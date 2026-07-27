// ── 'vm-queue' build backend — hard-isolated compilation ────────────────────
//
// Runs the ENTIRE untrusted build inside a disposable macOS VM and hands back
// only the built `.app` (plus the .xcresult we parse for diagnostics). This is
// the end state described in build-runner.ts, and it closes the biggest hole in
// the 'local-simuser' backend: there, `xcodegen generate` and `xcodebuild` —
// both of which execute attacker-controlled input (project.yml, Package.swift,
// SwiftPM plugins, Run Script phases) — run on bare metal as the orchestrator
// user that owns the signing keychain, the host tokens, and tailnet access.
//
// Isolation properties:
//   • Virtualization.framework VM boundary (not a uid boundary).
//   • The VM is DISPOSABLE: cloned fresh from the golden image per build and
//     destroyed after, so nothing persists between tenants.
//   • Optional Softnet egress restriction (VM_BUILD_NET_ALLOW) confines guest
//     networking to the CIDRs a build legitimately needs.
//   • Only bytes cross back: a tar of the .app and the .xcresult.
//
// Capacity: Virtualization.framework hard-caps concurrent macOS guests at 2 per
// host (empirically confirmed — a 3rd `tart run` fails with "The number of VMs
// exceeds the system limit"). Builds beyond the live slots wait in `pending`;
// builds are short (~8s measured), so the queue drains fast.
//
// Measured on the M5 Pro host: clone 0s (copy-on-write), boot→ssh 8s,
// xcodebuild 8s — i.e. parity with bare metal once a slot is warm.

import { spawn, type ChildProcess } from 'node:child_process';
import { lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { LogStream } from '@sim/shared';
import { execAsync } from './util.js';
import { parseProjectYml } from './project-yml.js';
import { log, warn } from './log.js';
import { extractDiagnostics, sanitize, sanitizeLine } from './build-diagnostics.js';
import {
  BUILDS_ROOT,
  BuildAborted,
  readAppBundleId,
  type BuildHandle,
  type BuildOptions,
  type BuildResult,
} from './build.js';

const TART = process.env.TART_BIN ?? '/opt/homebrew/bin/tart';
const GOLDEN = process.env.VM_BUILD_GOLDEN ?? 'golden-v3';
const GUEST_USER = process.env.VM_BUILD_GUEST_USER ?? 'admin';
const GUEST_PASS = process.env.VM_BUILD_GUEST_PASS ?? 'admin';
/** Concurrent build VMs. Virtualization.framework refuses a 3rd macOS guest. */
const SLOTS = Math.max(1, Math.min(2, parseInt(process.env.VM_BUILD_SLOTS ?? '2', 10) || 2));
const VM_MEMORY_MB = parseInt(process.env.VM_BUILD_MEMORY_MB ?? '8192', 10) || 8192;
const VM_CPU = parseInt(process.env.VM_BUILD_CPU ?? '6', 10) || 6;
/** Comma-separated CIDRs the guest may reach (tart Softnet). Unset = unrestricted. */
const NET_ALLOW = (process.env.VM_BUILD_NET_ALLOW ?? '').trim();
// The guest recreates the host workdir path verbatim, so that path must be
// writable INSIDE the guest. BUILDS_ROOT is /tmp/sim-builds in sim-user mode
// (prod) but os.tmpdir() -> /var/folders/... otherwise, which does not exist in
// the guest. Fail loudly at selection time rather than at every build.
function assertGuestWritableBuildsRoot(): void {
  if (!BUILDS_ROOT.startsWith('/tmp/')) {
    throw new Error(
      `vm-queue backend requires BUILDS_ROOT under /tmp (guest-writable); got ${BUILDS_ROOT}. ` +
        'Set SIM_RUN_USER/SIM_RUN_UID (sim-user mode) or point BUILDS_ROOT at /tmp.',
    );
  }
}

const BOOT_TIMEOUT_MS = 180_000;
const BUILD_TIMEOUT_MS = 20 * 60_000;
// NOTE: the guest builds at the SAME absolute path as the host workdir
// (BUILDS_ROOT/<sessionId>). That is deliberate: xcresult entries and compiler
// diagnostics then carry paths that already match the host layout, so
// sanitizeLine/extractDiagnostics work verbatim — no guest→host rewriting, and
// no class of bugs from getting that rewrite subtly wrong.
/** Cap on the UNCOMPRESSED size of artifacts copied back. A build phase can emit
 *  a tiny, highly-compressible archive that expands to hundreds of GB; the VM
 *  contains the build but extraction happens on the host, so bound it here. */
const MAX_ARTIFACT_BYTES = parseInt(process.env.VM_BUILD_MAX_ARTIFACT_BYTES ?? '', 10) || 4 * 1024 ** 3;
/** Companion cap on entry count — many small files can exhaust inodes/disk
 *  without any single one tripping a per-file limit. */
const MAX_ARTIFACT_ENTRIES = parseInt(process.env.VM_BUILD_MAX_ARTIFACT_ENTRIES ?? '', 10) || 200_000;

/**
 * Untrusted build output is NOT a control channel. A Run Script phase can print
 * anything, including `BF_APP_NAME=../../etc`, which would otherwise flow into
 * path joins and a recursive delete. Accept only a plain `.app` basename.
 */
function safeAppName(raw: string): string | null {
  const name = raw.trim();
  // Containment is what matters — enforce it structurally rather than with a
  // narrow charset, since valid PRODUCT_NAMEs include things like
  // "Acme+Beta.app", "Bob's App.app", and non-ASCII names.
  if (!name.endsWith('.app') || name.length < 5) return null;
  if (name.includes('/') || name.includes('\0')) return null;
  if (name === '.' || name === '..' || name.split('/').includes('..')) return null;
  if (path.basename(name) !== name) return null;
  if (path.isAbsolute(name)) return null;
  return name;
}

/** Largest project.yml we will read on the host. It is untrusted input parsed
 *  synchronously, so it must be tightly bounded. */
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;

/**
 * Host-side project discovery over an extracted (untrusted) source tree.
 * Mirrors prepareWorkdir's precedence — project.yml first, else the on-disk
 * .xcodeproj basename — but hardened: the manifest is only read when it is a
 * REGULAR file of bounded size (an archive can contain a FIFO named
 * project.yml, and readFileSync on a FIFO blocks the event loop forever).
 */
function discoverProject(srcDir: string, hints: BuildOptions['hints']): { scheme: string; bundleId: string } {
  let fromYml: { scheme: string; bundleId: string } | null = null;
  const manifest = path.join(srcDir, 'project.yml');
  try {
    const st = lstatSync(manifest);
    if (st.isFile() && st.size <= MAX_MANIFEST_BYTES) {
      fromYml = parseProjectYml(srcDir, hints);
    }
  } catch {
    /* absent — fall through to the .xcodeproj glob */
  }
  // An explicit hint always wins; otherwise prefer a real .xcodeproj basename
  // over parseProjectYml's 'MyApp' default, which would make us pass a scheme
  // that does not exist in the project we are about to build.
  // Precedence: explicit hint > project.yml > on-disk .xcodeproj. project.yml is
  // the source of truth — after a rename the OLD .xcodeproj is still in the
  // upload, so preferring the on-disk basename would build the stale target
  // (xcodegen regenerates the new one in the guest).
  let scheme = hints?.scheme ?? fromYml?.scheme ?? '';
  if (!scheme) {
    try {
      scheme = (readdirSync(srcDir).find((f) => f.endsWith('.xcodeproj')) ?? '').replace(/\.xcodeproj$/, '');
    } catch {
      /* unreadable */
    }
  }
  return { scheme, bundleId: hints?.bundleId ?? fromYml?.bundleId ?? '' };
}

/**
 * Total uncompressed bytes + entry count an archive would write. Returns null
 * when it can't be determined — callers treat that as "refuse to extract".
 */
async function archiveTotals(tgz: string): Promise<{ bytes: number; entries: number } | null> {
  // Sum the tar member headers, which is exactly what extraction will write.
  // (`gzip -l` is unusable here: its footer records size mod 2^32, so a >4GiB
  // bomb can report a small size and pass the check.) Listing decompresses but
  // writes nothing, so this is safe to run on untrusted input.
  const res = await execAsync(
    // BSD tar (macOS): "<mode> <links> <owner> <group> <size> <date> <name>"
    // — the size is field 5. Summing field 3 would add owner names (=0) and
    // silently disable the cap.
    `/usr/bin/tar tzvf ${q(tgz)} | /usr/bin/awk '{ s += $5; n += 1 } END { print s "|" n }'`,
    { timeoutMs: 120_000 },
  );
  if (res.code !== 0) return null;
  const [b, n] = res.stdout.trim().split('|');
  const bytes = parseInt(b ?? '', 10);
  const entries = parseInt(n ?? '', 10);
  if (!Number.isFinite(bytes) || !Number.isFinite(entries)) return null;
  return { bytes, entries };
}

/**
 * Extract a guest artifact into `destDir` under aggregate size + entry ceilings,
 * with a per-file `ulimit -f` backstop — so a compression bomb produced inside
 * the (otherwise contained) VM still can't fill the host disk.
 */
async function safeExtract(tgz: string, destDir: string): Promise<boolean> {
  const totals = await archiveTotals(tgz);
  if (totals === null) {
    warn(`refusing to extract ${path.basename(tgz)}: could not size the archive`);
    return false;
  }
  if (totals.bytes > MAX_ARTIFACT_BYTES) {
    warn(`refusing to extract ${path.basename(tgz)}: ${totals.bytes}B exceeds cap`);
    return false;
  }
  if (totals.entries > MAX_ARTIFACT_ENTRIES) {
    warn(`refusing to extract ${path.basename(tgz)}: ${totals.entries} entries exceeds cap`);
    return false;
  }
  const blocks = Math.ceil(MAX_ARTIFACT_BYTES / 512);
  // `ulimit -f` is a per-file backstop; the aggregate gate above is the real
  // ceiling. `-P` is NOT passed, so tar strips leading '/' and refuses '..',
  // keeping extraction inside destDir.
  const res = await execAsync(
    `ulimit -f ${blocks}; tar xzf ${q(tgz)} -C ${q(destDir)}`,
    { timeoutMs: 300_000 },
  );
  if (res.code !== 0) {
    warn(`extract failed for ${path.basename(tgz)}: ${(res.stderr || res.stdout).trim().split('\n')[0]}`);
    return false;
  }
  return true;
}

/** Single-quote for safe shell interpolation. */
const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

// ── Slot queue ──────────────────────────────────────────────────────────────
// A counting semaphore over the VM slots. Kept deliberately simple: builds are
// short, so FIFO waiting is sufficient and avoids a scheduler.

let inFlight = 0;
const waiters: Array<() => void> = [];

/**
 * Newest build generation per session. A cancelled/superseded handle must never
 * write into a workdir the replacement build now owns — checking `cancelled`
 * alone is racy because cancel() cannot kill host-side tar/rsync mid-flight.
 */
const sessionGeneration = new Map<string, number>();

async function acquireSlot(onLog: (l: string, s: LogStream) => void): Promise<void> {
  if (inFlight < SLOTS) {
    inFlight++;
    return;
  }
  onLog(`Waiting for a build slot (${SLOTS} in use)…`, 'stdout');
  await new Promise<void>((resolve) => waiters.push(resolve));
  inFlight++;
}

function releaseSlot(): void {
  inFlight = Math.max(0, inFlight - 1);
  const next = waiters.shift();
  if (next) next();
}

// ── tart helpers (host side) ────────────────────────────────────────────────

async function tart(args: string[], timeoutMs = 60_000): Promise<{ code: number; out: string }> {
  const res = await execAsync(`${q(TART)} ${args.map(q).join(' ')}`, { timeoutMs });
  // execAsync reports a null code when the process was signalled; treat that as
  // failure rather than coercing it to 0.
  return { code: res.code ?? -1, out: `${res.stdout}${res.stderr}` };
}

/** Best-effort teardown. Never throws — cleanup must not mask a build error. */
async function destroyVm(name: string, proc: ChildProcess | null): Promise<void> {
  try {
    if (proc && !proc.killed) proc.kill('SIGTERM');
  } catch {
    /* already gone */
  }
  await tart(['stop', name], 30_000).catch(() => undefined);
  await tart(['delete', name], 30_000).catch(() => undefined);
}

/**
 * Clone the golden image, boot it headless, and wait until SSH answers.
 * Returns the VM name, its IP, and the `tart run` child (which owns the VM's
 * lifetime — killing it powers the guest off).
 */
async function bootBuildVm(
  onLog: (l: string, s: LogStream) => void,
  isCancelled: () => boolean,
): Promise<{ name: string; ip: string; proc: ChildProcess }> {
  const name = `bfbuild-${randomBytes(4).toString('hex')}`;

  const cloned = await tart(['clone', GOLDEN, name], 120_000);
  if (cloned.code !== 0) throw new Error(`tart clone ${GOLDEN} failed: ${cloned.out.trim()}`);

  // tart 2.x: memory/cpu are set on the VM, not passed to `run`.
  const cfg = await tart(['set', name, '--memory', String(VM_MEMORY_MB), '--cpu', String(VM_CPU)]);
  if (cfg.code !== 0) {
    await destroyVm(name, null);
    throw new Error(`tart set ${name} failed: ${cfg.out.trim()}`);
  }

  const runArgs = ['run', name, '--no-graphics'];
  if (NET_ALLOW) {
    // Softnet + an allow-list confines the guest's egress at the VM boundary,
    // so untrusted build code cannot reach the control plane / tailnet / LAN
    // even with full control of the guest.
    runArgs.push('--net-softnet', `--net-softnet-allow=${NET_ALLOW}`);
  }
  const proc = spawn(TART, runArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
  proc.stderr?.on('data', (d: Buffer) => {
    const m = d.toString().trim();
    if (m) warn(`vm ${name}: ${m.split('\n')[0]}`);
  });

  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let ip = '';
  while (Date.now() < deadline) {
    if (isCancelled()) {
      await destroyVm(name, proc);
      throw new BuildAborted();
    }
    const r = await tart(['ip', name], 10_000);
    const candidate = r.out.trim();
    if (r.code === 0 && /^\d{1,3}(\.\d{1,3}){3}$/.test(candidate)) {
      ip = candidate;
      break;
    }
    await new Promise((r2) => setTimeout(r2, 2000));
  }
  if (!ip) {
    await destroyVm(name, proc);
    throw new Error(`build VM ${name} never reported an IP`);
  }

  // Wait for sshd, not just DHCP — the guest answers ARP well before login works.
  while (Date.now() < deadline) {
    if (isCancelled()) {
      await destroyVm(name, proc);
      throw new BuildAborted();
    }
    const probe = await execAsync(`${sshBase(ip)} ${q('echo ok')}`, { timeoutMs: 15_000 });
    if (probe.code === 0 && probe.stdout.includes('ok')) {
      onLog(`Build VM ready (${name})`, 'stdout');
      return { name, ip, proc };
    }
    await new Promise((r2) => setTimeout(r2, 2000));
  }
  await destroyVm(name, proc);
  throw new Error(`build VM ${name} SSH never became ready`);
}

/** ssh/scp prefix. Host keys are per-clone and ephemeral, so pinning them is
 *  pointless; the transport is a host-local NAT to a VM we just created. */
function sshBase(ip: string): string {
  return (
    `sshpass -p ${q(GUEST_PASS)} ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ` +
    `-o LogLevel=ERROR -o ConnectTimeout=10 ${q(`${GUEST_USER}@${ip}`)}`
  );
}
function scpTo(ip: string, local: string, remote: string): string {
  return (
    `sshpass -p ${q(GUEST_PASS)} scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ` +
    `-o LogLevel=ERROR -o ConnectTimeout=10 ${q(local)} ${q(`${GUEST_USER}@${ip}:${remote}`)}`
  );
}
/**
 * Pull a guest artifact with a HARD byte ceiling. scp has no size limit and
 * would write the whole file before any cap could be applied, so an oversized
 * or incompressible artifact could fill the host disk. Streaming through
 * `head -c` bounds what is written no matter what the (untrusted) guest sends;
 * a result of exactly cap+1 bytes means it was truncated => reject.
 */
function fetchBounded(ip: string, remote: string, local: string): string {
  return (
    `${sshBase(ip)} ${q(`cat ${remote}`)} | /usr/bin/head -c ${MAX_ARTIFACT_BYTES + 1} > ${q(local)}`
  );
}

/** True when the fetched file hit the ceiling (i.e. was truncated). */
function fetchOverflowed(local: string): boolean {
  try {
    return lstatSync(local).size > MAX_ARTIFACT_BYTES;
  } catch {
    return true;
  }
}

/**
 * The guest-side build script. Runs xcodegen (when project.yml is present) and
 * xcodebuild INSIDE the VM — this is the whole point: both execute untrusted
 * input. Mirrors the flag set the bare-metal backend uses so output is
 * byte-comparable, then tars the .app + .xcresult for extraction.
 */
function guestBuildScript(scheme: string | undefined, guestWorkdir: string): string {
  const schemeArg = scheme ? `SCHEME=${q(scheme)}` : 'SCHEME=""';
  return `
set -o pipefail
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
rm -rf ${q(guestWorkdir)} && mkdir -p ${q(guestWorkdir)} && cd ${q(guestWorkdir)}
tar xzf ~/job.tgz
${schemeArg}
if [ -f project.yml ] && command -v xcodegen >/dev/null 2>&1; then
  xcodegen generate >/dev/null 2>&1 && echo "xcodegen regenerated project from project.yml"
fi
# Prefer the project named after the requested scheme (mirrors prepareWorkdir):
# after a rename, xcodegen leaves the stale .xcodeproj alongside the new one, so
# a blind "first match" can build the OLD app or miss the scheme entirely.
PROJ=""
[ -n "$SCHEME" ] && [ -d "./$SCHEME.xcodeproj" ] && PROJ="./$SCHEME.xcodeproj"
[ -z "$PROJ" ] && PROJ=$(ls -d ./*.xcodeproj 2>/dev/null | head -1)
[ -z "$PROJ" ] && { echo "NO_XCODEPROJ" >&2; exit 65; }
[ -z "$SCHEME" ] && SCHEME=$(basename "$PROJ" .xcodeproj)
rm -rf result.xcresult
# Flag set MUST mirror the local-simuser backend: the orientation overrides are
# what let the injected shim rotate apps that don't declare orientations
# themselves — omitting them silently breaks the preview's rotate control.
xcodebuild -project "$PROJ" -scheme "$SCHEME" -sdk iphonesimulator \
  -derivedDataPath ./build -resultBundlePath ./result.xcresult \
  ONLY_ACTIVE_ARCH=YES ARCHS=arm64 \
  CODE_SIGN_IDENTITY= CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=NO \
  INFOPLIST_KEY_UIRequiresFullScreen=YES \
  'INFOPLIST_KEY_UISupportedInterfaceOrientations_iPhone=UIInterfaceOrientationPortrait UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight' \
  'INFOPLIST_KEY_UISupportedInterfaceOrientations_iPad=UIInterfaceOrientationPortrait UIInterfaceOrientationPortraitUpsideDown UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight' \
  build
RC=$?
APP=$(find ./build/Build/Products -maxdepth 2 -name '*.app' -path '*-iphonesimulator/*' 2>/dev/null | head -1)
if [ -n "$APP" ]; then
  ( cd "$(dirname "$APP")" && tar czf ~/out-app.tgz "$(basename "$APP")" )
  echo "BF_APP_NAME=$(basename "$APP")"
fi
[ -d result.xcresult ] && tar czf ~/out-xcresult.tgz result.xcresult
echo "BF_SCHEME=$SCHEME"
echo "BF_RC=$RC"
exit $RC
`;
}

// ── Public entry point ──────────────────────────────────────────────────────

/**
 * The 'vm-queue' implementation of the build contract. Signature-compatible
 * with build.ts's `runBuild`, so the call site can switch on
 * `selectedBuildBackend()` with nothing else changing.
 */
export function runVmBuild(options: BuildOptions): BuildHandle {
  const { sessionId, tarballBuf, hints, onLog } = options;
  const workdir = path.join(BUILDS_ROOT, sessionId);
  let cancelled = false;
  let sshProc: ChildProcess | null = null;
  let vm: { name: string; proc: ChildProcess } | null = null;

  const cancel = (): void => {
    cancelled = true;
    try {
      if (sshProc && !sshProc.killed) sshProc.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    // Powering the VM off is the authoritative cancel — it kills whatever the
    // untrusted build spawned, which SIGTERM on ssh alone would not.
    if (vm) void destroyVm(vm.name, vm.proc);
  };

  const done = (async (): Promise<BuildResult> => {
    const startedAt = Date.now();
    assertGuestWritableBuildsRoot();
    const myGen = (sessionGeneration.get(sessionId) ?? 0) + 1;
    sessionGeneration.set(sessionId, myGen);
    /** True once a newer build for this session has taken ownership. */
    const superseded = (): boolean => sessionGeneration.get(sessionId) !== myGen;
    const assertOwned = (): void => {
      if (cancelled || superseded()) throw new BuildAborted();
    };
    await acquireSlot(onLog);
    let booted: { name: string; ip: string; proc: ChildProcess } | null = null;
    const stage = path.join(tmpdir(), `bfvm-${sessionId}-${randomBytes(3).toString('hex')}`);

    try {
      assertOwned();
      mkdirSync(stage, { recursive: true });
      // Rebuilds reuse this workdir. Clear it ENTIRELY (as prepareWorkdir does):
      // leaving prior contents means a file dropped from the new upload — e.g.
      // project.yml — still gets parsed, so we'd ask the guest to build a scheme
      // that no longer exists, and stale results could be read as current.
      rmSync(workdir, { recursive: true, force: true });
      mkdirSync(workdir, { recursive: true });

      booted = await bootBuildVm(onLog, () => cancelled);
      vm = { name: booted.name, proc: booted.proc };

      // 1. Ship the project tarball in.
      const localTar = path.join(stage, 'job.tgz');
      writeFileSync(localTar, tarballBuf);

      // Mirror the sources into the PRIVATE stage (never the shared session
      // workdir): a cancelled build's tar must not be able to write into a
      // workdir that a replacement build is already using. They are published
      // to the workdir once, at the end, after the final cancellation check —
      // extractDiagnostics needs them there to attach source snippets.
      const stagedSrc = path.join(stage, 'src');
      mkdirSync(stagedSrc, { recursive: true });
      await safeExtract(localTar, stagedSrc);

      // Resolve the scheme host-side, exactly as the local backend does.
      const project = discoverProject(stagedSrc, hints);
      const put = await execAsync(scpTo(booted.ip, localTar, '~/job.tgz'), { timeoutMs: 120_000 });
      if (put.code !== 0) {
        // cancel() destroys the VM, which makes scp fail — report that as an
        // abort so the caller doesn't flip the session to 'error' while the
        // replacement build is running.
        if (cancelled) throw new BuildAborted();
        throw new Error(`sending project to build VM failed: ${sanitize(put.stderr.trim(), workdir)}`);
      }

      // 2. Build inside the guest, streaming sanitized output as it goes.
      const script = guestBuildScript(project.scheme, workdir);
      const scriptPath = path.join(stage, 'build.sh');
      writeFileSync(scriptPath, script);
      const putScript = await execAsync(scpTo(booted.ip, scriptPath, '~/build.sh'), {
        timeoutMs: 60_000,
      });
      if (putScript.code !== 0) {
        if (cancelled) throw new BuildAborted();
        throw new Error(`sending build script failed: ${sanitize(putScript.stderr.trim(), workdir)}`);
      }

      // Separate buffers: stdout and stderr are independent streams, so a shared
      // tail would splice a half-line from one onto the next chunk of the other,
      // corrupting logs and potentially hiding a BF_* control marker.
      let outTail = '';
      let errTail = '';
      let guestScheme = hints?.scheme ?? '';
      let appName = '';
      let rc: number | null = null;

      await new Promise<void>((resolve, reject) => {
        const child = spawn('/bin/sh', ['-c', `${sshBase(booted!.ip)} ${q('bash ~/build.sh')}`], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        sshProc = child;
        const timer = setTimeout(() => {
          warn(`vm build ${booted!.name}: timeout`);
          try {
            child.kill('SIGKILL');
          } catch {
            /* gone */
          }
        }, BUILD_TIMEOUT_MS);

        const onChunk = (buf: Buffer, stream: LogStream): void => {
          const isOut = stream === 'stdout';
          const merged = (isOut ? outTail : errTail) + buf.toString();
          const lines = merged.split('\n');
          const rest = lines.pop() ?? '';
          if (isOut) outTail = rest;
          else errTail = rest;
          for (const raw of lines) {
            // Markers are control channel, not build output.
            const m = raw.match(/^BF_(SCHEME|RC|APP_NAME)=(.*)$/);
            if (m) {
              if (m[1] === 'SCHEME') guestScheme = m[2].trim();
              else if (m[1] === 'APP_NAME') appName = safeAppName(m[2]) ?? '';
              else rc = parseInt(m[2].trim(), 10);
              continue;
            }
            // Map the GUEST build dir onto the host workdir FIRST — sanitizeLine
            // only strips the host workdir, so raw guest paths would otherwise
            // survive as `/Users/admin/bfjob/...` (unusable for source snippets)
            // and defeat the live diagnostic parser.
            const clean = sanitizeLine(raw, workdir);
            if (clean !== null) onLog(clean, stream);
          }
        };
        child.stdout?.on('data', (d: Buffer) => onChunk(d, 'stdout'));
        child.stderr?.on('data', (d: Buffer) => onChunk(d, 'stderr'));
        child.on('error', (e) => {
          clearTimeout(timer);
          reject(e);
        });
        // 'close' (not 'exit'): exit can fire while stdout/stderr still hold
        // buffered data, which would let artifact handling read appName/scheme
        // before the trailing BF_* markers are parsed.
        child.on('close', (code) => {
          clearTimeout(timer);
          if (rc === null) rc = code ?? 1;
          resolve();
        });
      });

      if (cancelled) throw new BuildAborted();

      // 3. Bring back the .app and the .xcresult (diagnostics are parsed from
      //    the xcresult exactly as the bare-metal backend does).
      assertOwned();

      let appBundlePath = '';
      if (appName) {
        const appTar = path.join(stage, 'out-app.tgz');
        const got = await execAsync(fetchBounded(booted.ip, '~/out-app.tgz', appTar), {
          timeoutMs: 300_000,
        });
        if (got.code === 0 && fetchOverflowed(appTar)) {
          warn(`app artifact exceeded ${MAX_ARTIFACT_BYTES}B — discarding`);
          rmSync(appTar, { force: true });
        } else if (got.code === 0) {
          // Unpack into the PRIVATE stage first. A cancelled build must never
          // mutate the shared session workdir — a replacement build may already
          // be writing there, and we'd corrupt its artifacts.
          const stagedApp = path.join(stage, 'app');
          mkdirSync(stagedApp, { recursive: true });
          if (await safeExtract(appTar, stagedApp)) {
            assertOwned();
            const products = path.join(workdir, 'build', 'Build', 'Products', 'Debug-iphonesimulator');
            mkdirSync(products, { recursive: true });
            // Replace, never merge: untarring over a previous .app would keep
            // files the new build deleted, so the sim would run a hybrid.
            rmSync(path.join(products, appName), { recursive: true, force: true });
            const mv = await execAsync(
              `/bin/mv ${q(path.join(stagedApp, appName))} ${q(products)}`,
              { timeoutMs: 120_000 },
            );
            if (mv.code === 0) appBundlePath = path.join(products, appName);
          }
        }
      }

      const resultBundlePath = path.join(workdir, 'result.xcresult');
      const xcTar = path.join(stage, 'out-xcresult.tgz');
      const gotXc = await execAsync(fetchBounded(booted.ip, '~/out-xcresult.tgz', xcTar), {
        timeoutMs: 120_000,
      });
      if (gotXc.code === 0 && !fetchOverflowed(xcTar)) {
        const stagedXc = path.join(stage, 'xcresult');
        mkdirSync(stagedXc, { recursive: true });
        if (await safeExtract(xcTar, stagedXc)) {
          assertOwned();
          rmSync(resultBundlePath, { recursive: true, force: true });
          await execAsync(
            `/bin/mv ${q(path.join(stagedXc, 'result.xcresult'))} ${q(workdir)}`,
            { timeoutMs: 120_000 },
          );
        }
      }
      // extractDiagnostics rewrites paths relative to `workdir`; the xcresult was
      // produced in the guest, so translate the guest dir onto the host one first
      // (same reason as the live log path mapping above).
      // Publish sources BEFORE parsing diagnostics: readSnippet resolves file
      // paths under workdir, so without them every snippet would be null (and a
      // failed build would never reach a later copy step at all).
      assertOwned();
      await execAsync(`/usr/bin/rsync -a ${q(`${stagedSrc}/`)} ${q(`${workdir}/`)}`, {
        timeoutMs: 120_000,
      }).catch(() => undefined);

      // Guest built at this exact path, so xcresult entries already match the
      // host layout — extractDiagnostics needs no translation.
      const diagnostics = await extractDiagnostics(resultBundlePath, workdir).catch(() => []);

      if (rc !== 0 || !appBundlePath) {
        const first = diagnostics.find((d) => d.severity === 'error');
        const err = new Error(first?.message ?? `build failed in VM (exit ${rc ?? 'unknown'})`);
        // Session.runBuildAndLaunch only forwards diagnostics carried on the
        // error — without this the Issues panel is empty for VM build failures.
        (err as Error & { diagnostics?: typeof diagnostics }).diagnostics = diagnostics;
        throw err;
      }

      // The .app must be readable by the sim user that installs it — workdir is
      // under the shared BUILDS_ROOT for exactly this reason.
      await execAsync(`chmod -R a+rX ${q(workdir)}`, { timeoutMs: 30_000 }).catch(() => undefined);

      // Retrieval can take minutes; a Refresh during it must not let this stale
      // handle resolve and install its app over the replacement build's.
      assertOwned();

      const scheme = guestScheme || path.basename(appBundlePath, '.app');
      // Authoritative bundle id comes from the BUILT app, not the upload hint:
      // the hint is optional (empty => `simctl launch` with no id) and can be
      // stale (=> launching the wrong app). Matches the local backend.
      const bundleId = (await readAppBundleId(appBundlePath).catch(() => null)) ?? project.bundleId ?? '';
      if (!bundleId) {
        throw new Error('could not determine bundle id from the built .app');
      }
      log(`vm build ok: scheme=${scheme} app=${appBundlePath} in ${Date.now() - startedAt}ms`);

      return {
        appBundlePath,
        scheme,
        bundleId,
        durationMs: Date.now() - startedAt,
        diagnostics,
      };
    } finally {
      // Disposable by construction: the VM is destroyed after every build, so
      // no state (or lingering process) survives to the next tenant.
      if (booted) await destroyVm(booted.name, booted.proc);
      vm = null;
      rmSync(stage, { recursive: true, force: true });
      // Only the current owner clears the entry; a superseded handle must leave
      // the newer build's generation intact.
      if (sessionGeneration.get(sessionId) === myGen) sessionGeneration.delete(sessionId);
      releaseSlot();
    }
  })();

  return { done, cancel };
}

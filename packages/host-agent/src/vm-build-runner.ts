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
// exceeds the system limit"). ALL build flavors share those 2 slots; overflow
// waits in a FIFO queue.
//
// Performance: a naive boot-per-build measured ~45s vs ~11s bare metal. The cost
// was NOT teardown (1s) but a cold guest — the golden's RAM-disk daemon hangs at
// boot, which also silently kills its self-warming build, so every build ran
// cold on the virtio disk. The warm pool below pre-boots, mounts the RAM disk on
// the build root, and pre-warms the page cache, moving all of that off the
// user's critical path.

import { spawn, type ChildProcess } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
  exportOptionsPlist,
  readAppBundleId,
  unlockSigningKeychain,
  type AppStoreBuildHandle,
  type AppStoreBuildOptions,
  type AppStoreBuildResult,
  type BuildHandle,
  type BuildOptions,
  type BuildResult,
  type DeviceBuildHandle,
  type DeviceBuildOptions,
  type DeviceBuildResult,
} from './build.js';
import { ensureSigningAssets } from './asc-signing.js';
import { normalizeP8, uploadIpaToAppStoreConnect } from './asc-upload.js';
import { placeholderIcon1024 } from './default-icon.js';

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

/** Guest build root. Equals BUILDS_ROOT so guest paths match host paths. */
const GUEST_BUILD_ROOT = BUILDS_ROOT;
/** RAM disk size for build I/O, in MiB. Backed by the GUEST's memory, so it must
 *  stay well under VM_MEMORY_MB — the runbook's 8GiB figure assumed a 32GB VM;
 *  at our 8GB default that would risk OOMing the guest. Pages are allocated
 *  lazily, but cap it anyway. */
const RAMDISK_MB = Math.max(
  512,
  Math.min(
    parseInt(process.env.VM_BUILD_RAMDISK_MB ?? '', 10) || 4096,
    Math.floor(VM_MEMORY_MB / 2),
  ),
);
/** hdiutil takes 512-byte sectors. */
const RAMDISK_SECTORS = RAMDISK_MB * 2048;
const WARMUP_TIMEOUT_MS = 5 * 60_000;
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
  if (!(name.endsWith('.app') || name.endsWith('.xcarchive')) || name.length < 5) return null;
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

// ── Warm VM pool ────────────────────────────────────────────────────────────
// A build must NOT pay for boot (~10s) or page-cache warm-up (15-70s). The
// golden image bakes both a RAM disk daemon and a self-warming build for this,
// but in a fresh clone the RAM-disk daemon hangs at boot, which also kills the
// warm-up (its script waits for /Volumes/RAMDisk, then fails) — so every build
// ran fully cold on the virtio disk (~45s vs ~11s bare metal).
//
// The pool fixes that by doing BOTH off the user's critical path: VMs are
// pre-booted, the RAM disk is mounted ON the build root, and the golden's
// warm-up project is compiled once so the OS page cache is hot. A build then
// just receives a ready VM. Disposability is unchanged — each VM still serves
// exactly one build and is destroyed after; the pool tops itself back up.

interface PooledVm {
  name: string;
  ip: string;
  proc: ChildProcess;
}

/**
 * Newest build generation per session. A cancelled/superseded handle must never
 * write into a workdir the replacement build now owns — checking `cancelled`
 * alone is racy because cancel() cannot kill host-side tar/rsync mid-flight.
 */
const sessionGeneration = new Map<string, number>();

/** warm + checked-out + currently booting. Must never exceed SLOTS. */
let liveVms = 0;
const warmQueue: PooledVm[] = [];
const vmWaiters: Array<(vm: PooledVm) => void> = [];

/**
 * Run a multi-line script in the guest by SHIPPING IT AS A FILE.
 *
 * Do NOT use `ssh host bash -c "<script>"`: the newlines collapse (a `\n` inside
 * double quotes is a literal backslash-n), so the whole script becomes one
 * nonsense command. That silently broke the RAM-disk mount and the page-cache
 * warm-up — the VM still reported "ready" while being neither.
 */
async function runGuestScript(
  ip: string,
  script: string,
  label: string,
  opts: { sudo?: boolean; timeoutMs: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const local = path.join(tmpdir(), `bfguest-${label}-${randomBytes(4).toString('hex')}.sh`);
  const remote = `~/.bf-${label}.sh`;
  try {
    writeFileSync(local, script.endsWith('\n') ? script : `${script}\n`);
    const put = await execAsync(scpTo(ip, local, remote), { timeoutMs: 60_000 });
    if (put.code !== 0) {
      return { code: put.code ?? 1, stdout: put.stdout, stderr: put.stderr };
    }
    const run = await execAsync(
      `${sshBase(ip)} ${q(`${opts.sudo ? 'sudo ' : ''}bash ${remote}`)}`,
      { timeoutMs: opts.timeoutMs },
    );
    return { code: run.code ?? 1, stdout: run.stdout, stderr: run.stderr };
  } finally {
    rmSync(local, { force: true });
  }
}

/**
 * Put the guest's build root on a RAM disk. `infra/vm/golden-build.md` measures
 * this as the dominant build cost on the virtio disk. Mounting AT the build root
 * (rather than /Volumes/RAMDisk) preserves the guest-path == host-path property
 * the diagnostics rely on. Best-effort: a failure just means a slower build.
 */
async function mountRamDisk(ip: string): Promise<boolean> {
  const script = [
    'set -e',
    `mkdir -p ${GUEST_BUILD_ROOT}`,
    'if ! diskutil info RAMDisk >/dev/null 2>&1; then',
    `  DEV=$(hdiutil attach -nomount ram://${RAMDISK_SECTORS} | awk '{print $1}')`,
    '  [ -z "$DEV" ] && exit 1',
    '  diskutil erasevolume HFS+ RAMDisk "$DEV" >/dev/null',
    'fi',
    'diskutil unmount force RAMDisk >/dev/null 2>&1 || true',
    `diskutil mount -mountPoint ${GUEST_BUILD_ROOT} RAMDisk >/dev/null`,
    `mdutil -i off ${GUEST_BUILD_ROOT} >/dev/null 2>&1 || true`,
    `chmod 1777 ${GUEST_BUILD_ROOT}`,
  ].join('\n');
  const res = await runGuestScript(ip, script, 'ramdisk', { sudo: true, timeoutMs: 120_000 });
  if (res.code !== 0) {
    warn(
      `ram disk mount failed (build will use the slower virtio disk): ` +
        `${(res.stderr || res.stdout).trim().split('\n')[0]}`,
    );
    return false;
  }
  return true;
}

/**
 * Compile the golden's baked warm-up project so the OS page cache holds the SPM
 * cache, Xcode and the SDK. The image ships a LaunchAgent for this, but it is
 * gated on /Volumes/RAMDisk and therefore never runs — we drive it ourselves,
 * with no user data involved, while the VM is still in the pool.
 */
async function warmPageCache(ip: string): Promise<void> {
  const w = `${GUEST_BUILD_ROOT}/.warmup`;
  const script = [
    `[ -d ~/warmup ] || exit 0`,
    `rm -rf ${w} && mkdir -p ${w} && cp -R ~/warmup/. ${w}/`,
    `cd ${w}`,
    `command -v xcodegen >/dev/null 2>&1 && xcodegen generate >/dev/null 2>&1 || true`,
    `P=$(ls -d ./*.xcodeproj 2>/dev/null | head -1); [ -z "$P" ] && exit 0`,
    `xcodebuild -project "$P" -scheme "$(basename "$P" .xcodeproj)" -sdk iphonesimulator ` +
      `-derivedDataPath ./build ONLY_ACTIVE_ARCH=YES ARCHS=arm64 ` +
      `CODE_SIGN_IDENTITY= CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=NO build >/dev/null 2>&1 || true`,
    `rm -rf ${w}`,
  ].join('\n');
  const res = await runGuestScript(ip, script, 'warmup', { timeoutMs: WARMUP_TIMEOUT_MS });
  if (res.code !== 0) {
    warn(
      `page-cache warm-up did not complete (build may be slower): ` +
        `${(res.stderr || res.stdout).trim().split('\n')[0]}`,
    );
  }
}

/** Boot a clone and make it build-ready: RAM disk mounted + page cache warm. */
async function bootAndWarm(): Promise<PooledVm> {
  const t0 = Date.now();
  const vm = await bootBuildVm(
    () => undefined,
    () => false,
  );
  const booted = Date.now();
  await mountRamDisk(vm.ip);
  // Trust the filesystem, not the exit code: a silently-degraded mount is how
  // the first attempt shipped "warm" VMs that were neither ram-backed nor warm.
  const df = await execAsync(
    `${sshBase(vm.ip)} ${q(`df -k ${GUEST_BUILD_ROOT} | tail -1`)}`,
    { timeoutMs: 30_000 },
  );
  const onRam = /\/dev\/disk/.test(df.stdout) && !/Volumes\/Data/.test(df.stdout);
  const mounted = Date.now();
  await warmPageCache(vm.ip);
  log(
    `build VM ${vm.name} ready: boot ${((booted - t0) / 1000).toFixed(1)}s, ` +
      `ramdisk ${((mounted - booted) / 1000).toFixed(1)}s (${onRam ? 'ON RAM' : 'NOT ram-backed'}), ` +
      `warmup ${((Date.now() - mounted) / 1000).toFixed(1)}s`,
  );
  return { name: vm.name, ip: vm.ip, proc: vm.proc };
}

/** Fire-and-forget top-up toward SLOTS. Hands a VM straight to a waiter if one
 *  is queued, else parks it warm. */
function topUpPool(): void {
  while (liveVms < SLOTS) {
    liveVms++;
    void bootAndWarm().then(
      (vm) => {
        const w = vmWaiters.shift();
        if (w) w(vm);
        else warmQueue.push(vm);
      },
      (e) => {
        liveVms--;
        warn(`build VM warm-up failed: ${(e as Error).message}`);
        // A build may be parked waiting for this VM; without a retry it would
        // hang forever. Back off so a persistent failure doesn't spin.
        if (vmWaiters.length > 0) setTimeout(() => topUpPool(), 5_000);
      },
    );
  }
}

/** Take a ready VM, waiting if all slots are busy. */
async function checkoutVm(onLog: (l: string, s: LogStream) => void): Promise<PooledVm> {
  const ready = warmQueue.shift();
  if (ready) {
    topUpPool(); // replace it while this build runs
    return ready;
  }
  if (liveVms < SLOTS) {
    liveVms++;
    try {
      return await bootAndWarm();
    } catch (e) {
      liveVms--;
      throw e;
    }
  }
  onLog(`Waiting for a build slot (${SLOTS} in use)…`, 'stdout');
  return new Promise<PooledVm>((resolve) => vmWaiters.push(resolve));
}

/** Destroy a used VM (single-use isolation) and replenish the pool. */
function releaseVm(vm: PooledVm | null): void {
  if (vm) void destroyVm(vm.name, vm.proc);
  liveVms = Math.max(0, liveVms - 1);
  topUpPool();
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
/** Which artifact the VM must produce. All three COMPILE untrusted code, so all
 *  three belong in the guest; only signing stays on the host. */
export type VmBuildKind = 'sim' | 'device' | 'archive';

export interface VmArchiveMetadata {
  bundleId: string;
  marketingVersion: string;
  buildNumber: string;
}

function guestBuildScript(
  scheme: string | undefined,
  guestWorkdir: string,
  kind: VmBuildKind,
  meta?: VmArchiveMetadata,
): string {
  const schemeArg = scheme ? `SCHEME=${q(scheme)}` : 'SCHEME=""';
  // Orientation overrides must match the local backend or the preview's rotate
  // control regresses for apps that don't declare orientations themselves.
  const orientationFlags = `INFOPLIST_KEY_UIRequiresFullScreen=YES \
  'INFOPLIST_KEY_UISupportedInterfaceOrientations_iPhone=UIInterfaceOrientationPortrait UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight' \
  'INFOPLIST_KEY_UISupportedInterfaceOrientations_iPad=UIInterfaceOrientationPortrait UIInterfaceOrientationPortraitUpsideDown UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight'`;
  // NOTE: every flavor builds UNSIGNED. The device .ipa is unsigned by design
  // (the Companion re-signs it with the user's own Apple ID), and the App Store
  // archive is signed on the HOST at export — putting the distribution private
  // key inside a VM that runs untrusted build scripts would let those scripts
  // exfiltrate it.
  const unsigned = `CODE_SIGN_IDENTITY= CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=NO`;
  // Xcode 16+ Debug builds otherwise split into a thin launcher + debug dylibs
  // meant for Xcode's harness; installed standalone they launch and crash.
  const standalone = `ENABLE_DEBUG_DYLIB=NO ENABLE_PREVIEWS=NO`;
  // The publish wizard's bundle id / versions must win over the project's own,
  // or the archive won't match the provisioning profile keyed to signing.bundleId
  // and the upload carries the wrong version.
  const publishMeta = meta
    ? `PRODUCT_BUNDLE_IDENTIFIER=${q(meta.bundleId)} MARKETING_VERSION=${q(meta.marketingVersion)} CURRENT_PROJECT_VERSION=${q(meta.buildNumber)}`
    : '';

  const invocation =
    kind === 'archive'
      ? // App Store: UNSIGNED archive (host signs at export). publishMeta must
        // win over the project's own identity/version or the archive won't match
        // the profile keyed to signing.bundleId. No orientation overrides — those
        // are a simulator-preview concern and would alter the shipped binary.
        `xcodebuild archive -project "$PROJ" -scheme "$SCHEME" -sdk iphoneos \
  -destination 'generic/platform=iOS' -archivePath ${q(`${guestWorkdir}/out.xcarchive`)} \
  -derivedDataPath ./build -resultBundlePath ./result.xcresult \
  ${unsigned} ${standalone} ${publishMeta}`
      : kind === 'device'
        ? // Device .ipa: unsigned (Companion re-signs). `standalone` is required
          // or Xcode 16+ Debug yields a thin launcher that crashes standalone.
          `xcodebuild -project "$PROJ" -scheme "$SCHEME" -sdk iphoneos \
  -destination 'generic/platform=iOS' \
  -derivedDataPath ./build -resultBundlePath ./result.xcresult \
  ONLY_ACTIVE_ARCH=NO ${unsigned} ${standalone} build`
        : // Simulator preview: the only flavor that gets orientation overrides.
          `xcodebuild -project "$PROJ" -scheme "$SCHEME" -sdk iphonesimulator \
  -derivedDataPath ./build -resultBundlePath ./result.xcresult \
  ONLY_ACTIVE_ARCH=YES ARCHS=arm64 ${unsigned} ${orientationFlags} build`;

  // What to hand back: an .app (sim/device) or the whole .xcarchive.
  const collect =
    kind === 'archive'
      ? `if [ -d ${q(`${guestWorkdir}/out.xcarchive`)} ]; then
  ( cd ${q(guestWorkdir)} && tar czf ~/out-app.tgz out.xcarchive )
  echo "BF_APP_NAME=out.xcarchive"
fi`
      : `PRODUCTS=./build/Build/Products
# Filter by SDK: an uploaded tarball can carry stale products for the OTHER sdk,
# and picking those would package/launch the wrong binary.
APP=$(find "$PRODUCTS" -maxdepth 2 -name '*.app' -path ${kind === 'device' ? "'*-iphoneos/*'" : "'*-iphonesimulator/*'"} 2>/dev/null | head -1)
if [ -n "$APP" ]; then
  ( cd "$(dirname "$APP")" && tar czf ~/out-app.tgz "$(basename "$APP")" )
  echo "BF_APP_NAME=$(basename "$APP")"
fi`;

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
# after a rename, xcodegen leaves the stale .xcodeproj alongside the new one.
PROJ=""
[ -n "$SCHEME" ] && [ -d "./$SCHEME.xcodeproj" ] && PROJ="./$SCHEME.xcodeproj"
[ -z "$PROJ" ] && PROJ=$(ls -d ./*.xcodeproj 2>/dev/null | head -1)
[ -z "$PROJ" ] && { echo "NO_XCODEPROJ" >&2; exit 65; }
[ -z "$SCHEME" ] && SCHEME=$(basename "$PROJ" .xcodeproj)
# Drop any build products shipped inside the upload so we can never collect a
# stale artifact instead of what we just compiled.
rm -rf result.xcresult out.xcarchive build
${kind === 'archive' ? `# Apple rejects processing without a 1024px icon. Injected in the GUEST: doing
# it host-side means writing into an untrusted tree, where a symlinked
# Contents.json would let the project overwrite arbitrary host files. The PNG
# itself is generated by trusted host code and shipped in as ~/default-icon.png.
ICONSET=$(find . -type d -name 'AppIcon.appiconset' -not -path '*/build/*' 2>/dev/null | head -1)
if [ -n "$ICONSET" ] && [ -f ~/default-icon.png ]; then
  # Mirror ensureAppStoreIcon: an icon counts only if Contents.json REFERENCES a
  # file that exists (Xcode ignores unreferenced PNGs), so glob-based checks both
  # skip broken sets and clobber valid ones with unusual extensions.
  NEED_ICON=1
  if [ -f "$ICONSET/Contents.json" ]; then
    # JSON-parse rather than word-split: asset filenames may legally contain
    # spaces, which shell word splitting would shred into bogus names.
    if /usr/bin/python3 -c 'import json,os,sys
d=sys.argv[1]
try: c=json.load(open(os.path.join(d,"Contents.json")))
except Exception: sys.exit(1)
sys.exit(0 if any(i.get("filename") and os.path.isfile(os.path.join(d,i["filename"])) for i in c.get("images",[])) else 1)' "$ICONSET" 2>/dev/null; then
      NEED_ICON=0
    fi
  fi
  if [ "$NEED_ICON" = "1" ]; then
    rm -f "$ICONSET/Contents.json"
    cp ~/default-icon.png "$ICONSET/AppIcon.png"
    printf '%s\\n' '{ "images": [ { "filename": "AppIcon.png", "idiom": "universal", "platform": "ios", "size": "1024x1024" } ], "info": { "author": "botflow", "version": 1 } }' > "$ICONSET/Contents.json"
    echo "Icon preflight: added a default app icon (project had none)."
  fi
fi` : ''}
${invocation}
RC=$?
${collect}
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
export interface VmCompileOptions {
  /** Stable key for generation ownership (sessionId or buildId). */
  jobId: string;
  /** Host workdir; the guest recreates this exact absolute path. */
  workdir: string;
  tarballBuf: Buffer;
  hints?: BuildOptions['hints'];
  onLog: (line: string, stream: LogStream) => void;
  kind: VmBuildKind;
  /** App Store only: publish-wizard identity/version overrides for the archive. */
  archiveMeta?: VmArchiveMetadata;
}

export interface VmCompileResult {
  /** Built .app (sim/device) or .xcarchive (App Store), on the HOST. */
  artifactPath: string;
  scheme: string;
  bundleId: string;
  durationMs: number;
  diagnostics: Awaited<ReturnType<typeof extractDiagnostics>>;
}

export interface VmCompileHandle {
  done: Promise<VmCompileResult>;
  cancel: () => void;
}

/**
 * Compile ANY build flavor inside a disposable VM. All flavors go through the
 * same 2-slot queue — Virtualization.framework caps concurrent macOS guests at
 * 2, so simulator, device and App Store builds contend for the same slots.
 */
export function runVmCompile(options: VmCompileOptions): VmCompileHandle {
  const { jobId: sessionId, workdir, tarballBuf, hints, onLog, kind, archiveMeta } = options;
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

  const done = (async (): Promise<VmCompileResult> => {
    const startedAt = Date.now();
    assertGuestWritableBuildsRoot();
    const myGen = (sessionGeneration.get(sessionId) ?? 0) + 1;
    sessionGeneration.set(sessionId, myGen);
    /** True once a newer build for this session has taken ownership. */
    const superseded = (): boolean => sessionGeneration.get(sessionId) !== myGen;
    const assertOwned = (): void => {
      if (cancelled || superseded()) throw new BuildAborted();
    };
    let booted: PooledVm | null = null;
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

      const tCheckout = Date.now();
      booted = await checkoutVm(onLog);
      const tGotVm = Date.now();
      if (cancelled) throw new BuildAborted();
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
      const script = guestBuildScript(project.scheme, workdir, kind, archiveMeta);
      const scriptPath = path.join(stage, 'build.sh');
      writeFileSync(scriptPath, script);
      if (kind === 'archive') {
        const iconPath = path.join(stage, 'default-icon.png');
        writeFileSync(iconPath, placeholderIcon1024());
        const putIcon = await execAsync(scpTo(booted.ip, iconPath, '~/default-icon.png'), {
          timeoutMs: 60_000,
        });
        if (putIcon.code !== 0) {
          if (cancelled) throw new BuildAborted();
          // Silently skipping means Apple rejects the upload much later.
          throw new Error(
            `sending default app icon failed: ${sanitize(putIcon.stderr.trim(), workdir)}`,
          );
        }
      }
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
      const tXfer = Date.now();
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
      const tCompiled = Date.now();

      // 3. Bring back the .app and the .xcresult (diagnostics are parsed from
      //    the xcresult exactly as the bare-metal backend does).
      assertOwned();

      // Publish sources FIRST, then artifacts — so a stale `out.xcarchive` (or
      // any same-named path) shipped inside the uploaded project can never be
      // rsynced over the artifact we just built. Sources must also be present
      // before extractDiagnostics so readSnippet can resolve file paths.
      // --safe-links drops symlinks pointing outside the tree, and the excludes
      // stop an upload from occupying the paths we place artifacts at — without
      // that, a source-controlled symlink at build/Build/Products/... would make
      // the mkdir/rm/mv below follow it to an attacker-chosen host location.
      await execAsync(
        `/usr/bin/rsync -a --safe-links ` +
          `--exclude=build --exclude=out.xcarchive --exclude=result.xcresult ` +
          `--exclude=export --exclude=ipa ` +
          `${q(`${stagedSrc}/`)} ${q(`${workdir}/`)}`,
        { timeoutMs: 120_000 },
      ).catch(() => undefined);

      let artifactPath = '';
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
            // Sim/device .apps live under Products/<config>; the App Store
            // artifact is a .xcarchive that belongs at the workdir root.
            const products =
              kind === 'archive'
                ? workdir
                : path.join(workdir, 'build', 'Build', 'Products', 'Debug-iphonesimulator');
            // Belt-and-braces: never write through a symlink, even if one
            // somehow reached this path.
            try {
              if (lstatSync(products).isSymbolicLink()) rmSync(products, { force: true });
            } catch {
              /* absent — fine */
            }
            mkdirSync(products, { recursive: true });
            // Replace, never merge: untarring over a previous .app would keep
            // files the new build deleted, so the sim would run a hybrid.
            rmSync(path.join(products, appName), { recursive: true, force: true });
            const mv = await execAsync(
              `/bin/mv ${q(path.join(stagedApp, appName))} ${q(products)}`,
              { timeoutMs: 120_000 },
            );
            if (mv.code === 0) artifactPath = path.join(products, appName);
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
      // Guest built at this exact path, so xcresult entries already match the
      // host layout — extractDiagnostics needs no translation.
      const diagnostics = await extractDiagnostics(resultBundlePath, workdir).catch(() => []);

      if (rc !== 0 || !artifactPath) {
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

      const scheme = guestScheme || path.basename(artifactPath).replace(/\.(app|xcarchive)$/, '');
      // Authoritative bundle id comes from the BUILT app, not the upload hint:
      // the hint is optional (empty => `simctl launch` with no id) and can be
      // stale (=> launching the wrong app). Matches the local backend.
      // Authoritative bundle id from the BUILT product (the hint is optional and
      // can be stale). For an archive the app sits inside Products/Applications.
      const appForId =
        kind === 'archive'
          ? (await execAsync(
              `ls -d ${q(path.join(artifactPath, 'Products', 'Applications'))}/*.app 2>/dev/null | head -1`,
            )).stdout.trim()
          : artifactPath;
      const bundleId =
        (appForId ? await readAppBundleId(appForId).catch(() => null) : null) ??
        project.bundleId ??
        '';
      if (!bundleId) throw new Error('could not determine bundle id from the built product');
      // Phase breakdown: without this a slow/stuck build is a black box. (The
      // first pool attempt looked "warm" while silently building cold on disk.)
      log(
        `vm ${kind} build ok: scheme=${scheme} in ${Date.now() - startedAt}ms ` +
          `[vm-wait ${((tGotVm - tCheckout) / 1000).toFixed(1)}s, ` +
          `transfer ${((tXfer - tGotVm) / 1000).toFixed(1)}s, ` +
          `compile ${((tCompiled - tXfer) / 1000).toFixed(1)}s, ` +
          `artifacts ${((Date.now() - tCompiled) / 1000).toFixed(1)}s] ${artifactPath}`,
      );

      return {
        artifactPath,
        scheme,
        bundleId,
        durationMs: Date.now() - startedAt,
        diagnostics,
      };
    } finally {
      // Disposable by construction: the VM is destroyed after every build, so
      // no state (or lingering process) survives to the next tenant.
      // Single-use: the VM is destroyed and the pool replenishes in background,
      // so teardown never sits on the user's critical path.
      releaseVm(booted);
      vm = null;
      rmSync(stage, { recursive: true, force: true });
      // Only the current owner clears the entry; a superseded handle must leave
      // the newer build's generation intact.
      if (sessionGeneration.get(sessionId) === myGen) sessionGeneration.delete(sessionId);
    }
  })();

  return { done, cancel };
}

/**
 * Simulator-preview flavor — the original `runBuild` contract, backed by the VM
 * compiler. Kept as a wrapper so the session.ts call site stays backend-agnostic.
 */
/**
 * Start filling the warm pool. Called at host-agent startup so the FIRST build
 * after a restart is also fast; safe to call repeatedly (tops up to SLOTS).
 */
export function primeVmBuildPool(): void {
  if (!BUILDS_ROOT.startsWith('/tmp/')) {
    warn('vm-queue pool not primed: BUILDS_ROOT is not guest-writable');
    return;
  }
  void reapOrphanedVms().then(() => {
    log(`priming ${SLOTS} warm build VM(s) (ramdisk ${RAMDISK_MB}MB)…`);
    topUpPool();
  });
}

/**
 * Destroy build VMs left behind by a previous host-agent process. Without this,
 * a restart leaks its warm pool and the leftovers consume the 2-guest limit —
 * every subsequent build then fails with "The number of VMs exceeds the system
 * limit". Only our own `bfbuild-` clones are touched; golden images are not.
 */
async function reapOrphanedVms(): Promise<void> {
  const listed = await tart(['list', '--format', 'json'], 30_000);
  if (listed.code !== 0) return;
  let names: string[] = [];
  try {
    names = (JSON.parse(listed.out) as Array<{ Name?: string }>)
      .map((r) => r.Name ?? '')
      .filter((n) => n.startsWith('bfbuild-'));
  } catch {
    return;
  }
  for (const n of names) {
    warn(`reaping orphaned build VM ${n}`);
    await destroyVm(n, null);
  }
}

export function runVmBuild(options: BuildOptions): BuildHandle {
  const inner = runVmCompile({
    jobId: options.sessionId,
    workdir: path.join(BUILDS_ROOT, options.sessionId),
    tarballBuf: options.tarballBuf,
    hints: options.hints,
    onLog: options.onLog,
    kind: 'sim',
  });
  const done = inner.done.then(
    (r): BuildResult => ({
      appBundlePath: r.artifactPath,
      scheme: r.scheme,
      bundleId: r.bundleId,
      durationMs: r.durationMs,
      diagnostics: r.diagnostics,
    }),
  );
  return { done, cancel: inner.cancel };
}

/**
 * Device `.ipa` flavor. The build is UNSIGNED by design (the Botflow Companion
 * re-signs locally with the user's own Apple ID), so the entire thing — compile
 * included — runs in the VM and nothing sensitive is involved. The host only
 * repackages the returned .app into an IPA.
 */
export function runVmDeviceBuild(options: DeviceBuildOptions): DeviceBuildHandle {
  const { buildId, tarballBuf, hints, onLog = () => undefined } = options;
  const workdir = path.join(BUILDS_ROOT, `device-${buildId}`);
  const inner = runVmCompile({
    jobId: `device-${buildId}`,
    workdir,
    tarballBuf,
    hints,
    onLog,
    kind: 'device',
  });

  const done = (async (): Promise<DeviceBuildResult> => {
    const r = await inner.done;
    // Package Payload/<App>.app -> .ipa. Keep the bundle's real name inside
    // Payload/ — renaming to the scheme yields a malformed IPA when
    // PRODUCT_NAME differs from the scheme.
    const ipaRoot = path.join(workdir, 'ipa');
    const payloadDir = path.join(ipaRoot, 'Payload');
    rmSync(ipaRoot, { recursive: true, force: true });
    mkdirSync(payloadDir, { recursive: true });
    const copy = await execAsync(
      `/usr/bin/ditto ${q(r.artifactPath)} ${q(path.join(payloadDir, path.basename(r.artifactPath)))}`,
      { timeoutMs: 120_000 },
    );
    if (copy.code !== 0) throw new Error(`ditto app copy failed: ${sanitize(copy.stderr, workdir)}`);

    const ipaPath = path.join(workdir, `${r.scheme}.ipa`);
    const zip = await execAsync(
      `/usr/bin/ditto -c -k --norsrc --keepParent "Payload" ${q(ipaPath)}`,
      { timeoutMs: 120_000, cwd: ipaRoot },
    );
    if (zip.code !== 0) throw new Error(`IPA packaging failed: ${sanitize(zip.stderr, workdir)}`);

    return {
      ipaPath,
      appBundlePath: r.artifactPath,
      scheme: r.scheme,
      bundleId: r.bundleId,
      durationMs: r.durationMs,
      diagnostics: r.diagnostics,
      unsigned: true,
    };
  })();

  return { done, cancel: inner.cancel };
}

/**
 * App Store flavor. SPLIT BY TRUST: the archive is built UNSIGNED inside the VM
 * (it compiles untrusted code), then signed + exported + uploaded on the HOST.
 * The distribution private key therefore never enters a VM running attacker
 * -controlled build scripts — which is the whole point of the boundary.
 */
export function runVmAppStoreBuild(options: AppStoreBuildOptions): AppStoreBuildHandle {
  const {
    buildId,
    tarballBuf,
    signing,
    hints,
    onLog = () => undefined,
    onPhase = () => undefined,
  } = options;
  const workdir = path.join(BUILDS_ROOT, `appstore-${buildId}`);
  let cancelled = false;
  let innerCancel: (() => void) | null = null;
  const cancel = (): void => {
    cancelled = true;
    innerCancel?.();
  };

  // TRUSTED scratch: never contains uploaded entries, so host-side writes
  // (ExportOptions.plist, cert/CSR material) cannot be redirected by a symlink
  // planted in the project archive — the uploaded tree is rsynced into workdir.
  const trusted = path.join(tmpdir(), `bfassign-${buildId}-${randomBytes(3).toString('hex')}`);

  const done = (async (): Promise<AppStoreBuildResult> => {
    const startedAt = Date.now();
    mkdirSync(trusted, { recursive: true });
    const keychain = process.env.SIGNING_KEYCHAIN;
    const keychainPassword = process.env.SIGNING_KEYCHAIN_PASSWORD;
    if (!keychain || !keychainPassword) {
      throw new Error(
        'App Store signing requires SIGNING_KEYCHAIN and SIGNING_KEYCHAIN_PASSWORD ' +
          'to be set in the host-agent environment.',
      );
    }

    if (cancelled) throw new BuildAborted();

    // ── Compile + archive (UNSIGNED) inside the VM ──
    const inner = runVmCompile({
      jobId: `appstore-${buildId}`,
      workdir,
      tarballBuf,
      hints,
      onLog,
      kind: 'archive',
      archiveMeta: {
        bundleId: signing.bundleId,
        marketingVersion: signing.marketingVersion,
        buildNumber: signing.buildNumber,
      },
    });
    innerCancel = inner.cancel;
    const r = await inner.done;
    const archivePath = r.artifactPath;
    if (cancelled) throw new BuildAborted();

    // ── Sign + export on the HOST (keychain never leaves it) ──
    onPhase('exporting');
    const p8 = normalizeP8(Buffer.from(signing.p8Base64, 'base64').toString('utf8'));
    const auth = { keyId: signing.keyId, issuerId: signing.issuerId, p8 };
    await unlockSigningKeychain(onLog);
    const { signingIdentity, profileName } = await ensureSigningAssets({
      auth,
      teamId: signing.teamId,
      bundleId: signing.bundleId,
      appName: r.scheme,
      keychain,
      keychainPassword,
      // Cert/CSR scratch (dist.key, dist.p12, …) also goes to trusted scratch.
      workdir: trusted,
      onLog,
    });

    const exportPath = path.join(trusted, 'export');
    const exportPlist = path.join(trusted, 'ExportOptions.plist');
    writeFileSync(
      exportPlist,
      exportOptionsPlist(signing.teamId, signing.bundleId, profileName, signingIdentity),
    );
    // Re-unlock immediately before export: codesign runs again here and a
    // re-locked keychain fails the re-sign silently.
    await unlockSigningKeychain(onLog);
    const exported = await execAsync(
      `/usr/bin/xcodebuild -exportArchive -archivePath ${q(archivePath)} ` +
        `-exportPath ${q(exportPath)} -exportOptionsPlist ${q(exportPlist)} ` +
        `OTHER_CODE_SIGN_FLAGS=--keychain\\ ${q(keychain)}`,
      { timeoutMs: 20 * 60_000, cwd: trusted },
    );
    for (const line of `${exported.stdout}${exported.stderr}`.split('\n')) {
      const clean = sanitizeLine(line, workdir);
      if (clean) onLog(clean, 'stdout');
    }
    if (exported.code !== 0) {
      throw new Error(`xcodebuild -exportArchive exited ${exported.code}`);
    }
    if (cancelled) throw new BuildAborted();

    const ipaGlob = await execAsync(`ls ${q(exportPath)}/*.ipa 2>/dev/null | head -1`);
    const ipaPath = ipaGlob.stdout.trim();
    if (!ipaPath) throw new Error('Export succeeded but no .ipa was produced');

    // ── Upload ──
    onPhase('uploading');
    const uploadResult = await uploadIpaToAppStoreConnect({
      auth,
      ascAppId: signing.ascAppId,
      ipaPath,
      cfBundleVersion: signing.buildNumber,
      cfBundleShortVersionString: signing.marketingVersion,
      onLog: (line) => onLog(line, 'stdout'),
    });

    return {
      scheme: r.scheme,
      bundleId: signing.bundleId,
      marketingVersion: signing.marketingVersion,
      buildNumber: signing.buildNumber,
      durationMs: Date.now() - startedAt,
      diagnostics: r.diagnostics,
      buildUploadId: uploadResult.buildUploadId,
      uploadState: uploadResult.state,
    };
  })().finally(() => {
    // Holds the exported .ipa + cert scratch; without this every publish leaks
    // a full IPA outside BUILDS_ROOT.
    rmSync(trusted, { recursive: true, force: true });
  });

  return { done, cancel };
}

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BuildDiagnostic, LogStream } from '@sim/shared';
import { execAsync } from './util.js';
import { log, warn } from './log.js';
import { parseProjectYml, type ProjectInfo } from './project-yml.js';
import { extractDiagnostics, sanitizeLine } from './build-diagnostics.js';
import { normalizeP8, uploadIpaToAppStoreConnect } from './asc-upload.js';
import { ensureSigningAssets } from './asc-signing.js';
import { ensureAppStoreIcon } from './default-icon.js';

const BUILDS_ROOT = path.join(tmpdir(), 'sim-builds');

export interface BuildResult {
  appBundlePath: string;
  scheme: string;
  bundleId: string;
  durationMs: number;
  /** Authoritative structured diagnostics extracted from the .xcresult bundle.
   * Empty array on success with no warnings, or when extraction failed. */
  diagnostics: BuildDiagnostic[];
}

export interface DeviceBuildResult {
  ipaPath: string;
  appBundlePath: string;
  scheme: string;
  bundleId: string;
  durationMs: number;
  diagnostics: BuildDiagnostic[];
  unsigned: true;
}

export interface BuildOptions {
  sessionId: string;
  tarballBuf: Buffer;
  hints?: Partial<ProjectInfo>;
  onLog: (line: string, stream: LogStream) => void;
}

export interface DeviceBuildOptions {
  buildId: string;
  tarballBuf: Buffer;
  hints?: Partial<ProjectInfo>;
  onLog?: (line: string, stream: LogStream) => void;
}

export class BuildAborted extends Error {
  constructor() {
    super('build aborted');
  }
}

/**
 * Shared build prologue: clean + recreate the workdir, untar the project,
 * parse `project.yml`, regenerate the xcodeproj via xcodegen (project.yml is
 * the source of truth — see the rename note inline), and locate the
 * .xcodeproj (re-deriving the scheme from a glob if the conventional name is
 * missing). Used by all three build flavors (simulator, device, App Store).
 */
async function prepareWorkdir(opts: {
  workdir: string;
  /** Log prefix for the parsed-project line ('Project', 'Device build', …). */
  logLabel: string;
  /** Human noun for error/warn messages ('workdir', 'device build workdir', …). */
  where: string;
  tarballBuf: Buffer;
  hints?: Partial<ProjectInfo>;
  onLog: (line: string, stream: LogStream) => void;
  isCancelled: () => boolean;
}): Promise<ProjectInfo> {
  const { workdir, logLabel, where, tarballBuf, hints, onLog, isCancelled } = opts;
  if (existsSync(workdir)) {
    try {
      rmSync(workdir, { recursive: true, force: true });
    } catch (e) {
      warn(`Could not clean ${where} ${workdir}: ${(e as Error).message}`);
    }
  }
  mkdirSync(workdir, { recursive: true });

  // ── Extract tarball via tar -xz piped from stdin ──
  await new Promise<void>((resolve, reject) => {
    const tar = spawn('tar', ['-xzf', '-', '-C', workdir]);
    let stderr = '';
    tar.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    tar.on('exit', (code) => {
      if (isCancelled()) return reject(new BuildAborted());
      if (code === 0) return resolve();
      reject(new Error(`tar exited ${code}: ${stderr.trim()}`));
    });
    tar.on('error', reject);
    tar.stdin.write(tarballBuf);
    tar.stdin.end();
  });

  if (isCancelled()) throw new BuildAborted();

  const project = parseProjectYml(workdir, hints);
  log(`${logLabel}: scheme=${project.scheme} bundleId=${project.bundleId}`);

  // ── Regenerate xcodeproj from project.yml if possible ──
  // project.yml is the source of truth for swift-template projects. If the
  // user renamed the project there (MyApp → TodoApp) the on-disk xcodeproj
  // is stale until xcodegen runs. Without this step we'd build the OLD app
  // (MyApp.app) and then fail to launch the NEW bundle id.
  const projectYmlPath = path.join(workdir, 'project.yml');
  if (existsSync(projectYmlPath)) {
    const probe = await execAsync('command -v xcodegen', { timeoutMs: 5_000 });
    if (probe.code === 0 && probe.stdout.trim()) {
      const gen = await execAsync(`cd "${workdir}" && xcodegen generate`, {
        timeoutMs: 60_000,
      });
      if (gen.code !== 0) {
        // Non-fatal — fall through to the glob fallback below. If the
        // .xcodeproj already exists we can still build with it.
        onLog(
          `xcodegen failed (${gen.code}): ${(gen.stderr || gen.stdout).split('\n')[0]}`,
          'stderr',
        );
      } else {
        onLog('xcodegen regenerated project from project.yml', 'stdout');
      }
    } else {
      onLog(
        'project.yml present but xcodegen not installed on host — using stale .xcodeproj',
        'stderr',
      );
    }
  }

  // ── Locate the xcodeproj (named after the scheme by convention) ──
  const xcodeproj = path.join(workdir, `${project.scheme}.xcodeproj`);
  if (!existsSync(xcodeproj)) {
    // Fall back: glob for any .xcodeproj in the workdir root.
    const glob = await execAsync(`ls -d "${workdir}"/*.xcodeproj 2>/dev/null | head -1`);
    const found = glob.stdout.trim();
    if (!found) {
      throw new Error(`No .xcodeproj found in ${where} (expected ${project.scheme}.xcodeproj).`);
    }
    // Re-derive scheme from the basename. NOTE: bundleId stays as parsed
    // from project.yml — it may not match the .app we're about to build.
    // Callers reconcile that after the build by reading the .app's Info.plist.
    project.scheme = path.basename(found, '.xcodeproj');
  }
  return project;
}

/**
 * Pipe an xcodebuild process's stdout/stderr through `sanitizeLine` to `onLog`,
 * line-buffered. This is the single chokepoint that strips workdir/session-id,
 * Xcode paths, /Users/<name>/, and drops destination-enumeration blocks — so
 * nothing sensitive ever crosses the wire, even in the raw log disclosure on
 * the browser side.
 */
function wireXcodebuildOutput(
  proc: ChildProcess,
  workdir: string,
  onLog: (line: string, stream: LogStream) => void,
): void {
  const wire = (readable: NodeJS.ReadableStream | null, stream: LogStream): void => {
    if (!readable) return;
    let buf = '';
    const emit = (raw: string): void => {
      const cleaned = sanitizeLine(raw, workdir);
      if (cleaned && cleaned.length > 0) onLog(cleaned, stream);
    };
    readable.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) if (line.length > 0) emit(line);
    });
    readable.on('end', () => {
      if (buf.length > 0) emit(buf);
    });
  };
  wire(proc.stdout, 'stdout');
  wire(proc.stderr, 'stderr');
}

/**
 * Untar the project into a per-session workdir, parse `project.yml`, then run
 * `xcodebuild` and stream stdout/stderr line-by-line via `onLog`. Resolves with
 * the absolute path to the built `.app` bundle on success.
 *
 * The returned handle exposes `cancel()` so a stale build can be killed if the
 * user clicks Refresh while a build is in flight.
 */
export interface BuildHandle {
  done: Promise<BuildResult>;
  cancel: () => void;
}

export interface DeviceBuildHandle {
  done: Promise<DeviceBuildResult>;
  cancel: () => void;
}

export function runBuild(options: BuildOptions): BuildHandle {
  const { sessionId, tarballBuf, hints, onLog } = options;
  const workdir = path.join(BUILDS_ROOT, sessionId);
  let proc: ChildProcess | null = null;
  let cancelled = false;

  const cancel = (): void => {
    cancelled = true;
    if (proc && !proc.killed) proc.kill('SIGTERM');
  };

  const done = (async (): Promise<BuildResult> => {
    const project = await prepareWorkdir({
      workdir,
      logLabel: 'Project',
      where: 'workdir',
      tarballBuf,
      hints,
      onLog,
      isCancelled: () => cancelled,
    });

    const derivedData = path.join(workdir, 'build');
    const startedAt = Date.now();

    // ── 4. Run xcodebuild, streaming output line-by-line ──
    // -resultBundlePath writes a .xcresult bundle we parse post-exit for
    // authoritative structured diagnostics. Must not pre-exist or xcodebuild
    // refuses to overwrite.
    const resultBundlePath = path.join(workdir, 'result.xcresult');
    try {
      rmSync(resultBundlePath, { recursive: true, force: true });
    } catch {
      /* fine */
    }

    let xcExitCode: number | null = null;
    await new Promise<void>((resolve, reject) => {
      const args = [
        '-project',
        path.join(workdir, `${project.scheme}.xcodeproj`),
        '-scheme',
        project.scheme,
        '-sdk',
        'iphonesimulator',
        '-derivedDataPath',
        derivedData,
        '-resultBundlePath',
        resultBundlePath,
        // Apple Silicon hosts only need the arm64 simulator slice. Without
        // these, xcodebuild uses ARCHS_STANDARD for iphonesimulator which
        // also tries x86_64 — wasted time and a frequent source of arch-
        // specific build flakes (binary-only arm64 SwiftPM deps, etc.).
        'ONLY_ACTIVE_ARCH=YES',
        'ARCHS=arm64',
        'CODE_SIGN_IDENTITY=',
        'CODE_SIGNING_REQUIRED=NO',
        'CODE_SIGNING_ALLOWED=NO',
        // Preview-only orientation enablement: let Botflow's orientation toggle
        // rotate ANY project — even ones scaffolded before the template gained a
        // supported-orientations list. These override the generated Info.plist
        // (only effective with GENERATE_INFOPLIST_FILE=YES, which the templates
        // use). UIRequiresFullScreen is required so iPadOS doesn't reject the
        // geometry change in windowed/Stage-Manager mode. This affects the
        // simulator preview build only — never the user's device/App Store build.
        'INFOPLIST_KEY_UIRequiresFullScreen=YES',
        'INFOPLIST_KEY_UISupportedInterfaceOrientations_iPhone=UIInterfaceOrientationPortrait UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight',
        'INFOPLIST_KEY_UISupportedInterfaceOrientations_iPad=UIInterfaceOrientationPortrait UIInterfaceOrientationPortraitUpsideDown UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight',
        'build',
      ];
      log(`xcodebuild ${args.join(' ')}`);
      proc = spawn('xcodebuild', args, { cwd: workdir });
      wireXcodebuildOutput(proc, workdir, onLog);

      proc.on('exit', (code) => {
        xcExitCode = code;
        if (cancelled) return reject(new BuildAborted());
        // Resolve regardless of exit code so we can extract diagnostics
        // either way; we re-check `code` below and throw the build error
        // *after* diagnostics are pulled.
        resolve();
      });
      proc.on('error', reject);
    });

    // Pull authoritative structured diagnostics from the xcresult bundle.
    // Best-effort: extractDiagnostics returns [] on any failure and must
    // never throw. We pull on both success (for warnings) and failure.
    const diagnostics = await extractDiagnostics(resultBundlePath, workdir);

    if (xcExitCode !== 0) {
      const err = new Error(`xcodebuild exited ${xcExitCode}`);
      // Attach diagnostics so the caller can surface them on a failed build.
      (err as Error & { diagnostics?: BuildDiagnostic[] }).diagnostics = diagnostics;
      throw err;
    }

    // Same caveat as the device build below: the .app is named after
    // PRODUCT_NAME and lives under `<Configuration>-iphonesimulator`, neither of
    // which is guaranteed to equal `${project.scheme}` / `Debug`. Try the
    // conventional path first, then discover the real product.
    let appBundlePath = path.join(
      derivedData,
      'Build/Products/Debug-iphonesimulator',
      `${project.scheme}.app`,
    );
    if (!existsSync(appBundlePath)) {
      const productsDir = path.join(derivedData, 'Build/Products');
      const glob = await execAsync(
        `find "${productsDir}" -maxdepth 2 -type d -name '*.app' -path '*-iphonesimulator/*.app' 2>/dev/null | head -1`,
      );
      const found = glob.stdout.trim();
      if (found) {
        log(`.app not at conventional path — discovered at ${path.basename(found)}`);
        appBundlePath = found;
      }
    }
    if (!existsSync(appBundlePath)) {
      throw new Error(`Build succeeded but .app missing at ${appBundlePath}`);
    }

    // Read the *actual* bundle id from the built .app's Info.plist — the
    // single source of truth for what simctl will see after `install`. If it
    // diverges from project.yml (stale xcodeproj, no xcodegen, hand-edits),
    // we trust the .app and launch that.
    const installedBundleId = await readAppBundleId(appBundlePath);
    if (installedBundleId && installedBundleId !== project.bundleId) {
      log(
        `bundleId mismatch: project.yml says ${project.bundleId}, ` +
          `.app Info.plist says ${installedBundleId} — using ${installedBundleId} for launch`,
      );
      project.bundleId = installedBundleId;
    }

    return {
      appBundlePath,
      scheme: project.scheme,
      bundleId: project.bundleId,
      durationMs: Date.now() - startedAt,
      diagnostics,
    };
  })();

  return { done, cancel };
}

/**
 * Build an unsigned physical-device IPA. This is the cloud side of Botflow's
 * local companion flow:
 *
 *   cloud Mac: compile Swift project for iphoneos → unsigned .ipa
 *   user Mac: Botflow Companion signs/provisions/installs with user's Apple ID
 *
 * This deliberately does NOT touch simulator sessions, boot a simulator, or
 * invoke simctl. The output is an installable IPA-shaped zip with Payload/*.app;
 * AltSign/AltServer will replace signing assets locally before device install.
 */
export function runDeviceBuild(options: DeviceBuildOptions): DeviceBuildHandle {
  const { buildId, tarballBuf, hints, onLog = () => undefined } = options;
  const workdir = path.join(BUILDS_ROOT, `device-${buildId}`);
  let proc: ChildProcess | null = null;
  let cancelled = false;

  const cancel = (): void => {
    cancelled = true;
    if (proc && !proc.killed) proc.kill('SIGTERM');
  };

  const done = (async (): Promise<DeviceBuildResult> => {
    const project = await prepareWorkdir({
      workdir,
      logLabel: 'Device build',
      where: 'device build workdir',
      tarballBuf,
      hints,
      onLog,
      isCancelled: () => cancelled,
    });

    const derivedData = path.join(workdir, 'build');
    const resultBundlePath = path.join(workdir, 'device-result.xcresult');
    try {
      rmSync(resultBundlePath, { recursive: true, force: true });
    } catch {
      /* fine */
    }

    const startedAt = Date.now();
    let xcExitCode: number | null = null;
    await new Promise<void>((resolve, reject) => {
      const args = [
        '-project',
        path.join(workdir, `${project.scheme}.xcodeproj`),
        '-scheme',
        project.scheme,
        '-sdk',
        'iphoneos',
        '-destination',
        'generic/platform=iOS',
        '-derivedDataPath',
        derivedData,
        '-resultBundlePath',
        resultBundlePath,
        'CODE_SIGN_IDENTITY=',
        'CODE_SIGNING_REQUIRED=NO',
        'CODE_SIGNING_ALLOWED=NO',
        // Xcode 16 Debug builds otherwise split into a thin launcher + a
        // <App>.debug.dylib (and __preview.dylib) that only run under Xcode's
        // harness — installed standalone they launch then crash instantly.
        // Disable both so the device IPA is a normal self-contained binary.
        'ENABLE_DEBUG_DYLIB=NO',
        'ENABLE_PREVIEWS=NO',
        'build',
      ];
      log(`device xcodebuild ${args.join(' ')}`);
      proc = spawn('xcodebuild', args, { cwd: workdir });
      wireXcodebuildOutput(proc, workdir, onLog);

      proc.on('exit', (code) => {
        xcExitCode = code;
        if (cancelled) return reject(new BuildAborted());
        resolve();
      });
      proc.on('error', reject);
    });

    const diagnostics = await extractDiagnostics(resultBundlePath, workdir);
    if (xcExitCode !== 0) {
      const err = new Error(`xcodebuild exited ${xcExitCode}`);
      (err as Error & { diagnostics?: BuildDiagnostic[] }).diagnostics = diagnostics;
      throw err;
    }

    // The built bundle is named after the target's PRODUCT_NAME and lives in a
    // `<Configuration>-iphoneos` directory — NEITHER of which is guaranteed to
    // equal `${project.scheme}` / `Debug`. `project.scheme` comes from the
    // project.yml top-level `name:`, while the .app filename is PRODUCT_NAME and
    // the dir is the scheme's build configuration; they only coincide in the
    // stock template. A renamed PRODUCT_NAME or a non-Debug scheme leaves a
    // *successful* build's product at a sibling path (e.g. Release-iphoneos/, or
    // <ProductName>.app), so reconstructing the path from those assumptions
    // misses it. Try the conventional path first, then discover the real one.
    let appBundlePath = path.join(
      derivedData,
      'Build/Products/Debug-iphoneos',
      `${project.scheme}.app`,
    );
    if (!existsSync(appBundlePath)) {
      const productsDir = path.join(derivedData, 'Build/Products');
      const glob = await execAsync(
        `find "${productsDir}" -maxdepth 2 -type d -name '*.app' -path '*-iphoneos/*.app' 2>/dev/null | head -1`,
      );
      const found = glob.stdout.trim();
      if (found) {
        log(`device .app not at conventional path — discovered at ${path.basename(found)}`);
        appBundlePath = found;
      }
    }
    if (!existsSync(appBundlePath)) {
      throw new Error(`Device build succeeded but .app missing at ${appBundlePath}`);
    }

    const installedBundleId = await readAppBundleId(appBundlePath);
    if (installedBundleId && installedBundleId !== project.bundleId) {
      log(
        `device bundleId mismatch: project.yml says ${project.bundleId}, ` +
          `.app Info.plist says ${installedBundleId} — using ${installedBundleId}`,
      );
      project.bundleId = installedBundleId;
    }

    const ipaRoot = path.join(workdir, 'ipa');
    const payloadDir = path.join(ipaRoot, 'Payload');
    // Keep the bundle's real name inside Payload/ — renaming it to the scheme
    // would produce a malformed IPA when PRODUCT_NAME differs from the scheme.
    const payloadAppPath = path.join(payloadDir, path.basename(appBundlePath));
    mkdirSync(payloadDir, { recursive: true });

    const copy = await execAsync(
      `/usr/bin/ditto "${appBundlePath}" "${payloadAppPath}"`,
      { timeoutMs: 60_000 },
    );
    if (copy.code !== 0) {
      throw new Error(`ditto app copy failed: ${copy.stderr || copy.stdout}`);
    }

    const ipaPath = path.join(workdir, `${project.scheme}.ipa`);
    const zip = await execAsync(
      `/usr/bin/ditto -c -k --norsrc --keepParent "Payload" "${ipaPath}"`,
      { timeoutMs: 60_000, cwd: ipaRoot },
    );
    if (zip.code !== 0) {
      throw new Error(`IPA packaging failed: ${zip.stderr || zip.stdout}`);
    }

    return {
      ipaPath,
      appBundlePath,
      scheme: project.scheme,
      bundleId: project.bundleId,
      durationMs: Date.now() - startedAt,
      diagnostics,
      unsigned: true,
    };
  })();

  return { done, cancel };
}

export interface AppStoreSigningInput {
  teamId: string;
  keyId: string;
  issuerId: string;
  /** Base64 of the ASC .p8 PEM. Decoded in-memory to mint ASC JWTs for the
   * device-free signing flow (cert/profile management) and the upload — never
   * written to disk. */
  p8Base64: string;
  /** ASC `apps` resource id the build uploads to. */
  ascAppId: string;
  bundleId: string;
  marketingVersion: string;
  buildNumber: string;
}

export interface AppStoreBuildOptions {
  buildId: string;
  tarballBuf: Buffer;
  signing: AppStoreSigningInput;
  hints?: Partial<ProjectInfo>;
  onLog?: (line: string, stream: LogStream) => void;
  /** Coarse phase signal relayed to the controller. */
  onPhase?: (phase: 'exporting' | 'uploading') => void;
}

export interface AppStoreBuildResult {
  scheme: string;
  bundleId: string;
  marketingVersion: string;
  buildNumber: string;
  durationMs: number;
  diagnostics: BuildDiagnostic[];
  buildUploadId: string;
  /** ASC upload state when we stopped watching: 'PROCESSING' or 'COMPLETE'. */
  uploadState: string;
}

export interface AppStoreBuildHandle {
  done: Promise<AppStoreBuildResult>;
  cancel: () => void;
}

/**
 * Best-effort unlock of the dedicated signing keychain before an archive.
 * Configured via SIGNING_KEYCHAIN (name or path) + SIGNING_KEYCHAIN_PASSWORD
 * in the host-agent env. Needed because the agent runs over a non-GUI
 * session: the login keychain may be locked, and codesign must reach the
 * distribution cert's private key without a prompt. One-time box setup must
 * also run `security set-key-partition-list -S apple-tool:,apple: -s -k <pw>
 * <keychain>` after the cert is first created, or codesign hangs on a GUI
 * permission dialog nothing can click.
 */
async function unlockSigningKeychain(
  onLog: (line: string, stream: LogStream) => void,
): Promise<void> {
  const kc = process.env.SIGNING_KEYCHAIN;
  const pw = process.env.SIGNING_KEYCHAIN_PASSWORD;
  if (!kc || !pw) {
    onLog(
      'SIGNING_KEYCHAIN not configured — relying on an already-unlocked default keychain',
      'stderr',
    );
    return;
  }
  const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
  const res = await execAsync(`security unlock-keychain -p ${q(pw)} ${q(kc)}`, {
    timeoutMs: 10_000,
  });
  if (res.code !== 0) {
    onLog(
      `Could not unlock signing keychain (${res.code}): ${(res.stderr || res.stdout).split('\n')[0]}`,
      'stderr',
    );
  }
}

/**
 * Build a distribution-signed IPA and upload it to App Store Connect. This is
 * the "Publish" target — distinct from runDeviceBuild's unsigned companion
 * path.
 *
 * Signing is MANUAL and device-free. Automatic signing
 * (`-allowProvisioningUpdates`) fails on a headless build server with no
 * registered devices ("Your team has no devices from which to generate a
 * provisioning profile"). Instead ensureSigningAssets() drives the ASC REST
 * API to mint/reuse a distribution cert (imported into the signing keychain)
 * and an IOS_APP_STORE profile, then xcodebuild signs against those.
 *
 *   ensureSigningAssets (ASC API: bundle id + cert + profile)
 *   → archive (iphoneos, manual signing) → -exportArchive (manual, app-store-connect)
 *   → BuildUpload REST upload → state PROCESSING/COMPLETE
 *
 * 'succeeded' means Apple ACCEPTED the package. TestFlight processing state
 * is polled platform-side afterward via the ASC API.
 */
export function runAppStoreBuild(options: AppStoreBuildOptions): AppStoreBuildHandle {
  const {
    buildId,
    tarballBuf,
    signing,
    hints,
    onLog = () => undefined,
    onPhase = () => undefined,
  } = options;
  const workdir = path.join(BUILDS_ROOT, `appstore-${buildId}`);
  let proc: ChildProcess | null = null;
  let cancelled = false;

  const cancel = (): void => {
    cancelled = true;
    if (proc && !proc.killed) proc.kill('SIGTERM');
  };

  const done = (async (): Promise<AppStoreBuildResult> => {
    const project = await prepareWorkdir({
      workdir,
      logLabel: 'App Store build',
      where: 'app store build workdir',
      tarballBuf,
      hints,
      onLog,
      isCancelled: () => cancelled,
    });

    // Preflight: guarantee a 1024px app icon (Apple fails processing without one).
    // No-op when the project already ships its own icon. Covers projects seeded
    // from older templates that lacked a default icon PNG.
    await ensureAppStoreIcon(workdir, onLog);

    await unlockSigningKeychain(onLog);

    // Signing now REQUIRES the dedicated keychain — the distribution cert's
    // private key lives there and codesign must reach it without a GUI prompt.
    const keychain = process.env.SIGNING_KEYCHAIN;
    const keychainPassword = process.env.SIGNING_KEYCHAIN_PASSWORD;
    if (!keychain || !keychainPassword) {
      throw new Error(
        'App Store signing requires SIGNING_KEYCHAIN and SIGNING_KEYCHAIN_PASSWORD ' +
          'to be set in the host-agent environment (device-free distribution signing ' +
          'imports the cert into a dedicated keychain).',
      );
    }

    // p8 is kept in-memory only — used to mint ASC JWTs for cert/profile
    // management and the upload. Never written to disk.
    const p8 = normalizeP8(Buffer.from(signing.p8Base64, 'base64').toString('utf8'));
    const auth = { keyId: signing.keyId, issuerId: signing.issuerId, p8 };

    const archivePath = path.join(workdir, `${project.scheme}.xcarchive`);
    const exportPath = path.join(workdir, 'export');
    const derivedData = path.join(workdir, 'build');
    const resultBundlePath = path.join(workdir, 'appstore-result.xcresult');
    try {
      rmSync(resultBundlePath, { recursive: true, force: true });
    } catch {
      /* fine */
    }

    const startedAt = Date.now();
    {
      // ── 1. Ensure device-free distribution signing assets via the ASC API ──
      // Mints/reuses the distribution cert (into the signing keychain) and an
      // IOS_APP_STORE provisioning profile (no devices), and installs the
      // profile locally. Returns the identity + profile name for manual signing.
      const { signingIdentity, profileName } = await ensureSigningAssets({
        auth,
        teamId: signing.teamId,
        bundleId: signing.bundleId,
        appName: project.scheme,
        keychain,
        keychainPassword,
        workdir,
        onLog,
      });
      if (cancelled) throw new BuildAborted();

      // ── 2. Archive (distribution-signed, MANUAL signing) ──
      let xcExitCode: number | null = null;
      await new Promise<void>((resolve, reject) => {
        const args = [
          'archive',
          '-project',
          path.join(workdir, `${project.scheme}.xcodeproj`),
          '-scheme',
          project.scheme,
          '-sdk',
          'iphoneos',
          '-destination',
          'generic/platform=iOS',
          '-archivePath',
          archivePath,
          '-derivedDataPath',
          derivedData,
          '-resultBundlePath',
          resultBundlePath,
          'CODE_SIGN_STYLE=Manual',
          `CODE_SIGN_IDENTITY=${signingIdentity}`,
          `PROVISIONING_PROFILE_SPECIFIER=${profileName}`,
          `DEVELOPMENT_TEAM=${signing.teamId}`,
          // The publish wizard owns the final identity/version — override
          // whatever dev values project.yml carries.
          `PRODUCT_BUNDLE_IDENTIFIER=${signing.bundleId}`,
          `MARKETING_VERSION=${signing.marketingVersion}`,
          `CURRENT_PROJECT_VERSION=${signing.buildNumber}`,
          // codesign must use the dedicated signing keychain (where the
          // distribution private key was imported), not the login keychain.
          `OTHER_CODE_SIGN_FLAGS=--keychain ${keychain}`,
          // Same Xcode 16 standalone-binary settings as device builds.
          'ENABLE_DEBUG_DYLIB=NO',
          'ENABLE_PREVIEWS=NO',
        ];
        log(`appstore xcodebuild archive (scheme=${project.scheme} team=${signing.teamId})`);
        proc = spawn('xcodebuild', args, { cwd: workdir });
        wireXcodebuildOutput(proc, workdir, onLog);
        proc.on('exit', (code) => {
          xcExitCode = code;
          if (cancelled) return reject(new BuildAborted());
          // Resolve regardless of exit code so diagnostics get extracted;
          // the error is thrown after the pull, same as the other builds.
          resolve();
        });
        proc.on('error', reject);
      });

      const diagnostics = await extractDiagnostics(resultBundlePath, workdir);
      if (xcExitCode !== 0) {
        const err = new Error(`xcodebuild archive exited ${xcExitCode}`);
        (err as Error & { diagnostics?: BuildDiagnostic[] }).diagnostics = diagnostics;
        throw err;
      }
      if (cancelled) throw new BuildAborted();

      // ── 3. Export the signed .ipa (MANUAL signing) ──
      onPhase('exporting');
      const exportPlist = path.join(workdir, 'ExportOptions.plist');
      writeFileSync(
        exportPlist,
        exportOptionsPlist(signing.teamId, signing.bundleId, profileName),
      );
      // Re-unlock right before export — codesign runs again here and a
      // re-locked keychain would silently fail the re-sign.
      await unlockSigningKeychain(onLog);
      await new Promise<void>((resolve, reject) => {
        const args = [
          '-exportArchive',
          '-archivePath',
          archivePath,
          '-exportPath',
          exportPath,
          '-exportOptionsPlist',
          exportPlist,
          `OTHER_CODE_SIGN_FLAGS=--keychain ${keychain}`,
        ];
        proc = spawn('xcodebuild', args, { cwd: workdir });
        wireXcodebuildOutput(proc, workdir, onLog);
        proc.on('exit', (code) => {
          if (cancelled) return reject(new BuildAborted());
          if (code === 0) return resolve();
          reject(new Error(`xcodebuild -exportArchive exited ${code}`));
        });
        proc.on('error', reject);
      });

      const ipaGlob = await execAsync(`ls "${exportPath}"/*.ipa 2>/dev/null | head -1`);
      const ipaPath = ipaGlob.stdout.trim();
      if (!ipaPath) {
        throw new Error(`Export succeeded but no .ipa found in ${exportPath}`);
      }
      if (cancelled) throw new BuildAborted();

      // ── 3. Upload to App Store Connect ──
      onPhase('uploading');
      const uploadResult = await uploadIpaToAppStoreConnect({
        auth: { keyId: signing.keyId, issuerId: signing.issuerId, p8 },
        ascAppId: signing.ascAppId,
        ipaPath,
        cfBundleVersion: signing.buildNumber,
        cfBundleShortVersionString: signing.marketingVersion,
        onLog: (line) => onLog(line, 'stdout'),
      });

      return {
        scheme: project.scheme,
        bundleId: signing.bundleId,
        marketingVersion: signing.marketingVersion,
        buildNumber: signing.buildNumber,
        durationMs: Date.now() - startedAt,
        diagnostics,
        buildUploadId: uploadResult.buildUploadId,
        uploadState: uploadResult.state,
      };
    }
  })();

  return { done, cancel };
}

function exportOptionsPlist(teamId: string, bundleId: string, profileName: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>app-store-connect</string>
  <key>teamID</key>
  <string>${teamId}</string>
  <key>signingStyle</key>
  <string>manual</string>
  <key>provisioningProfiles</key>
  <dict>
    <key>${bundleId}</key>
    <string>${profileName}</string>
  </dict>
  <key>signingCertificate</key>
  <string>Apple Distribution</string>
  <key>uploadSymbols</key>
  <true/>
  <key>destination</key>
  <string>export</string>
</dict>
</plist>
`;
}

/**
 * Read CFBundleIdentifier from a built .app's Info.plist via `plutil`.
 * Handles both binary and XML plist formats. Returns null on any failure
 * (caller falls back to whatever bundleId it parsed from project.yml).
 */
async function readAppBundleId(appBundlePath: string): Promise<string | null> {
  const plist = path.join(appBundlePath, 'Info.plist');
  if (!existsSync(plist)) return null;
  const res = await execAsync(
    `/usr/bin/plutil -extract CFBundleIdentifier raw -o - -- "${plist}"`,
    { timeoutMs: 5_000 },
  );
  if (res.code !== 0) return null;
  const out = res.stdout.trim();
  return out.length > 0 ? out : null;
}

export interface LaunchCameraInjection {
  /** Absolute path to the BotflowCameraShim simulator dylib. */
  dyldPath: string;
  /** ws://127.0.0.1:<port>/camera?session=…&token=… for the shim to dial. */
  cameraUrl: string;
}

export async function installAndLaunch(
  udid: string,
  appBundlePath: string,
  bundleId: string,
  camera?: LaunchCameraInjection | null,
): Promise<void> {
  const install = await execAsync(`xcrun simctl install ${udid} "${appBundlePath}"`, {
    timeoutMs: 60_000,
  });
  if (install.code !== 0) {
    throw new Error(`simctl install failed: ${install.stderr || install.stdout}`);
  }
  // `simctl launch` forwards SIMCTL_CHILD_*-prefixed env vars to the app process.
  // We use that to inject the camera shim (DYLD_INSERT_LIBRARIES) and tell it
  // where to dial for webcam frames — without touching the user's project.
  //
  // NOTE: rotation is NOT done via app-side injection. Forcing the app's
  // interface orientation (requestGeometryUpdate) only rotates the app's view
  // WITHIN a still-portrait device surface — the framebuffer stays portrait and
  // the content renders sideways. True rotation is a DEVICE rotation (the
  // simulator surface itself), handled host-side in rotateSimulator(). The plist
  // overrides above just ensure the app is *allowed* to follow that rotation.
  const env: NodeJS.ProcessEnv | undefined = camera
    ? {
        SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: camera.dyldPath,
        SIMCTL_CHILD_BOTFLOW_CAMERA_URL: camera.cameraUrl,
      }
    : undefined;
  // simctl launch returns immediately with PID; use --terminate-running-process so a
  // rebuild replaces the previous process cleanly.
  const launch = await execAsync(
    `xcrun simctl launch --terminate-running-process ${udid} ${bundleId}`,
    { timeoutMs: 15_000, env },
  );
  if (launch.code !== 0) {
    throw new Error(`simctl launch failed: ${launch.stderr || launch.stdout}`);
  }
}

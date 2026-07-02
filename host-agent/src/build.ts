import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LogStream } from '@sim/shared';
import { execAsync } from './util.js';
import { log, warn } from './log.js';
import { parseProjectYml, type ProjectInfo } from './project-yml.js';

const BUILDS_ROOT = path.join(tmpdir(), 'sim-builds');

export interface BuildResult {
  appBundlePath: string;
  scheme: string;
  bundleId: string;
  durationMs: number;
}

export interface BuildOptions {
  sessionId: string;
  tarballBuf: Buffer;
  hints?: Partial<ProjectInfo>;
  onLog: (line: string, stream: LogStream) => void;
}

export class BuildAborted extends Error {
  constructor() {
    super('build aborted');
  }
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
    if (existsSync(workdir)) {
      try {
        rmSync(workdir, { recursive: true, force: true });
      } catch (e) {
        warn(`Could not clean workdir ${workdir}: ${(e as Error).message}`);
      }
    }
    mkdirSync(workdir, { recursive: true });

    // ── 1. Extract tarball via tar -xz piped from stdin ──
    await new Promise<void>((resolve, reject) => {
      const tar = spawn('tar', ['-xzf', '-', '-C', workdir]);
      let stderr = '';
      tar.stderr.on('data', (d: Buffer) => {
        stderr += d.toString();
      });
      tar.on('exit', (code) => {
        if (cancelled) return reject(new BuildAborted());
        if (code === 0) return resolve();
        reject(new Error(`tar exited ${code}: ${stderr.trim()}`));
      });
      tar.on('error', reject);
      tar.stdin.write(tarballBuf);
      tar.stdin.end();
    });

    if (cancelled) throw new BuildAborted();

    // ── 2. Parse project.yml ──
    const project = parseProjectYml(workdir, hints);
    log(`Project: scheme=${project.scheme} bundleId=${project.bundleId}`);

    // ── 3. Locate the xcodeproj (named after the scheme by convention) ──
    const xcodeproj = path.join(workdir, `${project.scheme}.xcodeproj`);
    if (!existsSync(xcodeproj)) {
      // Fall back: glob for any .xcodeproj in the workdir root.
      const glob = await execAsync(`ls -d "${workdir}"/*.xcodeproj 2>/dev/null | head -1`);
      const found = glob.stdout.trim();
      if (!found) {
        throw new Error(
          `No .xcodeproj found in workdir (expected ${project.scheme}.xcodeproj).`,
        );
      }
      // Re-derive scheme from the basename
      project.scheme = path.basename(found, '.xcodeproj');
    }

    const derivedData = path.join(workdir, 'build');
    const startedAt = Date.now();

    // ── 4. Run xcodebuild, streaming output line-by-line ──
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
        'CODE_SIGN_IDENTITY=',
        'CODE_SIGNING_REQUIRED=NO',
        'CODE_SIGNING_ALLOWED=NO',
        'build',
      ];
      log(`xcodebuild ${args.join(' ')}`);
      proc = spawn('xcodebuild', args, { cwd: workdir });

      const wireLineStream = (
        readable: NodeJS.ReadableStream | null,
        stream: LogStream,
      ): void => {
        if (!readable) return;
        let buf = '';
        readable.on('data', (chunk: Buffer) => {
          buf += chunk.toString();
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            if (line.length > 0) onLog(line, stream);
          }
        });
        readable.on('end', () => {
          if (buf.length > 0) onLog(buf, stream);
        });
      };
      wireLineStream(proc.stdout, 'stdout');
      wireLineStream(proc.stderr, 'stderr');

      proc.on('exit', (code) => {
        if (cancelled) return reject(new BuildAborted());
        if (code === 0) return resolve();
        reject(new Error(`xcodebuild exited ${code}`));
      });
      proc.on('error', reject);
    });

    const appBundlePath = path.join(
      derivedData,
      'Build/Products/Debug-iphonesimulator',
      `${project.scheme}.app`,
    );
    if (!existsSync(appBundlePath)) {
      throw new Error(`Build succeeded but .app missing at ${appBundlePath}`);
    }

    return {
      appBundlePath,
      scheme: project.scheme,
      bundleId: project.bundleId,
      durationMs: Date.now() - startedAt,
    };
  })();

  return { done, cancel };
}

export async function installAndLaunch(
  udid: string,
  appBundlePath: string,
  bundleId: string,
): Promise<void> {
  const install = await execAsync(`xcrun simctl install ${udid} "${appBundlePath}"`, {
    timeoutMs: 60_000,
  });
  if (install.code !== 0) {
    throw new Error(`simctl install failed: ${install.stderr || install.stdout}`);
  }
  // simctl launch returns immediately with PID; use --terminate-running-process so a
  // rebuild replaces the previous process cleanly.
  const launch = await execAsync(
    `xcrun simctl launch --terminate-running-process ${udid} ${bundleId}`,
    { timeoutMs: 15_000 },
  );
  if (launch.code !== 0) {
    throw new Error(`simctl launch failed: ${launch.stderr || launch.stdout}`);
  }
}

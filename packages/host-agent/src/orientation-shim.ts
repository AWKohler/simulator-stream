import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './log.js';

// iOS-Simulator dylib injected at launch (SIMCTL_CHILD_DYLD_INSERT_LIBRARIES) so
// Botflow's preview can rotate ANY app — including projects scaffolded before the
// template gained an orientation observer. Compiled on demand like
// framebuffer-capturer; only the .m source is committed.
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(PKG_ROOT, 'native', 'orientation-shim', 'BotflowPreviewOrientation.m');
const BUILD_DIR = path.join(PKG_ROOT, 'native', 'orientation-shim', 'build');
const DYLIB = path.join(BUILD_DIR, 'BotflowPreviewOrientation.dylib');

export function orientationShimPath(): string {
  return DYLIB;
}

export async function ensureOrientationShim(): Promise<string> {
  const sourceMtime = statSync(SOURCE).mtimeMs;
  if (existsSync(DYLIB) && statSync(DYLIB).mtimeMs >= sourceMtime) return DYLIB;
  mkdirSync(BUILD_DIR, { recursive: true });
  const sdk = await new Promise<string>((resolve, reject) => {
    execFile('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'], (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
  const args = [
    '-sdk', 'iphonesimulator', 'clang',
    '-target', 'arm64-apple-ios16.0-simulator',
    '-isysroot', sdk,
    '-dynamiclib',
    '-fobjc-arc',
    '-framework', 'UIKit',
    '-framework', 'CoreFoundation',
    '-framework', 'Foundation',
    SOURCE,
    '-o', DYLIB,
  ];
  const res = await new Promise<{ ok: boolean; stderr: string }>((resolve) => {
    execFile('xcrun', args, { maxBuffer: 8 * 1024 * 1024 }, (err, _stdout, stderr) => {
      resolve({ ok: !err, stderr: stderr?.toString() ?? '' });
    });
  });
  if (!res.ok) throw new Error(`orientation-shim compile failed: ${res.stderr}`);
  log(`orientation-shim dylib ready: ${DYLIB}`);
  return DYLIB;
}

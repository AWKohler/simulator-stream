import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Orientation } from '@sim/shared';
import { log } from './log.js';

// Tiny iphonesimulator helper that posts a Darwin notification inside the
// guest's notify namespace (run via `simctl spawn`). This is the TCC-free
// rotation primitive — no Accessibility, no GUI automation. Compiled on demand
// like framebuffer-capturer; only the .c source is committed.
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(PKG_ROOT, 'native', 'notifypost', 'notifypost.c');
const BUILD_DIR = path.join(PKG_ROOT, 'native', 'notifypost', 'build');
const BIN = path.join(BUILD_DIR, 'notifypost');

// Darwin notification names the Botflow template's BotflowPreviewOrientation
// observer listens for. Kept in sync with the templates (swift-template /
// swift-convex-template, Sources/App/MyApp.swift).
const ORIENT_NOTIFICATION: Record<Orientation, string> = {
  portrait: 'io.botflow.orient.portrait',
  landscape: 'io.botflow.orient.landscape',
};

function run(cmd: string, args: string[], timeoutMs = 15_000): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, _stdout, stderr) => {
      const code = err && typeof (err as NodeJS.ErrnoException).code === 'number'
        ? ((err as unknown as { code: number }).code)
        : err ? 1 : 0;
      resolve({ code, stderr: stderr?.toString() ?? '' });
    });
  });
}

export async function ensureNotifyPost(): Promise<void> {
  const sourceMtime = statSync(SOURCE).mtimeMs;
  if (existsSync(BIN) && statSync(BIN).mtimeMs >= sourceMtime) return;
  mkdirSync(BUILD_DIR, { recursive: true });
  // Resolve the iphonesimulator SDK path, then build an arm64 simulator binary.
  const sdk = await new Promise<string>((resolve, reject) => {
    execFile('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'], (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
  const args = [
    '-sdk', 'iphonesimulator', 'clang',
    '-target', 'arm64-apple-ios15.0-simulator',
    '-isysroot', sdk,
    '-O2',
    SOURCE,
    '-o', BIN,
  ];
  const res = await new Promise<{ ok: boolean; stderr: string }>((resolve) => {
    execFile('xcrun', args, { maxBuffer: 8 * 1024 * 1024 }, (err, _stdout, stderr) => {
      resolve({ ok: !err, stderr: stderr?.toString() ?? '' });
    });
  });
  if (!res.ok) throw new Error(`notifypost compile failed: ${res.stderr}`);
  log(`notifypost binary ready: ${BIN}`);
}

/**
 * Post the orientation Darwin notification into a booted simulator's guest
 * namespace. The running app (Botflow template) receives it and rotates via
 * requestGeometryUpdate. No-op-safe: returns whether the notification was sent
 * (it does NOT guarantee the app rotated — that requires the app to be running
 * with the BotflowPreviewOrientation observer installed).
 */
export async function postOrientation(udid: string, target: Orientation): Promise<boolean> {
  await ensureNotifyPost();
  const name = ORIENT_NOTIFICATION[target];
  const res = await run('xcrun', ['simctl', 'spawn', udid, BIN, name]);
  return res.code === 0;
}

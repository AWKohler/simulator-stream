import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Orientation } from '@sim/shared';
import { execAsSimUser } from './util.js';
import { log } from './log.js';

// Tiny iphonesimulator helper that posts a Darwin notification inside the
// guest's notify namespace (run via `simctl spawn`). This is the TCC-free
// rotation primitive — no Accessibility, no GUI automation. Compiled on demand
// like framebuffer-capturer; only the .c source is committed.
//
// In sim-user (headless) mode the binary is pre-provisioned at a shared,
// simhost-runnable path (SIM_NOTIFYPOST_BIN) since simhost can't reach the
// orchestrator's private package dir, and `simctl spawn` runs as simhost.
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(PKG_ROOT, 'native', 'notifypost', 'notifypost.c');
const BUILD_DIR = path.join(PKG_ROOT, 'native', 'notifypost', 'build');
const BIN = process.env.SIM_NOTIFYPOST_BIN || path.join(BUILD_DIR, 'notifypost');

// Darwin notification names the Botflow BotflowPreviewOrientation shim listens
// for (injected at app launch — see orientation-shim.ts).
const ORIENT_NOTIFICATION: Record<Orientation, string> = {
  portrait: 'io.botflow.orient.portrait',
  landscape: 'io.botflow.orient.landscape',
};

export async function ensureNotifyPost(): Promise<void> {
  // Pre-provisioned (sim-user mode): trust the shared binary, don't recompile.
  if (process.env.SIM_NOTIFYPOST_BIN) return;
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
 * namespace. The running app (with the BotflowPreviewOrientation shim injected)
 * receives it and rotates via requestGeometryUpdate. Runs as the sim user in
 * sim-user mode. Returns whether the notification was sent (NOT whether the app
 * actually rotated — that requires the shim to be present in the running app).
 */
export async function postOrientation(udid: string, target: Orientation): Promise<boolean> {
  await ensureNotifyPost();
  const name = ORIENT_NOTIFICATION[target];
  const res = await execAsSimUser(`xcrun simctl spawn ${udid} "${BIN}" ${name}`, {
    timeoutMs: 15_000,
  });
  return res.code === 0;
}

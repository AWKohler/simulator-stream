import { exec, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WindowInfo } from '@sim/shared';
import { execAsync } from './util.js';
import { log, warn } from './log.js';

// Resolve capturer.swift relative to this package (works in dev via tsx and built).
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CAPTURER_SWIFT = path.join(PKG_ROOT, 'capturer.swift');
export const CAPTURER_BIN = path.join(tmpdir(), 'expo_stream_capturer');

let compiledOnce: Promise<boolean> | null = null;

export async function ensureCompiled(): Promise<boolean> {
  if (compiledOnce) return compiledOnce;
  compiledOnce = compileBinary();
  return compiledOnce;
}

async function compileBinary(): Promise<boolean> {
  if (!existsSync(CAPTURER_SWIFT)) {
    warn(`capturer.swift not found at ${CAPTURER_SWIFT}`);
    return false;
  }
  // Skip recompile when binary is newer than the source.
  if (existsSync(CAPTURER_BIN)) {
    try {
      const b = statSync(CAPTURER_BIN);
      const s = statSync(CAPTURER_SWIFT);
      if (b.mtimeMs > s.mtimeMs) {
        log('Capturer binary up-to-date.');
        return true;
      }
    } catch {
      /* fall through */
    }
  }
  log('Compiling capturer.swift...');
  return new Promise((resolve) => {
    exec(`swiftc "${CAPTURER_SWIFT}" -o "${CAPTURER_BIN}"`, (err, _stdout, stderr) => {
      if (err) {
        warn(`Capturer compile failed:\n${stderr || err.message}`);
        resolve(false);
      } else {
        log('Capturer binary ready.');
        resolve(true);
      }
    });
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Window discovery — diff before/after to find a newly-appeared sim window
// ──────────────────────────────────────────────────────────────────────────────

export interface SimWindow {
  id: number;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export async function listSimulatorWindows(): Promise<SimWindow[]> {
  await ensureCompiled();
  const res = await execAsync(`"${CAPTURER_BIN}" --list-windows-json`, { timeoutMs: 5_000 });
  if (res.code !== 0) {
    warn(`capturer --list-windows-json failed (code ${res.code}): ${res.stderr.split('\n')[0]}`);
    return [];
  }
  try {
    return JSON.parse(res.stdout) as SimWindow[];
  } catch (e) {
    warn(`Window list JSON parse error: ${(e as Error).message}`);
    return [];
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Per-session capturer process
// ──────────────────────────────────────────────────────────────────────────────

export interface CapturerEvents {
  onFrame: (jpeg: Buffer) => void;
  onWindowInfo: (info: WindowInfo) => void;
  onReady: () => void;
  onError: (message: string) => void;
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export interface CapturerHandle {
  stop: () => void;
  pid: number | undefined;
}

export function startCapturer(
  options: { windowId: number; fps?: number; quality?: number },
  events: CapturerEvents,
): CapturerHandle {
  const { windowId, fps = 30, quality = 0.75 } = options;

  log(`Spawning capturer (windowID=${windowId}, fps=${fps}, q=${quality})`);
  const proc: ChildProcess = spawn(CAPTURER_BIN, [
    'iPhone',
    `--fps=${fps}`,
    `--quality=${quality}`,
    `--window-id=${windowId}`,
  ]);

  // ── stderr: status + WINDOW_INFO + ERROR ──
  let stderrBuf = '';
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString();
    const lines = stderrBuf.split('\n');
    stderrBuf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line) continue;

      if (line.startsWith('WINDOW_INFO:')) {
        const nums: Record<string, number> = {};
        let title = '';
        for (const kv of line.replace('WINDOW_INFO:', '').trim().split(' ')) {
          const [k, v] = kv.split('=');
          if (!k || v === undefined) continue;
          if (k === 'title') title = v;
          else nums[k] = parseFloat(v);
        }
        const info: WindowInfo = {
          id: nums.id ?? windowId,
          x: nums.x ?? 0,
          y: nums.y ?? 0,
          w: nums.w ?? 0,
          h: nums.h ?? 0,
          scale: nums.scale ?? 2,
        };
        events.onWindowInfo(info);
        log(`Window: ${JSON.stringify(info)} title="${title}"`);
      } else if (line.startsWith('STREAM_STARTED')) {
        log(`capturer: ${line}`);
        events.onReady();
      } else if (line.startsWith('ERROR:')) {
        events.onError(line);
      } else {
        log(`capturer: ${line}`);
      }
    }
  });

  // ── stdout: 4-byte big-endian length-prefixed JPEG frames ──
  let frameBuffer = Buffer.alloc(0);
  let framesParsed = 0;
  proc.stdout?.on('data', (chunk: Buffer) => {
    frameBuffer = Buffer.concat([frameBuffer, chunk]);
    while (frameBuffer.length >= 4) {
      const frameLen = frameBuffer.readUInt32BE(0);
      if (frameLen > 10_000_000) {
        warn('Frame buffer corruption, resetting.');
        frameBuffer = Buffer.alloc(0);
        break;
      }
      if (frameBuffer.length < 4 + frameLen) break;
      const frame = frameBuffer.subarray(4, 4 + frameLen);
      frameBuffer = frameBuffer.subarray(4 + frameLen);
      framesParsed++;
      if (framesParsed === 1) log(`First frame: ${frame.length} bytes`);
      events.onFrame(frame);
    }
  });

  proc.on('exit', (code, signal) => {
    log(`Capturer exited code=${code} signal=${signal}`);
    events.onExit(code, signal);
  });

  return {
    stop: () => {
      if (!proc.killed) proc.kill();
    },
    pid: proc.pid,
  };
}

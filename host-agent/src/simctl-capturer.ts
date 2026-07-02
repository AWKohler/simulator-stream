// Headless capture path — captures `xcrun simctl io <udid> screenshot` frames.
// No ScreenCaptureKit, no Screen Recording TCC. Works on a Mac with no GUI
// session available.
//
// The bottleneck is per-screenshot process spawn (~100-150ms each). A strictly
// serial loop caps out around 5-7fps. To do better we run a *pipeline*: N
// capture "lanes" run concurrently, each one immediately starting the next
// capture as soon as its previous one finishes. With N lanes and ~150ms per
// capture, throughput is roughly N × (1000/150) — e.g. 4 lanes ≈ 25fps.
//
// Frames carry a launch-order sequence number; a frame is dropped if a
// higher-numbered frame has already been emitted, keeping the stream
// monotonic despite lanes racing each other.
//
// The frame is the device's logical screen with NO bezel, so coordinate
// mapping is the identity (normX*deviceW, normY*deviceH).

import { execSync, spawn } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LogStream } from '@sim/shared';
import { log, warn } from './log.js';

// Resolve the absolute path to `simctl` ONCE at module load. Every frame
// otherwise pays for an `xcrun` process spawn (~20-40ms) just to locate it.
// Spawning `simctl` directly removes that per-frame tax.
let SIMCTL_BIN = 'xcrun';
let SIMCTL_PREFIX_ARGS: string[] = ['simctl'];
try {
  const resolved = execSync('xcrun -f simctl', { stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
  if (resolved) {
    SIMCTL_BIN = resolved;
    SIMCTL_PREFIX_ARGS = [];
  }
} catch {
  // Fall back to `xcrun simctl` — slower per frame but always works.
}

export interface SimctlCapturerEvents {
  onFrame: (jpeg: Buffer) => void;
  onError: (message: string) => void;
  onExit: (reason: string) => void;
}

export interface SimctlCapturerHandle {
  stop: () => void;
}

export interface SimctlCapturerOptions {
  udid: string;
  /** Number of concurrent capture lanes. Higher = more fps + more CPU. */
  concurrency?: number;
  /** Stop after this many consecutive failures across all lanes. */
  maxConsecutiveErrors?: number;
}

/**
 * Start a pipelined screenshot capturer. Returns a handle whose `.stop()`
 * halts all lanes.
 */
export function startSimctlCapturer(
  options: SimctlCapturerOptions,
  events: SimctlCapturerEvents,
): SimctlCapturerHandle {
  const { udid, maxConsecutiveErrors = 12 } = options;
  // Measured scaling on an M-series MacBook Air (iPhone 16 Pro sim):
  //   serial ≈ 3-7fps · 4 lanes ≈ 12 · 6 lanes ≈ 15 · 8 lanes ≈ 19.
  // CoreSimulator partially serializes screenshot requests, so returns
  // diminish past ~8. Cap at 12 for headroom on a dedicated host.
  const concurrency = Math.max(1, Math.min(12, options.concurrency ?? 8));

  let stopped = false;
  let consecutiveErrors = 0;
  let firstFrameLogged = false;
  let nextSeq = 0;
  let lastEmittedSeq = -1;
  let activeLanes = 0;

  const lane = async (): Promise<void> => {
    activeLanes++;
    while (!stopped) {
      const seq = nextSeq++;
      try {
        const buf = await captureOne(udid);
        if (stopped) break;
        consecutiveErrors = 0;
        // Drop stragglers: only emit if this frame is newer than the last one
        // we sent. Lanes race, so completion order != launch order.
        if (seq > lastEmittedSeq) {
          lastEmittedSeq = seq;
          if (!firstFrameLogged) {
            firstFrameLogged = true;
            log(`simctl capturer: first frame ${buf.length} bytes (${concurrency} lanes)`);
          }
          events.onFrame(buf);
        }
      } catch (e) {
        if (stopped) break;
        consecutiveErrors++;
        const msg = (e as Error).message;
        warn(`simctl screenshot failed (${consecutiveErrors}/${maxConsecutiveErrors}): ${msg}`);
        if (consecutiveErrors >= maxConsecutiveErrors) {
          stopped = true;
          events.onError(`simctl screenshot failed ${consecutiveErrors} times: ${msg}`);
          break;
        }
      }
    }
    activeLanes--;
    if (activeLanes === 0) {
      events.onExit(consecutiveErrors >= maxConsecutiveErrors ? 'too many errors' : 'stopped');
    }
  };

  for (let i = 0; i < concurrency; i++) void lane();

  return {
    stop: () => {
      stopped = true;
    },
  };
}

// macOS 26's `simctl io ... screenshot -` writes nothing to stdout (only a
// "No display specified" note to stderr). Round-trip through a tmpfile.
function captureOne(udid: string): Promise<Buffer> {
  const tmp = path.join(
    tmpdir(),
    `sim-shot-${udid.slice(0, 8)}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.jpg`,
  );
  return new Promise<Buffer>((resolve, reject) => {
    const proc = spawn(
      SIMCTL_BIN,
      [...SIMCTL_PREFIX_ARGS, 'io', udid, 'screenshot', '--type=jpeg', tmp],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    proc.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    proc.on('exit', (code) => {
      if (code !== 0) {
        unlink(tmp).catch(() => undefined);
        reject(new Error(`simctl exit ${code}: ${stderr.trim().split('\n').pop()}`));
        return;
      }
      readFile(tmp).then(
        (buf) => {
          unlink(tmp).catch(() => undefined);
          if (buf.length === 0) reject(new Error('simctl wrote empty file'));
          else resolve(buf);
        },
        (e) => {
          unlink(tmp).catch(() => undefined);
          reject(new Error(`readFile failed: ${(e as Error).message}`));
        },
      );
    });
    proc.on('error', reject);
  });
}

/**
 * Probe the device's screen dimensions by taking one screenshot and reading
 * the JPEG header. Returns logical (point) dimensions, not physical pixels.
 */
export async function probeDeviceFromScreenshot(
  udid: string,
): Promise<{ logical: { w: number; h: number }; physical: { w: number; h: number } } | null> {
  try {
    const buf = await captureOne(udid);
    const dims = readJpegDimensions(buf);
    if (!dims) return null;
    // iPhone 16 Pro: 1179x2556 physical → 393x852 logical (@3x).
    const scale = Math.max(1, Math.round(dims.w / 393));
    return {
      physical: dims,
      logical: { w: Math.round(dims.w / scale), h: Math.round(dims.h / scale) },
    };
  } catch (e) {
    warn(`probeDeviceFromScreenshot failed: ${(e as Error).message}`);
    return null;
  }
}

// Parse JPEG SOF0/SOF2 markers for dimensions without decoding pixels.
function readJpegDimensions(buf: Buffer): { w: number; h: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    i += 2;
    // SOF0…SOF15 except DHT(0xC4), JPG(0xC8), DAC(0xCC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const h = (buf[i + 3] << 8) | buf[i + 4];
      const w = (buf[i + 5] << 8) | buf[i + 6];
      return { w, h };
    }
    const segLen = (buf[i] << 8) | buf[i + 1];
    i += segLen;
  }
  return null;
}

// Mark unused export to satisfy linters in consumers.
export const _logStream: LogStream = 'stdout';

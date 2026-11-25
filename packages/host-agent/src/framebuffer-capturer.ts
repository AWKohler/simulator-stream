import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnAsSimUser } from './util.js';
import { log, warn } from './log.js';
import { nativeBinaryFresh, stampNativeBinary } from './native-build.js';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(PKG_ROOT, 'native', 'framebuffer-capturer', 'main.mm');
const BUILD_DIR = path.join(PKG_ROOT, 'native', 'framebuffer-capturer', 'build');
// In sim-user mode the capturer is pre-provisioned at a shared, simhost-runnable
// path (SIM_CAPTURER_BIN, e.g. /opt/sim-tools/...) since simhost can't read the
// orchestrator's private package dir. Otherwise it's built into the package.
const BIN = process.env.SIM_CAPTURER_BIN || path.join(BUILD_DIR, 'framebuffer-capturer');

export interface FramebufferVideoConfig {
  codec: 'h264';
  format: 'annexb';
  width: number;
  height: number;
  fps: number;
  bitrate: number;
}

export interface FramebufferVideoChunk {
  data: Buffer;
  timestampMs: number;
  keyframe: boolean;
}

export interface FramebufferCapturerEvents {
  onConfig: (config: FramebufferVideoConfig) => void;
  onChunk: (chunk: FramebufferVideoChunk) => void;
  onError: (message: string) => void;
  onExit: (reason: string) => void;
  /** The panel went on or off (only with `reportLit`). */
  onLit?: (lit: boolean) => void;
}

export interface FramebufferCapturerHandle {
  stop: () => void;
}

export interface FramebufferCapturerOptions {
  udid: string;
  fps: number;
  bitrate: number;
  keyframeInterval: number;
  /** Which CoreSimulator display to capture, on a device with more than one
   * built-in panel (the iPhone Duo). Omitted: the largest. */
  screenID?: number;
  /** Encode at this fraction of the panel's size (0–1]. */
  scale?: number;
  /** Send a frame only when the panel's picture changed (plus two a second). */
  skipUnchanged?: boolean;
  /** Report through `onLit` whether iOS has the panel switched on. */
  reportLit?: boolean;
}

/** One display of a booted simulator, from the capturer's `--list`. */
export interface FramebufferDisplay {
  screenID: number;
  width: number;
  height: number;
  lit: boolean;
}

interface NativeRecord {
  type: string;
  [key: string]: unknown;
}

export async function ensureFramebufferCapturer(): Promise<void> {
  // Pre-provisioned (sim-user mode): the binary is already built + placed at a
  // shared path we can't/​shouldn't recompile into. Trust it.
  if (process.env.SIM_CAPTURER_BIN) return;
  if (nativeBinaryFresh(BIN, [SOURCE])) return;

  await new Promise<void>((resolve, reject) => {
    execFile(
      'mkdir',
      ['-p', BUILD_DIR],
      (mkdirErr) => {
        if (mkdirErr) {
          reject(mkdirErr);
          return;
        }
        const args = [
          '-std=c++17',
          '-fobjc-arc',
          SOURCE,
          '-o',
          BIN,
          '-framework',
          'Foundation',
          '-framework',
          'CoreMedia',
          '-framework',
          'CoreVideo',
          '-framework',
          'VideoToolbox',
          '-framework',
          'IOSurface',
          '-framework',
          'CoreImage',
          '-framework',
          'ImageIO',
          '-framework',
          'CoreGraphics',
          '-framework',
          'UniformTypeIdentifiers',
        ];
        execFile('clang++', args, { maxBuffer: 10 * 1024 * 1024 }, (err, _stdout, stderr) => {
          if (err) {
            reject(new Error(`framebuffer-capturer compile failed: ${stderr || err.message}`));
            return;
          }
          stampNativeBinary(BIN, [SOURCE]);
          log(`framebuffer-capturer binary ready: ${BIN}`);
          resolve();
        });
      },
    );
  });
}

export function startFramebufferCapturer(
  options: FramebufferCapturerOptions,
  events: FramebufferCapturerEvents,
): FramebufferCapturerHandle {
  // Runs as the sim user — attaches to that user's CoreSimulator framebuffer by
  // UDID (headless; no on-screen window). Frames stream back over stdout.
  if (
    options.screenID !== undefined &&
    (!Number.isInteger(options.screenID) || options.screenID < 0 || options.screenID > 0xffff_ffff)
  ) {
    throw new Error('screenID must be an unsigned 32-bit integer');
  }
  const spawned = spawnAsSimUser(BIN, [
    '--udid',
    options.udid,
    '--codec',
    'h264',
    '--fps',
    String(options.fps),
    '--bitrate',
    String(options.bitrate),
    '--keyframe-interval',
    String(options.keyframeInterval),
    ...(options.screenID === undefined ? [] : ['--screen-id', String(options.screenID)]),
    ...(options.scale !== undefined && options.scale < 1 ? ['--scale', String(options.scale)] : []),
    ...(options.skipUnchanged ? ['--skip-unchanged'] : []),
    ...(options.reportLit ? ['--report-lit'] : []),
  ]);
  const proc = spawn(spawned.cmd, spawned.args, { stdio: ['ignore', 'pipe', 'pipe'] });

  let stopped = false;
  const parser = new RecordParser((record) => {
    switch (record.type) {
      case 'config':
        events.onConfig({
          codec: 'h264',
          format: 'annexb',
          width: Number(record.width),
          height: Number(record.height),
          fps: Number(record.fps),
          bitrate: Number(record.bitrate),
        });
        break;
      case 'chunk': {
        const data = typeof record.data === 'string' ? Buffer.from(record.data, 'base64') : Buffer.alloc(0);
        if (data.length === 0) return;
        events.onChunk({
          data,
          timestampMs: Number(record.timestampMs ?? Date.now()),
          keyframe: record.keyframe === true,
        });
        break;
      }
      case 'lit':
        events.onLit?.(record.lit === true);
        break;
      case 'error':
        events.onError(String(record.message ?? 'native framebuffer error'));
        break;
      default:
        break;
    }
  });

  proc.stdout?.on('data', (chunk: Buffer) => parser.push(chunk));
  proc.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) warn(`framebuffer-capturer stderr: ${text}`);
  });
  proc.on('exit', (code, signal) => {
    events.onExit(stopped ? 'stopped' : `native helper exited code=${code} signal=${signal ?? 'none'}`);
  });
  proc.on('error', (e) => {
    events.onError(`failed to start framebuffer-capturer: ${(e as Error).message}`);
  });

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, 1000).unref();
    },
  };
}

/** The displays of a booted simulator that have a framebuffer, largest first. */
export function listFramebufferDisplays(udid: string): Promise<FramebufferDisplay[]> {
  return new Promise((resolve, reject) => {
    const spawned = spawnAsSimUser(BIN, ['--udid', udid, '--list']);
    const proc = spawn(spawned.cmd, spawned.args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let displays: FramebufferDisplay[] | null = null;
    let failure: string | null = null;
    const parser = new RecordParser((record) => {
      if (record.type === 'displays' && Array.isArray(record.displays)) {
        displays = (record.displays as Array<Record<string, unknown>>).map((d) => ({
          screenID: Number(d.screenID),
          width: Number(d.width),
          height: Number(d.height),
          lit: d.lit === true,
        }));
      } else if (record.type === 'error') {
        failure = String(record.message ?? 'native framebuffer error');
      }
    });
    proc.stdout?.on('data', (chunk: Buffer) => parser.push(chunk));
    const timer = setTimeout(() => proc.kill('SIGKILL'), 10_000);
    proc.on('close', () => {
      clearTimeout(timer);
      if (displays) resolve(displays);
      else reject(new Error(failure ?? 'could not list the simulator displays'));
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

class RecordParser {
  private buf = Buffer.alloc(0);

  constructor(private readonly onRecord: (record: NativeRecord) => void) {}

  push(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (len <= 0 || len > 64 * 1024 * 1024) {
        this.buf = Buffer.alloc(0);
        return;
      }
      if (this.buf.length < 4 + len) return;
      const payload = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      try {
        this.onRecord(JSON.parse(payload.toString('utf8')) as NativeRecord);
      } catch {
        // Ignore malformed helper records; the helper also emits explicit error records.
      }
    }
  }
}

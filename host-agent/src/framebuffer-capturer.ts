import { execFile, spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log, warn } from './log.js';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(PKG_ROOT, 'native', 'framebuffer-capturer', 'main.mm');
const BUILD_DIR = path.join(PKG_ROOT, 'native', 'framebuffer-capturer', 'build');
const BIN = path.join(BUILD_DIR, 'framebuffer-capturer');

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
}

export interface FramebufferCapturerHandle {
  stop: () => void;
}

export interface FramebufferCapturerOptions {
  udid: string;
  fps: number;
  bitrate: number;
  keyframeInterval: number;
}

interface NativeRecord {
  type: string;
  [key: string]: unknown;
}

export async function ensureFramebufferCapturer(): Promise<void> {
  const sourceMtime = statSync(SOURCE).mtimeMs;
  const binaryFresh = existsSync(BIN) && statSync(BIN).mtimeMs >= sourceMtime;
  if (binaryFresh) return;

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
  const proc = spawn(
    BIN,
    [
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
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

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

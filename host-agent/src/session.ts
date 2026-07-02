import { EventEmitter } from 'node:events';
import type { BuildPhase, DeviceLogical, Input, LogStream, ScreenRect, WindowInfo } from '@sim/shared';
import {
  type CapturerHandle,
  listSimulatorWindows,
  startCapturer,
} from './capturer.js';
import {
  bootSimulator,
  probeDeviceLogicalSize,
  shutdownSimulator,
} from './simulator.js';
import {
  startCompanion,
  stopCompanion,
  swipe,
  tap,
  sendText,
  sendKey,
  hasIDB,
  companionSocketPath,
} from './idb.js';
import { computeScreenRect, windowNormToDeviceLogical, clampPt } from './coordinates.js';
import { sleep } from './util.js';
import { err, log, warn } from './log.js';
import { BuildAborted, installAndLaunch, runBuild, type BuildHandle } from './build.js';
import {
  probeDeviceFromScreenshot,
  startSimctlCapturer,
  type SimctlCapturerHandle,
} from './simctl-capturer.js';
import {
  startIdbVideoStream,
  type IdbVideoStreamHandle,
} from './idb-video-stream.js';
import { existsSync } from 'node:fs';
import {
  startFramebufferCapturer,
  type FramebufferCapturerHandle,
  type FramebufferVideoChunk,
  type FramebufferVideoConfig,
} from './framebuffer-capturer.js';

export type CaptureMode = 'sck' | 'simctl' | 'idb' | 'framebuffer';

const ENV_CAPTURE_MODE = (process.env.SIM_CAPTURE_MODE ?? 'sck').toLowerCase() as CaptureMode;
const SIMCTL_CONCURRENCY = parseInt(process.env.SIM_SIMCTL_CONCURRENCY ?? '8', 10);
const IDB_STREAM_FPS = parseInt(process.env.SIM_IDB_FPS ?? '30', 10);
const IDB_STREAM_QUALITY = parseFloat(process.env.SIM_IDB_QUALITY ?? '0.7');
const FRAMEBUFFER_FPS = parseInt(process.env.SIM_FRAMEBUFFER_FPS ?? '60', 10);
const FRAMEBUFFER_BITRATE = parseInt(process.env.SIM_FRAMEBUFFER_BITRATE ?? '6000000', 10);
const FRAMEBUFFER_KEY_INTERVAL = parseInt(
  process.env.SIM_FRAMEBUFFER_KEYFRAME_INTERVAL ?? String(FRAMEBUFFER_FPS),
  10,
);

export type SessionPhase =
  | 'idle'
  | 'building'
  | 'booting'
  | 'installing'
  | 'capturing'
  | 'ready'
  | 'ending'
  | 'ended'
  | 'error';

export interface SessionReadyPayload {
  windowInfo: WindowInfo;
  screenRect: ScreenRect;
  deviceLogical: DeviceLogical;
}

export interface BuildEventPayload {
  event: BuildPhase;
  line?: string;
  stream?: LogStream;
  exitCode?: number;
  scheme?: string;
  bundleId?: string;
  durationMs?: number;
  message?: string;
}

// Default screen size for iPhone 16 Pro until probed.
const DEFAULT_DEVICE_LOGICAL: DeviceLogical = { w: 393, h: 852 };

interface SessionEvents {
  phase: (phase: SessionPhase, payload?: SessionReadyPayload | { message: string }) => void;
  frame: (jpeg: Buffer) => void;
  videoConfig: (config: FramebufferVideoConfig) => void;
  videoChunk: (chunk: FramebufferVideoChunk) => void;
  log: (message: string) => void;
  build: (payload: BuildEventPayload) => void;
}

export interface SessionInit {
  sessionId: string;
  udid: string;
}

export interface BuildHints {
  scheme?: string;
  bundleId?: string;
}

export declare interface Session {
  on<K extends keyof SessionEvents>(event: K, listener: SessionEvents[K]): this;
  emit<K extends keyof SessionEvents>(event: K, ...args: Parameters<SessionEvents[K]>): boolean;
}

export class Session extends EventEmitter {
  readonly sessionId: string;
  readonly udid: string;
  private phase: SessionPhase = 'idle';
  private capturer: CapturerHandle | null = null;
  private windowInfo: WindowInfo | null = null;
  private screenRect: ScreenRect | null = null;
  private deviceLogical: DeviceLogical = { ...DEFAULT_DEVICE_LOGICAL };
  private scrollAcc = { dx: 0, dy: 0, normX: 0.5, normY: 0.5 };
  private scrollTimer: NodeJS.Timeout | null = null;
  private bundleId: string | null = null;
  private currentBuild: BuildHandle | null = null;
  private simctlCapturer: SimctlCapturerHandle | null = null;
  private idbCapturer: IdbVideoStreamHandle | null = null;
  private framebufferCapturer: FramebufferCapturerHandle | null = null;

  constructor(init: SessionInit) {
    super();
    this.sessionId = init.sessionId;
    this.udid = init.udid;
  }

  getPhase(): SessionPhase {
    return this.phase;
  }

  isStreaming(): boolean {
    return this.phase === 'ready';
  }

  private setPhase(p: SessionPhase, payload?: SessionReadyPayload | { message: string }): void {
    this.phase = p;
    this.emit('phase', p, payload);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // PoC-style start: boot empty sim, start capture.
  // ────────────────────────────────────────────────────────────────────────────
  async start(): Promise<void> {
    if (this.phase !== 'idle') return;
    await this.bootAndCapture();
  }

  private async bootAndCapture(): Promise<void> {
    this.setPhase('booting');
    const before = await listSimulatorWindows();
    const beforeIds = new Set(before.map((w) => w.id));

    const booted = await bootSimulator(this.udid);
    if (!booted) {
      this.setPhase('error', { message: 'Simulator boot timed out.' });
      return;
    }

    const windowId = await this.findNewWindow(beforeIds, 12_000);
    if (!windowId) {
      this.setPhase('error', { message: 'Could not locate simulator window after boot.' });
      return;
    }

    const probed = await probeDeviceLogicalSize(this.udid);
    if (probed) this.deviceLogical = probed;
    log(`Session ${this.sessionId.slice(0, 8)} device logical=${this.deviceLogical.w}x${this.deviceLogical.h}`);

    if (hasIDB()) startCompanion(this.udid);

    await sleep(750);

    await this.startCaptureAtWindow(windowId);
  }

  private startCaptureAtWindow(windowId: number): Promise<void> {
    this.setPhase('capturing');
    return new Promise((resolve) => {
      let resolved = false;
      this.capturer = startCapturer(
        { windowId, fps: 30, quality: 0.75 },
        {
          onFrame: (jpeg) => this.emit('frame', jpeg),
          onWindowInfo: (info) => {
            this.windowInfo = info;
            this.screenRect = computeScreenRect(info);
          },
          onReady: () => {
            const finalize = (): void => {
              if (this.windowInfo && this.screenRect) {
                this.setPhase('ready', {
                  windowInfo: this.windowInfo,
                  screenRect: this.screenRect,
                  deviceLogical: this.deviceLogical,
                });
              }
              if (!resolved) {
                resolved = true;
                resolve();
              }
            };
            if (this.windowInfo && this.screenRect) {
              finalize();
            } else {
              warn('Capturer reported READY before WINDOW_INFO — waiting briefly.');
              void (async () => {
                for (let i = 0; i < 10 && (!this.windowInfo || !this.screenRect); i++) {
                  await sleep(100);
                }
                finalize();
              })();
            }
          },
          onError: (message) => {
            err(`Capturer error: ${message}`);
            this.emit('log', message);
          },
          onExit: (code) => {
            if (this.phase !== 'ending' && this.phase !== 'ended') {
              this.setPhase('error', { message: `Capturer exited unexpectedly (code=${code}).` });
            }
            if (!resolved) {
              resolved = true;
              resolve();
            }
          },
        },
      );
    });
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Swift-style: build + install + launch + capture
  // Cancels any in-flight build before starting a new one (Refresh while building).
  // ────────────────────────────────────────────────────────────────────────────
  async runBuildAndLaunch(tarballBuf: Buffer, hints?: BuildHints): Promise<void> {
    // Cancel any in-flight build (rebuild while building)
    if (this.currentBuild) {
      this.currentBuild.cancel();
      this.currentBuild = null;
    }

    // Kick off sim boot in parallel with the build — boot takes 8-15s, build takes
    // 30-60s, so the boot is almost always done by the time we need it.
    const isFirstBuild = this.phase === 'idle' || this.phase === 'building';
    const bootTask = isFirstBuild ? this.bootInParallel() : Promise.resolve(true);

    this.setPhase('building');
    this.emit('build', { event: 'started' });
    const handle = runBuild({
      sessionId: this.sessionId,
      tarballBuf,
      hints,
      onLog: (line, stream) => this.emit('build', { event: 'log', line, stream }),
    });
    this.currentBuild = handle;

    let result: Awaited<typeof handle.done>;
    try {
      result = await handle.done;
    } catch (e) {
      this.currentBuild = null;
      if (e instanceof BuildAborted) {
        // Cancelled by another rebuild; the caller already started its own work.
        return;
      }
      const msg = (e as Error).message;
      this.emit('build', { event: 'failed', message: msg });
      if (isFirstBuild) this.setPhase('error', { message: msg });
      return;
    }
    this.currentBuild = null;

    this.bundleId = result.bundleId;
    this.emit('build', {
      event: 'succeeded',
      scheme: result.scheme,
      bundleId: result.bundleId,
      durationMs: result.durationMs,
    });

    if (isFirstBuild) {
      const booted = await bootTask;
      if (!booted) {
        this.setPhase('error', { message: 'Simulator boot timed out.' });
        return;
      }
    }

    this.setPhase('installing');
    try {
      await installAndLaunch(this.udid, result.appBundlePath, result.bundleId);
    } catch (e) {
      const msg = (e as Error).message;
      this.emit('build', { event: 'failed', message: msg });
      if (isFirstBuild) this.setPhase('error', { message: msg });
      return;
    }

    if (!isFirstBuild) {
      // Re-build on an already-streaming session: simulator + capturer keep
      // running, the app was hot-swapped. Bounce back to 'ready' so the browser
      // knows the rebuild is done.
      this.setPhase('ready', {
        windowInfo: this.windowInfo!,
        screenRect: this.screenRect!,
        deviceLogical: this.deviceLogical,
      });
      return;
    }

    // First-time capture path — branch by mode.
    if (hasIDB()) startCompanion(this.udid);
    if (ENV_CAPTURE_MODE === 'framebuffer') {
      await this.startFramebufferCapture();
    } else if (ENV_CAPTURE_MODE === 'idb') {
      await this.startIdbCapture();
    } else if (ENV_CAPTURE_MODE === 'simctl') {
      await this.startSimctlCapture();
    } else {
      await this.startSckCaptureAfterLaunch();
    }
  }

  private async startFramebufferCapture(): Promise<void> {
    const probed = await probeDeviceFromScreenshot(this.udid);
    const physical = probed?.physical ?? { w: 1179, h: 2556 };
    const logical = probed?.logical ?? { w: 393, h: 852 };
    this.deviceLogical = logical;
    this.windowInfo = { id: 0, x: 0, y: 0, w: physical.w, h: physical.h, scale: 1 };
    this.screenRect = { left: 0, top: 0, right: physical.w, bottom: physical.h };

    let gotConfig = false;
    this.framebufferCapturer = startFramebufferCapturer(
      {
        udid: this.udid,
        fps: FRAMEBUFFER_FPS,
        bitrate: FRAMEBUFFER_BITRATE,
        keyframeInterval: FRAMEBUFFER_KEY_INTERVAL,
      },
      {
        onConfig: (config) => {
          gotConfig = true;
          this.windowInfo = { id: 0, x: 0, y: 0, w: config.width, h: config.height, scale: 1 };
          this.screenRect = { left: 0, top: 0, right: config.width, bottom: config.height };
          this.emit('videoConfig', config);
          this.setPhase('ready', {
            windowInfo: this.windowInfo,
            screenRect: this.screenRect,
            deviceLogical: this.deviceLogical,
          });
        },
        onChunk: (chunk) => this.emit('videoChunk', chunk),
        onError: (message) => {
          err(`framebuffer capturer: ${message}`);
          if (!gotConfig && this.phase !== 'ending' && this.phase !== 'ended') {
            this.setPhase('error', { message });
          }
        },
        onExit: (reason) => {
          if (this.phase !== 'ending' && this.phase !== 'ended') {
            this.setPhase('error', { message: `framebuffer capturer stopped: ${reason}` });
          }
        },
      },
    );
  }

  /**
   * idb capture mode — stream the device framebuffer from idb_companion over
   * its gRPC video_stream RPC. Persistent 30fps stream, no per-frame process
   * spawn, no Screen Recording permission. Capture source is the device
   * framebuffer (no macOS window), so no title-bar/occlusion artifacts.
   */
  private async startIdbCapture(): Promise<void> {
    if (!hasIDB()) {
      this.setPhase('error', { message: 'idb capture mode requires idb_companion (not found).' });
      return;
    }
    // Companion was spawned just above; wait for it to bind its domain socket.
    const sock = companionSocketPath(this.udid);
    const ready = await this.waitForSocket(sock, 15_000);
    if (!ready) {
      this.setPhase('error', { message: `idb_companion socket never appeared at ${sock}` });
      return;
    }

    // Probe device dimensions so the canvas + coordinate mapping are correct.
    const probed = await probeDeviceFromScreenshot(this.udid);
    const physical = probed?.physical ?? { w: 1179, h: 2556 };
    const logical = probed?.logical ?? { w: 393, h: 852 };
    this.deviceLogical = logical;
    // Synthesize identity "window" geometry — the framebuffer IS the device
    // screen, so coordinate mapping is a straight scale (no bezel).
    this.windowInfo = { id: 0, x: 0, y: 0, w: physical.w, h: physical.h, scale: 1 };
    this.screenRect = { left: 0, top: 0, right: physical.w, bottom: physical.h };

    this.idbCapturer = startIdbVideoStream(
      {
        socketPath: sock,
        fps: IDB_STREAM_FPS,
        format: 'MJPEG',
        compressionQuality: IDB_STREAM_QUALITY,
        scaleFactor: 1,
      },
      {
        onFrame: (jpeg) => this.emit('frame', jpeg),
        onError: (message) => err(`idb video-stream: ${message}`),
        onExit: (reason) => {
          if (this.phase !== 'ending' && this.phase !== 'ended') {
            this.setPhase('error', { message: `idb video-stream stopped: ${reason}` });
          }
        },
      },
    );

    this.setPhase('ready', {
      windowInfo: this.windowInfo,
      screenRect: this.screenRect,
      deviceLogical: this.deviceLogical,
    });
  }

  private async waitForSocket(socketPath: string, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (existsSync(socketPath)) return true;
      await sleep(300);
    }
    return false;
  }

  private async startSckCaptureAfterLaunch(): Promise<void> {
    const before = await listSimulatorWindows();
    const candidate = before.find(
      (w) => w.w > 300 && w.w < 500 && w.h > 700 && w.h < 950 && w.title.length > 0,
    );
    if (!candidate) {
      this.setPhase('error', { message: 'Could not locate simulator window after launch.' });
      return;
    }
    const probed = await probeDeviceLogicalSize(this.udid);
    if (probed) this.deviceLogical = probed;
    await sleep(500);
    await this.startCaptureAtWindow(candidate.id);
  }

  private async startSimctlCapture(): Promise<void> {
    // Probe device dimensions from a single screenshot so we know the canvas size
    // and frontend coordinate mapping is correct.
    const probed = await probeDeviceFromScreenshot(this.udid);
    const physical = probed?.physical ?? { w: 1179, h: 2556 };
    const logical = probed?.logical ?? { w: 393, h: 852 };
    this.deviceLogical = logical;

    // Synthesize "window" geometry matching the device screen so the existing
    // coordinate-mapping function works with no special-casing on the client.
    this.windowInfo = { id: 0, x: 0, y: 0, w: physical.w, h: physical.h, scale: 1 };
    this.screenRect = { left: 0, top: 0, right: physical.w, bottom: physical.h };

    this.simctlCapturer = startSimctlCapturer(
      { udid: this.udid, concurrency: SIMCTL_CONCURRENCY },
      {
        onFrame: (jpeg) => this.emit('frame', jpeg),
        onError: (message) => {
          err(`simctl capturer: ${message}`);
        },
        onExit: (reason) => {
          if (this.phase !== 'ending' && this.phase !== 'ended') {
            this.setPhase('error', { message: `simctl capturer stopped: ${reason}` });
          }
        },
      },
    );

    this.setPhase('ready', {
      windowInfo: this.windowInfo,
      screenRect: this.screenRect,
      deviceLogical: this.deviceLogical,
    });
  }

  /**
   * Boot the simulator without starting capture. Used so we can run boot in
   * parallel with the xcodebuild step on first-time Swift sessions.
   */
  private async bootInParallel(): Promise<boolean> {
    return bootSimulator(this.udid);
  }

  private async findNewWindow(beforeIds: Set<number>, timeoutMs: number): Promise<number | null> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const now = await listSimulatorWindows();
      const fresh = now.find((w) => !beforeIds.has(w.id) && w.w > 100 && w.h > 100);
      if (fresh) return fresh.id;
      await sleep(500);
    }
    return null;
  }

  setCalibration(rect: ScreenRect): void {
    this.screenRect = rect;
    if (this.windowInfo) {
      this.emit('phase', 'ready', {
        windowInfo: this.windowInfo,
        screenRect: rect,
        deviceLogical: this.deviceLogical,
      });
    }
  }

  resetCalibration(): void {
    if (!this.windowInfo) return;
    this.screenRect = computeScreenRect(this.windowInfo);
    this.emit('phase', 'ready', {
      windowInfo: this.windowInfo,
      screenRect: this.screenRect,
      deviceLogical: this.deviceLogical,
    });
  }

  async handleInput(input: Input): Promise<void> {
    if (!this.windowInfo || !this.screenRect) return;
    const wi = this.windowInfo;
    const sr = this.screenRect;
    const dl = this.deviceLogical;

    switch (input.kind) {
      case 'tap': {
        const pt = windowNormToDeviceLogical(input.normX, input.normY, wi, sr, dl);
        if (pt) await tap(this.udid, pt.x, pt.y);
        break;
      }
      case 'swipe': {
        const start =
          windowNormToDeviceLogical(input.startX, input.startY, wi, sr, dl) ?? {
            x: clampPt(input.startX * dl.w, 0, dl.w),
            y: clampPt(input.startY * dl.h, 0, dl.h),
          };
        const end =
          windowNormToDeviceLogical(input.endX, input.endY, wi, sr, dl) ?? {
            x: clampPt(input.endX * dl.w, 0, dl.w),
            y: clampPt(input.endY * dl.h, 0, dl.h),
          };
        await swipe(this.udid, start.x, start.y, end.x, end.y);
        break;
      }
      case 'scroll':
        this.injectScroll(input.normX, input.normY, input.deltaX, input.deltaY);
        break;
      case 'text':
        await sendText(this.udid, input.text);
        break;
      case 'key':
        await sendKey(this.udid, input.key);
        break;
    }
  }

  // Debounce 80ms — accumulate wheel deltas and fire one swipe.
  private injectScroll(normX: number, normY: number, deltaX: number, deltaY: number): void {
    this.scrollAcc.dx += deltaX;
    this.scrollAcc.dy += deltaY;
    this.scrollAcc.normX = normX;
    this.scrollAcc.normY = normY;
    if (this.scrollTimer) return;
    this.scrollTimer = setTimeout(() => {
      this.scrollTimer = null;
      const { dx, dy, normX: nx, normY: ny } = this.scrollAcc;
      this.scrollAcc = { dx: 0, dy: 0, normX: 0.5, normY: 0.5 };
      if (!this.windowInfo || !this.screenRect) return;
      const wi = this.windowInfo;
      const sr = this.screenRect;
      const dl = this.deviceLogical;

      const anchor = windowNormToDeviceLogical(nx, ny, wi, sr, dl) ?? {
        x: Math.round(nx * dl.w),
        y: Math.round(ny * dl.h),
      };

      const SPEED = 3;
      const distY = Math.min(400, Math.abs(dy) * SPEED);
      const distX = Math.min(400, Math.abs(dx) * SPEED);
      if (distY < 5 && distX < 5) return;

      if (distY >= distX) {
        const dir = dy > 0 ? -1 : 1;
        const startY = clampPt(anchor.y - (dir * distY) / 2, 0, dl.h);
        const endY = clampPt(anchor.y + (dir * distY) / 2, 0, dl.h);
        void swipe(this.udid, anchor.x, startY, anchor.x, endY);
      } else {
        const dir = dx > 0 ? -1 : 1;
        const startX = clampPt(anchor.x - (dir * distX) / 2, 0, dl.w);
        const endX = clampPt(anchor.x + (dir * distX) / 2, 0, dl.w);
        void swipe(this.udid, startX, anchor.y, endX, anchor.y);
      }
    }, 80);
  }

  async stop(): Promise<void> {
    if (this.phase === 'ended' || this.phase === 'ending') return;
    this.setPhase('ending');
    if (this.currentBuild) {
      this.currentBuild.cancel();
      this.currentBuild = null;
    }
    if (this.scrollTimer) {
      clearTimeout(this.scrollTimer);
      this.scrollTimer = null;
    }
    if (this.capturer) {
      this.capturer.stop();
      this.capturer = null;
    }
    if (this.simctlCapturer) {
      this.simctlCapturer.stop();
      this.simctlCapturer = null;
    }
    if (this.idbCapturer) {
      this.idbCapturer.stop();
      this.idbCapturer = null;
    }
    if (this.framebufferCapturer) {
      this.framebufferCapturer.stop();
      this.framebufferCapturer = null;
    }
    stopCompanion(this.udid);
    await shutdownSimulator(this.udid).catch(() => undefined);
    this.setPhase('ended');
  }
}

import { EventEmitter } from 'node:events';
import path from 'node:path';
import type {
  BuildDiagnostic,
  BuildPhase,
  DeviceLogical,
  DeviceModel,
  Input,
  LogStream,
  Orientation,
  ScreenRect,
  WindowInfo,
} from '@sim/shared';
import { parseLiveDiagnostic } from './build-diagnostics.js';
import {
  type CapturerHandle,
  listSimulatorWindows,
  startCapturer,
} from './capturer.js';
import {
  bootSimulator,
  probeDeviceLogicalSize,
  eraseSimulator,
  deviceScaleFor,
  naturalOrientation,
  rotateSimulator,
  getOrientation,
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
import {
  BUILDS_ROOT,
  BuildAborted,
  installAndLaunch,
  runBuild,
  type BuildHandle,
  type LaunchCameraInjection,
} from './build.js';
import { selectedBuildBackend } from './build-runner.js';
import { runVmBuild } from './vm-build-runner.js';
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
  // event:'diagnostic' carries one live-parsed issue; event:'succeeded'|'failed'
  // may carry the authoritative xcresult-extracted set as `diagnostics`.
  diagnostic?: BuildDiagnostic;
  diagnostics?: BuildDiagnostic[];
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
  orientation: (orientation: Orientation) => void;
}

export interface SessionInit {
  sessionId: string;
  udid: string;
  /** Device family this slot was claimed/retyped for. Drives screen-scale
   * (@2x iPad / @3x iPhone) and the natural default orientation. */
  deviceModel?: DeviceModel;
  /** Requested orientation. Absent → the device's natural default. */
  orientation?: Orientation;
  /** When present, the app is launched with the camera shim injected so a
   * webcam feed can be streamed into its AVCaptureSession. Null/absent on hosts
   * without the shim dylib (camera feature off; launch proceeds normally). */
  camera?: LaunchCameraInjection | null;
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
  readonly deviceModel: DeviceModel;
  /** Per-model screen scale used to derive logical size from screenshots. */
  private readonly scaleHint: number;
  /** Orientation we want the device in (requested, or the model's natural). */
  private desiredOrientation: Orientation;
  /** Orientation the device is actually in, as last observed/rotated. */
  private currentOrientation: Orientation;
  private readonly camera: LaunchCameraInjection | null;
  /**
   * Set to true by `stop()` when the post-session `simctl erase` fails. The
   * pool owner (index.ts) reads this after `stop()` resolves; if true, it
   * MUST recreate the device rather than return the UDID to the pool. The
   * cost of not honoring this flag is exactly the bug we're fixing: the next
   * tenant claims a UDID still holding the prior tenant's installed apps.
   */
  udidDirty = false;
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
  /** Capture mode actually chosen for this session (iPad forces simctl). */
  private activeCaptureMode: CaptureMode = ENV_CAPTURE_MODE;
  /**
   * Monotonic generation for the framebuffer capturer. A deliberate restart
   * (e.g. on rotate) increments this; the OLD capturer's onExit/onError
   * callbacks carry their original generation and are ignored once stale — so
   * stopping a capturer on purpose never errors the session.
   */
  private captureGen = 0;

  constructor(init: SessionInit) {
    super();
    this.sessionId = init.sessionId;
    this.udid = init.udid;
    this.deviceModel = init.deviceModel ?? 'iPhone-16-Pro';
    this.scaleHint = deviceScaleFor(this.deviceModel);
    this.desiredOrientation = init.orientation ?? naturalOrientation(this.deviceModel);
    this.currentOrientation = this.desiredOrientation;
    this.camera = init.camera ?? null;
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

  getOrientationState(): Orientation {
    return this.currentOrientation;
  }

  /**
   * Rotate the booted sim to `this.desiredOrientation` (best-effort) and report
   * the orientation actually achieved. Called once before capture starts.
   */
  private async applyDesiredOrientation(): Promise<void> {
    try {
      const actual = await rotateSimulator(this.udid, this.desiredOrientation);
      this.currentOrientation = actual;
      this.emit('orientation', actual);
    } catch (e) {
      warn(`applyDesiredOrientation failed: ${(e as Error).message}`);
      // Report whatever we can read so the bezel still matches.
      const obs = await getOrientation(this.udid).catch(() => null);
      if (obs) {
        this.currentOrientation = obs;
        this.emit('orientation', obs);
      }
    }
  }

  /**
   * Live rotate while streaming. JPEG capture modes (sck/simctl/idb) auto-adapt
   * to the new frame dimensions, so a rotate alone updates the stream. The
   * framebuffer (H.264) mode has fixed decoder dims, so we restart that capturer
   * to re-emit a fresh video_config at the rotated dimensions.
   */
  async setOrientation(orientation: Orientation): Promise<void> {
    this.desiredOrientation = orientation;
    if (this.phase !== 'ready') return; // applied at next capture start
    // Rotate the app's interface to `orientation`. IMPORTANT iOS-26 reality: the
    // simulator's captured IOSurface stays portrait-native regardless of how we
    // rotate — the app renders its landscape layout ROTATED into that portrait
    // surface (status bar upright, content sideways). There is no host-side way
    // to get a true landscape framebuffer, so the BROWSER compensates by rotating
    // the video 90° for landscape (see device-frame). Because the framebuffer
    // dimensions DON'T change, we must NOT restart the capturer (that would blip
    // the stream for nothing) and we report the REQUESTED orientation so the
    // browser knows to apply its 90° display rotation.
    await rotateSimulator(this.udid, orientation);
    this.deviceLogical =
      (await probeDeviceLogicalSize(this.udid, this.scaleHint)) ?? this.deviceLogical;
    {
      this.currentOrientation = orientation;
      this.emit('orientation', orientation);
    }
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

    await this.applyDesiredOrientation();
    const probed = await probeDeviceLogicalSize(this.udid, this.scaleHint);
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

    // Boot strategy, tuned for a memory-constrained host (8GB):
    //  • iPhone: boot in parallel with the build (light device, proven fast).
    //  • iPad: the 13" sim is heavy. Booting it *during* xcodebuild thrashes RAM
    //    (build crawls) and starves the display-surface ("screen surfaces
    //    timeout"). So we build FIRST with no sim running (fast), then boot the
    //    iPad ALONE afterwards so it gets its surface cleanly. See the post-build
    //    boot below.
    const isFirstBuild = this.phase === 'idle' || this.phase === 'building';
    const deferBoot = isFirstBuild && this.deviceModel === 'iPad-Pro';
    const bootTask =
      isFirstBuild && !deferBoot ? this.bootInParallel() : Promise.resolve(true);

    this.setPhase('building');
    this.emit('build', { event: 'started' });

    // Workdir mirrors what runBuild constructs; needed to feed the live regex
    // parser the same path-rewrite context the sanitizer uses.
    const buildWorkdir = path.join(BUILDS_ROOT, this.sessionId);
    // Backend switch (see build-runner.ts). 'vm-queue' compiles inside a
    // disposable VM — the only place untrusted xcodegen/xcodebuild should run;
    // 'local-simuser' is the bare-metal interim. Both satisfy the same contract,
    // so everything below is backend-agnostic.
    const startBuild = selectedBuildBackend() === 'vm-queue' ? runVmBuild : runBuild;
    const handle = startBuild({
      sessionId: this.sessionId,
      tarballBuf,
      hints,
      onLog: (line, stream) => {
        this.emit('build', { event: 'log', line, stream });
        // Live parse: if this log line looks like a compiler diagnostic, also
        // emit a structured `diagnostic` event so the UI can populate the
        // Issues panel as the build runs. The authoritative xcresult set
        // replaces these on completion.
        const diag = parseLiveDiagnostic(line, buildWorkdir);
        if (diag) this.emit('build', { event: 'diagnostic', diagnostic: diag });
      },
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
      // xcodebuild errors attach the authoritative xcresult diagnostics so
      // the UI can render the structured Issues panel on failure.
      const diagnostics =
        (e as Error & { diagnostics?: BuildDiagnostic[] }).diagnostics ?? [];
      this.emit('build', { event: 'failed', message: msg, diagnostics });
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
      diagnostics: result.diagnostics,
    });

    if (isFirstBuild) {
      // iPad: now that the build is done (and no sim was competing for RAM),
      // boot the heavy device alone so it allocates its display surface cleanly.
      // iPhone: just await the parallel boot started earlier.
      this.setPhase('booting');
      const booted = deferBoot
        ? await bootSimulator(this.udid, 180_000)
        : await bootTask;
      if (!booted) {
        this.setPhase('error', { message: 'Simulator boot timed out.' });
        return;
      }
    }

    this.setPhase('installing');
    try {
      await installAndLaunch(this.udid, result.appBundlePath, result.bundleId, this.camera);
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

    // The heavy iPad display surface can lag behind app launch on a constrained
    // host. Wait until a screenshot actually succeeds before starting capture,
    // so we don't hammer (and give up on) "Timeout waiting for screen surfaces".
    if (this.deviceModel === 'iPad-Pro') {
      const ready = await this.waitForScreenReady(90_000);
      if (!ready) {
        this.setPhase('error', {
          message: 'iPad display surface never became ready (host may be low on memory).',
        });
        return;
      }
    }

    // Best-effort rotation to the requested orientation BEFORE capture, so the
    // probe sees the final dimensions. Bounded + non-fatal: a failed/blocked
    // rotate leaves the device in its boot orientation, which we report so the
    // bezel matches. With the portrait default this is a fast no-op (no rotate).
    await this.applyDesiredOrientation();

    // Capture path. Both iPhone and iPad use the native framebuffer (H.264)
    // capturer. iPad works too as long as the device is fully booted + rendered
    // before we probe — the earlier "no IOSurface" failures were purely a
    // readiness race (iPad booting during the build), now fixed by build-first +
    // boot-alone + waitForScreenReady above. The IOSurface is the real rendered
    // display, so it's correct on rotation (no simctl screenshot orientation
    // quirk) and high-framerate.
    if (hasIDB()) startCompanion(this.udid);
    const mode: CaptureMode = ENV_CAPTURE_MODE;
    this.activeCaptureMode = mode;
    log(`Session ${this.sessionId.slice(0, 8)} capture mode=${mode} (${this.deviceModel}, ${this.currentOrientation})`);
    if (mode === 'framebuffer') {
      await this.startFramebufferCapture();
    } else if (mode === 'idb') {
      await this.startIdbCapture();
    } else if (mode === 'simctl') {
      await this.startSimctlCapture();
    } else {
      await this.startSckCaptureAfterLaunch();
    }
  }

  /**
   * Poll a screenshot until the device's display surface is up. simctl returns
   * "Timeout waiting for screen surfaces" until the booted device has rendered
   * its first frame — heavy iPad displays on a constrained host can take a while
   * after launch. Returns false if it never becomes ready within the budget.
   */
  private async waitForScreenReady(timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    let attempt = 0;
    while (Date.now() - start < timeoutMs) {
      const probed = await probeDeviceFromScreenshot(this.udid, this.scaleHint);
      if (probed) {
        log(`Session ${this.sessionId.slice(0, 8)} screen ready after ${attempt + 1} probe(s)`);
        return true;
      }
      attempt++;
      await sleep(2000);
    }
    return false;
  }

  private async startFramebufferCapture(): Promise<void> {
    const probed = await probeDeviceFromScreenshot(this.udid, this.scaleHint);
    const physical = probed?.physical ?? { w: 1179, h: 2556 };
    const logical = probed?.logical ?? { w: 393, h: 852 };
    this.deviceLogical = logical;
    this.windowInfo = { id: 0, x: 0, y: 0, w: physical.w, h: physical.h, scale: 1 };
    this.screenRect = { left: 0, top: 0, right: physical.w, bottom: physical.h };

    let gotConfig = false;
    const gen = ++this.captureGen;
    // True once a newer capturer generation supersedes this one (a deliberate
    // restart, e.g. on rotate). Stale callbacks must not touch session state.
    const isStale = () => gen !== this.captureGen;
    // Watchdog: if the native capturer never locates the SimDisplay IOSurface
    // (no onConfig), error out so the slot is released rather than leaking a
    // stuck session that wedges the queue.
    const configWatchdog = setTimeout(() => {
      if (!isStale() && !gotConfig && this.phase !== 'ending' && this.phase !== 'ended' && this.phase !== 'ready') {
        err(`framebuffer capturer: no video_config within 45s — failing session`);
        this.setPhase('error', { message: 'Capture did not start (no framebuffer surface).' });
      }
    }, 45_000);
    this.framebufferCapturer = startFramebufferCapturer(
      {
        udid: this.udid,
        fps: FRAMEBUFFER_FPS,
        bitrate: FRAMEBUFFER_BITRATE,
        keyframeInterval: FRAMEBUFFER_KEY_INTERVAL,
      },
      {
        onConfig: (config) => {
          if (isStale()) return;
          gotConfig = true;
          clearTimeout(configWatchdog);
          this.windowInfo = { id: 0, x: 0, y: 0, w: config.width, h: config.height, scale: 1 };
          this.screenRect = { left: 0, top: 0, right: config.width, bottom: config.height };
          this.emit('videoConfig', config);
          // NOTE: do NOT derive orientation from config dims. On iOS 26 the
          // captured surface is always portrait even when the app is landscape
          // (the browser rotates the video for display), so dims would always say
          // "portrait" and fight the requested orientation. Orientation is owned
          // by setOrientation, which reports what the user asked for.
          this.setPhase('ready', {
            windowInfo: this.windowInfo,
            screenRect: this.screenRect,
            deviceLogical: this.deviceLogical,
          });
        },
        onChunk: (chunk) => {
          if (isStale()) return;
          this.emit('videoChunk', chunk);
        },
        onError: (message) => {
          // A capturer that's been superseded (rotate restart) is expected to
          // exit/error — never let that take down the live session.
          if (isStale()) return;
          err(`framebuffer capturer: ${message}`);
          if (!gotConfig && this.phase !== 'ending' && this.phase !== 'ended') {
            this.setPhase('error', { message });
          }
        },
        onExit: (reason) => {
          if (isStale()) return;
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
    const probed = await probeDeviceFromScreenshot(this.udid, this.scaleHint);
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
    const probed = await probeDeviceLogicalSize(this.udid, this.scaleHint);
    if (probed) this.deviceLogical = probed;
    await sleep(500);
    await this.startCaptureAtWindow(candidate.id);
  }

  private async startSimctlCapture(): Promise<void> {
    // Probe device dimensions from a single screenshot so we know the canvas size
    // and frontend coordinate mapping is correct.
    const probed = await probeDeviceFromScreenshot(this.udid, this.scaleHint);
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
    // erase implies a verified shutdown first, then wipes installed apps +
    // state so the next session that claims this UDID starts clean (no stale
    // app from a prior tenant, no "duplicate same app" artifacts).
    //
    // The boolean result MUST be observed — silently swallowing it is the
    // original bug. If erase fails, we flag the UDID as dirty and let the
    // pool owner (index.ts stopSession) recreate the device.
    let erased = false;
    try {
      erased = await eraseSimulator(this.udid);
    } catch (e) {
      warn(`session ${this.sessionId} erase threw: ${(e as Error).message}`);
      erased = false;
    }
    if (!erased) {
      this.udidDirty = true;
      warn(`session ${this.sessionId} marked udid ${this.udid.slice(0, 8)} dirty`);
    }
    this.setPhase('ended');
  }
}

// Per-session bridge: forwards frames Host→Browser and inputs Browser→Host.
// The browser may connect after streaming has started; we replay the last known
// calibration so the canvas wires up correctly on reconnect.

import type { WebSocket } from 'ws';
import { DUO_DISPLAY_INDEX, encodeVideoFlags } from '@sim/shared';
import type {
  BuildDiagnostic,
  DuoDisplay,
  DuoState,
  Orientation,
  ScreenRect,
  ServerToBrowser,
  WindowInfo,
  DeviceLogical,
  SessionState,
} from '@sim/shared';

interface BuildLogEntry {
  line: string;
  stream: 'stdout' | 'stderr';
}

interface BuildStatusSnapshot {
  state: 'started' | 'succeeded' | 'failed';
  exitCode?: number;
  scheme?: string;
  bundleId?: string;
  durationMs?: number;
  message?: string;
}

interface VideoConfigSnapshot {
  codec: 'h264';
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  format: 'annexb';
  /** iPhone Duo: which panel the stream is. */
  display?: DuoDisplay;
}

/** One video stream's chunks since its last keyframe, kept so a browser that
 * joins (or rejoins) gets a picture at once instead of at the next keyframe —
 * which, for a stream that only sends when the picture changes, can be seconds
 * away. */
interface GopCache {
  chunks: Buffer[];
  bytes: number;
}

const BUILD_LOG_RING_SIZE = 200;
/** A cached group of pictures is dropped (until the next keyframe) past this. */
const GOP_MAX_BYTES = 12 * 1024 * 1024;
const GOP_MAX_CHUNKS = 1200;

interface SessionPipe {
  sessionId: string;
  browsers: Set<WebSocket>;
  windowInfo: WindowInfo | null;
  screenRect: ScreenRect | null;
  deviceLogical: DeviceLogical | null;
  /** Optional input fields this session's host honours; passed on to browsers. */
  features: string[];
  lastFrame: string | null; // base64 — replayed to late joiners so the screen isn't blank
  state: SessionState;
  buildLog: BuildLogEntry[];
  lastBuildStatus: BuildStatusSnapshot | null;
  /** Diagnostics from the most recent build. Replaced wholesale on `final:true`
   * (the authoritative xcresult set); appended-to on `final:false` (live regex).
   * Cleared when a new build starts. */
  buildDiagnostics: BuildDiagnostic[];
  videoConfig: VideoConfigSnapshot | null;
  /** iPhone Duo: the latest configuration of each panel's stream. */
  duoVideoConfigs: Partial<Record<DuoDisplay, VideoConfigSnapshot>>;
  /** iPhone Duo: the latest hinge and panel state. */
  duoState: DuoState | null;
  /** Chunks since the last keyframe, per stream index. Only kept for streams
   * that asked for it (see pushVideoChunk). */
  gops: Map<number, GopCache>;
  /** Last camera-request state from the injected shim (true once the app's
   * AVCaptureSession is running). Replayed to late joiners so a browser that
   * connects after the app opened the camera still starts streaming the webcam. */
  cameraActive: boolean;
  /** Last orientation the host reported. Replayed to late joiners so the bezel
   * matches the live stream immediately on (re)connect. */
  orientation: Orientation | null;
  /** Pending GC timer fired when the last browser disconnects. */
  idleTimer: NodeJS.Timeout | null;
}

const IDLE_GRACE_MS = parseInt(process.env.SESSION_IDLE_GRACE_MS ?? '60000', 10);

/** A browser with more than this still unsent is not given a replay on top. */
const REPLAY_MAX_PENDING_BYTES = 4 * 1024 * 1024;

export class SessionProxy {
  private pipes = new Map<string, SessionPipe>();

  ensure(sessionId: string): SessionPipe {
    let p = this.pipes.get(sessionId);
    if (!p) {
      p = {
        sessionId,
        browsers: new Set(),
        windowInfo: null,
        screenRect: null,
        deviceLogical: null,
        features: [],
        lastFrame: null,
        state: 'queued',
        buildLog: [],
        lastBuildStatus: null,
        buildDiagnostics: [],
        videoConfig: null,
        duoVideoConfigs: {},
        duoState: null,
        gops: new Map(),
        cameraActive: false,
        orientation: null,
        idleTimer: null,
      };
      this.pipes.set(sessionId, p);
      // Arm the idle timer immediately. If a browser attaches within the
      // grace window the timer is cancelled; otherwise the session is
      // considered abandoned and the slot is freed.
      this.armIdleTimer(p);
    }
    return p;
  }

  private armIdleTimer(p: SessionPipe): void {
    if (p.browsers.size > 0) return;
    if (p.idleTimer) clearTimeout(p.idleTimer);
    p.idleTimer = setTimeout(() => {
      p.idleTimer = null;
      if (p.browsers.size > 0) return;
      this.onSessionAbandoned?.(p.sessionId);
    }, IDLE_GRACE_MS);
  }

  /** Fires when a session's last browser leaves AND the grace period elapses. */
  onSessionAbandoned: ((sessionId: string) => void) | null = null;

  attachBrowser(sessionId: string, ws: WebSocket): void {
    const p = this.ensure(sessionId);
    p.browsers.add(ws);
    // Cancel any pending abandon timer — the session is being watched again.
    if (p.idleTimer) {
      clearTimeout(p.idleTimer);
      p.idleTimer = null;
    }
    // Replay calibration + last frame for the new client.
    if (p.windowInfo && p.screenRect && p.deviceLogical) {
      send(ws, {
        type: 'calibration',
        windowInfo: p.windowInfo,
        screenRect: p.screenRect,
        deviceLogical: p.deviceLogical,
        features: p.features,
      });
    }
    if (p.lastFrame) {
      send(ws, { type: 'frame', data: p.lastFrame, format: 'jpeg' });
    }
    if (p.videoConfig) {
      send(ws, { type: 'video_config', ...p.videoConfig });
    }
    // iPhone Duo: the device's state, then each panel's stream configuration
    // and its picture so far.
    if (p.duoState) send(ws, { type: 'duo_state', ...p.duoState });
    for (const config of Object.values(p.duoVideoConfigs)) {
      if (config) send(ws, { type: 'video_config', ...config });
    }
    this.replayVideo(sessionId, ws);
    // Replay buffered build log + last status so a late-joining UI rebuilds context.
    for (const entry of p.buildLog) {
      send(ws, { type: 'build_log', line: entry.line, stream: entry.stream });
    }
    if (p.buildDiagnostics.length > 0) {
      // Replay as `final:true` because what's in the buffer is whatever the most
      // recent push made it — for a late joiner there's no value treating it as
      // partial.
      send(ws, {
        type: 'build_diagnostics',
        diagnostics: p.buildDiagnostics,
        final: true,
      });
    }
    if (p.lastBuildStatus) {
      send(ws, { type: 'build_status', ...p.lastBuildStatus });
    }
    if (p.cameraActive) {
      send(ws, { type: 'camera_request', active: true });
    }
    if (p.orientation) {
      send(ws, { type: 'orientation', orientation: p.orientation });
    }
    send(ws, { type: 'state', state: p.state });
  }

  /**
   * Send one browser each cached stream's picture so far (see GopCache).
   * Not to a browser that is already far behind on what it has been sent:
   * a replay is megabytes, and one that asks again and again while reading
   * slowly would otherwise pile them up here. It is told nothing; the next
   * keyframe reaches it in its turn. Returns whether the replay was sent.
   */
  replayVideo(sessionId: string, ws: WebSocket): boolean {
    const p = this.pipes.get(sessionId);
    if (!p) return false;
    if (ws.bufferedAmount > REPLAY_MAX_PENDING_BYTES) return false;
    for (const gop of p.gops.values()) {
      for (const packet of gop.chunks) {
        try {
          ws.send(packet);
        } catch {
          /* ignore */
        }
      }
    }
    return true;
  }

  detachBrowser(sessionId: string, ws: WebSocket): void {
    const p = this.pipes.get(sessionId);
    if (!p) return;
    p.browsers.delete(ws);
    this.armIdleTimer(p);
  }

  updateState(
    sessionId: string,
    state: SessionState,
    queuePosition?: number,
    reason?: string,
  ): void {
    const p = this.ensure(sessionId);
    p.state = state;
    this.broadcast(p, { type: 'state', state, queuePosition, reason });
  }

  updateCalibration(
    sessionId: string,
    windowInfo: WindowInfo,
    screenRect: ScreenRect,
    deviceLogical: DeviceLogical,
    features?: string[],
  ): void {
    const p = this.ensure(sessionId);
    p.windowInfo = windowInfo;
    p.screenRect = screenRect;
    p.deviceLogical = deviceLogical;
    // A recalibration without a list keeps what the host last reported.
    if (features) p.features = features;
    this.broadcast(p, { type: 'calibration', windowInfo, screenRect, deviceLogical, features: p.features });
  }

  pushFrame(sessionId: string, jpegBase64: string): void {
    const p = this.pipes.get(sessionId);
    if (!p) return;
    p.lastFrame = jpegBase64;
    if (p.browsers.size === 0) return; // don't bother serializing if no one's watching
    this.broadcast(p, { type: 'frame', data: jpegBase64, format: 'jpeg' });
  }

  pushVideoConfig(sessionId: string, config: VideoConfigSnapshot): void {
    const p = this.ensure(sessionId);
    if (config.display) {
      // A panel's stream restarted: its cached pictures belong to the old one.
      p.duoVideoConfigs[config.display] = config;
      p.gops.delete(DUO_DISPLAY_INDEX[config.display]);
    } else {
      p.videoConfig = config;
    }
    this.broadcast(p, { type: 'video_config', ...config });
  }

  /** iPhone Duo: hinge angle and which panels are lit. */
  pushDuoState(sessionId: string, state: DuoState): void {
    const p = this.ensure(sessionId);
    p.duoState = state;
    this.broadcast(p, { type: 'duo_state', ...state });
  }

  pushVideoChunk(
    sessionId: string,
    timestampMs: number,
    keyframe: boolean,
    data: Buffer,
    streamIndex = 0,
  ): void {
    const p = this.pipes.get(sessionId);
    if (!p) return;
    // A Duo's streams send a frame only when the picture changes, so the
    // chunks since each one's last keyframe are kept for late joiners. (A
    // single-panel stream has a keyframe every second and needs no cache.)
    const cached = Object.keys(p.duoVideoConfigs).length > 0;
    if (!cached && p.browsers.size === 0) return;
    const header = Buffer.alloc(10);
    header.writeUInt8(1, 0); // protocol version
    header.writeUInt8(encodeVideoFlags(keyframe, streamIndex), 1);
    header.writeBigUInt64BE(BigInt(Math.max(0, Math.floor(timestampMs))), 2);
    const packet = Buffer.concat([header, data]);
    if (cached) {
      let gop = p.gops.get(streamIndex);
      if (keyframe) {
        gop = { chunks: [packet], bytes: packet.length };
        p.gops.set(streamIndex, gop);
      } else if (gop) {
        if (gop.chunks.length >= GOP_MAX_CHUNKS || gop.bytes + packet.length > GOP_MAX_BYTES) {
          p.gops.delete(streamIndex);
        } else {
          gop.chunks.push(packet);
          gop.bytes += packet.length;
        }
      }
    }
    for (const ws of p.browsers) {
      try {
        ws.send(packet);
      } catch {
        /* ignore individual send failure */
      }
    }
  }

  /** The injected shim's capture session started (active:true) or stopped
   * (active:false). Relayed to browsers so they prompt + start/stop the webcam. */
  pushCameraRequest(sessionId: string, active: boolean): void {
    const p = this.ensure(sessionId);
    p.cameraActive = active;
    this.broadcast(p, { type: 'camera_request', active });
  }

  pushStatus(sessionId: string, message: string): void {
    const p = this.pipes.get(sessionId);
    if (!p) return;
    this.broadcast(p, { type: 'status', message });
  }

  pushOrientation(sessionId: string, orientation: Orientation): void {
    const p = this.ensure(sessionId);
    p.orientation = orientation;
    this.broadcast(p, { type: 'orientation', orientation });
  }

  pushError(sessionId: string, message: string): void {
    const p = this.pipes.get(sessionId);
    if (!p) return;
    this.broadcast(p, { type: 'error', message });
  }

  pushBuildLog(sessionId: string, line: string, stream: 'stdout' | 'stderr'): void {
    const p = this.ensure(sessionId);
    p.buildLog.push({ line, stream });
    if (p.buildLog.length > BUILD_LOG_RING_SIZE) {
      p.buildLog.splice(0, p.buildLog.length - BUILD_LOG_RING_SIZE);
    }
    this.broadcast(p, { type: 'build_log', line, stream });
  }

  pushBuildStatus(sessionId: string, status: BuildStatusSnapshot): void {
    const p = this.ensure(sessionId);
    p.lastBuildStatus = status;
    // Clear the log + diagnostics buffers when a new build starts so the next
    // replay starts fresh.
    if (status.state === 'started') {
      p.buildLog = [];
      p.buildDiagnostics = [];
    }
    this.broadcast(p, { type: 'build_status', ...status });
  }

  pushBuildDiagnostics(
    sessionId: string,
    diagnostics: BuildDiagnostic[],
    final: boolean,
  ): void {
    const p = this.ensure(sessionId);
    if (final) {
      // Authoritative xcresult set replaces whatever live ones we had.
      p.buildDiagnostics = diagnostics;
    } else {
      // Live incremental: dedupe by file+line+col+message so the same warning
      // emitted multiple times by the regex doesn't pile up.
      const key = (d: BuildDiagnostic): string =>
        `${d.file}:${d.line}:${d.column}:${d.severity}:${d.message}`;
      const seen = new Set(p.buildDiagnostics.map(key));
      for (const d of diagnostics) {
        if (!seen.has(key(d))) {
          seen.add(key(d));
          p.buildDiagnostics.push(d);
        }
      }
    }
    this.broadcast(p, { type: 'build_diagnostics', diagnostics, final });
  }

  hasBrowsers(sessionId: string): boolean {
    return (this.pipes.get(sessionId)?.browsers.size ?? 0) > 0;
  }

  closeSession(sessionId: string): void {
    const p = this.pipes.get(sessionId);
    if (!p) return;
    if (p.idleTimer) {
      clearTimeout(p.idleTimer);
      p.idleTimer = null;
    }
    for (const ws of p.browsers) {
      try {
        ws.close(1000, 'session ended');
      } catch {
        /* ignore */
      }
    }
    this.pipes.delete(sessionId);
  }

  private broadcast(p: SessionPipe, msg: ServerToBrowser): void {
    const data = JSON.stringify(msg);
    for (const ws of p.browsers) {
      try {
        ws.send(data);
      } catch {
        /* ignore individual send failure */
      }
    }
  }
}

function send(ws: WebSocket, msg: ServerToBrowser): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    /* ignore */
  }
}

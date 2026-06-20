// Wire protocol — single source of truth for messages between Browser, Controller, Host Agent.
// All messages travel as JSON over WebSocket. Frames stay base64 inside JSON (PoC).

import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

// Binary camera-frame protocol version (leading byte of every camera frame).
// Distinct from the host→browser video-chunk version (1) so the controller can
// tell the two binary streams apart on a shared socket.
//
// Reverse media channel — webcam frames flow browser → controller → host → shim.
// Frames are raw binary (NOT JSON); JPEG payloads with a small header:
//   Browser → Controller: [ver:u8=2][reserved:u8][timestampMs:u64 BE][jpeg…]
//     (sessionId is implicit — the browser WS is already bound to one session)
//   Controller → Host:     [ver:u8=2][reserved:u8][sidLen:u16 BE][timestampMs:u64 BE][sessionId utf8][jpeg…]
//     (sessionId added so a multi-session host can route to the right shim)
export const CAMERA_FRAME_VERSION = 2;

// ──────────────────────────────────────────────────────────────────────────────
// Common types
// ──────────────────────────────────────────────────────────────────────────────

export const SessionState = z.enum([
  'queued',
  'building',
  'starting',
  'streaming',
  'ended',
  'error',
]);
export type SessionState = z.infer<typeof SessionState>;

export const BuildPhase = z.enum(['started', 'log', 'diagnostic', 'succeeded', 'failed']);
export type BuildPhase = z.infer<typeof BuildPhase>;

export const DeviceBuildState = z.enum(['queued', 'building', 'succeeded', 'failed']);
export type DeviceBuildState = z.infer<typeof DeviceBuildState>;

// App Store builds (distribution-signed + uploaded to App Store Connect) have
// two extra phases beyond a device build: export (archive → signed .ipa) and
// the ASC upload itself. 'succeeded' means Apple ACCEPTED the upload (state
// AWAITING_UPLOAD → PROCESSING); post-upload processing/TestFlight state is
// polled platform-side via the ASC API, not tracked here.
export const AppStoreBuildState = z.enum([
  'queued',
  'building',
  'exporting',
  'uploading',
  'succeeded',
  'failed',
]);
export type AppStoreBuildState = z.infer<typeof AppStoreBuildState>;

// Host→controller event phases for App Store builds. Superset of BuildPhase:
// 'exporting' fires when the archive completes and -exportArchive begins,
// 'uploading' when the signed IPA starts its App Store Connect upload.
export const AppStoreBuildEvent = z.enum([
  'started',
  'log',
  'diagnostic',
  'exporting',
  'uploading',
  'succeeded',
  'failed',
]);
export type AppStoreBuildEvent = z.infer<typeof AppStoreBuildEvent>;

export const LogStream = z.enum(['stdout', 'stderr']);
export type LogStream = z.infer<typeof LogStream>;

// A structured compiler/build issue. `file` is project-relative and already
// sanitized by the host (no absolute host paths, session ids, or UDIDs).
export const BuildDiagnostic = z.object({
  severity: z.enum(['error', 'warning']),
  file: z.string().nullable(),
  line: z.number().nullable(),
  column: z.number().nullable(),
  message: z.string(),
  // ±2 lines of source context around the issue (already sanitized).
  snippet: z.array(z.string()).nullable(),
});
export type BuildDiagnostic = z.infer<typeof BuildDiagnostic>;

export const DeviceModel = z.enum(['iPhone-16-Pro', 'iPad-Pro']);
export type DeviceModel = z.infer<typeof DeviceModel>;

// Device orientation. The host achieves non-default orientations by rotating
// the booted simulator (Device ▸ Rotate) and re-probing dimensions, so the
// stream follows. Absent → the host picks the device's natural default
// (iPhone: portrait, iPad: landscape).
export const Orientation = z.enum(['portrait', 'landscape']);
export type Orientation = z.infer<typeof Orientation>;

export const WindowInfo = z.object({
  id: z.number(),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  scale: z.number(),
});
export type WindowInfo = z.infer<typeof WindowInfo>;

export const ScreenRect = z.object({
  left: z.number(),
  top: z.number(),
  right: z.number(),
  bottom: z.number(),
});
export type ScreenRect = z.infer<typeof ScreenRect>;

export const DeviceLogical = z.object({
  w: z.number(),
  h: z.number(),
});
export type DeviceLogical = z.infer<typeof DeviceLogical>;

export const ResourceReport = z.object({
  cpuPercent: z.number().nullable(),
  memUsedMB: z.number().nullable(),
  memTotalMB: z.number().nullable(),
  loadAvg1: z.number().nullable(),
});
export type ResourceReport = z.infer<typeof ResourceReport>;

// ──────────────────────────────────────────────────────────────────────────────
// Input events (browser → controller → host)
// ──────────────────────────────────────────────────────────────────────────────

export const TapInput = z.object({
  kind: z.literal('tap'),
  normX: z.number(),
  normY: z.number(),
});
export const SwipeInput = z.object({
  kind: z.literal('swipe'),
  startX: z.number(),
  startY: z.number(),
  endX: z.number(),
  endY: z.number(),
});
export const ScrollInput = z.object({
  kind: z.literal('scroll'),
  normX: z.number(),
  normY: z.number(),
  deltaX: z.number(),
  deltaY: z.number(),
});
// Printable characters — typed verbatim via `idb ui text`.
export const TextInput = z.object({
  kind: z.literal('text'),
  text: z.string().max(1000),
});
// Named non-printable keys (Enter, Backspace, arrows, …). The host maps the
// name → HID usage code. Keeping it a name (not a raw code) keeps the wire
// protocol readable and lets the host own the keymap.
export const KeyInput = z.object({
  kind: z.literal('key'),
  key: z.string().max(32),
});
export const Input = z.discriminatedUnion('kind', [
  TapInput,
  SwipeInput,
  ScrollInput,
  TextInput,
  KeyInput,
]);
export type Input = z.infer<typeof Input>;

// ──────────────────────────────────────────────────────────────────────────────
// Browser ↔ Controller — WebSocket messages (/ws/session/:id)
// ──────────────────────────────────────────────────────────────────────────────

// Server → client
export const ServerStateMsg = z.object({
  type: z.literal('state'),
  state: SessionState,
  queuePosition: z.number().optional(),
  reason: z.string().optional(),
});
export const ServerCalibrationMsg = z.object({
  type: z.literal('calibration'),
  screenRect: ScreenRect,
  windowInfo: WindowInfo,
  deviceLogical: DeviceLogical,
});
export const ServerFrameMsg = z.object({
  type: z.literal('frame'),
  data: z.string(),
  format: z.literal('jpeg'),
});
export const ServerVideoConfigMsg = z.object({
  type: z.literal('video_config'),
  codec: z.literal('h264'),
  width: z.number(),
  height: z.number(),
  fps: z.number(),
  bitrate: z.number(),
  format: z.literal('annexb'),
});
export const ServerErrorMsg = z.object({
  type: z.literal('error'),
  message: z.string(),
});
export const ServerStatusMsg = z.object({
  type: z.literal('status'),
  message: z.string(),
});
export const ServerPongMsg = z.object({ type: z.literal('pong') });
// Reports the device's current orientation to the browser (on session ready
// and after a rotate completes) so the bezel can match the live stream.
export const ServerOrientationMsg = z.object({
  type: z.literal('orientation'),
  orientation: Orientation,
});
// The app inside the simulator started/stopped its camera capture (relayed up
// from the injected shim). The browser uses this to lazily prompt for webcam
// permission and start/stop streaming frames.
export const ServerCameraRequestMsg = z.object({
  type: z.literal('camera_request'),
  active: z.boolean(),
});
export const ServerBuildStatusMsg = z.object({
  type: z.literal('build_status'),
  state: z.enum(['started', 'succeeded', 'failed']),
  exitCode: z.number().optional(),
  scheme: z.string().optional(),
  bundleId: z.string().optional(),
  durationMs: z.number().optional(),
  message: z.string().optional(),
});
export const ServerBuildLogMsg = z.object({
  type: z.literal('build_log'),
  line: z.string(),
  stream: LogStream,
});
export const ServerBuildDiagnosticsMsg = z.object({
  type: z.literal('build_diagnostics'),
  diagnostics: z.array(BuildDiagnostic),
  // true = authoritative xcresult set (replaces live); false = incremental live append.
  final: z.boolean(),
});

export const ServerToBrowser = z.discriminatedUnion('type', [
  ServerStateMsg,
  ServerCalibrationMsg,
  ServerFrameMsg,
  ServerVideoConfigMsg,
  ServerErrorMsg,
  ServerStatusMsg,
  ServerPongMsg,
  ServerOrientationMsg,
  ServerCameraRequestMsg,
  ServerBuildStatusMsg,
  ServerBuildLogMsg,
  ServerBuildDiagnosticsMsg,
]);
export type ServerToBrowser = z.infer<typeof ServerToBrowser>;

// Client → server
export const ClientInputMsg = z.object({
  type: z.literal('input'),
  input: Input,
});
export const ClientCalibrationSetMsg = z.object({
  type: z.literal('set_calibration'),
  screenRect: ScreenRect,
});
export const ClientCalibrationResetMsg = z.object({ type: z.literal('reset_calibration') });
export const ClientPingMsg = z.object({ type: z.literal('ping') });
// Browser asks the controller to rotate the device. Relayed to the host as
// CtrlSetOrientationMsg.
export const ClientSetOrientationMsg = z.object({
  type: z.literal('set_orientation'),
  orientation: Orientation,
});
// Browser tells the controller whether it is (about to be) streaming webcam
// frames. The actual frames travel as binary (see CAMERA_FRAME_VERSION); this
// JSON control message carries the stream's on/off state + dimensions.
export const ClientCameraStateMsg = z.object({
  type: z.literal('camera_state'),
  streaming: z.boolean(),
  width: z.number().optional(),
  height: z.number().optional(),
});

export const BrowserToServer = z.discriminatedUnion('type', [
  ClientInputMsg,
  ClientCalibrationSetMsg,
  ClientCalibrationResetMsg,
  ClientPingMsg,
  ClientCameraStateMsg,
  ClientSetOrientationMsg,
]);
export type BrowserToServer = z.infer<typeof BrowserToServer>;

// ──────────────────────────────────────────────────────────────────────────────
// Browser ↔ Controller — HTTP
// ──────────────────────────────────────────────────────────────────────────────

export const CreateSessionRequest = z.object({
  deviceModel: DeviceModel.default('iPhone-16-Pro'),
  orientation: Orientation.optional(),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;

export const SessionSummary = z.object({
  sessionId: z.string(),
  state: SessionState,
  deviceModel: DeviceModel,
  orientation: Orientation.optional(),
  queuePosition: z.number().nullable(),
  createdAt: z.number(),
  hostId: z.string().nullable(),
});
export type SessionSummary = z.infer<typeof SessionSummary>;

export const DeviceBuildSummary = z.object({
  buildId: z.string(),
  state: DeviceBuildState,
  createdAt: z.number(),
  updatedAt: z.number(),
  hostId: z.string().nullable(),
  scheme: z.string().optional(),
  bundleId: z.string().optional(),
  durationMs: z.number().optional(),
  unsigned: z.boolean().optional(),
  diagnostics: z.array(BuildDiagnostic),
  logs: z.array(
    z.object({
      line: z.string(),
      stream: LogStream,
      at: z.number(),
    }),
  ),
  error: z.string().optional(),
  ipaUrl: z.string().nullable(),
});
export type DeviceBuildSummary = z.infer<typeof DeviceBuildSummary>;

export const AppStoreBuildSummary = z.object({
  buildId: z.string(),
  state: AppStoreBuildState,
  createdAt: z.number(),
  updatedAt: z.number(),
  hostId: z.string().nullable(),
  scheme: z.string().optional(),
  bundleId: z.string().optional(),
  marketingVersion: z.string().optional(),
  buildNumber: z.string().optional(),
  durationMs: z.number().optional(),
  diagnostics: z.array(BuildDiagnostic),
  logs: z.array(
    z.object({
      line: z.string(),
      stream: LogStream,
      at: z.number(),
    }),
  ),
  error: z.string().optional(),
});
export type AppStoreBuildSummary = z.infer<typeof AppStoreBuildSummary>;

// Distribution-signing + upload credentials for an App Store build. PASS-THROUGH
// ONLY: the controller forwards this to the host for the duration of one build
// and must never persist it on the build record or echo it in summaries/logs.
// p8Base64 is base64 of the .p8 PEM so the JSON wire stays single-line.
export const AppStoreSigning = z.object({
  teamId: z.string(),
  keyId: z.string(),
  issuerId: z.string(),
  p8Base64: z.string(),
  /** ASC `apps` resource id the build uploads to (looked up platform-side). */
  ascAppId: z.string(),
  bundleId: z.string(),
  marketingVersion: z.string(),
  buildNumber: z.string(),
});
export type AppStoreSigning = z.infer<typeof AppStoreSigning>;

// ──────────────────────────────────────────────────────────────────────────────
// Host Agent ↔ Controller — WebSocket messages (/ws/host)
// ──────────────────────────────────────────────────────────────────────────────

// Host → Controller
// `kind` declares the host's trust + isolation posture.
//   'vm'         — runs inside a dedicated tart VM (Phase 1+). Eligible for
//                  tenant placement. Destroyed + recreated per session.
//   'bare-metal' — runs on the build Mac directly. Used for internal smoke
//                  tests only. Excluded from tenant placement unless the
//                  controller is started with ALLOW_BARE_METAL_FALLBACK=1.
// Optional for backwards compat — older host-agents that omit it are
// treated as 'bare-metal' by the orchestrator.
export const HostKind = z.enum(['vm', 'bare-metal']);
export type HostKind = z.infer<typeof HostKind>;

export const HostHelloMsg = z.object({
  type: z.literal('hello'),
  hostId: z.string(),
  hostToken: z.string(),
  capacity: z.object({
    slots: z.number(),
    deviceModels: z.array(DeviceModel),
    kind: HostKind.optional(),
  }),
  resources: ResourceReport,
});
export const HostHeartbeatMsg = z.object({
  type: z.literal('heartbeat'),
  activeSessions: z.array(z.string()),
  resources: ResourceReport,
});
export const HostSessionEventMsg = z.object({
  type: z.literal('session_event'),
  sessionId: z.string(),
  event: z.enum(['starting', 'ready', 'ended', 'error']),
  payload: z
    .object({
      windowInfo: WindowInfo.optional(),
      screenRect: ScreenRect.optional(),
      deviceLogical: DeviceLogical.optional(),
      message: z.string().optional(),
    })
    .optional(),
});
export const HostSessionFrameMsg = z.object({
  type: z.literal('session_frame'),
  sessionId: z.string(),
  jpegBase64: z.string(),
});
export const HostVideoConfigMsg = z.object({
  type: z.literal('video_config'),
  sessionId: z.string(),
  codec: z.literal('h264'),
  width: z.number(),
  height: z.number(),
  fps: z.number(),
  bitrate: z.number(),
  format: z.literal('annexb'),
});
export const HostStatusMsg = z.object({
  type: z.literal('host_status'),
  sessionId: z.string().optional(),
  message: z.string(),
  level: z.enum(['info', 'warn', 'error']).default('info'),
});
export const HostPongMsg = z.object({ type: z.literal('pong') });
// Host reports the simulator's current orientation (after boot/launch and
// after a rotate completes). Relayed to the browser as ServerOrientationMsg.
export const HostOrientationMsg = z.object({
  type: z.literal('orientation'),
  sessionId: z.string(),
  orientation: Orientation,
});
// The injected shim connected/disconnected (i.e. the app's AVCaptureSession
// started/stopped). The controller relays this to the browser as
// ServerCameraRequestMsg so it can lazily prompt + start/stop the webcam.
export const HostCameraRequestMsg = z.object({
  type: z.literal('camera_request'),
  sessionId: z.string(),
  active: z.boolean(),
});
export const HostBuildEventMsg = z.object({
  type: z.literal('build_event'),
  sessionId: z.string(),
  event: BuildPhase,
  line: z.string().optional(),
  stream: LogStream.optional(),
  exitCode: z.number().optional(),
  scheme: z.string().optional(),
  bundleId: z.string().optional(),
  durationMs: z.number().optional(),
  message: z.string().optional(),
  // event:'diagnostic' carries one live-parsed issue; event:'succeeded'|'failed'
  // may carry the authoritative xcresult-extracted set.
  diagnostic: BuildDiagnostic.optional(),
  diagnostics: z.array(BuildDiagnostic).optional(),
});
export const HostDeviceBuildEventMsg = z.object({
  type: z.literal('device_build_event'),
  buildId: z.string(),
  event: BuildPhase,
  line: z.string().optional(),
  stream: LogStream.optional(),
  scheme: z.string().optional(),
  bundleId: z.string().optional(),
  durationMs: z.number().optional(),
  message: z.string().optional(),
  unsigned: z.boolean().optional(),
  ipaBase64: z.string().optional(),
  diagnostic: BuildDiagnostic.optional(),
  diagnostics: z.array(BuildDiagnostic).optional(),
});

export const HostAppStoreBuildEventMsg = z.object({
  type: z.literal('app_store_build_event'),
  buildId: z.string(),
  event: AppStoreBuildEvent,
  line: z.string().optional(),
  stream: LogStream.optional(),
  scheme: z.string().optional(),
  bundleId: z.string().optional(),
  durationMs: z.number().optional(),
  message: z.string().optional(),
  diagnostic: BuildDiagnostic.optional(),
  diagnostics: z.array(BuildDiagnostic).optional(),
});

export const HostToController = z.discriminatedUnion('type', [
  HostHelloMsg,
  HostHeartbeatMsg,
  HostSessionEventMsg,
  HostSessionFrameMsg,
  HostVideoConfigMsg,
  HostStatusMsg,
  HostPongMsg,
  HostOrientationMsg,
  HostCameraRequestMsg,
  HostBuildEventMsg,
  HostDeviceBuildEventMsg,
  HostAppStoreBuildEventMsg,
]);
export type HostToController = z.infer<typeof HostToController>;

// Controller → Host
export const CtrlStartSessionMsg = z.object({
  type: z.literal('start_session'),
  sessionId: z.string(),
  deviceModel: DeviceModel,
  orientation: Orientation.optional(),
});
// Live rotate request relayed from the browser. The host rotates the booted
// simulator, restarts capture at the new dimensions, and emits a fresh
// video_config / orientation event so the browser re-fits.
export const CtrlSetOrientationMsg = z.object({
  type: z.literal('set_orientation'),
  sessionId: z.string(),
  orientation: Orientation,
});
export const CtrlStopSessionMsg = z.object({
  type: z.literal('stop_session'),
  sessionId: z.string(),
});
export const CtrlInputMsg = z.object({
  type: z.literal('input'),
  sessionId: z.string(),
  input: Input,
});
export const CtrlSetCalibrationMsg = z.object({
  type: z.literal('set_calibration'),
  sessionId: z.string(),
  screenRect: ScreenRect,
});
export const CtrlResetCalibrationMsg = z.object({
  type: z.literal('reset_calibration'),
  sessionId: z.string(),
});
export const CtrlPingMsg = z.object({ type: z.literal('ping') });
export const CtrlBuildSessionMsg = z.object({
  type: z.literal('build_session'),
  sessionId: z.string(),
  deviceModel: DeviceModel.optional(),
  tarballBase64: z.string(),
  hints: z
    .object({
      scheme: z.string().optional(),
      bundleId: z.string().optional(),
    })
    .optional(),
  isRebuild: z.boolean().optional(),
  orientation: Orientation.optional(),
});
export const CtrlBuildDeviceMsg = z.object({
  type: z.literal('build_device'),
  buildId: z.string(),
  tarballBase64: z.string(),
  hints: z
    .object({
      scheme: z.string().optional(),
      bundleId: z.string().optional(),
    })
    .optional(),
});

export const CtrlBuildAppStoreMsg = z.object({
  type: z.literal('build_app_store'),
  buildId: z.string(),
  tarballBase64: z.string(),
  signing: AppStoreSigning,
  hints: z
    .object({
      scheme: z.string().optional(),
      bundleId: z.string().optional(),
    })
    .optional(),
});

export const ControllerToHost = z.discriminatedUnion('type', [
  CtrlStartSessionMsg,
  CtrlStopSessionMsg,
  CtrlInputMsg,
  CtrlSetCalibrationMsg,
  CtrlResetCalibrationMsg,
  CtrlPingMsg,
  CtrlBuildSessionMsg,
  CtrlBuildDeviceMsg,
  CtrlBuildAppStoreMsg,
  CtrlSetOrientationMsg,
]);
export type ControllerToHost = z.infer<typeof ControllerToHost>;

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Parse a wire message string. Returns null if the payload is invalid JSON or
 * fails schema validation. Caller is expected to fall back to ignoring/logging.
 */
export function safeParse<T extends z.ZodType>(
  schema: T,
  raw: string | { toString: () => string },
): z.infer<T> | null {
  try {
    const text = typeof raw === 'string' ? raw : raw.toString();
    const json = JSON.parse(text);
    const parsed = schema.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

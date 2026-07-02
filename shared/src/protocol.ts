// Wire protocol — single source of truth for messages between Browser, Controller, Host Agent.
// All messages travel as JSON over WebSocket. Frames stay base64 inside JSON (PoC).

import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

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

export const BuildPhase = z.enum(['started', 'log', 'succeeded', 'failed']);
export type BuildPhase = z.infer<typeof BuildPhase>;

export const LogStream = z.enum(['stdout', 'stderr']);
export type LogStream = z.infer<typeof LogStream>;

export const DeviceModel = z.enum(['iPhone-16-Pro']);
export type DeviceModel = z.infer<typeof DeviceModel>;

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

export const ServerToBrowser = z.discriminatedUnion('type', [
  ServerStateMsg,
  ServerCalibrationMsg,
  ServerFrameMsg,
  ServerVideoConfigMsg,
  ServerErrorMsg,
  ServerStatusMsg,
  ServerPongMsg,
  ServerBuildStatusMsg,
  ServerBuildLogMsg,
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

export const BrowserToServer = z.discriminatedUnion('type', [
  ClientInputMsg,
  ClientCalibrationSetMsg,
  ClientCalibrationResetMsg,
  ClientPingMsg,
]);
export type BrowserToServer = z.infer<typeof BrowserToServer>;

// ──────────────────────────────────────────────────────────────────────────────
// Browser ↔ Controller — HTTP
// ──────────────────────────────────────────────────────────────────────────────

export const CreateSessionRequest = z.object({
  deviceModel: DeviceModel.default('iPhone-16-Pro'),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;

export const SessionSummary = z.object({
  sessionId: z.string(),
  state: SessionState,
  deviceModel: DeviceModel,
  queuePosition: z.number().nullable(),
  createdAt: z.number(),
  hostId: z.string().nullable(),
});
export type SessionSummary = z.infer<typeof SessionSummary>;

// ──────────────────────────────────────────────────────────────────────────────
// Host Agent ↔ Controller — WebSocket messages (/ws/host)
// ──────────────────────────────────────────────────────────────────────────────

// Host → Controller
export const HostHelloMsg = z.object({
  type: z.literal('hello'),
  hostId: z.string(),
  hostToken: z.string(),
  capacity: z.object({
    slots: z.number(),
    deviceModels: z.array(DeviceModel),
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
});

export const HostToController = z.discriminatedUnion('type', [
  HostHelloMsg,
  HostHeartbeatMsg,
  HostSessionEventMsg,
  HostSessionFrameMsg,
  HostVideoConfigMsg,
  HostStatusMsg,
  HostPongMsg,
  HostBuildEventMsg,
]);
export type HostToController = z.infer<typeof HostToController>;

// Controller → Host
export const CtrlStartSessionMsg = z.object({
  type: z.literal('start_session'),
  sessionId: z.string(),
  deviceModel: DeviceModel,
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
  tarballBase64: z.string(),
  hints: z
    .object({
      scheme: z.string().optional(),
      bundleId: z.string().optional(),
    })
    .optional(),
  isRebuild: z.boolean().optional(),
});

export const ControllerToHost = z.discriminatedUnion('type', [
  CtrlStartSessionMsg,
  CtrlStopSessionMsg,
  CtrlInputMsg,
  CtrlSetCalibrationMsg,
  CtrlResetCalibrationMsg,
  CtrlPingMsg,
  CtrlBuildSessionMsg,
]);
export type ControllerToHost = z.infer<typeof ControllerToHost>;

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Parse a wire message string. Returns null if the payload is invalid JSON or
 * fails schema validation. Caller is expected to fall back to ignoring/logging.
 */
export function safeParse<T extends z.ZodType>(schema: T, raw: string | Buffer): z.infer<T> | null {
  try {
    const text = typeof raw === 'string' ? raw : raw.toString('utf8');
    const json = JSON.parse(text);
    const parsed = schema.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

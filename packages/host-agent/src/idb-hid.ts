// gRPC client for idb_companion's `hid` RPC — touch / swipe / key injection.
//
// Why this exists: the `idb ui tap|swipe|text|key` CLI is a Python process.
// Spawning it per input costs ~850ms (interpreter start + imports) before the
// event even reaches the companion, which made every click in the browser feel
// laggy. The companion is already running per device, so we keep one gRPC
// channel per companion socket and send each gesture as a short client-stream
// call — a few milliseconds end to end.
//
// Event shapes mirror idb's own Python client (idb/common/hid.py) so behaviour
// matches the CLI exactly: a tap is DOWN+UP on a touch, a key is DOWN+UP on a
// keycode, shifted characters wrap the key in LeftShift (225), and a swipe is a
// single HIDSwipe with delta/duration left at 0 (companion defaults, which is
// what the CLI sends when --delta/--duration are omitted).

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROTO_PATH = path.join(PKG_ROOT, 'proto', 'idb-hid.proto');

const SHIFT = 225;

interface GrpcPoint {
  x: number;
  y: number;
}

type HidPressAction =
  | { touch: { point: GrpcPoint } }
  | { key: { keycode: number } }
  | { button: { button: 'HOME' | 'LOCK' } };

export type HidEvent =
  | { press: { action: HidPressAction; direction: 'DOWN' | 'UP' } }
  | { swipe: { start: GrpcPoint; end: GrpcPoint; delta: number; duration: number } }
  // Seconds to wait before the next event (idb's own `tap --duration` uses it).
  | { delay: { duration: number } };

interface HidServiceClient extends grpc.Client {
  hid: (
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null) => void,
  ) => grpc.ClientWritableStream<HidEvent>;
}

let HidService: grpc.ServiceClientConstructor | null = null;
const clients = new Map<string, HidServiceClient>();

function loadService(): grpc.ServiceClientConstructor {
  if (HidService) return HidService;
  const def = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: Number,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const pkg = grpc.loadPackageDefinition(def) as unknown as {
    idb: { CompanionService: grpc.ServiceClientConstructor };
  };
  HidService = pkg.idb.CompanionService;
  return HidService;
}

function clientFor(socketPath: string): HidServiceClient {
  let client = clients.get(socketPath);
  if (!client) {
    const Service = loadService();
    client = new Service(`unix://${socketPath}`, grpc.credentials.createInsecure()) as unknown as HidServiceClient;
    clients.set(socketPath, client);
  }
  return client;
}

/** Drop the cached channel for a companion socket (companion stopped/restarted). */
export function closeHidClient(socketPath: string): void {
  const client = clients.get(socketPath);
  if (client) {
    client.close();
    clients.delete(socketPath);
  }
}

/**
 * Send one gesture's events as a single `hid` client-stream call. Resolves when
 * the companion has acknowledged the whole batch; rejects on any gRPC error or
 * when the deadline passes (callers fall back to the CLI).
 */
export function sendHidEvents(socketPath: string, events: HidEvent[], timeoutMs = 3_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = clientFor(socketPath);
    const call = client.hid({ deadline: Date.now() + timeoutMs }, (error) => {
      if (error) {
        // A broken channel (companion restarted, socket recreated) is not
        // recovered by grpc-js on its own for UDS targets — start fresh next time.
        if (error.code === grpc.status.UNAVAILABLE) closeHidClient(socketPath);
        reject(error);
      } else {
        resolve();
      }
    });
    for (const event of events) call.write(event);
    call.end();
  });
}

// ── Live touch ──────────────────────────────────────────────────────────────

/**
 * One finger, forwarded as it moves. Each touch is its own `hid` call, kept
 * open from finger-down to finger-up, so the companion acts on every event as
 * it arrives and the simulator sees a real, continuous touch.
 */
export interface LiveTouch {
  move(x: number, y: number): void;
  /** Lift the finger and close the call. Safe to call more than once. */
  up(x?: number, y?: number): void;
}

/** A touch may stay down this long at most (a stuck finger must not outlive its session). */
const LIVE_TOUCH_MAX_MS = 30_000;

export function beginLiveTouch(socketPath: string, x: number, y: number, onClosed?: () => void): LiveTouch {
  const client = clientFor(socketPath);
  let last = { x, y };
  let open = true;
  const call = client.hid({ deadline: Date.now() + LIVE_TOUCH_MAX_MS + 2_000 }, (error) => {
    open = false;
    if (error && error.code === grpc.status.UNAVAILABLE) closeHidClient(socketPath);
    onClosed?.();
  });
  call.write({ press: { action: { touch: { point: last } }, direction: 'DOWN' } });
  const limit = setTimeout(() => touch.up(), LIVE_TOUCH_MAX_MS);
  limit.unref();
  const touch: LiveTouch = {
    move(nx, ny) {
      if (!open) return;
      last = { x: nx, y: ny };
      // A touch-down at a new point while the finger is down is a move.
      call.write({ press: { action: { touch: { point: last } }, direction: 'DOWN' } });
    },
    up(nx, ny) {
      if (!open) return;
      open = false;
      clearTimeout(limit);
      if (nx !== undefined && ny !== undefined) last = { x: nx, y: ny };
      call.write({ press: { action: { touch: { point: last } }, direction: 'UP' } });
      call.end();
    },
  };
  return touch;
}

export function buttonEvents(button: 'HOME' | 'LOCK'): HidEvent[] {
  return press({ button: { button } });
}

// ── Event builders ──────────────────────────────────────────────────────────

function press(action: HidPressAction): HidEvent[] {
  return [
    { press: { action, direction: 'DOWN' } },
    { press: { action, direction: 'UP' } },
  ];
}

function keyDown(keycode: number): HidEvent {
  return { press: { action: { key: { keycode } }, direction: 'DOWN' } };
}

function keyUp(keycode: number): HidEvent {
  return { press: { action: { key: { keycode } }, direction: 'UP' } };
}

export function tapEvents(x: number, y: number): HidEvent[] {
  return press({ touch: { point: { x, y } } });
}

export function swipeEvents(startX: number, startY: number, endX: number, endY: number): HidEvent[] {
  return [{ swipe: { start: { x: startX, y: startY }, end: { x: endX, y: endY }, delta: 0, duration: 0 } }];
}

function touch(direction: 'DOWN' | 'UP', x: number, y: number): HidEvent {
  return { press: { action: { touch: { point: { x, y } } }, direction } };
}

function wait(ms: number): HidEvent {
  return { delay: { duration: ms / 1000 } };
}

/** The longest any one gesture may keep a finger down. */
const MAX_FINGER_MS = 4_000;

/** A press held in place: finger down, wait, finger up. */
export function holdEvents(x: number, y: number, durationMs: number): HidEvent[] {
  const ms = Math.min(Math.max(durationMs, 0), MAX_FINGER_MS);
  return [touch('DOWN', x, y), wait(ms), touch('UP', x, y)];
}

/**
 * A swipe driven point by point, the way a finger moves: down at the start,
 * a move about every 16 ms until the end is reached after `durationMs`, an
 * optional rest at the end, then up.
 *
 * A finger that is still moving when it lifts flings the content; one that
 * rested first leaves it where it is. During the rest the finger is nudged by
 * a fraction of a point each frame, so the simulator keeps receiving touch
 * moves and measures a speed of zero at release (a silent finger would still
 * carry the speed of its last move).
 */
export function pacedSwipeEvents(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  durationMs: number,
  endHoldMs = 0,
): HidEvent[] {
  const moving = Math.min(Math.max(durationMs, 32), MAX_FINGER_MS);
  const rest = Math.min(Math.max(endHoldMs, 0), 1_000);
  const steps = Math.max(2, Math.min(240, Math.round(moving / 16)));
  const stepMs = moving / steps;
  const events: HidEvent[] = [touch('DOWN', startX, startY)];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    events.push(wait(stepMs), touch('DOWN', startX + (endX - startX) * t, startY + (endY - startY) * t));
  }
  if (rest >= 16) {
    const frames = Math.max(2, Math.round(rest / 16));
    for (let i = 1; i <= frames; i++) {
      const nudge = i % 2 === 0 ? 0 : 0.2;
      events.push(wait(rest / frames), touch('DOWN', endX, endY + nudge));
    }
  }
  events.push(touch('UP', endX, endY));
  return events;
}

export function keyEvents(keycode: number): HidEvent[] {
  return press({ key: { keycode } });
}

// Character → [HID keycode, needs shift], from idb/common/hid.py KEY_MAP.
const CHAR_KEYS: Record<string, [number, boolean]> = (() => {
  const map: Record<string, [number, boolean]> = {};
  for (let i = 0; i < 26; i++) {
    map[String.fromCharCode(97 + i)] = [4 + i, false];
    map[String.fromCharCode(65 + i)] = [4 + i, true];
  }
  '1234567890'.split('').forEach((ch, i) => {
    map[ch] = [30 + i, false];
  });
  const plain: Record<string, number> = {
    '\n': 40, ';': 51, '=': 46, ',': 54, '-': 45, '.': 55, '/': 56, '`': 53,
    '[': 47, '\\': 49, ']': 48, "'": 52, ' ': 44,
  };
  const shifted: Record<string, number> = {
    '!': 30, '@': 31, '#': 32, '$': 33, '%': 34, '^': 35, '&': 36, '*': 37,
    '(': 38, ')': 39, '_': 45, '+': 46, '{': 47, '}': 48, ':': 51, '"': 52,
    '|': 49, '<': 54, '>': 55, '?': 56, '~': 53,
  };
  for (const [ch, code] of Object.entries(plain)) map[ch] = [code, false];
  for (const [ch, code] of Object.entries(shifted)) map[ch] = [code, true];
  return map;
})();

/**
 * Key events that type `text`, or null if any character has no HID mapping
 * (the CLI rejects those too — callers fall back to it so the failure is logged
 * the same way).
 */
export function textEvents(text: string): HidEvent[] | null {
  const events: HidEvent[] = [];
  for (const ch of text) {
    const mapped = CHAR_KEYS[ch];
    if (!mapped) return null;
    const [code, shift] = mapped;
    if (shift) events.push(keyDown(SHIFT), keyDown(code), keyUp(code), keyUp(SHIFT));
    else events.push(...keyEvents(code));
  }
  return events;
}

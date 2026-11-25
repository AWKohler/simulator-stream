import os from 'node:os';
import { WebSocket } from 'ws';
import {
  CAMERA_FRAME_VERSION,
  ControllerToHost,
  type DeviceModel,
  type HostKind,
  type HostToController,
  type ResourceReport,
  safeParse,
} from '@sim/shared';
import { log, warn, err } from './log.js';

export interface ControllerClientOptions {
  url: string;
  hostId: string;
  hostToken: string;
  slots: number;
  /** Isolation posture broadcast to the orchestrator. Defaults to 'bare-metal'
   * so the controller can keep older agents off tenant traffic by default. */
  kind?: HostKind;
  /** Device families this host can run. Defaults to iPhone and iPad. */
  deviceModels?: DeviceModel[];
  reconnectMs?: number;
  pingMs?: number;
}

export interface ControllerHandlers {
  onCommand: (cmd: ControllerToHostCmd) => void;
  /** A reverse-channel webcam frame for the injected camera shim. */
  onCameraFrame?: (sessionId: string, timestampMs: number, jpeg: Buffer) => void;
}

export type ControllerToHostCmd = ReturnType<typeof ControllerToHost.parse>;

/** How many rounds of an unanswered /health before connecting anyway. */
const MAX_UNANSWERED_ROUNDS = 3;

export class ControllerClient {
  private ws: WebSocket | null = null;
  private opts: Required<ControllerClientOptions>;
  private handlers: ControllerHandlers;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private getActiveSessions: () => string[];
  private closed = false;
  /** Asking the controller what it knows, before opening a socket. */
  private connecting = false;
  /** Rounds in a row in which the controller's /health gave no answer. */
  private unanswered = 0;

  constructor(
    opts: ControllerClientOptions,
    handlers: ControllerHandlers,
    getActiveSessions: () => string[],
  ) {
    this.opts = {
      reconnectMs: 2000,
      pingMs: 30_000,
      kind: 'bare-metal',
      deviceModels: ['iPhone-16-Pro', 'iPad-Pro'],
      ...opts,
    };
    this.handlers = handlers;
    this.getActiveSessions = getActiveSessions;
  }

  start(): void {
    this.connect();
  }

  close(): void {
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  /**
   * The device families to offer this controller. A controller validates the
   * greeting against the families its own protocol knows and ignores one it
   * cannot parse — which would leave this host serving nothing, iPhone and
   * iPad included. So anything beyond those two (the iPhone Duo) is offered
   * only if the controller's /health says it knows it; an older controller,
   * which says nothing, gets the two it has always had.
   */
  private async offeredDeviceModels(): Promise<DeviceModel[] | null> {
    const base: DeviceModel[] = ['iPhone-16-Pro', 'iPad-Pro'];
    const extra = this.opts.deviceModels.filter((m) => !base.includes(m));
    if (extra.length === 0) return this.opts.deviceModels;
    let failure = '';
    // One slow answer should not cost the Duo until the next reconnect.
    for (let attempt = 0; attempt < 3 && !this.closed; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 700));
      try {
        const url = new URL(this.opts.url);
        url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
        url.pathname = '/health';
        url.search = '';
        const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
        // (A controller that is starting or failing says nothing about what it knows.)
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { deviceModels?: unknown };
        const known = Array.isArray(body.deviceModels) ? body.deviceModels : [];
        const offered = this.opts.deviceModels.filter((m) => base.includes(m) || known.includes(m));
        this.unanswered = 0;
        const withheld = extra.filter((m) => !offered.includes(m));
        if (withheld.length > 0) {
          warn(`Controller does not know ${withheld.join(', ')} (it is older than this agent); not offering it.`);
        }
        return offered;
      } catch (e) {
        failure = (e as Error).message;
      }
    }
    // No answer. A controller that cannot be asked can rarely be connected to
    // either, so try again shortly rather than register without the Duo and
    // stay that way; if it keeps on not answering, connect with what every
    // controller knows.
    if (this.unanswered < MAX_UNANSWERED_ROUNDS) {
      this.unanswered++;
      warn(`Could not ask the controller which devices it knows (${failure}); trying again.`);
      return null;
    }
    warn(`Could not ask the controller which devices it knows (${failure}); offering iPhone and iPad only.`);
    return this.opts.deviceModels.filter((m) => base.includes(m));
  }

  /**
   * Find out what to offer FIRST, then open the socket and greet on it at
   * once. The greeting has to be the first thing the controller hears on a
   * new socket (it closes one that says anything else first), and a session
   * already running on this host may have something to say the moment the
   * socket is open — so nothing may come between opening and greeting.
   */
  private connect(): void {
    if (this.closed || this.connecting) return;
    this.connecting = true;
    void this.offeredDeviceModels().then((deviceModels) => {
      this.connecting = false;
      if (this.closed) return;
      if (deviceModels) this.open(deviceModels);
      else this.scheduleReconnect();
    });
  }

  private open(deviceModels: DeviceModel[]): void {
    log(`Connecting to controller @ ${this.opts.url}`);
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;

    ws.on('open', () => {
      log('Controller WS open');
      this.send({
        type: 'hello',
        hostId: this.opts.hostId,
        hostToken: this.opts.hostToken,
        capacity: {
          slots: this.opts.slots,
          deviceModels,
          kind: this.opts.kind,
        },
        resources: collectResources(),
      });

      // Heartbeats keep cloudflared's WS idle timeout from killing the conn
      // and let the orchestrator notice us going dark.
      this.pingTimer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        this.send({
          type: 'heartbeat',
          activeSessions: this.getActiveSessions(),
          resources: collectResources(),
        });
      }, this.opts.pingMs / 6); // ~5s heartbeat
    });

    ws.on('message', (raw) => {
      const data = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
      // Binary = a reverse-channel webcam frame for the camera shim. Layout:
      // [ver][reserved][sidLen:u16][timestampMs:u64][sessionId utf8][jpeg].
      if (Buffer.isBuffer(data) && data.length >= 12 && data[0] === CAMERA_FRAME_VERSION) {
        const sidLen = data.readUInt16BE(2);
        const timestampMs = Number(data.readBigUInt64BE(4));
        if (sidLen > 0 && data.length > 12 + sidLen) {
          const sessionId = data.subarray(12, 12 + sidLen).toString('utf8');
          const jpeg = data.subarray(12 + sidLen);
          this.handlers.onCameraFrame?.(sessionId, timestampMs, jpeg);
        }
        return;
      }
      const cmd = safeParse(ControllerToHost, data);
      if (!cmd) {
        warn('Invalid controller message');
        return;
      }
      if (cmd.type === 'ping') {
        this.send({ type: 'pong' });
        return;
      }
      try {
        this.handlers.onCommand(cmd);
      } catch (e) {
        err('onCommand handler threw:', (e as Error).message);
      }
    });

    ws.on('close', (code) => {
      log(`Controller WS closed (${code}); reconnecting in ${this.opts.reconnectMs}ms`);
      this.cleanupSocket();
      if (!this.closed) this.scheduleReconnect();
    });

    ws.on('error', (e) => {
      warn(`Controller WS error: ${(e as Error).message}`);
    });
  }

  private cleanupSocket(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.ws = null;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.opts.reconnectMs);
  }

  send(msg: HostToController): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch (e) {
      warn(`Send failed: ${(e as Error).message}`);
    }
  }

  sendBinary(buf: Buffer): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(buf);
    } catch (e) {
      warn(`Binary send failed: ${(e as Error).message}`);
    }
  }
}

export function collectResources(): ResourceReport {
  const free = os.freemem();
  const total = os.totalmem();
  const load = os.loadavg()[0] ?? null;
  return {
    cpuPercent: null, // PoC: skipping per-core sampling
    memUsedMB: Math.round((total - free) / 1024 / 1024),
    memTotalMB: Math.round(total / 1024 / 1024),
    loadAvg1: load,
  };
}

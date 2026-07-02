import os from 'node:os';
import { WebSocket } from 'ws';
import {
  ControllerToHost,
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
  reconnectMs?: number;
  pingMs?: number;
}

export interface ControllerHandlers {
  onCommand: (cmd: ControllerToHostCmd) => void;
}

export type ControllerToHostCmd = ReturnType<typeof ControllerToHost.parse>;

export class ControllerClient {
  private ws: WebSocket | null = null;
  private opts: Required<ControllerClientOptions>;
  private handlers: ControllerHandlers;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private getActiveSessions: () => string[];
  private closed = false;

  constructor(
    opts: ControllerClientOptions,
    handlers: ControllerHandlers,
    getActiveSessions: () => string[],
  ) {
    this.opts = {
      reconnectMs: 2000,
      pingMs: 30_000,
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

  private connect(): void {
    if (this.closed) return;
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
          deviceModels: ['iPhone-16-Pro'],
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

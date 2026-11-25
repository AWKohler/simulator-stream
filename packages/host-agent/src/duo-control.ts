// iPhone Duo input that CoreSimulator's own input path (and so idb) cannot
// carry: the hinge angle, touches on either panel, and the side buttons. It is
// done by a small helper that runs inside the simulator; see
// native/duo-control/main.m for what it sends and why.
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { spawnAsSimUser } from './util.js';
import { log, warn } from './log.js';
import { nativeBinaryFresh, stampNativeBinary } from './native-build.js';

const run = promisify(execFile);
const NATIVE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../native/duo-control');
const SOURCES = [path.join(NATIVE, 'main.m'), path.join(NATIVE, 'build.sh')];
// In sim-user mode the helper is pre-provisioned at a shared path the sim user
// can run (SIM_DUO_CONTROL_BIN); otherwise it is built into the package.
const BINARY = process.env.SIM_DUO_CONTROL_BIN || path.join(NATIVE, 'build/duo-control');

export type DuoButton = 'lock' | 'volumeUp' | 'volumeDown' | 'home';
export type TouchPhase = 'down' | 'move' | 'up';

export interface DuoHingeReport {
  angle: number;
  moving: boolean;
}

/** Build the helper if its source is newer than the binary. */
export async function ensureDuoControl(): Promise<void> {
  if (process.env.SIM_DUO_CONTROL_BIN) return;
  if (nativeBinaryFresh(BINARY, SOURCES)) return;
  await run('/bin/sh', [path.join(NATIVE, 'build.sh')], { timeout: 120_000 });
  stampNativeBinary(BINARY, SOURCES);
  log(`duo-control binary ready: ${BINARY}`);
}

/** Screen ID → display unique id, from CoreSimulator's own enumeration. */
export async function duoDisplayUUIDs(udid: string): Promise<Map<number, string>> {
  const listing = spawnAsSimUser('xcrun', ['simctl', 'io', udid, 'enumerate']);
  const { stdout } = await run(listing.cmd, listing.args, { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
  const map = new Map<number, string>();
  let screenID: number | null = null;
  for (const line of stdout.split('\n')) {
    const id = /^\s*Screen ID:\s*(\d+)/.exec(line);
    if (id) {
      screenID = Number(id[1]);
      continue;
    }
    const uuid = /^\s*Unique ID:\s*([0-9A-F-]{36})/i.exec(line);
    if (uuid && screenID !== null) {
      map.set(screenID, uuid[1].toUpperCase());
      screenID = null;
    }
  }
  return map;
}

interface Pending {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class DuoControl {
  private nextID = 0;
  private stopped = false;
  private readonly pending = new Map<string, Pending>();
  /** Called as the hinge moves: the angle the simulator has actually been given. */
  onHinge: ((report: DuoHingeReport) => void) | null = null;
  /** Called once if the helper dies while the session is live. */
  onExit: ((reason: string) => void) | null = null;

  private constructor(private readonly process: ChildProcessWithoutNullStreams) {}

  static async open(udid: string): Promise<DuoControl> {
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(udid)) throw new Error('Invalid simulator UDID');
    await ensureDuoControl();
    const target = spawnAsSimUser('xcrun', ['simctl', 'spawn', udid, BINARY]);
    const child = spawn(target.cmd, target.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const control = new DuoControl(child);
    await control.waitForReady();
    return control;
  }

  private waitForReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      let ready = false;
      let stderr = '';
      const timer = setTimeout(() => {
        this.close();
        reject(new Error(`Duo helper startup timed out${stderr ? `: ${stderr}` : ''}`));
      }, 15_000);
      const lines = createInterface({ input: this.process.stdout });
      this.process.stderr.on('data', (chunk) => {
        stderr = (stderr + String(chunk)).slice(-1000);
      });
      this.process.stdin.on('error', (error) => this.fail(error));
      this.process.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
        this.fail(error);
      });
      this.process.once('exit', (code, signal) => {
        clearTimeout(timer);
        lines.close();
        const reason = `Duo helper exited (code=${code} signal=${signal ?? 'none'})${stderr ? `: ${stderr.trim()}` : ''}`;
        const wasLive = ready && !this.stopped;
        if (!ready) reject(new Error(reason));
        this.fail(new Error(reason));
        if (wasLive) this.onExit?.(reason);
      });
      lines.on('line', (line) => {
        let record: {
          type?: string;
          id?: string | null;
          ok?: boolean;
          error?: string;
          angle?: number;
          moving?: boolean;
        };
        try {
          record = JSON.parse(line);
        } catch {
          return;
        }
        if (record.type === 'ready') {
          if (!ready) {
            ready = true;
            clearTimeout(timer);
            resolve();
          }
          return;
        }
        if (record.type === 'hinge' && typeof record.angle === 'number') {
          this.onHinge?.({ angle: record.angle, moving: record.moving === true });
          return;
        }
        if (typeof record.id !== 'string') {
          if (record.ok === false) warn(`duo-control: ${record.error ?? 'command failed'}`);
          return;
        }
        const item = this.pending.get(record.id);
        if (!item) return;
        this.pending.delete(record.id);
        clearTimeout(item.timer);
        if (record.ok) item.resolve();
        else item.reject(new Error(record.error ?? 'Duo helper command failed'));
      });
    });
  }

  /**
   * Fold to `angle` degrees. The helper eases the hinge there (iOS decides
   * which panel to light from how the angle moves), so this resolves when the
   * command is accepted, not when the hinge arrives; `onHinge` reports that.
   */
  setHinge(angle: number, instant = false): Promise<void> {
    if (!Number.isFinite(angle) || angle < 0 || angle > 180) {
      return Promise.reject(new Error('Hinge angle must be from 0 to 180'));
    }
    return this.send({ type: 'hinge', angle, ...(instant ? { instant: true } : {}) });
  }

  /**
   * One finger on one panel. `x`/`y` are fractions of that panel's framebuffer
   * (what the capturer streams); `displayUUID` is the panel's unique id.
   * Not awaited by callers that stream touches: order is kept by the pipe.
   */
  touch(displayUUID: string, phase: TouchPhase, x: number, y: number, finger = 0): Promise<void> {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return Promise.reject(new Error('Touch coordinates must be finite'));
    const clamp = (v: number): number => Math.min(1, Math.max(0, v));
    return this.send({ type: 'touch', display: displayUUID, phase, x: clamp(x), y: clamp(y), finger });
  }

  /** Lift every finger on a panel (or on all of them). */
  release(displayUUID?: string): Promise<void> {
    return this.send({ type: 'release', ...(displayUUID ? { display: displayUUID } : {}) });
  }

  button(button: DuoButton, down: boolean): Promise<void> {
    return this.send({ type: 'button', button, down });
  }

  /** How the device is held; iOS turns its interface to match. */
  orientation(orientation: 'portrait' | 'portrait-upside-down' | 'landscape-left' | 'landscape-right'): Promise<void> {
    return this.send({ type: 'orientation', orientation });
  }

  /**
   * Keyboard usages as [usage, down] pairs, sent in order. A long run (a
   * paste) goes as several commands: each is cut where no key is held, so a
   * shifted character is never split from its shift.
   */
  async keys(keys: Array<[number, boolean]>): Promise<void> {
    const MAX_PAIRS = 120;
    let chunk: Array<[number, boolean]> = [];
    const held = new Set<number>();
    for (const pair of keys) {
      chunk.push(pair);
      if (pair[1]) held.add(pair[0]);
      else held.delete(pair[0]);
      if (chunk.length >= MAX_PAIRS && held.size === 0) {
        await this.send({ type: 'keys', keys: chunk }, 15_000);
        chunk = [];
      }
    }
    if (chunk.length > 0) await this.send({ type: 'keys', keys: chunk }, 15_000);
  }

  private send(payload: Record<string, unknown>, timeoutMs = 5000): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('Duo helper is closed'));
    if (this.pending.size >= 512) return Promise.reject(new Error('Too many pending Duo commands'));
    const id = String(++this.nextID);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Duo helper command timed out'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(JSON.stringify({ id, ...payload }) + '\n', (error) => {
        if (!error) return;
        const item = this.pending.get(id);
        if (item) {
          clearTimeout(item.timer);
          this.pending.delete(id);
          item.reject(error);
        }
      });
    });
  }

  private fail(error: Error): void {
    this.stopped = true;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    this.pending.clear();
  }

  /** Closing stdin makes the helper lift any finger still down and exit. */
  close(): void {
    if (this.stopped) return;
    this.fail(new Error('Duo helper is closed'));
    this.process.stdin.end();
    const child = this.process;
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    }, 500).unref();
  }
}

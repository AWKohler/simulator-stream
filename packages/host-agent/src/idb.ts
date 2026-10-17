import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { execAsSimUser, spawnAsSimUser, simUserEnabled } from './util.js';
import { log, warn } from './log.js';
import {
  closeHidClient,
  keyEvents,
  sendHidEvents,
  swipeEvents,
  tapEvents,
  textEvents,
  type HidEvent,
} from './idb-hid.js';

// pip3/conda can install idb into various prefixes depending on the environment.
const IDB_CANDIDATES = [
  'idb',
  '/opt/anaconda3/bin/idb',
  '/opt/homebrew/bin/idb',
  '/usr/local/bin/idb',
  `${homedir()}/anaconda3/bin/idb`,
  `${homedir()}/.local/bin/idb`,
  '/opt/miniconda3/bin/idb',
  `${homedir()}/miniconda3/bin/idb`,
];

const COMPANION_CANDIDATES = [
  '/opt/homebrew/bin/idb_companion',
  '/usr/local/bin/idb_companion',
];

let idbBin: string | null = null;
let companionBin: string | null = null;

export function getIDBBin(): string | null {
  return idbBin;
}

export function hasIDB(): boolean {
  return !!idbBin;
}

export function detect(): { hasIDB: boolean; idbBin: string | null; companionBin: string | null } {
  // In sim-user mode the toolchain is pre-provisioned at shared, simhost-runnable
  // paths (simhost can't reach the orchestrator's private installs). Use those
  // directly rather than PATH detection, which would find the orchestrator's copy.
  if (simUserEnabled()) {
    idbBin = process.env.SIM_IDB_BIN ?? null;
    companionBin = process.env.SIM_COMPANION_BIN ?? null;
    if (idbBin) log(`idb (sim-user) at: ${idbBin}`);
    else warn('SIM_IDB_BIN unset — touch injection disabled in sim-user mode.');
    if (companionBin) log(`idb_companion (sim-user) at: ${companionBin}`);
    return { hasIDB: !!idbBin, idbBin, companionBin };
  }
  // Try shell PATH first — picks up pyenv, conda, etc.
  try {
    const found = execSync('bash -lc "which idb"', { stdio: 'pipe' }).toString().trim();
    if (found) idbBin = found;
  } catch {
    /* ignore */
  }
  if (!idbBin) {
    for (const c of IDB_CANDIDATES) {
      try {
        execSync(`"${c}" --version`, { stdio: 'pipe' });
        idbBin = c;
        break;
      } catch {
        /* ignore */
      }
    }
  }

  for (const c of COMPANION_CANDIDATES) {
    if (existsSync(c)) {
      companionBin = c;
      break;
    }
  }
  if (!companionBin) {
    try {
      companionBin = execSync('which idb_companion', { stdio: 'pipe' }).toString().trim() || null;
    } catch {
      /* ignore */
    }
  }

  if (idbBin) log(`idb at: ${idbBin}`);
  else warn('idb not found; touch injection disabled.');
  if (companionBin) log(`idb_companion at: ${companionBin}`);

  return { hasIDB: !!idbBin, idbBin, companionBin };
}

// ──────────────────────────────────────────────────────────────────────────────
// Companion management — one process per UDID, pre-warmed so first tap is
// instant. Each companion binds a Unix domain socket at the path the idb CLI
// expects by default — so the SAME companion serves both `idb ui` commands
// (touch/keyboard) and our direct gRPC video stream.
// ──────────────────────────────────────────────────────────────────────────────

const companions = new Map<string, ChildProcess>();
const IDB_SOCK_DIR = '/tmp/idb';

// Resolves once the companion for a UDID is serving gRPC on its socket and the
// orchestrator can connect to it (see markSocketReady). Inputs wait on this so
// the first tap after boot doesn't race the companion's startup.
const socketReady = new Map<string, { promise: Promise<boolean>; resolve: (ok: boolean) => void }>();

function readinessFor(udid: string) {
  let entry = socketReady.get(udid);
  if (!entry) {
    let resolve!: (ok: boolean) => void;
    const promise = new Promise<boolean>((r) => {
      resolve = r;
    });
    entry = { promise, resolve };
    socketReady.set(udid, entry);
  }
  return entry;
}

/**
 * The companion runs as the sim user and binds its socket with that user's
 * umask (0755) — but connecting to a Unix socket needs write permission, so the
 * orchestrator (a different user) couldn't reach it. Open it up as the sim user
 * once the companion has (re)created it.
 */
async function markSocketReady(udid: string): Promise<void> {
  const sock = companionSocketPath(udid);
  let ok = true;
  if (simUserEnabled()) {
    const res = await execAsSimUser(`/bin/chmod 666 '${sock}'`, { timeoutMs: 5_000 });
    if (res.code !== 0) {
      warn(`companion socket chmod failed for ${udid.slice(0, 6)}: ${(res.stderr || res.stdout).trim()}`);
      ok = false;
    }
  }
  readinessFor(udid).resolve(ok);
}

/** The Unix domain socket path the companion for `udid` binds to. */
export function companionSocketPath(udid: string): string {
  return `${IDB_SOCK_DIR}/${udid}_companion.sock`;
}

export function startCompanion(udid: string): void {
  if (!companionBin) return;
  if (companions.has(udid)) return;
  try {
    mkdirSync(IDB_SOCK_DIR, { recursive: true });
    // The companion runs as the sim user and binds its socket here, while the
    // orchestrator (a different user) may also need to reach it — make the dir
    // world-writable+sticky (like /tmp) so the socket can be created/used cross-user.
    if (simUserEnabled()) chmodSync(IDB_SOCK_DIR, 0o1777);
  } catch {
    /* already exists */
  }
  const sock = companionSocketPath(udid);
  log(`Starting idb_companion for ${udid} (sock=${sock})...`);
  const spawned = spawnAsSimUser(companionBin, ['--udid', udid, '--grpc-domain-sock', sock]);
  const proc = spawn(spawned.cmd, spawned.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  readinessFor(udid);
  proc.stderr?.on('data', (d: Buffer) => {
    const msg = d.toString().trim();
    if (msg) log(`companion[${udid.slice(0, 6)}]: ${msg.split('\n')[0]}`);
    if (msg.includes('Swift server started')) void markSocketReady(udid);
  });
  proc.on('exit', (code) => {
    log(`idb_companion ${udid.slice(0, 6)} exited: ${code}`);
    if (companions.get(udid) === proc) {
      companions.delete(udid);
      forgetSocket(udid);
    }
  });
  companions.set(udid, proc);
}

/** True once a companion process has been spawned for this UDID. */
export function hasCompanion(udid: string): boolean {
  return companions.has(udid);
}

function forgetSocket(udid: string): void {
  socketReady.get(udid)?.resolve(false);
  socketReady.delete(udid);
  hidFastPathLogged.delete(udid);
  closeHidClient(companionSocketPath(udid));
}

export function stopCompanion(udid: string): void {
  const proc = companions.get(udid);
  if (proc) {
    proc.kill();
    companions.delete(udid);
  }
  forgetSocket(udid);
}

export function stopAllCompanions(): void {
  for (const [udid, proc] of companions) {
    proc.kill();
    companions.delete(udid);
    forgetSocket(udid);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Input injection — fire-and-log; errors are reported but not thrown back
// (a missed tap shouldn't kill a session).
// ──────────────────────────────────────────────────────────────────────────────

async function idbCmd(udid: string, args: string, label: string): Promise<void> {
  if (!idbBin) return;
  const cmd = `"${idbBin}" ${args} --udid ${udid}`;
  const res = await execAsSimUser(cmd, { timeoutMs: 5_000 });
  if (res.code !== 0) {
    warn(`idb ${label} failed: ${(res.stderr || res.stdout).split('\n')[0]}`);
  }
}

// How long an input waits for a just-started companion before giving up on the
// fast path. Boot → companion ready is normally well under this.
const COMPANION_READY_WAIT_MS = 10_000;
const hidFallbackWarned = new Set<string>();
const hidFastPathLogged = new Set<string>();

/**
 * Send events straight to the device's companion over gRPC. Returns false (and
 * the caller uses the idb CLI instead) when there's no companion yet or the
 * call fails, so input keeps working — just slowly — if the fast path breaks.
 */
async function sendViaCompanion(udid: string, events: HidEvent[], label: string): Promise<boolean> {
  const entry = socketReady.get(udid);
  if (!entry || !companions.has(udid)) return false;
  const ready = await Promise.race([
    entry.promise,
    new Promise<boolean>((r) => setTimeout(() => r(false), COMPANION_READY_WAIT_MS).unref()),
  ]);
  if (!ready) return false;
  try {
    const started = Date.now();
    await sendHidEvents(companionSocketPath(udid), events);
    if (!hidFastPathLogged.has(udid)) {
      hidFastPathLogged.add(udid);
      log(`idb ${label} via companion gRPC ok (${Date.now() - started}ms) for ${udid.slice(0, 6)}`);
    }
    return true;
  } catch (e) {
    const key = `${udid}:${label}`;
    if (!hidFallbackWarned.has(key)) {
      hidFallbackWarned.add(key);
      warn(`idb ${label} via companion failed (${(e as Error).message}); falling back to idb CLI`);
    }
    return false;
  }
}

export async function tap(udid: string, x: number, y: number): Promise<void> {
  if (await sendViaCompanion(udid, tapEvents(x, y), 'tap')) return;
  await idbCmd(udid, `ui tap ${x} ${y}`, 'tap');
}

export async function swipe(
  udid: string,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): Promise<void> {
  if (await sendViaCompanion(udid, swipeEvents(startX, startY, endX, endY), 'swipe')) return;
  await idbCmd(udid, `ui swipe ${startX} ${startY} ${endX} ${endY}`, 'swipe');
}

// ──────────────────────────────────────────────────────────────────────────────
// Keyboard
// ──────────────────────────────────────────────────────────────────────────────

// HID usage codes for non-printable keys. Browser KeyboardEvent.key → HID code.
// Reference: USB HID Usage Tables §10 (Keyboard/Keypad Page 0x07).
const HID_KEYS: Record<string, number> = {
  Enter: 40,
  Return: 40,
  Escape: 41,
  Backspace: 42,
  Tab: 43,
  ArrowRight: 79,
  ArrowLeft: 80,
  ArrowDown: 81,
  ArrowUp: 82,
  Home: 74,
  End: 77,
  PageUp: 75,
  PageDown: 78,
  Delete: 76,
};

export function hidCodeForKey(key: string): number | null {
  return HID_KEYS[key] ?? null;
}

/**
 * Type printable text into the focused field. Uses spawn with an args array —
 * the text is untrusted and may contain shell metacharacters, so it must NOT
 * go through a shell string.
 */
export async function sendText(udid: string, text: string): Promise<void> {
  if (text.length === 0) return;
  const events = textEvents(text);
  if (events && (await sendViaCompanion(udid, events, 'text'))) return;
  if (!idbBin) return;
  await new Promise<void>((resolve) => {
    // text is untrusted — keep it a discrete argv element (no shell string).
    const spawned = spawnAsSimUser(idbBin!, ['ui', 'text', text, '--udid', udid]);
    const proc = spawn(spawned.cmd, spawned.args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on('exit', (code) => {
      if (code !== 0) warn(`idb text failed: ${stderr.split('\n')[0]}`);
      resolve();
    });
    proc.on('error', (e) => {
      warn(`idb text error: ${(e as Error).message}`);
      resolve();
    });
  });
}

/** Press a single named non-printable key. No-op for unknown names. */
export async function sendKey(udid: string, key: string): Promise<void> {
  const code = hidCodeForKey(key);
  if (code === null) return;
  if (await sendViaCompanion(udid, keyEvents(code), 'key')) return;
  await idbCmd(udid, `ui key ${code}`, 'key');
}

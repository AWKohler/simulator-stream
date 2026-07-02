import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { execAsync } from './util.js';
import { log, warn } from './log.js';

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

/** The Unix domain socket path the companion for `udid` binds to. */
export function companionSocketPath(udid: string): string {
  return `${IDB_SOCK_DIR}/${udid}_companion.sock`;
}

export function startCompanion(udid: string): void {
  if (!companionBin) return;
  if (companions.has(udid)) return;
  try {
    mkdirSync(IDB_SOCK_DIR, { recursive: true });
  } catch {
    /* already exists */
  }
  const sock = companionSocketPath(udid);
  log(`Starting idb_companion for ${udid} (sock=${sock})...`);
  const proc = spawn(companionBin, ['--udid', udid, '--grpc-domain-sock', sock], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr?.on('data', (d: Buffer) => {
    const msg = d.toString().trim();
    if (msg) log(`companion[${udid.slice(0, 6)}]: ${msg.split('\n')[0]}`);
  });
  proc.on('exit', (code) => {
    log(`idb_companion ${udid.slice(0, 6)} exited: ${code}`);
    companions.delete(udid);
  });
  companions.set(udid, proc);
}

/** True once a companion process has been spawned for this UDID. */
export function hasCompanion(udid: string): boolean {
  return companions.has(udid);
}

export function stopCompanion(udid: string): void {
  const proc = companions.get(udid);
  if (proc) {
    proc.kill();
    companions.delete(udid);
  }
}

export function stopAllCompanions(): void {
  for (const [udid, proc] of companions) {
    proc.kill();
    companions.delete(udid);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Input injection — fire-and-log; errors are reported but not thrown back
// (a missed tap shouldn't kill a session).
// ──────────────────────────────────────────────────────────────────────────────

async function idbCmd(udid: string, args: string, label: string): Promise<void> {
  if (!idbBin) return;
  const cmd = `"${idbBin}" ${args} --udid ${udid}`;
  const res = await execAsync(cmd, { timeoutMs: 5_000 });
  if (res.code !== 0) {
    warn(`idb ${label} failed: ${(res.stderr || res.stdout).split('\n')[0]}`);
  }
}

export async function tap(udid: string, x: number, y: number): Promise<void> {
  await idbCmd(udid, `ui tap ${x} ${y}`, 'tap');
}

export async function swipe(
  udid: string,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): Promise<void> {
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
  if (!idbBin || text.length === 0) return;
  await new Promise<void>((resolve) => {
    const proc = spawn(idbBin!, ['ui', 'text', text, '--udid', udid], {
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
  await idbCmd(udid, `ui key ${code}`, 'key');
}

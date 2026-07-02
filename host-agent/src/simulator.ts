import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execAsync, sleep } from './util.js';
import { log, warn } from './log.js';

// ──────────────────────────────────────────────────────────────────────────────
// simctl JSON types
// ──────────────────────────────────────────────────────────────────────────────
interface SimctlDevice {
  udid: string;
  name: string;
  state: 'Booted' | 'Shutdown' | 'Booting' | 'Shutting Down' | string;
  isAvailable: boolean;
  deviceTypeIdentifier?: string;
}

interface SimctlList {
  devices: Record<string, SimctlDevice[]>;
}

interface SimctlRuntime {
  identifier: string;
  isAvailable: boolean;
  version: string;
  name: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Listing & runtimes
// ──────────────────────────────────────────────────────────────────────────────

function readDevices(): SimctlList {
  return JSON.parse(execSync('xcrun simctl list devices --json').toString()) as SimctlList;
}

export function listSimulators(): SimctlDevice[] {
  const out: SimctlDevice[] = [];
  for (const arr of Object.values(readDevices().devices)) {
    for (const d of arr) out.push(d);
  }
  return out;
}

export function getSimulatorState(udid: string): string {
  for (const d of listSimulators()) if (d.udid === udid) return d.state;
  return 'Unknown';
}

export function findByName(name: string): SimctlDevice | null {
  return listSimulators().find((d) => d.name === name && d.isAvailable) ?? null;
}

function listIOSRuntimes(): SimctlRuntime[] {
  const json = JSON.parse(execSync('xcrun simctl list runtimes --json').toString()) as {
    runtimes: SimctlRuntime[];
  };
  return json.runtimes.filter((r) => r.isAvailable && r.identifier.includes('iOS'));
}

// ──────────────────────────────────────────────────────────────────────────────
// PoC pool: "PoC-N" iPhone 16 Pro devices for N=0..(slots-1).
// Sessions claim from this pool; on release they shut down (kept allocated).
// ──────────────────────────────────────────────────────────────────────────────

const POOL_PREFIX = 'PoC-Sim-';
const DEVICE_TYPE = 'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro';

export async function ensurePool(slots: number): Promise<string[]> {
  const existing = listSimulators().filter((d) => d.name.startsWith(POOL_PREFIX));
  const byName = new Map(existing.map((d) => [d.name, d]));

  // Find a usable iOS runtime once.
  let runtimeId: string | null = null;
  const runtimes = listIOSRuntimes();
  if (runtimes.length === 0) {
    throw new Error('No iOS simulator runtime is installed. Open Xcode and install one.');
  }
  // Prefer the highest-version runtime.
  runtimes.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  runtimeId = runtimes[0].identifier;

  const udids: string[] = [];
  for (let i = 0; i < slots; i++) {
    const name = `${POOL_PREFIX}${i}`;
    const present = byName.get(name);
    if (present) {
      udids.push(present.udid);
      continue;
    }
    log(`Creating pool device ${name} (runtime ${runtimeId})...`);
    const res = await execAsync(
      `xcrun simctl create "${name}" "${DEVICE_TYPE}" "${runtimeId}"`,
    );
    if (res.code !== 0) {
      throw new Error(`simctl create failed: ${res.stderr || res.stdout}`);
    }
    udids.push(res.stdout.trim());
  }
  return udids;
}

// ──────────────────────────────────────────────────────────────────────────────
// Boot / shutdown
// ──────────────────────────────────────────────────────────────────────────────

export async function bootSimulator(udid: string, timeoutMs = 90_000): Promise<boolean> {
  const current = getSimulatorState(udid);
  if (current === 'Booted') return true;

  log(`Booting ${udid}...`);
  // Don't await — `simctl boot` blocks until boot completes which can be slow;
  // we poll state instead so we can surface progress.
  void execAsync(`xcrun simctl boot ${udid}`).catch(() => undefined);

  // Make sure Simulator.app is open so the window appears.
  await execAsync('open -a Simulator');

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (getSimulatorState(udid) === 'Booted') return true;
    await sleep(1500);
  }
  warn(`Boot timed out for ${udid}`);
  return false;
}

export async function shutdownSimulator(udid: string): Promise<void> {
  const state = getSimulatorState(udid);
  if (state === 'Shutdown' || state === 'Unknown') return;
  await execAsync(`xcrun simctl shutdown ${udid}`, { timeoutMs: 30_000 });
}

// ──────────────────────────────────────────────────────────────────────────────
// Device screen size probe via screenshot
// ──────────────────────────────────────────────────────────────────────────────

export async function probeDeviceLogicalSize(
  udid: string,
): Promise<{ w: number; h: number } | null> {
  const tmp = path.join(tmpdir(), `expo_probe_${udid}.jpg`);
  const screenshot = await execAsync(`xcrun simctl io ${udid} screenshot --type=jpeg "${tmp}"`);
  if (screenshot.code !== 0) return null;
  const sips = await execAsync(`sips -g pixelWidth -g pixelHeight "${tmp}"`);
  if (sips.code !== 0) return null;
  const w = parseInt(sips.stdout.match(/pixelWidth: (\d+)/)?.[1] ?? '0');
  const h = parseInt(sips.stdout.match(/pixelHeight: (\d+)/)?.[1] ?? '0');
  if (!w || !h) return null;
  // iPhone 16 Pro: 1179×2556 physical → 393×852 logical (@3x)
  const scale = Math.round(w / 393);
  return { w: Math.round(w / scale), h: Math.round(h / scale) };
}

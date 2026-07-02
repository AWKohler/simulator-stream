import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DeviceModel, Orientation } from '@sim/shared';
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

// ──────────────────────────────────────────────────────────────────────────────
// Device model → simctl device type / scale / orientation
//
// A pool slot is created as an iPhone by default; when a session requests a
// different model the slot is retyped (delete + recreate as the new type — see
// index.ts claim path). iPad device-type identifiers vary by installed Xcode,
// so we resolve the best available iPad Pro dynamically rather than hardcoding.
// ──────────────────────────────────────────────────────────────────────────────

interface SimctlDeviceType {
  identifier: string;
  name: string;
  productFamily?: string;
}

function listDeviceTypes(): SimctlDeviceType[] {
  try {
    const json = JSON.parse(execSync('xcrun simctl list devicetypes --json').toString()) as {
      devicetypes: SimctlDeviceType[];
    };
    return json.devicetypes ?? [];
  } catch {
    return [];
  }
}

/** Resolve a logical DeviceModel to a concrete simctl device-type identifier. */
export function resolveDeviceType(model: DeviceModel): string {
  if (model !== 'iPad-Pro') return DEVICE_TYPE;
  const ipadPros = listDeviceTypes().filter((t) => /iPad-Pro/i.test(t.identifier));
  // Prefer the largest, newest iPad Pro: 13-inch > 12.9 > 11; higher M-gen wins.
  const rank = (id: string): number => {
    let s = 0;
    if (/13-inch/i.test(id)) s += 1000;
    else if (/12[-.]?9/i.test(id)) s += 800;
    else if (/11-inch/i.test(id)) s += 600;
    const m = id.match(/M(\d)/i);
    if (m) s += parseInt(m[1], 10) * 10;
    return s;
  };
  ipadPros.sort((a, b) => rank(b.identifier) - rank(a.identifier));
  return (
    ipadPros[0]?.identifier ??
    'com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M4-8GB'
  );
}

/** Screen scale (points→pixels) per model: iPhone 16 Pro @3x, iPad Pro @2x. */
export function deviceScaleFor(model: DeviceModel): number {
  return model === 'iPad-Pro' ? 2 : 3;
}

/** Default orientation per model when the request doesn't specify one. Both
 * boot in portrait; landscape is reached only by an explicit rotate so a
 * session never blocks on rotation just to come up. */
export function naturalOrientation(_model: DeviceModel): Orientation {
  return 'portrait';
}

/** simctl device-type identifier currently backing a UDID (for retype checks). */
export function getDeviceTypeIdentifier(udid: string): string | null {
  const d = listSimulators().find((x) => x.udid === udid);
  return d?.deviceTypeIdentifier ?? null;
}

/** Device name (e.g. "PoC-Sim-0") — used to target the right Simulator window. */
export function getDeviceName(udid: string): string | null {
  const d = listSimulators().find((x) => x.udid === udid);
  return d?.name ?? null;
}

/** True if the UDID's current device type matches what `model` resolves to. */
export function deviceTypeMatchesModel(udid: string, model: DeviceModel): boolean {
  const current = getDeviceTypeIdentifier(udid);
  return current != null && current === resolveDeviceType(model);
}

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

/**
 * Shut a simulator down and *verify* it actually reached `Shutdown`.
 * `simctl shutdown` can return before the device is fully down (or fail
 * transiently); without the poll+retry a "successful" shutdown can leave a
 * sim running, which the operator then sees lingering over VNC.
 */
export async function shutdownSimulator(udid: string): Promise<boolean> {
  const state = getSimulatorState(udid);
  if (state === 'Shutdown' || state === 'Unknown') return true;

  for (let attempt = 1; attempt <= 2; attempt++) {
    await execAsync(`xcrun simctl shutdown ${udid}`, { timeoutMs: 30_000 });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (getSimulatorState(udid) === 'Shutdown') return true;
      await sleep(750);
    }
    warn(`simctl shutdown ${udid.slice(0, 8)} not Shutdown after attempt ${attempt}`);
  }
  warn(`Giving up shutting down ${udid.slice(0, 8)} — still ${getSimulatorState(udid)}`);
  return false;
}

/**
 * Wipe a pool device back to factory state (removes installed apps, keychain,
 * settings). Prevents the previous session's app from lingering when the UDID
 * is reused — the source of "I see other users' apps on my home screen".
 *
 * Returns true iff the device was confirmed Shutdown AND erase exit code was 0.
 * Callers MUST treat `false` as "this UDID is dirty" — see `recreatePoolDevice`
 * which is the safe response (poisons the UDID, replaces it with a fresh one).
 *
 * The retry path: if the first erase fails, we issue `simctl shutdown all`
 * (a sledgehammer reset) and retry once. Some CoreSimulator hiccups (services
 * stuck mid-launch) only clear with a global shutdown.
 */
export async function eraseSimulator(udid: string): Promise<boolean> {
  const ok = await shutdownSimulator(udid);
  if (!ok) {
    warn(`erase ${udid.slice(0, 8)} aborted — could not shut down`);
    return false;
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await execAsync(`xcrun simctl erase ${udid}`, { timeoutMs: 30_000 });
    if (res.code === 0) {
      log(`erase ${udid.slice(0, 8)} ok (attempt ${attempt})`);
      return true;
    }
    warn(
      `erase ${udid.slice(0, 8)} failed attempt ${attempt}: ` +
        (res.stderr || res.stdout).split('\n')[0],
    );
    if (attempt === 1) {
      // Sledgehammer: shut down EVERY booted sim. CoreSimulator services
      // sometimes wedge on one device and refuse erase on others until
      // they're all idle. Best-effort; ignore exit code.
      await execAsync('xcrun simctl shutdown all', { timeoutMs: 30_000 });
      await sleep(500);
    }
  }
  warn(`erase ${udid.slice(0, 8)} gave up after retries — UDID is dirty`);
  return false;
}

/**
 * Find the pool device with the given UDID, delete it, then create a fresh
 * replacement with the SAME pool name. Returns the new UDID on success, or
 * null if anything went wrong (caller should drop the slot rather than serve
 * a session on an unverified device).
 *
 * Used when `eraseSimulator` returns false — the device is poisoned, and we
 * trade the cost of recreating (~2s) for guaranteed tenant isolation.
 */
export async function recreatePoolDevice(
  udid: string,
  deviceType?: string,
): Promise<string | null> {
  const existing = listSimulators().find((d) => d.udid === udid);
  if (!existing || !existing.name.startsWith(POOL_PREFIX)) {
    warn(`recreatePoolDevice: ${udid.slice(0, 8)} is not a pool device — refusing`);
    return null;
  }
  const name = existing.name;
  // Poison-recreate preserves the slot's current type; retype passes an explicit
  // deviceType to switch the slot (e.g. iPhone → iPad) for the next tenant.
  const targetType = deviceType ?? existing.deviceTypeIdentifier ?? DEVICE_TYPE;
  log(`Recreating pool device ${name} (${udid.slice(0, 8)}) as ${targetType.split('.').pop()}...`);
  // Best-effort shutdown — `simctl delete` of a Booted device may hang.
  await shutdownSimulator(udid);
  const delRes = await execAsync(`xcrun simctl delete ${udid}`, { timeoutMs: 30_000 });
  if (delRes.code !== 0) {
    warn(`delete ${udid.slice(0, 8)} failed: ${(delRes.stderr || delRes.stdout).split('\n')[0]}`);
    return null;
  }
  const runtimes = listIOSRuntimes();
  if (runtimes.length === 0) return null;
  runtimes.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  const createRes = await execAsync(
    `xcrun simctl create "${name}" "${targetType}" "${runtimes[0].identifier}"`,
  );
  if (createRes.code !== 0) {
    warn(`recreate ${name} failed: ${(createRes.stderr || createRes.stdout).split('\n')[0]}`);
    return null;
  }
  const newUdid = createRes.stdout.trim();
  log(`Recreated ${name} → ${newUdid.slice(0, 8)}`);
  return newUdid;
}

/**
 * Shut down AND erase every pool device on host-agent startup. The previous
 * behavior only shut them down, which left apps from before a crash visible
 * to the next tenant assigned to that UDID. Erase wipes installed apps +
 * keychain + filesystem so every cold start of the agent yields a clean pool.
 *
 * Devices that fail erase are recreated (we'd rather pay the ~2s cost than
 * leak data). Returns the (possibly remapped) list of pool UDIDs in the same
 * pool-name order so the caller can swap them into its own pool array.
 */
export async function shutdownAndErasePoolDevices(): Promise<Map<string, string>> {
  // Map of old UDID → new UDID (may equal old if no recreation was needed).
  const remap = new Map<string, string>();
  const pool = listSimulators().filter((d) => d.name.startsWith(POOL_PREFIX));
  for (const d of pool) {
    if (d.state === 'Booted' || d.state === 'Booting') {
      log(`Reaping orphaned ${d.name} (${d.state}) from a prior run`);
    }
    const erased = await eraseSimulator(d.udid);
    if (erased) {
      remap.set(d.udid, d.udid);
    } else {
      const newUdid = await recreatePoolDevice(d.udid);
      remap.set(d.udid, newUdid ?? d.udid);
    }
  }
  return remap;
}

// ──────────────────────────────────────────────────────────────────────────────
// Device screen size probe via screenshot
// ──────────────────────────────────────────────────────────────────────────────

export async function probeDeviceLogicalSize(
  udid: string,
  scaleHint?: number,
): Promise<{ w: number; h: number } | null> {
  const tmp = path.join(tmpdir(), `expo_probe_${udid}.jpg`);
  const screenshot = await execAsync(`xcrun simctl io ${udid} screenshot --type=jpeg "${tmp}"`);
  if (screenshot.code !== 0) return null;
  const sips = await execAsync(`sips -g pixelWidth -g pixelHeight "${tmp}"`);
  if (sips.code !== 0) return null;
  const w = parseInt(sips.stdout.match(/pixelWidth: (\d+)/)?.[1] ?? '0');
  const h = parseInt(sips.stdout.match(/pixelHeight: (\d+)/)?.[1] ?? '0');
  if (!w || !h) return null;
  // scaleHint = device @Nx (iPhone 16 Pro @3x, iPad Pro @2x). Without a hint,
  // fall back to the iPhone 16 Pro assumption (1179×2556 → 393×852 @3x).
  const scale = scaleHint ?? Math.max(1, Math.round(w / 393));
  return { w: Math.round(w / scale), h: Math.round(h / scale) };
}

// ──────────────────────────────────────────────────────────────────────────────
// Orientation — detection + rotation
//
// Rotation is TCC-free and deterministic: we post a Darwin notification into the
// guest (via `simctl spawn notifypost`), which the running Botflow template app
// turns into a requestGeometryUpdate(...) call (see rotateSimulator below). No
// Accessibility, no GUI scripting. getOrientation() reads the simctl screenshot
// aspect for a coarse check, but the authoritative orientation downstream is the
// live framebuffer IOSurface size (the capturer is restarted on change).
// ──────────────────────────────────────────────────────────────────────────────

export async function getOrientation(udid: string): Promise<Orientation | null> {
  const tmp = path.join(tmpdir(), `expo_orient_${udid}.jpg`);
  const shot = await execAsync(`xcrun simctl io ${udid} screenshot --type=jpeg "${tmp}"`);
  if (shot.code !== 0) return null;
  const sips = await execAsync(`sips -g pixelWidth -g pixelHeight "${tmp}"`);
  if (sips.code !== 0) return null;
  const w = parseInt(sips.stdout.match(/pixelWidth: (\d+)/)?.[1] ?? '0');
  const h = parseInt(sips.stdout.match(/pixelHeight: (\d+)/)?.[1] ?? '0');
  if (!w || !h) return null;
  return w > h ? 'landscape' : 'portrait';
}

export async function rotateSimulator(
  udid: string,
  target: Orientation,
): Promise<Orientation> {
  // Rotate the DEVICE (not just the app interface). Forcing the app's interface
  // orientation (requestGeometryUpdate) only spins the app's view inside a
  // still-portrait device surface — the framebuffer stays portrait and content
  // renders sideways. The Simulator's "Device ▸ Orientation" menu rotates the
  // actual device: the IOSurface is reallocated at the new dims and the app
  // relayouts upright (it must allow the orientation — guaranteed by the
  // build.ts plist overrides). We drive that menu via osascript, which runs
  // under the host-agent's `node` (granted Accessibility once on the host — a
  // stable binary, so the grant sticks; no per-app prompts).
  const name = (getDeviceName(udid) ?? '').replace(/["\\]/g, '');
  const orientItem = target === 'landscape' ? 'Landscape Right' : 'Portrait';
  const osa = [
    'tell application "Simulator" to activate',
    'delay 0.2',
    'tell application "System Events" to tell process "Simulator"',
    '  set frontmost to true',
    '  try',
    `    perform action "AXRaise" of (first window whose name contains "${name}")`,
    '  end try',
    '  delay 0.15',
    '  set dmenu to menu 1 of menu bar item "Device" of menu bar 1',
    // "Rotate Device Automatically" being ON makes the sim (no accelerometer)
    // ignore an explicit orientation and snap back — turn it off first.
    '  try',
    '    if (value of attribute "AXMenuItemMarkChar" of (menu item "Rotate Device Automatically" of dmenu)) is not "" then',
    '      click menu item "Rotate Device Automatically" of dmenu',
    '      delay 0.2',
    '    end if',
    '  end try',
    `  click menu item "${orientItem}" of menu 1 of menu item "Orientation" of dmenu`,
    'end tell',
  ].join('\n');
  const cmd = `osascript -e '${osa.replace(/'/g, "'\\''")}'`;
  for (let attempt = 0; attempt < 2; attempt++) {
    if ((await getOrientation(udid)) === target) return target;
    const res = await execAsync(cmd, { timeoutMs: 8_000 });
    if (res.code !== 0) {
      warn(`rotateSimulator: osascript exit ${res.code}: ${(res.stderr || res.stdout).split('\n')[0]}`);
      break;
    }
    // The device rotation (surface realloc + relayout) settles in ~1s; poll the
    // screenshot aspect, which DOES flip for a real device rotation.
    for (let p = 0; p < 6; p++) {
      await sleep(800);
      if ((await getOrientation(udid)) === target) return target;
    }
  }
  return (await getOrientation(udid)) ?? target;
}

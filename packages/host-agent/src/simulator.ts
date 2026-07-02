import { execSync } from 'node:child_process';
import path from 'node:path';
import type { DeviceModel, Orientation } from '@sim/shared';
import { execAsync, execAsSimUser, wrapAsSimUser, simUserEnabled, sleep } from './util.js';
import { postOrientation } from './notifypost.js';
import { log, warn } from './log.js';

// All CoreSimulator commands target the SIM USER's device set (see util.ts).
// In dev/VM (SIM_RUN_USER unset) wrapAsSimUser is a no-op, so these are plain.
// Cross-user files (screenshots simhost writes + the orchestrator reads) go to
// /tmp, which both users can access.
const SHARED_TMP = '/tmp';

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
  return JSON.parse(
    execSync(wrapAsSimUser('xcrun simctl list devices --json')).toString(),
  ) as SimctlList;
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
  const json = JSON.parse(
    execSync(wrapAsSimUser('xcrun simctl list runtimes --json')).toString(),
  ) as {
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
    const json = JSON.parse(
      execSync(wrapAsSimUser('xcrun simctl list devicetypes --json')).toString(),
    ) as {
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
    const res = await execAsSimUser(
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
  void execAsSimUser(`xcrun simctl boot ${udid}`).catch(() => undefined);

  // Open Simulator.app (window capture) only in legacy/dev single-user mode.
  // In sim-user mode we run headless: the framebuffer capturer attaches to the
  // device's IOSurface by UDID, so no on-screen window is needed (and we can't
  // render one in a background user's session anyway).
  if (!simUserEnabled()) await execAsync('open -a Simulator');

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
    await execAsSimUser(`xcrun simctl shutdown ${udid}`, { timeoutMs: 30_000 });
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
    const res = await execAsSimUser(`xcrun simctl erase ${udid}`, { timeoutMs: 30_000 });
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
      await execAsSimUser('xcrun simctl shutdown all', { timeoutMs: 30_000 });
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
  const delRes = await execAsSimUser(`xcrun simctl delete ${udid}`, { timeoutMs: 30_000 });
  if (delRes.code !== 0) {
    warn(`delete ${udid.slice(0, 8)} failed: ${(delRes.stderr || delRes.stdout).split('\n')[0]}`);
    return null;
  }
  const runtimes = listIOSRuntimes();
  if (runtimes.length === 0) return null;
  runtimes.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  const createRes = await execAsSimUser(
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
  // /tmp (not the orchestrator's private tmpdir): simhost writes the screenshot,
  // the orchestrator reads it for sips — they're different users.
  const tmp = path.join(SHARED_TMP, `expo_probe_${udid}.jpg`);
  const screenshot = await execAsSimUser(
    `xcrun simctl io ${udid} screenshot --type=jpeg "${tmp}"`,
  );
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
// On the iOS 26 simulator the captured IOSurface is ALWAYS portrait-native: even
// when the app is in landscape it renders its landscape layout sideways into the
// portrait surface. No host-side method changes that, so the BROWSER rotates the
// video 90° for landscape (see the frontend's device-frame). rotateSimulator's
// job is only to make the app actually relayout to the target orientation; the
// browser handles how it's displayed.
// ──────────────────────────────────────────────────────────────────────────────

export async function getOrientation(udid: string): Promise<Orientation | null> {
  const tmp = path.join(SHARED_TMP, `expo_orient_${udid}.jpg`);
  const shot = await execAsSimUser(`xcrun simctl io ${udid} screenshot --type=jpeg "${tmp}"`);
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
  // Headless rotation (sim-user mode): we don't drive Simulator.app's menus.
  // Instead post a Darwin notification that the injected BotflowPreviewOrientation
  // shim turns into a requestGeometryUpdate — the app relayouts to `target`. On
  // iOS 26 the captured IOSurface stays portrait-native regardless, so the
  // browser rotates the video 90° for display (same as the osascript path did).
  // Requires the orientation shim to be DYLD-injected at app launch.
  if (simUserEnabled()) {
    const ok = await postOrientation(udid, target);
    if (!ok) warn('rotateSimulator: notifypost failed (orientation shim injected at launch?)');
    return target;
  }
  // Make the app relayout to `target`. We drive the Simulator's "Device ▸
  // Orientation" menu via osascript (running under the host-agent's `node`, which
  // has a one-time Accessibility grant on the host — a stable binary, so the
  // grant sticks; no per-app prompts). The app must allow the orientation —
  // guaranteed by the build.ts plist overrides. NOTE: on iOS 26 this does NOT
  // change the captured framebuffer's dimensions (it stays portrait, content
  // sideways); the browser rotates the video 90° for display. So we don't rely
  // on a dimension change here — we just trigger the relayout.
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

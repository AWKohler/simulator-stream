// ── Lean mode — smaller simulator memory footprint ──────────────────────────
//
// Disables background iOS services a previewed app rarely needs (Siri, Health,
// photo analysis, iCloud sync, Maps sync, telemetry...) so each booted
// simulator holds less RAM. Needed on small hosts (16GB MacBook Air) where every
// simulator competes with the build VMs for memory.
//
// Mechanism (from tapflow's Lean mode, https://github.com/jo-duchan/tapflow,
// MIT): `launchd_sim` is a HOST process that reads its disable overrides from
// /private/var/tmp/com.apple.CoreSimulator.SimDevice.<udid>/disabled.plist when
// it starts. Writing that file while the device is shut down disables the
// labels for the next boot; no command has to run inside the device. Measured by
// tapflow (macOS 26.5/27, iOS runtime >= 18.5):
//   - the file survives `simctl erase` and `simctl delete`;
//   - a file written before a device's first boot is honoured, and the runtime
//     merges its own entries beside ours instead of replacing the file;
//   - about -25% memory per device with this list.
//
// Pool devices are lean for their whole life (we never revert), so unlike
// tapflow we keep no "prior values" marker. Entries already in the file are
// preserved; ours are only ever set to true.
//
// The file lives in a directory launchd_sim (running as the sim user) owns, so
// in sim-user mode it is read and written AS the sim user.

import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { execAsync, execAsSimUser, simUserEnabled } from './util.js';
import { log, warn } from './log.js';

/** On unless SIM_LEAN=0. */
export function leanEnabled(): boolean {
  return (process.env.SIM_LEAN ?? '1') !== '0';
}

/*
 * The launchd labels below are tapflow's selection (packages/ios-agent/src/
 * leanLabels.ts) from simslim (https://github.com/MobAI-App/simslim, commit
 * e752a728), both MIT:
 *
 *   Copyright (c) 2026 Interlap
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy
 *   of this software and associated documentation files (the "Software"), to deal
 *   in the Software without restriction, including without limitation the rights
 *   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *   copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included in all
 *   copies or substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *   SOFTWARE.
 *
 * Kept ON on purpose (an app under preview may depend on them): wallpaper and
 * widgets / Live Activities, dictation and keyboard suggestions, Sign in with
 * Apple, CloudKit, StoreKit, push, Wallet/Apple Pay, HealthKit, the photo
 * picker, DeviceCheck/App Attest, MapKit, Game Center, contacts/calendars,
 * universal links (swcd).
 */
export const LEAN_LABELS: readonly string[] = [
  'com.apple.Maps.geocorrectiond',
  'com.apple.Maps.mapspushd',
  'com.apple.Maps.mapssyncd',
  'com.apple.Safari.passwordbreachd',
  'com.apple.SafariBookmarksSyncAgent',
  'com.apple.ScreenTimeAgent',
  'com.apple.ScreenTimeSettingsAgent',
  'com.apple.SecureBackupDaemon',
  'com.apple.TrustedPeersHelper',
  'com.apple.WebBookmarks.webbookmarksd',
  'com.apple.activityawardsd',
  'com.apple.activitysharingd',
  'com.apple.announced',
  'com.apple.ap.adprivacyd',
  'com.apple.ap.promotedcontentd',
  'com.apple.appleaccounttransparencyd',
  'com.apple.appleidsetupd',
  'com.apple.appstorecomponentsd',
  'com.apple.askpermissiond',
  'com.apple.asktod',
  'com.apple.assetsubscriptiond',
  'com.apple.assistant_cdmd',
  'com.apple.assistant_service',
  'com.apple.assistantd',
  'com.apple.avatarsd',
  'com.apple.businessservicesd',
  'com.apple.carkitd',
  'com.apple.cdpd',
  'com.apple.cloudphotod',
  'com.apple.cloudsettingssyncagent',
  'com.apple.communicationtrustd',
  'com.apple.companiond',
  'com.apple.coreidvd',
  'com.apple.diagnosticextensionsd',
  'com.apple.facetimemessagestored',
  'com.apple.familycircled',
  'com.apple.familynotification',
  'com.apple.feedbackd',
  'com.apple.financed',
  'com.apple.findmy.findmylocated',
  'com.apple.finhealthd',
  'com.apple.fitcore',
  'com.apple.fitcore.session',
  'com.apple.fitnesscoachingd',
  'com.apple.fitnessintelligenced',
  'com.apple.followupd',
  'com.apple.geoanalyticsd',
  'com.apple.healthappd',
  'com.apple.healthcontentd',
  'com.apple.healtheventsd',
  'com.apple.healthrecordsd',
  'com.apple.homed',
  'com.apple.homeeventsd',
  'com.apple.icloudmailagent',
  'com.apple.icloudsubscriptionoptimizerd',
  'com.apple.identityservicesd',
  'com.apple.ids_simd',
  'com.apple.imautomatichistorydeletionagent',
  'com.apple.imcore.imtransferagent',
  'com.apple.imdpersistence.IMDPersistenceAgent',
  'com.apple.intelligencecontextd',
  'com.apple.intelligenceflowd',
  'com.apple.intelligenceplatformd',
  'com.apple.intelligencetasksd',
  'com.apple.itunescloudd',
  'com.apple.knowledgeconstructiond',
  'com.apple.managedconfiguration.passcodenagd',
  'com.apple.maps.destinationd',
  'com.apple.mediaanalysisd',
  'com.apple.mediaanalysisd.service',
  'com.apple.mediastream.mstreamd',
  'com.apple.musicd',
  'com.apple.navd',
  'com.apple.newsd',
  'com.apple.parsec-fbf',
  'com.apple.parsecd',
  'com.apple.photoanalysisd',
  'com.apple.photosface',
  'com.apple.proactiveeventtrackerd',
  'com.apple.protectedcloudstorage.protectedcloudkeysyncing',
  'com.apple.purplebuddy.budd',
  'com.apple.rapportd',
  'com.apple.rtcreportingd',
  'com.apple.safarifetcherd',
  'com.apple.securityuploadd',
  'com.apple.siri.acousticsignature',
  'com.apple.siriactionsd',
  'com.apple.siriinferenced',
  'com.apple.siriknowledged',
  'com.apple.sociallayerd',
  'com.apple.sosd',
  'com.apple.speechmodeltrainingd',
  'com.apple.stickersd',
  'com.apple.tipsd',
  'com.apple.triald',
  'com.apple.tvremoted',
  'com.apple.videosubscriptionsd',
  'com.apple.voicebankingd',
  'com.apple.wcd',
];

const STORE_ROOT = '/private/var/tmp';
const UDID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

const XML_ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
};

/** Parse the override store: an XML plist holding one dict of label -> bool.
 * Anything else throws rather than being rewritten (we would drop entries). */
export function parseDisabledStore(xml: string): Record<string, boolean> {
  const body = xml.match(/<plist[^>]*>\s*(<dict\s*\/>|<dict>([\s\S]*)<\/dict>)\s*<\/plist>/);
  if (!body) throw new Error('disabled.plist is not a plist holding one dict');
  const entries: Record<string, boolean> = {};
  const inner = body[2] ?? '';
  const pair = /\s*<key>([^<]*)<\/key>\s*<(true|false)\/>/y;
  let at = 0;
  for (let m = pair.exec(inner); m; m = pair.exec(inner)) {
    entries[m[1].replace(/&(amp|lt|gt|quot|apos);/g, (e) => XML_ENTITIES[e])] = m[2] === 'true';
    at = pair.lastIndex;
  }
  if (inner.slice(at).trim() !== '') throw new Error('disabled.plist holds something other than label -> bool');
  return entries;
}

export function renderDisabledStore(entries: Record<string, boolean>): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const rows = Object.entries(entries)
    .map(([label, off]) => `\t<key>${esc(label)}</key>\n\t<${off}/>\n`)
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n' +
    (rows ? `<dict>\n${rows}</dict>\n` : '<dict/>\n') +
    '</plist>\n'
  );
}

/**
 * Write the lean overrides for a SHUT-DOWN device so its next boot starts
 * without the listed services. Best-effort: a failure is logged and the device
 * simply boots with the stock service set.
 */
export async function applyLean(udid: string): Promise<void> {
  if (!leanEnabled()) return;
  if (!UDID_RE.test(udid)) {
    warn(`lean: refusing non-UDID ${udid}`);
    return;
  }
  const dir = path.join(STORE_ROOT, `com.apple.CoreSimulator.SimDevice.${udid}`);
  const store = path.join(dir, 'disabled.plist');
  const run = simUserEnabled() ? execAsSimUser : execAsync;
  try {
    const mk = await run(`/bin/mkdir -p ${dir}`);
    if (mk.code !== 0) throw new Error(`mkdir: ${mk.stderr || mk.stdout}`);
    const cur = await run(`/bin/cat ${store}`);
    // A missing file is normal before the first boot; any other read failure
    // could mean we cannot see entries we would then overwrite, so stop.
    let entries: Record<string, boolean> = {};
    if (cur.code === 0) entries = parseDisabledStore(cur.stdout);
    else if (!/No such file/i.test(cur.stderr)) throw new Error(`read: ${cur.stderr || cur.stdout}`);
    let added = 0;
    for (const label of LEAN_LABELS) {
      if (entries[label] !== true) added++;
      entries[label] = true;
    }
    if (added === 0) return;
    // Stage in a private dir, readable by the sim user, then copy into place
    // as that user (it owns `dir`). Done while the device is shut down, so
    // launchd_sim is not reading the file.
    // /tmp, not os.tmpdir(): the orchestrator's /var/folders tmpdir is not
    // traversable by the sim user.
    const stageDir = mkdtempSync(path.join('/tmp', 'lean-'));
    chmodSync(stageDir, 0o755);
    const staged = path.join(stageDir, 'disabled.plist');
    try {
      writeFileSync(staged, renderDisabledStore(entries), { mode: 0o644 });
      const cp = await run(`/bin/cp ${staged} ${store}.new`);
      if (cp.code !== 0) throw new Error(`stage: ${cp.stderr || cp.stdout}`);
      const mv = await run(`/bin/mv -f ${store}.new ${store}`);
      if (mv.code !== 0) throw new Error(`install: ${mv.stderr || mv.stdout}`);
    } finally {
      rmSync(stageDir, { recursive: true, force: true });
    }
    log(`lean: ${udid.slice(0, 8)} — disabled ${added} background service(s) for next boot`);
  } catch (e) {
    warn(`lean: could not apply to ${udid.slice(0, 8)}: ${(e as Error).message}`);
  }
}

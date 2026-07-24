// Device-free App Store distribution signing for headless build hosts.
//
// Automatic signing (`-allowProvisioningUpdates`) FAILS on a build server with
// no registered devices: Apple refuses to mint a profile ("Your team has no
// devices from which to generate a provisioning profile"). The App Store
// distribution flow does not actually need a device — but the automatic path
// insists on one. So we drive App Store Connect's REST API by hand to:
//
//   1. ensure the bundle id exists,
//   2. mint a DISTRIBUTION certificate once (CSR → cert), import its private
//      key into the dedicated signing keychain, and reuse it thereafter,
//   3. create/reuse an IOS_APP_STORE provisioning profile (no devices) and
//      install it under ~/Library/MobileDevice/Provisioning Profiles.
//
// xcodebuild then archives + exports with MANUAL signing pointed at those
// assets. This is the exact recipe validated by hand on the build Mac
// (macOS 26 / Xcode 26.5) over SSH.
//
// JWT minting is reused from asc-upload.ts — do NOT duplicate it here.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { LogStream } from '@sim/shared';
import { execAsync } from './util.js';
import { log } from './log.js';
import { mintAscToken, normalizeP8, type AscAuth } from './asc-upload.js';

const ASC_BASE = 'https://api.appstoreconnect.apple.com';

/** Single-quote a string for safe use in a shell command. */
const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

interface AscResource {
  id: string;
  type: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: { id: string } | Array<{ id: string }> }>;
}

interface AscResponse {
  data?: AscResource | AscResource[];
  [k: string]: unknown;
}

/**
 * Call the App Store Connect REST API with a freshly-minted ES256 JWT (Apple
 * tokens are short-lived; mint one per call rather than caching). Throws on any
 * non-2xx, surfacing Apple's error JSON verbatim — those messages name the
 * exact attribute/relationship at fault, which is the fastest path to a fix.
 */
async function ascApi(
  auth: AscAuth,
  method: string,
  apiPath: string,
  body?: unknown,
): Promise<AscResponse> {
  const res = await fetch(`${ASC_BASE}${apiPath}`, {
    method,
    headers: {
      authorization: `Bearer ${mintAscToken(auth)}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`ASC ${method} ${apiPath} → ${res.status}: ${text.slice(0, 2000)}`);
  }
  if (!text) return {};
  return JSON.parse(text) as AscResponse;
}

export interface EnsureSigningAssetsOptions {
  auth: AscAuth;
  teamId: string;
  bundleId: string;
  /** Human name for a freshly-registered bundle id (falls back to bundleId). */
  appName?: string;
  /** Signing keychain (name or path), already created on the host. */
  keychain: string;
  /** Password for `keychain`. */
  keychainPassword: string;
  /** Scratch dir for CSR/key/cert material (cleaned by the caller). */
  workdir: string;
  onLog: (line: string, stream: LogStream) => void;
}

export interface SigningAssets {
  /** Value for CODE_SIGN_IDENTITY — the TEAM-SPECIFIC distribution identity
   *  (its common name carries the teamId), never the generic "Apple
   *  Distribution", so codesign can't pick a different team's cert when
   *  several share the signing keychain. */
  signingIdentity: string;
  /** Value for PROVISIONING_PROFILE_SPECIFIER (the profile's name). */
  profileName: string;
}

/**
 * SHA-1 fingerprints of every VALID "Apple Distribution" identity for a SPECIFIC
 * team in the signing keychain. The 10-char teamId appears in the cert common
 * name (e.g. `Apple Distribution: Acme Inc (ABCDE12345)`), so scoping by it
 * keeps one team's cert from signing another team's app when several accumulate
 * in the shared keychain. `find-identity -v` lists only unexpired, private-key-
 * present identities — exactly the ones we can actually sign with.
 */
async function keychainTeamDistributionSha1s(
  keychain: string,
  teamId: string,
): Promise<Set<string>> {
  const res = await execAsync(
    `security find-identity -v -p codesigning ${q(keychain)}`,
    { timeoutMs: 10_000 },
  );
  // execAsync resolves with a nonzero `code` instead of throwing. A failed
  // lookup (keychain locked/unavailable/timeout) must NOT be read as "no
  // identities" — that would trigger a needless mint and hide the real fault.
  if (res.code !== 0) {
    throw new Error(
      `security find-identity failed (exit ${res.code}) on ${keychain}: ` +
        `${(res.stderr || res.stdout).trim().split('\n')[0]}`,
    );
  }
  const out = new Set<string>();
  for (const line of res.stdout.split('\n')) {
    // e.g.   1) <40-hex sha1> "Apple Distribution: Acme Inc (ABCDE12345)"
    const m = line.match(/^\s*\d+\)\s+([0-9A-Fa-f]{40})\s+"([^"]+)"/);
    if (!m) continue;
    const [, sha1, name] = m;
    if (name.includes('Apple Distribution') && name.includes(`(${teamId})`)) {
      out.add(sha1.toUpperCase());
    }
  }
  return out;
}

/**
 * The team's distribution cert we can actually use: an App Store Connect
 * certificate whose PRIVATE KEY is present in the keychain, returned as a matched
 * { certId, sha1 } pair. The pairing is what keeps the provisioning profile
 * (built from certId) and the signing identity (CODE_SIGN_IDENTITY = sha1)
 * pointing at the SAME certificate even when a team has duplicate or rotated
 * certs in the keychain — otherwise Xcode could sign with a cert the profile
 * doesn't include ("incompatible profile"). Returns null only when the team has
 * no usable cert (→ caller mints); a transient ASC error propagates so we never
 * mint needlessly against Apple's limited quota.
 */
async function resolveUsableTeamCert(
  auth: AscAuth,
  teamId: string,
  keychain: string,
): Promise<{ certId: string; sha1: string } | null> {
  const keychainSha1s = await keychainTeamDistributionSha1s(keychain, teamId);
  if (keychainSha1s.size === 0) return null;
  const res = await ascApi(auth, 'GET', '/v1/certificates?limit=200');
  const certs = (Array.isArray(res.data) ? res.data : []) as AscResource[];
  for (const c of certs) {
    const content = c.attributes?.certificateContent as string | undefined;
    if (!content) continue;
    const fp = createHash('sha1')
      .update(Buffer.from(content, 'base64'))
      .digest('hex')
      .toUpperCase();
    if (keychainSha1s.has(fp)) return { certId: c.id, sha1: fp };
  }
  return null;
}

/**
 * Serializes cert resolution + mint + keychain import across concurrent App
 * Store builds in this single host-agent process, so two publishes for the same
 * new team can't both mint (the second must see the first's cert) and concurrent
 * `security import`s can't race on the shared keychain.
 */
let signingLock: Promise<unknown> = Promise.resolve();
function withSigningLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = signingLock.then(fn, fn);
  // Keep the chain alive but never let one failure wedge the lock.
  signingLock = run.catch(() => undefined);
  return run;
}

/**
 * Ensure a DISTRIBUTION cert + IOS_APP_STORE provisioning profile exist for
 * `bundleId`, the cert's private key is in the signing keychain, and the
 * profile is installed locally. Returns the identity + profile name to feed
 * xcodebuild's manual-signing flags.
 *
 * Idempotent + team-scoped: reuses the team's existing distribution cert
 * whenever App Store Connect + the keychain already hold a matching pair (so a
 * cert is minted at most once per team, respecting Apple's quota), and reuses
 * the profile if one with the expected name already exists.
 *
 * NEVER logs the .p8, the p12 password, or any private-key material.
 */
export async function ensureSigningAssets(
  opts: EnsureSigningAssetsOptions,
): Promise<SigningAssets> {
  const { auth, teamId, bundleId, appName, keychain, keychainPassword, workdir, onLog } = opts;

  // ── 1. Bundle id ──────────────────────────────────────────────────────────
  let bundleResId: string;
  const bundleLookup = await ascApi(
    auth,
    'GET',
    `/v1/bundleIds?filter[identifier]=${encodeURIComponent(bundleId)}&limit=1`,
  );
  const existingBundle = (bundleLookup.data as AscResource[] | undefined)?.[0];
  if (existingBundle) {
    bundleResId = existingBundle.id;
  } else {
    const created = await ascApi(auth, 'POST', '/v1/bundleIds', {
      data: {
        type: 'bundleIds',
        attributes: {
          identifier: bundleId,
          name: appName || bundleId,
          platform: 'IOS',
        },
      },
    });
    bundleResId = (created.data as AscResource | undefined)?.id ?? '';
    if (!bundleResId) throw new Error('ASC bundleIds create returned no data.id');
    onLog(`Registered bundle id ${bundleId}`, 'stdout');
  }

  // ── 2. Distribution certificate (reuse per team, mint at most once) ────────
  // Multiple teams' distribution certs accumulate in the shared signing
  // keychain, so the usable cert is resolved by matching App Store Connect's
  // certificates against the keychain identities scoped to THIS team — never a
  // generic "Apple Distribution" pick. Runs under a lock so concurrent builds
  // for a new team can't both mint and can't race the keychain import.
  const { certId, signingIdentity } = await withSigningLock(async () => {
    // Reuse the team's existing cert (ASC id + keychain key paired by
    // fingerprint) whenever possible; mint only when the team has none we can
    // sign with, then re-resolve so certId and the signing identity are the
    // freshly-minted cert.
    let usable = await resolveUsableTeamCert(auth, teamId, keychain);
    if (usable) {
      onLog(`Reusing distribution certificate for team ${teamId}`, 'stdout');
    } else {
      await createDistributionCertificate({
        auth,
        teamId,
        keychain,
        keychainPassword,
        workdir,
      });
      usable = await resolveUsableTeamCert(auth, teamId, keychain);
      if (!usable) {
        throw new Error(
          `distribution certificate for team ${teamId} is not usable from the ` +
            `signing keychain after minting`,
        );
      }
      onLog(`Created distribution certificate for team ${teamId}`, 'stdout');
    }
    // certId → provisioning profile; sha1 → CODE_SIGN_IDENTITY. Both are the SAME
    // cert, so the profile always includes the signing identity (no "incompatible
    // profile") and the SHA-1 disambiguates duplicate/rotated certs.
    return { certId: usable.certId, signingIdentity: usable.sha1 };
  });

  // ── 3. App Store provisioning profile (device-free) ────────────────────────
  // Keep the name <=100 chars (Apple's limit); truncate the bundle id tail if a
  // pathologically long id would overflow the "Botflow " prefix.
  let profileName = `Botflow ${bundleId}`;
  if (profileName.length > 100) profileName = profileName.slice(0, 100);

  const profileDir = path.join(homedir(), 'Library', 'MobileDevice', 'Provisioning Profiles');

  // Serialized: lookup → (rotate) delete → create → install must not interleave
  // with a concurrent build for the same profile name. Under the lock, a second
  // build re-fetches and sees the first's freshly-created profile instead of
  // racing a duplicate-name create.
  await withSigningLock(async () => {
    let profileContent: string | undefined;
    let profileUuid: string | undefined;

    // `include=certificates` so we can see which cert each profile embeds.
    const profiles = await ascApi(auth, 'GET', '/v1/profiles?include=certificates&limit=200');
    let existingProfile = (profiles.data as AscResource[] | undefined)?.find(
      (p) => p.attributes?.name === profileName,
    );

    // A same-name profile is only reusable if it embeds the SELECTED cert. If it
    // was built for a different (also-valid) team cert, Xcode would sign with our
    // `certId` while the profile lists another → "provisioning profile doesn't
    // include signing certificate". Recreate it for the selected cert, and drop
    // its stale local file — it shares this profile name, so leaving it behind
    // could make Xcode resolve the superseded (wrong-cert) profile.
    if (existingProfile) {
      const rel = existingProfile.relationships?.certificates?.data;
      const embeddedCertIds = Array.isArray(rel) ? rel.map((c) => c.id) : rel ? [rel.id] : [];
      if (!embeddedCertIds.includes(certId)) {
        try {
          await ascApi(auth, 'DELETE', `/v1/profiles/${existingProfile.id}`);
        } catch (e) {
          // Only a definitive 404 means it's already gone (e.g. a concurrent
          // build removed it). Any other failure (permission, network, 5xx) is
          // inconclusive — rethrow rather than risk a duplicate-name create.
          if (!/→ 404\b/.test((e as Error).message)) throw e;
        }
        const staleUuid = existingProfile.attributes?.uuid as string | undefined;
        if (staleUuid) {
          rmSync(path.join(profileDir, `${staleUuid}.mobileprovision`), { force: true });
        }
        existingProfile = undefined;
      }
    }

    if (existingProfile) {
      profileContent = existingProfile.attributes?.profileContent as string | undefined;
      profileUuid = existingProfile.attributes?.uuid as string | undefined;
    }

    if (!profileContent || !profileUuid) {
      const created = await ascApi(auth, 'POST', '/v1/profiles', {
        data: {
          type: 'profiles',
          attributes: { name: profileName, profileType: 'IOS_APP_STORE' },
          relationships: {
            bundleId: { data: { type: 'bundleIds', id: bundleResId } },
            certificates: { data: [{ type: 'certificates', id: certId }] },
          },
        },
      });
      const attrs = (created.data as AscResource | undefined)?.attributes;
      profileContent = attrs?.profileContent as string | undefined;
      profileUuid = attrs?.uuid as string | undefined;
      if (!profileContent || !profileUuid) {
        throw new Error('ASC profiles create returned no profileContent/uuid');
      }
      onLog(`Created App Store profile ${profileName}`, 'stdout');
    }

    // Install the profile where xcodebuild's manual signing looks for it.
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(
      path.join(profileDir, `${profileUuid}.mobileprovision`),
      Buffer.from(profileContent, 'base64'),
    );
    onLog(`Installed App Store profile ${profileName}`, 'stdout');
  });

  return { signingIdentity, profileName };
}

/**
 * Mint a fresh DISTRIBUTION certificate: generate an RSA key + CSR locally,
 * POST the CSR to ASC, decode the returned cert to PEM, bundle key+cert into a
 * keychain-compatible p12, and import it into the signing keychain. Returns the
 * new certificate's ASC resource id.
 *
 * MUST use /usr/bin/openssl (system LibreSSL) for the p12 — a Homebrew OpenSSL 3
 * p12 uses an algorithm the macOS keychain can't import. The unlock immediately
 * before `security import` is THE FIX: a freshly-spawned non-GUI session leaves
 * the keychain re-locked, and import silently produces an unusable identity.
 *
 * All on-disk key material is deleted before returning (private-key hygiene).
 */
async function createDistributionCertificate(opts: {
  auth: AscAuth;
  teamId: string;
  keychain: string;
  keychainPassword: string;
  workdir: string;
}): Promise<string> {
  const { auth, teamId, keychain, keychainPassword, workdir } = opts;
  const keyPath = path.join(workdir, 'dist.key');
  const csrPath = path.join(workdir, 'dist.csr');
  const cerPath = path.join(workdir, 'dist.cer');
  const pemPath = path.join(workdir, 'dist.pem');
  const p12Path = path.join(workdir, 'dist.p12');
  // p12 transport password — random, never logged, never persisted.
  const p12pw = randomBytes(18).toString('base64url');

  const cleanup = (): void => {
    for (const f of [keyPath, csrPath, cerPath, pemPath, p12Path]) {
      try {
        rmSync(f, { force: true });
      } catch {
        /* fine */
      }
    }
  };

  try {
    // a. RSA private key.
    const gen = await execAsync(`/usr/bin/openssl genrsa -out ${q(keyPath)} 2048`, {
      timeoutMs: 30_000,
    });
    if (gen.code !== 0) throw new Error(`openssl genrsa failed: ${gen.stderr || gen.stdout}`);

    // b. CSR.
    const subj = `/CN=Botflow Distribution/O=${teamId}/C=US`;
    const csr = await execAsync(
      `/usr/bin/openssl req -new -key ${q(keyPath)} -out ${q(csrPath)} -subj ${q(subj)}`,
      { timeoutMs: 30_000 },
    );
    if (csr.code !== 0) throw new Error(`openssl req failed: ${csr.stderr || csr.stdout}`);

    // c. POST the CSR → distribution certificate.
    const csrContent = readFileSync(csrPath, 'utf8');
    const created = await ascApi(auth, 'POST', '/v1/certificates', {
      data: {
        type: 'certificates',
        attributes: { certificateType: 'DISTRIBUTION', csrContent },
      },
    });
    const certData = created.data as AscResource | undefined;
    const certId = certData?.id;
    const certificateContent = certData?.attributes?.certificateContent as string | undefined;
    if (!certId || !certificateContent) {
      throw new Error('ASC certificates create returned no id/certificateContent');
    }

    // d. DER → PEM.
    writeFileSync(cerPath, Buffer.from(certificateContent, 'base64'));
    const pem = await execAsync(
      `/usr/bin/openssl x509 -inform DER -in ${q(cerPath)} -out ${q(pemPath)}`,
      { timeoutMs: 30_000 },
    );
    if (pem.code !== 0) throw new Error(`openssl x509 failed: ${pem.stderr || pem.stdout}`);

    // e. Bundle key + cert into a keychain-compatible p12 (system LibreSSL).
    const p12 = await execAsync(
      `/usr/bin/openssl pkcs12 -export -inkey ${q(keyPath)} -in ${q(pemPath)} ` +
        `-out ${q(p12Path)} -passout pass:${q(p12pw)} -name "Apple Distribution"`,
      { timeoutMs: 30_000 },
    );
    if (p12.code !== 0) throw new Error(`openssl pkcs12 failed: ${p12.stderr || p12.stdout}`);

    // f. THE FIX: unlock immediately before importing, then import the private
    //    key + cert, granting codesign/xcodebuild access.
    const unlock = await execAsync(
      `security unlock-keychain -p ${q(keychainPassword)} ${q(keychain)}`,
      { timeoutMs: 10_000 },
    );
    if (unlock.code !== 0) {
      throw new Error(`security unlock-keychain failed: ${unlock.stderr || unlock.stdout}`);
    }
    const imp = await execAsync(
      `security import ${q(p12Path)} -k ${q(keychain)} -P ${q(p12pw)} ` +
        `-A -T /usr/bin/codesign -T /usr/bin/xcodebuild`,
      { timeoutMs: 30_000 },
    );
    if (imp.code !== 0) {
      throw new Error(`security import failed: ${imp.stderr || imp.stdout}`);
    }

    // g. Allow non-interactive codesign access (suppress the GUI key-access
    //    prompt). Best-effort — ignore failure.
    await execAsync(
      `security set-key-partition-list -S apple-tool:,apple:,codesign: -s ` +
        `-k ${q(keychainPassword)} ${q(keychain)}`,
      { timeoutMs: 10_000 },
    );

    log(`Imported distribution certificate ${certId.slice(0, 8)} into ${keychain}`);
    return certId;
  } finally {
    // h. Private-key hygiene — never leave key material on disk.
    cleanup();
  }
}

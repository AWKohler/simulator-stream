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
import { randomBytes } from 'node:crypto';
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
  /** Value for CODE_SIGN_IDENTITY (always "Apple Distribution"). */
  signingIdentity: string;
  /** Value for PROVISIONING_PROFILE_SPECIFIER (the profile's name). */
  profileName: string;
}

/** Persisted across builds so the distribution cert is minted exactly once. */
interface SigningState {
  certId?: string;
}

function stateDir(): string {
  return path.join(homedir(), '.botflow-signing');
}

function stateFile(): string {
  return path.join(stateDir(), 'state.json');
}

function readState(): SigningState {
  try {
    return JSON.parse(readFileSync(stateFile(), 'utf8')) as SigningState;
  } catch {
    return {};
  }
}

function writeState(state: SigningState): void {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(stateFile(), JSON.stringify(state, null, 2));
}

/**
 * Ensure a DISTRIBUTION cert + IOS_APP_STORE provisioning profile exist for
 * `bundleId`, the cert's private key is in the signing keychain, and the
 * profile is installed locally. Returns the identity + profile name to feed
 * xcodebuild's manual-signing flags.
 *
 * Idempotent: the cert is created once (tracked in ~/.botflow-signing/state.json)
 * and the profile is reused if one with the expected name already exists.
 *
 * NEVER logs the .p8, the p12 password, or any private-key material.
 */
export async function ensureSigningAssets(
  opts: EnsureSigningAssetsOptions,
): Promise<SigningAssets> {
  const { auth, teamId, bundleId, appName, keychain, keychainPassword, workdir, onLog } = opts;
  const signingIdentity = 'Apple Distribution';

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

  // ── 2. Distribution certificate (create-once, reuse) ───────────────────────
  const state = readState();
  let certId = state.certId;

  // Reuse only if state remembers a cert AND the keychain actually holds a
  // usable "Apple Distribution" codesigning identity. (A cert minted on a
  // since-rebuilt box would be in state.json but absent from the keychain.)
  let haveIdentity = false;
  if (certId) {
    const ids = await execAsync(
      `security find-identity -v -p codesigning ${q(keychain)}`,
      { timeoutMs: 10_000 },
    );
    haveIdentity = /Apple Distribution/.test(ids.stdout);
  }

  if (certId && haveIdentity) {
    onLog('Reusing distribution certificate', 'stdout');
  } else {
    certId = await createDistributionCertificate({
      auth,
      teamId,
      keychain,
      keychainPassword,
      workdir,
    });
    writeState({ ...state, certId });
    onLog('Created distribution certificate', 'stdout');
  }

  // ── 3. App Store provisioning profile (device-free) ────────────────────────
  // Keep the name <=100 chars (Apple's limit); truncate the bundle id tail if a
  // pathologically long id would overflow the "Botflow " prefix.
  let profileName = `Botflow ${bundleId}`;
  if (profileName.length > 100) profileName = profileName.slice(0, 100);

  let profileContent: string | undefined;
  let profileUuid: string | undefined;

  const profiles = await ascApi(auth, 'GET', '/v1/profiles?limit=200');
  const existingProfile = (profiles.data as AscResource[] | undefined)?.find(
    (p) => p.attributes?.name === profileName,
  );
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
  const profileDir = path.join(homedir(), 'Library', 'MobileDevice', 'Provisioning Profiles');
  mkdirSync(profileDir, { recursive: true });
  const profilePath = path.join(profileDir, `${profileUuid}.mobileprovision`);
  writeFileSync(profilePath, Buffer.from(profileContent, 'base64'));
  onLog(`Installed App Store profile ${profileName}`, 'stdout');

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

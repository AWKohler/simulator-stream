// App Store Connect BuildUpload client — uploads a signed .ipa via Apple's
// REST API (the WWDC25 buildUploads flow). Pure node:crypto + fetch; no
// altool/Transporter/fastlane. altool --upload-package remains the documented
// fallback if this API ever regresses.
//
// Flow (schema verified against Apple's ASC API docs, 2026-06):
//   1. POST /v1/buildUploads        { cfBundleVersion, cfBundleShortVersionString,
//                                     platform } + app relationship
//   2. POST /v1/buildUploadFiles    { assetType, fileName, fileSize, uti }
//                                   + buildUpload relationship
//      → uploadOperations: [{ url, method, offset, length, requestHeaders }]
//   3. PUT each chunk to its operation URL
//   4. PATCH /v1/buildUploadFiles/:id { uploaded: true }
//   5. Poll GET /v1/buildUploads/:id until state leaves AWAITING_UPLOAD.
//      PROCESSING counts as success here — post-upload processing/TestFlight
//      state is the platform's job to poll, not the build host's.

import { createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { openSync, readSync, closeSync, statSync } from 'node:fs';
import path from 'node:path';
import { log, warn } from './log.js';

const ASC_BASE = 'https://api.appstoreconnect.apple.com';

export interface AscAuth {
  keyId: string;
  issuerId: string;
  /** .p8 contents — full PEM or bare base64 body. */
  p8: string;
}

/** Normalize a .p8 (PEM or bare base64 body) into valid PEM. */
export function normalizeP8(p8: string): string {
  const trimmed = p8.trim();
  if (trimmed.includes('-----BEGIN')) return trimmed;
  const body = trimmed.replace(/\s+/g, '');
  const lines = body.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----`;
}

/** Mint a short-lived ES256 JWT for the ASC API. */
export function mintAscToken(auth: AscAuth): string {
  const key = createPrivateKey(normalizeP8(auth.p8));
  if (key.asymmetricKeyType !== 'ec') {
    throw new Error(`ASC key must be an EC (ES256) key, got ${key.asymmetricKeyType}`);
  }
  const b64url = (obj: unknown): string =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const header = b64url({ alg: 'ES256', kid: auth.keyId, typ: 'JWT' });
  const payload = b64url({
    iss: auth.issuerId,
    iat: now - 10,
    exp: now + 15 * 60, // Apple max is 20 min
    aud: 'appstoreconnect-v1',
  });
  // JWT ES256 wants raw R||S (ieee-p1363), not the DER default.
  const sig = cryptoSign('sha256', Buffer.from(`${header}.${payload}`), {
    key,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return `${header}.${payload}.${sig}`;
}

interface AscResource {
  id: string;
  type: string;
  attributes?: Record<string, unknown>;
}

async function ascRequest(
  auth: AscAuth,
  method: string,
  apiPath: string,
  body?: unknown,
): Promise<{ data?: AscResource } & Record<string, unknown>> {
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
    // Surface Apple's error JSON verbatim — these messages name the exact
    // attribute/relationship at fault, which is the fastest path to a fix.
    throw new Error(`ASC ${method} ${apiPath} → ${res.status}: ${text.slice(0, 2000)}`);
  }
  if (!text) return {};
  return JSON.parse(text) as { data?: AscResource } & Record<string, unknown>;
}

interface UploadOperation {
  method: string;
  url: string;
  offset: number;
  length: number;
  requestHeaders?: { name: string; value: string }[];
}

export interface AscUploadOptions {
  auth: AscAuth;
  /** ASC `apps` resource id (NOT the bundle id). */
  ascAppId: string;
  ipaPath: string;
  cfBundleVersion: string;
  cfBundleShortVersionString: string;
  onLog?: (line: string) => void;
}

export interface AscUploadResult {
  buildUploadId: string;
  /** Terminal-for-us state: 'PROCESSING' or 'COMPLETE'. */
  state: string;
}

export async function uploadIpaToAppStoreConnect(
  options: AscUploadOptions,
): Promise<AscUploadResult> {
  const { auth, ascAppId, ipaPath, onLog = () => undefined } = options;
  const fileName = path.basename(ipaPath);
  const fileSize = statSync(ipaPath).size;

  // 1. Create the build upload operation.
  const upload = await ascRequest(auth, 'POST', '/v1/buildUploads', {
    data: {
      type: 'buildUploads',
      attributes: {
        cfBundleVersion: options.cfBundleVersion,
        cfBundleShortVersionString: options.cfBundleShortVersionString,
        platform: 'IOS',
      },
      relationships: {
        app: { data: { type: 'apps', id: ascAppId } },
      },
    },
  });
  const buildUploadId = upload.data?.id;
  if (!buildUploadId) {
    throw new Error('ASC buildUploads response missing data.id');
  }
  log(`ASC buildUpload created ${buildUploadId.slice(0, 8)} for app ${ascAppId}`);

  // 2. Register the IPA file → receive chunked upload operations.
  const file = await ascRequest(auth, 'POST', '/v1/buildUploadFiles', {
    data: {
      type: 'buildUploadFiles',
      attributes: {
        // Verified against the live API: assetType must be 'ASSET' (valid enum
        // is ASSET | ASSET_DESCRIPTION | ASSET_SPI) and the IPA's uti is
        // 'com.apple.ipa' — NOT 'IPA' / 'com.apple.itunes.ipa', which 409.
        assetType: 'ASSET',
        fileName,
        fileSize,
        uti: 'com.apple.ipa',
      },
      relationships: {
        buildUpload: { data: { type: 'buildUploads', id: buildUploadId } },
      },
    },
  });
  const fileId = file.data?.id;
  const operations = (file.data?.attributes?.uploadOperations ?? []) as UploadOperation[];
  if (!fileId || operations.length === 0) {
    throw new Error(
      `ASC buildUploadFiles response missing id/uploadOperations: ${JSON.stringify(file).slice(0, 1000)}`,
    );
  }
  onLog(`Uploading ${fileName} (${Math.round(fileSize / 1024 / 1024)} MB, ${operations.length} part(s))`);

  // 3. PUT each chunk. Operations carry their own URLs + headers (pre-signed);
  //    read only the [offset, offset+length) slice per part.
  const fd = openSync(ipaPath, 'r');
  try {
    let done = 0;
    for (const op of operations) {
      const chunk = Buffer.alloc(op.length);
      readSync(fd, chunk, 0, op.length, op.offset);
      const headers: Record<string, string> = {};
      for (const h of op.requestHeaders ?? []) headers[h.name] = h.value;
      const res = await fetch(op.url, {
        method: op.method || 'PUT',
        headers,
        body: chunk as unknown as BodyInit,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(
          `IPA chunk upload failed (${res.status}) at offset ${op.offset}: ${text.slice(0, 500)}`,
        );
      }
      done += 1;
      onLog(`Uploaded part ${done}/${operations.length}`);
    }
  } finally {
    closeSync(fd);
  }

  // 4. Commit the file. (sourceFileChecksums is optional — Apple verifies
  //    per-part entityTags; skip the composite checksum for now.)
  await ascRequest(auth, 'PATCH', `/v1/buildUploadFiles/${fileId}`, {
    data: {
      type: 'buildUploadFiles',
      id: fileId,
      attributes: { uploaded: true },
    },
  });
  onLog('Upload committed — waiting for Apple to accept the package');

  // 5. Poll the build upload's state. IMPORTANT (verified against the live API):
  //    `attributes.state` is an OBJECT — { state: <enum>, errors, warnings,
  //    infos } — NOT a bare string. The enum lives at `.state.state`:
  //      AWAITING_UPLOAD → PROCESSING → COMPLETE (accepted; now in TestFlight)
  //      or FAILED (Apple rejected the bundle; `.errors[]` carries actionable
  //      text, e.g. missing icon / orientations / launch screen).
  //    We poll briefly to surface a fast validation FAILED; if it's still
  //    PROCESSING when the window closes the upload itself succeeded, so we
  //    return and let the platform poll processing state the rest of the way.
  const deadline = Date.now() + 2 * 60_000;
  let phase = 'AWAITING_UPLOAD';
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5_000));
    const status = await ascRequest(auth, 'GET', `/v1/buildUploads/${buildUploadId}`);
    const stateObj = (status.data?.attributes?.state ?? {}) as {
      state?: string;
      errors?: { code?: string; description?: string }[];
    };
    phase = stateObj.state ?? 'AWAITING_UPLOAD';
    if (phase === 'FAILED') {
      const detail = (stateObj.errors ?? [])
        .map((e) => e.description || e.code)
        .filter(Boolean)
        .join(' | ');
      throw new Error(
        `Apple rejected the build during processing: ${detail || '(no detail provided)'}`,
      );
    }
    if (phase === 'COMPLETE') {
      log(`ASC buildUpload ${buildUploadId.slice(0, 8)} state=${phase}`);
      return { buildUploadId, state: phase };
    }
  }
  // Still PROCESSING (not COMPLETE/FAILED yet) — the binary is uploaded and
  // accepted; Apple is finishing processing. Hand back to the platform poller.
  warn(`ASC buildUpload ${buildUploadId.slice(0, 8)} still ${phase} after upload window`);
  return { buildUploadId, state: phase };
}

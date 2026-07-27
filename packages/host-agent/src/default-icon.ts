// App Store build preflight: guarantee the bundle has a 1024px app icon.
//
// Apple FAILS processing of any App Store / TestFlight build whose app icon is
// missing — and projects seeded from older templates (or hand-edited) may have
// an `AppIcon.appiconset` with only a placeholder `Contents.json` and no PNG.
// This injects a default icon ONLY when the project has none of its own, so a
// user's real icon is never overridden; it just turns a hard processing failure
// into a publishable build the user can re-skin later.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { LogStream } from '@sim/shared';
import { execAsync } from './util.js';
import { warn } from './log.js';

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

/** A 1024×1024 opaque RGB PNG (no alpha — App Store requires it) with a subtle
 *  indigo→violet diagonal gradient. Generated at runtime so we don't carry a
 *  ~30 KB base64 literal. */
export function placeholderIcon1024(): Buffer {
  const size = 1024;
  const a = [79, 70, 229]; // #4F46E5
  const b = [124, 58, 237]; // #7C3AED
  const rowLen = 1 + size * 3;
  const raw = Buffer.alloc(size * rowLen);
  for (let y = 0; y < size; y++) {
    const o = y * rowLen;
    raw[o] = 0; // PNG filter byte 0 (none)
    for (let x = 0; x < size; x++) {
      const t = (x + y) / (2 * (size - 1));
      const p = o + 1 + x * 3;
      raw[p] = Math.round(a[0] + (b[0] - a[0]) * t);
      raw[p + 1] = Math.round(a[1] + (b[1] - a[1]) * t);
      raw[p + 2] = Math.round(a[2] + (b[2] - a[2]) * t);
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const t = Buffer.from(type);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type 2 = RGB (no alpha)
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Ensure the project has an app icon before an App Store archive. No-op when the
 * project already ships one (we never override a user's art). Best-effort: any
 * failure is logged and swallowed — a real missing-icon failure then surfaces
 * later as Apple's processing error, which is still actionable.
 */
export async function ensureAppStoreIcon(
  workdir: string,
  onLog: (line: string, stream: LogStream) => void,
): Promise<void> {
  try {
    const found = await execAsync(
      `find "${workdir}" -type d -name AppIcon.appiconset -not -path '*/build/*' 2>/dev/null | head -1`,
    );
    const dir = found.stdout.trim();
    if (!dir) {
      onLog('Icon preflight: no AppIcon.appiconset in project — skipping.', 'stderr');
      return;
    }
    const contentsPath = path.join(dir, 'Contents.json');

    // Already has a real icon image? Then leave it alone.
    try {
      const contents = JSON.parse(readFileSync(contentsPath, 'utf8')) as {
        images?: { filename?: string }[];
      };
      for (const img of contents.images ?? []) {
        if (img.filename && existsSync(path.join(dir, img.filename))) return;
      }
    } catch {
      // Missing/malformed Contents.json — treat as "no icon" and inject.
    }

    writeFileSync(path.join(dir, 'AppIcon.png'), placeholderIcon1024());
    writeFileSync(
      contentsPath,
      JSON.stringify(
        {
          images: [
            { filename: 'AppIcon.png', idiom: 'universal', platform: 'ios', size: '1024x1024' },
          ],
          info: { author: 'botflow', version: 1 },
        },
        null,
        2,
      ) + '\n',
    );
    onLog(
      'Icon preflight: added a default app icon (project had none) so Apple accepts the build.',
      'stdout',
    );
  } catch (e) {
    warn(`Icon preflight failed (non-fatal): ${(e as Error).message}`);
  }
}

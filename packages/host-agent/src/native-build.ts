// Whether a native helper has to be rebuilt.
//
// Comparing modification times is not enough: a deploy that copies the tree
// (cp, git archive, rsync without -t) can leave a stale binary looking newer
// than the source it no longer matches — and a stale capturer or control
// helper fails in ways that look like a broken simulator. So the binary is
// tied to the exact source it was built from by a hash kept beside it.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

function sourceHash(sources: string[]): string {
  const hash = createHash('sha256');
  for (const source of sources) hash.update(readFileSync(source));
  return hash.digest('hex');
}

const stampPath = (binary: string): string => `${binary}.srchash`;

/** True when `binary` exists and was built from exactly these sources. */
export function nativeBinaryFresh(binary: string, sources: string[]): boolean {
  try {
    if (!existsSync(binary) || !existsSync(stampPath(binary))) return false;
    return readFileSync(stampPath(binary), 'utf8').trim() === sourceHash(sources);
  } catch {
    return false;
  }
}

/** Record that `binary` was just built from these sources. */
export function stampNativeBinary(binary: string, sources: string[]): void {
  try {
    writeFileSync(stampPath(binary), sourceHash(sources) + '\n');
  } catch {
    // Without a stamp the helper is simply rebuilt next time.
  }
}

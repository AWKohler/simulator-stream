// Build-output parsing + sanitization. Everything here runs on the host-agent
// BEFORE anything crosses the wire — the hard requirement is that no absolute
// host path, session id, Xcode path, or device UDID ever leaves the Mac.

import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { BuildDiagnostic } from '@sim/shared';
import { execAsync } from './util.js';
import { warn } from './log.js';

// ── Sanitizer ───────────────────────────────────────────────────────────────
// Applied to every raw log line AND every diagnostic file/message string.

const UDID_RE = /\b[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\b/g;
const HW_UDID_RE = /\b[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}\b/g; // e.g. 00008103-001635DC34C0801E
const HOME_RE = /\/Users\/[^/\s]+/g;

/**
 * Returns null if the whole line should be dropped (pure infra noise), else the
 * sanitized string. `workdir` is the per-session build dir
 * (/private?/var/folders/.../sim-builds/<sessionId>) — stripped to make paths
 * project-relative, which also removes the session id (the WS bearer token).
 */
export function sanitizeLine(line: string, workdir: string): string | null {
  // Drop the destination-enumeration block: leaks Mac hardware UDID, pool sim
  // names + UDIDs, slot count. Zero diagnostic value.
  if (
    /Using the first of multiple matching destinations/.test(line) ||
    /IDERunDestination/.test(line) ||
    /^\s*{\s*platform:.*\bid:.*}\s*$/.test(line)
  ) {
    return null;
  }
  return sanitize(line, workdir);
}

/** String-level sanitize (no line-drop logic) — for diagnostic fields. */
export function sanitize(text: string, workdir: string): string {
  let out = text;
  // /private prefix appears in some xcodebuild paths; handle both.
  for (const wd of [workdir, `/private${workdir}`]) {
    out = out.split(`${wd}/`).join('').split(wd).join('');
  }
  out = out.replace(/\/Applications\/Xcode\.app\/[^\s'"]*/g, '<xcode>');
  out = out.replace(HOME_RE, '~');
  out = out.replace(HW_UDID_RE, '<udid>');
  out = out.replace(UDID_RE, '<uuid>');
  return out;
}

// ── Live regex parse (progressive, while the build runs) ─────────────────────

const DIAG_RE =
  /^(?<file>(?:\/|[A-Za-z]).+?):(?<line>\d+):(?<col>\d+):\s+(?<sev>error|warning):\s+(?<msg>.*)$/;

export function parseLiveDiagnostic(
  line: string,
  workdir: string,
): BuildDiagnostic | null {
  const m = DIAG_RE.exec(line);
  if (!m?.groups) return null;
  const sev = m.groups.sev === 'error' ? 'error' : 'warning';
  return {
    severity: sev,
    file: toProjectRelative(m.groups.file, workdir),
    line: Number(m.groups.line),
    column: Number(m.groups.col),
    message: sanitize(m.groups.msg, workdir),
    snippet: null, // snippets only attached by the authoritative pass
  };
}

function toProjectRelative(file: string, workdir: string): string {
  let f = file;
  for (const wd of [`/private${workdir}/`, `${workdir}/`]) {
    if (f.startsWith(wd)) {
      f = f.slice(wd.length);
      break;
    }
  }
  return sanitize(f, workdir);
}

// ── Authoritative extraction via xcresulttool (post-build) ───────────────────

interface XcresultIssue {
  message?: string;
  issueType?: string;
  targetName?: string;
  sourceURL?: string;
  documentLocationInCreatingWorkspace?: { url?: string };
}

/**
 * Pull structured diagnostics from the .xcresult bundle. Tries the Xcode 16+
 * `build-results` API first, then the legacy JSON schema. Any failure returns
 * [] — diagnostic extraction must NEVER break the build flow.
 */
export async function extractDiagnostics(
  bundlePath: string,
  workdir: string,
): Promise<BuildDiagnostic[]> {
  const modern = await tryBuildResults(bundlePath, workdir);
  if (modern !== null) return modern;
  const legacy = await tryLegacy(bundlePath, workdir);
  return legacy ?? [];
}

async function tryBuildResults(
  bundlePath: string,
  workdir: string,
): Promise<BuildDiagnostic[] | null> {
  const res = await execAsync(
    `xcrun xcresulttool get build-results --path "${bundlePath}" --format json`,
    { timeoutMs: 20_000 },
  );
  if (res.code !== 0) return null;
  try {
    const json = JSON.parse(res.stdout) as {
      errors?: XcresultIssue[];
      warnings?: XcresultIssue[];
    };
    const out: BuildDiagnostic[] = [];
    for (const e of json.errors ?? []) out.push(toDiag(e, 'error', workdir));
    for (const w of json.warnings ?? []) out.push(toDiag(w, 'warning', workdir));
    return out;
  } catch (e) {
    warn(`xcresult build-results parse failed: ${(e as Error).message}`);
    return null;
  }
}

async function tryLegacy(
  bundlePath: string,
  workdir: string,
): Promise<BuildDiagnostic[] | null> {
  const res = await execAsync(
    `xcrun xcresulttool get --legacy --format json --path "${bundlePath}"`,
    { timeoutMs: 20_000 },
  );
  if (res.code !== 0) return null;
  try {
    const root = JSON.parse(res.stdout) as Record<string, unknown>;
    const issues =
      (root.issues as Record<string, { _values?: unknown[] }>) ?? {};
    const out: BuildDiagnostic[] = [];
    const walk = (arr: unknown[] | undefined, sev: 'error' | 'warning'): void => {
      for (const raw of arr ?? []) {
        const v = raw as {
          message?: { _value?: string };
          documentLocationInCreatingWorkspace?: { url?: { _value?: string } };
        };
        const msg = v.message?._value ?? '';
        const url = v.documentLocationInCreatingWorkspace?.url?._value;
        out.push(diagFromUrl(msg, url, sev, workdir));
      }
    };
    walk(issues.errorSummaries?._values, 'error');
    walk(issues.warningSummaries?._values, 'warning');
    return out;
  } catch (e) {
    warn(`xcresult legacy parse failed: ${(e as Error).message}`);
    return null;
  }
}

function toDiag(
  issue: XcresultIssue,
  severity: 'error' | 'warning',
  workdir: string,
): BuildDiagnostic {
  const url = issue.sourceURL ?? issue.documentLocationInCreatingWorkspace?.url;
  return diagFromUrl(issue.message ?? '', url, severity, workdir);
}

// sourceURL form: file:///abs/path/File.swift#EndingColumnNumber=10&EndingLineNumber=42&StartingColumnNumber=9&StartingLineNumber=42
function diagFromUrl(
  message: string,
  url: string | undefined,
  severity: 'error' | 'warning',
  workdir: string,
): BuildDiagnostic {
  let file: string | null = null;
  let line: number | null = null;
  let column: number | null = null;
  if (url) {
    const [pathPart, frag] = url.replace(/^file:\/\//, '').split('#');
    file = toProjectRelative(decodeURIComponent(pathPart), workdir);
    if (frag) {
      const p = new URLSearchParams(frag);
      const l = p.get('StartingLineNumber');
      const c = p.get('StartingColumnNumber');
      if (l) line = Number(l);
      if (c) column = Number(c);
    }
  }
  return {
    severity,
    file,
    line,
    column,
    message: sanitize(message, workdir),
    snippet: file && line ? readSnippet(workdir, file, line, workdir) : null,
  };
}

/** ±2 lines around `line` from the extracted source, sanitized. */
function readSnippet(
  workdir: string,
  projectRelFile: string,
  line: number,
  sanitizeWorkdir: string,
): string[] | null {
  try {
    // CONTAINMENT: the file path comes from the .xcresult, which is produced by
    // an untrusted build (and, under the vm-queue backend, is fully
    // attacker-controlled). A path like `../../../etc/passwd` would otherwise
    // make us read and return arbitrary host-readable files — defeating the VM
    // isolation boundary. Resolve and require the result to stay under workdir.
    // realpath BOTH sides: a lexical check alone is bypassable by a symlink
    // planted inside the workdir by the uploaded archive (readFileSync would
    // happily follow it out to /etc/passwd).
    const root = realpathSync(path.resolve(workdir));
    const real = realpathSync(path.resolve(root, projectRelFile));
    if (real !== root && !real.startsWith(root + path.sep)) return null;
    const lines = readFileSync(real, 'utf8').split('\n');
    const start = Math.max(0, line - 3);
    const end = Math.min(lines.length, line + 2);
    return lines
      .slice(start, end)
      .map((text, i) => {
        const ln = start + i + 1;
        const mark = ln === line ? '→' : ' ';
        return `${mark} ${String(ln).padStart(4)} | ${sanitize(text, sanitizeWorkdir)}`;
      });
  } catch {
    return null;
  }
}

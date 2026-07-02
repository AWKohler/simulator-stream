import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export interface ProjectInfo {
  scheme: string;
  bundleId: string;
}

const DEFAULTS: ProjectInfo = {
  scheme: 'MyApp',
  bundleId: 'com.botflow.myapp',
};

// Cheap regex parser — project.yml is XcodeGen format. We only need two values
// (project name + bundleId of the first iOS target). A full YAML parser is overkill.
export function parseProjectYml(workdir: string, hints?: Partial<ProjectInfo>): ProjectInfo {
  const ymlPath = path.join(workdir, 'project.yml');
  if (!existsSync(ymlPath)) {
    return { ...DEFAULTS, ...hints };
  }

  let raw: string;
  try {
    raw = readFileSync(ymlPath, 'utf8');
  } catch {
    return { ...DEFAULTS, ...hints };
  }

  const name = raw.match(/^name:\s*([^\s#]+)/m)?.[1]?.trim();
  // First `bundleId:` we see under any target
  const bundleId = raw.match(/^\s+bundleId:\s*([^\s#]+)/m)?.[1]?.trim();
  // Fallback path: synthesize bundleId from bundleIdPrefix + name
  const prefix = raw.match(/^\s*bundleIdPrefix:\s*([^\s#]+)/m)?.[1]?.trim();
  const synthesized = name && prefix ? `${prefix}.${name.toLowerCase()}` : undefined;

  return {
    scheme: hints?.scheme ?? name ?? DEFAULTS.scheme,
    bundleId: hints?.bundleId ?? bundleId ?? synthesized ?? DEFAULTS.bundleId,
  };
}

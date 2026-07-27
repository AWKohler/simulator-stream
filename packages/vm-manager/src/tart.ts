// Typed wrapper over the `tart` CLI.
// We deliberately do NOT depend on a Node-native VM library; the upstream
// project is the CLI, and shelling out keeps us insulated from API churn.

import { spawn, spawnSync } from 'node:child_process';
import { warn } from './log.js';

export interface TartVM {
  name: string;
  state: 'running' | 'stopped' | 'suspended' | string;
  /** Size on disk in bytes, as reported by `tart list --format json`. */
  sizeBytes: number;
}

export interface TartRunOptions {
  /** Memory cap for the VM, in MB. Applied via `tart set` (see tartRun). */
  memoryMB: number;
  /** vCPU count. Applied via `tart set` (see tartRun). */
  cpu: number;
  /** When true, runs without an attached graphical window (headless). */
  noGraphics?: boolean;
  /** Host paths to share into the VM at boot (read-write). Key = guest mount
   * tag, value = host directory. Used to inject per-VM secrets (e.g. the
   * Tailscale authkey) without baking them into the golden image. */
  mounts?: Record<string, string>;
  /**
   * Run the VM behind tart's Softnet software networking instead of the shared
   * NAT. This is what makes a build VM's egress restrictable at the VM
   * boundary: combined with `netAllow`, the guest can only reach the listed
   * CIDRs. Untrusted compilation (Package.swift / SwiftPM plugins / Run Script
   * phases) therefore cannot reach the host's control plane, the tailnet, or
   * the home LAN even if it fully owns the guest.
   */
  netSoftnet?: boolean;
  /**
   * CIDRs the guest may reach, as `--net-softnet-allow`. Only meaningful with
   * `netSoftnet`. Empty/undefined leaves Softnet's default policy in place.
   */
  netAllow?: string[];
  /** CIDRs the guest may NOT reach, as `--net-softnet-block`. Longest prefix
   *  match wins when combined with `netAllow`. */
  netBlock?: string[];
}

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

function execSync(cmd: string, args: string[]): ExecResult {
  const res = spawnSync(cmd, args, { encoding: 'utf8' });
  return {
    code: res.status ?? -1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

/**
 * List all tart VMs. Filters out images that are templates (we use a naming
 * prefix convention to identify pool members — see `vm-manager/src/pool.ts`).
 *
 * Returns `[]` if `tart` is unavailable rather than throwing, so the
 * reconcile loop can keep running and surface the issue via warnings.
 */
export function tartList(): TartVM[] {
  const res = execSync('tart', ['list', '--format', 'json']);
  if (res.code !== 0) {
    warn(`tart list failed (${res.code}): ${res.stderr.trim() || res.stdout.trim()}`);
    return [];
  }
  try {
    const rows = JSON.parse(res.stdout) as Array<{
      Name?: string;
      State?: string;
      Size?: number;
    }>;
    return rows
      .filter((r) => typeof r.Name === 'string')
      .map((r) => ({
        name: r.Name!,
        state: (r.State ?? 'stopped').toLowerCase(),
        sizeBytes: typeof r.Size === 'number' ? r.Size : 0,
      }));
  } catch (e) {
    warn(`tart list: unparseable JSON: ${(e as Error).message}`);
    return [];
  }
}

/**
 * Clone an image into a new VM with the given name. Tart clones are
 * copy-on-write — only the delta from the source is stored on disk, so
 * cloning is cheap (~1-2s typical, vs ~140GB for a fresh pull).
 */
export function tartClone(source: string, target: string): boolean {
  const res = execSync('tart', ['clone', source, target]);
  if (res.code === 0) return true;
  warn(`tart clone ${source} -> ${target} failed: ${res.stderr.trim()}`);
  return false;
}

/**
 * Start a VM in the background. Returns the child process handle so the
 * caller can `kill()` it on shutdown. `tart run` is a foreground process
 * that holds the VM open for as long as it's running — we keep the handle
 * so the manager can tear it down cleanly.
 */
export function tartRun(
  name: string,
  options: TartRunOptions,
): { pid: number; kill: (signal?: NodeJS.Signals) => void } | null {
  // tart 2.x moved --memory/--cpu OFF `tart run` and onto `tart set`; passing
  // them to `run` is a hard "Unknown option" failure. Apply them as a separate
  // configure step first (idempotent, persisted on the VM), then boot.
  const cfg = execSync('tart', [
    'set',
    name,
    '--memory',
    String(options.memoryMB),
    '--cpu',
    String(options.cpu),
  ]);
  if (cfg.code !== 0) {
    warn(`tart set ${name} (mem=${options.memoryMB} cpu=${options.cpu}) failed: ${cfg.stderr.trim()}`);
    return null;
  }

  const args = ['run', name];
  if (options.noGraphics) args.push('--no-graphics');
  if (options.netSoftnet) {
    args.push('--net-softnet');
    if (options.netAllow?.length) args.push(`--net-softnet-allow=${options.netAllow.join(',')}`);
    if (options.netBlock?.length) args.push(`--net-softnet-block=${options.netBlock.join(',')}`);
  }
  if (options.mounts) {
    for (const [tag, hostPath] of Object.entries(options.mounts)) {
      // `--dir <tag>:<host-path>` shares a host directory into the guest at
      // the given mount tag. Inside the guest, mount with VirtIO 9p.
      args.push('--dir', `${tag}:${hostPath}`);
    }
  }
  try {
    const child = spawn('tart', args, { detached: false, stdio: 'ignore' });
    child.on('error', (e) => warn(`tart run ${name}: spawn error: ${e.message}`));
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        warn(`tart run ${name} exited code=${code}`);
      }
    });
    if (typeof child.pid !== 'number') {
      warn(`tart run ${name}: no pid`);
      return null;
    }
    return {
      pid: child.pid,
      kill: (signal: NodeJS.Signals = 'SIGTERM') => {
        try {
          child.kill(signal);
        } catch {
          /* already gone */
        }
      },
    };
  } catch (e) {
    warn(`tart run ${name}: ${(e as Error).message}`);
    return null;
  }
}

/** Gracefully stop a running VM. Idempotent. */
export function tartStop(name: string): boolean {
  const res = execSync('tart', ['stop', name]);
  if (res.code === 0) return true;
  warn(`tart stop ${name} failed: ${res.stderr.trim()}`);
  return false;
}

/** Permanently delete a VM image. Caller must `tartStop` first. */
export function tartDelete(name: string): boolean {
  const res = execSync('tart', ['delete', name]);
  if (res.code === 0) return true;
  warn(`tart delete ${name} failed: ${res.stderr.trim()}`);
  return false;
}

/**
 * Look up a VM's IPv4 once it's booted enough for tart to know. Returns
 * null if the VM isn't running or hasn't acquired an IP yet — callers
 * should poll with a deadline.
 */
export function tartIp(name: string): string | null {
  const res = execSync('tart', ['ip', name]);
  if (res.code !== 0) return null;
  const ip = res.stdout.trim();
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? ip : null;
}

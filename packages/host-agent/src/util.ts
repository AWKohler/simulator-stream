import { exec } from 'node:child_process';

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export function execAsync(
  cmd: string,
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const env = opts.env ? { ...process.env, ...opts.env } : process.env;
    exec(
      cmd,
      { timeout: opts.timeoutMs ?? 30_000, maxBuffer: 32 * 1024 * 1024, env, cwd: opts.cwd },
      (error, stdout, stderr) => {
        resolve({
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          code: error ? (error.code ?? 1) : 0,
        });
      },
    );
  });
}

// ── Sim-user isolation (bare-metal production) ──────────────────────────────
//
// On the bare-metal sim host, all SIMULATOR RUNTIME work (boot, install, launch,
// framebuffer capture, input) runs as a dedicated NON-ADMIN user (e.g. `simhost`)
// that holds the console GUI/Aqua session CoreSimulator requires, and is sealed
// off from the control plane / tailnet / secrets by a per-uid PF firewall. The
// orchestrator itself stays as its own user (it needs control-plane access the
// sim user is denied), and shells *out* to the sim user via `launchctl asuser`
// (which places the process in the sim user's Aqua session) + `sudo -u`. A
// scoped NOPASSWD sudoers rule grants exactly `launchctl asuser <uid>`.
//
// Gated by SIM_RUN_USER + SIM_RUN_UID — UNSET in dev and inside the build VMs,
// where everything already runs as the right (single) user, so these are no-ops.
//
// NOTE: this wraps the SIM RUNTIME only. BUILD execution is intentionally a
// separate seam (see build-runner.ts) because the decided end state queues all
// builds through the 2-VM slot system; today it happens to also run as the sim
// user on bare metal, but that path must stay swappable for the VM queue.

const SIM_RUN_USER = process.env.SIM_RUN_USER ?? '';
const SIM_RUN_UID = process.env.SIM_RUN_UID ?? '';

/** True when sim work must be routed to the dedicated sim user. */
export function simUserEnabled(): boolean {
  return SIM_RUN_USER !== '' && SIM_RUN_UID !== '';
}

/**
 * Prefix a shell command so it runs as the sim user in its Aqua session.
 * No-op when SIM_RUN_USER/UID are unset. Suitable for execAsync-style commands
 * without shell operators (pipes/redirects); quoted path args are preserved.
 */
export function wrapAsSimUser(cmd: string): string {
  if (!simUserEnabled()) return cmd;
  // -H sets HOME to the sim user's home. Required for anything HOME-relative
  // (e.g. idb's Python user-site packages) — without it HOME stays root's and
  // those imports/lookups fail. Harmless for HOME-agnostic tools (simctl).
  return `sudo -n /bin/launchctl asuser ${SIM_RUN_UID} sudo -H -u ${SIM_RUN_USER} ${cmd}`;
}

/** execAsync, but run as the sim user (no-op routing when disabled). */
export function execAsSimUser(
  cmd: string,
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<ExecResult> {
  return execAsync(wrapAsSimUser(cmd), opts);
}

/**
 * Rewrite a spawn() target so the binary launches as the sim user. Returns the
 * (command, args) to hand to child_process.spawn. Use for long-lived processes
 * (framebuffer capturer, idb_companion). No-op when disabled.
 */
export function spawnAsSimUser(
  bin: string,
  args: string[],
): { cmd: string; args: string[] } {
  if (!simUserEnabled()) return { cmd: bin, args };
  // -H: set HOME to the sim user's home (see wrapAsSimUser).
  return {
    cmd: 'sudo',
    args: ['-n', '/bin/launchctl', 'asuser', SIM_RUN_UID, 'sudo', '-H', '-u', SIM_RUN_USER, bin, ...args],
  };
}

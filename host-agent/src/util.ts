import { exec } from 'node:child_process';

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export function execAsync(cmd: string, opts: { timeoutMs?: number } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    exec(cmd, { timeout: opts.timeoutMs ?? 30_000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        code: error ? (error.code ?? 1) : 0,
      });
    });
  });
}

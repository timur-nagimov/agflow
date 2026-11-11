// Service commands (design 7.1): injected execution keeps macOS operations testable without running real vendor CLIs.
import type { Subprocess } from 'bun';
import type { ReadableStreamDefaultReader } from 'node:stream/web';

export interface ExecOptions {
  cwd?: string;
  /** The child's whole environment; process.env when omitted. */
  env?: Record<string, string>;
  /** Killed with SIGKILL after this many ms. */
  timeoutMs?: number;
  /** Inherit the terminal for vendor logins; captured output is then empty. */
  interactive?: boolean;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type Exec = (argv: string[], options?: ExecOptions) => Promise<ExecResult>;

async function readText(reader?: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  if (!reader) return '';
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

/** Commands that cannot start use the same failure path as commands that exit unsuccessfully. */
export const defaultExec: Exec = async (argv, options = {}) => {
  let proc: Subprocess<'ignore' | 'inherit', 'pipe' | 'inherit', 'pipe' | 'inherit'>;
  try {
    proc = Bun.spawn(argv, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdin: options.interactive ? 'inherit' : 'ignore',
      stdout: options.interactive ? 'inherit' : 'pipe',
      stderr: options.interactive ? 'inherit' : 'pipe',
    });
  } catch (error) {
    return { exitCode: 127, stdout: '', stderr: String(error), timedOut: false };
  }
  const stdoutReader = proc.stdout?.getReader();
  const stderrReader = proc.stderr?.getReader();
  let timedOut = false;
  const timer =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          proc.kill('SIGKILL');
          // A shell child may still hold the pipes after the shell dies; it must not extend the deadline.
          void stdoutReader?.cancel().catch(() => {});
          void stderrReader?.cancel().catch(() => {});
        }, options.timeoutMs);
  try {
    // Drain both pipes while the command runs, including commands with large stderr output.
    const [exitCode, stdout, stderr] = await Promise.all([proc.exited, readText(stdoutReader), readText(stderrReader)]);
    return { exitCode, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
};

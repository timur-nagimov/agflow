// Shared service test helpers: recorded commands now, with vendor and service fixtures added by tasks 2 and 3.
import type { Exec, ExecOptions, ExecResult } from '../src/service/system';

export interface ExecCall {
  argv: string[];
  options?: ExecOptions;
}

/** Scripted command outputs, with every invocation retained for assertions. */
export function recordingExec(
  scripts: { argv: string[]; result: Partial<ExecResult> }[] = [],
  fallback: Partial<ExecResult> = {},
): Exec & { calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const exec: Exec = async (argv, options) => {
    calls.push(structuredClone({ argv, options }));
    const result = scripts.find((script) => Bun.deepEquals(script.argv, argv))?.result ?? fallback;
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false, ...result };
  };
  return Object.assign(exec, { calls });
}

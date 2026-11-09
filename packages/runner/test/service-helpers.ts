// Shared service test helpers: recorded commands and isolated vendor CLIs.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Vendor } from '@agflow/core';
import type { RunnerPaths } from '../src/paths';
import type { Exec, ExecOptions, ExecResult } from '../src/service/system';
import { vendorBinary } from '../src/vendor/pins';

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

export interface VendorCliCall {
  argv: string[];
  cwd: string;
  entries: string[];
  env: Record<string, string>;
}

/** A shell entrypoint at the real pin path; Bun records structured data without shell escaping losses. */
export function fakeVendorCli(
  paths: RunnerPaths,
  vendor: Vendor,
  version: string,
  scripts: { argv: string[]; result: Partial<ExecResult> }[],
): { binary: string; calls: () => VendorCliCall[] } {
  const binary = join(paths.runner, vendorBinary(vendor, version));
  const log = join(paths.runner, `${vendor}-calls.jsonl`);
  mkdirSync(dirname(binary), { recursive: true });
  writeFileSync(log, '');
  const source = `
const fs = require('node:fs');
const argv = process.argv.slice(1);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({
  argv, cwd: process.cwd(), entries: fs.readdirSync('.'), env: process.env,
}) + '\\n');
const script = ${JSON.stringify(scripts)}.find(s => JSON.stringify(s.argv) === JSON.stringify(argv));
if (!script) process.exit(99);
process.stdout.write(script.result.stdout ?? '');
process.stderr.write(script.result.stderr ?? '');
process.exit(script.result.exitCode ?? 0);
`;
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(binary, `#!/bin/sh\nexec ${quote(process.execPath)} -e ${quote(source)} -- "$@"\n`, { mode: 0o700 });
  return {
    binary,
    calls: () =>
      readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
  };
}

// Shared service test helpers: recorded commands and isolated vendor CLIs.
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

/** Builds an npm tarball from package-relative files, keeping executable modes. */
export async function packTarball(
  files: Record<string, { content: string; mode?: number }>,
): Promise<{ bytes: Buffer; integrity: string }> {
  const root = mkdtempSync(join(tmpdir(), 'agf-pack-'));
  try {
    mkdirSync(join(root, 'package'));
    for (const [name, file] of Object.entries(files)) {
      const path = join(root, 'package', name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, file.content);
      chmodSync(path, file.mode ?? 0o644);
    }
    const proc = Bun.spawn(['tar', '-czf', join(root, 'package.tgz'), '-C', root, 'package'], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, , stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (code !== 0) throw new Error(`packing tarball failed: ${stderr}`);
    const bytes = readFileSync(join(root, 'package.tgz'));
    return { bytes, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A local npm registry with a request log; unknown packages return 404. */
export function localRegistry(packages: { package: string; packageVersion: string; bytes: Buffer }[]): {
  url: string;
  requests: string[];
  stop(): void;
} {
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(path);
      const entry = packages.find(
        (item) => path === `/${item.package}/-/${item.package.split('/').at(-1)}-${item.packageVersion}.tgz`,
      );
      return entry ? new Response(entry.bytes) : new Response('not found', { status: 404 });
    },
  });
  return {
    url: server.url.origin,
    requests,
    stop: () => {
      server.stop(true);
    },
  };
}

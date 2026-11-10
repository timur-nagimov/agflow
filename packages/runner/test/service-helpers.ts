// Shared service test helpers: recorded commands, isolated vendor CLIs, and the service host against the in-process
// hub.
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CREDENTIALS_FILE, type Vendor } from '@agflow/core';
import { FakeAdapter, originRepo } from '@agflow/testkit';
import { AttemptStore } from '../src/attempt-store';
import { type RunnerConfigInput, RunnerConfigSchema, saveRunnerConfig } from '../src/config';
import { openRunnerDb } from '../src/db';
import { type RunnerPaths, runnerPaths } from '../src/paths';
import { killGroup } from '../src/processes';
import { removeAgentTools } from '../src/run-dir';
import { type RunnerServiceOptions, startRunnerService } from '../src/service/host';
import type { Exec, ExecOptions, ExecResult } from '../src/service/system';
import { vendorBinary } from '../src/vendor/pins';
import { FIXTURE_AGFLOW, fixtureCliVersion } from './fixture';
import { startTestHub, type TestHub } from './hub-fixture';
import { afterThisTest, tempDir } from './runner-setup';

export interface TestServiceOptions {
  /** A hub another service of the test already uses; a new one over a local bare origin by default. */
  hub?: TestHub;
  /** runner.json fields over the test runner's. */
  config?: Partial<RunnerConfigInput>;
  /** Leaves credentials.json out of the CLI's config directory. */
  noCredentials?: boolean;
  /** The foreground by default. */
  mode?: RunnerServiceOptions['mode'];
  /** Host options over the helper's: the fake adapters, MACHINE-1 and a capturing terminal. */
  host?: Partial<RunnerServiceOptions>;
}

/**
 * A short AGFLOW_HOME (runner.sock must fit in 104 bytes) with a test runner.json, and a CLI config directory signed in
 * to the hub: the same files for an in-process host (start) and for run-service.ts in a child. Everything is removed
 * after the test.
 */
export async function setupTestService(options: TestServiceOptions = {}) {
  let hub = options.hub;
  if (!hub) {
    const origin = await originRepo({ 'README.md': '# demo\n', 'src/app.ts': 'app\n' });
    afterThisTest(() => origin.remove());
    hub = startTestHub({ config: { projectName: 'demo', projectRepo: origin.path } });
    const ownedHub = hub;
    afterThisTest(() => ownedHub.stop());
  }
  const home = mkdtempSync('/tmp/agf-');
  afterThisTest(() => rmSync(home, { recursive: true, force: true }));
  const paths = runnerPaths(home);
  afterThisTest(() => {
    if (!existsSync(paths.vaults)) return;
    for (const entry of readdirSync(paths.vaults).filter((name) => name.endsWith('.agent'))) {
      for (const attempt of readdirSync(join(paths.vaults, entry))) {
        removeAgentTools(join(paths.vaults, entry, attempt));
      }
    }
  });
  const configDir = tempDir('agf-cli-');
  if (!options.noCredentials) {
    writeFileSync(join(configDir, CREDENTIALS_FILE), JSON.stringify(hub.credentials), { mode: 0o600 });
  }
  const config = RunnerConfigSchema.parse({
    runnerKey: `rk_${crypto.randomUUID()}`,
    machineId: 'MACHINE-1',
    name: 'laptop',
    test: { skipAuthChecks: true, allowShortTimings: true },
    ...options.config,
  });
  saveRunnerConfig(paths.config, config);
  const tmpRoot = mkdtempSync('/tmp/ag');
  afterThisTest(() => rmSync(tmpRoot, { recursive: true, force: true }));
  const terminal: string[] = [];
  const start = async (overrides: Partial<RunnerServiceOptions> = {}) => {
    const host = { ...options.host, ...overrides };
    const service = await startRunnerService({
      paths,
      configDir,
      mode: options.mode ?? 'foreground',
      machineId: async () => 'MACHINE-1',
      agflow: FIXTURE_AGFLOW,
      cliVersion: fixtureCliVersion,
      terminal: (line) => terminal.push(line),
      tmpRoot,
      adapters: host.createAdapters ? undefined : fakeServiceAdapters(),
      ...host,
    });
    afterThisTest(async () => {
      try {
        // The host owns its db, so cleanup uses a separate reader even after the host has ended.
        if (existsSync(paths.db)) {
          const db = openRunnerDb(paths.db);
          try {
            for (const group of new AttemptStore(db).processes()) await killGroup(group, 'SIGKILL');
          } finally {
            db.close();
          }
        }
      } finally {
        await service.stop('test cleanup');
      }
    });
    return service;
  };
  return { hub, paths, configDir, config, terminal, tmpRoot, start };
}

/** A fake adapter per vendor whose agents play one empty turn. */
export function fakeServiceAdapters() {
  return (['claude', 'codex'] as const).map(
    (vendor) => new FakeAdapter({ vendor, skipAuthChecks: true, script: { turns: [[]] } }),
  );
}

/** The files of setupTestService and a service started on them. */
export async function startTestService(options: TestServiceOptions = {}) {
  const setup = await setupTestService(options);
  return { ...setup, service: await setup.start() };
}

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

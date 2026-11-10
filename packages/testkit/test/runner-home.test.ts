import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { CREDENTIALS_FILE, CredentialsSchema, type Vendor } from '@agflow/core';
import { loadRunnerConfig } from '@agflow/runner/src/config';
import { readMachineId } from '@agflow/runner/src/service/machine';
import { VENDOR_PINS, vendorBinary } from '@agflow/runner/src/vendor/pins';
import { claudeTestEnv } from '../src/anthropic/env';
import { codexTestConfig } from '../src/codex/test-config';
import { E2E_PLATFORM } from '../src/harness/env';
import { E2E_HUB_TIMINGS } from '../src/harness/hub-process';
import { processesInDir } from '../src/harness/proc';
import {
  E2E_RUNNER_TIMINGS,
  prepareRunnerHome,
  type RunnerHome,
  startRunnerProcess,
} from '../src/harness/runner-process';

const dirs: string[] = [];
const homes: RunnerHome[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.remove();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join('/tmp', prefix));
  dirs.push(dir);
  return dir;
}

const PINS = VENDOR_PINS[E2E_PLATFORM];
if (!PINS) throw new Error(`no ${E2E_PLATFORM} pins`);

const PROXY_URL = 'http://127.0.0.1:9';
// Stand-ins for the scripted servers: prepareRunnerHome only writes their addresses.
const MODELS = {
  proxyUrl: PROXY_URL,
  claudeEnv: claudeTestEnv({ baseUrl: 'http://127.0.0.1:7', proxyUrl: PROXY_URL }),
  codexConfig: codexTestConfig('http://127.0.0.1:8/v1'),
};

/** Stand-ins for the located binaries: a claude file and a codex version directory with bin/codex. */
function fakeBinaries(): Record<Vendor, string> {
  const root = tmpDir('agf-bins-');
  const claude = join(root, 'claude-bin', 'claude');
  const codex = join(root, 'codex-tree', 'bin', 'codex');
  for (const file of [claude, codex]) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '#!/bin/sh\nexit 0\n');
    chmodSync(file, 0o755);
  }
  return { claude, codex };
}

async function prepare(vendors: Vendor[], name = 'alice-mac'): Promise<RunnerHome> {
  const home = await prepareRunnerHome({
    dir: join(tmpDir('agf-rh-'), 'alice'),
    name,
    credentials: { hubUrl: 'http://127.0.0.1:4000', token: 'agf_cli_token', user: 'alice' },
    vendors,
    binaries: fakeBinaries(),
    models: MODELS,
  });
  homes.push(home);
  return home;
}

describe('E2E_RUNNER_TIMINGS', () => {
  test('push WIP within the WIP grace the hub sends, a third of its runner lease (X-11)', () => {
    expect(E2E_RUNNER_TIMINGS.wip).toBeLessThan(E2E_HUB_TIMINGS.runnerLeaseMs / 3);
  });
});

describe('prepareRunnerHome', () => {
  test('writes a runner.json that loadRunnerConfig accepts in test mode, with the e2e settings', async () => {
    const home = await prepare(['claude', 'codex']);
    // The short timings need test mode, which the runner process gets.
    expect(() => loadRunnerConfig(home.paths.config, {})).toThrow('timings.wip');
    expect(home.env.AGFLOW_TEST).toBe('1');
    const config = loadRunnerConfig(home.paths.config, { AGFLOW_TEST: '1' });
    expect(config).toEqual(home.config);
    expect(config.name).toBe('alice-mac');
    expect(config.machineId).toBe(await readMachineId());
    expect(config.test).toEqual({
      claudeEnv: MODELS.claudeEnv,
      codexConfig: MODELS.codexConfig,
      skipAuthChecks: true,
      allowShortTimings: true,
    });
    for (const [key, value] of Object.entries(E2E_RUNNER_TIMINGS)) {
      expect(config.timings[key as keyof typeof config.timings]).toEqual(value);
    }
    expect(config.keepAwake).toBe('off');
    expect(config.capacity).toBe(2);
    expect(config.minFreeGb).toBeLessThan(1);
    expect(config.commitIdentity).toEqual({ name: 'alice', email: 'alice@agflow.invalid' });
    expect(config.capturedPath).toBe(home.env.PATH ?? '');
    expect(config.capturedPath.split(':')).toEqual(
      [...new Set((process.env.PATH ?? '').split(':'))].filter((entry) => entry.startsWith('/')),
    );
    expect(config.connectivity).toEqual({
      HTTPS_PROXY: PROXY_URL,
      HTTP_PROXY: PROXY_URL,
      ALL_PROXY: PROXY_URL,
      NO_PROXY: '127.0.0.1,localhost,::1',
    });
    // Both vendor homes exist inside the runner home, at their real paths.
    const real = realpathSync(home.agflowHome);
    for (const vendor of ['claude', 'codex'] as const) {
      const path = config.homes[vendor] ?? '';
      expect(path.startsWith(`${real}/`)).toBe(true);
      expect(realpathSync(path)).toBe(path);
    }
  });

  test("gives the runner its own AGFLOW_HOME, CLI config directory and HOME, and no developer's variables", async () => {
    const home = await prepare(['claude']);
    expect(home.env).toMatchObject({
      AGFLOW_HOME: home.agflowHome,
      AGFLOW_CONFIG_DIR: home.configDir,
      HOME: home.home,
      AGFLOW_TEST: '1',
    });
    for (const dir of [home.agflowHome, home.configDir, home.home]) {
      expect(dir.startsWith(`${home.dir}/`)).toBe(true);
      expect(existsSync(dir)).toBe(true);
    }
    expect(home.paths.home).toBe(home.agflowHome);
    // Only what the runner reads: no inherited AGFLOW_*, GIT_* or vendor keys.
    const system = ['PATH', 'HOME', 'TMPDIR', 'USER', 'LOGNAME', 'LANG', 'SHELL'];
    const unexpected = Object.keys(home.env).filter((name) => !system.includes(name) && !name.startsWith('LC_'));
    expect(unexpected.sort()).toEqual(['AGFLOW_CONFIG_DIR', 'AGFLOW_HOME', 'AGFLOW_TEST']);
  });

  test("keeps only the absolute entries of the test process's PATH, for runner.json and the runner process", async () => {
    const saved = process.env.PATH;
    // readMachineId runs ioreg from /usr/sbin.
    process.env.PATH = './node_modules/.bin:/usr/bin:.::/bin:bin:/usr/sbin:/usr/bin';
    try {
      const home = await prepare(['claude']);
      expect(home.config.capturedPath).toBe('/usr/bin:/bin:/usr/sbin');
      expect(home.env.PATH).toBe('/usr/bin:/bin:/usr/sbin');
    } finally {
      process.env.PATH = saved;
    }
  });

  test('links the located binary of each offered vendor where vendorBinary looks, and leaves an omitted one out', async () => {
    for (const offered of ['claude', 'codex'] as const) {
      const home = await prepareRunnerHome({
        dir: join(tmpDir('agf-rh-'), 'bob'),
        name: 'bob-mac',
        credentials: { hubUrl: 'http://127.0.0.1:4000', token: 'agf_cli_token', user: 'bob' },
        vendors: [offered],
        binaries: fakeBinaries(),
        models: MODELS,
      });
      homes.push(home);
      const omitted: Vendor = offered === 'claude' ? 'codex' : 'claude';
      const binary = (vendor: Vendor) => join(home.paths.runner, vendorBinary(vendor, PINS[vendor].version));
      expect(realpathSync(binary(offered))).toBe(realpathSync(home.binaries[offered] ?? ''));
      expect(existsSync(binary(omitted))).toBe(false);
      expect(existsSync(dirname(binary(omitted)))).toBe(false);
      expect(home.vendors).toEqual([offered]);
    }
  });

  test('refuses an offered vendor without a located binary, and a codex binary outside a bin directory', async () => {
    const dir = join(tmpDir('agf-rh-'), 'carol');
    const options = {
      dir,
      name: 'carol-mac',
      credentials: { hubUrl: 'http://127.0.0.1:4000', token: 'agf_cli_token', user: 'carol' },
      models: MODELS,
    };
    await expect(prepareRunnerHome({ ...options, vendors: ['codex'], binaries: {} })).rejects.toThrow(
      'no located codex binary',
    );
    const loose = join(tmpDir('agf-bins-'), 'codex');
    writeFileSync(loose, '');
    await expect(prepareRunnerHome({ ...options, vendors: ['codex'], binaries: { codex: loose } })).rejects.toThrow(
      'bin/codex',
    );
  });

  test("writes credentials.json in the runner's config directory with mode 0600, parsed by CredentialsSchema", async () => {
    const home = await prepare(['codex']);
    const file = join(home.configDir, CREDENTIALS_FILE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(CredentialsSchema.parse(JSON.parse(readFileSync(file, 'utf8')))).toEqual({
      hubUrl: 'http://127.0.0.1:4000',
      token: 'agf_cli_token',
      user: 'alice',
    });
  });

  test("names the attempt's clone path under the runner's work directory", async () => {
    const home = await prepare(['claude']);
    const clone = home.clonePath('T-1-a1');
    expect(clone.startsWith(`${home.paths.work}/e2e-`)).toBe(true);
    expect(clone.endsWith('/T-1-a1')).toBe(true);
  });

  test('remove() deletes the home, read-only agent tools directories included', async () => {
    const home = await prepare(['claude']);
    const tools = home.paths.agentTools('e2e-0123456789', 'T-1-a1');
    mkdirSync(join(tools, 'bin'), { recursive: true });
    writeFileSync(join(tools, 'bin', 'gh'), '');
    chmodSync(join(tools, 'bin'), 0o555);
    chmodSync(tools, 0o555);
    home.remove();
    expect(existsSync(home.dir)).toBe(false);
  });
});

describe('startRunnerProcess', () => {
  const hasLsof = Bun.which('lsof') !== null;

  // macOS only: lsof finds what runs in the home, and the runner's sandbox probe needs macOS.
  test.skipIf(process.platform !== 'darwin' || !hasLsof)(
    'a start that times out leaves nothing of the runner running',
    async () => {
      // A hub that answers the project's status and refuses every link, so the runner keeps retrying it.
      const hub = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        fetch: (request) =>
          new URL(request.url).pathname === '/api/status'
            ? Response.json({ project: { name: 'e2e', repo: '/nowhere' } })
            : new Response('no', { status: 503 }),
      });
      try {
        const home = await prepareRunnerHome({
          dir: join(tmpDir('agf-rs-'), 'dave'),
          name: 'dave-mac',
          credentials: { hubUrl: `http://127.0.0.1:${hub.port}`, token: 'agf_cli_token', user: 'dave' },
          vendors: [],
          binaries: {},
          models: MODELS,
        });
        homes.push(home);
        await expect(startRunnerProcess(home, { timeoutMs: 8_000 })).rejects.toThrow('did not start within 8000 ms');
        expect(await processesInDir(home.dir)).toEqual([]);
      } finally {
        hub.stop(true);
      }
    },
    60_000,
  );
});

import { afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadRunnerConfig, saveRunnerConfig } from '@agflow/runner/src/config';
import { runnerPaths } from '@agflow/runner/src/paths';
import { startControlServer } from '@agflow/runner/src/service/control';
import { type RunnerService, startRunnerService } from '@agflow/runner/src/service/host';
import { installRefusal, plistPath } from '@agflow/runner/src/service/launchd';
import { acquireRunnerLock } from '@agflow/runner/src/service/lock';
import { defaultExec, type Exec } from '@agflow/runner/src/service/system';
import { type PlatformPins, VENDOR_PINS, vendorBinary } from '@agflow/runner/src/vendor/pins';
import { fixtureCliVersion } from '@agflow/runner/test/fixture';
import { afterThisTest, cleanupRunnerSetups, tempDir } from '@agflow/runner/test/runner-setup';
import {
  type ExecCall,
  fakePrepSandbox,
  fakeServiceAdapters,
  fakeServiceOperations,
  localRegistry,
  packTarball,
  startOriginHub,
} from '@agflow/runner/test/service-helpers';
import { parseArgs } from '../src/args';
import { deleteCredentials, saveCredentials } from '../src/credentials';
import { HubClient } from '../src/hub-client';
import { runnerCommand } from '../src/runner-command';
import { type Prompt, runnerSetup, type RunnerSetupDeps } from '../src/runner-setup';
import { shellQuote } from '../src/self';

setDefaultTimeout(60_000);
beforeEach(() => {
  for (const name of ['AGFLOW_HOME', 'AGFLOW_CONFIG_DIR']) {
    const previous = process.env[name];
    process.env[name] = tempDir('agf-setup-env-');
    afterThisTest(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
});
afterEach(cleanupRunnerSetups);

const machineId = '12345678-1234-1234-1234-123456789abc';
const checkNames = ['hub', 'git ls-remote', 'wip push', 'claude', 'codex', 'dependency preparation', 'sleep'];
interface VendorCall {
  vendor: string;
  argv: string[];
  env: Record<string, string>;
}

async function fixture(options: { failCheck?: boolean; noBootstrap?: boolean } = {}) {
  const root = realpathSync(mkdtempSync('/tmp/agf-su-'));
  afterThisTest(() => rmSync(root, { recursive: true, force: true }));
  const paths = runnerPaths(join(root, 'agflow'));
  const dir = join(root, 'cli');
  const home = join(root, 'owner');
  mkdirSync(home);
  const hub = await startOriginHub();
  saveCredentials(hub.credentials, dir);
  const log = join(root, 'vendor-calls.jsonl');
  const cli = (vendor: 'claude' | 'codex') => {
    const source = `
const fs = require('node:fs');
const argv = process.argv.slice(1);
const vendor = ${JSON.stringify(vendor)};
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ vendor, argv, env: process.env }) + '\\n');
if (argv[0] === '--version') {
  console.log(vendor === 'claude' ? '2.1.285 (Claude Code)' : 'codex-cli 0.159.2');
  process.exit(0);
}
const home = vendor === 'claude' ? process.env.CLAUDE_CONFIG_DIR : process.env.CODEX_HOME;
const marker = home + '/signed-in';
if (JSON.stringify(argv) === JSON.stringify(vendor === 'claude' ? ['auth', 'login', '--claudeai'] : ['login'])) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(marker, 'ok');
  process.exit(0);
}
if (JSON.stringify(argv) !== JSON.stringify(vendor === 'claude' ? ['auth', 'status', '--json'] : ['login', 'status'])) {
  process.exit(99);
}
const ok = fs.existsSync(marker);
console.log(vendor === 'claude' ? JSON.stringify({ loggedIn: ok, authMethod: 'claude.ai', subscriptionType: 'max' })
  : ok ? 'Logged in using ChatGPT' : 'Not logged in');
process.exit(ok ? 0 : 1);
`;
    return `#!/bin/sh\nexec ${shellQuote(process.execPath)} -e ${shellQuote(source)} -- "$@"\n`;
  };
  const claude = cli('claude');
  const claudeTar = await packTarball({ claude: { content: claude } });
  const tree = VENDOR_PINS['darwin-arm64']!.codex.tree;
  const codexTar = await packTarball({
    [`${tree}/bin/codex`]: { content: cli('codex'), mode: 0o755 },
    [`${tree}/bin/codex-code-mode-host`]: { content: 'fake host', mode: 0o755 },
    [`${tree}/codex-path/rg`]: { content: 'fake rg', mode: 0o755 },
  });
  const pins: PlatformPins = {
    claude: {
      ...VENDOR_PINS['darwin-arm64']!.claude,
      integrity: claudeTar.integrity,
      sha256: createHash('sha256').update(claude).digest('hex'),
    },
    codex: { ...VENDOR_PINS['darwin-arm64']!.codex, integrity: codexTar.integrity },
  };
  const registry = localRegistry([
    { ...pins.claude, bytes: claudeTar.bytes },
    { ...pins.codex, bytes: codexTar.bytes },
  ]);
  afterThisTest(() => registry.stop());
  const env = {
    HOME: home,
    PATH: '/usr/bin:/bin',
    SHELL: '/fake/shell',
    AGFLOW_HOME: paths.home,
    AGFLOW_CONFIG_DIR: dir,
    AGFLOW_NPM_REGISTRY: registry.url,
  };
  const calls: ExecCall[] = [];
  let service: RunnerService | undefined;
  afterThisTest(async () => {
    if (service) {
      await service.stop('test cleanup');
      await service.exited;
    }
  });
  const exec: Exec = async (argv, commandOptions) => {
    calls.push(structuredClone({ argv, options: commandOptions }));
    const ok = { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    if (argv[0] === 'ioreg') return { ...ok, stdout: `"IOPlatformUUID" = "${machineId}"` };
    if (argv[0] === 'scutil') return { ...ok, stdout: 'Test Mac\n' };
    if (argv[0] === 'git') return { ...ok, stdout: argv.at(-1) === 'user.name' ? 'Owner' : 'owner@example.test' };
    if (argv[0] === env.SHELL) {
      const markers = argv.at(-1)!.match(/AGFLOW_ENV_(?:START|END)_[a-f0-9-]+/g)!;
      return {
        ...ok,
        stdout: `${markers[0]}\0PATH=/captured/bin:/usr/bin:/bin\0HTTPS_PROXY=http://proxy.test\0${markers[1]}\0`,
      };
    }
    if (argv[0] === 'launchctl') {
      if (argv[1] === 'print') return { ...ok, exitCode: service ? 0 : 1 };
      if (argv[1] === 'bootout' && service) {
        await service.stop('bootout');
        await service.exited;
        service = undefined;
      }
      if (argv[1] === 'bootstrap' && !options.noBootstrap) {
        service = await startRunnerService({
          ...fakeServiceOperations(),
          paths,
          configDir: dir,
          mode: 'service',
          agflow: { command: process.execPath, args: [] },
          machineId: async () => machineId,
          adapters: fakeServiceAdapters(),
          cliVersion: fixtureCliVersion,
          terminal: () => {},
          ...(options.failCheck
            ? {
                prepSandbox: fakePrepSandbox({
                  initialize: async () => {
                    throw new Error('sandbox broken');
                  },
                }),
              }
            : {}),
        });
      }
      return ok;
    }
    if (argv[0] === 'tar' || argv[0]!.startsWith(paths.vendor + '/')) return defaultExec(argv, commandOptions);
    throw new Error(`unexpected command: ${argv.join(' ')}`);
  };
  const out: string[] = [];
  const err: string[] = [];
  const io = { out: (text: string) => void out.push(text), err: (text: string) => void err.push(text) };
  const deps: Partial<RunnerSetupDeps> = {
    dir,
    paths,
    env,
    exec,
    pins,
    platform: 'darwin-arm64',
    machinePlatform: 'darwin',
    home,
    uid: 501,
    socketTimeoutMs: 5_000,
    checksTimeoutMs: 50_000,
    pollMs: 10,
    prompt: {
      ask: async () => {
        throw new Error('--yes must not prompt');
      },
    },
  };
  const run = (flags = ['--yes', '--no-service'], overrides: Partial<RunnerSetupDeps> = {}) =>
    runnerSetup(parseArgs(['runner', 'setup', ...flags]), io, { ...deps, ...overrides });
  const vendorCalls = (): VendorCall[] =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      : [];
  const logins = () =>
    vendorCalls().filter((call) => call.argv.join(' ') === 'auth login --claudeai' || call.argv.join(' ') === 'login');
  return { root, paths, dir, home, hub, pins, registry, env, calls, out, err, io, deps, run, logins };
}

function answers(...values: string[]): Prompt {
  return { ask: async (_question, fallback) => values.shift() || fallback };
}

test('fresh setup installs pins, logs into the runner homes and prints every service check', async () => {
  const f = await fixture();
  expect(await runnerCommand(parseArgs(['runner', 'setup', '--yes']), f.io, { setup: f.deps })).toBe(0);
  const config = loadRunnerConfig(f.paths.config);
  expect(config.runnerKey).toMatch(/^rk_[a-f0-9]{32}$/);
  expect(config.machineId).toBe(machineId);
  expect(config.name).toBe('Test Mac');
  expect(config.capacity).toBe(2);
  expect(config.capturedPath).toBe('/captured/bin:/usr/bin:/bin');
  expect(config.connectivity.HTTPS_PROXY).toBe('http://proxy.test');
  expect(config.commitIdentity).toEqual({ name: 'Owner', email: 'owner@example.test' });
  expect(config.homes).toEqual({ claude: f.paths.homes.claude, codex: f.paths.homes.codex });
  expect(statSync(f.paths.config).mode & 0o777).toBe(0o600);
  for (const vendor of ['claude', 'codex'] as const) {
    const binary = join(f.paths.runner, vendorBinary(vendor, f.pins[vendor].version));
    expect(existsSync(binary)).toBe(true);
    expect(f.out.join('')).toContain(binary);
  }
  expect(f.registry.requests).toHaveLength(2);
  const [claude, codex] = f.logins();
  expect(claude!.env.CLAUDE_CONFIG_DIR).toBe(config.homes.claude!);
  expect(claude!.env.HOME).toBe(f.home);
  expect(codex!.env.CODEX_HOME).toBe(config.homes.codex!);
  expect(codex!.env.HOME).toBe(f.paths.homes.codexUser);
  expect(existsSync(join(f.home, '.claude'))).toBe(false);
  expect(existsSync(join(f.home, '.codex'))).toBe(false);
  expect(f.calls.filter((call) => call.options?.interactive)).toHaveLength(2);
  const plist = plistPath({ home: f.home });
  expect(readFileSync(plist, 'utf8')).toContain(f.paths.home);
  expect(f.calls.some((call) => call.argv.join(' ') === `launchctl bootstrap gui/501 ${plist}`)).toBe(true);
  expect(f.out.join('')).toContain('gui/501/dev.agflow.runner');
  expect(
    f.out
      .join('')
      .split('\n')
      .filter((line) => /^(ok|warn|FAIL) /.test(line))
      .map((line) => line.replace(/^(ok|warn|FAIL) /, '').split(':')[0]),
  ).toEqual(checkNames);
  expect(f.out.join('')).toContain(`signed in to ${f.hub.url} as alice`);
  expect(f.out.join('')).not.toContain(f.hub.token);
  expect(f.err).toEqual([]);
});

test('reruns preserve the key and unchanged file, skip valid logins, and honor --relogin', async () => {
  const f = await fixture();
  await f.run();
  const before = statSync(f.paths.config);
  const key = loadRunnerConfig(f.paths.config).runnerKey;
  await f.run();
  expect(loadRunnerConfig(f.paths.config).runnerKey).toBe(key);
  expect(statSync(f.paths.config).mtimeMs).toBe(before.mtimeMs);
  expect(f.logins()).toHaveLength(2);
  expect(f.out.join('')).toContain('claude: signed in (max)');
  expect(f.out.join('')).toContain('codex: signed in');
  await f.run(['--yes', '--relogin', '--no-service']);
  expect(f.logins()).toHaveLength(4);
  expect(f.registry.requests).toHaveLength(2);
});

test('a copied runner.json gets this machine facts, a new key, and the first setup name and capacity', async () => {
  const f = await fixture();
  await f.run();
  const old = loadRunnerConfig(f.paths.config);
  saveRunnerConfig(f.paths.config, { ...old, machineId: 'another-mac', name: 'Copied name', capacity: 4 });
  await f.run();
  const next = loadRunnerConfig(f.paths.config);
  expect(next.runnerKey).not.toBe(old.runnerKey);
  expect(next.machineId).toBe(machineId);
  expect(next.name).toBe('Test Mac');
  expect(next.capacity).toBe(2);
  expect(f.out.join('')).toContain('new runner key');
  expect(f.out.join('')).toContain('another Mac');
});

for (const kind of ['missing', 'refused', 'unreachable'] as const) {
  test(`${kind} credentials or hub stop at sign-in without runner writes`, async () => {
    const f = await fixture();
    if (kind === 'missing') deleteCredentials(f.dir);
    if (kind === 'refused') saveCredentials({ ...f.hub.credentials, token: 'unknown-token' }, f.dir);
    const overrides =
      kind === 'unreachable'
        ? {
            fetch: async () => {
              throw new Error('offline');
            },
          }
        : {};
    await expect(f.run(undefined, overrides)).rejects.toThrow(
      kind === 'unreachable'
        ? 'cannot reach the agflow hub'
        : `run agflow login --hub ${kind === 'missing' ? '<url>' : f.hub.url}`,
    );
    expect(existsSync(f.paths.runner)).toBe(false);
    expect(f.calls).toEqual([]);
    expect(f.registry.requests).toEqual([]);
  });
}

test('a failing check exits 1 after printing all checks', async () => {
  const f = await fixture({ failCheck: true });
  expect(await f.run(['--yes'])).toBe(1);
  expect(
    f.out
      .join('')
      .split('\n')
      .filter((line) => /^(ok|warn|FAIL) /.test(line))
      .map((line) => line.replace(/^(ok|warn|FAIL) /, '').split(':')[0]),
  ).toEqual(checkNames);
  expect(f.out.join('')).toContain('sandbox broken');
});

test('--no-service stops after login with the foreground start instruction', async () => {
  const f = await fixture();
  expect(await f.run()).toBe(0);
  expect(f.logins()).toHaveLength(2);
  expect(f.out.join('')).toContain('agflow runner start');
  expect(f.calls.some((call) => call.argv[0] === 'launchctl')).toBe(false);
});

test('test mode refuses service installation and explains the foreground flow', async () => {
  const f = await fixture();
  const env = { ...f.env, AGFLOW_TEST: '1' };
  expect(await f.run(['--yes'], { env })).toBe(1);
  expect(f.out.join('')).toContain(installRefusal(loadRunnerConfig(f.paths.config), env)!);
  expect(f.out.join('')).toContain('agflow runner setup --no-service');
  expect(f.out.join('')).toContain('agflow runner start');
  expect(f.calls.some((call) => call.argv[0] === 'launchctl')).toBe(false);
});

test('interactive answers set name and capacity; later capacity edits preserve the confirmed snapshot', async () => {
  const f = await fixture();
  await f.run(['--no-service'], { prompt: answers('My laptop', '5') });
  const initial = loadRunnerConfig(f.paths.config);
  expect(initial.name).toBe('My laptop');
  expect(initial.capacity).toBe(5);
  await f.run(['--no-service'], { prompt: answers('New name', '7') });
  const edited = loadRunnerConfig(f.paths.config);
  expect(edited.runnerKey).toBe(initial.runnerKey);
  expect(edited.name).toBe('New name');
  expect(edited.capacity).toBe(7);
  expect(edited.confirmedSettings).toEqual(initial.confirmedSettings);
});

for (const capacity of ['0', '17', '2.5', 'many']) {
  test(`invalid capacity ${capacity} fails without writing runner.json`, async () => {
    const f = await fixture();
    await expect(f.run(['--no-service'], { prompt: answers('Name', capacity) })).rejects.toThrow(
      'whole number from 1 to 16',
    );
    expect(existsSync(f.paths.config)).toBe(false);
    expect(f.registry.requests).toEqual([]);
  });
}

test('a running runner keeps ownership of runner.json and setup asks nothing', async () => {
  const f = await fixture();
  await f.run();
  const before = readFileSync(f.paths.config, 'utf8');
  const lock = await acquireRunnerLock(f.paths, { mode: 'foreground' });
  afterThisTest(() => lock.release());
  expect(await f.run(['--no-service'])).toBe(0);
  expect(readFileSync(f.paths.config, 'utf8')).toBe(before);
  expect(f.out.join('')).toContain(`pid ${process.pid}`);
  expect(f.out.join('')).toContain('change capacity on the hub');
});

test('socket timeout points to status and the runner log', async () => {
  const f = await fixture({ noBootstrap: true });
  await expect(f.run(['--yes'], { socketTimeoutMs: 50 })).rejects.toThrow('agflow runner status');
  await expect(f.run(['--yes'], { socketTimeoutMs: 50 })).rejects.toThrow(f.paths.runnerLog);
});

test('checks retry startup route errors within the socket deadline', async () => {
  const f = await fixture({ noBootstrap: true });
  // This test exercises socket startup, so vendor checks stay in-process on every host platform.
  const exec: Exec = async (argv, options) => {
    if (!argv[0]!.startsWith(f.paths.vendor + '/')) return f.deps.exec!(argv, options);
    const vendor = argv[0]!.endsWith('/claude') ? 'claude' : 'codex';
    const command = argv.slice(1).join(' ');
    let stdout: string;
    if (command === '--version') {
      stdout =
        vendor === 'claude' ? `${f.pins.claude.version} (Claude Code)` : `codex-cli ${f.pins.codex.version}`;
    } else if (vendor === 'claude' && command === 'auth status --json') {
      stdout = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' });
    } else if (vendor === 'codex' && command === 'login status') {
      stdout = 'Logged in using ChatGPT';
    } else {
      throw new Error(`unexpected vendor command: ${argv.join(' ')}`);
    }
    return { exitCode: 0, stdout, stderr: '', timedOut: false };
  };
  await f.run(undefined, { exec });
  expect(f.logins()).toEqual([]);
  const lock = await acquireRunnerLock(f.paths, { mode: 'foreground' });
  afterThisTest(() => lock.release());
  let tries = 0;
  const server = startControlServer({
    lock,
    paths: f.paths,
    routes: {
      'GET /health': () => ({}),
      'POST /checks': () => {
        if (++tries < 3) throw new Error('the runner is starting; try again');
        return [{ name: 'ready', status: 'pass', detail: 'started' }];
      },
    },
  });
  afterThisTest(() => server.stop());
  expect(await f.run(['--yes'], { exec })).toBe(0);
  expect(tries).toBe(3);
  expect(f.out.join('')).toContain('started');
  expect(f.logins()).toEqual([]);
});

test('runnerWhoami validates the response schema', async () => {
  const client = new HubClient({ baseUrl: 'http://fake', fetch: async () => Response.json({ user: 42 }) });
  await expect(client.runnerWhoami()).rejects.toThrow();
});

for (const input of ['First\nSecond\n', '\n']) {
  test(`terminal prompt preserves piped answers and accepts EOF defaults (${JSON.stringify(input)})`, async () => {
    const module = join(import.meta.dir, '..', 'src', 'runner-setup.ts');
    const script = `
const { terminalPrompt } = await import(${JSON.stringify(module)});
const prompt = terminalPrompt();
try {
  const answers = [];
  for (const question of ['one', 'two', 'three']) answers.push(await prompt.ask(question, 'fallback'));
  console.log(JSON.stringify(answers));
} finally { prompt.close(); }
`;
    const child = Bun.spawn([process.execPath, '-e', script], {
      stdin: new Response(input),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual(
      input.startsWith('First') ? ['First', 'Second', 'fallback'] : ['fallback', 'fallback', 'fallback'],
    );
    expect(err).toContain('one [fallback]:');
    expect(err).toContain('three [fallback]:');
  });
}

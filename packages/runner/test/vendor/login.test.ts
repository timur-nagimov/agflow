import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONNECTIVITY_VARS, RunnerConfigSchema, vendorHomes } from '../../src/config';
import { runnerPaths } from '../../src/paths';
import {
  claudeLoginStatus,
  codexLoginStatus,
  loginClaude,
  loginCodex,
  logoutClaude,
  logoutCodex,
  vendorCliEnv,
} from '../../src/vendor/login';
import { VENDOR_PINS, vendorBinary } from '../../src/vendor/pins';
import { fakeVendorCli, recordingExec, type VendorCliCall } from '../service-helpers';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const version = '1.2.3';
const subscription = { loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' };
const claudeStatus = ['auth', 'status', '--json'];
const codexStatus = ['login', 'status'];

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agf-login-')));
  dirs.push(root);
  const paths = runnerPaths(root);
  const config = RunnerConfigSchema.parse({
    runnerKey: 'rk_test',
    machineId: 'machine',
    name: 'laptop',
    homes: { claude: join(root, 'saved-claude'), codex: join(root, 'saved-codex') },
    capturedPath: '/captured/bin:/usr/bin:/bin',
    connectivity: Object.fromEntries(CONNECTIVITY_VARS.map((name) => [name, `saved-${name}`])),
  });
  const base = {
    HOME: join(root, 'owner'),
    USER: 'owner',
    LOGNAME: 'owner',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'C',
    TERM: 'xterm-256color',
    SHELL: '/bin/sh',
    PATH: '/wrong',
    HTTPS_PROXY: 'wrong',
    ANTHROPIC_API_KEY: 'secret',
    OPENAI_API_KEY: 'secret',
    CLAUDE_CODE_OAUTH_TOKEN: 'secret',
    CLAUDE_CODE_TMPDIR: '/wrong',
    CLAUDE_CONFIG_DIR: '/wrong',
    CODEX_HOME: '/wrong',
    CODEX_MANAGED_BY_NPM: '1',
    NODE_OPTIONS: '--wrong',
    NODE_USE_SYSTEM_CA: '0',
    SSH_AUTH_SOCK: '/secret',
    AGFLOW_AGENT_TOKEN: 'secret',
  };
  return { root, paths, config, base, options: { version, base } };
}

function isolated(calls: VendorCliCall[]) {
  expect(new Set(calls.map((call) => call.cwd)).size).toBe(calls.length);
  for (const call of calls) {
    expect(call.cwd).not.toBe(process.cwd());
    expect(call.entries).toEqual([]);
    expect(existsSync(call.cwd)).toBe(false);
  }
}

function environment(call: VendorCliCall, expected: Record<string, string>) {
  // The shell may add PWD, SHLVL and _; every supplied variable still has to match.
  expect(call.env).toMatchObject(expected);
  for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'NODE_OPTIONS', 'SSH_AUTH_SOCK', 'AGFLOW_AGENT_TOKEN']) {
    expect(call.env[name]).toBeUndefined();
  }
  expect(Object.keys(call.env).filter((name) => name.startsWith('CLAUDE_CODE_'))).toEqual([]);
  expect(Object.keys(call.env).filter((name) => name.startsWith('CODEX_'))).toEqual(
    expected.CODEX_HOME ? ['CODEX_HOME'] : [],
  );
}

describe('vendorCliEnv', () => {
  test('builds only the allowlist, with stored homes and captured connectivity', () => {
    const { config, paths, base } = fixture();
    const common = {
      USER: base.USER,
      LOGNAME: base.LOGNAME,
      LANG: base.LANG,
      LC_ALL: base.LC_ALL,
      TERM: base.TERM,
      SHELL: base.SHELL,
      PATH: config.capturedPath,
      ...config.connectivity,
      NODE_USE_SYSTEM_CA: '1',
      DISABLE_AUTOUPDATER: '1',
    };
    expect(vendorCliEnv('claude', config, paths, base)).toEqual({
      ...common,
      HOME: base.HOME,
      CLAUDE_CONFIG_DIR: config.homes.claude!,
    });
    expect(vendorCliEnv('codex', config, paths, base)).toEqual({
      ...common,
      HOME: paths.homes.codexUser,
      CODEX_HOME: config.homes.codex!,
    });
    expect(base.PATH).toBe('/wrong');
  });

  test('preserves stored path spelling and uses canonical layout homes when none were stored', () => {
    const { root, paths, config, base } = fixture();
    mkdirSync(join(root, 'actual'));
    symlinkSync(join(root, 'actual'), config.homes.claude!);
    expect(vendorCliEnv('claude', config, paths, base).CLAUDE_CONFIG_DIR).toBe(config.homes.claude!);
    config.homes = { claude: null, codex: null };
    const homes = vendorHomes(config, paths);
    expect(vendorCliEnv('claude', config, paths, base).CLAUDE_CONFIG_DIR).toBe(homes.claude);
    expect(vendorCliEnv('codex', config, paths, base).CODEX_HOME).toBe(homes.codex);
  });
});

describe('vendor logins', () => {
  test('Claude logs into claude.ai, then checks the subscription, in fresh empty directories', async () => {
    const { config, paths, options } = fixture();
    const fake = fakeVendorCli(paths, 'claude', version, [
      { argv: ['auth', 'login', '--claudeai'], result: {} },
      { argv: claudeStatus, result: { stdout: JSON.stringify(subscription) } },
    ]);
    await loginClaude(config, paths, options);
    expect(await claudeLoginStatus(config, paths, options)).toEqual({ ok: true, plan: 'max' });
    const calls = fake.calls();
    expect(calls.map((call) => call.argv)).toEqual([['auth', 'login', '--claudeai'], claudeStatus, claudeStatus]);
    isolated(calls);
    for (const call of calls) environment(call, vendorCliEnv('claude', config, paths, options.base));
  }, 20_000);

  test.each(['stdout', 'stderr'])(
    'Codex logs in and reads ChatGPT status from either stream with its own HOME: %s',
    async (stream) => {
      const { config, paths, options } = fixture();
      const fake = fakeVendorCli(paths, 'codex', version, [
        { argv: ['login'], result: {} },
        { argv: codexStatus, result: { [stream]: 'Logged in using ChatGPT\n' } },
      ]);
      await loginCodex(config, paths, options);
      expect(await codexLoginStatus(config, paths, options)).toEqual({ ok: true, plan: null });
      const calls = fake.calls();
      expect(calls.map((call) => call.argv)).toEqual([['login'], codexStatus, codexStatus]);
      isolated(calls);
      for (const call of calls) environment(call, vendorCliEnv('codex', config, paths, options.base));
    },
    20_000,
  );

  test.each(['claude', 'codex'] as const)(
    'interactive logins inherit stdio without a timeout; the status check captures output: %s',
    async (vendor) => {
      const { config, paths, options } = fixture();
      const fake = fakeVendorCli(paths, vendor, version, []);
      const args = vendor === 'claude' ? claudeStatus : codexStatus;
      const exec = recordingExec([
        {
          argv: [fake.binary, ...args],
          result: {
            stdout: vendor === 'claude' ? JSON.stringify(subscription) : 'Logged in using ChatGPT',
          },
        },
      ]);
      await (vendor === 'claude' ? loginClaude : loginCodex)(config, paths, { ...options, exec });
      expect(exec.calls[0].argv).toEqual([
        fake.binary,
        ...(vendor === 'claude' ? ['auth', 'login', '--claudeai'] : ['login']),
      ]);
      expect(exec.calls[0].options?.interactive).toBe(true);
      expect(exec.calls[0].options?.timeoutMs).toBeUndefined();
      expect(exec.calls[1].options?.interactive).not.toBe(true);
      for (const call of exec.calls) expect(existsSync(call.options!.cwd!)).toBe(false);
    },
    20_000,
  );

  test.each([
    [{ loggedIn: false, authMethod: 'none' }, 1, 'not logged in'],
    [{ loggedIn: true, authMethod: 'console' }, 0, 'Console (API) login'],
    [{ loggedIn: true, authMethod: 'api_key' }, 0, 'Console (API) login'],
    [{ ...subscription, subscriptionType: '' }, 0, 'subscription'],
    [{ ...subscription, subscriptionType: '  ' }, 0, 'subscription'],
    [{ ...subscription, subscriptionType: 123 }, 0, 'subscription'],
    [{ loggedIn: true, authMethod: 'claude.ai' }, 0, 'subscription'],
    [subscription, 2, 'exit code 2'],
  ] as const)('Claude refuses invalid status %j (exit %i): %s', async (data, exitCode, reason) => {
    const { config, paths, options } = fixture();
    const fake = fakeVendorCli(paths, 'claude', version, [
      { argv: ['auth', 'login', '--claudeai'], result: {} },
      { argv: claudeStatus, result: { stdout: JSON.stringify(data), exitCode } },
    ]);
    expect(await claudeLoginStatus(config, paths, options)).toMatchObject({
      ok: false,
      reason: expect.stringContaining(reason),
    });
    await expect(loginClaude(config, paths, options)).rejects.toThrow(reason);
    isolated(fake.calls());
  }, 20_000);

  test.each(['bad json\nsecond line', 'null', '[]', '"text"'])(
    'malformed Claude status is a failure with only the first output line: %s',
    async (output) => {
      const { config, paths, options } = fixture();
      fakeVendorCli(paths, 'claude', version, [{ argv: claudeStatus, result: { stdout: output } }]);
      const status = await claudeLoginStatus(config, paths, options);
      expect(status).toMatchObject({ ok: false, reason: expect.stringContaining(output.split('\n')[0]) });
      expect(JSON.stringify(status)).not.toContain('second line');
    },
    20_000,
  );

  test.each([
    ['Not logged in', 1, 'not logged in'],
    ['Logged in using an API key - sk-secret', 0, 'an API key login; agflow needs a ChatGPT login'],
    ['Logged in using ChatGPT', 2, 'exit code 2'],
    ['unexpected', 0, 'ChatGPT'],
  ] as const)('Codex rejects status %s (exit %i): %s', async (output, exitCode, reason) => {
    const { config, paths, options } = fixture();
    fakeVendorCli(paths, 'codex', version, [
      { argv: ['login'], result: {} },
      { argv: codexStatus, result: { stderr: output, exitCode } },
    ]);
    const status = await codexLoginStatus(config, paths, options);
    expect(status).toMatchObject({ ok: false, reason: expect.stringContaining(reason) });
    expect(JSON.stringify(status)).not.toContain('sk-secret');
    await expect(loginCodex(config, paths, options)).rejects.toThrow(reason);
  }, 20_000);

  test.each(['claude', 'codex'] as const)(
    'failed login commands report the exit code and do not probe status: %s',
    async (vendor) => {
      const { config, paths, options } = fixture();
      const fake = fakeVendorCli(paths, vendor, version, [
        {
          argv: vendor === 'claude' ? ['auth', 'login', '--claudeai'] : ['login'],
          result: { exitCode: 7 },
        },
      ]);
      await expect((vendor === 'claude' ? loginClaude : loginCodex)(config, paths, options)).rejects.toThrow(
        'exit code 7',
      );
      expect(fake.calls()).toHaveLength(1);
      isolated(fake.calls());
    },
    20_000,
  );

  test.each(['claude', 'codex'] as const)(
    'a missing binary names its path and directs setup; status reports the same reason: %s',
    async (vendor) => {
      const { config, paths, options } = fixture();
      const binary = join(paths.runner, vendorBinary(vendor, version));
      for (const reason of ['binary missing', binary, 'agflow runner setup']) {
        await expect((vendor === 'claude' ? loginClaude : loginCodex)(config, paths, options)).rejects.toThrow(reason);
        expect(
          await (vendor === 'claude' ? claudeLoginStatus : codexLoginStatus)(config, paths, options),
        ).toMatchObject({ ok: false, reason: expect.stringContaining(reason) });
      }
    },
    20_000,
  );

  test('reports unsupported platforms with the installer wording', async () => {
    const { config, paths, base } = fixture();
    expect(await claudeLoginStatus(config, paths, { base, platform: 'linux-x64' })).toEqual({
      ok: false,
      reason: 'unsupported platform linux-x64',
    });
  }, 20_000);

  test('defaults to the selected platform pin version', async () => {
    const { config, paths, base } = fixture();
    const pin = VENDOR_PINS['darwin-arm64']!;
    const fake = fakeVendorCli(paths, 'claude', pin.claude.version, [
      { argv: claudeStatus, result: { stdout: JSON.stringify(subscription) } },
    ]);
    expect(await claudeLoginStatus(config, paths, { base, platform: 'darwin-arm64' })).toEqual({
      ok: true, plan: 'max',
    });
    expect(fake.calls()).toHaveLength(1);
  }, 20_000);
});

describe('vendor logouts', () => {
  test.each(['claude', 'codex'] as const)(
    'uses the same isolated homes and directories and ignores failed commands: %s',
    async (vendor) => {
      const { config, paths, options } = fixture();
      const args = vendor === 'claude' ? ['auth', 'logout'] : ['logout'];
      const fake = fakeVendorCli(paths, vendor, version, [{ argv: args, result: { exitCode: 3 } }]);
      await (vendor === 'claude' ? logoutClaude : logoutCodex)(config, paths, options);
      const calls = fake.calls();
      expect(calls.map((call) => call.argv)).toEqual([args]);
      environment(calls[0], vendorCliEnv(vendor, config, paths, options.base));
      isolated(calls);
    },
    20_000,
  );

  test.each(['claude', 'codex'] as const)(
    'never throws, including missing binaries and execution exceptions, and cleans up: %s',
    async (vendor) => {
      const { config, paths, options } = fixture();
      const logout = vendor === 'claude' ? logoutClaude : logoutCodex;
      await logout(config, paths, options);
      fakeVendorCli(paths, vendor, version, []);
      let cwd = '';
      await logout(config, paths, {
        ...options,
        exec: async (_argv, opts) => {
          cwd = opts!.cwd!;
          throw new Error('cannot start');
        },
      });
      expect(cwd).not.toBe('');
      expect(existsSync(cwd)).toBe(false);
    },
    20_000,
  );
});

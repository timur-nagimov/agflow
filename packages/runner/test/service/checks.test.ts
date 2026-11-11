import { afterEach, expect, setDefaultTimeout, spyOn, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CREDENTIALS_FILE } from '@agflow/core';
import { gitIn, originRepo } from '@agflow/testkit';
import * as git from '../../src/git/run';
import { LinkClient } from '../../src/link';
import { parsePmsetSettings } from '../../src/ops/power';
import { type CheckResult, formatChecks, runServiceChecks } from '../../src/service/checks';
import { controlRequest } from '../../src/service/control';
import { readCliCredentials } from '../../src/service/credentials';
import { waitFor } from '../fixture';
import { startTestHub } from '../hub-fixture';
import { afterThisTest, cleanupRunnerSetups } from '../runner-setup';
import {
  fakePrepSandbox,
  fakeServiceAdapters,
  recordingExec,
  setupTestService,
  startTestService,
} from '../service-helpers';

afterEach(cleanupRunnerSetups);
setDefaultTimeout(60_000);

const names = ['hub', 'git ls-remote', 'wip push', 'claude', 'codex', 'dependency preparation', 'sleep'];
const pmset = (sleep: number) =>
  recordingExec([{ argv: ['pmset', '-g'], result: { stdout: `Currently in use:\n sleep ${sleep}\n` } }]);
const checks = (paths: Parameters<typeof controlRequest>[0]) =>
  controlRequest<CheckResult[]>(paths, 'POST', '/checks', undefined, { timeoutMs: 50_000 });
const result = (results: CheckResult[], name: string) => results.find((entry) => entry.name === name)!;

async function localService() {
  const origin = await originRepo({ 'README.md': '# checks\n' });
  afterThisTest(() => origin.remove());
  const hub = startTestHub({
    config: { projectName: 'checks', projectRepo: origin.path, wipRefPrefix: 'refs/checks/' },
  });
  afterThisTest(() => hub.stop());
  const exec = pmset(0);
  let initialized = 0;
  const sandbox = fakePrepSandbox({
    initialize: async () => {
      initialized++;
    },
  });
  const s = await startTestService({ hub, host: { exec, platform: 'darwin', prepSandbox: sandbox } });
  await waitFor(() => s.service.runner?.status().link === 'online');
  return { ...s, origin, exec, initialized: () => initialized };
}

test('POST /checks passes every check, reuses the sandbox, and removes the probe from a local origin', async () => {
  const s = await localService();
  const results = await checks(s.paths);
  expect(results.map((entry) => entry.name)).toEqual(names);
  expect(results.every((entry) => entry.status === 'pass')).toBe(true);
  expect(result(results, 'hub').detail).toContain('alice');
  const ref = `refs/checks/_probe/${s.service.runner!.status().runnerId}`;
  expect(result(results, 'wip push').detail).toContain(ref);
  expect(await gitIn(s.origin.path, ['for-each-ref', '--format=%(refname)', 'refs/checks/'])).toBe('');
  expect(s.initialized()).toBe(1);
  expect(s.exec.calls).toContainEqual({ argv: ['pmset', '-g'], options: { timeoutMs: 5_000 } });
  expect(formatChecks(results)).toContain('all passed');
  for (const entry of results) expect(entry.detail).not.toMatch(/[\r\n]/);
  expect(JSON.stringify(results)).not.toContain(s.hub.token);
});

test('a leftover probe is deleted on its current sha before a fenced creation and deletion', async () => {
  const s = await localService();
  const ref = `refs/checks/_probe/${s.service.runner!.status().runnerId}`;
  await gitIn(s.origin.path, ['update-ref', ref, s.origin.mainSha]);
  const run = git.runGit;
  const calls: { environment: git.GitEnvironment; args: string[] }[] = [];
  const observer = spyOn(git, 'runGit').mockImplementation(async (environment, args, options) => {
    calls.push({ environment, args });
    return run(environment, args, options);
  });
  afterThisTest(() => observer.mockRestore());
  expect(result(await checks(s.paths), 'wip push').status).toBe('pass');
  const pushes = calls.filter((call) => call.args.includes('push'));
  expect(pushes).toHaveLength(3);
  expect(pushes[0]!.args).toContain(`--force-with-lease=${ref}:${s.origin.mainSha}`);
  expect(pushes[0]!.args.at(-1)).toBe(`:${ref}`);
  expect(pushes[1]!.args).toContain(`--force-with-lease=${ref}:`);
  const sha = pushes[1]!.args.at(-1)!.split(':')[0]!;
  expect(pushes[2]!.args).toContain(`--force-with-lease=${ref}:${sha}`);
  expect(pushes[2]!.args.at(-1)).toBe(`:${ref}`);
  for (const call of pushes) {
    expect(call.environment.name).toBe('remote');
    expect(call.environment.env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(call.args[0]).toBe(`--git-dir=${s.service.runner!.vault.path}`);
    expect(call.args).toContain('--atomic');
  }
  expect(await gitIn(s.origin.path, ['for-each-ref', '--format=%(refname)', ref])).toBe('');
  expect(await gitIn(s.service.runner!.vault.path, ['show', '-s', '--format=%P', sha])).toBe('');
});

test('an unreachable origin fails both git checks with git stderr and still runs later checks', async () => {
  const s = await localService();
  s.origin.remove();
  const results = await checks(s.paths);
  const remote = result(results, 'git ls-remote');
  expect(remote.status).toBe('fail');
  expect(remote.detail).toContain('does not appear to be a git repository');
  expect(remote.detail).not.toMatch(/[\r\n]/);
  expect(result(results, 'wip push')).toEqual({ ...remote, name: 'wip push' });
  expect(result(results, 'sleep').status).toBe('pass');
});

test('a probe ref moved before deletion is preserved and the check fails', async () => {
  const s = await localService();
  const ref = `refs/checks/_probe/${s.service.runner!.status().runnerId}`;
  const run = git.runGit;
  let moved = false;
  const observer = spyOn(git, 'runGit').mockImplementation(async (environment, args, options) => {
    if (!moved && args.includes('push') && args.at(-1) === `:${ref}`) {
      moved = true;
      await gitIn(s.origin.path, ['update-ref', ref, s.origin.mainSha]);
    }
    return run(environment, args, options);
  });
  afterThisTest(() => observer.mockRestore());
  const results = await checks(s.paths);
  expect(moved).toBe(true);
  expect(result(results, 'wip push').status).toBe('fail');
  expect(result(results, 'wip push').detail).toContain('moved');
  expect(await gitIn(s.origin.path, ['rev-parse', ref])).toBe(s.origin.mainSha);
  expect(result(results, 'sleep').status).toBe('pass');
});

test('a remote that refuses probe creation reports its message and still runs later checks', async () => {
  const s = await localService();
  // Local receive policy refuses probe updates; keep the test entirely on the scratch origin.
  await gitIn(s.origin.path, ['config', 'receive.hideRefs', 'refs/checks/']);
  const results = await checks(s.paths);
  expect(result(results, 'git ls-remote').status).toBe('pass');
  expect(result(results, 'wip push').status).toBe('fail');
  expect(result(results, 'wip push').detail).toContain('hidden ref');
  expect(result(results, 'sleep').status).toBe('pass');
  expect(await gitIn(s.origin.path, ['for-each-ref', '--format=%(refname)', 'refs/checks/'])).toBe('');
});

test('concurrent check requests serialize their probes under the vault lock', async () => {
  const s = await localService();
  const results = await Promise.all([checks(s.paths), checks(s.paths)]);
  expect(results.every((entries) => entries.every((entry) => entry.status === 'pass'))).toBe(true);
  expect(await gitIn(s.origin.path, ['for-each-ref', '--format=%(refname)', 'refs/checks/'])).toBe('');
});

test('a refused CLI token is re-read and reports the login hint', async () => {
  const s = await localService();
  writeFileSync(join(s.configDir, CREDENTIALS_FILE), JSON.stringify({ ...s.hub.credentials, token: 'revoked-token' }));
  const results = await checks(s.paths);
  expect(result(results, 'hub')).toEqual({
    name: 'hub',
    status: 'fail',
    detail: `the hub refused the CLI sign-in; run agflow login --hub ${s.hub.url}`,
  });
  expect(result(results, 'wip push').status).toBe('pass');
});

test('a sign-in to another hub fails the hub check and names the runner hub', async () => {
  const s = await localService();
  const other = { ...s.hub.credentials, hubUrl: 'http://127.0.0.1:9' };
  writeFileSync(join(s.configDir, CREDENTIALS_FILE), JSON.stringify(other));
  const results = await checks(s.paths);
  expect(result(results, 'hub')).toEqual({
    name: 'hub',
    status: 'fail',
    detail: `the CLI is not signed in to the runner's hub; run agflow login --hub ${s.hub.url}`,
  });
});

test('unreachable whoami, failed preflights and a broken sandbox are isolated', async () => {
  const adapters = fakeServiceAdapters();
  const preflight = adapters[1]!.preflight.bind(adapters[1]);
  adapters[0]!.preflight = async () => {
    throw new Error('CLI crashed\ntry again');
  };
  adapters[1]!.preflight = async () => {
    const ready = await preflight();
    return { ...ready, facts: { ...ready.facts, ready: false, problem: 'codex_apps is enabled' } };
  };
  const s = await startTestService({
    host: {
      adapters,
      platform: 'darwin',
      exec: pmset(0),
      prepSandbox: fakePrepSandbox({
        initialize: async () => {
          throw new Error('sandbox unavailable');
        },
      }),
      fetch: async (input, init) => {
        if (String(input).endsWith('/api/runner/whoami')) throw new Error('connection refused');
        return fetch(input, init);
      },
    },
  });
  const results = await checks(s.paths);
  expect(result(results, 'hub')).toMatchObject({
    status: 'fail',
    detail: expect.stringContaining('connection refused'),
  });
  expect(result(results, 'claude')).toMatchObject({ status: 'fail', detail: 'CLI crashed try again' });
  expect(result(results, 'codex')).toMatchObject({ status: 'fail', detail: 'codex_apps is enabled' });
  expect(result(results, 'dependency preparation')).toMatchObject({ status: 'fail', detail: 'sandbox unavailable' });
  expect(result(results, 'sleep').status).toBe('pass');
});

for (const [minutes, status] of [
  [0, 'pass'],
  [1, 'warn'],
  [30, 'warn'],
  [31, 'pass'],
] as const) {
  test(`sleep ${minutes} is ${status}`, async () => {
    expect(parsePmsetSettings(` sleep ${minutes}\n`).sleepMinutes).toBe(minutes);
    const s = await startTestService();
    const results = await runServiceChecks({
      runner: s.service.runner!,
      welcome: Promise.resolve({ runnerId: 'sleep-test', wipRefPrefix: 'refs/checks/' }),
      credentials: () => readCliCredentials(s.configDir),
      hubUrl: s.hub.url,
      adapters: [],
      sandbox: fakePrepSandbox(),
      exec: pmset(minutes),
      platform: 'darwin',
    });
    const sleep = result(results, 'sleep');
    expect(sleep.status).toBe(status);
    if (status === 'warn') {
      expect(sleep.detail).toContain(`${minutes} minutes of idle`);
      expect(sleep.detail).toContain('agents stop');
      expect(sleep.detail).toContain('sudo pmset -c sleep 0');
    }
  });
}

for (const platform of ['darwin', 'linux'] as const) {
  test(`unknown sleep timer warns on ${platform}`, async () => {
    const exec = recordingExec([], { exitCode: 127, stderr: 'pmset missing' });
    const s = await startTestService({ host: { exec, platform } });
    expect(result(await checks(s.paths), 'sleep')).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining('sleep timer could not be read'),
    });
    if (platform === 'linux') expect(exec.calls).toHaveLength(0);
  });
}

// Hold link startup, leaving the real host and HTTP hub running before their first welcome.
function holdLink() {
  const start = LinkClient.prototype.start;
  let link: LinkClient;
  const gate = spyOn(LinkClient.prototype, 'start').mockImplementation(function (this: LinkClient) {
    link = this;
  });
  afterThisTest(() => gate.mockRestore());
  return () => {
    gate.mockRestore();
    start.call(link);
  };
}

test('POST /checks waits for the first welcome and then probes the welcome ref', async () => {
  const release = holdLink();
  const s = await startTestService({ host: { exec: pmset(0), platform: 'darwin', checksWelcomeTimeoutMs: 5_000 } });
  expect(s.service.runner!.status().runnerId).toBeNull();
  let answered = false;
  const pending = checks(s.paths).then((results) => {
    answered = true;
    return results;
  });
  try {
    await Bun.sleep(100);
    expect(answered).toBe(false);
  } finally {
    release();
  }
  const results = await pending;
  expect(results.every((entry) => entry.status === 'pass')).toBe(true);
  expect(result(results, 'wip push').detail).toContain(s.service.runner!.status().runnerId!);
});

test('POST /checks times out without welcome but runs all independent checks', async () => {
  holdLink();
  const s = await startTestService({ host: { exec: pmset(0), platform: 'darwin', checksWelcomeTimeoutMs: 40 } });
  const results = await checks(s.paths);
  expect(results.map((entry) => entry.name)).toEqual(names);
  expect(result(results, 'hub').status).toBe('fail');
  expect(result(results, 'hub').detail).toContain('no welcome from the hub within 0.04 s');
  expect(result(results, 'hub').detail).toContain('idle');
  expect(result(results, 'wip push').status).toBe('fail');
  expect(result(results, 'wip push').detail).toContain('skipped');
  expect(result(results, 'wip push').detail).toContain('runner id');
  expect(results.slice(3).every((entry) => entry.status === 'pass')).toBe(true);
});

test('POST /checks before the runner exists waits for startup and then runs the checks', async () => {
  // A short credentials probe needs test mode's short timings.
  const previous = process.env.AGFLOW_TEST;
  process.env.AGFLOW_TEST = '1';
  afterThisTest(() => {
    if (previous === undefined) delete process.env.AGFLOW_TEST;
    else process.env.AGFLOW_TEST = previous;
  });
  const s = await setupTestService({
    noCredentials: true,
    mode: 'service',
    config: { timings: { loginProbe: 50 } },
    host: { exec: pmset(0), platform: 'darwin', checksWelcomeTimeoutMs: 20_000 },
  });
  const starting = s.start();
  let answered = false;
  const pending = (async () => {
    await waitFor(() => existsSync(s.paths.socket));
    const results = await checks(s.paths);
    answered = true;
    return results;
  })();
  await Bun.sleep(200);
  expect(answered).toBe(false);
  writeFileSync(join(s.configDir, CREDENTIALS_FILE), JSON.stringify(s.hub.credentials), { mode: 0o600 });
  const results = await pending;
  expect(results.map((entry) => entry.name)).toEqual(names);
  expect(results.every((entry) => entry.status === 'pass')).toBe(true);
  expect((await starting).runner).not.toBeNull();
});

test('POST /checks names the login hold when the runner does not start within the budget', async () => {
  const s = await setupTestService({ noCredentials: true, mode: 'service', host: { checksWelcomeTimeoutMs: 50 } });
  const starting = s.start();
  try {
    await waitFor(() => existsSync(s.paths.socket));
    await expect(checks(s.paths)).rejects.toThrow(
      'the runner did not start within 0.05 s (needs_login: not signed in; run agflow login)',
    );
  } finally {
    await controlRequest(s.paths, 'POST', '/suspend');
    await starting;
  }
});

test('formatChecks keeps one line per check and summarizes failures and warnings', () => {
  const results: CheckResult[] = [
    { name: 'hub', status: 'pass', detail: 'alice' },
    { name: 'codex', status: 'fail', detail: 'login required' },
    { name: 'sleep', status: 'warn', detail: 'unknown' },
  ];
  const text = formatChecks(results);
  expect(text.split('\n')).toHaveLength(4);
  expect(text).toContain('ok hub: alice');
  expect(text).toContain('FAIL codex: login required');
  expect(text).toContain('warn sleep: unknown');
  expect(text).toContain('1 failed');
  expect(text).toContain('1 warnings');
  expect(formatChecks(results.slice(2))).toContain('1 warnings');
});

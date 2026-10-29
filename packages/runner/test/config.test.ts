import { afterEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunnerSettingsSchema } from '@agflow/core';
import {
  applySettingsEcho,
  CONNECTIVITY_VARS,
  DEFAULT_TIMINGS,
  isTestMode,
  loadRunnerConfig,
  localSettingsEdits,
  type RunnerConfig,
  RunnerConfigSchema,
  saveRunnerConfig,
  settingsOf,
  vendorHomes,
} from '../src/config';
import { runnerPaths } from '../src/paths';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const identity = { runnerKey: 'rk_test', machineId: 'MACHINE-1', name: 'laptop' };

/** Writes a runner.json with the given content and gives its path. */
function file(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'agflow-config-'));
  dirs.push(dir);
  const path = join(dir, 'runner.json');
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  return path;
}

function load(content: unknown, env: Record<string, string | undefined> = {}): RunnerConfig {
  return loadRunnerConfig(file(content), env);
}

function config(overrides: Record<string, unknown> = {}): RunnerConfig {
  return RunnerConfigSchema.parse({ ...identity, ...overrides });
}

const MIN = 60_000;

describe('loadRunnerConfig', () => {
  test('gives a runner.json with only its identity the section 12 defaults', () => {
    const loaded = load(identity);
    expect(loaded).toMatchObject({
      ...identity,
      capacity: 2,
      keepAwake: 'ac',
      draining: false,
      profile: 'standard',
      models: {
        claude: { lead: 'claude-opus-5-5', worker: 'claude-sonnet-5-5' },
        codex: { lead: 'gpt-6.1-sol', worker: 'gpt-6.1-sol' },
      },
      ceilings: { claude: { fiveHour: 0.85, weekly: 0.85 }, codex: { fiveHour: 0.85, weekly: 0.85 } },
      allowPaidUsage: { claude: false, codex: false },
      minFreeGb: 10,
      batteryDrainPercent: 20,
      homes: { claude: null, codex: null },
      connectivity: {},
    });
    expect(loaded.test).toBeUndefined();
    expect(loaded.timings).toEqual(DEFAULT_TIMINGS);
    expect(DEFAULT_TIMINGS).toEqual({
      heartbeat: 15_000,
      deadLink: 45_000,
      handshake: 10_000,
      backoffBase: 1_000,
      backoffCap: 30_000,
      tickGap: 5_000,
      continuationWait: 5_000,
      hold: 2 * MIN,
      handoff: 3 * MIN,
      wip: 10 * MIN,
      finalPush: 60_000,
      bridgePoll: 2_000,
      bridgePollMax: 3 * MIN,
      suspend: 45_000,
      wakeHold: 2 * MIN,
      crashLoopWindow: 10 * MIN,
      loginProbe: 60_000,
      stopInterrupt: 5_000,
      stopClose: 2_000,
      stopKill: 5_000,
      vendorErrorBackoff: { base: 30_000, cap: 10 * MIN },
      quotaUnknown: 30 * MIN,
      lateRetry: { base: 30_000, cap: 10 * MIN },
      submitRetry: 15 * MIN,
      prep: 15 * MIN,
      preflightEvery: 6 * 60 * MIN,
      eventRetention: 48 * 60 * MIN,
    });
  });

  test('a new runner.json confirms its own settings at version 0', () => {
    const loaded = load({ ...identity, capacity: 3, draining: true });
    expect(settingsOf(loaded)).toEqual({
      capacity: 3,
      keepAwake: 'ac',
      draining: true,
      ceilings: { claude: { fiveHour: 0.85, weekly: 0.85 }, codex: { fiveHour: 0.85, weekly: 0.85 } },
      allowPaidUsage: { claude: false, codex: false },
      version: 0,
    });
    expect(localSettingsEdits(loaded)).toEqual({});
  });

  test('keeps given values, partial nested objects included', () => {
    const loaded = load({
      ...identity,
      models: { claude: { lead: 'claude-opus-6' } },
      timings: { wip: 20 * MIN, lateRetry: { cap: 20 * MIN } },
      capturedPath: '/opt/homebrew/bin:/usr/bin:/bin',
      connectivity: { HTTPS_PROXY: 'http://proxy:3128', NO_PROXY: 'localhost' },
      homes: { claude: '/Users/me/.agflow/runner/homes/claude' },
      commitIdentity: { name: 'Me', email: 'me@example.com' },
    });
    expect(loaded.models.claude).toEqual({ lead: 'claude-opus-6', worker: 'claude-sonnet-5-5' });
    expect(loaded.timings.wip).toBe(20 * MIN);
    expect(loaded.timings.lateRetry).toEqual({ base: 30_000, cap: 20 * MIN });
    expect(loaded.capturedPath).toBe('/opt/homebrew/bin:/usr/bin:/bin');
    expect(loaded.connectivity).toEqual({ HTTPS_PROXY: 'http://proxy:3128', NO_PROXY: 'localhost' });
    expect(loaded.homes).toEqual({ claude: '/Users/me/.agflow/runner/homes/claude', codex: null });
    expect(loaded.commitIdentity).toEqual({ name: 'Me', email: 'me@example.com' });
  });

  test.each([
    ['an unknown key', { ...identity, colour: 'blue' }, /runner\.json: colour: unknown field/],
    ['a vendor pin', { ...identity, vendorPins: { claude: '2.1.200' } }, /vendorPins: unknown field/],
    ['a pin in models', { ...identity, models: { claude: { cliVersion: '2' } } }, /claude\.cliVersion: unknown/],
    ['a relative vendor home', { ...identity, homes: { claude: 'homes/claude' } }, /homes\.claude: .*absolute/],
    ['a vendor home with a trailing slash', { ...identity, homes: { codex: '/a/codex/' } }, /homes\.codex: .*trailing/],
    ['another environment variable', { ...identity, connectivity: { LD_PRELOAD: '/x' } }, /LD_PRELOAD: unknown/],
    ['a capacity of 0', { ...identity, capacity: 0 }, /capacity/],
    ['a capacity of 17', { ...identity, capacity: 17 }, /capacity/],
    ['a missing identity', { name: 'laptop' }, /runnerKey/],
    ['a negative timing', { ...identity, timings: { heartbeat: -1 } }, /timings\.heartbeat/],
    ['a cap below its base', { ...identity, timings: { lateRetry: { base: 20 * MIN, cap: MIN } } }, /lateRetry/],
  ])('refuses %s, naming the field', (_label, content, message) => {
    expect(() => load(content)).toThrow(message);
  });

  test('connectivity accepts exactly the listed variables', () => {
    const all = Object.fromEntries(CONNECTIVITY_VARS.map((name) => [name, 'x']));
    expect(load({ ...identity, connectivity: all }).connectivity).toEqual(all);
    expect(CONNECTIVITY_VARS).toEqual([
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'NO_PROXY',
      'ALL_PROXY',
      'NODE_EXTRA_CA_CERTS',
      'SSL_CERT_FILE',
      'SSL_CERT_DIR',
      'REQUESTS_CA_BUNDLE',
      'CURL_CA_BUNDLE',
      'GIT_SSL_CAINFO',
    ]);
  });

  test('refuses a missing file and a file that is not JSON, naming the path', () => {
    expect(() => loadRunnerConfig('/nonexistent/runner.json', {})).toThrow(
      '/nonexistent/runner.json does not exist; run agflow runner setup',
    );
    const broken = file('{ not json');
    expect(() => loadRunnerConfig(broken, {})).toThrow(`${broken} is not valid JSON`);
  });

  test('refuses timings below the defaults, the production minimums', () => {
    expect(() => load({ ...identity, timings: { heartbeat: 1_000 } })).toThrow(
      'runner.json: timings.heartbeat: 1000 ms is below the minimum of 15000 ms',
    );
    expect(() => load({ ...identity, timings: { vendorErrorBackoff: { base: 1_000, cap: 10 * MIN } } })).toThrow(
      'timings.vendorErrorBackoff.base',
    );
  });

  test('accepts any positive timing only with AGFLOW_TEST=1 and test.allowShortTimings', () => {
    const short = { ...identity, timings: { heartbeat: 50, lateRetry: { base: 10, cap: 40 } } };
    const allowed = { ...short, test: { allowShortTimings: true } };
    expect(() => load(allowed, {})).toThrow('timings.heartbeat');
    expect(() => load(short, { AGFLOW_TEST: '1' })).toThrow('timings.heartbeat');
    expect(() => load({ ...short, test: {} }, { AGFLOW_TEST: '1' })).toThrow('timings.heartbeat');
    const loaded = load(allowed, { AGFLOW_TEST: '1' });
    expect(loaded.timings.heartbeat).toBe(50);
    expect(loaded.timings.lateRetry).toEqual({ base: 10, cap: 40 });
  });
});

describe('test mode', () => {
  const block = {
    claudeEnv: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' },
    codexConfig: {
      model_provider: 'agflow_test',
      model_providers: { agflow_test: { base_url: 'http://127.0.0.1:9' } },
    },
    skipAuthChecks: true,
    allowShortTimings: true,
  };

  test('the test block loads with its defaults', () => {
    expect(load({ ...identity, test: {} }, { AGFLOW_TEST: '1' }).test).toEqual({
      claudeEnv: {},
      codexConfig: {},
      skipAuthChecks: false,
      allowShortTimings: false,
    });
    expect(load({ ...identity, test: block }, { AGFLOW_TEST: '1' }).test).toEqual(block);
  });

  test('isTestMode needs both AGFLOW_TEST=1 and a test block', () => {
    expect(isTestMode(config({ test: block }), { AGFLOW_TEST: '1' })).toBe(true);
    expect(isTestMode(config({ test: block }), {})).toBe(false);
    expect(isTestMode(config({ test: block }), { AGFLOW_TEST: 'true' })).toBe(false);
    expect(isTestMode(config(), { AGFLOW_TEST: '1' })).toBe(false);
  });

  test('without AGFLOW_TEST=1 the block is kept for the file but not honoured', () => {
    const loaded = load({ ...identity, test: block }, {});
    expect(loaded.test).toEqual(block);
    expect(isTestMode(loaded, {})).toBe(false);
  });
});

describe('saveRunnerConfig', () => {
  test('writes through a temporary file and a rename, with mode 0600', () => {
    const path = file(identity);
    const before = statSync(path).ino;
    const loaded = loadRunnerConfig(path, {});
    saveRunnerConfig(path, { ...loaded, capacity: 5 });
    expect(statSync(path).ino).not.toBe(before);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(path, '..'))).toEqual(['runner.json']);
    expect(loadRunnerConfig(path, {})).toEqual({ ...loaded, capacity: 5 });
    expect(readFileSync(path, 'utf8').endsWith('}\n')).toBe(true);
  });

  test('creates the runner directory and refuses an invalid config, leaving the file alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agflow-config-'));
    dirs.push(dir);
    const path = join(dir, 'runner', 'runner.json');
    saveRunnerConfig(path, config());
    expect(statSync(join(dir, 'runner')).mode & 0o777).toBe(0o700);
    const saved = readFileSync(path, 'utf8');
    expect(() => saveRunnerConfig(path, { ...config(), token: 'secret' } as RunnerConfig)).toThrow('token');
    expect(() => saveRunnerConfig(path, { ...config(), capacity: 40 })).toThrow('capacity');
    expect(readFileSync(path, 'utf8')).toBe(saved);
    expect(readdirSync(join(dir, 'runner'))).toEqual(['runner.json']);
  });
});

describe('vendorHomes', () => {
  test("gives runner.json's canonical homes, or the layout's", () => {
    const paths = runnerPaths('/h');
    expect(vendorHomes(config(), paths)).toEqual({ claude: '/h/runner/homes/claude', codex: '/h/runner/homes/codex' });
    expect(vendorHomes(config({ homes: { claude: '/private/h/claude' } }), paths)).toEqual({
      claude: '/private/h/claude',
      codex: '/h/runner/homes/codex',
    });
  });

  test("gives the real path of the layout's homes when AGFLOW_HOME sits behind a symlink", () => {
    const dir = mkdtempSync(join(tmpdir(), 'agflow-homes-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'real'));
    symlinkSync(join(dir, 'real'), join(dir, 'link'));
    const real = realpathSync(join(dir, 'real'));
    // Neither home exists yet; tmpdir() itself is a symlink on macOS (/var/folders -> /private/var/folders).
    expect(vendorHomes(config(), runnerPaths(join(dir, 'link')))).toEqual({
      claude: join(real, 'runner', 'homes', 'claude'),
      codex: join(real, 'runner', 'homes', 'codex'),
    });
  });
});

describe('settings sync', () => {
  /** A runner whose settings the hub confirmed at version 3, and which was then drained while offline. */
  function drainedOffline(): RunnerConfig {
    const confirmed = config({ capacity: 2 });
    const snapshot = { ...settingsOf(confirmed), version: 3 };
    return { ...confirmed, confirmedSettings: snapshot, draining: true };
  }

  test('settingsOf gives the confirmed snapshot and its version, never a local edit', () => {
    const runner = drainedOffline();
    const settings = settingsOf(runner);
    expect(settings.draining).toBe(false);
    expect(settings.version).toBe(3);
    expect(RunnerSettingsSchema.parse(settings)).toEqual(settings);
  });

  test('localSettingsEdits lists the fields runner.json changed since the snapshot', () => {
    expect(localSettingsEdits(drainedOffline())).toEqual({ draining: true });
    const ceilings = { ...drainedOffline().ceilings, codex: { fiveHour: 0.5, weekly: 0.9 } };
    const edited = { ...drainedOffline(), ceilings };
    expect(localSettingsEdits(edited)).toEqual({ draining: true, ceilings: { codex: { fiveHour: 0.5, weekly: 0.9 } } });
  });

  test('an in-place edit of the live settings never reaches the snapshot', () => {
    const runner = config();
    runner.allowPaidUsage.claude = true;
    runner.ceilings.codex.weekly = 0.5;
    expect(localSettingsEdits(runner)).toEqual({
      allowPaidUsage: { claude: true },
      ceilings: { codex: { fiveHour: 0.85, weekly: 0.5 } },
    });
    const { config: next } = applySettingsEcho(runner, { settings: {}, version: 1 });
    next.allowPaidUsage.codex = true;
    expect(localSettingsEdits(next)).toEqual({
      allowPaidUsage: { claude: true, codex: true },
      ceilings: { codex: { fiveHour: 0.85, weekly: 0.5 } },
    });
  });

  test("an echo takes the browser's capacity and the version and keeps the pending drain to send again", () => {
    // The hub had the browser's capacity at version 4, so it answers hello with all of its settings.
    const { version: _confirmed, ...hub } = settingsOf(drainedOffline());
    const { config: next, pending } = applySettingsEcho(drainedOffline(), {
      settings: { ...hub, capacity: 4 },
      version: 4,
    });
    expect(next.capacity).toBe(4);
    expect(next.draining).toBe(true);
    expect(settingsOf(next)).toMatchObject({ capacity: 4, draining: false, version: 4 });
    expect(pending).toEqual({ draining: true });
    expect(localSettingsEdits(next)).toEqual({ draining: true });
  });

  test('an echo that carries the edit clears it', () => {
    const first = applySettingsEcho(drainedOffline(), { settings: { capacity: 4 }, version: 4 }).config;
    const { config: next, pending } = applySettingsEcho(first, { settings: { draining: true }, version: 5 });
    expect(pending).toEqual({});
    expect(next.draining).toBe(true);
    expect(next.capacity).toBe(4);
    expect(settingsOf(next)).toMatchObject({ capacity: 4, draining: true, version: 5 });
    expect(localSettingsEdits(next)).toEqual({});
  });

  test('an echo replaces fields without a local edit and merges per-vendor records', () => {
    const runner = config();
    const { config: next, pending } = applySettingsEcho(runner, {
      settings: {
        keepAwake: 'always',
        ceilings: { codex: { fiveHour: 0.5, weekly: 0.6 } },
        allowPaidUsage: { claude: true },
      },
      version: 1,
    });
    expect(pending).toEqual({});
    expect(next.keepAwake).toBe('always');
    expect(next.ceilings).toEqual({ claude: { fiveHour: 0.85, weekly: 0.85 }, codex: { fiveHour: 0.5, weekly: 0.6 } });
    expect(next.allowPaidUsage).toEqual({ claude: true, codex: false });
    expect(settingsOf(next)).toMatchObject({ keepAwake: 'always', version: 1, ceilings: next.ceilings });
    expect(localSettingsEdits(next)).toEqual({});
  });

  /** Settings the hub confirmed at version 3, with paid usage on for Claude only. */
  function confirmedAt3(): RunnerConfig {
    const confirmed = config({ allowPaidUsage: { claude: true, codex: false } });
    return { ...confirmed, confirmedSettings: { ...structuredClone(settingsOf(confirmed)), version: 3 } };
  }

  test("an offline edit of one vendor's paid usage and the browser's edit of the other both survive", () => {
    const runner = confirmedAt3();
    runner.allowPaidUsage = { claude: true, codex: true };
    expect(localSettingsEdits(runner)).toEqual({ allowPaidUsage: { codex: true } });
    const { version: _v, ...hub } = settingsOf(runner);
    const { config: next, pending } = applySettingsEcho(runner, {
      settings: { ...hub, allowPaidUsage: { claude: false, codex: false } },
      version: 4,
    });
    expect(next.allowPaidUsage).toEqual({ claude: false, codex: true });
    expect(pending).toEqual({ allowPaidUsage: { codex: true } });
    expect(localSettingsEdits(next)).toEqual({ allowPaidUsage: { codex: true } });
  });

  test("an offline edit of one vendor's ceiling and the browser's edit of the other both survive", () => {
    const runner = confirmedAt3();
    runner.ceilings = { ...runner.ceilings, codex: { fiveHour: 0.5, weekly: 0.85 } };
    const { config: next, pending } = applySettingsEcho(runner, {
      settings: { ceilings: { claude: { fiveHour: 0.85, weekly: 0.4 }, codex: { fiveHour: 0.85, weekly: 0.85 } } },
      version: 4,
    });
    expect(next.ceilings).toEqual({ claude: { fiveHour: 0.85, weekly: 0.4 }, codex: { fiveHour: 0.5, weekly: 0.85 } });
    expect(pending).toEqual({ ceilings: { codex: { fiveHour: 0.5, weekly: 0.85 } } });
    expect(settingsOf(next).ceilings).toEqual({
      claude: { fiveHour: 0.85, weekly: 0.4 },
      codex: { fiveHour: 0.85, weekly: 0.85 },
    });
  });

  test('a local edit the echo already matches is not pending', () => {
    const runner = { ...config(), capacity: 6 };
    const { config: next, pending } = applySettingsEcho(runner, { settings: { capacity: 6 }, version: 2 });
    expect(pending).toEqual({});
    expect(next.capacity).toBe(6);
  });
});

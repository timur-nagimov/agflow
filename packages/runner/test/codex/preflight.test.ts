import { withoutTestProcessEnv } from '@agflow/testkit/src/process-cleanup';
// Zero-model preflight through the scripted app-server, including isolation and cleanup on failures.
import { afterEach, describe, expect, test } from 'bun:test';
import { TEST_ACCOUNT_ID, VendorQuotaSchema } from '@agflow/core';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CODEX_VERSION } from '../../src/adapters/codex/binary';
import type { ResultOf } from '../../src/adapters/codex/methods';
import { codexProcessOptions, runCodexPreflight, type CodexPreflightOptions } from '../../src/adapters/codex/preflight';
import type { SkillMetadata } from '../../src/adapters/codex/protocol/v2';
import { RunnerConfigSchema, type RunnerConfigInput, vendorHomes } from '../../src/config';
import { memoryLogger } from '../../src/log';
import { runnerPaths } from '../../src/paths';
import { vendorBinary } from '../../src/vendor/pins';
import { codexScenario, readCodexRecord, writeCodexShim, type CodexScenario, type ScriptedAnswers } from './peer';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const recorded = JSON.parse(readFileSync(`${import.meta.dir}/fixtures/requirements-managed.json`, 'utf8')) as {
  'configRequirements/read': ResultOf<'configRequirements/read'>;
  'config/read': ResultOf<'config/read'>;
};
const email = 'owner@example.com';
const failed = { error: { code: -32600, message: 'codex account authentication required to read rate limits' } };
const mcp: ResultOf<'mcpServerStatus/list'> = {
  data: [
    {
      name: 'codex_apps',
      runtimeStatus: null,
      pluginId: null,
      httpOrigin: null,
      serverInfo: null,
      serverCapabilities: null,
      tools: {},
      toolsError: null,
      resources: [],
      resourceTemplates: [],
      authStatus: 'unsupported',
    },
  ],
  nextCursor: null,
};

function skills(scope: SkillMetadata['scope'], pluginId: string | null = null): ResultOf<'skills/list'> {
  return {
    data: [
      {
        cwd: '/tmp',
        errors: [],
        skills: [
          {
            name: 'example-skill',
            description: 'test skill',
            path: '/tmp/SKILL.md',
            scope,
            enabled: true,
            pluginId,
          },
        ],
      },
    ],
  };
}

const rateLimits: ResultOf<'account/rateLimits/read'> = {
  ordinaryUsageAllowed: true,
  accountId: null,
  rateLimitsByLimitId: null,
  rateLimitResetCredits: null,
  rateLimitUpsell: null,
  rateLimits: {
    limitId: 'codex',
    limitName: null,
    normalModelSlug: null,
    primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_800_000_000 },
    secondary: { usedPercent: 50, windowDurationMins: 10080, resetsAt: 1_800_100_000 },
    credits: { hasCredits: true, unlimited: false, balance: '10' },
    individualLimit: null,
    spendControlReached: null,
    planType: 'plus',
    rateLimitReachedType: null,
  },
};

function answers(): ScriptedAnswers {
  return {
    'account/read': { result: { account: { type: 'chatgpt', email, planType: 'plus' }, requiresOpenaiAuth: true } },
    'configRequirements/read': { result: recorded['configRequirements/read'] },
    'config/read': { result: recorded['config/read'] },
    'mcpServerStatus/list': { result: { data: [], nextCursor: null } },
    'skills/list': { result: skills('system') },
    'account/rateLimits/read': { result: rateLimits },
  };
}

function runnerConfig(config: Partial<RunnerConfigInput> = {}) {
  return RunnerConfigSchema.parse({
    runnerKey: 'runner',
    machineId: 'machine',
    name: 'test',
    capturedPath: '/usr/bin:/bin',
    ...config,
  });
}

/** Preflight options as the adapter resolves them from runner.json and the service environment. */
function setup(
  overrides: ScriptedAnswers = {},
  config: Partial<RunnerConfigInput> = {},
  scenario: Partial<CodexScenario> = {},
  env: Record<string, string> = {},
) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agflow-codex-preflight-')));
  dirs.push(dir);
  const paths = runnerPaths(join(dir, 'agflow'));
  const bin = join(paths.runner, vendorBinary('codex', CODEX_VERSION));
  writeCodexShim(bin, codexScenario({ ...scenario, answers: { ...answers(), ...overrides } }));
  const parsed = runnerConfig(config);
  const options: CodexPreflightOptions = {
    ...codexProcessOptions({ config: parsed, paths, env }),
    paths,
    capturedPath: parsed.capturedPath,
    platform: 'darwin',
    arch: 'arm64',
    requestTimeoutMs: 200,
  };
  return { options, bin, dir, config: parsed };
}

/** The owner's npm install of 0.158.0 under dir: the bin directory for PATH and the native binary it points at. */
function ownerInstall(dir: string): { path: string; native: string } {
  const owner = join(dir, 'owner');
  const packageRoot = join(owner, 'node_modules', '@openai', 'codex');
  const wrapper = join(packageRoot, 'bin', 'codex.js');
  mkdirSync(dirname(wrapper), { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@openai/codex' }));
  writeFileSync(wrapper, 'throw new Error("the owner wrapper must never run");\n', { mode: 0o755 });
  const native = join(packageRoot, 'vendor', 'aarch64-apple-darwin', 'bin', 'codex');
  writeCodexShim(native, codexScenario({ version: '0.158.0' }));
  const path = join(owner, 'bin');
  mkdirSync(path);
  symlinkSync(wrapper, join(path, 'codex'));
  return { path, native };
}

async function probe(fixture: ReturnType<typeof setup>) {
  const result = await runCodexPreflight(fixture.options);
  const runs = readCodexRecord(fixture.bin);
  expect(runs).toHaveLength(1);
  expect(runs[0]?.exit).toMatchObject({ reason: 'eof', code: 0, signal: null });
  expect(result.weakened).toEqual([]);
  return result;
}

const blockedPolicy: ScriptedAnswers = {
  'configRequirements/read': {
    result: {
      requirements: { ...recorded['configRequirements/read'].requirements!, allowedSandboxModes: ['read-only'] },
    },
  },
};
const noAccount: ScriptedAnswers = { 'account/read': { result: { account: null, requiresOpenaiAuth: true } } };

describe('runCodexPreflight', () => {
  test('returns only facts, quota and weakened; asks the preflight methods and ends the process', async () => {
    const fixture = setup();
    const result = await probe(fixture);
    expect(Object.keys(result).sort()).toEqual(['facts', 'quota', 'weakened']);
    expect(result.facts).toEqual({
      vendor: 'codex',
      cliVersion: CODEX_VERSION,
      ownerCliVersion: null,
      ready: true,
      problem: null,
      accountId: createHash('sha256').update(email).digest('hex').slice(0, 16),
      plan: 'ChatGPT Plus',
      managedPolicy: true,
    });
    expect(VendorQuotaSchema.parse(result.quota)).toEqual({
      state: 'ok',
      windows: { fiveHour: 0.25, weekly: 0.5 },
      paidUsage: 'enabled',
      resetsAt: 1_800_100_000_000,
      updatedAt: expect.any(Number),
    });
    const run = readCodexRecord(fixture.bin)[0]!;
    expect(run.requests.slice(1).map(({ method, params }) => ({ method, params }))).toEqual([
      { method: 'account/read', params: { refreshToken: false } },
      { method: 'configRequirements/read', params: undefined },
      { method: 'config/read', params: { includeLayers: true } },
      { method: 'mcpServerStatus/list', params: {} },
      { method: 'skills/list', params: { cwds: [fixture.options.paths.homes.codexUser] } },
      { method: 'account/rateLimits/read', params: undefined },
    ]);
    expect(run.cwd).toBe(fixture.options.paths.homes.codexUser);
    for (const home of [run.env.CODEX_HOME!, run.env.HOME!]) expect(statSync(home).mode & 0o777).toBe(0o700);
  });

  test('runs app-server with the resolved homes and base environment', async () => {
    const fixture = setup({}, { connectivity: { HTTPS_PROXY: 'http://127.0.0.1:9', SSL_CERT_FILE: '/tmp/ca' } });
    const config = { ...fixture.config, homes: { ...fixture.config.homes, codex: join(fixture.dir, 'custom-codex') } };
    const env = {
      USER: 'test',
      LOGNAME: 'test',
      LANG: 'C',
      SHELL: '/bin/zsh',
      LC_ALL: 'C',
      PATH: '/unwanted',
      HTTPS_PROXY: 'http://unwanted',
      OPENAI_API_KEY: 'secret',
      HOME: '/unwanted',
      CODEX_HOME: '/unwanted',
      AGFLOW_AGENT_TOKEN: 'secret',
      CODEX_MANAGED_TEST: '1',
    };
    Object.assign(fixture.options, codexProcessOptions({ config, paths: fixture.options.paths, env }));
    expect((await probe(fixture)).facts.ready).toBe(true);
    expect(withoutTestProcessEnv(readCodexRecord(fixture.bin)[0]!.env)).toEqual({
      PATH: '/usr/bin:/bin',
      HTTPS_PROXY: 'http://127.0.0.1:9',
      SSL_CERT_FILE: '/tmp/ca',
      USER: 'test',
      LOGNAME: 'test',
      LANG: 'C',
      SHELL: '/bin/zsh',
      LC_ALL: 'C',
      CODEX_HOME: join(fixture.dir, 'custom-codex'),
      HOME: fixture.options.paths.homes.codexUser,
      GIT_DIR: '/dev/null',
    });
  });

  test('reports the owner version from captured PATH without starting the owner app-server', async () => {
    const fixture = setup();
    const { path, native } = ownerInstall(fixture.dir);
    fixture.options.capturedPath = `${path}:/usr/bin:/bin`;
    const result = await probe(fixture);
    expect(result.facts).toMatchObject({ ready: true, cliVersion: CODEX_VERSION, ownerCliVersion: '0.158.0' });
    expect(readCodexRecord(native)).toEqual([]);
  });

  const failures: [string, ScriptedAnswers, string][] = [
    ['MCP server', { 'mcpServerStatus/list': { result: mcp } }, 'codex_apps'],
    ['user skill', { 'skills/list': { result: skills('user') } }, 'example-skill'],
    ['plugin skill', { 'skills/list': { result: skills('system', 'plugin-1') } }, 'example-skill'],
    ['account absent', noAccount, 'not logged in'],
    ['account read fails', { 'account/read': failed }, 'not logged in'],
    ['MCP read fails', { 'mcpServerStatus/list': failed }, 'MCP'],
    ['skills read fails', { 'skills/list': failed }, 'skills'],
    ['MCP read times out', { 'mcpServerStatus/list': { silent: true } }, 'MCP'],
    ['policy disallows workspace-write', blockedPolicy, 'workspace-write'],
  ];
  for (const [name, overrides, problem] of failures) {
    test(`${name} is not ready and ends the process`, async () => {
      const result = await probe(setup(overrides));
      expect(result.facts.ready).toBe(false);
      expect(result.facts.problem).toContain(problem);
    });
  }

  test('first problem wins: policy, account, MCP, then skills', async () => {
    const extensions: ScriptedAnswers = {
      'mcpServerStatus/list': { result: mcp },
      'skills/list': { result: skills('user') },
    };
    for (const [overrides, problem] of [
      [{ ...extensions, ...noAccount, ...blockedPolicy }, 'workspace-write'],
      [{ ...extensions, ...noAccount }, 'not logged in'],
      [extensions, 'codex_apps'],
    ] as const)
      expect((await probe(setup(overrides))).facts.problem).toContain(problem);
  });

  for (const scope of ['system', 'admin', 'repo'] as const) {
    test(`${scope} skills pass`, async () => {
      expect((await probe(setup({ 'skills/list': { result: skills(scope) } }))).facts.ready).toBe(true);
    });
  }

  test('failed policy reads count as managed and a failed quota read is null', async () => {
    const result = await probe(
      setup({
        'configRequirements/read': failed,
        'config/read': failed,
        'account/rateLimits/read': failed,
      }),
    );
    expect(result.facts).toMatchObject({ ready: true, managedPolicy: true, problem: null });
    expect(result.quota).toBeNull();
  });

  test('unsupported platform, missing, mismatched and unreadable binary versions never open app-server', async () => {
    for (const kind of ['platform', 'missing', 'mismatch', 'unreadable'] as const) {
      const fixture = setup(
        {},
        {},
        { version: kind === 'mismatch' ? '0.158.0' : kind === 'unreadable' ? 'unknown' : CODEX_VERSION },
      );
      if (kind === 'platform') Object.assign(fixture.options, { platform: 'linux', arch: 'x64' });
      if (kind === 'missing') {
        rmSync(fixture.bin);
        // The owner's install is reported even when the runner's own binary is missing.
        fixture.options.capturedPath = `${ownerInstall(fixture.dir).path}:/usr/bin:/bin`;
      }
      const result = await runCodexPreflight(fixture.options);
      expect(result.facts).toEqual({
        vendor: 'codex',
        cliVersion: kind === 'mismatch' ? '0.158.0' : null,
        ownerCliVersion: kind === 'missing' ? '0.158.0' : null,
        ready: false,
        accountId: null,
        plan: null,
        managedPolicy: true,
        problem:
          kind === 'platform'
            ? 'unsupported platform'
            : kind === 'missing'
              ? 'binary missing'
              : kind === 'mismatch'
                ? `codex binary is version 0.158.0, expected ${CODEX_VERSION}`
                : expect.stringContaining('version'),
      });
      expect(result.quota).toBeNull();
      expect(result.weakened).toEqual([]);
      expect(readCodexRecord(fixture.bin)).toEqual([]);
    }
  });

  test('rejected open returns its error and the process is ended', async () => {
    const fixture = setup({}, {}, { failBeforeInitialize: { stderr: 'Error: cannot start', code: 1 } });
    const result = await runCodexPreflight(fixture.options);
    expect(result.facts).toMatchObject({ ready: false, problem: 'Error: cannot start', managedPolicy: true });
    expect(readCodexRecord(fixture.bin)[0]?.exit).toMatchObject({ reason: 'failed', code: 1 });
  });

  test('skipAuthChecks gives test identity but still checks policy, MCP and skills', async () => {
    for (const [overrides, problem] of [
      [{}, 'test mode'],
      [blockedPolicy, 'workspace-write'],
      [{ 'mcpServerStatus/list': { result: mcp } }, 'codex_apps'],
      [{ 'skills/list': { result: skills('user') } }, 'example-skill'],
    ] satisfies [ScriptedAnswers, string][]) {
      const fixture = setup(
        { ...noAccount, ...overrides },
        { test: { skipAuthChecks: true } },
        {},
        { AGFLOW_TEST: '1' },
      );
      const result = await probe(fixture);
      expect(result.facts).toMatchObject({
        ready: problem === 'test mode',
        accountId: TEST_ACCOUNT_ID,
        plan: 'test mode',
        problem: expect.stringContaining(problem),
      });
    }
  });

  test('the resolved test switches: codexConfig as -c flags and skipAuthChecks; no config.toml is written', async () => {
    for (const enabled of [false, true]) {
      const fixture = setup(noAccount);
      Object.assign(fixture.options, {
        codexConfig: enabled ? { model_provider: 'scripted' } : null,
        skipAuthChecks: enabled,
      });
      const result = await probe(fixture);
      expect(result.facts.ready).toBe(enabled);
      expect(result.facts.problem).toBe(enabled ? 'test mode' : 'not logged in');
      const argv = readCodexRecord(fixture.bin)[0]!.argv;
      expect(argv.includes('model_provider="scripted"')).toBe(enabled);
      if (enabled) expect(argv[argv.indexOf('model_provider="scripted"') - 1]).toBe('-c');
      expect(existsSync(join(fixture.options.paths.homes.codex, 'config.toml'))).toBe(false);
    }
  });

  test('an owner version that fails to read is null and fails nothing', async () => {
    const fixture = setup();
    fixture.options.capturedPath = `${ownerInstall(fixture.dir).path}:/usr/bin:/bin`;
    const logger = memoryLogger();
    fixture.options.logger = logger;
    // Reading the owner's version needs a scratch home in TMPDIR; the runner's own binary uses the runner's homes.
    const tmp = process.env.TMPDIR;
    process.env.TMPDIR = join(fixture.dir, 'missing-tmp');
    try {
      const result = await probe(fixture);
      expect(result.facts).toMatchObject({ ready: true, cliVersion: CODEX_VERSION, ownerCliVersion: null });
    } finally {
      if (tmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = tmp;
    }
    expect(logger.entries).toContainEqual(
      expect.objectContaining({ level: 'warn', message: 'codex preflight: owner version failed' }),
    );
  });

  test('ordinary usage not allowed is exhausted without credits, and paid usage in use with them', async () => {
    const limits = (credits: { hasCredits: boolean; unlimited: boolean }): ScriptedAnswers => {
      return {
        'account/rateLimits/read': {
          result: {
            ...rateLimits,
            ordinaryUsageAllowed: false,
            rateLimits: { ...rateLimits.rateLimits, credits: { ...credits, balance: null } },
          },
        },
      };
    };
    const without = await probe(setup(limits({ hasCredits: false, unlimited: false })));
    expect(without.quota).toMatchObject({ state: 'exhausted', paidUsage: 'disabled', windows: { fiveHour: 0.25 } });
    expect(without.facts.ready).toBe(true);
    for (const credits of [
      { hasCredits: true, unlimited: false },
      { hasCredits: false, unlimited: true },
    ]) {
      expect((await probe(setup(limits(credits)))).quota).toMatchObject({ state: 'ok', paidUsage: 'in_use' });
    }
  });
});

describe('codexProcessOptions', () => {
  const env = {
    USER: 'test',
    LOGNAME: 'test',
    LANG: 'C',
    SHELL: '/bin/zsh',
    LC_ALL: 'C',
    LC_CTYPE: 'UTF-8',
    PATH: '/unwanted',
    HTTPS_PROXY: 'http://unwanted',
    OPENAI_API_KEY: 'secret',
    HOME: '/unwanted',
    CODEX_HOME: '/unwanted',
  };

  test('configured homes, captured PATH and connectivity, and only the user variables', () => {
    const paths = runnerPaths('/tmp/agflow-codex-options/agflow');
    const config = runnerConfig({
      homes: { codex: '/tmp/custom-codex' },
      connectivity: { HTTPS_PROXY: 'http://127.0.0.1:9' },
    });
    expect(codexProcessOptions({ config, paths, env })).toEqual({
      codexHome: '/tmp/custom-codex',
      userHome: paths.homes.codexUser,
      base: {
        PATH: '/usr/bin:/bin',
        HTTPS_PROXY: 'http://127.0.0.1:9',
        USER: 'test',
        LOGNAME: 'test',
        LANG: 'C',
        SHELL: '/bin/zsh',
        LC_ALL: 'C',
        LC_CTYPE: 'UTF-8',
      },
      codexConfig: null,
      skipAuthChecks: false,
    });
    expect(codexProcessOptions({ config: runnerConfig(), paths, env: {} }).codexHome).toBe(
      vendorHomes(runnerConfig(), paths).codex,
    );
  });

  test('test flags and skipAuthChecks require AGFLOW_TEST=1 and a test block', () => {
    const paths = runnerPaths('/tmp/agflow-codex-options/agflow');
    const test = { skipAuthChecks: true, codexConfig: { model_provider: 'scripted' } };
    const switches = (config: Partial<RunnerConfigInput>, AGFLOW_TEST: string) => {
      const { codexConfig, skipAuthChecks } = codexProcessOptions({
        config: runnerConfig(config),
        paths,
        env: { AGFLOW_TEST },
      });
      return { codexConfig, skipAuthChecks };
    };
    expect(switches({ test }, '1')).toEqual({ codexConfig: { model_provider: 'scripted' }, skipAuthChecks: true });
    expect(switches({ test }, '0')).toEqual({ codexConfig: null, skipAuthChecks: false });
    expect(switches({}, '1')).toEqual({ codexConfig: null, skipAuthChecks: false });
  });
});

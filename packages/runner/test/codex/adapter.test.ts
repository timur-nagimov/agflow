// The registry's Codex adapter, exercised through real child-process shims and temporary transcripts and vaults.
import { afterEach, describe, expect, test } from 'bun:test';
import { TEST_ACCOUNT_ID } from '@agflow/core';
import { originRepo } from '@agflow/testkit';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdapters } from '../../src/adapters';
import { BRIDGE_TOOL_NAMES } from '../../src/adapters/bridge-tools';
import {
  CodexAdapter,
  CodexSession,
  CODEX_VERSION,
  codexAdapterOptions,
  createCodexAdapter,
} from '../../src/adapters/codex';
import { codexAdapterFactory } from '../../src/adapters/codex/entry';
import type { AgentEvent, AgentLaunch, VendorAdapter } from '../../src/adapters/types';
import { RunnerConfigSchema, type RunnerConfigInput, vendorHomes } from '../../src/config';
import { ensureRunnerGitFiles } from '../../src/git/run';
import { runnerPaths } from '../../src/paths';
import { standardProfile } from '../../src/profile';
import { VENDOR_PINS, vendorBinary, vendorPlatform } from '../../src/vendor/pins';
import { codexMessages as m, codexScenario, FAKE_THREAD_ID, fakeTurnId, readCodexRecord, writeCodexShim } from './peer';
import { collect, mcp, skills, until } from './session-fixture';

const dirs: string[] = [];
const pids: number[] = [];
afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Already exited.
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const testBlock = { skipAuthChecks: true, codexConfig: { model_provider: 'scripted' } };
const env = {
  AGFLOW_TEST: '1',
  USER: 'test',
  LOGNAME: 'test',
  LANG: 'C',
  SHELL: '/bin/zsh',
  LC_ALL: 'C',
  LC_CTYPE: 'UTF-8',
  PATH: '/unwanted',
  HTTPS_PROXY: 'http://unwanted',
  HOME: '/unwanted',
  CODEX_HOME: '/unwanted',
  OPENAI_API_KEY: 'secret',
  AGFLOW_AGENT_TOKEN: 'secret',
};
const base = {
  PATH: '/usr/bin:/bin',
  HTTPS_PROXY: 'http://127.0.0.1:9',
  USER: 'test',
  LOGNAME: 'test',
  LANG: 'C',
  SHELL: '/bin/zsh',
  LC_ALL: 'C',
  LC_CTYPE: 'UTF-8',
};

function setup(overrides: Partial<RunnerConfigInput> = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agflow-codex-adapter-')));
  dirs.push(dir);
  const paths = runnerPaths(join(dir, 'agflow'));
  const config = RunnerConfigSchema.parse({
    runnerKey: 'runner',
    machineId: 'machine',
    name: 'test',
    capturedPath: '/usr/bin:/bin',
    connectivity: { HTTPS_PROXY: base.HTTPS_PROXY },
    test: testBlock,
    ...overrides,
  });
  // The pinned platform, as in preflight.test.ts: CI runs on linux-x64, which has no pin.
  const adapter = createCodexAdapter({ config, paths, env, platform: 'darwin', arch: 'arm64', requestTimeoutMs: 500 });
  return { dir, paths, config, options: codexAdapterOptions(config, paths, env), adapter };
}

describe('codexAdapterOptions', () => {
  test('uses the runner homes and only captured connectivity and user variables', () => {
    const f = setup();
    expect(f.options.codexHome).toBe(vendorHomes(f.config, f.paths).codex);
    expect(f.options.userHome).toBe(f.paths.homes.codexUser);
    expect(f.options.base).toEqual(base);
    const config = { ...f.config, homes: { ...f.config.homes, codex: join(f.dir, 'custom-codex') } };
    expect(codexAdapterOptions(config, f.paths, env).codexHome).toBe(config.homes.codex!);
    expect(codexAdapterOptions(config, f.paths)).toEqual(codexAdapterOptions(config, f.paths, process.env));
  });

  test('both AGFLOW_TEST=1 and the test block are required for test switches', () => {
    const f = setup();
    const switches = (options: ReturnType<typeof codexAdapterOptions>) => ({
      codexConfig: options.codexConfig,
      skipAuthChecks: options.skipAuthChecks,
    });
    expect(switches(f.options)).toEqual(testBlock);
    expect(switches(codexAdapterOptions(f.config, f.paths, {}))).toEqual({
      codexConfig: null,
      skipAuthChecks: false,
    });
    expect(switches(codexAdapterOptions({ ...f.config, test: undefined }, f.paths, env))).toEqual({
      codexConfig: null,
      skipAuthChecks: false,
    });
  });
});

describe('CodexAdapter', () => {
  test('preflight reports test identity and probes the pinned shim with shared settings', async () => {
    const f = setup();
    const bin = join(f.paths.runner, vendorBinary('codex', CODEX_VERSION));
    writeCodexShim(
      bin,
      codexScenario({
        answers: {
          'configRequirements/read': { result: { requirements: null } },
          'config/read': { error: { code: -32600, message: 'unavailable' } },
          'mcpServerStatus/list': { result: mcp([]) },
          'skills/list': { result: skills('system') },
        },
      }),
    );
    expect(f.adapter.vendor).toBe('codex');
    expect(await f.adapter.preflight()).toEqual({
      facts: {
        vendor: 'codex',
        cliVersion: CODEX_VERSION,
        ownerCliVersion: null,
        ready: true,
        problem: 'test mode',
        accountId: TEST_ACCOUNT_ID,
        plan: 'test mode',
        managedPolicy: true,
      },
      quota: null,
      weakened: [],
    });
    const [run] = readCodexRecord(bin);
    expect(run!.requests.map(({ method }) => method)).toEqual([
      'initialize',
      'configRequirements/read',
      'config/read',
      'mcpServerStatus/list',
      'skills/list',
      'account/rateLimits/read',
    ]);
    expect(run!.argv.slice(-2)).toEqual(['-c', 'model_provider="scripted"']);
    expect(run!.env).toEqual({
      ...base,
      CODEX_HOME: f.options.codexHome,
      HOME: f.options.userHome,
      GIT_DIR: '/dev/null',
    });
    expect(run!.exit).toMatchObject({ reason: 'eof', code: 0 });
  });

  test('starts the launch version, delivers a turn and test quota, then closes the process and event iterable', async () => {
    const f = setup();
    const version = '0.158.0';
    const bin = join(f.paths.runner, vendorBinary('codex', version));
    const turn = fakeTurnId(1);
    writeCodexShim(
      bin,
      codexScenario({
        version,
        answers: {
          'mcpServerStatus/list': { result: mcp() },
          'skills/list': { result: skills('system') },
          'turn/start': {
            result: { turn: m.turn({ id: turn, status: 'inProgress' }) },
            then: [
              { notify: m.turnStarted(FAKE_THREAD_ID, m.turn({ id: turn, status: 'inProgress' })) },
              { notify: m.itemCompleted(FAKE_THREAD_ID, turn, m.agentMessageItem('Adapter turn complete.')) },
              { notify: m.rateLimitsUpdated() },
              { notify: m.turnCompleted(FAKE_THREAD_ID, m.turn({ id: turn, status: 'completed' })) },
            ],
          },
        },
      }),
    );
    const clone = join(f.dir, 'clone');
    // No preflight ran, so the homes are missing: the start makes them.
    mkdirSync(clone);
    const launch: AgentLaunch = {
      attemptId: 'T-42-a1',
      role: 'worker',
      model: 'requested-model',
      cliVersion: version,
      clone,
      baseCheckout: null,
      projectConfigVerified: true,
      tmpDir: join(clone, '.agflow/run/tmp'),
      env: { PATH: '/usr/bin:/bin', LANG: 'C' },
      bridge: {
        command: '/fake/agflow',
        args: ['mcp', '--vendor', 'codex', '--runner'],
        env: { AGFLOW_AGENT_TOKEN: 'test-token' },
        tools: BRIDGE_TOOL_NAMES.worker,
      },
      profile: standardProfile,
      brief: 'Work in this clone.',
      firstPrompt: 'Implement the task.',
      resume: null,
      logFile: f.paths.attemptLog('T-42-a1'),
      registerProcess: (pid) => {
        pids.push(pid);
      },
    };
    expect(existsSync(join(f.paths.runner, vendorBinary('codex', CODEX_VERSION)))).toBe(false);
    const session = await f.adapter.start(launch);
    expect(session).toBeInstanceOf(CodexSession);
    for (const home of [f.options.codexHome, f.options.userHome]) expect(statSync(home).mode & 0o777).toBe(0o700);
    const observed: AgentEvent[] = [];
    const completed = collect(
      (async function* () {
        for await (const event of session.events) {
          observed.push(event);
          yield event;
        }
      })(),
    );
    await until(() => observed.some((event) => event.type === 'turn_ended'));
    expect(observed).toEqual([
      {
        type: 'started',
        sessionRef: FAKE_THREAD_ID,
        model: launch.model,
        cliVersion: version,
        permissionMode: 'on-request',
      },
      { type: 'turn_started' },
      { type: 'text', text: 'Adapter turn complete.' },
      { type: 'quota', accountId: TEST_ACCOUNT_ID, quota: expect.any(Object) },
      { type: 'turn_ended', outcome: 'completed', toolCalls: 0, error: null, errorKind: null },
    ]);
    await session.close();
    expect(await session.exited).toEqual({ code: 0, signal: null });
    expect(await completed).toEqual(observed);
    const [run] = readCodexRecord(bin);
    expect(run!.requests.map(({ method }) => method)).toEqual([
      'initialize',
      'thread/start',
      'mcpServerStatus/list',
      'skills/list',
      'thread/name/set',
      'turn/start',
    ]);
    expect(run!.argv.slice(-2)).toEqual(['-c', 'model_provider="scripted"']);
    expect(run!.env).toEqual({
      PATH: '/usr/bin:/bin',
      LANG: 'C',
      AGFLOW_AGENT_TOKEN: 'test-token',
      CODEX_HOME: f.options.codexHome,
      HOME: f.options.userHome,
      GIT_DIR: '/dev/null',
    });
    expect(run!.exit).toMatchObject({ reason: 'eof', code: 0 });
  });

  test('reads from its Codex home and deletes through the pinned app-server', async () => {
    const f = setup();
    const dir = join(f.options.codexHome, 'sessions/2026/11/10');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `rollout-2026-11-10T12-00-00-${FAKE_THREAD_ID}.jsonl`),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'The adapter transcript.' }],
        },
      }) + '\n',
    );
    const input = { sessionRef: FAKE_THREAD_ID, clone: '/unused' };
    expect(await f.adapter.readTranscriptTail({ ...input, maxChars: 11 })).toBe('transcript.');
    expect(await f.adapter.readTranscriptTail({ ...input, sessionRef: 'missing', maxChars: 100 })).toBeNull();
    const bin = join(f.paths.runner, vendorBinary('codex', CODEX_VERSION));
    writeCodexShim(bin, codexScenario({ answers: { 'thread/delete': { result: {} } } }));
    await f.adapter.deleteTranscript(input);
    const [run] = readCodexRecord(bin);
    expect(run!.requests.map(({ method, params }) => ({ method, params })).slice(1)).toEqual([
      { method: 'thread/delete', params: { threadId: FAKE_THREAD_ID } },
    ]);
    expect(run!.requests[0]!.method).toBe('initialize');
    expect(run!.argv.slice(-2)).toEqual(['-c', 'model_provider="scripted"']);
    expect(run!.env).toEqual({
      ...base,
      CODEX_HOME: f.options.codexHome,
      HOME: f.options.userHome,
      GIT_DIR: '/dev/null',
    });
    expect(run!.exit).toMatchObject({ reason: 'eof', code: 0 });
  });

  test('enriches package-manager approvals against the vault and can be called detached', async () => {
    const f = setup();
    const before = '{"name":"before"}\n';
    const origin = await originRepo({ 'package.json': before });
    dirs.push(origin.root);
    const clone = join(f.dir, 'clone');
    mkdirSync(clone);
    writeFileSync(join(clone, 'package.json'), '{"name":"after"}\n');
    ensureRunnerGitFiles(f.paths);
    const enrich = f.adapter.enrichApproval;
    const input: Parameters<NonNullable<VendorAdapter['enrichApproval']>>[0] = {
      clone,
      vault: origin.path,
      startSha: origin.mainSha,
      request: { kind: 'command', summary: 'npm install', detail: { command: 'npm install', cwd: clone } },
    };
    const detail = await enrich(input);
    expect(detail).toMatchObject(input.request.detail);
    expect(detail.manifestDiff).toContain('--- a/package.json');
    expect(detail.manifestDiff).toContain('-{"name":"before"}');
    expect(detail.manifestDiff).toContain('+{"name":"after"}');
    const other = { ...input.request, detail: { command: 'npm test', cwd: clone } };
    expect(await enrich({ ...input, request: other })).toBe(other.detail);
    writeFileSync(join(clone, 'package.json'), before);
    expect(await enrich(input)).toBe(input.request.detail);
  });
});

describe('Codex registry entry', () => {
  for (const installed of [false, true]) {
    test(`creates exactly one CodexAdapter with the pinned binary ${installed ? 'present' : 'missing'}`, async () => {
      const f = setup();
      if (installed) writeCodexShim(join(f.paths.runner, vendorBinary('codex', CODEX_VERSION)), codexScenario());
      const agflow = { command: '/fake/agflow', args: [] };
      expect(codexAdapterFactory({ config: f.config, paths: f.paths, agflow })).toBeInstanceOf(CodexAdapter);
      const adapters = createAdapters(f.config, f.paths, { agflow }).filter(({ vendor }) => vendor === 'codex');
      expect(adapters).toHaveLength(1);
      expect(adapters[0]).toBeInstanceOf(CodexAdapter);
      // The production entry preflights the host platform, so an unpinned one (CI's linux-x64) is unsupported.
      const problem = VENDOR_PINS[vendorPlatform()]?.codex ? 'binary missing' : 'unsupported platform';
      if (!installed) expect((await adapters[0]!.preflight()).facts).toMatchObject({ ready: false, problem });
    });
  }
});

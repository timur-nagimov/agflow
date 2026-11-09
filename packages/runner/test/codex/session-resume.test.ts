import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, realpathSync } from 'node:fs';
import { BRIDGE_TOOL_NAMES } from '../../src/adapters/bridge-tools';
import { CODEX_VERSION } from '../../src/adapters/codex/binary';
import { appServerArgs, appServerEnv, codexToolsNote, threadOverrides } from '../../src/adapters/codex/config';
import type { ResultOf } from '../../src/adapters/codex/methods';
import { CodexSession } from '../../src/adapters/codex/session';
import { memoryLogger } from '../../src/log';
import { codexMessages as m, FAKE_THREAD_ID, readCodexRecord, type CodexRun, type ScriptedAnswers } from './peer';
import {
  cleanupSessions,
  collect,
  firstInput,
  mcp,
  rejectedStart,
  sessionFixture,
  skills,
  type SessionFixture,
} from './session-fixture';

const SESSION_REF = 'previous-thread';

afterEach(cleanupSessions);

function setup(answers: ScriptedAnswers = {}, version = CODEX_VERSION): SessionFixture {
  return sessionFixture({ answers, version, resume: SESSION_REF });
}

/** A failed resume never names the thread or sends a prompt. */
async function rejected(f: SessionFixture, reason: string): Promise<CodexRun> {
  const run = await rejectedStart(f, reason);
  expect(run.requests.some((request) => request.method === 'turn/start')).toBe(false);
  expect(run.requests.some((request) => request.method === 'thread/name/set')).toBe(false);
  return run;
}

describe('CodexSession resume', () => {
  test("runs the attempt's recorded binary and resumes with the same overrides without naming or prompting", async () => {
    const version = '0.158.0';
    expect(version).not.toBe(CODEX_VERSION);
    const f = setup({}, version);
    f.options.testConfig = { model_provider: 'scripted' };
    const session = await CodexSession.start(f.launch, f.options);
    await session.close();
    expect(await session.exited).toEqual({ code: 0, signal: null });
    const runs = readCodexRecord(f.bin);
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.argv).toEqual(appServerArgs(f.options.testConfig));
    expect(run.cwd).toBe(realpathSync(f.options.userHome));
    expect(run.env).toEqual(
      appServerEnv({
        base: f.launch.env,
        bridgeEnv: f.launch.bridge.env,
        codexHome: f.options.codexHome,
        userHome: f.options.userHome,
      }),
    );
    expect(f.registrations).toHaveLength(1);
    expect(f.registrations[0]!.pid).toBe(session.pid);
    expect(f.registrations[0]!.at).toBeLessThanOrEqual(run.initializedAt!);
    expect(readFileSync(f.launch.logFile, 'utf8')).toContain('session stderr\n');
    expect(run.requests.map((request) => request.method)).toEqual([
      'initialize',
      'thread/resume',
      'mcpServerStatus/list',
      'skills/list',
      'account/read',
    ]);
    expect(run.requests.slice(1).map((request) => request.params)).toEqual([
      { threadId: SESSION_REF, ...threadOverrides(f.launch, f.options.userHome), excludeTurns: true },
      { threadId: SESSION_REF },
      { cwds: [f.launch.clone] },
      { refreshToken: false },
    ]);
    expect(session.sessionRef).toBe(SESSION_REF);
    expect(await collect(session.events)).toEqual([
      {
        type: 'started',
        sessionRef: SESSION_REF,
        model: f.launch.model,
        cliVersion: version,
        permissionMode: 'on-request',
      },
    ]);
  });

  test('refreshes the tools note on resume without sending a prompt', async () => {
    const tools = BRIDGE_TOOL_NAMES.lead;
    const f = setup({ 'mcpServerStatus/list': { result: mcp(['agflow'], null, [...tools].reverse()) } });
    f.launch.role = 'lead';
    f.launch.bridge.tools = tools;
    f.launch.brief = 'Updated brief for the resumed thread.';
    const session = await CodexSession.start(f.launch, f.options);
    await session.close();
    const { requests } = readCodexRecord(f.bin)[0]!;
    expect(requests.find((r) => r.method === 'thread/resume')!.params).toHaveProperty(
      'developerInstructions', `${f.launch.brief}\n\n${codexToolsNote(tools)}`,
    );
    expect(requests.some((r) => r.method === 'turn/start')).toBe(false);
  });

  test('fails closed when the resumed bridge loses a required tool', async () => {
    const tools = BRIDGE_TOOL_NAMES.worker.filter((name) => name !== 'submit');
    await rejected(setup({ 'mcpServerStatus/list': { result: mcp(['agflow'], null, tools) } }),
      'codex thread is missing agflow tools: submit');
  });

  test('uses the returned thread id and model and warns once after started for unverified project config', async () => {
    const f = setup();
    f.launch.projectConfigVerified = false;
    f.answers['thread/resume'] = {
      result: m.threadResumeResult({
        thread: m.thread({ id: 'returned-thread', cwd: f.launch.clone, model: 'reported-model' }),
      }),
    };
    f.write();
    const session = await CodexSession.start(f.launch, f.options);
    await session.close();
    expect(session.sessionRef).toBe('returned-thread');
    const events = await collect(session.events);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      type: 'started',
      sessionRef: 'returned-thread',
      model: 'reported-model',
      cliVersion: CODEX_VERSION,
      permissionMode: 'on-request',
    });
    expect(events[1]).toMatchObject({ type: 'warning', text: expect.stringContaining('untrusted') });
    const run = readCodexRecord(f.bin)[0]!;
    expect(run.requests[1]!.params).toEqual({
      threadId: SESSION_REF,
      ...threadOverrides(f.launch, f.options.userHome),
      excludeTurns: true,
    });
    expect(run.requests[1]!.params).toMatchObject({
      config: { projects: { [f.launch.clone]: { trust_level: 'untrusted' } } },
    });
    expect(run.requests[2]!.params).toEqual({ threadId: 'returned-thread' });
    expect(run.requests.map((request) => request.method)).toEqual([
      'initialize',
      'thread/resume',
      'mcpServerStatus/list',
      'skills/list',
      'account/read',
    ]);
  });

  const badResponses: [string, Partial<ResultOf<'thread/resume'>>, string][] = [
    ['approval policy', { approvalPolicy: 'never' }, 'approval policy'],
    ['reviewer', { approvalsReviewer: 'guardian_subagent' }, 'approvals reviewer'],
    ['sandbox type', { sandbox: { type: 'readOnly', networkAccess: false } }, 'sandbox readOnly, expected workspaceWrite'],
    ['sandbox type and network', { sandbox: { type: 'dangerFullAccess' } }, 'sandbox'],
    [
      'sandbox network',
      {
        sandbox: {
          type: 'workspaceWrite',
          writableRoots: [],
          networkAccess: true,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        },
      },
      'network',
    ],
    ['cwd', { cwd: '/wrong\n  clone' }, 'cwd'],
  ];
  for (const [name, patch, reason] of badResponses) {
    test(`rejects a resumed thread reporting the wrong ${name}`, async () => {
      const f = setup();
      f.answers['thread/resume'] = {
        result: { ...m.threadResumeResult({ thread: m.thread({ id: SESSION_REF, cwd: f.launch.clone }) }), ...patch },
      };
      f.write();
      await rejected(f, `codex thread/resume reported ${reason === 'network' ? 'sandbox network' : reason}`);
    });
  }

  test('rejects unexpected MCP servers after resume', async () => {
    await rejected(setup({ 'mcpServerStatus/list': { result: mcp(['agflow', 'other']) } }), 'MCP servers');
  });
  test('rejects user skills after resume', async () => {
    await rejected(setup({ 'skills/list': { result: skills('user') } }), 'user or plugin skills');
  });
  for (const stage of ['thread/resume', 'mcpServerStatus/list', 'skills/list'] as const) {
    test(`a configuration warning during ${stage} fails closed`, async () => {
      const f = setup();
      const then = [{ notify: m.configWarning('ignored setting\n  not_a_real_key') }];
      if (stage === 'thread/resume') {
        f.answers[stage] = { then };
        f.answers['mcpServerStatus/list'] = { result: mcp(), delayMs: 30 };
      } else if (stage === 'mcpServerStatus/list') {
        f.answers[stage] = { result: mcp(), then };
        f.answers['skills/list'] = { result: skills('system'), delayMs: 30 };
      } else {
        f.answers['mcpServerStatus/list'] = { result: mcp(), then: [{ delayMs: 10 }, ...then] };
        f.answers[stage] = { result: skills('system'), delayMs: 50 };
      }
      f.write();
      await rejected(f, 'configuration warning: ignored setting not_a_real_key');
    });
  }

  for (const verified of [true, false]) {
    test(`a missing rollout starts fresh in the same process and clone (verified: ${verified})`, async () => {
      const f = setup({
        'thread/resume': { error: { code: -32600, message: `no rollout found for thread id ${SESSION_REF}` } },
      });
      f.launch.projectConfigVerified = verified;
      const logger = memoryLogger();
      f.options.logger = logger;
      const session = await CodexSession.start(f.launch, f.options);
      await session.close();
      expect(await session.exited).toEqual({ code: 0, signal: null });
      expect(session.sessionRef).toBe(FAKE_THREAD_ID);
      expect(session.sessionRef).not.toBe(SESSION_REF);
      const runs = readCodexRecord(f.bin);
      expect(runs).toHaveLength(1);
      expect(f.registrations).toHaveLength(1);
      expect(runs[0]!.cwd).toBe(realpathSync(f.options.userHome));
      expect(runs[0]!.requests.map((request) => request.method)).toEqual([
        'initialize',
        'thread/resume',
        'thread/start',
        'mcpServerStatus/list',
        'skills/list',
        'account/read',
        'thread/name/set',
        'turn/start',
      ]);
      expect(runs[0]!.requests.slice(1).map((request) => request.params)).toEqual([
        { threadId: SESSION_REF, ...threadOverrides(f.launch, f.options.userHome), excludeTurns: true },
        threadOverrides(f.launch, f.options.userHome),
        { threadId: FAKE_THREAD_ID },
        { cwds: [f.launch.clone] },
        { refreshToken: false },
        { threadId: FAKE_THREAD_ID, name: `agflow ${f.launch.attemptId}` },
        { threadId: FAKE_THREAD_ID, input: firstInput(f.launch.firstPrompt) },
      ]);
      const events = await collect(session.events);
      expect(events).toHaveLength(verified ? 1 : 2);
      expect(events[0]).toEqual({
        type: 'started',
        sessionRef: FAKE_THREAD_ID,
        model: f.launch.model,
        cliVersion: CODEX_VERSION,
        permissionMode: 'on-request',
      });
      if (!verified) expect(events[1]).toMatchObject({ type: 'warning', text: expect.stringContaining('untrusted') });
      expect(logger.entries.filter((entry) => entry.level === 'info' || entry.level === 'warn')).toEqual([
        {
          level: expect.stringMatching(/^(info|warn)$/),
          message: expect.stringContaining('no rollout found'),
          fields: { attemptId: f.launch.attemptId, sessionRef: SESSION_REF },
        },
      ]);
    });
  }

  for (const [code, message] of [
    [-32600, 'cannot resume\n  corrupted thread'],
    [-32603, `no rollout found for thread id ${SESSION_REF}`],
    [-32600, 'other error: no rollout found'],
  ] as const) {
    test(`rejects resume error ${code}: ${message}`, async () => {
      const run = await rejected(
        setup({ 'thread/resume': { error: { code, message } } }),
        `codex thread/resume failed: ${message.replace(/\s+/g, ' ')}`,
      );
      expect(run.requests.map((request) => request.method)).toEqual(['initialize', 'thread/resume']);
    });
  }
  test('ends the process when resume times out', async () => {
    const run = await rejected(setup({ 'thread/resume': { silent: true } }), 'codex thread/resume failed:');
    expect(run.requests.map((request) => request.method)).toEqual(['initialize', 'thread/resume']);
  });
  test('rejects when the process exits during resume', async () => {
    const run = await rejected(
      setup({ 'thread/resume': { silent: true, then: [{ crash: { code: 7 } }] } }),
      'codex thread/resume failed:',
    );
    expect(run.requests.map((request) => request.method)).toEqual(['initialize', 'thread/resume']);
  });
});

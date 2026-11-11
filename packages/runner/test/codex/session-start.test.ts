import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, realpathSync } from 'node:fs';
import { BRIDGE_TOOL_NAMES } from '../../src/adapters/bridge-tools';
import { CODEX_VERSION } from '../../src/adapters/codex/binary';
import { appServerArgs, appServerEnv, codexToolsNote, threadOverrides } from '../../src/adapters/codex/config';
import type { ResultOf } from '../../src/adapters/codex/methods';
import type { ServerNotification } from '../../src/adapters/codex/protocol';
import { CodexSession } from '../../src/adapters/codex/session';
import {
  codexMessages as m,
  codexScenario,
  FAKE_THREAD_ID,
  readCodexRecord,
  writeCodexShim,
  type CodexRun,
  type ScriptedAnswers,
} from './peer';
import {
  alive,
  cleanupSessions,
  collect,
  firstInput,
  mcp,
  rejectedStart,
  sessionFixture,
  skills,
  type SessionFixture,
} from './session-fixture';

afterEach(cleanupSessions);

function setup(answers: ScriptedAnswers = {}, version = CODEX_VERSION): SessionFixture {
  return sessionFixture({ answers, version });
}

function startupStatus(threadId: string | null, name: string): ServerNotification {
  return {
    method: 'mcpServer/startupStatus/updated',
    params: { threadId, name, status: 'starting', error: null, failureReason: null },
  };
}

async function rejected(f: SessionFixture, reason: string, turnSent = false): Promise<CodexRun> {
  const run = await rejectedStart(f, reason);
  expect(run.requests.some((request) => request.method === 'turn/start')).toBe(turnSent);
  return run;
}

describe('CodexSession.start', () => {
  for (const version of [CODEX_VERSION, '0.158.0']) {
    test(`runs the attempt's ${version} binary with exact launch settings and ordered requests`, async () => {
      const f = setup({}, version);
      if (version !== CODEX_VERSION) f.options.testConfig = { model_provider: 'scripted' };
      const session = await CodexSession.start(f.launch, f.options);
      expect(alive(session.pid)).toBe(true);
      expect(session.sessionRef).toBe(FAKE_THREAD_ID);
      await session.close();
      expect(await session.exited).toEqual({ code: 0, signal: null });
      const [run] = readCodexRecord(f.bin);
      expect(run!.argv).toEqual(appServerArgs(f.options.testConfig));
      expect(run!.cwd).toBe(realpathSync(f.options.userHome));
      expect(run!.env).toEqual(
        appServerEnv({
          base: f.launch.env,
          bridgeEnv: f.launch.bridge.env,
          codexHome: f.options.codexHome,
          userHome: f.options.userHome,
        }),
      );
      expect(f.registrations).toHaveLength(1);
      expect(f.registrations[0]!.pid).toBe(session.pid);
      expect(f.registrations[0]!.at).toBeLessThanOrEqual(run!.initializedAt!);
      expect(readFileSync(f.launch.logFile, 'utf8')).toContain('session stderr\n');
      expect(run!.requests.map((request) => request.method)).toEqual([
        'initialize',
        'thread/start',
        'mcpServerStatus/list',
        'skills/list',
        'account/read',
        'thread/name/set',
        'turn/start',
      ]);
      expect(run!.requests.slice(1).map((request) => request.params)).toEqual([
        threadOverrides(f.launch, f.options.userHome),
        { threadId: session.sessionRef },
        { cwds: [f.launch.clone] },
        { refreshToken: false },
        { threadId: session.sessionRef, name: 'agflow T-42-a3' },
        { threadId: session.sessionRef, input: firstInput(f.launch.firstPrompt) },
      ]);
      expect(await collect(session.events)).toEqual([
        {
          type: 'started',
          sessionRef: session.sessionRef,
          model: f.launch.model,
          cliVersion: version,
          permissionMode: 'on-request',
        },
      ]);
    });
  }

  for (const role of ['worker', 'lead'] as const) {
    test(`${role} tools persist in developer instructions and the first prompt stays unchanged`, async () => {
      const tools = BRIDGE_TOOL_NAMES[role];
      const f = setup({ 'mcpServerStatus/list': { result: mcp(['agflow'], null, [...tools].reverse()) } });
      f.launch.role = role;
      f.launch.bridge.tools = tools;
      const session = await CodexSession.start(f.launch, f.options);
      await session.close();
      const { requests } = readCodexRecord(f.bin)[0]!;
      const start = requests.find((request) => request.method === 'thread/start');
      expect(start!.params).toHaveProperty('developerInstructions', `${f.launch.brief}\n\n${codexToolsNote(tools)}`);
      const turn = requests.find((request) => request.method === 'turn/start');
      expect(turn!.params).toEqual({ threadId: session.sessionRef, input: firstInput(f.launch.firstPrompt) });
    });
  }

  test('rejects a nonempty bridge listing missing a required tool before prompting', async () => {
    const tools = BRIDGE_TOOL_NAMES.worker.filter((name) => name !== 'submit');
    await rejected(setup({ 'mcpServerStatus/list': { result: mcp(['agflow'], null, tools) } }),
      'codex thread is missing agflow tools: submit');
  });

  test('warns about extra tools without adding them to developer instructions', async () => {
    const f = setup({ 'mcpServerStatus/list': { result: mcp(['agflow'], null, [...BRIDGE_TOOL_NAMES.worker, 'extra']) } });
    const session = await CodexSession.start(f.launch, f.options);
    await session.close();
    expect(await collect(session.events)).toContainEqual({ type: 'warning', text: 'codex thread lists extra agflow tools: extra' });
    expect(readCodexRecord(f.bin)[0]!.requests[1]!.params).toHaveProperty(
      'developerInstructions', `${f.launch.brief}\n\n${codexToolsNote(f.launch.bridge.tools)}`,
    );
  });

  for (const toolsError of [null, 'tools/list failed\n  bridge said no']) {
    test(`rejects an agflow server that lists no tools (toolsError ${JSON.stringify(toolsError)})`, async () => {
      const listing = mcp(['agflow'], null, []);
      listing.data[0]!.toolsError = toolsError;
      const reason = 'codex thread lists no agflow tools' + (toolsError ? ': tools/list failed bridge said no' : '');
      await rejected(setup({ 'mcpServerStatus/list': { result: listing } }), reason);
    });
  }

  test('rejects an initialize version mismatch before opening a thread', async () => {
    const f = setup({
      initialize: { result: m.initializeResult('0.1.0', { name: 'agflow', version: 'test' }, '/tmp') },
    });
    const run = await rejected(f, `reports version 0.1.0, expected ${CODEX_VERSION}`);
    expect(run.requests.map((request) => request.method)).toEqual(['initialize']);
  });

  const badResponses: [string, Partial<ResultOf<'thread/start'>>, string][] = [
    ['approval policy', { approvalPolicy: 'never' }, 'approval policy'],
    ['reviewer', { approvalsReviewer: 'guardian_subagent' }, 'reviewer'],
    ['sandbox type', { sandbox: { type: 'readOnly', networkAccess: false } }, 'expected workspaceWrite'],
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
    test(`rejects a thread reporting the wrong ${name}`, async () => {
      const f = setup();
      f.answers['thread/start'] = {
        result: { ...m.threadStartResult({ thread: m.thread({ id: FAKE_THREAD_ID, cwd: f.launch.clone }) }), ...patch },
      };
      f.write();
      await rejected(f, reason);
    });
  }

  for (const names of [[], ['other\n server'], ['agflow', 'other'], ['agflow', 'agflow']]) {
    test(`rejects unexpected MCP inventory ${JSON.stringify(names)}`, async () => {
      await rejected(setup({ 'mcpServerStatus/list': { result: mcp(names) } }), 'MCP servers');
    });
  }
  test('rejects an incomplete MCP inventory', async () => {
    await rejected(setup({ 'mcpServerStatus/list': { result: mcp(['agflow'], 'more') } }), 'MCP');
  });
  // 0.159.2 lists neither a starting nor a failed server, so a trusted project config's server shows up only in its
  // startup status, which the thread sends before thread/start answers.
  for (const threadId of [FAKE_THREAD_ID, null]) {
    test(`rejects an MCP server that only a startup status shows (threadId ${threadId})`, async () => {
      const f = setup({
        initialize: {
          then: [
            { delayMs: 10 },
            { notify: startupStatus(threadId, 'agflow') },
            { notify: startupStatus(threadId, 'planted') },
          ],
        },
        'thread/start': { delayMs: 50 },
      });
      await rejected(f, 'codex thread started unexpected MCP servers: planted');
    });
  }
  test("accepts agflow's startup status and ignores another thread's", async () => {
    const f = setup({
      initialize: {
        then: [
          { delayMs: 10 },
          { notify: startupStatus(FAKE_THREAD_ID, 'agflow') },
          { notify: startupStatus('another-thread', 'planted') },
        ],
      },
      'thread/start': { delayMs: 50 },
    });
    const session = await CodexSession.start(f.launch, f.options);
    await session.close();
  });
  for (const [scope, pluginId] of [
    ['user', null],
    ['system', 'plugin'],
    ['repo', 'plugin'],
  ] as const) {
    test(`rejects ${scope} skills with pluginId ${pluginId}`, async () => {
      await rejected(
        setup({ 'skills/list': { result: skills(scope, pluginId) } }),
        'user or plugin skills: example-skill',
      );
    });
  }

  for (const method of [
    'thread/start',
    'mcpServerStatus/list',
    'skills/list',
    'thread/name/set',
    'turn/start',
  ] as const) {
    test(`ends the process when ${method} fails`, async () => {
      await rejected(
        setup({ [method]: { error: { code: -32603, message: 'required MCP servers failed\n  agflow exited' } } }),
        `${method} failed: required MCP servers failed agflow exited`,
        method === 'turn/start',
      );
    });
  }
  test('ends the process when thread/start times out', async () => {
    await rejected(setup({ 'thread/start': { silent: true } }), 'thread/start failed:');
  });
  test('rejects when the peer exits during thread/start', async () => {
    await rejected(setup({ 'thread/start': { silent: true, then: [{ crash: { code: 7 } }] } }), 'thread/start failed:');
  });

  for (const stage of ['thread/start', 'mcpServerStatus/list', 'skills/list'] as const) {
    test(`a configuration warning during ${stage} fails closed`, async () => {
      const f = setup();
      const then = [{ notify: m.configWarning('ignored setting\n  not_a_real_key') }];
      // Hold the checks open even if the warning is delivered separately from the preceding answer.
      if (stage === 'thread/start') {
        f.answers['thread/start'] = { then };
        f.answers['mcpServerStatus/list'] = { result: mcp(), delayMs: 30 };
      }
      if (stage === 'mcpServerStatus/list') {
        f.answers['mcpServerStatus/list'] = { result: mcp(), then };
        f.answers['skills/list'] = { result: skills('system'), delayMs: 30 };
      }
      if (stage === 'skills/list') {
        f.answers['mcpServerStatus/list'] = {
          result: mcp(),
          then: [{ delayMs: 10 }, { notify: m.configWarning('ignored setting\n  not_a_real_key') }],
        };
        f.answers['skills/list'] = { result: skills('system'), delayMs: 50 };
      }
      f.write();
      await rejected(f, 'configuration warning: ignored setting not_a_real_key');
    });
  }

  test('catches a configuration warning before thread/start answers', async () => {
    const f = setup({
      initialize: { then: [{ delayMs: 10 }, { notify: m.configWarning('ignored setting\n  before thread') }] },
      'thread/start': { delayMs: 50 },
    });
    await rejected(f, 'configuration warning: ignored setting before thread');
  });

  test('accepts repo skills, reports the returned model, and runs unverified project config untrusted', async () => {
    const f = setup({ 'skills/list': { result: skills('repo') } });
    f.launch.projectConfigVerified = false;
    f.answers['thread/start'] = {
      result: m.threadStartResult({
        thread: m.thread({ id: FAKE_THREAD_ID, cwd: f.launch.clone, model: 'reported-model' }),
      }),
    };
    f.write();
    const session = await CodexSession.start(f.launch, f.options);
    const iterator = session.events[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({
      type: 'started',
      sessionRef: FAKE_THREAD_ID,
      model: 'reported-model',
      cliVersion: CODEX_VERSION,
      permissionMode: 'on-request',
    });
    const warning = (await iterator.next()).value;
    expect(warning).toMatchObject({ type: 'warning' });
    expect(warning.text).toContain('.codex/');
    expect(warning.text).toContain('restore base');
    expect(warning.text).toContain('untrusted');
    expect(warning.text).toContain('skills still load');
    const pending = iterator.next();
    await session.close();
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(await session.exited).toEqual({ code: 0, signal: null });
    const overrides = threadOverrides(f.launch, f.options.userHome);
    expect(readCodexRecord(f.bin)[0]!.requests[1]!.params).toEqual(overrides);
    expect(overrides.config.projects[f.launch.clone]!.trust_level).toBe('untrusted');
  });

  test('a sqlite startup exit rejects with its reason instead of registering a second process', async () => {
    const f = setup();
    writeCodexShim(f.bin, [
      codexScenario({ failBeforeInitialize: { stderr: 'Error: failed to initialize sqlite state runtime', code: 1 } }),
      codexScenario({ answers: f.answers }),
    ]);
    const registered: number[] = [];
    f.launch.registerProcess = (pid) => {
      // M2b's ProcessRegistration: a launch registers exactly one pid.
      if (registered.length > 0) throw new Error(`the agent of ${f.launch.attemptId} was already registered`);
      registered.push(pid);
    };
    await expect(CodexSession.start(f.launch, f.options)).rejects.toThrow('failed to initialize sqlite state runtime');
    expect(registered).toHaveLength(1);
    const runs = readCodexRecord(f.bin);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.exit?.code).toBe(1);
    expect(alive(registered[0]!)).toBe(false);
  });

  test('ends the event iterator on an unrequested process exit', async () => {
    const f = setup({ 'turn/start': { then: [{ delayMs: 30 }, { crash: { code: 7 } }] } });
    const session = await CodexSession.start(f.launch, f.options);
    expect(await collect(session.events)).toHaveLength(1);
    expect(await session.exited).toEqual({ code: 7, signal: null });
    await session.close();
  });
});

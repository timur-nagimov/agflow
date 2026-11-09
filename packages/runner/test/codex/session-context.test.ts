import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { CODEX_VERSION } from '../../src/adapters/codex/binary';
import type { ServerNotification } from '../../src/adapters/codex/protocol';
import type { CodexErrorInfo } from '../../src/adapters/codex/protocol/v2';
import { CodexSession } from '../../src/adapters/codex/session';
import type { AgentEvent } from '../../src/adapters/types';
import {
  codexMessages as m,
  FAKE_THREAD_ID as MAIN,
  fakeTurnId,
  readCodexRecord,
  type ScriptedAnswers,
  type ScriptedStep,
} from './peer';
import { cleanupSessions, collect, firstInput, sessionFixture } from './session-fixture';

const FIRST = fakeTurnId(1);
const NEXT = fakeTurnId(2);
const COMPACT = 'compaction-turn';
const NOTE = 'System note: The context window filled up and was compacted. Continue your task where you left off.';
const started: AgentEvent = {
  type: 'started',
  sessionRef: MAIN,
  model: 'requested-model',
  cliVersion: CODEX_VERSION,
  permissionMode: 'on-request',
};
const turnStarted: AgentEvent = { type: 'turn_started' };
const compacted: AgentEvent = { type: 'compacted', summary: null };
const ended = (
  error: string | null = null,
  toolCalls = 0,
  errorKind: Extract<AgentEvent, { type: 'turn_ended' }>['errorKind'] = error === null ? null : 'context',
): AgentEvent => ({
  type: 'turn_ended',
  outcome: error === null ? 'completed' : 'failed',
  toolCalls,
  error,
  errorKind,
});
const tool = (id = 'exec') =>
  m.commandExecutionItem({ id, command: 'echo hi', cwd: '/tmp', status: 'completed', exitCode: 0 });
const toolEvents = (toolId = 'exec'): AgentEvent[] => [
  { type: 'tool_started', toolId, name: 'exec_command', input: 'echo hi', command: 'echo hi' },
  { type: 'tool_ended', toolId, ok: true, denied: false, terminal: null, hubUnreachable: false },
];
/** A compaction turn that ends with status and, when failed, that final error. */
const compactionEnd = (status: 'failed' | 'interrupted', info?: CodexErrorInfo, message = 'compaction failed') =>
  steps([
    begin(COMPACT),
    ...(info === undefined ? [] : [m.error(MAIN, COMPACT, m.turnError(info, message))]),
    m.turnCompleted(MAIN, m.turn({ id: COMPACT, status })),
  ]);
const begin = (id: string, thread = MAIN) => m.turnStarted(thread, m.turn({ id, status: 'inProgress' }));
const finish = (id: string) => m.turnCompleted(MAIN, m.turn({ id, status: 'completed' }));
const steps = (notes: ServerNotification[]): ScriptedStep[] => notes.map((notify) => ({ notify }));
const failure = (id: string): ServerNotification[] => [
  m.error(MAIN, id, m.turnError('contextWindowExceeded', 'context full')),
  m.turnCompleted(MAIN, m.turn({ id, status: 'failed' })),
];
const compaction = (id: string): ServerNotification[] => [
  m.itemStarted(MAIN, id, m.contextCompactionItem()),
  m.itemCompleted(MAIN, id, m.contextCompactionItem()),
  { method: 'thread/compacted', params: { threadId: MAIN, turnId: id } },
];
const compactRequest = { method: 'thread/compact/start', params: { threadId: MAIN } };
const continuationRequest = {
  method: 'turn/start',
  params: { threadId: MAIN, input: [{ type: 'text', text: NOTE, text_elements: [] }] },
};

afterEach(() => {
  mock.restore();
  cleanupSessions();
});

async function run(first: ServerNotification[], overrides: ScriptedAnswers = {}) {
  const f = sessionFixture({
    answers: {
      'turn/start': [
        // Bound a broken recovery too, so a missing request fails an assertion rather than hanging the test.
        { then: [...steps(first), { delayMs: 500 }, { crash: { code: 0 } }] },
        { then: [...steps([begin(NEXT), finish(NEXT)]), { crash: { code: 0 } }] },
      ],
      'thread/compact/start': { result: {}, then: steps([begin(COMPACT), ...compaction(COMPACT), finish(COMPACT)]) },
      ...overrides,
    },
  });
  const session = await CodexSession.start(f.launch, f.options);
  const events = await collect(session.events);
  expect(await session.exited).toEqual({ code: 0, signal: null });
  expect(session.activeTurnId).toBeNull();
  await session.close();
  const requests = readCodexRecord(f.bin)[0]!
    .requests.filter(({ method }) => method === 'turn/start' || method === 'thread/compact/start')
    .map(({ method, params }) => ({ method, params }));
  const firstRequest = {
    method: 'turn/start',
    params: { threadId: MAIN, input: firstInput(f.launch.firstPrompt) },
  };
  return { events, requests, firstRequest };
}

describe('CodexSession context recovery', () => {
  test('hides the failed end and compaction turn, then starts one ordinary continuation', async () => {
    const result = await run([begin(FIRST), ...failure(FIRST)]);
    expect(result.events).toEqual([started, turnStarted, compacted, turnStarted, ended()]);
    expect(result.requests).toEqual([result.firstRequest, compactRequest, continuationRequest]);
  });

  test("a failed turn's own contextWindowExceeded, without a final error, is recovered too", async () => {
    const result = await run([
      begin(FIRST),
      m.turnCompleted(
        MAIN,
        m.turn({ id: FIRST, status: 'failed', error: m.turnError('contextWindowExceeded', 'full') }),
      ),
    ]);
    expect(result.events).toEqual([started, turnStarted, compacted, turnStarted, ended()]);
    expect(result.requests).toEqual([result.firstRequest, compactRequest, continuationRequest]);
  });

  test('a second final context error ends the continuation without another compaction', async () => {
    const tool = m.commandExecutionItem({
      id: 'exec',
      command: 'echo hi',
      cwd: '/tmp',
      status: 'completed',
      exitCode: 0,
    });
    const result = await run([], {
      'turn/start': [
        { then: [...steps([begin(FIRST), ...failure(FIRST)]), { delayMs: 500 }, { crash: { code: 0 } }] },
        {
          then: [...steps([begin(NEXT), m.itemCompleted(MAIN, NEXT, tool), ...failure(NEXT)]), { crash: { code: 0 } }],
        },
      ],
    });
    expect(result.events).toEqual([
      started,
      turnStarted,
      compacted,
      turnStarted,
      { type: 'tool_started', toolId: 'exec', name: 'exec_command', input: 'echo hi', command: 'echo hi' },
      { type: 'tool_ended', toolId: 'exec', ok: true, denied: false, terminal: null, hubUnreachable: false },
      ended('context full', 1),
    ]);
    expect(result.requests).toEqual([result.firstRequest, compactRequest, continuationRequest]);
  });

  test('automatic compaction leaves normal turns visible and preserves the recovery allowance', async () => {
    const result = await run([
      begin(FIRST),
      m.error(MAIN, FIRST, m.turnError('contextWindowExceeded', 'retrying'), true),
      m.error('child-thread', 'child', m.turnError('contextWindowExceeded', 'child full')),
      m.itemCompleted('child-thread', 'child', m.contextCompactionItem()),
      ...compaction(FIRST),
      finish(FIRST),
      begin('later'),
      ...failure('later'),
    ]);
    expect(result.events).toEqual([
      started,
      turnStarted,
      compacted,
      ended(),
      turnStarted,
      compacted,
      turnStarted,
      ended(),
    ]);
    expect(result.requests).toEqual([result.firstRequest, compactRequest, continuationRequest]);
  });

  test("a rejected compaction request exposes one context failure with the failed turn's tools", async () => {
    const result = await run([begin(FIRST), m.itemCompleted(MAIN, FIRST, tool()), ...failure(FIRST)], {
      'thread/compact/start': { error: { code: -32603, message: 'cannot compact' } },
    });
    expect(result.events).toEqual([
      started,
      turnStarted,
      ...toolEvents(),
      ended('codex thread/compact/start failed: cannot compact', 1),
    ]);
    expect(result.requests).toEqual([result.firstRequest, compactRequest]);
  });

  test('a failed compaction turn ends as its own failure, counting the tools of both hidden turns', async () => {
    const result = await run([begin(FIRST), m.itemCompleted(MAIN, FIRST, tool()), ...failure(FIRST)], {
      'thread/compact/start': {
        result: {},
        then: steps([
          begin(COMPACT),
          m.itemCompleted(MAIN, COMPACT, tool('compact-exec')),
          m.error(MAIN, COMPACT, m.turnError('internalServerError', 'compaction failed')),
          m.turnCompleted(MAIN, m.turn({ id: COMPACT, status: 'failed' })),
        ]),
      },
    });
    expect(result.events).toEqual([
      started,
      turnStarted,
      ...toolEvents(),
      ...toolEvents('compact-exec'),
      ended('compaction failed', 2, 'vendor'),
    ]);
    expect(result.requests).toEqual([result.firstRequest, compactRequest]);
  });

  test('an interrupted compaction turn ends interrupted, without a continuation', async () => {
    const result = await run([begin(FIRST), ...failure(FIRST)], {
      'thread/compact/start': { result: {}, then: compactionEnd('interrupted') },
    });
    expect(result.events).toEqual([
      started,
      turnStarted,
      { type: 'turn_ended', outcome: 'interrupted', toolCalls: 0, error: null, errorKind: null },
    ]);
    expect(result.requests).toEqual([result.firstRequest, compactRequest]);
  });

  test('a compaction turn that hits the usage limit reports the exhausted quota, then a quota failure', async () => {
    const now = 1793200000000;
    spyOn(Date, 'now').mockReturnValue(now);
    const result = await run([begin(FIRST), ...failure(FIRST)], {
      'thread/compact/start': { result: {}, then: compactionEnd('failed', 'usageLimitExceeded', 'usage limit') },
    });
    expect(result.events).toEqual([
      started,
      turnStarted,
      {
        type: 'quota',
        accountId: null,
        quota: {
          state: 'exhausted',
          resetsAt: null,
          windows: { fiveHour: null, weekly: null },
          paidUsage: 'unknown',
          updatedAt: now,
        },
      },
      ended('usage limit', 0, 'quota'),
    ]);
    expect(result.requests).toEqual([result.firstRequest, compactRequest]);
  });

  test('an unauthorized compaction turn is an auth failure', async () => {
    const result = await run([begin(FIRST), ...failure(FIRST)], {
      'thread/compact/start': { result: {}, then: compactionEnd('failed', 'unauthorized', 'login expired') },
    });
    expect(result.events).toEqual([started, turnStarted, ended('login expired', 0, 'auth')]);
    expect(result.requests).toEqual([result.firstRequest, compactRequest]);
  });

  test('a compaction request that times out after its turn started lets that turn decide', async () => {
    const result = await run([], {
      'turn/start': [
        {
          then: [
            ...steps([begin(FIRST), ...failure(FIRST)]),
            { delayMs: 50 },
            { notify: begin(COMPACT) },
            { delayMs: 400 },
            { notify: finish(COMPACT) },
            { delayMs: 500 },
            { crash: { code: 0 } },
          ],
        },
        { then: [...steps([begin(NEXT), finish(NEXT)]), { crash: { code: 0 } }] },
      ],
      'thread/compact/start': { silent: true },
    });
    expect(result.events).toEqual([started, turnStarted, turnStarted, ended()]);
    expect(result.requests).toEqual([result.firstRequest, compactRequest, continuationRequest]);
  });

  for (const stage of ['compaction', 'continuation'] as const) {
    test(`an exit during the ${stage} request reports no context failure`, async () => {
      const crash = {
        silent: true,
        then: [{ delayMs: 50 }, { crash: { signal: 'SIGKILL' } }] satisfies ScriptedStep[],
      };
      const f = sessionFixture({
        answers: {
          'turn/start': [{ then: steps([begin(FIRST), ...failure(FIRST)]) }, crash],
          'thread/compact/start':
            stage === 'compaction'
              ? crash
              : { result: {}, then: steps([begin(COMPACT), ...compaction(COMPACT), finish(COMPACT)]) },
        },
      });
      const session = await CodexSession.start(f.launch, f.options);
      expect(await collect(session.events)).toEqual(
        stage === 'compaction' ? [started, turnStarted] : [started, turnStarted, compacted],
      );
      expect(await session.exited).toEqual({ code: null, signal: 'SIGKILL' });
      await session.close();
    });
  }

  test('hidden-turn tools still report progress without increasing the continuation tool count', async () => {
    const tool = m.commandExecutionItem({
      id: 'exec',
      command: 'echo hi',
      cwd: '/tmp',
      status: 'completed',
      exitCode: 0,
    });
    const result = await run([begin(FIRST), ...failure(FIRST)], {
      'thread/compact/start': {
        result: {},
        then: steps([
          begin('child', 'child-thread'),
          begin(COMPACT),
          m.itemCompleted(MAIN, COMPACT, tool),
          m.itemCompleted('child-thread', 'child', { ...tool, id: 'child-exec' }),
          ...compaction(COMPACT),
          finish(COMPACT),
        ]),
      },
    });
    expect(result.events).toEqual([
      started,
      turnStarted,
      ...['exec', 'child-exec'].flatMap<AgentEvent>((toolId) => [
        { type: 'tool_started', toolId, name: 'exec_command', input: 'echo hi', command: 'echo hi' },
        { type: 'tool_ended', toolId, ok: true, denied: false, terminal: null, hubUnreachable: false },
      ]),
      compacted,
      turnStarted,
      ended(),
    ]);
    expect(result.requests).toEqual([result.firstRequest, compactRequest, continuationRequest]);
  });

  test('waits for the failed completion and keeps the continuation answer active before its start notification', async () => {
    const f = sessionFixture({
      answers: {
        'turn/start': [
          {
            then: [
              ...steps([begin(FIRST), failure(FIRST)[0]!, m.warning('before completion')]),
              { delayMs: 100 },
              { notify: failure(FIRST)[1]! },
              { delayMs: 500 },
              { crash: { code: 0 } },
            ],
          },
          {
            then: [
              { notify: m.warning('continuation accepted') },
              { delayMs: 100 },
              ...steps([begin(NEXT), finish(NEXT)]),
              { crash: { code: 0 } },
            ],
          },
        ],
        'thread/compact/start': {
          result: {},
          then: [
            ...steps([begin(COMPACT), m.warning('compacting')]),
            { delayMs: 100 },
            ...steps([...compaction(COMPACT), finish(COMPACT)]),
          ],
        },
      },
    });
    const session = await CodexSession.start(f.launch, f.options);
    const events: AgentEvent[] = [];
    const firstRequest = {
      method: 'turn/start',
      params: { threadId: MAIN, input: firstInput(f.launch.firstPrompt) },
    };
    for await (const event of session.events) {
      events.push(event);
      if (event.type !== 'warning') continue;
      const stage = event.text.replace('codex warning: ', '');
      // The compaction turn is the active one while it runs: interrupts and steers meet it.
      expect(session.activeTurnId).toBe({ 'before completion': FIRST, compacting: COMPACT }[stage] ?? NEXT);
      expect(
        readCodexRecord(f.bin)[0]!
          .requests.filter(({ method }) => method === 'turn/start' || method === 'thread/compact/start')
          .map(({ method, params }) => ({ method, params })),
      ).toEqual(
        {
          'before completion': [firstRequest],
          compacting: [firstRequest, compactRequest],
        }[stage] ?? [firstRequest, compactRequest, continuationRequest],
      );
    }
    expect(events).toEqual([
      started,
      turnStarted,
      { type: 'warning', text: 'codex warning: before completion' },
      { type: 'warning', text: 'codex warning: compacting' },
      compacted,
      { type: 'warning', text: 'codex warning: continuation accepted' },
      turnStarted,
      ended(),
    ]);
    expect(session.activeTurnId).toBeNull();
    await session.close();
  });

  test('a rejected continuation request exposes the recovery failure', async () => {
    const result = await run([], {
      'turn/start': [
        { then: [...steps([begin(FIRST), ...failure(FIRST)]), { delayMs: 500 }, { crash: { code: 0 } }] },
        { error: { code: -32603, message: 'cannot continue' } },
      ],
    });
    expect(result.events).toEqual([started, turnStarted, compacted, ended('codex turn/start failed: cannot continue')]);
    expect(result.requests).toEqual([result.firstRequest, compactRequest, continuationRequest]);
  });
});

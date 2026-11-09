import { afterEach, describe, expect, test } from 'bun:test';
import { CODEX_VERSION } from '../../src/adapters/codex/binary';
import { CodexSession } from '../../src/adapters/codex/session';
import type { AgentEvent } from '../../src/adapters/types';
import { codexMessages as m, FAKE_THREAD_ID as MAIN, fakeTurnId, readCodexRecord, type ScriptedError } from './peer';
import {
  alive,
  cleanupSessions,
  collect,
  firstInput,
  sessionFixture,
  until,
  type SessionFixture,
} from './session-fixture';

const FIRST = fakeTurnId(1);
const NEXT = fakeTurnId(2);
const started: AgentEvent = {
  type: 'started',
  sessionRef: MAIN,
  model: 'requested-model',
  cliVersion: CODEX_VERSION,
  permissionMode: 'on-request',
};
const delivered = (id: string): AgentEvent => ({ type: 'delivered', id });
const acknowledged = (id: string): AgentEvent => ({ type: 'acknowledged', id });
const message = (id: string, authority: 'person' | 'system' | 'agent' = 'person') => ({ id, text: id, authority });
const input = (text: string) => [{ type: 'text', text, text_elements: [] }];
const startRequest = (text: string) => ({ method: 'turn/start', params: { threadId: MAIN, input: input(text) } });
/** The first prompt's turn/start; the tools note is in developer instructions. */
const firstRequest = (f: SessionFixture) => ({
  method: 'turn/start',
  params: { threadId: MAIN, input: firstInput(f.launch.firstPrompt) },
});
const steerRequest = (text: string, expectedTurnId = FIRST) => ({
  method: 'turn/steer',
  params: { threadId: MAIN, input: input(text), expectedTurnId },
});
const interruptRequest = (turnId = FIRST) => ({ method: 'turn/interrupt', params: { threadId: MAIN, turnId } });
const COMPACT = 'compact';
const NOTE = 'System note: The context window filled up and was compacted. Continue your task where you left off.';
const contextFailure = (id = FIRST) =>
  m.turnCompleted(MAIN, m.turn({ id, status: 'failed', error: m.turnError('contextWindowExceeded', 'full') }));
const begin = (id: string) => m.turnStarted(MAIN, m.turn({ id, status: 'inProgress' }));
const turnStarted: AgentEvent = { type: 'turn_started' };
const finish = (id = FIRST, status: 'completed' | 'interrupted' | 'failed' = 'completed', thread = MAIN) =>
  m.turnCompleted(thread, m.turn({ id, status }));
const ended = (outcome: 'completed' | 'interrupted' | 'failed' = 'completed'): AgentEvent => ({
  type: 'turn_ended',
  outcome,
  toolCalls: 0,
  error: null,
  errorKind: outcome === 'failed' ? 'vendor' : null,
});
const notSteerable: ScriptedError = {
  code: -32600,
  message: 'cannot steer',
  data: { codexErrorInfo: { activeTurnNotSteerable: { turnKind: 'compact' } } },
};
const requests = (f: SessionFixture) =>
  readCodexRecord(f.bin)[0]!
    .requests.filter(({ method }) => method.startsWith('turn/'))
    .map(({ method, params }) => ({ method, params }));
const result = (promise: Promise<void>) =>
  promise.then(
    () => null,
    (error: unknown) => error,
  );

afterEach(cleanupSessions);

describe('CodexSession messages', () => {
  test('a completion racing the steer answer still follows delivered and acknowledged', async () => {
    const f = sessionFixture({
      answers: {
        'turn/start': { then: [{ delayMs: 40 }, { notify: finish() }] },
        'turn/steer': { delayMs: 100 },
      },
    });
    const session = await CodexSession.start(f.launch, f.options);
    await session.send(message('racing'));
    await session.close();
    expect(requests(f)).toEqual([firstRequest(f), steerRequest('racing')]);
    expect(await collect(session.events)).toEqual([started, delivered('racing'), acknowledged('racing'), ended()]);
  });

  for (const status of ['completed', 'interrupted', 'failed'] as const) {
    test(`serialises idle person and mid-turn system messages and acknowledges ${status}`, async () => {
      const f = sessionFixture({
        resume: MAIN,
        answers: {
          'turn/start': { delayMs: 60 },
          'turn/steer': { then: [{ notify: finish(FIRST, status, 'child') }, { notify: finish(FIRST, status) }] },
        },
      });
      const session = await CodexSession.start(f.launch, f.options);
      const events: AgentEvent[] = [];
      const draining = (async () => {
        for await (const event of session.events) events.push(event);
      })();
      const first = session.send(message('one'));
      const second = session.send(message('two', 'system'));
      await until(() => requests(f).length > 0);
      expect(requests(f)).toEqual([startRequest('one')]);
      expect(events).toEqual([started]);
      await Promise.all([first, second]);
      await until(() => events.length === 6);
      await session.close();
      await draining;
      expect(requests(f)).toEqual([startRequest('one'), steerRequest('two')]);
      expect(events).toEqual([
        started,
        delivered('one'),
        delivered('two'),
        acknowledged('one'),
        acknowledged('two'),
        ended(status),
      ]);
    });
  }

  for (const text of ['expected active turn id newer, got old', 'no active turn to steer']) {
    test(`retries one start after ${text}`, async () => {
      const f = sessionFixture({
        answers: {
          'turn/steer': { error: { code: -32600, message: text } },
          'turn/start': [{}, { then: [{ notify: finish(NEXT) }] }],
        },
      });
      const session = await CodexSession.start(f.launch, f.options);
      await session.send(message('retry'));
      await until(() => session.activeTurnId === null);
      await session.close();
      expect(requests(f)).toEqual([firstRequest(f), steerRequest('retry'), startRequest('retry')]);
      expect(await collect(session.events)).toEqual([started, delivered('retry'), acknowledged('retry'), ended()]);
    });
  }

  for (const error of [
    { code: -32603, message: 'broken\n  steer' },
    { code: -32600, message: 'another refusal' },
    { code: -32600, message: 'cannot steer', data: { activeTurnNotSteerable: { turnKind: 'compact' } } },
    { ...notSteerable, code: -32603 },
  ]) {
    test(`other steer error rejects without blocking the next send: ${JSON.stringify(error)}`, async () => {
      const f = sessionFixture({ answers: { 'turn/steer': [{ error }, {}] } });
      const session = await CodexSession.start(f.launch, f.options);
      const failed = result(session.send(message('bad')));
      const good = session.send(message('good'));
      expect(((await failed) as Error).message).toBe(`codex turn/steer failed: ${error.message.replace(/\s+/g, ' ')}`);
      await good;
      await session.close();
      expect(requests(f)).toEqual([firstRequest(f), steerRequest('bad'), steerRequest('good')]);
      expect(await collect(session.events)).toEqual([started, delivered('good')]);
    });
  }

  test('holds a non-steerable message and its successors until that main turn completes', async () => {
    const f = sessionFixture({
      answers: {
        'turn/steer': [
          { error: notSteerable, then: [{ notify: finish(FIRST, 'completed', 'child') }] },
          { then: [{ notify: finish(NEXT) }] },
        ],
        'turn/interrupt': { then: [{ delayMs: 30 }, { notify: finish() }] },
      },
    });
    const session = await CodexSession.start(f.launch, f.options);
    const events: AgentEvent[] = [];
    const draining = (async () => {
      for await (const event of session.events) events.push(event);
    })();
    let settled = false;
    const first = session.send(message('held')).then(() => {
      settled = true;
    });
    const second = session.send(message('behind', 'system'));
    await until(() => requests(f).length === 2);
    await Bun.sleep(20);
    expect(settled).toBe(false);
    expect(events).toEqual([started]);
    expect(requests(f)).toEqual([firstRequest(f), steerRequest('held')]);
    await session.interrupt();
    await Promise.all([first, second]);
    await until(() => events.length === 7);
    await session.close();
    await draining;
    expect(requests(f)).toEqual([
      firstRequest(f),
      steerRequest('held'),
      interruptRequest(),
      startRequest('held'),
      steerRequest('behind', NEXT),
    ]);
    expect(events).toEqual([
      started,
      ended(),
      delivered('held'),
      delivered('behind'),
      acknowledged('held'),
      acknowledged('behind'),
      ended(),
    ]);
  });

  for (const active of [true, false]) {
    test(`agent input uses tool authority with active=${active}`, async () => {
      const f = sessionFixture({
        resume: active ? null : MAIN,
        answers: {
          'turn/start': active
            ? [{}, { result: { turn: m.turn({ id: FIRST, status: 'inProgress' }) }, then: [{ notify: finish() }] }]
            : { then: [{ notify: finish() }] },
        },
      });
      const session = await CodexSession.start(f.launch, f.options);
      await session.send(message('agent says', 'agent'));
      await until(() => session.activeTurnId === null);
      await session.close();
      expect(requests(f)).toEqual([
        ...(active ? [firstRequest(f)] : []),
        {
          method: 'turn/start',
          params: {
            threadId: MAIN,
            input: [],
            toolOutput: { name: 'agent_message', namespace: 'agflow', output: 'agent says' },
          },
        },
      ]);
      expect(await collect(session.events)).toEqual([
        started,
        delivered('agent says'),
        acknowledged('agent says'),
        ended(),
      ]);
    });
  }

  test('acknowledges the answered steer id and the hidden context-error turn', async () => {
    const f = sessionFixture({
      answers: {
        'turn/steer': {
          result: { turnId: 'taken' },
          then: [
            { notify: finish() },
            {
              notify: m.turnCompleted(
                MAIN,
                m.turn({ id: 'taken', status: 'failed', error: m.turnError('contextWindowExceeded', 'full') }),
              ),
            },
          ],
        },
        'thread/compact/start': { result: {} },
      },
    });
    const session = await CodexSession.start(f.launch, f.options);
    await session.send(message('context'));
    await until(() => readCodexRecord(f.bin)[0]!.requests.some(({ method }) => method === 'thread/compact/start'));
    await session.close();
    expect(await collect(session.events)).toEqual([started, delivered('context'), ended(), acknowledged('context')]);
    expect(requests(f)).toEqual([firstRequest(f), steerRequest('context')]);
  });

  test('interrupt is idle-safe, cancels held and queued sends, and permits the handoff send', async () => {
    const f = sessionFixture({
      answers: {
        'turn/steer': { error: notSteerable },
        'turn/interrupt': { then: [{ notify: finish(FIRST, 'interrupted') }] },
      },
    });
    const session = await CodexSession.start(f.launch, f.options);
    const first = result(session.send(message('held')));
    const second = result(session.send(message('behind')));
    await until(() => requests(f).length === 2);
    await session.interrupt({ cancelQueued: true });
    expect(((await first) as Error).message).toBe('codex send cancelled');
    expect(((await second) as Error).message).toBe('codex send cancelled');
    await until(() => session.activeTurnId === null);
    await session.interrupt();
    await session.send(message('handoff', 'system'));
    await session.close();
    expect(requests(f)).toEqual([
      firstRequest(f),
      steerRequest('held'),
      interruptRequest(),
      startRequest('handoff'),
    ]);
    expect(await collect(session.events)).toEqual([started, ended('interrupted'), delivered('handoff')]);
  });

  test('interrupt failure is one line', async () => {
    const f = sessionFixture({
      answers: { 'turn/interrupt': { error: { code: -32603, message: 'cannot\n interrupt' } } },
    });
    const session = await CodexSession.start(f.launch, f.options);
    expect(((await result(session.interrupt())) as Error).message).toBe(
      'codex turn/interrupt failed: cannot interrupt',
    );
    await session.close();
    expect(requests(f)).toEqual([firstRequest(f), interruptRequest()]);
    expect(await collect(session.events)).toEqual([started]);
  });

  test('messages sent during recovery wait for the continuation and are steered into its turn', async () => {
    const f = sessionFixture({
      answers: {
        'turn/start': [
          {},
          {
            delayMs: 50,
            result: { turn: m.turn({ id: NEXT, status: 'inProgress' }) },
            then: [{ delayMs: 50 }, { notify: begin(NEXT) }, { notify: finish(NEXT) }],
          },
        ],
        'turn/steer': [{ then: [{ notify: contextFailure() }] }, {}],
        'thread/compact/start': {
          result: {},
          then: [{ notify: begin(COMPACT) }, { delayMs: 100 }, { notify: finish(COMPACT) }],
        },
      },
    });
    const session = await CodexSession.start(f.launch, f.options);
    await session.send(message('before'));
    await until(() => session.activeTurnId === COMPACT);
    const held = session.send(message('held'));
    const behind = session.send(message('behind', 'system'));
    await Bun.sleep(30);
    // Nothing is steered into the compaction turn, and nothing starts beside it.
    expect(requests(f)).toEqual([firstRequest(f), steerRequest('before')]);
    await Promise.all([held, behind]);
    await until(() => session.activeTurnId === null);
    await session.close();
    expect(requests(f)).toEqual([
      firstRequest(f),
      steerRequest('before'),
      startRequest(NOTE),
      steerRequest('held', NEXT),
      steerRequest('behind', NEXT),
    ]);
    expect(await collect(session.events)).toEqual([
      started,
      delivered('before'),
      acknowledged('before'),
      delivered('held'),
      delivered('behind'),
      turnStarted,
      acknowledged('held'),
      acknowledged('behind'),
      ended(),
    ]);
  });

  const interrupted: AgentEvent = {
    type: 'turn_ended',
    outcome: 'interrupted',
    toolCalls: 0,
    error: null,
    errorKind: null,
  };
  for (const stage of [
    'before the compaction turn',
    'during the compaction turn',
    'during the continuation start',
  ] as const) {
    test(`an interrupt ${stage} ends the recovery as interrupted, without a continuation`, async () => {
      const turn = stage === 'during the continuation start' ? NEXT : COMPACT;
      const f = sessionFixture({
        answers: {
          'turn/start': [
            { then: [{ notify: begin(FIRST) }, { delayMs: 30 }, { notify: contextFailure() }] },
            {
              delayMs: 150,
              result: { turn: m.turn({ id: NEXT, status: 'inProgress' }) },
              then: [{ notify: begin(NEXT) }],
            },
          ],
          'thread/compact/start': {
            result: {},
            then:
              stage === 'during the continuation start'
                ? [{ notify: begin(COMPACT) }, { notify: finish(COMPACT) }]
                : [{ delayMs: stage === 'before the compaction turn' ? 150 : 0 }, { notify: begin(COMPACT) }],
          },
          'turn/interrupt': { then: [{ notify: finish(turn, 'interrupted') }] },
        },
      });
      const session = await CodexSession.start(f.launch, f.options);
      const record = () => readCodexRecord(f.bin)[0]!.requests.map(({ method }) => method);
      if (stage === 'during the compaction turn') await until(() => session.activeTurnId === COMPACT);
      else if (stage === 'before the compaction turn') await until(() => record().includes('thread/compact/start'));
      else await until(() => record().filter((method) => method === 'turn/start').length === 2);
      const queued = result(session.send(message('queued')));
      await session.interrupt({ cancelQueued: true });
      expect(((await queued) as Error).message).toBe('codex send cancelled');
      await until(() => session.activeTurnId === null && record().includes('turn/interrupt'));
      await Bun.sleep(100);
      await session.close();
      expect(requests(f)).toEqual([
        firstRequest(f),
        ...(stage === 'during the continuation start' ? [startRequest(NOTE)] : []),
        interruptRequest(turn),
      ]);
      expect(await collect(session.events)).toEqual([
        started,
        turnStarted,
        ...(stage === 'during the continuation start' ? [turnStarted] : []),
        interrupted,
      ]);
    });
  }

  test('a turn that our turn/start opened is never taken for the compaction turn', async () => {
    const x = 'agent-turn';
    const f = sessionFixture({
      answers: {
        'turn/start': [
          { then: [{ notify: begin(FIRST) }, { delayMs: 60 }, { notify: contextFailure() }] },
          {
            delayMs: 150,
            result: { turn: m.turn({ id: x, status: 'inProgress' }) },
            then: [{ notify: begin(x) }, { notify: finish(x) }],
          },
          { then: [{ notify: begin(NEXT) }, { notify: finish(NEXT) }] },
        ],
        'thread/compact/start': {
          result: {},
          then: [{ delayMs: 50 }, { notify: begin(COMPACT) }, { notify: finish(COMPACT) }],
        },
      },
    });
    const session = await CodexSession.start(f.launch, f.options);
    // The failed turn ends while the agent message's turn/start is unanswered, so recovery starts after its answer.
    await session.send(message('agent says', 'agent'));
    await until(() => requests(f).length === 3 && session.activeTurnId === null);
    await Bun.sleep(50);
    await session.close();
    expect(requests(f).map(({ method }) => method)).toEqual(['turn/start', 'turn/start', 'turn/start']);
    expect(requests(f)[2]).toEqual(startRequest(NOTE));
    expect(await collect(session.events)).toEqual([
      started,
      turnStarted,
      delivered('agent says'),
      turnStarted,
      acknowledged('agent says'),
      ended(),
      turnStarted,
      ended(),
    ]);
  });

  test('a completion that overtakes a non-steerable answer does not hold the message', async () => {
    const f = sessionFixture({
      answers: {
        'turn/start': [{ then: [{ delayMs: 40 }, { notify: finish() }] }, { then: [{ notify: finish(NEXT) }] }],
        'turn/steer': { error: notSteerable, delayMs: 100 },
      },
    });
    const session = await CodexSession.start(f.launch, f.options);
    await session.send(message('late'));
    await until(() => session.activeTurnId === null);
    await session.close();
    expect(requests(f)).toEqual([firstRequest(f), steerRequest('late'), startRequest('late')]);
    expect(await collect(session.events)).toEqual([started, ended(), delivered('late'), acknowledged('late'), ended()]);
  });

  test('a rejected held delivery rejects its send and lets the next queued send proceed', async () => {
    const f = sessionFixture({
      answers: {
        'turn/start': [{}, { error: { code: -32603, message: 'cannot\n start' } }, {}],
        'turn/steer': { error: notSteerable },
        'turn/interrupt': { then: [{ notify: finish() }] },
      },
    });
    const session = await CodexSession.start(f.launch, f.options);
    const held = result(session.send(message('held')));
    const behind = session.send(message('behind'));
    await until(() => requests(f).length === 2);
    await session.interrupt();
    expect(((await held) as Error).message).toBe('codex turn/start failed: cannot start');
    await behind;
    await session.close();
    expect(requests(f)).toEqual([
      firstRequest(f),
      steerRequest('held'),
      interruptRequest(),
      startRequest('held'),
      startRequest('behind'),
    ]);
    expect(await collect(session.events)).toEqual([started, ended(), delivered('behind')]);
  });

  test('close ends stdin, rejects held and queued sends and refuses new sends immediately', async () => {
    const f = sessionFixture({ answers: { 'turn/steer': { error: notSteerable } } });
    const session = await CodexSession.start(f.launch, f.options);
    const first = result(session.send(message('held')));
    const second = result(session.send(message('behind')));
    await until(() => requests(f).length === 2);
    const closing = session.close();
    expect(await result(session.send(message('closed')))).toBeInstanceOf(Error);
    expect(await first).toBeInstanceOf(Error);
    expect(await second).toBeInstanceOf(Error);
    await closing;
    expect(await session.exited).toEqual({ code: 0, signal: null });
    expect(alive(session.pid)).toBe(false);
    expect(readCodexRecord(f.bin)[0]!.exit?.reason).toBe('eof');
    expect(requests(f)).toEqual([firstRequest(f), steerRequest('held')]);
    expect(await collect(session.events)).toEqual([started]);
  });

  test('a crash rejects a held send and the sends behind it without close', async () => {
    const f = sessionFixture({
      answers: { 'turn/steer': { error: notSteerable, then: [{ delayMs: 30 }, { crash: { signal: 'SIGKILL' } }] } },
    });
    const session = await CodexSession.start(f.launch, f.options);
    const held = result(session.send(message('held')));
    const behind = result(session.send(message('behind')));
    expect(((await held) as Error).message).toBe('codex session is closed');
    expect(((await behind) as Error).message).toBe('codex session is closed');
    expect(await session.exited).toEqual({ code: null, signal: 'SIGKILL' });
    await session.close();
  });

  test('crash rejects an unanswered send and the chain, exposes its signal and drains events', async () => {
    const f = sessionFixture({ answers: { 'turn/steer': { silent: true, then: [{ crash: { signal: 'SIGKILL' } }] } } });
    const session = await CodexSession.start(f.launch, f.options);
    const first = result(session.send(message('unanswered')));
    const second = result(session.send(message('queued')));
    expect(await first).toBeInstanceOf(Error);
    expect(await second).toBeInstanceOf(Error);
    expect(await session.exited).toEqual({ code: null, signal: 'SIGKILL' });
    expect(await collect(session.events)).toEqual([started]);
    expect(await result(session.send(message('after exit')))).toBeInstanceOf(Error);
    await session.interrupt();
    expect(requests(f)).toEqual([firstRequest(f), steerRequest('unanswered')]);
    await session.close();
  });
});

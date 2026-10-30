import { describe, expect, test } from 'bun:test';
import { type LiveAttempt, type RunnerCommand, compareFence } from '@agflow/core';
import { getAttempt, updateAttempt } from '../src/attempt-store';
import { endAttempt, recentResumes, requestStop, startRunnerAttempt } from '../src/attempts';
import { createSession, resolveAgentToken } from '../src/auth';
import { enqueueCommand } from '../src/commands';
import { type HubContext, tx } from '../src/context';
import { listEvents } from '../src/events';
import { Gateway } from '../src/gateway';
import { RESTART_PROMPT, reconcileOnHello } from '../src/recovery';
import { getTask, listTaskNotes } from '../src/task-store';
import { createTasks } from '../src/tasks';
import { type FakeConnection, type FakeRunner, connectFakeRunner, settle } from './fake-runner';
import { addRunner, createTestContext, newTask } from './helpers';

type Link = FakeRunner<FakeConnection>;

const WIP_SHA = 'a'.repeat(40);
const FINAL_SHA = 'c'.repeat(40);

/**
 * A hub with runner R-1 (the key FakeRunner uses) connected, and three ready tasks. live is what the runner's hello
 * reports; tests fill it before a reconnect.
 */
async function setup() {
  const { ctx, clock } = createTestContext();
  const runnerId = addRunner(ctx, { vendors: ['claude', 'codex'] });
  const tasks = createTasks(
    ctx,
    [newTask({ title: 'One' }), newTask({ title: 'Two' }), newTask({ title: 'Three' })],
    'user:alice',
  );
  const gateway = new Gateway(ctx);
  const live: LiveAttempt[] = [];
  const runner = await connectFakeRunner(ctx, gateway, {
    token: createSession(ctx, 'alice', 'cli'),
    attempts: () => live,
  });
  return { ctx, clock, runnerId, tasks, runner, live };
}

/** A worker attempt on R-1 whose session is live. */
async function running(ctx: HubContext, runner: Link, runnerId: string, taskId: string) {
  const { attempt } = startRunnerAttempt(ctx, { runnerId, taskId, role: 'worker', vendor: 'claude' });
  await settle();
  runner.startRunning(attempt.id);
  await settle();
  return getAttempt(ctx, attempt.id);
}

/** What the runner reports about one attempt, at the fence the hub has for it now. */
function reported(ctx: HubContext, attemptId: string, state: LiveAttempt['state'], clone = true): LiveAttempt {
  return { attemptId, fence: getAttempt(ctx, attemptId).fence, state, sessionRef: `session-${attemptId}`, clone };
}

/** A new link: hello with what live holds. Resolves with the welcome. */
async function hello(runner: Link) {
  const welcome = await runner.reconnect();
  await settle();
  if (!welcome) throw new Error('the hub closed the link');
  return welcome;
}

const dispatchHold = (ctx: HubContext, taskId: string) =>
  (ctx.db.query('SELECT dispatch_hold_until FROM tasks WHERE id = $id').get({ id: taskId }) as {
    dispatch_hold_until: number | null;
  }).dispatch_hold_until;

const attemptOf = (command: RunnerCommand): string | null =>
  command.kind === 'start_attempt' ? command.attempt.attemptId : 'attemptId' in command ? command.attemptId : null;

/** The kinds of the commands the runner got since the given count of received messages, for one attempt. */
const sentFor = (runner: Link, attemptId: string, since: number) =>
  runner.received
    .slice(since)
    .flatMap((message) => (message.t === 'command' ? [message.command] : []))
    .filter((command) => attemptOf(command) === attemptId)
    .map((command) => command.kind);

describe('reconciliation on hello', () => {
  test('stopped or suspended with a stop recorded: it ends with the requested cause and its row applies', async () => {
    const { ctx, runnerId, tasks, runner, live } = await setup();
    const [one, two] = tasks;
    if (!one || !two) throw new Error('no tasks');
    const stopped = await running(ctx, runner, runnerId, one.id);
    const cancelled = await running(ctx, runner, runnerId, two.id);
    requestStop(ctx, { attemptId: stopped.id, cause: 'stop', reason: 'enough', by: 'user:alice' });
    requestStop(ctx, { attemptId: cancelled.id, cause: 'cancel', reason: 'not needed', by: 'user:alice' });
    await settle();
    live.push(reported(ctx, stopped.id, 'stopped'), reported(ctx, cancelled.id, 'suspended', false));
    const since = runner.received.length;
    const welcome = await hello(runner);
    expect(getAttempt(ctx, stopped.id)).toMatchObject({ status: 'ended', endReason: 'stopped', failureClass: null });
    expect(getTask(ctx, one.id)).toMatchObject({ status: 'ready', assignee: null });
    // Nothing was left to replay, so no exit can still be on its way.
    expect(dispatchHold(ctx, one.id)).toBeNull();
    // stop assembles a note when the agent wrote none.
    expect(listTaskNotes(ctx, one.id).map((note) => [note.kind, note.attemptId])).toEqual([['handoff', stopped.id]]);
    expect(getAttempt(ctx, cancelled.id)).toMatchObject({ status: 'ended', endReason: 'cancelled' });
    expect(getTask(ctx, two.id).status).toBe('cancelled');
    // The runner hears that both ended, and cleans them up.
    expect(welcome.stop.map((entry) => entry.attemptId).sort()).toEqual([stopped.id, cancelled.id].sort());
    for (const attempt of [stopped, cancelled]) expect(sentFor(runner, attempt.id, since)).toEqual(['cleanup_attempt']);
  });

  test('a stop completed while the replay is pending holds dispatch until the exit brings the final WIP', async () => {
    const { ctx, runnerId, tasks, runner, live } = await setup();
    const [one] = tasks;
    if (!one) throw new Error('no task');
    const attempt = await running(ctx, runner, runnerId, one.id);
    const at = { attemptId: attempt.id, fence: attempt.fence };
    const wip = { ref: attempt.wipRef as string, stripped: [], skipped: [], embedded: [], logStat: '' };
    runner.emit('attempt.wip', { ...wip, sha: WIP_SHA }, at);
    await settle();
    requestStop(ctx, { attemptId: attempt.id, cause: 'stop', reason: 'enough', by: 'user:alice' });
    await settle();
    // The runner pushes the final WIP and reports the exit, but the link drops before the hub has it.
    runner.disconnect();
    await settle();
    const finalWip = { ref: attempt.wipRef as string, sha: FINAL_SHA };
    const exit = { code: 0, signal: null, stoppedBy: 'close', handoffWritten: true, cause: null } as const;
    runner.emit('attempt.exited', { ...exit, finalSha: FINAL_SHA, finalWip, pushError: null }, at);
    live.push(reported(ctx, attempt.id, 'stopped'));

    // This link's replay never arrives.
    const welcomed = runner.reconnect();
    const link = runner.transport as FakeConnection;
    const send = link.send.bind(link);
    link.send = (text) => {
      if ((JSON.parse(text) as { t: string }).t !== 'events') send(text);
    };
    await welcomed;
    await settle();
    expect(getAttempt(ctx, attempt.id)).toMatchObject({ status: 'ended', endReason: 'stopped' });
    expect(getTask(ctx, one.id)).toMatchObject({ status: 'ready', workSha: WIP_SHA });
    expect(dispatchHold(ctx, one.id)).toBe(ctx.now() + ctx.config.dispatchHoldMs);

    // The next link replays the exit: its final WIP becomes the work position, and the wait is over.
    await hello(runner);
    expect(getTask(ctx, one.id)).toMatchObject({ status: 'ready', workRef: finalWip.ref, workSha: FINAL_SHA });
    expect(dispatchHold(ctx, one.id)).toBeNull();
  });

  test('a take-over in flight with a clone keeps going: its pending prepare_takeover is sent again', async () => {
    const { ctx, runnerId, tasks, runner, live } = await setup();
    const [one, two] = tasks;
    if (!one || !two) throw new Error('no tasks');
    const taken = await running(ctx, runner, runnerId, one.id);
    const gone = await running(ctx, runner, runnerId, two.id);
    runner.disconnect();
    await settle();
    for (const attempt of [taken, gone]) {
      requestStop(ctx, { attemptId: attempt.id, cause: 'takeover', reason: 'alice takes it over', by: 'user:alice' });
      const { id: attemptId, fence } = attempt;
      enqueueCommand(ctx, runnerId, { kind: 'prepare_takeover', attemptId, fence, person: 'alice' });
    }
    live.push(reported(ctx, taken.id, 'stopped'), reported(ctx, gone.id, 'stopped', false));
    const since = runner.received.length;
    const welcome = await hello(runner);
    expect(getAttempt(ctx, taken.id).status).toBe('running');
    expect(sentFor(runner, taken.id, since)).toEqual(['prepare_takeover']);
    // Without a clone there is nothing to take over: it ends taken_over, its task still blocked for the person.
    expect(getAttempt(ctx, gone.id)).toMatchObject({ status: 'ended', endReason: 'taken_over' });
    expect(getTask(ctx, two.id)).toMatchObject({ status: 'blocked', blockedKind: 'takeover' });
    expect(welcome.stop.map((entry) => entry.attemptId)).toEqual([gone.id]);
  });

  test('starting, running or idle: nothing changes, and pending commands are sent again', async () => {
    const { ctx, runnerId, tasks, runner, live } = await setup();
    const [one] = tasks;
    if (!one) throw new Error('no task');
    const attempt = await running(ctx, runner, runnerId, one.id);
    const lead = startRunnerAttempt(ctx, { runnerId, taskId: null, role: 'lead', vendor: 'claude' }).attempt;
    await settle();
    runner.disconnect();
    await settle();
    enqueueCommand(ctx, runnerId, { kind: 'interrupt', attemptId: attempt.id, fence: attempt.fence });
    live.push(reported(ctx, attempt.id, 'running'), reported(ctx, lead.id, 'idle'));
    const since = runner.received.length;
    const welcome = await hello(runner);
    expect(welcome.stop).toEqual([]);
    expect(getAttempt(ctx, attempt.id)).toMatchObject({ status: 'running', fence: attempt.fence });
    expect(getAttempt(ctx, lead.id)).toMatchObject({ status: 'starting', fence: lead.fence });
    expect(sentFor(runner, attempt.id, since)).toEqual(['interrupt']);
  });

  test('stopped or suspended with a clone while it runs: a runner-restart resume; crashed at the second', async () => {
    const { ctx, clock, runnerId, tasks, runner, live } = await setup();
    const [one, two] = tasks;
    if (!one || !two) throw new Error('no tasks');
    const attempt = await running(ctx, runner, runnerId, one.id);
    const held = await running(ctx, runner, runnerId, two.id);
    updateAttempt(ctx, held.id, { status: 'holding', leaseExpiresAt: null });
    live.push(reported(ctx, attempt.id, 'suspended'), reported(ctx, held.id, 'stopped'));
    const since = runner.received.length;
    await hello(runner);
    const resumed = getAttempt(ctx, attempt.id);
    expect(resumed.status).toBe('starting');
    expect(compareFence(resumed.fence, attempt.fence)).toBe(1);
    expect(recentResumes(ctx, attempt.id, 'runner_restart', ctx.config.resumeWindowMs)).toBe(1);
    expect(sentFor(runner, attempt.id, since)).toEqual(['resume_attempt']);
    const resume = runner.commands.at(-1)?.command;
    expect(resume).toMatchObject({ kind: 'resume_attempt', prompt: RESTART_PROMPT });
    expect(RESTART_PROMPT).toBe('the runner restarted; continue from your last step');
    // A holding attempt stays holding.
    expect(getAttempt(ctx, held.id)).toMatchObject({ status: 'holding', fence: held.fence });

    // The runner restarts again within resumeWindowMs: the attempt ends crashed.
    clock.advance(ctx.config.resumeWindowMs - 1);
    live.splice(0, live.length, reported(ctx, attempt.id, 'stopped'));
    const welcome = await hello(runner);
    expect(getAttempt(ctx, attempt.id)).toMatchObject({ status: 'ended', endReason: 'crashed', failureClass: 'infra' });
    expect(getTask(ctx, one.id).status).toBe('ready');
    expect(welcome.stop.map((entry) => entry.attemptId)).toContain(attempt.id);
  });

  test('a runner restart outside resumeWindowMs resumes again', async () => {
    const { ctx, clock, runnerId, tasks, runner, live } = await setup();
    const [one] = tasks;
    if (!one) throw new Error('no task');
    const attempt = await running(ctx, runner, runnerId, one.id);
    live.push(reported(ctx, attempt.id, 'suspended'));
    await hello(runner);
    clock.advance(ctx.config.resumeWindowMs);
    live.splice(0, live.length, reported(ctx, attempt.id, 'suspended'));
    await hello(runner);
    expect(getAttempt(ctx, attempt.id).status).toBe('starting');
    expect(recentResumes(ctx, attempt.id, 'runner_restart', ctx.config.resumeWindowMs)).toBe(1);
  });

  test('not reported while its start_attempt is pending: the start is sent again with a fresh token', async () => {
    const { ctx, runnerId, tasks, runner } = await setup();
    const [one] = tasks;
    if (!one) throw new Error('no task');
    runner.disconnect();
    await settle();
    const { attempt } = startRunnerAttempt(ctx, { runnerId, taskId: one.id, role: 'worker', vendor: 'claude' });
    const since = runner.received.length;
    await hello(runner);
    expect(getAttempt(ctx, attempt.id)).toMatchObject({ status: 'starting', fence: attempt.fence });
    expect(sentFor(runner, attempt.id, since)).toEqual(['start_attempt']);
    expect(resolveAgentToken(ctx, runner.tokens.get(attempt.id) as string).attempt.id).toBe(attempt.id);
  });

  test('not reported, or without a clone, while it runs: crashed, with its pending commands cancelled', async () => {
    const { ctx, runnerId, tasks, runner, live } = await setup();
    const [one, two] = tasks;
    if (!one || !two) throw new Error('no tasks');
    const missing = await running(ctx, runner, runnerId, one.id);
    const cloneless = await running(ctx, runner, runnerId, two.id);
    runner.disconnect();
    await settle();
    const interrupt = enqueueCommand(ctx, runnerId, { kind: 'interrupt', attemptId: missing.id, fence: missing.fence });
    live.push(reported(ctx, cloneless.id, 'suspended', false));
    await hello(runner);
    for (const attempt of [missing, cloneless]) {
      const ended = getAttempt(ctx, attempt.id);
      expect(ended).toMatchObject({ status: 'ended', endReason: 'crashed', failureClass: 'infra' });
    }
    expect(getTask(ctx, one.id).status).toBe('ready');
    expect(
      ctx.db.query('SELECT status FROM runner_commands WHERE id = $id').get({ id: interrupt.id }),
    ).toEqual({ status: 'cancelled' });
    // A start that already reached the runner is no longer pending, so a missing starting attempt crashed too.
    const [three] = tasks.slice(2);
    if (!three) throw new Error('no task');
    const started = startRunnerAttempt(ctx, { runnerId, taskId: three.id, role: 'worker', vendor: 'claude' }).attempt;
    await settle();
    live.splice(0, live.length);
    await hello(runner);
    expect(getAttempt(ctx, started.id)).toMatchObject({ status: 'ended', endReason: 'crashed' });
  });

  test('a holding attempt not reported, or without a clone, cannot be resumed; its task keeps its status', async () => {
    const { ctx, runnerId, tasks, runner, live } = await setup();
    const [one, two] = tasks;
    if (!one || !two) throw new Error('no tasks');
    const missing = await running(ctx, runner, runnerId, one.id);
    const cloneless = await running(ctx, runner, runnerId, two.id);
    for (const attempt of [missing, cloneless]) {
      updateAttempt(ctx, attempt.id, { status: 'holding', leaseExpiresAt: null });
    }
    live.push(reported(ctx, cloneless.id, 'stopped', false));
    const welcome = await hello(runner);
    for (const attempt of [missing, cloneless]) {
      expect(getAttempt(ctx, attempt.id)).toMatchObject({ status: 'holding', resumable: false });
    }
    expect(getTask(ctx, one.id).status).toBe('claimed');
    expect(welcome.stop).toEqual([]);
  });

  test('attempts reported but ended, or unknown to the hub, go to welcome.stop', async () => {
    const { ctx, runnerId, tasks, runner, live } = await setup();
    const [one] = tasks;
    if (!one) throw new Error('no task');
    const attempt = await running(ctx, runner, runnerId, one.id);
    endAttempt(ctx, { attemptId: attempt.id, trigger: 'stop' });
    live.push(reported(ctx, attempt.id, 'running'), {
      attemptId: 'T-9-a1',
      fence: { epoch: 1, counter: 99 },
      state: 'running',
      sessionRef: null,
      clone: true,
    });
    const welcome = await hello(runner);
    expect(welcome.stop).toEqual([
      { attemptId: attempt.id, reason: 'the attempt ended (stopped)' },
      { attemptId: 'T-9-a1', reason: 'the hub does not know this attempt' },
    ]);
    // An attempt of another runner is not this runner's to run.
    const other = addRunner(ctx, { owner: 'bob' });
    const taskId = tasks[1]?.id as string;
    const theirs = startRunnerAttempt(ctx, { runnerId: other, taskId, role: 'worker', vendor: 'claude' });
    live.splice(0, live.length, reported(ctx, theirs.attempt.id, 'running'));
    const again = await hello(runner);
    expect(again.stop).toEqual([{ attemptId: theirs.attempt.id, reason: `the attempt runs on ${other}` }]);
    expect(getAttempt(ctx, theirs.attempt.id).status).toBe('starting');
    expect(listEvents(ctx.db).filter((event) => event.type === 'attempt.ended')).toHaveLength(1);
  });
});

describe('the reconciliation result', () => {
  test('lists what happened to each open attempt, oldest first', () => {
    const { ctx } = createTestContext();
    const runnerId = addRunner(ctx);
    const titles = ['Ended', 'Takeover', 'Kept', 'Resumed', 'Resent', 'Crashed', 'Unresumable'];
    const tasks = createTasks(ctx, titles.map((title) => newTask({ title })), 'user:alice');
    const attempts = tasks.map(
      (task) => startRunnerAttempt(ctx, { runnerId, taskId: task.id, role: 'worker', vendor: 'claude' }).attempt,
    );
    const [ended, takeover, kept, resumed, resent, crashed, unresumable] = attempts;
    if (!ended || !takeover || !kept || !resumed || !resent || !crashed || !unresumable) throw new Error('no attempts');
    // All but one started; the resent one's start_attempt is still pending.
    for (const attempt of [ended, takeover, kept, resumed, crashed]) {
      updateAttempt(ctx, attempt.id, { status: 'running' });
    }
    updateAttempt(ctx, unresumable.id, { status: 'holding', leaseExpiresAt: null });
    requestStop(ctx, { attemptId: ended.id, cause: 'stop', reason: 'enough', by: 'user:alice' });
    requestStop(ctx, { attemptId: takeover.id, cause: 'takeover', reason: 'alice takes it over', by: 'user:alice' });
    const reports = [
      reported(ctx, ended.id, 'stopped'),
      reported(ctx, takeover.id, 'stopped'),
      reported(ctx, kept.id, 'running'),
      reported(ctx, resumed.id, 'suspended'),
    ];
    const result = tx(ctx, () => reconcileOnHello(ctx, runnerId, reports));
    expect(result.actions).toEqual([
      { attemptId: ended.id, action: 'ended' },
      { attemptId: takeover.id, action: 'takeover' },
      { attemptId: kept.id, action: 'kept' },
      { attemptId: resumed.id, action: 'resumed' },
      { attemptId: resent.id, action: 'resent' },
      { attemptId: crashed.id, action: 'crashed' },
      { attemptId: unresumable.id, action: 'unresumable' },
    ]);
    expect(result.stop).toEqual([{ attemptId: ended.id, reason: 'the attempt ended (stopped)' }]);
  });
});

import { describe, expect, test } from 'bun:test';
import { type Fence, type RunnerEventData, lateWorkRef } from '@agflow/core';
import { attemptLog, getAttempt, insertAttempt, issueFence, updateAttempt } from '../src/attempt-store';
import { endAttempt, startPositionFor, startRunnerAttempt } from '../src/attempts';
import { createSession } from '../src/auth';
import { pendingCommands } from '../src/commands';
import { type HubContext, tx } from '../src/context';
import { listEvents } from '../src/events';
import { Gateway } from '../src/gateway';
import { recordedRefs } from '../src/retention';
import { listMessages } from '../src/messages';
import { getRunner, markGitNotReady } from '../src/runners';
import { getTask, listTaskNotes, move, writeTask } from '../src/task-store';
import { createTasks } from '../src/tasks';
import { type FakeConnection, type FakeRunner, connectFakeRunner, settle } from './fake-runner';
import { addAgent, addRunner, createTestContext, newTask } from './helpers';

const WIP_SHA = 'a'.repeat(40);
const LATE_SHA = 'b'.repeat(40);
const SUBMITTED_SHA = 'c'.repeat(40);

type Link = FakeRunner<FakeConnection>;

/** A hub with runner R-1 (the key FakeRunner uses) connected, and a ready task. */
async function setup() {
  const { ctx, clock } = createTestContext();
  const runnerId = addRunner(ctx, { vendors: ['claude', 'codex'] });
  const [task] = createTasks(ctx, [newTask({ title: 'Fix the parser' })], 'user:alice');
  if (!task) throw new Error('no task');
  const gateway = new Gateway(ctx);
  const runner = await connectFakeRunner(ctx, gateway, { token: createSession(ctx, 'alice', 'cli') });
  return { ctx, clock, runnerId, task, runner };
}

/** A worker attempt on R-1 whose session is live, with a WIP pushed when wip is set. */
async function running(ctx: HubContext, runner: Link, runnerId: string, taskId: string, wip = true) {
  const { attempt } = startRunnerAttempt(ctx, { runnerId, taskId, role: 'worker', vendor: 'claude' });
  await settle();
  runner.startRunning(attempt.id);
  await settle();
  if (wip) {
    const data: RunnerEventData['attempt.wip'] = {
      ref: attempt.wipRef as string,
      sha: WIP_SHA,
      stripped: [],
      skipped: [],
      embedded: [],
      logStat: '',
    };
    runner.emit('attempt.wip', data, { attemptId: attempt.id, fence: attempt.fence });
    await settle();
  }
  return getAttempt(ctx, attempt.id);
}

/** The runner reports late work of the attempt, at the fence it last knew. */
async function lateWork(runner: Link, attemptId: string, fence: Fence, taskId = 'T-1', n = 1, sha = LATE_SHA) {
  const ref = lateWorkRef('refs/agflow/', attemptId, n);
  runner.emit('attempt.late_work', { taskId, ref, sha }, { attemptId, fence });
  await settle();
  return ref;
}

/**
 * The attempt's submission at SUBMITTED_SHA was recorded, as a runner submission's success records it (the task
 * submitted, on its branch at that head, and the attempt holding), and a person accepted it before the runner reported
 * anything more: the task accepted and the attempt ended accepted.
 */
function acceptedSubmission(ctx: HubContext, attemptId: string, taskId: string): void {
  tx(ctx, (emit) => {
    const branch = getTask(ctx, taskId).branch ?? `agflow/${taskId}`;
    const submission = {
      summary: 'Done.',
      evidence: [],
      branch,
      headSha: SUBMITTED_SHA,
      submittedAt: ctx.now(),
      by: getAttempt(ctx, attemptId).agentId,
      attemptId,
      submissionId: 'S-1',
    };
    const changes = { submission, workRef: `refs/heads/${branch}`, workSha: SUBMITTED_SHA };
    move(ctx, emit, getTask(ctx, taskId), 'submitted', `runner:${getAttempt(ctx, attemptId).runnerId}`, { changes });
    updateAttempt(ctx, attemptId, { status: 'holding', leaseExpiresAt: null, submittedSha: SUBMITTED_SHA });
    move(ctx, emit, getTask(ctx, taskId), 'accepted', 'user:alice');
  });
  endAttempt(ctx, { attemptId, trigger: 'accepted', actor: 'user:alice' });
}

const rejects = (ctx: HubContext) => ctx.db.query('SELECT type, error FROM runner_event_rejects').all();
const lateNotes = (ctx: HubContext, taskId: string) =>
  listTaskNotes(ctx, taskId).filter((note) => note.kind === 'late_work');
const dispatchHold = (ctx: HubContext, taskId: string) =>
  (ctx.db.query('SELECT dispatch_hold_until FROM tasks WHERE id = $id').get({ id: taskId }) as {
    dispatch_hold_until: number | null;
  }).dispatch_hold_until;

describe('late work under the lineage rule', () => {
  test('becomes the position while the task has no open attempt and its position is the attempt WIP', async () => {
    const { ctx, runnerId, task, runner } = await setup();
    const attempt = await running(ctx, runner, runnerId, task.id);
    endAttempt(ctx, { attemptId: attempt.id, trigger: 'lost' });
    writeTask(ctx, task.id, { dispatchHoldUntil: ctx.now() + ctx.config.dispatchHoldMs });
    const ref = await lateWork(runner, attempt.id, attempt.fence);
    expect(rejects(ctx)).toEqual([]);
    expect(getTask(ctx, task.id)).toMatchObject({ status: 'ready', workRef: ref, workSha: LATE_SHA });
    // The wait for it is over.
    expect(dispatchHold(ctx, task.id)).toBeNull();
    // The ended attempt's WIP ref is never rewritten, so its record stays.
    expect(getAttempt(ctx, attempt.id)).toMatchObject({ wipRef: 'refs/agflow/T-1/a1', wipSha: WIP_SHA });
    expect(lateNotes(ctx, task.id)).toEqual([]);
    const events = listEvents(ctx.db).filter((event) => event.type === 'attempt.late_work');
    expect(events.map((event) => [event.subject, event.actor, event.data])).toEqual([
      [
        task.id,
        `runner:${runnerId}`,
        { attemptId: attempt.id, taskId: task.id, agentId: attempt.agentId, runnerId, ref, sha: LATE_SHA },
      ],
    ]);
  });

  test('of an attempt that never pushed, while the task still has no position', async () => {
    const { ctx, runnerId, task, runner } = await setup();
    const attempt = await running(ctx, runner, runnerId, task.id, false);
    endAttempt(ctx, { attemptId: attempt.id, trigger: 'lost' });
    const ref = await lateWork(runner, attempt.id, attempt.fence);
    expect(getTask(ctx, task.id)).toMatchObject({ workRef: ref, workSha: LATE_SHA });
  });

  test('of an attempt that never pushed, while the position is still where it started', async () => {
    const { ctx, runnerId, task, runner } = await setup();
    // A hand-back, say, gave the task its position before the attempt started from it.
    writeTask(ctx, task.id, { workRef: 'refs/agflow/T-1/takeover-alice', workSha: 'd'.repeat(40) });
    const attempt = await running(ctx, runner, runnerId, task.id, false);
    expect(attempt).toMatchObject({ startSha: 'd'.repeat(40), wipSha: null });
    endAttempt(ctx, { attemptId: attempt.id, trigger: 'lost' });
    const ref = await lateWork(runner, attempt.id, attempt.fence);
    expect(getTask(ctx, task.id)).toMatchObject({ workRef: ref, workSha: LATE_SHA });
    expect(lateNotes(ctx, task.id)).toEqual([]);
  });

  test('otherwise a note with the attempt id names the ref; nothing is sent while no one holds the task', async () => {
    const { ctx, runnerId, task, runner } = await setup();
    const attempt = await running(ctx, runner, runnerId, task.id);
    endAttempt(ctx, { attemptId: attempt.id, trigger: 'lost' });
    // A hand-back, say, moved the position on.
    writeTask(ctx, task.id, { workRef: 'refs/agflow/T-1/takeover-alice', workSha: 'd'.repeat(40) });
    const ref = await lateWork(runner, attempt.id, attempt.fence);
    expect(getTask(ctx, task.id)).toMatchObject({ workRef: 'refs/agflow/T-1/takeover-alice' });
    const notes = lateNotes(ctx, task.id);
    expect(notes.map((note) => [note.author, note.attemptId])).toEqual([['system', attempt.id]]);
    expect(notes[0]?.body).toContain(`git fetch origin ${ref} && git merge FETCH_HEAD`);
    expect(notes[0]?.body).toContain(LATE_SHA);
    expect(pendingCommands(ctx, runnerId, 1).filter((row) => row.kind === 'refresh_vault')).toEqual([]);
  });

  test("with a holder, refresh_vault goes to its runner first and the holder gets the merge command", async () => {
    const { ctx, runnerId, task, runner } = await setup();
    const attempt = await running(ctx, runner, runnerId, task.id);
    endAttempt(ctx, { attemptId: attempt.id, trigger: 'lost' });
    const elsewhere = addRunner(ctx, { owner: 'bob' });
    const next = startRunnerAttempt(ctx, { runnerId: elsewhere, taskId: task.id, role: 'worker', vendor: 'claude' });
    const ref = await lateWork(runner, attempt.id, attempt.fence);
    expect(getTask(ctx, task.id)).toMatchObject({ workRef: 'refs/agflow/T-1/a1', workSha: WIP_SHA });
    expect(lateNotes(ctx, task.id).map((note) => note.attemptId)).toEqual([attempt.id]);
    expect(pendingCommands(ctx, elsewhere, 1).map((row) => row.command)).toEqual([
      next.command.command,
      { kind: 'refresh_vault', taskId: task.id, refs: [ref] },
    ]);
    const told = listMessages(ctx, { target: `agent:${next.agent.id}` });
    expect(told.map((message) => [message.from, message.taskId])).toEqual([['system', task.id]]);
    expect(told[0]?.body).toContain(`git fetch origin ${ref} && git merge FETCH_HEAD`);
  });

  test('a live holder gets the merge command; there is no vault to refresh', async () => {
    const { ctx, runnerId, task, runner } = await setup();
    const attempt = await running(ctx, runner, runnerId, task.id);
    endAttempt(ctx, { attemptId: attempt.id, trigger: 'lost' });
    const live = addAgent(ctx, 'bob');
    tx(ctx, () =>
      insertAttempt(ctx, {
        id: 'T-1-a2',
        taskId: task.id,
        number: 2,
        role: 'worker',
        agentId: live.id,
        runnerId: null,
        vendor: 'claude',
        fence: issueFence(ctx),
        status: 'running',
      }),
    );
    const ref = await lateWork(runner, attempt.id, attempt.fence);
    expect(listMessages(ctx, { target: `agent:${live.id}` })[0]?.body).toContain(`git fetch origin ${ref}`);
    expect(pendingCommands(ctx, runnerId, 1).filter((row) => row.kind === 'refresh_vault')).toEqual([]);
  });
});

describe('late work of an open attempt at its fence', () => {
  test("is the attempt's own final push: the work position, with no note, and its exit holds nothing", async () => {
    const { ctx, runnerId, task, runner } = await setup();
    const attempt = await running(ctx, runner, runnerId, task.id);
    // canPushWip forbade the final push, so it went to a late-work ref while the attempt was still open (X-11).
    const ref = await lateWork(runner, attempt.id, attempt.fence);
    expect(rejects(ctx)).toEqual([]);
    expect(getTask(ctx, task.id)).toMatchObject({ workRef: ref, workSha: LATE_SHA });
    expect(lateNotes(ctx, task.id)).toEqual([]);
    expect(pendingCommands(ctx, runnerId, 1).filter((row) => row.kind === 'refresh_vault')).toEqual([]);
    expect(listMessages(ctx, { target: `agent:${attempt.agentId}` })).toEqual([]);
    expect(listEvents(ctx.db).filter((event) => event.type === 'attempt.late_work')).toHaveLength(1);

    const exited: RunnerEventData['attempt.exited'] = {
      code: 0,
      signal: null,
      stoppedBy: 'none',
      handoffWritten: false,
      cause: null,
      finalSha: LATE_SHA,
      finalWip: null,
      pushError: 'no welcome since the last clock gap',
    };
    runner.emit('attempt.exited', exited, { attemptId: attempt.id, fence: attempt.fence });
    await settle();
    expect(getAttempt(ctx, attempt.id).status).toBe('ended');
    // Its late work landed first, so nothing waits for it and nothing says it is only on the runner.
    expect(dispatchHold(ctx, task.id)).toBeNull();
    expect(lateNotes(ctx, task.id)).toEqual([]);
    expect(startPositionFor(ctx, getTask(ctx, task.id), runnerId)).toEqual({ ref, sha: LATE_SHA });
  });
});

describe("late work and the runner's git", () => {
  test('a late WIP push or late work sets git.ready back after failed WIP pushes', async () => {
    const { ctx, runnerId, task, runner } = await setup();
    const attempt = await running(ctx, runner, runnerId, task.id);
    const at = { attemptId: attempt.id, fence: attempt.fence };
    runner.emit('attempt.wip_failed', { error: 'Could not resolve host', failures: 3 }, at);
    await settle();
    expect(getRunner(ctx, runnerId).git.ready).toBe(false);
    // The attempt ends, so no current attempt is left to push a WIP.
    endAttempt(ctx, { attemptId: attempt.id, trigger: 'lost' });
    const data: RunnerEventData['attempt.wip'] = {
      ref: attempt.wipRef as string,
      sha: LATE_SHA,
      stripped: [],
      skipped: [],
      embedded: [],
      logStat: '',
    };
    runner.emit('attempt.wip', data, at);
    await settle();
    expect(getRunner(ctx, runnerId).git).toEqual({ ready: true, problem: null, lastPushAt: ctx.now() });

    tx(ctx, () => markGitNotReady(ctx, runnerId, 'the last 3 WIP pushes failed'));
    await lateWork(runner, attempt.id, attempt.fence, task.id, 2, 'e'.repeat(40));
    expect(getRunner(ctx, runnerId).git.ready).toBe(true);
  });
});

describe('late work of attempts the hub does not know', () => {
  test('becomes a note on its task when the task exists', async () => {
    const { ctx, task, runner } = await setup();
    const ref = await lateWork(runner, 'T-1-a7', { epoch: 1, counter: 99 });
    expect(rejects(ctx)).toEqual([]);
    const notes = lateNotes(ctx, task.id);
    expect(notes.map((note) => [note.attemptId, note.body.includes(ref)])).toEqual([['T-1-a7', true]]);
    expect(getTask(ctx, task.id).workRef).toBeNull();
    expect(listEvents(ctx.db).find((event) => event.type === 'attempt.late_work')?.data).toMatchObject({
      attemptId: 'T-1-a7',
      taskId: task.id,
      agentId: null,
    });
  });

  test('becomes a message to people when the task does not exist either', async () => {
    const { ctx, runner } = await setup();
    const ref = await lateWork(runner, 'T-99-a1', { epoch: 1, counter: 99 }, 'T-99');
    expect(rejects(ctx)).toEqual([]);
    const told = listMessages(ctx, { target: 'humans' });
    expect(told.map((message) => [message.from, message.taskId])).toEqual([['system', null]]);
    expect(told[0]?.body).toContain(ref);
    expect(told[0]?.body).toContain('T-99');
  });

  test('a WIP push of an unknown attempt counts too', async () => {
    const { ctx, task, runner } = await setup();
    const data: RunnerEventData['attempt.wip'] = {
      ref: 'refs/agflow/T-1/a7',
      sha: LATE_SHA,
      stripped: [],
      skipped: [],
      embedded: [],
      logStat: '',
    };
    runner.emit('attempt.wip', data, { attemptId: 'T-1-a7', fence: { epoch: 1, counter: 99 } });
    await settle();
    expect(rejects(ctx)).toEqual([]);
    expect(lateNotes(ctx, task.id).map((note) => note.attemptId)).toEqual(['T-1-a7']);
  });
});

describe('late work of ended attempts', () => {
  test('a WIP push after the end is late work', async () => {
    const { ctx, runnerId, task, runner } = await setup();
    const attempt = await running(ctx, runner, runnerId, task.id);
    endAttempt(ctx, { attemptId: attempt.id, trigger: 'lost' });
    const data: RunnerEventData['attempt.wip'] = {
      ref: attempt.wipRef as string,
      sha: LATE_SHA,
      stripped: [],
      skipped: [],
      embedded: [],
      logStat: '',
    };
    runner.emit('attempt.wip', data, { attemptId: attempt.id, fence: attempt.fence });
    await settle();
    expect(getTask(ctx, task.id)).toMatchObject({ workRef: attempt.wipRef, workSha: LATE_SHA });
    expect(getAttempt(ctx, attempt.id).wipSha).toBe(WIP_SHA);
    expect(listEvents(ctx.db).filter((event) => event.type === 'attempt.late_work')).toHaveLength(1);
  });

  test('an exit whose final WIP differs from the recorded one is late work; the same WIP is not', async () => {
    const { ctx, runnerId, task, runner } = await setup();
    const attempt = await running(ctx, runner, runnerId, task.id);
    endAttempt(ctx, { attemptId: attempt.id, trigger: 'lost' });
    const exited = (sha: string): RunnerEventData['attempt.exited'] => ({
      code: null,
      signal: 'SIGTERM',
      stoppedBy: 'sigterm',
      handoffWritten: false,
      cause: null,
      finalSha: sha,
      finalWip: { ref: attempt.wipRef as string, sha },
      pushError: null,
    });
    runner.emit('attempt.exited', exited(WIP_SHA), { attemptId: attempt.id, fence: attempt.fence });
    await settle();
    expect(listEvents(ctx.db).filter((event) => event.type === 'attempt.late_work')).toEqual([]);
    runner.emit('attempt.exited', exited(LATE_SHA), { attemptId: attempt.id, fence: attempt.fence });
    await settle();
    expect(rejects(ctx)).toEqual([]);
    const events = listEvents(ctx.db).filter((event) => event.type === 'attempt.late_work');
    expect(events.map((event) => [event.data.ref, event.data.sha])).toEqual([[attempt.wipRef, LATE_SHA]]);
    expect(getTask(ctx, task.id)).toMatchObject({ workRef: attempt.wipRef, workSha: LATE_SHA });
    expect(getAttempt(ctx, attempt.id)).toMatchObject({ status: 'ended', endReason: 'lost' });
  });
});

describe('the submitted head pushed after the end', () => {
  const exited = (ref: string, sha: string): RunnerEventData['attempt.exited'] => ({
    code: 0,
    signal: null,
    stoppedBy: 'none',
    handoffWritten: false,
    cause: null,
    finalSha: sha,
    finalWip: { ref, sha },
    pushError: null,
  });
  const lateEvents = (ctx: HubContext) =>
    listEvents(ctx.db)
      .filter((event) => event.type === 'attempt.late_work')
      .map((event) => [event.data.ref, event.data.sha]);

  test('as the final WIP of an accepted attempt is its WIP, not late work; another sha still is', async () => {
    const { ctx, runnerId, task, runner } = await setup();
    // The attempt pushed no WIP before it submitted, so the hub recorded no WIP sha for it.
    const attempt = await running(ctx, runner, runnerId, task.id, false);
    acceptedSubmission(ctx, attempt.id, task.id);
    const { workRef } = getTask(ctx, task.id);
    const wipRef = attempt.wipRef as string;
    runner.emit('attempt.exited', exited(wipRef, SUBMITTED_SHA), { attemptId: attempt.id, fence: attempt.fence });
    await settle();
    expect(rejects(ctx)).toEqual([]);
    expect(lateEvents(ctx)).toEqual([]);
    expect(lateNotes(ctx, task.id)).toEqual([]);
    expect(getTask(ctx, task.id)).toMatchObject({ status: 'accepted', workRef, workSha: SUBMITTED_SHA });
    // The WIP ref holds the accepted head now, and its cleanup expects it there.
    expect(getAttempt(ctx, attempt.id)).toMatchObject({
      status: 'ended',
      endReason: 'accepted',
      wipSha: SUBMITTED_SHA,
    });

    runner.emit('attempt.exited', exited(wipRef, LATE_SHA), { attemptId: attempt.id, fence: attempt.fence });
    await settle();
    expect(lateEvents(ctx)).toEqual([[wipRef, LATE_SHA]]);
  });

  test('as a WIP push of an accepted attempt is its WIP, not late work, and the push counts for git', async () => {
    const { ctx, runnerId, task, runner } = await setup();
    const attempt = await running(ctx, runner, runnerId, task.id, false);
    const at = { attemptId: attempt.id, fence: attempt.fence };
    runner.emit('attempt.wip_failed', { error: 'Could not resolve host', failures: 3 }, at);
    await settle();
    acceptedSubmission(ctx, attempt.id, task.id);
    const data: RunnerEventData['attempt.wip'] = {
      ref: attempt.wipRef as string,
      sha: SUBMITTED_SHA,
      stripped: [],
      skipped: [],
      embedded: [],
      logStat: '',
    };
    runner.emit('attempt.wip', data, at);
    await settle();
    expect(rejects(ctx)).toEqual([]);
    expect(lateEvents(ctx)).toEqual([]);
    expect(lateNotes(ctx, task.id)).toEqual([]);
    expect(getAttempt(ctx, attempt.id)).toMatchObject({ wipRef: attempt.wipRef, wipSha: SUBMITTED_SHA });
    expect(getRunner(ctx, runnerId).git.ready).toBe(true);
  });

  test('as late work of an accepted attempt is no late work: logged, with its ref kept for cleanup', async () => {
    const { ctx, runnerId, task, runner } = await setup();
    const attempt = await running(ctx, runner, runnerId, task.id);
    acceptedSubmission(ctx, attempt.id, task.id);
    const { workRef } = getTask(ctx, task.id);
    // The runner learned of the end before its final push, which went to a late-work ref.
    const ref = await lateWork(runner, attempt.id, attempt.fence, task.id, 1, SUBMITTED_SHA);
    expect(rejects(ctx)).toEqual([]);
    // attempt.late_work records the pushed ref, so the task's ref cleanup deletes it (design 6.18).
    expect(lateEvents(ctx)).toEqual([[ref, SUBMITTED_SHA]]);
    expect(listEvents(ctx.db).find((event) => event.type === 'attempt.late_work')?.data.submittedHead).toBe(true);
    expect(recordedRefs(ctx, task.id)).toContainEqual({ ref, expectedSha: SUBMITTED_SHA });
    expect(lateNotes(ctx, task.id)).toEqual([]);
    expect(getTask(ctx, task.id)).toMatchObject({ status: 'accepted', workRef, workSha: SUBMITTED_SHA });
    // Its WIP ref was not pushed again, so its record stays.
    expect(getAttempt(ctx, attempt.id)).toMatchObject({ wipRef: attempt.wipRef, wipSha: WIP_SHA });
    expect(attemptLog(ctx, attempt.id).at(-1)?.summary).toContain(`${SUBMITTED_SHA} to ${ref}`);
  });
  test('a hand-back fallback of the submitted head stays out of a successor’s merge notes and messages', async () => {
    const { ctx, runnerId, task, runner } = await setup();
    const attempt = await running(ctx, runner, runnerId, task.id);
    updateAttempt(ctx, attempt.id, { submittedSha: SUBMITTED_SHA });
    endAttempt(ctx, { attemptId: attempt.id, trigger: 'lost' });
    await running(ctx, runner, runnerId, task.id);
    const ref = lateWorkRef('refs/agflow/', attempt.id, 1);
    const messages = listMessages(ctx);
    runner.emit('attempt.handed_back', { ref, sha: SUBMITTED_SHA }, { attemptId: attempt.id, fence: attempt.fence });
    await settle();
    expect(rejects(ctx)).toEqual([]);
    expect(listEvents(ctx.db).find((event) => event.type === 'attempt.late_work')?.data).toMatchObject({
      ref, sha: SUBMITTED_SHA, submittedHead: true,
    });
    expect(lateNotes(ctx, task.id)).toEqual([]);
    expect(listMessages(ctx)).toEqual(messages);
    expect(recordedRefs(ctx, task.id)).toContainEqual({ ref, expectedSha: SUBMITTED_SHA });
  });

});

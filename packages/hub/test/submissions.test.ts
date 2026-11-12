import { describe, expect, test } from 'bun:test';
import type { RawRunnerEvent, RunnerEventData } from '@agflow/core';
import { ACTIVE_MS } from '../src/agents';
import { attemptLog, getAttempt, updateAttempt } from '../src/attempt-store';
import { endAttempt, expireRunnerLeases, requestStop, resumeAttempt, startRunnerAttempt } from '../src/attempts';
import { mintAgentToken } from '../src/auth';
import { pendingCommands } from '../src/commands';
import { flushDeliveries } from '../src/delivery';
import { listEvents } from '../src/events';
import { applyRunnerEvents } from '../src/events-in';
import { listMessages } from '../src/messages';
import { branchHeadOf, findSubmission, insertSubmission, pendingSubmissionOf } from '../src/submission-store';
import { expireSubmissions, requestSubmission } from '../src/submissions';
import { getTask, writeTask } from '../src/task-store';
import { claimTask, createTasks, getTaskDetail, rejectTask, submitTask, unblockTask } from '../src/tasks';
import { type RunnerAttempt, addAgent, addRunner, addRunnerAttempt, newTask } from './helpers';
import { createTestHub } from './http-helpers';

type Hub = ReturnType<typeof createTestHub>;

const sha = (char: string) => char.repeat(40);
const work = { summary: 'Parser done.', evidence: ['bun test: 12 pass'] };

/** A hub with a running runner attempt holding a task, and its agent token. */
function setup() {
  const hub = createTestHub();
  const held = addRunnerAttempt(hub.ctx);
  const token = mintAgentToken(hub.ctx, held.attempt);
  return { hub, held, token, taskId: held.task.id };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

function submit(hub: Hub, token: string, taskId: string, body: unknown = work) {
  return hub.call('POST', `/api/tasks/${taskId}/submit`, { headers: bearer(token), body });
}

const pushesOf = (hub: Hub, held: RunnerAttempt) =>
  pendingCommands(hub.ctx, held.runner.id, 1)
    .map((row) => row.command)
    .filter((command) => command.kind === 'push_submission');

let seq = 0;

/** The runner reports that the attempt's process exited on its own, with its final WIP pushed. */
function exit(hub: Hub, held: RunnerAttempt): void {
  const raw: RawRunnerEvent = {
    seq: ++seq,
    at: hub.ctx.now(),
    type: 'attempt.exited',
    attemptId: held.attempt.id,
    fence: getAttempt(hub.ctx, held.attempt.id).fence,
    data: {
      code: 0,
      signal: null,
      stoppedBy: 'close',
      handoffWritten: false,
      cause: null,
      finalSha: sha('a'),
      finalWip: { ref: held.attempt.wipRef as string, sha: sha('a') },
      pushError: null,
    },
  };
  applyRunnerEvents(hub.ctx, held.runner.id, { outboxEpoch: 'outbox-1', events: [raw] }, { restoreReplay: false });
}

describe('a runner submission request', () => {
  test('a runner agent gets 202 with a pending submission, and submission.pending is emitted', async () => {
    const { hub, held, token, taskId } = setup();
    const answer = await submit(hub, token, taskId);
    expect(answer.status).toBe(202);
    expect(answer.json).toEqual({
      submission: {
        id: 'S-1',
        taskId,
        attemptId: held.attempt.id,
        status: 'pending',
        summary: work.summary,
        evidence: work.evidence,
        headSha: null,
        error: null,
        requestedAt: hub.ctx.now(),
        decidedAt: null,
      },
    });
    // The task waits for the push; nothing moves yet.
    expect(getTask(hub.ctx, taskId)).toMatchObject({ status: 'claimed', submission: null });
    const events = listEvents(hub.ctx.db, { subject: taskId }).filter((event) => event.type === 'submission.pending');
    expect(events.map((event) => [event.actor, event.data])).toEqual([
      [
        `agent:${held.agent.id}`,
        { submissionId: 'S-1', attemptId: held.attempt.id, taskId, agentId: held.agent.id, runnerId: held.runner.id },
      ],
    ]);
  });

  test('a branch or headSha from a runner agent is a 400; a live chat keeps 200 { task }', async () => {
    const { hub, token, taskId } = setup();
    for (const extra of [{ branch: 'agflow/T-1-elsewhere' }, { headSha: sha('a') }]) {
      const refused = await submit(hub, token, taskId, { ...work, ...extra });
      expect(refused.status).toBe(400);
    }
    expect(pendingSubmissionOf(hub.ctx, getTask(hub.ctx, taskId).currentAttempt as string)).toBeNull();

    const [task] = createTasks(hub.ctx, [newTask({ title: 'Live' })], 'user:alice');
    const agent = await hub.liveAgent('bob', 'session-bob');
    await hub.call('POST', `/api/tasks/${task?.id}/claim`, { user: 'bob', agent, body: {} });
    const live = await hub.call('POST', `/api/tasks/${task?.id}/submit`, {
      user: 'bob',
      agent,
      body: { ...work, headSha: sha('b') },
    });
    expect(live.status).toBe(200);
    expect(live.json.task).toMatchObject({ id: task?.id, status: 'submitted' });
  });

  test('the holder test applies, and a recorded stop or a take-over refuses', async () => {
    const { hub, held, token, taskId } = setup();
    const other = addRunnerAttempt(hub.ctx, { runnerId: held.runner.id });
    const theirs = mintAgentToken(hub.ctx, other.attempt);
    expect((await submit(hub, theirs, taskId)).status).toBe(403);

    requestStop(hub.ctx, { attemptId: held.attempt.id, cause: 'released', reason: 'not mine', by: 'system' });
    const stopping = await submit(hub, token, taskId);
    expect([stopping.status, stopping.json.error]).toEqual([409, 'conflict']);

    const otherTask = other.task.id;
    requestStop(hub.ctx, { attemptId: other.attempt.id, cause: 'takeover', reason: 'alice takes it', by: 'user:alice' });
    expect((await submit(hub, theirs, otherTask)).status).toBe(409);
    expect(listEvents(hub.ctx.db).filter((event) => event.type === 'submission.pending')).toEqual([]);
  });

  test("push_submission carries the task branch, its recorded head and the shas agflow knows as the task's work", () => {
    const { ctx, clock } = createTestHub();
    const [task] = createTasks(ctx, [newTask({ title: 'Parser' })], 'user:alice');
    const taskId = task?.id as string;
    // An M1 live submission, rejected and not returned to its author.
    const live = addAgent(ctx, 'bob');
    claimTask(ctx, taskId, live, 'agflow/T-1-parser');
    submitTask(ctx, taskId, live, { summary: 'Done.', evidence: [], headSha: sha('1') });
    clock.advance(ACTIVE_MS + 1);
    rejectTask(ctx, taskId, 'user:alice', 'Add a test.');
    // A runner attempt that started from a position and pushed a WIP, and a submission recorded earlier.
    const held = addRunnerAttempt(ctx, { taskId });
    updateAttempt(ctx, held.attempt.id, { startSha: sha('2'), wipSha: sha('3') });
    insertSubmission(ctx, { taskId, attemptId: held.attempt.id, summary: 'First try.', evidence: [] });
    ctx.db.run(`UPDATE submissions SET status = 'submitted', head_sha = '${sha('4')}'`);
    writeTask(ctx, taskId, { branchHead: sha('5') });

    const pending = requestSubmission(ctx, taskId, held.agent, work);
    const [push] = pendingCommands(ctx, held.runner.id, 1).map((row) => row.command);
    expect(push).toEqual({
      kind: 'push_submission',
      attemptId: held.attempt.id,
      fence: held.attempt.fence,
      submissionId: pending.id,
      branch: 'agflow/T-1-parser',
      expectedBranchSha: sha('5'),
      adoptable: [sha('2'), sha('3'), sha('4'), sha('1'), sha('5')],
    });
  });

  test('a second submit returns the pending one; the poll answers the submitting agent and people only', async () => {
    const { hub, held, token, taskId } = setup();
    const first = await submit(hub, token, taskId);
    const again = await submit(hub, token, taskId, { summary: 'Really done.', evidence: [] });
    expect(again.status).toBe(202);
    expect(again.json.submission).toEqual(first.json.submission);
    expect(pushesOf(hub, held)).toHaveLength(1);

    const poll = (options: Parameters<Hub['call']>[2]) => hub.call('GET', '/api/submissions/S-1', options);
    expect((await poll({ headers: bearer(token) })).json).toEqual({ submission: first.json.submission });
    expect((await poll({ user: 'bob', via: 'web' })).status).toBe(200);
    expect((await poll({ user: 'bob' })).status).toBe(200);
    const other = addRunnerAttempt(hub.ctx, { runnerId: held.runner.id });
    expect((await poll({ headers: bearer(mintAgentToken(hub.ctx, other.attempt)) })).status).toBe(403);
    const live = await hub.liveAgent('bob', 'session-bob');
    expect((await poll({ user: 'bob', agent: live })).status).toBe(403);
    expect((await hub.call('GET', '/api/submissions/S-9', { user: 'bob' })).status).toBe(404);
  });
});

describe('while a submission is pending', () => {
  test("a person's or the lead's stop or replace is stored deferred, with no move and no stop_attempt", async () => {
    const { hub, held, token, taskId } = setup();
    await submit(hub, token, taskId);
    const stop = requestStop(hub.ctx, { attemptId: held.attempt.id, cause: 'stop', reason: 'enough', by: 'user:alice' });
    expect(stop.outcome).toBe('requested');
    expect(getAttempt(hub.ctx, held.attempt.id).stopRequested).toMatchObject({ cause: 'stop', deferred: true });
    const replace = requestStop(hub.ctx, { attemptId: held.attempt.id, cause: 'replace', reason: 'x', by: 'agent:A-9' });
    expect(replace.outcome).toBe('replaced');
    expect(getAttempt(hub.ctx, held.attempt.id).stopRequested).toMatchObject({ cause: 'replace', deferred: true });
    const kinds = pendingCommands(hub.ctx, held.runner.id, 1).map((row) => row.kind);
    expect(kinds).toEqual(['push_submission']);
    expect(getTask(hub.ctx, taskId).status).toBe('claimed');
    // A cancel moves the task at once, so it is never held back.
    requestStop(hub.ctx, { attemptId: held.attempt.id, cause: 'cancel', reason: 'not needed', by: 'user:alice' });
    expect(getAttempt(hub.ctx, held.attempt.id).stopRequested).toMatchObject({ cause: 'cancel', deferred: false });
    expect(getTask(hub.ctx, taskId).status).toBe('cancelled');
  });

  test("a person's stop and hold is held back too: the task is not paused while its push is in flight", async () => {
    const { hub, held, token, taskId } = setup();
    await submit(hub, token, taskId);
    requestStop(hub.ctx, { attemptId: held.attempt.id, cause: 'stop_hold', reason: 'look', by: 'user:alice' });
    expect(getAttempt(hub.ctx, held.attempt.id).stopRequested).toMatchObject({ cause: 'stop_hold', deferred: true });
    expect(getTask(hub.ctx, taskId)).toMatchObject({ status: 'claimed', blockedKind: null });
    expect(pendingCommands(hub.ctx, held.runner.id, 1).map((row) => row.kind)).toEqual(['push_submission']);
  });

  test('an attempt that ends with a stop and hold held back still pauses the task, on its exit or lease expiry', async () => {
    for (const end of ['exit', 'lease'] as const) {
      const { hub, held, token, taskId } = setup();
      await submit(hub, token, taskId);
      requestStop(hub.ctx, { attemptId: held.attempt.id, cause: 'stop_hold', reason: 'look', by: 'user:alice' });
      if (end === 'exit') exit(hub, held);
      else {
        hub.clock.advance(hub.ctx.config.runnerLeaseMs);
        expect(expireRunnerLeases(hub.ctx)).toBe(1);
      }
      expect(getAttempt(hub.ctx, held.attempt.id).status).toBe('ended');
      expect(findSubmission(hub.ctx, 'S-1')?.status).toBe('failed');
      expect(getTask(hub.ctx, taskId)).toMatchObject({
        status: 'blocked',
        blockedKind: 'paused',
        blockedReason: 'look',
        assignee: null,
      });
    }
  });

  test('a re-fence sends the push again at the new fence while its submission is pending', async () => {
    const { hub, held, token, taskId } = setup();
    await submit(hub, token, taskId);
    const [before] = pushesOf(hub, held);
    const { attempt } = resumeAttempt(hub.ctx, { attemptId: held.attempt.id, cause: 'runner_restart', prompt: 'Go on.' });
    expect(pendingCommands(hub.ctx, held.runner.id, 1).map((row) => row.kind)).toEqual([
      'resume_attempt',
      'push_submission',
    ]);
    expect(pushesOf(hub, held)).toEqual([{ ...(before as object), fence: attempt.fence } as never]);
    expect(findSubmission(hub.ctx, 'S-1')?.status).toBe('pending');
  });

  test("the attempt's end fails it, 'attempt ended: <reason>', and cancels its push", async () => {
    const { hub, held, token, taskId } = setup();
    await submit(hub, token, taskId);
    hub.clock.advance(hub.ctx.config.runnerLeaseMs);
    expect(expireRunnerLeases(hub.ctx)).toBe(1);
    expect(getTaskDetail(hub.ctx, taskId).submissions).toEqual([
      expect.objectContaining({ id: 'S-1', status: 'failed', error: 'attempt ended: lost', decidedAt: hub.ctx.now() }),
    ]);
    expect(pushesOf(hub, held)).toEqual([]);
    const failed = listEvents(hub.ctx.db, { subject: taskId }).filter((event) => event.type === 'submission.failed');
    expect(failed.map((event) => event.data)).toEqual([
      {
        submissionId: 'S-1',
        attemptId: held.attempt.id,
        taskId,
        agentId: held.agent.id,
        runnerId: held.runner.id,
        error: 'attempt ended: lost',
      },
    ]);
  });

  test('the task detail lists its submissions, newest first', async () => {
    const { hub, held, token, taskId } = setup();
    await submit(hub, token, taskId);
    endAttempt(hub.ctx, { attemptId: held.attempt.id, trigger: 'crashed', error: 'boom' });
    const next = addRunnerAttempt(hub.ctx, { taskId, runnerId: held.runner.id });
    await submit(hub, mintAgentToken(hub.ctx, next.attempt), taskId);
    const detail = await hub.call('GET', `/api/tasks/${taskId}`, { user: 'bob' });
    expect(detail.json.submissions.map((one: { id: string; status: string }) => [one.id, one.status])).toEqual([
      ['S-2', 'pending'],
      ['S-1', 'failed'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Outcomes and timeouts
// ---------------------------------------------------------------------------

type Outcome = RunnerEventData['attempt.submitted'];

/** The runner reports a submission's outcome for the attempt, at its fence as the hub has it now. */
function report(hub: Hub, held: RunnerAttempt, outcome: Outcome): void {
  const raw: RawRunnerEvent = {
    seq: ++seq,
    at: hub.ctx.now(),
    type: 'attempt.submitted',
    attemptId: held.attempt.id,
    fence: getAttempt(hub.ctx, held.attempt.id).fence,
    data: outcome,
  };
  applyRunnerEvents(hub.ctx, held.runner.id, { outboxEpoch: 'outbox-1', events: [raw] }, { restoreReplay: false });
  expect(hub.ctx.db.query('SELECT error FROM runner_event_rejects').all()).toEqual([]);
}

const pushed = (submissionId: string, headSha = sha('a')): Outcome => ({
  submissionId,
  ok: true,
  headSha,
  remoteHead: headSha,
  error: null,
  detail: null,
});

const refused = (submissionId: string, error: Outcome['error'], detail: string | null, remoteHead = sha('e')): Outcome => ({
  submissionId,
  ok: false,
  headSha: sha('a'),
  remoteHead,
  error,
  detail,
});

const toAgent = (hub: Hub, agentId: string) =>
  listMessages(hub.ctx, { target: `agent:${agentId}` }).map((message) => message.body);
/** The commands queued after the push, which stays pending until the runner's result. */
const afterPush = (hub: Hub, held: RunnerAttempt) =>
  pendingCommands(hub.ctx, held.runner.id, 1).filter((row) => row.kind !== 'push_submission');
const kindsFor = (hub: Hub, held: RunnerAttempt) => afterPush(hub, held).map((row) => row.kind);
const eventsOf = (hub: Hub, taskId: string, type: string) =>
  listEvents(hub.ctx.db, { subject: taskId }).filter((event) => event.type === type);

/** A runner attempt with a pending submission S-1. */
async function pendingSetup() {
  const { hub, held, token, taskId } = setup();
  await submit(hub, token, taskId);
  return { hub, held, token, taskId };
}

describe('a successful outcome', () => {
  test('submits the task, holds the attempt, drops a deferred stop, tells the lead and emits the events', async () => {
    const { hub, held, taskId } = await pendingSetup();
    requestStop(hub.ctx, { attemptId: held.attempt.id, cause: 'stop', reason: 'enough', by: 'user:alice' });
    report(hub, held, pushed('S-1'));
    const task = getTask(hub.ctx, taskId);
    expect(task).toMatchObject({
      status: 'submitted',
      assignee: held.agent.id,
      workRef: `refs/heads/${held.task.branch}`,
      workSha: sha('a'),
      submission: {
        summary: work.summary,
        evidence: work.evidence,
        branch: held.task.branch,
        headSha: sha('a'),
        by: held.agent.id,
        attemptId: held.attempt.id,
        submissionId: 'S-1',
      },
    });
    expect(branchHeadOf(hub.ctx, taskId)).toBe(sha('a'));
    expect(getAttempt(hub.ctx, held.attempt.id)).toMatchObject({
      status: 'holding',
      leaseExpiresAt: null,
      submittedSha: sha('a'),
      stopRequested: null,
    });
    expect(afterPush(hub, held).map((row) => row.command)).toEqual([
      { kind: 'hold_attempt', attemptId: held.attempt.id, fence: held.attempt.fence },
    ]);
    expect(findSubmission(hub.ctx, 'S-1')).toMatchObject({ status: 'submitted', headSha: sha('a'), error: null });
    const lead = listMessages(hub.ctx, { target: 'lead' });
    expect(lead[0]?.body).toContain(`was submitted by ${held.agent.id} for review on branch ${held.task.branch}`);
    expect(lead[0]?.body).toContain(`> ${work.summary}`);
    const dropped = listMessages(hub.ctx, { target: 'humans' });
    expect(dropped[0]?.body).toContain('user:alice');
    expect(dropped[0]?.body).toContain('was dropped');
    expect(eventsOf(hub, taskId, 'submission.recorded').map((event) => event.data)).toEqual([
      {
        submissionId: 'S-1',
        attemptId: held.attempt.id,
        taskId,
        agentId: held.agent.id,
        runnerId: held.runner.id,
        headSha: sha('a'),
        branch: held.task.branch,
      },
    ]);
    expect(eventsOf(hub, taskId, 'attempt.holding').map((event) => event.data.submissionId)).toEqual(['S-1']);
  });

  test("a lead's deferred stop is dropped with word to the lead", async () => {
    const { hub, held } = await pendingSetup();
    const lead = addAgent(hub.ctx, 'alice', 'lead');
    requestStop(hub.ctx, { attemptId: held.attempt.id, cause: 'replace', reason: 'slow', by: `agent:${lead.id}` });
    report(hub, held, pushed('S-1'));
    expect(toAgent(hub, lead.id)[0]).toContain('was dropped');
  });

  test('a stop that moves the task only when the attempt ends does not keep a success from being recorded', async () => {
    const { hub, held, taskId } = await pendingSetup();
    requestStop(hub.ctx, { attemptId: held.attempt.id, cause: 'released', reason: 'done', by: `agent:${held.agent.id}` });
    expect(kindsFor(hub, held)).toEqual(['stop_attempt']);
    report(hub, held, pushed('S-1'));
    expect(getTask(hub.ctx, taskId)).toMatchObject({ status: 'submitted', submission: { submissionId: 'S-1' } });
    expect(getAttempt(hub.ctx, held.attempt.id)).toMatchObject({ status: 'holding', stopRequested: null });
    expect(findSubmission(hub.ctx, 'S-1')?.status).toBe('submitted');
    // The stop the runner had not taken yet is cancelled with it.
    expect(kindsFor(hub, held)).toEqual(['hold_attempt']);
    expect(listMessages(hub.ctx, { target: 'lead' })).toHaveLength(1);
  });

  test('the same success reported again records the heads and says nothing more', async () => {
    const { hub, held, taskId } = await pendingSetup();
    report(hub, held, pushed('S-1'));
    report(hub, held, pushed('S-1'));
    expect(getTask(hub.ctx, taskId).status).toBe('submitted');
    expect(findSubmission(hub.ctx, 'S-1')).toMatchObject({ status: 'submitted', headSha: sha('a') });
    expect(listMessages(hub.ctx, { target: 'lead' })).toHaveLength(1);
    expect(toAgent(hub, held.agent.id)).toEqual([]);
    expect(kindsFor(hub, held)).toEqual(['hold_attempt']);
    expect(eventsOf(hub, taskId, 'submission.recorded')).toHaveLength(1);
  });

  test('an exit after the recorded submission leaves the task submitted', async () => {
    const { hub, held, taskId } = await pendingSetup();
    report(hub, held, pushed('S-1'));
    exit(hub, held);
    expect(getAttempt(hub.ctx, held.attempt.id).status).toBe('holding');
    expect(getTask(hub.ctx, taskId).status).toBe('submitted');
  });
});

describe('a refused outcome', () => {
  const fixes: [Outcome['error'], string, string][] = [
    ['dirty', 'uncommitted changes', 'src/parser.ts is modified'],
    ['protected_paths', 'protected paths', 'merge main rather than revert: main changed .github/workflows/ci.yml'],
    ['needs_merge', 'git fetch origin && git merge origin/', 'origin has 2 commits on top of agflow work'],
  ];
  for (const [error, fix, detail] of fixes) {
    test(`${error} fails it and tells the agent what to fix, with the runner's detail unchanged`, async () => {
      const { hub, held, taskId } = await pendingSetup();
      report(hub, held, refused('S-1', error, detail));
      expect(findSubmission(hub.ctx, 'S-1')).toMatchObject({ status: 'failed', error: `${error}: ${detail}` });
      const [told] = toAgent(hub, held.agent.id);
      expect(told).toContain('S-1');
      expect(told).toContain(fix);
      expect(told).toContain(`> ${detail}`);
      expect(told).toContain('submit again');
      expect(getTask(hub.ctx, taskId).status).toBe('claimed');
      expect(getAttempt(hub.ctx, held.attempt.id).status).toBe('running');
      expect(eventsOf(hub, taskId, 'submission.failed').map((event) => event.data.error)).toEqual([`${error}: ${detail}`]);
      // The agent may submit again at once.
      expect(requestSubmission(hub.ctx, taskId, held.agent, work).id).toBe('S-2');
    });
  }

  test('a fixable refusal applies a stop held back for the submission', async () => {
    const { hub, held, taskId } = await pendingSetup();
    requestStop(hub.ctx, { attemptId: held.attempt.id, cause: 'stop', reason: 'enough', by: 'user:alice' });
    hub.clock.advance(1_000);
    report(hub, held, refused('S-1', 'dirty', 'src/parser.ts is modified'));
    expect(getAttempt(hub.ctx, held.attempt.id).stopRequested).toMatchObject({
      cause: 'stop',
      deferred: false,
      at: hub.ctx.now(),
    });
    expect(kindsFor(hub, held)).toEqual(['stop_attempt']);
    expect(getTask(hub.ctx, taskId).status).toBe('claimed');
  });

  test('branch_moved blocks the task with both shas and stops the attempt with a handoff', async () => {
    const { hub, held, taskId } = await pendingSetup();
    report(hub, held, refused('S-1', 'branch_moved', 'the branch is not agflow work', sha('e')));
    const task = getTask(hub.ctx, taskId);
    expect(task).toMatchObject({ status: 'blocked', blockedKind: 'branch_moved' });
    expect(task.blockedReason).toContain(sha('a'));
    expect(task.blockedReason).toContain(sha('e'));
    expect(getAttempt(hub.ctx, held.attempt.id).stopRequested).toMatchObject({
      cause: 'branch_moved',
      handoff: true,
      deferred: false,
    });
    expect(kindsFor(hub, held)).toEqual(['stop_attempt']);
    expect(findSubmission(hub.ctx, 'S-1')?.status).toBe('failed');
    expect(listMessages(hub.ctx, { target: 'humans' })[0]?.body).toContain(sha('e'));
    expect(toAgent(hub, held.agent.id)[0]).toContain('safe in your WIP ref');
    expect(toAgent(hub, held.agent.id)[0]).toContain('> the branch is not agflow work');
    // Unblocking adopts the remote head the task shows.
    unblockTask(hub.ctx, taskId, 'user:alice');
    expect(branchHeadOf(hub.ctx, taskId)).toBe(sha('e'));
  });

  for (const error of ['remote', 'interrupted'] as const) {
    test(`${error} fails it like the timeout: the work is safe, and a deferred stop applies`, async () => {
      const { hub, held, taskId } = await pendingSetup();
      requestStop(hub.ctx, { attemptId: held.attempt.id, cause: 'stop', reason: 'enough', by: 'user:alice' });
      hub.clock.advance(1_000);
      report(hub, held, refused('S-1', error, error === 'remote' ? 'HTTP 503 from origin' : null));
      expect(findSubmission(hub.ctx, 'S-1')?.status).toBe('failed');
      const [told] = toAgent(hub, held.agent.id);
      expect(told).toContain(`safe in your WIP ref ${held.attempt.wipRef}`);
      expect(told).toContain('submit again, or call declare_blocked');
      if (error === 'remote') expect(told).toContain('> HTTP 503 from origin');
      expect(getAttempt(hub.ctx, held.attempt.id).stopRequested).toMatchObject({
        cause: 'stop',
        deferred: false,
        at: hub.ctx.now(),
      });
      expect(kindsFor(hub, held)).toEqual(['stop_attempt']);
      expect(eventsOf(hub, taskId, 'submission.failed')).toHaveLength(1);
    });
  }

  test('expireSubmissions fails one pending past submitTimeoutMs: error remote, push cancelled, stop applied', async () => {
    const { hub, held, taskId } = await pendingSetup();
    requestStop(hub.ctx, { attemptId: held.attempt.id, cause: 'replace', reason: 'slow', by: 'user:alice' });
    hub.clock.advance(hub.ctx.config.submitTimeoutMs - 1);
    expect(expireSubmissions(hub.ctx)).toBe(0);
    hub.clock.advance(1);
    expect(expireSubmissions(hub.ctx)).toBe(1);
    expect(findSubmission(hub.ctx, 'S-1')).toMatchObject({ status: 'failed', error: 'remote' });
    expect(pushesOf(hub, held)).toEqual([]);
    expect(kindsFor(hub, held)).toEqual(['stop_attempt']);
    expect(getAttempt(hub.ctx, held.attempt.id).stopRequested).toMatchObject({ cause: 'replace', deferred: false });
    expect(toAgent(hub, held.agent.id)[0]).toContain('safe in your WIP ref');
    expect(eventsOf(hub, taskId, 'submission.failed').map((event) => event.data.error)).toEqual(['remote']);
    expect(expireSubmissions(hub.ctx)).toBe(0);
  });
});

describe('outcomes the hub cannot match', () => {
  test("a success naming another attempt's submission records nothing, and is logged on the reporting attempt", async () => {
    const { hub, held, taskId } = await pendingSetup();
    const other = addRunnerAttempt(hub.ctx, { runnerId: held.runner.id });
    report(hub, other, pushed('S-1', sha('9')));
    expect(findSubmission(hub.ctx, 'S-1')).toMatchObject({ status: 'pending', headSha: null });
    expect(branchHeadOf(hub.ctx, taskId)).toBeNull();
    expect(branchHeadOf(hub.ctx, other.task.id)).toBeNull();
    expect(attemptLog(hub.ctx, other.attempt.id).map((entry) => entry.kind)).toContain('rejected');
  });

  test('a success naming a submission the hub does not have still records the branch head', async () => {
    const { hub, held, taskId } = await pendingSetup();
    report(hub, held, pushed('S-77', sha('7')));
    expect(branchHeadOf(hub.ctx, taskId)).toBe(sha('7'));
    expect(findSubmission(hub.ctx, 'S-1')?.status).toBe('pending');
    expect(attemptLog(hub.ctx, held.attempt.id).at(-1)?.summary).toContain('S-77');

    // An attempt the hub does not know, after a restore: its id names the task.
    const raw: RawRunnerEvent = {
      seq: ++seq,
      at: hub.ctx.now(),
      type: 'attempt.submitted',
      attemptId: `${taskId}-a9`,
      fence: held.attempt.fence,
      data: pushed('S-78', sha('8')),
    };
    applyRunnerEvents(hub.ctx, held.runner.id, { outboxEpoch: 'outbox-1', events: [raw] }, { restoreReplay: false });
    expect(branchHeadOf(hub.ctx, taskId)).toBe(sha('8'));
    expect(getTask(hub.ctx, taskId).status).toBe('claimed');
    // A refusal records nothing.
    report(hub, held, refused('S-79', 'remote', null));
    expect(branchHeadOf(hub.ctx, taskId)).toBe(sha('8'));
  });
});

describe('outcomes that come late', () => {
  test('every outcome of a failed submission reaches the agent; a late success records the head only', async () => {
    const { hub, held, taskId } = await pendingSetup();
    hub.clock.advance(hub.ctx.config.submitTimeoutMs);
    expireSubmissions(hub.ctx);
    report(hub, held, refused('S-1', 'remote', 'HTTP 503 from origin'));
    report(hub, held, pushed('S-1'));
    const told = toAgent(hub, held.agent.id);
    expect(told).toHaveLength(3);
    expect(told[1]).toContain('HTTP 503 from origin');
    expect(told[0]).toContain(`${held.task.branch} is at ${sha('a')}`);
    expect(findSubmission(hub.ctx, 'S-1')).toMatchObject({ status: 'failed', headSha: sha('a') });
    expect(getTask(hub.ctx, taskId).status).toBe('claimed');
    expect(branchHeadOf(hub.ctx, taskId)).toBe(sha('a'));
    expect(listMessages(hub.ctx, { target: 'lead' })[0]?.body).toContain(`${held.task.branch} moved to ${sha('a')}`);
  });

  test('a success for an older submission records only the head and tells the lead and the holder', async () => {
    const { hub, held, taskId } = await pendingSetup();
    report(hub, held, refused('S-1', 'dirty', 'src/parser.ts is modified'));
    requestSubmission(hub.ctx, taskId, held.agent, work);
    report(hub, held, pushed('S-1', sha('b')));
    expect(findSubmission(hub.ctx, 'S-2')?.status).toBe('pending');
    expect(getTask(hub.ctx, taskId).status).toBe('claimed');
    expect(branchHeadOf(hub.ctx, taskId)).toBe(sha('b'));
    expect(listMessages(hub.ctx, { target: 'lead' })[0]?.body).toContain(`moved to ${sha('b')}`);
    // The holder is the agent that submitted it: one message, as for any outcome of a failed submission.
    const told = toAgent(hub, held.agent.id);
    expect(told).toHaveLength(2);
    expect(told[0]).toContain(`${held.task.branch} is at ${sha('b')}`);
  });

  test('a success of an attempt that ended records only the head, and the new holder is told to merge', async () => {
    const { hub, held, taskId } = await pendingSetup();
    endAttempt(hub.ctx, { attemptId: held.attempt.id, trigger: 'crashed', error: 'boom' });
    const next = addRunnerAttempt(hub.ctx, { taskId, runnerId: held.runner.id });
    report(hub, held, pushed('S-1', sha('c')));
    expect(findSubmission(hub.ctx, 'S-1')).toMatchObject({ status: 'failed', error: 'attempt ended: crashed' });
    expect(branchHeadOf(hub.ctx, taskId)).toBe(sha('c'));
    expect(getTask(hub.ctx, taskId)).toMatchObject({ status: 'claimed', currentAttempt: next.attempt.id });
    const branchRef = `refs/heads/${held.task.branch}`;
    expect(pendingCommands(hub.ctx, held.runner.id, 1).map((row) => row.command)).toContainEqual({
      kind: 'refresh_vault',
      taskId,
      refs: [branchRef],
    });
    expect(toAgent(hub, next.agent.id)[0]).toContain(`git fetch origin && git merge origin/${held.task.branch}`);
    expect(listMessages(hub.ctx, { target: 'lead' })[0]?.body).toContain(`moved to ${sha('c')}`);
  });
});


describe('branches for a runner lead to review', () => {
  function seat(hub: Hub) {
    const runnerId = addRunner(hub.ctx, { owner: 'bob' });
    const { attempt } = startRunnerAttempt(hub.ctx, { runnerId, taskId: null, role: 'lead', vendor: 'claude' });
    updateAttempt(hub.ctx, attempt.id, { status: 'running', phase: 'idle' });
    return { runnerId, attempt };
  }

  function checkRefresh(hub: Hub, runnerId: string, taskId: string, branch: string) {
    hub.clock.advance(hub.ctx.config.deliveryBatchMs);
    flushDeliveries(hub.ctx);
    const commands = pendingCommands(hub.ctx, runnerId, 1);
    const refresh = commands.findLast((row) => row.kind === 'refresh_vault');
    expect(refresh?.command).toEqual({ kind: 'refresh_vault', taskId, refs: [`refs/heads/${branch}`] });
    const deliver = commands.findLast((row) => row.kind === 'deliver');
    expect(deliver).toBeDefined();
    expect(refresh!.seq).toBeLessThan(deliver!.seq);
    expect(listMessages(hub.ctx, { target: 'lead' })[0]?.body).toContain('git fetch origin');
  }

  test('a submission and resubmission refresh the other runner before review delivery', async () => {
    const { hub, held, taskId } = await pendingSetup();
    const lead = seat(hub);
    expect(lead.runnerId).not.toBe(held.runner.id);
    report(hub, held, pushed('S-1'));
    checkRefresh(hub, lead.runnerId, taskId, held.task.branch!);
    rejectTask(hub.ctx, taskId, `agent:${lead.attempt.agentId}`, 'Please revise.');
    requestSubmission(hub.ctx, taskId, held.agent, work);
    report(hub, held, pushed('S-2', sha('b')));
    checkRefresh(hub, lead.runnerId, taskId, held.task.branch!);
    expect(pendingCommands(hub.ctx, lead.runnerId, 1).filter((row) => row.kind === 'refresh_vault')).toHaveLength(2);
  });

  test('seating a runner lead refreshes waiting submissions before its start', async () => {
    const { hub, held, taskId } = await pendingSetup();
    report(hub, held, pushed('S-1'));
    const lead = seat(hub);
    const commands = pendingCommands(hub.ctx, lead.runnerId, 1);
    expect(commands[0]?.command).toEqual({ kind: 'refresh_vault', taskId, refs: [`refs/heads/${held.task.branch}`] });
    expect(commands[1]?.kind).toBe('start_attempt');
  });

  test('a live-chat submission also refreshes its chosen branch for the runner lead', () => {
    const hub = createTestHub();
    const lead = seat(hub);
    const worker = addAgent(hub.ctx);
    const task = createTasks(hub.ctx, [newTask()], 'user:alice')[0]!;
    claimTask(hub.ctx, task.id, worker);
    submitTask(hub.ctx, task.id, worker, { ...work, branch: 'person-review', headSha: sha('c') });
    checkRefresh(hub, lead.runnerId, task.id, 'person-review');
  });

  test.each(['empty', 'live'] as const)('no refresh with a %s lead seat', async (kind) => {
    const { hub, held } = await pendingSetup();
    if (kind === 'live') addAgent(hub.ctx, 'bob', 'lead');
    report(hub, held, pushed('S-1'));
    expect(hub.ctx.db.query("SELECT id FROM runner_commands WHERE kind = 'refresh_vault'").all()).toEqual([]);
  });
});

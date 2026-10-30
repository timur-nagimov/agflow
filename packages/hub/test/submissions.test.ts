import { describe, expect, test } from 'bun:test';
import type { RawRunnerEvent } from '@agflow/core';
import { ACTIVE_MS } from '../src/agents';
import { getAttempt, updateAttempt } from '../src/attempt-store';
import { endAttempt, expireRunnerLeases, requestStop, resumeAttempt } from '../src/attempts';
import { mintAgentToken } from '../src/auth';
import { pendingCommands } from '../src/commands';
import { listEvents } from '../src/events';
import { applyRunnerEvents } from '../src/events-in';
import { findSubmission, insertSubmission, pendingSubmissionOf } from '../src/submission-store';
import { requestSubmission } from '../src/submissions';
import { getTask, writeTask } from '../src/task-store';
import { claimTask, createTasks, getTaskDetail, rejectTask, submitTask } from '../src/tasks';
import { type RunnerAttempt, addAgent, addRunnerAttempt, newTask } from './helpers';
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

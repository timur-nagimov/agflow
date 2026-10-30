import { describe, expect, test } from 'bun:test';
import { type InjectedMessage, compareFence, restoreSet } from '@agflow/core';
import { attemptLog, getAttempt, updateAttempt } from '../src/attempt-store';
import { recentResumes, resumeAttempt, startRunnerAttempt } from '../src/attempts';
import { mintAgentToken, resolveAgentToken } from '../src/auth';
import { composeTaskPack } from '../src/brief';
import { enqueueCommand, findCommand, pendingCommands, toWireCommand } from '../src/commands';
import { listEvents } from '../src/events';
import { getTask, writeTask } from '../src/task-store';
import { addRunner, addRunnerAttempt, createTestContext } from './helpers';

function setup() {
  const { ctx, clock } = createTestContext();
  const held = addRunnerAttempt(ctx);
  return { ctx, clock, held };
}

const note = (messageId: number, text: string): InjectedMessage => ({ messageId, authority: 'person', text });

describe('resuming an attempt', () => {
  test('sets starting with a higher fence and a renewed lease, and emits attempt.resumed', () => {
    const { ctx, clock, held } = setup();
    updateAttempt(ctx, held.attempt.id, { status: 'holding', leaseExpiresAt: null });
    clock.advance(60_000);
    const { attempt, command } = resumeAttempt(ctx, {
      attemptId: held.attempt.id,
      cause: 'review',
      prompt: '> Handle empty lists.',
    });
    expect(compareFence(attempt.fence, held.attempt.fence)).toBe(1);
    expect(attempt).toMatchObject({ status: 'starting', leaseExpiresAt: ctx.now() + ctx.config.runnerLeaseMs });
    expect(command).toMatchObject({ kind: 'resume_attempt', attemptId: attempt.id, fence: attempt.fence });
    const resumed = listEvents(ctx.db).filter((event) => event.type === 'attempt.resumed');
    expect(resumed.map((event) => [event.subject, event.data])).toEqual([
      [
        held.task.id,
        {
          attemptId: attempt.id,
          taskId: held.task.id,
          agentId: held.agent.id,
          runnerId: held.runner.id,
          fence: attempt.fence,
          reason: 'the review feedback goes back to its author',
        },
      ],
    ]);
    expect(attemptLog(ctx, attempt.id).map((entry) => [entry.kind, entry.summary])).toEqual([
      ['note', 'resumed at fence e1.2: the review feedback goes back to its author'],
    ]);
  });

  test('old tokens answer attempt_ended, and the new command carries a token that works', () => {
    const { ctx, held } = setup();
    const old = mintAgentToken(ctx, held.attempt);
    expect(resolveAgentToken(ctx, old).attempt.id).toBe(held.attempt.id);
    const live = () =>
      ctx.db
        .query('SELECT COUNT(*) AS n FROM agent_tokens WHERE attempt_id = $id AND revoked_at IS NULL')
        .get({ id: held.attempt.id });
    const { command } = resumeAttempt(ctx, { attemptId: held.attempt.id, cause: 'runner_restart', prompt: 'continue' });
    // The old fence's tokens are revoked, not only refused, so retention can delete them.
    expect(live()).toEqual({ n: 0 });
    expect(() => resolveAgentToken(ctx, old)).toThrow(expect.objectContaining({ code: 'attempt_ended' }));
    const wire = toWireCommand(ctx, command).command;
    expect(live()).toEqual({ n: 1 });
    if (wire.kind !== 'resume_attempt') throw new Error('not a resume');
    expect(resolveAgentToken(ctx, wire.agentToken).attempt.fence).toEqual(getAttempt(ctx, held.attempt.id).fence);
    const { payload } = ctx.db.query('SELECT payload FROM runner_commands WHERE id = $id').get({ id: command.id }) as {
      payload: string;
    };
    expect(payload).not.toContain('agt_');
  });

  test("the old fence's pending commands are cancelled; a pending resume's prompt and messages move into the new one", () => {
    const { ctx, held } = setup();
    const { attempt } = held;
    const deliver = enqueueCommand(ctx, held.runner.id, {
      kind: 'deliver',
      attemptId: attempt.id,
      fence: attempt.fence,
      messages: [note(3, 'hi')],
      more: 0,
    });
    const cleanup = enqueueCommand(ctx, held.runner.id, { kind: 'cleanup_attempt', attemptId: attempt.id });
    const first = resumeAttempt(ctx, {
      attemptId: attempt.id,
      cause: 'review',
      prompt: '> Handle empty lists.',
      messages: [note(4, 'also add a test')],
    });
    expect(findCommand(ctx, deliver.id)?.status).toBe('cancelled');
    expect(findCommand(ctx, cleanup.id)?.status).toBe('pending');
    // The first resume never reached the runner; the runner restarts and the hub re-fences again.
    const second = resumeAttempt(ctx, {
      attemptId: attempt.id,
      cause: 'runner_restart',
      prompt: 'the runner restarted; continue from your last step',
      messages: [note(4, 'also add a test'), note(5, 'and docs')],
    });
    expect(findCommand(ctx, first.command.id)?.status).toBe('cancelled');
    expect(second.command.command).toMatchObject({
      prompt: '> Handle empty lists.\n\nthe runner restarted; continue from your last step',
      messages: [note(4, 'also add a test'), note(5, 'and docs')],
    });
    expect(pendingCommands(ctx, held.runner.id, 1).map((row) => row.kind)).toEqual(['cleanup_attempt', 'resume_attempt']);
    // A third re-fence for the same reason does not repeat the line the carried prompt already ends with.
    const third = resumeAttempt(ctx, {
      attemptId: attempt.id,
      cause: 'runner_restart',
      prompt: 'the runner restarted; continue from your last step',
    });
    expect(third.command.command).toMatchObject({
      prompt: '> Handle empty lists.\n\nthe runner restarted; continue from your last step',
    });
  });

  test('the command carries a recomputed task pack, restore set and acceptance ids', () => {
    const { ctx, held } = setup();
    writeTask(ctx, held.task.id, { feedback: 'Handle empty lists.' });
    const { command } = resumeAttempt(ctx, { attemptId: held.attempt.id, cause: 'review', prompt: 'fix it' });
    const task = getTask(ctx, held.task.id);
    expect(command.command).toEqual({
      kind: 'resume_attempt',
      attemptId: held.attempt.id,
      fence: getAttempt(ctx, held.attempt.id).fence,
      prompt: 'fix it',
      messages: [],
      taskPack: composeTaskPack(task),
      restore: { paths: restoreSet(task), base: 'refs/heads/main' },
      acceptanceIds: ['A1'],
    });
    expect(composeTaskPack(task)).toContain('> Handle empty lists.');
  });

  test('a recorded stop is sent again at the new fence; a take-over or an ended attempt cannot be resumed', () => {
    const { ctx, held } = setup();
    const stop = { cause: 'stop' as const, reason: 'a person stopped it', by: 'user:alice', handoff: true };
    updateAttempt(ctx, held.attempt.id, { stopRequested: { ...stop, deferred: false, at: ctx.now() } });
    const { attempt } = resumeAttempt(ctx, { attemptId: held.attempt.id, cause: 'restore', prompt: 'continue' });
    expect(pendingCommands(ctx, held.runner.id, 1).map((row) => [row.kind, row.fence])).toEqual([
      ['resume_attempt', attempt.fence],
      ['stop_attempt', attempt.fence],
    ]);
    expect(pendingCommands(ctx, held.runner.id, 1).at(-1)?.command).toEqual({
      kind: 'stop_attempt',
      attemptId: attempt.id,
      fence: attempt.fence,
      cause: 'stop',
      reason: '[agflow stop requested by user:alice]\n> a person stopped it',
      handoff: true,
      interruptFirst: false,
      keepClone: false,
    });
    // A deferred stop waits for its submission: the re-fence does not send it.
    updateAttempt(ctx, held.attempt.id, { stopRequested: { ...stop, deferred: true, at: ctx.now() } });
    resumeAttempt(ctx, { attemptId: held.attempt.id, cause: 'restore', prompt: 'continue' });
    expect(pendingCommands(ctx, held.runner.id, 1).map((row) => row.kind)).toEqual(['resume_attempt']);

    updateAttempt(ctx, held.attempt.id, { stopRequested: { ...stop, cause: 'takeover', deferred: false, at: 0 } });
    expect(() => resumeAttempt(ctx, { attemptId: held.attempt.id, cause: 'restore', prompt: 'continue' })).toThrow(
      'a take-over is in flight',
    );
    updateAttempt(ctx, held.attempt.id, { status: 'ended', endReason: 'stopped', endedAt: ctx.now() });
    expect(() => resumeAttempt(ctx, { attemptId: held.attempt.id, cause: 'restore', prompt: 'continue' })).toThrow(
      `attempt ${held.attempt.id} has ended (stopped)`,
    );
  });

  test('a stop sent again at the new fence gets its grace again from the re-fence', () => {
    const { ctx, clock, held } = setup();
    const stop = { cause: 'stop' as const, reason: 'enough', by: 'user:alice', handoff: true, deferred: false };
    updateAttempt(ctx, held.attempt.id, { stopRequested: { ...stop, at: ctx.now() } });
    clock.advance(7 * 60_000);
    resumeAttempt(ctx, { attemptId: held.attempt.id, cause: 'restore', prompt: 'continue' });
    expect(getAttempt(ctx, held.attempt.id).stopRequested).toEqual({ ...stop, at: ctx.now() });
  });
});

describe('the resume log', () => {
  test('records runner_restart and lead_exit resumes, which recentResumes counts in a window', () => {
    const { ctx, clock, held } = setup();
    const resume = (cause: 'runner_restart' | 'lead_exit' | 'review') =>
      resumeAttempt(ctx, { attemptId: held.attempt.id, cause, prompt: 'continue' });
    resume('runner_restart');
    clock.advance(10 * 60_000);
    resume('lead_exit');
    resume('review');
    clock.advance(10 * 60_000);
    resume('runner_restart');
    const hour = 60 * 60_000;
    expect(recentResumes(ctx, held.attempt.id, 'runner_restart', hour)).toBe(2);
    expect(recentResumes(ctx, held.attempt.id, 'lead_exit', hour)).toBe(1);
    expect(recentResumes(ctx, held.attempt.id, 'runner_restart', 15 * 60_000)).toBe(1);
    clock.advance(hour);
    expect(recentResumes(ctx, held.attempt.id, 'runner_restart', hour)).toBe(0);
    const { resume_log: log } = ctx.db.query('SELECT resume_log FROM attempts WHERE id = $id').get({
      id: held.attempt.id,
    }) as { resume_log: string };
    expect(JSON.parse(log).map((entry: { cause: string }) => entry.cause)).toEqual([
      'runner_restart',
      'lead_exit',
      'runner_restart',
    ]);
  });

  test("a holding lead's resume on its next delivery counts as a lead exit, as one in a turn does", () => {
    const { ctx } = createTestContext();
    const runnerId = addRunner(ctx);
    const { attempt } = startRunnerAttempt(ctx, { runnerId, taskId: null, role: 'lead', vendor: 'claude' });
    // Exited in a turn: resumed at once.
    updateAttempt(ctx, attempt.id, { status: 'holding', leaseExpiresAt: null });
    resumeAttempt(ctx, { attemptId: attempt.id, cause: 'lead_exit', prompt: 'You exited; continue.' });
    // Exited while idle: resumed when its next message is delivered.
    updateAttempt(ctx, attempt.id, { status: 'holding', leaseExpiresAt: null });
    resumeAttempt(ctx, { attemptId: attempt.id, cause: 'lead_exit', prompt: 'You have new messages.' });
    expect(recentResumes(ctx, attempt.id, 'lead_exit', ctx.config.leadExitWindowMs)).toBe(2);
  });
});

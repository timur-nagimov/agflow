import { describe, expect, test } from 'bun:test';
import { PROTOCOL_VERSION, type SubmissionCheck } from '@agflow/core';
import { updateAttempt } from '../src/attempt-store';
import { pendingCommands, recordResult } from '../src/commands';
import { type HubContext, tx } from '../src/context';
import { reachDeadline } from '../src/deadline';
import { listEvents } from '../src/events';
import { queueMerges } from '../src/merges';
import { listMessages } from '../src/messages';
import { getProject, setDeadline, setPaused } from '../src/project';
import { runTick } from '../src/scheduler';
import { getTask, move } from '../src/task-store';
import { acceptTask, createTasks, markMerged } from '../src/tasks';
import { addRunner, addRunnerAttempt, createTestContext, markHubAlive, newTask } from './helpers';

const HOUR = 60 * 60_000;
const sha = (char: string) => char.repeat(40);
const command = 'bash scripts/check.sh';
const passed: SubmissionCheck = { status: 'passed', command, durationMs: 58_000, tail: '12 pass' };
const failed: SubmissionCheck = { ...passed, status: 'failed', tail: '1 fail' };

/** A hub with auto merge and a runner of this release, which checks and merges main; the deadline in an hour. */
function setup(autoMerge = true) {
  const { ctx, clock } = createTestContext({ autoMerge });
  const runner = addRunner(ctx);
  ctx.db.query('UPDATE runners SET protocol = $p WHERE id = $id').run({ p: PROTOCOL_VERSION, id: runner });
  const deadlineAt = ctx.now() + HOUR;
  setDeadline(ctx, deadlineAt, 'user:alice');
  return { ctx, clock, runner, deadlineAt };
}

/** A task merged into main at sha, as merge_task's result would say. */
function merge(ctx: HubContext, at: string): void {
  const [task] = createTasks(ctx, [newTask({ title: `Merge ${at.slice(0, 1)}` })], 'user:alice');
  const id = task?.id as string;
  tx(ctx, (emit) => {
    const claimed = move(ctx, emit, getTask(ctx, id), 'claimed', 'system');
    move(ctx, emit, move(ctx, emit, claimed, 'submitted', 'user:alice'), 'accepted', 'user:alice');
  });
  markMerged(ctx, id, 'user:alice', at);
}

/** The runner answers its pending check of main. */
function answer(ctx: HubContext, runnerId: string, check: SubmissionCheck): void {
  const [row] = pendingCommands(ctx, runnerId, PROTOCOL_VERSION).filter((one) => one.kind === 'check_main');
  if (row?.command.kind !== 'check_main') throw new Error('no check_main is pending');
  recordResult(ctx, runnerId, { commandId: row.id, ok: true, data: { sha: row.command.sha, check } });
}

/** A runner task whose submission was recorded, accepted now: it waits in merging. */
function accept(ctx: HubContext): string {
  const held = addRunnerAttempt(ctx);
  tx(ctx, (emit) => {
    const task = getTask(ctx, held.task.id);
    const submission = {
      summary: 'Done.',
      evidence: [],
      branch: task.branch,
      headSha: sha('e'),
      submittedAt: ctx.now(),
      by: held.agent.id,
      attemptId: held.attempt.id,
      submissionId: null,
    };
    move(ctx, emit, task, 'submitted', `agent:${held.agent.id}`, { changes: { submission } });
  });
  updateAttempt(ctx, held.attempt.id, { status: 'holding', leaseExpiresAt: null });
  acceptTask(ctx, held.task.id, 'user:alice');
  return held.task.id;
}

/** The merges sent and not answered yet. */
const merges = (ctx: HubContext): number => {
  const sent = "SELECT COUNT(*) AS n FROM runner_commands WHERE kind = 'merge_task' AND status = 'pending'";
  return (ctx.db.query(sent).get() as { n: number }).n;
};

const reached = (ctx: HubContext) =>
  listEvents(ctx.db).filter((event) => event.type === 'project.deadline_reached').map((event) => event.data);

const told = (ctx: HubContext, to: string) => listMessages(ctx, { target: to }).map((message) => message.body);

describe('the deadline', () => {
  test('no deadline, or one still ahead, changes nothing', () => {
    const { ctx, clock } = setup();
    clock.advance(HOUR - 1);
    expect(reachDeadline(ctx)).toBe(false);
    setDeadline(ctx, null, 'user:alice');
    clock.advance(10 * HOUR);
    expect(reachDeadline(ctx)).toBe(false);
    expect([getProject(ctx).paused, reached(ctx), told(ctx, 'humans')]).toEqual([false, [], []]);
  });

  test('once it passes, the hub pauses the project once and tells people and the lead where main stands', () => {
    const { ctx, clock, runner, deadlineAt } = setup();
    merge(ctx, sha('a'));
    answer(ctx, runner, passed);
    merge(ctx, sha('b'));
    answer(ctx, runner, failed);
    clock.advance(HOUR);
    expect(reachDeadline(ctx)).toBe(true);
    expect(getProject(ctx).paused).toBe(true);
    expect(reached(ctx)).toEqual([{ deadlineAt }]);
    const paused = listEvents(ctx.db).filter((event) => event.type === 'project.paused');
    expect(paused.map((event) => event.actor)).toEqual(['system']);
    const body = [
      'The deadline, 2026-10-26 13:00 UTC, has passed: agflow paused the project and holds merges into main.',
      'main as agflow last merged it is bbbbbbb; its check failed.',
      'The last main whose check passed is aaaaaaa.',
      'Resume in the web UI goes on: workers start again, and accepted work merges into main.',
    ].join('\n');
    // The newest first: before it, main's failure.
    expect([told(ctx, 'humans')[0], told(ctx, 'lead')[0]]).toEqual([body, body]);
    const before = told(ctx, 'lead').length;
    // It fires once: neither a later tick nor Resume brings it back for the same deadline.
    expect(reachDeadline(ctx)).toBe(false);
    setPaused(ctx, false, 'user:alice');
    clock.advance(HOUR);
    expect(reachDeadline(ctx)).toBe(false);
    expect([getProject(ctx).paused, reached(ctx).length, told(ctx, 'lead').length]).toEqual([false, 1, before]);
  });

  test('a deadline moved later fires again when it passes', () => {
    const { ctx, clock, deadlineAt } = setup();
    clock.advance(HOUR);
    reachDeadline(ctx);
    setPaused(ctx, false, 'user:alice');
    setDeadline(ctx, deadlineAt + HOUR, 'user:alice');
    expect(reachDeadline(ctx)).toBe(false);
    clock.advance(HOUR);
    expect(reachDeadline(ctx)).toBe(true);
    expect(getProject(ctx).paused).toBe(true);
    expect(reached(ctx)).toEqual([{ deadlineAt }, { deadlineAt: deadlineAt + HOUR }]);
  });

  test('the message says what is not known yet, and a project a person paused stays paused', () => {
    const { ctx, clock, runner } = setup();
    clock.advance(HOUR);
    setPaused(ctx, true, 'user:alice');
    reachDeadline(ctx);
    expect(told(ctx, 'lead')[0]).toBe(
      [
        'The deadline, 2026-10-26 13:00 UTC, has passed: the project stays paused, and agflow holds merges into main.',
        'agflow has merged nothing into main.',
        'No check of main has passed yet.',
        'Resume in the web UI goes on: workers start again, and accepted work merges into main.',
      ].join('\n'),
    );
    setPaused(ctx, false, 'user:alice');
    merge(ctx, sha('c'));
    expect(pendingCommands(ctx, runner, PROTOCOL_VERSION).map((row) => row.kind)).toContain('check_main');
    setDeadline(ctx, ctx.now() + 1, 'user:alice');
    clock.advance(1);
    reachDeadline(ctx);
    expect(told(ctx, 'lead')[0]).toContain('main as agflow last merged it is ccccccc; its check has not run yet.');
  });

  test('without AGFLOW_AUTO_MERGE it only pauses', () => {
    const { ctx, clock } = setup(false);
    clock.advance(HOUR);
    expect(reachDeadline(ctx)).toBe(true);
    expect(told(ctx, 'humans')).toEqual([
      'The deadline, 2026-10-26 13:00 UTC, has passed: agflow paused the project. Resume in the web UI goes on.',
    ]);
  });

  test('merges wait while the project is paused past its deadline; Resume or a later deadline lets them go', () => {
    const { ctx, clock, deadlineAt } = setup();
    // Paused by a person before the deadline, accepted work still merges.
    setPaused(ctx, true, 'user:alice');
    accept(ctx);
    expect(merges(ctx)).toBe(1);
    ctx.db.query("UPDATE runner_commands SET status = 'cancelled' WHERE kind = 'merge_task'").run();
    clock.advance(HOUR);
    reachDeadline(ctx);
    const taskId = accept(ctx);
    expect([getTask(ctx, taskId).status, merges(ctx), queueMerges(ctx)]).toEqual(['merging', 0, null]);
    setDeadline(ctx, deadlineAt + HOUR, 'user:alice');
    expect(queueMerges(ctx)?.kind).toBe('merge_task');
    ctx.db.query("UPDATE runner_commands SET status = 'cancelled' WHERE kind = 'merge_task'").run();
    clock.advance(HOUR);
    reachDeadline(ctx);
    expect(queueMerges(ctx)).toBeNull();
    setPaused(ctx, false, 'user:alice');
    expect(queueMerges(ctx)?.kind).toBe('merge_task');
  });

  test('the tick pauses the project at the deadline before its merge queue goes', () => {
    const { ctx, clock } = setup();
    ctx.db.query("UPDATE runners SET state = 'offline'").run();
    const taskId = accept(ctx);
    expect(merges(ctx)).toBe(0);
    clock.advance(HOUR);
    ctx.db.query("UPDATE runners SET state = 'online'").run();
    markHubAlive(ctx);
    runTick(ctx);
    expect([getProject(ctx).paused, getTask(ctx, taskId).status, merges(ctx)]).toEqual([true, 'merging', 0]);
    setPaused(ctx, false, 'user:alice');
    runTick(ctx);
    expect(merges(ctx)).toBe(1);
  });
});

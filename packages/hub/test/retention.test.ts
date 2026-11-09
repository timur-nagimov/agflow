import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lateWorkRef, takeoverRef } from '@agflow/core';
import { appendAttemptLog, attemptLog, getAttempt, updateAttempt } from '../src/attempt-store';
import { endAttempt, recordLateWork } from '../src/attempts';
import { mintAgentToken } from '../src/auth';
import { cancelPendingOfKind, enqueueCommand, findCommand, pendingCommands, recordResult } from '../src/commands';
import { type HubContext, tx } from '../src/context';
import { listEvents } from '../src/events';
import {
  type Every,
  RETENTION,
  recordedRefs,
  runRetention,
  scheduleRefCleanup,
  startHousekeeping,
} from '../src/retention';
import { markRetired } from '../src/runners';
import { onTakenOver, requestTakeover } from '../src/takeover';
import { getTask, writeTask } from '../src/task-store';
import { cancelTask, createTasks } from '../src/tasks';
import { addRunner, addRunnerAttempt, createTestContext, newTask } from './helpers';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const WIP_SHA = 'a'.repeat(40);
const LATE_SHA = 'b'.repeat(40);
const HANDED_SHA = 'c'.repeat(40);
const SUBMITTED_SHA = 'd'.repeat(40);

const deleteRefs = (ctx: HubContext, runnerId: string) =>
  pendingCommands(ctx, runnerId, 1).filter((row) => row.kind === 'delete_refs');
const eventsOf = (ctx: HubContext, type: string) =>
  listEvents(ctx.db, { limit: 1000 }).filter((event) => event.type === type);

describe('retention', () => {
  test('the periods are those of design 6.18', () => {
    expect(RETENTION).toEqual({
      commandPayloadMs: 7 * DAY,
      revokedTokenMs: 30 * DAY,
      decidedApprovalMs: 90 * DAY,
      eventRejectMs: 30 * DAY,
      refCleanupMs: 7 * DAY,
    });
  });

  test('a done, failed or cancelled command loses its payload after 7 days; a pending one keeps it', () => {
    const { ctx, clock } = createTestContext();
    const runnerId = addRunner(ctx);
    const done = enqueueCommand(ctx, runnerId, { kind: 'refresh_vault', taskId: 'T-1', refs: [] });
    const failed = enqueueCommand(ctx, runnerId, { kind: 'refresh_vault', taskId: 'T-2', refs: [] });
    const cancelled = enqueueCommand(ctx, runnerId, { kind: 'cleanup_attempt', attemptId: 'T-3-a1' });
    const pending = enqueueCommand(ctx, runnerId, { kind: 'cleanup_attempt', attemptId: 'T-1-a1' });
    recordResult(ctx, runnerId, { commandId: done.id, ok: true, data: { fetched: 1 } });
    recordResult(ctx, runnerId, { commandId: failed.id, ok: false, error: 'fetch failed' });
    expect(cancelPendingOfKind(ctx, 'T-3-a1', 'cleanup_attempt')).toBe(1);
    clock.advance(7 * DAY - 1);
    expect(runRetention(ctx).payloadsCleared).toBe(0);
    clock.advance(1);
    expect(runRetention(ctx).payloadsCleared).toBe(3);
    // The rows still read, with their results.
    expect(findCommand(ctx, done.id)).toMatchObject({ command: { kind: 'refresh_vault' }, status: 'done' });
    expect(findCommand(ctx, done.id)?.result).toEqual({ ok: true, data: { fetched: 1 } });
    expect(findCommand(ctx, failed.id)).toMatchObject({ command: { kind: 'refresh_vault' }, status: 'failed' });
    expect(findCommand(ctx, cancelled.id)).toMatchObject({ command: { kind: 'cleanup_attempt' }, status: 'cancelled' });
    expect(findCommand(ctx, pending.id)?.command).toEqual({ kind: 'cleanup_attempt', attemptId: 'T-1-a1' });
    expect(runRetention(ctx).payloadsCleared).toBe(0);
  });

  test('revoked agent tokens go after 30 days, live ones stay', () => {
    const { ctx, clock } = createTestContext();
    const ended = addRunnerAttempt(ctx);
    const live = addRunnerAttempt(ctx);
    mintAgentToken(ctx, ended.attempt);
    mintAgentToken(ctx, live.attempt);
    endAttempt(ctx, { attemptId: ended.attempt.id, trigger: 'stop' });
    clock.advance(30 * DAY - 1);
    expect(runRetention(ctx).tokensDeleted).toBe(0);
    clock.advance(1);
    expect(runRetention(ctx).tokensDeleted).toBe(1);
    const left = ctx.db.query('SELECT attempt_id FROM agent_tokens').all() as { attempt_id: string }[];
    expect(left.map((row) => row.attempt_id)).toEqual([live.attempt.id]);
  });

  test('decided approvals go after 90 days, event rejects after 30; pending approvals stay', () => {
    const { ctx, clock } = createTestContext();
    const { attempt, runner, agent, task } = addRunnerAttempt(ctx);
    const insert = ctx.db.query(
      `INSERT INTO approvals (id, attempt_id, fence_epoch, fence_counter, runner_id, owner, task_id, agent_id, kind,
         summary, detail, status, decided_at, created_at, expires_at)
       VALUES ($id, $attemptId, 1, 1, $runnerId, 'alice', $taskId, $agentId, 'command', 'bun install', '{}', $status,
         $decidedAt, $now, $now)`,
    );
    const ids = { attemptId: attempt.id, runnerId: runner.id, taskId: task.id, agentId: agent.id, now: ctx.now() };
    insert.run({ ...ids, id: 'approval-1', status: 'approved', decidedAt: ctx.now() });
    insert.run({ ...ids, id: 'approval-2', status: 'pending', decidedAt: null });
    ctx.db
      .query(
        `INSERT INTO runner_event_rejects (runner_id, outbox_epoch, seq, type, error, raw, at)
         VALUES ($runnerId, 'outbox-1', 7, 'attempt.wip', 'invalid', '{}', $now)`,
      )
      .run({ runnerId: runner.id, now: ctx.now() });
    clock.advance(30 * DAY - 1);
    expect(runRetention(ctx)).toMatchObject({ rejectsDeleted: 0, approvalsDeleted: 0 });
    clock.advance(1);
    expect(runRetention(ctx)).toMatchObject({ rejectsDeleted: 1, approvalsDeleted: 0 });
    clock.advance(60 * DAY - 1);
    expect(runRetention(ctx).approvalsDeleted).toBe(0);
    clock.advance(1);
    expect(runRetention(ctx).approvalsDeleted).toBe(1);
    const left = ctx.db.query('SELECT id FROM approvals').all() as { id: string }[];
    expect(left.map((row) => row.id)).toEqual(['approval-2']);
  });

  test('each attempt keeps its newest 500 log rows', () => {
    const { ctx } = createTestContext();
    const long = addRunnerAttempt(ctx);
    const short = addRunnerAttempt(ctx);
    for (let n = 1; n <= 520; n++) appendAttemptLog(ctx, long.attempt.id, 'note', `row ${n}`);
    appendAttemptLog(ctx, short.attempt.id, 'note', 'only row');
    runRetention(ctx);
    const rows = (attemptId: string) => attemptLog(ctx, attemptId).map((entry) => entry.summary);
    const kept = rows(long.attempt.id);
    expect(kept).toHaveLength(500);
    expect([kept[0], kept.at(-1)]).toEqual(['row 21', 'row 520']);
    expect(rows(short.attempt.id)).toEqual(['only row']);
  });
});

/**
 * Task T-1 cancelled after its attempt pushed a WIP, a late-work ref and a clone hand-back, and alice took it over:
 * the hub knows her take-over ref, which was never handed back from, so no sha is recorded for it.
 */
function closedTask() {
  const { ctx, clock } = createTestContext();
  const held = addRunnerAttempt(ctx);
  const { attempt, runner, task } = held;
  const prefix = ctx.config.wipRefPrefix;
  const late = lateWorkRef(prefix, attempt.id, 1);
  const handed = lateWorkRef(prefix, attempt.id, 2);
  tx(ctx, (emit) => {
    const work = { attemptId: attempt.id, taskId: task.id, ref: late, sha: LATE_SHA, runnerId: runner.id };
    recordLateWork(ctx, emit, attempt, work);
    emit({
      type: 'task.handed_back',
      actor: 'user:alice',
      subject: task.id,
      data: { attemptId: attempt.id, source: 'clone', ref: handed, sha: HANDED_SHA },
    });
  });
  requestTakeover(ctx, task.id, 'alice');
  const commands = { local: null, anywhere: `git fetch origin ${takeoverRef(prefix, task.id, 'alice')}` };
  tx(ctx, () => onTakenOver(ctx, getAttempt(ctx, attempt.id), { commands, wipSha: WIP_SHA, error: null }));
  cancelTask(ctx, task.id, 'not needed', 'user:alice');
  const refs = [
    { ref: attempt.wipRef as string, expectedSha: WIP_SHA },
    { ref: late, expectedSha: LATE_SHA },
    { ref: handed, expectedSha: HANDED_SHA },
  ];
  return { ctx, clock, held, refs, unrecorded: takeoverRef(prefix, task.id, 'alice') };
}

describe('ref cleanup', () => {
  test('7 days after the task closed, its last runner gets delete_refs for the refs with a recorded sha', () => {
    const { ctx, clock, held, refs, unrecorded } = closedTask();
    clock.advance(7 * DAY - 1);
    expect(scheduleRefCleanup(ctx)).toBe(0);
    clock.advance(1);
    expect(runRetention(ctx).refCleanups).toBe(1);
    const [command] = deleteRefs(ctx, held.runner.id);
    expect(command?.command).toEqual({ kind: 'delete_refs', refs });
    // The take-over ref nobody handed back from has no recorded sha, so it stays.
    expect(getAttempt(ctx, held.attempt.id).takeover?.ref).toBe(unrecorded);
    expect(recordedRefs(ctx, held.task.id).map((target) => target.ref)).not.toContain(unrecorded);
    // While it is pending, the next run sends no other.
    clock.advance(DAY);
    expect(scheduleRefCleanup(ctx)).toBe(0);
  });

  test('merged and failed tasks too; open tasks and tasks with nothing recorded get none', () => {
    const { ctx, clock } = createTestContext();
    const merged = addRunnerAttempt(ctx);
    const failed = addRunnerAttempt(ctx);
    const open = addRunnerAttempt(ctx);
    const [plain] = createTasks(ctx, [newTask({ title: 'No runner' })], 'user:alice');
    for (const held of [merged, failed, open]) updateAttempt(ctx, held.attempt.id, { wipSha: WIP_SHA });
    for (const [held, status] of [
      [merged, 'merged'],
      [failed, 'failed'],
    ] as const) {
      endAttempt(ctx, { attemptId: held.attempt.id, trigger: 'stop' });
      tx(ctx, (emit) => {
        writeTask(ctx, held.task.id, { status });
        emit({ type: `task.${status}`, actor: 'user:alice', subject: held.task.id, data: { from: 'merging' } });
      });
    }
    cancelTask(ctx, plain?.id as string, 'not needed', 'user:alice');
    clock.advance(7 * DAY);
    expect(scheduleRefCleanup(ctx)).toBe(2);
    for (const held of [merged, failed]) {
      expect(deleteRefs(ctx, held.runner.id).map((row) => row.command)).toEqual([
        { kind: 'delete_refs', refs: [{ ref: held.attempt.wipRef as string, expectedSha: WIP_SHA }] },
      ]);
    }
    expect(deleteRefs(ctx, open.runner.id)).toEqual([]);
  });

  test('a late-work ref pushed at the submitted head is deleted too', () => {
    const { ctx, clock } = createTestContext();
    const { attempt, runner, task } = addRunnerAttempt(ctx);
    updateAttempt(ctx, attempt.id, { wipSha: WIP_SHA, submittedSha: SUBMITTED_SHA });
    endAttempt(ctx, { attemptId: attempt.id, trigger: 'stop' });
    // The process was still alive, so its final work went to a late-work ref, at the head its submission recorded.
    const late = lateWorkRef(ctx.config.wipRefPrefix, attempt.id, 1);
    tx(ctx, (emit) => {
      const work = { attemptId: attempt.id, taskId: task.id, ref: late, sha: SUBMITTED_SHA, runnerId: runner.id };
      recordLateWork(ctx, emit, getAttempt(ctx, attempt.id), work);
      writeTask(ctx, task.id, { status: 'merged' });
      emit({ type: 'task.merged', actor: 'user:alice', subject: task.id, data: { from: 'merging' } });
    });
    const refs = [
      { ref: attempt.wipRef as string, expectedSha: WIP_SHA },
      { ref: late, expectedSha: SUBMITTED_SHA },
    ];
    expect(recordedRefs(ctx, task.id)).toEqual(refs);
    clock.advance(7 * DAY);
    expect(scheduleRefCleanup(ctx)).toBe(1);
    expect(deleteRefs(ctx, runner.id).map((row) => row.command)).toEqual([{ kind: 'delete_refs', refs }]);
  });

  test("the last attempt's runner gets it before another online runner", () => {
    const { ctx, clock } = createTestContext();
    // R-1 comes first among the online runners, but the task's last attempt ran on R-2.
    const first = addRunner(ctx);
    const held = addRunnerAttempt(ctx);
    expect([first, held.runner.id]).toEqual(['R-1', 'R-2']);
    updateAttempt(ctx, held.attempt.id, { wipSha: WIP_SHA });
    endAttempt(ctx, { attemptId: held.attempt.id, trigger: 'stop' });
    cancelTask(ctx, held.task.id, 'not needed', 'user:alice');
    clock.advance(7 * DAY);
    expect(scheduleRefCleanup(ctx)).toBe(1);
    expect(deleteRefs(ctx, held.runner.id)).toHaveLength(1);
    expect(deleteRefs(ctx, first)).toEqual([]);
  });

  test('one pending on a runner that was retired or went offline moves to an online runner', () => {
    const { ctx, clock, held, refs } = closedTask();
    const other = addRunner(ctx);
    const third = addRunner(ctx);
    const setState = (id: string, state: string) =>
      ctx.db.query('UPDATE runners SET state = $state WHERE id = $id').run({ id, state });
    clock.advance(7 * DAY);
    expect(scheduleRefCleanup(ctx)).toBe(1);
    const [stuck] = deleteRefs(ctx, held.runner.id);
    // Its runner is retired before it answers: it can never answer now.
    tx(ctx, (emit) => markRetired(ctx, emit, held.runner.id, 'user:alice'));
    setState(third, 'offline');
    clock.advance(DAY);
    expect(scheduleRefCleanup(ctx)).toBe(1);
    expect(findCommand(ctx, stuck?.id as string)?.status).toBe('cancelled');
    const [moved] = deleteRefs(ctx, other);
    expect(moved?.command).toEqual({ kind: 'delete_refs', refs });
    // That runner goes offline without answering, and the one left online takes it the next day.
    setState(other, 'offline');
    setState(third, 'online');
    clock.advance(DAY);
    expect(scheduleRefCleanup(ctx)).toBe(1);
    expect(findCommand(ctx, moved?.id as string)?.status).toBe('cancelled');
    const [last] = deleteRefs(ctx, third);
    // A late answer to a cancelled one is ignored; the one that is answered records task.refs_deleted once.
    expect(recordResult(ctx, other, { commandId: moved?.id as string, ok: true })).toBeNull();
    recordResult(ctx, third, { commandId: last?.id as string, ok: true });
    expect(eventsOf(ctx, 'task.refs_deleted').map((event) => event.actor)).toEqual([`runner:${third}`]);
    clock.advance(DAY);
    expect(scheduleRefCleanup(ctx)).toBe(0);
  });

  test('another online runner takes it when the last one is offline; with none online it waits', () => {
    const { ctx, clock, held } = closedTask();
    const other = addRunner(ctx);
    const setState = (id: string, state: string) =>
      ctx.db.query('UPDATE runners SET state = $state WHERE id = $id').run({ id, state });
    setState(held.runner.id, 'offline');
    setState(other, 'offline');
    clock.advance(7 * DAY);
    expect(scheduleRefCleanup(ctx)).toBe(0);
    setState(other, 'online');
    expect(scheduleRefCleanup(ctx)).toBe(1);
    expect(deleteRefs(ctx, other)).toHaveLength(1);
    expect(deleteRefs(ctx, held.runner.id)).toEqual([]);
  });

  test('a successful result records task.refs_deleted and ends the retries; a failed one is retried daily', () => {
    const { ctx, clock, held, refs } = closedTask();
    const runnerId = held.runner.id;
    clock.advance(7 * DAY);
    scheduleRefCleanup(ctx);
    const failed = deleteRefs(ctx, runnerId)[0];
    recordResult(ctx, runnerId, { commandId: failed?.id as string, ok: false, error: 'push failed' });
    expect(eventsOf(ctx, 'task.refs_deleted')).toEqual([]);
    clock.advance(DAY);
    expect(scheduleRefCleanup(ctx)).toBe(1);
    const retry = deleteRefs(ctx, runnerId)[0];
    recordResult(ctx, runnerId, { commandId: retry?.id as string, ok: true });
    const deleted = eventsOf(ctx, 'task.refs_deleted');
    expect(deleted.map((event) => [event.subject, event.actor, event.data])).toEqual([
      [held.task.id, `runner:${runnerId}`, { taskId: held.task.id, runnerId, refs: refs.map((target) => target.ref) }],
    ]);
    clock.advance(DAY);
    expect(scheduleRefCleanup(ctx)).toBe(0);
    expect(getTask(ctx, held.task.id).status).toBe('cancelled');
  });
});

describe('the housekeeping timer', () => {
  /** A timer the test fires by hand. */
  function manualTimer() {
    const timers: { ms: number; run: () => void }[] = [];
    const every: Every = (ms, run) => {
      const timer = { ms, run };
      timers.push(timer);
      return () => {
        timers.splice(timers.indexOf(timer), 1);
      };
    };
    return { every, timers };
  }

  test('runs outside the tick: hourly snapshots from an hour after start, the daily one, retention once a day', () => {
    const { ctx, clock } = closedTask();
    const dir = mkdtempSync(join(tmpdir(), 'agflow-housekeeping-'));
    const { every, timers } = manualTimer();
    const stop = startHousekeeping(ctx, dir, every);
    // Nothing at start: the start snapshot is main's, and the first run comes an hour later.
    expect(timers.map((timer) => timer.ms)).toEqual([HOUR]);
    expect(readdirSync(dir)).toEqual([]);
    clock.advance(7 * DAY);
    timers[0]?.run();
    const snapshots = () => readdirSync(dir).sort();
    expect(snapshots()).toEqual(['agflow-daily-2026-11-02.db', 'agflow-hourly-2026-11-02T12.db']);
    expect(pendingCommands(ctx, 'R-1', 1).filter((row) => row.kind === 'delete_refs')).toHaveLength(1);
    // Retention waits a day for its next run; the snapshots keep coming every hour.
    ctx.db.query("UPDATE runner_commands SET status = 'failed' WHERE kind = 'delete_refs'").run();
    clock.advance(HOUR);
    timers[0]?.run();
    expect(snapshots()).toContain('agflow-hourly-2026-11-02T13.db');
    expect(pendingCommands(ctx, 'R-1', 1).filter((row) => row.kind === 'delete_refs')).toHaveLength(0);
    clock.advance(DAY - HOUR);
    timers[0]?.run();
    expect(pendingCommands(ctx, 'R-1', 1).filter((row) => row.kind === 'delete_refs')).toHaveLength(1);
    expect(snapshots()).toContain('agflow-daily-2026-11-03.db');
    stop();
    expect(timers).toEqual([]);
  });
});

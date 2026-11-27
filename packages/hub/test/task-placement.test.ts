import { describe, expect, test } from 'bun:test';
import { listAttempts, updateAttempt } from '../src/attempt-store';
import { endAttempt, requestStop, resumeAttempt, startRunnerAttempt } from '../src/attempts';
import { replaceQuotaWaits, runTick, workerLoad } from '../src/scheduler';
import { setDegraded } from '../src/runners';
import { getTask } from '../src/task-store';
import { createTasks, updateTask } from '../src/tasks';
import { addRunner, createTestContext, markHubAlive, newTask } from './helpers';

function setup() {
  const made = createTestContext({ maxWorkers: 6 });
  made.ctx.db.run('UPDATE project SET runner_leads = 0 WHERE id = 1');
  const r1 = addRunner(made.ctx, { vendors: ['claude', 'codex'] });
  const r2 = addRunner(made.ctx, { vendors: ['claude', 'codex'] });
  return { ...made, r1, r2 };
}

describe('task placement constraints', () => {
  test('waits for the required host without consuming attempts, then starts there', () => {
    const { ctx, r1, r2 } = setup();
    const [task] = createTasks(ctx, [newTask({ placement: { runnerIds: [r1] } })], 'user:alice');
    ctx.db.query("UPDATE runners SET state = 'offline' WHERE id = ?").run(r1);
    for (let i = 0; i < 3; i++) expect(runTick(ctx).started).toHaveLength(0);
    expect(getTask(ctx, task!.id).status).toBe('ready');
    expect(listAttempts(ctx, { task: task!.id })).toHaveLength(0);
    expect(workerLoad(ctx)).toMatchObject({ ready: 1, dispatchable: 0 });
    expect(() => startRunnerAttempt(ctx, { taskId: task!.id, runnerId: r2, role: 'worker', vendor: 'claude' }))
      .toThrow('runner_constraint');
    ctx.db.query("UPDATE runners SET state = 'online' WHERE id = ?").run(r1);
    expect(runTick(ctx).started.map((a) => a.runnerId)).toEqual([r1]);
    expect(getTask(ctx, task!.id).placement).toEqual({ runnerIds: [r1] });
  });

  test('serializes a resource group on each host, not across independent hosts, including the same tick', () => {
    const { ctx } = setup();
    const tasks = createTasks(ctx, Array.from({ length: 3 }, () => newTask({ placement: { resourceGroup: 'heavy-check' } })), 'user:alice');
    const started = runTick(ctx).started;
    expect(started).toHaveLength(2);
    expect(new Set(started.map((a) => a.runnerId)).size).toBe(2);
    expect(getTask(ctx, tasks[2]!.id).status).toBe('ready');
    expect(runTick(ctx).started).toHaveLength(0);
    // Asking for a stop does not release the host prematurely.
    requestStop(ctx, { attemptId: started[0]!.id, cause: 'cancel', reason: 'done', by: 'user:alice' });
    expect(runTick(ctx).started).toHaveLength(0);
    endAttempt(ctx, { attemptId: started[0]!.id, trigger: 'cancel' });
    expect(runTick(ctx).started.map((a) => a.taskId)).toEqual([tasks[2]!.id]);
  });

  test('multiple registrations of one physical machine share the reservation; other work still runs', () => {
    const { ctx, r1, r2 } = setup();
    ctx.db.query('UPDATE runners SET machine_id = (SELECT machine_id FROM runners WHERE id = ?) WHERE id = ?').run(r1, r2);
    const tasks = createTasks(ctx, [
      newTask({ placement: { runnerIds: [r1], resourceGroup: 'heavy-check' } }),
      newTask({ placement: { runnerIds: [r2], resourceGroup: 'heavy-check' } }),
      newTask({ title: 'Unrelated light work' }),
    ], 'user:alice');
    expect(runTick(ctx).started.map((a) => a.taskId)).toEqual([tasks[0]!.id, tasks[2]!.id]);
    expect(getTask(ctx, tasks[1]!.id).status).toBe('ready');
    expect(() => startRunnerAttempt(ctx, { taskId: tasks[1]!.id, runnerId: r2, role: 'worker', vendor: 'claude' }))
      .toThrow('resource_busy');
  });

  test('mandatory vendor never falls back, including a zero quota ceiling; soft hints still do', () => {
    const { ctx, clock } = setup();
    // Same deployed case: Claude is installed but explicitly disabled by its owner.
    ctx.db.run(`UPDATE runners SET info = json_set(info, '$.ceilings.claude', json('{"fiveHour":0,"weekly":0}'))`);
    const [hard, soft] = createTasks(ctx, [
      newTask({ placement: { vendor: 'claude' } }),
      newTask({ vendorHint: 'claude' }),
    ], 'user:alice');
    expect(runTick(ctx).started).toHaveLength(0);
    clock.advance(61_000);
    markHubAlive(ctx);
    ctx.db.query('UPDATE runners SET last_seen_at = ?').run(ctx.now());
    expect(runTick(ctx).started.map((a) => [a.taskId, a.vendor])).toEqual([[soft!.id, 'codex']]);
    expect(getTask(ctx, hard!.id).status).toBe('ready');
    expect(listAttempts(ctx, { task: hard!.id })).toHaveLength(0);
  });

  test('placement can be patched/cleared before start, but cannot drop an open reservation', () => {
    const { ctx, r1 } = setup();
    const [task] = createTasks(ctx, [newTask()], 'user:alice');
    expect(updateTask(ctx, task!.id, { placement: { runnerIds: [r1] } }, 'user:alice').placement).toEqual({ runnerIds: [r1] });
    expect(updateTask(ctx, task!.id, { placement: null }, 'user:alice').placement).toBeNull();
    updateTask(ctx, task!.id, { placement: { resourceGroup: 'heavy-check' } }, 'user:alice');
    const [attempt] = runTick(ctx).started;
    expect(() => updateTask(ctx, task!.id, { placement: null }, 'user:alice')).toThrow('placement cannot change');
    // Holding and quota waits can resume; their resource must stay reserved meanwhile.
    for (const status of ['holding', 'quota_wait'] as const) {
      updateAttempt(ctx, attempt!.id, { status });
      createTasks(ctx, [newTask({ placement: { runnerIds: [attempt!.runnerId!], resourceGroup: 'heavy-check' } })], 'user:alice');
      expect(runTick(ctx).started).toHaveLength(0);
      expect(() => updateTask(ctx, task!.id, { placement: null }, 'user:alice')).toThrow('placement cannot change');
    }
    expect(resumeAttempt(ctx, { attemptId: attempt!.id, actor: 'system', cause: 'runner_restart', prompt: 'Continue' }).attempt.status).toBe('starting');
  });
});


test('quota replacement can reuse its own host reservation but never violates a mandatory vendor', () => {
  for (const mandatory of [false, true]) {
    const { ctx, r1 } = setup();
    const [task] = createTasks(ctx, [newTask({ placement: {
      runnerIds: [r1], resourceGroup: 'heavy-check', ...(mandatory ? { vendor: 'claude' as const } : {}),
    } })], 'user:alice');
    const { attempt } = startRunnerAttempt(ctx, { runnerId: r1, taskId: task!.id, role: 'worker', vendor: 'claude' });
    updateAttempt(ctx, attempt.id, { status: 'quota_wait', quotaResetsAt: ctx.now() + 24 * 60 * 60_000 });
    setDegraded(ctx, r1, 'claude');
    expect(replaceQuotaWaits(ctx)).toEqual(mandatory ? [] : [attempt.id]);
  }
});

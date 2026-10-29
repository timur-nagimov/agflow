import { describe, expect, test } from 'bun:test';
import { listEvents } from '../src/events';
import { updateGoal } from '../src/goal';
import { listMessages } from '../src/messages';
import {
  acceptTask,
  cancelTask,
  claimTask,
  createTasks,
  getTask,
  listTasks,
  submitTask,
  unblockTask,
  updateTask,
} from '../src/tasks';
import { addAgent, createTestContext, newTask } from './helpers';

describe('creating tasks', () => {
  test('a task without dependencies is ready and records the goal version', () => {
    const { ctx } = createTestContext();
    updateGoal(ctx, { text: 'goal', baseVersion: 0 }, 'user:alice');
    const [task] = createTasks(ctx, [newTask({ title: 'First' })], 'user:alice');
    expect(task).toMatchObject({ id: 'T-1', status: 'ready', goalVersion: 1, createdBy: 'user:alice', title: 'First' });
  });

  test('batch references resolve to earlier tasks and unmet dependencies block', () => {
    const { ctx } = createTestContext();
    const [a, b] = createTasks(ctx, [newTask({ title: 'A' }), newTask({ title: 'B', dependsOn: ['#1'] })], 'agent:A-1');
    expect(b.dependsOn).toEqual([a.id]);
    expect(b).toMatchObject({ status: 'blocked', blockedKind: 'deps', blockedReason: 'waiting on T-1' });
  });

  test('bad references are rejected and nothing is created', () => {
    const { ctx } = createTestContext();
    expect(() => createTasks(ctx, [newTask({ dependsOn: ['#1'] })], 'user:alice')).toThrow('earlier task');
    expect(() => createTasks(ctx, [newTask({ dependsOn: ['T-9'] })], 'user:alice')).toThrow('unknown task T-9');
    expect(listTasks(ctx)).toEqual([]);
  });

  test('the open-task guard refuses creation and tells people once', () => {
    const { ctx } = createTestContext({ maxOpenTasks: 2 });
    createTasks(ctx, [newTask(), newTask()], 'agent:A-1');
    expect(() => createTasks(ctx, [newTask()], 'agent:A-1')).toThrow('open tasks');
    expect(() => createTasks(ctx, [newTask()], 'agent:A-1')).toThrow('open tasks');
    expect(listEvents(ctx.db).filter((event) => event.type === 'guard.tripped')).toHaveLength(2);
    expect(listMessages(ctx, { target: 'humans' })).toHaveLength(1);
  });

  test('the hourly guard counts recent creations only', () => {
    const { ctx, clock } = createTestContext({ maxTasksPerHour: 2 });
    createTasks(ctx, [newTask(), newTask()], 'agent:A-1');
    expect(() => createTasks(ctx, [newTask()], 'agent:A-1')).toThrow('per hour');
    clock.advance(60 * 60_000 + 1);
    expect(createTasks(ctx, [newTask()], 'agent:A-1')).toHaveLength(1);
  });
});

describe('updating and cancelling', () => {
  test('patches merge into the contract', () => {
    const { ctx } = createTestContext();
    const [task] = createTasks(ctx, [newTask({ title: 'Old' })], 'user:alice');
    const updated = updateTask(ctx, task.id, { title: 'New', priority: 1 }, 'user:alice');
    expect(updated).toMatchObject({ title: 'New', priority: 1, objective: task.objective });
  });

  test('the contract keeps the vendor hint until a patch changes it', () => {
    const { ctx } = createTestContext();
    const [hinted, plain] = createTasks(ctx, [newTask({ title: 'A', vendorHint: 'codex' }), newTask({ title: 'B' })], 'user:alice');
    expect(hinted.vendorHint).toBe('codex');
    expect(plain.vendorHint).toBeUndefined();
    expect(updateTask(ctx, hinted.id, { title: 'A2', priority: 1 }, 'user:alice').vendorHint).toBe('codex');
    expect(updateTask(ctx, hinted.id, { vendorHint: null }, 'user:alice').vendorHint).toBeNull();
    expect(updateTask(ctx, plain.id, { vendorHint: 'claude' }, 'user:alice').vendorHint).toBe('claude');
    expect(getTask(ctx, plain.id).vendorHint).toBe('claude');
  });

  test("the holder is not told about a new vendor hint: it steers only the scheduler's next placement", () => {
    const { ctx } = createTestContext();
    const agent = addAgent(ctx);
    const [task] = createTasks(ctx, [newTask({ title: 'Parser' })], 'user:alice');
    claimTask(ctx, task.id, agent);
    updateTask(ctx, task.id, { vendorHint: 'codex' }, 'user:alice');
    expect(listMessages(ctx, { target: `agent:${agent.id}` })).toEqual([]);
    updateTask(ctx, task.id, { vendorHint: 'claude', title: 'JSON parser' }, 'user:alice');
    const notices = listMessages(ctx, { target: `agent:${agent.id}` });
    expect(notices.map((notice) => notice.body.split('\n')[0])).toEqual([
      `user:alice amended ${task.id}, which you hold. Changed: title.`,
    ]);
    expect(getTask(ctx, task.id).vendorHint).toBe('claude');
  });

  test('adding an unmet dependency blocks a ready task, removing it unblocks', () => {
    const { ctx } = createTestContext();
    const [a, b] = createTasks(ctx, [newTask({ title: 'A' }), newTask({ title: 'B' })], 'user:alice');
    expect(updateTask(ctx, b.id, { dependsOn: [a.id] }, 'user:alice').status).toBe('blocked');
    expect(updateTask(ctx, b.id, { dependsOn: [] }, 'user:alice').status).toBe('ready');
  });

  test('dependency cycles are refused', () => {
    const { ctx } = createTestContext();
    const [a, b] = createTasks(ctx, [newTask({ title: 'A' }), newTask({ title: 'B', dependsOn: ['#1'] })], 'user:alice');
    expect(() => updateTask(ctx, a.id, { dependsOn: [b.id] }, 'user:alice')).toThrow('cycle');
    expect(() => updateTask(ctx, a.id, { dependsOn: [a.id] }, 'user:alice')).toThrow('cycle');
  });

  test('cancelling records the reason, and cancelled tasks cannot change', () => {
    const { ctx } = createTestContext();
    const [task] = createTasks(ctx, [newTask()], 'user:alice');
    expect(cancelTask(ctx, task.id, 'not needed', 'user:alice').status).toBe('cancelled');
    expect(listEvents(ctx.db, { subject: task.id }).at(-1)?.data).toMatchObject({ reason: 'not needed' });
    expect(() => updateTask(ctx, task.id, { title: 'x' }, 'user:alice')).toThrow('can no longer change');
    expect(getTask(ctx, task.id).status).toBe('cancelled');
  });

  test('cancelling a blocked task clears why it was blocked', () => {
    const { ctx } = createTestContext();
    const [, b] = createTasks(ctx, [newTask({ title: 'A' }), newTask({ title: 'B', dependsOn: ['#1'] })], 'user:alice');
    expect(cancelTask(ctx, b.id, 'not needed', 'user:alice')).toMatchObject({
      status: 'cancelled',
      blockedKind: null,
      blockedReason: null,
    });
  });

  test('cancelling a task asks the lead to decide on the open tasks that depend on it', () => {
    const { ctx } = createTestContext();
    const agent = addAgent(ctx);
    const [a, b, c, d] = createTasks(
      ctx,
      [
        newTask({ title: 'API' }),
        newTask({ title: 'Client', dependsOn: ['#1'] }),
        newTask({ title: 'Docs' }),
        newTask({ title: 'Old client', dependsOn: ['#1'] }),
      ],
      'user:alice',
    );
    claimTask(ctx, c.id, agent);
    updateTask(ctx, c.id, { dependsOn: [a.id] }, 'user:alice');
    // Nothing depends on d, and once cancelled d is not open, so neither cancel below lists it.
    cancelTask(ctx, d.id, 'Superseded.', 'user:alice');
    expect(listMessages(ctx, { target: 'lead' })).toEqual([]);
    cancelTask(ctx, a.id, 'Replaced by the vendor SDK.', 'user:alice');
    expect(getTask(ctx, b.id)).toMatchObject({
      status: 'blocked',
      blockedKind: 'deps',
      blockedReason: `${a.id} was cancelled; amend or cancel this task`,
    });
    expect(getTask(ctx, c.id)).toMatchObject({ status: 'claimed', blockedReason: null });
    const notices = listMessages(ctx, { target: 'lead' });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ from: 'system', taskId: a.id });
    expect(notices[0]?.body).toBe(
      [
        `${a.id} ("API") was cancelled by user:alice.`,
        'user:alice wrote:',
        '> Replaced by the vendor SDK.',
        'These open tasks depend on it:',
        `- ${b.id} ("Client") [blocked]`,
        `- ${c.id} ("Docs") [claimed]`,
        'Decide for each: amend its dependencies with update_task, or cancel it with cancel_task.',
      ].join('\n'),
    );
  });

  test('a task whose dependency was cancelled stays blocked until it is amended', () => {
    const { ctx } = createTestContext();
    const agent = addAgent(ctx);
    const [a, b, c] = createTasks(
      ctx,
      [newTask({ title: 'A' }), newTask({ title: 'B' }), newTask({ title: 'C', dependsOn: ['#1', '#2'] })],
      'user:alice',
    );
    cancelTask(ctx, a.id, 'Not needed.', 'user:alice');
    const reason = `${a.id} was cancelled; amend or cancel this task`;
    expect(getTask(ctx, c.id).blockedReason).toBe(reason);
    // Neither accepting the other dependency nor unblocking hides the reason, and new dependents get it too.
    claimTask(ctx, b.id, agent);
    submitTask(ctx, b.id, agent, { summary: 'Done.', evidence: [] });
    acceptTask(ctx, b.id, 'user:alice');
    expect(getTask(ctx, c.id)).toMatchObject({ status: 'blocked', blockedReason: reason });
    expect(unblockTask(ctx, c.id, 'user:alice')).toMatchObject({ status: 'blocked', blockedReason: reason });
    const [late] = createTasks(ctx, [newTask({ title: 'Late', dependsOn: [a.id] })], 'user:alice');
    expect(late.blockedReason).toBe(reason);
    expect(updateTask(ctx, c.id, { dependsOn: [b.id] }, 'user:alice').status).toBe('ready');
  });
});

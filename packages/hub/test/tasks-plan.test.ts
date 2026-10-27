import { describe, expect, test } from 'bun:test';
import { listEvents } from '../src/events';
import { updateGoal } from '../src/goal';
import { listMessages } from '../src/messages';
import { cancelTask, createTasks, getTask, listTasks, updateTask } from '../src/tasks';
import { createTestContext, newTask } from './helpers';

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
});

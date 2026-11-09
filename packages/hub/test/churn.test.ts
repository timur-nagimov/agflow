import { describe, expect, test } from 'bun:test';
import { listEvents } from '../src/events';
import { churnPaused, getHubState } from '../src/hub-state';
import { listMessages } from '../src/messages';
import { runTick } from '../src/scheduler';
import { cancelTask, createTasks, updateTask } from '../src/tasks';
import { addRunner, createTestContext, markHubAlive, newTask } from './helpers';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const LEAD = 'agent:A-1';

/** A hub whose churn budget is 3 agent calls per hour. */
function churnContext(overrides: Parameters<typeof createTestContext>[0] = {}) {
  return createTestContext({ maxPlanChangesPerHour: 3, ...overrides });
}

type Ctx = ReturnType<typeof churnContext>['ctx'];

const eventsOf = (ctx: Ctx, type: string) => listEvents(ctx.db, { limit: 1000 }).filter((event) => event.type === type);
const toPeople = (ctx: Ctx) => listMessages(ctx, {}).filter((message) => message.to === 'humans');

describe('the churn budget', () => {
  test('each agent call counts once, whatever the number of tasks; people do not count', () => {
    const { ctx } = churnContext({ maxPlanChangesPerHour: 60 });
    const created = createTasks(ctx, [newTask({ title: 'One' }), newTask({ title: 'Two' })], LEAD);
    const ids = created.map((task) => task.id);
    updateTask(ctx, ids[0] as string, { priority: 1 }, LEAD);
    cancelTask(ctx, ids[1] as string, 'not needed', LEAD);
    createTasks(ctx, [newTask({ title: 'By a person' })], 'user:alice');
    updateTask(ctx, ids[0] as string, { priority: 2 }, 'user:alice');
    expect(eventsOf(ctx, 'guard.plan_change').map((event) => [event.actor, event.subject, event.data])).toEqual([
      [LEAD, null, { agentId: 'A-1', call: 'create_tasks', taskIds: ids, count: 1 }],
      [LEAD, null, { agentId: 'A-1', call: 'update_task', taskIds: [ids[0]], count: 2 }],
      [LEAD, null, { agentId: 'A-1', call: 'cancel_task', taskIds: [ids[1]], count: 3 }],
    ]);
  });

  test('a refused call does not count', () => {
    const { ctx } = churnContext();
    const [task] = createTasks(ctx, [newTask()], 'user:alice');
    expect(() => updateTask(ctx, task?.id as string, { dependsOn: ['T-99'] }, LEAD)).toThrow();
    expect(eventsOf(ctx, 'guard.plan_change')).toEqual([]);
  });

  test('reaching the budget pauses dispatch until the oldest call leaves the hour, telling people once', () => {
    const { ctx, clock } = churnContext();
    const first = ctx.now();
    createTasks(ctx, [newTask({ title: 'One' })], LEAD);
    clock.advance(10 * MINUTE);
    createTasks(ctx, [newTask({ title: 'Two' })], 'agent:A-2');
    expect(churnPaused(ctx)).toBe(false);
    clock.advance(10 * MINUTE);
    createTasks(ctx, [newTask({ title: 'Three' })], LEAD);
    expect(getHubState(ctx).dispatchPausedUntil).toBe(first + HOUR);
    expect(churnPaused(ctx)).toBe(true);
    expect(eventsOf(ctx, 'guard.dispatch_paused').map((event) => event.data)).toEqual([
      { agentId: 'A-1', until: first + HOUR, count: 3 },
    ]);
    const told = toPeople(ctx);
    expect(told).toHaveLength(1);
    expect(told[0]?.body).toContain('paused worker dispatch');
    // A further call while paused counts too and moves the end of the pause, but people are not told again.
    clock.advance(5 * MINUTE);
    createTasks(ctx, [newTask({ title: 'Four' })], LEAD);
    expect(getHubState(ctx).dispatchPausedUntil).toBe(first + 10 * MINUTE + HOUR);
    expect(toPeople(ctx)).toHaveLength(1);
    clock.advance(45 * MINUTE - 1);
    expect(churnPaused(ctx)).toBe(true);
    clock.advance(1);
    expect(ctx.now()).toBe(first + 10 * MINUTE + HOUR);
    expect(churnPaused(ctx)).toBe(false);
  });

  test('a pause after an earlier one ended tells people again', () => {
    const { ctx, clock } = churnContext({ maxPlanChangesPerHour: 1 });
    createTasks(ctx, [newTask({ title: 'One' })], LEAD);
    clock.advance(HOUR);
    expect(churnPaused(ctx)).toBe(false);
    createTasks(ctx, [newTask({ title: 'Two' })], LEAD);
    expect(toPeople(ctx)).toHaveLength(2);
  });

  test('meanwhile the tick starts no workers but fills the lead seat', () => {
    const { ctx, clock } = churnContext();
    const runnerId = addRunner(ctx);
    for (const title of ['One', 'Two', 'Three']) createTasks(ctx, [newTask({ title })], LEAD);
    expect(churnPaused(ctx)).toBe(true);
    const paused = runTick(ctx);
    expect(paused.started).toEqual([]);
    expect(paused.lead).toMatchObject({ role: 'lead', runnerId });
    clock.advance(HOUR);
    markHubAlive(ctx);
    expect(runTick(ctx).started.map((attempt) => attempt.taskId)).toEqual(['T-1']);
  });

  test('the M1 creation limits still apply', () => {
    const { ctx } = churnContext({ maxPlanChangesPerHour: 60, maxTasksPerHour: 2 });
    createTasks(ctx, [newTask({ title: 'One' }), newTask({ title: 'Two' })], LEAD);
    expect(() => createTasks(ctx, [newTask({ title: 'Three' })], LEAD)).toThrow(
      expect.objectContaining({ status: 409 }),
    );
    expect(eventsOf(ctx, 'guard.tripped')).toHaveLength(1);
    expect(eventsOf(ctx, 'guard.plan_change')).toHaveLength(1);
  });
});

import { describe, expect, test } from 'bun:test';
import { TEST_ACCOUNT_ID } from '@agflow/core';
import { type HubConfig, type HubContext, tx } from '../src/context';
import { listEvents } from '../src/events';
import { updateGoal } from '../src/goal';
import { updateHubState } from '../src/hub-state';
import { listMessages } from '../src/messages';
import { setDeadline, setPaused } from '../src/project';
import { upsertAccountQuota } from '../src/quota';
import { resetProject } from '../src/reset';
import { nudgeIdleLead, runTick, workerLoad } from '../src/scheduler';
import { createTasks } from '../src/tasks';
import { addAgent, addRunner, addRunnerLead, createTestContext, markHubAlive, newTask } from './helpers';

const MINUTE = 60_000;

/** The first goal, which the lead plans from. */
const setGoal = (ctx: HubContext) => updateGoal(ctx, { text: 'Ship the parser.', baseVersion: 0 }, 'user:alice');

/**
 * A runner lead holding the seat on R-1, whose one slot its runner worker fills (a lead takes no slot), and R-2 with
 * two free slots: two free worker slots and no ready task, with a goal set.
 */
function idleProject(overrides: Partial<HubConfig> = {}) {
  const { ctx, clock } = createTestContext(overrides);
  const lead = addRunnerLead(ctx);
  ctx.db.run("UPDATE runners SET capacity = 1 WHERE id = 'R-1'");
  addRunner(ctx);
  setGoal(ctx);
  return { ctx, clock, lead };
}

/** The idle nudges among the messages to the lead. */
const nudgeMessages = (ctx: HubContext) =>
  listMessages(ctx, { target: 'lead' }).filter((message) => message.body.includes('worker slot(s) are free'));

/** Ready tasks the scheduler may start, by the lead. */
function ready(ctx: HubContext, count: number): void {
  createTasks(
    ctx,
    Array.from({ length: count }, (_, n) => newTask({ title: `Task ${n}` })),
    'user:alice',
  );
}

const nudges = (ctx: HubContext) => listEvents(ctx.db).filter((event) => event.type === 'lead.idle_nudged');

describe('the idle nudge', () => {
  test('fires once free slots have outnumbered the dispatchable tasks for idleNudgeMs, with the numbers in it', () => {
    const { ctx, clock } = idleProject();
    tx(ctx, (emit) =>
      upsertAccountQuota(ctx, emit, {
        owner: 'alice',
        runnerId: 'R-2',
        report: {
          vendor: 'claude',
          accountId: TEST_ACCOUNT_ID,
          quota: {
            state: 'ok',
            resetsAt: ctx.now() + 3 * 60 * MINUTE,
            windows: { fiveHour: 0.4, weekly: 0.12 },
            paidUsage: 'disabled',
            updatedAt: ctx.now(),
          },
        },
      }),
    );
    const deadlineAt = ctx.now() + 5 * 60 * MINUTE + 20 * MINUTE;
    setDeadline(ctx, deadlineAt, 'user:alice');
    expect(workerLoad(ctx)).toMatchObject({ running: 1, freeSlots: 2, ready: 0, dispatchable: 0 });
    // The first idle reading starts the clock.
    expect(nudgeIdleLead(ctx)).toBeNull();
    clock.advance(ctx.config.idleNudgeMs - 1);
    expect(nudgeIdleLead(ctx)).toBeNull();
    clock.advance(1);
    const message = nudgeIdleLead(ctx);
    expect(message).toMatchObject({ from: 'system', to: 'lead' });
    expect(message?.body).toStartWith(
      [
        '2 worker slot(s) are free, more than the 0 ready task(s) that can start now.',
        'Workers: 1 running (target 4, cap 4); 2 free worker slot(s).',
        'Ready tasks: 0, 0 of them dispatchable now. Blocked on dependencies: 0. Submitted: 0. Accepted, not merged: 0.',
        'Quota:',
        '- alice claude: ok, 5-hour 40%, weekly 12%, resets 2026-10-26 15:00 UTC',
        'Deadline: 2026-10-26 17:20 UTC, 5 h 19 min left.',
        '',
        'Plan the next batch now, so that ready, independent tasks are at least twice the free worker slots.',
      ].join('\n'),
    );
    for (const part of [
      // While the skeleton runs, the tasks waiting for it are planned already.
      'Tasks blocked on dependencies count as planned: while they wait for work in progress, such as the skeleton, add ' +
        'only tasks that need none of it.',
      'Work through SPEC.md (or the goal) until every requirement is covered.',
      'defects found by the latest demo check or reported by agents, missing tests, demo polish, then new features a jury would notice',
      'In the last hour before the deadline, plan only fixes.',
    ]) {
      expect(message?.body).toContain(part);
    }
    expect(nudges(ctx).map((event) => [event.actor, event.data])).toEqual([
      [
        'system',
        {
          running: 1,
          target: null,
          cap: 4,
          freeSlots: 2,
          ready: 0,
          dispatchable: 0,
          blockedOnDependencies: 0,
          submitted: 0,
          acceptedNotMerged: 0,
          deadlineAt,
        },
      ],
    ]);
  });

  test('not again within idleNudgeIntervalMs; the next comes once it has passed', () => {
    const { ctx, clock } = idleProject();
    nudgeIdleLead(ctx);
    clock.advance(ctx.config.idleNudgeMs);
    expect(nudgeIdleLead(ctx)).not.toBeNull();
    clock.advance(ctx.config.idleNudgeIntervalMs - 1);
    expect(nudgeIdleLead(ctx)).toBeNull();
    clock.advance(1);
    expect(nudgeIdleLead(ctx)?.body).toContain('Deadline: no deadline.');
    expect(nudges(ctx)).toHaveLength(2);
  });

  test('none while the dispatchable ready tasks cover the free slots; the clock starts once they do not', () => {
    const { ctx, clock } = idleProject();
    ready(ctx, 2);
    expect(workerLoad(ctx)).toMatchObject({ freeSlots: 2, ready: 2, dispatchable: 2 });
    expect(nudgeIdleLead(ctx)).toBeNull();
    clock.advance(ctx.config.idleNudgeIntervalMs);
    expect(nudgeIdleLead(ctx)).toBeNull();
    // A third worker would fit no runner: the free slots of the runners bound the cap.
    ready(ctx, 1);
    expect(workerLoad(ctx)).toMatchObject({ freeSlots: 2, dispatchable: 3 });
    expect(nudgeIdleLead(ctx)).toBeNull();
    // With one of them cancelled the slots outnumber the tasks again, and the clock starts from there.
    ctx.db.run("UPDATE tasks SET status = 'cancelled' WHERE id IN ('T-2', 'T-3')");
    expect(workerLoad(ctx)).toMatchObject({ freeSlots: 2, dispatchable: 1 });
    expect(nudgeIdleLead(ctx)).toBeNull();
    clock.advance(ctx.config.idleNudgeMs);
    expect(nudgeIdleLead(ctx)?.body).toStartWith('2 worker slot(s) are free, more than the 1 ready task(s)');
  });

  test('none with the duty off, AGFLOW_IDLE_NUDGE_MINUTES 0', () => {
    const { ctx, clock } = idleProject({ idleNudgeIntervalMs: 0 });
    for (let tick = 0; tick < 10; tick++) {
      expect(nudgeIdleLead(ctx)).toBeNull();
      clock.advance(ctx.config.idleNudgeMs);
    }
    expect(nudges(ctx)).toEqual([]);
  });

  test('none without a runner lead in the seat: with the seat empty, or a live lead in it', () => {
    const { ctx, clock } = createTestContext();
    addRunner(ctx);
    setGoal(ctx);
    expect(workerLoad(ctx).freeSlots).toBe(2);
    nudgeIdleLead(ctx);
    clock.advance(ctx.config.idleNudgeIntervalMs);
    expect(nudgeIdleLead(ctx)).toBeNull();
    addAgent(ctx, 'alice', 'lead');
    nudgeIdleLead(ctx);
    clock.advance(ctx.config.idleNudgeIntervalMs);
    expect(nudgeIdleLead(ctx)).toBeNull();
    expect(nudges(ctx)).toEqual([]);
    expect(nudgeMessages(ctx)).toEqual([]);
  });

  test('none before the goal is set: there is nothing to plan yet', () => {
    const { ctx, clock } = createTestContext();
    addRunnerLead(ctx);
    ctx.db.run("UPDATE runners SET capacity = 1 WHERE id = 'R-1'");
    addRunner(ctx);
    expect(workerLoad(ctx)).toMatchObject({ freeSlots: 2, dispatchable: 0 });
    for (let tick = 0; tick < 3; tick++) {
      expect(nudgeIdleLead(ctx)).toBeNull();
      clock.advance(ctx.config.idleNudgeIntervalMs);
    }
    expect(nudges(ctx)).toEqual([]);
    expect(listMessages(ctx, { target: 'lead' })).toEqual([]);
    // The clock starts once the goal is set.
    setGoal(ctx);
    expect(nudgeIdleLead(ctx)).toBeNull();
    clock.advance(ctx.config.idleNudgeMs);
    expect(nudgeIdleLead(ctx)).not.toBeNull();
  });

  test('none while the project is paused or the churn guard holds dispatch: neither starts a worker', () => {
    const { ctx, clock } = idleProject();
    setPaused(ctx, true, 'user:alice');
    nudgeIdleLead(ctx);
    clock.advance(ctx.config.idleNudgeMs);
    expect(nudgeIdleLead(ctx)).toBeNull();
    setPaused(ctx, false, 'user:alice');
    updateHubState(ctx, { dispatchPausedUntil: ctx.now() + 10 * MINUTE });
    nudgeIdleLead(ctx);
    clock.advance(ctx.config.idleNudgeMs);
    expect(nudgeIdleLead(ctx)).toBeNull();
    expect(nudges(ctx)).toEqual([]);
  });

  test('none once the deadline has passed: the work is planned until then', () => {
    const { ctx, clock } = idleProject();
    setDeadline(ctx, ctx.now() + 30_000, 'user:alice');
    nudgeIdleLead(ctx);
    clock.advance(ctx.config.idleNudgeMs);
    expect(nudgeIdleLead(ctx)).toBeNull();
    // A later deadline brings it back.
    setDeadline(ctx, ctx.now() + 60 * MINUTE, 'user:alice');
    nudgeIdleLead(ctx);
    clock.advance(ctx.config.idleNudgeMs);
    expect(nudgeIdleLead(ctx)?.body).toContain('59 min left.');
  });

  test("a project reset starts the idle clock afresh: the old project's idle time does not count", () => {
    const { ctx, clock } = idleProject();
    nudgeIdleLead(ctx);
    clock.advance(ctx.config.idleNudgeMs);
    const next = { name: 'next', repo: 'https://github.com/acme/next', deadlineAt: null, goal: 'Ship it.', rules: [] };
    resetProject(ctx, next, 'user:alice');
    // Even with a runner lead in the seat before any tick, the new project waits idleNudgeMs of its own.
    addRunnerLead(ctx);
    expect(nudgeIdleLead(ctx)).toBeNull();
    clock.advance(ctx.config.idleNudgeMs);
    expect(nudgeIdleLead(ctx)).not.toBeNull();
  });

  test('the tick runs it in its reconcile step', () => {
    const { ctx, clock } = idleProject();
    expect(runTick(ctx).reconciled?.idleNudge).toBe(false);
    clock.advance(ctx.config.idleNudgeMs);
    markHubAlive(ctx);
    expect(runTick(ctx).reconciled?.idleNudge).toBe(true);
    expect(nudgeMessages(ctx)).toHaveLength(1);
  });
});

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
import {
  addAgent,
  addRunner,
  addRunnerAttempt,
  addRunnerLead,
  createTestContext,
  markHubAlive,
  newTask,
} from './helpers';

const MINUTE = 60_000;

/** The first goal, which the lead plans from. */
const setGoal = (ctx: HubContext) => updateGoal(ctx, { text: 'Ship the parser.', baseVersion: 0 }, 'user:alice');

/**
 * A runner lead holding the seat on R-1, whose one slot its runner worker fills (a lead takes no slot), and R-2 with
 * two free slots: three worker slots, one running and two free, and no ready task, with a goal set.
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
  listMessages(ctx, { target: 'lead' }).filter((message) => message.body.includes('ready task(s) can start now'));

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
  test('fires once the startable tasks have been fewer than the worker slots for idleNudgeMs, with the numbers', () => {
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
        'Only 0 ready task(s) can start now, fewer than the 3 worker slot(s) (1 running, 2 free).',
        'Workers: 1 running (target 4, cap 4); 2 free worker slot(s).',
        'Ready tasks: 0, 0 of them dispatchable now. Blocked on dependencies: 0. Submitted: 0. Accepted, not merged: 0.',
        'Quota:',
        '- alice claude: ok, 5-hour 40%, weekly 12%, resets in 2 h 59 min',
        'Deadline: 2026-10-26 17:20 UTC, 5 h 19 min left.',
        '',
        'Plan the next batch now, so that ready, independent tasks are at least as many as the worker slots, running ' +
          'plus free.',
      ].join('\n'),
    );
    for (const part of [
      // While the skeleton runs, the tasks waiting for it are planned already.
      'Tasks blocked on dependencies count as planned: while they wait for work in progress, such as the skeleton, add ' +
        'only tasks that need none of it.',
      'Work through SPEC.md (or the goal) until every requirement is covered.',
      // The lead guide's order (brief.ts).
      'Once it is, plan in this order: requirements docs/STATUS.md does not show working, defects from the latest ' +
        'demo check and gaps agents named, missing tests, demo polish, then new features a jury would notice.',
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

  test('none while the startable tasks cover the worker slots, busy or free; the clock starts once they do not', () => {
    const { ctx, clock } = idleProject();
    ready(ctx, 3);
    expect(workerLoad(ctx)).toMatchObject({ running: 1, freeSlots: 2, ready: 3, dispatchable: 3 });
    expect(nudgeIdleLead(ctx)).toBeNull();
    clock.advance(ctx.config.idleNudgeIntervalMs);
    expect(nudgeIdleLead(ctx)).toBeNull();
    // A fourth worker would fit no runner: the free slots of the runners bound the cap.
    ready(ctx, 1);
    expect(workerLoad(ctx)).toMatchObject({ freeSlots: 2, dispatchable: 4 });
    expect(nudgeIdleLead(ctx)).toBeNull();
    // With two of them cancelled the slots outnumber the tasks again, and the clock starts from there.
    ctx.db.run("UPDATE tasks SET status = 'cancelled' WHERE id IN ('T-2', 'T-3')");
    expect(workerLoad(ctx)).toMatchObject({ freeSlots: 2, dispatchable: 2 });
    expect(nudgeIdleLead(ctx)).toBeNull();
    clock.advance(ctx.config.idleNudgeMs);
    expect(nudgeIdleLead(ctx)?.body).toStartWith(
      'Only 2 ready task(s) can start now, fewer than the 3 worker slot(s) (1 running, 2 free).',
    );
  });

  test('fires at full load too, while the ready tasks are fewer than the busy slots, and not once they suffice', () => {
    const { ctx, clock } = idleProject();
    // Two more runner workers fill R-2: every slot is busy, and nothing is ready to follow them.
    addRunnerAttempt(ctx, { runnerId: 'R-2' });
    addRunnerAttempt(ctx, { runnerId: 'R-2' });
    expect(workerLoad(ctx)).toMatchObject({ running: 3, freeSlots: 0, dispatchable: 0 });
    expect(nudgeIdleLead(ctx)).toBeNull();
    clock.advance(ctx.config.idleNudgeMs);
    expect(nudgeIdleLead(ctx)?.body).toStartWith(
      'Only 0 ready task(s) can start now, fewer than the 3 worker slot(s) (3 running, 0 free).\n' +
        'Workers: 3 running (target 4, cap 4); 0 free worker slot(s).',
    );
    // A ready task for every busy slot is enough: the clock stops, and nothing more goes out.
    ready(ctx, 3);
    expect(workerLoad(ctx)).toMatchObject({ running: 3, freeSlots: 0, dispatchable: 3 });
    for (let tick = 0; tick < 3; tick++) {
      clock.advance(ctx.config.idleNudgeIntervalMs);
      expect(nudgeIdleLead(ctx)).toBeNull();
    }
    expect(nudges(ctx)).toHaveLength(1);
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

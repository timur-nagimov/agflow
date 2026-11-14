import { describe, expect, test } from 'bun:test';
import { type HubLoad, TEST_ACCOUNT_ID, type Vendor, type VendorQuota } from '@agflow/core';
import { type HubContext, tx } from '../src/context';
import { updateHubState } from '../src/hub-state';
import { setPaused, setWorkerTarget } from '../src/project';
import { upsertAccountQuota } from '../src/quota';
import { Scheduler, idleSlotMinutes, runTick, sampleSlots, withWaitReason } from '../src/scheduler';
import { getTask, move, writeTask } from '../src/task-store';
import { createTasks } from '../src/tasks';
import { addRunner, addRunnerAttempt, createTestContext, newTask } from './helpers';
import { createTestHub } from './http-helpers';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Runner leads off: a lead would take a slot in every tick. */
function noLeads(ctx: HubContext): void {
  ctx.db.run('UPDATE project SET runner_leads = 0 WHERE id = 1');
}

/** Creates a ready task, by alice; returns its id. */
function ready(ctx: HubContext, overrides: Parameters<typeof newTask>[0] = {}): string {
  const [task] = createTasks(ctx, [newTask(overrides)], 'user:alice');
  if (!task) throw new Error('no task');
  return task.id;
}

/** A task moved through claimed and submitted to the status given; returns its id. */
function through(ctx: HubContext, to: 'submitted' | 'accepted' | 'merged'): string {
  const id = ready(ctx);
  tx(ctx, (emit) => {
    let task = move(ctx, emit, getTask(ctx, id), 'claimed', 'system');
    for (const next of ['submitted', 'accepted', 'merged'] as const) {
      task = move(ctx, emit, task, next, 'user:alice');
      if (next === to) break;
    }
  });
  return id;
}

const reasonOf = (ctx: HubContext, id: string) => withWaitReason(ctx, getTask(ctx, id)).waitReason;

function report(ctx: HubContext, runnerId: string, vendor: Vendor, quota: Partial<VendorQuota>): void {
  tx(ctx, (emit) =>
    upsertAccountQuota(ctx, emit, {
      owner: 'alice',
      runnerId,
      report: {
        vendor,
        accountId: TEST_ACCOUNT_ID,
        quota: {
          state: 'ok',
          resetsAt: ctx.now() + HOUR,
          windows: { fiveHour: 0.1, weekly: 0.1 },
          paidUsage: 'disabled',
          updatedAt: ctx.now(),
          ...quota,
        },
      },
    }),
  );
}

describe('why a ready task waits', () => {
  test('the placement, the worker slots and a start each leave their word, kept until the next tick', () => {
    const { ctx } = createTestContext();
    noLeads(ctx);
    const first = ready(ctx, { title: 'First', priority: 1 });
    const second = ready(ctx, { title: 'Second', priority: 2 });
    runTick(ctx);
    expect(reasonOf(ctx, first)).toBe('no runner can take it: none offers a vendor');

    const runnerId = addRunner(ctx);
    setWorkerTarget(ctx, 1);
    runTick(ctx);
    // The first started, so it no longer waits; the second waits for the target.
    expect(getTask(ctx, first).status).toBe('claimed');
    expect(reasonOf(ctx, first)).toBeNull();
    expect(reasonOf(ctx, second)).toBe('it waits for a worker slot: the worker target is 1');

    // A second runner attempt fills the runner.
    setWorkerTarget(ctx, 4);
    addRunnerAttempt(ctx, { runnerId });
    runTick(ctx);
    expect(reasonOf(ctx, second)).toBe(`no runner can take it: ${runnerId} full`);
  });

  test('a ready task out of the ready set says why: here, another task holds its owned paths', () => {
    const { ctx } = createTestContext();
    noLeads(ctx);
    addRunner(ctx);
    const holder = ready(ctx, { title: 'Parser', ownedPaths: ['src/parser/**'] });
    addRunnerAttempt(ctx, { taskId: holder });
    const waiting = ready(ctx, { title: 'Lexer', ownedPaths: ['src/parser/lexer.ts'] });
    runTick(ctx);
    expect(reasonOf(ctx, waiting)).toBe(`its owned paths overlap those of ${holder}`);
  });

  test('a tick that starts no worker says why: a paused project, the churn guard or the recovery window', () => {
    const { ctx, clock } = createTestContext();
    noLeads(ctx);
    addRunner(ctx);
    const id = ready(ctx, { title: 'Held' });
    const backingOff = ready(ctx, { title: 'Backing off' });
    writeTask(ctx, backingOff, { nextDispatchAt: ctx.now() + HOUR });
    setPaused(ctx, true, 'user:alice');
    runTick(ctx);
    expect(reasonOf(ctx, id)).toBe('the project is paused');
    // A task out of the ready set keeps its own reason.
    expect(reasonOf(ctx, backingOff)).toBe('it waits 60 min after an infrastructure failure');

    setPaused(ctx, false, 'user:alice');
    updateHubState(ctx, { dispatchPausedUntil: ctx.now() + 50 * MINUTE });
    runTick(ctx);
    expect(reasonOf(ctx, id)).toBe('the churn guard holds worker dispatch for 50 more min');

    updateHubState(ctx, { dispatchPausedUntil: null });
    // Downtime: the tick opens a recovery window of recoveryMs.
    clock.advance(10 * MINUTE);
    expect(runTick(ctx).recovering).toBe(true);
    expect(reasonOf(ctx, id)).toBe('the hub is recovering after downtime: nothing starts for up to 2 min');
    expect(getTask(ctx, id).status).toBe('ready');
  });

  test('the task API gives each task its reason while it is ready, and null otherwise', async () => {
    const hub = createTestHub();
    noLeads(hub.ctx);
    const waiting = ready(hub.ctx, { title: 'Waiting' });
    const done = through(hub.ctx, 'accepted');
    runTick(hub.ctx);
    const web = { user: 'alice', via: 'web' as const };
    const listed = (await hub.call('GET', '/api/tasks', web)).json.tasks as { id: string; waitReason: string | null }[];
    expect(listed.map((task) => [task.id, task.waitReason])).toEqual([
      [waiting, 'no runner can take it: none offers a vendor'],
      [done, null],
    ]);
    const detail = await hub.call('GET', `/api/tasks/${waiting}`, web);
    expect(detail.json.task.waitReason).toBe('no runner can take it: none offers a vendor');
    expect(detail.json.attempts).toEqual([]);
  });
});

describe('the free slot samples', () => {
  test('count each sample until the next one, at most a tick, for the last hour', () => {
    const { ctx, clock } = createTestContext({ tickMs: 15_000 });
    addRunner(ctx);
    expect(idleSlotMinutes(ctx)).toBe(0);
    sampleSlots(ctx);
    clock.advance(15_000);
    sampleSlots(ctx);
    // Two slots free for a tick, twice; a stretch without ticks counts one tick.
    clock.advance(10 * MINUTE);
    expect(idleSlotMinutes(ctx)).toBe(1);
    clock.advance(HOUR);
    expect(idleSlotMinutes(ctx)).toBe(0);
  });

  test("the scheduler's tick takes one", () => {
    const { ctx, clock } = createTestContext({ tickMs: 30_000 });
    noLeads(ctx);
    addRunner(ctx);
    new Scheduler(ctx).tick();
    clock.advance(30_000);
    expect(idleSlotMinutes(ctx)).toBe(1);
  });
});

describe('GET /api/load', () => {
  test('is for a person in the web UI', async () => {
    const hub = createTestHub();
    expect((await hub.call('GET', '/api/load')).status).toBe(401);
    expect((await hub.call('GET', '/api/load', { user: 'alice', via: 'cli' })).status).toBe(403);
    expect((await hub.call('GET', '/api/load', { user: 'alice', via: 'web' })).status).toBe(200);
  });

  test("gives the project's numbers", async () => {
    const hub = createTestHub();
    const { ctx, clock } = hub;
    noLeads(ctx);
    // Merged two hours ago: outside the last hour.
    through(ctx, 'merged');
    clock.advance(2 * HOUR);
    const runnerId = addRunner(ctx, { vendors: ['claude', 'codex'] });
    addRunnerAttempt(ctx, { runnerId });
    setWorkerTarget(ctx, 3);
    const open = ready(ctx, { title: 'Open' });
    const backingOff = ready(ctx, { title: 'Backing off' });
    writeTask(ctx, backingOff, { nextDispatchAt: ctx.now() + HOUR });
    ready(ctx, { title: 'Waits', dependsOn: [open] });
    through(ctx, 'submitted');
    through(ctx, 'accepted');
    through(ctx, 'merged');
    clock.advance(10 * MINUTE);
    ctx.db.run(`UPDATE project SET deadline_at = ${ctx.now() + 5 * HOUR} WHERE id = 1`);

    const load = (await hub.call('GET', '/api/load', { user: 'alice', via: 'web' })).json as HubLoad;
    expect(load.now).toBe(ctx.now());
    expect(load.project).toEqual({
      workers: { running: 1, target: 3, cap: 4 },
      slots: { capacity: 2, busy: 1, idle: 1 },
      idleSlotMinutes: 0,
      tasks: {
        ready: 2,
        dispatchable: 1,
        blockedOnDependencies: 1,
        submitted: { count: 1, oldestAgeMs: 10 * MINUTE },
        acceptedNotMerged: { count: 1, oldestAgeMs: 10 * MINUTE },
        mergedLastHour: 1,
      },
      deadline: { at: ctx.now() + 5 * HOUR, leftMs: 5 * HOUR },
    });
  });

  test('counts no ready task as able to start while the scheduler holds dispatch', async () => {
    const hub = createTestHub();
    const { ctx } = hub;
    noLeads(ctx);
    addRunner(ctx);
    ready(ctx);
    const tasks = async () =>
      ((await hub.call('GET', '/api/load', { user: 'alice', via: 'web' })).json as HubLoad).project.tasks;
    expect(await tasks()).toMatchObject({ ready: 1, dispatchable: 1 });
    setPaused(ctx, true, 'user:alice');
    expect(await tasks()).toMatchObject({ ready: 1, dispatchable: 0 });
    setPaused(ctx, false, 'user:alice');
    updateHubState(ctx, { dispatchPausedUntil: ctx.now() + HOUR });
    expect(await tasks()).toMatchObject({ ready: 1, dispatchable: 0 });
    updateHubState(ctx, { dispatchPausedUntil: null, recoveryUntil: ctx.now() + MINUTE });
    expect(await tasks()).toMatchObject({ ready: 1, dispatchable: 0 });
  });

  test('gives one row per account, with its slots, its windows against the ceilings and its state', async () => {
    const hub = createTestHub();
    const { ctx } = hub;
    noLeads(ctx);
    const alice = addRunner(ctx, { vendors: ['claude', 'codex'] });
    addRunnerAttempt(ctx, { runnerId: alice, vendor: 'codex' });
    report(ctx, alice, 'claude', { windows: { fiveHour: 0.5, weekly: 0.9 } });
    report(ctx, alice, 'codex', { state: 'exhausted', resetsAt: ctx.now() + 30 * MINUTE });
    // Bob's runners on one account: one full, one offline and one draining. As in the project's slots, the last two
    // count no slots, taken or free, though each still has an attempt open.
    const away = addRunner(ctx, { owner: 'bob' });
    addRunnerAttempt(ctx, { runnerId: away, owner: 'bob' });
    ctx.db.run(`UPDATE runners SET state = 'offline' WHERE id = '${away}'`);
    const busy = addRunner(ctx, { owner: 'bob' });
    addRunnerAttempt(ctx, { runnerId: busy, owner: 'bob' });
    addRunnerAttempt(ctx, { runnerId: busy, owner: 'bob' });
    const drained = addRunner(ctx, { owner: 'bob' });
    addRunnerAttempt(ctx, { runnerId: drained, owner: 'bob' });
    ctx.db.run(`UPDATE runners SET draining = 1 WHERE id = '${drained}'`);

    const load = (await hub.call('GET', '/api/load', { user: 'alice', via: 'web' })).json as HubLoad;
    const ceilings = { fiveHour: 0.85, weekly: 0.85 };
    expect(load.accounts).toEqual([
      {
        owner: 'alice',
        vendor: 'claude',
        accountId: TEST_ACCOUNT_ID,
        plan: 'test mode',
        busy: 0,
        capacity: 2,
        fiveHour: 0.5,
        weekly: 0.9,
        ceilings,
        resetsAt: ctx.now() + HOUR,
        state: 'ceiling',
      },
      {
        owner: 'alice',
        vendor: 'codex',
        accountId: TEST_ACCOUNT_ID,
        plan: 'test mode',
        busy: 1,
        capacity: 2,
        fiveHour: 0.1,
        weekly: 0.1,
        ceilings,
        resetsAt: ctx.now() + 30 * MINUTE,
        state: 'exhausted',
      },
      {
        owner: 'bob',
        vendor: 'claude',
        accountId: TEST_ACCOUNT_ID,
        plan: 'test mode',
        busy: 2,
        capacity: 2,
        fiveHour: null,
        weekly: null,
        ceilings,
        resetsAt: null,
        state: 'full',
      },
    ]);
  });
});

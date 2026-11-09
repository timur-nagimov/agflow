import { describe, expect, spyOn, test } from 'bun:test';
import { TEST_ACCOUNT_ID, type Vendor, type VendorQuota } from '@agflow/core';
import { endAttempt, startRunnerAttempt } from '../src/attempts';
import { pendingCommands } from '../src/commands';
import { type HubContext, tx } from '../src/context';
import { listMessages } from '../src/messages';
import { getProject, getStaffing, setPaused, setWorkerTarget } from '../src/project';
import { clearOwnerAway, setOwnerAway, upsertAccountQuota } from '../src/quota';
import { recordHeartbeatInfo, recordStartRefusal } from '../src/runners';
import { requestAgents, runTick } from '../src/scheduler';
import { getTask, writeTask } from '../src/task-store';
import { claimTask, createTasks } from '../src/tasks';
import { addAgent, addRunner, addRunnerAttempt, createTestContext, newTask } from './helpers';
import { createTestHub } from './http-helpers';

const MINUTE = 60_000;

type NewTaskInput = Parameters<typeof newTask>[0];

/** Creates ready tasks, by alice; returns their ids. */
function tasks(ctx: HubContext, ...inputs: NewTaskInput[]): string[] {
  return createTasks(ctx, inputs.map((input) => newTask(input)), 'user:alice').map((task) => task.id);
}

/** The tick's started attempts as [task, runner, vendor]. */
const tick = (ctx: HubContext) =>
  runTick(ctx).started.map((attempt) => [attempt.taskId, attempt.runnerId, attempt.vendor]);

const statusOf = (ctx: HubContext, taskId: string) => getTask(ctx, taskId).status;

function exhaust(ctx: HubContext, vendor: Vendor, quota: Partial<VendorQuota>): void {
  tx(ctx, (emit) =>
    upsertAccountQuota(ctx, emit, {
      owner: 'alice',
      runnerId: 'R-1',
      report: {
        vendor,
        accountId: TEST_ACCOUNT_ID,
        quota: {
          state: 'exhausted',
          resetsAt: null,
          windows: { fiveHour: 1, weekly: 0.5 },
          paidUsage: 'disabled',
          updatedAt: ctx.now(),
          ...quota,
        },
      },
    }),
  );
}

const leadMessages = (ctx: HubContext) => listMessages(ctx, {}).filter((message) => message.to === 'lead');

describe('dispatch', () => {
  test('a ready task with a free slot and a usable runner gets an attempt, by priority then age', () => {
    const { ctx, clock } = createTestContext();
    const runnerId = addRunner(ctx);
    const [older] = tasks(ctx, { title: 'Older', priority: 5 });
    clock.advance(1_000);
    const [urgent, newer] = tasks(ctx, { title: 'Urgent', priority: 1 }, { title: 'Newer', priority: 5 });
    // The runner has two slots.
    expect(tick(ctx)).toEqual([
      [urgent, runnerId, 'claude'],
      [older, runnerId, 'claude'],
    ]);
    expect([statusOf(ctx, urgent as string), statusOf(ctx, older as string), statusOf(ctx, newer as string)]).toEqual([
      'claimed',
      'claimed',
      'ready',
    ]);
    const starts = pendingCommands(ctx, runnerId, 1).filter((row) => row.command.kind === 'start_attempt');
    expect(starts).toHaveLength(2);
    // Full now: nothing more until a slot frees.
    expect(tick(ctx)).toEqual([]);
  });

  test('one failing start does not roll back the others', () => {
    const { ctx } = createTestContext();
    addRunner(ctx);
    const [first, second] = tasks(ctx, { title: 'First', priority: 1 }, { title: 'Second', priority: 2 });
    ctx.db.run(
      `CREATE TEMP TRIGGER refuse_first BEFORE INSERT ON attempts WHEN NEW.task_id = '${first}'
       BEGIN SELECT RAISE(ABORT, 'refused for the test'); END`,
    );
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(tick(ctx).map(([taskId]) => taskId)).toEqual([second]);
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
    expect(getTask(ctx, first as string)).toMatchObject({ status: 'ready', assignee: null, currentAttempt: null });
    expect(ctx.db.query('SELECT COUNT(*) AS n FROM agents').get()).toEqual({ n: 1 });
    expect(statusOf(ctx, second as string)).toBe('claimed');
  });

  test('a task whose paths overlap one started in the same tick waits for the next', () => {
    const { ctx } = createTestContext();
    const runnerId = addRunner(ctx);
    const [first, second] = tasks(
      ctx,
      { title: 'Dir', priority: 1, ownedPaths: ['src/a'] },
      { title: 'File', priority: 2, ownedPaths: ['src/a/b.ts'] },
    );
    // The runner has two slots, and neither task held its paths when the tick began.
    expect(tick(ctx)).toEqual([[first, runnerId, 'claude']]);
    expect(statusOf(ctx, second as string)).toBe('ready');
    // Now the first holds them, so the next tick does not start the second either.
    expect(tick(ctx)).toEqual([]);
  });

  test("request_agents' vendor steers placement until vendorPrefMs has passed", () => {
    const { ctx, clock } = createTestContext();
    const runnerId = addRunner(ctx, { vendors: ['claude', 'codex'] });
    const [first, second] = tasks(ctx, { title: 'First', priority: 1 }, { title: 'Second', priority: 2 });
    requestAgents(ctx, { count: 1, vendor: 'codex' });
    expect(tick(ctx)).toEqual([[first, runnerId, 'codex']]);
    // Expired, the preference no longer counts: Claude wins the tie.
    clock.advance(ctx.config.vendorPrefMs);
    requestAgents(ctx, { count: 2 });
    expect(tick(ctx)).toEqual([[second, runnerId, 'claude']]);
  });

  test('workers stay below maxWorkers; leads and live chats do not count', () => {
    const { ctx } = createTestContext({ maxWorkers: 1 });
    const runnerId = addRunner(ctx);
    const other = addRunner(ctx);
    // A runner lead and a live chat's attempt hold no worker slot.
    startRunnerAttempt(ctx, { runnerId: other, taskId: null, role: 'lead', vendor: 'claude' });
    const [live] = tasks(ctx, { title: 'Live' });
    claimTask(ctx, live as string, addAgent(ctx));
    const [a, b] = tasks(ctx, { title: 'A', priority: 1 }, { title: 'B', priority: 2 });
    expect(tick(ctx)).toEqual([[a, runnerId, 'claude']]);
    // R-2 has a slot left, but the workers are at maxWorkers.
    expect(tick(ctx)).toEqual([]);
    expect(statusOf(ctx, b as string)).toBe('ready');
  });

  test('workers stay below worker_target; a target of 0 dispatches nothing without pausing', () => {
    const { ctx } = createTestContext();
    const runnerId = addRunner(ctx);
    const [a, b, c] = tasks(ctx, { title: 'A', priority: 1 }, { title: 'B', priority: 2 }, { title: 'C', priority: 3 });
    tx(ctx, () => setWorkerTarget(ctx, 1));
    expect(tick(ctx)).toEqual([[a, runnerId, 'claude']]);
    expect(tick(ctx)).toEqual([]);
    tx(ctx, () => setWorkerTarget(ctx, 0));
    expect(tick(ctx)).toEqual([]);
    expect(getProject(ctx).paused).toBe(false);
    // Above maxWorkers it is clamped; the runner's two slots hold A and B.
    tx(ctx, () => setWorkerTarget(ctx, 10));
    expect(getStaffing(ctx).workerTarget).toBe(ctx.config.maxWorkers);
    expect(tick(ctx)).toEqual([[b, runnerId, 'claude']]);
    expect(statusOf(ctx, c as string)).toBe('ready');
  });

  test('a paused project dispatches nothing', () => {
    const { ctx } = createTestContext();
    const runnerId = addRunner(ctx);
    const [taskId] = tasks(ctx, { title: 'Parser' });
    setPaused(ctx, true, 'user:alice');
    expect(tick(ctx)).toEqual([]);
    setPaused(ctx, false, 'user:alice');
    expect(tick(ctx)).toEqual([[taskId, runnerId, 'claude']]);
  });

  test('live-chat-only tasks stay ready, and future next_dispatch_at or dispatch_hold_until waits', () => {
    const { ctx, clock } = createTestContext();
    const runnerId = addRunner(ctx);
    const [config] = tasks(ctx, { title: 'Hooks', ownedPaths: ['.claude/settings.json'] });
    const [backoff, hold] = tasks(ctx, { title: 'Backoff' }, { title: 'Hold' });
    writeTask(ctx, backoff as string, { nextDispatchAt: ctx.now() + MINUTE });
    ctx.db.query('UPDATE tasks SET dispatch_hold_until = $until WHERE id = $id').run({
      id: hold as string,
      until: ctx.now() + 2 * MINUTE,
    });
    expect(tick(ctx)).toEqual([]);
    clock.advance(MINUTE);
    expect(tick(ctx)).toEqual([[backoff, runnerId, 'claude']]);
    clock.advance(MINUTE);
    expect(tick(ctx)).toEqual([[hold, runnerId, 'claude']]);
    expect(statusOf(ctx, config as string)).toBe('ready');
  });

  test('the ladder requirement and vendorHint steer the vendor', () => {
    const { ctx } = createTestContext();
    const runnerId = addRunner(ctx, { vendors: ['claude', 'codex'] });
    // Both vendors are at the same level, so without a hint Claude, first on a tie, would be chosen.
    const [hinted] = tasks(ctx, { title: 'Hinted', priority: 1, vendorHint: 'codex' });
    // A counted Claude failure: ladder step 2 asks for Claude again, whatever the hint says.
    const [laddered] = tasks(ctx, { title: 'Laddered', priority: 2, vendorHint: 'codex' });
    const failed = addRunnerAttempt(ctx, { taskId: laddered, vendor: 'claude' });
    endAttempt(ctx, { attemptId: failed.attempt.id, trigger: 'stall_silent' });
    expect(statusOf(ctx, laddered as string)).toBe('ready');
    expect(tick(ctx)).toEqual([
      [hinted, runnerId, 'codex'],
      [laddered, runnerId, 'claude'],
    ]);
  });

  test('a runner that refused a start gets nothing until its next heartbeat', () => {
    const { ctx } = createTestContext();
    const runnerId = addRunner(ctx);
    const [taskId] = tasks(ctx, { title: 'Parser' });
    recordStartRefusal(ctx, runnerId, 'at_capacity');
    expect(tick(ctx)).toEqual([]);
    recordHeartbeatInfo(ctx, runnerId, {
      power: { source: 'ac', batteryPercent: null, lowPowerMode: false },
      disk: { freeBytes: 100e9, agflowBytes: 0 },
      acceptingUntil: null,
    });
    expect(tick(ctx)).toEqual([[taskId, runnerId, 'claude']]);
  });

  test('a Claude account with an unknown reset gets one probing start, the next waiting while it is open', () => {
    const { ctx, clock } = createTestContext();
    const runnerId = addRunner(ctx);
    const [first, second] = tasks(ctx, { title: 'First', priority: 1 }, { title: 'Second', priority: 2 });
    exhaust(ctx, 'claude', { resetsAt: null });
    expect(tick(ctx)).toEqual([]);
    clock.advance(ctx.config.quotaUnknownMs);
    expect(tick(ctx)).toEqual([[first, runnerId, 'claude']]);
    expect(tick(ctx)).toEqual([]);
    expect(statusOf(ctx, second as string)).toBe('ready');
  });
});

describe('owner away', () => {
  test('an owner_away refusal tells the lead once per away period', () => {
    const { ctx } = createTestContext();
    addRunner(ctx, { vendors: ['codex'] });
    const [taskId] = tasks(ctx, { title: 'Parser' });
    const away = () =>
      tx(ctx, (emit) =>
        setOwnerAway(ctx, emit, { owner: 'alice', vendor: 'codex', accountId: TEST_ACCOUNT_ID, approvalId: 'x' }),
      );
    away();
    expect(tick(ctx)).toEqual([]);
    expect(leadMessages(ctx).map((message) => message.body)).toEqual([
      `alice did not answer an approval in time, so agflow starts no new codex attempts on their runners until they ` +
        `answer an approval or change one of their runners. Ready work that waits on it: ${taskId}. This is the only ` +
        'notice until they are back.',
    ]);
    expect(tick(ctx)).toEqual([]);
    expect(leadMessages(ctx)).toHaveLength(1);

    // Back, then away again: a new period, and one more notice.
    clearOwnerAway(ctx, 'alice');
    away();
    expect(tick(ctx)).toEqual([]);
    expect(leadMessages(ctx)).toHaveLength(2);
    clearOwnerAway(ctx, 'alice');
    expect(tick(ctx).map(([task]) => task)).toEqual([taskId]);
  });
});

describe('POST /api/staffing', () => {
  test('a person sets the clamped target and a vendor preference, and gets { running, target }', async () => {
    const hub = createTestHub();
    addRunnerAttempt(hub.ctx);
    const staff = (body: unknown) => hub.call('POST', '/api/staffing', { user: 'alice', via: 'web', body });
    const many = await staff({ count: 10, reason: 'lots of ready work' });
    expect([many.status, many.json]).toEqual([200, { running: 1, target: hub.ctx.config.maxWorkers }]);
    expect(getStaffing(hub.ctx)).toEqual({ workerTarget: hub.ctx.config.maxWorkers, vendorPref: null });

    const codex = await staff({ count: 2, vendor: 'codex', reason: 'Claude is busy' });
    expect(codex.json).toEqual({ running: 1, target: 2 });
    expect(getStaffing(hub.ctx)).toEqual({
      workerTarget: 2,
      vendorPref: { vendor: 'codex', until: hub.ctx.now() + hub.ctx.config.vendorPrefMs },
    });
    expect((await staff({ count: 0, reason: 'hold on' })).json).toEqual({ running: 1, target: 0 });
    expect((await staff({ count: -1, reason: 'no' })).status).toBe(400);
  });

  test('the seat holder may call it; other agents and CLI tokens may not', async () => {
    const hub = createTestHub();
    const lead = await hub.liveAgent('alice', 'session-lead', 'lead');
    const worker = await hub.liveAgent('bob', 'session-worker');
    const body = { count: 3, reason: 'two more' };
    expect((await hub.call('POST', '/api/staffing', { user: 'alice', agent: lead, body })).json).toEqual({
      running: 0,
      target: 3,
    });
    expect((await hub.call('POST', '/api/staffing', { user: 'bob', agent: worker, body })).status).toBe(403);
    expect((await hub.call('POST', '/api/staffing', { user: 'alice', body })).status).toBe(403);
    expect(getStaffing(hub.ctx).workerTarget).toBe(3);
  });
});

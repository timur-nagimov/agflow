import { describe, expect, spyOn, test } from 'bun:test';
import { type AttemptFacts, type RawRunnerEvent, TEST_ACCOUNT_ID, type Vendor, type VendorQuota } from '@agflow/core';
import { getAttempt, updateAttempt } from '../src/attempt-store';
import { endAttempt, requestStop, startRunnerAttempt } from '../src/attempts';
import { pendingCommands } from '../src/commands';
import { type HubContext, tx } from '../src/context';
import { applyRunnerEvents } from '../src/events-in';
import { listMessages } from '../src/messages';
import { seatHolderId } from '../src/hub-state';
import { getProject, getStaffing, setPaused, setWorkerTarget } from '../src/project';
import { clearOwnerAway, setOwnerAway, upsertAccountQuota } from '../src/quota';
import { recordHeartbeatInfo, recordStartRefusal } from '../src/runners';
import { Scheduler, replaceQuotaWaits, requestAgents, runTick } from '../src/scheduler';
import { startHub } from '../src/server';
import { requestSubmission } from '../src/submissions';
import { getTask, writeTask } from '../src/task-store';
import { blockTask, claimTask, createTasks, releaseTask, unblockTask } from '../src/tasks';
import { addAgent, addRunner, addRunnerAttempt, addRunnerLead, createTestContext, newTask } from './helpers';
import { createTestHub } from './http-helpers';

const MINUTE = 60_000;

/**
 * A test context with runner leads off: a runner lead would take a runner slot in every tick, and the lead seat is
 * lead-runner.test.ts's to test.
 */
function schedulerContext(overrides: Parameters<typeof createTestContext>[0] = {}) {
  const made = createTestContext(overrides);
  made.ctx.db.run('UPDATE project SET runner_leads = 0 WHERE id = 1');
  return made;
}

type NewTaskInput = Parameters<typeof newTask>[0];

/** Creates ready tasks, by alice; returns their ids. */
function tasks(ctx: HubContext, ...inputs: NewTaskInput[]): string[] {
  return createTasks(ctx, inputs.map((input) => newTask(input)), 'user:alice').map((task) => task.id);
}

/** The tick's started attempts as [task, runner, vendor]. */
const tick = (ctx: HubContext) =>
  runTick(ctx).started.map((attempt) => [attempt.taskId, attempt.runnerId, attempt.vendor]);

const statusOf = (ctx: HubContext, taskId: string) => getTask(ctx, taskId).status;

/** Reports the vendor's account exhausted, by default alice's on R-1. */
function exhaust(
  ctx: HubContext,
  vendor: Vendor,
  quota: Partial<VendorQuota>,
  where: { owner: string; runnerId: string } = { owner: 'alice', runnerId: 'R-1' },
): void {
  tx(ctx, (emit) =>
    upsertAccountQuota(ctx, emit, {
      ...where,
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

/** Heartbeat facts of a running attempt that fire no stall rule. */
function factsOf(attemptId: string): AttemptFacts {
  return {
    attemptId,
    fence: { epoch: 1, counter: 1 },
    phase: 'turn',
    eventAgeMs: 5_000,
    tool: null,
    fsAgeMs: 20_000,
    commitAgeMs: null,
    turns: 3,
    turnsWithoutProgress: 0,
    repeatedCalls: 0,
    continuations: 0,
    vendorErrorMs: 0,
    activeMs: 90_000,
    contextUsed: 0.4,
  };
}

const leadMessages = (ctx: HubContext) => listMessages(ctx, {}).filter((message) => message.to === 'lead');

describe('dispatch', () => {
  test('a ready task with a free slot and a usable runner gets an attempt, by priority then age', () => {
    const { ctx, clock } = schedulerContext();
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
    const { ctx } = schedulerContext();
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
    const { ctx } = schedulerContext();
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
    const { ctx, clock } = schedulerContext();
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
    const { ctx } = schedulerContext({ maxWorkers: 1 });
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
    const { ctx } = schedulerContext();
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
    const { ctx } = schedulerContext();
    const runnerId = addRunner(ctx);
    const [taskId] = tasks(ctx, { title: 'Parser' });
    setPaused(ctx, true, 'user:alice');
    expect(tick(ctx)).toEqual([]);
    setPaused(ctx, false, 'user:alice');
    expect(tick(ctx)).toEqual([[taskId, runnerId, 'claude']]);
  });

  test('live-chat-only tasks stay ready, and future next_dispatch_at or dispatch_hold_until waits', () => {
    const { ctx, clock } = schedulerContext();
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
    const { ctx } = schedulerContext();
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
    const { ctx } = schedulerContext();
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
    const { ctx, clock } = schedulerContext();
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
    const { ctx } = schedulerContext();
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

describe('the reconcile step', () => {
  test('runs every reconcile duty before dispatch, and nothing else', () => {
    const { ctx, clock } = schedulerContext({ leaseMs: 20 * MINUTE, maxWorkers: 8 });
    const runnerId = addRunner(ctx, { vendors: ['claude', 'codex'] });
    // A live claim whose M1 lease runs out: the sweep makes it ready, and the same tick dispatches it.
    const [swept] = tasks(ctx, { title: 'Swept' });
    claimTask(ctx, swept as string, addAgent(ctx));
    // A runner attempt whose lease runs out.
    const lost = addRunnerAttempt(ctx);
    // One that reports an hour of vendor errors, and one of bob's whose stop timed out.
    const erring = addRunnerAttempt(ctx);
    const stopping = addRunnerAttempt(ctx, { owner: 'bob' });
    // A pending submission, and a pending approval of bob's, so that its expiry marks only bob away; both past their
    // timeouts by then.
    const submitting = addRunnerAttempt(ctx);
    requestSubmission(ctx, submitting.task.id, submitting.agent, { summary: 'Done.', evidence: [] });
    ctx.db
      .query(
        `INSERT INTO approvals (id, attempt_id, fence_epoch, fence_counter, runner_id, owner, task_id, agent_id, kind,
           summary, detail, status, created_at, expires_at)
         VALUES ('approval-1', $attemptId, $epoch, $counter, $runnerId, 'bob', $taskId, $agentId, 'command',
           'bun install', '{}', 'pending', $now, $expiresAt)`,
      )
      .run({
        attemptId: stopping.attempt.id,
        epoch: stopping.attempt.fence.epoch,
        counter: stopping.attempt.fence.counter,
        runnerId: stopping.runner.id,
        taskId: stopping.task.id,
        agentId: stopping.agent.id,
        now: ctx.now(),
        expiresAt: ctx.now() + ctx.config.approvalMs,
      });
    // An exhausted Codex account with an unknown reset, for the probe.
    exhaust(ctx, 'codex', { resetsAt: null });
    // A taken-over attempt whose hand-back from the clone gets no answer.
    const taken = addRunnerAttempt(ctx);
    const by = 'user:alice';
    requestStop(ctx, { attemptId: taken.attempt.id, cause: 'takeover', reason: 'taken over by alice', by });
    endAttempt(ctx, { attemptId: taken.attempt.id, trigger: 'takeover' });
    const takeover = getAttempt(ctx, taken.attempt.id).takeover;
    if (!takeover) throw new Error('no take-over recorded');
    updateAttempt(ctx, taken.attempt.id, { takeover: { ...takeover, handingBack: { by, at: ctx.now() } } });

    clock.advance(ctx.config.quotaUnknownMs);
    const later = ctx.now() + ctx.config.runnerLeaseMs;
    for (const held of [erring, stopping, submitting]) updateAttempt(ctx, held.attempt.id, { leaseExpiresAt: later });
    updateAttempt(ctx, erring.attempt.id, {
      facts: { ...factsOf(erring.attempt.id), vendorErrorMs: ctx.config.vendorErrorReplaceMs },
      factsAt: ctx.now(),
    });
    updateAttempt(ctx, stopping.attempt.id, {
      stopRequested: {
        cause: 'stop',
        reason: 'enough',
        by: 'user:alice',
        handoff: true,
        deferred: false,
        at: ctx.now() - ctx.config.stopGraceMs,
      },
    });

    const result = runTick(ctx);
    expect(result.reconciled).toEqual({
      leases: [swept],
      runnerLeases: 1,
      approvals: 1,
      stalls: { suspected: [], stopped: [erring.attempt.id] },
      stops: 1,
      submissions: 1,
      handbacks: 1,
      holdingLeads: [],
      probes: 1,
      quotaWaits: [],
      leadReview: false,
      rotated: null,
    });
    expect(getAttempt(ctx, lost.attempt.id).endReason).toBe('lost');
    expect(getAttempt(ctx, taken.attempt.id).takeover?.handingBack).toBeNull();
    expect(result.started.map((attempt) => [attempt.taskId, attempt.runnerId])).toContainEqual([swept, runnerId]);
  });

  test('a duty that fails is logged and leaves the other duties and dispatch to run', () => {
    const { ctx, clock } = schedulerContext({ leaseMs: 20 * MINUTE });
    // A live claim whose M1 lease runs out, which the lease sweep cannot move.
    const [stuck] = tasks(ctx, { title: 'Stuck' });
    claimTask(ctx, stuck as string, addAgent(ctx));
    ctx.db.run(
      `CREATE TEMP TRIGGER refuse_stale BEFORE UPDATE ON tasks WHEN OLD.id = '${stuck}' AND NEW.status = 'stale'
       BEGIN SELECT RAISE(ABORT, 'refused for the test'); END`,
    );
    // A runner attempt whose lease runs out, and a ready task.
    const lost = addRunnerAttempt(ctx);
    clock.advance(ctx.config.runnerLeaseMs + 20 * MINUTE);
    const [ready] = tasks(ctx, { title: 'Ready' });
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = runTick(ctx);
      expect(logged).toHaveBeenCalledTimes(1);
      expect(result.reconciled).toMatchObject({ leases: [], runnerLeases: 1 });
      expect(getAttempt(ctx, lost.attempt.id).endReason).toBe('lost');
      expect(result.started.map((attempt) => attempt.taskId)).toEqual([ready]);
    } finally {
      logged.mockRestore();
    }
    expect(statusOf(ctx, stuck as string)).toBe('claimed');
  });
});

describe('replaceQuotaWaits', () => {
  /** A Codex worker on R-1 in quota_wait, its account exhausted until resetIn from now, or with no known reset. */
  function waiting(resetIn: ((ctx: HubContext) => number) | null) {
    const { ctx, clock } = schedulerContext();
    const resetsAt = resetIn === null ? null : ctx.now() + resetIn(ctx);
    const held = addRunnerAttempt(ctx, { vendor: 'codex' });
    exhaust(ctx, 'codex', { resetsAt });
    updateAttempt(ctx, held.attempt.id, { status: 'quota_wait', quotaResetsAt: resetsAt });
    return { ctx, clock, held };
  }


  test('replaces one whose reset is unknown, once a placement with quota exists', () => {
    const { ctx, held } = waiting(null);
    // Only the exhausted account: it waits.
    expect(replaceQuotaWaits(ctx)).toEqual([]);
    expect(getAttempt(ctx, held.attempt.id).stopRequested).toBeNull();
    addRunner(ctx, { vendors: ['claude'] });
    expect(replaceQuotaWaits(ctx)).toEqual([held.attempt.id]);
    expect(getAttempt(ctx, held.attempt.id).stopRequested).toMatchObject({ cause: 'quota', handoff: false });
    const stop = pendingCommands(ctx, held.runner.id, 1).find((row) => row.command.kind === 'stop_attempt');
    expect(stop?.command).toMatchObject({ cause: 'quota', handoff: false });
    // Recorded once.
    expect(replaceQuotaWaits(ctx)).toEqual([]);
  });

  test('replaces one whose reset is more than quotaWaitMaxMs away, and leaves a nearer one waiting', () => {
    const near = waiting((ctx) => ctx.config.quotaWaitMaxMs);
    addRunner(near.ctx, { vendors: ['claude'] });
    expect(replaceQuotaWaits(near.ctx)).toEqual([]);

    const far = waiting((ctx) => ctx.config.quotaWaitMaxMs + 1);
    addRunner(far.ctx, { vendors: ['claude'] });
    expect(replaceQuotaWaits(far.ctx)).toEqual([far.held.attempt.id]);
  });
});

describe('replaceQuotaWaits, when the successor cannot start', () => {
  /** A Codex worker on R-1 waiting with no known reset, and a Claude runner, R-2, with room. */
  function replaceable() {
    const { ctx } = createTestContext();
    const held = addRunnerAttempt(ctx, { vendor: 'codex' });
    exhaust(ctx, 'codex', { resetsAt: null });
    updateAttempt(ctx, held.attempt.id, { status: 'quota_wait', quotaResetsAt: null });
    addRunner(ctx, { vendors: ['claude'] });
    return { ctx, held };
  }

  test('nothing is replaced while the project is paused; a lead keeps the seat', () => {
    const { ctx, held } = replaceable();
    const lead = addRunnerLead(ctx);
    updateAttempt(ctx, lead.attempt.id, { status: 'quota_wait', quotaResetsAt: null });
    addRunner(ctx, { vendors: ['claude'] });
    setPaused(ctx, true, 'user:alice');
    expect(replaceQuotaWaits(ctx)).toEqual([]);
    expect([getAttempt(ctx, held.attempt.id).stopRequested, getAttempt(ctx, lead.attempt.id).stopRequested]).toEqual([
      null,
      null,
    ]);
    expect(seatHolderId(ctx)).toBe(lead.agent.id);
    setPaused(ctx, false, 'user:alice');
    expect(replaceQuotaWaits(ctx).sort()).toEqual([held.attempt.id, lead.attempt.id].sort());
  });

  test('a worker is not replaced while the worker target leaves its successor no slot', () => {
    const { ctx, held } = replaceable();
    tx(ctx, () => setWorkerTarget(ctx, 0));
    expect(replaceQuotaWaits(ctx)).toEqual([]);
    expect(getAttempt(ctx, held.attempt.id).stopRequested).toBeNull();
    // The successor takes the slot the wait frees.
    tx(ctx, () => setWorkerTarget(ctx, 1));
    expect(replaceQuotaWaits(ctx)).toEqual([held.attempt.id]);
  });

  test('with one free slot, only the older of two waits is replaced', () => {
    const { ctx, clock } = createTestContext();
    const older = addRunnerAttempt(ctx, { vendor: 'codex' });
    clock.advance(1_000);
    const newer = addRunnerAttempt(ctx, { vendor: 'codex', runnerId: older.runner.id });
    exhaust(ctx, 'codex', { resetsAt: null });
    for (const held of [older, newer]) updateAttempt(ctx, held.attempt.id, { status: 'quota_wait' });
    const claude = addRunner(ctx, { vendors: ['claude'] });
    ctx.db.query('UPDATE runners SET capacity = 1 WHERE id = $id').run({ id: claude });
    expect(replaceQuotaWaits(ctx)).toEqual([older.attempt.id]);
    expect(getAttempt(ctx, newer.attempt.id).stopRequested).toBeNull();
  });

  test('a lead is replaced once another runner has room, and only with runner leads on', () => {
    const { ctx } = createTestContext();
    const lead = addRunnerLead(ctx);
    updateAttempt(ctx, lead.attempt.id, { status: 'quota_wait', quotaResetsAt: null });
    // Its runner is full: the lead and a worker.
    expect(replaceQuotaWaits(ctx)).toEqual([]);
    addRunner(ctx);
    ctx.db.run('UPDATE project SET runner_leads = 0 WHERE id = 1');
    expect(replaceQuotaWaits(ctx)).toEqual([]);
    ctx.db.run('UPDATE project SET runner_leads = 1 WHERE id = 1');
    expect(replaceQuotaWaits(ctx)).toEqual([lead.attempt.id]);
    expect(getAttempt(ctx, lead.attempt.id).stopRequested).toMatchObject({ cause: 'quota', handoff: false });
  });

  test("two exhausted Claude accounts with unknown resets do not replace each other's waits", () => {
    const { ctx, clock } = createTestContext();
    const held = addRunnerAttempt(ctx);
    exhaust(ctx, 'claude', { resetsAt: null });
    updateAttempt(ctx, held.attempt.id, { status: 'quota_wait', quotaResetsAt: null });
    const bobs = addRunner(ctx, { owner: 'bob' });
    exhaust(ctx, 'claude', { resetsAt: null }, { owner: 'bob', runnerId: bobs });
    // Bob's account may take its probing start now, which would only wait in turn.
    clock.advance(ctx.config.quotaUnknownMs);
    expect(replaceQuotaWaits(ctx)).toEqual([]);
    expect(getAttempt(ctx, held.attempt.id).stopRequested).toBeNull();
  });
});

describe('the Scheduler', () => {
  const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Polls until the predicate holds, failing at the deadline; for waits on real timers. */
  async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms`);
      await Bun.sleep(5);
    }
  }

  test("'auto' ticks every tickMs", async () => {
    const { ctx } = schedulerContext({ tickMs: 20 });
    addRunner(ctx);
    const [taskId] = tasks(ctx, { title: 'Parser' });
    const scheduler = new Scheduler(ctx);
    scheduler.start();
    try {
      expect(scheduler.running).toBe(true);
      await until(() => statusOf(ctx, taskId as string) === 'claimed');
    } finally {
      scheduler.stop();
    }
    expect(scheduler.running).toBe(false);
  });

  test('ticks once more, debounced, after a task gets ready or an attempt ends', async () => {
    const { ctx } = schedulerContext({ tickMs: 60 * MINUTE });
    addRunner(ctx);
    tx(ctx, () => setWorkerTarget(ctx, 1));
    const scheduler = new Scheduler(ctx, { debounceMs: 10 });
    scheduler.start();
    try {
      const [first] = tasks(ctx, { title: 'First' });
      await until(() => statusOf(ctx, first as string) === 'claimed');
      const [second] = tasks(ctx, { title: 'Second' });
      await settle(60);
      expect(statusOf(ctx, second as string)).toBe('ready');
      // The first attempt ends lost, which frees the one worker slot; the first waits out its backoff.
      const attempt = getTask(ctx, first as string).currentAttempt as string;
      endAttempt(ctx, { attemptId: attempt, trigger: 'lost' });
      await until(() => statusOf(ctx, second as string) === 'claimed');
    } finally {
      scheduler.stop();
    }
  });

  test('ticks after a worker goes holding, and after a task is unblocked or released', async () => {
    const { ctx } = schedulerContext({ tickMs: 60 * MINUTE });
    // A running worker on R-1 holds the one worker slot.
    const held = addRunnerAttempt(ctx);
    tx(ctx, () => setWorkerTarget(ctx, 1));
    const scheduler = new Scheduler(ctx, { debounceMs: 10 });
    scheduler.start();
    try {
      const [waiting] = tasks(ctx, { title: 'Waiting' });
      await settle(60);
      expect(statusOf(ctx, waiting as string)).toBe('ready');
      // Its submission is recorded, so it holds, which frees the slot.
      writeTask(ctx, held.task.id, { branch: 'agflow/T-1-task' });
      const submission = requestSubmission(ctx, held.task.id, held.agent, { summary: 'Done.', evidence: [] });
      const headSha = 'a'.repeat(40);
      const { fence } = getAttempt(ctx, held.attempt.id);
      const data = { submissionId: submission.id, ok: true, headSha, remoteHead: headSha, error: null, detail: null };
      const submitted = { seq: 1, at: 0, type: 'attempt.submitted', attemptId: held.attempt.id, fence, data };
      const events: RawRunnerEvent[] = [submitted];
      applyRunnerEvents(ctx, held.runner.id, { outboxEpoch: 'outbox-1', events }, { restoreReplay: false });
      expect(getAttempt(ctx, held.attempt.id).status).toBe('holding');
      await until(() => statusOf(ctx, waiting as string) === 'claimed');

      // Unblocked by a person, and released by its live holder: each is dispatched within the debounce.
      addRunner(ctx);
      tx(ctx, () => setWorkerTarget(ctx, 3));
      const [blocked, released] = tasks(ctx, { title: 'Blocked' }, { title: 'Released' });
      const agent = addAgent(ctx);
      const other = addAgent(ctx, 'bob');
      claimTask(ctx, blocked as string, agent);
      claimTask(ctx, released as string, other);
      blockTask(ctx, blocked as string, agent, 'needs a key');
      unblockTask(ctx, blocked as string, 'user:alice', 'the key is in the vault');
      await until(() => statusOf(ctx, blocked as string) === 'claimed');
      releaseTask(ctx, released as string, other, 'not mine');
      await until(() => statusOf(ctx, released as string) === 'claimed');
    } finally {
      scheduler.stop();
    }
  });

  test('a burst of events makes one extra tick, debounceMs after the first', async () => {
    const { ctx } = schedulerContext({ tickMs: 60 * MINUTE });
    addRunner(ctx);
    const scheduler = new Scheduler(ctx, { debounceMs: 30 });
    let ticks = 0;
    const once = scheduler.tick.bind(scheduler);
    scheduler.tick = () => {
      ticks += 1;
      return once();
    };
    scheduler.start();
    try {
      const created = tasks(ctx, { title: 'One' }, { title: 'Two' }, { title: 'Three' });
      expect(created.map((id) => statusOf(ctx, id))).toEqual(['ready', 'ready', 'ready']);
      await until(() => ticks > 0);
      await settle(60);
      expect(ticks).toBe(1);
      // The runner's two slots took the first two.
      expect(created.map((id) => statusOf(ctx, id))).toEqual(['claimed', 'claimed', 'ready']);
    } finally {
      scheduler.stop();
    }
  });

  test("'manual' starts stopped: tick() runs one tick and start() begins the timer; stop() stops it", async () => {
    const { ctx } = schedulerContext({ tickMs: 20 });
    addRunner(ctx);
    const scheduler = new Scheduler(ctx, { debounceMs: 10 });
    const [one] = tasks(ctx, { title: 'One' });
    await settle(60);
    expect(statusOf(ctx, one as string)).toBe('ready');
    expect(scheduler.tick().started.map((attempt) => attempt.taskId)).toEqual([one]);
    scheduler.start();
    scheduler.stop();
    // Neither the timer nor an extra tick after the event.
    const [two] = tasks(ctx, { title: 'Two' });
    await settle(60);
    expect(statusOf(ctx, two as string)).toBe('ready');
  });

  test("startHub's scheduler option: 'auto' runs one, 'manual' makes one stopped, false none", async () => {
    for (const [option, running] of [
      ['auto', true],
      ['manual', false],
    ] as const) {
      const { ctx } = schedulerContext();
      const hub = startHub(ctx, { scheduler: option, timers: false });
      expect(hub.scheduler?.running).toBe(running);
      await hub.stop();
      expect(hub.scheduler?.running).toBe(false);
    }
    const { ctx } = schedulerContext();
    const hub = startHub(ctx, { scheduler: false, timers: false });
    expect(hub.scheduler).toBeNull();
    await hub.stop();
  });

  test('the entry point leaves the lease sweep to the tick', async () => {
    const main = await Bun.file(new URL('../src/main.ts', import.meta.url)).text();
    expect(main).not.toContain('sweepLeases');
    expect(main).toContain("scheduler: 'auto'");
  });
});

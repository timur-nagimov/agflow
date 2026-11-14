import { describe, expect, test } from 'bun:test';
import { HINT_WAIT_MS, type RawRunnerEvent, TEST_ACCOUNT_ID, type Vendor, type VendorQuota } from '@agflow/core';
import { getAttempt, updateAttempt } from '../src/attempt-store';
import { endAttempt, requestStop, startRunnerAttempt } from '../src/attempts';
import { type HubContext, tx } from '../src/context';
import { applyRunnerEvents } from '../src/events-in';
import { seatHolderId } from '../src/hub-state';
import { accountFor, upsertAccountQuota } from '../src/quota';
import { getRunner } from '../src/runners';
import { replaceQuotaWaits, runTick, runningWorkers } from '../src/scheduler';
import { getTask } from '../src/task-store';
import { createTasks } from '../src/tasks';
import { addRunner, addRunnerAttempt, createTestContext, markHubAlive, newTask } from './helpers';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A test context with runner leads off, so that only the workers a test makes are on its runners. */
function workersOnly() {
  const made = createTestContext();
  made.ctx.db.run('UPDATE project SET runner_leads = 0 WHERE id = 1');
  return made;
}

/** Stores the owner's account report for the vendor, as a runner of theirs reports it. */
function report(ctx: HubContext, owner: string, runnerId: string, vendor: Vendor, quota: Partial<VendorQuota> = {}) {
  tx(ctx, (emit) =>
    upsertAccountQuota(ctx, emit, {
      owner,
      runnerId,
      report: {
        vendor,
        accountId: TEST_ACCOUNT_ID,
        quota: {
          state: 'ok',
          resetsAt: null,
          windows: { fiveHour: 0.2, weekly: 0.1 },
          paidUsage: 'disabled',
          updatedAt: ctx.now(),
          ...quota,
        },
      },
    }),
  );
}

/** Ready tasks by alice; returns their ids. */
const tasks = (ctx: HubContext, ...inputs: Parameters<typeof newTask>[0][]): string[] =>
  createTasks(ctx, inputs.map((input) => newTask(input)), 'user:alice').map((task) => task.id);

describe('the slots the hub counts', () => {
  test('a runner counts its starting and running workers: a lead, a holding attempt and a quota wait take none', () => {
    const { ctx } = workersOnly();
    const runnerId = addRunner(ctx);
    startRunnerAttempt(ctx, { runnerId, taskId: null, role: 'lead', vendor: 'claude' });
    addRunnerAttempt(ctx, { runnerId });
    const holding = addRunnerAttempt(ctx, { runnerId });
    updateAttempt(ctx, holding.attempt.id, { status: 'holding', leaseExpiresAt: null });
    const waiting = addRunnerAttempt(ctx, { runnerId });
    updateAttempt(ctx, waiting.attempt.id, { status: 'quota_wait', quotaResetsAt: null });
    expect(getRunner(ctx, runnerId).activeAttempts).toBe(1);
    expect(runningWorkers(ctx)).toBe(1);
    // A wait asked to stop takes its slot again until it ends, which keeps the slot for its successor.
    requestStop(ctx, { attemptId: waiting.attempt.id, cause: 'quota', reason: 'out of quota', by: 'system' });
    expect(getRunner(ctx, runnerId).activeAttempts).toBe(2);
    expect(runningWorkers(ctx)).toBe(2);
  });

  test('a worker waiting for its quota frees its slot, so the other vendor on the same laptop starts at once', () => {
    const { ctx } = workersOnly();
    const runnerId = addRunner(ctx, { vendors: ['claude', 'codex'] });
    const waiting = addRunnerAttempt(ctx, { runnerId });
    addRunnerAttempt(ctx, { runnerId });
    const [next] = tasks(ctx, { title: 'Next' });
    expect(runTick(ctx).started).toEqual([]);
    // The Claude account runs out for ten minutes, too short a wait to replace the worker.
    report(ctx, 'alice', runnerId, 'claude', { state: 'exhausted', resetsAt: ctx.now() + 10 * MINUTE });
    updateAttempt(ctx, waiting.attempt.id, { status: 'quota_wait', quotaResetsAt: ctx.now() + 10 * MINUTE });
    const started = runTick(ctx).started.map((attempt) => [attempt.taskId, attempt.runnerId, attempt.vendor]);
    expect(started).toEqual([[next, runnerId, 'codex']]);
    // At its reset the wait runs again, past the capacity for a while; nothing more starts meanwhile.
    updateAttempt(ctx, waiting.attempt.id, { status: 'running', quotaResetsAt: null });
    expect(getRunner(ctx, runnerId)).toMatchObject({ capacity: 2, activeAttempts: 3 });
    tasks(ctx, { title: 'Later' });
    expect(runTick(ctx).started).toEqual([]);
  });
});

describe('quota replacements', () => {
  test('are no failure: no backoff, no failure signature, and three in a row leave the task ready', () => {
    const { ctx } = workersOnly();
    const runnerId = addRunner(ctx);
    const [taskId] = tasks(ctx, { title: 'Parser' });
    for (let n = 0; n < 3; n++) {
      const held = addRunnerAttempt(ctx, { runnerId, taskId });
      updateAttempt(ctx, held.attempt.id, { status: 'quota_wait', quotaResetsAt: null });
      requestStop(ctx, { attemptId: held.attempt.id, cause: 'quota', reason: 'out of quota', by: 'system' });
      const ending = endAttempt(ctx, { attemptId: held.attempt.id, trigger: 'quota' });
      expect(ending?.attempt).toMatchObject({ endReason: 'replaced', failureClass: 'infra', failureSignature: null });
      expect(getTask(ctx, taskId as string)).toMatchObject({ status: 'ready', nextDispatchAt: null });
    }
    // The backoff passes over them: a crash after them waits as the first infra failure does.
    const crashed = addRunnerAttempt(ctx, { runnerId, taskId });
    endAttempt(ctx, { attemptId: crashed.attempt.id, trigger: 'crashed' });
    expect(getTask(ctx, taskId as string).nextDispatchAt).toBe(ctx.now() + (ctx.config.infraBackoffMs[0] as number));
  });

  test("a worker is replaced only onto another account than the one it waits on, which stays usable", () => {
    const { ctx } = workersOnly();
    const held = addRunnerAttempt(ctx);
    // A limit of one model: the attempt waits a day, and its account is not exhausted.
    updateAttempt(ctx, held.attempt.id, { status: 'quota_wait', quotaResetsAt: ctx.now() + 24 * HOUR });
    addRunner(ctx);
    expect(replaceQuotaWaits(ctx)).toEqual([]);
    addRunner(ctx, { owner: 'bob' });
    expect(replaceQuotaWaits(ctx)).toEqual([held.attempt.id]);
    expect(getAttempt(ctx, held.attempt.id).stopRequested).toMatchObject({ cause: 'quota', handoff: false });
  });

  test('a lead in quota_wait is replaced at once, and the next lead starts on another account', () => {
    const { ctx } = createTestContext();
    const first = addRunner(ctx);
    const lead = runTick(ctx).lead;
    if (!lead) throw new Error('no lead');
    // Its reset is five minutes away, which a worker would wait for.
    updateAttempt(ctx, lead.id, { status: 'quota_wait', quotaResetsAt: ctx.now() + 5 * MINUTE });
    const bobs = addRunner(ctx, { owner: 'bob' });
    // Another of alice's, roomier, which a lead would prefer, is on the account the lead waits on.
    const roomier = addRunner(ctx);
    ctx.db.query('UPDATE runners SET capacity = 8 WHERE id = $id').run({ id: roomier });
    expect(runTick(ctx).reconciled?.quotaWaits).toEqual([lead.id]);
    expect(seatHolderId(ctx)).toBe(lead.agentId);
    endAttempt(ctx, { attemptId: lead.id, trigger: 'quota' });
    expect(getAttempt(ctx, lead.id)).toMatchObject({ endReason: 'replaced', runnerId: first });
    expect(runTick(ctx).lead).toMatchObject({ role: 'lead', runnerId: bobs });
  });
});

describe('placement over accounts', () => {
  test("a tick spreads its workers over all four accounts of two laptops", () => {
    const { ctx } = workersOnly();
    const alices = addRunner(ctx, { vendors: ['claude', 'codex'] });
    const bobs = addRunner(ctx, { owner: 'bob', vendors: ['claude', 'codex'] });
    for (const vendor of ['claude', 'codex'] as const) {
      report(ctx, 'alice', alices, vendor);
      report(ctx, 'bob', bobs, vendor);
    }
    tasks(ctx, { title: 'One' }, { title: 'Two' }, { title: 'Three' }, { title: 'Four' });
    const owners: Record<string, string> = { [alices]: 'alice', [bobs]: 'bob' };
    const placed = runTick(ctx).started.map((attempt) => `${owners[attempt.runnerId as string]} ${attempt.vendor}`);
    expect(placed.sort()).toEqual(['alice claude', 'alice codex', 'bob claude', 'bob codex']);
  });

  test('a hinted task waits a minute for its vendor, then starts on the other', () => {
    const { ctx, clock } = workersOnly();
    const runnerId = addRunner(ctx, { vendors: ['claude', 'codex'] });
    report(ctx, 'alice', runnerId, 'codex', { state: 'exhausted', resetsAt: ctx.now() + HOUR });
    const [hinted] = tasks(ctx, { title: 'Hinted', vendorHint: 'codex' });
    expect(runTick(ctx).started).toEqual([]);
    clock.advance(HINT_WAIT_MS);
    markHubAlive(ctx);
    const started = runTick(ctx).started.map((attempt) => [attempt.taskId, attempt.vendor]);
    expect(started).toEqual([[hinted, 'claude']]);
  });

  test("a live reading of a running attempt stores its account's use and leaves the attempt running", () => {
    const { ctx } = workersOnly();
    const held = addRunnerAttempt(ctx);
    const quota: VendorQuota = {
      state: 'ok',
      resetsAt: ctx.now() + HOUR,
      windows: { fiveHour: 0.7, weekly: 0.3 },
      paidUsage: 'disabled',
      updatedAt: ctx.now(),
    };
    const reading: RawRunnerEvent = {
      seq: 1,
      at: ctx.now(),
      type: 'attempt.quota',
      attemptId: held.attempt.id,
      fence: held.attempt.fence,
      data: { vendor: 'claude', accountId: TEST_ACCOUNT_ID, quota },
    };
    applyRunnerEvents(ctx, held.runner.id, { outboxEpoch: 'outbox-1', events: [reading] }, { restoreReplay: false });
    expect(ctx.db.query('SELECT type, error FROM runner_event_rejects').all()).toEqual([]);
    expect(accountFor(ctx, 'alice', 'claude', TEST_ACCOUNT_ID)?.quota).toEqual(quota);
    expect(getAttempt(ctx, held.attempt.id).status).toBe('running');
  });
});

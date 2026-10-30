import { describe, expect, test } from 'bun:test';
import { type Attempt, type AttemptFacts, TEST_ACCOUNT_ID, type Vendor, type VendorQuota } from '@agflow/core';
import { getAttempt } from '../src/attempt-store';
import { startRunnerAttempt } from '../src/attempts';
import { createSession } from '../src/auth';
import type { HubContext } from '../src/context';
import { listEvents } from '../src/events';
import { Gateway } from '../src/gateway';
import { accountFor, listAccounts, probeUnknownResets } from '../src/quota';
import { createTasks } from '../src/tasks';
import { type FakeConnection, type FakeRunner, connectFakeRunner, settle } from './fake-runner';
import { addRunner, createTestContext, newTask, testVendor } from './helpers';

const HOUR = 60 * 60_000;

type Link = FakeRunner<FakeConnection>;

function quota(ctx: HubContext, overrides: Partial<VendorQuota> = {}): VendorQuota {
  return {
    state: 'ok',
    resetsAt: null,
    windows: { fiveHour: 0.4, weekly: 0.2 },
    paidUsage: 'disabled',
    updatedAt: ctx.now(),
    ...overrides,
  };
}

function factsOf(attempt: Attempt, phase: AttemptFacts['phase']): AttemptFacts {
  return {
    attemptId: attempt.id,
    fence: attempt.fence,
    phase,
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

/** A hub with runner R-1 connected, whose heartbeats carry the facts in `reported`, and a running worker on it. */
async function setup(vendor: Vendor = 'codex') {
  const { ctx, clock } = createTestContext();
  const runnerId = addRunner(ctx, { vendors: ['claude', 'codex'] });
  const reported: { facts: AttemptFacts[] } = { facts: [] };
  const runner = await connectFakeRunner(ctx, new Gateway(ctx), {
    token: createSession(ctx, 'alice', 'cli'),
    facts: () => reported.facts,
  });
  const [task] = createTasks(ctx, [newTask({ title: 'Parser' })], 'user:alice');
  const { attempt } = startRunnerAttempt(ctx, { runnerId, taskId: task?.id as string, role: 'worker', vendor });
  await settle();
  runner.startRunning(attempt.id);
  await settle();
  return { ctx, clock, runnerId, runner, reported, attempt: getAttempt(ctx, attempt.id) };
}

async function reportQuota(
  ctx: HubContext,
  runner: Link,
  attempt: Attempt,
  vendorQuota: VendorQuota,
  accountId: string | null = TEST_ACCOUNT_ID,
): Promise<void> {
  const at = { attemptId: attempt.id, fence: getAttempt(ctx, attempt.id).fence };
  runner.emit('attempt.quota', { vendor: attempt.vendor, accountId, quota: vendorQuota }, at);
  await settle();
  expect(ctx.db.query('SELECT type, error FROM runner_event_rejects').all()).toEqual([]);
}

const eventsOf = (ctx: HubContext, type: string) => listEvents(ctx.db).filter((event) => event.type === type);

describe('quota_wait', () => {
  test('an exhausted attempt.quota moves a running attempt to quota_wait, and its lease keeps renewing', async () => {
    const { ctx, clock, runner, reported, attempt } = await setup();
    const resetsAt = ctx.now() + HOUR;
    await reportQuota(ctx, runner, attempt, quota(ctx, { state: 'exhausted', resetsAt }));
    expect(getAttempt(ctx, attempt.id)).toMatchObject({ status: 'quota_wait', quotaResetsAt: resetsAt });
    expect(accountFor(ctx, 'alice', 'codex', TEST_ACCOUNT_ID)?.quota).toMatchObject({ state: 'exhausted', resetsAt });
    expect(eventsOf(ctx, 'attempt.quota_wait').map((event) => [event.subject, event.data])).toEqual([
      [
        attempt.taskId,
        { attemptId: attempt.id, taskId: attempt.taskId, agentId: attempt.agentId, runnerId: attempt.runnerId, resetsAt },
      ],
    ]);

    clock.advance(ctx.config.runnerLeaseMs - 1_000);
    reported.facts = [factsOf(attempt, 'quota_wait')];
    runner.heartbeat();
    await settle();
    expect(getAttempt(ctx, attempt.id)).toMatchObject({
      status: 'quota_wait',
      leaseExpiresAt: ctx.now() + ctx.config.runnerLeaseMs,
    });
  });

  test('state ok moves it back to running and emits attempt.running', async () => {
    const { ctx, clock, runner, attempt } = await setup();
    await reportQuota(ctx, runner, attempt, quota(ctx, { state: 'exhausted', resetsAt: ctx.now() + HOUR }));
    const running = eventsOf(ctx, 'attempt.running').length;
    clock.advance(HOUR);
    await reportQuota(ctx, runner, attempt, quota(ctx));
    expect(getAttempt(ctx, attempt.id)).toMatchObject({ status: 'running', quotaResetsAt: null });
    expect(eventsOf(ctx, 'attempt.running')).toHaveLength(running + 1);
    // A running attempt's ok report changes nothing more.
    await reportQuota(ctx, runner, attempt, quota(ctx));
    expect(eventsOf(ctx, 'attempt.running')).toHaveLength(running + 1);
  });

  test('fresh facts with phase turn move it back to running; other phases leave it waiting', async () => {
    const { ctx, runner, reported, attempt } = await setup();
    await reportQuota(ctx, runner, attempt, quota(ctx, { state: 'exhausted', resetsAt: null }));
    reported.facts = [factsOf(attempt, 'idle')];
    runner.heartbeat();
    await settle();
    expect(getAttempt(ctx, attempt.id).status).toBe('quota_wait');
    const running = eventsOf(ctx, 'attempt.running').length;
    reported.facts = [factsOf(attempt, 'turn')];
    runner.heartbeat();
    await settle();
    expect(getAttempt(ctx, attempt.id)).toMatchObject({ status: 'running', quotaResetsAt: null, phase: 'turn' });
    expect(eventsOf(ctx, 'attempt.running')).toHaveLength(running + 1);
  });

  test('a second exhausted report updates the reset time and emits nothing more', async () => {
    const { ctx, runner, attempt } = await setup();
    await reportQuota(ctx, runner, attempt, quota(ctx, { state: 'exhausted', resetsAt: ctx.now() + HOUR }));
    const later = ctx.now() + 2 * HOUR;
    await reportQuota(ctx, runner, attempt, quota(ctx, { state: 'exhausted', resetsAt: later }));
    expect(getAttempt(ctx, attempt.id)).toMatchObject({ status: 'quota_wait', quotaResetsAt: later });
    expect(eventsOf(ctx, 'attempt.quota_wait')).toHaveLength(1);
  });

  test('a report with state unknown leaves a running attempt alone', async () => {
    const { ctx, runner, attempt } = await setup();
    await reportQuota(ctx, runner, attempt, quota(ctx, { state: 'unknown' }));
    expect(getAttempt(ctx, attempt.id).status).toBe('running');
    expect(eventsOf(ctx, 'attempt.quota_wait')).toEqual([]);
  });

  test('a null account id moves the attempt and updates no account', async () => {
    const { ctx, runner, attempt } = await setup();
    const before = listAccounts(ctx);
    await reportQuota(ctx, runner, attempt, quota(ctx, { state: 'exhausted', resetsAt: null }), null);
    expect(getAttempt(ctx, attempt.id)).toMatchObject({ status: 'quota_wait', quotaResetsAt: null });
    expect(listAccounts(ctx)).toEqual(before);
    await reportQuota(ctx, runner, attempt, quota(ctx), null);
    expect(getAttempt(ctx, attempt.id).status).toBe('running');
    expect(listAccounts(ctx)).toEqual(before);
  });
});

describe('probeUnknownResets', () => {
  /** The preflight commands queued so far, as [runner, vendor]. */
  const preflights = (ctx: HubContext) =>
    (
      ctx.db
        .query(
          `SELECT runner_id, json_extract(payload, '$.vendor') AS vendor FROM runner_commands
           WHERE kind = 'preflight' ORDER BY hub_epoch, seq`,
        )
        .all() as { runner_id: string; vendor: string }[]
    ).map((row) => [row.runner_id, row.vendor]);

  test('sends one preflight per quotaUnknownMs to one online runner of the owner on an exhausted Codex account', async () => {
    const { ctx, clock, runnerId, runner, attempt } = await setup();
    // Another runner of alice's on the account, offline, and one of bob's: neither is asked.
    const offline = addRunner(ctx, { vendors: ['codex'] });
    ctx.db.run(`UPDATE runners SET state = 'offline' WHERE id = '${offline}'`);
    addRunner(ctx, { owner: 'bob', vendors: ['codex'] });
    await reportQuota(ctx, runner, attempt, quota(ctx, { state: 'exhausted', resetsAt: null }));
    const before = preflights(ctx).length;

    clock.advance(ctx.config.quotaUnknownMs - 1);
    expect(probeUnknownResets(ctx)).toBe(0);
    clock.advance(1);
    expect(probeUnknownResets(ctx)).toBe(1);
    expect(preflights(ctx).slice(before)).toEqual([[runnerId, 'codex']]);
    // Once per quotaUnknownMs, timed by the last preflight.
    clock.advance(ctx.config.quotaUnknownMs - 1);
    expect(probeUnknownResets(ctx)).toBe(0);
    clock.advance(1);
    expect(probeUnknownResets(ctx)).toBe(1);
    expect(preflights(ctx).slice(before)).toHaveLength(2);

    // The preflight's runner.vendors answer lifts the exhaustion, and nothing more is probed.
    runner.emit('runner.vendors', {
      vendors: [testVendor('claude'), testVendor('codex')],
      quota: [{ vendor: 'codex', accountId: TEST_ACCOUNT_ID, quota: quota(ctx) }],
    });
    await settle();
    expect(accountFor(ctx, 'alice', 'codex', TEST_ACCOUNT_ID)?.quota.state).toBe('ok');
    clock.advance(ctx.config.quotaUnknownMs);
    expect(probeUnknownResets(ctx)).toBe(0);
  });

  test("asks an online runner of the owner on that account, whatever the runners' order", async () => {
    const { ctx, clock, runnerId, runner, attempt } = await setup();
    await reportQuota(ctx, runner, attempt, quota(ctx, { state: 'exhausted', resetsAt: null }));
    const before = preflights(ctx).length;
    // Runners that come before the spare in runner order: bob's, and alice's on another account.
    addRunner(ctx, { owner: 'bob', vendors: ['codex'] });
    const elsewhere = addRunner(ctx, { vendors: ['codex'] });
    ctx.db
      .query(`UPDATE runners SET info = json_set(info, '$.vendors[0].accountId', 'another-account') WHERE id = $id`)
      .run({ id: elsewhere });
    const spare = addRunner(ctx, { vendors: ['codex'] });
    const offline = ctx.db.query(`UPDATE runners SET state = 'offline' WHERE id = $id`);
    offline.run({ id: runnerId });

    clock.advance(ctx.config.quotaUnknownMs);
    expect(probeUnknownResets(ctx)).toBe(1);
    expect(preflights(ctx).slice(before)).toEqual([[spare, 'codex']]);
    // With no online runner on the account, none is asked.
    offline.run({ id: spare });
    clock.advance(ctx.config.quotaUnknownMs);
    expect(probeUnknownResets(ctx)).toBe(0);
  });

  test('an exhaustion with a known reset, and a Claude account, get no preflight', async () => {
    const codex = await setup('codex');
    const resetsAt = codex.ctx.now() + HOUR;
    await reportQuota(codex.ctx, codex.runner, codex.attempt, quota(codex.ctx, { state: 'exhausted', resetsAt }));
    codex.clock.advance(codex.ctx.config.quotaUnknownMs);
    expect(probeUnknownResets(codex.ctx)).toBe(0);

    const claude = await setup('claude');
    await reportQuota(claude.ctx, claude.runner, claude.attempt, quota(claude.ctx, { state: 'exhausted' }));
    claude.clock.advance(claude.ctx.config.quotaUnknownMs);
    expect(probeUnknownResets(claude.ctx)).toBe(0);
  });
});

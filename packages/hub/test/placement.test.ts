import { describe, expect, test } from 'bun:test';
import {
  type AccountQuotaReport,
  TEST_ACCOUNT_ID,
  type VendorQuota,
  candidateRunners,
  freeSlots,
  usableVendors,
} from '@agflow/core';
import { updateAttempt } from '../src/attempt-store';
import { startRunnerAttempt } from '../src/attempts';
import { type HubContext, tx } from '../src/context';
import { placementSnapshot } from '../src/placement';
import { upsertAccountQuota } from '../src/quota';
import { markVendorNotReady, recordStartRefusal, setDegraded } from '../src/runners';
import { addRunner, addRunnerAttempt, createTestContext } from './helpers';

const HOUR = 60 * 60_000;

function report(vendor: 'claude' | 'codex', overrides: Partial<VendorQuota> = {}): AccountQuotaReport {
  return {
    vendor,
    accountId: TEST_ACCOUNT_ID,
    quota: {
      state: 'ok',
      resetsAt: null,
      windows: { fiveHour: 0.2, weekly: 0.1 },
      paidUsage: 'disabled',
      updatedAt: Date.UTC(2026, 9, 26, 11, 0, 0),
      ...overrides,
    },
  };
}

const upsert = (ctx: HubContext, owner: string, runnerId: string, quotaReport: AccountQuotaReport) =>
  tx(ctx, (emit) => upsertAccountQuota(ctx, emit, { owner, runnerId, report: quotaReport }));

/**
 * alice's R-1 (claude and codex) with a running worker and a starting lead, alice's R-2 (claude) offline, draining,
 * with git not ready, a refused start and a heartbeat's acceptingUntil, and bob's R-3 (claude).
 */
function setup() {
  const { ctx, clock } = createTestContext();
  const r1 = addRunner(ctx, { vendors: ['claude', 'codex'] });
  const worker = addRunnerAttempt(ctx, { runnerId: r1 });
  startRunnerAttempt(ctx, { runnerId: r1, taskId: null, role: 'lead', vendor: 'claude' });
  // Holding and ended attempts take no slot.
  const holding = addRunnerAttempt(ctx, { runnerId: r1 });
  updateAttempt(ctx, holding.attempt.id, { status: 'holding', leaseExpiresAt: null });
  const ended = addRunnerAttempt(ctx, { runnerId: r1, vendor: 'codex' });
  updateAttempt(ctx, ended.attempt.id, { status: 'ended', endReason: 'crashed', leaseExpiresAt: null });
  setDegraded(ctx, r1, 'codex');
  const r2 = addRunner(ctx, { vendors: ['claude'] });
  const info = JSON.parse(
    (ctx.db.query('SELECT info FROM runners WHERE id = $id').get({ id: r2 }) as { info: string }).info,
  );
  info.git = { ready: false, problem: 'push refused', lastPushAt: null };
  ctx.db
    .query(
      `UPDATE runners SET state = 'offline', draining = 1, capacity = 3, accepting_until = $until, info = $info
       WHERE id = $id`,
    )
    .run({ id: r2, until: ctx.now() + 60_000, info: JSON.stringify(info) });
  recordStartRefusal(ctx, r2, 'waking');
  markVendorNotReady(ctx, r2, 'claude');
  const r3 = addRunner(ctx, { owner: 'bob', vendors: ['claude'] });
  upsert(ctx, 'alice', r1, report('claude'));
  upsert(ctx, 'alice', r1, report('codex', { windows: { fiveHour: 0.9, weekly: 0.4 } }));
  upsert(ctx, 'bob', r3, report('claude'));
  return { ctx, clock, r1, r2, r3, worker };
}

describe('placementSnapshot', () => {
  test("lists each runner's slots, open attempts and vendor holds, and each account with its open attempts", () => {
    const { ctx, r1, r2, r3 } = setup();
    const snapshot = placementSnapshot(ctx);
    expect(snapshot.now).toBe(ctx.now());
    expect(snapshot.quotaUnknownMs).toBe(ctx.config.quotaUnknownMs);
    expect(snapshot.runners.map((runner) => runner.id)).toEqual([r1, r2, r3]);
    const [first, second, third] = snapshot.runners;
    expect(first).toEqual({
      id: r1,
      owner: 'alice',
      state: 'online',
      draining: false,
      gitReady: true,
      acceptingUntil: null,
      startRefusal: null,
      capacity: 2,
      // The worker and the lead; the holding and the ended attempts take no slot.
      openAttempts: 2,
      power: { source: 'ac', batteryPercent: null, lowPowerMode: false },
      vendors: [
        {
          vendor: 'claude',
          ready: true,
          notReadySince: null,
          degradedUntil: null,
          accountId: TEST_ACCOUNT_ID,
          ceilings: { fiveHour: 0.85, weekly: 0.85 },
          allowPaidUsage: false,
        },
        {
          vendor: 'codex',
          ready: true,
          notReadySince: null,
          degradedUntil: ctx.now() + ctx.config.degradedMs,
          accountId: TEST_ACCOUNT_ID,
          ceilings: { fiveHour: 0.85, weekly: 0.85 },
          allowPaidUsage: false,
        },
      ],
    });
    expect(second).toMatchObject({
      state: 'offline',
      draining: true,
      gitReady: false,
      acceptingUntil: ctx.now() + 60_000,
      startRefusal: { code: 'waking', at: ctx.now() },
      capacity: 3,
      openAttempts: 0,
      vendors: [{ vendor: 'claude', ready: true, notReadySince: ctx.now() }],
    });
    expect(third).toMatchObject({ owner: 'bob', openAttempts: 0 });
    expect(snapshot.accounts.map((account) => [account.owner, account.vendor, account.openAttempts])).toEqual([
      ['alice', 'claude', 2],
      ['alice', 'codex', 0],
      ['bob', 'claude', 0],
    ]);
    expect(snapshot.accounts[1]).toMatchObject({ accountId: TEST_ACCOUNT_ID, ownerAway: false });
  });

  test("each open attempt counts for the account its runner's vendor reports", () => {
    const { ctx } = createTestContext();
    /** A claude runner of alice's that reports this account, with this many running attempts. */
    const runnerWith = (accountId: string | null, running: number) => {
      const runnerId = addRunner(ctx, { vendors: ['claude'] });
      const row = ctx.db.query('SELECT info FROM runners WHERE id = $id').get({ id: runnerId }) as { info: string };
      const info = JSON.parse(row.info);
      info.vendors[0].accountId = accountId;
      ctx.db.query('UPDATE runners SET info = $info WHERE id = $id').run({ id: runnerId, info: JSON.stringify(info) });
      for (let n = 0; n < running; n++) addRunnerAttempt(ctx, { runnerId });
      return runnerId;
    };
    const first = runnerWith(TEST_ACCOUNT_ID, 1);
    const second = runnerWith('account-y', 2);
    runnerWith(null, 1);
    upsert(ctx, 'alice', first, report('claude'));
    upsert(ctx, 'alice', second, { ...report('claude'), accountId: 'account-y' });
    expect(placementSnapshot(ctx).accounts.map((account) => [account.accountId, account.openAttempts])).toEqual([
      [TEST_ACCOUNT_ID, 1],
      ['account-y', 2],
    ]);
  });

  test("the runner's own settings set its ceilings and paid usage", () => {
    const { ctx, r3 } = setup();
    const info = JSON.parse(
      (ctx.db.query('SELECT info FROM runners WHERE id = $id').get({ id: r3 }) as { info: string }).info,
    );
    info.ceilings = { claude: { fiveHour: 0.5, weekly: 0.6 } };
    info.allowPaidUsage = { claude: true };
    ctx.db.query('UPDATE runners SET info = $info WHERE id = $id').run({ id: r3, info: JSON.stringify(info) });
    const runner = placementSnapshot(ctx).runners.find((slot) => slot.id === r3);
    expect(runner?.vendors[0]).toMatchObject({ ceilings: { fiveHour: 0.5, weekly: 0.6 }, allowPaidUsage: true });
  });

  test('retired runners are left out', () => {
    const { ctx, r2 } = setup();
    ctx.db.query('UPDATE runners SET retired_at = $now WHERE id = $id').run({ id: r2, now: ctx.now() });
    expect(placementSnapshot(ctx).runners.map((runner) => runner.id)).not.toContain(r2);
  });
});

describe("core's placement rules over the snapshot", () => {
  test("an account exhausted by one runner is refused on every runner of the owner's until resetsAt", () => {
    const { ctx, clock, r1, r3 } = setup();
    const r4 = addRunner(ctx, { vendors: ['claude'] });
    // R-4 reports the exhaustion; R-1 shares the account.
    upsert(ctx, 'alice', r4, report('claude', { state: 'exhausted', resetsAt: ctx.now() + HOUR, updatedAt: ctx.now() }));
    const refusals = () => {
      const snapshot = placementSnapshot(ctx);
      return snapshot.runners.map((runner) => [runner.id, usableVendors(snapshot, runner).refused]);
    };
    const now = refusals();
    expect(now.find(([id]) => id === r1)?.[1]).toEqual([
      { runnerId: r1, vendor: 'claude', refusal: 'exhausted' },
      // codex is degraded on R-1.
      { runnerId: r1, vendor: 'codex', refusal: 'degraded' },
    ]);
    expect(now.find(([id]) => id === r4)?.[1]).toEqual([{ runnerId: r4, vendor: 'claude', refusal: 'exhausted' }]);
    expect(now.find(([id]) => id === r3)?.[1]).toEqual([]);
    clock.advance(HOUR);
    expect(refusals().find(([id]) => id === r4)?.[1]).toEqual([]);
  });

  test('freeSlots counts open attempts, a lead included', () => {
    const { ctx, r1, worker } = setup();
    const snapshot = placementSnapshot(ctx);
    const runner = snapshot.runners.find((slot) => slot.id === r1);
    expect(runner && freeSlots(runner)).toBe(0);
    expect(candidateRunners(snapshot).refused).toContainEqual({ runnerId: r1, vendor: null, refusal: 'full' });
    updateAttempt(ctx, worker.attempt.id, { status: 'ended', endReason: 'crashed', leaseExpiresAt: null });
    const after = placementSnapshot(ctx);
    const freed = after.runners.find((slot) => slot.id === r1);
    expect(freed && freeSlots(freed)).toBe(1);
    expect(candidateRunners(after).candidates.map((slot) => slot.id)).toContain(r1);
  });
});

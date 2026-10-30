import { describe, expect, test } from 'bun:test';
import { type AccountQuotaReport, TEST_ACCOUNT_ID, type VendorQuota } from '@agflow/core';
import { getAttempt } from '../src/attempt-store';
import { startRunnerAttempt } from '../src/attempts';
import { createSession } from '../src/auth';
import { type HubContext, tx } from '../src/context';
import { listEvents } from '../src/events';
import { Gateway } from '../src/gateway';
import { accountFor, listAccounts, upsertAccountQuota } from '../src/quota';
import { createTasks } from '../src/tasks';
import { connectFakeRunner, settle } from './fake-runner';
import { addRunner, createTestContext, newTask, testVendor } from './helpers';

const HOUR = 60 * 60_000;

function quota(overrides: Partial<VendorQuota> = {}): VendorQuota {
  return {
    state: 'ok',
    resetsAt: null,
    windows: { fiveHour: 0.2, weekly: 0.1 },
    paidUsage: 'disabled',
    updatedAt: Date.UTC(2026, 9, 26, 11, 0, 0),
    ...overrides,
  };
}

const report = (overrides: Partial<VendorQuota> = {}, accountId = TEST_ACCOUNT_ID): AccountQuotaReport => ({
  vendor: 'claude',
  accountId,
  quota: quota(overrides),
});

const quotaEvents = (ctx: HubContext) =>
  listEvents(ctx.db).filter((event) => event.type === 'account.quota_changed');

const upsert = (ctx: HubContext, owner: string, quotaReport: AccountQuotaReport) =>
  tx(ctx, (emit) => upsertAccountQuota(ctx, emit, { owner, runnerId: 'R-1', report: quotaReport }));

describe('upsertAccountQuota', () => {
  test('keeps one row per owner, vendor and account, and emits only when the quota changes', () => {
    const { ctx } = createTestContext();
    expect(upsert(ctx, 'alice', report())).toBe(true);
    expect(accountFor(ctx, 'alice', 'claude', TEST_ACCOUNT_ID)).toEqual({
      owner: 'alice',
      vendor: 'claude',
      accountId: TEST_ACCOUNT_ID,
      quota: quota(),
      ownerAway: false,
    });
    const [first] = quotaEvents(ctx);
    expect(first).toMatchObject({
      actor: 'runner:R-1',
      subject: 'alice',
      data: { vendor: 'claude', accountId: TEST_ACCOUNT_ID, quota: quota() },
    });
    // The same reading, reported later: stored, with no event.
    const later = quota({ updatedAt: quota().updatedAt + 60_000 });
    expect(upsert(ctx, 'alice', { ...report(), quota: later })).toBe(false);
    expect(accountFor(ctx, 'alice', 'claude', TEST_ACCOUNT_ID)?.quota).toEqual(later);
    expect(quotaEvents(ctx)).toHaveLength(1);
    // A new state or new windows are a change.
    upsert(ctx, 'alice', report({ updatedAt: later.updatedAt + 1, windows: { fiveHour: 0.5, weekly: 0.1 } }));
    upsert(ctx, 'alice', report({ updatedAt: later.updatedAt + 2, state: 'exhausted', resetsAt: later.updatedAt + HOUR }));
    expect(quotaEvents(ctx)).toHaveLength(3);
    // Another owner, vendor or account is another row.
    upsert(ctx, 'bob', report());
    upsert(ctx, 'alice', { ...report(), vendor: 'codex' });
    upsert(ctx, 'alice', report({}, 'other-account'));
    expect(listAccounts(ctx).map((account) => [account.owner, account.vendor, account.accountId])).toEqual([
      ['alice', 'claude', TEST_ACCOUNT_ID],
      ['alice', 'claude', 'other-account'],
      ['alice', 'codex', TEST_ACCOUNT_ID],
      ['bob', 'claude', TEST_ACCOUNT_ID],
    ]);
    expect(listAccounts(ctx, { owner: 'bob' })).toHaveLength(1);
  });

  test('a report older than the stored one changes nothing, and the owner-away mark stays', () => {
    const { ctx } = createTestContext();
    upsert(ctx, 'alice', report({ state: 'exhausted', resetsAt: quota().updatedAt + HOUR }));
    ctx.db.query('UPDATE vendor_accounts SET owner_away = 1').run();
    expect(upsert(ctx, 'alice', report({ updatedAt: quota().updatedAt - 1 }))).toBe(false);
    expect(accountFor(ctx, 'alice', 'claude', TEST_ACCOUNT_ID)).toMatchObject({
      quota: { state: 'exhausted' },
      ownerAway: true,
    });
    upsert(ctx, 'alice', report({ updatedAt: quota().updatedAt + 1 }));
    expect(accountFor(ctx, 'alice', 'claude', TEST_ACCOUNT_ID)).toMatchObject({ quota: { state: 'ok' }, ownerAway: true });
  });

  const singleChanges: [string, Partial<VendorQuota>][] = [
    // As Codex reports it: exhausted, with the reset still unknown.
    ['state', { state: 'exhausted' }],
    ['resetsAt', { resetsAt: quota().updatedAt + HOUR }],
    ['paidUsage', { paidUsage: 'in_use' }],
    ['the five-hour window', { windows: { fiveHour: 0.6, weekly: 0.1 } }],
    ['the weekly window', { windows: { fiveHour: 0.2, weekly: 0.7 } }],
  ];
  for (const [what, change] of singleChanges) {
    test(`a change of ${what} alone is a change`, () => {
      const { ctx } = createTestContext();
      upsert(ctx, 'alice', report());
      expect(upsert(ctx, 'alice', report({ ...change, updatedAt: quota().updatedAt + 1 }))).toBe(true);
      expect(quotaEvents(ctx)).toHaveLength(2);
    });
  }

  test("a reading from a runner whose clock runs ahead is capped at the hub's clock", () => {
    const { ctx, clock } = createTestContext();
    const ahead = report({ state: 'exhausted', updatedAt: ctx.now() + 24 * HOUR });
    tx(ctx, (emit) => upsertAccountQuota(ctx, emit, { owner: 'alice', runnerId: 'R-1', report: ahead }));
    expect(accountFor(ctx, 'alice', 'claude', TEST_ACCOUNT_ID)?.quota.updatedAt).toBe(ctx.now());
    expect(quotaEvents(ctx)[0]?.data.quota).toMatchObject({ updatedAt: ctx.now() });
    // Two hours later another runner of alice's, with a correct clock, reads the account ok.
    clock.advance(2 * HOUR);
    const ok = report({ updatedAt: ctx.now() });
    expect(tx(ctx, (emit) => upsertAccountQuota(ctx, emit, { owner: 'alice', runnerId: 'R-2', report: ok }))).toBe(true);
    expect(accountFor(ctx, 'alice', 'claude', TEST_ACCOUNT_ID)?.quota).toEqual(ok.quota);
  });
});

describe('quota reports from runners', () => {
  async function setup() {
    const { ctx, clock } = createTestContext();
    const runnerId = addRunner(ctx, { vendors: ['claude', 'codex'] });
    const gateway = new Gateway(ctx);
    const runner = await connectFakeRunner(ctx, gateway, {
      token: createSession(ctx, 'alice', 'cli'),
      quota: () => [report({ windows: { fiveHour: 0.3, weekly: 0.2 } })],
    });
    return { ctx, clock, runnerId, runner };
  }

  test('hello, runner.vendors and attempt.quota update the owner account', async () => {
    const { ctx, runnerId, runner } = await setup();
    expect(accountFor(ctx, 'alice', 'claude', TEST_ACCOUNT_ID)?.quota.windows).toEqual({ fiveHour: 0.3, weekly: 0.2 });
    runner.emit('runner.vendors', {
      vendors: [testVendor('claude'), testVendor('codex')],
      quota: [{ ...report({ updatedAt: quota().updatedAt + 1 }), vendor: 'codex' }],
    });
    await settle();
    expect(accountFor(ctx, 'alice', 'codex', TEST_ACCOUNT_ID)?.quota.updatedAt).toBe(quota().updatedAt + 1);
    const [task] = createTasks(ctx, [newTask()], 'user:alice');
    const { attempt } = startRunnerAttempt(ctx, { runnerId, taskId: task?.id as string, role: 'worker', vendor: 'claude' });
    await settle();
    runner.startRunning(attempt.id);
    await settle();
    const exhausted = quota({ state: 'exhausted', resetsAt: ctx.now() + HOUR, updatedAt: ctx.now() });
    runner.emit(
      'attempt.quota',
      { vendor: 'claude', accountId: TEST_ACCOUNT_ID, quota: exhausted },
      { attemptId: attempt.id, fence: getAttempt(ctx, attempt.id).fence },
    );
    await settle();
    expect(ctx.db.query('SELECT type, error FROM runner_event_rejects').all()).toEqual([]);
    expect(accountFor(ctx, 'alice', 'claude', TEST_ACCOUNT_ID)?.quota).toEqual(exhausted);
    expect(quotaEvents(ctx).at(-1)?.data).toEqual({ vendor: 'claude', accountId: TEST_ACCOUNT_ID, quota: exhausted });
  });

  test("a runner's reports go to its own owner's account", async () => {
    const { ctx } = createTestContext();
    addRunner(ctx, { owner: 'bob' });
    await connectFakeRunner(ctx, new Gateway(ctx), {
      token: createSession(ctx, 'bob', 'cli'),
      quota: () => [report()],
    });
    expect(listAccounts(ctx).map((account) => [account.owner, account.vendor, account.accountId])).toEqual([
      ['bob', 'claude', TEST_ACCOUNT_ID],
    ]);
    expect(accountFor(ctx, 'bob', 'claude', TEST_ACCOUNT_ID)).not.toBeNull();
  });

  test('an attempt.quota with no account id updates no account', async () => {
    const { ctx, runnerId, runner } = await setup();
    const [task] = createTasks(ctx, [newTask()], 'user:alice');
    const { attempt } = startRunnerAttempt(ctx, { runnerId, taskId: task?.id as string, role: 'worker', vendor: 'claude' });
    await settle();
    runner.startRunning(attempt.id);
    await settle();
    const before = listAccounts(ctx);
    const events = quotaEvents(ctx).length;
    runner.emit(
      'attempt.quota',
      { vendor: 'claude', accountId: null, quota: quota({ state: 'exhausted', updatedAt: ctx.now() }) },
      { attemptId: attempt.id, fence: getAttempt(ctx, attempt.id).fence },
    );
    await settle();
    expect(ctx.db.query('SELECT type, error FROM runner_event_rejects').all()).toEqual([]);
    expect(listAccounts(ctx)).toEqual(before);
    expect(quotaEvents(ctx)).toHaveLength(events);
  });
});

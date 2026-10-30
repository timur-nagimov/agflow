// Vendor accounts (design 6.10, Quota belongs to the account): the quota of each (owner, vendor, accountId), shared by
// every runner of that owner logged in to the account, as hello, runner.vendors and attempt.quota report it. The
// placement rules that read it live only in core's usableVendors; placement.ts hands them these accounts.
import type { AccountQuota, AccountQuotaReport, AccountView, Vendor, VendorQuota } from '@agflow/core';
import type { HubContext } from './context';
import { notFound } from './errors';
import type { Emit } from './events';
import { findRunnerRow, runnerInfo } from './runners';

interface AccountRow {
  owner: string;
  vendor: Vendor;
  account_id: string;
  quota: string;
  owner_away: number;
  updated_at: number;
}

const rowToAccount = (row: AccountRow): AccountQuota => ({
  owner: row.owner,
  vendor: row.vendor,
  accountId: row.account_id,
  quota: JSON.parse(row.quota) as VendorQuota,
  ownerAway: row.owner_away === 1,
});

/** The stored account, or null when no runner of the owner has reported it. */
export function accountFor(ctx: HubContext, owner: string, vendor: Vendor, accountId: string): AccountQuota | null {
  const row = ctx.db
    .query('SELECT * FROM vendor_accounts WHERE owner = $owner AND vendor = $vendor AND account_id = $accountId')
    .get({ owner, vendor, accountId }) as AccountRow | null;
  return row ? rowToAccount(row) : null;
}

/** The accounts, of one owner or of everyone, by owner, vendor and account id. */
export function listAccounts(ctx: HubContext, options: { owner?: string } = {}): AccountQuota[] {
  const rows = ctx.db
    .query(
      `SELECT * FROM vendor_accounts WHERE $owner IS NULL OR owner = $owner ORDER BY owner, vendor, account_id`,
    )
    .all({ owner: options.owner ?? null }) as AccountRow[];
  return rows.map(rowToAccount);
}

/** Whether a reading differs from the stored one in anything but the time it was taken. */
function changed(stored: VendorQuota | null, next: VendorQuota): boolean {
  if (stored === null) return true;
  return (
    stored.state !== next.state ||
    stored.resetsAt !== next.resetsAt ||
    stored.paidUsage !== next.paidUsage ||
    stored.windows.fiveHour !== next.windows.fiveHour ||
    stored.windows.weekly !== next.windows.weekly
  );
}

export interface AccountReportInput {
  /** The owner of the runner that reported it: an account is shared only by one owner's runners. */
  owner: string;
  runnerId: string;
  report: AccountQuotaReport;
}

/**
 * Stores a runner's quota report for its owner's account (design 6.10): one row per (owner, vendor, accountId), so an
 * exhaustion one runner reports holds for every runner of the owner on that account. A report older than the stored
 * one, as a runner's cached reading at its hello can be, changes nothing; the owner-away mark is the hub's and stays.
 * account.quota_changed goes out only when the reading changed, not for every report of the same one. Returns
 * whether it did.
 */
export function upsertAccountQuota(ctx: HubContext, emit: Emit, input: AccountReportInput): boolean {
  const { owner, report } = input;
  // A reading cannot come from the future: capped at the hub's clock, a runner whose clock runs ahead cannot outrank
  // the later readings of the owner's other runners.
  const quota = { ...report.quota, updatedAt: Math.min(report.quota.updatedAt, ctx.now()) };
  const stored = accountFor(ctx, owner, report.vendor, report.accountId);
  if (stored && quota.updatedAt < stored.quota.updatedAt) return false;
  ctx.db
    .query(
      `INSERT INTO vendor_accounts (owner, vendor, account_id, quota, owner_away, updated_at)
       VALUES ($owner, $vendor, $accountId, $quota, 0, $now)
       ON CONFLICT (owner, vendor, account_id) DO UPDATE SET quota = excluded.quota, updated_at = excluded.updated_at`,
    )
    .run({
      owner,
      vendor: report.vendor,
      accountId: report.accountId,
      quota: JSON.stringify(quota),
      now: ctx.now(),
    });
  if (!changed(stored?.quota ?? null, quota)) return false;
  emit({
    type: 'account.quota_changed',
    actor: `runner:${input.runnerId}`,
    subject: owner,
    data: { vendor: report.vendor, accountId: report.accountId, quota },
  });
  return true;
}

/** Stores the account reports of a hello, a runner.vendors or an attempt.quota, for the runner's owner. */
export function recordQuotaReports(
  ctx: HubContext,
  emit: Emit,
  runnerId: string,
  reports: readonly AccountQuotaReport[],
): void {
  if (reports.length === 0) return;
  const row = findRunnerRow(ctx, runnerId);
  if (!row) throw notFound(`runner ${runnerId}`);
  for (const report of reports) upsertAccountQuota(ctx, emit, { owner: row.owner, runnerId, report });
}

const accountKey = (owner: string, vendor: Vendor, accountId: string): string =>
  JSON.stringify([owner, vendor, accountId]);

/**
 * The accounts as placement reads them (core's AccountView): each with its vendor's starting, running and quota_wait
 * attempts on the owner's runners that report being logged in to it, which core's probing start for an unknown
 * reset waits on.
 */
export function accountViews(ctx: HubContext): AccountView[] {
  const open = ctx.db
    .query(
      `SELECT runners.owner, attempts.vendor, runners.info, COUNT(*) AS n
       FROM attempts JOIN runners ON runners.id = attempts.runner_id
       WHERE attempts.status IN ('starting', 'running', 'quota_wait')
       GROUP BY attempts.runner_id, attempts.vendor`,
    )
    .all() as { owner: string; vendor: Vendor; info: string; n: number }[];
  const counts = new Map<string, number>();
  for (const row of open) {
    const accountId = runnerInfo(row).vendors.find((slot) => slot.vendor === row.vendor)?.accountId ?? null;
    if (accountId === null) continue;
    const key = accountKey(row.owner, row.vendor, accountId);
    counts.set(key, (counts.get(key) ?? 0) + row.n);
  }
  return listAccounts(ctx).map((account) => ({
    ...account,
    openAttempts: counts.get(accountKey(account.owner, account.vendor, account.accountId)) ?? 0,
  }));
}

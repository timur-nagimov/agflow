// Vendor accounts (design 6.10, Quota belongs to the account): the quota of each (owner, vendor, accountId), shared by
// every runner of that owner logged in to the account, as hello, runner.vendors and attempt.quota report it. The
// placement rules that read it live only in core's usableVendors; placement.ts hands them these accounts.
import type { AccountQuota, AccountQuotaReport, AccountView, Vendor, VendorQuota } from '@agflow/core';
import { enqueueCommand } from './commands';
import { type HubContext, tx } from './context';
import { notFound } from './errors';
import type { Emit } from './events';
import { type RunnerRow, findRunnerRow, findRunnerRows, runnerInfo } from './runners';

interface AccountRow {
  owner: string;
  vendor: Vendor;
  account_id: string;
  quota: string;
  owner_away: number;
  updated_at: number;
}

/**
 * vendor_accounts.owner_away: 0 while the owner is present; 1 once an expiry marked them away; 2 once the lead was
 * told that ready work waits on it, which happens once per away period (design 6.10, Owner away).
 */
const OWNER_PRESENT = 0;
const OWNER_AWAY = 1;
const OWNER_AWAY_TOLD = 2;

const rowToAccount = (row: AccountRow): AccountQuota => ({
  owner: row.owner,
  vendor: row.vendor,
  accountId: row.account_id,
  quota: JSON.parse(row.quota) as VendorQuota,
  ownerAway: row.owner_away !== OWNER_PRESENT,
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

// ---------------------------------------------------------------------------
// Owner away (design 6.10)
// ---------------------------------------------------------------------------

/** The reading of an account no runner has reported yet: older than any report, so the first one replaces it. */
const UNREPORTED: VendorQuota = {
  state: 'unknown',
  resetsAt: null,
  windows: { fiveHour: null, weekly: null },
  paidUsage: 'unknown',
  updatedAt: 0,
};

export interface OwnerAwayInput {
  owner: string;
  vendor: Vendor;
  /** The account the approval's runner reports for the vendor; null marks every account of the owner on the vendor. */
  accountId: string | null;
  /** The approval whose expiry marks the owner away. */
  approvalId: string;
}

/**
 * Marks the owner's account for the vendor away after an approval expired (design 6.10, Owner away; X-39): core's
 * usableVendors then places no new attempts of that vendor on any of the owner's runners logged in to it. An account
 * without a quota report is stored with an unknown reading to carry the mark. account.owner_away goes out for each
 * account newly marked. Returns how many.
 */
export function setOwnerAway(ctx: HubContext, emit: Emit, input: OwnerAwayInput): number {
  const { owner, vendor, accountId, approvalId } = input;
  const marked = (
    accountId === null
      ? ctx.db
          .query(
            `UPDATE vendor_accounts SET owner_away = $away WHERE owner = $owner AND vendor = $vendor
               AND owner_away = $present
             RETURNING account_id`,
          )
          .all({ owner, vendor, away: OWNER_AWAY, present: OWNER_PRESENT })
      : ctx.db
          .query(
            `INSERT INTO vendor_accounts (owner, vendor, account_id, quota, owner_away, updated_at)
             VALUES ($owner, $vendor, $accountId, $quota, $away, $now)
             ON CONFLICT (owner, vendor, account_id) DO UPDATE SET owner_away = $away
               WHERE vendor_accounts.owner_away = $present
             RETURNING account_id`,
          )
          .all({
            owner,
            vendor,
            accountId,
            quota: JSON.stringify(UNREPORTED),
            now: ctx.now(),
            away: OWNER_AWAY,
            present: OWNER_PRESENT,
          })
  ) as { account_id: string }[];
  for (const row of marked) {
    emit({
      type: 'account.owner_away',
      actor: 'system',
      subject: owner,
      data: { vendor, accountId: row.account_id, approvalId },
    });
  }
  return marked.length;
}

/**
 * Clears every owner-away mark of the owner, when they act (X-39): any approval decision of theirs, or a PATCH of one
 * of their runners (task 52). Returns how many accounts it cleared.
 */
export function clearOwnerAway(ctx: HubContext, owner: string): number {
  return ctx.db
    .query('UPDATE vendor_accounts SET owner_away = $present WHERE owner = $owner AND owner_away != $present')
    .run({ owner, present: OWNER_PRESENT }).changes;
}

/**
 * Records that the lead was told about the account's owner being away; false when it already was in this away period,
 * or the owner is not away. The scheduler tells the lead only when this returns true.
 */
export function markOwnerAwayTold(
  ctx: HubContext,
  account: Pick<AccountQuota, 'owner' | 'vendor' | 'accountId'>,
): boolean {
  return (
    ctx.db
      .query(
        `UPDATE vendor_accounts SET owner_away = $told
         WHERE owner = $owner AND vendor = $vendor AND account_id = $accountId AND owner_away = $away`,
      )
      .run({
        owner: account.owner,
        vendor: account.vendor,
        accountId: account.accountId,
        told: OWNER_AWAY_TOLD,
        away: OWNER_AWAY,
      }).changes === 1
  );
}

// ---------------------------------------------------------------------------
// Unknown reset times (design 6.10)
// ---------------------------------------------------------------------------

/** The owner's runners logged in to the account, in runner order. */
const runnersOn = (ctx: HubContext, account: AccountQuota): RunnerRow[] =>
  findRunnerRows(ctx).filter(
    (row) =>
      row.owner === account.owner &&
      runnerInfo(row).vendors.some((slot) => slot.vendor === account.vendor && slot.accountId === account.accountId),
  );

/** When the hub last sent a Codex preflight to one of the runners, or null. */
function lastCodexPreflight(ctx: HubContext, runnerIds: readonly string[]): number | null {
  if (runnerIds.length === 0) return null;
  const row = ctx.db
    .query(
      `SELECT MAX(created_at) AS at FROM runner_commands
       WHERE kind = 'preflight' AND json_extract(payload, '$.vendor') = 'codex'
         AND runner_id IN (SELECT value FROM json_each($runnerIds))`,
    )
    .get({ runnerIds: JSON.stringify(runnerIds) }) as { at: number | null };
  return row.at;
}

/**
 * The Codex reset probe (design 6.10, Unknown reset times; X-14). An exhausted Codex account whose reset is unknown
 * gets one preflight { vendor: 'codex' }, on the first online runner of its owner logged in to it, once quotaUnknownMs
 * has passed since the report and since the last Codex preflight to those runners: preflight reads the account's rate
 * limits, and its runner.vendors answer lifts the exhaustion. Claude's probe is its next start (core's usableVendors).
 * One account's failure is logged and leaves the others probed. Returns how many preflights it sent.
 */
export function probeUnknownResets(ctx: HubContext): number {
  const now = ctx.now();
  const wait = ctx.config.quotaUnknownMs;
  let sent = 0;
  for (const account of listAccounts(ctx)) {
    const { quota } = account;
    if (account.vendor !== 'codex' || quota.state !== 'exhausted' || quota.resetsAt !== null) continue;
    if (now < quota.updatedAt + wait) continue;
    const runners = runnersOn(ctx, account);
    const last = lastCodexPreflight(ctx, runners.map((row) => row.id));
    if (last !== null && now < last + wait) continue;
    const online = runners.find((row) => row.state === 'online');
    if (!online) continue;
    try {
      tx(ctx, () => enqueueCommand(ctx, online.id, { kind: 'preflight', vendor: 'codex' }));
      sent += 1;
    } catch (error) {
      console.error(`probing the reset of ${account.owner}'s codex account ${account.accountId} failed`, error);
    }
  }
  return sent;
}

// The placement snapshot (design 6.6, step 5): core's PlacementSnapshot, built from the database. The rules that read
// it live only in core (candidateRunners, usableVendors, freeSlots; X-46); the scheduler and rejectTask's ladder step 1
// share this one view of runners, their vendor holds and refusals, their open attempts and the owners' accounts.
import type { PlacementSnapshot, RunnerSlot, Vendor, VendorSlot } from '@agflow/core';
import type { HubContext } from './context';
import { accountViews } from './quota';
import { type RunnerRow, findRunnerRows, runnerInfo, vendorHolds } from './runners';

/** A runner as placement sees it: the hub's holds and its copy of the runner's settings over the runner's report. */
function runnerSlot(row: RunnerRow): RunnerSlot {
  const info = runnerInfo(row);
  const holds = vendorHolds(row);
  const vendors: VendorSlot[] = info.vendors.map((reported) => {
    const hold = holds[reported.vendor];
    return {
      vendor: reported.vendor,
      ready: reported.ready,
      notReadySince: hold?.notReadySince ?? null,
      degradedUntil: hold?.degradedUntil ?? null,
      accountId: reported.accountId,
      ceilings: info.ceilings[reported.vendor] ?? reported.ceilings,
      allowPaidUsage: info.allowPaidUsage[reported.vendor] ?? reported.allowPaidUsage,
    };
  });
  return {
    id: row.id,
    owner: row.owner,
    state: row.state,
    draining: row.draining === 1,
    gitReady: info.git.ready,
    acceptingUntil: row.accepting_until,
    startRefusal: info.startRefusal ?? null,
    capacity: row.capacity,
    openAttempts: row.active_attempts,
    power: info.power,
    vendors,
  };
}

/**
 * What placement reads now: every runner that is not retired, in id order, and every account. The scheduler updates
 * it after each placement it makes in one tick; anything else builds a new one.
 */
export function placementSnapshot(ctx: HubContext): PlacementSnapshot {
  return {
    now: ctx.now(),
    quotaUnknownMs: ctx.config.quotaUnknownMs,
    runners: findRunnerRows(ctx).map(runnerSlot),
    accounts: accountViews(ctx),
  };
}

/**
 * The snapshot without the account an attempt draws on: its vendor on its runner, and on every runner of the same
 * owner logged in to the same account. A quota_wait replacement, and the lead after one, go to another account: a
 * wait that left its account usable (a limit of one model, or paid usage its runner refuses) would meet the same limit
 * there. The runners are copies; the accounts are the snapshot's own, so a placement still counts on them.
 */
export function withoutAccountOf(
  snapshot: PlacementSnapshot,
  attempt: { runnerId: string | null; vendor: Vendor },
): PlacementSnapshot {
  const home = snapshot.runners.find((runner) => runner.id === attempt.runnerId);
  const accountId = home?.vendors.find((slot) => slot.vendor === attempt.vendor)?.accountId ?? null;
  const sameAccount = (runner: RunnerSlot, slot: VendorSlot): boolean =>
    accountId !== null && runner.owner === home?.owner && slot.accountId === accountId;
  const same = (runner: RunnerSlot, slot: VendorSlot): boolean =>
    slot.vendor === attempt.vendor && (runner.id === attempt.runnerId || sameAccount(runner, slot));
  return {
    ...snapshot,
    runners: snapshot.runners.map((runner) => ({
      ...runner,
      vendors: runner.vendors.filter((slot) => !same(runner, slot)),
    })),
  };
}

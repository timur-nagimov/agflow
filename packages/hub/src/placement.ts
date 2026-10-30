// The placement snapshot (design 6.6, step 5): core's PlacementSnapshot, built from the database. The rules that read
// it live only in core (candidateRunners, usableVendors, freeSlots; X-46); the scheduler and rejectTask's ladder step 1
// share this one view of runners, their vendor holds and refusals, their open attempts and the owners' accounts.
import type { PlacementSnapshot, RunnerSlot, VendorSlot } from '@agflow/core';
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

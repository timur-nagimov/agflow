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
      limitedUntil: hold?.limitedUntil ?? {},
      accountId: reported.accountId,
      ceilings: info.ceilings[reported.vendor] ?? reported.ceilings,
      allowPaidUsage: info.allowPaidUsage[reported.vendor] ?? reported.allowPaidUsage,
    };
  });
  return {
    id: row.id,
    machineId: row.machine_id,
    owner: row.owner,
    state: row.state,
    draining: row.draining === 1,
    gitReady: info.git.ready,
    acceptingUntil: row.accepting_until,
    startRefusal: info.startRefusal ?? null,
    capacity: row.capacity,
    openAttempts: row.active_attempts,
    power: info.power,
    profile: info.profile.name,
    vendors,
  };
}

/**
 * What placement reads now: every runner that is not retired, in id order, and every account. The scheduler updates
 * it after each placement it makes in one tick; anything else builds a new one.
 */
export function placementSnapshot(ctx: HubContext, ignoreAttemptId?: string): PlacementSnapshot {
  return {
    now: ctx.now(),
    quotaUnknownMs: ctx.config.quotaUnknownMs,
    runners: findRunnerRows(ctx).map(runnerSlot),
    accounts: accountViews(ctx),
    resourceHolders: (ctx.db.query(`
      SELECT attempts.id AS attemptId, runners.machine_id AS machineId,
        json_extract(tasks.contract, '$.placement.resourceGroup') AS "group"
      FROM attempts JOIN runners ON runners.id = attempts.runner_id JOIN tasks ON tasks.id = attempts.task_id
      WHERE attempts.status != 'ended'
        AND json_extract(tasks.contract, '$.placement.resourceGroup') IS NOT NULL
    `).all() as NonNullable<PlacementSnapshot['resourceHolders']>).filter((holder) => holder.attemptId !== ignoreAttemptId),
  };
}

// GET /api/load: how busy each account and the project are, for people watching a run. The accounts are read with
// core's placement rules over the placement snapshot, so a row says what placement would do now. The project's workers,
// slots and task counts are the scheduler's (workerLoad, runnerSlots), the same the lead's report and the idle nudge
// read; the free slot minutes come from the scheduler's samples, which it keeps in memory.
import {
  type AccountLoad,
  type HubLoad,
  type ProjectLoad,
  type TaskStatus,
  type Vendor,
  candidateRunners,
  reportHolds,
  usableVendors,
  utilization,
} from '@agflow/core';
import type { HubContext } from './context';
import { placementSnapshot } from './placement';
import { getProject } from './project';
import { TAKES_SLOT_SQL, findRunnerRows, runnerInfo } from './runners';
import { ACCEPTED_NOT_MERGED, SUBMITTED, idleSlotMinutes, runnerSlots, workerLoad } from './scheduler';
import { listTasks } from './task-store';

const HOUR = 60 * 60_000;

/** Of several runners' states for one account, the one a row shows: usable first, offline last. */
const rank = (state: AccountLoad['state']): number => (state === 'ok' ? 0 : state === 'offline' ? 2 : 1);

/**
 * One row per account (owner, vendor and account id) that a runner of the owner reports. Its taken and total slots
 * count the owner's runners logged in to it that are online and not draining, and the vendor's attempts there that
 * take a slot (TAKES_SLOT_SQL: a lead and a quota wait take none); its windows read as placement reads them, a window
 * that has reset since the report as unknown; its state is 'ok' when one of those runners can take an attempt of the
 * vendor now, and otherwise the vendor's refusal there, or the runner's.
 */
function accountLoads(ctx: HubContext): AccountLoad[] {
  const snapshot = placementSnapshot(ctx);
  const runnerRefusals = new Map(candidateRunners(snapshot).refused.map((one) => [one.runnerId, one.refusal]));
  const plans = new Map(
    findRunnerRows(ctx).map((row) => [row.id, new Map(runnerInfo(row).vendors.map((one) => [one.vendor, one.plan]))]),
  );
  const open = ctx.db
    .query(
      `SELECT runner_id AS runnerId, vendor, COUNT(*) AS n FROM attempts
       WHERE runner_id IS NOT NULL AND ${TAKES_SLOT_SQL} GROUP BY runner_id, vendor`,
    )
    .all() as { runnerId: string; vendor: Vendor; n: number }[];
  const busyOn = (runnerId: string, vendor: Vendor): number =>
    open.find((row) => row.runnerId === runnerId && row.vendor === vendor)?.n ?? 0;
  const rows = new Map<string, AccountLoad>();
  for (const runner of snapshot.runners) {
    const vendorRefusals = usableVendors(snapshot, runner).refused;
    for (const slot of runner.vendors) {
      const account =
        snapshot.accounts.find(
          (one) => one.owner === runner.owner && one.vendor === slot.vendor && one.accountId === slot.accountId,
        ) ?? null;
      const state =
        vendorRefusals.find((one) => one.vendor === slot.vendor)?.refusal ?? runnerRefusals.get(runner.id) ?? 'ok';
      const key = JSON.stringify([runner.owner, slot.vendor, slot.accountId]);
      let row = rows.get(key);
      if (!row) {
        const holds = account !== null && reportHolds(snapshot, account);
        const placed = utilization(account, holds);
        // A reading placement no longer counts is a window that has reset since the report.
        const reading = (window: 'fiveHour' | 'weekly'): number | null => {
          const value = account?.quota.windows[window] ?? null;
          return value === null || placed[window] !== value ? null : value;
        };
        const resetsAt = account?.quota.resetsAt ?? null;
        row = {
          owner: runner.owner,
          vendor: slot.vendor,
          accountId: slot.accountId,
          plan: null,
          busy: 0,
          capacity: 0,
          fiveHour: reading('fiveHour'),
          weekly: reading('weekly'),
          ceilings: { ...slot.ceilings },
          resetsAt: resetsAt !== null && resetsAt > snapshot.now ? resetsAt : null,
          state,
        };
        rows.set(key, row);
      }
      row.plan ??= plans.get(runner.id)?.get(slot.vendor) ?? null;
      if (runner.state === 'online' && !runner.draining) {
        row.busy += busyOn(runner.id, slot.vendor);
        row.capacity += runner.capacity;
      }
      row.ceilings = {
        fiveHour: Math.min(row.ceilings.fiveHour, slot.ceilings.fiveHour),
        weekly: Math.min(row.ceilings.weekly, slot.ceilings.weekly),
      };
      if (rank(state) < rank(row.state)) row.state = state;
    }
  }
  return [...rows.values()];
}

/** The time of the task's latest acceptance, from its events. */
function acceptedAt(ctx: HubContext, taskId: string): number | null {
  const row = ctx.db
    .query("SELECT MAX(ts) AS ts FROM events WHERE subject = $taskId AND type = 'task.accepted'")
    .get({ taskId }) as { ts: number | null };
  return row.ts;
}

/** The age of the oldest of the times, as of now; null for none. */
function oldestAge(now: number, times: readonly number[]): number | null {
  return times.length === 0 ? null : now - Math.min(...times);
}

/** The project's numbers: the counts are workerLoad's, and the tasks it counts give the ages. */
function projectLoad(ctx: HubContext): ProjectLoad {
  const now = ctx.now();
  const load = workerLoad(ctx);
  const tasks = listTasks(ctx);
  const inStatus = (statuses: readonly TaskStatus[]) => tasks.filter((task) => statuses.includes(task.status));
  const submitted = inStatus(SUBMITTED);
  const accepted = inStatus(ACCEPTED_NOT_MERGED);
  const merged = ctx.db
    .query("SELECT COUNT(DISTINCT subject) AS n FROM events WHERE type = 'task.merged' AND ts > $since")
    .get({ since: now - HOUR }) as { n: number };
  const { deadlineAt } = getProject(ctx);
  return {
    workers: { running: load.running, target: load.target, cap: load.cap },
    slots: runnerSlots(ctx),
    idleSlotMinutes: idleSlotMinutes(ctx),
    tasks: {
      ready: load.ready,
      dispatchable: load.dispatchable,
      blockedOnDependencies: load.blockedOnDependencies,
      submitted: {
        count: load.submitted,
        oldestAgeMs: oldestAge(now, submitted.map((task) => task.submission?.submittedAt ?? task.updatedAt)),
      },
      acceptedNotMerged: {
        count: load.acceptedNotMerged,
        oldestAgeMs: oldestAge(now, accepted.map((task) => acceptedAt(ctx, task.id) ?? task.updatedAt)),
      },
      mergedLastHour: merged.n,
    },
    deadline: { at: deadlineAt, leftMs: deadlineAt === null ? null : deadlineAt - now },
  };
}

/** GET /api/load's answer. */
export function loadOf(ctx: HubContext): HubLoad {
  return { now: ctx.now(), accounts: accountLoads(ctx), project: projectLoad(ctx) };
}

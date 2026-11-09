import type { Project, Vendor } from '@agflow/core';
import { type HubContext, tx } from './context';

export function getProject(ctx: HubContext): Project {
  const row = ctx.db.query('SELECT name, repo, paused, runner_leads FROM project WHERE id = 1').get() as {
    name: string;
    repo: string;
    paused: number;
    runner_leads: number;
  };
  return { name: row.name, repo: row.repo, paused: row.paused === 1, runnerLeads: row.runner_leads === 1 };
}

export function setPaused(ctx: HubContext, paused: boolean, actor: string): Project {
  return tx(ctx, (emit) => {
    const before = getProject(ctx);
    if (before.paused === paused) return before;
    ctx.db.query('UPDATE project SET paused = $paused WHERE id = 1').run({ paused: paused ? 1 : 0 });
    emit({ type: paused ? 'project.paused' : 'project.resumed', actor });
    return getProject(ctx);
  });
}

/** What request_agents sets (design 6.6): the worker target, and a vendor the scheduler prefers for a while. */
export interface Staffing {
  /** project.worker_target; null leaves the scheduler at maxWorkers. */
  workerTarget: number | null;
  /** project.vendor_pref, which counts until vendor_pref_until. */
  vendorPref: { vendor: Vendor; until: number } | null;
}

export function getStaffing(ctx: HubContext): Staffing {
  const row = ctx.db.query('SELECT worker_target, vendor_pref, vendor_pref_until FROM project WHERE id = 1').get() as {
    worker_target: number | null;
    vendor_pref: Vendor | null;
    vendor_pref_until: number | null;
  };
  return {
    workerTarget: row.worker_target,
    vendorPref:
      row.vendor_pref === null || row.vendor_pref_until === null
        ? null
        : { vendor: row.vendor_pref, until: row.vendor_pref_until },
  };
}

/** Sets project.worker_target, clamped to [0, maxWorkers]; 0 stops new dispatches without pausing. Returns it. */
export function setWorkerTarget(ctx: HubContext, count: number): number {
  const target = Math.min(Math.max(0, Math.floor(count)), ctx.config.maxWorkers);
  ctx.db.query('UPDATE project SET worker_target = $target WHERE id = 1').run({ target });
  return target;
}

/** The scheduler prefers the vendor for vendorPrefMs, after the ladder's requirement and the task's vendorHint. */
export function setVendorPreference(ctx: HubContext, vendor: Vendor): void {
  ctx.db
    .query('UPDATE project SET vendor_pref = $vendor, vendor_pref_until = $until WHERE id = 1')
    .run({ vendor, until: ctx.now() + ctx.config.vendorPrefMs });
}

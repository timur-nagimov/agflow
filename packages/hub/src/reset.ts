// A project reset (POST /api/operator/project/reset, which agflow start calls): a new project in place of the old one,
// on the same hub, without ssh. It replaces the manual procedure of draining runners, stopping the hub, moving the
// database aside, copying the sessions back and raising the epoch with the restore tool. People's sign-ins, runners and
// vendor accounts stay; the old project's work is archived and emptied.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Project, ProjectResetResult } from '@agflow/core';
import { archiveDatabase } from './backup';
import { type HubContext, afterCommit, tx } from './context';
import { GOING_AWAY_CLOSE } from './gateway';
import { updateGoal } from './goal';
import { hubEpoch, updateHubState } from './hub-state';
import { sendMessage } from './messages';
import { getProject } from './project';
import { clearOwnerAway } from './quota';
import { advanceIds } from './restore';
import { forgetFailedStarts } from './runners';
import { forgetSchedulerMemory } from './scheduler';

/** The project a reset sets up. */
export interface ProjectReset {
  name: string;
  repo: string;
  /** Epoch ms; null for none. */
  deadlineAt: number | null;
  /** Goal v1. */
  goal: string;
  /** Standing rules for everyone, posted in order. */
  rules: readonly string[];
}

/**
 * The tables of one project's work, emptied in this order, so no row is left pointing at a deleted one. Sessions, CLI
 * sign-ins, runners, their acknowledged outbox positions, vendor accounts and people's live agents stay.
 */
const PROJECT_TABLES = [
  'deliveries',
  'pending_deliveries',
  'messages',
  'task_fetch_grants',
  'agent_fetches',
  'approvals',
  'submissions',
  'attempt_log',
  'agent_tokens',
  'attempts',
  'task_notes',
  'tasks',
  'lead_notes',
  'goal_notes',
  'goal_versions',
  'events',
  'runner_event_rejects',
] as const;

/**
 * Resets the hub's project. First a copy of the whole database goes to the backup folder (archiveDatabase); then, in
 * one transaction:
 * - the project's tables are emptied, with the commands about its work and the agents of runner attempts; people's
 *   live agents hold no task any more;
 * - the project takes the new name, repository and deadline, unpaused, with no worker target or vendor preference;
 *   the lead seat, the churn guard, the review clock and the restore mark are cleared;
 * - every owner-away mark is cleared, and every runner's failed starts (forgetFailedStarts); the vendor accounts'
 *   quotas and limits stay;
 * - the epoch rises and the id counters advance as after a restore (advanceIds), so no new attempt id, branch or ref
 *   collides with what runners' journals and the repository already hold;
 * - project.reset is recorded, and project.deadline_set when there is a deadline, as the deadline routes record it; the
 *   goal is set and the rules are posted, as the operator's goal and message routes do.
 * Once it commits, what the scheduler keeps in memory (why tasks wait, the free slot samples, the idle nudge's clock)
 * starts afresh and every runner's link is closed. Each runner says hello again: the hub knows none of the attempts it
 * reports, so welcome.stop ends them, as after a restore, and the welcome names the new project, whose vault the
 * runner opens.
 */
export function resetProject(ctx: HubContext, input: ProjectReset, actor: string): ProjectResetResult {
  const archive = ctx.config.backupDir ? archiveDatabase(ctx, ctx.config.backupDir, getProject(ctx).name) : null;
  return tx(ctx, (emit) => {
    const previous = getProject(ctx).name;
    const epoch = hubEpoch(ctx) + 1;
    for (const table of PROJECT_TABLES) ctx.db.run(`DELETE FROM ${table}`);
    // A runner's own commands are not the project's: its settings echoes and preflights stay.
    ctx.db.run("DELETE FROM runner_commands WHERE kind NOT IN ('update_settings', 'preflight')");
    ctx.db.run("DELETE FROM agents WHERE origin = 'runner'");
    ctx.db.run('UPDATE agents SET current_task = NULL');
    ctx.db
      .query(
        `UPDATE project SET name = $name, repo = $repo, deadline_at = $deadlineAt, paused = 0, worker_target = NULL,
           vendor_pref = NULL, vendor_pref_until = NULL, epoch = $epoch
         WHERE id = 1`,
      )
      .run({ name: input.name, repo: input.repo, deadlineAt: input.deadlineAt, epoch });
    updateHubState(ctx, {
      leadAgentId: null,
      leadKind: null,
      leadSince: null,
      dispatchPausedUntil: null,
      lastLeadReviewAt: null,
      restoredAt: null,
    });
    // An owner the old project marked away would keep the new one off their accounts until they answer an approval or
    // change a runner, which may never come (with AGFLOW_AUTO_APPROVALS they answer none). The failed starts were the
    // old project's too.
    clearOwnerAway(ctx);
    forgetFailedStarts(ctx);
    // Nothing was replaced: the ids move past this database's own.
    advanceIds(ctx.db, { events: 0, messages: 0 });
    const project: Project = getProject(ctx);
    emit({
      type: 'project.reset',
      actor,
      data: { name: input.name, repo: input.repo, deadlineAt: input.deadlineAt, previous, epoch, archive },
    });
    // The same event as the deadline routes (setDeadline), so the timeline and the lead's report show it.
    const { deadlineAt } = input;
    if (deadlineAt !== null) emit({ type: 'project.deadline_set', actor, data: { deadlineAt } });
    const goal = updateGoal(ctx, { text: input.goal, baseVersion: 0 }, actor);
    for (const rule of input.rules) sendMessage(ctx, { from: actor, to: 'all', body: rule, standingRule: true });
    // The restore tool's floor (restore.ts), so a backup taken before the reset is restored at a higher epoch.
    const { backupDir } = ctx.config;
    if (backupDir) afterCommit(ctx, () => writeFileSync(join(backupDir, 'epoch'), `${epoch}\n`));
    afterCommit(ctx, () => forgetSchedulerMemory(ctx));
    const runners = ctx.db.query('SELECT id FROM runners WHERE connection_id IS NOT NULL').all() as { id: string }[];
    afterCommit(ctx, () => {
      for (const { id } of runners) ctx.link.closeRunner(id, GOING_AWAY_CLOSE, 'the project was reset; say hello again');
    });
    return { project, archive, epoch, goalVersion: goal.version };
  });
}

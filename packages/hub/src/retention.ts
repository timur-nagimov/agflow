// Hub housekeeping outside the tick (design 6.14 Backups, 6.18, X-39): the hourly and daily snapshots, and a daily
// retention run that trims old rows and asks a runner to delete the remote refs of tasks closed for a week. Ref
// cleanup deletes only refs whose sha the hub recorded, each fenced on that sha, so a ref someone moved since stays.
import { FullShaSchema, taskRefGlob } from '@agflow/core';
import { backupAndLog, dailyBackupDue } from './backup';
import { type CommandRow, RESULT_HANDLERS, enqueueCommand } from './commands';
import { type HubContext, tx } from './context';
import type { Emit } from './events';
import { findRunnerRows } from './runners';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/** How long each kind of row is kept (design 6.18). */
export const RETENTION = {
  /** A done, failed or cancelled command keeps its payload this long; its result stays. */
  commandPayloadMs: 7 * DAY,
  revokedTokenMs: 30 * DAY,
  decidedApprovalMs: 90 * DAY,
  eventRejectMs: 30 * DAY,
  /** How long after its task closed a task's remote refs are deleted. */
  refCleanupMs: 7 * DAY,
} as const;

/** What one retention run removed, and how many tasks' refs it asked a runner to delete. */
export interface RetentionReport {
  payloadsCleared: number;
  tokensDeleted: number;
  approvalsDeleted: number;
  rejectsDeleted: number;
  refCleanups: number;
}

/** The statuses whose task's refs go a week later: merged, cancelled or failed (design 6.18). */
const FINAL_STATUSES = ['merged', 'cancelled', 'failed'] as const;

/**
 * The daily retention run (design 6.18): commands lose their payload (a bare { kind } stays, so rows still read),
 * revoked agent tokens, decided approvals and event rejects go, and the tasks due for ref cleanup get their
 * delete_refs. The attempt log needs nothing here: every append keeps its attempt to the newest 500 rows.
 */
export function runRetention(ctx: HubContext): RetentionReport {
  const now = ctx.now();
  const removed = tx(ctx, () => ({
    payloadsCleared: ctx.db
      .query(
        `UPDATE runner_commands SET payload = json_object('kind', kind)
         WHERE status != 'pending' AND done_at <= $cutoff AND payload != json_object('kind', kind)`,
      )
      .run({ cutoff: now - RETENTION.commandPayloadMs }).changes,
    tokensDeleted: ctx.db
      .query('DELETE FROM agent_tokens WHERE revoked_at <= $cutoff')
      .run({ cutoff: now - RETENTION.revokedTokenMs }).changes,
    approvalsDeleted: ctx.db
      .query("DELETE FROM approvals WHERE status != 'pending' AND decided_at <= $cutoff")
      .run({ cutoff: now - RETENTION.decidedApprovalMs }).changes,
    rejectsDeleted: ctx.db
      .query('DELETE FROM runner_event_rejects WHERE at <= $cutoff')
      .run({ cutoff: now - RETENTION.eventRejectMs }).changes,
  }));
  return { ...removed, refCleanups: scheduleRefCleanup(ctx) };
}

/** The prefix of every remote ref of the task: its WIP, late-work and take-over refs. */
const taskRefPrefix = (ctx: HubContext, taskId: string): string =>
  taskRefGlob(ctx.config.wipRefPrefix, taskId).slice(0, -'*'.length);

/**
 * The task's remote refs whose sha the hub recorded, with the last sha recorded for each: the attempts' WIP refs, and
 * the refs of attempt.late_work and task.handed_back. A take-over ref nobody handed back from has no recorded sha.
 */
export function recordedRefs(ctx: HubContext, taskId: string): { ref: string; expectedSha: string }[] {
  const prefix = taskRefPrefix(ctx, taskId);
  const shas = new Map<string, string>();
  const record = (ref: string | null, sha: string | null) => {
    if (ref?.startsWith(prefix) && FullShaSchema.safeParse(sha).success) shas.set(ref, sha as string);
  };
  const wip = ctx.db
    .query(
      'SELECT wip_ref, wip_sha FROM attempts WHERE task_id = $taskId AND wip_sha IS NOT NULL ORDER BY number',
    )
    .all({ taskId }) as { wip_ref: string | null; wip_sha: string }[];
  for (const row of wip) record(row.wip_ref, row.wip_sha);
  const pushed = ctx.db
    .query(
      `SELECT json_extract(data, '$.ref') AS ref, json_extract(data, '$.sha') AS sha FROM events
       WHERE subject = $taskId AND type IN ('attempt.late_work', 'task.handed_back') ORDER BY id`,
    )
    .all({ taskId }) as { ref: string | null; sha: string | null }[];
  for (const row of pushed) record(row.ref, row.sha);
  return [...shas].map(([ref, expectedSha]) => ({ ref, expectedSha }));
}

/**
 * The delete_refs for refs of the task still waiting for their results, each with whether its runner can still answer
 * it: online and not retired.
 */
function pendingCleanups(ctx: HubContext, taskId: string): { id: string; answerable: boolean }[] {
  const rows = ctx.db
    .query(
      `SELECT DISTINCT runner_commands.id, runners.state = 'online' AND runners.retired_at IS NULL AS answerable
       FROM runner_commands JOIN runners ON runners.id = runner_commands.runner_id,
         json_each(runner_commands.payload, '$.refs') AS target
       WHERE runner_commands.kind = 'delete_refs' AND runner_commands.status = 'pending'
         AND substr(json_extract(target.value, '$.ref'), 1, length($prefix)) = $prefix`,
    )
    .all({ prefix: taskRefPrefix(ctx, taskId) }) as { id: string; answerable: number }[];
  return rows.map((row) => ({ id: row.id, answerable: row.answerable === 1 }));
}

/** The online runner that deletes the task's refs: the one of its last attempt, else the first online runner. */
function cleanupRunner(ctx: HubContext, taskId: string): string | null {
  const online = findRunnerRows(ctx).filter((row) => row.state === 'online');
  const last = ctx.db
    .query(
      'SELECT runner_id FROM attempts WHERE task_id = $taskId AND runner_id IS NOT NULL ORDER BY number DESC LIMIT 1',
    )
    .get({ taskId }) as { runner_id: string } | null;
  return (online.find((row) => row.id === last?.runner_id) ?? online[0])?.id ?? null;
}

/**
 * Ref cleanup (design 6.18, X-39): every task merged, cancelled or failed refCleanupMs ago or more, with no
 * task.refs_deleted yet and no delete_refs pending on a runner that can answer it, gets delete_refs for its recorded
 * refs, each fenced on its sha, on an online runner. One pending on a runner that went offline or was retired may never
 * be answered, so it is cancelled when the new one goes out: a late result for it is ignored, and as the deletes are
 * fenced, running both is harmless. A task with nothing recorded, or no runner online, waits for the next daily run.
 * Each task is its own transaction, so one failure leaves the others cleaned. Returns how many delete_refs went out.
 */
export function scheduleRefCleanup(ctx: HubContext): number {
  const placeholders = FINAL_STATUSES.map((status) => `'${status}'`).join(', ');
  const closedEvents = FINAL_STATUSES.map((status) => `'task.${status}'`).join(', ');
  const due = ctx.db
    .query(
      `SELECT id FROM tasks
       WHERE status IN (${placeholders})
         AND (SELECT MAX(ts) FROM events WHERE subject = tasks.id AND type IN (${closedEvents})) <= $cutoff
         AND NOT EXISTS (SELECT 1 FROM events WHERE subject = tasks.id AND type = 'task.refs_deleted')
       ORDER BY seq`,
    )
    .all({ cutoff: ctx.now() - RETENTION.refCleanupMs }) as { id: string }[];
  let sent = 0;
  for (const { id } of due) {
    try {
      const queued = tx(ctx, () => {
        const pending = pendingCleanups(ctx, id);
        if (pending.some((command) => command.answerable)) return false;
        const refs = recordedRefs(ctx, id);
        const runnerId = refs.length > 0 ? cleanupRunner(ctx, id) : null;
        if (runnerId === null) return false;
        const cancel = ctx.db.query(
          "UPDATE runner_commands SET status = 'cancelled', done_at = $now WHERE id = $id AND status = 'pending'",
        );
        for (const command of pending) cancel.run({ id: command.id, now: ctx.now() });
        enqueueCommand(ctx, runnerId, { kind: 'delete_refs', refs });
        return true;
      });
      if (queued) sent += 1;
    } catch (error) {
      console.error(`the ref cleanup of ${id} failed`, error);
    }
  }
  return sent;
}

/** A successful delete_refs records task.refs_deleted, which ends the daily retries for its task. */
function onRefsDeleted(ctx: HubContext, emit: Emit, command: CommandRow, ok: boolean): void {
  if (!ok || command.command.kind !== 'delete_refs') return;
  const refs = command.command.refs.map((target) => target.ref);
  const taskId = refs[0]?.slice(ctx.config.wipRefPrefix.length).split('/')[0];
  if (!taskId) return;
  emit({
    type: 'task.refs_deleted',
    actor: `runner:${command.runnerId}`,
    subject: taskId,
    data: { taskId, runnerId: command.runnerId, refs },
  });
}

RESULT_HANDLERS.delete_refs = (ctx, emit, command, result) => onRefsDeleted(ctx, emit, command, result.ok);

/** Starts a repeating timer; returns the function that stops it. Tests pass their own. */
export type Every = (ms: number, run: () => void) => () => void;

const realEvery: Every = (ms, run) => {
  const timer = setInterval(run, ms);
  return () => clearInterval(timer);
};

/**
 * Backups and retention on an hourly timer of their own, outside the tick (design 6.14, 6.18, X-39). Every hour: an
 * hourly snapshot, the daily one once the UTC day has none, and the retention run once a day. The first run comes an
 * hour after start, so a start writes only its own snapshots, and runners have reconnected to take the ref deletes;
 * a hub restarted more often than daily still runs retention an hour into each start. Returns the stop function.
 */
export function startHousekeeping(ctx: HubContext, backupDir: string, every: Every = realEvery): () => void {
  let lastRetention: number | null = null;
  return every(HOUR, () => {
    backupAndLog(ctx, backupDir, 'hourly');
    if (dailyBackupDue(ctx, backupDir)) backupAndLog(ctx, backupDir, 'daily');
    if (lastRetention !== null && ctx.now() - lastRetention < DAY) return;
    lastRetention = ctx.now();
    try {
      const report = runRetention(ctx);
      console.log(`retention: ${JSON.stringify(report)}`);
    } catch (error) {
      console.error('the retention run failed', error);
    }
  });
}

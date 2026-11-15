// main's check (AGFLOW_AUTO_MERGE). A submission's check runs on its branch with main merged in at submit time, but
// merge_task merges into the main of merge time with no check, so two changes that each pass alone can leave main
// broken, and then every later submission's check fails. agflow does not check before it pushes main, which would hold
// every merge behind a check: once a merge lands, one runner checks main as agflow last merged it (check_main), off the
// merge queue's path, and a failure gets a fix task at the top priority at once. What the checks gave is read from
// their main.checked events; no table holds it.
import {
  type Attempt,
  COMMAND_MIN_PROTOCOL,
  FullShaSchema,
  MainCheckResultSchema,
  type MainHealth,
  type NewTask,
  NewTaskSchema,
  type SubmissionCheck,
  type Task,
  minutesUntil,
  quoteLines,
} from '@agflow/core';
import { type CommandResult, type CommandRow, RESULT_HANDLERS, enqueueCommand } from './commands';
import { type HubContext, tx } from './context';
import type { Emit } from './events';
import { insertMessage } from './messages';
import { findRunnerRows, runnerInfo } from './runners';
import { findTask } from './task-store';
import { cancelTask, createTasks, creationGuard } from './tasks';
import { clip } from './text';

/** A task the system created with a title that starts so fixes main's check, whatever its title is now. */
export const FIX_MAIN_TITLE = 'Fix main:';

/** How long after a check_main that gave no result the next one for the same sha waits. */
export const MAIN_CHECK_RETRY_MS = 60_000;

/** The most of a check's output a main.checked event keeps: its end. */
const EVENT_TAIL_MAX = 2_000;

/** The most of a contract's objective (core's limit), which quotes the end of the check's output. */
const OBJECTIVE_MAX = 4_000;

/** The task ids a fix task's objective names at most. */
const TASKS_NAMED = 20;

const short = (sha: string): string => sha.slice(0, 7);

/** The end of a text in at most max characters. */
const lastChars = (text: string, max: number): string =>
  text.length <= max ? text : `…${text.slice(text.length - max + 1)}`;

/** A check's output, quoted line by line, in at most max characters: its last lines. */
function quotedTail(tail: string, max: number): string {
  const lines = quoteLines(tail.trimEnd() || '(no output)').split('\n');
  while (lines.length > 1 && lines.join('\n').length > max) lines.shift();
  const quoted = lines.join('\n');
  return quoted.length <= max ? quoted : `> …${quoted.slice(quoted.length - max + 3)}`;
}

/** main as agflow last merged it: the sha of the newest task.merged event that names one in full, and its task. */
function mergedMain(ctx: HubContext): { sha: string; taskId: string } | null {
  const row = ctx.db
    .query(
      `SELECT subject, json_extract(data, '$.sha') AS sha FROM events
       WHERE type = 'task.merged' AND length(json_extract(data, '$.sha')) = 40 ORDER BY id DESC LIMIT 1`,
    )
    .get() as { subject: string; sha: string } | null;
  return row && FullShaSchema.safeParse(row.sha).success ? { sha: row.sha, taskId: row.subject } : null;
}

/**
 * The check_main commands still waiting for a result, and whether their runner can still answer: online, not retired,
 * and not gone back to an older release, which is never sent the command.
 */
function pendingChecks(ctx: HubContext): { id: string; answerable: boolean }[] {
  const rows = ctx.db
    .query(
      `SELECT runner_commands.id,
         runners.state = 'online' AND runners.retired_at IS NULL AND runners.protocol >= $protocol AS answerable
       FROM runner_commands JOIN runners ON runners.id = runner_commands.runner_id
       WHERE runner_commands.kind = 'check_main' AND runner_commands.status = 'pending'`,
    )
    .all({ protocol: COMMAND_MIN_PROTOCOL.check_main }) as { id: string; answerable: number }[];
  return rows.map((row) => ({ id: row.id, answerable: row.answerable === 1 }));
}

/** When the newest check_main of the sha that came back ended; one that gave a result is a main.checked event. */
function lastTry(ctx: HubContext, sha: string): number | null {
  const row = ctx.db
    .query(
      `SELECT MAX(done_at) AS at FROM runner_commands
       WHERE kind = 'check_main' AND status IN ('done', 'failed') AND json_extract(payload, '$.sha') = $sha`,
    )
    .get({ sha }) as { at: number | null };
  return row.at;
}

/** Whether a check of the sha gave a result. */
function checked(ctx: HubContext, sha: string): boolean {
  return (
    ctx.db
      .query("SELECT 1 FROM events WHERE type = 'main.checked' AND json_extract(data, '$.sha') = $sha LIMIT 1")
      .get({ sha }) !== null
  );
}

/**
 * The runner that checks main: online, its git ready, speaking protocol 4, able to prepare dependencies (one with no
 * sandbox for them answers none, which is final for the sha), with the most free slots.
 */
function checkRunner(ctx: HubContext): string | null {
  const able = findRunnerRows(ctx).filter((row) => {
    const info = runnerInfo(row);
    return (
      row.state === 'online' &&
      row.protocol >= COMMAND_MIN_PROTOCOL.check_main &&
      info.git.ready &&
      info.profile.dependencyPrep
    );
  });
  const free = (row: (typeof able)[number]) => row.capacity - row.active_attempts;
  return able.sort((a, b) => free(b) - free(a))[0]?.id ?? null;
}

/**
 * Sends check_main for main as agflow last merged it, unless that sha has a result or a check is out on a runner that
 * can still answer; one whose runner went offline or was retired is cancelled. After a check that gave no result, the
 * next one for the same sha waits MAIN_CHECK_RETRY_MS. Called by every tick, and once a merge lands. Gives the
 * check_main it queued, or null.
 */
export function queueMainCheck(ctx: HubContext): CommandRow | null {
  if (!ctx.config.autoMerge) return null;
  return tx(ctx, () => {
    const cancel = ctx.db.query(
      "UPDATE runner_commands SET status = 'cancelled', done_at = $now WHERE id = $id AND status = 'pending'",
    );
    for (const pending of pendingChecks(ctx)) {
      if (pending.answerable) return null;
      cancel.run({ id: pending.id, now: ctx.now() });
    }
    const main = mergedMain(ctx);
    if (main === null || checked(ctx, main.sha)) return null;
    const tried = lastTry(ctx, main.sha);
    if (tried !== null && ctx.now() - tried < MAIN_CHECK_RETRY_MS) return null;
    const runnerId = checkRunner(ctx);
    return runnerId === null ? null : enqueueCommand(ctx, runnerId, { kind: 'check_main', sha: main.sha });
  });
}

/**
 * The fix-main tasks created after the event of that id, newest first, found by the title in their task.created event,
 * which update_task leaves.
 */
function fixTasks(ctx: HubContext, after: number): Task[] {
  const rows = ctx.db
    .query(
      `SELECT subject AS id FROM events
       WHERE type = 'task.created' AND actor = 'system' AND json_extract(data, '$.title') LIKE $title AND id > $after
       ORDER BY id DESC`,
    )
    .all({ title: `${FIX_MAIN_TITLE}%`, after }) as { id: string }[];
  return rows.flatMap((row) => findTask(ctx, row.id) ?? []);
}

/**
 * The fix-main task of main's failure now, if any: created since main's check last passed, and neither merged,
 * cancelled nor failed. One created before that pass fixed an older failure, even while an agent still works on it.
 */
export function openFixTask(ctx: HubContext): Task | null {
  const passed = ctx.db
    .query(
      `SELECT COALESCE(MAX(id), 0) AS id FROM events
       WHERE type = 'main.checked' AND json_extract(data, '$.status') = 'passed'`,
    )
    .get() as { id: number };
  return fixTasks(ctx, passed.id).find((task) => !['merged', 'cancelled', 'failed'].includes(task.status)) ?? null;
}

/**
 * main's check as its newest result that passed or failed left it: passed at a sha, or failing since the first failure
 * after the last pass, with the open fix task. A failure counts only at the sha agflow had merged last when it came:
 * one at an older sha waits for the newest's check, and nobody hears of it. Null without AGFLOW_AUTO_MERGE, and until
 * a check passed or failed.
 */
export function mainHealth(ctx: HubContext): MainHealth | null {
  if (!ctx.config.autoMerge) return null;
  const status = "json_extract(data, '$.status')";
  const passed = `type = 'main.checked' AND ${status} = 'passed'`;
  const failed = `type = 'main.checked' AND ${status} = 'failed' AND json_extract(data, '$.newest') = 1`;
  const newest = ctx.db
    .query(
      `SELECT ts, json_extract(data, '$.sha') AS sha, ${status} AS status FROM events
       WHERE (${passed}) OR (${failed}) ORDER BY id DESC LIMIT 1`,
    )
    .get() as { ts: number; sha: string; status: 'passed' | 'failed' } | null;
  if (newest === null) return null;
  if (newest.status === 'passed') return { status: 'passed', sha: newest.sha, at: newest.ts };
  const first = ctx.db
    .query(
      `SELECT json_extract(data, '$.sha') AS sha FROM events
       WHERE ${failed} AND id > (SELECT COALESCE(MAX(id), 0) FROM events WHERE ${passed})
       ORDER BY id LIMIT 1`,
    )
    .get() as { sha: string };
  return { status: 'failed', since: first.sha, fixTask: openFixTask(ctx)?.id ?? null };
}

/**
 * What an agent whose submission failed its check hears while main's own check fails and a fix task is open: that task
 * fixes main, and when the failure is not from its change, it calls declare_blocked, which parks its task until main
 * passes (waitsForMain). Empty otherwise, and for the fix task itself.
 */
export function mainFailingHint(ctx: HubContext, taskId: string): string {
  const health = mainHealth(ctx);
  if (health?.status !== 'failed' || health.fixTask === null || health.fixTask === taskId) return '';
  const main = ctx.config.mainBranch;
  const fix = health.fixTask;
  return (
    `\n${main}'s own check has failed since ${short(health.since)}; ${fix} fixes it. If the failure is not from your ` +
    `change, do not fix it in your branch: call declare_blocked with the reason "waiting for ${fix}". agflow then ` +
    `parks your task and starts it again once ${main}'s check passes.`
  );
}

/** How long a task parked while main's check fails stays out of dispatch at most, from the end of its attempt. */
export const PARK_MAX_MS = 45 * 60_000;

/**
 * Whether the attempt waits for main (AGFLOW_AUTO_MERGE): main's check fails, the attempt's task is not the fix task,
 * and the attempt's newest submission failed its check, which runs with main merged in. Such an attempt is parked
 * rather than blocked or stopped as stalled (tasks.ts blockTask, supervisor.ts): the hub replaces it, which counts
 * nothing and asks for a handoff note, tells nobody, and its task waits out of dispatch until main passes
 * (parkedTasks).
 */
export function waitsForMain(ctx: HubContext, attempt: Pick<Attempt, 'id' | 'taskId'>): boolean {
  const health = mainHealth(ctx);
  if (health?.status !== 'failed' || attempt.taskId === null || health.fixTask === attempt.taskId) return false;
  const newest = ctx.db
    .query(
      `SELECT status, error FROM submissions WHERE attempt_id = $attemptId
       ORDER BY requested_at DESC, rowid DESC LIMIT 1`,
    )
    .get({ attemptId: attempt.id }) as { status: string; error: string | null } | null;
  // A refusal's error is its code, then the runner's detail after a colon (submissions.ts).
  return newest?.status === 'failed' && /^check_failed(:|$)/.test(newest.error ?? '');
}

/** The reason of the stop that parks a task waiting for main, which its agent reads in the handoff prompt. */
export function parkReason(ctx: HubContext, taskId: string): string {
  const main = ctx.config.mainBranch;
  const health = mainHealth(ctx);
  const fix = health?.status === 'failed' && health.fixTask !== null ? ` and ${health.fixTask} fixes it` : '';
  return `${main}'s own check fails${fix}, so agflow parks ${taskId} until it passes, then starts ${taskId} again`;
}

/**
 * Why each parked task waits, while main's check fails: a ready task whose newest attempt the hub replaced because it
 * waited for main, within PARK_MAX_MS of that attempt's end. People and the lead replace an agent as themselves, so a
 * replace by system is a park. Dispatch leaves these tasks alone (scheduler.ts readySet); once main passes, or after
 * PARK_MAX_MS, they start as any ready task does.
 */
export function parkedTasks(ctx: HubContext): Map<string, string> {
  const health = mainHealth(ctx);
  if (health?.status !== 'failed') return new Map();
  const rows = ctx.db
    .query(
      `SELECT attempts.task_id AS taskId, attempts.ended_at AS endedAt FROM attempts
       JOIN tasks ON tasks.id = attempts.task_id
       WHERE tasks.status = 'ready' AND attempts.end_reason = 'replaced' AND attempts.ended_at > $since
         AND json_extract(attempts.stop_requested, '$.cause') = 'replace'
         AND json_extract(attempts.stop_requested, '$.by') = 'system'
         AND attempts.number = (SELECT MAX(number) FROM attempts AS newer WHERE newer.task_id = attempts.task_id)`,
    )
    .all({ since: ctx.now() - PARK_MAX_MS }) as { taskId: string; endedAt: number }[];
  const main = ctx.config.mainBranch;
  const fix = health.fixTask === null ? '' : ` (${health.fixTask} fixes it)`;
  const left = (endedAt: number) => minutesUntil(endedAt + PARK_MAX_MS, ctx.now());
  return new Map(
    rows.map((row) => [row.taskId, `it waits for ${main}'s check to pass${fix}, up to ${left(row.endedAt)} more min`]),
  );
}

/** The sha of the newest check of main that passed, or null. */
function lastPassed(ctx: HubContext): string | null {
  const row = ctx.db
    .query(
      `SELECT json_extract(data, '$.sha') AS sha FROM events
       WHERE type = 'main.checked' AND json_extract(data, '$.status') = 'passed' ORDER BY id DESC LIMIT 1`,
    )
    .get() as { sha: string } | null;
  return row?.sha ?? null;
}

/** Where main stands, for the deadline's message (deadline.ts). */
export interface MainStanding {
  /** main as agflow last merged it; null before its first merge. */
  sha: string | null;
  /** What the newest check of that sha gave; null while none gave a result. */
  check: SubmissionCheck['status'] | null;
  /** The newest sha whose check passed; null before any passed. */
  passed: string | null;
}

/** main as agflow last merged it, what its check gave, and the newest sha whose check passed. */
export function mainStanding(ctx: HubContext): MainStanding {
  const sha = mergedMain(ctx)?.sha ?? null;
  const newest =
    sha === null
      ? null
      : (ctx.db
          .query(
            `SELECT json_extract(data, '$.status') AS status FROM events
             WHERE type = 'main.checked' AND json_extract(data, '$.sha') = $sha ORDER BY id DESC LIMIT 1`,
          )
          .get({ sha }) as { status: SubmissionCheck['status'] } | null);
  return { sha, check: newest?.status ?? null, passed: lastPassed(ctx) };
}

/** The tasks merged since main's check last passed, up to the merge that made sha, in the order they were merged. */
function mergedSincePass(ctx: HubContext, sha: string): string[] {
  const mergeOf = (of: string | null) =>
    of === null
      ? 0
      : ((
          ctx.db
            .query("SELECT MAX(id) AS id FROM events WHERE type = 'task.merged' AND json_extract(data, '$.sha') = $sha")
            .get({ sha: of }) as { id: number | null }
        ).id ?? 0);
  const rows = ctx.db
    .query(
      `SELECT subject FROM events WHERE type = 'task.merged' AND id > $from AND id <= $to AND subject IS NOT NULL
       ORDER BY id`,
    )
    .all({ from: mergeOf(lastPassed(ctx)), to: mergeOf(sha) }) as { subject: string }[];
  return [...new Set(rows.map((row) => row.subject))];
}

/** The fix-main task's contract: main's check fails at sha, after the task that made it. */
export function fixMainContract(input: {
  main: string;
  sha: string;
  after: string;
  merged: readonly string[];
  check: Pick<SubmissionCheck, 'command' | 'tail'>;
}): NewTask {
  const { main } = input;
  const command = clip(input.check.command ?? "the project's check", 300);
  const named =
    input.merged.length > TASKS_NAMED
      ? `${input.merged.length} tasks, the last ${TASKS_NAMED}: ${input.merged.slice(-TASKS_NAMED).join(', ')}`
      : input.merged.join(', ') || input.after;
  const objective = [
    `The project's check \`${command}\` fails on ${main} at ${input.sha}, which agflow merged for ${input.after}.`,
    `Tasks merged since ${main}'s check last passed: ${named}.`,
    `Find the change that broke it and fix it, so the check passes on ${main} again. The end of its output:`,
  ].join(' ');
  return NewTaskSchema.parse({
    title: `${FIX_MAIN_TITLE} the check fails after ${input.after}`,
    objective: `${objective}\n${quotedTail(input.check.tail, OBJECTIVE_MAX - objective.length - 1)}`,
    why: `Every submission merges ${main} before its check, so while ${main} fails, every submission fails.`,
    nonGoals: [
      'Weakening, skipping or deleting tests.',
      "Changing the check's own files: .agflow/config.json and what its check command runs.",
    ],
    acceptance: [
      { id: 'A1', assertion: `The check \`${command}\` passes with ${main} merged in.` },
      { id: 'A2', assertion: 'No test was removed or skipped.' },
    ],
    priority: 0,
    tier: 'strong',
  });
}

/**
 * main's check failed at the sha agflow merged last: unless a fix task is open, one is created, at the top priority,
 * and people and the lead hear of it once, so the lead creates no other. A failure at an older sha waits for the check
 * of the newest, which the next merge's work may have fixed. Gives the task it created, or null.
 */
function mainFailed(
  ctx: HubContext,
  emit: Emit,
  sha: string,
  check: Pick<SubmissionCheck, 'command' | 'tail'>,
): Task | null {
  const main = mergedMain(ctx);
  if (main?.sha !== sha || openFixTask(ctx) !== null) return null;
  const branch = ctx.config.mainBranch;
  const merged = mergedSincePass(ctx, sha);
  const refusal = creationGuard(ctx, 1);
  const contract = fixMainContract({ main: branch, sha, after: main.taskId, merged, check });
  const [task] = refusal === null ? createTasks(ctx, [contract], 'system') : [];
  const command = clip(check.command ?? 'the check', 200);
  const failed = `${branch}'s check \`${command}\` fails at ${short(sha)}, after ${main.taskId} merged.`;
  const body = task
    ? `${failed} agflow created ${task.id} ("${task.title}") to fix it, at the top priority. The lead should not ` +
      'create another task for it.'
    : `${failed} agflow could not create a task to fix it: ${refusal}.`;
  for (const to of ['humans', 'lead']) insertMessage(ctx, emit, { from: 'system', to, taskId: task?.id, body });
  return task ?? null;
}

/**
 * The fix task the task limits kept mainFailed from creating, created once they allow it: main's check failed at the
 * sha agflow merged last, and no fix task was created since. People and the lead hear of it as from mainFailed, so the
 * lead, told that agflow could not create one, creates no other. Called by every tick; gives the task, or null.
 */
export function retryFixTask(ctx: HubContext): Task | null {
  const main = ctx.config.autoMerge ? mergedMain(ctx) : null;
  if (main === null) return null;
  const newest = ctx.db
    .query(
      `SELECT id, json_extract(data, '$.status') AS status, json_extract(data, '$.command') AS command,
         json_extract(data, '$.tail') AS tail
       FROM events WHERE type = 'main.checked' AND json_extract(data, '$.sha') = $sha ORDER BY id DESC LIMIT 1`,
    )
    .get({ sha: main.sha }) as { id: number; status: string; command: string | null; tail: string } | null;
  if (newest?.status !== 'failed' || fixTasks(ctx, newest.id).length > 0 || creationGuard(ctx, 1) !== null) return null;
  return tx(ctx, (emit) => mainFailed(ctx, emit, main.sha, newest));
}

/**
 * main's check passes again: people and the lead hear of it, and the failure's fix task, found before the pass was
 * recorded (after it, openFixTask finds none), is cancelled while it was never claimed: ready or blocked, with no
 * attempt. The tasks parked while it failed start again (parkedTasks).
 */
function mainPassesAgain(ctx: HubContext, emit: Emit, sha: string, since: string, fixTask: string | null): void {
  const main = ctx.config.mainBranch;
  const fix = fixTask === null ? null : findTask(ctx, fixTask);
  const unclaimed =
    fix !== null && fix.currentAttempt === null && (fix.status === 'ready' || fix.status === 'blocked');
  if (unclaimed) cancelTask(ctx, fix.id, `${main}'s check passes again at ${short(sha)}: no fix is needed.`, 'system');
  const body =
    `${main}'s check passes again at ${short(sha)}; it had failed since ${short(since)}.` +
    (unclaimed ? ` agflow cancelled ${fix.id}, which nobody had started.` : '');
  for (const to of ['humans', 'lead']) {
    insertMessage(ctx, emit, { from: 'system', to, taskId: unclaimed ? fix.id : undefined, body });
  }
}

/**
 * check_main's result (AGFLOW_AUTO_MERGE): main.checked records what the check gave and whether its sha was still the
 * one agflow merged last (newest); then a failure, or a pass after one, is dealt with. A command that failed, or data
 * agflow cannot read, records nothing: the tick asks again MAIN_CHECK_RETRY_MS later.
 */
function onMainCheckResult(ctx: HubContext, emit: Emit, command: CommandRow, result: CommandResult): void {
  if (command.command.kind !== 'check_main' || !ctx.config.autoMerge) return;
  const parsed = result.ok ? MainCheckResultSchema.safeParse(result.data) : null;
  if (!parsed?.success || parsed.data.sha !== command.command.sha) return;
  const { sha, check } = parsed.data;
  const before = mainHealth(ctx);
  emit({
    type: 'main.checked',
    actor: `runner:${command.runnerId}`,
    data: {
      sha,
      status: check.status,
      command: check.command,
      tail: lastChars(check.tail, EVENT_TAIL_MAX),
      durationMs: check.durationMs,
      runnerId: command.runnerId,
      newest: mergedMain(ctx)?.sha === sha,
    },
  });
  if (check.status === 'failed') mainFailed(ctx, emit, sha, check);
  else if (check.status === 'passed' && before?.status === 'failed') {
    mainPassesAgain(ctx, emit, sha, before.since, before.fixTask);
  }
}

RESULT_HANDLERS.check_main = onMainCheckResult;

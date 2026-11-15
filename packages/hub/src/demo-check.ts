// The demo check: after every AGFLOW_DEMO_CHECK_EVERY tasks merged (or accepted, without AGFLOW_AUTO_MERGE and while
// nothing marks tasks merged), the hub creates one task, by system, that runs the product from main as a jury would,
// walks every flow SPEC.md describes and records what works. The lead turns the defects it lists into fix tasks. The
// scheduler's tick calls ensureDemoCheck before dispatch; nothing else creates one. Its paths are protected under no
// runner profile, so any runner may take it.
import { type NewTask, NewTaskSchema, type Task, type Vendor, isClosed } from '@agflow/core';
import { findAttempt } from './attempt-store';
import { type HubContext, tx } from './context';
import { insertMessage } from './messages';
import { getProject } from './project';
import { findTask } from './task-store';
import { createTasks, creationGuard } from './tasks';

/** A task the system created with a title that starts so is a demo check, whatever its title is now. */
export const DEMO_CHECK_TITLE = 'Demo check after';

/** The only paths a demo check may change. */
export const DEMO_CHECK_PATHS = ['docs/STATUS.md', 'docs/qa/**', 'scripts/demo.sh'] as const;

/**
 * The demo checks so far, oldest first, each with the id of the event that created it. They are found by the title in
 * that event, which update_task does not change.
 */
function demoChecks(ctx: HubContext): { task: Task; createdEvent: number }[] {
  const rows = ctx.db
    .query(
      `SELECT subject AS id, id AS created_event FROM events
       WHERE type = 'task.created' AND actor = 'system' AND json_extract(data, '$.title') LIKE $title ORDER BY id`,
    )
    .all({ title: `${DEMO_CHECK_TITLE} %` }) as { id: string; created_event: number }[];
  return rows.flatMap((row) => {
    const task = findTask(ctx, row.id);
    return task ? [{ task, createdEvent: row.created_event }] : [];
  });
}

/** Whether the task is a demo check: the system created it with a demo check's title, as demoChecks finds them. */
export function isDemoCheck(ctx: HubContext, taskId: string): boolean {
  const row = ctx.db
    .query(
      `SELECT 1 FROM events WHERE type = 'task.created' AND actor = 'system' AND subject = $taskId
         AND json_extract(data, '$.title') LIKE $title`,
    )
    .get({ taskId, title: `${DEMO_CHECK_TITLE} %` });
  return row !== null;
}

/**
 * The tasks that count as done for the demo check, each once with its latest such event, in the order they got done:
 * merged ones, or, without AGFLOW_AUTO_MERGE and while no task has ever been marked merged, accepted ones. With auto
 * merge, accepted work reaches main only once merged, so only merged tasks count. The demo checks themselves do not.
 */
function doneTasks(ctx: HubContext, checks: ReadonlySet<string>): { taskId: string; event: number }[] {
  const merged =
    ctx.config.autoMerge === true ||
    ctx.db.query("SELECT 1 FROM events WHERE type = 'task.merged' LIMIT 1").get() !== null;
  const rows = ctx.db
    .query(
      `SELECT subject AS taskId, MAX(id) AS event FROM events WHERE type = $type AND subject IS NOT NULL
       GROUP BY subject ORDER BY event`,
    )
    .all({ type: merged ? 'task.merged' : 'task.accepted' }) as { taskId: string; event: number }[];
  return rows.filter((row) => !checks.has(row.taskId));
}

/** The vendor that implemented fewer of the tasks, by each task's newest attempt; null on a tie. */
function lessUsedVendor(ctx: HubContext, taskIds: readonly string[]): Vendor | null {
  const count: Record<Vendor, number> = { claude: 0, codex: 0 };
  for (const id of taskIds) {
    const current = findTask(ctx, id)?.currentAttempt ?? null;
    const attempt = current === null ? null : findAttempt(ctx, current);
    if (attempt) count[attempt.vendor] += 1;
  }
  if (count.claude === count.codex) return null;
  return count.claude < count.codex ? 'claude' : 'codex';
}

/** A folder name for the screenshots: the time the check was created, in UTC, as 2026-11-15-1430. */
function folderTime(now: number): string {
  const iso = new Date(now).toISOString();
  return `${iso.slice(0, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}`;
}

const tasks = (count: number): string => `${count} task${count === 1 ? '' : 's'}`;

/** The demo check's contract, after count tasks were done. */
export function demoCheckContract(count: number, now: number, vendorHint: Vendor | null): NewTask {
  const folder = `docs/qa/${folderTime(now)}/`;
  return NewTaskSchema.parse({
    title: `${DEMO_CHECK_TITLE} ${tasks(count)}`,
    objective: [
      'From a clean checkout of main, install and start the product the way AGENTS.md says (with scripts/demo.sh',
      'when it exists). Walk every user flow SPEC.md describes, as a user would. Save a screenshot of every screen',
      `into ${folder}, with Playwright or the product's own tools. Record each SPEC.md requirement in`,
      'docs/STATUS.md as working, broken or missing. List every defect, with steps to reproduce, in your submission',
      'summary. Change nothing but docs/STATUS.md, docs/qa/** and scripts/demo.sh.',
    ].join(' '),
    why:
      `A jury judges the product it can run. This check finds what does not work yet, after ${tasks(count)} done; ` +
      'the lead turns each defect it lists into a fix task.',
    nonGoals: ['Fixing the defects it finds: the lead makes fix tasks of them.'],
    acceptance: [
      { id: 'A1', assertion: 'docs/STATUS.md marks every requirement of SPEC.md as working, broken or missing.' },
      { id: 'A2', assertion: `${folder} holds a screenshot of every screen the flows reach.` },
      { id: 'A3', assertion: 'The submission summary lists every defect found, each with steps to reproduce.' },
      { id: 'A4', assertion: 'Nothing outside docs/STATUS.md, docs/qa/** and scripts/demo.sh changed.' },
    ],
    ownedPaths: [...DEMO_CHECK_PATHS],
    priority: 1,
    ...(vendorHint === null ? {} : { vendorHint }),
  });
}

/** The time before the deadline in which one task done is enough for the next demo check. */
const LAST_HOUR_MS = 60 * 60_000;

/**
 * Creates the next demo check when it is due (AGFLOW_DEMO_CHECK_EVERY): at least that many tasks done since the last
 * check was created, or one in the last hour before the deadline, none still open, and room under the task limits. Its
 * vendor hint is the vendor that implemented fewer of the last tasks done, so the other model checks the work. The
 * lead is told what to do with it. Returns the new task, or null.
 */
export function ensureDemoCheck(ctx: HubContext): Task | null {
  const configured = ctx.config.demoCheckEvery ?? 0;
  if (configured <= 0) return null;
  const { deadlineAt } = getProject(ctx);
  const left = deadlineAt === null ? null : deadlineAt - ctx.now();
  const every = left !== null && left > 0 && left <= LAST_HOUR_MS ? 1 : configured;
  const checks = demoChecks(ctx);
  if (checks.some((check) => !isClosed(check.task.status))) return null;
  const done = doneTasks(ctx, new Set(checks.map((check) => check.task.id)));
  const since = checks.at(-1)?.createdEvent ?? 0;
  if (done.filter((row) => row.event > since).length < every) return null;
  if (creationGuard(ctx, 1) !== null) return null;
  const vendor = lessUsedVendor(ctx, done.slice(-every).map((row) => row.taskId));
  const [task] = createTasks(ctx, [demoCheckContract(done.length, ctx.now(), vendor)], 'system');
  if (!task) return null;
  tx(ctx, (emit) =>
    insertMessage(ctx, emit, {
      from: 'system',
      to: 'lead',
      taskId: task.id,
      body:
        `agflow created ${task.id}, a demo check after ${tasks(done.length)} done: an agent runs the product from ` +
        'main, walks the flows in SPEC.md and records what works in docs/STATUS.md. When it is submitted, review it ' +
        'as usual, and turn each defect its summary lists into a fix task with create_tasks.',
    }),
  );
  return task;
}

// The deadline. Once the project's deadline has passed, the hub presses Pause, once per deadline: no worker starts,
// and while the project stays paused past its deadline no merge goes into main (merges.ts, queueMerges). People and
// the lead hear where main stands. Resume in the web UI goes on, and a deadline moved later lifts the merge hold at
// once and pauses the project again when it passes.
import { type HubContext, tx } from './context';
import { mainStanding } from './main-check';
import { insertMessage } from './messages';
import { getProject, setPaused } from './project';

const short = (sha: string): string => sha.slice(0, 7);

const at = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/** What the newest check of main gave, as the deadline's message says it. */
const CHECKED = { passed: 'its check passed', failed: 'its check failed', none: 'no check ran on it' } as const;

/**
 * The deadline's message to people and the lead: what agflow did, and, with AGFLOW_AUTO_MERGE, main as agflow last
 * merged it with its check, and the last main whose check passed.
 */
function deadlineMessage(ctx: HubContext, deadlineAt: number, wasPaused: boolean): string {
  const main = ctx.config.mainBranch;
  const passed = `The deadline, ${at(deadlineAt)}, has passed:`;
  const paused = wasPaused ? 'the project stays paused' : 'agflow paused the project';
  if (!ctx.config.autoMerge) return `${passed} ${paused}. Resume in the web UI goes on.`;
  const standing = mainStanding(ctx);
  const checked = standing.check === null ? 'its check has not run yet' : CHECKED[standing.check];
  return [
    `${passed} ${wasPaused ? `${paused}, and agflow holds` : `${paused} and holds`} merges into ${main}.`,
    standing.sha === null
      ? `agflow has merged nothing into ${main}.`
      : `${main} as agflow last merged it is ${short(standing.sha)}; ${checked}.`,
    standing.passed === null
      ? `No check of ${main} has passed yet.`
      : `The last ${main} whose check passed is ${short(standing.passed)}.`,
    `Resume in the web UI goes on: workers start again, and accepted work merges into ${main}.`,
  ].join('\n');
}

/**
 * The deadline's duty, run by every tick before the merge queue: once the project's deadline has passed and no
 * project.deadline_reached names it, it records one, pauses the project as system and tells people and the lead
 * (deadlineMessage). So it fires once per deadline: Resume goes on, and a deadline moved later fires again when it
 * passes. Whether it fired.
 */
export function reachDeadline(ctx: HubContext): boolean {
  const { deadlineAt } = getProject(ctx);
  if (deadlineAt === null || ctx.now() < deadlineAt) return false;
  return tx(ctx, (emit) => {
    const reached = ctx.db
      .query(
        `SELECT 1 FROM events
         WHERE type = 'project.deadline_reached' AND json_extract(data, '$.deadlineAt') = $deadlineAt LIMIT 1`,
      )
      .get({ deadlineAt });
    if (reached !== null) return false;
    const wasPaused = getProject(ctx).paused;
    emit({ type: 'project.deadline_reached', actor: 'system', data: { deadlineAt } });
    setPaused(ctx, true, 'system');
    const body = deadlineMessage(ctx, deadlineAt, wasPaused);
    for (const to of ['humans', 'lead']) insertMessage(ctx, emit, { from: 'system', to, body });
    return true;
  });
}

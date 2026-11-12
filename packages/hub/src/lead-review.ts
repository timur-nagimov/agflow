// Submission branches must reach a runner lead's vault before its clone can fetch them from origin.
import { enqueueCommand } from './commands';
import type { HubContext } from './context';
import { leadSeat } from './hub-state';

export function refreshLeadSubmission(ctx: HubContext, taskId: string, branch: string | null): void {
  const seat = leadSeat(ctx);
  if (branch === null || seat.kind !== 'runner' || seat.runnerId === null) return;
  enqueueCommand(ctx, seat.runnerId, { kind: 'refresh_vault', taskId, refs: [`refs/heads/${branch}`] });
}

export function submissionReviewInstruction(taskId: string, branch: string | null): string {
  const fetch = branch
    ? `Call \`fetch_submission\` with task_id "${taskId}", then \`git fetch origin ${branch}\` and review FETCH_HEAD. ` +
      'For a runner agent, origin is its runner vault. '
    : '';
  return `${fetch}Review it with accept_task or reject_task.`;
}

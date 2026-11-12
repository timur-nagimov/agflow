// Submission branches must reach a runner lead's vault before its clone can fetch them from origin.
import { getAgent } from './agents';
import { RESULT_HANDLERS, enqueueCommand } from './commands';
import type { HubContext } from './context';
import { leadSeat } from './hub-state';
import { unreadFor } from './messages';

export function refreshLeadSubmission(ctx: HubContext, taskId: string, branch: string | null): void {
  const seat = leadSeat(ctx);
  if (branch === null || seat.kind !== 'runner' || seat.runnerId === null || seat.attemptId === null) return;
  const refresh = enqueueCommand(ctx, seat.runnerId, { kind: 'refresh_vault', taskId, refs: [`refs/heads/${branch}`] });
  // Reserve the notice in the same transaction that publishes it (or seats a new lead). This covers both
  // check_inbox and pushed delivery, including a hub restart before the runner reports its result.
  const reserve = ctx.db.query(
    `INSERT INTO pending_deliveries (message_id, attempt_id, command_id, created_at)
     VALUES ($messageId, $attemptId, $commandId, $now)`,
  );
  for (const message of unreadFor(ctx, getAgent(ctx, seat.agentId!))) {
    if (message.to !== 'lead' || message.taskId !== taskId) continue;
    reserve.run({ messageId: message.id, attemptId: seat.attemptId, commandId: refresh.id, now: ctx.now() });
  }
}

// Completion releases the reservation, not a delivery acknowledgement: the normal inbox or delivery batch
// still has to consume the notice. Failed fetches retain the existing completion semantics of the gateway.
RESULT_HANDLERS.refresh_vault = (ctx, _emit, command) => {
  ctx.db.query('DELETE FROM pending_deliveries WHERE command_id = $commandId').run({ commandId: command.id });
};

export function submissionReviewInstruction(branch: string | null): string {
  const fetch = branch
    ? `Fetch the submitted branch with \`git fetch origin ${branch}\`, then inspect FETCH_HEAD. ` +
      'For a runner agent, origin is its runner vault. '
    : '';
  return `${fetch}Review it with accept_task or reject_task.`;
}

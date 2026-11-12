// A lead explicitly waits for its own vault fetch. Review notices and other commands never wait for it.
import type { Agent, FetchSubmissionRequest } from '@agflow/core';
import { findAttempt } from './attempt-store';
import { enqueueCommand, findCommand, type CommandRow } from './commands';
import { type HubContext, tx } from './context';
import { conflict, forbidden, notFound } from './errors';
import { holdsSeat, leadSeat } from './hub-state';
import { findRunnerRow } from './runners';
import { getTask } from './task-store';

function submission(ctx: HubContext, taskId: string) {
  const task = getTask(ctx, taskId);
  const { branch, headSha } = task.submission ?? {};
  if (!branch || !headSha) throw conflict(`${taskId} has no submission with a branch and head to review`);
  return { branch, head_sha: headSha };
}

function caller(ctx: HubContext, agent: Agent) {
  if (!holdsSeat(ctx, agent.id)) throw forbidden('only the seated lead can fetch a submission');
  const seat = leadSeat(ctx);
  if (seat.kind === 'live') return null;
  const attempt = seat.attemptId === null ? null : findAttempt(ctx, seat.attemptId);
  if (!attempt || attempt.agentId !== agent.id || attempt.runnerId === null) {
    throw forbidden('only the seated runner lead can fetch a submission');
  }
  if (attempt.stopRequested) throw conflict(`lead attempt ${attempt.id} is being stopped`);
  return attempt;
}

function online(ctx: HubContext, runnerId: string): void {
  const runner = findRunnerRow(ctx, runnerId);
  if (!runner || runner.state === 'offline' || runner.retired_at !== null) {
    throw conflict(`runner ${runnerId} is offline; retry fetch_submission when it reconnects`);
  }
}

function result(ctx: HubContext, row: CommandRow): FetchSubmissionRequest {
  if (row.command.kind !== 'refresh_vault') throw notFound(`submission fetch ${row.id}`);
  const head = submission(ctx, row.command.taskId);
  const ref = `refs/heads/${head.branch}`;
  let error: string | null = null;
  if (!row.command.refs.includes(ref)) error = 'the submission branch changed; call fetch_submission again';
  else if (row.status === 'cancelled') error = 'the submission fetch was cancelled because the lead ended or restarted';
  else if (row.status === 'failed') error = row.result?.error ?? 'the runner fetch failed without a message';
  else if (row.status === 'done') {
    const data = row.result?.data as { refs?: Record<string, unknown> } | undefined;
    if (data?.refs?.[ref] !== head.head_sha) {
      error = `the runner vault did not confirm ${ref} at the submitted head ${head.head_sha}; call fetch_submission again`;
    }
  }
  return { id: row.id, ...head, status: error ? 'failed' : row.status === 'pending' ? 'pending' : 'ok', error };
}

export function requestSubmissionFetch(ctx: HubContext, agent: Agent, taskId: string): FetchSubmissionRequest {
  return tx(ctx, () => {
    const attempt = caller(ctx, agent);
    const head = submission(ctx, taskId);
    if (!attempt) return { id: null, ...head, status: 'ok', error: null, note: 'Your own git remote has this submission; fetch the branch from it and review FETCH_HEAD.' };
    const runnerId = attempt.runnerId!;
    online(ctx, runnerId);
    const ref = `refs/heads/${head.branch}`;
    const pending = ctx.db.query(
      "SELECT id FROM runner_commands WHERE kind = 'refresh_vault' AND attempt_id = $attemptId AND status = 'pending' AND json_extract(payload, '$.taskId') = $taskId ORDER BY seq DESC LIMIT 1",
    ).get({ attemptId: attempt.id, taskId }) as { id: string } | null;
    if (pending) {
      const row = findCommand(ctx, pending.id)!;
      if (row.command.kind === 'refresh_vault' && row.command.refs.includes(ref)) return result(ctx, row);
      ctx.db.query("UPDATE runner_commands SET status = 'cancelled', done_at = ? WHERE id = ?")
        .run(ctx.now(), row.id);
    }
    const command = enqueueCommand(ctx, runnerId, { kind: 'refresh_vault', taskId, refs: [ref] });
    // Request ownership is hub metadata, not a wire fence on the runner-wide refresh command. Ending or re-fencing
    // the lead cancels its request using the existing attempt-command lifecycle.
    ctx.db.query('UPDATE runner_commands SET attempt_id = ?, fence_epoch = ?, fence_counter = ? WHERE id = ?')
      .run(attempt.id, attempt.fence.epoch, attempt.fence.counter, command.id);
    return result(ctx, findCommand(ctx, command.id)!);
  });
}

export function getSubmissionFetch(ctx: HubContext, agent: Agent, id: string): FetchSubmissionRequest {
  const attempt = caller(ctx, agent);
  const row = findCommand(ctx, id);
  if (!row || row.kind !== 'refresh_vault') throw notFound(`submission fetch ${id}`);
  if (!attempt || row.attemptId !== attempt.id || row.runnerId !== attempt.runnerId) {
    throw forbidden('this submission fetch belongs to another lead attempt');
  }
  if (row.status === 'pending') online(ctx, row.runnerId);
  return result(ctx, row);
}

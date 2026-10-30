// Dependency preparation an agent asks for (design 7.7): POST /api/prepare sends prepare_dependencies, the runner's
// attempt.prepared records how it went, and GET /api/prepare/:id polls it. The request is the command: its id is the
// command id, and its state lives with the command (X-40).
import type { Attempt, PrepareRequest, RunnerEventData } from '@agflow/core';
import { appendAttemptLog, attemptSubject, findAttempt } from './attempt-store';
import { attemptData } from './attempts';
import { resolveAgentToken } from './auth';
import { type CommandResult, type CommandRow, enqueueCommand, findCommand } from './commands';
import { type HubContext, tx } from './context';
import { conflict, forbidden, notFound } from './errors';
import type { Emit } from './events';

/** What a request whose command was cancelled reads as: a re-fence or the attempt's end came first. */
const CANCELLED = 'cancelled: the attempt ended or restarted before the runner ran it';

/** The request as its command keeps it: pending until the runner's outcome, and failed if it was cancelled. */
function toPrepareRequest(row: CommandRow): PrepareRequest {
  const logTail = (row.result?.data as { logTail?: string | null } | undefined)?.logTail ?? null;
  const status = row.status === 'pending' ? 'pending' : row.status === 'done' ? 'ok' : 'failed';
  return {
    id: row.id,
    attemptId: row.attemptId as string,
    status,
    error: row.status === 'cancelled' ? CANCELLED : (row.result?.error ?? null),
    logTail,
    requestedAt: row.createdAt,
    finishedAt: row.doneAt,
  };
}

/** The attempt's request the runner has not reported on yet. */
function pendingPreparationOf(ctx: HubContext, attemptId: string): CommandRow | null {
  const row = ctx.db
    .query(
      `SELECT id FROM runner_commands WHERE attempt_id = $attemptId AND kind = 'prepare_dependencies'
       AND status = 'pending' ORDER BY hub_epoch, seq LIMIT 1`,
    )
    .get({ attemptId }) as { id: string } | null;
  return row ? findCommand(ctx, row.id) : null;
}

/**
 * POST /api/prepare (design 7.7, 6.16): the attempt the agent token names gets prepare_dependencies at its fence, with
 * the command's own id as requestId. Only a running runner worker asks: leads get none, and an attempt that is
 * starting, waiting for quota or holding has no agent at work. One that is being stopped or taken over asks no more,
 * since a preparation would run ahead of its stop on the runner's queue. A request while one is pending answers that
 * one, as a second submit does. The token is resolved in the request's transaction.
 */
export function requestPreparation(ctx: HubContext, token: string): PrepareRequest {
  return tx(ctx, () => {
    const { attempt } = resolveAgentToken(ctx, token);
    if (attempt.runnerId === null || attempt.role !== 'worker') {
      throw forbidden('only a runner worker asks agflow to prepare dependencies');
    }
    if (attempt.status !== 'running') throw conflict(`attempt ${attempt.id} is ${attempt.status}, not running`);
    if (attempt.stopRequested) {
      throw conflict(`your attempt ${attempt.id} is being stopped; write a handoff note if you have not, and stop`);
    }
    const pending = pendingPreparationOf(ctx, attempt.id);
    if (pending) return toPrepareRequest(pending);
    const command = enqueueCommand(ctx, attempt.runnerId, (id) => ({
      kind: 'prepare_dependencies',
      attemptId: attempt.id,
      fence: attempt.fence,
      requestId: id,
    }));
    return toPrepareRequest(command);
  });
}

/** GET /api/prepare/:id: only the agent of the attempt that asked reads it. */
export function getPreparation(ctx: HubContext, id: string, agentId: string): PrepareRequest {
  const row = findCommand(ctx, id);
  if (!row || row.kind !== 'prepare_dependencies') throw notFound(`preparation request ${id}`);
  const attempt = row.attemptId === null ? null : findAttempt(ctx, row.attemptId);
  if (attempt?.agentId !== agentId) throw forbidden(`preparation request ${id} is another agent's`);
  return toPrepareRequest(row);
}

/**
 * attempt.prepared (design 6.3, 7.7). A preparation the runner ran before a start or resume (requestId null) is only
 * logged; a failed one is followed by attempt.failed_to_start. An agent's request gets the outcome, its error and log
 * tail, kept with its command whatever the command's own result said, and the attempt.prepared event.
 */
export function onPrepared(
  ctx: HubContext,
  emit: Emit,
  attempt: Attempt,
  data: RunnerEventData['attempt.prepared'],
): void {
  const how = data.ok ? 'ok' : `failed: ${data.error ?? 'no error given'}`;
  if (data.requestId === null) {
    appendAttemptLog(ctx, attempt.id, 'note', `prepared the dependencies before the agent started: ${how}`);
    return;
  }
  const row = findCommand(ctx, data.requestId);
  if (!row || row.kind !== 'prepare_dependencies' || row.attemptId !== attempt.id) {
    const why = `attempt.prepared names request ${data.requestId}, not one of its own`;
    appendAttemptLog(ctx, attempt.id, 'rejected', why);
    return;
  }
  const result: CommandResult = { ok: data.ok, data: { logTail: data.logTail } };
  if (data.error !== null) result.error = data.error;
  ctx.db
    .query('UPDATE runner_commands SET status = $status, result = $result, done_at = $now WHERE id = $id')
    .run({ id: row.id, status: data.ok ? 'done' : 'failed', result: JSON.stringify(result), now: ctx.now() });
  appendAttemptLog(ctx, attempt.id, 'note', `prepared the dependencies (request ${row.id}): ${how}`);
  emit({
    type: 'attempt.prepared',
    actor: `runner:${attempt.runnerId}`,
    subject: attemptSubject(attempt),
    data: { ...attemptData(attempt), requestId: row.id, ok: data.ok, error: data.error },
  });
}

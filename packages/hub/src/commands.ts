// The runner command queue (design 6.3): runner_commands rows, sent after every welcome and right after the
// transaction that queued them commits, until the runner answers with a result or the hub cancels them.
import {
  type AttemptSpec,
  COMMAND_MIN_PROTOCOL,
  type Fence,
  type HubMessage,
  type RunnerCommand,
  type RunnerCommandKind,
} from '@agflow/core';
import { getAttempt } from './attempt-store';
import { mintAgentToken } from './auth';
import { type HubContext, afterCommit, tx } from './context';
import type { Emit } from './events';
import { hubEpoch } from './hub-state';

/**
 * A command as stored: start_attempt and resume_attempt carry no agent token. toWireCommand mints a fresh one for
 * every send, so no token is ever written to runner_commands.
 */
export type StoredCommand =
  | { kind: 'start_attempt'; attempt: Omit<AttemptSpec, 'agentToken'> }
  | Omit<Extract<RunnerCommand, { kind: 'resume_attempt' }>, 'agentToken'>
  | Exclude<RunnerCommand, { kind: 'start_attempt' | 'resume_attempt' }>;

export type CommandStatus = 'pending' | 'done' | 'failed' | 'cancelled';

/** A runner's answer to a command, as its result message carries it. */
export interface CommandResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface CommandRow {
  /** '<hubEpoch>-<runnerId>-<seq>', unique across restores. */
  id: string;
  runnerId: string;
  hubEpoch: number;
  /** Per runner and hub epoch, from 1. */
  seq: number;
  kind: RunnerCommandKind;
  attemptId: string | null;
  fence: Fence | null;
  command: StoredCommand;
  status: CommandStatus;
  result: CommandResult | null;
  createdAt: number;
  sentAt: number | null;
  doneAt: number | null;
}

interface StoredRow {
  id: string;
  runner_id: string;
  hub_epoch: number;
  seq: number;
  kind: RunnerCommandKind;
  attempt_id: string | null;
  fence_epoch: number | null;
  fence_counter: number | null;
  payload: string;
  status: CommandStatus;
  result: string | null;
  created_at: number;
  sent_at: number | null;
  done_at: number | null;
}

function toRow(row: StoredRow): CommandRow {
  return {
    id: row.id,
    runnerId: row.runner_id,
    hubEpoch: row.hub_epoch,
    seq: row.seq,
    kind: row.kind,
    attemptId: row.attempt_id,
    fence:
      row.fence_epoch === null || row.fence_counter === null ? null : { epoch: row.fence_epoch, counter: row.fence_counter },
    command: JSON.parse(row.payload) as StoredCommand,
    status: row.status,
    result: row.result === null ? null : (JSON.parse(row.result) as CommandResult),
    createdAt: row.created_at,
    sentAt: row.sent_at,
    doneAt: row.done_at,
  };
}

/** Drops an agent token a caller may have put in, so none can reach the table. */
function withoutToken(command: StoredCommand): StoredCommand {
  if (command.kind === 'start_attempt') {
    const attempt: Partial<AttemptSpec> = { ...command.attempt };
    delete attempt.agentToken;
    return { kind: command.kind, attempt: attempt as Omit<AttemptSpec, 'agentToken'> };
  }
  if (command.kind === 'resume_attempt') {
    const resume: Partial<Extract<RunnerCommand, { kind: 'resume_attempt' }>> = { ...command };
    delete resume.agentToken;
    return resume as StoredCommand;
  }
  return command;
}

/** The attempt a command is about, and the fence it acts at; hand_back, cleanup and uploads carry no fence. */
function targetOf(command: StoredCommand): { attemptId: string | null; fence: Fence | null } {
  if (command.kind === 'start_attempt') return { attemptId: command.attempt.attemptId, fence: command.attempt.fence };
  return {
    attemptId: 'attemptId' in command ? command.attemptId : null,
    fence: 'fence' in command ? command.fence : null,
  };
}

export function findCommand(ctx: HubContext, id: string): CommandRow | null {
  const row = ctx.db.query('SELECT * FROM runner_commands WHERE id = $id').get({ id }) as StoredRow | null;
  return row ? toRow(row) : null;
}

/**
 * Queues a command for the runner, in the caller's transaction. The runner's link is flushed once that transaction
 * commits; a rollback sends nothing. A command that names itself, as prepare_dependencies does with its requestId
 * (X-40), is built from its id.
 */
export function enqueueCommand(
  ctx: HubContext,
  runnerId: string,
  command: StoredCommand | ((id: string) => StoredCommand),
): CommandRow {
  const epoch = hubEpoch(ctx);
  const { seq } = ctx.db
    .query('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM runner_commands WHERE runner_id = $runnerId AND hub_epoch = $epoch')
    .get({ runnerId, epoch }) as { seq: number };
  const id = `${epoch}-${runnerId}-${seq}`;
  const stored = withoutToken(typeof command === 'function' ? command(id) : command);
  const { attemptId, fence } = targetOf(stored);
  ctx.db
    .query(
      `INSERT INTO runner_commands (id, runner_id, hub_epoch, seq, kind, attempt_id, fence_epoch, fence_counter, payload,
         status, created_at)
       VALUES ($id, $runnerId, $epoch, $seq, $kind, $attemptId, $fenceEpoch, $fenceCounter, $payload, 'pending', $now)`,
    )
    .run({
      id,
      runnerId,
      epoch,
      seq,
      kind: stored.kind,
      attemptId,
      fenceEpoch: fence?.epoch ?? null,
      fenceCounter: fence?.counter ?? null,
      payload: JSON.stringify(stored),
      now: ctx.now(),
    });
  afterCommit(ctx, () => ctx.link.flush(runnerId), `link:${runnerId}`);
  return findCommand(ctx, id) as CommandRow;
}

/** The runner's pending commands in seq order, leaving out kinds newer than the protocol it speaks. */
export function pendingCommands(ctx: HubContext, runnerId: string, protocol: number): CommandRow[] {
  const rows = ctx.db
    .query("SELECT * FROM runner_commands WHERE runner_id = $runnerId AND status = 'pending' ORDER BY hub_epoch, seq")
    .all({ runnerId }) as StoredRow[];
  return rows.map(toRow).filter((row) => COMMAND_MIN_PROTOCOL[row.kind] <= protocol);
}

/**
 * The command message for one send. A start or resume gets a freshly minted token for its attempt and fence; the
 * tokens of earlier sends stay valid until the attempt ends or gets a new fence.
 */
export function toWireCommand(ctx: HubContext, row: CommandRow): Extract<HubMessage, { t: 'command' }> {
  const stored = row.command;
  let command: RunnerCommand;
  if (stored.kind === 'start_attempt' || stored.kind === 'resume_attempt') {
    const attempt = getAttempt(ctx, row.attemptId as string);
    const agentToken = mintAgentToken(ctx, { id: attempt.id, agentId: attempt.agentId, fence: row.fence as Fence });
    command =
      stored.kind === 'start_attempt'
        ? { kind: 'start_attempt', attempt: { ...stored.attempt, agentToken } }
        : { ...stored, agentToken };
  } else {
    command = stored;
  }
  return { t: 'command', id: row.id, seq: row.seq, command };
}

/** Records when the command last went out. */
export function markSent(ctx: HubContext, id: string): void {
  ctx.db.query('UPDATE runner_commands SET sent_at = $now WHERE id = $id').run({ id, now: ctx.now() });
}

/** What a command kind does when its result arrives, inside the transaction that records it. */
export type ResultHandler = (ctx: HubContext, emit: Emit, command: CommandRow, result: CommandResult) => void;

/**
 * Per-kind hooks for results. The modules that need one register it here (hand-back, ref cleanup), so this module
 * stays below them.
 */
export const RESULT_HANDLERS: Partial<Record<RunnerCommandKind, ResultHandler>> = {};

/**
 * Stores a runner's result for one of its pending commands as done or failed, and runs the kind's handler. Results
 * for unknown commands, other runners' commands, and commands no longer pending are ignored: null.
 */
export function recordResult(
  ctx: HubContext,
  runnerId: string,
  message: { commandId: string } & CommandResult,
): CommandRow | null {
  return tx(ctx, (emit) => {
    const row = findCommand(ctx, message.commandId);
    if (!row || row.runnerId !== runnerId || row.status !== 'pending') return null;
    const result: CommandResult = { ok: message.ok };
    if (message.data !== undefined) result.data = message.data;
    if (message.error !== undefined) result.error = message.error;
    ctx.db
      .query('UPDATE runner_commands SET status = $status, result = $result, done_at = $now WHERE id = $id')
      .run({ id: row.id, status: result.ok ? 'done' : 'failed', result: JSON.stringify(result), now: ctx.now() });
    const done = findCommand(ctx, row.id) as CommandRow;
    RESULT_HANDLERS[row.kind]?.(ctx, emit, done, result);
    return done;
  });
}

/**
 * Kinds that outlive the attempt's fence: they clean up after it or hand it back, so cancelling keeps them, and a
 * runner runs them for an attempt its welcome stopped.
 */
export const KEPT_ON_CANCEL: readonly RunnerCommandKind[] = ['cleanup_attempt', 'upload_transcript', 'hand_back'];

/**
 * Cancels the attempt's pending commands, in the transaction that ends it or gives it a new fence. Cancelled commands
 * are never sent again. Returns them, oldest first.
 */
export function cancelPendingCommands(ctx: HubContext, attemptId: string): CommandRow[] {
  const rows = ctx.db
    .query(
      `UPDATE runner_commands SET status = 'cancelled', done_at = $now
       WHERE attempt_id = $attemptId AND status = 'pending' AND kind NOT IN (${KEPT_ON_CANCEL.map((kind) => `'${kind}'`).join(', ')})
       RETURNING *`,
    )
    .all({ attemptId, now: ctx.now() }) as StoredRow[];
  return rows.map(toRow).sort((a, b) => a.hubEpoch - b.hubEpoch || a.seq - b.seq);
}

/** Cancels the attempt's pending commands of one kind, such as the stop_attempt a newer stop request replaces. */
export function cancelPendingOfKind(ctx: HubContext, attemptId: string, kind: RunnerCommandKind): number {
  return ctx.db
    .query(
      `UPDATE runner_commands SET status = 'cancelled', done_at = $now
       WHERE attempt_id = $attemptId AND kind = $kind AND status = 'pending'`,
    )
    .run({ attemptId, kind, now: ctx.now() }).changes;
}

/**
 * Cancels the runner's pending update_settings, when the hub adopts a newer snapshot from its hello: every one of them
 * carries an older version, which would undo the adopted settings on the runner. Returns how many.
 */
export function cancelPendingSettings(ctx: HubContext, runnerId: string): number {
  return ctx.db
    .query(
      `UPDATE runner_commands SET status = 'cancelled', done_at = $now
       WHERE runner_id = $runnerId AND kind = 'update_settings' AND status = 'pending'`,
    )
    .run({ runnerId, now: ctx.now() }).changes;
}

/** The attempt's pending resume_attempt, whose prompt and messages a re-fence carries over. */
export function pendingResumeOf(ctx: HubContext, attemptId: string): CommandRow | null {
  const row = ctx.db
    .query(
      `SELECT * FROM runner_commands WHERE attempt_id = $attemptId AND kind = 'resume_attempt' AND status = 'pending'
       ORDER BY hub_epoch DESC, seq DESC LIMIT 1`,
    )
    .get({ attemptId }) as StoredRow | null;
  return row ? toRow(row) : null;
}

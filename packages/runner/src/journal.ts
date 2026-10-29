// The command journal (design 6.3, "Commands"): each command is recorded as running before it executes and as done
// with its result after, so a resent command is never executed twice. Commands are matched by id and by the
// idempotency keys of design 6.3, because the hub may resend a command under a new id (after a restore, or with a
// fresh agent token). Agent tokens are dropped before anything is stored (design 7.2).
import { type AttemptSpec, formatFence, type RunnerCommand, type RunnerMessage } from '@agflow/core';
import type { RunnerDb } from './db';

/** What a command answers: the result message without its envelope. */
export type CommandResult = Omit<Extract<RunnerMessage, { t: 'result' }>, 't' | 'commandId'>;

type ResumeCommand = Extract<RunnerCommand, { kind: 'resume_attempt' }>;

/** A command as the journal keeps it: start_attempt and resume_attempt without their agent token. */
export type JournaledCommand =
  | Exclude<RunnerCommand, { kind: 'start_attempt' | 'resume_attempt' }>
  | { kind: 'start_attempt'; attempt: Omit<AttemptSpec, 'agentToken'> }
  | Omit<ResumeCommand, 'agentToken'>;

export interface JournalEntry {
  commandId: string;
  seq: number;
  kind: RunnerCommand['kind'];
  attemptId: string | null;
  /** idempotencyKey(command), or null when only the id identifies the command. */
  key: string | null;
  command: JournaledCommand;
  /**
   * The outbox's newest seq when the command first arrived, as the executor gives it to begin; null when none was
   * given. An update_settings echo answers only the settings edits appended before it (X-12), after a restart too.
   */
  outboxSeq: number | null;
  state: 'running' | 'done';
  result: CommandResult | null;
  startedAt: number;
  finishedAt: number | null;
}

/**
 * What begin found. new: the caller executes the command. running: an execution of the same command (this id, or
 * the first id with the same key) has not finished; its result answers this one too. done: answer the stored result.
 */
export type JournalBegin =
  | { state: 'new' }
  | { state: 'running'; commandId: string }
  | { state: 'done'; commandId: string; result: CommandResult };

/**
 * Design 6.3's idempotency keys: start and resume by attempt and fence, push_submission by submission, stop, hold
 * and prepare_takeover by fence, decide_approval by approval. Every other command is identified by its id alone.
 */
export function idempotencyKey(command: RunnerCommand): string | null {
  switch (command.kind) {
    case 'start_attempt':
      return `${command.kind}:${command.attempt.attemptId}:${formatFence(command.attempt.fence)}`;
    case 'resume_attempt':
    case 'stop_attempt':
    case 'hold_attempt':
    case 'prepare_takeover':
      return `${command.kind}:${command.attemptId}:${formatFence(command.fence)}`;
    case 'push_submission':
      return `${command.kind}:${command.submissionId}`;
    case 'decide_approval':
      return `${command.kind}:${command.approvalId}`;
    default:
      return null;
  }
}

/** The command without its agent token. */
export function journaledCommand(command: RunnerCommand): JournaledCommand {
  if (command.kind === 'start_attempt') {
    const { agentToken: _token, ...attempt } = command.attempt;
    return { kind: command.kind, attempt };
  }
  if (command.kind === 'resume_attempt') {
    const { agentToken: _token, ...rest } = command;
    return rest;
  }
  return command;
}

/** The attempt a command is about, if any. */
function attemptOf(command: RunnerCommand): string | null {
  if (command.kind === 'start_attempt') return command.attempt.attemptId;
  return 'attemptId' in command ? command.attemptId : null;
}

interface JournalRow {
  command_id: string;
  seq: number;
  kind: RunnerCommand['kind'];
  attempt_id: string | null;
  idempotency_key: string | null;
  command: string;
  outbox_seq: number | null;
  state: 'running' | 'done';
  result: string | null;
  started_at: number;
  finished_at: number | null;
}

function entryOf(row: JournalRow): JournalEntry {
  return {
    commandId: row.command_id,
    seq: row.seq,
    kind: row.kind,
    attemptId: row.attempt_id,
    key: row.idempotency_key,
    command: JSON.parse(row.command) as JournaledCommand,
    outboxSeq: row.outbox_seq,
    state: row.state,
    result: row.result === null ? null : (JSON.parse(row.result) as CommandResult),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export class Journal {
  private readonly now: () => number;

  constructor(
    private readonly db: RunnerDb,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  /**
   * Records the command as running unless this id or its idempotency key is already journaled, with the outbox
   * position it arrived at; a resend leaves the first one's.
   */
  begin(commandId: string, seq: number, command: RunnerCommand, outboxSeq: number | null = null): JournalBegin {
    const key = idempotencyKey(command);
    return this.db.sqlite.transaction((): JournalBegin => {
      const existing = this.db.sqlite
        .query('SELECT * FROM journal WHERE command_id = $commandId OR idempotency_key = $key ORDER BY rowid LIMIT 1')
        .get({ commandId, key }) as JournalRow | null;
      if (existing) {
        const { commandId: first, state, result } = entryOf(existing);
        if (state === 'done' && result) return { state, commandId: first, result };
        return { state: 'running', commandId: first };
      }
      this.db.sqlite
        .query(
          `INSERT INTO journal
             (command_id, seq, kind, attempt_id, idempotency_key, command, outbox_seq, state, started_at)
           VALUES ($commandId, $seq, $kind, $attemptId, $key, $command, $outboxSeq, 'running', $at)`,
        )
        .run({
          commandId,
          seq,
          kind: command.kind,
          attemptId: attemptOf(command),
          key,
          command: JSON.stringify(journaledCommand(command)),
          outboxSeq,
          at: this.now(),
        });
      return { state: 'new' };
    })();
  }

  /** Records the result of a command begin returned new for. */
  finish(commandId: string, result: CommandResult): void {
    const { changes } = this.db.sqlite
      .query("UPDATE journal SET state = 'done', result = $result, finished_at = $at WHERE command_id = $commandId")
      .run({ commandId, result: JSON.stringify(result), at: this.now() });
    if (changes === 0) throw new Error(`command ${commandId} is not in the journal`);
  }

  get(commandId: string): JournalEntry | null {
    const row = this.db.sqlite.query('SELECT * FROM journal WHERE command_id = $commandId').get({ commandId });
    return row ? entryOf(row as JournalRow) : null;
  }

  /** Commands a previous run left running, in arrival order; the executor re-runs or answers them after a restart. */
  running(): JournalEntry[] {
    const rows = this.db.sqlite.query("SELECT * FROM journal WHERE state = 'running' ORDER BY rowid").all();
    return (rows as JournalRow[]).map(entryOf);
  }

  /** Drops rows started before at (M2c's 14-day cutoff). Gives how many. */
  pruneBefore(at: number): number {
    return this.db.sqlite.query('DELETE FROM journal WHERE started_at < $at').run({ at }).changes;
  }
}

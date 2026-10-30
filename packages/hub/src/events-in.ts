// Inbound runner events (design 6.3, Events). Each event applies in its own savepoint, after the checks that decide
// whether it is current. Whatever happens to it, the cumulative acknowledgement advances, so one bad event never
// blocks a runner's outbox: invalid, unknown and throwing events become rejects. A message that fails as a whole, or
// that skips events the runner sent after its hello, applies nothing and is never acknowledged: the gateway ends the
// link, and the replay after the next hello brings it again. What each type does lives in the module that owns it,
// registered in EVENT_HANDLERS.
import {
  type Attempt,
  type Fence,
  type RawRunnerEvent,
  type RunnerEvent,
  type RunnerEventType,
  compareFence,
  formatFence,
  parseRunnerEvent,
} from '@agflow/core';
import { appendAttemptLog, findAttempt } from './attempt-store';
import { onActivity, onFailedToStart, onFirstOutput, onSpawned } from './attempts';
import { type HubContext, tx } from './context';
import type { Emit } from './events';
import { applyRunnerSettings, applyVendorReport, setReportedState } from './runners';
import { clip } from './text';

/**
 * Where an event stands against the hub's record of its attempt. current: a runner event, or an attempt event of an
 * open attempt at its current fence (or, during the replay after a restore, a newer one); ended: the attempt ended;
 * refenced: the attempt is open at another fence; unknown: the hub has no such attempt.
 */
export type EventStanding = 'current' | 'ended' | 'refenced' | 'unknown';

export interface EventContext {
  runnerId: string;
  emit: Emit;
  /** The attempt an attempt event is about; null for runner events and for attempts the hub does not know. */
  attempt: Attempt | null;
  standing: EventStanding;
}

export type EventHandler<T extends RunnerEventType = RunnerEventType> = (
  ctx: HubContext,
  event: Extract<RunnerEvent, { type: T }>,
  context: EventContext,
) => void;

/** Whether a non-current event of one of STALE_EVENT_TYPES still reaches its handler. */
export type StaleRule = (standing: Exclude<EventStanding, 'current'>, attempt: Attempt | null) => boolean;

const endedOrUnknown: StaleRule = (standing) => standing === 'ended' || standing === 'unknown';
const ended: StaleRule = (standing) => standing === 'ended';

/**
 * Design 6.3's exceptions to the fence rule: the attempt event types whose handlers also see some non-current events,
 * and which ones. Late WIP and late work of an ended or unknown attempt, the exit and violations of an ended one, the
 * commands of one that ended taken_over, and every submission and hand-back (a hand-back carries no fence to compare).
 * Any other non-current event is logged on its attempt as rejected, or rejected when the hub has no such attempt.
 */
export const STALE_EVENT_TYPES: ReadonlyMap<RunnerEventType, StaleRule> = new Map<RunnerEventType, StaleRule>([
  ['attempt.wip', endedOrUnknown],
  ['attempt.late_work', endedOrUnknown],
  ['attempt.exited', ended],
  ['attempt.violation', ended],
  ['attempt.taken_over', (standing, attempt) => standing === 'ended' && attempt?.endReason === 'taken_over'],
  ['attempt.submitted', () => true],
  ['attempt.handed_back', () => true],
]);

/** The attempt of an attempt event: dispatch passes it for every event that reaches a handler but unknown ones. */
function attemptOf(context: EventContext): Attempt {
  if (!context.attempt) throw new Error('the event names an attempt the hub does not know');
  return context.attempt;
}

/** What each event type does once it passed the checks; a type with no entry is acknowledged and has no effect. */
export const EVENT_HANDLERS: { [T in RunnerEventType]?: EventHandler<T> } = {
  'attempt.spawned': (ctx, event, context) => onSpawned(ctx, context.emit, attemptOf(context), event.data),
  'attempt.failed_to_start': (ctx, event, context) => {
    onFailedToStart(ctx, attemptOf(context), event.data);
  },
  'attempt.activity': (ctx, event, context) => onActivity(ctx, attemptOf(context), event.data),
  'attempt.first_output': (ctx, event, context) => onFirstOutput(ctx, attemptOf(context), event.data),
  'runner.state': (ctx, event, { runnerId }) => setReportedState(ctx, runnerId, event.data.state, event.data.detail),
  'runner.settings': (ctx, event, { runnerId, emit }) => {
    applyRunnerSettings(ctx, emit, runnerId, event.data.settings);
  },
  'runner.vendors': (ctx, event, { runnerId }) => applyVendorReport(ctx, runnerId, event.data.vendors),
};

/**
 * Raises the runner's acknowledged position for this outbox epoch to at least firstSeq − 1, creating the row for a
 * new epoch, and returns it: the runner replays every event after it that it still has.
 */
export function acknowledgePosition(ctx: HubContext, runnerId: string, outboxEpoch: string, firstSeq: number): number {
  const row = ctx.db
    .query(
      `INSERT INTO runner_inbox (runner_id, outbox_epoch, acked_seq) VALUES ($runnerId, $outboxEpoch, $floor)
       ON CONFLICT (runner_id, outbox_epoch) DO UPDATE SET acked_seq = MAX(acked_seq, excluded.acked_seq)
       RETURNING acked_seq`,
    )
    .get({ runnerId, outboxEpoch, floor: firstSeq - 1 }) as { acked_seq: number };
  return row.acked_seq;
}

export interface ApplyOptions {
  /** The replay after a restore is still running: a fence newer than the attempt's recorded one is current (X-1). */
  restoreReplay: boolean;
  /**
   * For a message on a runner link, the lastSeq of its hello for the message's outbox epoch (0 for another epoch).
   * The runner's replay may leave out some of the events up to it, ones the hub had (X-12) or that the runner no
   * longer holds, and the cumulative ack covers them. After it, each event the runner sends follows the one before: a
   * gap there is events the hub never had, so applyRunnerEvents throws rather than acknowledge past them. Undefined for
   * a message from no link: no gap is looked for.
   */
  helloLastSeq?: number | undefined;
}

/** Raw events can be anything; a reject keeps this much of one. */
const RAW_KEPT = 64_000;

/** Stores an event the hub could not apply and tells the pages; it is acknowledged like any other. */
function reject(
  ctx: HubContext,
  emit: Emit,
  runnerId: string,
  outboxEpoch: string,
  raw: RawRunnerEvent,
  error: string,
): void {
  ctx.db
    .query(
      `INSERT INTO runner_event_rejects (runner_id, outbox_epoch, seq, type, error, raw, at)
       VALUES ($runnerId, $outboxEpoch, $seq, $type, $error, $raw, $at)`,
    )
    .run({
      runnerId,
      outboxEpoch,
      seq: raw.seq,
      type: raw.type,
      error,
      raw: clip(JSON.stringify(raw), RAW_KEPT),
      at: ctx.now(),
    });
  emit({
    type: 'runner.event_rejected',
    actor: `runner:${runnerId}`,
    subject: runnerId,
    data: { runnerId, seq: raw.seq, type: raw.type, error: clip(error, 500) },
  });
}

function standingOf(attempt: Attempt | null, fence: Fence, options: ApplyOptions): EventStanding {
  if (!attempt) return 'unknown';
  if (attempt.status === 'ended') return 'ended';
  const order = compareFence(fence, attempt.fence);
  return order === 0 || (order > 0 && options.restoreReplay) ? 'current' : 'refenced';
}

/**
 * Runs the event's handler when it may apply. Returns why it is a reject, or null. A non-current event of a known
 * attempt that is no exception is logged on the attempt instead of rejected: the runner did nothing wrong in sending
 * it. One of an unknown attempt has nowhere to be logged, so it is a reject.
 */
function dispatch(
  ctx: HubContext,
  emit: Emit,
  runnerId: string,
  event: RunnerEvent,
  options: ApplyOptions,
): string | null {
  const handler = EVENT_HANDLERS[event.type] as EventHandler | undefined;
  if (!('attemptId' in event)) {
    handler?.(ctx, event, { runnerId, emit, attempt: null, standing: 'current' });
    return null;
  }
  const attempt = findAttempt(ctx, event.attemptId);
  // A runner speaks only for its own attempts.
  if (attempt && attempt.runnerId !== runnerId) {
    return `attempt ${attempt.id} runs on ${attempt.runnerId ?? 'no runner'}, not on ${runnerId}`;
  }
  const standing = standingOf(attempt, event.fence, options);
  if (standing !== 'current' && !STALE_EVENT_TYPES.get(event.type)?.(standing, attempt)) {
    if (!attempt) return `unknown attempt ${event.attemptId}`;
    const why =
      standing === 'ended'
        ? `the attempt ended (${attempt.endReason ?? 'unknown reason'})`
        : `the attempt's fence is ${formatFence(attempt.fence)}`;
    appendAttemptLog(ctx, attempt.id, 'rejected', `${event.type} at fence ${formatFence(event.fence)} ignored: ${why}`);
    return null;
  }
  handler?.(ctx, event, { runnerId, emit, attempt, standing });
  return null;
}

function applyOne(
  ctx: HubContext,
  emit: Emit,
  runnerId: string,
  outboxEpoch: string,
  raw: RawRunnerEvent,
  options: ApplyOptions,
): void {
  const parsed = parseRunnerEvent(raw);
  if (!parsed.ok) {
    reject(ctx, emit, runnerId, outboxEpoch, raw, parsed.error);
    return;
  }
  let refusal: string | null;
  try {
    // A savepoint: whatever a throwing handler wrote is undone, and the rest of the batch goes on.
    refusal = tx(ctx, (inner) => dispatch(ctx, inner, runnerId, parsed.value, options));
  } catch (error) {
    refusal = `the hub failed to apply it: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (refusal !== null) reject(ctx, emit, runnerId, outboxEpoch, raw, refusal);
}

/**
 * Applies an events message from the runner, in seq order, skipping events at or below the acknowledged position,
 * and returns the new position for the ack. One transaction: the effects and the position commit together, and a
 * message that throws applies nothing, a gap after the link's hello included (ApplyOptions.helloLastSeq).
 */
export function applyRunnerEvents(
  ctx: HubContext,
  runnerId: string,
  message: { outboxEpoch: string; events: RawRunnerEvent[] },
  options: ApplyOptions,
): number {
  return tx(ctx, (emit) => {
    const { outboxEpoch } = message;
    let acked = acknowledgePosition(ctx, runnerId, outboxEpoch, 1);
    for (const raw of message.events) {
      if (raw.seq <= acked) continue;
      if (options.helloLastSeq !== undefined && raw.seq - 1 > Math.max(acked, options.helloLastSeq)) {
        throw new Error(`event ${raw.seq - 1} never arrived: the events skip from ${acked} to ${raw.seq}`);
      }
      applyOne(ctx, emit, runnerId, outboxEpoch, raw, options);
      acked = raw.seq;
    }
    ctx.db
      .query('UPDATE runner_inbox SET acked_seq = $acked WHERE runner_id = $runnerId AND outbox_epoch = $outboxEpoch')
      .run({ acked, runnerId, outboxEpoch });
    return acked;
  });
}

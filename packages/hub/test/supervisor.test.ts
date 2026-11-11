import { describe, expect, spyOn, test } from 'bun:test';
import type { Attempt, AttemptFacts, RawRunnerEvent, RunnerEventData, VendorOutcomeKind } from '@agflow/core';
import { getAttempt, issueFence, updateAttempt } from '../src/attempt-store';
import { markFactsStale, renewLeases, requestStop } from '../src/attempts';
import { pendingCommands } from '../src/commands';
import { type HubContext, tx } from '../src/context';
import { listEvents } from '../src/events';
import { applyRunnerEvents } from '../src/events-in';
import { listMessages } from '../src/messages';
import { findRunnerRow, vendorHolds } from '../src/runners';
import { requestSubmission } from '../src/submissions';
import { getTask, writeTask } from '../src/task-store';
import { judgeStalls, onVendorOutcome, replaceForVendorErrors } from '../src/supervisor';
import { type RunnerAttempt, addRunnerAttempt, addRunnerLead, createTestContext } from './helpers';

/** Facts of a busy, healthy worker; overrides make a rule fire. */
function factsOf(attempt: Attempt, overrides: Partial<AttemptFacts> = {}): AttemptFacts {
  return {
    attemptId: attempt.id,
    fence: attempt.fence,
    phase: 'turn',
    eventAgeMs: 5_000,
    tool: null,
    fsAgeMs: 20_000,
    commitAgeMs: null,
    turns: 3,
    turnsWithoutProgress: 0,
    repeatedCalls: 0,
    continuations: 1,
    vendorErrorMs: 0,
    activeMs: 90_000,
    contextUsed: 0.42,
    ...overrides,
  };
}

/** A running runner worker, and a heartbeat that reports its facts now. */
function setup() {
  const { ctx, clock } = createTestContext();
  const held = addRunnerAttempt(ctx);
  const beat = (attempt: Pick<Attempt, 'id'> & { runnerId: string | null }, overrides: Partial<AttemptFacts> = {}) =>
    tx(ctx, (emit) =>
      renewLeases(ctx, emit, attempt.runnerId as string, [factsOf(getAttempt(ctx, attempt.id), overrides)]),
    );
  return { ctx, clock, held, beat };
}

const silent = (ctx: HubContext): Partial<AttemptFacts> => ({ eventAgeMs: ctx.config.stallMs });

const stops = (ctx: HubContext, held: Pick<RunnerAttempt, 'runner'>) =>
  pendingCommands(ctx, held.runner.id, 1)
    .map((row) => row.command)
    .filter((command) => command.kind === 'stop_attempt');

const eventsOf = (ctx: HubContext, type: string) => listEvents(ctx.db).filter((event) => event.type === type);

describe('judgeStalls', () => {
  test('a rule firing on fresh facts is suspected; the next fresh heartbeat still firing stops the attempt', () => {
    const { ctx, clock, held, beat } = setup();
    beat(held.attempt, silent(ctx));
    expect(judgeStalls(ctx)).toEqual({ suspected: [held.attempt.id], stopped: [] });
    expect(getAttempt(ctx, held.attempt.id).stopRequested).toBeNull();
    // The same heartbeat judged again confirms nothing.
    clock.advance(ctx.config.heartbeatMs / 2);
    expect(judgeStalls(ctx)).toEqual({ suspected: [], stopped: [] });
    clock.advance(ctx.config.heartbeatMs / 2);
    beat(held.attempt, silent(ctx));
    expect(judgeStalls(ctx)).toEqual({ suspected: [], stopped: [held.attempt.id] });
    const attempt = getAttempt(ctx, held.attempt.id);
    expect(attempt.stopRequested).toMatchObject({ cause: 'stall_silent', by: 'system', handoff: true });
    expect(stops(ctx, held)).toMatchObject([{ cause: 'stall_silent', handoff: true, interruptFirst: true }]);
    const [stalled] = eventsOf(ctx, 'agent.stalled');
    expect(stalled?.data).toMatchObject({ cause: 'stall_silent', attemptId: held.attempt.id });
    expect(stalled?.data.reason).toContain('no agent event');
  });

  test('a suspicion the next heartbeat clears decides nothing, and the next one starts over', () => {
    const { ctx, clock, held, beat } = setup();
    beat(held.attempt, silent(ctx));
    judgeStalls(ctx);
    clock.advance(ctx.config.heartbeatMs);
    beat(held.attempt);
    expect(judgeStalls(ctx)).toEqual({ suspected: [], stopped: [] });
    clock.advance(ctx.config.heartbeatMs);
    beat(held.attempt, { repeatedCalls: 3 });
    expect(judgeStalls(ctx)).toEqual({ suspected: [held.attempt.id], stopped: [] });
    clock.advance(ctx.config.heartbeatMs);
    beat(held.attempt, { repeatedCalls: 4 });
    judgeStalls(ctx);
    expect(getAttempt(ctx, held.attempt.id).stopRequested?.cause).toBe('stall_loop');
  });

  test('facts older than two heartbeat intervals decide nothing, and their ages are never extrapolated', () => {
    const { ctx, clock, held, beat } = setup();
    // Just short of the stall window as of the heartbeat; the hub's clock moving on does not age it.
    beat(held.attempt, { eventAgeMs: ctx.config.stallMs - 1 });
    clock.advance(2 * ctx.config.heartbeatMs);
    expect(judgeStalls(ctx)).toEqual({ suspected: [], stopped: [] });
    beat(held.attempt, silent(ctx));
    judgeStalls(ctx);
    // The confirming heartbeat never came: the suspicion's facts went stale.
    clock.advance(2 * ctx.config.heartbeatMs + 1);
    expect(judgeStalls(ctx)).toEqual({ suspected: [], stopped: [] });
    expect(getAttempt(ctx, held.attempt.id).stopRequested).toBeNull();
  });

  test('a suspicion is not confirmed by a heartbeat whose facts went stale', () => {
    const { ctx, clock, held, beat } = setup();
    beat(held.attempt, silent(ctx));
    expect(judgeStalls(ctx)).toEqual({ suspected: [held.attempt.id], stopped: [] });
    clock.advance(ctx.config.heartbeatMs);
    beat(held.attempt, silent(ctx));
    clock.advance(2 * ctx.config.heartbeatMs + 1);
    expect(judgeStalls(ctx)).toEqual({ suspected: [], stopped: [] });
    expect(getAttempt(ctx, held.attempt.id).stopRequested).toBeNull();
  });

  test('a suspicion from before a resume is not confirmed at the new fence: it starts over', () => {
    const { ctx, clock, held, beat } = setup();
    beat(held.attempt, silent(ctx));
    judgeStalls(ctx);
    updateAttempt(ctx, held.attempt.id, { fence: issueFence(ctx) });
    clock.advance(ctx.config.heartbeatMs);
    beat(held.attempt, silent(ctx));
    expect(judgeStalls(ctx)).toEqual({ suspected: [held.attempt.id], stopped: [] });
    expect(getAttempt(ctx, held.attempt.id).stopRequested).toBeNull();
  });

  test('facts from a previous link decide nothing', () => {
    const { ctx, held, beat } = setup();
    beat(held.attempt, silent(ctx));
    markFactsStale(ctx, held.runner.id);
    expect(judgeStalls(ctx)).toEqual({ suspected: [], stopped: [] });
  });

  test('no decision while a submission is pending, a stop is recorded or the attempt is not running', () => {
    const { ctx, clock, held, beat } = setup();
    writeTask(ctx, held.task.id, { branch: 'agflow/T-1-task' });
    requestSubmission(ctx, held.task.id, held.agent, { summary: 'Done.', evidence: [] });
    const stopping = addRunnerAttempt(ctx);
    requestStop(ctx, { attemptId: stopping.attempt.id, cause: 'stop', reason: 'enough', by: 'user:alice' });
    const starting = addRunnerAttempt(ctx);
    updateAttempt(ctx, starting.attempt.id, { status: 'starting' });
    for (let beats = 0; beats < 2; beats += 1) {
      for (const each of [held, stopping, starting]) beat(each.attempt, silent(ctx));
      expect(judgeStalls(ctx)).toEqual({ suspected: [], stopped: [] });
      clock.advance(ctx.config.heartbeatMs);
    }
    expect(getAttempt(ctx, held.attempt.id).stopRequested).toBeNull();
    expect(getAttempt(ctx, stopping.attempt.id).stopRequested?.cause).toBe('stop');
  });

  test('a lead is judged only during a turn', () => {
    const { ctx, clock, beat } = setup();
    const lead = addRunnerLead(ctx);
    beat(lead.attempt, { ...silent(ctx), phase: 'idle' });
    expect(judgeStalls(ctx).suspected).not.toContain(lead.attempt.id);
    clock.advance(ctx.config.heartbeatMs);
    beat(lead.attempt, silent(ctx));
    expect(judgeStalls(ctx).suspected).toContain(lead.attempt.id);
  });

  test('one attempt failing to stop leaves the others judged', () => {
    const { ctx, clock, held, beat } = setup();
    const other = addRunnerAttempt(ctx);
    for (let beats = 0; beats < 2; beats += 1) {
      for (const each of [held, other]) beat(each.attempt, silent(ctx));
      if (beats === 0) judgeStalls(ctx);
      clock.advance(1);
    }
    ctx.db.run(
      `CREATE TRIGGER no_stop BEFORE UPDATE OF stop_requested ON attempts WHEN OLD.id = '${held.attempt.id}'
       BEGIN SELECT RAISE(ABORT, 'the disk is full'); END`,
    );
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(judgeStalls(ctx).stopped).toEqual([other.attempt.id]);
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
  });
});

describe('vendor errors', () => {
  test('vendorErrorMs past vendorErrorReplaceMs replaces the attempt and marks the vendor degraded there', () => {
    const { ctx, held, beat } = setup();
    beat(held.attempt, { phase: 'vendor_error', vendorErrorMs: ctx.config.vendorErrorReplaceMs - 1 });
    expect(replaceForVendorErrors(ctx)).toEqual([]);
    beat(held.attempt, { phase: 'vendor_error', vendorErrorMs: ctx.config.vendorErrorReplaceMs });
    // No second heartbeat is needed: vendor errors are no stall decision.
    expect(replaceForVendorErrors(ctx)).toEqual([held.attempt.id]);
    expect(getAttempt(ctx, held.attempt.id).stopRequested).toMatchObject({ cause: 'vendor_error', handoff: false });
    expect(stops(ctx, held)).toMatchObject([{ cause: 'vendor_error', handoff: false }]);
    const holds = vendorHolds(findRunnerRow(ctx, held.runner.id) as NonNullable<ReturnType<typeof findRunnerRow>>);
    expect(holds.claude?.degradedUntil).toBe(ctx.now() + ctx.config.degradedMs);
    // Once requested, it is not requested again.
    expect(replaceForVendorErrors(ctx)).toEqual([]);
  });

  test('judgeStalls replaces for vendor errors too, and stale facts replace nothing', () => {
    const { ctx, clock, held, beat } = setup();
    beat(held.attempt, { phase: 'vendor_error', vendorErrorMs: ctx.config.vendorErrorReplaceMs });
    clock.advance(2 * ctx.config.heartbeatMs + 1);
    expect(judgeStalls(ctx)).toEqual({ suspected: [], stopped: [] });
    beat(held.attempt, { phase: 'vendor_error', vendorErrorMs: ctx.config.vendorErrorReplaceMs });
    expect(judgeStalls(ctx)).toEqual({ suspected: [], stopped: [held.attempt.id] });
    expect(getAttempt(ctx, held.attempt.id).stopRequested?.cause).toBe('vendor_error');
  });
});

describe('vendor outcomes', () => {
  let seq = 0;

  /** The runner reports an attempt event at the attempt's fence. */
  function send<T extends 'attempt.vendor_outcome' | 'attempt.submitted'>(
    ctx: HubContext,
    held: RunnerAttempt,
    type: T,
    data: RunnerEventData[T],
  ) {
    const { id: attemptId, fence } = getAttempt(ctx, held.attempt.id);
    const events = [{ seq: ++seq, at: 0, type, attemptId, fence, data }] as RawRunnerEvent[];
    applyRunnerEvents(ctx, held.runner.id, { outboxEpoch: 'outbox-1', events }, { restoreReplay: false });
    expect(ctx.db.query('SELECT type, error FROM runner_event_rejects').all()).toEqual([]);
  }

  const report = (ctx: HubContext, held: RunnerAttempt, kind: VendorOutcomeKind, detail: string | null = null) =>
    send(ctx, held, 'attempt.vendor_outcome', { kind, detail });

  /** The attempt's task with a pending submission S-1. */
  function submitting(ctx: HubContext, held: RunnerAttempt): void {
    writeTask(ctx, held.task.id, { branch: 'agflow/T-1-task' });
    requestSubmission(ctx, held.task.id, held.agent, { summary: 'Done.', evidence: [] });
  }

  const head = 'a'.repeat(40);
  const pushed = { submissionId: 'S-1', ok: true, headSha: head, remoteHead: head, error: null, detail: null };
  const kindsOf = (ctx: HubContext, held: RunnerAttempt) =>
    pendingCommands(ctx, held.runner.id, 1).map((row) => row.command.kind);

  test('auth stops it crashed, with no handoff, and marks the vendor not ready with a preflight', () => {
    const { ctx, held } = setup();
    report(ctx, held, 'auth', 'OAuth token expired');
    expect(getAttempt(ctx, held.attempt.id).stopRequested).toMatchObject({ cause: 'auth', handoff: false });
    expect(getAttempt(ctx, held.attempt.id).stopRequested?.reason).toContain('login expired');
    const holds = vendorHolds(findRunnerRow(ctx, held.runner.id) as NonNullable<ReturnType<typeof findRunnerRow>>);
    expect(holds.claude?.notReadySince).toBe(ctx.now());
    const kinds = pendingCommands(ctx, held.runner.id, 1).map((row) => row.command.kind);
    expect(kinds).toContain('preflight');
  });

  test('context replaces it with a handoff', () => {
    const { ctx, held } = setup();
    report(ctx, held, 'context');
    expect(getAttempt(ctx, held.attempt.id).stopRequested).toMatchObject({ cause: 'context', handoff: true });
    expect(eventsOf(ctx, 'agent.replaced')).toHaveLength(1);
  });

  test('policy blocks the task as policy at once and tells people', () => {
    const { ctx, held } = setup();
    report(ctx, held, 'policy', 'The request was refused under the usage policy.');
    expect(getAttempt(ctx, held.attempt.id).stopRequested).toMatchObject({ cause: 'policy', handoff: false });
    expect(getTask(ctx, held.task.id)).toMatchObject({ status: 'blocked', blockedKind: 'policy' });
    const told = listMessages(ctx, { target: 'humans' });
    expect(told.map((message) => [message.from, message.taskId])).toEqual([['system', held.task.id]]);
    expect(told[0]?.body).toContain('The request was refused under the usage policy.');
  });

  test('denials and session_budget stop it as stall_budget', () => {
    for (const kind of ['denials', 'session_budget'] as const) {
      const { ctx, held } = setup();
      report(ctx, held, kind);
      expect([kind, getAttempt(ctx, held.attempt.id).stopRequested?.cause]).toEqual([kind, 'stall_budget']);
      expect(eventsOf(ctx, 'agent.stalled')).toHaveLength(1);
    }
  });

  test('while a submission is pending, the outcome is held back for it: no stop goes out', () => {
    for (const kind of ['session_budget', 'context', 'policy'] as const) {
      const { ctx, held } = setup();
      submitting(ctx, held);
      const { status } = getTask(ctx, held.task.id);
      report(ctx, held, kind);
      const stop = getAttempt(ctx, held.attempt.id).stopRequested;
      const cause = kind === 'session_budget' ? 'stall_budget' : kind;
      expect([kind, stop?.cause, stop?.deferred]).toEqual([kind, cause, true]);
      expect(stops(ctx, held)).toEqual([]);
      expect(getTask(ctx, held.task.id).status).toBe(status);
      if (kind === 'policy') {
        const [told] = listMessages(ctx, { target: 'humans' });
        expect(told?.body).toContain('It stops if its pending submission fails');
        expect(told?.body).toContain(`${held.task.id} keeps its status (${status})`);
      }
    }
  });

  test("while a submission is pending, a person's deferred stop and hold stays recorded", () => {
    const { ctx, held } = setup();
    submitting(ctx, held);
    requestStop(ctx, { attemptId: held.attempt.id, cause: 'stop_hold', reason: 'pause', by: 'user:alice' });
    for (const kind of ['session_budget', 'auth'] as const) report(ctx, held, kind);
    expect(getAttempt(ctx, held.attempt.id).stopRequested).toMatchObject({ cause: 'stop_hold', deferred: true });
    expect(stops(ctx, held)).toEqual([]);
    // The login still expired: the vendor waits for a preflight.
    const holds = vendorHolds(findRunnerRow(ctx, held.runner.id) as NonNullable<ReturnType<typeof findRunnerRow>>);
    expect(holds.claude?.notReadySince).toBe(ctx.now());
  });

  test('a submitted attempt that holds keeps its session and clone for the review, whatever the outcome', () => {
    for (const kind of ['session_budget', 'denials', 'context', 'policy', 'auth'] as const) {
      const { ctx, held } = setup();
      submitting(ctx, held);
      send(ctx, held, 'attempt.submitted', pushed);
      expect(getAttempt(ctx, held.attempt.id).status).toBe('holding');
      report(ctx, held, kind);
      const attempt = getAttempt(ctx, held.attempt.id);
      expect([kind, attempt.status, attempt.stopRequested]).toEqual([kind, 'holding', null]);
      expect(getTask(ctx, held.task.id).status).toBe('submitted');
      expect(kindsOf(ctx, held)).not.toContain('cleanup_attempt');
      expect(listMessages(ctx, { target: 'humans' })).toEqual([]);
      expect(kindsOf(ctx, held).includes('preflight')).toBe(kind === 'auth');
    }
  });

  test('an outcome for an attempt with a stop recorded follows the second-request rules', () => {
    const { ctx, held } = setup();
    requestStop(ctx, { attemptId: held.attempt.id, cause: 'stop', reason: 'enough', by: 'user:alice' });
    tx(ctx, (emit) => onVendorOutcome(ctx, emit, getAttempt(ctx, held.attempt.id), { kind: 'context', detail: null }));
    expect(getAttempt(ctx, held.attempt.id).stopRequested?.cause).toBe('stop');
    tx(ctx, (emit) => onVendorOutcome(ctx, emit, getAttempt(ctx, held.attempt.id), { kind: 'policy', detail: null }));
    expect(getAttempt(ctx, held.attempt.id).stopRequested?.cause).toBe('policy');
  });
});

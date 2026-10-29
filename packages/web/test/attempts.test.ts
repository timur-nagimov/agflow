import { describe, expect, test } from 'bun:test';
import {
  type Attempt,
  type AttemptFacts,
  type AttemptLogEntry,
  type AttemptPhase,
  AttemptLogEntrySchema,
  AttemptPhaseSchema,
  AttemptSchema,
  FIXABLE_SUBMIT_ERRORS,
  STOP_CAUSES,
  StopCauseSchema,
  SUBMIT_ERRORS,
  type SubmissionRecord,
  type Task,
} from '@agflow/core';
import {
  ATTEMPT_STATUS_LABELS,
  attemptLabel,
  attemptTone,
  currentAttempt,
  END_REASON_LABELS,
  FAILURE_CLASS_LABELS,
  factsRows,
  holderOf,
  isOpen,
  LOG_KIND_LABELS,
  LOG_KIND_TONES,
  phaseLabel,
  STOP_CAUSE_LABELS,
  SUBMIT_ERROR_TEXTS,
  submissionOutcome,
  wipText,
} from '../src/attempts';

const MINUTE = 60_000;
const NOW = 1_800_000_000_000;
const SHA = '3f9a1c2b7d4e5f60718293a4b5c6d7e8f9012345';

function attempt(overrides: Partial<Attempt> = {}): Attempt {
  return {
    id: 'T-42-a3',
    taskId: 'T-42',
    number: 3,
    role: 'worker',
    agentId: 'A-7',
    runnerId: 'R-1',
    vendor: 'claude',
    model: 'claude-sonnet',
    sessionRef: 'session-1',
    fence: { epoch: 1, counter: 4 },
    status: 'running',
    endReason: null,
    failureClass: null,
    failureSignature: null,
    startRef: 'refs/heads/main',
    startSha: SHA,
    wipRef: 'refs/agflow/T-42/a3',
    wipSha: SHA,
    submittedSha: null,
    resumable: true,
    reviewRounds: 0,
    wakeups: 0,
    activeMs: 20 * MINUTE,
    phase: 'turn',
    facts: null,
    stopRequested: null,
    takeover: null,
    leaseExpiresAt: NOW + 15 * MINUTE,
    quotaResetsAt: null,
    startedAt: NOW - 30 * MINUTE,
    endedAt: null,
    lastActivityAt: NOW,
    ...overrides,
  };
}

function facts(overrides: Partial<AttemptFacts> = {}): AttemptFacts {
  return {
    attemptId: 'T-42-a3',
    fence: { epoch: 1, counter: 4 },
    phase: 'turn',
    eventAgeMs: 12_000,
    tool: { name: 'Bash', command: 'bun test', long: false, capMs: 10 * MINUTE, ageMs: 4 * MINUTE },
    fsAgeMs: 3 * MINUTE,
    commitAgeMs: null,
    turns: 14,
    turnsWithoutProgress: 1,
    repeatedCalls: 0,
    continuations: 2,
    vendorErrorMs: 0,
    activeMs: 75 * MINUTE,
    contextUsed: 0.423,
    ...overrides,
  };
}

const stop = (cause: NonNullable<Attempt['stopRequested']>['cause'], deferred = false): Attempt['stopRequested'] => ({
  cause,
  reason: 'stuck',
  by: 'user:demo',
  handoff: true,
  deferred,
  at: NOW - MINUTE,
});

describe('labels', () => {
  test("the label tables cover every value core's attempt schema accepts", () => {
    const parses = (overrides: Partial<Attempt>) => AttemptSchema.safeParse(attempt(overrides)).success;
    expect(Object.keys(ATTEMPT_STATUS_LABELS)).toEqual(['starting', 'running', 'quota_wait', 'holding', 'ended']);
    for (const status of Object.keys(ATTEMPT_STATUS_LABELS)) {
      expect(parses({ status: status as Attempt['status'] })).toBe(true);
    }
    expect(Object.keys(END_REASON_LABELS)).toHaveLength(14);
    for (const endReason of Object.keys(END_REASON_LABELS)) {
      expect(parses({ status: 'ended', endReason: endReason as Attempt['endReason'] })).toBe(true);
    }
    expect(Object.keys(FAILURE_CLASS_LABELS)).toEqual(['infra', 'agent', 'review']);
    for (const failureClass of Object.keys(FAILURE_CLASS_LABELS)) {
      expect(parses({ failureClass: failureClass as Attempt['failureClass'] })).toBe(true);
    }
    expect(parses({ status: 'asleep' as Attempt['status'] })).toBe(false);
    expect(Object.keys(STOP_CAUSE_LABELS).sort()).toEqual(Object.keys(STOP_CAUSES).sort());
    for (const cause of Object.keys(STOP_CAUSE_LABELS)) expect(StopCauseSchema.safeParse(cause).success).toBe(true);
  });

  test('a few labels in words', () => {
    expect(ATTEMPT_STATUS_LABELS.quota_wait).toBe('Waiting for quota');
    expect(END_REASON_LABELS.failed_to_start).toBe('Failed to start');
    expect(END_REASON_LABELS.taken_over).toBe('Taken over');
    expect(FAILURE_CLASS_LABELS.infra).toBe('Infrastructure');
    expect(STOP_CAUSE_LABELS.stall_hung_tool).toBe('Stalled: a tool hung');
    expect(STOP_CAUSE_LABELS.stop_hold).toBe('Stop and hold');
  });
});

describe('phase', () => {
  test('every phase reads as section 11 lists it', () => {
    const phases: AttemptPhase[] = [
      'starting',
      'preparing',
      'turn',
      'idle',
      'waiting_approval',
      'quota_wait',
      'vendor_error',
      'stopping',
    ];
    for (const phase of phases) expect(AttemptPhaseSchema.safeParse(phase).success).toBe(true);
    expect(phases.map((phase) => phaseLabel(attempt({ phase })))).toEqual([
      'Starting',
      'Preparing',
      'Working',
      'Idle',
      'Waiting for approval',
      'Waiting for quota',
      'Vendor error',
      'Stopping',
    ]);
  });

  test('the status speaks when the phase does not, a stop request shows as stopping, an end as its reason', () => {
    expect(phaseLabel(attempt({ status: 'starting', phase: null }))).toBe('Starting');
    expect(phaseLabel(attempt({ status: 'running', phase: null }))).toBe('Running');
    expect(phaseLabel(attempt({ status: 'quota_wait', phase: 'turn' }))).toBe('Waiting for quota');
    expect(phaseLabel(attempt({ status: 'holding', phase: 'idle' }))).toBe('Holding');
    expect(phaseLabel(attempt({ stopRequested: stop('stop') }))).toBe('Stopping');
    // A deferred stop waits for the pending submission, so the agent goes on as before.
    expect(phaseLabel(attempt({ stopRequested: stop('stop', true) }))).toBe('Working');
    expect(phaseLabel(attempt({ status: 'ended', endReason: 'stalled', phase: 'turn', stopRequested: stop('stall_loop') }))).toBe(
      'Stalled',
    );
    expect(phaseLabel(attempt({ status: 'ended', endReason: null }))).toBe('Ended');
  });
});

describe('tones and names', () => {
  test('open attempts are active, holding ones review, ended ones follow their class', () => {
    expect(attemptTone(attempt({ status: 'starting' }))).toBe('active');
    expect(attemptTone(attempt({ status: 'quota_wait' }))).toBe('active');
    expect(attemptTone(attempt({ status: 'holding' }))).toBe('review');
    const ended = (endReason: Attempt['endReason'], failureClass: Attempt['failureClass']) =>
      attemptTone(attempt({ status: 'ended', endReason, failureClass }));
    expect(ended('stalled', 'agent')).toBe('trouble');
    expect(ended('rejected', 'review')).toBe('trouble');
    expect(ended('lost', 'infra')).toBe('wait');
    expect(ended('stopped', null)).toBe('closed');
    expect(ended('accepted', null)).toBe('done');
  });

  test('short attempt labels', () => {
    expect(attemptLabel('T-42-a3')).toBe('a3');
    expect(attemptLabel('T-42-e2-a3')).toBe('e2-a3');
    expect(attemptLabel('lead-a5')).toBe('lead a5');
    expect(attemptLabel('lead-e3-a1')).toBe('lead e3-a1');
    expect(attemptLabel('not-an-id')).toBe('not-an-id');
  });

  test('the WIP position', () => {
    expect(wipText(attempt())).toBe('refs/agflow/T-42/a3 at 3f9a1c2');
    expect(wipText(attempt({ wipSha: null }))).toBe('refs/agflow/T-42/a3');
    expect(wipText(attempt({ wipRef: null, wipSha: null }))).toBeNull();
  });
});

describe('facts', () => {
  test("the attempt page's facts rows", () => {
    expect(factsRows(facts())).toEqual([
      { label: 'Last agent event', value: '12 s ago', tone: null },
      { label: 'Tool in flight', value: 'Bash (bun test), running 4 min of its 10 min cap', tone: null },
      { label: 'Last file change', value: '3 min ago', tone: null },
      { label: 'Last commit', value: 'none yet', tone: null },
      { label: 'Turns', value: '14', tone: null },
      { label: 'Turns without progress', value: '1', tone: null },
      { label: 'Repeated calls', value: '0', tone: null },
      { label: 'Continuations', value: '2', tone: null },
      { label: 'Vendor errors', value: 'none', tone: null },
      { label: 'Active time', value: '1 h 15 min', tone: null },
      { label: 'Context used', value: '42%', tone: null },
    ]);
  });

  test('a tool past its cap, no tool, vendor errors and unknown context', () => {
    const rows = factsRows(
      facts({
        tool: { name: 'Bash', command: null, long: true, capMs: 10 * MINUTE, ageMs: 11 * MINUTE },
        vendorErrorMs: 90_000,
        contextUsed: null,
      }),
    );
    const byLabel = Object.fromEntries(rows.map((row) => [row.label, row]));
    expect(byLabel['Tool in flight']).toEqual({
      label: 'Tool in flight',
      value: 'Bash, running 11 min of its 10 min cap',
      tone: 'trouble',
    });
    expect(byLabel['Vendor errors']).toEqual({ label: 'Vendor errors', value: 'for 2 min', tone: 'trouble' });
    expect(byLabel['Context used']?.value).toBe('unknown');
    const idle = factsRows(facts({ tool: null }));
    expect(idle.find((row) => row.label === 'Tool in flight')?.value).toBe('none');
    const uncapped = factsRows(facts({ tool: { name: 'Read', command: null, long: false, capMs: null, ageMs: 5_000 } }));
    expect(uncapped.find((row) => row.label === 'Tool in flight')?.value).toBe('Read, running 5 s');
  });

  test('nothing without facts', () => {
    expect(factsRows(null)).toEqual([]);
  });
});

describe('log kinds', () => {
  test('every log kind has a label and a tone', () => {
    const kinds = Object.keys(LOG_KIND_LABELS) as AttemptLogEntry['kind'][];
    expect(Object.keys(LOG_KIND_TONES)).toEqual(kinds);
    const entry = (kind: string) => ({ id: 1, attemptId: 'T-42-a3', ts: NOW, kind, summary: 's' });
    for (const kind of kinds) expect(AttemptLogEntrySchema.safeParse(entry(kind)).success).toBe(true);
    expect(kinds).toHaveLength(10);
    expect(LOG_KIND_LABELS.vendor_error).toBe('Vendor error');
    expect(LOG_KIND_TONES.violation).toBe('trouble');
  });
});

describe('submissions', () => {
  const record = (overrides: Partial<SubmissionRecord> = {}): SubmissionRecord => ({
    id: 'S-1',
    taskId: 'T-42',
    attemptId: 'T-42-a3',
    status: 'pending',
    summary: 'Parser done',
    evidence: [],
    headSha: null,
    error: null,
    requestedAt: NOW,
    decidedAt: null,
    ...overrides,
  });

  test("the outcome texts cover core's SUBMIT_ERRORS, and say which ones the agent fixes", () => {
    expect(Object.keys(SUBMIT_ERROR_TEXTS)).toEqual([...SUBMIT_ERRORS]);
    const fixable = Object.entries(SUBMIT_ERROR_TEXTS).filter(([, spec]) => spec.fixable);
    expect(fixable.map(([code]) => code)).toEqual([...FIXABLE_SUBMIT_ERRORS]);
  });

  test('pending, submitted and each refusal in plain words', () => {
    expect(submissionOutcome(record())).toEqual({
      text: 'Pending: the runner is pushing it',
      tone: 'active',
      fixable: false,
      detail: null,
    });
    expect(submissionOutcome(record({ status: 'submitted', headSha: SHA }))).toEqual({
      text: 'Submitted at 3f9a1c2',
      tone: 'review',
      fixable: false,
      detail: null,
    });
    const failed = (error: string) => submissionOutcome(record({ status: 'failed', error }));
    expect(failed('dirty')).toEqual({
      text: 'Refused: the clone had uncommitted changes. The agent fixes this and submits again',
      tone: 'trouble',
      fixable: true,
      detail: null,
    });
    expect(failed('protected_paths').text).toBe(
      'Refused: it changed protected paths. The agent fixes this and submits again',
    );
    expect(failed('needs_merge').text).toBe(
      'Refused: someone added commits to the task branch, so it must merge them first. The agent fixes this and submits again',
    );
    expect(failed('branch_moved')).toEqual({
      text: 'Refused: the task branch moved outside agflow',
      tone: 'trouble',
      fixable: false,
      detail: null,
    });
    expect(failed('remote').text).toBe('Failed: pushing to the remote kept failing');
    expect(failed('interrupted').text).toBe('Interrupted: a stop arrived while it was pushing');
  });

  test("a refusal with the runner's detail reads in plain words, the detail kept beside them", () => {
    expect(
      submissionOutcome(record({ status: 'failed', error: 'needs_merge: someone pushed to agflow/T-10 since then' })),
    ).toEqual({
      text: 'Refused: someone added commits to the task branch, so it must merge them first. The agent fixes this and submits again',
      tone: 'trouble',
      fixable: true,
      detail: 'someone pushed to agflow/T-10 since then',
    });
    expect(submissionOutcome(record({ status: 'failed', error: 'remote: timeout' })).detail).toBe('timeout');
    // A colon alone does not make a code.
    expect(submissionOutcome(record({ status: 'failed', error: 'push: timeout' })).text).toBe('push: timeout');
  });

  test('other errors show as given', () => {
    expect(submissionOutcome(record({ status: 'failed', error: 'attempt ended: stalled' }))).toEqual({
      text: 'attempt ended: stalled',
      tone: 'trouble',
      fixable: false,
      detail: null,
    });
    expect(submissionOutcome(record({ status: 'failed', error: null })).text).toBe('Failed');
  });
});

describe('the current attempt and who holds the task', () => {
  const held = (overrides: Partial<Task> = {}) =>
    ({ status: 'working', assignee: 'A-7', currentAttempt: 'T-42-a3', ...overrides }) as Task;

  test('currentAttempt finds the task\'s current attempt', () => {
    const attempts = [attempt({ id: 'T-42-a2', number: 2, status: 'ended' }), attempt()];
    expect(currentAttempt(held(), attempts)?.id).toBe('T-42-a3');
    expect(currentAttempt(held({ currentAttempt: null }), attempts)).toBeNull();
    expect(currentAttempt(held({ currentAttempt: 'T-42-a9' }), attempts)).toBeNull();
  });

  test('a runner, a live chat or nobody', () => {
    expect(holderOf(held(), [attempt()])).toBe('runner');
    expect(holderOf(held(), [attempt({ runnerId: null })])).toBe('live');
    expect(holderOf(held({ status: 'submitted' }), [attempt({ status: 'holding' })])).toBe('runner');
    expect(holderOf(held({ status: 'ready' }), [attempt({ status: 'ended', endReason: 'stopped' })])).toBe('nobody');
    expect(holderOf(held(), [attempt({ status: 'ended', endReason: 'lost' })])).toBe('nobody');
    // A claim from before M2 has no attempt; its holder is a live chat.
    expect(holderOf(held({ currentAttempt: null }), [])).toBe('live');
    expect(holderOf(held({ status: 'ready', assignee: null, currentAttempt: null }), [])).toBe('nobody');
  });

  test('every status but ended is open', () => {
    expect(isOpen(attempt({ status: 'holding' }))).toBe(true);
    expect(isOpen(attempt({ status: 'quota_wait' }))).toBe(true);
    expect(isOpen(attempt({ status: 'ended' }))).toBe(false);
  });
});

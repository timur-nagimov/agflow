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
  HandbackInputSchema,
  type Runner,
  STOP_CAUSES,
  type StopCause,
  StopCauseSchema,
  SUBMIT_ERRORS,
  type SubmissionRecord,
  TAKEOVER_REFUSALS,
  type Task,
  type TaskNote,
} from '@agflow/core';
import {
  ATTEMPT_STATUS_LABELS,
  actionOutcomeText,
  attemptLabel,
  attemptTone,
  canHandBack,
  currentAttempt,
  END_REASON_LABELS,
  FAILURE_CLASS_LABELS,
  factsRows,
  handbackSource,
  holderOf,
  isOpen,
  LOG_KIND_LABELS,
  LOG_KIND_TONES,
  noteGroups,
  phaseLabel,
  RUNNER_ACTIONS,
  runnerActionBody,
  runnerActionsFor,
  STOP_CAUSE_LABELS,
  SUBMIT_ERROR_TEXTS,
  submissionOutcome,
  takeoverRefusal,
  takeoverState,
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

describe('runner actions', () => {
  const online = { state: 'online' } as const;
  const offline = { state: 'offline' } as const;

  test('stop, stop and hold and replace need a reason; interrupt and take over need none', () => {
    expect(
      Object.entries(RUNNER_ACTIONS).map(([action, spec]) => [action, spec.label, spec.reason, spec.route]),
    ).toEqual([
      ['interrupt', 'Interrupt', false, 'interrupt'],
      ['stop', 'Stop', true, 'stop'],
      ['stop_hold', 'Stop and hold', true, 'stop'],
      ['replace', 'Replace', true, 'replace'],
      ['takeover', 'Take over', false, null],
    ]);
    expect(runnerActionBody('stop', '  stuck in a loop ')).toEqual({ reason: 'stuck in a loop' });
    expect(runnerActionBody('stop_hold', 'I want to look')).toEqual({ reason: 'I want to look', hold: true });
    expect(runnerActionBody('replace', 'wrong approach')).toEqual({ reason: 'wrong approach' });
    expect(runnerActionBody('replace', '   ')).toBeNull();
    expect(runnerActionBody('interrupt', '')).toEqual({});
    expect(runnerActionBody('takeover', '')).toEqual({});
  });

  test('a worker on an online runner', () => {
    expect(runnerActionsFor(attempt(), online)).toEqual(['interrupt', 'stop', 'stop_hold', 'replace', 'takeover']);
    // Interrupt stops a turn, so it is offered only during one.
    expect(runnerActionsFor(attempt({ phase: 'idle' }), online)).toEqual(['stop', 'stop_hold', 'replace', 'takeover']);
    expect(runnerActionsFor(attempt({ status: 'quota_wait', phase: 'quota_wait' }), online)).toEqual([
      'stop',
      'stop_hold',
      'replace',
      'takeover',
    ]);
    expect(runnerActionsFor(attempt({ status: 'starting', phase: 'starting' }), online)).toEqual([
      'stop',
      'stop_hold',
      'replace',
    ]);
  });

  test('interrupt is offered only during a turn', () => {
    // Keyed by AttemptPhase, so a phase core adds fails the typecheck until it is listed here.
    const every: Record<AttemptPhase, true> = {
      starting: true,
      preparing: true,
      turn: true,
      idle: true,
      waiting_approval: true,
      quota_wait: true,
      vendor_error: true,
      stopping: true,
    };
    const phases: (AttemptPhase | null)[] = [...(Object.keys(every) as AttemptPhase[]), null];
    for (const phase of phases.filter((candidate) => candidate !== 'turn')) {
      expect([phase, runnerActionsFor(attempt({ phase }), online).includes('interrupt')]).toEqual([phase, false]);
    }
    expect(runnerActionsFor(attempt({ phase: 'turn' }), online)).toContain('interrupt');
  });

  test("no take-over while the runner stops the agent on its own, which records no stop", () => {
    expect(runnerActionsFor(attempt({ phase: 'stopping' }), online)).toEqual(['stop', 'stop_hold', 'replace']);
  });

  test('a worker on a runner that is not online gets no interrupt and no take-over', () => {
    expect(runnerActionsFor(attempt(), offline)).toEqual(['stop', 'stop_hold', 'replace']);
    expect(runnerActionsFor(attempt(), { state: 'crash_loop' })).toEqual(['stop', 'stop_hold', 'replace']);
    expect(runnerActionsFor(attempt(), null)).toEqual(['stop', 'stop_hold', 'replace']);
  });

  test('after a stop, replace or stall cause only stop and hold remains', () => {
    const causes = ['stop', 'replace', 'stall_silent', 'stall_hung_tool', 'stall_loop', 'stall_no_progress', 'stall_budget'];
    for (const cause of causes as StopCause[]) {
      expect(runnerActionsFor(attempt({ stopRequested: stop(cause) }), online)).toEqual(['stop_hold']);
    }
  });

  test('after any other cause, a take-over included, nothing remains', () => {
    const holdReplaces = ['stop', 'replace', 'stall_silent', 'stall_hung_tool', 'stall_loop', 'stall_no_progress', 'stall_budget'];
    const others = (Object.keys(STOP_CAUSES) as StopCause[]).filter((cause) => !holdReplaces.includes(cause));
    expect(others).toHaveLength(13);
    for (const cause of others) {
      expect([cause, runnerActionsFor(attempt({ stopRequested: stop(cause) }), online)]).toEqual([cause, []]);
    }
  });

  test('a deferred stop can be replaced by stop, stop and hold or replace, but not by take over', () => {
    expect(runnerActionsFor(attempt({ stopRequested: stop('stop', true) }), online)).toEqual([
      'stop',
      'stop_hold',
      'replace',
    ]);
  });

  test('holding and ended attempts, runner leads and live chats', () => {
    expect(runnerActionsFor(attempt({ status: 'holding', phase: 'idle' }), online)).toEqual([]);
    expect(runnerActionsFor(attempt({ status: 'ended', endReason: 'stopped' }), online)).toEqual([]);
    const lead = attempt({ id: 'lead-a5', taskId: null, number: 5, role: 'lead' });
    expect(runnerActionsFor(lead, online)).toEqual(['interrupt', 'stop', 'replace']);
    expect(runnerActionsFor({ ...lead, phase: 'idle' }, online)).toEqual(['stop', 'replace']);
    expect(runnerActionsFor(lead, offline)).toEqual(['stop', 'replace']);
    expect(runnerActionsFor({ ...lead, stopRequested: stop('stop') }, online)).toEqual([]);
    expect(runnerActionsFor(attempt({ runnerId: null }), null)).toEqual([]);
    expect(runnerActionsFor(null, online)).toEqual([]);
  });

  test('an accepted action says what the hub did: done, kept the recorded stop, or held behind a submission', () => {
    expect(actionOutcomeText('interrupt', null)).toBe('Interrupt sent: the runner interrupts the turn.');
    expect(actionOutcomeText('stop_hold', attempt({ stopRequested: stop('stop_hold') }))).toBe(
      'Stop and hold recorded: the agent writes a handoff note, and the task waits for people.',
    );
    expect(actionOutcomeText('replace', attempt({ stopRequested: stop('replace') }))).toBe(
      'Replace recorded: the agent writes a handoff note, and a new agent goes on from its work.',
    );
    // X-34: a context stop may not be replaced, so the hub answers with it unchanged.
    const context = { ...stop('context'), by: 'system' } as NonNullable<Attempt['stopRequested']>;
    expect(actionOutcomeText('stop_hold', attempt({ stopRequested: context }))).toBe(
      'The hub kept the stop already recorded (Context window full, asked by agflow): your request changed nothing.',
    );
    // 6.13: a pending submission holds the stop back; it applies only if the push fails.
    expect(actionOutcomeText('stop', attempt({ stopRequested: stop('stop', true) }))).toBe(
      'Recorded, but it waits for the pending submission: if the push fails it applies; if it lands, it is dropped ' +
        'and the task goes up for review.',
    );
    // An attempt that ended at once (no live process) still names the stop it ended for.
    expect(actionOutcomeText('stop', attempt({ status: 'ended', stopRequested: stop('stop') }))).toBe(
      'Stop recorded: the agent writes a handoff note, then stops.',
    );
  });
});

describe('take-over', () => {
  const takenOver = { status: 'blocked', blockedKind: 'takeover' } as const;
  const commands = {
    local: 'cd /Users/demo/.agflow/work/T-42-a3 && claude --resume session-1',
    anywhere: 'git fetch origin refs/agflow/T-42/a3 && git switch -c agflow/T-42-parser FETCH_HEAD',
    ref: 'refs/agflow/T-42/takeover-demo',
    error: null,
    handingBack: null,
  };
  const ended = (takeover: Attempt['takeover']) =>
    attempt({ status: 'ended', endReason: 'taken_over', stopRequested: stop('takeover'), takeover });

  test('each refusal is explained and offers Stop and hold instead', () => {
    for (const code of TAKEOVER_REFUSALS) expect(takeoverRefusal(code)?.offer).toBe('stop_hold');
    expect(takeoverRefusal('runner_offline')?.message).toBe(
      "Its runner is offline, so nobody can hand you its clone. Stop and hold keeps the task for people, from the agent's last pushed work.",
    );
    expect(takeoverRefusal('not_running')?.message).toBe(
      "The agent is not running, or a stop is already on its way. Stop and hold keeps the task for people, from the agent's last pushed work.",
    );
    expect(takeoverRefusal('submission_pending')?.message).toBe(
      "A submission is being pushed. Wait for its outcome, or stop and hold the task: it then waits for people, from the agent's last pushed work.",
    );
    expect(takeoverRefusal('not_found')).toBeNull();
  });

  test('none, preparing, ready, failed, unrecorded', () => {
    expect(takeoverState({ status: 'working', blockedKind: null }, attempt())).toEqual({ kind: 'none' });
    expect(takeoverState(takenOver, null)).toEqual({ kind: 'none' });
    expect(takeoverState(takenOver, attempt({ stopRequested: stop('takeover') }))).toEqual({ kind: 'preparing' });
    // The attempt ended before the runner recorded any commands, its runner retired mid-take-over, say.
    const lost = attempt({ status: 'ended', endReason: 'lost', stopRequested: stop('takeover'), takeover: null });
    expect(takeoverState(takenOver, lost)).toEqual({ kind: 'unrecorded' });
    expect(takeoverState(takenOver, ended(commands))).toEqual({
      kind: 'ready',
      local: commands.local,
      anywhere: commands.anywhere,
      ref: commands.ref,
      handbackError: null,
    });
    // At lease expiry or the stop timeout the hub builds only the command that works anywhere.
    expect(takeoverState(takenOver, ended({ ...commands, local: null }))).toEqual({
      kind: 'ready',
      local: null,
      anywhere: commands.anywhere,
      ref: commands.ref,
      handbackError: null,
    });
    expect(takeoverState(takenOver, ended({ ...commands, local: null, error: 'harvest failed: disk full' }))).toEqual({
      kind: 'failed',
      error: 'harvest failed: disk full',
      anywhere: commands.anywhere,
      ref: commands.ref,
    });
  });

  test('a refused clone hand-back keeps the commands and shows its error', () => {
    const refused = ended({ ...commands, error: 'process_running: pids 4121, 4188 still run in the clone' });
    expect(takeoverState(takenOver, refused)).toMatchObject({
      kind: 'ready',
      local: commands.local,
      handbackError: 'process_running: pids 4121, 4188 still run in the clone',
    });
    expect(canHandBack(takenOver, refused, online(), { user: 'demo' })).toBe(true);
  });

  test('a refused clone hand-back after the hub ended the take-over itself is still a hand-back error', () => {
    const error = 'process_running: pids 4121 still run in the clone';
    expect(takeoverState(takenOver, ended({ ...commands, local: null, error }))).toEqual({
      kind: 'ready',
      local: null,
      anywhere: commands.anywhere,
      ref: commands.ref,
      handbackError: error,
    });
  });

  test('a hand-back from the clone on its way shows who sent it and allows no second one', () => {
    const handingBack = { by: 'user:demo', at: 1_700_000_000_000 };
    const pending = ended({ ...commands, handingBack });
    expect(takeoverState(takenOver, pending)).toEqual({ kind: 'handing_back', ...handingBack });
    expect(canHandBack(takenOver, pending, online(), { user: 'demo' })).toBe(false);
    expect(canHandBack(takenOver, pending, { state: 'offline' }, { user: 'ann' })).toBe(false);
    // A refused one clears handingBack and records the error, and the person may hand back again.
    const refused = ended({ ...commands, error: 'process_running: pids 4121 still run in the clone' });
    expect(canHandBack(takenOver, refused, online(), { user: 'demo' })).toBe(true);
  });

  test('a take-over that ended unrecorded can be handed back; one still preparing cannot', () => {
    const lost = attempt({ status: 'ended', endReason: 'lost', stopRequested: stop('takeover'), takeover: null });
    expect(canHandBack(takenOver, lost, online(), { user: 'demo' })).toBe(true);
    expect(canHandBack(takenOver, lost, online(), { user: 'ann' })).toBe(false);
    expect(canHandBack(takenOver, lost, null, { user: 'ann' })).toBe(true);
    const preparing = attempt({ stopRequested: stop('takeover'), takeover: null });
    expect(canHandBack(takenOver, preparing, online(), { user: 'demo' })).toBe(false);
    expect(canHandBack(takenOver, preparing, null, { user: 'ann' })).toBe(false);
  });

  test('the person who took over hands back, or anyone once the runner is not online; nobody while preparing', () => {
    const ready = ended(commands);
    expect(canHandBack(takenOver, ready, online(), { user: 'demo' })).toBe(true);
    expect(canHandBack(takenOver, ready, online(), { user: 'ann' })).toBe(false);
    expect(canHandBack(takenOver, ready, online(), null)).toBe(false);
    expect(canHandBack(takenOver, ready, { state: 'offline' }, { user: 'ann' })).toBe(true);
    expect(canHandBack(takenOver, ready, { state: 'needs_login' }, { user: 'ann' })).toBe(true);
    expect(canHandBack(takenOver, ready, null, { user: 'ann' })).toBe(true);
    const preparing = attempt({ stopRequested: stop('takeover') });
    expect(canHandBack(takenOver, preparing, online(), { user: 'demo' })).toBe(false);
    expect(canHandBack(takenOver, preparing, { state: 'offline' }, { user: 'ann' })).toBe(false);
    expect(canHandBack({ status: 'ready', blockedKind: null }, ready, online(), { user: 'demo' })).toBe(false);
  });

  function online(): Pick<Runner, 'state'> {
    return { state: 'online' };
  }
});

describe('hand-back sources', () => {
  const FULL = '0123456789abcdef0123456789abcdef01234567';

  test('the clone, or a ref under refs/ at a full sha', () => {
    expect(handbackSource('clone')).toBe('clone');
    expect(handbackSource({ ref: ' refs/agflow/T-42/takeover-demo ', sha: ` ${FULL.toUpperCase()} ` })).toEqual({
      ref: 'refs/agflow/T-42/takeover-demo',
      sha: FULL,
    });
    expect(handbackSource({ ref: 'refs/agflow/T-42/takeover-demo', sha: FULL.slice(0, 12) })).toBeNull();
    expect(handbackSource({ ref: 'agflow/T-42-parser', sha: FULL })).toBeNull();
  });

  test("agrees with core's HandbackInputSchema", () => {
    const cases: { ref: string; sha: string }[] = [
      { ref: 'refs/agflow/T-42/takeover-demo', sha: FULL },
      { ref: 'refs/heads/agflow/T-42-parser', sha: FULL },
      { ref: 'refs/agflow/T-42/takeover-demo', sha: FULL.slice(0, 39) },
      { ref: 'refs/agflow/T-42/takeover-demo', sha: `${FULL}0` },
      { ref: 'refs/agflow/T-42/takeover-demo', sha: `${FULL.slice(0, 39)}g` },
      { ref: 'heads/main', sha: FULL },
      { ref: 'refs/', sha: FULL },
      { ref: 'refs//x', sha: FULL },
      { ref: 'refs/agflow/../main', sha: FULL },
      { ref: 'refs/agflow/a..b', sha: FULL },
      { ref: 'refs/agflow/x.', sha: FULL },
      { ref: 'refs/agflow/.x', sha: FULL },
      { ref: 'refs/agflow/x.lock', sha: FULL },
      { ref: 'refs/agflow/x y', sha: FULL },
      { ref: 'refs/agflow/x~1', sha: FULL },
      { ref: `refs/${'a'.repeat(196)}`, sha: FULL },
      { ref: `refs/${'a'.repeat(195)}`, sha: FULL },
      { ref: '', sha: FULL },
    ];
    for (const source of cases) {
      const schema = HandbackInputSchema.safeParse({ source }).success;
      expect({ source, accepted: handbackSource(source) !== null }).toEqual({ source, accepted: schema });
    }
    expect(cases.filter((source) => handbackSource(source) !== null)).toHaveLength(3);
    expect(HandbackInputSchema.safeParse({ source: handbackSource('clone') }).success).toBe(true);
  });
});

describe('note groups', () => {
  let nextId = 1;
  const note = (kind: TaskNote['kind'], attemptId: string | null, createdAt = NOW): TaskNote => ({
    id: nextId++,
    taskId: 'T-42',
    kind,
    body: `${kind} of ${attemptId}`,
    author: 'A-7',
    createdAt,
    attemptId,
  });
  const attempts = [
    attempt({ id: 'T-42-a2', number: 2, status: 'ended' }),
    attempt({ id: 'T-42-a1', number: 1, status: 'ended' }),
    attempt({ id: 'T-42-e2-a1', number: 1, status: 'running' }),
  ];

  test("each attempt's handoff and late work sit beside its successor's restatement, in attempt order", () => {
    const handoff1 = note('handoff', 'T-42-a1');
    const restate2 = note('restatement', 'T-42-a2');
    const late1 = note('late_work', 'T-42-a1', NOW + MINUTE);
    const handoff2 = note('handoff', 'T-42-a2');
    const restate3 = note('restatement', 'T-42-e2-a1');
    const restate1 = note('restatement', 'T-42-a1');
    const loose = note('handoff', null);
    const groups = noteGroups(
      [restate3, late1, handoff2, note('progress', 'T-42-a1'), note('release', null), restate2, handoff1, restate1, loose],
      attempts,
    );
    expect(groups).toEqual([
      { from: null, to: 'T-42-a1', handoffs: [], lateWork: [], restatements: [restate1] },
      { from: 'T-42-a1', to: 'T-42-a2', handoffs: [handoff1], lateWork: [late1], restatements: [restate2] },
      { from: 'T-42-a2', to: 'T-42-e2-a1', handoffs: [handoff2], lateWork: [], restatements: [restate3] },
      { from: null, to: null, handoffs: [loose], lateWork: [], restatements: [] },
    ]);
  });

  test('an attempt that failed to start sits outside the chain, so a handoff still meets its restatement', () => {
    const chain = [
      attempt({ id: 'T-42-a1', number: 1, status: 'ended', endReason: 'stopped' }),
      attempt({ id: 'T-42-a2', number: 2, status: 'ended', endReason: 'failed_to_start' }),
      attempt({ id: 'T-42-a3', number: 3, status: 'running' }),
    ];
    const handoff = note('handoff', 'T-42-a1');
    const restatement = note('restatement', 'T-42-a3');
    expect(noteGroups([handoff, restatement], chain)).toEqual([
      { from: 'T-42-a1', to: 'T-42-a3', handoffs: [handoff], lateWork: [], restatements: [restatement] },
    ]);
  });

  test('the newest attempt has no successor yet, and a note may name an attempt the list lacks', () => {
    const handoff = note('handoff', 'T-42-e2-a1');
    const late = note('late_work', 'T-42-a7');
    expect(noteGroups([handoff, late], attempts)).toEqual([
      { from: 'T-42-a7', to: 'T-42-e2-a1', handoffs: [], lateWork: [late], restatements: [] },
      { from: 'T-42-e2-a1', to: null, handoffs: [handoff], lateWork: [], restatements: [] },
    ]);
    expect(noteGroups([note('progress', 'T-42-a1')], attempts)).toEqual([]);
  });
});

import { describe, expect, test } from 'bun:test';
import {
  COUNTED_CLASSES,
  DEFAULT_INFRA_BACKOFF_MS,
  ENDING_MOVES,
  type EndingTrigger,
  STOP_CAUSES,
  backoffApplies,
  countedAttempts,
  endingClass,
  failureSignature,
  infraBackoffMs,
  ladderStep,
  plannedTaskMove,
  signatureApplies,
  vendorRequirement,
} from '../src/ladder';
import { canTransition } from '../src/task-state';
import type { Attempt, FailureClass, StopCause, TaskStatus, Vendor } from '../src/types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const STATUSES: TaskStatus[] = [
  'draft', 'ready', 'claimed', 'working', 'submitted', 'checking', 'reviewing',
  'accepted', 'merging', 'merged', 'rejected', 'stale', 'blocked', 'cancelled', 'failed',
];

const CAUSES = Object.keys(STOP_CAUSES) as StopCause[];
const TRIGGERS = Object.keys(ENDING_MOVES) as EndingTrigger[];

/** The triggers that pass, sorted, so a test reads as a list. */
function where(predicate: (trigger: EndingTrigger) => boolean): EndingTrigger[] {
  return TRIGGERS.filter(predicate).sort();
}

describe('STOP_CAUSES', () => {
  test('has the 20 stop causes', () => {
    expect([...CAUSES].sort()).toEqual([
      'auth', 'blocked', 'branch_moved', 'cancel', 'context', 'impossible', 'policy', 'quota', 'released', 'replace',
      'rotation', 'stall_budget', 'stall_hung_tool', 'stall_loop', 'stall_no_progress', 'stall_silent', 'stop',
      'stop_hold', 'takeover', 'vendor_error',
    ]);
  });

  test('stall_hung_tool, stall_silent and stall_loop interrupt first', () => {
    expect(CAUSES.filter((cause) => STOP_CAUSES[cause].interruptFirst).sort()).toEqual([
      'stall_hung_tool',
      'stall_loop',
      'stall_silent',
    ]);
  });

  test('quota, vendor_error, policy, auth, cancel, blocked, impossible and released skip the handoff; the rest ask for one', () => {
    expect(CAUSES.filter((cause) => !STOP_CAUSES[cause].handoff).sort()).toEqual([
      'auth', 'blocked', 'cancel', 'impossible', 'policy', 'quota', 'released', 'vendor_error',
    ]);
  });

  test('each cause ends its attempt with the end reason and class of its trigger table row', () => {
    const ends = Object.fromEntries(
      CAUSES.map((cause) => [cause, `${STOP_CAUSES[cause].endReason}, ${STOP_CAUSES[cause].failureClass ?? 'none'}`]),
    );
    expect(ends).toEqual({
      stall_silent: 'stalled, agent',
      stall_hung_tool: 'stalled, agent',
      stall_loop: 'stalled, agent',
      stall_no_progress: 'stalled, agent',
      stall_budget: 'stalled, agent',
      stop: 'stopped, none',
      stop_hold: 'stopped, none',
      replace: 'replaced, none',
      quota: 'replaced, infra',
      vendor_error: 'replaced, infra',
      context: 'replaced, infra',
      policy: 'blocked, none',
      auth: 'crashed, infra',
      cancel: 'cancelled, none',
      blocked: 'blocked, none',
      impossible: 'blocked, none',
      released: 'released, agent',
      takeover: 'taken_over, none',
      rotation: 'rotated, none',
      branch_moved: 'stopped, none',
    });
  });

  test("a stop request's row in ENDING_MOVES ends the attempt as STOP_CAUSES says", () => {
    for (const cause of CAUSES) {
      const row = ENDING_MOVES[cause];
      expect([cause, row.endReason, row.failureClass]).toEqual([
        cause,
        STOP_CAUSES[cause].endReason,
        STOP_CAUSES[cause].failureClass,
      ]);
    }
  });
});

describe('ENDING_MOVES', () => {
  test('has a row for every stop cause and for every other way an attempt ends', () => {
    expect(TRIGGERS.filter((trigger) => !Object.hasOwn(STOP_CAUSES, trigger)).sort()).toEqual([
      'accepted', 'crashed', 'failed_to_start', 'lead_exit', 'lost', 'refused_start', 'rejected', 'review_resume',
      'runner_stop', 'submission', 'superseded', 'suspend',
    ]);
  });

  test('the other rows end the attempt with the reason of their trigger table row, or not at all', () => {
    const others = TRIGGERS.filter((trigger) => !Object.hasOwn(STOP_CAUSES, trigger));
    expect(Object.fromEntries(others.map((trigger) => [trigger, ENDING_MOVES[trigger].endReason]))).toEqual({
      submission: null,
      accepted: 'accepted',
      review_resume: null,
      rejected: 'rejected',
      runner_stop: 'stopped',
      suspend: null,
      crashed: 'crashed',
      lead_exit: null,
      lost: 'lost',
      failed_to_start: 'failed_to_start',
      refused_start: 'failed_to_start',
      superseded: 'superseded',
    });
  });

  test('the rows move tasks as the trigger table says', () => {
    const moves = Object.fromEntries(
      TRIGGERS.map((trigger) => {
        const move = ENDING_MOVES[trigger].task;
        if (move === null) return [trigger, '—'];
        const kind = move.blockedKind === null ? '' : ` (${move.blockedKind})`;
        return [trigger, `${move.when}, from ${move.from.join(' or ')}: ${move.path.join(' → ')}${kind}`];
      }),
    );
    const onEnd = 'on_end, from claimed or working: ready';
    expect(moves).toEqual({
      stall_silent: onEnd,
      stall_hung_tool: onEnd,
      stall_loop: onEnd,
      stall_no_progress: onEnd,
      stall_budget: onEnd,
      stop: onEnd,
      stop_hold: 'at_once, from claimed or working: blocked (paused)',
      replace: onEnd,
      quota: onEnd,
      vendor_error: onEnd,
      context: onEnd,
      policy: 'at_once, from claimed or working: blocked (policy)',
      auth: onEnd,
      cancel: 'at_once, from claimed or working: cancelled',
      blocked: 'at_once, from claimed or working: blocked (agent)',
      impossible: 'at_once, from claimed or working: blocked (impossible)',
      released: onEnd,
      takeover: 'at_once, from claimed or working: blocked (takeover)',
      rotation: '—',
      branch_moved: 'at_once, from claimed or working: blocked (branch_moved)',
      submission: 'at_once, from claimed or working: submitted',
      accepted: 'at_once, from submitted: accepted',
      review_resume: 'at_once, from submitted: rejected → claimed',
      rejected: 'at_once, from submitted: rejected',
      runner_stop: onEnd,
      suspend: '—',
      crashed: onEnd,
      lead_exit: '—',
      lost: 'on_end, from claimed or working: stale → ready',
      failed_to_start: onEnd,
      refused_start: onEnd,
      superseded: '—',
    });
  });

  test('an ending adds an assembled handoff note as the trigger table says', () => {
    expect(where((trigger) => ENDING_MOVES[trigger].note === 'always')).toEqual([
      'auth',
      'lost',
      'quota',
      'vendor_error',
    ]);
    expect(where((trigger) => ENDING_MOVES[trigger].note === 'if_none_written')).toEqual([
      'branch_moved', 'context', 'crashed', 'released', 'replace', 'runner_stop', 'stall_budget', 'stall_hung_tool',
      'stall_loop', 'stall_no_progress', 'stall_silent', 'stop', 'stop_hold',
    ]);
  });
});

describe('endingClass', () => {
  test('agent for stalled and released, review for rejected', () => {
    expect(where((trigger) => endingClass(trigger) === 'agent')).toEqual([
      'released', 'stall_budget', 'stall_hung_tool', 'stall_loop', 'stall_no_progress', 'stall_silent',
    ]);
    expect(where((trigger) => endingClass(trigger) === 'review')).toEqual(['rejected']);
  });

  test('infra for crashed, lost and failed starts, quota, vendor and context replacements and runner stops', () => {
    expect(where((trigger) => endingClass(trigger) === 'infra')).toEqual([
      'auth', 'context', 'crashed', 'failed_to_start', 'lost', 'quota', 'runner_stop', 'vendor_error',
    ]);
    for (const trigger of ['quota', 'vendor_error', 'context'] as const) {
      expect([trigger, ENDING_MOVES[trigger].endReason]).toEqual([trigger, 'replaced']);
    }
  });

  test('none otherwise: stops and holds by people and the lead, refused starts, and rows that end nothing', () => {
    expect(where((trigger) => endingClass(trigger) === null)).toEqual([
      'accepted', 'blocked', 'branch_moved', 'cancel', 'impossible', 'lead_exit', 'policy', 'refused_start',
      'replace', 'review_resume', 'rotation', 'stop', 'stop_hold', 'submission', 'superseded', 'suspend', 'takeover',
    ]);
  });
});

type LadderAttempt = Pick<Attempt, 'number' | 'runnerId' | 'vendor' | 'failureClass' | 'endedAt'>;

function ended(
  number: number,
  failureClass: FailureClass | null,
  overrides: Partial<LadderAttempt> = {},
): LadderAttempt {
  return { number, runnerId: 'R-1', vendor: 'claude', failureClass, endedAt: 0, ...overrides };
}

describe('the ladder', () => {
  test('countedAttempts counts agent and review endings of runner attempts above ladder_floor', () => {
    expect(COUNTED_CLASSES).toEqual(['agent', 'review']);
    const attempts = [
      ended(1, 'agent'),
      ended(2, 'infra'),
      ended(3, 'review'),
      ended(4, null),
      // A live chat's attempt is never counted.
      ended(5, 'agent', { runnerId: null }),
      ended(6, 'agent'),
    ];
    expect(countedAttempts(attempts, 0)).toBe(3);
    expect(countedAttempts(attempts, 1)).toBe(2);
    expect(countedAttempts(attempts, 3)).toBe(1);
    expect(countedAttempts(attempts, 6)).toBe(0);
    expect(countedAttempts([], 0)).toBe(0);
  });

  test('ladderStep gives step 2, then 3, then 4 before a re-plan or 5 after one', () => {
    const step = (counted: number, ladderFloor: number) => ladderStep({ counted, ladderFloor, maxAttempts: 3 });
    expect([1, 2, 3, 4].map((counted) => step(counted, 0))).toEqual([2, 3, 4, 4]);
    expect([1, 2, 3, 4].map((counted) => step(counted, 5))).toEqual([2, 3, 5, 5]);
  });

  test('maxAttempts is the limit', () => {
    const step = (counted: number, maxAttempts: number) => ladderStep({ counted, ladderFloor: 0, maxAttempts });
    expect([1, 2, 3, 4, 5].map((counted) => step(counted, 5))).toEqual([2, 3, 3, 3, 4]);
    expect([1, 2].map((counted) => step(counted, 2))).toEqual([2, 4]);
    expect(step(1, 1)).toBe(4);
  });

  test('no step while nothing counts, as for an attempt that ends at or below the floor after a re-plan', () => {
    expect(ladderStep({ counted: 0, ladderFloor: 3, maxAttempts: 3 })).toBeNull();
  });

  test('step 1 for a rejection whose author can resume, below 2 review rounds', () => {
    const rejected = (authorCanResume: boolean, reviewRounds: number, counted = 1) =>
      ladderStep({ counted, ladderFloor: 0, maxAttempts: 3, rejection: { authorCanResume, reviewRounds } });
    expect(rejected(true, 0)).toBe(1);
    expect(rejected(true, 1)).toBe(1);
    expect(rejected(true, 2)).toBe(2);
    expect(rejected(false, 0)).toBe(2);
    expect(rejected(false, 0, 2)).toBe(3);
    // A resume ends nothing, so it comes before the limit.
    expect(rejected(true, 1, 3)).toBe(1);
    expect(rejected(false, 1, 3)).toBe(4);
  });
});

describe('vendorRequirement', () => {
  const now = 1_800_000_000_000;
  const options = { ladderFloor: 0, now, vendorRequirementMs: 10 * MINUTE };
  const at = (vendor: Vendor, endedAt = now - MINUTE): Partial<LadderAttempt> => ({ vendor, endedAt });

  test('the first counted failure requires the same vendor, the second the other one', () => {
    expect(vendorRequirement([ended(1, 'agent', at('claude'))], options)).toEqual({ step: 2, vendor: 'claude' });
    expect(vendorRequirement([ended(1, 'agent', at('codex'))], options)).toEqual({ step: 2, vendor: 'codex' });
    const twice = [ended(1, 'agent', at('claude')), ended(2, 'review', at('claude'))];
    expect(vendorRequirement(twice, options)).toEqual({ step: 3, vendor: 'codex' });
  });

  test("the other vendor is the other one than the last counted attempt's", () => {
    // The step-2 requirement ran out, so the second attempt used Codex.
    const attempts = [ended(1, 'agent', at('claude', now - HOUR)), ended(2, 'agent', at('codex'))];
    expect(vendorRequirement(attempts, options)).toEqual({ step: 3, vendor: 'claude' });
    expect(vendorRequirement([...attempts].reverse(), options)).toEqual({ step: 3, vendor: 'claude' });
  });

  test('endings that do not count change no step', () => {
    const attempts = [
      ended(1, 'agent', at('claude', now - HOUR)),
      ended(2, 'infra', at('codex', now - HOUR)),
      ended(3, null, at('codex', now - HOUR)),
      ended(4, 'agent', { ...at('codex'), runnerId: null }),
    ];
    expect(vendorRequirement(attempts, options)).toEqual({ step: 2, vendor: 'claude' });
    // A re-plan starts the count again.
    expect(vendorRequirement(attempts, { ...options, ladderFloor: 1 })).toBeNull();
  });

  test('any vendor once the task has been ready vendorRequirementMs since its last attempt ended', () => {
    expect(vendorRequirement([ended(1, 'agent', at('claude', now - 10 * MINUTE + 1))], options)).toEqual({
      step: 2,
      vendor: 'claude',
    });
    expect(vendorRequirement([ended(1, 'agent', at('claude', now - 10 * MINUTE))], options)).toBeNull();
    // A later ending of any class restarts the wait.
    const later = [ended(1, 'agent', at('claude', now - HOUR)), ended(2, 'infra', at('claude', now - MINUTE))];
    expect(vendorRequirement(later, options)).toEqual({ step: 2, vendor: 'claude' });
  });

  test('none without a counted attempt', () => {
    expect(vendorRequirement([], options)).toBeNull();
    expect(vendorRequirement([ended(1, 'infra', at('claude'))], options)).toBeNull();
  });
});

describe('infra backoff and failure signatures', () => {
  test('infraBackoffMs gives 1, 2, 5, 15 and 30 minutes and stays at 30', () => {
    expect(DEFAULT_INFRA_BACKOFF_MS).toEqual([1, 2, 5, 15, 30].map((minutes) => minutes * MINUTE));
    expect([1, 2, 3, 4, 5, 6, 40].map((consecutive) => infraBackoffMs(consecutive))).toEqual(
      [1, 2, 5, 15, 30, 30, 30].map((minutes) => minutes * MINUTE),
    );
  });

  test('infraBackoffMs follows a configured schedule and counts from the first infra ending', () => {
    expect([1, 2, 3].map((consecutive) => infraBackoffMs(consecutive, [100, 250]))).toEqual([100, 250, 250]);
    expect(() => infraBackoffMs(0)).toThrow(RangeError);
    expect(() => infraBackoffMs(1.5)).toThrow(RangeError);
    expect(() => infraBackoffMs(1, [])).toThrow(RangeError);
  });

  test('infra endings back off, except the runner stopping itself', () => {
    expect(where(backoffApplies)).toEqual([
      'auth', 'context', 'crashed', 'failed_to_start', 'lost', 'quota', 'vendor_error',
    ]);
  });

  test('signatureApplies is false for lost, runner stops, suspends and refused starts', () => {
    for (const trigger of ['lost', 'runner_stop', 'suspend', 'refused_start'] as const) {
      expect([trigger, signatureApplies(trigger)]).toEqual([trigger, false]);
    }
    expect(where(signatureApplies)).toEqual(['auth', 'context', 'crashed', 'failed_to_start', 'quota', 'vendor_error']);
  });

  test('failureSignature is the end reason and the error, or the end reason alone', () => {
    expect(failureSignature('failed_to_start', 'vendor not logged in')).toBe('failed_to_start: vendor not logged in');
    expect(failureSignature('crashed', null)).toBe('crashed');
    expect(failureSignature('crashed', ' \n\t ')).toBe('crashed');
    expect(failureSignature('crashed', 'git\n  fetch\tfailed ')).toBe('crashed: git fetch failed');
    expect(failureSignature('replaced', 'oops')).not.toBe(failureSignature('crashed', 'oops'));
    expect(failureSignature('crashed', 'push rejected')).not.toBe(failureSignature('crashed', 'fetch rejected'));
  });

  test('failureSignature ignores digits', () => {
    const signature = failureSignature('crashed', 'the agent exited with code 137 after 12 s');
    expect(signature).toBe('crashed: the agent exited with code <n> after <n> s');
    expect(failureSignature('crashed', 'the agent exited with code 1 after 300 s')).toBe(signature);
  });

  test('failureSignature ignores paths, URLs and refs', () => {
    const lock = (path: string) => failureSignature('failed_to_start', `cannot lock ${path}: File exists`);
    expect(lock('/Users/ann/.agflow/runner/vault/refs/agflow/T-42/a3.lock')).toBe(
      'failed_to_start: cannot lock <path>: File exists',
    );
    expect(lock('/Users/bob/.agflow/runner/vault/refs/agflow/T-7/e2-a1.lock')).toBe(
      'failed_to_start: cannot lock <path>: File exists',
    );
    const offline = "fatal: unable to access 'https://github.com/ann/app.git/': Could not resolve host: github.com";
    expect(failureSignature('crashed', offline)).toBe(
      "crashed: fatal: unable to access '<path>': Could not resolve host: github.com",
    );
    expect(failureSignature('crashed', '~/bin/tool and ./node_modules/.bin/tsc not found')).toBe(
      'crashed: <path> and <path> not found',
    );
  });

  test('failureSignature ignores shas', () => {
    const rejected = 'push of 3f2a9c1 rejected: the remote has 9be0d2e4c1f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9';
    expect(failureSignature('crashed', rejected)).toBe('crashed: push of <sha> rejected: the remote has <sha>');
    // Words that only look like hex stay.
    expect(failureSignature('crashed', 'a defaced cafe')).toBe('crashed: a defaced cafe');
  });

  test('failureSignature ignores ids', () => {
    const ids = 'attempt T-42-e2-a3 of A-12 on R-3: command 2-R-3-17 for S-9 of T-42 failed';
    expect(failureSignature('crashed', ids)).toBe(
      'crashed: attempt <id> of <id> on <id>: command <id> for <id> of <id> failed',
    );
    const session = 'lead-e2-a5 lost session 4b8f0c9e-2d1a-4c3b-9e8f-7a6b5c4d3e2f';
    expect(failureSignature('crashed', session)).toBe('crashed: <id> lost session <id>');
    expect(failureSignature('crashed', `Bearer agt_${'x'.repeat(43)} refused`)).toBe('crashed: Bearer <id> refused');
  });

  test('failureSignature keeps at most 200 characters of the error', () => {
    expect(failureSignature('crashed', 'x'.repeat(5000))).toBe(`crashed: ${'x'.repeat(200)}`);
  });

  test('failureSignature reads a long run of URL scheme characters in linear time', () => {
    // Tried from every word boundary in the run, the URL pattern took minutes on this megabyte.
    expect(failureSignature('crashed', 'a.'.repeat(500_000))).toStartWith('crashed: a.a.');
  });
});

describe('plannedTaskMove', () => {
  const ATTEMPT = 'T-42-a3';
  const REVIEW: EndingTrigger[] = ['accepted', 'review_resume', 'rejected'];

  // Every move the trigger table can make, replayed against the state machine from every status (design 15): only
  // from claimed or working (submitted for an accept or a reject), and only while the task names the attempt.
  test('every trigger from every status: null, or a path canTransition allows, for the current attempt only', () => {
    for (const trigger of TRIGGERS) {
      for (const when of ['at_once', 'on_end'] as const) {
        for (const status of STATUSES) {
          for (const currentAttempt of [ATTEMPT, 'T-42-a2', null]) {
            const move = plannedTaskMove(trigger, when, { status, currentAttempt }, ATTEMPT);
            if (move === null) continue;
            expect([trigger, currentAttempt, move.when]).toEqual([trigger, ATTEMPT, when]);
            const from = REVIEW.includes(trigger) ? ['submitted'] : ['claimed', 'working'];
            expect([trigger, status, from.includes(status)]).toEqual([trigger, status, true]);
            let at = status;
            for (const to of move.path) {
              expect([trigger, at, to, canTransition(at, to)]).toEqual([trigger, at, to, true]);
              at = to;
            }
            expect([trigger, move.blockedKind !== null]).toEqual([trigger, at === 'blocked']);
          }
        }
      }
    }
  });

  test('each row moves the task from every status it lists, at its own stage only', () => {
    for (const trigger of TRIGGERS) {
      const move = ENDING_MOVES[trigger].task;
      if (move === null) continue;
      const other = move.when === 'at_once' ? 'on_end' : 'at_once';
      for (const status of move.from) {
        expect([trigger, plannedTaskMove(trigger, move.when, { status, currentAttempt: ATTEMPT }, ATTEMPT)]).toEqual([
          trigger,
          move,
        ]);
        expect([trigger, plannedTaskMove(trigger, other, { status, currentAttempt: ATTEMPT }, ATTEMPT)]).toEqual([
          trigger,
          null,
        ]);
      }
    }
  });

  test('the task keeps its status otherwise', () => {
    const task = (status: TaskStatus, currentAttempt: string | null = ATTEMPT) => ({ status, currentAttempt });
    // A newer attempt holds the task.
    expect(plannedTaskMove('stall_silent', 'on_end', task('working', 'T-42-a4'), ATTEMPT)).toBeNull();
    // A cancel already moved it, and an accept or reject comes only for submitted work.
    expect(plannedTaskMove('stop', 'on_end', task('cancelled'), ATTEMPT)).toBeNull();
    expect(plannedTaskMove('accepted', 'at_once', task('working'), ATTEMPT)).toBeNull();
    // A take-over in flight keeps the task blocked when the attempt ends.
    expect(plannedTaskMove('lost', 'on_end', task('blocked'), ATTEMPT)).toBeNull();
    // Rows that move no task.
    for (const trigger of ['rotation', 'suspend', 'lead_exit', 'superseded'] as const) {
      expect(plannedTaskMove(trigger, 'on_end', task('working'), ATTEMPT)).toBeNull();
      expect(plannedTaskMove(trigger, 'at_once', task('working'), ATTEMPT)).toBeNull();
    }
  });
});

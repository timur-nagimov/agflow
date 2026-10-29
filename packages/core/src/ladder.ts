// The trigger table of design 6.4 and the retry ladder of design 6.9, which the hub and the runner share: STOP_CAUSES,
// what every way an attempt ends does to the attempt and its task (ENDING_MOVES, plannedTaskMove), failure classes
// and counted attempts, the ladder's steps and vendor requirements, the infra backoff and failure signatures. Pure,
// with no zod at run time, so the web UI may import it too (X-48).
import type {
  Attempt,
  AttemptEndReason,
  BlockedKind,
  FailureClass,
  StopCause,
  Task,
  TaskStatus,
  Vendor,
} from './types';

// ---------------------------------------------------------------------------
// Stop causes
// ---------------------------------------------------------------------------

/** What a stop cause ends an attempt with, and the flags its stop_attempt carries (design 6.8, Replacement). */
export interface StopCauseSpec {
  endReason: AttemptEndReason;
  failureClass: FailureClass | null;
  /** The runner asks the agent for a handoff note, as a turn of its own, before it stops it. */
  handoff: boolean;
  /** The runner interrupts the turn before it asks: a stuck tool, a silent agent or a loop. */
  interruptFirst: boolean;
}

/**
 * Every stop cause, as design 6.4's trigger table has it. The hub records the cause in stop_requested, sends its
 * flags in stop_attempt and ends the attempt with its end reason and class. A take-over sends prepare_takeover
 * instead, which always interrupts the turn before it asks for the handoff (design 6.12).
 */
export const STOP_CAUSES: Readonly<Record<StopCause, Readonly<StopCauseSpec>>> = {
  stall_silent: { endReason: 'stalled', failureClass: 'agent', handoff: true, interruptFirst: true },
  stall_hung_tool: { endReason: 'stalled', failureClass: 'agent', handoff: true, interruptFirst: true },
  stall_loop: { endReason: 'stalled', failureClass: 'agent', handoff: true, interruptFirst: true },
  stall_no_progress: { endReason: 'stalled', failureClass: 'agent', handoff: true, interruptFirst: false },
  stall_budget: { endReason: 'stalled', failureClass: 'agent', handoff: true, interruptFirst: false },
  stop: { endReason: 'stopped', failureClass: null, handoff: true, interruptFirst: false },
  stop_hold: { endReason: 'stopped', failureClass: null, handoff: true, interruptFirst: false },
  replace: { endReason: 'replaced', failureClass: null, handoff: true, interruptFirst: false },
  quota: { endReason: 'replaced', failureClass: 'infra', handoff: false, interruptFirst: false },
  vendor_error: { endReason: 'replaced', failureClass: 'infra', handoff: false, interruptFirst: false },
  context: { endReason: 'replaced', failureClass: 'infra', handoff: true, interruptFirst: false },
  policy: { endReason: 'blocked', failureClass: null, handoff: false, interruptFirst: false },
  auth: { endReason: 'crashed', failureClass: 'infra', handoff: false, interruptFirst: false },
  cancel: { endReason: 'cancelled', failureClass: null, handoff: false, interruptFirst: false },
  blocked: { endReason: 'blocked', failureClass: null, handoff: false, interruptFirst: false },
  impossible: { endReason: 'blocked', failureClass: null, handoff: false, interruptFirst: false },
  released: { endReason: 'released', failureClass: 'agent', handoff: false, interruptFirst: false },
  takeover: { endReason: 'taken_over', failureClass: null, handoff: true, interruptFirst: false },
  rotation: { endReason: 'rotated', failureClass: null, handoff: true, interruptFirst: false },
  branch_moved: { endReason: 'stopped', failureClass: null, handoff: true, interruptFirst: false },
};

// ---------------------------------------------------------------------------
// Every way an attempt ends
// ---------------------------------------------------------------------------

/**
 * A row of design 6.4's trigger table, "Every way an attempt ends". A stop request's row is named by its StopCause:
 * the attempt ends on its exit, at the stop timeout, or at once when it has no process; a take-over's ends when
 * attempt.taken_over arrives, or at the lease expiry or the stop timeout. The other rows:
 * - submission: a submission was recorded, and the attempt holds;
 * - accepted: the lead or a person accepted the work;
 * - review_resume: a rejection goes back to its author, ladder step 1, and the attempt resumes with a new fence;
 * - rejected: a rejection without a resume;
 * - runner_stop: the runner's own stop (attempt.exited.cause runner_stop);
 * - suspend: a runner suspend (attempt.exited.cause suspend), and the attempt keeps its status;
 * - crashed: an exit nobody requested, of a worker, or a lead's third within leadExitWindowMs;
 * - lead_exit: an earlier exit nobody requested, of a lead, which holds until it is resumed;
 * - lost: a runner lease expiry, or a holding runner lead that cannot be resumed;
 * - failed_to_start and refused_start: attempt.failed_to_start, without and with refused;
 * - superseded: reconciled away after a restore.
 */
export type EndingTrigger =
  | StopCause
  | 'submission'
  | 'accepted'
  | 'review_resume'
  | 'rejected'
  | 'runner_stop'
  | 'suspend'
  | 'crashed'
  | 'lead_exit'
  | 'lost'
  | 'failed_to_start'
  | 'refused_start'
  | 'superseded';

/** How a row moves the attempt's task. */
export interface TaskMove {
  /** at_once: when the trigger happens, such as a stop request; on_end: when the attempt ends. */
  when: 'at_once' | 'on_end';
  /** The statuses it moves the task from: claimed and working, or submitted for acceptance and rejection. */
  from: readonly TaskStatus[];
  /** The statuses the task passes through, in order. */
  path: readonly TaskStatus[];
  /** The kind that a move to blocked gives the task. */
  blockedKind: BlockedKind | null;
}

/** One row of the trigger table: what it does to the attempt and to its task. */
export interface EndingMove {
  /** Null when the attempt does not end: it holds, waits to be resumed or keeps its status. */
  endReason: AttemptEndReason | null;
  /** Design 6.9's class; null for none. */
  failureClass: FailureClass | null;
  /** Null when the row moves no task. */
  task: TaskMove | null;
  /** Whether the ending adds an assembled handoff note to the task: always, if the agent wrote none, or never. */
  note: 'always' | 'if_none_written' | null;
}

const HELD: readonly TaskStatus[] = ['claimed', 'working'];
const SUBMITTED: readonly TaskStatus[] = ['submitted'];

/** Back to ready once the attempt has ended, so that a successor starts from its final WIP (invariant b). */
const READY_ON_END: TaskMove = { when: 'on_end', from: HELD, path: ['ready'], blockedKind: null };

/** A lease expiry's move: through stale, as M1's lease sweep moves a task whose holder went silent. */
const STALE_ON_END: TaskMove = { when: 'on_end', from: HELD, path: ['stale', 'ready'], blockedKind: null };

function atOnce(from: readonly TaskStatus[], path: TaskStatus[], blockedKind: BlockedKind | null = null): TaskMove {
  return { when: 'at_once', from, path, blockedKind };
}

/** A row: the end reason, the class, the task move and the assembled note, the columns of the trigger table. */
function row(
  endReason: AttemptEndReason | null,
  failureClass: FailureClass | null,
  task: TaskMove | null,
  note: EndingMove['note'],
): EndingMove {
  return { endReason, failureClass, task, note };
}

/**
 * The trigger table of design 6.4, a row per trigger. A stop request's row repeats STOP_CAUSES' end reason and class,
 * so that every row reads in one place. A rejection without a resume only marks the task rejected: the ladder then
 * moves it on (ready at steps 2 and 3, blocked as replan at 4, failed at 5). Lead attempts have no task, so their rows
 * move nothing, and the hub keeps a lead note for them instead (6.11). Live-chat attempts keep M1's moves (6.4).
 */
export const ENDING_MOVES: Readonly<Record<EndingTrigger, Readonly<EndingMove>>> = {
  stall_silent: row('stalled', 'agent', READY_ON_END, 'if_none_written'),
  stall_hung_tool: row('stalled', 'agent', READY_ON_END, 'if_none_written'),
  stall_loop: row('stalled', 'agent', READY_ON_END, 'if_none_written'),
  stall_no_progress: row('stalled', 'agent', READY_ON_END, 'if_none_written'),
  stall_budget: row('stalled', 'agent', READY_ON_END, 'if_none_written'),
  stop: row('stopped', null, READY_ON_END, 'if_none_written'),
  stop_hold: row('stopped', null, atOnce(HELD, ['blocked'], 'paused'), 'if_none_written'),
  replace: row('replaced', null, READY_ON_END, 'if_none_written'),
  quota: row('replaced', 'infra', READY_ON_END, 'always'),
  vendor_error: row('replaced', 'infra', READY_ON_END, 'always'),
  context: row('replaced', 'infra', READY_ON_END, 'if_none_written'),
  policy: row('blocked', null, atOnce(HELD, ['blocked'], 'policy'), null),
  auth: row('crashed', 'infra', READY_ON_END, 'always'),
  cancel: row('cancelled', null, atOnce(HELD, ['cancelled']), null),
  blocked: row('blocked', null, atOnce(HELD, ['blocked'], 'agent'), null),
  impossible: row('blocked', null, atOnce(HELD, ['blocked'], 'impossible'), null),
  released: row('released', 'agent', READY_ON_END, 'if_none_written'),
  takeover: row('taken_over', null, atOnce(HELD, ['blocked'], 'takeover'), null),
  rotation: row('rotated', null, null, null),
  branch_moved: row('stopped', null, atOnce(HELD, ['blocked'], 'branch_moved'), 'if_none_written'),
  submission: row(null, null, atOnce(HELD, ['submitted']), null),
  accepted: row('accepted', null, atOnce(SUBMITTED, ['accepted']), null),
  review_resume: row(null, null, atOnce(SUBMITTED, ['rejected', 'claimed']), null),
  rejected: row('rejected', 'review', atOnce(SUBMITTED, ['rejected']), null),
  runner_stop: row('stopped', 'infra', READY_ON_END, 'if_none_written'),
  suspend: row(null, null, null, null),
  crashed: row('crashed', 'infra', READY_ON_END, 'if_none_written'),
  lead_exit: row(null, null, null, null),
  lost: row('lost', 'infra', STALE_ON_END, 'always'),
  failed_to_start: row('failed_to_start', 'infra', READY_ON_END, null),
  refused_start: row('failed_to_start', null, READY_ON_END, null),
  superseded: row('superseded', null, null, null),
};

/**
 * The move a trigger makes to the attempt's task at one stage (design 6.4, "Task moves are conditional"): its row's
 * move, while the task's current attempt is this attempt and the task is in a status the row moves it from, whether a
 * runner event, a stop request or the tick triggered it. Otherwise null: the attempt still ends as its row says, and
 * the task keeps its status. The M1 operations of people and the lead (cancel, accept, reject, unblock) keep their
 * own preconditions (X-34).
 */
export function plannedTaskMove(
  trigger: EndingTrigger,
  when: TaskMove['when'],
  task: Pick<Task, 'status' | 'currentAttempt'>,
  attemptId: string,
): TaskMove | null {
  const move = ENDING_MOVES[trigger].task;
  if (move === null || move.when !== when) return null;
  return task.currentAttempt === attemptId && move.from.includes(task.status) ? move : null;
}

/** The class of an ending (design 6.9); null for none, and for rows that end nothing. */
export function endingClass(trigger: EndingTrigger): FailureClass | null {
  return ENDING_MOVES[trigger].failureClass;
}

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

/** The classes the ladder counts. */
export const COUNTED_CLASSES: readonly FailureClass[] = ['agent', 'review'];

type CountedFields = Pick<Attempt, 'number' | 'runnerId' | 'failureClass'>;

function isCounted(attempt: CountedFields, ladderFloor: number): boolean {
  return (
    attempt.runnerId !== null &&
    attempt.failureClass !== null &&
    COUNTED_CLASSES.includes(attempt.failureClass) &&
    attempt.number > ladderFloor
  );
}

/**
 * A task's counted attempts (design 6.9): runner attempts that ended with a counted class, numbered above
 * ladder_floor, the highest attempt number at the task's last re-plan. Live-chat attempts never count (6.4).
 */
export function countedAttempts(attempts: readonly CountedFields[], ladderFloor: number): number {
  return attempts.filter((attempt) => isCounted(attempt, ladderFloor)).length;
}

/**
 * A step of the retry ladder (design 6.9):
 * 1. a rejection goes back to its author: rejected → claimed, a new fence and the quoted feedback;
 * 2. after the first counted failure the task goes ready, and its next attempt must use the same vendor;
 * 3. after the second, ready, and the next attempt must use the other vendor when a runner offers it;
 * 4. at maxAttempts counted attempts before any re-plan the task is blocked (replan), and the lead is told;
 * 5. at maxAttempts counted attempts after a re-plan it fails, and people are told.
 */
export type LadderStep = 1 | 2 | 3 | 4 | 5;

/** A rejection goes back to its author while the attempt has had fewer review rounds than this. */
const REVIEW_ROUNDS = 2;

export interface LadderInput {
  /** The task's counted attempts, this ending's included (countedAttempts). */
  counted: number;
  /** tasks.ladder_floor: the highest attempt number at the task's last re-plan; 0 before any. */
  ladderFloor: number;
  /** The ladder's limit: HubConfig.maxAttempts, 3 by default. */
  maxAttempts: number;
  /**
   * For a rejection: whether its author can take the work back, which the hub decides (the author's attempt is
   * holding and resumable, on an online runner with a free slot and its vendor usable there, and no path overlaps),
   * and the attempt's review rounds so far.
   */
  rejection?: { authorCanResume: boolean; reviewRounds: number };
}

/**
 * The ladder's step after an ending that counts, or a rejection. Null when nothing counts, as for an attempt numbered
 * at or below the floor that ends after its task's re-plan.
 */
export function ladderStep(input: LadderInput): LadderStep | null {
  const { rejection } = input;
  if (rejection?.authorCanResume && rejection.reviewRounds < REVIEW_ROUNDS) return 1;
  if (input.counted < 1) return null;
  if (input.counted >= input.maxAttempts) return input.ladderFloor > 0 ? 5 : 4;
  return input.counted === 1 ? 2 : 3;
}

/** What the ladder asks of the vendor of a task's next attempt (design 6.9, steps 2 and 3). */
export interface VendorRequirement {
  /** 2: the vendor of the last counted attempt; 3: the other vendor, which binds only while a runner offers it. */
  step: 2 | 3;
  vendor: Vendor;
}

const OTHER_VENDOR: Readonly<Record<Vendor, Vendor>> = { claude: 'codex', codex: 'claude' };

/**
 * The ladder's vendor requirement for a task's next attempt (design 6.6, step 5): from its counted attempts, until
 * the task has been ready for vendorRequirementMs since its last attempt ended. Null after that, or with no counted
 * attempt: any vendor.
 */
export function vendorRequirement(
  attempts: readonly (CountedFields & Pick<Attempt, 'vendor' | 'endedAt'>)[],
  options: { ladderFloor: number; now: number; vendorRequirementMs: number },
): VendorRequirement | null {
  const ends = attempts.flatMap((attempt) => (attempt.endedAt === null ? [] : [attempt.endedAt]));
  if (ends.length === 0 || options.now - Math.max(...ends) >= options.vendorRequirementMs) return null;
  const counted = attempts
    .filter((attempt) => isCounted(attempt, options.ladderFloor))
    .sort((a, b) => a.number - b.number);
  const last = counted.at(-1);
  if (last === undefined) return null;
  return counted.length === 1 ? { step: 2, vendor: last.vendor } : { step: 3, vendor: OTHER_VENDOR[last.vendor] };
}

// ---------------------------------------------------------------------------
// Infra endings
// ---------------------------------------------------------------------------

const MINUTE = 60_000;

/** HubConfig.infraBackoffMs by default: 1, 2, 5, 15 and 30 minutes. */
export const DEFAULT_INFRA_BACKOFF_MS: readonly number[] = [1, 2, 5, 15, 30].map((minutes) => minutes * MINUTE);

/**
 * How long a task waits for its next dispatch after its nth consecutive infra ending, counted from 1 (design 6.9):
 * the schedule's nth entry, and its last entry from then on.
 */
export function infraBackoffMs(consecutive: number, schedule: readonly number[] = DEFAULT_INFRA_BACKOFF_MS): number {
  if (!Number.isSafeInteger(consecutive) || consecutive < 1) {
    throw new RangeError(`consecutive infra endings count from 1, not ${consecutive}`);
  }
  const wait = schedule[Math.min(consecutive, schedule.length) - 1];
  if (wait === undefined) throw new RangeError('the infra backoff schedule is empty');
  return wait;
}

/** Infra endings delay the task's next dispatch, except the runner's own stops (design 6.4). */
export function backoffApplies(trigger: EndingTrigger): boolean {
  return endingClass(trigger) === 'infra' && trigger !== 'runner_stop';
}

/**
 * Infra endings record a failure signature, except lost attempts and the runner's own stops. Suspends end nothing and
 * refused starts have no class, so neither gets one (design 6.9).
 */
export function signatureApplies(trigger: EndingTrigger): boolean {
  return endingClass(trigger) === 'infra' && trigger !== 'lost' && trigger !== 'runner_stop';
}

/** How much of the normalised error a failure signature keeps. */
const SIGNATURE_ERROR_LENGTH = 200;

// What failureSignature replaces, in this order. URLs and other words with a slash (paths, refs) go first and whole,
// so that no id, sha or number in them survives in pieces. A URL's scheme starts its run of scheme characters, after
// no word character: tried from every word boundary inside a long run, the pattern takes time quadratic in the run.
// Then agent tokens, UUIDs and agflow's own ids (commands, attempts, then tasks, runners, agents and submissions);
// then shas, hex runs with a letter and a digit, so that words such as "defaced" stay; then every other number.
const URL_TEXT = /(?<![\w+.-])[a-z][a-z0-9+.-]*:\/\/[^\s'"`<>()[\]{},;]+/gi;
const WORD = /[^\s'"`<>()[\]{},;:]+/g;
const AGENT_TOKEN = /\bagt_[\w-]+/g;
const UUID = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi;
const AGFLOW_ID = /\b(?:\d+-R-\d+-\d+|(?:T-\d+|lead)-(?:e\d+-)?a\d+|[ARST]-\d+)\b/g;
const SHA = /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,64}\b/g;
const NUMBER = /\d+/g;

/**
 * An infra ending's failure signature (design 6.9): the end reason and the error, with paths, ids, shas and digits
 * replaced by placeholders, so that the same failure on another attempt, runner or commit reads the same.
 */
export function failureSignature(endReason: AttemptEndReason, error: string | null): string {
  const text = (error ?? '')
    .replace(URL_TEXT, '<path>')
    .replace(WORD, (word) => (word.includes('/') ? '<path>' : word))
    .replace(AGENT_TOKEN, '<id>')
    .replace(UUID, '<id>')
    .replace(AGFLOW_ID, '<id>')
    .replace(SHA, '<sha>')
    .replace(NUMBER, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SIGNATURE_ERROR_LENGTH)
    .trimEnd();
  return text === '' ? endReason : `${endReason}: ${text}`;
}

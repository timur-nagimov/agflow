// What the web says about attempts (design 6.1, 6.4, 6.8, 6.9, 6.12, 6.13, 11): labels, the phase a person sees,
// tones, short names, the WIP position, the facts of the attempt page, log kinds, submission outcomes, who holds a
// task, the actions on runner agents and what the hub did with them, take-over and hand-back, and the notes attempts
// leave each other. Free of the DOM so the rules are unit-tested. From api-schemas.ts and runner-protocol.ts, which
// build zod schemas, only types come in (X-48); the tests compare the tables here with their values.
import {
  type Attempt,
  type AttemptEndReason,
  type AttemptFacts,
  type AttemptLogEntry,
  type AttemptPhase,
  type AttemptStatus,
  attemptSuffix,
  type FailureClass,
  isHeld,
  parseAttemptId,
  type Runner,
  splitSubmitError,
  type StopCause,
  type SubmissionRecord,
  type SubmitError,
  type TakeoverRefusal,
  type Task,
  type TaskNote,
} from '@agflow/core';
import type { AgentAction, AgentActionBodies, HandbackSource, Me } from './api';
import { duration, percent, shortSha, type TaskHolder, type Tone, who } from './format';

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export const ATTEMPT_STATUS_LABELS: Record<AttemptStatus, string> = {
  starting: 'Starting',
  running: 'Running',
  quota_wait: 'Waiting for quota',
  holding: 'Holding',
  ended: 'Ended',
};

export const END_REASON_LABELS: Record<AttemptEndReason, string> = {
  accepted: 'Accepted',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  released: 'Released',
  blocked: 'Blocked',
  stalled: 'Stalled',
  crashed: 'Crashed',
  failed_to_start: 'Failed to start',
  stopped: 'Stopped',
  replaced: 'Replaced',
  lost: 'Lost',
  taken_over: 'Taken over',
  rotated: 'Rotated',
  superseded: 'Superseded',
};

/** Who a failure counts against on the retry ladder (6.9). */
export const FAILURE_CLASS_LABELS: Record<FailureClass, string> = {
  infra: 'Infrastructure',
  agent: 'Agent',
  review: 'Review',
};

/** Why a stop was requested (core's STOP_CAUSES). */
export const STOP_CAUSE_LABELS: Record<StopCause, string> = {
  stall_silent: 'Stalled: silent',
  stall_hung_tool: 'Stalled: a tool hung',
  stall_loop: 'Stalled: looping',
  stall_no_progress: 'Stalled: no progress',
  stall_budget: 'Stalled: over its budget',
  stop: 'Stop',
  stop_hold: 'Stop and hold',
  replace: 'Replace',
  quota: 'Out of quota',
  vendor_error: 'Vendor errors',
  context: 'Context window full',
  policy: 'Refused by the vendor on policy grounds',
  auth: 'Vendor login expired',
  cancel: 'Task cancelled',
  blocked: 'Declared blocked',
  impossible: 'Declared impossible',
  released: 'Released by the agent',
  takeover: 'Taken over',
  rotation: 'Lead rotation',
  branch_moved: 'Branch moved',
};

// ---------------------------------------------------------------------------
// Phase, tone and names
// ---------------------------------------------------------------------------

const PHASE_LABELS: Record<AttemptPhase, string> = {
  starting: 'Starting',
  preparing: 'Preparing',
  turn: 'Working',
  idle: 'Idle',
  waiting_approval: 'Waiting for approval',
  quota_wait: 'Waiting for quota',
  vendor_error: 'Vendor error',
  stopping: 'Stopping',
};

/** Starting, open, holding: the attempt is not over. */
export function isOpen(attempt: Pick<Attempt, 'status'>): boolean {
  return attempt.status !== 'ended';
}

/**
 * The phase a person sees in the Agents table (design 11). An ended attempt shows its end reason. A recorded stop
 * shows as stopping, but a deferred one waits for the pending submission (6.13), so the agent's phase stands. The
 * status speaks for holding and quota_wait, and when the runner reported no phase yet.
 */
export function phaseLabel(attempt: Pick<Attempt, 'status' | 'phase' | 'stopRequested' | 'endReason'>): string {
  if (attempt.status === 'ended') return attempt.endReason ? END_REASON_LABELS[attempt.endReason] : 'Ended';
  if ((attempt.stopRequested && !attempt.stopRequested.deferred) || attempt.phase === 'stopping') return 'Stopping';
  if (attempt.status === 'holding' || attempt.status === 'quota_wait') return ATTEMPT_STATUS_LABELS[attempt.status];
  return attempt.phase ? PHASE_LABELS[attempt.phase] : ATTEMPT_STATUS_LABELS[attempt.status];
}

/** Ended attempts follow their failure class: the agent's and the review's failures need a look, infra's only wait. */
export function attemptTone(attempt: Pick<Attempt, 'status' | 'endReason' | 'failureClass'>): Tone {
  if (attempt.status === 'holding') return 'review';
  if (attempt.status !== 'ended') return 'active';
  if (attempt.endReason === 'accepted') return 'done';
  switch (attempt.failureClass) {
    case 'agent':
    case 'review':
      return 'trouble';
    case 'infra':
      return 'wait';
    case null:
      return 'closed';
  }
}

/** An attempt's name within its task, core's suffix: 'a3', 'e2-a3' from epoch 2; a lead's reads 'lead a5'. */
export function attemptLabel(id: string): string {
  const parts = parseAttemptId(id);
  if (!parts) return id;
  return parts.taskId === null ? `lead ${attemptSuffix(id)}` : attemptSuffix(id);
}

/** Where the attempt's work in progress is: its WIP ref, at the last pushed sha. */
export function wipText(attempt: Pick<Attempt, 'wipRef' | 'wipSha'>): string | null {
  if (!attempt.wipRef) return null;
  return attempt.wipSha ? `${attempt.wipRef} at ${shortSha(attempt.wipSha)}` : attempt.wipRef;
}

// ---------------------------------------------------------------------------
// Facts and log
// ---------------------------------------------------------------------------

export interface FactRow {
  label: string;
  value: string;
  /** Set when the fact is what a stall rule watches and it looks wrong. */
  tone: Tone | null;
}

/** A short age with seconds under a minute, since facts change by the heartbeat. */
function age(ms: number): string {
  return ms < 60_000 ? `${Math.round(ms / 1000)} s` : duration(ms);
}

/**
 * The facts rows of the attempt page (6.8), from the runner's last heartbeat. They are ages with sleep already taken
 * out, so they are shown as reported rather than against this browser's clock.
 */
export function factsRows(facts: AttemptFacts | null): FactRow[] {
  if (!facts) return [];
  const row = (label: string, value: string, tone: Tone | null = null): FactRow => ({ label, value, tone });
  const since = (ms: number | null) => (ms === null ? 'none yet' : `${age(ms)} ago`);
  const { tool } = facts;
  const toolText = tool
    ? `${tool.name}${tool.command ? ` (${tool.command})` : ''}, running ${age(tool.ageMs)}${
        tool.capMs === null ? '' : ` of its ${age(tool.capMs)} cap`
      }`
    : 'none';
  const overCap = tool !== null && tool.capMs !== null && tool.ageMs >= tool.capMs;
  return [
    row('Last agent event', since(facts.eventAgeMs)),
    row('Tool in flight', toolText, overCap ? 'trouble' : null),
    row('Last file change', since(facts.fsAgeMs)),
    row('Last commit', since(facts.commitAgeMs)),
    row('Turns', String(facts.turns)),
    row('Turns without progress', String(facts.turnsWithoutProgress)),
    row('Repeated calls', String(facts.repeatedCalls)),
    row('Continuations', String(facts.continuations)),
    facts.vendorErrorMs > 0
      ? row('Vendor errors', `for ${age(facts.vendorErrorMs)}`, 'trouble')
      : row('Vendor errors', 'none'),
    row('Active time', age(facts.activeMs)),
    row('Context used', facts.contextUsed === null ? 'unknown' : percent(facts.contextUsed)),
  ];
}

export const LOG_KIND_LABELS: Record<AttemptLogEntry['kind'], string> = {
  tool: 'Tool',
  turn: 'Turn',
  text: 'Text',
  delivery: 'Message',
  quota: 'Quota',
  violation: 'Violation',
  compaction: 'Compaction',
  vendor_error: 'Vendor error',
  rejected: 'Rejected',
  note: 'Note',
};

/** Violations, vendor errors and rejected events need a look; messages delivered to the agent are worth reading. */
export const LOG_KIND_TONES: Record<AttemptLogEntry['kind'], Tone> = {
  tool: 'active',
  turn: 'active',
  text: 'closed',
  delivery: 'review',
  quota: 'wait',
  violation: 'trouble',
  compaction: 'wait',
  vendor_error: 'trouble',
  rejected: 'trouble',
  note: 'closed',
};

// ---------------------------------------------------------------------------
// Submissions
// ---------------------------------------------------------------------------

/**
 * Each submit refusal in plain words (6.13), keyed by core's SubmitError so a code core adds fails the typecheck.
 * fixable mirrors FIXABLE_SUBMIT_ERRORS: those refusals go back to the agent, which fixes them and submits again.
 */
export const SUBMIT_ERROR_TEXTS: Record<SubmitError, { text: string; fixable: boolean }> = {
  dirty: { text: 'Refused: the clone had uncommitted changes', fixable: true },
  protected_paths: { text: 'Refused: it changed protected paths', fixable: true },
  needs_merge: { text: 'Refused: someone added commits to the task branch, so it must merge them first', fixable: true },
  branch_moved: { text: 'Refused: the task branch moved outside agflow', fixable: false },
  remote: { text: 'Failed: pushing to the remote kept failing', fixable: false },
  interrupted: { text: 'Interrupted: a stop arrived while it was pushing', fixable: false },
};

/**
 * A submission's outcome in plain words. A runner's refusal is read with core's splitSubmitError: its code gives the
 * words, and the runner's own detail, when it sent one, comes back as `detail` to show beside them.
 */
export function submissionOutcome(record: Pick<SubmissionRecord, 'status' | 'headSha' | 'error'>): {
  text: string;
  tone: Tone;
  fixable: boolean;
  detail: string | null;
} {
  switch (record.status) {
    case 'pending':
      return { text: 'Pending: the runner is pushing it', tone: 'active', fixable: false, detail: null };
    case 'submitted':
      return {
        text: record.headSha ? `Submitted at ${shortSha(record.headSha)}` : 'Submitted',
        tone: 'review',
        fixable: false,
        detail: null,
      };
    case 'failed': {
      if (!record.error) return { text: 'Failed', tone: 'trouble', fixable: false, detail: null };
      const { code, detail } = splitSubmitError(record.error);
      // The hub's own failures ("attempt ended: stalled") are already words.
      if (code === null) return { text: record.error, tone: 'trouble', fixable: false, detail: null };
      const { text, fixable } = SUBMIT_ERROR_TEXTS[code];
      return {
        text: fixable ? `${text}. The agent fixes this and submits again` : text,
        tone: 'trouble',
        fixable,
        detail,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// The task's current attempt and its holder
// ---------------------------------------------------------------------------

export function currentAttempt(task: Pick<Task, 'currentAttempt'>, attempts: Attempt[]): Attempt | null {
  if (!task.currentAttempt) return null;
  return attempts.find((attempt) => attempt.id === task.currentAttempt) ?? null;
}

/**
 * Who works on a task: the runner or live chat of its open current attempt, and nobody once that attempt ended. A
 * claim from before M2 has no attempt, so a held task with an assignee and no known attempt is a live chat's.
 */
export function holderOf(task: Pick<Task, 'status' | 'assignee' | 'currentAttempt'>, attempts: Attempt[]): TaskHolder {
  const current = currentAttempt(task, attempts);
  if (current) return !isOpen(current) ? 'nobody' : current.runnerId ? 'runner' : 'live';
  return isHeld(task.status) && task.assignee ? 'live' : 'nobody';
}

// ---------------------------------------------------------------------------
// Actions on runner agents
// ---------------------------------------------------------------------------

export type RunnerAction = 'interrupt' | 'stop' | 'stop_hold' | 'replace' | 'takeover';

export interface RunnerActionSpec {
  label: string;
  /** The agent route it calls under /api/agents/:id/; take over calls the task's route instead. */
  route: AgentAction | null;
  /** The hub records the reason with the stop; the agent's handoff turn and the timeline show it. */
  reason: boolean;
  prompt: string;
  confirm: string;
  danger: boolean;
}

/** In the order the Agents table offers them (design 11; the stop rows of 6.4). */
export const RUNNER_ACTIONS: Record<RunnerAction, RunnerActionSpec> = {
  interrupt: {
    label: 'Interrupt',
    route: 'interrupt',
    reason: false,
    prompt: 'Interrupt the turn it is in? The agent keeps its session and its work.',
    confirm: 'Interrupt',
    danger: false,
  },
  stop: {
    label: 'Stop',
    route: 'stop',
    reason: true,
    prompt: 'Why stop it? It writes a handoff note first, and a task it holds goes back to Ready for the next agent.',
    confirm: 'Stop',
    danger: true,
  },
  stop_hold: {
    label: 'Stop and hold',
    route: 'stop',
    reason: true,
    prompt: 'Why stop and hold it? It writes a handoff note, and the task waits, paused, until a person unblocks it.',
    confirm: 'Stop and hold',
    danger: true,
  },
  replace: {
    label: 'Replace',
    route: 'replace',
    reason: true,
    prompt: 'Why replace it? It writes a handoff note, and a new agent goes on from its work.',
    confirm: 'Replace',
    danger: true,
  },
  takeover: {
    label: 'Take over',
    route: null,
    reason: false,
    prompt: 'Take this task over? The agent stops, and you get the commands to go on with its work yourself.',
    confirm: 'Take over',
    danger: true,
  },
};

/** The request body for an action, or null while a required reason is missing. */
export function runnerActionBody(action: RunnerAction, reason: string): AgentActionBodies[AgentAction] | null {
  const text = reason.trim();
  if (!RUNNER_ACTIONS[action].reason) return {};
  if (!text) return null;
  return action === 'stop_hold' ? { reason: text, hold: true } : { reason: text };
}

/** Causes a stop and hold may still replace: it moves the task at request time, and these move it only on exit. */
const HOLD_REPLACES = new Set<StopCause>([
  'stop',
  'replace',
  'stall_silent',
  'stall_hung_tool',
  'stall_loop',
  'stall_no_progress',
  'stall_budget',
]);

/**
 * The actions a person may take on a runner agent's attempt (6.4, 6.12, X-34). Live chats get none (people release
 * those), nor do holding or ended attempts. A runner lead gets interrupt, stop and replace: hold and take-over are
 * refused for leads. Interrupt needs a turn to interrupt, and take-over a running or quota_wait attempt; both need an
 * online runner, and neither is offered while the runner stops the agent on its own (phase stopping with no stop
 * recorded: a guard, agflow runner stop or uninstall), since a take-over would race that stop.
 * Once a stop is recorded, 6.4's rule for a second request applies: a stop and hold may replace a stop, replace or
 * stall cause, nothing replaces any other cause (a take-over included), and a deferred stop, waiting on a pending
 * submission, may be replaced by any stop but not by a take-over, which a pending submission refuses.
 */
export function runnerActionsFor(attempt: Attempt | null, runner: Pick<Runner, 'state'> | null): RunnerAction[] {
  if (!attempt || attempt.runnerId === null || !isOpen(attempt) || attempt.status === 'holding') return [];
  const stop = attempt.stopRequested;
  const lead = attempt.role === 'lead' && attempt.taskId === null;
  if (stop && stop.deferred) return lead ? ['stop', 'replace'] : ['stop', 'stop_hold', 'replace'];
  if (stop) return !lead && HOLD_REPLACES.has(stop.cause) ? ['stop_hold'] : [];
  const online = runner?.state === 'online';
  const stopping = attempt.phase === 'stopping';
  const actions: RunnerAction[] = [];
  if (online && attempt.status === 'running' && attempt.phase === 'turn') actions.push('interrupt');
  actions.push(...(lead ? (['stop', 'replace'] as const) : (['stop', 'stop_hold', 'replace'] as const)));
  if (!lead && online && !stopping && (attempt.status === 'running' || attempt.status === 'quota_wait')) {
    actions.push('takeover');
  }
  return actions;
}

/** What a person sees once the hub took the request; the agent then acts in its own time. */
const ACTION_DONE: Record<RunnerAction, string> = {
  interrupt: 'Interrupt sent: the runner interrupts the turn.',
  stop: 'Stop recorded: the agent writes a handoff note, then stops.',
  stop_hold: 'Stop and hold recorded: the agent writes a handoff note, and the task waits for people.',
  replace: 'Replace recorded: the agent writes a handoff note, and a new agent goes on from its work.',
  takeover: 'Take-over started.',
};

/** The stop cause each stop action records (6.4). */
const ACTION_CAUSES: Partial<Record<RunnerAction, StopCause>> = {
  stop: 'stop',
  stop_hold: 'stop_hold',
  replace: 'replace',
};

/**
 * What the hub did with an accepted action, from the attempt it answered with (6.4, 6.13, X-34). A stop or replace
 * may be taken without being done now: the hub keeps a stop already recorded that the new one may not replace, and
 * holds one back while a submission is pending, applying it only if the push fails. Interrupt answers no attempt.
 */
export function actionOutcomeText(action: RunnerAction, attempt: Pick<Attempt, 'stopRequested'> | null): string {
  const stop = attempt?.stopRequested;
  const cause = ACTION_CAUSES[action];
  if (!stop || !cause) return ACTION_DONE[action];
  if (stop.cause !== cause) {
    return (
      `The hub kept the stop already recorded (${STOP_CAUSE_LABELS[stop.cause]}, asked by ${who(stop.by)}): ` +
      'your request changed nothing.'
    );
  }
  if (stop.deferred) {
    return (
      'Recorded, but it waits for the pending submission: if the push fails it applies; if it lands, it is dropped ' +
      'and the task goes up for review.'
    );
  }
  return ACTION_DONE[action];
}

// ---------------------------------------------------------------------------
// Take-over and hand-back
// ---------------------------------------------------------------------------

const HOLD_INSTEAD = "Stop and hold keeps the task for people, from the agent's last pushed work.";

/** Each 409 of a refused take-over (6.12), keyed by core's TakeoverRefusal; the test compares the keys. */
const TAKEOVER_REFUSAL_TEXTS: Record<TakeoverRefusal, string> = {
  runner_offline: `Its runner is offline, so nobody can hand you its clone. ${HOLD_INSTEAD}`,
  not_running: `The agent is not running, or a stop is already on its way. ${HOLD_INSTEAD}`,
  submission_pending:
    'A submission is being pushed. Wait for its outcome, or stop and hold the task: it then waits for people, ' +
    "from the agent's last pushed work.",
};

/** Why the hub refused a take-over, with Stop and hold offered instead; null for any other error code. */
export function takeoverRefusal(code: string): { message: string; offer: RunnerAction } | null {
  if (!Object.hasOwn(TAKEOVER_REFUSAL_TEXTS, code)) return null;
  return { message: TAKEOVER_REFUSAL_TEXTS[code as TakeoverRefusal], offer: 'stop_hold' };
}

/**
 * Where a take-over stands, from the task and its current attempt (6.12, X-22, X-37):
 * - preparing: the attempt is still open while the runner stops the agent and builds the clone; no commands yet;
 * - ready: the commands to run and the take-over ref to push to. local is null when the hub ended the attempt at
 *   lease expiry or the stop timeout, which leaves only the command that works anywhere. handbackError is a refused
 *   clone hand-back (X-37's 'process_running'), after which the person may hand back again;
 * - handing_back: a hand-back from the clone is on its way, sent by `by` at `at` (X-49); the hub refuses a second one
 *   until the runner answers or handbackTimeoutMs passes;
 * - failed: the runner stopped the agent but could not prepare its clone (local null, with the runner's error); the
 *   work is still in its WIP, which the anywhere command fetches;
 * - unrecorded: the attempt ended before any commands were recorded (its runner was retired, say); the task stays
 *   taken over, so it is handed back from a pushed ref, or from the clone if the runner still has one.
 */
export type TakeoverState =
  | { kind: 'none' }
  | { kind: 'preparing' }
  | { kind: 'ready'; local: string | null; anywhere: string; ref: string; handbackError: string | null }
  | { kind: 'handing_back'; by: string; at: number }
  | { kind: 'failed'; error: string; anywhere: string; ref: string }
  | { kind: 'unrecorded' };

/** X-37 records a refused clone hand-back in takeover.error under this code. */
const HANDBACK_REFUSED = 'process_running';

export function takeoverState(task: Pick<Task, 'status' | 'blockedKind'>, attempt: Attempt | null): TakeoverState {
  if (task.status !== 'blocked' || task.blockedKind !== 'takeover' || !attempt) return { kind: 'none' };
  const { takeover } = attempt;
  if (!takeover) return isOpen(attempt) ? { kind: 'preparing' } : { kind: 'unrecorded' };
  if (takeover.handingBack) return { kind: 'handing_back', by: takeover.handingBack.by, at: takeover.handingBack.at };
  // A refused hand-back is no failed take-over, whether or not the runner built the local command.
  const refused = takeover.error?.startsWith(HANDBACK_REFUSED) ?? false;
  if (takeover.local === null && takeover.error !== null && !refused) {
    return { kind: 'failed', error: takeover.error, anywhere: takeover.anywhere, ref: takeover.ref };
  }
  return {
    kind: 'ready',
    local: takeover.local,
    anywhere: takeover.anywhere,
    ref: takeover.ref,
    handbackError: takeover.error,
  };
}

/**
 * Hand-back is for the person who took over, or anyone once its runner is not online (X-24); nobody while the
 * take-over is still preparing, or while a hand-back is on its way (the hub answers 409 handback_pending). The person
 * is the attempt's stopRequested.by, which holds the requester's actor string as the hub's actor() writes it
 * ('user:<login>'). The hub checks the same.
 */
export function canHandBack(
  task: Pick<Task, 'status' | 'blockedKind'>,
  attempt: Attempt | null,
  runner: Pick<Runner, 'state'> | null,
  me: Pick<Me, 'user'> | null,
): boolean {
  const state = takeoverState(task, attempt);
  if (state.kind === 'none' || state.kind === 'preparing' || state.kind === 'handing_back') return false;
  if (me !== null && attempt?.stopRequested?.by === `user:${me.user}`) return true;
  return runner?.state !== 'online';
}

/**
 * A ref git accepts under refs/, as core's RefSchema has it (its branch-name rule plus the refs/ prefix). The rule is
 * repeated here because the web takes no values from core's zod modules (X-48); the test checks it against
 * HandbackInputSchema.
 */
function isRef(ref: string): boolean {
  return (
    /^[A-Za-z0-9._/-]{1,200}$/.test(ref) &&
    ref.startsWith('refs/') &&
    !ref.includes('..') &&
    !ref.endsWith('.') &&
    ref.split('/').every((part) => part !== '' && !part.startsWith('.') && !part.endsWith('.lock'))
  );
}

/**
 * A hand-back source the hub accepts: the runner's clone, or a pushed ref at a full 40-hex sha, because the next
 * runner may fetch the ref by it (X-24). Pasted values are trimmed, and the sha lowercased.
 */
export function handbackSource(input: 'clone' | { ref: string; sha: string }): HandbackSource | null {
  if (input === 'clone') return 'clone';
  const ref = input.ref.trim();
  const sha = input.sha.trim().toLowerCase();
  return isRef(ref) && /^[0-9a-f]{40}$/.test(sha) ? { ref, sha } : null;
}

// ---------------------------------------------------------------------------
// Notes between attempts
// ---------------------------------------------------------------------------

/**
 * One step from an attempt to the next, for the side-by-side view: what `from` left (its handoff and late work) beside
 * how `to` read it back (its restatement). The first attempt's restatement has no `from`, the newest attempt's
 * handoff no `to`, and notes without an attempt form one group with neither.
 */
export interface NoteGroup {
  from: string | null;
  to: string | null;
  handoffs: TaskNote[];
  lateWork: TaskNote[];
  restatements: TaskNote[];
}

/** Epoch first, then number; ids that are not attempt ids go last. */
function attemptOrder(a: string, b: string): number {
  const pa = parseAttemptId(a);
  const pb = parseAttemptId(b);
  if (!pa || !pb) return pa ? -1 : pb ? 1 : a.localeCompare(b);
  return pa.epoch - pb.epoch || pa.number - pb.number;
}

/**
 * Groups a task's handoff, restatement and late-work notes by TaskNote.attemptId (X-22), in attempt order. The
 * attempts come from the task's attempt list and from the notes themselves, so a note naming an attempt the list
 * lacks still finds its place. Attempts that failed to start never ran an agent, so they neither leave nor read notes
 * and stay out of the chain: a handoff still sits beside the restatement that answers it across a refused start.
 * Progress and release notes stay out.
 */
export function noteGroups(notes: TaskNote[], attempts: Pick<Attempt, 'id' | 'endReason'>[]): NoteGroup[] {
  const paired = notes
    .filter((note) => note.kind === 'handoff' || note.kind === 'late_work' || note.kind === 'restatement')
    .sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  const ids = [
    ...new Set([
      ...attempts.filter((attempt) => attempt.endReason !== 'failed_to_start').map((attempt) => attempt.id),
      ...paired.flatMap((note) => (note.attemptId ? [note.attemptId] : [])),
    ]),
  ].sort(attemptOrder);
  const group = (from: string | null, to: string | null, of: (note: TaskNote) => boolean): NoteGroup => ({
    from,
    to,
    handoffs: paired.filter((note) => note.kind === 'handoff' && of(note) && note.attemptId === from),
    lateWork: paired.filter((note) => note.kind === 'late_work' && of(note) && note.attemptId === from),
    restatements: paired.filter((note) => note.kind === 'restatement' && of(note) && note.attemptId === to),
  });
  const groups: NoteGroup[] = [];
  if (ids.length > 0) {
    for (let i = 0; i <= ids.length; i += 1) {
      groups.push(group(ids[i - 1] ?? null, ids[i] ?? null, (note) => note.attemptId !== null));
    }
  }
  groups.push(group(null, null, (note) => note.attemptId === null));
  return groups.filter((g) => g.handoffs.length + g.lateWork.length + g.restatements.length > 0);
}

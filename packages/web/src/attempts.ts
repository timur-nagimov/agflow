// What the web says about attempts (design 6.1, 6.4, 6.8, 6.9, 6.13, 11): labels, the phase a person sees, tones,
// short names, the WIP position, the facts of the attempt page, log kinds, submission outcomes, and who holds a task.
// Free of the DOM so the rules are unit-tested. From runner-protocol.ts, which builds zod schemas, only types come in
// (X-48); the tests compare the tables here with its values.
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
  splitSubmitError,
  type StopCause,
  type SubmissionRecord,
  type SubmitError,
  type Task,
} from '@agflow/core';
import { duration, percent, shortSha, type TaskHolder, type Tone } from './format';

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

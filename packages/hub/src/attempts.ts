// Runner attempts (design 6.4): the one transaction that starts one, the AttemptSpec its start_attempt carries, the
// re-fence that resumes one, stop requests and their timeout, endAttempt, the one path every ending takes, the retry
// ladder that follows an ending (design 6.9), and what the attempt events a runner reports do (design 6.3).
import {
  type Agent,
  type AgentRole,
  type Attempt,
  type AttemptSpec,
  COUNTED_CLASSES,
  ENDING_MOVES,
  type EndingTrigger,
  type InjectedMessage,
  type LadderStep,
  type RunnerEventData,
  STOP_CAUSES,
  type StopCause,
  type Task,
  type TaskStatus,
  type Vendor,
  type VendorRequirement,
  attemptId,
  backoffApplies,
  branchEpoch,
  computeToolCaps,
  countedAttempts,
  endingClass,
  failureSignature,
  formatFence,
  infraBackoffMs,
  isTaskBranch,
  ladderStep,
  leadAttemptId,
  plannedTaskMove,
  quoteLines,
  restoreSet,
  signatureApplies,
  taskBranchName,
  vendorRequirement,
  wipRef,
} from '@agflow/core';
import { getAgent } from './agents';
import {
  type ResumeLogEntry,
  appendAttemptLog,
  attemptSubject,
  getAttempt,
  insertAttempt,
  issueFence,
  listAttempts,
  nextAttemptNumber,
  openAttemptOf,
  updateAttempt,
} from './attempt-store';
import { revokeAgentTokens } from './auth';
import { buildBrief, composeTaskPack, firstPrompt, isSuccessor } from './brief';
import {
  type CommandRow,
  type StoredCommand,
  cancelPendingCommands,
  cancelPendingOfKind,
  enqueueCommand,
  pendingResumeOf,
} from './commands';
import { type HubContext, tx } from './context';
import { nextId } from './db';
import { HubError, badRequest, conflict, notFound } from './errors';
import type { Emit } from './events';
import { assembleHandoffNote, handoffWritten } from './handoff';
import { emptySeat, insertLeadNote, seatHolderId, takeSeat } from './hub-state';
import { insertMessage } from './messages';
import { getProject } from './project';
import {
  findRunnerRow,
  markVendorNotReady,
  recordFailedStart,
  recordStartRefusal,
  resetFailedStarts,
} from './runners';
import { addNote, findTask, getTask, move, setAgentTask, writeTask } from './task-store';
import { clip } from './text';

export interface StartAttemptInput {
  runnerId: string;
  /** The task a worker takes; null for a lead attempt. */
  taskId: string | null;
  role: AgentRole;
  vendor: Vendor;
  /** Null, the default: the runner's model for the vendor and role. */
  model?: string | null | undefined;
  /** Who starts it: the scheduler by default. */
  actor?: string | undefined;
}

export interface StartedAttempt {
  attempt: Attempt;
  agent: Agent;
  /** The start_attempt queued for the runner. */
  command: CommandRow;
}

/** The base the runner resolves the restore set against: main, by name, because the hub has no git (X-16). */
const restoreBase = (ctx: HubContext): string => `refs/heads/${ctx.config.mainBranch}`;

/**
 * Where an attempt starts (design 6.4, Work position): the task's work position, or main when it has none, as for
 * every lead attempt. The runner fetches the ref and reports the commit it actually used.
 */
export function startPositionFor(ctx: HubContext, task: Task | null): AttemptSpec['start'] {
  if (task?.workRef) return { ref: task.workRef, sha: task.workSha };
  return { ref: restoreBase(ctx), sha: null };
}

/** The restore set and its base, recomputed for every start and resume (X-16). */
function restoreFor(ctx: HubContext, task: Task | null): AttemptSpec['restore'] {
  return { paths: restoreSet(task), base: restoreBase(ctx) };
}

/**
 * The spec of a start_attempt (design 6.3), without the agent token, which is minted for each send. Call it once the
 * attempt, its agent and the claim exist: the brief describes them.
 */
export function buildAttemptSpec(
  ctx: HubContext,
  attempt: Attempt,
  model: string | null = null,
): Omit<AttemptSpec, 'agentToken'> {
  const task = attempt.taskId === null ? null : getTask(ctx, attempt.taskId);
  const successor = isSuccessor(attempt);
  return {
    attemptId: attempt.id,
    taskId: attempt.taskId,
    role: attempt.role,
    vendor: attempt.vendor,
    model,
    fence: attempt.fence,
    hubUrl: ctx.config.publicUrl,
    repo: { url: getProject(ctx).repo, mainBranch: ctx.config.mainBranch },
    start: { ref: attempt.startRef ?? restoreBase(ctx), sha: attempt.startSha },
    branch: task?.branch ?? null,
    wipRef: attempt.wipRef,
    restore: restoreFor(ctx, task),
    acceptanceIds: task?.acceptance.map((criterion) => criterion.id) ?? [],
    toolCaps: computeToolCaps(ctx.config, task?.checks ?? []),
    // A lead holds no task, so its task.md is empty; its brief carries what it needs.
    taskPack: task ? composeTaskPack(task) : '',
    brief: buildBrief(ctx, getAgent(ctx, attempt.agentId)),
    firstPrompt: firstPrompt({ role: attempt.role, taskId: attempt.taskId, successor }),
    successor,
  };
}

/**
 * The branch a task's runner attempts commit on (design 6.14, 10): the one it has, when that lies in its namespace and
 * was named in the current epoch, or a new name. At epoch 1 every recorded branch is current; from epoch 2 a branch
 * named before the restore is left alone, so nothing collides with what existed then.
 */
function branchFor(task: Task, epoch: number): string {
  const current = isTaskBranch(task.id, task.branch) && (epoch === 1 || branchEpoch(task.branch) === epoch);
  return current ? (task.branch as string) : taskBranchName(task.id, task.title, epoch);
}

/** The data every event about one attempt carries (design 6.17). */
export function attemptData(attempt: Attempt): Record<string, unknown> {
  return { attemptId: attempt.id, taskId: attempt.taskId, agentId: attempt.agentId, runnerId: attempt.runnerId };
}

/** Checks that the attempt may start, and returns its task (null for a lead). */
function checkStart(ctx: HubContext, input: StartAttemptInput): Task | null {
  if (input.role === 'lead') {
    if (input.taskId !== null) throw badRequest('a lead attempt takes no task');
    const holder = seatHolderId(ctx);
    if (holder !== null) throw conflict(`${holder} holds the lead seat`);
    return null;
  }
  if (input.taskId === null) throw badRequest('a worker attempt needs a task');
  const task = findTask(ctx, input.taskId);
  if (!task) throw notFound(`task ${input.taskId}`);
  const open = openAttemptOf(ctx, task.id);
  if (open) throw conflict(`${task.id} already has an open attempt, ${open.id}`);
  if (task.status !== 'ready') throw conflict(`${task.id} is ${task.status}, not ready`);
  return task;
}

/**
 * Starts a runner attempt (design 6.4, Creating an attempt). In one transaction: the agent (origin runner, owned by
 * the runner's owner), the attempt (starting, a new fence, a runner lease), the claim on the task, or the lead seat
 * for a lead, and start_attempt. The agent token is minted when the command is sent, so none is stored. A task holds
 * at most one open attempt; a lead starts only while the seat is empty.
 */
export function startRunnerAttempt(ctx: HubContext, input: StartAttemptInput): StartedAttempt {
  return tx(ctx, (emit) => {
    const actor = input.actor ?? 'system';
    const runner = findRunnerRow(ctx, input.runnerId);
    if (!runner) throw notFound(`runner ${input.runnerId}`);
    const task = checkStart(ctx, input);
    const now = ctx.now();
    const number = nextAttemptNumber(ctx, task?.id ?? null);
    const fence = issueFence(ctx);
    const id = task ? attemptId(task.id, number, fence.epoch) : leadAttemptId(number, fence.epoch);
    const agentSeq = nextId(ctx.db, 'agent');
    const agentId = `A-${agentSeq}`;
    ctx.db
      .query(
        `INSERT INTO agents (id, seq, login, vendor, role, origin, label, current_task, last_seen_at, created_at,
           runner_id, attempt_id)
         VALUES ($id, $seq, $login, $vendor, $role, 'runner', $label, NULL, $now, $now, $runnerId, $attemptId)`,
      )
      .run({
        id: agentId,
        seq: agentSeq,
        login: runner.owner,
        vendor: input.vendor,
        role: input.role,
        label: id,
        now,
        runnerId: runner.id,
        attemptId: id,
      });
    const start = startPositionFor(ctx, task);
    const attempt = insertAttempt(ctx, {
      id,
      taskId: task?.id ?? null,
      number,
      role: input.role,
      agentId,
      runnerId: runner.id,
      vendor: input.vendor,
      fence,
      status: 'starting',
      startRef: start.ref,
      startSha: start.sha,
      wipRef: task ? wipRef(ctx.config.wipRefPrefix, id) : null,
      leaseExpiresAt: now + ctx.config.runnerLeaseMs,
    });
    claim(ctx, emit, task, attempt, actor);
    const command = enqueueCommand(ctx, runner.id, {
      kind: 'start_attempt',
      attempt: buildAttemptSpec(ctx, attempt, input.model ?? null),
    });
    emit({
      type: 'attempt.started',
      actor,
      subject: attemptSubject(attempt),
      data: { ...attemptData(attempt), vendor: attempt.vendor, role: attempt.role },
    });
    return { attempt, agent: getAgent(ctx, agentId), command };
  });
}

/**
 * Gives the attempt its work: the task claimed for its agent on the task branch, with no M1 lease (runner attempts
 * hold a runner lease instead), or the lead seat.
 */
function claim(ctx: HubContext, emit: Emit, task: Task | null, attempt: Attempt, actor: string): void {
  if (!task) {
    takeSeat(ctx, emit, attempt.agentId, 'runner', actor);
    return;
  }
  const branch = branchFor(task, attempt.fence.epoch);
  // A recorded head is the head of the branch it was recorded for; a new name starts with none (design 6.13).
  const branchHead = branch === task.branch ? undefined : null;
  move(ctx, emit, task, 'claimed', actor, {
    changes: { assignee: attempt.agentId, branch, branchHead, leaseExpiresAt: null },
    data: { assignee: attempt.agentId, attemptId: attempt.id },
  });
  setAgentTask(ctx, attempt.agentId, task.id);
}

// ---------------------------------------------------------------------------
// Resume (design 6.4): a new fence for an open attempt
// ---------------------------------------------------------------------------

/**
 * What a resume is for: ladder step 1 (review feedback back to its author), a runner restart or suspend
 * (reconciliation), a holding lead, which exited on its own (resumed at once after an exit in a turn, or on its next
 * delivery after an idle one: design 6.11), or the re-fence after a restore.
 */
export type ResumeCause = 'review' | 'runner_restart' | 'lead_exit' | 'restore';

const RESUME_CAUSES: Readonly<Record<ResumeCause, string>> = {
  review: 'the review feedback goes back to its author',
  runner_restart: 'the runner restarted',
  lead_exit: 'the lead exited on its own',
  restore: 'the hub was restored from a backup',
};

/** The resumes resume_log keeps, which end an attempt when they repeat within their window (design 6.3, 6.11). */
const isLogged = (cause: ResumeCause): cause is ResumeLogEntry['cause'] =>
  cause === 'runner_restart' || cause === 'lead_exit';

export interface ResumeInput {
  attemptId: string;
  cause: ResumeCause;
  /** The agent's next prompt: the quoted feedback, the wake-up delivery, or word that the runner restarted. */
  prompt: string;
  /** Messages injected with it, formatted and quoted. */
  messages?: InjectedMessage[] | undefined;
  actor?: string | undefined;
}

export interface ResumedAttempt {
  attempt: Attempt;
  command: CommandRow;
}

function resumeLog(ctx: HubContext, attemptId: string): ResumeLogEntry[] {
  const row = ctx.db.query('SELECT resume_log FROM attempts WHERE id = $id').get({ id: attemptId }) as {
    resume_log: string | null;
  } | null;
  return row?.resume_log ? (JSON.parse(row.resume_log) as ResumeLogEntry[]) : [];
}

/** How many resumes of this cause the attempt had within the last windowMs. */
export function recentResumes(ctx: HubContext, attemptId: string, cause: ResumeCause, windowMs: number): number {
  const since = ctx.now() - windowMs;
  return resumeLog(ctx, attemptId).filter((entry) => entry.cause === cause && entry.at > since).length;
}

/** The log with this resume added, keeping only entries a window can still count. */
function loggedResume(ctx: HubContext, attemptId: string, cause: ResumeCause): ResumeLogEntry[] | undefined {
  if (!isLogged(cause)) return undefined;
  const now = ctx.now();
  const kept = Math.max(ctx.config.resumeWindowMs, ctx.config.leadExitWindowMs);
  return [...resumeLog(ctx, attemptId).filter((entry) => entry.at > now - kept), { at: now, cause }];
}

/** The prompts and messages of a resume that a re-fence replaced, then this one's; a message once only. */
function carriedOver(pending: CommandRow | null, input: ResumeInput): { prompt: string; messages: InjectedMessage[] } {
  const earlier = pending?.command.kind === 'resume_attempt' ? pending.command : null;
  const messages = [...(earlier?.messages ?? []), ...(input.messages ?? [])];
  const seen = new Set<number>();
  const unique = messages.filter((message) => {
    // Id 0 is hub text with no message row; each copy may differ.
    if (message.messageId === 0) return true;
    if (seen.has(message.messageId)) return false;
    seen.add(message.messageId);
    return true;
  });
  // A prompt the carried one already ends with was carried by an earlier re-fence that never reached the runner.
  const prompt =
    earlier === null || earlier.prompt === input.prompt
      ? input.prompt
      : earlier.prompt.endsWith(`\n\n${input.prompt}`)
        ? earlier.prompt
        : `${earlier.prompt}\n\n${input.prompt}`;
  return { prompt, messages: unique };
}

/**
 * The stop_attempt for a recorded stop request, at the attempt's current fence. The reason is the text the agent is
 * given: the hub's own goes as it is, anyone else's, a lead's included, quoted under who asked (design 5).
 */
export function stopCommand(attempt: Attempt): StoredCommand {
  const stop = attempt.stopRequested;
  if (!stop) throw new Error(`attempt ${attempt.id} has no stop request`);
  return {
    kind: 'stop_attempt',
    attemptId: attempt.id,
    fence: attempt.fence,
    cause: stop.cause,
    reason: stop.by === 'system' ? stop.reason : `[agflow stop requested by ${stop.by}]\n${quoteLines(stop.reason)}`,
    handoff: stop.handoff,
    interruptFirst: STOP_CAUSES[stop.cause].interruptFirst,
    keepClone: stop.cause === 'stop_hold',
  };
}

/**
 * Resumes an open runner attempt with a new fence (design 6.4, Resume). In one transaction: the attempt goes to
 * starting with a fresh runner lease, its tokens are revoked, its old fence's commands cancelled (a pending resume's
 * prompt and messages carried into this one), the cause logged, and resume_attempt queued with a recomputed task
 * pack, restore set and acceptance ids. A recorded stop is queued again at the new fence, after the resume, so the
 * re-fence does not drop it, and its grace starts again. A deferred stop stays held back. A take-over in flight is the take-over's to finish, so it cannot be resumed.
 */
export function resumeAttempt(ctx: HubContext, input: ResumeInput): ResumedAttempt {
  return tx(ctx, (emit) => {
    const before = getAttempt(ctx, input.attemptId);
    if (before.status === 'ended') {
      throw conflict(`attempt ${before.id} has ended (${before.endReason ?? 'unknown reason'})`);
    }
    if (before.runnerId === null) throw conflict(`attempt ${before.id} runs in a live chat, not on a runner`);
    if (before.stopRequested?.cause === 'takeover') throw conflict(`a take-over is in flight for attempt ${before.id}`);
    const pending = pendingResumeOf(ctx, before.id);
    cancelPendingCommands(ctx, before.id);
    revokeAgentTokens(ctx, before.id);
    const fence = issueFence(ctx);
    const now = ctx.now();
    updateAttempt(ctx, before.id, {
      fence,
      status: 'starting',
      leaseExpiresAt: now + ctx.config.runnerLeaseMs,
      resumeLog: loggedResume(ctx, before.id, input.cause),
    });
    ctx.db.query('UPDATE agents SET last_seen_at = $now WHERE id = $id').run({ now, id: before.agentId });
    appendAttemptLog(ctx, before.id, 'note', `resumed at fence ${formatFence(fence)}: ${RESUME_CAUSES[input.cause]}`);
    const attempt = getAttempt(ctx, before.id);
    const task = attempt.taskId === null ? null : getTask(ctx, attempt.taskId);
    const { prompt, messages } = carriedOver(pending, input);
    const command = enqueueCommand(ctx, attempt.runnerId as string, {
      kind: 'resume_attempt',
      attemptId: attempt.id,
      fence,
      prompt,
      messages,
      taskPack: task ? composeTaskPack(task) : null,
      restore: restoreFor(ctx, task),
      acceptanceIds: task?.acceptance.map((criterion) => criterion.id) ?? [],
    });
    if (attempt.stopRequested && !attempt.stopRequested.deferred) {
      // The new process gets the whole grace for its stop: the old one's may have run out before the re-fence.
      updateAttempt(ctx, attempt.id, { stopRequested: { ...attempt.stopRequested, at: now } });
      enqueueCommand(ctx, attempt.runnerId as string, stopCommand(getAttempt(ctx, attempt.id)));
    }
    emit({
      type: 'attempt.resumed',
      actor: input.actor ?? 'system',
      subject: attemptSubject(attempt),
      data: { ...attemptData(attempt), fence, reason: RESUME_CAUSES[input.cause] },
    });
    return { attempt: getAttempt(ctx, attempt.id), command };
  });
}

// ---------------------------------------------------------------------------
// Endings (design 6.4, Every way an attempt ends)
// ---------------------------------------------------------------------------

export interface EndAttemptInput {
  attemptId: string;
  /** The row of the trigger table: the recorded stop cause, or the event, timeout or decision that ends it. */
  trigger: EndingTrigger;
  /** What failed, for an infra ending's failure signature. */
  error?: string | null | undefined;
  actor?: string | undefined;
}

/** What an ending did. */
export interface Ending {
  attempt: Attempt;
  /** The attempt's task after the ending; null for a lead. */
  task: Task | null;
  /** The statuses the task passed through, in order; empty when it kept its status. */
  moved: TaskStatus[];
  /** Whether the hub stored an assembled handoff note for the task. */
  noteAdded: boolean;
  /** What the retry ladder did, when the ending moved the task to ready; null when it did not run. */
  ladder: LadderOutcome | null;
}

/** A task in these statuses keeps its assignee when the attempt ends: it names whose work is in review or merged. */
const KEEPS_ASSIGNEE: readonly TaskStatus[] = ['submitted', 'accepted'];

/**
 * Ends an attempt, whatever triggered it (design 6.4): the one path every ending takes, in the caller's transaction or
 * its own. It sets the end reason, class and failure signature from the trigger's row, revokes the tokens, cancels the
 * pending commands (cleanup, transcript uploads and hand-backs stay) and queues cleanup_attempt, except for a take-over,
 * whose cleanup follows its hand-back. It clears the holder fields (invariant e) and makes the row's on-exit move, only
 * while the task is claimed or working and names this attempt (X-34). It stores an assembled handoff note, with the
 * attempt's id, when the row asks and the agent wrote none, and empties the seat its lead held. A live chat's attempt
 * only ends: M1's operations move its task. Null when the attempt had already ended.
 */
export function endAttempt(ctx: HubContext, input: EndAttemptInput): Ending | null {
  return tx(ctx, (emit) => {
    const row = ENDING_MOVES[input.trigger];
    if (row.endReason === null) throw new Error(`${input.trigger} does not end an attempt`);
    const before = getAttempt(ctx, input.attemptId);
    if (before.status === 'ended') return null;
    const actor = input.actor ?? 'system';
    const failureClass = endingClass(input.trigger);
    updateAttempt(ctx, before.id, {
      status: 'ended',
      endReason: row.endReason,
      failureClass,
      failureSignature: signatureApplies(input.trigger) ? failureSignature(row.endReason, input.error ?? null) : null,
      leaseExpiresAt: null,
      endedAt: ctx.now(),
    });
    revokeAgentTokens(ctx, before.id);
    const attempt = getAttempt(ctx, before.id);
    let task = attempt.taskId === null ? null : getTask(ctx, attempt.taskId);
    let moved: TaskStatus[] = [];
    let noteAdded = false;
    let ladder: LadderOutcome | null = null;
    if (attempt.runnerId !== null) {
      cancelPendingCommands(ctx, attempt.id);
      if (row.endReason !== 'taken_over') {
        enqueueCommand(ctx, attempt.runnerId, { kind: 'cleanup_attempt', attemptId: attempt.id });
      }
      setAgentTask(ctx, attempt.agentId, null);
      if (task) {
        ({ task, moved } = moveOnEnd(ctx, emit, task, attempt, input.trigger, actor));
        noteAdded = addAssembledNote(ctx, attempt, input.trigger);
        // The ladder and the failure-signature rule run only when a move to ready actually happened (design 6.4).
        if (moved.at(-1) === 'ready') {
          ladder = applyLadder(ctx, emit, { task, attempt, trigger: input.trigger });
          task = ladder.task;
        }
      }
    }
    // Only a lead attempt with no task holds the seat; a live lead's task attempt leaves it alone.
    if (attempt.taskId === null) emptySeat(ctx, emit, actor, attempt.agentId);
    emit({
      type: 'attempt.ended',
      actor,
      subject: attemptSubject(attempt),
      data: { ...attemptData(attempt), endReason: attempt.endReason, failureClass },
    });
    return { attempt, task, moved, noteAdded, ladder };
  });
}

/**
 * The row's on-exit move, and the task's holder cleared unless its status keeps it. A task that names another attempt
 * by now has another holder, so it keeps its assignee.
 */
function moveOnEnd(
  ctx: HubContext,
  emit: Emit,
  task: Task,
  attempt: Attempt,
  trigger: EndingTrigger,
  actor: string,
): { task: Task; moved: TaskStatus[] } {
  const planned = plannedTaskMove(trigger, 'on_end', task, attempt.id);
  const path = planned ? [...planned.path] : [];
  const final = path.at(-1) ?? task.status;
  const clear =
    task.currentAttempt === attempt.id && task.assignee === attempt.agentId && !KEEPS_ASSIGNEE.includes(final);
  if (path.length === 0) {
    if (clear) writeTask(ctx, task.id, { assignee: null });
    return { task: getTask(ctx, task.id), moved: [] };
  }
  let current = task;
  for (const [index, status] of path.entries()) {
    const changes = index === 0 && clear ? { assignee: null } : {};
    current = move(ctx, emit, current, status, actor, { changes, data: { attemptId: attempt.id } });
  }
  return { task: current, moved: path };
}

/** Stores the assembled handoff note when the trigger's row asks for one (design 6.8). */
function addAssembledNote(ctx: HubContext, attempt: Attempt, trigger: EndingTrigger): boolean {
  const { note } = ENDING_MOVES[trigger];
  if (note === null || (note === 'if_none_written' && handoffWritten(ctx, attempt))) return false;
  addNote(ctx, attempt.taskId as string, 'handoff', assembleHandoffNote(ctx, attempt).body, 'system', attempt.id);
  return true;
}

// ---------------------------------------------------------------------------
// The retry ladder (design 6.9, 6.15 Attempt limit)
// ---------------------------------------------------------------------------

/** What the ladder asks of the vendor of a task's next attempt: core's requirement, for the scheduler. */
export type LadderRequirement = VendorRequirement;

export interface LadderInput {
  /** The task after the ending: ready, or rejected after a rejection without a resume. */
  task: Task;
  /** The attempt as ended. */
  attempt: Attempt;
  trigger: EndingTrigger;
}

/** What the ladder did after an ending. */
export interface LadderOutcome {
  /** The step a counted failure reached, or 4 for a repeated failure signature; null for anything else. */
  step: LadderStep | null;
  /** When an infra ending lets the task be dispatched again; null without a backoff. */
  nextDispatchAt: number | null;
  /** The task afterwards: ready, blocked for a re-plan, or failed. */
  task: Task;
}

/** Infra endings with one failure signature that send the task to step 4 (design 6.9). */
const SIGNATURE_REPEATS = 3;

function ladderFloor(ctx: HubContext, taskId: string): number {
  const row = ctx.db.query('SELECT ladder_floor FROM tasks WHERE id = $taskId').get({ taskId }) as {
    ladder_floor: number;
  } | null;
  return row?.ladder_floor ?? 0;
}

/** The task's attempts by number, oldest first. */
const attemptsOf = (ctx: HubContext, taskId: string): Attempt[] =>
  listAttempts(ctx, { task: taskId }).sort((a, b) => a.number - b.number);

/**
 * A runner's own stop and a refused start say nothing about the task, so the backoff passes over them, and live-chat
 * attempts are never on the ladder (design 6.4).
 */
const passedOver = (attempt: Attempt): boolean =>
  attempt.runnerId === null ||
  (attempt.endReason === 'stopped' && attempt.failureClass === 'infra') ||
  (attempt.endReason === 'failed_to_start' && attempt.failureClass === null);

/** The task's consecutive infra endings, newest back: the infra backoff's index (design 6.9). */
function consecutiveInfra(attempts: readonly Attempt[]): number {
  let count = 0;
  for (const attempt of [...attempts].reverse()) {
    if (attempt.status !== 'ended' || passedOver(attempt)) continue;
    if (attempt.failureClass !== 'infra') break;
    count += 1;
  }
  return count;
}

const named = (task: Task): string => `${task.id} ("${clip(task.title, 120)}")`;

/** The step-4 move: the task is blocked for a re-plan, with the reason the lead and people read. */
function blockForReplan(ctx: HubContext, emit: Emit, task: Task, attempt: Attempt, reason: string): Task {
  return move(ctx, emit, task, 'blocked', 'system', {
    changes: { blockedKind: 'replan', blockedReason: reason },
    data: { attemptId: attempt.id, ladderStep: 4 },
  });
}

/**
 * The retry ladder after an ending (design 6.9), in the ending's transaction. Call it once the ending moved the task
 * to ready, or once a rejection without a resume marked it rejected. A counted failure takes its step: 2 and 3 leave
 * the task ready (ladderRequirement then steers the vendor), 4 blocks it for a re-plan and tells the lead, 5 fails it
 * and tells people. An infra ending delays the task's next dispatch by the infra backoff, and the third with one
 * failure signature since the last re-plan blocks it for a re-plan and tells the lead and people. A rejected task
 * that stays on the ladder goes back to ready.
 */
export function applyLadder(ctx: HubContext, emit: Emit, input: LadderInput): LadderOutcome {
  const { attempt, trigger } = input;
  let task = input.task;
  if (task.status !== 'ready' && task.status !== 'rejected') {
    throw new Error(`the ladder runs on a ready or rejected task, not on ${task.id}, which is ${task.status}`);
  }
  const attempts = attemptsOf(ctx, task.id);
  const floor = ladderFloor(ctx, task.id);
  let step: LadderStep | null = null;
  let nextDispatchAt: number | null = null;
  if (backoffApplies(trigger)) {
    nextDispatchAt = ctx.now() + infraBackoffMs(Math.max(1, consecutiveInfra(attempts)), ctx.config.infraBackoffMs);
  }
  // Only this ending's backoff holds: one an earlier ending set must not delay the task now.
  writeTask(ctx, task.id, { nextDispatchAt });
  task = getTask(ctx, task.id);
  if (attempt.failureClass !== null && COUNTED_CLASSES.includes(attempt.failureClass)) {
    const counted = countedAttempts(attempts, floor);
    step = ladderStep({ counted, ladderFloor: floor, maxAttempts: ctx.config.maxAttempts });
    if (step === 4) {
      const reason =
        `${counted} attempts at ${task.id} failed; it needs a re-plan: split it, clarify or amend it, or cancel it.`;
      task = blockForReplan(ctx, emit, task, attempt, reason);
      insertMessage(ctx, emit, {
        from: 'system',
        to: 'lead',
        taskId: task.id,
        body:
          `${named(task)} is blocked for a re-plan: ${counted} of its attempts failed.\n` +
          'Split it, clarify or amend it with update_task, or cancel it with cancel_task. Unblocking it with ' +
          `unblock_task gives it ${ctx.config.maxAttempts} more attempts.`,
      });
    } else if (step === 5) {
      task = move(ctx, emit, task, 'failed', 'system', { data: { attemptId: attempt.id, ladderStep: 5 } });
      insertMessage(ctx, emit, {
        from: 'system',
        to: 'humans',
        taskId: task.id,
        body:
          `${named(task)} failed: ${counted} more of its attempts failed after its re-plan, so agflow will not try it ` +
          'again. Look at its attempts and decide what to do with the work.',
      });
    }
  } else if (attempt.failureSignature !== null) {
    const signature = attempt.failureSignature;
    const repeats = attempts.filter((other) => other.number > floor && other.failureSignature === signature).length;
    if (repeats >= SIGNATURE_REPEATS) {
      step = 4;
      const reason =
        `${repeats} attempts at ${task.id} ended the same way (${clip(signature, 300)}); ` +
        'fix the cause, then unblock it.';
      task = blockForReplan(ctx, emit, task, attempt, reason);
      const body =
        `${named(task)} is blocked for a re-plan: ${repeats} of its attempts ended the same way on runners:\n` +
        `${quoteLines(clip(signature, 300))}\n` +
        'This points at the runners or the setup more than at the task. Fix the cause, then unblock it with ' +
        'unblock_task.';
      for (const to of ['lead', 'humans']) insertMessage(ctx, emit, { from: 'system', to, taskId: task.id, body });
    }
  }
  if (task.status === 'rejected') {
    task = move(ctx, emit, task, 'ready', 'system', { data: { attemptId: attempt.id, ladderStep: step } });
  }
  return { step, nextDispatchAt, task: getTask(ctx, task.id) };
}

/**
 * The ladder's vendor requirement for the task's next attempt (design 6.6 step 5, 6.9 steps 2 and 3): from its
 * counted attempts since the last re-plan, until it has been ready for vendorRequirementMs since its last attempt
 * ended. Null when any vendor will do.
 */
export function ladderRequirement(ctx: HubContext, taskId: string): LadderRequirement | null {
  return vendorRequirement(listAttempts(ctx, { task: taskId }), {
    ladderFloor: ladderFloor(ctx, taskId),
    now: ctx.now(),
    vendorRequirementMs: ctx.config.vendorRequirementMs,
  });
}

// ---------------------------------------------------------------------------
// Stop requests (design 6.4, 6.8 Replacement steps 1 and 2)
// ---------------------------------------------------------------------------

export interface StopRequestInput {
  attemptId: string;
  cause: StopCause;
  /** The text the agent is given, and a blocked task's reason. */
  reason: string;
  /** Who asked: user:<login>, agent:<id> or system. */
  by: string;
  /**
   * Held back while a submission is pending (design 6.13): recorded, with no move and nothing sent, unless the attempt
   * has no process, when it applies at once. A successful submission drops it. A failed one applies it by requesting
   * the same stop again without deferred, which replaces it (X-34), makes the move, sends it and starts its stop
   * timeout; flipping deferred alone would keep the old time, and expireStops would end the attempt at its next tick.
   */
  deferred?: boolean | undefined;
}

export interface StopRequestResult {
  attempt: Attempt;
  /** requested: recorded; replaced: it replaced a recorded stop; kept: a recorded stop stands; none: it had ended. */
  outcome: 'requested' | 'replaced' | 'kept' | 'none';
  /** The ending, when the attempt had no process and ended at once. */
  ending: Ending | null;
}

/** Whether the attempt has an agent process on its runner: holding attempts and live chats have none. */
export function hasLiveProcess(attempt: Pick<Attempt, 'runnerId' | 'status'>): boolean {
  return (
    attempt.runnerId !== null &&
    (attempt.status === 'starting' || attempt.status === 'running' || attempt.status === 'quota_wait')
  );
}

/** Causes a later request with an at-once move replaces (X-34). */
const REPLACEABLE: ReadonlySet<StopCause> = new Set<StopCause>([
  'stop',
  'replace',
  'stall_silent',
  'stall_hung_tool',
  'stall_loop',
  'stall_no_progress',
  'stall_budget',
]);

/** Whether the cause moves the task when it is requested; a take-over does, but never replaces another stop. */
const movesAtOnce = (cause: StopCause): boolean => ENDING_MOVES[cause].task?.when === 'at_once';

/** Whether a new request takes the place of the recorded one (design 6.4, A second stop request). */
function replaces(recorded: NonNullable<Attempt['stopRequested']>, cause: StopCause): boolean {
  if (recorded.cause === 'takeover') return false;
  if (recorded.deferred) return true;
  return cause !== 'takeover' && movesAtOnce(cause) && REPLACEABLE.has(recorded.cause);
}

/** The event a stop request makes, by what the attempt ends as. */
function stopEventType(cause: StopCause): string {
  const { endReason } = STOP_CAUSES[cause];
  if (endReason === 'stalled') return 'agent.stalled';
  return endReason === 'replaced' ? 'agent.replaced' : 'agent.stopped';
}

/**
 * Requests a stop (design 6.4, 6.8 steps 1 and 2). It records stop_requested, makes the cause's at-once move while
 * the task is claimed or working and names the attempt, keeping the holder fields (invariant e), and sends
 * stop_attempt with the cause's flags. The attempt ends when its runner reports the exit, or at the stop timeout
 * (invariant a); one with no live process ends at once. A take-over records its stop and moves the task, but its
 * prepare_takeover, which names the person, is the take-over's to send; it needs a live process, and only a lead is
 * rotated. A deferred request is only recorded (see StopRequestInput.deferred). A second request follows X-34.
 */
export function requestStop(ctx: HubContext, input: StopRequestInput): StopRequestResult {
  return tx(ctx, (emit): StopRequestResult => {
    const attempt = getAttempt(ctx, input.attemptId);
    if (attempt.status === 'ended') return { attempt, outcome: 'none', ending: null };
    if (input.cause === 'stop_hold' && attempt.role === 'lead') {
      throw conflict('a lead cannot be held; stop or replace it');
    }
    if (input.cause === 'rotation' && attempt.role !== 'lead') throw conflict('only a lead is rotated');
    // A take-over moves a running agent's work to a person (design 6.12); with no process there is nothing to take.
    if (input.cause === 'takeover' && !hasLiveProcess(attempt)) {
      throw new HubError(409, 'not_running', `attempt ${attempt.id} has no running agent to take over`);
    }
    const recorded = attempt.stopRequested;
    if (recorded && input.cause === 'takeover') {
      throw new HubError(409, 'not_running', `attempt ${attempt.id} is already stopping (${recorded.cause})`);
    }
    if (recorded && !replaces(recorded, input.cause)) return { attempt, outcome: 'kept', ending: null };
    const deferred = (input.deferred ?? false) && hasLiveProcess(attempt);
    updateAttempt(ctx, attempt.id, {
      stopRequested: {
        cause: input.cause,
        reason: input.reason,
        by: input.by,
        handoff: STOP_CAUSES[input.cause].handoff,
        deferred,
        at: ctx.now(),
      },
    });
    // A deferred stop may still be dropped, and a move made now could not be.
    if (!deferred) moveAtRequest(ctx, emit, attempt, input);
    const stopping = getAttempt(ctx, attempt.id);
    emit({
      type: stopEventType(input.cause),
      actor: input.by,
      subject: attemptSubject(stopping),
      data: { ...attemptData(stopping), cause: input.cause, reason: input.reason },
    });
    const outcome = recorded ? 'replaced' : 'requested';
    if (!hasLiveProcess(stopping)) {
      const ending = endAttempt(ctx, { attemptId: attempt.id, trigger: input.cause, actor: input.by });
      return { attempt: getAttempt(ctx, attempt.id), outcome, ending };
    }
    // The runner keys a stop on the fence, so only one that has not reached it yet can be replaced.
    if (recorded) cancelPendingOfKind(ctx, attempt.id, 'stop_attempt');
    if (!deferred && input.cause !== 'takeover') enqueueCommand(ctx, attempt.runnerId as string, stopCommand(stopping));
    return { attempt: stopping, outcome, ending: null };
  });
}

/**
 * The cause's at-once move: cancelled, or blocked with its kind and the request's reason. Its event is the one M1's
 * blockTask and cancelTask make for the same move, with the reason, so readers tell it from a dependency wait.
 */
function moveAtRequest(ctx: HubContext, emit: Emit, attempt: Attempt, input: StopRequestInput): void {
  if (attempt.taskId === null) return;
  const task = getTask(ctx, attempt.taskId);
  const planned = plannedTaskMove(input.cause, 'at_once', task, attempt.id);
  if (!planned) return;
  let current = task;
  for (const status of planned.path) {
    const changes = status === 'blocked' ? { blockedKind: planned.blockedKind, blockedReason: input.reason } : {};
    current = move(ctx, emit, current, status, input.by, {
      changes,
      event: input.cause === 'impossible' ? 'task.impossible' : undefined,
      data: { attemptId: attempt.id, reason: clip(input.reason, 500) },
    });
  }
}

/**
 * Ends every stop not completed within stopGraceMs with its requested reason (invariant d), each in its own
 * transaction; the runner stops the process at its next hello, through welcome.stop. Deferred stops wait for their
 * submission. Returns how many ended.
 */
export function expireStops(ctx: HubContext): number {
  const cutoff = ctx.now() - ctx.config.stopGraceMs;
  const due = listAttempts(ctx, { status: ['starting', 'running', 'quota_wait', 'holding'] }).filter(
    (attempt) => attempt.stopRequested && !attempt.stopRequested.deferred && attempt.stopRequested.at <= cutoff,
  );
  let ended = 0;
  for (const attempt of due) {
    try {
      const cause = (attempt.stopRequested as NonNullable<Attempt['stopRequested']>).cause;
      if (endAttempt(ctx, { attemptId: attempt.id, trigger: cause })) ended += 1;
    } catch (error) {
      console.error(`ending attempt ${attempt.id} at its stop timeout failed`, error);
    }
  }
  return ended;
}

// ---------------------------------------------------------------------------
// Attempt events (design 6.3): spawned, failed to start, activity and first output
// ---------------------------------------------------------------------------

/** Consecutive failed starts of one vendor on one runner, refusals excluded, that mark it not ready (design 6.9). */
const FAILED_STARTS_LIMIT = 2;

/** A restatement is a few lines; a first output longer than a progress note is cut to one. */
const RESTATEMENT_LIMIT = 4000;

const byRunner = (attempt: Attempt): string => `runner:${attempt.runnerId ?? 'unknown'}`;

/**
 * attempt.spawned: the agent's session is live, for a new session or a resumed one. A starting attempt goes to
 * running; its session, model and start commit are recorded, and so is its agent's session id; the run of failed starts
 * of its vendor on the runner ends. A start commit that differs from the recorded one is work pushed before the
 * attempt's fence that the hub had not heard of: it is logged, and the attempt goes on (design 7.3).
 */
export function onSpawned(
  ctx: HubContext,
  emit: Emit,
  attempt: Attempt,
  data: RunnerEventData['attempt.spawned'],
): void {
  const recorded = attempt.startSha;
  if (data.startSha !== null && recorded !== null && data.startSha !== recorded) {
    appendAttemptLog(
      ctx,
      attempt.id,
      'note',
      `started from ${data.startSha}, not the recorded ${recorded}: work pushed before its fence`,
    );
  }
  const starting = attempt.status === 'starting';
  updateAttempt(ctx, attempt.id, {
    status: starting ? 'running' : undefined,
    sessionRef: data.sessionRef,
    model: data.model,
    startSha: data.startSha ?? undefined,
    lastActivityAt: ctx.now(),
  });
  // A session id another agent holds stays theirs: the unique index would refuse it, and the event with it.
  ctx.db
    .query(
      `UPDATE agents SET session_id = $sessionId WHERE id = $agentId AND NOT EXISTS (
         SELECT 1 FROM agents WHERE vendor = $vendor AND session_id = $sessionId AND id != $agentId)`,
    )
    .run({ sessionId: data.sessionRef, agentId: attempt.agentId, vendor: attempt.vendor });
  if (attempt.runnerId !== null) resetFailedStarts(ctx, attempt.runnerId, attempt.vendor);
  if (starting) {
    emit({ type: 'attempt.running', actor: byRunner(attempt), subject: attemptSubject(attempt), data: attemptData(attempt) });
  }
}

/**
 * attempt.failed_to_start: the start or resume never got a live session, and the attempt ends failed_to_start. A
 * failure is infra, with the backoff and a failure signature, and the second in a row of its vendor on the runner marks
 * the vendor not ready there and asks for a preflight. A refusal (refused set) has no class: no backoff, no signature,
 * no count; it shows on the runner's card and keeps placement off the runner until its next heartbeat (X-3). Either way
 * the task goes back to ready under the conditional moves.
 */
export function onFailedToStart(
  ctx: HubContext,
  attempt: Attempt,
  data: RunnerEventData['attempt.failed_to_start'],
): Ending | null {
  const runnerId = attempt.runnerId as string;
  const actor = byRunner(attempt);
  if (data.refused !== null) {
    appendAttemptLog(ctx, attempt.id, 'note', `the runner refused the start (${data.refused}): ${data.error}`);
    recordStartRefusal(ctx, runnerId, data.refused);
    return endAttempt(ctx, { attemptId: attempt.id, trigger: 'refused_start', error: data.error, actor });
  }
  appendAttemptLog(ctx, attempt.id, 'note', `failed to start: ${data.error}`);
  const ending = endAttempt(ctx, { attemptId: attempt.id, trigger: 'failed_to_start', error: data.error, actor });
  if (recordFailedStart(ctx, runnerId, attempt.vendor) >= FAILED_STARTS_LIMIT) {
    markVendorNotReady(ctx, runnerId, attempt.vendor);
  }
  return ending;
}

/** attempt.activity: an entry in the attempt's log and its last activity; a compaction also keeps its summary. */
export function onActivity(ctx: HubContext, attempt: Attempt, data: RunnerEventData['attempt.activity']): void {
  appendAttemptLog(ctx, attempt.id, data.kind, data.summary);
  updateAttempt(ctx, attempt.id, {
    lastActivityAt: ctx.now(),
    compactionSummary: data.kind === 'compaction' ? data.summary : undefined,
  });
}

/**
 * attempt.first_output: a successor's restatement of the state and its next step (design 6.8), kept with its attempt
 * id as a restatement note on the task, or for a lead in lead_notes. It is stored as the agent wrote it, under the
 * agent's name, so every reader quotes it. A first attempt has nothing to restate: its first output is only logged.
 */
export function onFirstOutput(ctx: HubContext, attempt: Attempt, data: RunnerEventData['attempt.first_output']): void {
  const text = clip(data.text, RESTATEMENT_LIMIT);
  if (!isSuccessor(attempt)) {
    appendAttemptLog(ctx, attempt.id, 'text', text);
    return;
  }
  const author = `agent:${attempt.agentId}`;
  if (attempt.taskId === null) insertLeadNote(ctx, { attemptId: attempt.id, kind: 'restatement', body: text, author });
  else addNote(ctx, attempt.taskId, 'restatement', text, author, attempt.id);
}

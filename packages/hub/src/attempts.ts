// Runner attempts (design 6.4): the one transaction that starts one, the AttemptSpec its start_attempt carries, the
// re-fence that resumes one, stop requests and their timeout, endAttempt, the one path every ending takes, the retry
// ladder that follows an ending (design 6.9), what the attempt events a runner reports do (design 6.3), and runner
// leases with the heartbeat facts that renew them (design 6.4, 6.8).
import {
  type Agent,
  type AgentRole,
  type Attempt,
  type AttemptFacts,
  type AttemptSpec,
  type AttemptStatus,
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
  compareFence,
  computeToolCaps,
  countedAttempts,
  endingClass,
  failureSignature,
  formatFence,
  freeSlots,
  infraBackoffMs,
  isTaskBranch,
  ladderStep,
  leadAttemptId,
  localPinRefs,
  plannedTaskMove,
  quoteLines,
  restoreSet,
  signatureApplies,
  taskBranchName,
  usableVendors,
  vendorRequirement,
  wipRef,
} from '@agflow/core';
import { getAgent } from './agents';
import { voidApprovals } from './approvals';
import {
  type ResumeLogEntry,
  appendAttemptLog,
  attemptSubject,
  findAttempt,
  getAttempt,
  insertAttempt,
  isUnpushed,
  issueFence,
  listAttempts,
  nextAttemptNumber,
  openAttemptOf,
  positionIsOwn,
  unpushedHead,
  updateAttempt,
} from './attempt-store';
import { revokeAgentTokens } from './auth';
import { buildBrief, composeTaskPack, firstPrompt, isSuccessor } from './brief';
import {
  type CommandRow,
  type StoredCommand,
  cancelPendingCommands,
  cancelPendingDeliveries,
  cancelPendingOfKind,
  enqueueCommand,
  pendingResumeOf,
} from './commands';
import { type HubContext, tx } from './context';
import { nextId } from './db';
import { deliverBacklog, messagesInFlight, retargetDeliveries, settleDeliveriesOnEnd } from './delivery';
import { HubError, badRequest, conflict, notFound } from './errors';
import type { Emit } from './events';
import { assembleHandoffNote, handoffWritten } from './handoff';
import { emptySeat, insertLeadNote, seatHolderId, takeSeat } from './hub-state';
import { insertMessage } from './messages';
import { placementSnapshot } from './placement';
import { getProject } from './project';
import { recordQuotaReports } from './quota';
import {
  findRunnerRow,
  markGitNotReady,
  markGitPushed,
  markVendorNotReady,
  recordFailedStart,
  recordStartRefusal,
  resetFailedStarts,
} from './runners';
import { failPendingSubmission, pendingSubmissionOf } from './submission-store';
import {
  addNote,
  findTask,
  getTask,
  move,
  overlappingPathHolder,
  setAgentTask,
  writeTask,
} from './task-store';
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
 * every lead attempt. When the previous attempt's final push failed and its harvested head is still the newest work, a
 * successor on that attempt's runner starts from the head its vault pins (design 6.8, Replacement step 4); the task's
 * work position stays the last pushed ref, which a successor elsewhere starts from. The runner fetches the ref and
 * reports the commit it actually used.
 */
export function startPositionFor(
  ctx: HubContext,
  task: Task | null,
  runnerId: string | null = null,
): AttemptSpec['start'] {
  const unpushed = task && runnerId !== null ? unpushedWork(ctx, task) : null;
  if (unpushed && unpushed.runnerId === runnerId) {
    return { ref: localPinRefs(unpushed.attemptId).head, sha: unpushed.sha };
  }
  if (task?.workRef) return { ref: task.workRef, sha: task.workSha };
  return { ref: restoreBase(ctx), sha: null };
}

/**
 * The task's newest attempt's unpushed head, while that attempt has ended on a runner (unpushedHead); null otherwise.
 * Its runner's late work would make it the work position.
 */
function unpushedWork(ctx: HubContext, task: Task): { attemptId: string; runnerId: string; sha: string } | null {
  const [last] = listAttempts(ctx, { task: task.id, limit: 1 });
  if (!last || last.status !== 'ended') return null;
  const unpushed = unpushedHead(ctx, task, last);
  return unpushed && { attemptId: last.id, ...unpushed };
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
    const start = startPositionFor(ctx, task, runner.id);
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
// Live-chat attempts (design 6.4, Live-chat attempts): M1's operations move the task, and the attempt follows
// ---------------------------------------------------------------------------

/** The task's current attempt while it is open in a live chat, or null; a claim made before M2 has none. */
export function openLiveAttempt(ctx: HubContext, task: Pick<Task, 'currentAttempt'>): Attempt | null {
  const attempt = task.currentAttempt === null ? null : findAttempt(ctx, task.currentAttempt);
  return attempt && attempt.status !== 'ended' && attempt.runnerId === null ? attempt : null;
}

/**
 * A live claim's attempt, in the claim's transaction (design 6.4): running at once, with a fence, from the task's
 * work position, and with no runner and no runner lease: the task's M1 lease stays authoritative for it. It becomes
 * the task's current attempt; it is never on the ladder and takes no worker slot.
 */
export function startLiveAttempt(ctx: HubContext, emit: Emit, task: Task, agent: Agent): Attempt {
  const number = nextAttemptNumber(ctx, task.id);
  const fence = issueFence(ctx);
  const start = startPositionFor(ctx, task);
  const attempt = insertAttempt(ctx, {
    id: attemptId(task.id, number, fence.epoch),
    taskId: task.id,
    number,
    // An attempt at a task is a worker's, whoever holds the seat.
    role: 'worker',
    agentId: agent.id,
    runnerId: null,
    vendor: agent.vendor,
    fence,
    status: 'running',
    startRef: start.ref,
    startSha: start.sha,
  });
  emit({
    type: 'attempt.started',
    actor: `agent:${agent.id}`,
    subject: attemptSubject(attempt),
    data: { ...attemptData(attempt), vendor: attempt.vendor, role: attempt.role },
  });
  return attempt;
}

/**
 * Ends the task's open live attempt as the live-chat table says, after M1's operation moved the task: release,
 * block, a forced release (stop), the lease sweep (lost), cancel, accept, a rejection not returned to its author, or a
 * resume_claim (superseded). Null when the task has none.
 */
export function endLiveAttempt(
  ctx: HubContext,
  task: Pick<Task, 'currentAttempt'>,
  trigger: EndingTrigger,
  actor: string,
): Ending | null {
  const attempt = openLiveAttempt(ctx, task);
  return attempt ? endAttempt(ctx, { attemptId: attempt.id, trigger, actor }) : null;
}

/** A live submit: the attempt holds while its work is reviewed. */
export function holdLiveAttempt(ctx: HubContext, emit: Emit, task: Pick<Task, 'currentAttempt'>, actor: string): void {
  const attempt = openLiveAttempt(ctx, task);
  if (!attempt) return;
  updateAttempt(ctx, attempt.id, { status: 'holding' });
  emit({
    type: 'attempt.holding',
    actor,
    subject: attemptSubject(attempt),
    data: { ...attemptData(attempt), submissionId: null },
  });
}

/** A rejection M1 returned to its live author: the attempt runs again, at a new fence. */
export function refenceLiveAttempt(
  ctx: HubContext,
  emit: Emit,
  task: Pick<Task, 'currentAttempt'>,
  actor: string,
): void {
  const attempt = openLiveAttempt(ctx, task);
  if (!attempt) return;
  const fence = issueFence(ctx);
  updateAttempt(ctx, attempt.id, { status: 'running', fence });
  emit({
    type: 'attempt.resumed',
    actor,
    subject: attemptSubject(attempt),
    data: { ...attemptData(attempt), fence, reason: RESUME_CAUSES.review },
  });
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

/**
 * The resumes resume_log keeps, which end an attempt when they repeat within their window (design 6.3). A lead's
 * exits are logged when they happen (onExited), not when the lead is resumed, which may be much later.
 */
const isLogged = (cause: ResumeCause): cause is ResumeLogEntry['cause'] => cause === 'runner_restart';

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

/** The log with an entry of this cause added now, keeping only entries a window can still count. */
function withLogEntry(ctx: HubContext, attemptId: string, cause: ResumeLogEntry['cause']): ResumeLogEntry[] {
  const now = ctx.now();
  const kept = Math.max(ctx.config.resumeWindowMs, ctx.config.leadExitWindowMs);
  return [...resumeLog(ctx, attemptId).filter((entry) => entry.at > now - kept), { at: now, cause }];
}

/** The log with this resume added, for a resume it keeps. */
const loggedResume = (ctx: HubContext, attemptId: string, cause: ResumeCause): ResumeLogEntry[] | undefined =>
  isLogged(cause) ? withLogEntry(ctx, attemptId, cause) : undefined;

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
 * starting with a fresh runner lease, its tokens are revoked and its pending approvals voided, its old fence's
 * commands cancelled (a pending resume's prompt and messages carried into this one, with the messages in flight), the
 * cause logged, and resume_attempt queued with a recomputed task pack, restore set and acceptance ids; the rows of the
 * messages it carries name it.
 * A push owed to a pending submission and a recorded stop are queued again at the new fence, after the resume, so the
 * re-fence drops neither, and the stop's grace starts again. A deferred stop stays held back. A take-over in flight
 * is the take-over's to finish, so it cannot be resumed.
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
    // Read before the cancel frees their rows: the resume carries them to the new fence (design 6.7, Backlog).
    const inFlight = messagesInFlight(ctx, before.id);
    const cancelled = cancelPendingCommands(ctx, before.id);
    revokeAgentTokens(ctx, before.id);
    voidApprovals(ctx, emit, before.id, input.actor);
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
    const { prompt, messages } = carriedOver(pending, { ...input, messages: [...inFlight, ...(input.messages ?? [])] });
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
    retargetDeliveries(ctx, attempt.id, command.id, messages);
    // A push still owed to a pending submission goes again at the new fence: nothing else would push it. A runner that
    // already had it maps it to its first run by the submission id (design 6.13).
    const submission = pendingSubmissionOf(ctx, attempt.id);
    for (const row of cancelled) {
      if (row.command.kind === 'push_submission' && row.command.submissionId === submission?.id) {
        enqueueCommand(ctx, attempt.runnerId as string, { ...row.command, fence });
      }
    }
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
 * its own. It sets the end reason, class and failure signature from the trigger's row, revokes the tokens, voids
 * the pending approvals, fails a pending submission (design 6.13), cancels the pending commands (cleanup, transcript
 * uploads and hand-backs stay) and queues cleanup_attempt, except for a take-over, whose cleanup follows its
 * hand-back. It clears the holder fields (invariant e) and makes the row's on-exit move, only while the task is
 * claimed or working and names this attempt (X-34); a stop held back for the submission makes its at-once move first.
 * It stores an assembled handoff note, with the attempt's id, when the row asks and the agent wrote none, and empties
 * the seat its lead held. A runner attempt's deliveries are settled (settleDeliveriesOnEnd) before its pending
 * commands are cancelled. A live chat's attempt only ends: M1's operations move its task. Null when the attempt had
 * already ended.
 */
export function endAttempt(ctx: HubContext, input: EndAttemptInput): Ending | null {
  return tx(ctx, (emit) => {
    const row = ENDING_MOVES[input.trigger];
    if (row.endReason === null) throw new Error(`${input.trigger} does not end an attempt`);
    const before = getAttempt(ctx, input.attemptId);
    if (before.status === 'ended') return null;
    const actor = input.actor ?? 'system';
    const failureClass = endingClass(input.trigger);
    // A requested stop names what failed by its cause: a quota, a vendor-error and a context replacement all end
    // replaced, and must not read as one repeated failure (design 6.9).
    const stop = before.stopRequested;
    const error = input.error ?? (stop?.cause === input.trigger ? stop.cause : null);
    updateAttempt(ctx, before.id, {
      status: 'ended',
      endReason: row.endReason,
      failureClass,
      failureSignature: signatureApplies(input.trigger) ? failureSignature(row.endReason, error) : null,
      leaseExpiresAt: null,
      endedAt: ctx.now(),
    });
    revokeAgentTokens(ctx, before.id);
    voidApprovals(ctx, emit, before.id, actor);
    const attempt = getAttempt(ctx, before.id);
    failPendingSubmission(ctx, emit, attempt, actor);
    let task = attempt.taskId === null ? null : getTask(ctx, attempt.taskId);
    let moved: TaskStatus[] = [];
    let noteAdded = false;
    let ladder: LadderOutcome | null = null;
    if (attempt.runnerId !== null) {
      settleDeliveriesOnEnd(ctx, emit, attempt);
      cancelPendingCommands(ctx, attempt.id);
      if (row.endReason !== 'taken_over') {
        enqueueCommand(ctx, attempt.runnerId, { kind: 'cleanup_attempt', attemptId: attempt.id });
      }
      setAgentTask(ctx, attempt.agentId, null);
      if (task) {
        // A stop held back for the submission applies with the ending that fails it (design 6.13): a stop and hold
        // pauses the task whatever ended the attempt.
        const held = stop?.deferred ? moveAtRequest(ctx, emit, attempt, { ...stop, attemptId: attempt.id }) : [];
        if (held.length > 0) task = getTask(ctx, task.id);
        ({ task, moved } = moveOnEnd(ctx, emit, task, attempt, input.trigger, actor));
        moved = [...held, ...moved];
        if (moved[0] === 'stale') tellLeadStale(ctx, emit, task, attempt);
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

/**
 * A task that went stale wakes the lead, as M1's lease sweep does (design 6.11). Only hub-known fields are named, so
 * nothing an agent wrote is unquoted.
 */
function tellLeadStale(ctx: HubContext, emit: Emit, task: Task, attempt: Attempt): void {
  insertMessage(ctx, emit, {
    from: 'system',
    to: 'lead',
    taskId: task.id,
    body:
      `${named(task)} went stale: its runner attempt ${attempt.id} on ${attempt.runnerId ?? 'unknown'} was lost (no ` +
      'heartbeat for the runner lease). It is ready again.',
  });
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
// Rejecting a runner submission (design 6.4 rejected rows, 6.9 step 1)
// ---------------------------------------------------------------------------

/**
 * Whether a rejection can go back to its author (design 6.9, step 1): the author's attempt is holding and resumable, on
 * an online runner with a free slot where its vendor is usable, by core's freeSlots and usableVendors over the
 * placement snapshot (X-46), and no other task holds paths that overlap the task's. Review rounds are the ladder's.
 */
export function authorCanResume(ctx: HubContext, task: Task, attempt: Attempt): boolean {
  if (attempt.status !== 'holding' || !attempt.resumable || attempt.runnerId === null) return false;
  const snapshot = placementSnapshot(ctx);
  const runner = snapshot.runners.find((slot) => slot.id === attempt.runnerId);
  if (!runner || runner.state !== 'online' || freeSlots(runner) < 1) return false;
  if (!usableVendors(snapshot, runner).usable.some(({ slot }) => slot.vendor === attempt.vendor)) return false;
  return overlappingPathHolder(ctx, task) === null;
}

export interface RejectionInput {
  /** Who rejected it: the lead or a person. */
  actor: string;
  feedback: string;
}

/**
 * A rejection of a runner attempt's submission, in the transaction that moved the task to rejected with its feedback
 * (design 6.9). At ladder step 1 the task goes back to claimed for its author (current_attempt unchanged), the attempt
 * gets one more review round and resumes at a new fence with the quoted feedback as its prompt. Otherwise the attempt
 * ends rejected (review) and the ladder moves the task on. Returns the task afterwards.
 */
export function rejectRunnerAttempt(
  ctx: HubContext,
  emit: Emit,
  task: Task,
  attempt: Attempt,
  input: RejectionInput,
): Task {
  const step = ladderStep({
    counted: 0,
    ladderFloor: ladderFloor(ctx, task.id),
    maxAttempts: ctx.config.maxAttempts,
    rejection: { authorCanResume: authorCanResume(ctx, task, attempt), reviewRounds: attempt.reviewRounds },
  });
  if (step !== 1) {
    const ending = endAttempt(ctx, { attemptId: attempt.id, trigger: 'rejected', actor: input.actor });
    if (!ending) return getTask(ctx, task.id);
    return applyLadder(ctx, emit, { task: getTask(ctx, task.id), attempt: ending.attempt, trigger: 'rejected' }).task;
  }
  move(ctx, emit, task, 'claimed', 'system', {
    changes: { assignee: attempt.agentId, leaseExpiresAt: null },
    event: 'task.returned',
    data: { to: attempt.agentId, attemptId: attempt.id, ladderStep: 1 },
  });
  setAgentTask(ctx, attempt.agentId, task.id);
  updateAttempt(ctx, attempt.id, { reviewRounds: attempt.reviewRounds + 1 });
  resumeAttempt(ctx, {
    attemptId: attempt.id,
    cause: 'review',
    prompt:
      `${task.id} was rejected and is back with you. Address the review feedback below, then submit again.\n` +
      `[agflow review feedback from ${input.actor}]\n${quoteLines(input.feedback)}`,
    actor: input.actor,
  });
  return getTask(ctx, task.id);
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
   * Left out, a stop, a stop and hold or a replace is held back while the attempt has a submission pending.
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

/**
 * The task's current attempt while it is open on a runner, or null. M1's operations on such a task take the stop flow
 * (design 6.4, M1 operations on runner-held tasks).
 */
export function openRunnerAttempt(ctx: HubContext, task: Pick<Task, 'currentAttempt'>): Attempt | null {
  const attempt = task.currentAttempt === null ? null : findAttempt(ctx, task.currentAttempt);
  return attempt && attempt.status !== 'ended' && attempt.runnerId !== null ? attempt : null;
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

/** The causes held back while a submission is pending: a person's or the lead's stop or replace (design 6.13). */
const DEFERRABLE: ReadonlySet<StopCause> = new Set<StopCause>(['stop', 'stop_hold', 'replace']);

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
 * Requests a stop (design 6.4, 6.8 steps 1 and 2). It records stop_requested, makes the cause's at-once move while the
 * task is claimed or working and names the attempt, keeping the holder fields (invariant e), voids the approvals
 * pending then (design 6.10), and sends stop_attempt with the cause's flags. The attempt ends when its runner reports
 * the exit, or at the stop timeout (invariant a); one with no live process ends at once. A take-over records its stop
 * and moves the task, but its prepare_takeover, which names the person, is the take-over's to send; it needs a live
 * process, and only a lead is rotated. A deferred request is only recorded (see StopRequestInput.deferred). A second
 * request follows X-34.
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
    const held = input.deferred ?? (DEFERRABLE.has(input.cause) && pendingSubmissionOf(ctx, attempt.id) !== null);
    const deferred = held && hasLiveProcess(attempt);
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
    // From stop_requested on nothing more is pushed to the attempt, and a deliver still pending would be (design 6.7).
    cancelPendingDeliveries(ctx, attempt.id);
    // A deferred stop may still be dropped, and a move made now could not be, nor approvals voided now be answered.
    if (!deferred) {
      moveAtRequest(ctx, emit, attempt, input);
      voidApprovals(ctx, emit, attempt.id, input.by);
    }
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
 * The cause's at-once move, and the statuses it passed through: cancelled, or blocked with its kind and the request's
 * reason. Its event is the one M1's blockTask and cancelTask make for the same move, with the reason, so readers tell
 * it from a dependency wait.
 */
function moveAtRequest(ctx: HubContext, emit: Emit, attempt: Attempt, input: StopRequestInput): TaskStatus[] {
  if (attempt.taskId === null) return [];
  const task = getTask(ctx, attempt.taskId);
  const planned = plannedTaskMove(input.cause, 'at_once', task, attempt.id);
  if (!planned) return [];
  let current = task;
  for (const status of planned.path) {
    const changes = status === 'blocked' ? { blockedKind: planned.blockedKind, blockedReason: input.reason } : {};
    current = move(ctx, emit, current, status, input.by, {
      changes,
      event: input.cause === 'impossible' ? 'task.impossible' : undefined,
      data: { attemptId: attempt.id, reason: clip(input.reason, 500) },
    });
  }
  return [...planned.path];
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
    // Messages for a starting attempt waited for its session (design 6.7, Pushing).
    deliverBacklog(ctx, getAttempt(ctx, attempt.id));
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

// ---------------------------------------------------------------------------
// WIP, the final push and violations (design 6.3, 6.4 Work position, 6.8 Replacement step 4, 7.3)
// ---------------------------------------------------------------------------

/** Consecutive failed WIP pushes of a runner, over all its attempts, that mark its git not ready (X-3). */
const WIP_FAILURES_LIMIT = 3;

/** What the runner did about protected paths in each phase (design 7.3). */
const VIOLATION_TEXT: Readonly<Record<RunnerEventData['attempt.violation']['phase'], string>> = {
  start: 'its start commit changed these protected paths; the runner restored them and strips them from its pushes',
  wip: 'it changed these protected paths; the runner stripped them from what it pushed',
  submit: 'its submission touched protected paths or another branch; the runner refused it',
  takeover: "its clone's git held config, hooks or links the runner does not allow; it moved them aside",
};

/** The attempt's pushed WIP, and the task's work position while the task names the attempt (design 6.4). */
function recordWip(ctx: HubContext, attempt: Attempt, ref: string, sha: string): void {
  updateAttempt(ctx, attempt.id, { wipRef: ref, wipSha: sha });
  if (attempt.taskId === null) return;
  const task = getTask(ctx, attempt.taskId);
  if (task.currentAttempt === attempt.id) writeTask(ctx, task.id, { workRef: ref, workSha: sha });
}

/**
 * attempt.wip of the current attempt: its WIP and the task's work position, and the attempt.wip event with what the
 * push left out and its git log --stat, which assembled handoff notes quote (X-3). The runner's git pushed, so it is
 * ready again.
 */
export function onWip(ctx: HubContext, emit: Emit, attempt: Attempt, data: RunnerEventData['attempt.wip']): void {
  recordWip(ctx, attempt, data.ref, data.sha);
  if (attempt.runnerId !== null) markGitPushed(ctx, attempt.runnerId);
  emit({
    type: 'attempt.wip',
    actor: byRunner(attempt),
    subject: attemptSubject(attempt),
    data: { ...attemptData(attempt), ...data },
  });
}

/**
 * attempt.wip_failed: logged on the attempt. The event carries the runner's own count of failed pushes in a row, over
 * all its attempts; from the third the runner's git is not ready, until a push goes through, late work included, or a
 * hello with git.ready (X-3).
 */
export function onWipFailed(ctx: HubContext, attempt: Attempt, data: RunnerEventData['attempt.wip_failed']): void {
  const inRow = `${data.failures} in a row on the runner`;
  appendAttemptLog(ctx, attempt.id, 'note', `a WIP push failed (${inRow}): ${data.error}`);
  if (data.failures >= WIP_FAILURES_LIMIT && attempt.runnerId !== null) {
    markGitNotReady(ctx, attempt.runnerId, `the last ${data.failures} WIP pushes failed: ${clip(data.error, 300)}`);
  }
}

/**
 * attempt.violation, of a current or an ended attempt: logged, emitted, and told to people and the lead. The paths
 * name files in the agent's clone, so they are quoted.
 */
export function onViolation(
  ctx: HubContext,
  emit: Emit,
  attempt: Attempt,
  data: RunnerEventData['attempt.violation'],
): void {
  const paths = clip(data.paths.join('\n'), 2_000);
  appendAttemptLog(ctx, attempt.id, 'violation', `${data.phase}: ${paths}`);
  emit({
    type: 'attempt.violation',
    actor: byRunner(attempt),
    subject: attemptSubject(attempt),
    data: { ...attemptData(attempt), phase: data.phase, paths: data.paths },
  });
  const about = attempt.taskId === null ? 'the lead' : attempt.taskId;
  const body =
    `Attempt ${attempt.id} at ${about} (agent ${attempt.agentId} on runner ${attempt.runnerId ?? 'none'}): ` +
    `${VIOLATION_TEXT[data.phase]}:\n${quoteLines(paths)}\n` +
    'Runner agents never change these paths. If the task needs them changed, a person should do it.';
  for (const to of ['humans', 'lead']) insertMessage(ctx, emit, { from: 'system', to, taskId: attempt.taskId, body });
}

/**
 * A final push that failed (design 6.8, Replacement step 4): the harvested head is only in the runner's vault. While
 * the task names the attempt, dispatch waits dispatchHoldMs for that runner's late work, and a note with the attempt's
 * id names the commit, for a successor on another runner, which starts from the last pushed position without it.
 */
function holdForUnpushed(ctx: HubContext, attempt: Attempt, data: RunnerEventData['attempt.exited']): void {
  const sha = data.finalSha;
  if (attempt.taskId === null || !isUnpushed(sha, attempt)) return;
  appendAttemptLog(ctx, attempt.id, 'note', `the final push of ${sha} failed: ${data.pushError ?? 'no error given'}`);
  const task = getTask(ctx, attempt.taskId);
  // Late work of the same push may have landed first.
  if (task.currentAttempt !== attempt.id || task.workSha === sha) return;
  writeTask(ctx, task.id, { dispatchHoldUntil: ctx.now() + ctx.config.dispatchHoldMs });
  const runner = attempt.runnerId as string;
  const position = task.workRef ? `${task.workRef} at ${task.workSha ?? 'its tip'}` : ctx.config.mainBranch;
  addNote(
    ctx,
    task.id,
    'late_work',
    `The final push of ${attempt.id} failed, so its last commit, ${sha}, is only on runner ${runner}. A successor ` +
      `on ${runner} starts from that commit; one on another runner starts from ${position}, without it. Once ` +
      `${runner} pushes the commit, agflow records it as late work.`,
    'system',
    attempt.id,
  );
}

// ---------------------------------------------------------------------------
// Late work (design 6.3 stale events, 6.4 Work position, 7.3 Late work)
// ---------------------------------------------------------------------------

/** Work a runner pushed after the hub ended its attempt, or for an attempt the hub does not know. */
export interface LateWork {
  attemptId: string;
  taskId: string;
  ref: string;
  sha: string;
  /** The runner that pushed it. */
  runnerId: string;
}

/** attempt.late_work of a pushed ref, which keeps the ref, at its sha, for its cleanup (design 6.18). */
function emitLateWork(emit: Emit, attempt: Attempt | null, work: LateWork): void {
  emit({
    type: 'attempt.late_work',
    actor: `runner:${work.runnerId}`,
    subject: work.taskId,
    data: {
      attemptId: work.attemptId,
      taskId: work.taskId,
      agentId: attempt?.agentId ?? null,
      runnerId: work.runnerId,
      ref: work.ref,
      sha: work.sha,
    },
  });
}

/**
 * A push of the attempt's recorded submission head after it ended (a person accepted it before the runner reported
 * its final WIP, say): no late work, as its submission put that commit on the task branch, so no late_work note, no
 * message to a holder and no change of the work position; it is logged on the attempt. Pushed to the attempt's WIP
 * ref, it is the attempt's WIP sha, which the ref's cleanup expects there; to another ref, a late-work or hand-back
 * one, attempt.late_work still records that ref, so its cleanup deletes it too.
 */
function recordSubmittedHeadPush(ctx: HubContext, emit: Emit, attempt: Attempt, work: LateWork): void {
  if (work.ref === attempt.wipRef) updateAttempt(ctx, attempt.id, { wipSha: work.sha });
  else emitLateWork(emit, attempt, work);
  const pushed = `runner ${work.runnerId} pushed the submitted head ${work.sha} to ${work.ref}`;
  appendAttemptLog(ctx, attempt.id, 'note', `${pushed}: it is on the task branch, not late work`);
}

/**
 * Records late work (design 6.4). It becomes the task's work position only while the task has no open attempt and
 * its position is still the late attempt's own (positionIsOwn), which also ends a dispatch hold waiting for it.
 * Otherwise a late_work note with the attempt's id names the ref for the next attempt to merge, and a holder, the
 * task's open attempt, is told how to merge it, after refresh_vault brings the ref to its runner's vault (design
 * 7.3). Late work for a task the hub does not have goes to people. attempt.late_work keeps the ref for its cleanup.
 * The attempt's recorded submission head is no late work (recordSubmittedHeadPush).
 */
export function recordLateWork(ctx: HubContext, emit: Emit, attempt: Attempt | null, work: LateWork): void {
  if (attempt !== null && work.sha === attempt.submittedSha) {
    recordSubmittedHeadPush(ctx, emit, attempt, work);
    return;
  }
  emitLateWork(emit, attempt, work);
  const pushed = `runner ${work.runnerId} pushed ${work.sha} to ${work.ref}`;
  const task = findTask(ctx, work.taskId);
  if (!task) {
    insertMessage(ctx, emit, {
      from: 'system',
      to: 'humans',
      taskId: null,
      body:
        `Late work of attempt ${work.attemptId}: ${pushed}, but this hub has no task ${work.taskId}. Look at the ref ` +
        'and keep what is worth keeping.',
    });
    return;
  }
  const holder = openAttemptOf(ctx, task.id);
  if (attempt && holder === null && positionIsOwn(task, attempt)) {
    writeTask(ctx, task.id, { workRef: work.ref, workSha: work.sha, dispatchHoldUntil: null });
    appendAttemptLog(ctx, attempt.id, 'note', `late work became the work position: ${work.ref} at ${work.sha}`);
    return;
  }
  const merge = `git fetch origin ${work.ref} && git merge FETCH_HEAD`;
  addNote(
    ctx,
    task.id,
    'late_work',
    `Late work of attempt ${work.attemptId}: ${pushed} after the attempt ended. Merge it before going on: ${merge}`,
    'system',
    work.attemptId,
  );
  if (!holder) return;
  if (holder.runnerId !== null) {
    enqueueCommand(ctx, holder.runnerId, { kind: 'refresh_vault', taskId: task.id, refs: [work.ref] });
  }
  insertMessage(ctx, emit, {
    from: 'system',
    to: `agent:${holder.agentId}`,
    taskId: task.id,
    body:
      `Late work for ${task.id}: attempt ${work.attemptId} pushed ${work.sha} to ${work.ref} after it ended. Merge ` +
      `it into your branch before you go on: ${merge}`,
  });
}

/**
 * attempt.late_work, of an ended attempt or one the hub does not know: late work. One of an open attempt at its
 * fence, a final push that went to a late-work ref, is the attempt's own (invariant a): its task's work position,
 * while the task names it. Either way the push went through, so the runner's git is ready again (X-3).
 */
export function onLateWork(
  ctx: HubContext,
  emit: Emit,
  runnerId: string,
  attempt: Attempt | null,
  event: { attemptId: string; data: RunnerEventData['attempt.late_work'] },
): void {
  const { taskId, ref, sha } = event.data;
  markGitPushed(ctx, runnerId);
  if (attempt && attempt.status !== 'ended') {
    const task = getTask(ctx, taskId);
    if (task.currentAttempt === attempt.id) writeTask(ctx, task.id, { workRef: ref, workSha: sha });
    emit({
      type: 'attempt.late_work',
      actor: byRunner(attempt),
      subject: attemptSubject(attempt),
      data: { ...attemptData(attempt), ref, sha },
    });
    return;
  }
  recordLateWork(ctx, emit, attempt, { attemptId: event.attemptId, taskId, ref, sha, runnerId });
}

// ---------------------------------------------------------------------------
// Process exits (design 6.4 exit rows, invariant c; 6.11 Process exits)
// ---------------------------------------------------------------------------

/** Unrequested lead exits within leadExitWindowMs: the one that reaches this count ends the attempt crashed. */
const LEAD_EXITS_LIMIT = 3;

/** How the process went, as the error of an unrequested exit's failure signature. */
function exitError(data: RunnerEventData['attempt.exited']): string {
  if (data.signal !== null) return `the agent was killed by ${data.signal}`;
  return data.code === null ? 'the agent exited' : `the agent exited with code ${data.code}`;
}

/**
 * Whether a lead was in a turn when its process exited (X-35): its last reported phase was turn, or a message
 * delivered to it is still unacknowledged. Such a lead resumes at once with its unacknowledged deliveries; an idle one
 * waits for its next delivery (design 6.11).
 */
export function exitedInTurn(ctx: HubContext, attempt: Attempt): boolean {
  if (attempt.phase === 'turn') return true;
  return (
    ctx.db.query('SELECT 1 FROM deliveries WHERE agent_id = $agentId AND acked_at IS NULL LIMIT 1').get({
      agentId: attempt.agentId,
    }) !== null
  );
}

/**
 * attempt.exited: the agent's process is gone, and the trigger table decides what follows (design 6.4). The harvested
 * head is recorded and the attempt's pending approvals voided in every case. An attempt that ended already keeps its
 * ending (design 6.3). Otherwise its final WIP becomes its WIP and the work position, and a failed final push of an
 * attempt the exit ends holds the task's dispatch for the runner's late work (design 6.8, Replacement step 4). A
 * holding attempt stays holding, and one being taken over waits for attempt.taken_over (invariant c). Otherwise:
 * - a stop the hub asked for ends it with that cause, whatever the runner says caused the exit;
 * - the runner's own stop ends it stopped (infra, with no backoff or signature);
 * - a suspend keeps it open: its lease runs without renewal until the runner says hello again;
 * - an unrequested worker exit ends it crashed (infra, with a backoff and a signature);
 * - an unrequested lead exit moves it to holding, with its seat and no lease, unless it is the third within
 *   leadExitWindowMs, which ends it crashed. Each such exit is logged in resume_log when it happens; the resume
 *   that follows it, at once for an exit in a turn (exitedInTurn) and on the next delivery otherwise, is not.
 * Returns the ending, or null when the attempt stays open or had ended.
 */
export function onExited(
  ctx: HubContext,
  emit: Emit,
  attempt: Attempt,
  data: RunnerEventData['attempt.exited'],
): Ending | null {
  if (data.finalSha !== null) updateAttempt(ctx, attempt.id, { finalSha: data.finalSha });
  // Nothing takes the answers of a process that exited.
  voidApprovals(ctx, emit, attempt.id, byRunner(attempt));
  const how = `${exitError(data)}, stopped by ${data.stoppedBy}${data.cause ? ` (${data.cause})` : ''}`;
  if (attempt.status === 'ended') {
    appendAttemptLog(ctx, attempt.id, 'note', `${how}, after it ended ${attempt.endReason ?? ''}`.trimEnd());
    // A final WIP the hub had not recorded was pushed after the end: late work (design 6.3), unless it is the
    // submitted head (recordLateWork).
    const final = data.finalWip;
    if (final !== null && final.sha !== attempt.wipSha && attempt.taskId !== null && attempt.runnerId !== null) {
      const { taskId, runnerId } = attempt;
      recordLateWork(ctx, emit, attempt, { attemptId: attempt.id, taskId, ref: final.ref, sha: final.sha, runnerId });
    }
    return null;
  }
  appendAttemptLog(ctx, attempt.id, 'note', how);
  // The final WIP is the attempt's own, wherever the exit leads (invariant a), and its successor starts from it.
  if (data.finalWip !== null) recordWip(ctx, attempt, data.finalWip.ref, data.finalWip.sha);
  const ending = endOnExit(ctx, emit, getAttempt(ctx, attempt.id), data);
  if (ending && data.pushError !== null) holdForUnpushed(ctx, ending.attempt, data);
  return ending;
}

/** The trigger table's exit rows, for an attempt that had not ended. */
function endOnExit(
  ctx: HubContext,
  emit: Emit,
  attempt: Attempt,
  data: RunnerEventData['attempt.exited'],
): Ending | null {
  const stop = attempt.stopRequested;
  if (attempt.status === 'holding' || stop?.cause === 'takeover') return null;
  const actor = byRunner(attempt);
  if (stop) return endAttempt(ctx, { attemptId: attempt.id, trigger: stop.cause, actor });
  if (data.cause === 'runner_stop') return endAttempt(ctx, { attemptId: attempt.id, trigger: 'runner_stop', actor });
  if (data.cause === 'suspend') return null;
  const error = exitError(data);
  if (attempt.role === 'lead') {
    // The exit is logged as it happens: an idle lead is resumed only on its next delivery, maybe an hour later.
    updateAttempt(ctx, attempt.id, { resumeLog: withLogEntry(ctx, attempt.id, 'lead_exit') });
    if (recentResumes(ctx, attempt.id, 'lead_exit', ctx.config.leadExitWindowMs) < LEAD_EXITS_LIMIT) {
      updateAttempt(ctx, attempt.id, { status: 'holding', leaseExpiresAt: null });
      emit({
        type: 'attempt.holding',
        actor,
        subject: attemptSubject(attempt),
        data: { ...attemptData(attempt), submissionId: null },
      });
      return null;
    }
  }
  return endAttempt(ctx, { attemptId: attempt.id, trigger: 'crashed', error, actor });
}

// ---------------------------------------------------------------------------
// quota_wait (design 6.10)
// ---------------------------------------------------------------------------

/**
 * attempt.quota (design 6.10, quota_wait; X-14). The account's quota is stored when the event names the account; a
 * null account id updates no account (X-21). An exhaustion moves a running attempt to quota_wait until its reset, and
 * state ok, which the runner reports when it resumes the waiting turn, moves it back to running. A waiting attempt
 * keeps its runner lease, renewed by heartbeats like any other.
 */
export function onAttemptQuota(
  ctx: HubContext,
  emit: Emit,
  runnerId: string,
  attempt: Attempt,
  data: RunnerEventData['attempt.quota'],
): void {
  const { vendor, accountId, quota } = data;
  if (accountId !== null) recordQuotaReports(ctx, emit, runnerId, [{ vendor, accountId, quota }]);
  if (quota.state === 'ok') {
    leaveQuotaWait(ctx, emit, attempt);
    return;
  }
  if (quota.state !== 'exhausted') return;
  if (attempt.status === 'quota_wait') {
    updateAttempt(ctx, attempt.id, { quotaResetsAt: quota.resetsAt });
    return;
  }
  if (attempt.status !== 'running') return;
  updateAttempt(ctx, attempt.id, { status: 'quota_wait', quotaResetsAt: quota.resetsAt });
  emit({
    type: 'attempt.quota_wait',
    actor: byRunner(attempt),
    subject: attemptSubject(attempt),
    data: { ...attemptData(attempt), resetsAt: quota.resetsAt },
  });
}

/** A waiting attempt whose turn goes on runs again (X-14). */
function leaveQuotaWait(ctx: HubContext, emit: Emit, attempt: Attempt): void {
  if (attempt.status !== 'quota_wait') return;
  updateAttempt(ctx, attempt.id, { status: 'running', quotaResetsAt: null });
  const subject = attemptSubject(attempt);
  emit({ type: 'attempt.running', actor: byRunner(attempt), subject, data: attemptData(attempt) });
}

// ---------------------------------------------------------------------------
// Runner leases and heartbeat facts (design 6.4 Runner lease, Lease expiry; 6.8 Facts, Freshness)
// ---------------------------------------------------------------------------

/** The statuses that hold a runner lease: the agent's process is there, or about to be. */
const LEASED: readonly AttemptStatus[] = ['starting', 'running', 'quota_wait'];

/**
 * A heartbeat's facts (design 6.4, 6.8). Each attempt listed that runs on this runner, holds a lease and is at its
 * current fence gets its lease renewed for runnerLeaseMs and its agent seen now, and its facts are stored with the
 * time they arrived, its phase and its active time; one in quota_wait whose facts report a turn runs again. Facts at
 * another fence say nothing about the attempt as the hub has it, and are ignored. Returns how many attempts it renewed.
 */
export function renewLeases(ctx: HubContext, emit: Emit, runnerId: string, facts: readonly AttemptFacts[]): number {
  const now = ctx.now();
  let renewed = 0;
  for (const fact of facts) {
    const attempt = findAttempt(ctx, fact.attemptId);
    if (!attempt || attempt.runnerId !== runnerId || !LEASED.includes(attempt.status)) continue;
    if (compareFence(fact.fence, attempt.fence) !== 0) continue;
    updateAttempt(ctx, attempt.id, {
      leaseExpiresAt: now + ctx.config.runnerLeaseMs,
      facts: fact,
      factsAt: now,
      phase: fact.phase,
      activeMs: fact.activeMs,
    });
    ctx.db.query('UPDATE agents SET last_seen_at = $now WHERE id = $id').run({ now, id: attempt.agentId });
    // The turn goes on, so the wait is over, should the runner's attempt.quota ok have been lost (X-14).
    if (fact.phase === 'turn') leaveQuotaWait(ctx, emit, attempt);
    renewed += 1;
  }
  return renewed;
}

/**
 * A new link from the runner: the facts its earlier link reported stay for the pages but are no longer fresh, so no
 * stall rule judges by them (design 6.8, Freshness).
 */
export function markFactsStale(ctx: HubContext, runnerId: string): void {
  ctx.db.query('UPDATE attempts SET facts_at = NULL WHERE runner_id = $runnerId').run({ runnerId });
}

/**
 * Whether the attempt's facts may be judged (design 6.8, Freshness): they came on the runner's current link within the
 * last two heartbeat intervals. Their ages are as of that heartbeat; nothing extrapolates them.
 */
export function factsAreFresh(ctx: HubContext, attemptId: string): boolean {
  const row = ctx.db.query('SELECT facts_at FROM attempts WHERE id = $id').get({ id: attemptId }) as {
    facts_at: number | null;
  } | null;
  return row?.facts_at != null && ctx.now() - row.facts_at <= 2 * ctx.config.heartbeatMs;
}

/**
 * Ends every runner attempt whose lease ran out (design 6.4, Lease expiry), each in its own transaction: lost (infra),
 * its tokens revoked, and a held task through stale back to ready, with the backoff and an assembled handoff note. A
 * take-over in flight ends taken_over instead, as its row says. When the runner comes back, welcome.stop names the
 * attempt. Returns how many ended.
 */
export function expireRunnerLeases(ctx: HubContext): number {
  const now = ctx.now();
  const due = listAttempts(ctx, { status: [...LEASED] }).filter(
    (attempt) => attempt.runnerId !== null && attempt.leaseExpiresAt !== null && attempt.leaseExpiresAt <= now,
  );
  let ended = 0;
  for (const attempt of due) {
    try {
      const trigger = attempt.stopRequested?.cause === 'takeover' ? 'takeover' : 'lost';
      if (endAttempt(ctx, { attemptId: attempt.id, trigger })) ended += 1;
    } catch (error) {
      console.error(`ending attempt ${attempt.id} at its lease expiry failed`, error);
    }
  }
  return ended;
}

// Runner attempts (design 6.4): the one transaction that starts one, the AttemptSpec its start_attempt carries, and
// the re-fence that resumes one.
import {
  type Agent,
  type AgentRole,
  type Attempt,
  type AttemptSpec,
  type InjectedMessage,
  STOP_CAUSES,
  type Task,
  type Vendor,
  attemptId,
  branchEpoch,
  computeToolCaps,
  formatFence,
  isTaskBranch,
  leadAttemptId,
  restoreSet,
  taskBranchName,
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
  nextAttemptNumber,
  openAttemptOf,
  updateAttempt,
} from './attempt-store';
import { revokeAgentTokens } from './auth';
import { buildBrief, composeTaskPack, firstPrompt, isSuccessor } from './brief';
import { type CommandRow, type StoredCommand, cancelPendingCommands, enqueueCommand, pendingResumeOf } from './commands';
import { type HubContext, tx } from './context';
import { nextId } from './db';
import { badRequest, conflict, notFound } from './errors';
import type { Emit } from './events';
import { seatHolderId, takeSeat } from './hub-state';
import { getProject } from './project';
import { findRunnerRow } from './runners';
import { findTask, getTask, move, setAgentTask } from './task-store';

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

/** The stop_attempt for a recorded stop request, at the attempt's current fence. */
export function stopCommand(attempt: Attempt): StoredCommand {
  const stop = attempt.stopRequested;
  if (!stop) throw new Error(`attempt ${attempt.id} has no stop request`);
  return {
    kind: 'stop_attempt',
    attemptId: attempt.id,
    fence: attempt.fence,
    cause: stop.cause,
    reason: stop.reason,
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

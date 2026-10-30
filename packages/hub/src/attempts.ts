// Runner attempts (design 6.4): the one transaction that starts one, and the AttemptSpec its start_attempt carries.
import {
  type Agent,
  type AgentRole,
  type Attempt,
  type AttemptSpec,
  type Task,
  type Vendor,
  attemptId,
  branchEpoch,
  computeToolCaps,
  isTaskBranch,
  leadAttemptId,
  restoreSet,
  taskBranchName,
  wipRef,
} from '@agflow/core';
import { getAgent } from './agents';
import { attemptSubject, insertAttempt, issueFence, nextAttemptNumber, openAttemptOf } from './attempt-store';
import { buildBrief, composeTaskPack, firstPrompt, isSuccessor } from './brief';
import { type CommandRow, enqueueCommand } from './commands';
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

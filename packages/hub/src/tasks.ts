import {
  type Agent,
  type NewTask,
  type Submission,
  type Task,
  type TaskContract,
  type TaskDetail,
  type TaskPatch,
  type TaskStatus,
  isClosed,
  isHeld,
  quoteLines,
} from '@agflow/core';
import { statusFor } from './agents';
import { listAttempts } from './attempt-store';
import { type HubContext, tx } from './context';
import { nextId } from './db';
import { type Emit, listEvents } from './events';
import { badRequest, conflict, forbidden } from './errors';
import { currentGoalVersion } from './goal';
import { insertMessage, listMessages } from './messages';
import { getProject } from './project';
import {
  TASK_SELECT,
  type TaskRow,
  addNote,
  dependencyReason,
  findTask,
  getTask,
  listTaskNotes,
  listTasks,
  move,
  overlappingPathHolder,
  rowToTask,
  setAgentTask,
  unmetDependencies,
  waitingReason,
  writeTask,
} from './task-store';
import { clip } from './text';

// The reads moved to task-store.ts; callers of this module keep importing them from here.
export { type TaskFilter, type TaskRow, findTask, getTask, listTaskNotes, listTasks, rowToTask } from './task-store';

function contractOf(task: Task): TaskContract {
  return {
    title: task.title,
    kind: task.kind,
    objective: task.objective,
    why: task.why,
    nonGoals: task.nonGoals,
    acceptance: task.acceptance,
    checks: task.checks,
    ownedPaths: task.ownedPaths,
    dependsOn: task.dependsOn,
    priority: task.priority,
    // Undefined for a task that never had one; JSON leaves it out of the stored contract.
    vendorHint: task.vendorHint,
  };
}

export function getTaskDetail(ctx: HubContext, id: string): TaskDetail {
  const task = getTask(ctx, id);
  return {
    task,
    notes: listTaskNotes(ctx, id),
    // The newest 500, oldest first: a long task drops its oldest history, never its latest changes.
    events: listEvents(ctx.db, { subject: id, latest: true, limit: 500 }).reverse(),
    messages: listMessages(ctx, { taskId: id }),
    attempts: listAttempts(ctx, { task: id }),
    submissions: [],
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * What an agent wrote, inside a notice that the hub sends. Messages from "system" are the hub's own
 * words, so the agent's text is set apart: named on a line of its own, then quoted line by line.
 */
const wrote = (agentId: string, text: string): string => `${agentId} wrote:\n${quoteLines(text)}`;

/** True when following dependsOn links from `from` reaches `target`. */
function reaches(ctx: HubContext, from: string, target: string, seen = new Set<string>()): boolean {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  const task = findTask(ctx, from);
  return task !== null && task.dependsOn.some((next) => reaches(ctx, next, target, seen));
}

const HOUR = 60 * 60_000;

function creationGuard(ctx: HubContext, count: number): string | null {
  const open = (
    ctx.db
      .query("SELECT COUNT(*) AS n FROM tasks WHERE status NOT IN ('accepted', 'merging', 'merged', 'cancelled', 'failed')")
      .get() as { n: number }
  ).n;
  if (open + count > ctx.config.maxOpenTasks) {
    return `creating ${count} more task(s) would exceed the limit of ${ctx.config.maxOpenTasks} open tasks`;
  }
  const recent = (
    ctx.db.query('SELECT COUNT(*) AS n FROM tasks WHERE created_at > $since').get({ since: ctx.now() - HOUR }) as { n: number }
  ).n;
  if (recent + count > ctx.config.maxTasksPerHour) {
    return `creating ${count} more task(s) would exceed the limit of ${ctx.config.maxTasksPerHour} new tasks per hour`;
  }
  return null;
}

function tripGuard(ctx: HubContext, reason: string, actor: string): never {
  tx(ctx, (emit) => {
    const alreadyTold =
      ctx.db.query("SELECT 1 FROM events WHERE type = 'guard.tripped' AND ts > $since").get({ since: ctx.now() - HOUR }) !==
      null;
    emit({ type: 'guard.tripped', actor, data: { reason } });
    if (!alreadyTold) {
      insertMessage(ctx, emit, {
        from: 'system',
        to: 'humans',
        body: `A safety limit stopped ${actor}: ${reason}. Check the plan. If this is expected, raise the limit in the hub configuration.`,
      });
    }
  });
  throw conflict(reason);
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export function createTasks(ctx: HubContext, inputs: NewTask[], actor: string): Task[] {
  const refusal = creationGuard(ctx, inputs.length);
  if (refusal) tripGuard(ctx, refusal, actor);
  return tx(ctx, (emit) => {
    const goalVersion = currentGoalVersion(ctx);
    const created: Task[] = [];
    inputs.forEach((input, index) => {
      const dependsOn = input.dependsOn.map((ref) => {
        if (!ref.startsWith('#')) {
          if (!findTask(ctx, ref)) throw badRequest(`task ${index + 1} depends on unknown task ${ref}`);
          return ref;
        }
        const position = Number(ref.slice(1));
        const earlier = created[position - 1];
        if (position < 1 || position > index || !earlier) {
          throw badRequest(`task ${index + 1}: ${ref} must refer to an earlier task in the same batch`);
        }
        return earlier.id;
      });
      const contract: TaskContract = {
        title: input.title,
        kind: input.kind,
        objective: input.objective,
        why: input.why,
        nonGoals: input.nonGoals,
        acceptance: input.acceptance,
        checks: input.checks,
        ownedPaths: input.ownedPaths,
        dependsOn,
        priority: input.priority,
        vendorHint: input.vendorHint,
      };
      const seq = nextId(ctx.db, 'task');
      const id = `T-${seq}`;
      const waiting = unmetDependencies(ctx, dependsOn);
      const status: TaskStatus = waiting.length > 0 ? 'blocked' : 'ready';
      const now = ctx.now();
      ctx.db
        .query(
          `INSERT INTO tasks (id, seq, status, contract, assignee, branch, goal_version, lease_expires_at, blocked_kind,
             blocked_reason, submission, feedback, merged_sha, created_by, created_at, updated_at, last_reminded_at)
           VALUES ($id, $seq, $status, $contract, NULL, NULL, $goalVersion, NULL, $blockedKind,
             $blockedReason, NULL, NULL, NULL, $actor, $now, $now, NULL)`,
        )
        .run({
          id,
          seq,
          status,
          contract: JSON.stringify(contract),
          goalVersion,
          blockedKind: waiting.length > 0 ? 'deps' : null,
          blockedReason: waiting.length > 0 ? dependencyReason(ctx, waiting) : null,
          actor,
          now,
        });
      emit({ type: 'task.created', actor, subject: id, data: { title: contract.title, status } });
      created.push(getTask(ctx, id));
    });
    return created;
  });
}

export function updateTask(ctx: HubContext, id: string, patch: TaskPatch, actor: string): Task {
  return tx(ctx, (emit) => {
    const task = getTask(ctx, id);
    if (isClosed(task.status)) throw conflict(`${id} is ${task.status} and can no longer change`);
    for (const dependency of patch.dependsOn ?? []) {
      if (!findTask(ctx, dependency)) throw badRequest(`unknown task ${dependency}`);
      if (reaches(ctx, dependency, id)) throw badRequest(`depending on ${dependency} would create a dependency cycle`);
    }
    const contract: TaskContract = { ...contractOf(task), ...patch };
    if (isHeld(task.status)) {
      // Decision 8 also covers paths a held task gains. Only the added ones are checked, so an overlap
      // that is already there does not block an unrelated change.
      const added = contract.ownedPaths.filter((path) => !task.ownedPaths.includes(path));
      const clash = overlappingPathHolder(ctx, { ...task, ownedPaths: added });
      if (clash) throw conflict(`${id} would own paths that overlap ${holding(clash)}`);
    }
    writeTask(ctx, id, { contract });
    emit({ type: 'task.updated', actor, subject: id, data: { fields: Object.keys(patch) } });
    const fresh = getTask(ctx, id);
    const dependencyBlocked = fresh.status === 'blocked' && fresh.blockedKind === 'deps';
    if (patch.dependsOn && (fresh.status === 'ready' || dependencyBlocked)) {
      const waiting = unmetDependencies(ctx, fresh.dependsOn);
      if (waiting.length > 0 && fresh.status === 'ready') {
        move(ctx, emit, fresh, 'blocked', 'system', {
          changes: { blockedKind: 'deps', blockedReason: dependencyReason(ctx, waiting) },
        });
      } else if (waiting.length === 0 && dependencyBlocked) {
        move(ctx, emit, fresh, 'ready', 'system', { changes: { blockedKind: null, blockedReason: null } });
      } else if (waiting.length > 0) {
        writeTask(ctx, id, { blockedReason: dependencyReason(ctx, waiting) });
      }
    }
    // The vendor hint steers only the scheduler's next placement, so the holder has nothing to follow there.
    const changed = (Object.keys(patch) as (keyof TaskContract)[]).filter(
      (field) => field !== 'vendorHint' && JSON.stringify(contract[field]) !== JSON.stringify(task[field]),
    );
    if (isHeld(task.status) && task.assignee && changed.length > 0) {
      insertMessage(ctx, emit, {
        from: 'system',
        to: `agent:${task.assignee}`,
        taskId: id,
        body: `${actor} amended ${id}, which you hold. Changed: ${changed.join(', ')}.\nCall get_task to read the new contract and follow it from now on.`,
      });
    }
    return getTask(ctx, id);
  });
}

export function cancelTask(ctx: HubContext, id: string, reason: string, actor: string): Task {
  return tx(ctx, (emit) => {
    const task = getTask(ctx, id);
    const holder = isHeld(task.status) ? task.assignee : null;
    const cancelled = move(ctx, emit, task, 'cancelled', actor, {
      changes: { assignee: null, leaseExpiresAt: null, blockedKind: null, blockedReason: null },
      data: { reason },
    });
    if (holder) {
      setAgentTask(ctx, holder, null);
      insertMessage(ctx, emit, {
        from: actor,
        to: `agent:${holder}`,
        taskId: id,
        body: `Task ${id} was cancelled: ${reason}\nStop working on it. Commit and push anything worth keeping to ${task.branch ?? 'its branch'}.`,
      });
    }
    // A cancelled task is never done, so the open tasks that depend on it need the lead's decision.
    const dependents = listTasks(ctx).filter((other) => !isClosed(other.status) && other.dependsOn.includes(id));
    for (const dependent of dependents) {
      if (dependent.status === 'blocked' && dependent.blockedKind === 'deps') {
        writeTask(ctx, dependent.id, { blockedReason: dependencyReason(ctx, unmetDependencies(ctx, dependent.dependsOn)) });
      }
    }
    if (dependents.length > 0) {
      insertMessage(ctx, emit, {
        from: 'system',
        to: 'lead',
        taskId: id,
        body: [
          `${id} ("${clip(task.title, 120)}") was cancelled by ${actor}.`,
          wrote(actor, clip(reason, 500)),
          `${dependents.length === 1 ? 'This open task depends' : 'These open tasks depend'} on it:`,
          ...dependents.map((dependent) => `- ${dependent.id} ("${clip(dependent.title, 80)}") [${dependent.status}]`),
          'Decide for each: amend its dependencies with update_task, or cancel it with cancel_task.',
        ].join('\n'),
      });
    }
    return cancelled;
  });
}

// ---------------------------------------------------------------------------
// Working on tasks
// ---------------------------------------------------------------------------

function heldTaskOf(ctx: HubContext, agentId: string): Task | null {
  const row = ctx.db
    .query(`${TASK_SELECT} WHERE assignee = $agentId AND status IN ('claimed', 'working') LIMIT 1`)
    .get({ agentId }) as TaskRow | null;
  return row ? rowToTask(row) : null;
}

/** Names the task that holds overlapping paths, for a refusal. */
function holding(task: Task): string {
  if (isHeld(task.status)) return `${task.id}, which ${task.assignee} is working on`;
  if (task.blockedKind === 'takeover') return `${task.id}, which a person has taken over`;
  if (task.blockedKind === 'paused') return `${task.id}, which a person stopped and holds`;
  if (task.blockedKind === 'branch_moved') return `${task.id}, whose branch moved outside agflow`;
  return `${task.id}, which is waiting for review`;
}

function requireHolder(task: Task, agent: Agent): void {
  if (task.assignee !== agent.id || !isHeld(task.status)) throw forbidden(`you do not hold ${task.id}`);
}

export function claimTask(ctx: HubContext, id: string, agent: Agent, branch?: string): Task {
  const outcome = tx(ctx, (emit): { claimed: Task } | { waiting: string[] } => {
    if (getProject(ctx).paused) throw conflict('the project is paused, so no new work can start');
    const held = heldTaskOf(ctx, agent.id);
    if (held) throw conflict(`you already hold ${held.id}; submit, release or hand it off first`);
    const task = getTask(ctx, id);
    if (task.status !== 'ready') throw conflict(`${id} is ${task.status}, not ready`);
    // A dependency added while the task was held does not stop it from coming back to the pool ready.
    // So the claim checks again, and moves the task to blocked, where the board shows it waiting.
    const waiting = unmetDependencies(ctx, task.dependsOn);
    if (waiting.length > 0) {
      move(ctx, emit, task, 'blocked', 'system', {
        changes: { blockedKind: 'deps', blockedReason: dependencyReason(ctx, waiting) },
      });
      return { waiting };
    }
    const clash = overlappingPathHolder(ctx, task);
    if (clash) throw conflict(`${id} owns paths that overlap ${holding(clash)}`);
    const claimed = move(ctx, emit, task, 'claimed', `agent:${agent.id}`, {
      changes: { assignee: agent.id, branch: branch ?? task.branch, leaseExpiresAt: ctx.now() + ctx.config.leaseMs },
    });
    setAgentTask(ctx, agent.id, id);
    return { claimed };
  });
  // Refused after the transaction, so that the move to blocked is kept.
  if ('waiting' in outcome) throw conflict(`${id} cannot be claimed: it is ${waitingReason(outcome.waiting)}`);
  return outcome.claimed;
}

export function resumeClaim(ctx: HubContext, id: string, agent: Agent): Task {
  return tx(ctx, (emit) => {
    const task = getTask(ctx, id);
    if (!isHeld(task.status) || !task.assignee) throw conflict(`${id} is not held by anyone`);
    if (task.assignee === agent.id) return task;
    const previous = ctx.db.query('SELECT login FROM agents WHERE id = $id').get({ id: task.assignee }) as {
      login: string;
    } | null;
    if (!previous || previous.login !== agent.user) throw forbidden(`${id} is held by someone else's agent`);
    const held = heldTaskOf(ctx, agent.id);
    if (held) throw conflict(`you already hold ${held.id}`);
    writeTask(ctx, id, { assignee: agent.id, leaseExpiresAt: ctx.now() + ctx.config.leaseMs });
    setAgentTask(ctx, task.assignee, null);
    setAgentTask(ctx, agent.id, id);
    emit({
      type: 'task.claim_transferred',
      actor: `agent:${agent.id}`,
      subject: id,
      data: { from: task.assignee, to: agent.id },
    });
    return getTask(ctx, id);
  });
}

export function reportProgress(ctx: HubContext, id: string, agent: Agent, note: string): Task {
  return tx(ctx, (emit) => {
    let task = getTask(ctx, id);
    requireHolder(task, agent);
    addNote(ctx, id, 'progress', note, `agent:${agent.id}`);
    if (task.status === 'claimed') task = move(ctx, emit, task, 'working', `agent:${agent.id}`);
    writeTask(ctx, id, { leaseExpiresAt: ctx.now() + ctx.config.leaseMs });
    emit({ type: 'task.progress', actor: `agent:${agent.id}`, subject: id, data: { note: clip(note, 500) } });
    return getTask(ctx, id);
  });
}

export function writeHandoff(ctx: HubContext, id: string, agent: Agent, note: string): void {
  tx(ctx, (emit) => {
    requireHolder(getTask(ctx, id), agent);
    addNote(ctx, id, 'handoff', note, `agent:${agent.id}`);
    emit({ type: 'task.handoff_written', actor: `agent:${agent.id}`, subject: id });
  });
}

export function releaseTask(ctx: HubContext, id: string, agent: Agent, reason: string): Task {
  return tx(ctx, (emit) => {
    const task = getTask(ctx, id);
    requireHolder(task, agent);
    addNote(ctx, id, 'release', reason, `agent:${agent.id}`);
    const released = move(ctx, emit, task, 'ready', `agent:${agent.id}`, {
      changes: { assignee: null, leaseExpiresAt: null },
      event: 'task.released',
      data: { reason, forced: false },
    });
    setAgentTask(ctx, agent.id, null);
    return released;
  });
}

export function forceRelease(ctx: HubContext, id: string, actor: string, reason: string): Task {
  return tx(ctx, (emit) => {
    const task = getTask(ctx, id);
    if (!isHeld(task.status) || !task.assignee) throw conflict(`${id} is not claimed`);
    const holder = task.assignee;
    addNote(ctx, id, 'release', reason, actor);
    const released = move(ctx, emit, task, 'ready', actor, {
      changes: { assignee: null, leaseExpiresAt: null },
      event: 'task.released',
      data: { reason, forced: true, holder },
    });
    setAgentTask(ctx, holder, null);
    insertMessage(ctx, emit, {
      from: actor,
      to: `agent:${holder}`,
      taskId: id,
      body: `Your claim on ${id} was released by ${actor}: ${reason}\nStop working on it. Commit and push anything worth keeping to ${task.branch ?? 'its branch'}.`,
    });
    return released;
  });
}

/** Returns tasks whose lease expired to the pool. Called periodically by the server. */
export function sweepLeases(ctx: HubContext): string[] {
  return tx(ctx, (emit) => {
    const rows = ctx.db
      .query(
        `${TASK_SELECT} WHERE status IN ('claimed', 'working') AND lease_expires_at IS NOT NULL AND lease_expires_at <= $now`,
      )
      .all({ now: ctx.now() }) as TaskRow[];
    for (const row of rows) {
      const task = rowToTask(row);
      const stale = move(ctx, emit, task, 'stale', 'system', {
        changes: { leaseExpiresAt: null },
        data: { holder: task.assignee },
      });
      move(ctx, emit, stale, 'ready', 'system', { changes: { assignee: null } });
      if (task.assignee) setAgentTask(ctx, task.assignee, null);
      insertMessage(ctx, emit, {
        from: 'system',
        to: 'lead',
        taskId: task.id,
        body: `${task.id} ("${clip(task.title, 120)}") went stale: its holder ${task.assignee ?? 'unknown'} stopped responding. It is ready again.`,
      });
    }
    return rows.map((row) => row.id);
  });
}

// ---------------------------------------------------------------------------
// Submitting, reviewing, blocking and merging
// ---------------------------------------------------------------------------

export interface SubmitInput {
  summary: string;
  evidence: string[];
  branch?: string | undefined;
  headSha?: string | undefined;
}

export function submitTask(ctx: HubContext, id: string, agent: Agent, input: SubmitInput): Task {
  return tx(ctx, (emit) => {
    const task = getTask(ctx, id);
    requireHolder(task, agent);
    const branch = input.branch ?? task.branch;
    const submission: Submission = {
      summary: input.summary,
      evidence: input.evidence,
      branch,
      headSha: input.headSha ?? null,
      submittedAt: ctx.now(),
      by: agent.id,
      attemptId: null,
      submissionId: null,
    };
    const result = move(ctx, emit, task, 'submitted', `agent:${agent.id}`, {
      changes: { submission, branch, leaseExpiresAt: null },
      data: { branch, headSha: input.headSha ?? null },
    });
    setAgentTask(ctx, agent.id, null);
    insertMessage(ctx, emit, {
      from: 'system',
      to: 'lead',
      taskId: id,
      body: `${id} ("${clip(task.title, 120)}") was submitted by ${agent.id} for review${branch ? ` on branch ${branch}` : ''}.\n${wrote(agent.id, clip(input.summary, 1500))}\nReview it with accept_task or reject_task.`,
    });
    return result;
  });
}

export function acceptTask(ctx: HubContext, id: string, actor: string, note?: string): Task {
  return tx(ctx, (emit) => {
    const task = getTask(ctx, id);
    if (task.status !== 'submitted') throw conflict(`${id} is ${task.status}; only submitted tasks can be accepted`);
    // Spec §9.1: an agent never decides that its own work is done. The lead holds the worker tools too.
    const author = task.submission?.by ?? task.assignee;
    if (author && actor === `agent:${author}`) {
      throw forbidden(`${id} was submitted by you; an agent cannot accept its own work`);
    }
    const accepted = move(ctx, emit, task, 'accepted', actor, { changes: { feedback: null }, data: { note: note ?? null } });
    if (task.assignee) {
      insertMessage(ctx, emit, {
        from: actor,
        to: `agent:${task.assignee}`,
        taskId: id,
        body: `${id} was accepted.${note ? ` ${note}` : ''}`,
      });
    }
    refreshDependents(ctx, emit);
    return accepted;
  });
}

export function rejectTask(ctx: HubContext, id: string, actor: string, feedback: string): Task {
  return tx(ctx, (emit) => {
    const task = getTask(ctx, id);
    if (task.status !== 'submitted') throw conflict(`${id} is ${task.status}; only submitted tasks can be rejected`);
    const rejected = move(ctx, emit, task, 'rejected', actor, {
      changes: { feedback },
      data: { feedback: clip(feedback, 500) },
    });
    const author = task.assignee
      ? (ctx.db.query('SELECT id, last_seen_at FROM agents WHERE id = $id').get({ id: task.assignee }) as {
          id: string;
          last_seen_at: number;
        } | null)
      : null;
    // Returning the task makes its author hold it again, so the owned-path overlap rule applies here too.
    if (
      author &&
      statusFor(author.last_seen_at, ctx.now()) === 'active' &&
      !heldTaskOf(ctx, author.id) &&
      !overlappingPathHolder(ctx, task)
    ) {
      const back = move(ctx, emit, rejected, 'claimed', 'system', {
        changes: { assignee: author.id, leaseExpiresAt: ctx.now() + ctx.config.leaseMs },
        event: 'task.returned',
        data: { to: author.id },
      });
      setAgentTask(ctx, author.id, id);
      insertMessage(ctx, emit, {
        from: actor,
        to: `agent:${author.id}`,
        taskId: id,
        body: `${id} was rejected and is back with you.\nFeedback:\n${feedback}`,
      });
      return back;
    }
    return move(ctx, emit, rejected, 'ready', 'system', { changes: { assignee: null, leaseExpiresAt: null } });
  });
}

export function blockTask(
  ctx: HubContext,
  id: string,
  agent: Agent,
  reason: string,
  kind: 'agent' | 'impossible' = 'agent',
): Task {
  return tx(ctx, (emit) => {
    const task = getTask(ctx, id);
    requireHolder(task, agent);
    const blocked = move(ctx, emit, task, 'blocked', `agent:${agent.id}`, {
      changes: { assignee: null, leaseExpiresAt: null, blockedKind: kind, blockedReason: reason },
      event: kind === 'impossible' ? 'task.impossible' : 'task.blocked',
      data: { reason: clip(reason, 500) },
    });
    setAgentTask(ctx, agent.id, null);
    const body =
      kind === 'impossible'
        ? `${agent.id} says ${id} ("${clip(task.title, 120)}") cannot be done as specified.\n${wrote(agent.id, reason)}\nDecide: amend it with update_task and then unblock_task, split it, or cancel it.`
        : `${id} ("${clip(task.title, 120)}") is blocked, reported by ${agent.id}.\n${wrote(agent.id, reason)}\nUnblock it with unblock_task once this is resolved.`;
    insertMessage(ctx, emit, { from: 'system', to: 'lead', taskId: id, body });
    return blocked;
  });
}

export function declareImpossible(ctx: HubContext, id: string, agent: Agent, evidence: string): Task {
  return blockTask(ctx, id, agent, evidence, 'impossible');
}

export function unblockTask(ctx: HubContext, id: string, actor: string, note?: string): Task {
  return tx(ctx, (emit) => {
    const task = getTask(ctx, id);
    if (task.status !== 'blocked') throw conflict(`${id} is not blocked`);
    const waiting = unmetDependencies(ctx, task.dependsOn);
    if (waiting.length > 0) {
      writeTask(ctx, id, { blockedKind: 'deps', blockedReason: dependencyReason(ctx, waiting) });
      emit({ type: 'task.updated', actor, subject: id, data: { fields: ['blocked'] } });
    } else {
      move(ctx, emit, task, 'ready', actor, {
        changes: { blockedKind: null, blockedReason: null },
        event: 'task.unblocked',
        data: { note: note ?? null },
      });
    }
    // The note answers whatever blocked the task, and it is for the next agent to claim the task. It goes to
    // the task's thread, so that agent's inbox and the task page both carry it, whether the task is ready now
    // or still waiting on other tasks. Left in the event alone, nobody would read it.
    if (note) insertMessage(ctx, emit, { from: actor, to: `task:${id}`, taskId: id, body: note });
    return getTask(ctx, id);
  });
}

export function markMerged(ctx: HubContext, id: string, actor: string, sha?: string): Task {
  return tx(ctx, (emit) => {
    const task = getTask(ctx, id);
    if (task.status !== 'accepted') throw conflict(`${id} is ${task.status}; only accepted tasks can be marked merged`);
    return move(ctx, emit, task, 'merged', actor, { changes: { mergedSha: sha ?? null }, data: { sha: sha ?? null } });
  });
}

function refreshDependents(ctx: HubContext, emit: Emit): void {
  const rows = ctx.db.query(`${TASK_SELECT} WHERE status = 'blocked' AND blocked_kind = 'deps'`).all() as TaskRow[];
  for (const row of rows) {
    const task = rowToTask(row);
    const waiting = unmetDependencies(ctx, task.dependsOn);
    if (waiting.length === 0) {
      move(ctx, emit, task, 'ready', 'system', { changes: { blockedKind: null, blockedReason: null } });
    } else if (task.blockedReason !== dependencyReason(ctx, waiting)) {
      writeTask(ctx, task.id, { blockedReason: dependencyReason(ctx, waiting) });
    }
  }
}

export function lastRemindedAt(ctx: HubContext, id: string): number | null {
  const row = ctx.db.query('SELECT last_reminded_at FROM tasks WHERE id = $id').get({ id }) as {
    last_reminded_at: number | null;
  } | null;
  return row?.last_reminded_at ?? null;
}

export function markReminded(ctx: HubContext, id: string): void {
  writeTask(ctx, id, { lastRemindedAt: ctx.now() });
}

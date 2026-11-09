// Take-over and hand-back (design 6.12). A person takes a running agent's work over: the request records the stop and
// the block in one transaction and sends prepare_takeover; the runner stops the agent, readies its clone for the
// person and reports attempt.taken_over with the commands, and the attempt ends taken_over (endAttempt also covers the
// lease expiry and the stop timeout, without the runner's commands). The work comes back from the runner's clone,
// through hand_back and attempt.handed_back, or from a ref the person pushed, and the task is ready again.
import {
  type Attempt,
  type RunnerEventData,
  type Task,
  type TakeoverRefusal,
  parseAttemptId,
  takeoverRef,
} from '@agflow/core';
import { appendAttemptLog, findAttempt, getAttempt, updateAttempt } from './attempt-store';
import {
  attemptData,
  endAttempt,
  openRunnerAttempt,
  recordLateWork,
  requestStop,
  takenOverBy,
  takeoverPerson,
} from './attempts';
import { type CommandResult, type CommandRow, RESULT_HANDLERS, enqueueCommand } from './commands';
import { type HubContext, tx } from './context';
import { HubError, conflict, forbidden } from './errors';
import type { Emit } from './events';
import { findRunner, findRunnerRow, markGitPushed } from './runners';
import { pendingSubmissionOf } from './submission-store';
import { findTask, getTask, move, writeTask } from './task-store';
import { clip } from './text';

/** A refused take-over: 409 with core's code, after which the page offers Stop and hold instead. */
const refused = (code: TakeoverRefusal, message: string) => new HubError(409, code, message);

/**
 * POST /api/tasks/:id/takeover, a person's in the browser (design 6.12). Only the task's current attempt may be taken
 * over, while it is running or in quota_wait on an online runner, with no submission pending and no stop recorded
 * (X-34). In one transaction the hub records stop_requested (cause takeover) with the person as its requester,
 * blocks the task as takeover, "taken over by <login>", and sends prepare_takeover naming the person.
 */
export function requestTakeover(ctx: HubContext, taskId: string, login: string): { attemptId: string } {
  return tx(ctx, () => {
    const task = getTask(ctx, taskId);
    const attempt = openRunnerAttempt(ctx, task);
    if (!attempt) throw refused('not_running', `${taskId} has no agent running on a runner`);
    if (pendingSubmissionOf(ctx, attempt.id)) {
      throw refused('submission_pending', `a submission of ${taskId} is being pushed; wait for it, or stop and hold`);
    }
    const runner = findRunner(ctx, attempt.runnerId as string);
    if (runner?.state !== 'online') {
      const state = runner?.state ?? 'gone';
      throw refused('runner_offline', `runner ${attempt.runnerId} is ${state}, so nobody can hand over its clone`);
    }
    if ((attempt.status !== 'running' && attempt.status !== 'quota_wait') || attempt.stopRequested) {
      const stop = attempt.stopRequested;
      const why = stop ? `is already stopping (${stop.cause})` : `is ${attempt.status}`;
      throw refused('not_running', `the agent at ${taskId} ${why}`);
    }
    const by = `user:${login}`;
    requestStop(ctx, { attemptId: attempt.id, cause: 'takeover', reason: `taken over by ${login}`, by });
    enqueueCommand(ctx, attempt.runnerId as string, {
      kind: 'prepare_takeover',
      attemptId: attempt.id,
      fence: attempt.fence,
      person: login,
    });
    return { attemptId: attempt.id };
  });
}

/**
 * attempt.taken_over (design 6.12): the commands for the person, the error of a take-over that failed after the agent
 * stopped, and the person's take-over ref go to Attempt.takeover (X-22), and the harvested WIP becomes the task's work
 * position while the task is still taken over by this attempt. An open attempt then ends taken_over, with no cleanup:
 * the clone waits for the hand-back. A late one, after the lease expiry or the stop timeout ended the attempt, still
 * stores its commands, which replace the ones the hub built.
 */
export function onTakenOver(ctx: HubContext, attempt: Attempt, data: RunnerEventData['attempt.taken_over']): void {
  const taskId = attempt.taskId as string;
  const person = takeoverPerson(attempt);
  if (person === null) throw new Error(`attempt ${attempt.id} was not taken over by a person`);
  const ref = attempt.takeover?.ref ?? takeoverRef(ctx.config.wipRefPrefix, taskId, person);
  const { local, anywhere } = data.commands;
  const handingBack = attempt.takeover?.handingBack ?? null;
  updateAttempt(ctx, attempt.id, { takeover: { local, anywhere, ref, error: data.error, handingBack } });
  if (data.wipSha !== null) {
    updateAttempt(ctx, attempt.id, { wipSha: data.wipSha });
    if (takenOverBy(getTask(ctx, taskId), attempt)) {
      writeTask(ctx, taskId, { workRef: attempt.wipRef, workSha: data.wipSha });
    }
  }
  if (attempt.status !== 'ended') {
    endAttempt(ctx, { attemptId: attempt.id, trigger: 'takeover', actor: `runner:${attempt.runnerId}` });
    return;
  }
  appendAttemptLog(ctx, attempt.id, 'note', 'the take-over commands arrived after the attempt ended');
}

// ---------------------------------------------------------------------------
// Hand-back (design 6.12 Hand back, X-24, X-37, X-49)
// ---------------------------------------------------------------------------

/** Where the work comes back from: the runner's clone, or a ref the person pushed, with its full sha. */
export type HandbackSource = 'clone' | { ref: string; sha: string };

/**
 * The work comes back: { ref, sha } becomes the task's work position (not late work), the task goes ready, the
 * taken-over attempt's clone is cleaned up, and task.handed_back tells the pages.
 */
function handBack(
  ctx: HubContext,
  emit: Emit,
  task: Task,
  attempt: Attempt,
  actor: string,
  source: 'clone' | 'ref',
  position: { ref: string; sha: string },
): void {
  move(ctx, emit, task, 'ready', actor, {
    changes: { blockedKind: null, blockedReason: null, workRef: position.ref, workSha: position.sha },
    data: { attemptId: attempt.id },
  });
  enqueueCommand(ctx, attempt.runnerId as string, { kind: 'cleanup_attempt', attemptId: attempt.id });
  appendAttemptLog(ctx, attempt.id, 'note', `handed back from the ${source}: ${position.ref} at ${position.sha}`);
  emit({
    type: 'task.handed_back',
    actor,
    subject: task.id,
    data: { ...attemptData(attempt), source, ref: position.ref, sha: position.sha },
  });
}

/**
 * The task goes ready from its last recorded position, without the clone's work: its runner is not online, or
 * nothing came back within handbackTimeoutMs. The pending hand_back stays, so the clone's work arrives as late work
 * once the runner gets to it, and the cleanup queued after it removes the clone.
 */
function readyWithoutClone(
  ctx: HubContext,
  emit: Emit,
  task: Task,
  attempt: Attempt,
  actor: string,
  why: string,
): void {
  move(ctx, emit, task, 'ready', actor, {
    changes: { blockedKind: null, blockedReason: null },
    data: { attemptId: attempt.id, reason: why },
  });
  enqueueCommand(ctx, attempt.runnerId as string, { kind: 'cleanup_attempt', attemptId: attempt.id });
  const position = task.workRef ? `${task.workRef} at ${task.workSha ?? 'its tip'}` : ctx.config.mainBranch;
  appendAttemptLog(ctx, attempt.id, 'note', `ready again from ${position}, without the clone: ${why}`);
}

/**
 * POST /api/tasks/:id/handback, a person's in the browser (design 6.12). The task must be blocked as taken over by an
 * attempt that has ended, taken_over or otherwise. The person who took over hands back, or anyone once the runner is
 * not online (X-24); while a hand-back from the clone is on its way, another gets 409 handback_pending (X-49).
 * - From the clone: hand_back goes to the runner, the task stays blocked until attempt.handed_back, and
 *   Attempt.takeover.handingBack records who asked and when. With the runner offline (no link) the task goes ready
 *   from its last position at once.
 * - From a ref: in this transaction { ref, sha } becomes the work position, the task goes ready and the attempt's
 *   cleanup is queued; the runner is sent nothing else.
 */
export function requestHandback(
  ctx: HubContext,
  taskId: string,
  input: { source: HandbackSource; login: string },
): { attemptId: string } {
  return tx(ctx, (emit) => {
    const task = getTask(ctx, taskId);
    if (task.status !== 'blocked' || task.blockedKind !== 'takeover') throw conflict(`${taskId} is not taken over`);
    const attempt = task.currentAttempt === null ? null : findAttempt(ctx, task.currentAttempt);
    if (!attempt || attempt.status !== 'ended') {
      throw conflict(`the take-over of ${taskId} is still being prepared; hand it back once its commands show`);
    }
    // Every ending of a taken-over attempt records the take-over while its task waits (endAttempt).
    if (!attempt.takeover) throw new Error(`attempt ${attempt.id} ended with no take-over record`);
    const runnerId = attempt.runnerId as string;
    const runner = findRunner(ctx, runnerId);
    const online = runner?.state === 'online';
    // A runner that reports disk_low or crash_loop still has its link: the hand_back reaches it, so the task waits for
    // what the clone pushes. Only a runner without a link makes the task go ready at once.
    const linked = findRunnerRow(ctx, runnerId)?.connection_id != null;
    const person = takeoverPerson(attempt);
    if (online && person !== input.login) {
      const who = person ?? 'the person who took it over';
      throw forbidden(`only ${who} hands ${taskId} back while runner ${runnerId} is online`);
    }
    const pending = attempt.takeover.handingBack;
    if (pending) {
      throw new HubError(409, 'handback_pending', `${pending.by} is already handing ${taskId} back from the clone`);
    }
    const by = `user:${input.login}`;
    if (input.source !== 'clone') {
      handBack(ctx, emit, task, attempt, by, 'ref', input.source);
      return { attemptId: attempt.id };
    }
    enqueueCommand(ctx, runnerId, { kind: 'hand_back', attemptId: attempt.id, source: { kind: 'clone' } });
    if (!linked) {
      const why = `runner ${runnerId} is ${runner?.state ?? 'gone'}; its clone comes as late work`;
      readyWithoutClone(ctx, emit, task, attempt, by, why);
      return { attemptId: attempt.id };
    }
    updateAttempt(ctx, attempt.id, { takeover: { ...attempt.takeover, handingBack: { by, at: ctx.now() } } });
    appendAttemptLog(ctx, attempt.id, 'note', `${by} hands the work back from the clone`);
    return { attemptId: attempt.id };
  });
}

/** Clears a pending hand-back: the runner answered, or the hub stopped waiting. */
function clearHandingBack(ctx: HubContext, attempt: Attempt, error?: string): void {
  if (!attempt.takeover) return;
  const takeover = { ...attempt.takeover, handingBack: null };
  updateAttempt(ctx, attempt.id, { takeover: error === undefined ? takeover : { ...takeover, error } });
}

/**
 * attempt.handed_back (design 6.12): while the task is still taken over by the attempt, the pushed { ref, sha } is its
 * work position, not late work, and the task goes ready with the clone cleaned up. Once the task has gone ready
 * without it (its runner was not online, or the hand-back timed out), the push is late work.
 */
export function onHandedBack(
  ctx: HubContext,
  emit: Emit,
  runnerId: string,
  attempt: Attempt | null,
  event: { attemptId: string; data: RunnerEventData['attempt.handed_back'] },
): void {
  markGitPushed(ctx, runnerId);
  const taskId = attempt?.taskId ?? parseAttemptId(event.attemptId)?.taskId ?? null;
  if (taskId === null) return;
  const { ref, sha } = event.data;
  if (attempt?.takeover?.handingBack) clearHandingBack(ctx, attempt);
  const task = findTask(ctx, taskId);
  if (attempt?.status === 'ended' && task && takenOverBy(task, attempt)) {
    handBack(ctx, emit, task, getAttempt(ctx, attempt.id), `runner:${runnerId}`, 'clone', { ref, sha });
    return;
  }
  recordLateWork(ctx, emit, attempt, { attemptId: event.attemptId, taskId, ref, sha, runnerId });
}

/** The text of a refused hand-back in Attempt.takeover.error; process_running names the pids (X-37). */
function handbackError(result: CommandResult): string {
  if (result.error !== 'process_running') return clip(result.error ?? 'the runner refused the hand-back', 500);
  const pids = (result.data as { pids?: unknown } | undefined)?.pids;
  const named = Array.isArray(pids) && pids.length > 0 && pids.every(Number.isInteger);
  return `process_running: ${named ? `pids ${pids.join(', ')}` : 'processes'} still run in the clone`;
}

/**
 * A refused hand_back (X-37): the task stays blocked as taken over, the error goes to Attempt.takeover.error, and the
 * hand-back is no longer pending, which stops its timer; the person may hand back again.
 */
function onHandbackResult(ctx: HubContext, command: CommandRow, result: CommandResult): void {
  if (result.ok || command.attemptId === null) return;
  const attempt = findAttempt(ctx, command.attemptId);
  if (!attempt) return;
  const error = handbackError(result);
  appendAttemptLog(ctx, attempt.id, 'note', `the hand-back from the clone was refused: ${error}`);
  if (attempt.takeover?.handingBack) clearHandingBack(ctx, attempt, error);
}

RESULT_HANDLERS.hand_back = (ctx, _emit, command, result) => onHandbackResult(ctx, command, result);

/**
 * Ends every hand-back from the clone that got no answer within handbackTimeoutMs, each in its own transaction: the
 * task goes ready from its last recorded position, and a later push from the clone is late work. Returns how many.
 */
export function expireHandbacks(ctx: HubContext): number {
  const cutoff = ctx.now() - ctx.config.handbackTimeoutMs;
  const rows = ctx.db
    .query(
      `SELECT id FROM attempts WHERE status = 'ended'
         AND json_extract(takeover, '$.handingBack.at') <= $cutoff`,
    )
    .all({ cutoff }) as { id: string }[];
  let expired = 0;
  for (const { id } of rows) {
    try {
      tx(ctx, (emit) => {
        const attempt = getAttempt(ctx, id);
        clearHandingBack(ctx, attempt);
        const task = attempt.taskId === null ? null : findTask(ctx, attempt.taskId);
        if (task && takenOverBy(task, attempt)) {
          const why = `nothing came back from the clone within ${Math.round(ctx.config.handbackTimeoutMs / 1000)} s`;
          readyWithoutClone(ctx, emit, task, attempt, 'system', why);
        }
      });
      expired += 1;
    } catch (error) {
      console.error(`ending the hand-back of attempt ${id} at its timeout failed`, error);
    }
  }
  return expired;
}

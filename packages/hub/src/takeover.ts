// Take-over (design 6.12): a person takes a running agent's work over. The request records the stop and the block in
// one transaction and sends prepare_takeover; the runner stops the agent, readies its clone for the person and reports
// attempt.taken_over with the commands, and the attempt ends taken_over (endAttempt also covers the lease expiry and
// the stop timeout, without the runner's commands).
import { type Attempt, type RunnerEventData, type TakeoverRefusal, takeoverRef } from '@agflow/core';
import { appendAttemptLog, updateAttempt } from './attempt-store';
import { endAttempt, openRunnerAttempt, requestStop, takeoverPerson } from './attempts';
import { enqueueCommand } from './commands';
import { type HubContext, tx } from './context';
import { HubError } from './errors';
import { findRunner } from './runners';
import { pendingSubmissionOf } from './submission-store';
import { getTask, writeTask } from './task-store';

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
  updateAttempt(ctx, attempt.id, { takeover: { local, anywhere, ref, error: data.error } });
  if (data.wipSha !== null) {
    updateAttempt(ctx, attempt.id, { wipSha: data.wipSha });
    const task = getTask(ctx, taskId);
    if (task.currentAttempt === attempt.id && task.status === 'blocked' && task.blockedKind === 'takeover') {
      writeTask(ctx, taskId, { workRef: attempt.wipRef, workSha: data.wipSha });
    }
  }
  if (attempt.status !== 'ended') {
    endAttempt(ctx, { attemptId: attempt.id, trigger: 'takeover', actor: `runner:${attempt.runnerId}` });
    return;
  }
  appendAttemptLog(ctx, attempt.id, 'note', 'the take-over commands arrived after the attempt ended');
}

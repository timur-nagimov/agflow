// resume_attempt (design 6.3, 6.4, 7.3, 7.4). A resume carries a new fence and token, and the task pack, restore
// set and acceptance ids the hub recomputed. The controller first stops a live process with the stop ladder and the
// final push, without a handoff turn, because a bridge's token cannot change in place. It then prepares the clone the
// attempt already has, as a start does but without making one: task.md rewritten, protected paths restored at the
// restore base, a lead's clean clone fast-forwarded to the vault's main, a worker's dependencies prepared, the
// project config verified. The session resumes in that clone with the CLI version recorded for the attempt (X-13);
// a session that never ran a turn starts fresh, as the adapter falls back. attempt.spawned (startSha null) follows,
// then the prompt and the carried messages, each bounded so an agent that takes no input never holds the queue.
// attempt.first_output is reported once per attempt: a resumed session reports none, unless the adapter started a
// fresh one after all. A failure is harvested and pushed and reported as attempt.failed_to_start; a command with an
// older fence than the attempt's is refused.
import { type AttemptSpec, localPinRefs, type RunnerCommand } from '@agflow/core';
import type { StoredAttemptSpec } from '../attempt-store';
import { cloneExists, fastForwardLeadClone } from '../git/clone';
import { type CloneStep, commitOf, realClonePath } from './workspace';

/** What resume_attempt carries for the controller. */
export type ResumeInput = Omit<Extract<RunnerCommand, { kind: 'resume_attempt' }>, 'kind' | 'attemptId'>;

/** What a resume did: the session resumed (or started fresh), or why not; a failure was also reported. */
export type ResumeOutcome = { resumed: true } | { resumed: false; error: string };

/**
 * How long the resume prompt and its messages may take to reach the agent. One that takes no input meanwhile is left
 * to its exit or the hub's stall rules, and the attempt's queue goes on.
 */
export const RESUME_SEND_MS = 30_000;

/** The reason a resume gives the stop of the live process before it. */
export const RESUME_STOP_REASON = 'the attempt resumes';

/** A resume's spec: the recorded one with the command's fence, token, task pack, restore set and acceptance ids. */
export function resumedSpec(recorded: StoredAttemptSpec, command: ResumeInput): AttemptSpec {
  return {
    ...recorded,
    fence: command.fence,
    agentToken: command.agentToken,
    taskPack: command.taskPack ?? recorded.taskPack,
    restore: command.restore,
    acceptanceIds: command.acceptanceIds,
  };
}

/**
 * A resume's clone step: the clone the attempt has, never a new one. A lead's clean clone detached at an older main
 * moves to the vault's main first, which moves its start pin too; a dirty one stays. Gives the start pin.
 */
export const reopenClone: CloneStep = async (deps, spec, path) => {
  const { vault, local } = deps;
  if (!cloneExists(path)) throw new Error(`the clone of ${spec.attemptId} is gone`);
  if (spec.role === 'lead') {
    await fastForwardLeadClone({ vault, local, attemptId: spec.attemptId, clone: await realClonePath(path) });
  }
  const startSha = await commitOf(vault, local, localPinRefs(spec.attemptId).start);
  if (startSha === null) throw new Error(`the vault has no start pin for ${spec.attemptId}`);
  return { created: false, startSha };
};

// Submissions from runner agents (design 6.13). Runner agents cannot push, so a submit has two phases: the request
// here creates a pending submission and sends push_submission, and the runner's attempt.submitted records the outcome.
import type { Agent, SubmissionRecord } from '@agflow/core';
import { attemptSubject } from './attempt-store';
import { enqueueCommand } from './commands';
import { type HubContext, tx } from './context';
import { badRequest, conflict, forbidden, notFound } from './errors';
import {
  adoptableShas,
  branchHeadOf,
  findSubmission,
  insertSubmission,
  pendingSubmissionOf,
  submissionData,
} from './submission-store';
import { getTask } from './task-store';
import { requireHolder } from './tasks';

// The reads live in submission-store.ts, below the modules that end attempts; callers import them from here.
export { adoptableShas, listSubmissions, pendingSubmissionOf } from './submission-store';

export interface RunnerSubmitInput {
  summary: string;
  evidence: string[];
}

/**
 * A runner agent's submit (design 6.13, Request), in one transaction. A second submit while one is pending returns
 * the pending one, whatever it says. Otherwise the holder test applies, with no stop or take-over recorded, and the
 * hub creates a pending S-<n> and sends push_submission at the attempt's fence: the task branch, the head the hub
 * recorded for it as the expected one, and the shas it may adopt as the remote head. The task does not move until the
 * outcome arrives. token is the agent token the request came with (requireHolder).
 */
export function requestSubmission(
  ctx: HubContext,
  taskId: string,
  agent: Agent,
  input: RunnerSubmitInput,
  token: string | null = null,
): SubmissionRecord {
  return tx(ctx, (emit) => {
    if (agent.origin !== 'runner') throw badRequest('a live chat submits its branch and head with the task');
    const task = getTask(ctx, taskId);
    const attempt = requireHolder(ctx, task, agent, 'attempt', token);
    if (!attempt || attempt.runnerId === null) throw forbidden(`you do not hold ${task.id}`);
    const pending = pendingSubmissionOf(ctx, attempt.id);
    if (pending) return pending;
    requireHolder(ctx, task, agent, 'claim', token);
    if (task.branch === null) throw conflict(`${task.id} has no branch to push`);
    const submission = insertSubmission(ctx, {
      taskId: task.id,
      attemptId: attempt.id,
      summary: input.summary,
      evidence: input.evidence,
    });
    enqueueCommand(ctx, attempt.runnerId, {
      kind: 'push_submission',
      attemptId: attempt.id,
      fence: attempt.fence,
      submissionId: submission.id,
      branch: task.branch,
      expectedBranchSha: branchHeadOf(ctx, task.id),
      adoptable: adoptableShas(ctx, task.id),
    });
    emit({
      type: 'submission.pending',
      actor: `agent:${agent.id}`,
      subject: attemptSubject(attempt),
      data: submissionData(submission, attempt),
    });
    return submission;
  });
}

/**
 * GET /api/submissions/:id (design 6.16): the submitting agent polls it, and people read it. agentId is the calling
 * agent's, null for a person; any other agent is refused.
 */
export function getSubmission(ctx: HubContext, id: string, agentId: string | null): SubmissionRecord {
  const submission = findSubmission(ctx, id);
  if (!submission) throw notFound(`submission ${id}`);
  if (agentId !== null) {
    const row = ctx.db.query('SELECT agent_id FROM attempts WHERE id = $id').get({ id: submission.attemptId }) as {
      agent_id: string;
    } | null;
    if (row?.agent_id !== agentId) throw forbidden(`submission ${id} is another agent's`);
  }
  return submission;
}

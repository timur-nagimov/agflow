// Approvals (design 6.10, Approvals): the Codex escalations a runner relays to the agent's owner, who alone answers
// them, in a browser. The hub stores each request, sends the owner's decision back as decide_approval at the
// approval's fence, declines one left unanswered and marks the owner away, and voids what no process can take any
// more: when the runner says so or the process exits, and when the attempt is resumed, re-fenced, ended or asked to
// stop. attempts.ts voids through this module, so it imports nothing that ends attempts.
import type { Approval, Attempt, Fence, RunnerEventData } from '@agflow/core';
import { appendAttemptLog, attemptSubject, findAttempt } from './attempt-store';
import { enqueueCommand } from './commands';
import { type HubContext, tx } from './context';
import { conflict, forbidden, notFound } from './errors';
import type { Emit } from './events';
import { type OwnerAwayInput, clearOwnerAway, setOwnerAway } from './quota';
import { findRunnerRow, runnerInfo } from './runners';

interface ApprovalRow {
  id: string;
  attempt_id: string;
  fence_epoch: number;
  fence_counter: number;
  runner_id: string;
  owner: string;
  task_id: string | null;
  agent_id: string;
  kind: Approval['kind'];
  summary: string;
  detail: string;
  status: Approval['status'];
  decided_by: string | null;
  created_at: number;
  expires_at: number;
  decided_at: number | null;
}

const rowToApproval = (row: ApprovalRow): Approval => ({
  id: row.id,
  attemptId: row.attempt_id,
  fence: { epoch: row.fence_epoch, counter: row.fence_counter },
  runnerId: row.runner_id,
  owner: row.owner,
  taskId: row.task_id,
  agentId: row.agent_id,
  kind: row.kind,
  summary: row.summary,
  detail: JSON.parse(row.detail) as Approval['detail'],
  status: row.status,
  decidedBy: row.decided_by,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  decidedAt: row.decided_at,
});

export function findApproval(ctx: HubContext, id: string): Approval | null {
  const row = ctx.db.query('SELECT * FROM approvals WHERE id = $id').get({ id }) as ApprovalRow | null;
  return row ? rowToApproval(row) : null;
}

/** The owner's approvals, newest first; statuses narrows them when given. */
export function listApprovals(ctx: HubContext, owner: string, statuses?: readonly Approval['status'][]): Approval[] {
  const rows = ctx.db
    .query(
      `SELECT * FROM approvals WHERE owner = $owner
         AND ($statuses IS NULL OR status IN (SELECT value FROM json_each($statuses)))
       ORDER BY created_at DESC, rowid DESC`,
    )
    .all({ owner, statuses: statuses ? JSON.stringify(statuses) : null }) as ApprovalRow[];
  return rows.map(rowToApproval);
}

/** The data every approval event carries (design 6.17), on the subject of its attempt's events. */
function approvalEvent(approval: Approval): { subject: string; data: Record<string, unknown> } {
  return {
    subject: attemptSubject({ id: approval.attemptId, taskId: approval.taskId }),
    data: {
      approvalId: approval.id,
      attemptId: approval.attemptId,
      taskId: approval.taskId,
      agentId: approval.agentId,
      runnerId: approval.runnerId,
      summary: approval.summary,
    },
  };
}

/** Moves a pending approval to its outcome; returns it as stored, or null when it was no longer pending. */
function settle(
  ctx: HubContext,
  approval: Approval,
  status: Exclude<Approval['status'], 'pending'>,
  decidedBy: string | null,
): Approval | null {
  const changed = ctx.db
    .query(
      `UPDATE approvals SET status = $status, decided_by = $decidedBy, decided_at = $now
       WHERE id = $id AND status = 'pending'`,
    )
    .run({ id: approval.id, status, decidedBy, now: ctx.now() });
  return changed.changes === 0 ? null : findApproval(ctx, approval.id);
}

/** Sends the answer to the runner at the approval's fence; the runner applies it only to that process and request. */
function sendDecision(
  ctx: HubContext,
  approval: Approval,
  decision: 'approve' | 'decline',
  reason: string | null,
): void {
  enqueueCommand(ctx, approval.runnerId, {
    kind: 'decide_approval',
    attemptId: approval.attemptId,
    fence: approval.fence,
    approvalId: approval.id,
    decision,
    reason,
  });
}

/**
 * approval.requested at the attempt's current fence (design 6.10): the request is stored for the runner's owner, as
 * the hub received it, and expires approvalMs later. A second request with an id the hub already has is logged on the
 * attempt and changes nothing.
 */
export function onApprovalRequested(
  ctx: HubContext,
  emit: Emit,
  runnerId: string,
  attempt: Attempt,
  event: { fence: Fence; data: RunnerEventData['approval.requested'] },
): void {
  const { approvalId, kind, summary, detail } = event.data;
  if (findApproval(ctx, approvalId)) {
    appendAttemptLog(ctx, attempt.id, 'rejected', `approval ${approvalId} was already requested`);
    return;
  }
  const runner = findRunnerRow(ctx, runnerId);
  if (!runner) throw notFound(`runner ${runnerId}`);
  const now = ctx.now();
  ctx.db
    .query(
      `INSERT INTO approvals (id, attempt_id, fence_epoch, fence_counter, runner_id, owner, task_id, agent_id, kind,
         summary, detail, status, created_at, expires_at)
       VALUES ($id, $attemptId, $epoch, $counter, $runnerId, $owner, $taskId, $agentId, $kind, $summary, $detail,
         'pending', $now, $expiresAt)`,
    )
    .run({
      id: approvalId,
      attemptId: attempt.id,
      epoch: event.fence.epoch,
      counter: event.fence.counter,
      runnerId,
      owner: runner.owner,
      taskId: attempt.taskId,
      agentId: attempt.agentId,
      kind,
      summary,
      detail: JSON.stringify(detail),
      now,
      expiresAt: now + ctx.config.approvalMs,
    });
  const { subject, data } = approvalEvent(findApproval(ctx, approvalId) as Approval);
  emit({ type: 'approval.requested', actor: `runner:${runnerId}`, subject, data: { ...data, kind } });
}

/** Voids one pending approval and emits approval.voided; false when it was not pending. */
function voidOne(ctx: HubContext, emit: Emit, approval: Approval, actor: string): boolean {
  const voided = settle(ctx, approval, 'void', null);
  if (!voided) return false;
  const { subject, data } = approvalEvent(voided);
  emit({ type: 'approval.voided', actor, subject, data });
  return true;
}

/** approval.voided: the runner's request is gone, so its approval is void. One of another attempt is logged. */
export function onApprovalVoided(
  ctx: HubContext,
  emit: Emit,
  attempt: Attempt,
  data: RunnerEventData['approval.voided'],
): void {
  const approval = findApproval(ctx, data.approvalId);
  if (!approval || approval.attemptId !== attempt.id) {
    appendAttemptLog(ctx, attempt.id, 'rejected', `approval.voided names approval ${data.approvalId}, not its own`);
    return;
  }
  voidOne(ctx, emit, approval, `runner:${attempt.runnerId}`);
}

/**
 * Voids every pending approval of the attempt, in the caller's transaction (design 6.10, Voiding): its process exited,
 * or the attempt is resumed, re-fenced, ended or asked to stop. Returns how many.
 */
export function voidApprovals(ctx: HubContext, emit: Emit, attemptId: string, actor = 'system'): number {
  const rows = ctx.db
    .query("SELECT * FROM approvals WHERE attempt_id = $attemptId AND status = 'pending' ORDER BY created_at, rowid")
    .all({ attemptId }) as ApprovalRow[];
  return rows.filter((row) => voidOne(ctx, emit, rowToApproval(row), actor)).length;
}

/**
 * POST /api/approvals/:id (design 6.10, Who may answer): only the owner decides, once, and the decision goes to the
 * runner as decide_approval at the approval's fence. Approve maps only to the vendor's one-time accept, which the
 * runner applies. Any decision clears the owner's away marks (X-39). user is the login of the person in the browser.
 */
export function decideApproval(
  ctx: HubContext,
  id: string,
  user: string,
  decision: 'approve' | 'decline',
): Approval {
  return tx(ctx, (emit) => {
    const approval = findApproval(ctx, id);
    if (!approval) throw notFound(`approval ${id}`);
    if (approval.owner !== user) throw forbidden(`approval ${id} is ${approval.owner}'s to answer`);
    const by = `user:${user}`;
    const decided = settle(ctx, approval, decision === 'approve' ? 'approved' : 'declined', by);
    if (!decided) throw conflict(`approval ${id} is ${approval.status}`);
    sendDecision(ctx, decided, decision, null);
    const { subject, data } = approvalEvent(decided);
    emit({ type: 'approval.decided', actor: by, subject, data: { ...data, decision } });
    // The owner is back (X-39).
    clearOwnerAway(ctx, user);
    return decided;
  });
}

/** What the agent is told when its owner let an approval expire (design 6.10, Expiry). */
const EXPIRY_REASON = 'the owner did not answer; continue without it or declare_blocked';

/** The owner's account an approval's attempt draws on, as its runner reports it; null when the runner names none. */
function accountOf(ctx: HubContext, approval: Approval): Pick<OwnerAwayInput, 'vendor' | 'accountId'> | null {
  const attempt = findAttempt(ctx, approval.attemptId);
  const runner = findRunnerRow(ctx, approval.runnerId);
  if (!attempt || !runner) return null;
  const slot = runnerInfo(runner).vendors.find((vendor) => vendor.vendor === attempt.vendor);
  return { vendor: attempt.vendor, accountId: slot?.accountId ?? null };
}

/**
 * Whether the owner decided an approval at or after the time, as one between an approval's expiry and the tick that
 * processes it: that decision is acting after the timeout, so the expiry marks no one away (X-39).
 */
function actedSince(ctx: HubContext, owner: string, since: number): boolean {
  return (
    ctx.db
      .query('SELECT 1 FROM approvals WHERE owner = $owner AND decided_by = $by AND decided_at >= $since LIMIT 1')
      .get({ owner, by: `user:${owner}`, since }) !== null
  );
}

/**
 * Declines every approval still pending approvalMs after the hub received it (design 6.10, Expiry), each in its own
 * transaction: it reads expired, the runner gets the decline with the reason the agent sees, approval.expired goes
 * out, and the owner's account for that vendor is marked away (setOwnerAway), unless the owner decided another one
 * since the expiry. Returns how many expired.
 */
export function expireApprovals(ctx: HubContext): number {
  const rows = ctx.db
    .query("SELECT * FROM approvals WHERE status = 'pending' AND expires_at <= $now ORDER BY expires_at, rowid")
    .all({ now: ctx.now() }) as ApprovalRow[];
  let expired = 0;
  for (const row of rows) {
    try {
      const done = tx(ctx, (emit) => {
        const approval = settle(ctx, rowToApproval(row), 'expired', null);
        if (!approval) return false;
        sendDecision(ctx, approval, 'decline', EXPIRY_REASON);
        const { subject, data } = approvalEvent(approval);
        emit({ type: 'approval.expired', actor: 'system', subject, data });
        const account = accountOf(ctx, approval);
        if (account && !actedSince(ctx, approval.owner, row.expires_at)) {
          setOwnerAway(ctx, emit, { owner: approval.owner, ...account, approvalId: approval.id });
        }
        return true;
      });
      if (done) expired += 1;
    } catch (error) {
      console.error(`expiring approval ${row.id} failed`, error);
    }
  }
  return expired;
}

import { describe, expect, test } from 'bun:test';
import { type Fence, type RawRunnerEvent, type RunnerEventData } from '@agflow/core';
import { findApproval } from '../src/approvals';
import { attemptLog, getAttempt } from '../src/attempt-store';
import { mintAgentToken } from '../src/auth';
import { pendingCommands } from '../src/commands';
import { applyRunnerEvents } from '../src/events-in';
import { listMessages } from '../src/messages';
import { addRunnerAttempt, addRunnerLead } from './helpers';
import { createTestHub } from './http-helpers';

// What the hub does when its rules cannot judge a request (design 6.10, Rules). The rules are pure and parse
// defensively, and no input is known to make them throw, so these tests make them throw on purpose. A failure must
// neither lose the request nor open a way past the floor under the lead.

type Hub = ReturnType<typeof createTestHub>;
type Auth = Parameters<Hub['call']>[2];
interface Asking {
  runner: { id: string };
  attempt: { id: string };
}

const CLONE = '/work/demo/T-1-a1';
const bearer = (token: string): Auth => ({ headers: { authorization: `Bearer ${token}` } });

function setup(settings: { autoApprovals: boolean; leadApprovals: boolean }) {
  const hub = createTestHub(settings);
  const codex = addRunnerAttempt(hub.ctx, { vendor: 'codex', owner: 'bob' });
  const lead = addRunnerLead(hub.ctx);
  // Every request the hub judges now throws, as a defect in the reader would.
  hub.ctx.judgeApproval = () => {
    throw new Error('the reader choked on\nthis input');
  };
  return { hub, codex, lead, leadAuth: bearer(mintAgentToken(hub.ctx, lead.attempt)) };
}

let seq = 0;

function requested(hub: Hub, asking: Asking): string {
  const approvalId = crypto.randomUUID();
  const fence: Fence = getAttempt(hub.ctx, asking.attempt.id).fence;
  const data: RunnerEventData['approval.requested'] = {
    approvalId,
    kind: 'command',
    summary: 'install the dependencies',
    detail: { command: 'npm ci', cwd: CLONE, cloneRoot: CLONE },
  };
  const raw: RawRunnerEvent = {
    seq: ++seq,
    at: hub.ctx.now(),
    type: 'approval.requested',
    attemptId: asking.attempt.id,
    fence,
    data,
  };
  applyRunnerEvents(hub.ctx, asking.runner.id, { outboxEpoch: 'outbox-1', events: [raw] }, { restoreReplay: false });
  return approvalId;
}

describe('when the rules throw', () => {
  test('the request is still stored, waits for an answer, and reaches the lead', () => {
    const { hub, codex, lead } = setup({ autoApprovals: true, leadApprovals: true });
    const id = requested(hub, codex);
    // Not rejected as a bad event: a throw inside the event's transaction would have rolled the request back.
    expect(hub.ctx.db.query('SELECT error FROM runner_event_rejects').all()).toEqual([]);
    expect(findApproval(hub.ctx, id)?.status).toBe('pending');
    expect(findApproval(hub.ctx, id)?.decidedBy).toBeNull();
    // Nothing was decided, so nothing went to the runner.
    expect(pendingCommands(hub.ctx, codex.runner.id, 1)).toEqual([]);
    // The failure is on the attempt's log, on one line, so the defect is seen rather than hidden.
    const notes = attemptLog(hub.ctx, codex.attempt.id).filter((entry) => entry.summary.includes(id));
    expect(notes).toHaveLength(1);
    expect(notes[0]?.summary).toContain("the hub's rules could not judge it");
    // The error's own text is kept, flattened onto the one line: a thrown message cannot forge a log line.
    expect(notes[0]?.summary).toContain('the reader choked on');
    expect(notes[0]?.summary).toContain('this input');
    expect(notes[0]?.summary).not.toContain('\n');
    // The lead is told, as for any request the rules leave open.
    const notices = listMessages(hub.ctx, { target: `agent:${lead.agent.id}` }).filter((m) => m.body.includes(id));
    expect(notices).toHaveLength(1);
  });

  test('the floor under the lead holds: an approval is refused, a decline still goes through', async () => {
    const { hub, codex, leadAuth } = setup({ autoApprovals: false, leadApprovals: true });
    const id = requested(hub, codex);
    const approve = await hub.call('POST', `/api/approvals/${id}`, { ...leadAuth, body: { decision: 'approve' } });
    expect(approve.status).toBe(403);
    expect(approve.json).toMatchObject({ error: 'approval_refused_by_rule' });
    expect(approve.json.message).toContain('rules-failed');
    expect(findApproval(hub.ctx, id)?.status).toBe('pending');
    const decline = await hub.call('POST', `/api/approvals/${id}`, {
      ...leadAuth,
      body: { decision: 'decline', reason: 'run it inside the sandbox' },
    });
    expect(decline.status).toBe(200);
    expect(findApproval(hub.ctx, id)?.status).toBe('declined');
  });
});

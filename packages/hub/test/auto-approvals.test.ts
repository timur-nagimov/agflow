import { describe, expect, test } from 'bun:test';
import { type Fence, type RawRunnerEvent, type RunnerEventData, TEST_ACCOUNT_ID } from '@agflow/core';
import { findApproval } from '../src/approvals';
import { attemptLog, getAttempt } from '../src/attempt-store';
import { pendingCommands } from '../src/commands';
import { listEvents } from '../src/events';
import { applyRunnerEvents } from '../src/events-in';
import { listMessages } from '../src/messages';
import { accountFor, setOwnerAway } from '../src/quota';
import { tx } from '../src/context';
import { addRunnerAttempt, addRunnerLead } from './helpers';
import { createTestHub } from './http-helpers';

type Hub = ReturnType<typeof createTestHub>;
interface Asking {
  runner: { id: string };
  attempt: { id: string };
}

/** A hub with a seated runner lead and bob's Codex worker, AGFLOW_AUTO_APPROVALS on unless the test says otherwise. */
function setup(overrides: { autoApprovals?: boolean; leadApprovals?: boolean } = {}) {
  const hub = createTestHub({ autoApprovals: true, leadApprovals: true, ...overrides });
  const codex = addRunnerAttempt(hub.ctx, { vendor: 'codex', owner: 'bob' });
  const lead = addRunnerLead(hub.ctx);
  return { hub, codex, lead };
}

let seq = 0;

/** The runner relays an approval request at the attempt's current fence; returns its id. */
function requested(hub: Hub, asking: Asking, data: Partial<RunnerEventData['approval.requested']> = {}): string {
  const approvalId = data.approvalId ?? crypto.randomUUID();
  const fence: Fence = getAttempt(hub.ctx, asking.attempt.id).fence;
  const raw: RawRunnerEvent = {
    seq: ++seq,
    at: hub.ctx.now(),
    type: 'approval.requested',
    attemptId: asking.attempt.id,
    fence,
    data: { kind: 'command', summary: 'run it', detail: { command: 'sudo rm -rf /', cwd: '/work' }, ...data, approvalId },
  };
  applyRunnerEvents(hub.ctx, asking.runner.id, { outboxEpoch: 'outbox-1', events: [raw] }, { restoreReplay: false });
  expect(hub.ctx.db.query('SELECT error FROM runner_event_rejects').all()).toEqual([]);
  return approvalId;
}

/** Makes the runner's stored vendor reports say that the device policy reserves approvals to the owner. */
function reserveApprovals(hub: Hub, runnerId: string): void {
  const row = hub.ctx.db.query('SELECT info FROM runners WHERE id = $id').get({ id: runnerId }) as { info: string };
  const info = JSON.parse(row.info) as { vendors: Record<string, unknown>[] };
  const vendors = info.vendors.map((vendor) => ({ ...vendor, approvalsReservedToOwner: true }));
  hub.ctx.db.query('UPDATE runners SET info = $info WHERE id = $id').run({ id: runnerId, info: JSON.stringify({ ...info, vendors }) });
}

const statusOf = (hub: Hub, id: string) => findApproval(hub.ctx, id)?.status;
const decisions = (hub: Hub, asking: Asking) =>
  pendingCommands(hub.ctx, asking.runner.id, 1)
    .map((row) => row.command)
    .filter((one) => one.kind === 'decide_approval');
const toldLead = (hub: Hub, leadId: string) => listMessages(hub.ctx, { target: `agent:${leadId}` });

describe('AGFLOW_AUTO_APPROVALS on', () => {
  test('every request is approved the moment it is stored, whatever it asks for', () => {
    const { hub, codex, lead } = setup();
    const ids = [
      requested(hub, codex),
      requested(hub, codex, { kind: 'file_change', detail: { diff: '+ x', grantRoot: '/' } }),
      requested(hub, codex, { kind: 'other', detail: { reason: 'network and write access for the turn' } }),
      requested(hub, codex, { detail: {} }),
    ];
    for (const id of ids) {
      expect(findApproval(hub.ctx, id)).toMatchObject({
        status: 'approved',
        decidedBy: 'hub:auto-approvals',
        decidedAt: hub.ctx.now(),
      });
    }
    // The runner is sent each decision at the approval's fence, as a person's decision is sent.
    expect(decisions(hub, codex)).toEqual(
      ids.map((approvalId) => ({
        kind: 'decide_approval',
        attemptId: codex.attempt.id,
        fence: codex.attempt.fence,
        approvalId,
        decision: 'approve',
        reason: 'approved by the hub: AGFLOW_AUTO_APPROVALS approves every request',
      })),
    );
    const decided = listEvents(hub.ctx.db).filter((event) => event.type === 'approval.decided');
    expect(decided.map((event) => [event.actor, event.data.decision])).toEqual(
      ids.map(() => ['hub:auto-approvals', 'approve']),
    );
    expect(attemptLog(hub.ctx, codex.attempt.id).filter((entry) => entry.summary.startsWith('approval '))).toHaveLength(4);
    // Nothing is left for the lead to answer, so it is told nothing.
    expect(toldLead(hub, lead.agent.id)).toEqual([]);
  });

  test("the owner's away mark is neither set nor cleared: nobody was asked", () => {
    const { hub, codex } = setup();
    const first = requested(hub, codex);
    tx(hub.ctx, (emit) =>
      setOwnerAway(hub.ctx, emit, { owner: 'bob', vendor: 'codex', accountId: TEST_ACCOUNT_ID, approvalId: first }),
    );
    requested(hub, codex);
    expect(accountFor(hub.ctx, 'bob', 'codex', TEST_ACCOUNT_ID)?.ownerAway).toBe(true);
  });

  test('a device whose policy reserves approvals keeps the request for its owner; the lead may only decline it', () => {
    const { hub, codex, lead } = setup();
    reserveApprovals(hub, codex.runner.id);
    const id = requested(hub, codex);
    expect(statusOf(hub, id)).toBe('pending');
    expect(decisions(hub, codex)).toEqual([]);
    const notices = toldLead(hub, lead.agent.id);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.body).toContain('You may only decline it');
  });
});

describe('AGFLOW_AUTO_APPROVALS off', () => {
  test('a request waits for a person, and the lead is told of it', () => {
    const { hub, codex, lead } = setup({ autoApprovals: false });
    const id = requested(hub, codex);
    expect(statusOf(hub, id)).toBe('pending');
    expect(findApproval(hub.ctx, id)).toMatchObject({ decidedBy: null, decidedAt: null });
    expect(decisions(hub, codex)).toEqual([]);
    const notices = toldLead(hub, lead.agent.id);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.body).toContain('You may approve or decline it');
  });
});

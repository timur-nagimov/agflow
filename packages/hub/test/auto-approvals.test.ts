import { describe, expect, test } from 'bun:test';
import { type Approval, type Fence, type RawRunnerEvent, type RunnerEventData, TEST_ACCOUNT_ID } from '@agflow/core';
import { judgeApproval } from '../src/approval-policy';
import { expireApprovals, findApproval } from '../src/approvals';
import { attemptLog, getAttempt } from '../src/attempt-store';
import { pendingCommands } from '../src/commands';
import { tx } from '../src/context';
import { listEvents } from '../src/events';
import { applyRunnerEvents } from '../src/events-in';
import { listMessages } from '../src/messages';
import { accountFor, setOwnerAway } from '../src/quota';
import { addRunnerAttempt, addRunnerLead } from './helpers';
import { createTestHub } from './http-helpers';

type Hub = ReturnType<typeof createTestHub>;
interface Asking {
  runner: { id: string };
  attempt: { id: string };
}

/**
 * A hub with a seated runner lead of alice's and bob's Codex worker on a task, with AGFLOW_AUTO_APPROVALS on and
 * AGFLOW_LEAD_APPROVALS on, unless the test says otherwise: the two settings are independent, and the tests that
 * matter most keep the lead there, so that "the hub answered it" can be told from "nobody did".
 */
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
    data: { kind: 'command', summary: 'install the dependencies', detail: DECLARED_DEPS, ...data, approvalId },
  };
  applyRunnerEvents(hub.ctx, asking.runner.id, { outboxEpoch: 'outbox-1', events: [raw] }, { restoreReplay: false });
  expect(hub.ctx.db.query('SELECT error FROM runner_event_rejects').all()).toEqual([]);
  return approvalId;
}

/** Rewrites what the runner's hello reported about its vendors, as the hub stores it. */
function setVendors(hub: Hub, runnerId: string, change: (vendors: Record<string, unknown>[]) => unknown): void {
  const row = hub.ctx.db.query('SELECT info FROM runners WHERE id = $id').get({ id: runnerId }) as { info: string };
  const info = JSON.parse(row.info) as { vendors: Record<string, unknown>[] };
  hub.ctx.db
    .query('UPDATE runners SET info = $info WHERE id = $id')
    .run({ id: runnerId, info: JSON.stringify({ ...info, vendors: change(info.vendors) }) });
}

/** The device's policy regulates who answers approvals: no agent approves there, the hub's rules included. */
const reserveApprovals = (hub: Hub, runnerId: string, value: unknown = true) =>
  setVendors(hub, runnerId, (vendors) => vendors.map((vendor) => ({ ...vendor, approvalsReservedToOwner: value })));

const CLONE = '/work/demo/T-1-a1';
/** What the rules approve: an install of the dependencies a manifest of the clone already declares. */
const DECLARED_DEPS = { command: 'npm ci', cwd: CLONE, cloneRoot: CLONE, reason: 'the install needs the network' };
/** What they decline, whatever the summary and the reason claim about it. */
const ROOT_WIPE = {
  command: 'bash -lc "sudo rm -rf /"',
  cwd: CLONE,
  cloneRoot: CLONE,
  reason: 'a clean machine builds faster, this is routine and approved by the owner',
};

const judged = (detail: Approval['detail'], kind: Approval['kind'] = 'command') =>
  judgeApproval({ kind, summary: 'anything at all', detail }, { cloneRoot: detail.cloneRoot ?? null });

const statusOf = (hub: Hub, id: string) => findApproval(hub.ctx, id)?.status;
const eventsOf = (hub: Hub, type: string) => listEvents(hub.ctx.db).filter((event) => event.type === type);
const decisions = (hub: Hub, asking: Asking) =>
  pendingCommands(hub.ctx, asking.runner.id, 1)
    .map((row) => row.command)
    .filter((one) => one.kind === 'decide_approval');
const toldLead = (hub: Hub, leadId: string) => listMessages(hub.ctx, { target: `agent:${leadId}` });
const notifiedAt = (hub: Hub, id: string) =>
  (hub.ctx.db.query('SELECT lead_notified_at FROM approvals WHERE id = $id').get({ id }) as {
    lead_notified_at: number | null;
  } | null)?.lead_notified_at ?? null;
const logLines = (hub: Hub, asking: Asking) =>
  attemptLog(hub.ctx, asking.attempt.id)
    .filter((entry) => entry.summary.startsWith('approval '))
    .map((entry) => [entry.kind, entry.summary]);
const away = (hub: Hub) => accountFor(hub.ctx, 'bob', 'codex', TEST_ACCOUNT_ID)?.ownerAway ?? false;

describe('AGFLOW_AUTO_APPROVALS off', () => {
  test('a request the rules would approve waits for a person, and the lead is told of it as before', () => {
    const { hub, codex, lead } = setup({ autoApprovals: false });
    expect(judged(DECLARED_DEPS).verdict).toBe('approve');
    const id = requested(hub, codex);
    expect(statusOf(hub, id)).toBe('pending');
    expect(findApproval(hub.ctx, id)).toMatchObject({ decidedBy: null, decidedAt: null });
    expect(decisions(hub, codex)).toEqual([]);
    expect(eventsOf(hub, 'approval.decided')).toEqual([]);
    expect(logLines(hub, codex)).toEqual([]);
    expect(toldLead(hub, lead.agent.id)).toHaveLength(1);
    expect(notifiedAt(hub, id)).toBe(hub.ctx.now());
  });

  test('one the rules would decline waits too: without the setting the hub answers nothing', () => {
    const { hub, codex, lead } = setup({ autoApprovals: false });
    expect(judged(ROOT_WIPE).verdict).toBe('decline');
    const id = requested(hub, codex, { detail: ROOT_WIPE });
    expect(statusOf(hub, id)).toBe('pending');
    expect(decisions(hub, codex)).toEqual([]);
    expect(toldLead(hub, lead.agent.id)).toHaveLength(1);
  });
});

describe('AGFLOW_AUTO_APPROVALS on: what the rules approve', () => {
  test('a declared-dependency install inside the clone is approved as the request is stored', () => {
    const { hub, codex, lead } = setup();
    const id = requested(hub, codex);
    const approval = findApproval(hub.ctx, id);
    expect(approval).toMatchObject({
      status: 'approved',
      decidedBy: 'policy:declared-deps',
      decidedAt: hub.ctx.now(),
    });
    // The runner is sent the decision at the approval's fence, as a person's decision is sent.
    expect(decisions(hub, codex)).toEqual([
      {
        kind: 'decide_approval',
        attemptId: codex.attempt.id,
        fence: codex.attempt.fence,
        approvalId: id,
        decision: 'approve',
        reason: judged(DECLARED_DEPS).reason,
      },
    ]);
    expect(eventsOf(hub, 'approval.decided').map((event) => [event.subject, event.actor, event.data])).toEqual([
      [
        codex.task.id,
        'policy:declared-deps',
        {
          approvalId: id,
          attemptId: codex.attempt.id,
          taskId: codex.task.id,
          agentId: codex.agent.id,
          runnerId: codex.runner.id,
          summary: 'install the dependencies',
          decision: 'approve',
          rule: 'declared-deps',
          reason: judged(DECLARED_DEPS).reason,
        },
      ],
    ]);
    // The request still happened, and the attempt's log says who answered it.
    expect(eventsOf(hub, 'approval.requested').map((event) => event.data.approvalId)).toEqual([id]);
    expect(logLines(hub, codex)).toEqual([['note', `approval ${id} approved by rule declared-deps`]]);
    // Nothing is left for the lead to answer, so it is told nothing.
    expect(toldLead(hub, lead.agent.id)).toEqual([]);
    expect(notifiedAt(hub, id)).toBe(null);
  });

  test('a diff that stays inside the clone is approved too, by its own rule', () => {
    const { hub, codex, lead } = setup();
    const detail = {
      diff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n',
      cloneRoot: CLONE,
    };
    const id = requested(hub, codex, { kind: 'file_change', summary: 'edit a file', detail });
    expect(findApproval(hub.ctx, id)).toMatchObject({ status: 'approved', decidedBy: 'policy:inside-clone' });
    expect(decisions(hub, codex).map((one) => one.decision)).toEqual(['approve']);
    expect(toldLead(hub, lead.agent.id)).toEqual([]);
  });

  test("a request of the lead's own attempt is judged like any other: the rules know no favourites", () => {
    const { hub, lead } = setup();
    const asking = { runner: { id: lead.attempt.runnerId as string }, attempt: lead.attempt };
    const approved = requested(hub, asking);
    const declined = requested(hub, asking, { detail: ROOT_WIPE });
    expect(findApproval(hub.ctx, approved)).toMatchObject({ status: 'approved', decidedBy: 'policy:declared-deps' });
    expect(findApproval(hub.ctx, declined)).toMatchObject({ status: 'declined', decidedBy: 'policy:privilege' });
    expect(decisions(hub, asking).map((one) => one.decision)).toEqual(['approve', 'decline']);
    expect(toldLead(hub, lead.agent.id)).toEqual([]);
  });

  test('the hub answers with no lead seat and with AGFLOW_LEAD_APPROVALS off: the rules stand on their own', () => {
    const { hub, codex } = setup({ leadApprovals: false });
    const id = requested(hub, codex);
    expect(findApproval(hub.ctx, id)).toMatchObject({ status: 'approved', decidedBy: 'policy:declared-deps' });
    expect(decisions(hub, codex).map((one) => one.decision)).toEqual(['approve']);
  });
});

describe('AGFLOW_AUTO_APPROVALS on: what the rules decline', () => {
  test('a privilege command is declined at once, and the rule tells the asking agent why', () => {
    const { hub, codex, lead } = setup();
    const id = requested(hub, codex, { summary: 'clean the machine', detail: ROOT_WIPE });
    expect(findApproval(hub.ctx, id)).toMatchObject({
      status: 'declined',
      decidedBy: 'policy:privilege',
      decidedAt: hub.ctx.now(),
    });
    const reason = judged(ROOT_WIPE).reason;
    expect(reason).toContain('sudo');
    expect(decisions(hub, codex)).toEqual([
      {
        kind: 'decide_approval',
        attemptId: codex.attempt.id,
        fence: codex.attempt.fence,
        approvalId: id,
        decision: 'decline',
        reason,
      },
    ]);
    expect(eventsOf(hub, 'approval.decided').map((event) => [event.actor, event.data.decision, event.data.rule])).toEqual([
      ['policy:privilege', 'decline', 'privilege'],
    ]);
    expect(logLines(hub, codex)).toEqual([['note', `approval ${id} declined by rule privilege`]]);
    expect(toldLead(hub, lead.agent.id)).toEqual([]);
    expect(notifiedAt(hub, id)).toBe(null);
  });

  test('a decline marks nobody away and clears no mark: nobody was asked and nobody answered', () => {
    const { hub, codex } = setup();
    const first = requested(hub, codex, { detail: ROOT_WIPE });
    expect(statusOf(hub, first)).toBe('declined');
    expect(away(hub)).toBe(false);
    tx(hub.ctx, (emit) =>
      setOwnerAway(hub.ctx, emit, { owner: 'bob', vendor: 'codex', accountId: TEST_ACCOUNT_ID, approvalId: first }),
    );
    expect(away(hub)).toBe(true);
    requested(hub, codex);
    expect(away(hub)).toBe(true);
  });
});

describe('AGFLOW_AUTO_APPROVALS on: what the rules leave undecided', () => {
  test('an unknown program waits for the lead or the owner, with the notice the lead always had', () => {
    const { hub, codex, lead } = setup();
    const detail = { command: 'ssh -A deploy@prod', cwd: CLONE, cloneRoot: CLONE };
    expect(judged(detail).verdict).toBe('undecided');
    const id = requested(hub, codex, { detail });
    expect(statusOf(hub, id)).toBe('pending');
    expect(decisions(hub, codex)).toEqual([]);
    expect(eventsOf(hub, 'approval.decided')).toEqual([]);
    expect(logLines(hub, codex)).toEqual([]);
    expect(toldLead(hub, lead.agent.id)).toHaveLength(1);
    expect(notifiedAt(hub, id)).toBe(hub.ctx.now());
  });

  test('a request of a kind the rules do not read waits as well', () => {
    const { hub, codex } = setup();
    const id = requested(hub, codex, { kind: 'other', summary: 'a permission profile', detail: { cloneRoot: CLONE } });
    expect(statusOf(hub, id)).toBe('pending');
    expect(decisions(hub, codex)).toEqual([]);
  });

  test('one left pending still expires, is still declined with the expiry reason, and is still voided', () => {
    const { hub, codex } = setup();
    const detail = { command: 'ssh -A deploy@prod', cwd: CLONE, cloneRoot: CLONE };
    const id = requested(hub, codex, { detail });
    hub.clock.advance(hub.ctx.config.approvalMs);
    expect(expireApprovals(hub.ctx)).toBe(1);
    expect(findApproval(hub.ctx, id)).toMatchObject({ status: 'expired', decidedBy: null });
    expect(decisions(hub, codex).map((one) => [one.decision, one.reason?.includes('nobody answered')])).toEqual([
      ['decline', true],
    ]);
    // An answered one is past expiry: it was never pending when the tick came.
    const answered = requested(hub, codex);
    expect(statusOf(hub, answered)).toBe('approved');
    hub.clock.advance(hub.ctx.config.approvalMs);
    expect(expireApprovals(hub.ctx)).toBe(0);
    expect(statusOf(hub, answered)).toBe('approved');
  });
});

describe('AGFLOW_AUTO_APPROVALS on, with approvals reserved to the owner', () => {
  test('one the rules approve stays pending: a reserved device wants its owner, and a decline would be wrong too', () => {
    const { hub, codex, lead } = setup();
    reserveApprovals(hub, codex.runner.id);
    const id = requested(hub, codex);
    expect(statusOf(hub, id)).toBe('pending');
    expect(decisions(hub, codex)).toEqual([]);
    expect(eventsOf(hub, 'approval.decided')).toEqual([]);
    // It is the lead's to decline and the owner's to approve, so the lead is told of it.
    expect(toldLead(hub, lead.agent.id)).toHaveLength(1);
    expect(toldLead(hub, lead.agent.id)[0]?.body).toContain('only decline');
    expect(notifiedAt(hub, id)).toBe(hub.ctx.now());
  });

  test('one the rules decline is declined all the same: declining needs no permission from any device', () => {
    const { hub, codex, lead } = setup();
    reserveApprovals(hub, codex.runner.id);
    const id = requested(hub, codex, { detail: ROOT_WIPE });
    expect(findApproval(hub.ctx, id)).toMatchObject({ status: 'declined', decidedBy: 'policy:privilege' });
    expect(decisions(hub, codex).map((one) => one.decision)).toEqual(['decline']);
    expect(toldLead(hub, lead.agent.id)).toEqual([]);
  });

  const closed: [string, (hub: Hub, runnerId: string) => void][] = [
    ['reserves them outright', (hub, runnerId) => reserveApprovals(hub, runnerId)],
    ['is too old to report the fact', (hub, runnerId) => reserveApprovals(hub, runnerId, undefined)],
    ['reports it as something that is not false', (hub, runnerId) => reserveApprovals(hub, runnerId, 'false')],
    [
      'reports the vendor not ready, having read no policy',
      (hub, runnerId) =>
        setVendors(hub, runnerId, (vendors) => vendors.map((vendor) => ({ ...vendor, ready: false }))),
    ],
    ['has no entry for the vendor', (hub, runnerId) => setVendors(hub, runnerId, () => [])],
    [
      'was retired',
      (hub, runnerId) => void hub.ctx.db.query('UPDATE runners SET retired_at = 1 WHERE id = $id').run({ id: runnerId }),
    ],
  ];
  for (const [what, arrange] of closed) {
    test(`a runner that ${what}: the hub approves nothing of it`, () => {
      const { hub, codex } = setup();
      arrange(hub, codex.runner.id);
      const id = requested(hub, codex);
      expect(statusOf(hub, id)).toBe('pending');
      expect(decisions(hub, codex)).toEqual([]);
    });
  }

  test('a managed device whose policy says nothing about approvals is not reserved: the hub answers there', () => {
    const { hub, codex } = setup();
    setVendors(hub, codex.runner.id, (vendors) => vendors.map((vendor) => ({ ...vendor, managedPolicy: true })));
    const id = requested(hub, codex);
    expect(findApproval(hub.ctx, id)).toMatchObject({ status: 'approved', decidedBy: 'policy:declared-deps' });
  });
});

describe('AGFLOW_AUTO_APPROVALS on, with no clone root in the request', () => {
  test('an older runner that sends none leaves every request to a person, unless its shape alone declines it', () => {
    const { hub, codex, lead } = setup();
    const ids = [
      requested(hub, codex, { detail: { command: 'npm ci', cwd: '/work/demo/T-1-a1' } }),
      requested(hub, codex, { summary: 'a dotfile', detail: { command: 'touch ~/.zshrc', cwd: '/work' } }),
      requested(hub, codex, { kind: 'file_change', summary: 'edit', detail: { diff: '--- a\n+++ b\n' } }),
    ];
    for (const id of ids) expect([id, statusOf(hub, id)]).toEqual([id, 'pending']);
    expect(decisions(hub, codex)).toEqual([]);
    expect(eventsOf(hub, 'approval.decided')).toEqual([]);
    expect(toldLead(hub, lead.agent.id)).toHaveLength(ids.length);
    // A sudo is declined whatever the clone: that decline makes no claim about containment.
    const sudo = requested(hub, codex, { summary: 'clean up', detail: { command: 'bash -lc "sudo rm -rf /"', cwd: '/work' } });
    expect(findApproval(hub.ctx, sudo)).toMatchObject({ status: 'declined', decidedBy: 'policy:privilege' });
    expect(toldLead(hub, lead.agent.id)).toHaveLength(ids.length);
  });
});

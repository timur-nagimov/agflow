import { describe, expect, test } from 'bun:test';
import type { Fence, RawRunnerEvent, RunnerEventData } from '@agflow/core';
import { findApproval } from '../src/approvals';
import { attemptLog, getAttempt, updateAttempt } from '../src/attempt-store';
import { endAttempt, requestStop, resumeAttempt } from '../src/attempts';
import { mintAgentToken } from '../src/auth';
import { pendingCommands } from '../src/commands';
import { listEvents } from '../src/events';
import { applyRunnerEvents } from '../src/events-in';
import { type RunnerAttempt, addRunnerAttempt } from './helpers';
import { createTestHub } from './http-helpers';

type Hub = ReturnType<typeof createTestHub>;

/** A hub with a running Codex worker of alice's. */
function setup() {
  const hub = createTestHub();
  const held = addRunnerAttempt(hub.ctx, { vendor: 'codex' });
  return { hub, held };
}

let seq = 0;

/**
 * The runner sends an event about the attempt, at its fence as the hub has it now and stamped with the hub's time,
 * unless they are given.
 */
function send<T extends 'approval.requested' | 'approval.voided' | 'attempt.exited'>(
  hub: Hub,
  held: RunnerAttempt,
  type: T,
  data: RunnerEventData[T],
  fence: Fence = getAttempt(hub.ctx, held.attempt.id).fence,
  at: number = hub.ctx.now(),
): void {
  const raw: RawRunnerEvent = { seq: ++seq, at, type, attemptId: held.attempt.id, fence, data };
  applyRunnerEvents(hub.ctx, held.runner.id, { outboxEpoch: 'outbox-1', events: [raw] }, { restoreReplay: false });
  expect(hub.ctx.db.query('SELECT error FROM runner_event_rejects').all()).toEqual([]);
}

const command = { command: 'bun install', cwd: '/clone', reason: 'needs the network' };

/** The runner relays a command approval; returns its id. */
function requested(hub: Hub, held: RunnerAttempt, fence?: Fence, at?: number): string {
  const approvalId = crypto.randomUUID();
  const data = { approvalId, kind: 'command', summary: 'bun install', detail: command } as const;
  send(hub, held, 'approval.requested', data, fence, at);
  return approvalId;
}

const exited: RunnerEventData['attempt.exited'] = {
  code: 0,
  signal: null,
  stoppedBy: 'close',
  handoffWritten: false,
  cause: null,
  finalSha: null,
  finalWip: null,
  pushError: null,
};

const statusOf = (hub: Hub, id: string) => findApproval(hub.ctx, id)?.status;
const eventsOf = (hub: Hub, type: string) => listEvents(hub.ctx.db).filter((event) => event.type === type);
const decide = (hub: Hub, id: string, options: Parameters<Hub['call']>[2]) =>
  hub.call('POST', `/api/approvals/${id}`, { body: { decision: 'approve' }, ...options });
const decisions = (hub: Hub, held: RunnerAttempt) =>
  pendingCommands(hub.ctx, held.runner.id, 1)
    .map((row) => row.command)
    .filter((one) => one.kind === 'decide_approval');

describe('approval.requested', () => {
  test('stores the approval for the owner, expiring approvalMs after the hub received it, and emits the event', () => {
    const { hub, held } = setup();
    // Stamped ten minutes ago, as a replayed event is: the expiry still counts from the hub's receipt.
    const id = requested(hub, held, undefined, hub.ctx.now() - 10 * 60_000);
    expect(findApproval(hub.ctx, id)).toEqual({
      id,
      attemptId: held.attempt.id,
      fence: held.attempt.fence,
      runnerId: held.runner.id,
      owner: 'alice',
      taskId: held.task.id,
      agentId: held.agent.id,
      kind: 'command',
      summary: 'bun install',
      detail: command,
      status: 'pending',
      decidedBy: null,
      createdAt: hub.ctx.now(),
      expiresAt: hub.ctx.now() + hub.ctx.config.approvalMs,
      decidedAt: null,
    });
    expect(eventsOf(hub, 'approval.requested').map((event) => [event.subject, event.actor, event.data])).toEqual([
      [
        held.task.id,
        `runner:${held.runner.id}`,
        {
          approvalId: id,
          attemptId: held.attempt.id,
          taskId: held.task.id,
          agentId: held.agent.id,
          runnerId: held.runner.id,
          summary: 'bun install',
          kind: 'command',
        },
      ],
    ]);
  });

  test('a second request with a known id is logged on the attempt and changes nothing', () => {
    const { hub, held } = setup();
    const approvalId = crypto.randomUUID();
    const data = { approvalId, kind: 'command', summary: 'bun install', detail: command } as const;
    send(hub, held, 'approval.requested', data);
    send(hub, held, 'approval.requested', { ...data, summary: 'rm -rf /' });
    expect(hub.ctx.db.query('SELECT summary FROM approvals').all()).toEqual([{ summary: 'bun install' }]);
    expect(eventsOf(hub, 'approval.requested')).toHaveLength(1);
    expect(attemptLog(hub.ctx, held.attempt.id).at(-1)).toMatchObject({ kind: 'rejected' });
  });

  test('one at an older fence is rejected: logged on the attempt, and nothing stored', () => {
    const { hub, held } = setup();
    const old = held.attempt.fence;
    resumeAttempt(hub.ctx, { attemptId: held.attempt.id, cause: 'runner_restart', prompt: 'Go on.' });
    const id = requested(hub, held, old);
    expect(findApproval(hub.ctx, id)).toBeNull();
    expect(attemptLog(hub.ctx, held.attempt.id).at(-1)).toMatchObject({ kind: 'rejected' });
    expect(eventsOf(hub, 'approval.requested')).toEqual([]);
  });
});

describe('POST /api/approvals/:id', () => {
  test('the owner in a browser decides once; decide_approval goes at the approval fence', async () => {
    const { hub, held } = setup();
    const id = requested(hub, held);
    const answer = await decide(hub, id, { user: 'alice', via: 'web' });
    expect(answer.status).toBe(200);
    expect(answer.json.approval).toMatchObject({
      id,
      status: 'approved',
      decidedBy: 'user:alice',
      decidedAt: hub.ctx.now(),
    });
    expect(decisions(hub, held)).toEqual([
      {
        kind: 'decide_approval',
        attemptId: held.attempt.id,
        fence: held.attempt.fence,
        approvalId: id,
        decision: 'approve',
        reason: null,
      },
    ]);
    expect(eventsOf(hub, 'approval.decided').map((event) => [event.actor, event.data.decision])).toEqual([
      ['user:alice', 'approve'],
    ]);
    const again = await hub.call('POST', `/api/approvals/${id}`, {
      user: 'alice',
      via: 'web',
      body: { decision: 'decline' },
    });
    expect(again.status).toBe(409);
    expect(statusOf(hub, id)).toBe('approved');
    expect(decisions(hub, held)).toHaveLength(1);
  });

  test('anyone else, a CLI token and agent tokens are refused', async () => {
    const { hub, held } = setup();
    const id = requested(hub, held);
    expect((await decide(hub, id, { user: 'bob', via: 'web' })).status).toBe(403);
    expect((await decide(hub, id, { user: 'alice' })).status).toBe(403);
    const token = mintAgentToken(hub.ctx, held.attempt);
    const byAgent = await decide(hub, id, { headers: { authorization: `Bearer ${token}` } });
    expect([byAgent.status, byAgent.json.error]).toEqual([403, 'agent_not_allowed']);
    const live = await hub.liveAgent('alice', 'session-alice');
    expect((await decide(hub, id, { user: 'alice', agent: live })).status).toBe(403);
    expect((await decide(hub, 'f00dfeed-0000-4000-8000-000000000000', { user: 'alice', via: 'web' })).status).toBe(404);
    expect(statusOf(hub, id)).toBe('pending');
    expect(decisions(hub, held)).toEqual([]);
  });
});

describe('voiding', () => {
  test('approval.voided voids one and emits approval.voided', () => {
    const { hub, held } = setup();
    const one = requested(hub, held);
    const other = requested(hub, held);
    send(hub, held, 'approval.voided', { approvalId: one });
    expect([statusOf(hub, one), statusOf(hub, other)]).toEqual(['void', 'pending']);
    expect(findApproval(hub.ctx, one)?.decidedAt).toBe(hub.ctx.now());
    expect(eventsOf(hub, 'approval.voided').map((event) => event.data.approvalId)).toEqual([one]);
  });

  test("approval.voided naming another attempt's approval is logged and voids nothing", () => {
    const { hub, held } = setup();
    const theirs = requested(hub, held);
    const other = addRunnerAttempt(hub.ctx, { vendor: 'codex', runnerId: held.runner.id });
    send(hub, other, 'approval.voided', { approvalId: theirs });
    expect(statusOf(hub, theirs)).toBe('pending');
    expect(attemptLog(hub.ctx, other.attempt.id).at(-1)).toMatchObject({ kind: 'rejected' });
    expect(eventsOf(hub, 'approval.voided')).toEqual([]);
  });

  test("a resume or re-fence, and an ending, void the attempt's pending approvals", () => {
    const { hub, held } = setup();
    const first = requested(hub, held);
    resumeAttempt(hub.ctx, { attemptId: held.attempt.id, cause: 'runner_restart', prompt: 'Go on.' });
    expect(statusOf(hub, first)).toBe('void');
    updateAttempt(hub.ctx, held.attempt.id, { status: 'running' });
    const second = requested(hub, held);
    endAttempt(hub.ctx, { attemptId: held.attempt.id, trigger: 'crashed', error: 'boom' });
    expect(statusOf(hub, second)).toBe('void');
    expect(eventsOf(hub, 'approval.voided').map((event) => event.data.approvalId)).toEqual([first, second]);
  });

  test('a stop request voids those pending then; one raised during the handoff turn is relayed as usual', () => {
    const { hub, held } = setup();
    const before = requested(hub, held);
    requestStop(hub.ctx, { attemptId: held.attempt.id, cause: 'stop', reason: 'enough', by: 'user:alice' });
    expect(statusOf(hub, before)).toBe('void');
    const during = requested(hub, held);
    expect(statusOf(hub, during)).toBe('pending');
  });

  test('a deferred stop voids nothing until it applies', () => {
    const { hub, held } = setup();
    const id = requested(hub, held);
    const stop = { attemptId: held.attempt.id, cause: 'stop', reason: 'enough', by: 'user:alice' } as const;
    requestStop(hub.ctx, { ...stop, deferred: true });
    expect(statusOf(hub, id)).toBe('pending');
    // A failed submission applies it by requesting it again, not deferred.
    requestStop(hub.ctx, { ...stop, deferred: false });
    expect(statusOf(hub, id)).toBe('void');
  });

  test('an exit voids its approvals, whether or not it ends the attempt', () => {
    const { hub, held } = setup();
    // A holding attempt's process exits and the attempt holds on.
    updateAttempt(hub.ctx, held.attempt.id, { status: 'holding' });
    const holding = requested(hub, held);
    send(hub, held, 'attempt.exited', exited);
    expect(getAttempt(hub.ctx, held.attempt.id).status).toBe('holding');
    expect(statusOf(hub, holding)).toBe('void');

    // The exit of an attempt that already ended voids what is still pending of it.
    const ended = addRunnerAttempt(hub.ctx, { vendor: 'codex', runnerId: held.runner.id });
    const late = requested(hub, ended);
    endAttempt(hub.ctx, { attemptId: ended.attempt.id, trigger: 'crashed', error: 'boom' });
    hub.ctx.db.run(`UPDATE approvals SET status = 'pending' WHERE id = '${late}'`);
    send(hub, ended, 'attempt.exited', exited, ended.attempt.fence);
    expect(statusOf(hub, late)).toBe('void');
  });
});

describe('GET /api/approvals', () => {
  test("answers the caller's own approvals, filtered by a comma list of statuses, newest first", async () => {
    const { hub, held } = setup();
    const first = requested(hub, held);
    hub.clock.advance(1_000);
    const second = requested(hub, held);
    await decide(hub, first, { user: 'alice', via: 'web' });
    const list = (user: string, query = '') => hub.call('GET', `/api/approvals${query}`, { user, via: 'web' });
    const all = await list('alice');
    expect(all.json.approvals.map((one: { id: string }) => one.id)).toEqual([second, first]);
    const some = await list('alice', '?status=pending,declined');
    expect(some.json.approvals.map((one: { id: string }) => one.id)).toEqual([second]);
    expect((await list('bob')).json).toEqual({ approvals: [] });
    expect((await list('alice', '?status=maybe')).status).toBe(400);
  });
});

import { describe, expect, test } from 'bun:test';
import { type Agent, type AttemptStatus, leadAttemptId, restoreSet } from '@agflow/core';
import { getAgent, startLiveSession } from '../src/agents';
import { getAttempt, insertAttempt, issueFence, nextAttemptNumber, updateAttempt } from '../src/attempt-store';
import { mintAgentToken } from '../src/auth';
import { buildBrief } from '../src/brief';
import { type HubContext, tx } from '../src/context';
import { nextId } from '../src/db';
import { HubError } from '../src/errors';
import { listEvents } from '../src/events';
import { emptySeat, getHubState, holdsSeat, leadSeat, seatHolderId, takeSeat } from '../src/hub-state';
import { sendMessage, unreadFor } from '../src/messages';
import { getTask } from '../src/task-store';
import { createTasks } from '../src/tasks';
import { addAgent, addRunnerAttempt, createTestContext, newTask } from './helpers';
import { createTestHub } from './http-helpers';

const seatEvents = (ctx: HubContext) =>
  listEvents(ctx.db)
    .filter((event) => event.type === 'lead.seat_changed')
    .map((event) => event.data);

/** A runner lead with a lead attempt in the given status, seated the way the scheduler seats one. */
function seatRunnerLead(ctx: HubContext, status: AttemptStatus = 'running'): Agent {
  const { runner } = addRunnerAttempt(ctx);
  return tx(ctx, (emit) => {
    const seq = nextId(ctx.db, 'agent');
    const agentId = `A-${seq}`;
    const number = nextAttemptNumber(ctx, null);
    const fence = issueFence(ctx);
    const id = leadAttemptId(number, fence.epoch);
    ctx.db
      .query(
        `INSERT INTO agents (id, seq, login, vendor, role, origin, session_id, label, current_task, last_seen_at,
           created_at, runner_id, attempt_id)
         VALUES ($id, $seq, 'alice', 'claude', 'lead', 'runner', $session, $label, NULL, $now, $now, $runnerId, $attemptId)`,
      )
      .run({ id: agentId, seq, session: `runner-session-${seq}`, label: id, now: ctx.now(), runnerId: runner.id, attemptId: id });
    insertAttempt(ctx, {
      id,
      taskId: null,
      number,
      role: 'lead',
      agentId,
      runnerId: runner.id,
      vendor: 'claude',
      fence,
      status,
    });
    takeSeat(ctx, emit, agentId, 'runner', 'system');
    return getAgent(ctx, agentId);
  });
}

describe('the lead seat', () => {
  test('the first live lead request takes the seat and emits lead.seat_changed', () => {
    const { ctx } = createTestContext();
    const result = startLiveSession(ctx, 'alice', { vendor: 'claude', sessionId: 'lead', role: 'lead' });
    expect(result.agent.role).toBe('lead');
    expect(result.leadSeatTakenBy).toBeNull();
    expect(seatHolderId(ctx)).toBe(result.agent.id);
    expect(getHubState(ctx)).toMatchObject({ leadAgentId: result.agent.id, leadKind: 'live', leadSince: ctx.now() });
    expect(seatEvents(ctx)).toEqual([{ kind: 'live', agentId: result.agent.id, attemptId: null, runnerId: null }]);
    // The holder starting its session again keeps the seat without a new event.
    startLiveSession(ctx, 'alice', { vendor: 'claude', sessionId: 'lead', role: 'lead' });
    expect(seatEvents(ctx)).toHaveLength(1);
  });

  test('a second request becomes a worker with leadSeatTakenBy until the live lead is unseen for liveLeadGraceMs', () => {
    const { ctx, clock } = createTestContext();
    const lead = startLiveSession(ctx, 'alice', { vendor: 'claude', sessionId: 'lead', role: 'lead' });
    const second = startLiveSession(ctx, 'bob', { vendor: 'codex', sessionId: 'x', role: 'lead' });
    expect(second.agent.role).toBe('worker');
    expect(second.leadSeatTakenBy?.id).toBe(lead.agent.id);
    // M1's 15 minutes no longer free the seat.
    clock.advance(ctx.config.liveLeadGraceMs - 1);
    const third = startLiveSession(ctx, 'bob', { vendor: 'codex', sessionId: 'y', role: 'lead' });
    expect(third.leadSeatTakenBy?.id).toBe(lead.agent.id);
    clock.advance(1);
    expect(seatHolderId(ctx)).toBeNull();
    expect(leadSeat(ctx).kind).toBe('none');
    const next = startLiveSession(ctx, 'bob', { vendor: 'codex', sessionId: 'z', role: 'lead' });
    expect(next.agent.role).toBe('lead');
    expect(next.leadSeatTakenBy).toBeNull();
    expect(seatHolderId(ctx)).toBe(next.agent.id);
    expect(getAgent(ctx, lead.agent.id).role).toBe('worker');
  });

  test('the seat holder starting again as a worker empties the seat', () => {
    const { ctx } = createTestContext();
    const lead = startLiveSession(ctx, 'alice', { vendor: 'claude', sessionId: 'lead', role: 'lead' });
    startLiveSession(ctx, 'alice', { vendor: 'claude', sessionId: 'lead', role: 'worker' });
    expect(seatHolderId(ctx)).toBeNull();
    expect(getAgent(ctx, lead.agent.id).role).toBe('worker');
    expect(seatEvents(ctx).at(-1)).toEqual({ kind: 'none', agentId: null, attemptId: null, runnerId: null });
  });

  test('a chat asking while a runner lead holds the seat registers as a worker', () => {
    const { ctx, clock } = createTestContext();
    const runnerLead = seatRunnerLead(ctx);
    clock.advance(ctx.config.liveLeadGraceMs * 2);
    const chat = startLiveSession(ctx, 'alice', { vendor: 'claude', sessionId: 'chat', role: 'lead' });
    expect(chat.agent.role).toBe('worker');
    expect(chat.leadSeatTakenBy?.id).toBe(runnerLead.id);
    expect(seatHolderId(ctx)).toBe(runnerLead.id);
    expect(getAgent(ctx, runnerLead.id).role).toBe('lead');
  });

  test('a runner lead holds the seat while starting, running, quota_wait or holding', () => {
    const { ctx } = createTestContext();
    const runnerLead = seatRunnerLead(ctx, 'starting');
    for (const status of ['starting', 'running', 'quota_wait', 'holding'] as const) {
      updateAttempt(ctx, runnerLead.attemptId as string, { status });
      expect([status, holdsSeat(ctx, runnerLead.id)]).toEqual([status, true]);
    }
    updateAttempt(ctx, runnerLead.attemptId as string, { status: 'ended', endReason: 'lost' });
    expect(holdsSeat(ctx, runnerLead.id)).toBe(false);
  });

  test("a session id of a runner agent is refused with 409", () => {
    const { ctx } = createTestContext();
    const runnerLead = seatRunnerLead(ctx);
    let refusal: unknown;
    try {
      startLiveSession(ctx, 'alice', { vendor: 'claude', sessionId: runnerLead.sessionId as string, role: 'lead' });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(HubError);
    expect((refusal as HubError).status).toBe(409);
    expect(seatHolderId(ctx)).toBe(runnerLead.id);
  });

  test('emptySeat clears the seat, or only when it names the given agent', () => {
    const { ctx } = createTestContext();
    const runnerLead = seatRunnerLead(ctx);
    expect(leadSeat(ctx)).toEqual({
      kind: 'runner',
      agentId: runnerLead.id,
      attemptId: runnerLead.attemptId,
      runnerId: runnerLead.runnerId,
      since: ctx.now(),
      wakeups: 0,
      runnerLeads: true,
    });
    expect(seatEvents(ctx).at(-1)).toEqual({
      kind: 'runner',
      agentId: runnerLead.id,
      attemptId: runnerLead.attemptId,
      runnerId: runnerLead.runnerId,
    });
    updateAttempt(ctx, runnerLead.attemptId as string, { wakeups: 3 });
    expect(leadSeat(ctx).wakeups).toBe(3);
    expect(tx(ctx, (emit) => emptySeat(ctx, emit, 'system', 'A-999'))).toBe(false);
    expect(seatHolderId(ctx)).toBe(runnerLead.id);
    expect(tx(ctx, (emit) => emptySeat(ctx, emit, 'system', runnerLead.id))).toBe(true);
    expect(getHubState(ctx)).toMatchObject({ leadAgentId: null, leadKind: null, leadSince: null });
    expect(seatEvents(ctx).at(-1)).toEqual({ kind: 'none', agentId: null, attemptId: null, runnerId: null });
    expect(tx(ctx, (emit) => emptySeat(ctx, emit, 'system'))).toBe(false);
  });
});

describe('lead authority comes from the seat', () => {
  test('a role column of lead without the seat is refused on lead routes and messages to all', async () => {
    const hub = createTestHub();
    const lead = addAgent(hub.ctx, 'alice', 'lead');
    const pretender = addAgent(hub.ctx, 'bob');
    hub.ctx.db.query("UPDATE agents SET role = 'lead' WHERE id = $id").run({ id: pretender.id });
    const task = { tasks: [{ title: 'T', objective: 'O', acceptance: [{ id: 'A1', assertion: 'works' }] }] };
    const refused = await hub.call('POST', '/api/tasks', { user: 'bob', agent: pretender.id, body: task });
    expect([refused.status, refused.json.message]).toEqual([403, 'only the lead or a person can do this']);
    const note = await hub.call('POST', '/api/goal/notes', { user: 'bob', agent: pretender.id, body: { text: 'x' } });
    expect(note.status).toBe(403);
    const all = await hub.call('POST', '/api/messages', { user: 'bob', agent: pretender.id, body: { to: 'all', body: 'hi' } });
    expect(all.status).toBe(403);
    expect((await hub.call('POST', '/api/tasks', { user: 'alice', agent: lead.id, body: task })).status).toBe(201);
    expect(
      (await hub.call('POST', '/api/messages', { user: 'alice', agent: lead.id, body: { to: 'all', body: 'hi' } })).status,
    ).toBe(201);
  });

  test('a runner lead that holds the seat may use lead routes; its role column is not what counts', async () => {
    const hub = createTestHub();
    const runnerLead = seatRunnerLead(hub.ctx);
    const live = addAgent(hub.ctx, 'alice');
    hub.ctx.db.query("UPDATE agents SET role = 'lead' WHERE id = $id").run({ id: live.id });
    const task = { tasks: [{ title: 'T', objective: 'O', acceptance: [{ id: 'A1', assertion: 'works' }] }] };
    expect((await hub.call('POST', '/api/tasks', { user: 'alice', agent: live.id, body: task })).status).toBe(403);
    const attempt = getAttempt(hub.ctx, runnerLead.attemptId as string);
    const auth = { headers: { authorization: `Bearer ${mintAgentToken(hub.ctx, attempt)}` } };
    expect((await hub.call('POST', '/api/tasks', { ...auth, body: task })).status).toBe(201);
    hub.ctx.db.query("UPDATE agents SET role = 'worker' WHERE id = $id").run({ id: runnerLead.id });
    expect((await hub.call('POST', '/api/goal/notes', { ...auth, body: { text: 'v2 means the new API' } })).status).toBe(201);
  });

  test('only a person can give a task people-only paths; the seated runner lead and a live lead are refused', async () => {
    const hub = createTestHub();
    const [task] = createTasks(hub.ctx, [newTask({ ownedPaths: ['src/parser/**'] })], 'user:alice');
    if (!task) throw new Error('no task');
    const runnerLead = seatRunnerLead(hub.ctx);
    const token = mintAgentToken(hub.ctx, getAttempt(hub.ctx, runnerLead.attemptId as string));
    const auth = { headers: { authorization: `Bearer ${token}` } };
    const widen = { ownedPaths: ['src/parser/**', '.github/**'] };
    const refused = await hub.call('PATCH', `/api/tasks/${task.id}`, { ...auth, body: widen });
    expect([refused.status, refused.json.message]).toEqual([403, 'only a person can give a task people-only paths']);
    expect(restoreSet(getTask(hub.ctx, task.id))).toContain('.github/workflows/**');
    // Paths outside the class stay the lead's to change.
    const narrow = await hub.call('PATCH', `/api/tasks/${task.id}`, { ...auth, body: { ownedPaths: ['src/**'] } });
    expect(narrow.status).toBe(200);

    tx(hub.ctx, (emit) => emptySeat(hub.ctx, emit, 'system'));
    const live = await hub.liveAgent('alice', 'lead-chat', 'lead');
    const liveRefused = await hub.call('PATCH', `/api/tasks/${task.id}`, { user: 'alice', agent: live, body: widen });
    expect([liveRefused.status, liveRefused.json.message]).toEqual([403, 'only a person can give a task people-only paths']);

    const person = await hub.call('PATCH', `/api/tasks/${task.id}`, { user: 'alice', via: 'web', body: widen });
    expect(person.status).toBe(200);
    expect(restoreSet(getTask(hub.ctx, task.id))).not.toContain('.github/workflows/**');
  });

  test('a lead route checks the seat again once the body has arrived', async () => {
    const hub = createTestHub();
    const lead = await hub.liveAgent('alice', 'lead-chat', 'lead');
    const body = { tasks: [{ title: 'T', objective: 'O', acceptance: [{ id: 'A1', assertion: 'works' }] }] };
    // The stream gives its body only when the route reads it, after the first seat check.
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          tx(hub.ctx, (emit) => emptySeat(hub.ctx, emit, 'user:alice'));
          controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const answer = await hub.app.request('/api/tasks', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${hub.tokenFor('alice', 'cli')}`,
        'x-agflow-agent': lead,
        'content-type': 'application/json',
      },
      body: stream,
    });
    expect(answer.status).toBe(403);
    expect(hub.ctx.db.query('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 0 });
  });

  test('lead messages are unread only for the seat holder', () => {
    const { ctx } = createTestContext();
    const lead = addAgent(ctx, 'alice', 'lead');
    const pretender = addAgent(ctx, 'bob');
    ctx.db.query("UPDATE agents SET role = 'lead' WHERE id = $id").run({ id: pretender.id });
    sendMessage(ctx, { from: 'user:alice', to: 'lead', body: 'Plan the goal.' });
    expect(unreadFor(ctx, getAgent(ctx, pretender.id))).toEqual([]);
    expect(unreadFor(ctx, getAgent(ctx, lead.id)).map((message) => message.body)).toEqual(['Plan the goal.']);
  });

  test("the brief's role follows the seat", () => {
    const { ctx, clock } = createTestContext();
    const lead = addAgent(ctx, 'alice', 'lead');
    const pretender = addAgent(ctx, 'bob');
    ctx.db.query("UPDATE agents SET role = 'lead' WHERE id = $id").run({ id: pretender.id });
    expect(buildBrief(ctx, getAgent(ctx, lead.id))).toContain('the lead manager');
    const pretenderBrief = buildBrief(ctx, getAgent(ctx, pretender.id));
    expect(pretenderBrief).toContain(', a worker,');
    expect(pretenderBrief).not.toContain('## Your duties as lead');
    clock.advance(ctx.config.liveLeadGraceMs);
    expect(buildBrief(ctx, getAgent(ctx, lead.id))).toContain(', a worker,');
  });
});

describe('GET /api/status', () => {
  test('reports the seat, the epoch, and the seat holder as the lead', async () => {
    const hub = createTestHub();
    const empty = await hub.call('GET', '/api/status', { user: 'bob' });
    expect(empty.json).toMatchObject({
      lead: null,
      leadSeat: { kind: 'none', agentId: null, attemptId: null, runnerId: null, since: null, wakeups: 0, runnerLeads: true },
      epoch: 1,
    });
    const runnerLead = seatRunnerLead(hub.ctx);
    hub.ctx.db.run('UPDATE project SET epoch = 2');
    const seated = await hub.call('GET', '/api/status', { user: 'bob' });
    expect(seated.json.lead).toMatchObject({ id: runnerLead.id, origin: 'runner' });
    expect(seated.json.leadSeat).toMatchObject({ kind: 'runner', agentId: runnerLead.id, attemptId: runnerLead.attemptId });
    expect(seated.json.epoch).toBe(2);
  });
});

import { describe, expect, test } from 'bun:test';
import { LeadNotesResponseSchema, OkResponseSchema, ProjectSchema, type RawRunnerEvent } from '@agflow/core';
import { startLiveSession } from '../src/agents';
import { getAttempt, updateAttempt } from '../src/attempt-store';
import { mintAgentToken } from '../src/auth';
import { pendingCommands } from '../src/commands';
import { listEvents } from '../src/events';
import { applyRunnerEvents } from '../src/events-in';
import { seatHolderId } from '../src/hub-state';
import { runTick } from '../src/scheduler';
import { addAgent, addLeadNote, addRunnerAttempt, addRunnerLead } from './helpers';
import { createTestHub } from './http-helpers';

type Hub = ReturnType<typeof createTestHub>;

const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });
const asPerson = { user: 'alice', via: 'web' } as const;

const leadNotes = (hub: Hub) =>
  hub.ctx.db.query('SELECT attempt_id, kind, body, author FROM lead_notes ORDER BY id').all() as {
    attempt_id: string | null;
    kind: string;
    body: string;
    author: string;
  }[];

/** A hub with a runner worker and a runner lead holding the seat, and both agents' tokens. */
function setup() {
  const hub = createTestHub();
  const worker = addRunnerAttempt(hub.ctx);
  const lead = addRunnerLead(hub.ctx);
  return {
    hub,
    worker,
    lead,
    leadToken: mintAgentToken(hub.ctx, lead.attempt),
    workerToken: mintAgentToken(hub.ctx, worker.attempt),
  };
}

describe('POST /api/lead/handoff', () => {
  test('the seat holder stores a lead handoff with its attempt id', async () => {
    const { hub, lead, leadToken } = setup();
    const answer = await hub.call('POST', '/api/lead/handoff', {
      ...bearer(leadToken),
      body: { note: 'Next: review T-3, then plan the CLI.' },
    });
    expect([answer.status, OkResponseSchema.parse(answer.json)]).toEqual([200, { ok: true }]);
    expect(leadNotes(hub)).toEqual([
      {
        attempt_id: lead.attempt.id,
        kind: 'handoff',
        body: 'Next: review T-3, then plan the CLI.',
        author: `agent:${lead.agent.id}`,
      },
    ]);
  });

  test('a live lead holding the seat stores one with no attempt id', async () => {
    const hub = createTestHub();
    const live = addAgent(hub.ctx, 'alice', 'lead');
    const body = { note: 'Bye.' };
    const answer = await hub.call('POST', '/api/lead/handoff', { user: 'alice', agent: live.id, body });
    expect(answer.status).toBe(200);
    expect(leadNotes(hub)).toEqual([{ attempt_id: null, kind: 'handoff', body: 'Bye.', author: `agent:${live.id}` }]);
  });

  test('other agents and people are refused; an empty note is a 400', async () => {
    const { hub, leadToken, workerToken } = setup();
    const worker = await hub.call('POST', '/api/lead/handoff', { ...bearer(workerToken), body: { note: 'Me?' } });
    expect(worker.status).toBe(403);
    const person = await hub.call('POST', '/api/lead/handoff', { ...asPerson, body: { note: 'From alice.' } });
    expect(person.status).toBe(403);
    const empty = await hub.call('POST', '/api/lead/handoff', { ...bearer(leadToken), body: { note: '' } });
    expect(empty.status).toBe(400);
    expect(leadNotes(hub)).toEqual([]);
  });
});

describe('GET /api/lead/notes', () => {
  test('answers { notes }, newest first, to the seat holder and to people; other agents are refused', async () => {
    const { hub, lead, leadToken, workerToken } = setup();
    addLeadNote(hub.ctx, { attemptId: 'lead-a7', body: 'The first.', author: 'system' });
    hub.clock.advance(1);
    addLeadNote(hub.ctx, { attemptId: lead.attempt.id, kind: 'restatement', body: 'I lead.', author: 'agent:A-9' });
    for (const options of [bearer(leadToken), asPerson, { user: 'bob' }]) {
      const answer = await hub.call('GET', '/api/lead/notes', options);
      expect(answer.status).toBe(200);
      const { notes } = LeadNotesResponseSchema.parse(answer.json);
      expect(notes.map((note) => [note.kind, note.body, note.attemptId])).toEqual([
        ['restatement', 'I lead.', lead.attempt.id],
        ['handoff', 'The first.', 'lead-a7'],
      ]);
    }
    expect((await hub.call('GET', '/api/lead/notes', bearer(workerToken))).status).toBe(403);
    expect((await hub.call('GET', '/api/lead/notes')).status).toBe(401);
  });

  test('answers the 20 newest only', async () => {
    const { hub } = setup();
    for (let n = 1; n <= 21; n++) {
      addLeadNote(hub.ctx, { attemptId: null, body: `Note ${n}.`, author: 'system' });
      hub.clock.advance(1);
    }
    const { notes } = LeadNotesResponseSchema.parse((await hub.call('GET', '/api/lead/notes', asPerson)).json);
    expect(notes.map((note) => note.body)).toEqual(Array.from({ length: 20 }, (_, n) => `Note ${21 - n}.`));
  });
});

describe('PATCH /api/project', () => {
  let seq = 0;

  /** The runner reports the lead's process gone after its handoff turn. */
  function exited(hub: Hub, attemptId: string): void {
    const attempt = getAttempt(hub.ctx, attemptId);
    const raw = {
      seq: ++seq,
      at: hub.ctx.now(),
      type: 'attempt.exited',
      attemptId,
      fence: attempt.fence,
      data: {
        code: 0,
        signal: null,
        stoppedBy: 'close',
        handoffWritten: true,
        cause: null,
        finalSha: null,
        finalWip: null,
        pushError: null,
      },
    } as RawRunnerEvent;
    const batch = { outboxEpoch: 'outbox-1', events: [raw] };
    applyRunnerEvents(hub.ctx, attempt.runnerId as string, batch, { restoreReplay: false });
    expect(hub.ctx.db.query('SELECT error FROM runner_event_rejects').all()).toEqual([]);
  }

  test('runner leads off rotate the runner lead out, so a live lead can take the seat; on lets one start', async () => {
    const { hub, lead } = setup();
    const off = await hub.call('PATCH', '/api/project', { ...asPerson, body: { runnerLeads: false } });
    expect(off.status).toBe(200);
    expect(ProjectSchema.parse(off.json).runnerLeads).toBe(false);
    expect(getAttempt(hub.ctx, lead.attempt.id).stopRequested).toMatchObject({ cause: 'rotation', handoff: true });
    const stops = pendingCommands(hub.ctx, lead.attempt.runnerId as string, 1).filter(
      (row) => row.command.kind === 'stop_attempt' && row.command.attemptId === lead.attempt.id,
    );
    expect(stops).toHaveLength(1);
    const [rotated] = listEvents(hub.ctx.db).filter((event) => event.type === 'lead.rotated');
    expect([rotated?.actor, rotated?.data.attemptId]).toEqual(['user:alice', lead.attempt.id]);
    // Turning it off again asks nothing more.
    await hub.call('PATCH', '/api/project', { ...asPerson, body: { runnerLeads: false } });
    expect(listEvents(hub.ctx.db).filter((event) => event.type === 'lead.rotated')).toHaveLength(1);

    exited(hub, lead.attempt.id);
    expect(getAttempt(hub.ctx, lead.attempt.id).endReason).toBe('rotated');
    expect(seatHolderId(hub.ctx)).toBeNull();
    // No runner lead starts while they are off, and a person's live lead takes the seat.
    expect(runTick(hub.ctx).lead).toBeNull();
    const live = startLiveSession(hub.ctx, 'alice', { vendor: 'claude', sessionId: 'chat-1', role: 'lead' });
    expect(live.leadSeatTakenBy).toBeNull();
    expect(seatHolderId(hub.ctx)).toBe(live.agent.id);

    const on = await hub.call('PATCH', '/api/project', { ...asPerson, body: { runnerLeads: true } });
    expect(on.json.runnerLeads).toBe(true);
    // The live lead keeps the seat; once it is empty, the next tick starts a runner lead.
    expect(runTick(hub.ctx).lead).toBeNull();
    hub.clock.advance(hub.ctx.config.liveLeadGraceMs);
    expect(runTick(hub.ctx).lead).toMatchObject({ role: 'lead', status: 'starting' });
  });

  test('a holding runner lead has no process for a handoff turn: it ends rotated at once', async () => {
    const { hub, lead } = setup();
    updateAttempt(hub.ctx, lead.attempt.id, { status: 'holding', leaseExpiresAt: null });
    await hub.call('PATCH', '/api/project', { ...asPerson, body: { runnerLeads: false } });
    expect(getAttempt(hub.ctx, lead.attempt.id)).toMatchObject({ status: 'ended', endReason: 'rotated' });
    expect(seatHolderId(hub.ctx)).toBeNull();
    // The hub assembled the lead handoff the next lead starts from.
    expect(leadNotes(hub).map((note) => [note.attempt_id, note.author])).toEqual([[lead.attempt.id, 'system']]);
  });

  test('only a person in a browser may change it; a bad body is a 400', async () => {
    const { hub, lead, leadToken } = setup();
    const body = { runnerLeads: false };
    expect((await hub.call('PATCH', '/api/project', { user: 'alice', body })).status).toBe(403);
    expect((await hub.call('PATCH', '/api/project', { ...bearer(leadToken), body })).status).toBe(403);
    const bad = await hub.call('PATCH', '/api/project', { ...asPerson, body: { runnerLeads: 'no' } });
    expect(bad.status).toBe(400);
    const extra = await hub.call('PATCH', '/api/project', { ...asPerson, body: { runnerLeads: false, name: 'x' } });
    expect(extra.status).toBe(400);
    expect(getAttempt(hub.ctx, lead.attempt.id).stopRequested).toBeNull();
    expect((await hub.call('GET', '/api/project', { user: 'bob' })).json.runnerLeads).toBe(true);
  });
});

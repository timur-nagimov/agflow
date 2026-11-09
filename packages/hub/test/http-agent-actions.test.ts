import { describe, expect, test } from 'bun:test';
import { AttemptResponseSchema, OkResponseSchema } from '@agflow/core';
import { getAttempt, updateAttempt } from '../src/attempt-store';
import { onExited } from '../src/attempts';
import { mintAgentToken } from '../src/auth';
import { pendingCommands } from '../src/commands';
import { tx } from '../src/context';
import { listEvents } from '../src/events';
import { seatHolderId } from '../src/hub-state';
import { requestSubmission } from '../src/submissions';
import { getTask, writeTask } from '../src/task-store';
import { type RunnerAttempt, addRunnerAttempt, addRunnerLead } from './helpers';
import { createTestHub } from './http-helpers';

type Hub = ReturnType<typeof createTestHub>;

const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });
const asPerson = { user: 'alice', via: 'web' } as const;

const commandsOf = (hub: Hub, runnerId: string, kind: string) =>
  pendingCommands(hub.ctx, runnerId, 1)
    .map((row) => row.command)
    .filter((command) => command.kind === kind);

const eventsOf = (hub: Hub, type: string) => listEvents(hub.ctx.db).filter((event) => event.type === type);

/** A hub with a running runner worker and a runner lead holding the seat, and the lead's agent token. */
function setup() {
  const hub = createTestHub();
  const worker = addRunnerAttempt(hub.ctx);
  const lead = addRunnerLead(hub.ctx);
  const leadToken = mintAgentToken(hub.ctx, lead.attempt);
  return { hub, worker, lead, leadToken };
}

/** The runner reports the attempt's process gone, as it does once a stop completes. */
function exited(hub: Hub, attemptId: string): void {
  const attempt = getAttempt(hub.ctx, attemptId);
  const data = {
    code: 0,
    signal: null,
    stoppedBy: 'close',
    handoffWritten: true,
    cause: null,
    finalSha: null,
    finalWip: null,
    pushError: null,
  } as const;
  tx(hub.ctx, (emit) => onExited(hub.ctx, emit, attempt, data));
}

describe('POST /api/agents/:id/stop and /replace', () => {
  test('a person stops a runner worker: { attempt } with the stop recorded and sent, and agent.stopped', async () => {
    const { hub, worker } = setup();
    const answer = await hub.call('POST', `/api/agents/${worker.agent.id}/stop`, {
      ...asPerson,
      body: { reason: 'Wrong approach.' },
    });
    expect(answer.status).toBe(200);
    const { attempt } = AttemptResponseSchema.parse(answer.json);
    expect(attempt).toMatchObject({ id: worker.attempt.id, status: 'running' });
    expect(attempt.stopRequested).toMatchObject({ cause: 'stop', reason: 'Wrong approach.', by: 'user:alice' });
    expect(commandsOf(hub, worker.runner.id, 'stop_attempt')).toMatchObject([{ cause: 'stop', keepClone: false }]);
    expect(eventsOf(hub, 'agent.stopped').map((event) => [event.actor, event.data.cause])).toEqual([
      ['user:alice', 'stop'],
    ]);
  });

  test('hold makes it a stop and hold: the task is paused at once', async () => {
    const { hub, worker } = setup();
    const answer = await hub.call('POST', `/api/agents/${worker.agent.id}/stop`, {
      ...asPerson,
      body: { reason: 'Wait for me.', hold: true },
    });
    expect(answer.json.attempt.stopRequested).toMatchObject({ cause: 'stop_hold' });
    expect(commandsOf(hub, worker.runner.id, 'stop_attempt')).toMatchObject([{ cause: 'stop_hold', keepClone: true }]);
    expect(getTask(hub.ctx, worker.task.id)).toMatchObject({ status: 'blocked', blockedKind: 'paused' });
  });

  test('replace records a replace, and agent.replaced', async () => {
    const { hub, worker } = setup();
    const answer = await hub.call('POST', `/api/agents/${worker.agent.id}/replace`, {
      ...asPerson,
      body: { reason: 'Start over.' },
    });
    expect(answer.status).toBe(200);
    expect(answer.json.attempt.stopRequested).toMatchObject({ cause: 'replace', reason: 'Start over.' });
    expect(eventsOf(hub, 'agent.replaced')).toHaveLength(1);
    exited(hub, worker.attempt.id);
    expect(getAttempt(hub.ctx, worker.attempt.id)).toMatchObject({ status: 'ended', endReason: 'replaced' });
    expect(getTask(hub.ctx, worker.task.id).status).toBe('ready');
  });

  test('a stop held back for a pending submission answers 202 { attempt }, recorded as deferred', async () => {
    const { hub, worker } = setup();
    writeTask(hub.ctx, worker.task.id, { branch: 'agflow/T-1-task' });
    requestSubmission(hub.ctx, worker.task.id, worker.agent, { summary: 'Done.', evidence: [] });
    for (const route of ['stop', 'replace']) {
      const answer = await hub.call('POST', `/api/agents/${worker.agent.id}/${route}`, {
        ...asPerson,
        body: { reason: 'Enough.' },
      });
      expect([route, answer.status]).toEqual([route, 202]);
      // Each request replaces the deferred one before it.
      const { stopRequested } = AttemptResponseSchema.parse(answer.json).attempt;
      expect(stopRequested).toMatchObject({ cause: route, deferred: true });
    }
    expect(commandsOf(hub, worker.runner.id, 'stop_attempt')).toEqual([]);
  });

  test('the seat holder may stop, hold or replace runner workers', async () => {
    const { hub, worker, lead, leadToken } = setup();
    const hold = await hub.call('POST', `/api/agents/${worker.agent.id}/stop`, {
      ...bearer(leadToken),
      body: { reason: 'Pause this.', hold: true },
    });
    expect(hold.status).toBe(200);
    expect(hold.json.attempt.stopRequested).toMatchObject({ cause: 'stop_hold', by: `agent:${lead.agent.id}` });
    const other = addRunnerAttempt(hub.ctx);
    const replace = await hub.call('POST', `/api/agents/${other.agent.id}/replace`, {
      ...bearer(leadToken),
      body: { reason: 'Try again.' },
    });
    expect(replace.json.attempt.stopRequested).toMatchObject({ cause: 'replace', by: `agent:${lead.agent.id}` });
  });

  test('the seat holder cannot stop or replace a lead, itself included; other agents are refused', async () => {
    const { hub, worker, lead, leadToken } = setup();
    for (const route of ['stop', 'replace']) {
      const self = await hub.call('POST', `/api/agents/${lead.agent.id}/${route}`, {
        ...bearer(leadToken),
        body: { reason: 'Me?' },
      });
      expect([route, self.status, self.json.error]).toEqual([route, 403, 'forbidden']);
    }
    const workerToken = mintAgentToken(hub.ctx, worker.attempt);
    const other = addRunnerAttempt(hub.ctx);
    const byWorker = await hub.call('POST', `/api/agents/${other.agent.id}/stop`, {
      ...bearer(workerToken),
      body: { reason: 'Stop.' },
    });
    expect([byWorker.status, byWorker.json.error]).toEqual([403, 'forbidden']);
    const live = await hub.liveAgent('alice', 'session-1');
    const byLive = await hub.call('POST', `/api/agents/${other.agent.id}/replace`, {
      user: 'alice',
      agent: live,
      body: { reason: 'Stop.' },
    });
    expect([byLive.status, byLive.json.error]).toEqual([403, 'forbidden']);
    const body = { reason: 'Stop.' };
    const byCli = await hub.call('POST', `/api/agents/${other.agent.id}/stop`, { user: 'alice', body });
    expect(byCli.status).toBe(403);
    expect(getAttempt(hub.ctx, other.attempt.id).stopRequested).toBeNull();
    expect(getAttempt(hub.ctx, lead.attempt.id).stopRequested).toBeNull();
  });

  test('a live chat gets 409 (use Release); an unknown agent 404; an ended attempt 409', async () => {
    const { hub, worker } = setup();
    const live = await hub.liveAgent('bob', 'session-2');
    for (const route of ['stop', 'replace']) {
      const answer = await hub.call('POST', `/api/agents/${live}/${route}`, { ...asPerson, body: { reason: 'x' } });
      expect([route, answer.status, answer.json.error]).toEqual([route, 409, 'conflict']);
    }
    const unknown = await hub.call('POST', '/api/agents/A-99/stop', { ...asPerson, body: { reason: 'x' } });
    expect(unknown.status).toBe(404);
    await hub.call('POST', `/api/agents/${worker.agent.id}/stop`, { ...asPerson, body: { reason: 'x' } });
    exited(hub, worker.attempt.id);
    const again = await hub.call('POST', `/api/agents/${worker.agent.id}/stop`, { ...asPerson, body: { reason: 'x' } });
    expect([again.status, again.json.error]).toEqual([409, 'conflict']);
  });

  test('a person stopping or replacing a runner lead ends it on exit and empties the seat', async () => {
    for (const [route, endReason] of [
      ['stop', 'stopped'],
      ['replace', 'replaced'],
    ] as const) {
      const { hub, lead } = setup();
      const answer = await hub.call('POST', `/api/agents/${lead.agent.id}/${route}`, {
        ...asPerson,
        body: { reason: 'New lead.' },
      });
      expect([route, answer.status]).toEqual([route, 200]);
      // The lead's handoff turn writes its lead note before it exits.
      expect(commandsOf(hub, lead.attempt.runnerId as string, 'stop_attempt')).toMatchObject([{ handoff: true }]);
      expect(seatHolderId(hub.ctx)).toBe(lead.agent.id);
      exited(hub, lead.attempt.id);
      expect(getAttempt(hub.ctx, lead.attempt.id)).toMatchObject({ status: 'ended', endReason });
      expect(seatHolderId(hub.ctx)).toBeNull();
    }
  });

  test('hold on a lead gets 409, whoever asks', async () => {
    const { hub, lead } = setup();
    const answer = await hub.call('POST', `/api/agents/${lead.agent.id}/stop`, {
      ...asPerson,
      body: { reason: 'Hold.', hold: true },
    });
    expect([answer.status, answer.json.error]).toEqual([409, 'conflict']);
    expect(getAttempt(hub.ctx, lead.attempt.id).stopRequested).toBeNull();
  });

  test('a body without a reason gets 400', async () => {
    const { hub, worker } = setup();
    const answer = await hub.call('POST', `/api/agents/${worker.agent.id}/stop`, { ...asPerson, body: {} });
    expect(answer.status).toBe(400);
  });
});

describe('POST /api/agents/:id/interrupt', () => {
  test('a person sends interrupt to a runner agent at its current fence', async () => {
    const { hub, worker, lead } = setup();
    for (const held of [worker, lead] as Pick<RunnerAttempt, 'agent' | 'attempt'>[]) {
      const answer = await hub.call('POST', `/api/agents/${held.agent.id}/interrupt`, asPerson);
      expect([answer.status, OkResponseSchema.parse(answer.json)]).toEqual([200, { ok: true }]);
      expect(commandsOf(hub, held.attempt.runnerId as string, 'interrupt')).toEqual([
        { kind: 'interrupt', attemptId: held.attempt.id, fence: held.attempt.fence },
      ]);
    }
  });

  test('only a person in a browser; a live chat or an agent with no process gets 409', async () => {
    const { hub, worker, leadToken } = setup();
    const cli = await hub.call('POST', `/api/agents/${worker.agent.id}/interrupt`, { user: 'alice' });
    expect(cli.status).toBe(403);
    const byLead = await hub.call('POST', `/api/agents/${worker.agent.id}/interrupt`, bearer(leadToken));
    expect([byLead.status, byLead.json.error]).toEqual([403, 'agent_not_allowed']);
    const live = await hub.liveAgent('bob', 'session-3');
    const answer = await hub.call('POST', `/api/agents/${live}/interrupt`, asPerson);
    expect([answer.status, answer.json.error]).toEqual([409, 'conflict']);
    updateAttempt(hub.ctx, worker.attempt.id, { status: 'holding', leaseExpiresAt: null });
    const holding = await hub.call('POST', `/api/agents/${worker.agent.id}/interrupt`, asPerson);
    expect([holding.status, holding.json.error]).toEqual([409, 'conflict']);
    expect(commandsOf(hub, worker.runner.id, 'interrupt')).toEqual([]);
  });
});

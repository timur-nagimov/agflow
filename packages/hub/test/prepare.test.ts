import { describe, expect, test } from 'bun:test';
import type { RawRunnerEvent, RunnerEventData } from '@agflow/core';
import { attemptLog, getAttempt, updateAttempt } from '../src/attempt-store';
import { endAttempt, requestStop, resumeAttempt } from '../src/attempts';
import { mintAgentToken } from '../src/auth';
import { findCommand, recordResult } from '../src/commands';
import { listEvents } from '../src/events';
import { applyRunnerEvents } from '../src/events-in';
import { type RunnerAttempt, addRunnerAttempt, addRunnerLead } from './helpers';
import { createTestHub } from './http-helpers';

type Hub = ReturnType<typeof createTestHub>;

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** A hub with a running runner worker and its agent token. */
function setup() {
  const hub = createTestHub();
  const held = addRunnerAttempt(hub.ctx);
  const token = mintAgentToken(hub.ctx, held.attempt);
  return { hub, held, token };
}

/** The prepare_dependencies commands queued so far. */
const prepares = (hub: Hub) => hub.ctx.db.query("SELECT id FROM runner_commands WHERE kind = 'prepare_dependencies'").all();
const request = (hub: Hub, token: string) => hub.call('POST', '/api/prepare', { headers: bearer(token), body: {} });
const poll = (hub: Hub, id: string, options: Parameters<Hub['call']>[2]) =>
  hub.call('GET', `/api/prepare/${id}`, options);

let seq = 0;

/** The runner reports a preparation of the attempt, at its fence as the hub has it now. */
function prepared(hub: Hub, held: RunnerAttempt, data: RunnerEventData['attempt.prepared']): void {
  const raw: RawRunnerEvent = {
    seq: ++seq,
    at: hub.ctx.now(),
    type: 'attempt.prepared',
    attemptId: held.attempt.id,
    fence: getAttempt(hub.ctx, held.attempt.id).fence,
    data,
  };
  applyRunnerEvents(hub.ctx, held.runner.id, { outboxEpoch: 'outbox-1', events: [raw] }, { restoreReplay: false });
  expect(hub.ctx.db.query('SELECT error FROM runner_event_rejects').all()).toEqual([]);
}

describe('POST /api/prepare', () => {
  test('answers 202 { request } and sends prepare_dependencies at the fence, with the command id as requestId', async () => {
    const { hub, held, token } = setup();
    const answer = await request(hub, token);
    expect(answer.status).toBe(202);
    const id = answer.json.request.id as string;
    expect(answer.json).toEqual({
      request: {
        id,
        attemptId: held.attempt.id,
        status: 'pending',
        error: null,
        logTail: null,
        requestedAt: hub.ctx.now(),
        finishedAt: null,
      },
    });
    expect(findCommand(hub.ctx, id)?.command).toEqual({
      kind: 'prepare_dependencies',
      attemptId: held.attempt.id,
      fence: held.attempt.fence,
      requestId: id,
    });
  });

  test('an attempt that is not running is refused, and so are a lead and anyone without an agent token', async () => {
    const { hub, held, token } = setup();
    for (const status of ['starting', 'quota_wait', 'holding'] as const) {
      updateAttempt(hub.ctx, held.attempt.id, { status });
      const refused = await request(hub, token);
      expect([status, refused.status]).toEqual([status, 409]);
    }
    const lead = addRunnerLead(hub.ctx);
    expect((await request(hub, mintAgentToken(hub.ctx, lead.attempt))).status).toBe(403);
    expect((await hub.call('POST', '/api/prepare', { user: 'alice', via: 'web', body: {} })).status).toBe(403);
    const ended = addRunnerAttempt(hub.ctx);
    const endedToken = mintAgentToken(hub.ctx, ended.attempt);
    endAttempt(hub.ctx, { attemptId: ended.attempt.id, trigger: 'crashed', error: 'boom' });
    expect((await request(hub, endedToken)).json.error).toBe('attempt_ended');
    expect(hub.ctx.db.query("SELECT 1 FROM runner_commands WHERE kind = 'prepare_dependencies'").all()).toEqual([]);
  });
  test('a second request while one is pending answers that one, and queues nothing more', async () => {
    const { hub, held, token } = setup();
    const first = await request(hub, token);
    hub.clock.advance(60_000);
    const again = await request(hub, token);
    expect(again.status).toBe(202);
    expect(again.json).toEqual(first.json);
    expect(prepares(hub)).toHaveLength(1);
    // Once the runner reported it, the agent may ask again.
    prepared(hub, held, { requestId: first.json.request.id, ok: false, error: 'timed out', logTail: null });
    expect((await request(hub, token)).json.request.id).not.toBe(first.json.request.id);
    expect(prepares(hub)).toHaveLength(2);
  });

  test('a request after a stop or a take-over was recorded is refused, and queues nothing', async () => {
    for (const cause of ['stop', 'takeover'] as const) {
      const { hub, held, token } = setup();
      requestStop(hub.ctx, { attemptId: held.attempt.id, cause, reason: 'enough', by: 'user:alice' });
      const refused = await request(hub, token);
      expect([cause, refused.status, refused.json.error]).toEqual([cause, 409, 'conflict']);
      expect(refused.json.message).toContain('being stopped');
      expect(prepares(hub)).toEqual([]);
    }
  });
});

describe('attempt.prepared', () => {
  test('fills the request with its status, error and log tail, and emits attempt.prepared', async () => {
    const { hub, held, token } = setup();
    const id = (await request(hub, token)).json.request.id as string;
    hub.clock.advance(30_000);
    prepared(hub, held, { requestId: id, ok: false, error: 'bun install exited 1', logTail: 'error: lockfile changed' });
    const read = await poll(hub, id, { headers: bearer(token) });
    expect(read.json).toEqual({
      request: {
        id,
        attemptId: held.attempt.id,
        status: 'failed',
        error: 'bun install exited 1',
        logTail: 'error: lockfile changed',
        requestedAt: hub.ctx.now() - 30_000,
        finishedAt: hub.ctx.now(),
      },
    });
    const events = listEvents(hub.ctx.db).filter((event) => event.type === 'attempt.prepared');
    expect(events.map((event) => [event.subject, event.data])).toEqual([
      [
        held.task.id,
        {
          attemptId: held.attempt.id,
          taskId: held.task.id,
          agentId: held.agent.id,
          runnerId: held.runner.id,
          requestId: id,
          ok: false,
          error: 'bun install exited 1',
        },
      ],
    ]);
    // The command's own result, arriving after the event, changes nothing.
    recordResult(hub.ctx, held.runner.id, { commandId: id, ok: true });
    expect((await poll(hub, id, { headers: bearer(token) })).json.request.status).toBe('failed');
  });

  test('a success reads ok, also when the command result came first', async () => {
    const { hub, held, token } = setup();
    const id = (await request(hub, token)).json.request.id as string;
    recordResult(hub.ctx, held.runner.id, { commandId: id, ok: true });
    prepared(hub, held, { requestId: id, ok: true, error: null, logTail: 'installed 214 packages' });
    expect((await poll(hub, id, { headers: bearer(token) })).json.request).toMatchObject({
      status: 'ok',
      error: null,
      logTail: 'installed 214 packages',
    });
  });

  test("an outcome naming another attempt's request changes nothing, and is logged on the reporting attempt", async () => {
    const { hub, held, token } = setup();
    const id = (await request(hub, token)).json.request.id as string;
    const other = addRunnerAttempt(hub.ctx, { runnerId: held.runner.id });
    prepared(hub, other, { requestId: id, ok: false, error: 'boom', logTail: null });
    expect((await poll(hub, id, { headers: bearer(token) })).json.request).toMatchObject({ status: 'pending' });
    expect(attemptLog(hub.ctx, other.attempt.id).map((entry) => entry.kind)).toContain('rejected');
  });

  test('a preparation before a start or resume (requestId null) only adds a log entry', () => {
    const { hub, held } = setup();
    prepared(hub, held, { requestId: null, ok: true, error: null, logTail: 'installed 214 packages' });
    expect(attemptLog(hub.ctx, held.attempt.id).map((entry) => entry.summary)).toEqual([
      'prepared the dependencies before the agent started: ok',
    ]);
    expect(listEvents(hub.ctx.db).filter((event) => event.type === 'attempt.prepared')).toEqual([]);
  });
});

describe('GET /api/prepare/:id', () => {
  test("answers only the requesting attempt's agent; a cancelled command reads failed", async () => {
    const { hub, held, token } = setup();
    const id = (await request(hub, token)).json.request.id as string;
    const other = addRunnerAttempt(hub.ctx, { runnerId: held.runner.id });
    expect((await poll(hub, id, { headers: bearer(mintAgentToken(hub.ctx, other.attempt)) })).status).toBe(403);
    expect((await poll(hub, id, { user: 'alice', via: 'web' })).status).toBe(403);
    expect((await poll(hub, '1-R-1-999', { headers: bearer(token) })).status).toBe(404);

    // A re-fence cancels the old fence's commands; the agent's new token reads the request as failed.
    resumeAttempt(hub.ctx, { attemptId: held.attempt.id, cause: 'runner_restart', prompt: 'continue' });
    const fresh = mintAgentToken(hub.ctx, getAttempt(hub.ctx, held.attempt.id));
    const read = await poll(hub, id, { headers: bearer(fresh) });
    expect(read.json.request).toMatchObject({ status: 'failed', finishedAt: hub.ctx.now() });
    expect(read.json.request.error).toContain('cancelled');
  });
});

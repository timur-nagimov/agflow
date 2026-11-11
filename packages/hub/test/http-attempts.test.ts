import { describe, expect, test } from 'bun:test';
import { AttemptDetailResponseSchema, AttemptsResponseSchema, leadAttemptId } from '@agflow/core';
import { appendAttemptLog, insertAttempt, issueFence, nextAttemptNumber, updateAttempt } from '../src/attempt-store';
import { writeTask } from '../src/task-store';
import { addRunnerAttempt } from './helpers';
import { createTestHub } from './http-helpers';

type Hub = ReturnType<typeof createTestHub>;

function leadAttempts(hub: Hub, count: number): void {
  for (let n = 0; n < count; n++) {
    const number = nextAttemptNumber(hub.ctx, null);
    const fence = issueFence(hub.ctx);
    insertAttempt(hub.ctx, {
      id: leadAttemptId(number, fence.epoch),
      taskId: null,
      number,
      role: 'lead',
      agentId: 'A-99',
      runnerId: null,
      vendor: 'claude',
      fence,
      status: 'ended',
    });
  }
}

describe('attempt routes', () => {
  test('need a signed-in user', async () => {
    const hub = createTestHub();
    const { attempt } = addRunnerAttempt(hub.ctx);
    expect((await hub.call('GET', '/api/attempts')).status).toBe(401);
    expect((await hub.call('GET', `/api/attempts/${attempt.id}`)).status).toBe(401);
  });

  test('GET /api/attempts lists attempts newest first, with filters', async () => {
    const hub = createTestHub();
    const first = addRunnerAttempt(hub.ctx);
    hub.clock.advance(1_000);
    const second = addRunnerAttempt(hub.ctx, { owner: 'bob' });
    updateAttempt(hub.ctx, second.attempt.id, { status: 'holding' });
    const all = await hub.call('GET', '/api/attempts', { user: 'alice', via: 'web' });
    expect(all.status).toBe(200);
    expect(AttemptsResponseSchema.parse(all.json)).toEqual(all.json);
    expect(all.json.attempts.map((attempt: { id: string }) => attempt.id)).toEqual([second.attempt.id, first.attempt.id]);
    const ids = async (query: string) =>
      (await hub.call('GET', `/api/attempts?${query}`, { user: 'alice' })).json.attempts.map(
        (attempt: { id: string }) => attempt.id,
      );
    expect(await ids(`task=${first.task.id}`)).toEqual([first.attempt.id]);
    expect(await ids(`runner=${second.runner.id}`)).toEqual([second.attempt.id]);
    expect(await ids('status=holding,quota_wait')).toEqual([second.attempt.id]);
    expect(await ids('role=lead')).toEqual([]);
    expect(await ids('limit=1')).toEqual([second.attempt.id]);
    expect(await ids('task=&role=&status=&runner=&limit=')).toEqual([second.attempt.id, first.attempt.id]);
    for (const query of ['status=lost', 'role=boss', 'task=42', 'runner=R-x', 'limit=0', 'limit=two']) {
      expect([query, (await hub.call('GET', `/api/attempts?${query}`, { user: 'alice' })).status]).toEqual([query, 400]);
    }
  });

  test('the limit is 200 by default and 1000 at most', async () => {
    const hub = createTestHub();
    leadAttempts(hub, 1001);
    const count = async (query: string) =>
      (await hub.call('GET', `/api/attempts${query}`, { user: 'alice' })).json.attempts.length as number;
    expect(await count('')).toBe(200);
    expect(await count('?limit=5000')).toBe(1000);
  });

  test('GET /api/attempts/:id answers the attempt and its log, or 404', async () => {
    const hub = createTestHub();
    const { attempt } = addRunnerAttempt(hub.ctx);
    appendAttemptLog(hub.ctx, attempt.id, 'tool', 'Bash: bun test');
    hub.clock.advance(1_000);
    appendAttemptLog(hub.ctx, attempt.id, 'turn', 'turn ended');
    const detail = await hub.call('GET', `/api/attempts/${attempt.id}`, { user: 'bob', via: 'web' });
    expect(detail.status).toBe(200);
    expect(AttemptDetailResponseSchema.parse(detail.json)).toEqual(detail.json);
    expect(detail.json.attempt.id).toBe(attempt.id);
    expect(detail.json.log.map((entry: { summary: string }) => entry.summary)).toEqual(['Bash: bun test', 'turn ended']);
    const missing = await hub.call('GET', '/api/attempts/T-9-a1', { user: 'bob' });
    expect(missing.status).toBe(404);
    expect(missing.json).toEqual({ error: 'not_found', message: 'attempt T-9-a1 not found' });
  });

  test('GET /api/tasks/:id lists the task attempts newest first', async () => {
    const hub = createTestHub();
    const { task, attempt } = addRunnerAttempt(hub.ctx);
    updateAttempt(hub.ctx, attempt.id, { status: 'ended', endReason: 'crashed', failureClass: 'infra' });
    writeTask(hub.ctx, task.id, { status: 'ready', assignee: null });
    hub.clock.advance(1_000);
    const next = addRunnerAttempt(hub.ctx, { taskId: task.id, runnerId: attempt.runnerId ?? undefined });
    const detail = await hub.call('GET', `/api/tasks/${task.id}`, { user: 'alice', via: 'web' });
    expect(detail.json.attempts.map((entry: { id: string }) => entry.id)).toEqual([next.attempt.id, attempt.id]);
    expect(detail.json.task).toMatchObject({ currentAttempt: next.attempt.id, attemptCount: 2 });
  });
});

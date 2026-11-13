import { describe, expect, test } from 'bun:test';
import { BRIDGE_ANSWERS, BRIDGE_HEADER, BRIDGE_VERSION, NewTaskSchema } from '@agflow/core';
import { updateAttempt } from '@agflow/hub/src/attempt-store';
import { createTasks } from '@agflow/hub/src/tasks';
import { type FetchFn, HubClient, HubClientError } from '../src/hub-client';
import { HUB_URL, helloCodeIn, hubFixture } from './fixture';

/** The fixture's fetch, keeping the headers of every request it passes on. */
const recording = (fetchFn: FetchFn) => {
  const seen: Headers[] = [];
  const wrapped: FetchFn = (input, init) => {
    seen.push(new Headers(init?.headers));
    return fetchFn(input, init);
  };
  return { seen, fetch: wrapped };
};

const task = (title: string) =>
  NewTaskSchema.parse({ title, objective: 'o', acceptance: [{ id: 'A1', assertion: 'works' }] });

describe('HubClient', () => {
  test('reads public and signed-in endpoints', async () => {
    const hub = hubFixture();
    const anonymous = new HubClient({ baseUrl: `${HUB_URL}/`, fetch: hub.fetch });
    expect(await anonymous.authConfig()).toEqual({ mode: 'dev', project: 'demo' });
    expect((await hub.client('alice').me()).user).toBe('alice');
  });

  test('turns hub errors into HubClientError with status and code', async () => {
    const hub = hubFixture();
    const anonymous = new HubClient({ baseUrl: HUB_URL, fetch: hub.fetch });
    const error = await anonymous.me().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HubClientError);
    expect(error).toMatchObject({ status: 401, code: 'unauthorized' });
  });

  test("a request's own timeout replaces the client's", async () => {
    // A hub that never answers: only the request's signal ends the wait.
    const hanging: FetchFn = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')));
      });
    const client = new HubClient({ baseUrl: HUB_URL, fetch: hanging, timeoutMs: 60_000 });
    const started = performance.now();
    const error = await client.request('GET', '/api/status', undefined, { timeoutMs: 20 }).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 0, code: 'unreachable' });
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  test('an unreachable hub is reported clearly', async () => {
    const broken = new HubClient({
      baseUrl: 'http://hub.test',
      fetch: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    await expect(broken.authConfig()).rejects.toThrow('cannot reach the agflow hub at http://hub.test');
  });

  test('works as an agent once the agent id is set', async () => {
    const hub = hubFixture();
    createTasks(hub.ctx, [task('Parser')], 'user:alice');
    const started = await hub.client('alice').sessionStart({ vendor: 'claude', sessionId: 'abc', role: 'worker' });
    const client = hub.client('alice');
    const hello = await client.hello(helloCodeIn(started.brief));
    client.agentId = hello.agentId;
    expect((await client.claim('T-1', 'agflow/T-1-parser')).task).toMatchObject({ status: 'claimed', branch: 'agflow/T-1-parser' });
    expect((await client.progress('T-1', 'started')).task.status).toBe('working');
    expect((await client.submit('T-1', { summary: 'done', evidence: [] })).task.status).toBe('submitted');
    expect(await client.peek('claude', 'abc')).toEqual({ unread: 0, first: null });
  });

  test('lead calls are rejected for workers', async () => {
    const hub = hubFixture();
    const worker = hub.liveAgent('bob');
    const error = await worker.client.createTasks([task('x')]).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 403 });
  });
});

describe('HubClient for runner agents', () => {
  test('every request carries the bridge header with the bridge version', async () => {
    const hub = hubFixture();
    const { seen, fetch } = recording(hub.fetch);
    const client = new HubClient({ baseUrl: HUB_URL, token: hub.tokenFor('alice'), fetch });
    await client.authConfig();
    await client.me();
    await client.createTasks([task('Parser')]).catch(() => undefined);
    await new HubClient({ baseUrl: HUB_URL, fetch }).me().catch(() => undefined);
    expect(seen).toHaveLength(4);
    expect([BRIDGE_HEADER, BRIDGE_VERSION]).toEqual(['X-Agflow-Bridge', 2]);
    for (const headers of seen) expect(headers.get('X-Agflow-Bridge')).toBe('2');
  });

  test('a client with an agent token sends it as the bearer and never X-Agflow-Agent', async () => {
    const hub = hubFixture();
    const worker = hub.runnerAgent();
    const { seen, fetch } = recording(hub.fetch);
    const client = new HubClient({ baseUrl: HUB_URL, token: worker.token, agentId: worker.agent.id, fetch });
    expect(worker.token).toStartWith('agt_');
    expect((await client.tasks()).tasks.map((t) => t.id)).toEqual([worker.task?.id ?? '']);
    expect((await client.progress(worker.task?.id ?? '', 'started')).task.status).toBe('working');
    expect(seen.map((headers) => [headers.get('authorization'), headers.get('x-agflow-agent')])).toEqual([
      [`Bearer ${worker.token}`, null],
      [`Bearer ${worker.token}`, null],
    ]);
  });

  test("a worker's submit, submissions and dependency preparation use their routes", async () => {
    const hub = hubFixture();
    const worker = hub.runnerAgent();
    const taskId = worker.task?.id ?? '';
    const { submission } = await worker.client.submitWork(taskId, { summary: 'Parser added', evidence: ['bun test: 3 pass'] });
    expect(submission).toMatchObject({
      taskId,
      attemptId: worker.attempt.id,
      status: 'pending',
      summary: 'Parser added',
      evidence: ['bun test: 3 pass'],
    });
    expect((await worker.client.submission(submission.id)).submission).toEqual(submission);
    const other = hub.runnerAgent();
    const { request } = await other.client.requestPrepare();
    expect(request).toMatchObject({ attemptId: other.attempt.id, status: 'pending', logTail: null });
    expect((await other.client.prepareRequest(request.id)).request).toEqual(request);
    expect(await worker.client.prepareRequest(request.id).catch((e: unknown) => e)).toMatchObject({ status: 403 });
  });

  test("the lead's staffing, stop, replace, handoff and notes use their routes", async () => {
    const hub = hubFixture();
    const lead = hub.runnerAgent({ role: 'lead' });
    const first = hub.runnerAgent();
    const second = hub.runnerAgent();
    expect(await lead.client.staffing({ count: 2, reason: 'two ready tasks' })).toEqual({ running: expect.any(Number), target: 2 });
    const stopped = await lead.client.stopAgent(first.agent.id, { reason: 'wrong approach', hold: true });
    expect(stopped.attempt).toMatchObject({ id: first.attempt.id, stopRequested: expect.objectContaining({ cause: 'stop_hold' }) });
    const replaced = await lead.client.replaceAgent(second.agent.id, 'stuck for an hour');
    expect(replaced.attempt).toMatchObject({ id: second.attempt.id, stopRequested: expect.objectContaining({ cause: 'replace' }) });
    expect(await lead.client.leadHandoff('Next: review T-2.')).toEqual({ ok: true });
    expect((await lead.client.leadNotes()).notes).toEqual([
      expect.objectContaining({ kind: 'handoff', body: 'Next: review T-2.', attemptId: lead.attempt.id }),
    ]);
    // Workers do not hold the seat.
    expect(await first.client.leadNotes().catch((e: unknown) => e)).toMatchObject({ status: 403 });
  });

  test('401 attempt_ended keeps the reason of the hub, and attempt_refenced its code', async () => {
    const hub = hubFixture();
    const ended = hub.runnerAgent();
    updateAttempt(hub.ctx, ended.attempt.id, { status: 'ended', endReason: 'stopped', endedAt: hub.ctx.now() });
    const error = await ended.client.tasks().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HubClientError);
    expect(error).toMatchObject({ status: 401, code: 'attempt_ended', reason: 'stopped', message: BRIDGE_ANSWERS.attemptEnded('stopped') });
    const refenced = hub.runnerAgent();
    hub.ctx.db.run('UPDATE project SET epoch = 2');
    expect(await refenced.client.tasks().catch((e: unknown) => e)).toMatchObject({
      status: 401,
      code: 'attempt_refenced',
      reason: null,
      message: BRIDGE_ANSWERS.attemptRefenced,
    });
  });
});

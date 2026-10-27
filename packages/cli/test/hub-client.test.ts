import { describe, expect, test } from 'bun:test';
import { NewTaskSchema } from '@agflow/core';
import { createTasks } from '@agflow/hub/src/tasks';
import { HubClient, HubClientError } from '../src/hub-client';
import { HUB_URL, helloCodeIn, hubFixture } from './fixture';

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

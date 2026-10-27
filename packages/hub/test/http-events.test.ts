import { describe, expect, test } from 'bun:test';
import { updateGoal } from '../src/goal';
import { createTasks } from '../src/tasks';
import { newTask } from './helpers';
import { createTestHub } from './http-helpers';

describe('event routes', () => {
  test('events can be listed after a position and by subject', async () => {
    const hub = createTestHub();
    createTasks(hub.ctx, [newTask(), newTask()], 'user:alice');
    const all = await hub.call('GET', '/api/events', { user: 'alice', via: 'web' });
    expect(all.json.events.map((event: { subject: string }) => event.subject)).toEqual(['T-1', 'T-2']);
    const later = await hub.call('GET', '/api/events?after=1', { user: 'alice', via: 'web' });
    expect(later.json.events).toHaveLength(1);
    const bySubject = await hub.call('GET', '/api/events?subject=T-2', { user: 'alice', via: 'web' });
    expect(bySubject.json.events).toHaveLength(1);
  });

  test('search is available to any signed-in caller', async () => {
    const hub = createTestHub();
    createTasks(hub.ctx, [newTask({ title: 'Token refresh' })], 'user:alice');
    const result = await hub.call('GET', '/api/search?q=refresh', { user: 'bob' });
    expect(result.json.tasks.map((task: { title: string }) => task.title)).toEqual(['Token refresh']);
  });

  test('the stream replays missed events, then pushes new ones', async () => {
    const hub = createTestHub();
    updateGoal(hub.ctx, { text: 'first', baseVersion: 0 }, 'user:alice');
    const controller = new AbortController();
    const response = await hub.app.request('/api/events/stream?after=0', {
      headers: { cookie: `agflow_session=${hub.tokenFor('alice', 'web')}` },
      signal: controller.signal,
    });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const readUntil = async (text: string) => {
      while (!buffer.includes(text)) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`stream ended before ${text}`);
        buffer += decoder.decode(chunk.value);
      }
    };
    await readUntil('goal.updated');
    updateGoal(hub.ctx, { text: 'second', baseVersion: 1 }, 'user:alice');
    await readUntil('"version":2');
    expect(buffer).toContain('event: hub');
    controller.abort();
    await reader.cancel();
  });

  test('the stream needs a signed-in caller', async () => {
    const hub = createTestHub();
    expect((await hub.call('GET', '/api/events/stream')).status).toBe(401);
  });
});

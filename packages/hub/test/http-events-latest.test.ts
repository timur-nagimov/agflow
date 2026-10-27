import { describe, expect, test } from 'bun:test';
import { createTasks } from '../src/tasks';
import { newTask } from './helpers';
import { createTestHub } from './http-helpers';

describe('event routes for the web UI', () => {
  test('latest=1 lists the newest events first', async () => {
    const hub = createTestHub();
    createTasks(hub.ctx, [newTask(), newTask(), newTask()], 'user:alice');
    const result = await hub.call('GET', '/api/events?latest=1&limit=2', { user: 'alice', via: 'web' });
    expect(result.json.events.map((event: { subject: string }) => event.subject)).toEqual(['T-3', 'T-2']);
  });

  test('the stream announces itself before any event happens', async () => {
    const hub = createTestHub();
    const controller = new AbortController();
    const response = await hub.app.request('/api/events/stream', {
      headers: { cookie: `agflow_session=${hub.tokenFor('alice', 'web')}` },
      signal: controller.signal,
    });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('event: ready');
    controller.abort();
    await reader.cancel();
  });
});

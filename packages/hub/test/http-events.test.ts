import { describe, expect, spyOn, test } from 'bun:test';
import { updateGoal } from '../src/goal';
import { sendMessage } from '../src/messages';
import { createTasks } from '../src/tasks';
import { newTask } from './helpers';
import { createTestHub } from './http-helpers';

const range = (last: number): number[] => Array.from({ length: last }, (_, i) => i + 1);

/** Opens the event stream like the web UI does and records the id of every `hub` event that arrives. */
async function openStream(hub: ReturnType<typeof createTestHub>, after: number) {
  const controller = new AbortController();
  const response = await hub.app.request(`/api/events/stream?after=${after}`, {
    headers: { cookie: `agflow_session=${hub.tokenFor('alice', 'web')}` },
    signal: controller.signal,
  });
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const ids: number[] = [];
  let pending = '';
  return {
    ids,
    async readUntilId(last: number): Promise<void> {
      while (ids[ids.length - 1] !== last) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`stream ended before event ${last}`);
        pending += decoder.decode(chunk.value, { stream: true });
        const frames = pending.split('\n\n');
        pending = frames.pop() ?? '';
        for (const frame of frames) {
          const id = frame.match(/^id: (\d+)$/m);
          if (id?.[1]) ids.push(Number(id[1]));
        }
      }
    },
    async close(): Promise<void> {
      controller.abort();
      await reader.cancel();
    },
  };
}

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

  test('the stream replays a backlog larger than one page without gaps or repeats', async () => {
    const hub = createTestHub();
    const post = () => sendMessage(hub.ctx, { from: 'user:alice', to: 'lead', body: 'hi' });
    // A single replay read returns at most 1000 events; a client that was away longer must still get every one.
    for (let i = 0; i < 1005; i++) post();
    const stream = await openStream(hub, 0);
    // Stored and queued as a live event while the replay is still being written out.
    post();
    await stream.readUntilId(1006);
    expect(stream.ids).toEqual(range(1006));
    post();
    await stream.readUntilId(1007);
    expect(stream.ids).toEqual(range(1007));
    await stream.close();
  });

  test('a replay stops reading pages once the client has gone', async () => {
    const hub = createTestHub();
    for (let i = 0; i < 2500; i++) sendMessage(hub.ctx, { from: 'user:alice', to: 'lead', body: 'hi' });
    const query = spyOn(hub.ctx.db, 'query');
    const stream = await openStream(hub, 0);
    await stream.readUntilId(1);
    await stream.close();
    // Give an unguarded replay time to run on through the remaining pages.
    await Bun.sleep(50);
    expect(query.mock.calls.filter(([sql]) => String(sql).includes('FROM events'))).toHaveLength(1);
  });

  test('the stream needs a signed-in caller', async () => {
    const hub = createTestHub();
    expect((await hub.call('GET', '/api/events/stream')).status).toBe(401);
  });
});

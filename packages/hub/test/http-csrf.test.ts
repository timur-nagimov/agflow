import { describe, expect, test } from 'bun:test';
import { claimTask, createTasks } from '../src/tasks';
import { addAgent, newTask } from './helpers';
import { createTestHub } from './http-helpers';

type Hub = ReturnType<typeof createTestHub>;

const refused = { error: 'forbidden', message: 'cross-site request refused' };
const code = 'x'.repeat(32);

/** Alice pauses or resumes the project with her web UI cookie, sending the given extra headers. */
function pause(hub: Hub, headers: Record<string, string>, paused = true) {
  return hub.call('POST', '/api/project/pause', { user: 'alice', via: 'web', body: { paused }, headers });
}

describe('cross-site request protection', () => {
  test('a cookie POST from another port on the same host is refused', async () => {
    const hub = createTestHub({ publicUrl: 'http://localhost:8787' });
    const attempts: Record<string, string>[] = [
      { host: 'localhost:8787', origin: 'http://localhost:5173', 'sec-fetch-site': 'same-site' },
      // Browsers without Sec-Fetch-Site still send Origin; sandboxed frames send "null".
      { host: 'localhost:8787', origin: 'http://localhost:5173' },
      { host: 'localhost:8787', origin: 'null' },
      { host: 'localhost:8787', 'sec-fetch-site': 'same-site' },
      { host: 'localhost:8787', 'sec-fetch-site': 'cross-site' },
    ];
    for (const headers of attempts) {
      const result = await pause(hub, headers);
      expect(result.status).toBe(403);
      expect(result.json).toEqual(refused);
    }
    const project = await hub.call('GET', '/api/project', { user: 'alice', via: 'web', headers: { origin: 'http://localhost:5173' } });
    expect(project.json.paused).toBe(false);
  });

  test('a cookie POST from a sibling subdomain is refused', async () => {
    const hub = createTestHub({ publicUrl: 'https://agflow.example.com' });
    const attempts: Record<string, string>[] = [
      { host: 'agflow.example.com', origin: 'https://evil.example.com', 'sec-fetch-site': 'same-site' },
      { host: 'agflow.example.com', origin: 'https://evil.example.com' },
    ];
    for (const headers of attempts) expect((await pause(hub, headers)).json).toEqual(refused);
  });

  test('an opaque origin never matches, even when the public URL lacks a scheme', async () => {
    const hub = createTestHub({ publicUrl: 'localhost:8787' });
    expect((await pause(hub, { origin: 'null' })).json).toEqual(refused);
  });

  test('every write that relies on the cookie is checked, with or without a body', async () => {
    const hub = createTestHub();
    const web = { user: 'alice', via: 'web' as const, headers: { origin: 'http://localhost:5173' } };
    expect((await hub.call('PUT', '/api/goal', { ...web, body: { text: 'Use npm.', baseVersion: 0 } })).status).toBe(403);
    expect((await hub.call('POST', '/api/messages', { ...web, body: { to: 'all', body: 'Use npm.', standingRule: true } })).status).toBe(403);
    expect((await hub.call('POST', '/api/cli-login/approve', { ...web, body: { code, label: 'evil' } })).status).toBe(403);
    expect((await hub.call('GET', `/api/cli-login/poll?code=${code}`)).json).toEqual({ status: 'pending' });
    expect((await hub.call('POST', '/auth/logout', web)).json).toEqual(refused);
    expect((await hub.call('GET', '/api/me', { user: 'alice', via: 'web' })).status).toBe(200);
  });

  test("the hub's own pages and clients that are not browsers can use the cookie", async () => {
    const hub = createTestHub({ publicUrl: 'https://agflow.example.com' });
    const allowed: Record<string, string>[] = [
      { origin: 'https://agflow.example.com', 'sec-fetch-site': 'same-origin' },
      // The address the request was sent to, when people reach the hub by another name than its public URL.
      { host: '127.0.0.1:8787', origin: 'http://127.0.0.1:8787', 'sec-fetch-site': 'same-origin' },
      // A typed address or a bookmark.
      { 'sec-fetch-site': 'none' },
      // curl and scripts send neither header.
      {},
    ];
    for (const [i, headers] of allowed.entries()) {
      const paused = i % 2 === 0;
      const result = await pause(hub, headers, paused);
      expect(result.status).toBe(200);
      expect(result.json.paused).toBe(paused);
    }
  });

  test('requests with a Bearer token are never refused', async () => {
    const hub = createTestHub();
    const headers = { origin: 'http://localhost:5173', 'sec-fetch-site': 'cross-site' };
    const worker = addAgent(hub.ctx, 'bob');
    expect((await hub.call('POST', '/api/inbox', { user: 'bob', agent: worker.id, headers })).status).toBe(200);
    // The Bearer token wins over a cookie sent alongside it, so the cookie's authority is not used.
    const withCookie = { ...headers, cookie: `agflow_session=${hub.tokenFor('bob', 'web')}` };
    expect((await hub.call('POST', '/api/inbox', { user: 'bob', agent: worker.id, headers: withCookie })).status).toBe(200);
    const oldSession = addAgent(hub.ctx, 'alice');
    const newSession = addAgent(hub.ctx, 'alice');
    const [task] = createTasks(hub.ctx, [newTask()], 'user:alice');
    claimTask(hub.ctx, task.id, oldSession);
    const resumed = await hub.call('POST', `/api/tasks/${task.id}/resume-claim`, { user: 'alice', agent: newSession.id, headers });
    expect(resumed.json.task.assignee).toBe(newSession.id);
  });
});

describe('JSON request bodies', () => {
  async function postPause(hub: Hub, contentType: string | null, body: string) {
    const headers: Record<string, string> = { cookie: `agflow_session=${hub.tokenFor('alice', 'web')}` };
    if (contentType) headers['content-type'] = contentType;
    const response = await hub.app.request('/api/project/pause', { method: 'POST', headers, body });
    return { status: response.status, json: (await response.json()) as { error?: string; paused?: boolean } };
  }

  test('a body sent as anything but application/json is refused', async () => {
    const hub = createTestHub();
    const body = JSON.stringify({ paused: true });
    for (const type of ['text/plain', 'text/plain;charset=UTF-8', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', null]) {
      const result = await postPause(hub, type, body);
      expect(result.status).toBe(415);
      expect(result.json.error).toBe('unsupported_media_type');
    }
    expect((await hub.call('GET', '/api/project', { user: 'alice', via: 'web' })).json.paused).toBe(false);
  });

  test('application/json may carry parameters', async () => {
    const hub = createTestHub();
    expect((await postPause(hub, 'application/json; charset=utf-8', '{"paused":true}')).json.paused).toBe(true);
    expect((await postPause(hub, 'Application/JSON', '{"paused":false}')).json.paused).toBe(false);
  });

  test('a POST without a body needs no content type', async () => {
    const hub = createTestHub();
    // A route that reads a body still says it wants JSON...
    const empty = await hub.call('POST', '/api/project/pause', { user: 'alice', via: 'web' });
    expect(empty.status).toBe(400);
    expect(empty.json.error).toBe('bad_request');
    // ...and routes that read none keep working.
    const worker = addAgent(hub.ctx, 'bob');
    expect((await hub.call('POST', '/api/inbox', { user: 'bob', agent: worker.id })).status).toBe(200);
    expect((await hub.call('POST', '/auth/logout', { user: 'alice', via: 'web' })).json).toEqual({ ok: true });
  });
});

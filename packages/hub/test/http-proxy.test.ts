import { afterEach, expect, test } from 'bun:test';
import { createSession, mintAgentToken } from '../src/auth';
import { loadConfig } from '../src/config';
import { startHub, type HubServer } from '../src/server';
import { addRunnerAttempt, createTestContext } from './helpers';

const publicUrl = 'https://hub.example.com';
const servers: HubServer[] = [];
afterEach(async () => { for (const hub of servers.splice(0)) await hub.stop({ closeDatabase: true }); });

function fixture() {
  const { config } = loadConfig({
    AGFLOW_AUTH: 'github', AGFLOW_PUBLIC_URL: publicUrl, AGFLOW_ALLOWED_USERS: 'alice',
    AGFLOW_PROJECT_NAME: 'demo', AGFLOW_PROJECT_REPO: 'https://github.com/acme/demo',
    GITHUB_CLIENT_ID: 'test-client', GITHUB_CLIENT_SECRET: 'test-secret',
  });
  const { ctx } = createTestContext(config, async (input) => Response.json(
    String(input).includes('access_token') ? { access_token: 'fake' } : { login: 'alice' },
  ));
  const hub = startHub(ctx, { timers: false });
  servers.push(hub);
  const request = (path: string, init: RequestInit = {}) => fetch(`${hub.url}${path}`, {
    ...init, redirect: 'manual', headers: {
      host: 'hub.example.com', 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1',
      'x-forwarded-host': 'localhost', 'x-forwarded-proto': 'http',
      forwarded: 'for=127.0.0.1;host=localhost;proto=http', ...init.headers,
    },
  });
  return { ctx, hub, request };
}

test('loopback and forged proxy headers never authenticate any protected route group', async () => {
  const { request } = fixture();
  for (const [method, path] of [
    ['GET', '/api/me'], ['GET', '/api/project'], ['GET', '/api/tasks'], ['GET', '/api/agents'],
    ['GET', '/api/attempts'], ['GET', '/api/messages'], ['GET', '/api/events/stream'],
    ['GET', '/api/approvals'], ['POST', '/api/approvals/A-1'], ['POST', '/api/cli-login/approve'],
    ['GET', '/api/runner/ws'], ['GET', '/api/runner/whoami'], ['GET', '/api/runners'],
    ['POST', '/api/live/session-start'], ['POST', '/api/live/hello'], ['POST', '/api/inbox'],
    ['POST', '/api/lead/handoff'],
  ]) {
    const response = await request(path!, { method });
    expect([method, path, response.status]).toEqual([method, path, 401]);
  }
  expect((await request('/auth/dev?user=alice')).status).toBe(404);
  expect((await request('/cli-login?code=' + 'x'.repeat(32))).headers.get('location')).toStartWith('/auth/github?');
});

test('HTTPS public URL sets Secure cookies and OAuth callback despite internal HTTP and forged headers', async () => {
  const { request } = fixture();
  const start = await request('/auth/github');
  const destination = new URL(start.headers.get('location')!);
  expect(destination.searchParams.get('redirect_uri')).toBe(`${publicUrl}/auth/github/callback`);
  const stateCookie = start.headers.getSetCookie()[0]!;
  expect(stateCookie).toContain('Secure');
  expect(stateCookie).toContain('HttpOnly');
  expect(stateCookie).toContain('SameSite=Lax');
  const response = await request(`/auth/github/callback?code=fake&state=${destination.searchParams.get('state')}`, {
    headers: { cookie: stateCookie.split(';')[0]! },
  });
  expect(response.status).toBe(302);
  const cookie = response.headers.getSetCookie().find((line) => line.startsWith('agflow_session='))!;
  expect(cookie).toContain('Secure');
  expect(cookie).toContain('HttpOnly');
  expect(cookie).toContain('SameSite=Lax');
});

test('browser writes require same-origin; CLI and scoped agent tokens retain their permissions', async () => {
  const { ctx, request } = fixture();
  const cookie = `agflow_session=${createSession(ctx, 'alice', 'web')}`;
  for (const [method, path] of [
    ['POST', '/api/project/pause'], ['PATCH', '/api/runners/R-1'], ['POST', '/api/approvals/A-1'],
    ['POST', '/api/cli-login/approve'], ['POST', '/auth/logout'], ['POST', '/api/live/session-start'],
  ]) {
    expect((await request(path!, { method, headers: { cookie, origin: 'https://evil.example.com' } })).status).toBe(403);
  }
  const pause = await request('/api/project/pause', {
    method: 'POST', headers: { cookie, origin: publicUrl, 'content-type': 'application/json' },
    body: JSON.stringify({ paused: true }),
  });
  expect(pause.status).toBe(200);
  expect((await request('/api/runner/ws', { headers: { cookie, upgrade: 'websocket' } })).status).toBe(401);
  const cli = createSession(ctx, 'alice', 'cli');
  expect((await request('/api/runner/whoami', { headers: { authorization: `Bearer ${cli}` } })).status).toBe(200);
  expect((await request('/api/approvals/A-1', { method: 'POST', headers: { authorization: `Bearer ${cli}` } })).status).toBe(403);
  const { attempt } = addRunnerAttempt(ctx);
  const agent = mintAgentToken(ctx, attempt);
  for (const path of ['/api/runner/ws', '/api/approvals', '/api/live/inbox']) {
    expect((await request(path, { headers: { authorization: `Bearer ${agent}` } })).status).toBe(403);
  }
  expect((await request('/api/status', { headers: { authorization: `Bearer ${agent}` } })).status).toBe(200);
});

test('authenticated SSE sends initial bytes over internal HTTP without waiting for an event', async () => {
  const { ctx, request } = fixture();
  const controller = new AbortController();
  try {
    const response = await request('/api/events/stream', {
      headers: { cookie: `agflow_session=${createSession(ctx, 'alice', 'web')}` }, signal: controller.signal,
    });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('event: ready');
    await reader.cancel();
  } finally { controller.abort(); }
});

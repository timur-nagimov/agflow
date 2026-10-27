import { describe, expect, test } from 'bun:test';
import { addAgent } from './helpers';
import { createTestHub } from './http-helpers';

describe('sign-in and principals', () => {
  test('auth-config is public', async () => {
    const hub = createTestHub();
    const result = await hub.call('GET', '/api/auth-config');
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ mode: 'dev', project: 'demo' });
  });

  test('/api/me needs a session and reports how the caller signed in', async () => {
    const hub = createTestHub();
    expect((await hub.call('GET', '/api/me')).status).toBe(401);
    expect((await hub.call('GET', '/api/me', { user: 'alice' })).json).toEqual({ user: 'alice', via: 'cli', agent: null });
    expect((await hub.call('GET', '/api/me', { user: 'alice', via: 'web' })).json.via).toBe('web');
  });

  test('dev sign-in sets an HttpOnly session cookie and redirects', async () => {
    const hub = createTestHub();
    const result = await hub.call('GET', '/auth/dev?user=alice&returnTo=/board');
    expect(result.status).toBe(302);
    expect(result.headers.get('location')).toBe('/board');
    const cookie = result.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('HttpOnly');
    const token = cookie.match(/agflow_session=([^;]+)/)?.[1];
    const me = await hub.call('GET', '/api/me', { headers: { cookie: `agflow_session=${token}` } });
    expect(me.json.user).toBe('alice');
  });

  test('dev sign-in refuses unknown users and open redirects', async () => {
    const hub = createTestHub();
    expect((await hub.call('GET', '/auth/dev?user=mallory')).status).toBe(403);
    expect((await hub.call('GET', '/auth/dev?user=alice&returnTo=//evil.example')).headers.get('location')).toBe('/');
  });

  test('dev sign-in redirects only to same-site paths', async () => {
    const hub = createTestHub();
    const redirectFor = async (returnTo: string) =>
      (await hub.call('GET', `/auth/dev?user=alice&returnTo=${returnTo}`)).headers.get('location');
    for (const path of ['/board', '/tasks/T-1?tab=notes#x', '/cli-login?code=abc']) {
      expect(await redirectFor(encodeURIComponent(path))).toBe(path);
    }
    // Browsers read a backslash as a slash and drop tabs and line breaks from URLs.
    for (const hostile of [
      '/%5Cevil.example',
      '/%09/evil.example',
      '/%0A/evil.example',
      '/%0D/evil.example',
      '/%00/evil.example',
      'https://evil.example',
      'evil.example',
    ]) {
      expect(await redirectFor(hostile)).toBe('/');
    }
  });

  test('dev sign-in is disabled in GitHub mode', async () => {
    const hub = createTestHub({ auth: 'github' });
    expect((await hub.call('GET', '/auth/dev?user=alice')).status).toBe(404);
  });

  test('an agent header must name an agent of the same user', async () => {
    const hub = createTestHub();
    const agent = addAgent(hub.ctx, 'alice');
    expect((await hub.call('GET', '/api/me', { user: 'alice', agent: agent.id })).json.agent.id).toBe(agent.id);
    expect((await hub.call('GET', '/api/me', { user: 'bob', agent: agent.id })).status).toBe(403);
    expect((await hub.call('GET', '/api/me', { user: 'alice', agent: 'A-99' })).status).toBe(401);
  });

  test('logout ends the session', async () => {
    const hub = createTestHub();
    expect((await hub.call('POST', '/auth/logout', { user: 'alice', via: 'web' })).json).toEqual({ ok: true });
    expect((await hub.call('GET', '/api/me', { user: 'alice', via: 'web' })).status).toBe(401);
  });

  test('unknown API routes return a JSON 404', async () => {
    const hub = createTestHub();
    const result = await hub.call('GET', '/api/nope');
    expect(result.status).toBe(404);
    expect(result.json.error).toBe('not_found');
  });
});

describe('CLI login', () => {
  const code = 'x'.repeat(32);

  test('a person approves in the web UI and the CLI collects its token once', async () => {
    const hub = createTestHub();
    expect((await hub.call('GET', `/api/cli-login/poll?code=${code}`)).json).toEqual({ status: 'pending' });
    const approve = await hub.call('POST', '/api/cli-login/approve', { user: 'alice', via: 'web', body: { code, label: 'laptop' } });
    expect(approve.status).toBe(200);
    const poll = await hub.call('GET', `/api/cli-login/poll?code=${code}`);
    expect(poll.json.status).toBe('approved');
    const me = await hub.call('GET', '/api/me', { headers: { authorization: `Bearer ${poll.json.token}` } });
    expect(me.json).toMatchObject({ user: 'alice', via: 'cli' });
    expect((await hub.call('GET', `/api/cli-login/poll?code=${code}`)).json).toEqual({ status: 'pending' });
  });

  test('a CLI token cannot approve CLI logins', async () => {
    const hub = createTestHub();
    expect((await hub.call('POST', '/api/cli-login/approve', { user: 'alice', via: 'cli', body: { code } })).status).toBe(403);
  });
});

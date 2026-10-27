import { describe, expect, test } from 'bun:test';
import type { FetchFn } from '../src/context';
import { createTestHub } from './http-helpers';

const githubConfig = { auth: 'github' as const, githubClientId: 'client', githubClientSecret: 'secret' };

function fakeGithub(login: string | null): FetchFn {
  return async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('https://github.com/login/oauth/access_token')) {
      return Response.json(login ? { access_token: 'gho_test' } : { error_description: 'bad code' });
    }
    if (url === 'https://api.github.com/user') return Response.json({ login });
    return new Response('unexpected', { status: 500 });
  };
}

async function startSignIn(hub: ReturnType<typeof createTestHub>): Promise<string> {
  const start = await hub.call('GET', '/auth/github?returnTo=/board');
  expect(start.status).toBe(302);
  const location = new URL(start.headers.get('location') ?? '');
  expect(location.origin + location.pathname).toBe('https://github.com/login/oauth/authorize');
  expect(location.searchParams.get('client_id')).toBe('client');
  expect(location.searchParams.get('redirect_uri')).toBe('http://hub.test/auth/github/callback');
  return location.searchParams.get('state') ?? '';
}

describe('GitHub sign-in', () => {
  test('a successful callback signs the person in and returns them to the page', async () => {
    const hub = createTestHub(githubConfig, fakeGithub('alice'));
    const state = await startSignIn(hub);
    const callback = await hub.call('GET', `/auth/github/callback?code=abc&state=${state}`);
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/board');
    expect(callback.headers.get('set-cookie')).toContain('agflow_session=');
  });

  test('a reused or unknown state is refused', async () => {
    const hub = createTestHub(githubConfig, fakeGithub('alice'));
    const state = await startSignIn(hub);
    await hub.call('GET', `/auth/github/callback?code=abc&state=${state}`);
    expect((await hub.call('GET', `/auth/github/callback?code=abc&state=${state}`)).status).toBe(400);
  });

  test('people outside the allowlist are refused', async () => {
    const hub = createTestHub(githubConfig, fakeGithub('mallory'));
    const state = await startSignIn(hub);
    expect((await hub.call('GET', `/auth/github/callback?code=abc&state=${state}`)).status).toBe(403);
  });

  test('a GitHub error is reported as a failed sign-in', async () => {
    const hub = createTestHub(githubConfig, fakeGithub(null));
    const state = await startSignIn(hub);
    const result = await hub.call('GET', `/auth/github/callback?code=bad&state=${state}`);
    expect(result.status).toBe(401);
    expect(result.json.message).toBe('bad code');
  });
});

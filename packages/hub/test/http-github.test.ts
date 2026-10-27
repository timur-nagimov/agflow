import { describe, expect, test } from 'bun:test';
import { OAUTH_STATE_TTL } from '../src/auth';
import type { FetchFn } from '../src/context';
import { createTestHub } from './http-helpers';

const githubConfig = { auth: 'github' as const, githubClientId: 'client', githubClientSecret: 'secret' };

type Hub = ReturnType<typeof createTestHub>;
type Reply = () => Response | Promise<Response>;

/** Stands in for GitHub; `replies` replaces an endpoint's answer to imitate outages and odd replies. */
function fakeGithub(login: string | null, replies: { token?: Reply; user?: Reply } = {}): FetchFn {
  return async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('https://github.com/login/oauth/access_token')) {
      if (replies.token) return replies.token();
      return Response.json(login ? { access_token: 'gho_test' } : { error_description: 'bad code' });
    }
    if (url === 'https://api.github.com/user') return replies.user ? replies.user() : Response.json({ login });
    return new Response('unexpected', { status: 500 });
  };
}

/** The Set-Cookie line for the sign-in state cookie, if the response has one. */
function stateCookieLine(headers: Headers): string | undefined {
  return headers.getSetCookie().find((line) => line.startsWith('agflow_oauth_state='));
}

interface SignIn {
  state: string;
  /** The Cookie header sent back by the browser that started the sign-in. */
  cookie: string;
}

async function startSignIn(hub: Hub, returnTo = '/board'): Promise<SignIn> {
  const start = await hub.call('GET', `/auth/github?returnTo=${returnTo}`);
  expect(start.status).toBe(302);
  const location = new URL(start.headers.get('location') ?? '');
  expect(location.origin + location.pathname).toBe('https://github.com/login/oauth/authorize');
  expect(location.searchParams.get('client_id')).toBe('client');
  expect(location.searchParams.get('redirect_uri')).toBe('http://hub.test/auth/github/callback');
  return { state: location.searchParams.get('state') ?? '', cookie: stateCookieLine(start.headers)?.split(';')[0] ?? '' };
}

/** GitHub sends a browser back with the state; `cookie` is what that browser holds, if anything. */
function callback(hub: Hub, state: string, cookie?: string) {
  return hub.call('GET', `/auth/github/callback?code=abc&state=${state}`, cookie ? { headers: { cookie } } : {});
}

describe('GitHub sign-in', () => {
  test('a successful callback signs the person in and returns them to the page', async () => {
    const hub = createTestHub(githubConfig, fakeGithub('alice'));
    const signIn = await startSignIn(hub);
    const result = await callback(hub, signIn.state, signIn.cookie);
    expect(result.status).toBe(302);
    expect(result.headers.get('location')).toBe('/board');
    expect(result.headers.get('set-cookie')).toContain('agflow_session=');
  });

  test('sign-in asks GitHub for no scopes', async () => {
    const hub = createTestHub(githubConfig, fakeGithub('alice'));
    const start = await hub.call('GET', '/auth/github');
    expect(new URL(start.headers.get('location') ?? '').searchParams.has('scope')).toBe(false);
  });

  test('starting sign-in gives the browser the state in a short-lived cookie for the sign-in paths', async () => {
    const hub = createTestHub(githubConfig, fakeGithub('alice'));
    const start = await hub.call('GET', '/auth/github');
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state');
    expect(stateCookieLine(start.headers)?.split('; ').sort()).toEqual(
      [`agflow_oauth_state=${state}`, `Max-Age=${OAUTH_STATE_TTL / 1000}`, 'Path=/auth/github', 'HttpOnly', 'SameSite=Lax'].sort(),
    );
    const httpsHub = createTestHub({ ...githubConfig, secureCookies: true }, fakeGithub('alice'));
    expect(stateCookieLine((await httpsHub.call('GET', '/auth/github')).headers)?.split('; ')).toContain('Secure');
  });

  test('a returnTo that would leave the site is replaced before the round trip to GitHub', async () => {
    const hub = createTestHub(githubConfig, fakeGithub('alice'));
    const signIn = await startSignIn(hub, '/%5Cevil.example/phish');
    const result = await callback(hub, signIn.state, signIn.cookie);
    expect(result.status).toBe(302);
    expect(result.headers.get('location')).toBe('/');
    expect(result.headers.get('set-cookie')).toContain('agflow_session=');
  });

  test('a callback in a browser without the state cookie is refused before GitHub is asked', async () => {
    let githubCalls = 0;
    const github = fakeGithub('alice');
    const hub = createTestHub(githubConfig, (input, init) => {
      githubCalls += 1;
      return github(input, init);
    });
    const signIn = await startSignIn(hub);
    const result = await callback(hub, signIn.state);
    expect(result.status).toBe(400);
    expect(result.json.error).toBe('bad_request');
    expect(result.headers.get('set-cookie')).toBeNull();
    expect(githubCalls).toBe(0);
  });

  // Login CSRF: an allowlisted insider finishes their own GitHub authorization, then gets someone else's browser to
  // open the callback link, which would sign that browser in under the insider's account.
  test("a callback link carrying another browser's state is refused", async () => {
    const hub = createTestHub(githubConfig, fakeGithub('alice'));
    const insider = await startSignIn(hub);
    const victim = await startSignIn(hub);
    const forged = await callback(hub, insider.state, victim.cookie);
    expect(forged.status).toBe(400);
    expect(forged.json.error).toBe('bad_request');
    // Nothing is set or cleared, so the victim's own sign-in still works.
    expect(forged.headers.get('set-cookie')).toBeNull();
    expect((await callback(hub, victim.state, victim.cookie)).status).toBe(302);
  });

  test('the callback clears the state cookie once it has used it, whatever GitHub says', async () => {
    for (const login of ['alice', null]) {
      const hub = createTestHub(githubConfig, fakeGithub(login));
      const signIn = await startSignIn(hub);
      const result = await callback(hub, signIn.state, signIn.cookie);
      expect(result.status).toBe(login ? 302 : 401);
      expect(stateCookieLine(result.headers)?.split('; ')).toEqual(
        expect.arrayContaining(['agflow_oauth_state=', 'Max-Age=0', 'Path=/auth/github']),
      );
    }
  });

  test('a reused or unknown state is refused', async () => {
    const hub = createTestHub(githubConfig, fakeGithub('alice'));
    const signIn = await startSignIn(hub);
    await callback(hub, signIn.state, signIn.cookie);
    expect((await callback(hub, signIn.state, signIn.cookie)).status).toBe(400);
    expect((await callback(hub, 'made-up', 'agflow_oauth_state=made-up')).status).toBe(400);
  });

  test('people outside the allowlist are refused', async () => {
    const hub = createTestHub(githubConfig, fakeGithub('mallory'));
    const signIn = await startSignIn(hub);
    expect((await callback(hub, signIn.state, signIn.cookie)).status).toBe(403);
  });

  test('a GitHub error is reported as a failed sign-in', async () => {
    const hub = createTestHub(githubConfig, fakeGithub(null));
    const signIn = await startSignIn(hub);
    const result = await callback(hub, signIn.state, signIn.cookie);
    expect(result.status).toBe(401);
    expect(result.json.message).toBe('bad code');
  });

  test('an HTML error page from GitHub is a failed sign-in, not a server error', async () => {
    const errorPage: Reply = () =>
      new Response('<html><body><h1>502 Bad Gateway</h1></body></html>', { status: 502, headers: { 'content-type': 'text/html' } });
    for (const replies of [{ token: errorPage }, { user: errorPage }]) {
      const hub = createTestHub(githubConfig, fakeGithub('alice', replies));
      const signIn = await startSignIn(hub);
      const result = await callback(hub, signIn.state, signIn.cookie);
      expect(result.status).toBe(401);
      expect(result.json.error).toBe('github_failed');
      expect(result.json.message).toContain('502');
    }
  });

  test('GitHub being unreachable is a failed sign-in', async () => {
    const unreachable: Reply = () => Promise.reject(new TypeError('fetch failed'));
    for (const replies of [{ token: unreachable }, { user: unreachable }]) {
      const hub = createTestHub(githubConfig, fakeGithub('alice', replies));
      const signIn = await startSignIn(hub);
      const result = await callback(hub, signIn.state, signIn.cookie);
      expect(result.status).toBe(401);
      expect(result.json).toEqual({ error: 'github_failed', message: 'could not reach GitHub; try again' });
    }
  });

  test('a GitHub reply of an unexpected shape is a failed sign-in', async () => {
    for (const replies of [
      { token: () => Response.json(null) },
      { token: () => Response.json({ access_token: 42 }) },
      { user: () => Response.json(['alice']) },
      { user: () => Response.json({ login: 42 }) },
    ]) {
      const hub = createTestHub(githubConfig, fakeGithub('alice', replies));
      const signIn = await startSignIn(hub);
      const result = await callback(hub, signIn.state, signIn.cookie);
      expect(result.status).toBe(401);
      expect(result.json.error).toBe('github_failed');
    }
  });
});

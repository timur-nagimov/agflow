import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approveCliLogin } from '@agflow/hub/src/auth';
import { loadCredentials } from '../src/credentials';
import { login } from '../src/login';
import { hubFixture } from './fixture';

test('HTTPS login keeps TLS for auth-config, browser approval, polling and saved runner credentials', async () => {
  const publicUrl = 'https://hub.example.com';
  const hub = hubFixture({ auth: 'github', publicUrl, secureCookies: true });
  const dir = mkdtempSync(join(tmpdir(), 'agflow-login-https-'));
  const requests: string[] = [];
  let browser = '';
  try {
    const credentials = await login(`${publicUrl}/`, { out: () => {}, err: () => {} }, {
      dir, host: 'colleague-mac', pollMs: 1, timeoutMs: 10,
      fetch: async (input, init) => {
        requests.push(input instanceof Request ? input.url : String(input));
        return hub.fetch(input, init);
      },
      openUrl: (url) => { browser = url; },
      sleep: async () => { approveCliLogin(hub.ctx, new URL(browser).searchParams.get('code')!, 'alice'); },
    });
    expect(new URL(browser).origin).toBe(publicUrl);
    expect(new URL(browser).pathname).toBe('/cli-login');
    expect(requests.length).toBeGreaterThanOrEqual(3);
    expect(requests.every((url) => new URL(url).origin === publicUrl)).toBe(true);
    expect(new URL(requests[0]!).pathname).toBe('/api/auth-config');
    expect(new URL(requests.at(-1)!).pathname).toBe('/api/cli-login/poll');
    expect(credentials.hubUrl).toBe(publicUrl);
    expect(loadCredentials(dir)).toEqual(credentials);
  } finally {
    hub.ctx.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

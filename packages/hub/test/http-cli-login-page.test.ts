import { describe, expect, test } from 'bun:test';
import { verificationCode } from '@agflow/core';
import { createTestHub } from './http-helpers';

const code = 'AbCdEfGh12345678_-xyzXYZ0123456789';

describe('CLI sign-in page', () => {
  test('signed out in dev mode, it asks for a login and returns here afterwards', async () => {
    const hub = createTestHub();
    const result = await hub.call('GET', `/cli-login?code=${code}&label=laptop`);
    expect(result.status).toBe(200);
    expect(result.json).toContain('action="/auth/dev"');
    expect(result.json).toContain(`/cli-login?code=${code}&amp;label=laptop`);
  });

  test('signed out in GitHub mode, it sends people to GitHub sign-in', async () => {
    const hub = createTestHub({ auth: 'github', githubClientId: 'c', githubClientSecret: 's' });
    const result = await hub.call('GET', `/cli-login?code=${code}&label=laptop`);
    expect(result.status).toBe(302);
    expect(result.headers.get('location')).toStartWith('/auth/github?returnTo=');
  });

  test('signed in, it shows the verification code and escapes the label', async () => {
    const hub = createTestHub();
    const label = encodeURIComponent('<script>alert(1)</script>');
    const result = await hub.call('GET', `/cli-login?code=${code}&label=${label}`, { user: 'alice', via: 'web' });
    expect(result.json).toContain(verificationCode(code));
    expect(result.json).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(result.json).not.toContain('<script>alert(1)</script>');
    expect(result.json).toContain('/api/cli-login/approve');
  });

  test('malformed codes are rejected', async () => {
    const hub = createTestHub();
    expect((await hub.call('GET', '/cli-login?code=short')).status).toBe(400);
  });
});

describe('verificationCode', () => {
  test('is the first eight characters, upper-cased and grouped', () => {
    expect(verificationCode('abcd1234zzzz')).toBe('ABCD-1234');
  });
});

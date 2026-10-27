import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verificationCode } from '@agflow/core';
import { approveCliLogin } from '@agflow/hub/src/auth';
import { loadCredentials, saveCredentials } from '../src/credentials';
import { login, statusReport } from '../src/login';
import { HUB_URL, hubFixture } from './fixture';

const tempDir = () => mkdtempSync(join(tmpdir(), 'agflow-cfg-'));
const silent = { out: () => {}, err: () => {} };

describe('login', () => {
  test('waits for approval in the browser and saves the credentials', async () => {
    const hub = hubFixture();
    const dir = tempDir();
    const printed: string[] = [];
    let opened = '';
    const credentials = await login(`${HUB_URL}/`, { out: (t) => void printed.push(t), err: () => {} }, {
      fetch: hub.fetch,
      dir,
      host: 'laptop',
      pollMs: 1,
      timeoutMs: 1000,
      openUrl: (url) => {
        opened = url;
      },
      sleep: async () => {
        const code = new URL(opened).searchParams.get('code') ?? '';
        approveCliLogin(hub.ctx, code, 'alice', 'laptop');
      },
    });
    const code = new URL(opened).searchParams.get('code') ?? '';
    expect(new URL(opened).pathname).toBe('/cli-login');
    expect(new URL(opened).searchParams.get('label')).toBe('laptop');
    expect(printed.join('')).toContain(verificationCode(code));
    expect(credentials).toMatchObject({ hubUrl: HUB_URL, user: 'alice' });
    expect(loadCredentials(dir)?.token).toBe(credentials.token);
  });

  test('an expired approval ends the login', async () => {
    const hub = hubFixture();
    let opened = '';
    const attempt = login(HUB_URL, silent, {
      fetch: hub.fetch,
      dir: tempDir(),
      host: 'laptop',
      pollMs: 1,
      timeoutMs: 1000,
      openUrl: (url) => {
        opened = url;
      },
      sleep: async () => {
        approveCliLogin(hub.ctx, new URL(opened).searchParams.get('code') ?? '', 'alice');
        hub.clock.t += 11 * 60_000;
      },
    });
    await expect(attempt).rejects.toThrow('expired');
  });

  test('gives up after the timeout', async () => {
    const hub = hubFixture();
    const attempt = login(HUB_URL, silent, {
      fetch: hub.fetch,
      dir: tempDir(),
      host: 'laptop',
      pollMs: 1,
      timeoutMs: 3,
      openUrl: () => {},
      sleep: async () => {},
    });
    await expect(attempt).rejects.toThrow('timed out');
  });
});

describe('status', () => {
  test('reports the hub, account and project', async () => {
    const hub = hubFixture();
    const dir = tempDir();
    saveCredentials({ hubUrl: HUB_URL, token: hub.tokenFor('alice'), user: 'alice' }, dir);
    const report = await statusReport(dir, hub.fetch);
    expect(report).toContain(`Hub: ${HUB_URL}`);
    expect(report).toContain('Signed in as: alice');
    expect(report).toContain('Project: demo');
  });

  test('says so when signed out', async () => {
    expect(await statusReport(tempDir())).toContain('Not signed in');
  });
});

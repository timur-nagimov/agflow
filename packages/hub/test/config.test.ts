import { describe, expect, test } from 'bun:test';
import { loadConfig } from '../src/config';

const base = {
  AGFLOW_AUTH: 'dev',
  AGFLOW_ALLOWED_USERS: 'alice, bob',
  AGFLOW_PROJECT_NAME: 'demo',
  AGFLOW_PROJECT_REPO: 'https://github.com/acme/demo',
};
const github = { ...base, AGFLOW_AUTH: 'github', GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret' };

describe('loadConfig', () => {
  test('applies defaults', () => {
    const loaded = loadConfig(base);
    expect(loaded.host).toBe('127.0.0.1');
    expect(loaded.port).toBe(8787);
    expect(loaded.dbPath).toBe('data/agflow.db');
    expect(loaded.backupDir).toBe('data/backups');
    expect(loaded.config).toMatchObject({
      auth: 'dev',
      allowedUsers: ['alice', 'bob'],
      publicUrl: 'http://localhost:8787',
      leaseMs: 120 * 60_000,
      reminderMs: 30 * 60_000,
      maxOpenTasks: 200,
      maxTasksPerHour: 60,
      secureCookies: false,
    });
  });

  test('dev sign-in listens on loopback and GitHub sign-in on all interfaces', () => {
    expect(loadConfig({ ...base, AGFLOW_HOST: '' }).host).toBe('127.0.0.1');
    expect(loadConfig(github).host).toBe('0.0.0.0');
  });

  test('AGFLOW_HOST sets the listening address', () => {
    expect(loadConfig({ ...base, AGFLOW_HOST: '0.0.0.0' }).host).toBe('0.0.0.0');
    expect(loadConfig({ ...github, AGFLOW_HOST: '::' }).host).toBe('::');
  });

  test('secure cookies follow an https public URL', () => {
    const loaded = loadConfig({ ...base, AGFLOW_PUBLIC_URL: 'https://hub.example.com/' });
    expect(loaded.config.publicUrl).toBe('https://hub.example.com');
    expect(loaded.config.secureCookies).toBe(true);
    expect(loadConfig({ ...base, AGFLOW_PUBLIC_URL: 'HTTPS://Hub.Example.com/agflow//' }).config).toMatchObject({
      publicUrl: 'https://hub.example.com/agflow',
      secureCookies: true,
    });
  });

  test('accepts ports from 1 to 65535', () => {
    expect(loadConfig({ ...base, AGFLOW_PORT: '1' }).port).toBe(1);
    expect(loadConfig({ ...base, AGFLOW_PORT: '65535' }).port).toBe(65535);
  });

  test('rejects incomplete or invalid settings', () => {
    expect(() => loadConfig({ ...base, AGFLOW_ALLOWED_USERS: '' })).toThrow('AGFLOW_ALLOWED_USERS');
    expect(() => loadConfig({ ...base, AGFLOW_PROJECT_REPO: undefined })).toThrow('AGFLOW_PROJECT_REPO');
    expect(() => loadConfig({ ...base, AGFLOW_AUTH: 'github' })).toThrow('GITHUB_CLIENT_ID');
    expect(() => loadConfig({ ...base, AGFLOW_AUTH: 'magic' })).toThrow('AGFLOW_AUTH');
    expect(() => loadConfig({ ...base, AGFLOW_PORT: '-1' })).toThrow('AGFLOW_PORT');
    expect(() => loadConfig({ ...base, AGFLOW_PORT: '65536' })).toThrow('AGFLOW_PORT');
  });

  test('rejects a public URL that is not a plain http or https address', () => {
    for (const value of [
      '',
      'hub.example.com',
      'https://',
      'ftp://hub.example.com',
      'https://user:secret@hub.example.com',
      'https://hub.example.com/?next=/',
      'https://hub.example.com/#/tasks',
    ]) {
      expect(() => loadConfig({ ...base, AGFLOW_PUBLIC_URL: value })).toThrow('AGFLOW_PUBLIC_URL');
    }
  });
});

import { describe, expect, test } from 'bun:test';
import { loadConfig } from '../src/config';

const base = {
  AGFLOW_AUTH: 'dev',
  AGFLOW_ALLOWED_USERS: 'alice, bob',
  AGFLOW_PROJECT_NAME: 'demo',
  AGFLOW_PROJECT_REPO: 'https://github.com/acme/demo',
};

describe('loadConfig', () => {
  test('applies defaults', () => {
    const loaded = loadConfig(base);
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

  test('secure cookies follow an https public URL', () => {
    const loaded = loadConfig({ ...base, AGFLOW_PUBLIC_URL: 'https://hub.example.com/' });
    expect(loaded.config.publicUrl).toBe('https://hub.example.com');
    expect(loaded.config.secureCookies).toBe(true);
  });

  test('rejects incomplete or invalid settings', () => {
    expect(() => loadConfig({ ...base, AGFLOW_ALLOWED_USERS: '' })).toThrow('AGFLOW_ALLOWED_USERS');
    expect(() => loadConfig({ ...base, AGFLOW_PROJECT_REPO: undefined })).toThrow('AGFLOW_PROJECT_REPO');
    expect(() => loadConfig({ ...base, AGFLOW_AUTH: 'github' })).toThrow('GITHUB_CLIENT_ID');
    expect(() => loadConfig({ ...base, AGFLOW_AUTH: 'magic' })).toThrow('AGFLOW_AUTH');
    expect(() => loadConfig({ ...base, AGFLOW_PORT: '-1' })).toThrow('AGFLOW_PORT');
  });
});

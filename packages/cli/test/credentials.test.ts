import { describe, expect, test } from 'bun:test';
import { mkdtempSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialsPath, deleteCredentials, loadCredentials, saveCredentials } from '../src/credentials';
import { configDir } from '../src/paths';

const dir = () => mkdtempSync(join(tmpdir(), 'agflow-cfg-'));

describe('configDir', () => {
  test('defaults to ~/.config/agflow and honours AGFLOW_CONFIG_DIR', () => {
    expect(configDir({})).toBe(join(homedir(), '.config', 'agflow'));
    expect(configDir({ AGFLOW_CONFIG_DIR: '/tmp/x' })).toBe('/tmp/x');
  });
});

describe('credentials', () => {
  test('round-trip through a file only the owner can read', () => {
    const where = dir();
    saveCredentials({ hubUrl: 'https://hub.example', token: 't0ken', user: 'alice' }, where);
    expect(loadCredentials(where)).toEqual({ hubUrl: 'https://hub.example', token: 't0ken', user: 'alice' });
    expect(statSync(credentialsPath(where)).mode & 0o777).toBe(0o600);
  });

  test('missing or incomplete files mean signed out', () => {
    const where = dir();
    expect(loadCredentials(where)).toBeNull();
    saveCredentials({ hubUrl: 'h', token: '', user: 'alice' }, where);
    expect(loadCredentials(where)).toBeNull();
  });

  test('deleting signs out and is safe to repeat', () => {
    const where = dir();
    saveCredentials({ hubUrl: 'h', token: 't', user: 'alice' }, where);
    deleteCredentials(where);
    deleteCredentials(where);
    expect(loadCredentials(where)).toBeNull();
  });
});

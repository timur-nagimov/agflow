import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CREDENTIALS_FILE, CredentialsSchema } from '@agflow/core';
import { readCliCredentials } from '../../src/service/credentials';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agf-creds-'));
  dirs.push(dir);
  return dir;
}

describe('readCliCredentials', () => {
  test('parses with the core schema and rereads the file after login', () => {
    const dir = directory();
    const credentials = { hubUrl: 'http://localhost:9000', token: 'test-token', user: 'owner', future: true };
    writeFileSync(join(dir, CREDENTIALS_FILE), JSON.stringify(credentials));
    expect(readCliCredentials(dir)).toEqual(CredentialsSchema.parse(credentials));
    credentials.token = 'new-test-token';
    writeFileSync(join(dir, CREDENTIALS_FILE), JSON.stringify(credentials));
    expect(readCliCredentials(dir)?.token).toBe('new-test-token');
  });

  test('returns null for a missing file and names unreadable files', () => {
    const dir = directory();
    expect(readCliCredentials(dir)).toBeNull();
    expect(readCliCredentials(join(dir, 'absent'))).toBeNull();
    mkdirSync(join(dir, CREDENTIALS_FILE));
    expect(() => readCliCredentials(dir)).toThrow(`cannot read ${join(dir, CREDENTIALS_FILE)}`);
  });

  test.each(['{}', 'null', '{"hubUrl":"hub","token":"","user":"owner"}'])(
    'treats invalid credentials as signed out: %s',
    (content) => {
      const dir = directory();
      writeFileSync(join(dir, CREDENTIALS_FILE), content);
      expect(readCliCredentials(dir)).toBeNull();
    },
  );

  test('names a file that is not valid JSON', () => {
    const dir = directory();
    const path = join(dir, CREDENTIALS_FILE);
    writeFileSync(path, '{ broken');
    expect(() => readCliCredentials(dir)).toThrow(`${path} is not valid JSON; run agflow login`);
  });
});

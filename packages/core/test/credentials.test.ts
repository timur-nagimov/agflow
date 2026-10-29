import { describe, expect, test } from 'bun:test';
import { CREDENTIALS_FILE, type Credentials, CredentialsSchema } from '../src/credentials';

const credentials: Credentials = { hubUrl: 'https://hub.example', token: 'cli_t0ken', user: 'alice' };
const parses = (value: unknown) => CredentialsSchema.safeParse(value).success;

describe('credentials', () => {
  test('CredentialsSchema takes { hubUrl, token, user }', () => {
    expect(CredentialsSchema.parse(credentials)).toEqual(credentials);
  });

  test('a missing or empty field fails the parse, which readers take as signed out', () => {
    for (const key of ['hubUrl', 'token', 'user']) {
      const copy: Record<string, unknown> = { ...credentials };
      delete copy[key];
      expect([key, parses(copy)]).toEqual([key, false]);
      expect([key, parses({ ...credentials, [key]: '' })]).toEqual([key, false]);
      expect([key, parses({ ...credentials, [key]: 7 })]).toEqual([key, false]);
    }
    for (const odd of [null, [], 'credentials', 42]) expect([odd, parses(odd)]).toEqual([odd, false]);
  });

  test("keys it does not know are dropped, so a newer CLI's file still signs an older reader in", () => {
    expect(CredentialsSchema.parse({ ...credentials, label: 'laptop' })).toEqual(credentials);
  });

  test("CREDENTIALS_FILE is the CLI's credentials.json", () => {
    expect(CREDENTIALS_FILE).toBe('credentials.json');
  });

  test('the module reads no files and imports nothing from node:, so the web UI and the runner both use it', async () => {
    const source = await Bun.file(new URL('../src/credentials.ts', import.meta.url)).text();
    expect([...source.matchAll(/from '([^']+)'/g)].map((match) => match[1])).toEqual(['zod']);
    expect(source).not.toContain('node:');
  });
});

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CREDENTIALS_FILE, type Credentials, CredentialsSchema } from '@agflow/core';

export type { Credentials };

export function credentialsPath(dir: string): string {
  return join(dir, CREDENTIALS_FILE);
}

export function saveCredentials(credentials: Credentials, dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = credentialsPath(dir);
  writeFileSync(path, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function loadCredentials(dir: string): Credentials | null {
  const path = credentialsPath(dir);
  if (!existsSync(path)) return null;
  // Core's schema, which the runner reads the file with too: a missing or empty field means signed out.
  const parsed = CredentialsSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  return parsed.success ? parsed.data : null;
}

export function deleteCredentials(dir: string): void {
  rmSync(credentialsPath(dir), { force: true });
}

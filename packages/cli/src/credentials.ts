import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Credentials {
  hubUrl: string;
  token: string;
  user: string;
}

export function credentialsPath(dir: string): string {
  return join(dir, 'credentials.json');
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
  const data = JSON.parse(readFileSync(path, 'utf8')) as Partial<Credentials>;
  if (!data.hubUrl || !data.token || !data.user) return null;
  return { hubUrl: data.hubUrl, token: data.token, user: data.user };
}

export function deleteCredentials(dir: string): void {
  rmSync(credentialsPath(dir), { force: true });
}

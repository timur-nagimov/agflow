// CLI credentials for the runner (design 7.1 and 13): share core's schema without importing the CLI package.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CREDENTIALS_FILE, type Credentials, CredentialsSchema } from '@agflow/core';

/**
 * Re-read on each call so a new CLI login can reconnect the service. Missing or invalid credentials mean signed out;
 * unreadable files and invalid JSON report the file to repair.
 */
export function readCliCredentials(configDir: string): Credentials | null {
  const path = join(configDir, CREDENTIALS_FILE);
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`cannot read ${path}: ${(error as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new Error(`${path} is not valid JSON; run agflow login`);
  }
  const parsed = CredentialsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

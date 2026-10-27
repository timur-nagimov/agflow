import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where the CLI keeps credentials, logs and state. AGFLOW_CONFIG_DIR overrides it (tests, multiple hubs). */
export function configDir(env: Record<string, string | undefined> = process.env): string {
  return env.AGFLOW_CONFIG_DIR ?? join(homedir(), '.config', 'agflow');
}

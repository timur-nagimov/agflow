import type { HubConfig } from './context';

export interface LoadedConfig {
  config: HubConfig;
  host: string;
  port: number;
  dbPath: string;
  backupDir: string;
}

type Env = Record<string, string | undefined>;

function positiveInt(env: Env, key: string, fallback: number, max = Infinity): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${key} must be a positive integer`);
  if (value > max) throw new Error(`${key} must be at most ${max}`);
  return value;
}

export function loadConfig(env: Env): LoadedConfig {
  const auth = env.AGFLOW_AUTH ?? 'github';
  if (auth !== 'github' && auth !== 'dev') throw new Error('AGFLOW_AUTH must be "github" or "dev"');
  const allowedUsers = (env.AGFLOW_ALLOWED_USERS ?? '')
    .split(',')
    .map((user) => user.trim())
    .filter(Boolean);
  if (allowedUsers.length === 0) throw new Error('AGFLOW_ALLOWED_USERS must list at least one GitHub login');
  const projectName = env.AGFLOW_PROJECT_NAME;
  const projectRepo = env.AGFLOW_PROJECT_REPO;
  if (!projectName || !projectRepo) throw new Error('AGFLOW_PROJECT_NAME and AGFLOW_PROJECT_REPO are required');
  if (auth === 'github' && (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET)) {
    throw new Error('GitHub sign-in needs GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET');
  }
  const port = positiveInt(env, 'AGFLOW_PORT', 8787, 65535);
  // Dev sign-in needs no password, so a dev hub stays off the network unless AGFLOW_HOST says otherwise.
  const host = env.AGFLOW_HOST || (auth === 'dev' ? '127.0.0.1' : '0.0.0.0');
  const url = URL.parse(env.AGFLOW_PUBLIC_URL ?? `http://localhost:${port}`);
  if (url?.protocol !== 'http:' && url?.protocol !== 'https:') throw new Error('AGFLOW_PUBLIC_URL must be an http or https URL');
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('AGFLOW_PUBLIC_URL must not contain credentials, a query or a fragment');
  }
  const publicUrl = `${url.origin}${url.pathname}`.replace(/\/+$/, '');
  return {
    host,
    port,
    dbPath: env.AGFLOW_DB ?? 'data/agflow.db',
    backupDir: env.AGFLOW_BACKUP_DIR ?? 'data/backups',
    config: {
      publicUrl,
      auth,
      allowedUsers,
      githubClientId: env.GITHUB_CLIENT_ID,
      githubClientSecret: env.GITHUB_CLIENT_SECRET,
      projectName,
      projectRepo,
      leaseMs: positiveInt(env, 'AGFLOW_LEASE_MINUTES', 120) * 60_000,
      reminderMs: positiveInt(env, 'AGFLOW_REMINDER_MINUTES', 30) * 60_000,
      maxOpenTasks: positiveInt(env, 'AGFLOW_MAX_OPEN_TASKS', 200),
      maxTasksPerHour: positiveInt(env, 'AGFLOW_MAX_TASKS_PER_HOUR', 60),
      secureCookies: url.protocol === 'https:',
      webDist: env.AGFLOW_WEB_DIST,
    },
  };
}

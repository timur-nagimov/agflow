import type { HubConfig } from './context';

export interface LoadedConfig {
  config: HubConfig;
  port: number;
  dbPath: string;
  backupDir: string;
}

type Env = Record<string, string | undefined>;

function positiveInt(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${key} must be a positive integer`);
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
  const port = positiveInt(env, 'AGFLOW_PORT', 8787);
  const publicUrl = (env.AGFLOW_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, '');
  return {
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
      secureCookies: publicUrl.startsWith('https://'),
      webDist: env.AGFLOW_WEB_DIST,
    },
  };
}

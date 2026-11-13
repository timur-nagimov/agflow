import { BranchSchema, isValidWipRefPrefix } from '@agflow/core';
import { z } from 'zod';
import { HUB_RUNNER_DEFAULTS, type HubConfig, type HubRunnerSettings, stopGraceFor, wipGraceFor } from './context';

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

/** An opt-in switch: off when unset or empty, on only as "1". Anything else is a mistake worth stopping the start for. */
function switchOf(env: Env, key: string): boolean {
  const raw = env[key] ?? '';
  if (raw !== '' && raw !== '0' && raw !== '1') throw new Error(`${key} must be 0 or 1`);
  return raw === '1';
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;

type CountField = {
  [K in keyof HubRunnerSettings]: HubRunnerSettings[K] extends number ? K : never;
}[keyof HubRunnerSettings];

/** Section 12's environment overrides: each variable counts in its own unit. */
const RUNNER_VARIABLES: readonly (readonly [CountField, string, number])[] = [
  ['runnerLeaseMs', 'AGFLOW_RUNNER_LEASE_MINUTES', MINUTE],
  ['tickMs', 'AGFLOW_TICK_SECONDS', SECOND],
  ['stallMs', 'AGFLOW_STALL_MINUTES', MINUTE],
  ['toolCapMs', 'AGFLOW_TOOL_CAP_MINUTES', MINUTE],
  ['longToolCapMs', 'AGFLOW_LONG_TOOL_CAP_MINUTES', MINUTE],
  ['recoveryMs', 'AGFLOW_RECOVERY_SECONDS', SECOND],
  ['approvalMs', 'AGFLOW_APPROVAL_MINUTES', MINUTE],
  ['leadReviewMs', 'AGFLOW_LEAD_REVIEW_MINUTES', MINUTE],
  ['liveLeadGraceMs', 'AGFLOW_LIVE_LEAD_GRACE_MINUTES', MINUTE],
  ['quotaWaitMaxMs', 'AGFLOW_QUOTA_WAIT_MINUTES', MINUTE],
  ['quotaUnknownMs', 'AGFLOW_QUOTA_UNKNOWN_MINUTES', MINUTE],
  ['activeBudgetMs', 'AGFLOW_ACTIVE_BUDGET_MINUTES', MINUTE],
  ['submitTimeoutMs', 'AGFLOW_SUBMIT_TIMEOUT_MINUTES', MINUTE],
  ['maxWorkers', 'AGFLOW_MAX_WORKERS', 1],
  ['maxAttempts', 'AGFLOW_MAX_ATTEMPTS', 1],
  ['leadRotateWakeups', 'AGFLOW_LEAD_ROTATE_WAKEUPS', 1],
  ['maxPlanChangesPerHour', 'AGFLOW_MAX_PLAN_CHANGES_PER_HOUR', 1],
];

/** Outside test mode, shorter timings would end healthy work or leave people no time to answer. */
const PRODUCTION_MINIMUMS: Partial<Record<CountField, number>> = {
  tickMs: 5 * SECOND,
  recoveryMs: 30 * SECOND,
  runnerLeaseMs: 5 * MINUTE,
  stallMs: 5 * MINUTE,
  approvalMs: 5 * MINUTE,
  submitTimeoutMs: 5 * MINUTE,
};

type MillisecondField = { [K in keyof HubConfig]-?: K extends `${string}Ms` ? K : never }[keyof HubConfig];

const Milliseconds = z.number().int().positive();

/** AGFLOW_TEST_CONFIG: any of HubConfig's millisecond fields, and nothing else. */
const TestConfigSchema = z.strictObject({
  leaseMs: Milliseconds.optional(),
  reminderMs: Milliseconds.optional(),
  runnerLeaseMs: Milliseconds.optional(),
  tickMs: Milliseconds.optional(),
  stallMs: Milliseconds.optional(),
  toolCapMs: Milliseconds.optional(),
  longToolCapMs: Milliseconds.optional(),
  recoveryMs: Milliseconds.optional(),
  approvalMs: Milliseconds.optional(),
  leadReviewMs: Milliseconds.optional(),
  liveLeadGraceMs: Milliseconds.optional(),
  quotaWaitMaxMs: Milliseconds.optional(),
  quotaUnknownMs: Milliseconds.optional(),
  deliveryBatchMs: Milliseconds.optional(),
  stopGraceMs: Milliseconds.optional(),
  heartbeatMs: Milliseconds.optional(),
  deadLinkMs: Milliseconds.optional(),
  handoffMs: Milliseconds.optional(),
  wipGraceMs: Milliseconds.optional(),
  activeBudgetMs: Milliseconds.optional(),
  vendorErrorReplaceMs: Milliseconds.optional(),
  degradedMs: Milliseconds.optional(),
  dispatchHoldMs: Milliseconds.optional(),
  vendorRequirementMs: Milliseconds.optional(),
  handbackTimeoutMs: Milliseconds.optional(),
  infraBackoffMs: z.array(Milliseconds).min(1).optional(),
  resumeWindowMs: Milliseconds.optional(),
  leadExitWindowMs: Milliseconds.optional(),
  vendorPrefMs: Milliseconds.optional(),
  submitTimeoutMs: Milliseconds.optional(),
} satisfies Record<MillisecondField, z.ZodType>);

function testOverrides(raw: string): z.output<typeof TestConfigSchema> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error('AGFLOW_TEST_CONFIG must be a JSON object');
  }
  const parsed = TestConfigSchema.safeParse(json);
  if (!parsed.success) throw new Error(`AGFLOW_TEST_CONFIG: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** The environment's runner settings; the test configuration and the derived settings come later, in loadConfig. */
function runnerSettings(env: Env, testMode: boolean): HubRunnerSettings {
  const settings: HubRunnerSettings = { ...HUB_RUNNER_DEFAULTS, testMode };
  for (const [key, variable, unit] of RUNNER_VARIABLES) {
    if (!env[variable]) continue;
    const value = positiveInt(env, variable, 0) * unit;
    const minimum = PRODUCTION_MINIMUMS[key];
    if (!testMode && minimum !== undefined && value < minimum) {
      throw new Error(`${variable} must be at least ${minimum / unit} outside test mode (AGFLOW_TEST=1)`);
    }
    settings[key] = value;
  }
  if (env.AGFLOW_WIP_REF_PREFIX) {
    if (!isValidWipRefPrefix(env.AGFLOW_WIP_REF_PREFIX)) {
      throw new Error('AGFLOW_WIP_REF_PREFIX must name a namespace under refs/ that ends with "/", such as refs/agflow/');
    }
    settings.wipRefPrefix = env.AGFLOW_WIP_REF_PREFIX;
  }
  if (env.AGFLOW_MAIN_BRANCH) {
    if (!BranchSchema.safeParse(env.AGFLOW_MAIN_BRANCH).success) {
      throw new Error('AGFLOW_MAIN_BRANCH must be a git branch name');
    }
    settings.mainBranch = env.AGFLOW_MAIN_BRANCH;
  }
  return settings;
}

/** The hub's database file: AGFLOW_DB, or data/agflow.db. The restore command reads it the same way. */
export function databasePath(env: Env): string {
  return env.AGFLOW_DB ?? 'data/agflow.db';
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
  const operatorToken = env.AGFLOW_OPERATOR_TOKEN || null;
  const operatorLogin = env.AGFLOW_OPERATOR_USER?.trim().toLowerCase() || null;
  let operatorUser: string | null = null;
  if (operatorToken !== null) {
    if (operatorToken.length < 32) throw new Error('AGFLOW_OPERATOR_TOKEN must be at least 32 characters');
    if (!operatorLogin) throw new Error('AGFLOW_OPERATOR_TOKEN needs AGFLOW_OPERATOR_USER, the person it acts as');
    operatorUser = operatorLogin;
    if (!allowedUsers.some((user) => user.toLowerCase() === operatorUser)) {
      throw new Error('AGFLOW_OPERATOR_USER must be one of AGFLOW_ALLOWED_USERS');
    }
  }
  const needMerge = switchOf(env, 'AGFLOW_DEPENDENCIES_NEED_MERGE');
  const agentFetch = switchOf(env, 'AGFLOW_AGENT_FETCH');
  const leadApprovals = switchOf(env, 'AGFLOW_LEAD_APPROVALS');
  const testMode = env.AGFLOW_TEST === '1';
  if (env.AGFLOW_TEST_CONFIG && !testMode) throw new Error('AGFLOW_TEST_CONFIG is honoured only with AGFLOW_TEST=1');
  const config: HubConfig = {
    ...runnerSettings(env, testMode),
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
    operatorToken,
    operatorUser,
    dependenciesNeedMerge: needMerge,
    agentFetch,
    leadApprovals,
  };
  const overrides = env.AGFLOW_TEST_CONFIG ? testOverrides(env.AGFLOW_TEST_CONFIG) : {};
  Object.assign(config, overrides);
  // The derived settings follow their base, wherever it came from, unless the test configuration sets them.
  config.stopGraceMs = overrides.stopGraceMs ?? stopGraceFor(config.handoffMs);
  config.wipGraceMs = overrides.wipGraceMs ?? wipGraceFor(config.runnerLeaseMs);
  return {
    host,
    port,
    dbPath: databasePath(env),
    backupDir: env.AGFLOW_BACKUP_DIR ?? 'data/backups',
    config,
  };
}

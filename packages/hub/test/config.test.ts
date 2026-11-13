import { describe, expect, test } from 'bun:test';
import { loadConfig } from '../src/config';
import { HUB_RUNNER_DEFAULTS, type HubConfig } from '../src/context';
import { makeConfig } from './helpers';

const base = {
  AGFLOW_AUTH: 'dev',
  AGFLOW_ALLOWED_USERS: 'alice, bob',
  AGFLOW_PROJECT_NAME: 'demo',
  AGFLOW_PROJECT_REPO: 'https://github.com/acme/demo',
};
const github = { ...base, AGFLOW_AUTH: 'github', GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret' };

describe('loadConfig', () => {
  test('applies defaults', () => {
    const loaded = loadConfig(base);
    expect(loaded.host).toBe('127.0.0.1');
    expect(loaded.port).toBe(8787);
    expect(loaded.dbPath).toBe('data/agflow.db');
    expect(loaded.backupDir).toBe('data/backups');
    expect(loaded.config).toMatchObject({
      auth: 'dev',
      allowedUsers: ['alice', 'bob'],
      publicUrl: 'http://localhost:8787',
      leaseMs: 120 * 60_000,
      reminderMs: 30 * 60_000,
      maxOpenTasks: 200,
      maxTasksPerHour: 60,
      secureCookies: false,
    });
  });

  test('dev sign-in listens on loopback and GitHub sign-in on all interfaces', () => {
    expect(loadConfig({ ...base, AGFLOW_HOST: '' }).host).toBe('127.0.0.1');
    expect(loadConfig(github).host).toBe('0.0.0.0');
  });

  test('AGFLOW_HOST sets the listening address', () => {
    expect(loadConfig({ ...base, AGFLOW_HOST: '0.0.0.0' }).host).toBe('0.0.0.0');
    expect(loadConfig({ ...github, AGFLOW_HOST: '::' }).host).toBe('::');
  });

  test('secure cookies follow an https public URL', () => {
    const loaded = loadConfig({ ...base, AGFLOW_PUBLIC_URL: 'https://hub.example.com/' });
    expect(loaded.config.publicUrl).toBe('https://hub.example.com');
    expect(loaded.config.secureCookies).toBe(true);
    expect(loadConfig({ ...base, AGFLOW_PUBLIC_URL: 'HTTPS://Hub.Example.com/agflow//' }).config).toMatchObject({
      publicUrl: 'https://hub.example.com/agflow',
      secureCookies: true,
    });
  });

  test('accepts ports from 1 to 65535', () => {
    expect(loadConfig({ ...base, AGFLOW_PORT: '1' }).port).toBe(1);
    expect(loadConfig({ ...base, AGFLOW_PORT: '65535' }).port).toBe(65535);
  });

  test('rejects incomplete or invalid settings', () => {
    expect(() => loadConfig({ ...base, AGFLOW_ALLOWED_USERS: '' })).toThrow('AGFLOW_ALLOWED_USERS');
    expect(() => loadConfig({ ...base, AGFLOW_PROJECT_REPO: undefined })).toThrow('AGFLOW_PROJECT_REPO');
    expect(() => loadConfig({ ...base, AGFLOW_AUTH: 'github' })).toThrow('GITHUB_CLIENT_ID');
    expect(() => loadConfig({ ...base, AGFLOW_AUTH: 'magic' })).toThrow('AGFLOW_AUTH');
    expect(() => loadConfig({ ...base, AGFLOW_PORT: '-1' })).toThrow('AGFLOW_PORT');
    expect(() => loadConfig({ ...base, AGFLOW_PORT: '65536' })).toThrow('AGFLOW_PORT');
  });

  test('rejects a public URL that is not a plain http or https address', () => {
    for (const value of [
      '',
      'hub.example.com',
      'https://',
      'ftp://hub.example.com',
      'https://user:secret@hub.example.com',
      'https://hub.example.com/?next=/',
      'https://hub.example.com/#/tasks',
    ]) {
      expect(() => loadConfig({ ...base, AGFLOW_PUBLIC_URL: value })).toThrow('AGFLOW_PUBLIC_URL');
    }
  });
});

const MINUTE = 60_000;

describe('loadConfig: runner settings', () => {
  test('without environment every setting has its default, and the derived ones follow their base', () => {
    const { config } = loadConfig(base);
    expect(config).toMatchObject({ ...HUB_RUNNER_DEFAULTS, testMode: false });
    expect(HUB_RUNNER_DEFAULTS).toMatchObject({
      runnerLeaseMs: 15 * MINUTE,
      tickMs: 15_000,
      stallMs: 10 * MINUTE,
      toolCapMs: 30 * MINUTE,
      longToolCapMs: 90 * MINUTE,
      recoveryMs: 2 * MINUTE,
      approvalMs: 15 * MINUTE,
      leadReviewMs: 45 * MINUTE,
      liveLeadGraceMs: 120 * MINUTE,
      quotaWaitMaxMs: 45 * MINUTE,
      quotaUnknownMs: 30 * MINUTE,
      deliveryBatchMs: 2_000,
      heartbeatMs: 15_000,
      deadLinkMs: 45_000,
      handoffMs: 3 * MINUTE,
      activeBudgetMs: 4 * 60 * MINUTE,
      maxContinuations: 25,
      vendorErrorReplaceMs: 60 * MINUTE,
      degradedMs: 60 * MINUTE,
      dispatchHoldMs: 2 * MINUTE,
      vendorRequirementMs: 10 * MINUTE,
      handbackTimeoutMs: 10 * MINUTE,
      infraBackoffMs: [1, 2, 5, 15, 30].map((minutes) => minutes * MINUTE),
      resumeWindowMs: 60 * MINUTE,
      leadExitWindowMs: 60 * MINUTE,
      vendorPrefMs: 60 * MINUTE,
      submitTimeoutMs: 15 * MINUTE,
      maxWorkers: 4,
      maxAttempts: 3,
      leadRotateWakeups: 20,
      maxPlanChangesPerHour: 60,
      wipRefPrefix: 'refs/agflow/',
      mainBranch: 'main',
      minProtocol: 1,
      testMode: false,
    });
    expect(config.stopGraceMs).toBe(config.handoffMs + 5 * MINUTE);
    expect(config.wipGraceMs).toBe(config.runnerLeaseMs / 3);
    expect(HUB_RUNNER_DEFAULTS.stopGraceMs).toBe(8 * MINUTE);
    expect(HUB_RUNNER_DEFAULTS.wipGraceMs).toBe(5 * MINUTE);
  });

  test('each variable is read in its unit', () => {
    const { config } = loadConfig({
      ...base,
      AGFLOW_RUNNER_LEASE_MINUTES: '30',
      AGFLOW_TICK_SECONDS: '20',
      AGFLOW_STALL_MINUTES: '11',
      AGFLOW_TOOL_CAP_MINUTES: '31',
      AGFLOW_LONG_TOOL_CAP_MINUTES: '91',
      AGFLOW_RECOVERY_SECONDS: '45',
      AGFLOW_APPROVAL_MINUTES: '16',
      AGFLOW_LEAD_REVIEW_MINUTES: '46',
      AGFLOW_LIVE_LEAD_GRACE_MINUTES: '121',
      AGFLOW_QUOTA_WAIT_MINUTES: '47',
      AGFLOW_QUOTA_UNKNOWN_MINUTES: '32',
      AGFLOW_ACTIVE_BUDGET_MINUTES: '300',
      AGFLOW_SUBMIT_TIMEOUT_MINUTES: '17',
      AGFLOW_MAX_WORKERS: '6',
      AGFLOW_MAX_ATTEMPTS: '5',
      AGFLOW_LEAD_ROTATE_WAKEUPS: '12',
      AGFLOW_MAX_PLAN_CHANGES_PER_HOUR: '90',
      AGFLOW_WIP_REF_PREFIX: 'refs/agflow-test/',
      AGFLOW_MAIN_BRANCH: 'trunk',
    });
    expect(config).toMatchObject({
      runnerLeaseMs: 30 * MINUTE,
      tickMs: 20_000,
      stallMs: 11 * MINUTE,
      toolCapMs: 31 * MINUTE,
      longToolCapMs: 91 * MINUTE,
      recoveryMs: 45_000,
      approvalMs: 16 * MINUTE,
      leadReviewMs: 46 * MINUTE,
      liveLeadGraceMs: 121 * MINUTE,
      quotaWaitMaxMs: 47 * MINUTE,
      quotaUnknownMs: 32 * MINUTE,
      activeBudgetMs: 300 * MINUTE,
      submitTimeoutMs: 17 * MINUTE,
      maxWorkers: 6,
      maxAttempts: 5,
      leadRotateWakeups: 12,
      maxPlanChangesPerHour: 90,
      wipRefPrefix: 'refs/agflow-test/',
      mainBranch: 'trunk',
      // A longer lease gives WIP pushes a longer grace.
      wipGraceMs: 10 * MINUTE,
    });
  });

  test('refuses a WIP ref prefix or main branch git would not take', () => {
    for (const prefix of ['refs/agflow', 'agflow/', 'refs/../x/', 'refs/agflow-local/']) {
      expect(() => loadConfig({ ...base, AGFLOW_WIP_REF_PREFIX: prefix })).toThrow('AGFLOW_WIP_REF_PREFIX');
    }
    for (const branch of ['-main', 'a..b', 'main.', 'has space', 'x.lock']) {
      expect(() => loadConfig({ ...base, AGFLOW_MAIN_BRANCH: branch })).toThrow('AGFLOW_MAIN_BRANCH');
    }
    expect(() => loadConfig({ ...base, AGFLOW_MAX_WORKERS: '0' })).toThrow('AGFLOW_MAX_WORKERS');
    expect(() => loadConfig({ ...base, AGFLOW_STALL_MINUTES: '1.5' })).toThrow('AGFLOW_STALL_MINUTES');
  });

  test('outside test mode values below the minimums are refused', () => {
    const below: [string, string, keyof HubConfig, number][] = [
      ['AGFLOW_TICK_SECONDS', '4', 'tickMs', 4_000],
      ['AGFLOW_RECOVERY_SECONDS', '29', 'recoveryMs', 29_000],
      ['AGFLOW_RUNNER_LEASE_MINUTES', '4', 'runnerLeaseMs', 4 * MINUTE],
      ['AGFLOW_STALL_MINUTES', '4', 'stallMs', 4 * MINUTE],
      ['AGFLOW_APPROVAL_MINUTES', '4', 'approvalMs', 4 * MINUTE],
      ['AGFLOW_SUBMIT_TIMEOUT_MINUTES', '4', 'submitTimeoutMs', 4 * MINUTE],
    ];
    for (const [key, value, field, ms] of below) {
      expect(() => loadConfig({ ...base, [key]: value })).toThrow(`${key} must be at least`);
      // Test mode applies the short value.
      expect(loadConfig({ ...base, AGFLOW_TEST: '1', [key]: value }).config[field]).toBe(ms);
    }
    expect(loadConfig({ ...base, AGFLOW_TICK_SECONDS: '5', AGFLOW_RUNNER_LEASE_MINUTES: '5' }).config).toMatchObject({
      tickMs: 5_000,
      runnerLeaseMs: 5 * MINUTE,
    });
  });

  test('AGFLOW_TEST_CONFIG overrides millisecond settings in test mode only', () => {
    const timings = JSON.stringify({ tickMs: 200, runnerLeaseMs: 3_000, handoffMs: 600, infraBackoffMs: [100, 200] });
    const { config } = loadConfig({ ...base, AGFLOW_TEST: '1', AGFLOW_TEST_CONFIG: timings });
    expect(config).toMatchObject({
      testMode: true,
      tickMs: 200,
      runnerLeaseMs: 3_000,
      handoffMs: 600,
      infraBackoffMs: [100, 200],
      // Derived settings follow their overridden base.
      wipGraceMs: 1_000,
      stopGraceMs: 600 + 5 * MINUTE,
    });
    // It wins over the environment, and a derived setting it names is kept.
    const set = loadConfig({
      ...base,
      AGFLOW_TEST: '1',
      AGFLOW_STALL_MINUTES: '20',
      AGFLOW_TEST_CONFIG: JSON.stringify({ stallMs: 1_500, runnerLeaseMs: 3_000, wipGraceMs: 2_500, stopGraceMs: 900 }),
    }).config;
    expect(set).toMatchObject({ stallMs: 1_500, wipGraceMs: 2_500, stopGraceMs: 900 });
    expect(() => loadConfig({ ...base, AGFLOW_TEST_CONFIG: timings })).toThrow('AGFLOW_TEST=1');
    expect(() => loadConfig({ ...base, AGFLOW_TEST: '0', AGFLOW_TEST_CONFIG: timings })).toThrow('AGFLOW_TEST=1');
  });

  test('AGFLOW_TEST_CONFIG refuses unknown keys and values that are not positive whole milliseconds', () => {
    const test = (value: unknown) => ({ ...base, AGFLOW_TEST: '1', AGFLOW_TEST_CONFIG: JSON.stringify(value) });
    for (const value of [
      { tickMS: 200 },
      { maxWorkers: 2 },
      { mainBranch: 'trunk' },
      { tickMs: 0 },
      { tickMs: 1.5 },
      { tickMs: '200' },
      { infraBackoffMs: [] },
      { infraBackoffMs: [100, -1] },
      [200],
      null,
    ]) {
      expect(() => loadConfig(test(value))).toThrow('AGFLOW_TEST_CONFIG');
    }
    const unreadable = { ...base, AGFLOW_TEST: '1', AGFLOW_TEST_CONFIG: '{tickMs: 200}' };
    expect(() => loadConfig(unreadable)).toThrow('AGFLOW_TEST_CONFIG must be a JSON object');
    // M1's own millisecond settings are HubConfig fields too.
    const m1 = loadConfig(test({ leaseMs: 4_000, reminderMs: 2_000 })).config;
    expect(m1).toMatchObject({ leaseMs: 4_000, reminderMs: 2_000 });
  });
});

describe('the unattended options', () => {
  test('AGFLOW_AGENT_FETCH is off unless it is 1, and anything but 0 or 1 refuses to start', () => {
    expect(loadConfig(base).config.agentFetch).toBe(false);
    expect(loadConfig({ ...base, AGFLOW_AGENT_FETCH: '' }).config.agentFetch).toBe(false);
    expect(loadConfig({ ...base, AGFLOW_AGENT_FETCH: '0' }).config.agentFetch).toBe(false);
    expect(loadConfig({ ...base, AGFLOW_AGENT_FETCH: '1' }).config.agentFetch).toBe(true);
    for (const value of ['yes', 'true', '2', ' 1', 'on']) {
      expect(() => loadConfig({ ...base, AGFLOW_AGENT_FETCH: value })).toThrow('AGFLOW_AGENT_FETCH must be 0 or 1');
    }
  });

  test('AGFLOW_LEAD_APPROVALS is off unless it is 1, and anything but 0 or 1 refuses to start', () => {
    expect(loadConfig(base).config.leadApprovals).toBe(false);
    expect(loadConfig({ ...base, AGFLOW_LEAD_APPROVALS: '' }).config.leadApprovals).toBe(false);
    expect(loadConfig({ ...base, AGFLOW_LEAD_APPROVALS: '0' }).config.leadApprovals).toBe(false);
    expect(loadConfig({ ...base, AGFLOW_LEAD_APPROVALS: '1' }).config.leadApprovals).toBe(true);
    for (const value of ['yes', 'true', '2', ' 1', 'on']) {
      expect(() => loadConfig({ ...base, AGFLOW_LEAD_APPROVALS: value })).toThrow('AGFLOW_LEAD_APPROVALS must be 0 or 1');
    }
  });
});

describe('makeConfig', () => {
  test('a HubConfig built in code spreads the runner defaults', () => {
    expect(makeConfig()).toMatchObject(HUB_RUNNER_DEFAULTS);
    expect(makeConfig({ tickMs: 100 }).tickMs).toBe(100);
  });
});

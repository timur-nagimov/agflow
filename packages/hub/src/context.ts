import type { Database } from 'bun:sqlite';
import { DEFAULT_INFRA_BACKOFF_MS, DEFAULT_WIP_REF_PREFIX, type HubEvent } from '@agflow/core';
import { openDb } from './db';
import { type Emit, EventBus, insertEvent } from './events';

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** The hub's runner settings (design section 12). Durations are in milliseconds. */
export interface HubRunnerSettings {
  /** How long an attempt's runner may stay silent before the attempt ends lost. */
  runnerLeaseMs: number;
  tickMs: number;
  stallMs: number;
  toolCapMs: number;
  longToolCapMs: number;
  /** After a restart or downtime, the window in which the tick reconciles nothing. */
  recoveryMs: number;
  approvalMs: number;
  leadReviewMs: number;
  liveLeadGraceMs: number;
  quotaWaitMaxMs: number;
  quotaUnknownMs: number;
  deliveryBatchMs: number;
  /** Stop timeout: handoffMs plus 5 minutes. */
  stopGraceMs: number;
  heartbeatMs: number;
  deadLinkMs: number;
  handoffMs: number;
  /** runnerLeaseMs / 3: how long a runner may push WIP without hearing from the hub (design 7.3). */
  wipGraceMs: number;
  activeBudgetMs: number;
  maxContinuations: number;
  vendorErrorReplaceMs: number;
  degradedMs: number;
  dispatchHoldMs: number;
  vendorRequirementMs: number;
  handbackTimeoutMs: number;
  /** The infra backoff after each consecutive infra failure; the last step repeats. */
  infraBackoffMs: readonly number[];
  resumeWindowMs: number;
  leadExitWindowMs: number;
  vendorPrefMs: number;
  submitTimeoutMs: number;
  maxWorkers: number;
  maxAttempts: number;
  leadRotateWakeups: number;
  maxPlanChangesPerHour: number;
  wipRefPrefix: string;
  mainBranch: string;
  /** The oldest runner protocol this hub accepts. */
  minProtocol: number;
  /** AGFLOW_TEST=1: settings below the production minimums are accepted. */
  testMode: boolean;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** Section 12's defaults. Code that builds a HubConfig directly (tests, the demo) spreads them. */
export const HUB_RUNNER_DEFAULTS: Readonly<HubRunnerSettings> = Object.freeze({
  runnerLeaseMs: 15 * MINUTE,
  tickMs: 15 * SECOND,
  stallMs: 10 * MINUTE,
  toolCapMs: 30 * MINUTE,
  longToolCapMs: 90 * MINUTE,
  recoveryMs: 2 * MINUTE,
  approvalMs: 15 * MINUTE,
  leadReviewMs: 45 * MINUTE,
  liveLeadGraceMs: 120 * MINUTE,
  quotaWaitMaxMs: 45 * MINUTE,
  quotaUnknownMs: 30 * MINUTE,
  deliveryBatchMs: 2 * SECOND,
  stopGraceMs: stopGraceFor(3 * MINUTE),
  heartbeatMs: 15 * SECOND,
  deadLinkMs: 45 * SECOND,
  handoffMs: 3 * MINUTE,
  wipGraceMs: wipGraceFor(15 * MINUTE),
  activeBudgetMs: 4 * 60 * MINUTE,
  maxContinuations: 25,
  vendorErrorReplaceMs: 60 * MINUTE,
  degradedMs: 60 * MINUTE,
  dispatchHoldMs: 2 * MINUTE,
  vendorRequirementMs: 10 * MINUTE,
  handbackTimeoutMs: 10 * MINUTE,
  infraBackoffMs: DEFAULT_INFRA_BACKOFF_MS,
  resumeWindowMs: 60 * MINUTE,
  leadExitWindowMs: 60 * MINUTE,
  vendorPrefMs: 60 * MINUTE,
  submitTimeoutMs: 15 * MINUTE,
  maxWorkers: 4,
  maxAttempts: 3,
  leadRotateWakeups: 20,
  maxPlanChangesPerHour: 60,
  wipRefPrefix: DEFAULT_WIP_REF_PREFIX,
  mainBranch: 'main',
  minProtocol: 1,
  testMode: false,
});

/** The stop timeout leaves a handoff turn its full time, plus 5 minutes for the exit and the final push. */
export function stopGraceFor(handoffMs: number): number {
  return handoffMs + 5 * MINUTE;
}

/** A third of the lease: well inside it and the stop timeout, so the hub cannot end the attempt meanwhile (X-11). */
export function wipGraceFor(runnerLeaseMs: number): number {
  return Math.max(1, Math.floor(runnerLeaseMs / 3));
}

export interface HubConfig extends HubRunnerSettings {
  publicUrl: string;
  auth: 'github' | 'dev';
  allowedUsers: string[];
  githubClientId?: string | undefined;
  githubClientSecret?: string | undefined;
  projectName: string;
  projectRepo: string;
  leaseMs: number;
  reminderMs: number;
  maxOpenTasks: number;
  maxTasksPerHour: number;
  secureCookies: boolean;
  webDist?: string | undefined;
}

export interface HubContext {
  db: Database;
  bus: EventBus;
  config: HubConfig;
  now: () => number;
  fetch: FetchFn;
}

export interface ContextOptions {
  dbPath: string;
  config: HubConfig;
  now?: (() => number) | undefined;
  fetch?: FetchFn | undefined;
}

export function createContext(options: ContextOptions): HubContext {
  const now = options.now ?? (() => Date.now());
  const db = openDb(options.dbPath, now());
  db.query('INSERT OR IGNORE INTO project (id, name, repo, paused) VALUES (1, $name, $repo, 0)').run({
    name: options.config.projectName,
    repo: options.config.projectRepo,
  });
  return {
    db,
    bus: new EventBus(),
    config: options.config,
    now,
    fetch: options.fetch ?? ((input, init) => fetch(input, init)),
  };
}

/** Runs fn in one SQLite transaction and publishes its events only after the commit. */
export function tx<T>(ctx: HubContext, fn: (emit: Emit) => T): T {
  const emitted: HubEvent[] = [];
  const emit: Emit = (event) => {
    const stored = insertEvent(ctx.db, ctx.now(), event);
    emitted.push(stored);
    return stored;
  };
  const result = ctx.db.transaction(() => fn(emit))() as T;
  for (const event of emitted) ctx.bus.publish(event);
  return result;
}

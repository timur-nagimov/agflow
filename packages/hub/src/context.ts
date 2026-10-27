import type { Database } from 'bun:sqlite';
import type { HubEvent } from '@agflow/core';
import { openDb } from './db';
import { type Emit, EventBus, insertEvent } from './events';

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface HubConfig {
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
  const db = openDb(options.dbPath);
  db.query('INSERT OR IGNORE INTO project (id, name, repo, paused) VALUES (1, $name, $repo, 0)').run({
    name: options.config.projectName,
    repo: options.config.projectRepo,
  });
  return {
    db,
    bus: new EventBus(),
    config: options.config,
    now: options.now ?? (() => Date.now()),
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

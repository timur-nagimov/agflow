// Laptop retention (design 7.8). The service's runner.lock holder calls this; clones belong to cleanup_attempt.
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Vendor } from '@agflow/core';
import { z } from 'zod';
import type { VendorAdapter } from '../adapters/types';
import type { AttemptStore } from '../attempt-store';
import type { Vault } from '../git/vault';
import type { Journal } from '../journal';
import { type Logger, noopLogger } from '../log';
import type { Outbox } from '../outbox';
import type { RunnerPaths } from '../paths';
import { prepLayout, PrepState } from '../prep/plan';
import { launchdLogPaths, trimLaunchdLogs } from '../service/log';
import { VENDOR_PINS, vendorPlatform } from '../vendor/pins';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

export const RETENTION = Object.freeze({
  journalMs: 14 * DAY,
  outboxMs: 14 * DAY,
  attemptLogMs: 14 * DAY,
  endedAttemptMs: 14 * DAY,
  sweepIntervalMs: DAY,
  /** How often the service asks; logs/retention.json keeps the sweep daily, from the start of the last one. */
  checkIntervalMs: HOUR,
  consolidationIntervalMs: DAY,
  quarantineMs: HOUR,
});

export interface RetentionInput {
  paths: RunnerPaths;
  outbox: Pick<Outbox, 'pruneAcked' | 'pruneBefore'>;
  journal: Pick<Journal, 'pruneBefore'>;
  store: Pick<AttemptStore, 'list' | 'remove'>;
  vaults: readonly Pick<Vault, 'project' | 'consolidate'>[];
  adapters: ReadonlyMap<Vendor, Pick<VendorAdapter, 'deleteTranscript'>>;
  eventRetentionMs: number;
  now?: () => number;
  logger?: Logger;
  /** vendorPlatform() by default; its VENDOR_PINS are the running pins. */
  platform?: string;
  /** The service's shutdown: the sweep stops before its next step, and the step under way finishes. */
  signal?: AbortSignal;
}

/** Counts are successful removals; failed steps are logged and can retry on the next daily sweep. */
export interface RetentionResult {
  ran: boolean;
  ackedEvents: number;
  outboxEvents: number;
  journalRows: number;
  attemptLogs: number;
  attempts: number;
  transcripts: number;
  vendorVersions: number;
  quarantines: number;
  prepStates: number;
  launchdLogs: string[];
  consolidatedVaults: string[];
  failedSteps: string[];
}

const Time = z.number().int().nonnegative();
const StateSchema = z.strictObject({
  sweptAt: Time,
  consolidatedAt: z.record(z.string(), Time),
});
type State = z.output<typeof StateSchema>;

/** Numeric major.minor.patch order; both are VERSION-shaped directory names or pins. */
function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function statOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Check containers too: unlinking a child through a directory symlink would delete in its target. AGFLOW_HOME itself
 * is the owner's choice and may be a link.
 */
function directoryExists(paths: RunnerPaths, path: string): boolean {
  const tail = relative(paths.home, path);
  if (isAbsolute(tail) || tail === '..' || tail.startsWith(`..${sep}`)) {
    throw new Error(`retention path outside AGFLOW_HOME: ${path}`);
  }
  if (!existsSync(paths.home)) return false;
  if (!statSync(paths.home).isDirectory()) throw new Error(`AGFLOW_HOME is not a directory: ${paths.home}`);
  let current = paths.home;
  for (const part of tail.split(sep).filter(Boolean)) {
    current = join(current, part);
    const stat = statOrNull(current);
    if (!stat) return false;
    if (!stat.isDirectory()) throw new Error(`retention needs a real directory: ${current}`);
  }
  return true;
}

function entries(paths: RunnerPaths, path: string) {
  return directoryExists(paths, path) ? readdirSync(path, { withFileTypes: true }) : [];
}

function readState(paths: RunnerPaths): State | null {
  try {
    if (!directoryExists(paths, paths.logs)) return null;
    const path = join(paths.logs, 'retention.json');
    if (!statOrNull(path)?.isFile()) return null;
    return StateSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    // Missing, unreadable or corrupt state must not prevent retention after a restart.
    return null;
  }
}

function saveState(paths: RunnerPaths, state: State): void {
  directoryExists(paths, paths.logs);
  mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
  const temporary = join(paths.logs, `.retention.json.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, join(paths.logs, 'retention.json'));
  } finally {
    rmSync(temporary, { force: true });
  }
}

function due(previous: number | undefined, at: number, interval: number): boolean {
  return previous === undefined || previous > at || at - previous >= interval;
}

const underway = new Map<string, Promise<RetentionResult>>();

/** Only the lock holder may call this. Calls for the same home share the sweep already underway. */
export function sweepRetention(input: RetentionInput): Promise<RetentionResult> {
  const key = resolve(input.paths.home);
  const existing = underway.get(key);
  if (existing) return existing;
  const pending = sweep(input).finally(() => underway.delete(key));
  underway.set(key, pending);
  return pending;
}

async function sweep(input: RetentionInput): Promise<RetentionResult> {
  const { paths, outbox, journal, store } = input;
  const now = input.now ?? Date.now;
  const at = now();
  const logger = input.logger ?? noopLogger;
  const state = readState(paths);
  const result: RetentionResult = {
    ran: false,
    ackedEvents: 0,
    outboxEvents: 0,
    journalRows: 0,
    attemptLogs: 0,
    attempts: 0,
    transcripts: 0,
    vendorVersions: 0,
    quarantines: 0,
    prepStates: 0,
    launchdLogs: [],
    consolidatedVaults: [],
    failedSteps: [],
  };
  if (!due(state?.sweptAt, at, RETENTION.sweepIntervalMs)) return result;
  result.ran = true;

  const attempt = async (name: string, run: () => void | Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      if (!result.failedSteps.includes(name)) result.failedSteps.push(name);
      logger.warn('retention step failed', {
        step: name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const step = async (name: string, run: () => void | Promise<void>): Promise<void> => {
    if (!input.signal?.aborted) await attempt(name, run);
  };

  await step('pruneAcked', () => {
    result.ackedEvents = outbox.pruneAcked(input.eventRetentionMs);
  });
  await step('pruneOutbox', () => {
    result.outboxEvents = outbox.pruneBefore(at - RETENTION.outboxMs);
  });
  await step('pruneJournal', () => {
    result.journalRows = journal.pruneBefore(at - RETENTION.journalMs);
  });

  await step('attemptLogs', async () => {
    const root = join(paths.logs, 'attempts');
    for (const entry of entries(paths, root)) {
      await step('attemptLogs', () => {
        const path = join(root, entry.name);
        const stat = statOrNull(path);
        if (stat?.isFile() && stat.mtimeMs < at - RETENTION.attemptLogMs) {
          rmSync(path);
          result.attemptLogs++;
        }
      });
    }
  });

  await step('endedAttempts', async () => {
    for (const record of store.list()) {
      await step('endedAttempts', async () => {
        if (record.lateWorkSha !== null) return;
        if (record.endedAt === null || record.endedAt >= at - RETENTION.endedAttemptMs) return;
        // lstat preserves even a dangling clone link; only an absent path is known to be gone.
        if (record.clone !== null && statOrNull(record.clone) !== null) return;
        const adapter = input.adapters.get(record.spec.vendor);
        if (record.clone !== null && record.sessionRef !== null && adapter) {
          await adapter.deleteTranscript({ sessionRef: record.sessionRef, clone: record.clone });
          result.transcripts++;
        }
        // A null clone was already cleaned up, including its transcript, by cleanup_attempt.
        store.remove(record.attemptId);
        result.attempts++;
      });
    }
  });

  await step('vendorVersions', async () => {
    const platformPins = VENDOR_PINS[input.platform ?? vendorPlatform()];
    const pins = { claude: platformPins?.claude.version, codex: platformPins?.codex.version };
    const records = store.list();
    for (const vendor of ['claude', 'codex'] as const) {
      await step('vendorVersions', async () => {
        const used = new Set(
          records.filter((record) => record.spec.vendor === vendor).map((record) => record.cliVersion),
        );
        const root = join(paths.vendor, vendor);
        for (const entry of entries(paths, root)) {
          if (!/^\d+\.\d+\.\d+$/.test(entry.name) || used.has(entry.name)) continue;
          // An upgrade can install its pin before this older runner restarts; only versions below the running pin go.
          const pin = pins[vendor];
          if (pin !== undefined && compareVersions(entry.name, pin) >= 0) continue;
          await step('vendorVersions', () => {
            const path = join(root, entry.name);
            const stat = statOrNull(path);
            if (!stat?.isDirectory() && !stat?.isSymbolicLink()) return;
            rmSync(path, { recursive: true, force: true });
            result.vendorVersions++;
          });
        }
      });
    }
  });

  await step('quarantines', async () => {
    for (const project of entries(paths, paths.vaults)) {
      if (!project.isDirectory() || !project.name.endsWith('.quarantine')) continue;
      const root = join(paths.vaults, project.name);
      await step('quarantines', async () => {
        for (const entry of entries(paths, root)) {
          await step('quarantines', () => {
            const path = join(root, entry.name);
            const stat = statOrNull(path);
            if (stat && stat.mtimeMs < at - RETENTION.quarantineMs) {
              rmSync(path, { recursive: true, force: true });
              result.quarantines++;
            }
          });
        }
      });
    }
  });

  await step('prepStates', async () => {
    const kept = new Set(store.list().map((record) => record.attemptId));
    for (const project of entries(paths, join(paths.runner, 'prep'))) {
      if (!project.isDirectory()) continue;
      await step('prepStates', async () => {
        const root = paths.prep(project.name);
        if (!directoryExists(paths, prepLayout(root).state)) return;
        const prep = new PrepState(root);
        for (const attemptId of prep.attempts()) {
          if (kept.has(attemptId)) continue;
          await step('prepStates', () => {
            prep.forget(attemptId);
            result.prepStates++;
          });
        }
      });
    }
  });

  await step('launchdLogs', () => {
    if (!directoryExists(paths, paths.logs)) return;
    // trimLaunchdLogs truncates in place, so refuse links before handing it these paths.
    for (const path of Object.values(launchdLogPaths(paths))) {
      const stat = statOrNull(path);
      if (stat && !stat.isFile()) throw new Error(`launchd log is not a regular file: ${path}`);
    }
    result.launchdLogs = trimLaunchdLogs(paths);
  });

  // No prototype: a project key is a name, never an inherited property.
  const consolidatedAt: Record<string, number> = Object.assign(Object.create(null), state?.consolidatedAt);
  for (const vault of input.vaults) {
    const previous = Object.hasOwn(consolidatedAt, vault.project) ? consolidatedAt[vault.project] : undefined;
    if (!due(previous, at, RETENTION.consolidationIntervalMs)) continue;
    await step('consolidate', async () => {
      await vault.consolidate();
      // Stamped with the sweep's start, as sweptAt is, so a long repack does not push the next one past a day.
      consolidatedAt[vault.project] = at;
      result.consolidatedVaults.push(vault.project);
    });
  }
  // A stopped sweep keeps its consolidations and stays due, so the next start finishes it.
  const stopped = input.signal?.aborted === true;
  if (stopped) logger.info('retention sweep stopped by shutdown');
  await attempt('saveState', () => saveState(paths, { sweptAt: stopped ? (state?.sweptAt ?? 0) : at, consolidatedAt }));
  return result;
}

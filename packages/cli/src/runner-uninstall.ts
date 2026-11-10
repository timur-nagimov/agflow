// Uninstall keeps unpushed work recoverable and leaves the owner's logins and CLI credentials alone (design 7.1).
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Vendor } from '@agflow/core';
import { isCleanedUp, removeTree } from '@agflow/runner/src/attempt/cleanup';
import { AttemptStore, type AttemptRecord } from '@agflow/runner/src/attempt-store';
import { loadRunnerConfig } from '@agflow/runner/src/config';
import { openRunnerDb } from '@agflow/runner/src/db';
import { Outbox } from '@agflow/runner/src/outbox';
import { agflowHome, type RunnerPaths, runnerPaths } from '@agflow/runner/src/paths';
import { killRegisteredGroups } from '@agflow/runner/src/recovery';
import { bootoutService, plistPath, serviceLoaded } from '@agflow/runner/src/service/launchd';
import { acquireRunnerLock } from '@agflow/runner/src/service/lock';
import { machineMismatch, readMachineId } from '@agflow/runner/src/service/machine';
import { stopRunner } from '@agflow/runner/src/service/stop';
import { defaultExec, type Exec } from '@agflow/runner/src/service/system';
import { logoutClaude, logoutCodex } from '@agflow/runner/src/vendor/login';
import { type PlatformPins, VENDOR_PINS, vendorBinary, vendorPlatform } from '@agflow/runner/src/vendor/pins';
import type { ParsedArgs } from './args';
import { loadCredentials } from './credentials';
import { type FetchFn, HubClient, HubClientError } from './hub-client';
import type { Io } from './io';
import { configDir } from './paths';

export interface RunnerUninstallDeps {
  dir: string;
  paths: RunnerPaths;
  env: Record<string, string | undefined>;
  fetch: FetchFn;
  exec: Exec;
  pins: PlatformPins;
  platform: string;
  /** The machine-id platform (ioreg on darwin). */
  machinePlatform: NodeJS.Platform;
  home: string;
  uid: number;
  lockWaitMs: number;
  pollMs: number;
}

export interface UnpushedAttempt {
  record: AttemptRecord;
  reasons: string[];
}

const LIVE_STATES: readonly AttemptRecord['state'][] = ['starting', 'running', 'idle'];

/**
 * Durable pending work survives event retention and a missing clone: the vault still holds lateWorkSha. Before
 * finalization, a worker's clone may also hold unharvested work, and unequal WIP shas name work still waiting to push.
 * Recovery can mark a worker stopped without finalizing it. After finalization, WIP shas can stay unequal even when
 * all final work reached the origin. Live workers remain protected regardless of a previous completion timestamp.
 * A failed harvest may produce no SHA at all: an unresolved final-work error still protects a retained clone.
 */
export function unpushedWork(
  store: AttemptStore,
  cloneExists: (path: string) => boolean = existsSync,
): UnpushedAttempt[] {
  return store.list().flatMap((record) => {
    const reasons: string[] = [];
    if (record.lateWorkSha !== null) {
      reasons.push(record.pushError !== null
        ? `final push failed: ${record.pushError}`
        : `final work ${record.lateWorkSha} has not reached a late-work ref yet`);
    } else if (isCleanedUp(record)) {
      return [];
    } else if (record.pushError !== null && record.clone !== null && cloneExists(record.clone)) {
      reasons.push(`final work failed: ${record.pushError}`);
    }
    if (record.spec.role === 'worker' && (LIVE_STATES.includes(record.state) || record.finalizedAt === null)) {
      if (record.clone !== null && cloneExists(record.clone)) {
        reasons.push('the runner did not stop this attempt, so its clone was never harvested');
      } else if (record.wipSha !== null && record.wipSha !== record.pushedSha) {
        reasons.push(`unpushed WIP ${record.wipSha} (last pushed: ${record.pushedSha ?? 'none'})`);
      }
    }
    return reasons.length ? [{ record, reasons }] : [];
  });
}

function versionOrder(a: string, b: string): number {
  const [x, y] = [a, b].map((version) => version.split('.').map(Number));
  for (let i = 0; i < 3; i++) if (x![i] !== y![i]) return x![i]! - y![i]!;
  return 0;
}

/** The pinned version when installed; after an upgrade bumped a pin that start never downloads, the newest one there. */
function installedVersion(paths: RunnerPaths, vendor: Vendor, pinned: string | undefined): string | null {
  const installed = (version: string) => {
    try {
      return existsSync(join(paths.runner, vendorBinary(vendor, version)));
    } catch {
      // Not a version directory.
      return false;
    }
  };
  if (pinned !== undefined && installed(pinned)) return pinned;
  const dir = join(paths.vendor, vendor);
  const versions = existsSync(dir) ? readdirSync(dir).filter(installed) : [];
  return versions.sort(versionOrder).at(-1) ?? null;
}

export async function uninstallRunner(
  args: ParsedArgs,
  io: Io,
  deps: Partial<RunnerUninstallDeps> = {},
): Promise<number> {
  const env = deps.env ?? process.env;
  const paths = deps.paths ?? runnerPaths(agflowHome(env));
  const exec = deps.exec ?? defaultExec;
  const launchctl = { exec, uid: deps.uid };
  const log = (line: string) => io.out(`${line}\n`);
  const stopped = await stopRunner({ paths, env, ...launchctl, lockWaitMs: deps.lockWaitMs, pollMs: deps.pollMs });
  log(stopped.wasRunning ? 'the runner stopped' : 'no runner was running');
  if (!stopped.wasRunning) {
    const lock = await acquireRunnerLock(paths, { mode: 'foreground', wait: false });
    try {
      let killed = 0;
      if (existsSync(paths.db)) {
        const db = openRunnerDb(paths.db);
        try {
          killed = (await killRegisteredGroups(new AttemptStore(db))).length;
        } finally {
          db.close();
        }
      }
      log(`killed ${killed} registered agent group${killed === 1 ? '' : 's'}`);
    } finally {
      lock.release();
    }
  }

  if (args.flags.purge === true) {
    let unpushed: UnpushedAttempt[] = [];
    let unacked = 0;
    if (existsSync(paths.db)) {
      const db = openRunnerDb(paths.db);
      try {
        const outbox = new Outbox(db);
        unpushed = unpushedWork(new AttemptStore(db));
        unacked = outbox.eventsAfter(outbox.ackedSeq()).length;
      } finally {
        db.close();
      }
    }
    if (unpushed.length) {
      log('refusing to purge: attempts have unpushed work');
      for (const { record, reasons } of unpushed) {
        log(`${record.attemptId}: ${record.clone ?? '(no clone path recorded)'}; ${reasons.join('; ')}`);
      }
      log(
        'run agflow runner start once to finish and retry these pushes, or push the work from the clone by hand; ' +
          'then run agflow runner uninstall --purge again',
      );
      return 1;
    }
    // Exits and final WIP shas the hub has not heard of would go with runner.db: a successor would start from older work.
    if (unacked > 0) {
      log(
        `refusing to purge: runner.db holds ${unacked} event${unacked === 1 ? '' : 's'} the hub has not acknowledged`,
      );
      log('run agflow runner start until the hub has them, then run agflow runner uninstall --purge again');
      return 1;
    }
    log('no attempt has unpushed work');
  }

  let retireFailed = false;
  if (!existsSync(paths.config)) {
    log('runner.json is missing; skipping vendor logouts and hub retirement');
  } else {
    const config = loadRunnerConfig(paths.config, env);
    // A runner.json copied from another Mac (a restore, Migration Assistant) names that Mac's live runner.
    const copied =
      machineMismatch(config, await readMachineId({ exec, platform: deps.machinePlatform ?? process.platform })) !==
      null;
    const platform = deps.platform ?? vendorPlatform();
    const pins = deps.pins ?? VENDOR_PINS[platform];
    for (const vendor of ['claude', 'codex'] as const) {
      const version = installedVersion(paths, vendor, pins?.[vendor].version);
      if (version === null) {
        const kept = vendor === 'claude' ? '; its login stays in the login keychain' : '';
        log(`${vendor}: no runner binary is installed, so the logout could not run${kept}`);
        continue;
      }
      await (vendor === 'claude' ? logoutClaude : logoutCodex)(config, paths, { version, platform, exec, base: env });
      // The vendor logout API is best effort and does not report success or failure.
      log(`${vendor}: requested logout from the runner's home`);
    }
    if (copied) {
      log(
        `runner.json came from another Mac; its runner ${config.runnerKey} belongs to that Mac and is not retired here`,
      );
    } else {
      try {
        const credentials = loadCredentials(deps.dir ?? configDir());
        if (!credentials) throw new Error('not signed in; run agflow login --hub <url>');
        const client = new HubClient({ baseUrl: credentials.hubUrl, token: credentials.token, fetch: deps.fetch });
        try {
          await client.retireRunner(config.runnerKey);
        } catch (error) {
          if (error instanceof HubClientError && error.status === 401) {
            throw new Error(`the hub refused the CLI sign-in; run agflow login --hub ${credentials.hubUrl}`);
          }
          throw error;
        }
        log(`retired runner ${config.runnerKey} on ${credentials.hubUrl}`);
      } catch (error) {
        retireFailed = true;
        log(`could not retire the runner: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  if (env.AGFLOW_TEST !== '1') {
    if (await serviceLoaded(launchctl)) {
      if (!(await bootoutService(launchctl)) && (await serviceLoaded(launchctl))) {
        throw new Error('launchctl bootout failed; the service is still loaded');
      }
    }
    const plist = plistPath({ home: deps.home ?? homedir() });
    rmSync(plist, { force: true });
    log(`removed ${plist}`);
  }
  if (args.flags.purge === true) {
    if (retireFailed) {
      // runner.json holds the key a later retirement needs, and runner.db the events the hub may still lack.
      log(`kept ${paths.runner}, ${paths.vaults} and ${paths.work}`);
      log('run agflow runner uninstall --purge again once the hub is reachable and the CLI is signed in');
      return 1;
    }
    // Clones hold read-only directories (Go's module cache, an agent's chmod), and tools are read-only. runner/ goes
    // last, so a failure leaves runner.json for a rerun.
    for (const path of [paths.work, paths.vaults, paths.runner]) await removeTree(path);
    log(`removed ${paths.runner}, ${paths.vaults} and ${paths.work}`);
  }
  return retireFailed ? 1 : 0;
}

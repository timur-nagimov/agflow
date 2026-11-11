// A cluster for the e2e scenarios (design 1, 15): one hub process, a local bare origin, the scripted models and three
// runners owned by alice, bob and carol. Every runner offers the cluster's vendor only (X-10), so placement and lead
// seating are deterministic. Scenarios wait on what the hub shows; a wait that times out fails with a dump of
// everything a reader needs to see why. A live run's cluster uses real models instead, and may use a throwaway remote
// as its origin (X-43).
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Attempt, HubEvent, Vendor } from '@agflow/core';
import { gitIn, type OriginRepo, originRepo } from '../git-fixtures';
import { requireE2e } from './env';
import { E2E_USERS, type HubProcess, type HubTimings, startHubProcess } from './hub-process';
import { type Models, startModels } from './models';
import { cliToken, type Person, signIn } from './person';
import { GATE_DIR, type Programs } from './playbook';
import { processesInDir } from './proc';
import {
  prepareRunnerHome,
  type RealModels,
  type RunnerHome,
  type RunnerProcess,
  startRunnerProcess,
} from './runner-process';

export interface ClusterOptions {
  /** Every runner offers this vendor only. */
  vendor: Vendor;
  /** Whether the hub seats a runner lead; off by default, so only the scenario's workers run. */
  runnerLeads?: boolean;
  /** The goal the person sets before any runner connects. */
  goal?: string;
  /** main's files on the origin. */
  files?: Record<string, string>;
  /** The scripted programs known up front; more come through models.addPrograms. */
  programs?: Programs;
  /** The hub's timings; E2E_HUB_TIMINGS by default. */
  hubTimings?: HubTimings;
  /**
   * The scripted servers behind the refusing proxy (the default), or a live run's real models through the person's
   * logged-in vendor homes. With real models no scripted server starts, and Cluster.models records nothing.
   */
  models?: 'scripted' | RealModels;
  /**
   * The pinned binaries the runners link; by default requireE2e's located ones, or none with real models, which bring
   * the person's.
   */
  binaries?: Partial<Record<Vendor, string>>;
  /**
   * A throwaway remote to use as the project's repository instead of a new local bare origin (a live run's --repo).
   * The cluster resets it to main holding the files (remoteOrigin), and Cluster.origin is a local mirror of it that
   * every wait fetches again before it returns, so the reads after a wait see what the hub saw.
   */
  repo?: string;
  /** How long waitFor and waitForEvent wait by default; 120 s. A live run waits longer for real models. */
  waitMs?: number;
}

export interface ClusterWaitOptions {
  /** ClusterOptions.waitMs by default. */
  timeoutMs?: number;
  /** 250 ms by default. */
  intervalMs?: number;
}

/** An event to wait for: its type, and optionally its subject, its data.attemptId and other data fields. */
export interface EventMatch {
  type: string;
  subject?: string;
  attemptId?: string;
  data?: Record<string, unknown>;
}

export interface EventWaitOptions extends ClusterWaitOptions {
  /** Only events with a larger id count; 0 by default. */
  after?: number;
}

export interface Cluster {
  /** The cluster's directory, at its real path: the hub's and every runner's directories. */
  readonly dir: string;
  readonly vendor: Vendor;
  readonly hub: HubProcess;
  /** The project's repository: a local bare origin, or the local mirror of a throwaway remote. */
  readonly origin: OriginRepo;
  /** The scripted models; with real models, noScriptedModels(). */
  readonly models: Models;
  /** alice, signed in: she set the goal and the runner-leads switch, and accepts work. */
  readonly person: Person;
  /** The runners of alice, bob and carol, in that order. */
  readonly runners: readonly RunnerProcess[];
  /** Whether a step threw; close() then keeps the directory. */
  readonly failed: boolean;
  /** Steps still running: a test that timed out leaves its step running, and close() then keeps the directory. */
  readonly inFlight: number;
  /** The runner the hub placed the attempt on. */
  runnerOf(attemptId: string): Promise<RunnerProcess>;
  /** The task's attempts, oldest first. */
  attemptsOf(taskId: string): Promise<Attempt[]>;
  /**
   * Polls check until it gives a value other than null, undefined or false, and resolves with it. A check that throws
   * counts as not yet, so a wait survives a hub restart. On timeout it throws with the last error and the dump.
   */
  waitFor<T>(
    what: string,
    check: () => Promise<T | null | undefined | false>,
    options?: ClusterWaitOptions,
  ): Promise<T>;
  /** The first event, oldest first, that matches; on timeout it throws with the dump. */
  waitForEvent(match: EventMatch, options?: EventWaitOptions): Promise<HubEvent>;
  /** Opens the gate a playbook step of the attempt waits for, in the attempt's clone. */
  openGate(attemptId: string, name: string): Promise<void>;
  /** Everything a failure needs: attempts and their logs, runners, recent events, log tails and model requests. */
  dump(): Promise<string>;
  /**
   * Runs a test step; a step that throws marks the cluster failed, and a step still running at close() (its test
   * timed out) counts as failed too, so close() keeps the directory. Once close() began, waits and gates throw at once,
   * so a step left running stops soon.
   */
  step<T>(body: () => Promise<T>): Promise<T>;
  /**
   * Thaws, kills and sweeps every process the cluster started, then removes its files, unless keep (by default:
   * KEEP_E2E=1, a failed step or a step still running) keeps them for a look. A second call does nothing.
   */
  close(options?: { keep?: boolean }): Promise<void>;
}

const DEFAULT_WAIT_MS = 120_000;
const DEFAULT_INTERVAL_MS = 250;
const DEFAULT_GOAL = 'Keep the e2e repository tidy, one small task at a time.';
const DEFAULT_FILES = { 'README.md': '# e2e\n\nA repository for agflow end-to-end tests.\n' };

/** The subject of main's commit after remoteOrigin's reset: only a remote whose main has it may be reset again. */
export const REMOTE_MAIN_SUBJECT = 'agflow: the toy repository of a live run';

/** The refs a live run's cluster leaves on its remote, which a later reset may delete. */
const RUN_REFS = [/^HEAD$/, /^refs\/heads\/main$/, /^refs\/heads\/agflow\//, /^refs\/agflow\//];

/** A throwaway remote's local mirror, and how to fetch it again. */
export interface RemoteOrigin {
  origin: OriginRepo;
  refresh(): Promise<void>;
}

/**
 * git with the person's own environment and configuration, so their credentials reach the remote; no hooks run and
 * nothing prompts.
 */
async function personGit(dir: string, args: string[]): Promise<string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !name.startsWith('GIT_')) env[name] = value;
  }
  const proc = Bun.spawn(['git', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: dir,
    env: { ...env, GIT_TERMINAL_PROMPT: '0' },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed (exit ${code}): ${stderr.trim()}`);
  return stdout.trim();
}

/**
 * Resets a throwaway remote for a live cluster and mirrors it into dir: main becomes one new commit holding the files,
 * and every other ref is deleted, so task ids starting again at T-1 meet no ref of an earlier run. It refuses a
 * remote with a ref outside main and agflow's own refs, or whose main is not one a reset made: that is no throwaway.
 */
export async function remoteOrigin(url: string, files: Record<string, string>, dir: string): Promise<RemoteOrigin> {
  mkdirSync(dirname(dir), { recursive: true });
  await personGit(dirname(dir), ['clone', '--quiet', '--mirror', url, dir]);
  const refs = (await personGit(dir, ['for-each-ref', '--format=%(refname)'])).split('\n').filter(Boolean);
  const foreign = refs.filter((ref) => !RUN_REFS.some((pattern) => pattern.test(ref)));
  const subject = refs.includes('refs/heads/main') ? await personGit(dir, ['log', '-1', '--format=%s', 'main']) : null;
  if (foreign.length > 0 || (subject !== null && subject !== REMOTE_MAIN_SUBJECT)) {
    const why = foreign.length > 0 ? `it has ${foreign.join(', ')}` : `its main is ${JSON.stringify(subject)}`;
    throw new Error(`${url} is not a throwaway repository of the live run (${why}); give an empty repository`);
  }
  for (const ref of refs) await gitIn(dir, ['update-ref', '-d', ref]);
  // The new main, committed in a scratch repository with the fixture identity and fetched into the mirror.
  const scratch = mkdtempSync(join(dirname(dir), 'toy-'));
  try {
    await gitIn(scratch, ['init', '--quiet']);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(scratch, path)), { recursive: true });
      writeFileSync(join(scratch, path), content);
    }
    await gitIn(scratch, ['add', '--all']);
    await gitIn(scratch, ['commit', '--quiet', '-m', REMOTE_MAIN_SUBJECT]);
    await gitIn(dir, ['fetch', '--quiet', scratch, '+HEAD:refs/heads/main']);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  await gitIn(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  // The remote becomes the mirror: main is replaced, and every ref the mirror no longer has is deleted.
  await personGit(dir, ['push', '--quiet', '--mirror', url]);
  const mainSha = await gitIn(dir, ['rev-parse', 'refs/heads/main']);
  return {
    origin: { root: dir, path: dir, mainSha, remove: () => rmSync(dir, { recursive: true, force: true }) },
    refresh: async () => {
      await personGit(dir, ['fetch', '--quiet', '--prune', url, '+refs/*:refs/*']);
    },
  };
}

/** Cluster.models with real models: nothing is recorded, and nothing can be programmed or reached. */
export function noScriptedModels(): Models {
  const refuse = (what: string): never => {
    throw new Error(`the cluster runs real models: it has no ${what}`);
  };
  return {
    get anthropic() {
      return refuse('scripted Anthropic server');
    },
    get responses() {
      return refuse('scripted Responses provider');
    },
    get proxy() {
      return refuse('refusing proxy');
    },
    get proxyUrl() {
      return refuse('refusing proxy');
    },
    get claudeEnv() {
      return refuse('scripted Anthropic server');
    },
    get codexConfig() {
      return refuse('scripted Responses provider');
    },
    addPrograms: () => refuse('scripted programs'),
    requests: () => [],
    requestsFor: () => [],
    sawText: () => false,
    unmatched: () => [],
    externalAttempts: () => [],
    close: async () => {},
  };
}

/** How much of the cluster the dump shows. */
const DUMP = { attemptLog: 20, events: 40, logLines: 30, requests: 6, requestChars: 1_500 };

/** One line of JSON, cut to a length a dump can carry. */
function brief(value: unknown, max = 400): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function matches(event: HubEvent, match: EventMatch): boolean {
  if (event.type !== match.type) return false;
  if (match.subject !== undefined && event.subject !== match.subject) return false;
  if (match.attemptId !== undefined && event.data.attemptId !== match.attemptId) return false;
  return Object.entries(match.data ?? {}).every(([key, value]) => Bun.deepEquals(event.data[key], value));
}

/** Starts a cluster; a start that fails stops every process it started and keeps its files for a look. */
export async function startCluster(options: ClusterOptions): Promise<Cluster> {
  const real = options.models === undefined || options.models === 'scripted' ? null : options.models;
  // A scripted cluster is e2e-gated whatever binaries it is given; a live run needs no gate, as it brings the person's.
  const located = real === null ? (await requireE2e()).binaries : {};
  const binaries = options.binaries ?? located;
  // Short and real: runner.sock must fit in 104 bytes, and lsof reports real paths.
  const dir = realpathSync(mkdtempSync('/tmp/agf-e2e-'));
  const started: {
    origin?: OriginRepo;
    models?: Models;
    hub?: HubProcess;
    refreshOrigin?: () => Promise<void>;
    homes: RunnerHome[];
    runners: RunnerProcess[];
  } = { homes: [], runners: [] };
  const stopAll = async () => {
    for (const runner of started.runners) await runner.close().catch(() => {});
    await started.models?.close();
    if (started.hub?.running) await started.hub.kill();
    // Whatever escaped: agents of a runner that died during the start still run in its directory.
    for (const row of await processesInDir(dir).catch(() => [])) {
      try {
        process.kill(row.pid, 'SIGKILL');
      } catch {
        // Gone meanwhile.
      }
    }
  };
  try {
    const files = options.files ?? DEFAULT_FILES;
    if (options.repo === undefined) {
      started.origin = await originRepo(files);
    } else {
      const remote = await remoteOrigin(options.repo, files, join(dir, 'origin.git'));
      started.origin = remote.origin;
      started.refreshOrigin = remote.refresh;
    }
    started.models = real === null ? await startModels({ programs: options.programs }) : noScriptedModels();
    const repo = options.repo ?? started.origin.path;
    const hub = await startHubProcess({ dir: join(dir, 'hub'), repo, timings: options.hubTimings });
    started.hub = hub;
    const people = await Promise.all(E2E_USERS.map((login) => signIn(hub.url, login)));
    const [person] = people;
    if (!person) throw new Error('no person to drive the cluster');
    // Before any runner connects: the seat and the goal are what the scheduler reads first.
    await person.setRunnerLeads(options.runnerLeads ?? false);
    await person.setGoal(options.goal ?? DEFAULT_GOAL);
    const models = started.models;
    for (const owner of people) {
      started.homes.push(
        await prepareRunnerHome({
          dir: join(dir, owner.login),
          name: `${owner.login}-mac`,
          credentials: { hubUrl: hub.url, token: await cliToken(owner), user: owner.login },
          vendors: [options.vendor],
          binaries,
          models: real ?? models,
        }),
      );
    }
    for (const home of started.homes) started.runners.push(await startRunnerProcess(home));
    return createCluster({
      dir,
      vendor: options.vendor,
      hub,
      origin: started.origin,
      models,
      person,
      homes: started.homes,
      runners: started.runners,
      waitMs: options.waitMs ?? DEFAULT_WAIT_MS,
      refreshOrigin: started.refreshOrigin ?? null,
    });
  } catch (error) {
    await stopAll();
    throw new Error(`the cluster did not start; its files are in ${dir}: ${describe(error)}`, { cause: error });
  }
}

interface ClusterParts {
  dir: string;
  vendor: Vendor;
  hub: HubProcess;
  origin: OriginRepo;
  models: Models;
  person: Person;
  homes: RunnerHome[];
  runners: RunnerProcess[];
  waitMs: number;
  /** Fetches a remote origin's mirror again; null for a local origin. */
  refreshOrigin: (() => Promise<void>) | null;
}

function createCluster(parts: ClusterParts): Cluster {
  const { dir, vendor, hub, origin, models, person, homes, runners, waitMs, refreshOrigin } = parts;
  let failed = false;
  let inFlight = 0;
  let closing: Promise<void> | null = null;

  function requireOpen(what: string): void {
    if (closing !== null) throw new Error(`the cluster is closed: cannot ${what}`);
  }

  async function runnerOf(attemptId: string): Promise<RunnerProcess> {
    const { attempt } = await person.attempt(attemptId);
    if (attempt.runnerId === null) throw new Error(`${attemptId} runs on no runner`);
    const placed = (await person.runners()).runners.find((runner) => runner.id === attempt.runnerId);
    const runner = runners.find((candidate) => candidate.name === placed?.name);
    if (!runner) throw new Error(`${attemptId} runs on ${attempt.runnerId}, which is no runner of this cluster`);
    return runner;
  }

  async function attemptsOf(taskId: string): Promise<Attempt[]> {
    return (await person.attempts({ task: taskId })).sort((a, b) => a.number - b.number);
  }

  /** Each part on its own: a hub that is down still leaves the runners' and the models' parts. */
  async function section(title: string, body: () => Promise<string[]> | string[]): Promise<string> {
    try {
      const lines = await body();
      return [`--- ${title}`, ...(lines.length > 0 ? lines : ['(none)'])].join('\n');
    } catch (error) {
      return `--- ${title}\n(unavailable: ${describe(error)})`;
    }
  }

  async function dump(): Promise<string> {
    const attempts = await person.attempts().catch(() => [] as Attempt[]);
    const parts = [
      `=== cluster ${dir} (${vendor}), hub ${hub.url}${hub.running ? '' : ' (not running)'}`,
      await section('attempts', async () => {
        const lines: string[] = [];
        for (const attempt of [...attempts].reverse()) {
          lines.push(
            `${attempt.id} ${attempt.role} ${attempt.status}/${attempt.phase ?? '-'} ` +
              `runner ${attempt.runnerId ?? '-'} fence ${brief(attempt.fence)} ` +
              `end ${attempt.endReason ?? '-'}/${attempt.failureClass ?? '-'} ` +
              `start ${attempt.startSha ?? '-'} wip ${attempt.wipSha ?? '-'}`,
          );
          const { log } = await person.attempt(attempt.id);
          for (const entry of log.slice(-DUMP.attemptLog)) lines.push(`  ${entry.kind}: ${brief(entry.summary, 300)}`);
        }
        return lines;
      }),
      await section('runners', async () =>
        (await person.runners()).runners.map(
          (runner) =>
            `${runner.name} ${runner.id} ${runner.state}${runner.stateDetail ? ` (${runner.stateDetail})` : ''} ` +
            `active ${runner.activeAttempts} vendors ` +
            runner.vendors.map((entry) => `${entry.vendor}:${entry.ready ? 'ready' : entry.problem}`).join(','),
        ),
      ),
      await section(`events (newest ${DUMP.events})`, async () =>
        (await person.events({ latest: true, limit: DUMP.events }))
          .reverse()
          .map((event) => `#${event.id} ${event.type} ${event.subject ?? '-'} ${event.actor} ${brief(event.data)}`),
      ),
      ...runners.map((runner) =>
        section(`runner ${runner.name} (${runner.running ? `pid ${runner.pid}` : 'not running'})`, () =>
          runner.logTail(DUMP.logLines).split('\n'),
        ),
      ),
      section('hub log', () => hub.logTail(DUMP.logLines).split('\n')),
      ...attempts.map((attempt) =>
        section(`model requests of ${attempt.id}`, () =>
          models
            .requestsFor(attempt.id)
            .slice(-DUMP.requests)
            .map((request) => {
              const answer = request.answer === null ? 'default' : brief(request.answer, 300);
              const seen = request.text.slice(-DUMP.requestChars);
              return `#${request.seq} ${request.vendor} answered ${answer}\n  saw …${seen}`;
            }),
        ),
      ),
      section('unmatched model requests', () =>
        models.unmatched().map((request) => `#${request.seq} ${request.vendor} …${request.text.slice(-300)}`),
      ),
    ];
    return (await Promise.all(parts)).join('\n');
  }

  async function waitFor<T>(
    what: string,
    check: () => Promise<T | null | undefined | false>,
    options: ClusterWaitOptions = {},
  ): Promise<T> {
    const timeoutMs = options.timeoutMs ?? waitMs;
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown = null;
    for (;;) {
      requireOpen(`wait for ${what}`);
      try {
        const value = await check();
        if (value !== null && value !== undefined && value !== false) {
          // A remote's pushes come before the hub records them, so the mirror is fetched once the wait is over.
          if (refreshOrigin !== null) await refreshOrigin();
          return value;
        }
        lastError = null;
      } catch (error) {
        lastError = error;
      }
      if (Date.now() >= deadline) {
        const last = lastError === null ? '' : ` (last error: ${describe(lastError)})`;
        throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}${last}\n${await dump()}`);
      }
      await Bun.sleep(options.intervalMs ?? DEFAULT_INTERVAL_MS);
    }
  }

  async function waitForEvent(match: EventMatch, options: EventWaitOptions = {}): Promise<HubEvent> {
    let after = options.after ?? 0;
    const what =
      `event ${match.type}${match.subject ? ` of ${match.subject}` : ''}` +
      `${match.attemptId ? ` for ${match.attemptId}` : ''}${match.data ? ` with ${brief(match.data)}` : ''}`;
    return waitFor(
      what,
      async () => {
        const events = await person.events({ after, subject: match.subject, limit: 1000 });
        const found = events.find((event) => matches(event, match));
        if (found) return found;
        after = events.at(-1)?.id ?? after;
        return null;
      },
      options,
    );
  }

  async function openGate(attemptId: string, name: string): Promise<void> {
    const runner = await runnerOf(attemptId);
    // A step left running must not recreate directories in a removed cluster.
    requireOpen(`open the gate ${name} of ${attemptId}`);
    const file = join(runner.clonePath(attemptId), GATE_DIR, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '');
  }

  async function step<T>(body: () => Promise<T>): Promise<T> {
    inFlight += 1;
    try {
      return await body();
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      inFlight -= 1;
    }
  }

  async function shutDown(keep: boolean): Promise<void> {
    const problems: string[] = [];
    for (const runner of runners) {
      await runner.close().catch((error) => problems.push(`runner ${runner.name}: ${describe(error)}`));
    }
    await models.close();
    if (hub.running) await hub.kill();
    // Whatever escaped every runner's sweep: the cluster's directory must be empty of processes.
    const left = await processesInDir(dir);
    for (const row of left) {
      try {
        process.kill(row.pid, 'SIGKILL');
      } catch {
        // Gone meanwhile.
      }
      problems.push(`process ${row.pid} (${row.command}) still ran in ${dir}`);
    }
    if (keep) {
      process.stderr.write(`agflow e2e: kept the cluster's files in ${dir} and the origin in ${origin.root}\n`);
    } else {
      for (const home of homes) home.remove();
      rmSync(dir, { recursive: true, force: true });
      origin.remove();
    }
    if (problems.length > 0) throw new Error(`closing the cluster:\n${problems.join('\n')}`);
  }

  return {
    dir,
    vendor,
    hub,
    origin,
    models,
    person,
    runners,
    get failed() {
      return failed;
    },
    get inFlight() {
      return inFlight;
    },
    runnerOf,
    attemptsOf,
    waitFor,
    waitForEvent,
    openGate,
    dump,
    step,
    close(options = {}) {
      closing ??= shutDown(options.keep ?? (failed || inFlight > 0 || process.env.KEEP_E2E === '1'));
      return closing;
    },
  };
}

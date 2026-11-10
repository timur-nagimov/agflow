// A cluster for the e2e scenarios (design 1, 15): one hub process, a local bare origin, the scripted models and three
// runners owned by alice, bob and carol. Every runner offers the cluster's vendor only (X-10), so placement and lead
// seating are deterministic. Scenarios wait on what the hub shows; a wait that times out fails with a dump of
// everything a reader needs to see why.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Attempt, HubEvent, Vendor } from '@agflow/core';
import { type OriginRepo, originRepo } from '../git-fixtures';
import { requireE2e } from './env';
import { E2E_USERS, type HubProcess, type HubTimings, startHubProcess } from './hub-process';
import { type Models, startModels } from './models';
import { cliToken, type Person, signIn } from './person';
import { GATE_DIR, type Programs } from './playbook';
import { processesInDir } from './proc';
import { prepareRunnerHome, type RunnerHome, type RunnerProcess, startRunnerProcess } from './runner-process';

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
}

export interface ClusterWaitOptions {
  /** 120 s by default. */
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
  readonly origin: OriginRepo;
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
  const { binaries } = await requireE2e();
  // Short and real: runner.sock must fit in 104 bytes, and lsof reports real paths.
  const dir = realpathSync(mkdtempSync('/tmp/agf-e2e-'));
  const started: {
    origin?: OriginRepo;
    models?: Models;
    hub?: HubProcess;
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
    started.origin = await originRepo(options.files ?? DEFAULT_FILES);
    started.models = await startModels({ programs: options.programs });
    const repo = started.origin.path;
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
          models,
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
}

function createCluster(parts: ClusterParts): Cluster {
  const { dir, vendor, hub, origin, models, person, homes, runners } = parts;
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
    const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_MS;
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown = null;
    for (;;) {
      requireOpen(`wait for ${what}`);
      try {
        const value = await check();
        if (value !== null && value !== undefined && value !== false) return value;
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

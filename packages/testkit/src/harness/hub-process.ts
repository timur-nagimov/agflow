// The hub as a real process (design 6.14, 12, 15). Scenarios restart, kill and restore the hub, so it runs as
// `bun packages/hub/src/main.ts`, which serves startHub with the database lock and the automatic scheduler (X-26), in
// hub test mode with the E2E timings (X-27). The harness imports hub modules by path and adds no dependency (X-44).
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { BackupKind } from '../../../hub/src/backup';
import type { HubConfig } from '../../../hub/src/context';
import { trackProcess } from './proc';

const HUB_SRC = join(import.meta.dir, '../../../hub/src');
const MAIN = join(HUB_SRC, 'main.ts');
const RESTORE = join(HUB_SRC, 'restore.ts');

const SECOND = 1000;
const MINUTE = 60 * SECOND;

type MillisecondField = { [K in keyof HubConfig]-?: K extends `${string}Ms` ? K : never }[keyof HubConfig];

/** Hub settings AGFLOW_TEST_CONFIG may carry: HubConfig's millisecond fields (X-27). */
export type HubTimings = Partial<Pick<HubConfig, MillisecondField>>;

/**
 * The E2E hub timings. Liveness is short, so a fault shows within seconds: the tick, the heartbeat and dead link, the
 * runner lease (whose third is the WIP grace, X-11), the recovery window, the infra backoff, the dispatch hold for late
 * work and delivery batching. Judgement is long, so a scenario trips only the rule it tests: no stall, tool cap, lead
 * review or active budget ends an attempt during a run.
 */
export const E2E_HUB_TIMINGS = Object.freeze({
  tickMs: SECOND,
  heartbeatMs: SECOND,
  deadLinkMs: 5 * SECOND,
  runnerLeaseMs: 30 * SECOND,
  recoveryMs: 15 * SECOND,
  infraBackoffMs: [SECOND, 2 * SECOND, 5 * SECOND],
  dispatchHoldMs: 10 * SECOND,
  deliveryBatchMs: 500,
  stallMs: 60 * MINUTE,
  toolCapMs: 60 * MINUTE,
  longToolCapMs: 120 * MINUTE,
  leadReviewMs: 60 * MINUTE,
  activeBudgetMs: 8 * 60 * MINUTE,
}) satisfies HubTimings;

/** The people of a cluster: each owns a runner, and any of them signs in to the dev hub. */
export const E2E_USERS = ['alice', 'bob', 'carol'] as const;

export interface HubProcessOptions {
  /** The hub's directory: agflow.db, backups/ and hub.log; created when missing. */
  dir: string;
  /** AGFLOW_PROJECT_REPO: the origin's path; a local bare repository works as is (X-43). */
  repo: string;
  /** 'e2e' by default. */
  projectName?: string;
  /** The logins dev sign-in admits; E2E_USERS by default. */
  users?: readonly string[];
  /** AGFLOW_TEST_CONFIG; E2E_HUB_TIMINGS by default. */
  timings?: HubTimings;
  /** How long a start may take to answer /api/auth-config; 30 s by default. */
  startTimeoutMs?: number;
}

export interface HubProcess {
  /** http://127.0.0.1:<port>, the same across restarts. */
  readonly url: string;
  readonly port: number;
  readonly dir: string;
  readonly dbPath: string;
  readonly backupDir: string;
  /** stdout and stderr of every start and restore, appended. */
  readonly logPath: string;
  /** The environment each start gets. */
  readonly env: Readonly<Record<string, string>>;
  /** The running hub's pid; null while it is stopped. */
  readonly pid: number | null;
  readonly running: boolean;
  /** Starts main.ts and resolves once /api/auth-config answers. */
  start(): Promise<void>;
  /** SIGTERM: the hub closes the database cleanly and gives up its lock; it must exit 0. */
  stop(): Promise<void>;
  /** stop(), then start(), on the same port and database. */
  restart(): Promise<void>;
  /** SIGKILL, as a crash: the database lock (<db>.pid) stays behind, stale. */
  kill(): Promise<void>;
  /** The kind's finished snapshots in the backup folder, newest last. */
  backups(kind: BackupKind): string[];
  /** Runs `bun packages/hub/src/restore.ts <backup>` on this hub's database, while it is stopped; gives its output. */
  restore(backup: string): Promise<string>;
  /** The last lines of the hub's log. */
  logTail(lines?: number): string;
}

const DEFAULT_START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 20_000;
const POLL_MS = 50;

/** A port that was free a moment ago; restarts reuse it, so the runners' hub URL never changes. */
function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() });
  const port = probe.port as number;
  probe.stop(true);
  return port;
}

function tail(text: string, lines: number): string {
  return text.split('\n').filter(Boolean).slice(-lines).join('\n');
}

/** Resolves with the exit code, or null when the process is still running after timeoutMs. */
async function exitWithin(proc: Bun.Subprocess, timeoutMs: number): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([proc.exited, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** A hub process on a free port, started. */
export async function startHubProcess(options: HubProcessOptions): Promise<HubProcess> {
  const hub = createHubProcess(options, freePort());
  await hub.start();
  return hub;
}

function createHubProcess(options: HubProcessOptions, port: number): HubProcess {
  const { dir } = options;
  const url = `http://127.0.0.1:${port}`;
  const dbPath = join(dir, 'agflow.db');
  const backupDir = join(dir, 'backups');
  const logPath = join(dir, 'hub.log');
  const startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  // The log opens before main.ts runs, so the directory must exist first.
  mkdirSync(dir, { recursive: true });
  // Only what the hub reads: a developer's own AGFLOW_* variables must not reach it. HOME is the hub directory, so
  // nothing the hub or bun writes lands in the real home.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: dir,
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
    AGFLOW_AUTH: 'dev',
    AGFLOW_ALLOWED_USERS: (options.users ?? E2E_USERS).join(','),
    AGFLOW_PROJECT_NAME: options.projectName ?? 'e2e',
    AGFLOW_PROJECT_REPO: options.repo,
    AGFLOW_PORT: String(port),
    AGFLOW_PUBLIC_URL: url,
    AGFLOW_DB: dbPath,
    AGFLOW_BACKUP_DIR: backupDir,
    AGFLOW_TEST: '1',
    AGFLOW_TEST_CONFIG: JSON.stringify(options.timings ?? E2E_HUB_TIMINGS),
  };
  let proc: Bun.Subprocess | null = null;

  const running = () => proc !== null && proc.exitCode === null && proc.signalCode === null;

  function log(line: string): void {
    const fd = openSync(logPath, 'a');
    try {
      writeSync(fd, `${line}\n`);
    } finally {
      closeSync(fd);
    }
  }

  function logTail(lines = 40): string {
    return existsSync(logPath) ? tail(readFileSync(logPath, 'utf8'), lines) : '';
  }

  /** Spawns a bun script in the hub directory, its output appended to the log. */
  function spawn(argv: string[], spawnEnv: Record<string, string>): Bun.Subprocess {
    const fd = openSync(logPath, 'a');
    try {
      // --no-env-file: a .env file must not add settings to the hub's.
      return Bun.spawn([process.execPath, '--no-env-file', ...argv], {
        cwd: dir,
        env: spawnEnv,
        stdin: 'ignore',
        stdout: fd,
        stderr: fd,
      });
    } finally {
      closeSync(fd);
    }
  }

  async function answers(): Promise<boolean> {
    try {
      return (await fetch(`${url}/api/auth-config`, { signal: AbortSignal.timeout(2_000) })).ok;
    } catch {
      return false;
    }
  }

  async function start(): Promise<void> {
    if (running()) throw new Error(`the hub at ${url} is already running (pid ${proc?.pid})`);
    log(`--- harness: starting the hub at ${new Date().toISOString()}`);
    const started = spawn([MAIN], env);
    proc = started;
    trackProcess(started);
    const deadline = Date.now() + startTimeoutMs;
    while (!(await answers())) {
      if (started.exitCode !== null || started.signalCode !== null) {
        throw new Error(`the hub exited (${started.exitCode ?? started.signalCode}) before it answered:\n${logTail()}`);
      }
      if (Date.now() > deadline) {
        started.kill('SIGKILL');
        await started.exited;
        throw new Error(`the hub did not answer at ${url} within ${startTimeoutMs} ms:\n${logTail()}`);
      }
      await Bun.sleep(POLL_MS);
    }
  }

  async function stop(): Promise<void> {
    const current = proc;
    if (current === null || !running()) throw new Error(`the hub at ${url} is not running`);
    current.kill('SIGTERM');
    const code = await exitWithin(current, STOP_TIMEOUT_MS);
    if (code === null) {
      current.kill('SIGKILL');
      await current.exited;
      throw new Error(`the hub did not stop within ${STOP_TIMEOUT_MS} ms of SIGTERM:\n${logTail()}`);
    }
    if (code !== 0) throw new Error(`the hub exited ${code} on SIGTERM:\n${logTail()}`);
  }

  async function kill(): Promise<void> {
    const current = proc;
    if (current === null || !running()) throw new Error(`the hub at ${url} is not running`);
    log(`--- harness: SIGKILL at ${new Date().toISOString()}`);
    current.kill('SIGKILL');
    await current.exited;
  }

  async function restore(backup: string): Promise<string> {
    if (running()) throw new Error(`stop the hub at ${url} before a restore`);
    log(`--- harness: restoring ${backup} at ${new Date().toISOString()}`);
    const before = existsSync(logPath) ? readFileSync(logPath, 'utf8').length : 0;
    const restoring = spawn([RESTORE, backup], { PATH: env.PATH ?? '', HOME: dir, AGFLOW_DB: dbPath });
    const code = await restoring.exited;
    const output = readFileSync(logPath, 'utf8').slice(before);
    if (code !== 0) throw new Error(`the restore of ${backup} exited ${code}:\n${output}`);
    return output;
  }

  function backups(kind: BackupKind): string[] {
    if (!existsSync(backupDir)) return [];
    // Finished snapshots only: an interrupted one is agflow-<kind>.tmp. Their names sort in time order.
    return readdirSync(backupDir)
      .filter((name) => name.startsWith(`agflow-${kind}-`) && name.endsWith('.db'))
      .sort()
      .map((name) => join(backupDir, name));
  }

  return {
    url,
    port,
    dir,
    dbPath,
    backupDir,
    logPath,
    env,
    get pid() {
      return running() ? (proc?.pid ?? null) : null;
    },
    get running() {
      return running();
    },
    start,
    stop,
    async restart() {
      await stop();
      await start();
    },
    kill,
    backups,
    restore,
    logTail,
  };
}

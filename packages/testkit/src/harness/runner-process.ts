// Runner homes and runner processes (design 7.1, 7.2, 7.4, 15, 15.1). Each runner has its own AGFLOW_HOME, CLI
// config directory and scratch HOME, and runs as `bun packages/cli/src/main.ts runner start` in the foreground, whose
// host calls createAdapters, so the real adapters run (X-6). The harness runs the CLI by path and adds no dependency
// on @agflow/cli; it finds an attempt's agent through `agflow runner status --json` and never reads runner.db (X-42).
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { CREDENTIALS_FILE, type Credentials, CredentialsSchema, type Vendor } from '@agflow/core';
import {
  CONNECTIVITY_VARS,
  type RunnerConfig,
  type RunnerTimings,
  saveRunnerConfig,
} from '@agflow/runner/src/config';
import { projectKey, type RunnerPaths, runnerPaths } from '@agflow/runner/src/paths';
import { type ProcessIdentity, processIdentity, sameProcess } from '@agflow/runner/src/processes';
import { removeAgentTools } from '@agflow/runner/src/run-dir';
import { ControlUnavailableError, controlRequest } from '@agflow/runner/src/service/control';
import { canonicalHome, readMachineId } from '@agflow/runner/src/service/machine';
import { createRunnerConfig } from '@agflow/runner/src/service/runner-json';
import type { RunnerStatusReport } from '@agflow/runner/src/service/status';
import { VENDOR_PINS, vendorBinary } from '@agflow/runner/src/vendor/pins';
import { linkClaudeBinary } from '../anthropic/binary';
import { bindTestProcessScope } from '../process-cleanup';
import { E2E_PLATFORM } from './env';
import type { Models } from './models';
import {
  descendantsOf,
  freezeTree,
  processesInDir,
  signalGroup,
  thawTree,
  trackProcess,
  waitUntilGone,
} from './proc';

const CLI_MAIN = join(import.meta.dir, '../../../cli/src/main.ts');

const SECOND = 1000;

/**
 * The e2e runner timings over design 12's defaults (X-30; runner.json's test.allowShortTimings admits them). WIP is
 * pushed every 5 s, inside the 10 s WIP grace the hub derives from E2E_HUB_TIMINGS.runnerLeaseMs (X-11). A runner
 * reconnects within 2 s of a hub restart. A thawed runner takes new starts again 5 s after its clock gap, not 2
 * minutes. Unclean exits count as a crash loop only within 30 s, so the SIGKILL scenarios never drain a runner. The
 * hub sets heartbeat, deadLink and handoff through welcome.timings; everything else keeps its default.
 */
export const E2E_RUNNER_TIMINGS = Object.freeze({
  backoffBase: SECOND / 2,
  backoffCap: 2 * SECOND,
  wip: 5 * SECOND,
  wakeHold: 5 * SECOND,
  crashLoopWindow: 30 * SECOND,
}) satisfies Partial<RunnerTimings>;

/** Agents of every runner reach the scripted servers and the hub directly; every other host goes to the proxy. */
const NO_PROXY = '127.0.0.1,localhost,::1';

/** Low enough that the disk guard never refuses a start on a developer's Mac. */
const E2E_MIN_FREE_GB = 0.5;

const DEFAULT_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

/**
 * The test process's PATH with only absolute entries, as setup keeps it (service/machine.ts): vendor CLIs, hooks and
 * the runner's own git run with their cwd in a clone, where a relative entry would find an agent-written binary.
 */
function runnerPath(path = process.env.PATH ?? ''): string {
  const entries = path.split(':').filter((entry) => entry.startsWith('/'));
  return [...new Set(entries)].join(':') || DEFAULT_PATH;
}

/** What prepareRunnerHome needs of the scripted models: Models, or stand-ins in a test. */
export type RunnerModels = Pick<Models, 'claudeEnv' | 'codexConfig' | 'proxyUrl'>;

/**
 * A live run's models (design 1, 15, X-43): the vendors' own services, reached through the person's runner vendor homes
 * that one `agflow runner setup` logged in. Every runner of the run shares them, and none goes through the refusing
 * proxy: they reach the network as the person's runner does.
 */
export interface RealModels {
  readonly kind: 'real';
  /** CLAUDE_CONFIG_DIR and CODEX_HOME exactly as setup created them: Claude's keychain item depends on the string. */
  readonly homes: Readonly<Record<Vendor, string>>;
  /** The person's HOME, which the runners get as in production: their remote git uses the person's credentials. */
  readonly home: string;
  /**
   * The proxy and certificate variables setup recorded in the person's runner.json (design 7.1); empty without one.
   * Each runner records them too, and its process gets them, as the LaunchAgent sets them.
   */
  readonly connectivity: RunnerConfig['connectivity'];
}

export interface RunnerHomeOptions {
  /** The runner's directory; created, and used at its real path. Keep it short: runner.sock must fit in 104 bytes. */
  dir: string;
  /** The runner's name on the hub. */
  name: string;
  /** The owner's CLI sign-in: hub URL, a token from cliToken, and the owner's login. */
  credentials: Credentials;
  /** The vendors the runner offers; any other lacks its binary, and preflight reports 'binary missing' (X-10). */
  vendors: readonly Vendor[];
  /** The located pinned binaries, from requireE2e; with real models, the person's from setup. */
  binaries: Partial<Record<Vendor, string>>;
  models: RunnerModels | RealModels;
  /** The hub's project name, which names the runner's vault and clone directories; 'e2e' by default. */
  projectName?: string;
}

export interface RunnerHome {
  readonly name: string;
  /** The owner's login. */
  readonly owner: string;
  readonly vendors: readonly Vendor[];
  /** The located binaries the home links, by vendor. */
  readonly binaries: Partial<Record<Vendor, string>>;
  /** The runner's directory, at its real path; everything below lives in it. */
  readonly dir: string;
  /**
   * HOME: a scratch home, so no CLI ever reads or writes the developer's own; with real models, the person's HOME, as
   * in production.
   */
  readonly home: string;
  /** AGFLOW_HOME. */
  readonly agflowHome: string;
  /** AGFLOW_CONFIG_DIR: the CLI's config directory, holding credentials.json. */
  readonly configDir: string;
  readonly paths: RunnerPaths;
  readonly config: RunnerConfig;
  readonly hubUrl: string;
  readonly projectName: string;
  /** The runner process's whole environment. */
  readonly env: Readonly<Record<string, string>>;
  /** The runner process's stdout and stderr, appended across starts. */
  readonly logPath: string;
  /** Where the runner clones the attempt: the agent's working directory. */
  clonePath(attemptId: string): string;
  /** Deletes the directory, after making the read-only agent tools directories writable (M2b's removeAgentTools). */
  remove(): void;
}

/**
 * The runner process's environment: only what the runner and its agents read, never a developer's own settings. With
 * real models the runner also gets the person's SSH agent, which its remote git uses for a remote origin, and the
 * recorded connectivity variables, as the LaunchAgent gives them (design 7.1).
 */
function runnerEnv(
  home: { home: string; agflowHome: string; configDir: string },
  real: RealModels | null,
): Record<string, string> {
  const env: Record<string, string> = { PATH: runnerPath() };
  if (real !== null) {
    for (const name of CONNECTIVITY_VARS) {
      const value = real.connectivity[name];
      if (value !== undefined) env[name] = value;
    }
  }
  const passed = ['TMPDIR', 'USER', 'LOGNAME', 'LANG', 'SHELL', ...(real !== null ? ['SSH_AUTH_SOCK'] : [])];
  // The user variables agents inherit (buildAgentEnv), and the temporary directory Bun and the sandbox use.
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (passed.includes(name) || name.startsWith('LC_')) env[name] = value;
  }
  return {
    ...env,
    HOME: home.home,
    AGFLOW_HOME: home.agflowHome,
    AGFLOW_CONFIG_DIR: home.configDir,
    AGFLOW_TEST: '1',
  };
}

/** Links each offered vendor's located binary into the home's vendor/, where vendorBinary looks (X-20). */
function linkBinaries(
  paths: RunnerPaths,
  vendors: readonly Vendor[],
  binaries: Partial<Record<Vendor, string>>,
): void {
  const pins = VENDOR_PINS[E2E_PLATFORM];
  if (!pins) throw new Error(`VENDOR_PINS has no ${E2E_PLATFORM} entry`);
  for (const vendor of vendors) {
    const bin = binaries[vendor];
    if (bin === undefined) throw new Error(`no located ${vendor} binary for a runner that offers ${vendor}`);
    if (vendor === 'claude') {
      linkClaudeBinary(paths.home, pins.claude.version, bin);
      continue;
    }
    // Codex needs its whole version directory: the bundled rg and the code-mode host sit next to bin/.
    if (basename(dirname(bin)) !== 'bin') {
      throw new Error(`the codex binary ${bin} is not in a version directory's bin/codex`);
    }
    const link = dirname(dirname(join(paths.runner, vendorBinary('codex', pins.codex.version))));
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(dirname(dirname(bin)), link);
  }
}

/**
 * Creates a runner home: runner.json from createRunnerConfig with readMachineId's id and the e2e overrides (X-42), the
 * vendor homes inside it, the offered vendors' binaries linked into its vendor/, and the owner's credentials.json.
 * With real models, runner.json's test block holds only allowShortTimings (X-30), so preflight checks the logins; it
 * points at the person's vendor homes and records the person's connectivity variables, never the refusing proxy.
 */
export async function prepareRunnerHome(options: RunnerHomeOptions): Promise<RunnerHome> {
  mkdirSync(options.dir, { recursive: true });
  // The real path: lsof reports real paths, and vendor homes must be real paths (createRunnerConfig refuses links).
  const dir = realpathSync(options.dir);
  const owner = options.credentials.user;
  const projectName = options.projectName ?? 'e2e';
  const models = options.models;
  const real = 'kind' in models ? models : null;
  const home = real === null ? join(dir, 'home') : real.home;
  const agflowHome = join(dir, 'agflow');
  const configDir = join(dir, 'config');
  for (const path of [agflowHome, configDir, ...(real === null ? [home] : [])]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  const paths = runnerPaths(agflowHome);
  linkBinaries(paths, options.vendors, options.binaries);
  const scripted = 'kind' in models ? null : models;
  const config = createRunnerConfig(
    {
      machineId: await readMachineId(),
      name: options.name,
      capturedPath: runnerPath(),
      connectivity:
        scripted === null
          ? { ...real?.connectivity }
          : { HTTPS_PROXY: scripted.proxyUrl, HTTP_PROXY: scripted.proxyUrl, ALL_PROXY: scripted.proxyUrl, NO_PROXY },
      commitIdentity: { name: owner, email: `${owner}@agflow.invalid` },
      homes:
        real === null
          ? { claude: canonicalHome(paths.homes.claude), codex: canonicalHome(paths.homes.codex) }
          : { ...real.homes },
    },
    {
      capacity: 2,
      keepAwake: 'off',
      minFreeGb: E2E_MIN_FREE_GB,
      timings: { ...E2E_RUNNER_TIMINGS },
      test:
        scripted === null
          ? { allowShortTimings: true }
          : {
              claudeEnv: scripted.claudeEnv,
              codexConfig: scripted.codexConfig,
              skipAuthChecks: true,
              allowShortTimings: true,
            },
    },
  );
  saveRunnerConfig(paths.config, config);
  const credentials = CredentialsSchema.parse(options.credentials);
  writeFileSync(join(configDir, CREDENTIALS_FILE), `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  const project = projectKey(credentials.hubUrl, projectName);
  return {
    name: options.name,
    owner,
    vendors: [...options.vendors],
    binaries: { ...options.binaries },
    dir,
    home,
    agflowHome,
    configDir,
    paths,
    config,
    hubUrl: credentials.hubUrl,
    projectName,
    env: runnerEnv({ home, agflowHome, configDir }, real),
    logPath: join(dir, 'runner-process.log'),
    clonePath: (attemptId) => paths.clone(project, attemptId),
    remove() {
      if (existsSync(paths.vaults)) {
        for (const entry of readdirSync(paths.vaults).filter((name) => name.endsWith('.agent'))) {
          for (const attempt of readdirSync(join(paths.vaults, entry))) {
            removeAgentTools(join(paths.vaults, entry, attempt));
          }
        }
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface RunnerStartOptions {
  /** Wait until the runner's link is online with a runner id (true by default); false waits only for its socket. */
  online?: boolean;
  /** 120 s by default: a start runs the sandbox probe and every vendor's preflight. */
  timeoutMs?: number;
}

export interface RunnerProcess {
  readonly home: RunnerHome;
  readonly name: string;
  /** The running runner's pid; null while it is stopped. */
  readonly pid: number | null;
  readonly running: boolean;
  /** The exit code of the last run, or null for a run ended by a signal or still running. */
  readonly exitCode: number | null;
  /** Starts `agflow runner start` in the foreground and waits for it (RunnerStartOptions). */
  start(options?: RunnerStartOptions): Promise<void>;
  /** SIGTERM, which suspends (design 7.1); the runner must exit 0 within its suspend timing. */
  stop(): Promise<void>;
  /** SIGKILL of the runner process alone, as a crash: its agents lead their own groups and may run on. */
  kill(): Promise<void>;
  /** Stops the runner and every descendant, as a closed lid does; gives the stopped pids, the runner's first. */
  freeze(): Promise<number[]>;
  /** Resumes what freeze() stopped; the same process runs on. */
  thaw(): Promise<number[]>;
  /** `agflow runner status --json`, parsed. */
  status(): Promise<RunnerStatusReport>;
  /** The attempt's agent as the runner recorded it, checked against the live process with processIdentity. */
  agentOf(attemptId: string): Promise<ProcessIdentity>;
  /** SIGKILLs the attempt's agent process group; gives the agent it killed. */
  killAgent(attemptId: string): Promise<ProcessIdentity>;
  clonePath(attemptId: string): string;
  /** The last lines of the runner's output. */
  logTail(lines?: number): string;
  /** Thaws, then SIGKILLs the runner, its descendants and every process left with its cwd in the runner's directory. */
  close(): Promise<void>;
}

const DEFAULT_START_TIMEOUT_MS = 120_000;
/** Beyond the suspend timing: the process still has to close its database and release its lock. */
const STOP_MARGIN_MS = 15_000;
const STATUS_TIMEOUT_MS = 30_000;
const POLL_MS = 100;
const CLOSE_WAIT_MS = 10_000;

/** What the runner's GET /health answers. */
interface Health {
  pid: number;
  link: string;
  runnerId: string | null;
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

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

/** A runner process on the home, started. */
export async function startRunnerProcess(home: RunnerHome, options: RunnerStartOptions = {}): Promise<RunnerProcess> {
  const runner = createRunnerProcess(home);
  await runner.start(options);
  return runner;
}

function createRunnerProcess(home: RunnerHome): RunnerProcess {
  const { name, paths } = home;
  let proc: Bun.Subprocess | null = null;
  let frozen = false;
  const running = () => proc !== null && proc.exitCode === null && proc.signalCode === null;
  // `runner status` reads launchd's disabled state for the real label in gui/<uid> (M2c's Known behaviour 12). Its
  // PATH is an empty directory, so launchctl cannot run and the state reads unknown.
  const statusPath = join(home.dir, 'status-path');

  function log(line: string): void {
    const fd = openSync(home.logPath, 'a');
    try {
      writeSync(fd, `${line}\n`);
    } finally {
      closeSync(fd);
    }
  }

  function logTail(lines = 40): string {
    return existsSync(home.logPath) ? tail(readFileSync(home.logPath, 'utf8'), lines) : '';
  }

  function requireRunning(action: string): Bun.Subprocess {
    if (proc === null || !running()) throw new Error(`cannot ${action} runner ${name}: it is not running`);
    return proc;
  }

  /** The runner's own view through its control socket; null while the socket does not answer. */
  async function health(): Promise<Health | null> {
    try {
      return await controlRequest<Health>(paths, 'GET', '/health', undefined, { timeoutMs: 2_000 });
    } catch (error) {
      if (error instanceof ControlUnavailableError) return null;
      throw error;
    }
  }

  async function start(options: RunnerStartOptions = {}): Promise<void> {
    if (running()) throw new Error(`runner ${name} is already running (pid ${proc?.pid})`);
    const timeoutMs = options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    log(`--- harness: starting runner ${name} at ${new Date().toISOString()}`);
    const fd = openSync(home.logPath, 'a');
    let started: Bun.Subprocess;
    try {
      // --no-env-file: a .env file must not add settings to the runner's.
      started = Bun.spawn([process.execPath, '--no-env-file', CLI_MAIN, 'runner', 'start'], {
        cwd: home.dir,
        env: { ...home.env },
        stdin: 'ignore',
        stdout: fd,
        stderr: fd,
      });
    } finally {
      closeSync(fd);
    }
    proc = started;
    frozen = false;
    trackProcess(started);
    try {
      await untilStarted(started, options.online !== false, timeoutMs);
    } catch (error) {
      // A start that failed leaves nothing behind: the runner may still be retrying its link, its agents running.
      await close();
      throw error;
    }
  }

  async function untilStarted(started: Bun.Subprocess, online: boolean, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (started.exitCode !== null || started.signalCode !== null) {
        const end = started.exitCode ?? started.signalCode;
        throw new Error(`runner ${name} exited (${end}) during its start:\n${logTail()}`);
      }
      const seen = await health();
      // Only this process's answer counts: another instance of the home may still hold the socket.
      const own = seen !== null && seen.pid === started.pid;
      if (own && (!online || (seen.link === 'online' && seen.runnerId !== null))) return;
      if (Date.now() > deadline) {
        const state =
          seen === null
            ? 'its socket did not answer'
            : own
              ? `its link is ${seen.link}`
              : `its socket answered for pid ${seen.pid}`;
        throw new Error(`runner ${name} did not start within ${timeoutMs} ms (${state}):\n${logTail()}`);
      }
      await Bun.sleep(POLL_MS);
    }
  }

  async function stop(): Promise<void> {
    const current = requireRunning('stop');
    log(`--- harness: SIGTERM at ${new Date().toISOString()}`);
    current.kill('SIGTERM');
    const timeoutMs = home.config.timings.suspend + STOP_MARGIN_MS;
    const code = await exitWithin(current, timeoutMs);
    if (code === null) {
      current.kill('SIGKILL');
      await current.exited;
      throw new Error(`runner ${name} did not exit within ${timeoutMs} ms of SIGTERM:\n${logTail()}`);
    }
    if (code !== 0) throw new Error(`runner ${name} exited ${code} on SIGTERM:\n${logTail()}`);
  }

  async function kill(): Promise<void> {
    const current = requireRunning('kill');
    log(`--- harness: SIGKILL at ${new Date().toISOString()}`);
    current.kill('SIGKILL');
    await current.exited;
  }

  async function freeze(): Promise<number[]> {
    const current = requireRunning('freeze');
    log(`--- harness: freezing the tree at ${new Date().toISOString()}`);
    frozen = true;
    return freezeTree(current.pid);
  }

  async function thaw(): Promise<number[]> {
    const current = requireRunning('thaw');
    frozen = false;
    const thawed = await thawTree(current.pid);
    log(`--- harness: thawed the tree at ${new Date().toISOString()}`);
    return thawed;
  }

  async function status(): Promise<RunnerStatusReport> {
    mkdirSync(statusPath, { recursive: true });
    const env = { ...home.env, PATH: statusPath };
    const child = Bun.spawn([process.execPath, '--no-env-file', CLI_MAIN, 'runner', 'status', '--json'], {
      cwd: home.dir,
      env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const code = await exitWithin(child, STATUS_TIMEOUT_MS);
    if (code === null) {
      child.kill('SIGKILL');
      await child.exited;
      throw new Error(`agflow runner status --json for ${name} did not answer within ${STATUS_TIMEOUT_MS} ms`);
    }
    const [stdout, stderr] = await output;
    // It exits 0 when the runner answered and 1 with the offline report; anything else is a failure.
    try {
      return JSON.parse(stdout) as RunnerStatusReport;
    } catch {
      throw new Error(`agflow runner status --json for ${name} exited ${code}: ${stderr.trim() || stdout.trim()}`);
    }
  }

  async function agentOf(attemptId: string): Promise<ProcessIdentity> {
    const report = await status();
    if (!report.running) throw new Error(`runner ${name} is not running, so it has no agent for ${attemptId}`);
    const attempt = report.attempts.find((candidate) => candidate.attemptId === attemptId);
    if (attempt === undefined) throw new Error(`runner ${name} has no attempt ${attemptId}`);
    const { pid, pgid, lstart } = attempt;
    if (pid === null || pgid === null || lstart === null) {
      throw new Error(`runner ${name} has recorded no agent process for ${attemptId} (phase ${attempt.phase})`);
    }
    // macOS reuses pids: only the same pid with the same start time is the recorded agent.
    const now = await processIdentity(pid);
    if (now === null || !sameProcess(now, { pid, lstart }) || now.pgid !== pgid) {
      throw new Error(`the agent of ${attemptId} (pid ${pid}, started ${lstart}) no longer runs`);
    }
    return { pid, pgid, lstart };
  }

  async function killAgent(attemptId: string): Promise<ProcessIdentity> {
    const agent = await agentOf(attemptId);
    log(`--- harness: SIGKILL of ${attemptId}'s group ${agent.pgid} at ${new Date().toISOString()}`);
    if (!(await signalGroup(agent.pgid, 'SIGKILL'))) {
      throw new Error(`the agent group ${agent.pgid} of ${attemptId} is gone`);
    }
    return agent;
  }

  async function close(): Promise<void> {
    const current = proc;
    if (current !== null && running()) {
      if (frozen) await thaw();
      // Collected first: once the runner is gone, its agents are reparented and no longer descend from it.
      const descendants = await descendantsOf(current.pid);
      current.kill('SIGKILL');
      await current.exited;
      for (const row of descendants) signal(row.pid, 'SIGKILL');
    }
    // Escaped tools and agents of an earlier kill: everything whose cwd is still inside the runner's directory.
    const left = await processesInDir(home.dir);
    for (const row of left) signal(row.pid, 'SIGKILL');
    for (const row of left) await waitUntilGone(row.pid, { timeoutMs: CLOSE_WAIT_MS });
  }

  return {
    home,
    name,
    get pid() {
      return running() ? (proc?.pid ?? null) : null;
    },
    get running() {
      return running();
    },
    get exitCode() {
      return proc === null || running() ? null : proc.exitCode;
    },
    start: bindTestProcessScope(start),
    stop,
    kill,
    freeze,
    thaw,
    status,
    agentOf,
    killAgent,
    clonePath: (attemptId) => home.clonePath(attemptId),
    logTail,
    close,
  };
}

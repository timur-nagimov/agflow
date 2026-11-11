// Laptop setup (design 7.1): verify sign-in before writes, then reuse the runner's config, pins, logins and service.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { createInterface, type Interface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { editLocalSettings, loadRunnerConfig, type RunnerConfig, saveRunnerConfig } from '@agflow/runner/src/config';
import { agflowHome, type RunnerPaths, runnerPaths } from '@agflow/runner/src/paths';
import { type CheckResult, formatChecks } from '@agflow/runner/src/service/checks';
import { controlRequest } from '@agflow/runner/src/service/control';
import { installRefusal, installService } from '@agflow/runner/src/service/launchd';
import { AlreadyRunningError, acquireRunnerLock, type RunnerLock } from '@agflow/runner/src/service/lock';
import {
  canonicalHome,
  captureLoginShellEnv,
  machineMismatch,
  readComputerName,
  readGitIdentity,
  readMachineId,
} from '@agflow/runner/src/service/machine';
import { createRunnerConfig } from '@agflow/runner/src/service/runner-json';
import { defaultExec, type Exec } from '@agflow/runner/src/service/system';
import { ensurePinnedVendors } from '@agflow/runner/src/vendor/install';
import { claudeLoginStatus, codexLoginStatus, loginClaude, loginCodex } from '@agflow/runner/src/vendor/login';
import { type PlatformPins, VENDOR_PINS, vendorPlatform } from '@agflow/runner/src/vendor/pins';
import type { ParsedArgs } from './args';
import { loadCredentials } from './credentials';
import { type FetchFn, HubClient, HubClientError } from './hub-client';
import type { Io } from './io';
import { configDir } from './paths';
import { type SelfCommand, selfCommand } from './self';

export interface Prompt {
  ask(question: string, fallback: string): Promise<string>;
}

/** One reader retains piped lines between questions; EOF, like an empty line, accepts the default. */
export function terminalPrompt(): Prompt & { close(): void } {
  let reader: Interface | undefined;
  let lines: AsyncIterator<string> | undefined;
  return {
    async ask(question, fallback) {
      reader ??= createInterface({ input: process.stdin, output: process.stderr, terminal: process.stdin.isTTY });
      lines ??= reader[Symbol.asyncIterator]();
      process.stderr.write(`${question} [${fallback}]: `);
      const answer = await lines.next();
      return answer.done || !answer.value.trim() ? fallback : answer.value.trim();
    },
    close() {
      reader?.close();
    },
  };
}

export interface RunnerSetupDeps {
  dir: string;
  paths: RunnerPaths;
  env: Record<string, string | undefined>;
  fetch: FetchFn;
  exec: Exec;
  prompt: Prompt;
  pins: PlatformPins;
  /** The vendor platform key, including for login verification. */
  platform: string;
  machinePlatform: NodeJS.Platform;
  home: string;
  uid: number;
  agflow: SelfCommand;
  socketTimeoutMs: number;
  checksTimeoutMs: number;
  pollMs: number;
}

async function configure(
  paths: RunnerPaths,
  env: RunnerSetupDeps['env'],
  exec: Exec,
  platform: NodeJS.Platform,
  prompt: Prompt,
  log: (line: string) => void,
): Promise<RunnerConfig> {
  const machineId = await readMachineId({ exec, platform });
  let lock: RunnerLock;
  try {
    lock = await acquireRunnerLock(paths, { mode: 'foreground', wait: false });
  } catch (error) {
    if (!(error instanceof AlreadyRunningError)) throw error;
    log(
      `the runner (pid ${error.pid ?? 'unknown'}) is running, so runner.json stays as it is; ` +
        'change capacity on the hub, or stop the runner and run setup again',
    );
    return loadRunnerConfig(paths.config, env);
  }
  try {
    // Re-read under the lock: a service may have saved settings while setup checked sign-in.
    const previous = existsSync(paths.config) ? loadRunnerConfig(paths.config, env) : null;
    const mismatch = previous !== null && machineMismatch(previous, machineId) !== null;
    // A runner.json from another Mac names that Mac's runner, which still runs there: this one starts from the design's
    // defaults, as a first setup does.
    const kept = mismatch ? null : previous;
    const defaultName = kept?.name ?? (await readComputerName(exec));
    const defaultCapacity = kept?.capacity ?? 2;
    const name = (await prompt.ask('Runner name', defaultName)).trim() || defaultName;
    const answer = (await prompt.ask('Capacity', String(defaultCapacity))).trim();
    const capacity = Number(answer || defaultCapacity);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 16) {
      throw new Error('capacity must be a whole number from 1 to 16');
    }
    if (kept) {
      if (name === kept.name && capacity === kept.capacity) return kept;
      const next = { ...editLocalSettings(kept, { capacity }).config, name };
      saveRunnerConfig(paths.config, next);
      return next;
    }
    const captured = await captureLoginShellEnv({ env, exec });
    const config = createRunnerConfig(
      {
        machineId,
        name: defaultName,
        capturedPath: captured.path,
        connectivity: captured.connectivity,
        commitIdentity: await readGitIdentity(exec),
        homes: { claude: canonicalHome(paths.homes.claude), codex: canonicalHome(paths.homes.codex) },
      },
      { name, capacity },
    );
    saveRunnerConfig(paths.config, config);
    if (mismatch) log('assigned a new runner key because runner.json came from another Mac');
    return config;
  } finally {
    lock.release();
  }
}

async function serviceChecks(paths: RunnerPaths, socketTimeoutMs: number, checksTimeoutMs: number, pollMs: number) {
  for (const [name, value] of Object.entries({ socketTimeoutMs, checksTimeoutMs, pollMs })) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  }
  const deadline = performance.now() + socketTimeoutMs;
  let lastError: unknown;
  do {
    try {
      await controlRequest(paths, 'GET', '/health', undefined, {
        timeoutMs: Math.max(1, Math.ceil(Math.min(3_000, deadline - performance.now()))),
      });
      // A responsive socket can precede runner creation; route errors retry against the same startup deadline.
      return await controlRequest<CheckResult[]>(paths, 'POST', '/checks', undefined, { timeoutMs: checksTimeoutMs });
    } catch (error) {
      lastError = error;
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    await delay(Math.min(pollMs, remaining));
  } while (performance.now() < deadline);
  throw new Error(`timed out waiting for runner service checks; run agflow runner status and see ${paths.runnerLog}`, {
    cause: lastError,
  });
}

export async function runnerSetup(args: ParsedArgs, io: Io, deps: Partial<RunnerSetupDeps> = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const paths = deps.paths ?? runnerPaths(agflowHome(env));
  const credentials = loadCredentials(deps.dir ?? configDir());
  if (!credentials) throw new Error('not signed in; run agflow login --hub <url>');
  const client = new HubClient({ baseUrl: credentials.hubUrl, token: credentials.token, fetch: deps.fetch });
  let user: string;
  try {
    user = (await client.runnerWhoami()).user;
  } catch (error) {
    if (error instanceof HubClientError && error.status === 401) {
      throw new Error(`the hub refused the CLI sign-in; run agflow login --hub ${credentials.hubUrl}`);
    }
    throw error;
  }
  const log = (line: string) => io.out(`${line}\n`);
  log(`signed in to ${credentials.hubUrl} as ${user}`);
  const exec = deps.exec ?? defaultExec;
  const terminal = args.flags.yes !== true && !deps.prompt ? terminalPrompt() : undefined;
  let config: RunnerConfig;
  try {
    config = await configure(
      paths,
      env,
      exec,
      deps.machinePlatform ?? process.platform,
      args.flags.yes === true ? { ask: async (_question, fallback) => fallback } : (deps.prompt ?? terminal!),
      log,
    );
  } finally {
    terminal?.close();
  }
  const platform = deps.platform ?? vendorPlatform();
  const pins = deps.pins ?? VENDOR_PINS[platform];
  const pinOptions = { env, exec, platform, pins, log };
  log('installing the pinned Claude and Codex binaries; the first setup downloads about 550 MB');
  await ensurePinnedVendors(paths, pinOptions);
  for (const vendor of ['claude', 'codex'] as const) {
    const options = { version: pins?.[vendor].version, platform, exec, base: env };
    const status = await (vendor === 'claude' ? claudeLoginStatus : codexLoginStatus)(config, paths, options);
    if (status.ok && args.flags.relogin !== true) {
      log(`${vendor}: signed in${status.plan ? ` (${status.plan})` : ''}`);
    } else {
      log(`${vendor}: login opens now in the runner's own home`);
      await (vendor === 'claude' ? loginClaude : loginCodex)(config, paths, options);
    }
  }
  if (args.flags['no-service'] === true) {
    log('setup is done; run agflow runner start');
    return 0;
  }
  const refusal = installRefusal(config, env);
  if (refusal) {
    log(refusal);
    log('run agflow runner setup --no-service and then agflow runner start to run a test runner in the foreground');
    return 1;
  }
  const installed = await installService({
    paths,
    agflow: deps.agflow ?? selfCommand(),
    env,
    exec,
    uid: deps.uid,
    home: deps.home ?? homedir(),
    log,
    installPins: (paths) => ensurePinnedVendors(paths, pinOptions),
  });
  log(`installed ${installed.plistPath}; the runner starts as ${installed.target}`);
  const results = await serviceChecks(
    paths,
    deps.socketTimeoutMs ?? 120_000,
    deps.checksTimeoutMs ?? 180_000,
    deps.pollMs ?? 250,
  );
  io.out(`${formatChecks(results)}\n`);
  return results.some((check) => check.status === 'fail') ? 1 : 0;
}

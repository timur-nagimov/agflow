// Runner setup (design 7.1): verify sign-in before writes, then reuse the runner's config, pins, logins and service.
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createInterface, type Interface } from 'node:readline/promises';
import { Writable } from 'node:stream';
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
import { installSystemdService } from '@agflow/runner/src/service/systemd';
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

/**
 * Reads a secret without showing it: the lines up to an empty one or the end of the input, joined. A terminal wraps a
 * long token over lines, and a copy of it keeps the breaks.
 */
export async function readSecret(
  question: string,
  input: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
  output: NodeJS.WritableStream = process.stderr,
): Promise<string> {
  output.write(question);
  // The reader shows what is typed on its own output, which goes nowhere.
  const nowhere = new Writable({ write: (_chunk, _encoding, done) => done() });
  const reader = createInterface({ input, output: nowhere, terminal: input.isTTY === true });
  const lines: string[] = [];
  try {
    for await (const line of reader) {
      if (line.trim() === '') break;
      lines.push(line);
    }
  } finally {
    reader.close();
  }
  output.write('\n');
  return lines.join('\n');
}

export interface RunnerSetupDeps {
  dir: string;
  paths: RunnerPaths;
  env: Record<string, string | undefined>;
  fetch: FetchFn;
  exec: Exec;
  prompt: Prompt;
  /** Reads the Claude token on Linux; readSecret by default. */
  secret: (question: string) => Promise<string>;
  pins: PlatformPins;
  /** The vendor platform key, including for login verification. */
  platform: string;
  /** The OS: Linux has no browser for the logins and runs the runner as a systemd unit. */
  machinePlatform: NodeJS.Platform;
  /** Linux's machine id file, /etc/machine-id by default. */
  machineIdFile: string;
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
  machine: { platform: NodeJS.Platform; machineIdFile?: string },
  prompt: Prompt,
  log: (line: string) => void,
): Promise<RunnerConfig> {
  const machineId = await readMachineId({ exec, ...machine });
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

/** How every token of `claude setup-token` starts. */
export const CLAUDE_TOKEN_PREFIX = 'sk-ant-oat';

/**
 * What the owner does on a machine with no browser (Linux) for a Claude login: makes a token with `claude setup-token`
 * on a Mac, then pastes it into setup, which --yes keeps from asking.
 */
export function claudeTokenSteps(reason: string, ask: boolean): string[] {
  return [
    `claude: ${reason}; this machine has no browser, so Claude signs in with a token made on your Mac:`,
    '  1. on your Mac run: claude setup-token',
    ask
      ? '  2. paste the token here, then press Enter on an empty line'
      : '  2. run agflow runner setup here without --yes, and paste the token when it asks',
  ];
}

/**
 * Saves a pasted token of `claude setup-token` as CLAUDE_CODE_OAUTH_TOKEN in the runner's environment file, readable by
 * its owner alone. All whitespace goes, which joins the lines of a wrapped token; the rest must start as such a token.
 */
export function saveClaudeToken(paths: Pick<RunnerPaths, 'envFile'>, pasted: string): void {
  const token = pasted.replace(/\s+/g, '');
  if (!token.startsWith(CLAUDE_TOKEN_PREFIX)) {
    throw new Error(
      `that is not a token of claude setup-token, which starts with ${CLAUDE_TOKEN_PREFIX}; ` +
        'run agflow runner setup again and paste the whole token',
    );
  }
  writeFileSync(paths.envFile, `CLAUDE_CODE_OAUTH_TOKEN=${token}\n`, { mode: 0o600 });
  chmodSync(paths.envFile, 0o600);
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
  const machinePlatform = deps.machinePlatform ?? process.platform;
  // A Linux runner is a cloud machine: no browser for the logins, and systemd instead of launchd.
  const linux = machinePlatform === 'linux';
  const terminal = args.flags.yes !== true && !deps.prompt ? terminalPrompt() : undefined;
  let config: RunnerConfig;
  try {
    config = await configure(
      paths,
      env,
      exec,
      { platform: machinePlatform, machineIdFile: deps.machineIdFile },
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
  // The Claude token's file holds a secret: only its owner reads it.
  if (existsSync(paths.envFile)) chmodSync(paths.envFile, 0o600);
  const ask = args.flags.yes !== true;
  let claudeToken = false;
  for (const vendor of ['claude', 'codex'] as const) {
    const options = { version: pins?.[vendor].version, platform, exec, base: env, deviceAuth: linux };
    const status = await (vendor === 'claude' ? claudeLoginStatus : codexLoginStatus)(config, paths, options);
    // On Linux Claude signs in with a token made on a Mac, which setup asks for; --yes asks for nothing.
    const token = linux && vendor === 'claude';
    if (status.ok && (args.flags.relogin !== true || (token && !ask))) {
      log(`${vendor}: signed in${status.plan ? ` (${status.plan})` : ''}`);
    } else if (token) {
      for (const line of claudeTokenSteps(status.ok ? '--relogin asks for a new token' : status.reason, ask)) log(line);
      if (ask) {
        saveClaudeToken(paths, await (deps.secret ?? readSecret)('Token: '));
        const saved = await claudeLoginStatus(config, paths, options);
        if (!saved.ok) throw new Error(`claude: ${saved.reason}`);
        log('claude: signed in');
      } else {
        claudeToken = true;
      }
    } else {
      log(
        linux
          ? `${vendor}: sign in with the code below, in a browser on any machine`
          : `${vendor}: login opens now in the runner's own home`,
      );
      await (vendor === 'claude' ? loginClaude : loginCodex)(config, paths, options);
    }
  }
  if (claudeToken) return 1;
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
  const service = {
    paths,
    agflow: deps.agflow ?? selfCommand(),
    env,
    exec,
    home: deps.home ?? homedir(),
    log,
    installPins: (paths: RunnerPaths) => ensurePinnedVendors(paths, pinOptions),
  };
  if (linux) {
    const installed = await installSystemdService(service);
    log(`installed ${installed.unitPath}; the runner starts as ${installed.target}`);
  } else {
    const installed = await installService({ ...service, uid: deps.uid });
    log(`installed ${installed.plistPath}; the runner starts as ${installed.target}`);
  }
  const results = await serviceChecks(
    paths,
    deps.socketTimeoutMs ?? 120_000,
    deps.checksTimeoutMs ?? 180_000,
    deps.pollMs ?? 250,
  );
  io.out(`${formatChecks(results)}\n`);
  return results.some((check) => check.status === 'fail') ? 1 : 0;
}

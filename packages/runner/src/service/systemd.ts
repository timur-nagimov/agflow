// The systemd user unit of a Linux runner (design 7.1), the counterpart of launchd.ts's LaunchAgent. install writes
// ~/.config/systemd/user/agflow-runner.service, turns on lingering, so the unit runs with nobody logged in and starts
// at boot, and starts it; stop, restart and uninstall drive it with systemctl --user.
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { AgflowCommand } from '../adapters/types';
import { loadRunnerConfig } from '../config';
import type { RunnerPaths } from '../paths';
import { ensurePinnedVendors } from '../vendor/install';
import { installRefusal, programPaths, serviceEnvironment, waitForServiceLock } from './launchd';
import { launchdLogPaths } from './log';
import { defaultExec, type Exec, type ExecResult } from './system';

export const SYSTEMD_UNIT = 'agflow-runner.service';

type Env = Record<string, string | undefined>;

/** A stop waits for the runner's suspend (45 s) within the unit's TimeoutStopSec (60 s); plus a margin. */
const STOP_TIMEOUT_MS = 75_000;

export interface SystemctlOptions {
  exec?: Exec;
  /** The user's home, not AGFLOW_HOME; os.homedir() by default. */
  home?: string;
}

interface InstallOptions extends SystemctlOptions {
  paths: RunnerPaths;
  agflow: AgflowCommand;
  env?: Env;
  installPins?: typeof ensurePinnedVendors;
  /** Whose lingering is turned on; the current user by default. */
  user?: string;
  lockPollMs?: number;
  /** 90 s, as for the LaunchAgent. */
  lockWaitMs?: number;
  /** Progress and warnings, without a trailing newline. */
  log?: (line: string) => void;
}

export interface UnitInput {
  execStart: string[];
  environment: Record<string, string>;
  stdout: string;
  stderr: string;
}

export function unitPath(home: string = homedir()): string {
  return join(home, '.config', 'systemd', 'user', SYSTEMD_UNIT);
}

function plainValue(value: string): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error(`a unit file cannot hold ${JSON.stringify(value)}`);
  // % starts a specifier wherever it appears.
  return value.replaceAll('%', '%%');
}

/** One word of a unit line, quoted when it needs it; in ExecStart a $ starts a variable, so it is doubled there. */
function unitWord(word: string, command: boolean): string {
  let value = plainValue(word);
  if (command) value = value.replaceAll('$', () => '$$');
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/** Pure, stable unit text. */
export function renderUnit(input: UnitInput): string {
  return [
    '[Unit]',
    'Description=agflow runner',
    '',
    '[Service]',
    `ExecStart=${input.execStart.map((word) => unitWord(word, true)).join(' ')}`,
    ...Object.keys(input.environment)
      .sort()
      .map((key) => `Environment=${unitWord(`${key}=${input.environment[key]}`, false)}`),
    // As the LaunchAgent's KeepAlive: a crash restarts the runner, a clean exit (a stop, or a refusal that needs a
    // person) does not, so it never loops.
    'Restart=on-failure',
    'RestartSec=30',
    // SIGTERM goes to the runner alone, which suspends its agents; whatever is left is killed once it has exited.
    'KillMode=mixed',
    'TimeoutStopSec=60',
    // When the kernel runs out of memory and kills one process, an agent's build say, the runner and the other agents
    // go on, as on a Mac; systemd's default would stop the whole unit.
    'OOMPolicy=continue',
    'LimitNOFILE=65536',
    `StandardOutput=append:${plainValue(input.stdout)}`,
    `StandardError=append:${plainValue(input.stderr)}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function succeeded(result: ExecResult): boolean {
  return result.exitCode === 0 && !result.timedOut;
}

function detail(result: ExecResult): string {
  return result.stderr.trim() || (result.timedOut ? 'timed out' : `exit ${result.exitCode}`);
}

function systemctl(args: string[], options: SystemctlOptions, timeoutMs = 30_000): Promise<ExecResult> {
  return (options.exec ?? defaultExec)(['systemctl', '--user', ...args], { timeoutMs });
}

function requireSuccess(command: string, result: ExecResult): void {
  if (!succeeded(result)) throw new Error(`systemctl --user ${command} failed: ${detail(result)}`);
}

/** Writes the unit, turns on lingering, then replaces a running service with the new one once it holds no lock. */
export async function installSystemdService(
  options: InstallOptions,
): Promise<{ unitPath: string; target: string; warnings: string[] }> {
  const { paths, agflow } = options;
  const env = options.env ?? process.env;
  const config = loadRunnerConfig(paths.config, env);
  const refusal = installRefusal(config, env);
  if (refusal) throw new Error(refusal);
  for (const path of programPaths(agflow)) {
    if (!isAbsolute(path)) throw new Error(`the unit's program paths must be absolute: ${path}`);
  }
  if (!isAbsolute(paths.home)) throw new Error("the unit's AGFLOW_HOME must be absolute");
  const pollMs = options.lockPollMs ?? 100;
  const waitMs = options.lockWaitMs ?? 90_000;
  if (!Number.isFinite(pollMs) || pollMs <= 0) throw new Error('lockPollMs must be positive');
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new Error('lockWaitMs must be nonnegative');
  const path = unitPath(resolve(options.home ?? homedir()));
  const warnings: string[] = [];
  const warn = (line: string) => {
    warnings.push(line);
    options.log?.(line);
  };

  await (options.installPins ?? ensurePinnedVendors)(paths, {
    env, exec: options.exec, log: options.log, vendors: config.vendors,
  });
  const unit = renderUnit({
    execStart: [agflow.command, ...agflow.args, 'runner', 'start', '--service'],
    environment: serviceEnvironment(config, paths, env),
    ...launchdLogPaths(paths),
  });
  mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${SYSTEMD_UNIT}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, unit, { mode: 0o644, flag: 'wx' });
    chmodSync(temporary, 0o644);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }

  const user = options.user ?? userInfo().username;
  const linger = await (options.exec ?? defaultExec)(['loginctl', 'enable-linger', user], { timeoutMs: 30_000 });
  if (!succeeded(linger)) {
    warn(
      `warning: loginctl enable-linger failed (${detail(linger)}); run sudo loginctl enable-linger ${user}, ` +
        'or the runner stops when you log out',
    );
  }
  requireSuccess('daemon-reload', await systemctl(['daemon-reload'], options));
  // Stopping a unit that is not running succeeds; a failure leaves the lock wait to tell.
  await systemctl(['stop', SYSTEMD_UNIT], options, STOP_TIMEOUT_MS);
  await waitForServiceLock(paths, { deadline: performance.now() + waitMs, pollMs, waitMs }, warn);
  requireSuccess('enable', await systemctl(['enable', SYSTEMD_UNIT], options));
  requireSuccess('start', await systemctl(['start', SYSTEMD_UNIT], options));
  return { unitPath: path, target: SYSTEMD_UNIT, warnings };
}

/** Whether the unit is installed and enabled: what restart needs, as a loaded LaunchAgent on macOS. */
export async function systemdServiceEnabled(options: SystemctlOptions = {}): Promise<boolean> {
  try {
    return succeeded(await systemctl(['is-enabled', '--quiet', SYSTEMD_UNIT], options));
  } catch {
    return false;
  }
}

/** Whether systemd has the unit disabled; null when it cannot tell (no unit, no systemctl, no user manager). */
export async function systemdServiceDisabled(options: SystemctlOptions = {}): Promise<boolean | null> {
  try {
    const state = (await systemctl(['is-enabled', SYSTEMD_UNIT], options, 3_000)).stdout.trim();
    return state === 'enabled' ? false : state === 'disabled' ? true : null;
  } catch {
    return null;
  }
}

/**
 * The end of a stop: an installed unit is stopped, which also cancels a restart systemd has planned, and disabled
 * until install. False when no unit is installed.
 */
export async function disableSystemdService(options: SystemctlOptions = {}): Promise<boolean> {
  if (!existsSync(unitPath(options.home))) return false;
  requireSuccess('disable --now', await systemctl(['disable', '--now', SYSTEMD_UNIT], options, STOP_TIMEOUT_MS));
  return true;
}

/** Starts the unit again after a suspend; systemd stops whatever of the old process is left first. */
export async function restartSystemdService(options: SystemctlOptions = {}): Promise<void> {
  requireSuccess('restart', await systemctl(['restart', SYSTEMD_UNIT], options, 120_000));
}

/** Uninstall: stops and disables the unit, removes its file and reloads systemd; no unit at all is normal. */
export async function removeSystemdService(options: SystemctlOptions = {}): Promise<string> {
  const path = unitPath(options.home);
  await disableSystemdService(options);
  rmSync(path, { force: true });
  // The file is gone either way; a manager that cannot reload forgets the unit at its next start.
  await systemctl(['daemon-reload'], options).catch(() => null);
  return path;
}

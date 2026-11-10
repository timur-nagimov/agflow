// The per-user LaunchAgent (design 7.1): install upgrades pins, replaces the plist, and waits out the old service.
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { AgflowCommand } from '../adapters/types';
import { CONNECTIVITY_VARS, loadRunnerConfig, type RunnerConfig } from '../config';
import type { RunnerPaths } from '../paths';
import { ensurePinnedVendors } from '../vendor/install';
import { readLockOwner } from './lock';
import { launchdLogPaths } from './log';
import { defaultExec, type Exec, type ExecResult } from './system';

export const LAUNCHD_LABEL = 'dev.agflow.runner';

type Env = Record<string, string | undefined>;

interface LaunchctlOptions {
  exec?: Exec;
  label?: string;
  uid?: number;
}

interface PlistOptions {
  /** The user's home, not AGFLOW_HOME. */
  home?: string;
  label?: string;
}

interface PlistInput {
  label: string;
  programArguments: string[];
  environment: Record<string, string>;
  stdout: string;
  stderr: string;
}

interface InstallOptions extends LaunchctlOptions, PlistOptions {
  paths: RunnerPaths;
  agflow: AgflowCommand;
  env?: Env;
  installPins?: typeof ensurePinnedVendors;
  lockPollMs?: number;
  /** 90 s allows suspension (45 s), launchd's ExitTimeOut (60 s), and a margin. */
  lockWaitMs?: number;
  /** Progress and warnings, without a trailing newline. */
  log?: (line: string) => void;
}

export function plistPath(options: PlistOptions = {}): string {
  return join(options.home ?? homedir(), 'Library', 'LaunchAgents', `${options.label ?? LAUNCHD_LABEL}.plist`);
}

export function serviceTarget(label = LAUNCHD_LABEL, uid = process.getuid!()): string {
  return `gui/${uid}/${label}`;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** Pure, stable XML; KeepAlive.SuccessfulExit implies RunAtLoad. */
export function renderPlist(input: PlistInput): string {
  const string = (value: string) => `<string>${xmlEscape(value)}</string>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '<key>Label</key>',
    string(input.label),
    '<key>ProgramArguments</key>',
    '<array>',
    ...input.programArguments.map(string),
    '</array>',
    '<key>EnvironmentVariables</key>',
    '<dict>',
    ...Object.keys(input.environment)
      .sort()
      .flatMap((key) => [`<key>${xmlEscape(key)}</key>`, string(input.environment[key])]),
    '</dict>',
    '<key>KeepAlive</key>',
    '<dict>',
    '<key>SuccessfulExit</key>',
    '<false/>',
    '</dict>',
    '<key>ExitTimeOut</key>',
    '<integer>60</integer>',
    '<key>ThrottleInterval</key>',
    '<integer>30</integer>',
    '<key>HardResourceLimits</key>',
    '<dict>',
    '<key>NumberOfFiles</key>',
    '<integer>65536</integer>',
    '</dict>',
    '<key>ProcessType</key>',
    string('Interactive'),
    '<key>LimitLoadToSessionType</key>',
    string('Aqua'),
    '<key>StandardOutPath</key>',
    string(input.stdout),
    '<key>StandardErrorPath</key>',
    string(input.stderr),
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** Installation refuses either test switch alone, unlike runtime isTestMode which requires both. */
export function installRefusal(config: Pick<RunnerConfig, 'test'>, env: Env = process.env): string | null {
  return env.AGFLOW_TEST === '1' || config.test !== undefined
    ? 'cannot install the runner in test mode; unset AGFLOW_TEST and remove the test block from runner.json'
    : null;
}

function succeeded(result: ExecResult): boolean {
  return result.exitCode === 0 && !result.timedOut;
}

/** bootout waits for the process to exit, which launchd allows ExitTimeOut (60 s) after a suspend; plus a margin. */
const BOOTOUT_TIMEOUT_MS = 75_000;

function launchctl(args: string[], options: LaunchctlOptions, timeoutMs = 30_000): Promise<ExecResult> {
  return (options.exec ?? defaultExec)(['launchctl', ...args], { timeoutMs });
}

function requireSuccess(command: string, result: ExecResult, hint = ''): void {
  if (succeeded(result)) return;
  const detail = result.stderr.trim() || (result.timedOut ? 'timed out' : `exit ${result.exitCode}`);
  throw new Error(`launchctl ${command} failed: ${detail}${hint}`);
}

/** False means nothing was unloaded; an already absent job is normal. */
export async function bootoutService(options: LaunchctlOptions = {}): Promise<boolean> {
  try {
    const target = serviceTarget(options.label, options.uid);
    return succeeded(await launchctl(['bootout', target], options, BOOTOUT_TIMEOUT_MS));
  } catch {
    return false;
  }
}

export async function disableService(options: LaunchctlOptions = {}): Promise<void> {
  requireSuccess('disable', await launchctl(['disable', serviceTarget(options.label, options.uid)], options));
}

/** kickstart returns once the job runs, and launchd holds a job that started within its throttle for up to a minute. */
export async function kickstartService(options: LaunchctlOptions = {}): Promise<void> {
  const target = serviceTarget(options.label, options.uid);
  requireSuccess('kickstart', await launchctl(['kickstart', '-k', target], options, 120_000));
}

export async function serviceLoaded(options: LaunchctlOptions = {}): Promise<boolean> {
  return succeeded(await launchctl(['print', serviceTarget(options.label, options.uid)], options));
}

/**
 * The files ProgramArguments names: the command, every argument that is not an option (the source main.ts, or the
 * value of a separate `--config <path>`), and the value of `--config=<path>`. Options such as --no-env-file are not.
 */
export function programPaths(agflow: AgflowCommand): string[] {
  const paths = [agflow.command];
  for (const argument of agflow.args) {
    if (!argument.startsWith('-')) paths.push(argument);
    else if (argument.startsWith('--config=')) paths.push(argument.slice('--config='.length));
  }
  return paths;
}

export async function installService(
  options: InstallOptions,
): Promise<{ plistPath: string; target: string; warnings: string[] }> {
  const { paths, agflow } = options;
  const env = options.env ?? process.env;
  const config = loadRunnerConfig(paths.config, env);
  const refusal = installRefusal(config, env);
  if (refusal) throw new Error(refusal);
  const program = [agflow.command, ...agflow.args];
  const files = programPaths(agflow);
  for (const path of files) {
    if (!isAbsolute(path)) throw new Error(`LaunchAgent program paths must be absolute: ${path}`);
  }
  if (!isAbsolute(paths.home)) throw new Error('LaunchAgent AGFLOW_HOME must be absolute');
  const pollMs = options.lockPollMs ?? 100;
  const waitMs = options.lockWaitMs ?? 90_000;
  if (!Number.isFinite(pollMs) || pollMs <= 0) throw new Error('lockPollMs must be positive');
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new Error('lockWaitMs must be nonnegative');
  const home = resolve(options.home ?? homedir());
  const label = options.label ?? LAUNCHD_LABEL;
  const uid = options.uid ?? process.getuid!();
  const target = serviceTarget(label, uid);
  const path = plistPath({ home, label });
  const warnings: string[] = [];
  const warn = (line: string) => {
    warnings.push(line);
    options.log?.(line);
  };

  await (options.installPins ?? ensurePinnedVendors)(paths, { env, exec: options.exec, log: options.log });
  for (const argument of files) {
    if (
      ['Desktop', 'Documents', 'Downloads'].some((folder) => {
        const protectedPath = join(home, folder);
        const absolute = resolve(argument);
        return absolute === protectedPath || absolute.startsWith(protectedPath + sep);
      })
    ) {
      warn(
        `warning: ${argument} is in a privacy-protected folder; ` +
          'macOS asks for folder access for a LaunchAgent there. ' +
          'Move the binary or source to ~/.local/bin or /usr/local/bin and run install again.',
      );
    }
  }

  const environment: Record<string, string> = { PATH: config.capturedPath, NODE_USE_SYSTEM_CA: '1' };
  for (const key of CONNECTIVITY_VARS) {
    const value = config.connectivity[key];
    if (value !== undefined) environment[key] = value;
  }
  if (env.AGFLOW_HOME !== undefined) environment.AGFLOW_HOME = paths.home;
  if (env.AGFLOW_CONFIG_DIR !== undefined) environment.AGFLOW_CONFIG_DIR = resolve(env.AGFLOW_CONFIG_DIR);
  const plist = renderPlist({
    label,
    programArguments: [...program, 'runner', 'start', '--service'],
    environment,
    ...launchdLogPaths(paths),
  });
  mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${label}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, plist, { mode: 0o644, flag: 'wx' });
    chmodSync(temporary, 0o644);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }

  await bootoutService({ ...options, label, uid });
  const deadline = performance.now() + waitMs;
  let owner = readLockOwner(paths);
  while (owner !== null) {
    if (owner.mode === 'foreground') {
      warn(`warning: the service waits for the foreground runner (pid ${owner.pid ?? 'unknown'}) to stop`);
      break;
    }
    // An unknown owner can be a service still writing its identity; wait rather than racing its teardown.
    if (performance.now() >= deadline) {
      throw new Error(`runner.lock is still held by pid ${owner.pid ?? 'unknown'} after ${waitMs} ms; install aborted`);
    }
    await delay(Math.min(pollMs, Math.max(0, deadline - performance.now())));
    owner = readLockOwner(paths);
  }
  // The lock is free once the old process exits, which can precede launchd removing the job (or a bootout that timed
  // out); bootstrap fails with an input/output error while the label is still loaded.
  while (await serviceLoaded({ ...options, label, uid })) {
    if (performance.now() >= deadline) {
      throw new Error(`launchd still has ${target} loaded after ${waitMs} ms; install aborted`);
    }
    await delay(Math.min(pollMs, Math.max(0, deadline - performance.now())));
  }
  requireSuccess('enable', await launchctl(['enable', target], options));
  requireSuccess(
    'bootstrap',
    await launchctl(['bootstrap', `gui/${uid}`, path], options),
    '; this needs the logged-in desktop session: LimitLoadToSessionType Aqua fails over SSH',
  );
  return { plistPath: path, target, warnings };
}

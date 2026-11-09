// Setup and uninstall use the runner's pinned CLIs and homes, never a project's settings (design 7.1, 7.6).
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Vendor } from '@agflow/core';
import { CONNECTIVITY_VARS, type RunnerConfig, vendorHomes } from '../config';
import { userVariables } from '../env';
import type { RunnerPaths } from '../paths';
import { defaultExec, type Exec, type ExecResult } from '../service/system';
import { VENDOR_PINS, vendorBinary, vendorPlatform } from './pins';

/** A subscription login with its plan (Claude's subscriptionType; Codex reports none), or why there is none. */
export type VendorLoginStatus = { ok: true; plan: string | null } | { ok: false; reason: string };

type Env = Record<string, string | undefined>;

export interface VendorLoginOptions {
  exec?: Exec;
  /** Override the current platform's pin for scripted CLIs, including on Linux CI. */
  version?: string;
  /** The pins' platform key; vendorPlatform() when omitted. */
  platform?: string;
  /** The caller's environment, read only for the user and system variables and the owner's HOME. */
  base?: Env;
}

/**
 * The vendor CLI's environment, built from an allowlist like the agents' (7.6), so a caller's API key or vendor
 * variable never replaces the subscription login. TERM stays: the logins are interactive.
 */
export function vendorCliEnv(
  vendor: Vendor,
  config: RunnerConfig,
  paths: RunnerPaths,
  base: Env = process.env,
): Record<string, string> {
  // The agents' user variables (USER, LOGNAME, LANG, SHELL and LC_*), then TERM.
  const env = userVariables(base);
  if (base.TERM !== undefined) env.TERM = base.TERM;
  env.PATH = config.capturedPath;
  for (const name of CONNECTIVITY_VARS) {
    const value = config.connectivity[name];
    if (value !== undefined) env[name] = value;
  }
  env.NODE_USE_SYSTEM_CA = '1';
  env.DISABLE_AUTOUPDATER = '1';
  const homes = vendorHomes(config, paths);
  if (vendor === 'claude') {
    // Claude's login keychain item depends on this exact config-directory string.
    env.HOME = base.HOME ?? homedir();
    env.CLAUDE_CONFIG_DIR = homes.claude;
  } else {
    env.HOME = paths.homes.codexUser;
    env.CODEX_HOME = homes.codex;
  }
  return env;
}

async function run(
  vendor: Vendor,
  args: string[],
  config: RunnerConfig,
  paths: RunnerPaths,
  options: VendorLoginOptions,
  interactive = false,
): Promise<ExecResult> {
  const platform = options.platform ?? vendorPlatform();
  const version = options.version ?? VENDOR_PINS[platform]?.[vendor].version;
  if (!version) throw new Error(`unsupported platform ${platform}`);
  const binary = join(paths.runner, vendorBinary(vendor, version));
  if (!existsSync(binary)) {
    throw new Error(`the runner's ${vendor} binary is missing (binary missing: ${binary}); run agflow runner setup`);
  }
  const env = vendorCliEnv(vendor, config, paths, options.base);
  const cwd = await mkdtemp(join(tmpdir(), 'agf-login-'));
  try {
    return await (options.exec ?? defaultExec)([binary, ...args], { cwd, env, interactive });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function failure(reason: string): VendorLoginStatus {
  return { ok: false, reason };
}

function commandFailure(vendor: Vendor, command: string, result: ExecResult): string {
  return `${vendor} ${command} ${result.timedOut ? 'timed out' : `failed with exit code ${result.exitCode}`}`;
}

/** `auth status --json` must show a claude.ai login with a subscription; setup skips the login when it does. */
export async function claudeLoginStatus(
  config: RunnerConfig,
  paths: RunnerPaths,
  options: VendorLoginOptions = {},
): Promise<VendorLoginStatus> {
  try {
    const result = await run('claude', ['auth', 'status', '--json'], config, paths, options);
    if (result.timedOut) return failure(commandFailure('claude', 'auth status', result));
    let status: unknown;
    try {
      status = JSON.parse(result.stdout);
    } catch {
      const firstLine = (result.stdout.trim() || result.stderr.trim()).split(/\r?\n/)[0];
      return failure(`invalid Claude auth status: ${firstLine || '(empty output)'}`);
    }
    if (!status || typeof status !== 'object' || Array.isArray(status)) {
      return failure(`invalid Claude auth status: ${result.stdout.trim().split(/\r?\n/)[0]}`);
    }
    const auth = status as Record<string, unknown>;
    // Logged-out Claude exits 1 but still prints structured status.
    if (auth.loggedIn !== true) return failure('not logged in to Claude');
    if (result.exitCode !== 0) return failure(commandFailure('claude', 'auth status', result));
    if (auth.authMethod !== 'claude.ai') {
      return failure('a Console (API) login; agflow needs a Claude subscription login');
    }
    if (typeof auth.subscriptionType !== 'string' || !auth.subscriptionType.trim()) {
      return failure('no subscriptionType; agflow needs a Claude subscription login');
    }
    return { ok: true, plan: auth.subscriptionType };
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}

/** `login status` must exit 0 and name ChatGPT; an API key login is refused. */
export async function codexLoginStatus(
  config: RunnerConfig,
  paths: RunnerPaths,
  options: VendorLoginOptions = {},
): Promise<VendorLoginStatus> {
  try {
    const result = await run('codex', ['login', 'status'], config, paths, options);
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.timedOut) return failure(commandFailure('codex', 'login status', result));
    // Never include the raw output: API-key status contains the key itself.
    if (/API[ -]key/i.test(output)) return failure('an API key login; agflow needs a ChatGPT login');
    if (/not logged in/i.test(output)) return failure('not logged in to Codex');
    if (result.exitCode !== 0) return failure(commandFailure('codex', 'login status', result));
    if (!/\bChatGPT\b/i.test(output)) return failure('agflow needs a ChatGPT login');
    return { ok: true, plan: null };
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}

async function login(
  vendor: Vendor,
  config: RunnerConfig,
  paths: RunnerPaths,
  options: VendorLoginOptions,
): Promise<void> {
  const args = vendor === 'claude' ? ['auth', 'login', '--claudeai'] : ['login'];
  const result = await run(vendor, args, config, paths, options, true);
  if (result.exitCode !== 0 || result.timedOut) throw new Error(commandFailure(vendor, 'login', result));
  const status = await (vendor === 'claude' ? claudeLoginStatus : codexLoginStatus)(config, paths, options);
  if (!status.ok) throw new Error(status.reason);
}

/** Setup step 4: the owner signs in on the terminal, then the status must show a subscription. */
export function loginClaude(config: RunnerConfig, paths: RunnerPaths, options: VendorLoginOptions = {}): Promise<void> {
  return login('claude', config, paths, options);
}

/** Setup step 5: the owner signs in on the terminal, then the status must name ChatGPT. */
export function loginCodex(config: RunnerConfig, paths: RunnerPaths, options: VendorLoginOptions = {}): Promise<void> {
  return login('codex', config, paths, options);
}

async function logout(
  vendor: Vendor,
  config: RunnerConfig,
  paths: RunnerPaths,
  options: VendorLoginOptions,
): Promise<void> {
  try {
    await run(vendor, vendor === 'claude' ? ['auth', 'logout'] : ['logout'], config, paths, options);
  } catch {
    // Uninstall continues even when a pin is missing or a vendor cannot log out.
  }
}

/** Uninstall's logouts are best effort: they never throw. */
export function logoutClaude(
  config: RunnerConfig,
  paths: RunnerPaths,
  options: VendorLoginOptions = {},
): Promise<void> {
  return logout('claude', config, paths, options);
}

export function logoutCodex(config: RunnerConfig, paths: RunnerPaths, options: VendorLoginOptions = {}): Promise<void> {
  return logout('codex', config, paths, options);
}

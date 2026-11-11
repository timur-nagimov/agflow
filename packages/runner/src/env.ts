// The agent environment (design 7.6): built only from an allowlist, never by removing variables from the runner's
// own environment, so a secret the runner happens to hold (an API key, an SSH agent, a cloud credential) never
// reaches an agent. Test mode's claudeEnv comes after the allowlist (15.1).
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AttemptSpec, Vendor } from '@agflow/core';
import { CONNECTIVITY_VARS, isTestMode, type RunnerConfig, vendorHomes } from './config';
import { agentGitEnv } from './git/run';
import type { RunnerPaths } from './paths';
import { runDirOf } from './run-dir';

type Env = Record<string, string | undefined>;

export interface AgentEnvInput {
  vendor: Vendor;
  spec: Pick<AttemptSpec, 'attemptId' | 'role' | 'agentToken' | 'hubUrl'>;
  clone: string;
  /** The attempt's runner-owned tools directory, paths.agentTools(project, attemptId). */
  tools: string;
  /** Claude's CLAUDE_CODE_TMPDIR, /tmp/agf/<id> (makeAttemptTmpDir); null for Codex. */
  tmpDir: string | null;
  config: RunnerConfig;
  paths: RunnerPaths;
  /** The runner's own environment, read only for the user and system variables and the owner's HOME. */
  base?: Env;
  /** Where AGFLOW_TEST is read; process.env by default. */
  env?: Env;
}

/** Carried from the runner's environment as they are. */
function userVariable(name: string): boolean {
  return ['USER', 'LOGNAME', 'LANG', 'SHELL'].includes(name) || name.startsWith('LC_');
}

/** What an agent environment carries from base as it is: USER, LOGNAME, LANG, SHELL and the LC_ variables. */
export function userVariables(base: Env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && userVariable(name)) env[name] = value;
  }
  return env;
}

/** The package managers' caches, per attempt inside the clone. */
const CACHES = {
  BUN_INSTALL_CACHE_DIR: 'bun',
  npm_config_cache: 'npm',
  PIP_CACHE_DIR: 'pip',
  UV_CACHE_DIR: 'uv',
  GOMODCACHE: 'go-mod',
  CARGO_HOME: 'cargo',
} as const;

const BRIDGE_PREFIX = 'AGFLOW_';
const CONNECTIVITY = new Set<string>(CONNECTIVITY_VARS);

export function buildAgentEnv(input: AgentEnvInput): Record<string, string> {
  const base = input.base ?? process.env;
  const runDir = runDirOf(input.clone, input.tools);
  const homes = vendorHomes(input.config, input.paths);
  const env = userVariables(base);
  env.TERM = 'dumb';
  env.NODE_USE_SYSTEM_CA = '1';
  for (const [name, value] of Object.entries(input.config.connectivity)) {
    if (value !== undefined) env[name] = value;
  }
  if (input.vendor === 'claude') {
    if (input.tmpDir === null) throw new Error('a Claude attempt needs its private CLAUDE_CODE_TMPDIR');
    // The CLI process needs the owner's HOME for its login; its tools are confined by the sandbox and the guard.
    env.HOME = base.HOME ?? homedir();
    env.CLAUDE_CONFIG_DIR = homes.claude;
    env.CLAUDE_CODE_TMPDIR = input.tmpDir;
    env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1';
  } else {
    // An empty HOME, so the owner's ~/.agents/skills do not load into the app-server.
    env.HOME = input.paths.homes.codexUser;
    env.CODEX_HOME = homes.codex;
  }
  env.DISABLE_AUTOUPDATER = '1';
  for (const [name, dir] of Object.entries(CACHES)) env[name] = join(runDir.cache, dir);
  env.PATH = `${runDir.bin}:${input.config.capturedPath}`;
  Object.assign(env, agentGitEnv(runDir));
  Object.assign(env, {
    AGFLOW_AGENT_TOKEN: input.spec.agentToken,
    AGFLOW_HUB_URL: input.spec.hubUrl,
    AGFLOW_ATTEMPT_ID: input.spec.attemptId,
    AGFLOW_ROLE: input.spec.role,
    AGFLOW_CLONE: input.clone,
    AGFLOW_BRIDGE_POLL_MS: String(input.config.timings.bridgePoll),
    AGFLOW_BRIDGE_POLL_MAX_MS: String(input.config.timings.bridgePollMax),
    // Empty and per attempt, so the bridge never reads the owner's CLI credentials (X-32).
    AGFLOW_CONFIG_DIR: runDir.config,
  });
  if (input.vendor === 'claude' && isTestMode(input.config, input.env ?? process.env)) {
    Object.assign(env, input.config.test?.claudeEnv);
  }
  return env;
}

/**
 * The bridge's own environment (AgentLaunch.bridge.env, X-32): the AGFLOW_* variables, NODE_USE_SYSTEM_CA and the
 * connectivity variables of an agent environment. Codex forwards exactly these names to the bridge.
 */
export function bridgeEnvOf(agentEnv: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(agentEnv).filter(
      ([name]) => name.startsWith(BRIDGE_PREFIX) || name === 'NODE_USE_SYSTEM_CA' || CONNECTIVITY.has(name),
    ),
  );
}

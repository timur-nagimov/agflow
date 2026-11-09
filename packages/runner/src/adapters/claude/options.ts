// The SDK options of one Claude session (design 8.2, 7.6, 8.4, X-5, X-13, X-29, X-32). Pure, so a test pins every
// security-relevant option: the tools, the permission mode, the sandbox, the deny rules, the only MCP server, the
// brief hook, the guard and the CLI's shell.
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Vendor } from '@agflow/core';
import type {
  HookCallback,
  Options,
  PermissionMode,
  SpawnedProcess,
  SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk';
import type { RunnerPaths } from '../../paths';
import type { PermissionProfile } from '../../profile';
import { vendorBinary } from '../../vendor/pins';
import type { AgentLaunch, AgflowCommand } from '../types';
import { createGuardHook } from './guard';
import { claudePermissionRules, claudeSandboxSettings } from './rules';

/**
 * The built-in tools an agent gets. Naming them removes the rest: SendMessage, ListAgents, the cron and wake-up
 * tools, RemoteTrigger, Workflow, EnterWorktree and ToolSearch.
 */
export const CLAUDE_BUILTIN_TOOLS: readonly string[] = Object.freeze([
  'Bash',
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'Task',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskUpdate',
]);

/** Offered, and allowed, only with profile.webTools: they run in-process, outside the sandbox's network allowlist. */
const WEB_TOOLS = ['WebFetch', 'WebSearch'];

/** Measured on 2.1.285 with permissionPrompts 'none'; this note adds no permission or sandbox exception. */
export const CLAUDE_BASH_NOTE =
  'Runner Bash: this session has no approval surface. Claude Code may deny loops with $var, ' +
  'quoted command substitutions such as "$(git rev-parse --show-toplevel)", and brace groups with quotes ' +
  'before running them. Use simple commands; for ordinary local work that needs these shell constructs, ' +
  'write a script file in the clone and run it with sh script.sh inside the sandbox. ' +
  'The script fallback does not permit evading a guard, path, or network restriction. ' +
  'Only the runner pushes; use the agflow tools for submission.';

export interface ClaudeOptionDeps {
  /** How the runner runs agflow, from the adapter factory's input; the brief hook runs it (X-5). */
  agflow: AgflowCommand;
  /** The runner's layout; the pinned binaries lie under paths.runner. */
  paths: Pick<RunnerPaths, 'runner' | 'vaults' | 'work'>;
  /** vendorHomes(config, paths); the Claude home is the CLAUDE_CONFIG_DIR every launch must carry. */
  vendorHomes: Record<Vendor, string>;
  /** Whether the account offered auto mode in the adapter's last preflight. */
  autoOffered: boolean;
  /** The detached spawn hook: each claude in its own process group (design 7.4). */
  spawnClaudeCodeProcess: (options: SpawnOptions) => SpawnedProcess;
  /** The session's compaction callbacks: PreCompact warns, PostCompact captures the summary. */
  compaction: { preCompact: HookCallback; postCompact: HookCallback };
  /** A new session's id; randomUUID by default. */
  newSessionId?: () => string;
}

/**
 * An empty directory the runner owns, in its Claude home, which agents cannot write (7.6).
 *
 * The bridge and the brief hook start in it. Both run outside the sandbox with the agent token, and Bun loads the
 * bunfig.toml (with its preload) and the .env of its working directory; the CLI would start both in the base checkout,
 * so a bunfig.toml or .env committed to main would run in them.
 *
 * zsh takes it as ZDOTDIR, so none of the CLI's shells outside the sandbox (its `<shell> -c env`, the snapshot's login
 * shell and the wrapper of every Bash command) nor the agent's own reads the owner's ~/.zshenv, ~/.zprofile or
 * ~/.zlogin: only the snapshot sources ~/.zshrc, by its path, once per process (design 5, 8.2).
 */
export function claudeEmptyDir(claudeHome: string): string {
  return join(claudeHome, 'agflow-empty');
}

/** Makes the empty directory (mode 0700) before a launch; anything but a directory there, a link included, fails. */
export function ensureClaudeEmptyDir(claudeHome: string): string {
  const dir = claudeEmptyDir(claudeHome);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!lstatSync(dir).isDirectory()) throw new Error(`${dir} is not a directory`);
  return dir;
}

/**
 * The shell the CLI runs its shells with when the owner's SHELL is not a zsh (CLAUDE_CODE_SHELL): only zsh can be kept
 * from the owner's startup files by ZDOTDIR, and bash reads ~/.bashrc in each of the CLI's shells (its standard input
 * is a socket).
 */
export const CLAUDE_SHELL = '/bin/zsh';

/** The CLI's environment: the launch's, with the empty directory as ZDOTDIR and zsh as the CLI's shell. */
function claudeEnv(env: Record<string, string>, emptyDir: string): Record<string, string> {
  const { CLAUDE_CODE_SHELL: _owner, ...rest } = env;
  const zsh = env.SHELL !== undefined && basename(env.SHELL) === 'zsh';
  return { ...rest, ZDOTDIR: emptyDir, ...(zsh ? {} : { CLAUDE_CODE_SHELL: CLAUDE_SHELL }) };
}

/** A command that changes to the directory, then runs as itself: /bin/sh reads no startup file and execs it. */
export function inDirectory(dir: string, command: string, args: string[]): { command: string; args: string[] } {
  return { command: '/bin/sh', args: ['-c', 'cd -- "$1" && shift && exec "$@"', 'agflow', dir, command, ...args] };
}

/** acceptEdits, or auto for the auto profile on an account that offers it (7.6, X-29). */
export function effectivePermissionMode(profile: PermissionProfile, autoOffered: boolean): PermissionMode {
  return profile.name === 'auto' && autoOffered ? 'auto' : 'acceptEdits';
}

// A full id names a model family and a version; the CLI resolves aliases (opus, sonnet, default, opusplan, ...)
// to whatever its release maps them to, which the hub could neither record nor reproduce.
const FULL_MODEL_ID = /^claude-[a-z]+(?:-[a-z0-9]+)*-[0-9][a-z0-9-]*$/;

export function assertFullModelId(model: string): void {
  if (!FULL_MODEL_ID.test(model)) {
    throw new Error(`the model ${JSON.stringify(model)} is not a full model id such as claude-sonnet-5-5`);
  }
}

/**
 * The SessionStart command hook: `cd <dir> && exec <agflow> hook brief --runner`, quoted for the /bin/sh the CLI runs
 * it with.
 */
export function briefHookCommand(agflow: AgflowCommand, dir: string): string {
  const command = [agflow.command, ...agflow.args].map(shellQuote).concat('hook', 'brief', '--runner').join(' ');
  return `cd ${shellQuote(dir)} && exec ${command}`;
}

function shellQuote(word: string): string {
  return /^[A-Za-z0-9_/.:=@%+-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * query()'s options for a launch. It refuses a model alias, a launch without a base checkout, and an environment
 * whose CLAUDE_CONFIG_DIR or CLAUDE_CODE_TMPDIR differs from what the rules, the sandbox and the guard confine.
 */
export function buildQueryOptions(launch: AgentLaunch, deps: ClaudeOptionDeps): Options {
  assertFullModelId(launch.model);
  if (launch.baseCheckout === null) {
    throw new Error('a Claude launch needs a base checkout as its project config root');
  }
  const claudeHome = deps.vendorHomes.claude;
  const { CLAUDE_CONFIG_DIR, CLAUDE_CODE_TMPDIR } = launch.env;
  if (CLAUDE_CONFIG_DIR !== claudeHome) {
    throw new Error(`the launch's CLAUDE_CONFIG_DIR is ${CLAUDE_CONFIG_DIR}, not the Claude home ${claudeHome}`);
  }
  if (CLAUDE_CODE_TMPDIR !== launch.tmpDir) {
    throw new Error(`the launch's CLAUDE_CODE_TMPDIR is ${CLAUDE_CODE_TMPDIR}, not its tmpDir ${launch.tmpDir}`);
  }
  // The agent's HOME is where the rules point and where the CLI expands ~; the runner's own never counts.
  const home = launch.env.HOME;
  if (!home) throw new Error("a Claude launch's environment needs HOME");
  const scope = {
    home,
    paths: deps.paths,
    vendorHomes: deps.vendorHomes,
    profile: launch.profile,
    clone: launch.clone,
    tmpDir: launch.tmpDir,
  };
  const rules = claudePermissionRules(scope);
  const emptyDir = claudeEmptyDir(claudeHome);
  const session = launch.resume
    ? { resume: launch.resume.sessionRef }
    : { sessionId: (deps.newSessionId ?? randomUUID)() };
  return {
    pathToClaudeCodeExecutable: join(deps.paths.runner, vendorBinary('claude', launch.cliVersion)),
    spawnClaudeCodeProcess: deps.spawnClaudeCodeProcess,
    cwd: launch.clone,
    // Whole: the SDK gives the child exactly this environment.
    env: claudeEnv(launch.env, emptyDir),
    ...session,
    model: launch.model,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: CLAUDE_BASH_NOTE },
    settingSources: ['project'],
    projectConfigRoot: launch.baseCheckout,
    strictMcpConfig: true,
    mcpServers: {
      agflow: {
        type: 'stdio',
        ...inDirectory(emptyDir, launch.bridge.command, launch.bridge.args),
        env: launch.bridge.env,
      },
    },
    tools: [...CLAUDE_BUILTIN_TOOLS, ...(launch.profile.webTools ? WEB_TOOLS : [])],
    permissionMode: effectivePermissionMode(launch.profile, deps.autoOffered),
    // No canUseTool: a call the rules do not allow is denied at once instead of waiting for an answer.
    permissionPrompts: 'none',
    // Top-level only, so the SDK passes failIfUnavailable and Bash never runs unsandboxed.
    sandbox: claudeSandboxSettings(scope),
    settings: {
      permissions: { allow: rules.allow, deny: rules.deny },
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: briefHookCommand(deps.agflow, emptyDir) }] }] },
      autoMemoryEnabled: false,
      crossSessionInbound: 'refuse',
      cleanupPeriodDays: 30,
      syncClaudeAiSkills: false,
      syncClaudeAiPlugins: false,
    },
    hooks: {
      PreToolUse: [
        createGuardHook({
          clone: launch.clone,
          tmpDir: launch.tmpDir,
          workRoot: deps.paths.work,
          claudeHome,
          home,
        }),
      ],
      PreCompact: [{ hooks: [deps.compaction.preCompact] }],
      PostCompact: [{ hooks: [deps.compaction.postCompact] }],
    },
  };
}

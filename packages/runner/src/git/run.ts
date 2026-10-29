// The runner's git (design 7.3): three environments and one async runner for the two the runner itself uses.
//
// - local: everything that touches the vault, a quarantine or a clone's files. It reads no configuration of the
//   owner's (no system file, the runner's own global file, no default ignore or attributes file) and pins every
//   program-valued key, so nothing an agent planted in a clone can run.
// - remote: fetch, push and ls-remote between the vault and origin. It keeps the owner's environment and git
//   configuration (credential helper, SSH config), runs no hooks and never prompts, and is killed after 2 minutes.
// - agent: the variables an agent's own git gets, with no credentials at all.
//
// Git runs through Bun.spawn with argument arrays, never a shell and never spawnSync, so heartbeats keep flowing
// during long git work. GIT_* variables inherited by the runner (a hook's GIT_DIR, say) never reach its git.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CONNECTIVITY_VARS } from '../config';
import type { RunnerPaths } from '../paths';
import { boundedWait } from '../processes';

type Env = Record<string, string | undefined>;

export interface GitEnvironment {
  name: 'local' | 'remote';
  /** The whole environment of the git process; nothing else is inherited. */
  env: Record<string, string>;
  /** Placed before the subcommand: -c pins and --no-optional-locks. */
  args: string[];
  /** Kill git after this long; null for no limit. */
  timeoutMs: number | null;
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly code: number,
    readonly stderr: string,
    readonly timedOut: boolean,
    timeoutMs: number | null,
  ) {
    const command = `git ${args.join(' ')}`;
    super(
      timedOut
        ? `${command} timed out after ${timeoutMs} ms`
        : `${command} failed (exit ${code}): ${stderr.trim() || '(no output)'}`,
    );
    this.name = 'GitError';
  }
}

/** The second layer of the local environment: every program-valued key, pinned on the command line. */
export const LOCAL_GIT_PINS = [
  'core.hooksPath=/dev/null',
  'core.fsmonitor=false',
  'core.pager=cat',
  'core.editor=false',
  'core.sshCommand=false',
  'core.askPass=',
  'credential.helper=',
  'diff.external=',
  'sequence.editor=false',
  'gpg.program=false',
  'protocol.allow=never',
  'protocol.file.allow=always',
  'gc.auto=0',
] as const;

/** Runner commands that take paths add this, so a clone's runner-owned .agflow/run/ never takes part. */
export const RUN_DIR_EXCLUDE = ':(exclude,top).agflow/run';

/** What git/excludes lists: the runner's own directory and the Claude CLI's staging directory (X-28). */
const RUNNER_EXCLUDES = '.agflow/run/\n.claude/.cc-writes/\n';

/** Writes the runner's git/excludes and an empty git/local.gitconfig, in a private git/ directory. */
export function ensureRunnerGitFiles(paths: Pick<RunnerPaths, 'gitConfig' | 'gitExcludes'>): void {
  const dir = dirname(paths.gitConfig);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  if (!existsSync(paths.gitExcludes) || readFileSync(paths.gitExcludes, 'utf8') !== RUNNER_EXCLUDES) {
    writeFileSync(paths.gitExcludes, RUNNER_EXCLUDES, { mode: 0o600 });
  }
  if (!existsSync(paths.gitConfig)) {
    writeFileSync(paths.gitConfig, '# The global config of the agflow runner\'s local git; the runner owns it.\n', {
      mode: 0o600,
    });
  }
}

/** Variables the local environment keeps: who and where the user is, and nothing that configures git. */
function localAllowed(name: string): boolean {
  return ['PATH', 'USER', 'LOGNAME', 'LANG', 'TMPDIR', 'TZ'].includes(name) || name.startsWith('LC_');
}

/**
 * The local environment. HOME and XDG_CONFIG_HOME point at the runner's git directory, so git's default
 * ~/.config/git/ignore and attributes, which it reads even with GIT_CONFIG_GLOBAL set, are never the owner's.
 */
export function localGitEnv(
  paths: Pick<RunnerPaths, 'gitConfig' | 'gitExcludes'>,
  base: Env = process.env,
): GitEnvironment {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && localAllowed(name)) env[name] = value;
  }
  const gitDir = dirname(paths.gitConfig);
  Object.assign(env, {
    HOME: gitDir,
    XDG_CONFIG_HOME: gitDir,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: paths.gitConfig,
    GIT_TERMINAL_PROMPT: '0',
  });
  const pins = [`core.excludesFile=${paths.gitExcludes}`, ...LOCAL_GIT_PINS].flatMap((pin) => ['-c', pin]);
  return { name: 'local', env, args: ['--no-optional-locks', ...pins], timeoutMs: null };
}

/** The remote environment's limit: 2 minutes. */
export const REMOTE_GIT_TIMEOUT_MS = 120_000;

const CONNECTIVITY = new Set<string>(CONNECTIVITY_VARS);

/**
 * The remote environment: the owner's environment without inherited GIT_* variables (GIT_SSL_CAINFO, a captured
 * connectivity variable, stays), with the hook pins, no prompts, and SSH in batch mode unless the owner's own git
 * configuration sets core.sshCommand, which GIT_SSH_COMMAND would override. gitDir is the repository the commands
 * will run in (the vault): the probe runs there, so the owner's includes conditional on it (includeIf
 * "hasconfig:remote.*.url:...", the usual way to pick an SSH key per organisation) apply.
 */
export async function remoteGitEnv(
  options: { base?: Env; timeoutMs?: number; gitDir?: string } = {},
): Promise<GitEnvironment> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.base ?? process.env)) {
    if (value !== undefined && (!name.startsWith('GIT_') || CONNECTIVITY.has(name))) env[name] = value;
  }
  env.GIT_TERMINAL_PROMPT = '0';
  const environment: GitEnvironment = {
    name: 'remote',
    env,
    args: ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'],
    timeoutMs: options.timeoutMs ?? REMOTE_GIT_TIMEOUT_MS,
  };
  const repository = options.gitDir === undefined ? [] : [`--git-dir=${options.gitDir}`];
  const configured = await runGit(environment, [...repository, 'config', '--get', 'core.sshCommand'], {
    check: false,
  });
  if (configured.code !== 0 || configured.stdout.trim() === '') env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
  return environment;
}

/** The paths agentGitEnv names: runner-owned files outside the clone, which agents cannot write (writeRunDir). */
export interface AgentGitPaths {
  /** The agent's GIT_CONFIG_GLOBAL: identity, no credential helper, local protocols only. */
  gitconfig: string;
  /** A script that refuses every SSH connection with an explanation. */
  sshRefusal: string;
  /** Empty directories, so gh and glab find no login. */
  ghConfigDir: string;
  glabConfigDir: string;
}

/** git runs GIT_SSH_COMMAND through the shell, so a path with spaces (a home folder, say) is quoted. */
function shellWord(path: string): string {
  return /^[A-Za-z0-9_\/.:=@%+-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}

/** A value that is set but is no token, so gh and glab never look further for one. */
const DUMMY_TOKEN = 'agflow-no-token';

/** The agent's git variables: no system config, its own global config, no prompts, no credentials, no SSH. */
export function agentGitEnv(paths: AgentGitPaths): Record<string, string> {
  return {
    GIT_CONFIG_GLOBAL: paths.gitconfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/usr/bin/false',
    GIT_SSH_COMMAND: shellWord(paths.sshRefusal),
    GIT_SSH_VARIANT: 'ssh',
    GH_CONFIG_DIR: paths.ghConfigDir,
    GLAB_CONFIG_DIR: paths.glabConfigDir,
    GH_TOKEN: DUMMY_TOKEN,
    GITLAB_TOKEN: DUMMY_TOKEN,
  };
}

export interface RunGitOptions {
  /** '/' by default, which is in no repository: commands name their repository with --git-dir. */
  cwd?: string;
  /** Added to the environment's variables, GIT_INDEX_FILE for a temporary index, say. */
  env?: Record<string, string>;
  input?: string | Uint8Array;
  /** Overrides the environment's limit. */
  timeoutMs?: number | null;
  /** Throw a GitError when git fails or times out; true by default. */
  check?: boolean;
}

/** After a kill, a child git started (ssh, a remote helper) may hold the pipes; its output is not worth waiting for. */
const OUTPUT_AFTER_KILL_MS = 1_000;

/**
 * Runs git in its own process group, so a timeout kills git and every helper it started. The output is raw: -z
 * output keeps its NUL separators and trailing newlines are the caller's to trim.
 */
export async function runGit(
  environment: GitEnvironment,
  args: string[],
  options: RunGitOptions = {},
): Promise<GitResult> {
  const timeoutMs = options.timeoutMs === undefined ? environment.timeoutMs : options.timeoutMs;
  const proc = Bun.spawn(['git', ...environment.args, ...args], {
    cwd: options.cwd ?? '/',
    env: { ...environment.env, ...options.env },
    stdin: options.input === undefined ? 'ignore' : Buffer.from(options.input),
    stdout: 'pipe',
    stderr: 'pipe',
    detached: true,
  });
  let timedOut = false;
  const timer =
    timeoutMs === null
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          try {
            process.kill(-proc.pid, 'SIGKILL');
          } catch {
            proc.kill('SIGKILL');
          }
        }, timeoutMs);
  const output = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  clearTimeout(timer);
  let stdout = '';
  let stderr = '';
  if (timedOut) {
    const read = await boundedWait(output, OUTPUT_AFTER_KILL_MS);
    if (read.done) [stdout, stderr] = read.value;
  } else {
    [stdout, stderr] = await output;
  }
  const result: GitResult = { code, stdout, stderr, timedOut };
  if (options.check !== false && (code !== 0 || timedOut)) {
    throw new GitError(args, code, stderr, timedOut, timeoutMs);
  }
  return result;
}

/** Whether git succeeds: `cat-file -e`, `rev-parse --verify --quiet` and the like. */
export async function gitOk(
  environment: GitEnvironment,
  args: string[],
  options: Omit<RunGitOptions, 'check'> = {},
): Promise<boolean> {
  const result = await runGit(environment, args, { ...options, check: false });
  return result.code === 0 && !result.timedOut;
}

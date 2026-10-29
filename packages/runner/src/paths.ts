// The runner's layout (design 7.2): its own state under AGFLOW_HOME/runner, the vaults and the attempt clones, plus
// the short private directories under /tmp that Claude attempts use as CLAUDE_CODE_TMPDIR.
import { createHash, getRandomValues } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface RunnerPaths {
  /** AGFLOW_HOME, ~/.agflow by default. */
  home: string;
  /** Runner state; agents read only their own Claude project directory in it (design 7.6). */
  runner: string;
  config: string;
  db: string;
  lock: string;
  socket: string;
  logs: string;
  runnerLog: string;
  attemptLog(attemptId: string): string;
  homes: {
    /** CLAUDE_CONFIG_DIR for agents. */
    claude: string;
    /** CODEX_HOME for agents. */
    codex: string;
    /** The empty HOME of the codex app-server process. */
    codexUser: string;
  };
  /** Pinned vendor binaries; vendorBinary gives paths relative to `runner`. */
  vendor: string;
  /** GIT_CONFIG_GLOBAL of the runner's own git. */
  gitConfig: string;
  gitExcludes: string;
  /** Dependency caches and tmp of one project. */
  prep(project: string): string;
  /** An agent's .git, moved aside at take-over. */
  forensics(attemptId: string): string;
  vaults: string;
  vault(project: string): string;
  quarantine(project: string, attemptId: string): string;
  /** A base checkout of main, Claude's project config root. */
  baseCheckout(project: string, sha: string): string;
  work: string;
  /** The attempt clone, the agent's cwd. */
  clone(project: string, attemptId: string): string;
}

/** AGFLOW_HOME, or ~/.agflow, always absolute: agents get paths under it from a different working directory. */
export function agflowHome(env: Record<string, string | undefined> = process.env): string {
  return resolve(env.AGFLOW_HOME || join(homedir(), '.agflow'));
}

// Project keys and attempt ids become directory names; anything else that reaches here is a bug, not a path.
const SAFE_NAME = /^(?!\.\.?$)[A-Za-z0-9._-]+$/;

function segment(name: string): string {
  if (!SAFE_NAME.test(name)) throw new Error(`not a safe path name: ${JSON.stringify(name)}`);
  return name;
}

export function runnerPaths(home: string = agflowHome()): RunnerPaths {
  const runner = join(home, 'runner');
  const logs = join(runner, 'logs');
  const vaults = join(home, 'vaults');
  const work = join(home, 'work');
  return {
    home,
    runner,
    config: join(runner, 'runner.json'),
    db: join(runner, 'runner.db'),
    lock: join(runner, 'runner.lock'),
    socket: join(runner, 'runner.sock'),
    logs,
    runnerLog: join(logs, 'runner.log'),
    attemptLog: (attemptId) => join(logs, 'attempts', `${segment(attemptId)}.log`),
    homes: {
      claude: join(runner, 'homes', 'claude'),
      codex: join(runner, 'homes', 'codex'),
      codexUser: join(runner, 'homes', 'codex-user'),
    },
    vendor: join(runner, 'vendor'),
    gitConfig: join(runner, 'git', 'local.gitconfig'),
    gitExcludes: join(runner, 'git', 'excludes'),
    prep: (project) => join(runner, 'prep', segment(project)),
    forensics: (attemptId) => join(runner, 'forensics', segment(attemptId)),
    vaults,
    vault: (project) => join(vaults, `${segment(project)}.git`),
    quarantine: (project, attemptId) => join(vaults, `${segment(project)}.quarantine`, segment(attemptId)),
    baseCheckout: (project, sha) => {
      if (!/^[0-9a-f]{12,40}$/.test(sha)) throw new Error(`expected a commit sha, not ${JSON.stringify(sha)}`);
      return join(vaults, `${segment(project)}.base`, sha.slice(0, 12));
    },
    work,
    clone: (project, attemptId) => join(work, segment(project), segment(attemptId)),
  };
}

/**
 * A filesystem-safe id for one project of one hub: a readable slug of the name and a hash of the hub URL and the
 * name, so two hubs with a project of the same name never share a vault. It stays short, because clone paths end up
 * in Claude's project directory names.
 */
export function projectKey(hubUrl: string, projectName: string): string {
  const slug =
    projectName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24)
      .replace(/-+$/, '') || 'project';
  const hash = createHash('sha256')
    .update(`${hubUrl.replace(/\/+$/, '')}\n${projectName}`)
    .digest('hex')
    .slice(0, 10);
  return `${slug}-${hash}`;
}

/** Beyond this length of <dir>/claude-<uid>, Claude Code silently falls back to the shared /tmp/claude-<uid>. */
export const MAX_CLAUDE_TMP_BYTES = 44;

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomTmpId(): string {
  return Array.from(getRandomValues(new Uint8Array(6)), (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join('');
}

export interface AttemptTmpDirOptions {
  /** /tmp by default. */
  root?: string;
  uid?: number;
  randomId?: () => string;
}

/**
 * Creates a new private <root>/agf/<6 chars> directory (mode 0700) for one Claude attempt. It refuses a root whose
 * <dir>/claude-<uid> would exceed 44 bytes, measured on both the given and the real path, since the CLI may see
 * either.
 */
export function makeAttemptTmpDir(options: AttemptTmpDirOptions = {}): string {
  const root = options.root ?? '/tmp';
  const uid = options.uid ?? process.getuid?.() ?? 0;
  const randomId = options.randomId ?? randomTmpId;
  const tail = `/agf/${'x'.repeat(6)}/claude-${uid}`;
  const longest = Math.max(Buffer.byteLength(root + tail), Buffer.byteLength(realpathSync(root) + tail));
  if (longest > MAX_CLAUDE_TMP_BYTES) {
    throw new Error(
      `the temporary root ${root} is too long: ${root}${tail} must fit in ${MAX_CLAUDE_TMP_BYTES} bytes, ` +
        `or Claude Code falls back to the shared /tmp/claude-${uid}`,
    );
  }
  const parent = join(root, 'agf');
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  // A shared /tmp lets anyone create agf first; only a real directory of our own will do.
  const stat = lstatSync(parent);
  if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error(`${parent} is not a private directory of this user`);
  }
  chmodSync(parent, 0o700);
  for (let tries = 0; tries < 100; tries += 1) {
    const dir = join(parent, randomId());
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    chmodSync(dir, 0o700);
    return dir;
  }
  throw new Error(`no free directory name under ${parent}`);
}

// Local bare origins for runner tests (design 15): nothing here reaches the network, and no git command reads the
// developer's own git configuration.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** The author and committer of every fixture commit. */
export const FIXTURE_IDENTITY = { name: 'agflow test', email: 'test@agflow.invalid' } as const;

export interface GitInOptions {
  /** Added after the clean environment, so a test can set its own GIT_ variables. */
  env?: Record<string, string>;
  input?: string;
  /** Answer '' instead of throwing when git exits non-zero. */
  allowFailure?: boolean;
}

/** Holds no git files, so git's default ignore and attributes files ($XDG_CONFIG_HOME/git/...) do not exist. */
const NO_XDG_CONFIG = '/nonexistent/agflow-testkit';

/**
 * The caller's environment without its GIT_ variables (a hook's GIT_DIR would point git at the wrong repository),
 * without the global and system config files, and without the default ~/.config/git/ignore and attributes, which git
 * reads even when GIT_CONFIG_GLOBAL is /dev/null and which would silently leave files such as .env out of commits.
 */
function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !name.startsWith('GIT_')) env[name] = value;
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    XDG_CONFIG_HOME: NO_XDG_CONFIG,
    ...extra,
  };
}

const FIXTURE_FLAGS = [
  '-c',
  `user.name=${FIXTURE_IDENTITY.name}`,
  '-c',
  `user.email=${FIXTURE_IDENTITY.email}`,
  '-c',
  'init.defaultBranch=main',
];

/** Runs git in dir and gives its trimmed output. It throws with git's own message when git fails. */
export async function gitIn(dir: string, args: string[], options: GitInOptions = {}): Promise<string> {
  const proc = Bun.spawn(['git', ...FIXTURE_FLAGS, ...args], {
    cwd: dir,
    env: cleanEnv(options.env),
    stdin: options.input === undefined ? 'ignore' : Buffer.from(options.input),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code === 0) return stdout.trim();
  if (options.allowFailure) return '';
  throw new Error(`git ${args.join(' ')} failed (exit ${code}) in ${dir}: ${stderr.trim()}`);
}

export interface OriginRepo {
  /** The temporary directory that holds the origin. */
  root: string;
  /** The bare repository, usable as a remote URL. */
  path: string;
  /** main's first commit, which holds the files. */
  mainSha: string;
  remove(): void;
}

/** A new bare origin under a temporary directory, whose main holds the files in one commit. */
export async function originRepo(files: Record<string, string>): Promise<OriginRepo> {
  const root = mkdtempSync(join(tmpdir(), 'agflow-origin-'));
  const path = join(root, 'origin.git');
  try {
    await gitIn(root, ['init', '--quiet', '--bare', '--initial-branch=main', path]);
    const mainSha = await commitFiles(path, { branch: 'main', files, message: 'initial commit' });
    return { root, path, mainSha, remove: () => rmSync(root, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export interface FileChange {
  branch: string;
  /** Content to write, or null to delete the file. Directories are created as needed. */
  files: Record<string, string | null>;
  message?: string;
  /** The commit a new branch starts from; main by default. An existing branch always builds on its tip. */
  from?: string;
}

/**
 * Commits the change on a branch of a fresh working clone of the origin and pushes it, as a person or another
 * machine would. It gives the new commit's sha.
 */
export async function commitFiles(origin: string, change: FileChange): Promise<string> {
  const work = mkdtempSync(join(tmpdir(), 'agflow-work-'));
  try {
    await gitIn(work, ['clone', '--quiet', origin, '.']);
    const has = async (ref: string) =>
      (await gitIn(work, ['rev-parse', '--verify', '--quiet', ref], { allowFailure: true })) !== '';
    if (await has(`refs/remotes/origin/${change.branch}`)) {
      await gitIn(work, ['checkout', '--quiet', '-B', change.branch, `refs/remotes/origin/${change.branch}`]);
    } else if (change.from !== undefined) {
      await gitIn(work, ['checkout', '--quiet', '-B', change.branch, change.from]);
    } else if (await has('refs/remotes/origin/main')) {
      await gitIn(work, ['checkout', '--quiet', '-B', change.branch, 'refs/remotes/origin/main']);
    } else {
      await gitIn(work, ['checkout', '--quiet', '--orphan', change.branch]);
    }
    for (const [file, content] of Object.entries(change.files)) {
      const target = join(work, file);
      if (content === null) {
        rmSync(target, { force: true });
      } else {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content);
      }
    }
    await gitIn(work, ['add', '--all']);
    await gitIn(work, ['commit', '--quiet', '--allow-empty', '-m', change.message ?? `change ${change.branch}`]);
    await gitIn(work, ['push', '--quiet', 'origin', `HEAD:refs/heads/${change.branch}`]);
    return await gitIn(work, ['rev-parse', 'HEAD']);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

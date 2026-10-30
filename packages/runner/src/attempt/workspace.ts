// A start's work before the agent runs (design 7.3, "Attempt clone", "Starting point", "Protected paths at a
// start", "Base checkouts"). The vault is fetched, the clone made at the start tip the vault actually holds (an
// existing clone is kept, at the start it was made at), the Claude CLI's staging directory removed, .agflow/run/
// written with the brief extended by the clone's path (X-17), and the protected paths restored from the restore base
// (X-16). A Claude attempt also gets a base checkout of main and a private temporary directory (X-5). Right before
// the agent starts, after any dependency preparation, finishWorkspace restores the protected paths once more and
// verifies the clone's .codex/ (design 9.2).
// The clone and the recorded temporary directory belong to the agent, which can replace either with a link: the
// runner never follows their last component, and refuses the start when anything but a directory stands there.
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { type AttemptSpec, localPinRefs, matchesProtectedPattern } from '@agflow/core';
import type { AttemptStore } from '../attempt-store';
import type { RunnerConfig } from '../config';
import { cloneExists, createLeadClone, createTaskClone } from '../git/clone';
import { detectProtected, resolveRestoreBase, restoreProtected } from '../git/protect';
import { type GitEnvironment, runGit } from '../git/run';
import type { BaseCheckout, Vault } from '../git/vault';
import { makeAttemptTmpDir, type RunnerPaths } from '../paths';
import { type RunDir, withWorkingDirectory, writeRunDir } from '../run-dir';

export interface WorkspaceDeps {
  config(): RunnerConfig;
  paths: RunnerPaths;
  store: AttemptStore;
  vault: Vault;
  local: GitEnvironment;
  wipRefPrefix(): string;
  /** Where Claude attempts' private temporary directories go: /tmp. */
  tmpRoot: string;
}

export interface PreparedWorkspace {
  /** The clone's real path, the agent's cwd. */
  clone: string;
  /** False when the clone existed and was kept. */
  created: boolean;
  /** The commit the clone was made at: attempt.spawned.startSha. */
  startSha: string;
  /** The restore base (X-16). */
  base: string;
  runDir: RunDir;
  /** spec.brief plus the working-directory line, as .agflow/run/brief.md holds it. */
  brief: string;
  /** Protected paths the start commit changed against the base: restored in the clone, stripped from pushes. */
  violations: string[];
  /** Claude's project configuration root; null for Codex. */
  baseCheckout: BaseCheckout | null;
  /** Claude's CLAUDE_CODE_TMPDIR, <tmpRoot>/agf/<id>; null for Codex. */
  tmpDir: string | null;
  /**
   * The clone's .codex/ equals the restore base's (design 9.2); set by finishWorkspace right before the launch, after
   * any dependency preparation, and false until then.
   */
  projectConfigVerified: boolean;
}

/** The longest error text a start reports: a git failure's stderr can carry a line per file. */
export const START_ERROR_MAX = 4_000;
/** The most bytes of paths one start's attempt.violation lists; the outbox takes no event over 1 MB. */
export const VIOLATION_PATHS_MAX_BYTES = 16 * 1024;

/** An error text cut to START_ERROR_MAX characters, an ellipsis marking the cut. */
export function clipStartError(text: string): string {
  return text.length <= START_ERROR_MAX ? text : `${text.slice(0, START_ERROR_MAX - 1)}…`;
}

/** The first paths within maxBytes, and one '… and N more' entry for the rest. */
export function clipViolationPaths(paths: readonly string[], maxBytes: number = VIOLATION_PATHS_MAX_BYTES): string[] {
  const kept: string[] = [];
  let bytes = 0;
  for (const path of paths) {
    bytes += Buffer.byteLength(path) + 1;
    if (bytes > maxBytes) break;
    kept.push(path);
  }
  return kept.length === paths.length ? kept : [...kept, `… and ${paths.length - kept.length} more`];
}

/**
 * Refuses a clone path where something other than a directory stands: a link the agent planted, or a file. Every
 * use of a recorded clone checks it first; a clone that does not exist passes.
 */
export async function assertCloneDirectory(path: string): Promise<void> {
  const stat = await lstat(path).catch(() => null);
  if (stat !== null && !stat.isDirectory()) {
    throw new Error(`${path} is not a directory: something other than the clone stands in its place`);
  }
}

/**
 * The clone's real path, for every use of it: the runner-owned parent is resolved (/tmp is /private/tmp), the last
 * component never is, since the agent can replace its clone with a link to anywhere. Throws when anything but a
 * directory stands at the path.
 */
export async function realClonePath(path: string): Promise<string> {
  await assertCloneDirectory(path);
  return join(await realpath(dirname(path)), basename(path));
}

/** The commit a vault ref names, or null. */
async function commitOf(vault: Vault, local: GitEnvironment, ref: string): Promise<string | null> {
  const args = [`--git-dir=${vault.path}`, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`];
  const result = await runGit(local, args, { check: false });
  const sha = result.stdout.trim();
  return result.code === 0 && sha !== '' ? sha : null;
}

/** Makes the clone, or keeps the one there; gives the commit it was made at. */
async function ensureClone(deps: WorkspaceDeps, spec: AttemptSpec, clone: string) {
  const { vault, local } = deps;
  const target = { vault, local, attemptId: spec.attemptId, clone };
  if (cloneExists(clone)) {
    const pinned = await commitOf(vault, local, localPinRefs(spec.attemptId).start);
    if (pinned !== null) return { created: false, startSha: pinned };
  }
  const { sha } = await vault.resolveStart(spec.start);
  let created: boolean;
  if (spec.role === 'lead') {
    created = (await createLeadClone({ ...target, startSha: sha })).created;
  } else {
    if (spec.branch === null) throw new Error(`the worker attempt ${spec.attemptId} has no task branch`);
    created = (await createTaskClone({ ...target, branch: spec.branch, startSha: sha })).created;
  }
  // A kept clone that lost its start pin is pinned at the start it resolves to now.
  if (!created) await vault.pin(spec.attemptId, { start: sha });
  return { created, startSha: sha };
}

/**
 * Whether a recorded temporary directory is still the private one makeAttemptTmpDir made: a real directory, not a
 * link, of this user, mode 0700, directly under <tmpRoot>/agf/. The agent can write there, so anything else is left
 * alone and a new directory made.
 */
async function reusableTmpDir(recorded: string | null, tmpRoot: string): Promise<boolean> {
  if (recorded === null || dirname(recorded) !== join(tmpRoot, 'agf')) return false;
  const stat = await lstat(recorded).catch(() => null);
  if (stat === null || !stat.isDirectory() || (stat.mode & 0o777) !== 0o700) return false;
  return process.getuid === undefined || stat.uid === process.getuid();
}

/**
 * Deletes the Claude CLI's untracked staging directory, which is never a violation (X-28). .claude must be a real
 * directory: through a link the delete would reach outside the clone.
 */
async function removeStaging(clone: string): Promise<void> {
  const claude = await lstat(join(clone, '.claude')).catch(() => null);
  if (claude?.isDirectory()) await rm(join(clone, '.claude', '.cc-writes'), { recursive: true, force: true });
}

const CODEX_CONFIG = '.codex/**';

/**
 * Whether the clone's .codex/ equals the restore base's (design 9.2), compared through the vault with a temporary
 * index and --work-tree, never with git in the clone: every tracked file the same, and nothing else there, not even
 * an ignored file, since Codex reads them all. Paths are matched in code, case-insensitively.
 */
export async function verifyProjectConfig(input: {
  vault: Vault;
  local: GitEnvironment;
  clone: string;
  base: string;
}): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), 'agflow-verify-'));
  try {
    const git = (args: string[]) =>
      runGit(input.local, [`--git-dir=${input.vault.path}`, `--work-tree=${input.clone}`, ...args], {
        cwd: input.clone,
        env: { GIT_INDEX_FILE: join(dir, 'index') },
        check: false,
      });
    await git(['read-tree', input.base]);
    await git(['update-index', '-q', '--refresh']);
    const changed = await git(['diff-files', '-z', '--name-only', '--ignore-submodules=all']);
    // --directory lists an untracked directory once ("node_modules/") instead of every file in it.
    const untracked = await git(['ls-files', '-z', '--others', '--directory']);
    if (changed.code !== 0 || untracked.code !== 0) return false;
    const paths = `${changed.stdout}${untracked.stdout}`.split('\0').filter((path) => path !== '');
    return !paths.some((path) => matchesProtectedPattern(path.replace(/\/+$/, ''), CODEX_CONFIG));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Steps 1-3 of the attempt clone, and the base checkout and temporary directory of a Claude attempt. The
 * preparation of dependencies (step 4) is the controller's, through its seam, and finishWorkspace follows it.
 */
export async function prepareWorkspace(deps: WorkspaceDeps, spec: AttemptSpec): Promise<PreparedWorkspace> {
  const { vault, local, paths } = deps;
  const path = paths.clone(vault.project, spec.attemptId);
  // A link left at the clone path stays there for forensics; nothing is done through it.
  await assertCloneDirectory(path);
  await vault.fetchForAttempt({ taskId: spec.taskId, start: spec.start }, deps.wipRefPrefix());
  const { created, startSha } = await ensureClone(deps, spec, path);
  const clone = await realClonePath(path);
  await removeStaging(clone);
  const brief = withWorkingDirectory(spec.brief, clone);
  const runDir = writeRunDir({
    clone,
    tools: paths.agentTools(vault.project, spec.attemptId),
    taskPack: spec.taskPack,
    brief,
    identity: deps.config().commitIdentity,
  });
  const git = { vault, local };
  const base = await resolveRestoreBase(vault, spec);
  const changes = await detectProtected(git, { base, head: startSha, paths: spec.restore.paths });
  await restoreProtected(git, { clone, base, paths: spec.restore.paths });
  let baseCheckout: BaseCheckout | null = null;
  let tmpDir: string | null = null;
  if (spec.vendor === 'claude') {
    baseCheckout = await vault.acquireBaseCheckout(spec.attemptId);
    try {
      const recorded = deps.store.get(spec.attemptId)?.tmpDir ?? null;
      tmpDir = (await reusableTmpDir(recorded, deps.tmpRoot)) ? recorded : makeAttemptTmpDir({ root: deps.tmpRoot });
    } catch (error) {
      await baseCheckout.release();
      throw error;
    }
  }
  return {
    clone,
    created,
    startSha,
    base,
    runDir,
    brief,
    violations: [...new Set(changes.map((change) => change.path))].sort(),
    baseCheckout,
    tmpDir,
    projectConfigVerified: false,
  };
}

/**
 * The last step before the agent starts (design 9.2): when a dependency preparation ran, which may run the
 * project's scripts in the clone, the protected paths are restored once more, so the agent starts with the base's
 * agent config; then the clone's .codex/ is verified against the restore base.
 */
export async function finishWorkspace(
  deps: Pick<WorkspaceDeps, 'vault' | 'local'>,
  spec: Pick<AttemptSpec, 'restore'>,
  workspace: PreparedWorkspace,
  options: { prepared: boolean },
): Promise<void> {
  const { vault, local } = deps;
  const { clone, base } = workspace;
  if (options.prepared) await restoreProtected({ vault, local }, { clone, base, paths: spec.restore.paths });
  workspace.projectConfigVerified = await verifyProjectConfig({ vault, local, clone, base });
}

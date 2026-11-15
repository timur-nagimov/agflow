// Merges with main (design 6.13). A submission merges main into its branch, so the project's check runs on what main
// will hold, and merge_task merges an accepted task into main. Both merge in the vault with `git merge-tree
// --write-tree`, which needs no work tree and runs no hook, and make the merge commit with commit-tree: no git ever
// runs in a clone. main moves only by a push leased on the main sha that was merged; one that lost its lease because
// main moved meanwhile fetches and tries again.
import { isTaskBranch, type MergeTaskResult } from '@agflow/core';
import { type PushGit, pushRefs } from './push';
import { type GitEnvironment, GitError, gitOk, runGit } from './run';
import { commitTree } from './snapshot';
import type { Vault } from './vault';

const SHA = /^[0-9a-f]{40}$/;
/** A recorded sha: the hub may hold an abbreviation, as M1's records do. */
const RECORDED_SHA = /^[0-9a-f]{7,40}$/;

/** How many times merge_task pushes main before it gives up on a main that keeps moving. */
export const MERGE_TRIES = 5;

export interface MergeGit {
  vault: Vault;
  /** The local environment, localGitEnv(paths). */
  local: GitEnvironment;
}

/** What merging two commits gives: the merged tree, or the files that conflict. */
export type MergeTree = { clean: true; tree: string } | { clean: false; files: string[] };

/** The commit a ref or a recorded sha names in the vault, or null. */
async function commitOf(git: MergeGit, name: string): Promise<string | null> {
  const args = [`--git-dir=${git.vault.path}`, 'rev-parse', '--verify', '--quiet', `${name}^{commit}`];
  const result = await runGit(git.local, args, { check: false });
  const sha = result.stdout.trim();
  return result.code === 0 && SHA.test(sha) ? sha : null;
}

/** Whether ancestor is descendant or one of its ancestors, in the vault. */
export function isAncestor(git: MergeGit, ancestor: string, descendant: string): Promise<boolean> {
  return gitOk(git.local, [`--git-dir=${git.vault.path}`, 'merge-base', '--is-ancestor', ancestor, descendant]);
}

/** The files that differ between two commits in the vault, a rename as its old and new path. */
export async function changedFiles(git: MergeGit, from: string, to: string): Promise<string[]> {
  const args = [`--git-dir=${git.vault.path}`, 'diff-tree', '-r', '--name-only', '--no-renames', '-z', from, to];
  const { stdout } = await runGit(git.local, args);
  return stdout.split('\0').filter((path) => path !== '');
}

/** main's commit in the vault. */
export async function mainOf(git: MergeGit): Promise<string> {
  const sha = await commitOf(git, `refs/heads/${git.vault.mainBranch}`);
  if (sha === null) throw new Error(`the vault has no ${git.vault.mainBranch}`);
  return sha;
}

/** Merges theirs into ours in the vault, writing no work tree: the merged tree, or the files that conflict. */
export async function mergeTree(git: MergeGit, ours: string, theirs: string): Promise<MergeTree> {
  const args = [
    `--git-dir=${git.vault.path}`,
    'merge-tree',
    '--write-tree',
    '--name-only',
    '--no-messages',
    '-z',
    ours,
    theirs,
  ];
  const result = await runGit(git.local, args, { check: false });
  const [tree, ...files] = result.stdout.split('\0').filter((entry) => entry !== '');
  // 0: clean, 1: conflicts; git also exits 1 for a commit it cannot merge, with no tree.
  if (result.timedOut || (result.code !== 0 && result.code !== 1) || tree === undefined || !SHA.test(tree)) {
    throw new GitError(args, result.code, result.stderr, result.timedOut, git.local.timeoutMs);
  }
  return result.code === 0 ? { clean: true, tree } : { clean: false, files: [...new Set(files)].sort() };
}

export interface MergeIntoInput extends MergeGit {
  /** The branch's commit that main merges into. */
  head: string;
  main: string;
  message: string;
  identity: { name: string; email: string };
  now?: Date;
}

/** A merge commit of main into head, with head as its first parent: its sha and tree, or the files that conflict. */
export async function mergeMainInto(
  input: MergeIntoInput,
): Promise<{ merged: true; sha: string; tree: string } | { merged: false; files: string[] }> {
  const merge = await mergeTree(input, input.head, input.main);
  if (!merge.clean) return { merged: false, files: merge.files };
  const sha = await commitTree({
    vault: input.vault,
    local: input.local,
    tree: merge.tree,
    parent: input.head,
    merged: input.main,
    message: input.message,
    identity: input.identity,
    now: input.now ?? new Date(),
  });
  return { merged: true, sha, tree: merge.tree };
}

export interface MergeTaskInput extends PushGit {
  taskId: string;
  title: string;
  /** The task branch, without refs/heads/. */
  branch: string;
  /** The accepted head; an abbreviation the vault resolves. */
  headSha: string;
  wipRefPrefix: string;
  /** The merge commit's author and committer: runner.json's commitIdentity. */
  identity: { name: string; email: string };
  /** Runs before each push of main: tests move main there. */
  beforePush?(): Promise<void>;
}

/** What merge_task did: merged or a conflict, as the hub reads it, or failed with why. */
export type MergeTaskOutcome = MergeTaskResult | { status: 'failed'; detail: string };

/** A title on one line, for a commit message's subject. */
function subject(title: string): string {
  const line = title.replace(/\s+/g, ' ').trim();
  return line.length <= 200 ? line : `${line.slice(0, 199)}…`;
}

/**
 * merge_task: fetches main and the task's refs into the vault, then merges the accepted head into main as a commit
 * "Merge <task id>: <title>" whose first parent is main, and pushes main leased on that main sha. A head main already
 * holds is merged at main as it is. A push that lost its lease fetches and merges again, MERGE_TRIES times at most; a
 * conflict reports its files and changes nothing. Only a task's own branch is merged.
 */
export async function mergeTaskBranch(input: MergeTaskInput): Promise<MergeTaskOutcome> {
  const { vault, taskId } = input;
  if (!isTaskBranch(taskId, input.branch)) return { status: 'failed', detail: `${input.branch} is not a branch of ${taskId}` };
  if (!RECORDED_SHA.test(input.headSha)) return { status: 'failed', detail: `${input.headSha} is not a commit sha` };
  const mainRef = `refs/heads/${vault.mainBranch}`;
  for (let tries = 1; ; tries++) {
    try {
      await vault.refresh(taskId, [], input.wipRefPrefix);
    } catch (error) {
      return { status: 'failed', detail: `cannot fetch ${vault.mainBranch}: ${describe(error)}` };
    }
    const head = await commitOf(input, input.headSha);
    if (head === null) return { status: 'failed', detail: `the vault has no commit ${input.headSha} of ${input.branch}` };
    const main = await mainOf(input);
    if (await isAncestor(input, head, main)) return { status: 'merged', sha: main };
    const merge = await mergeTree(input, main, head);
    if (!merge.clean) return { status: 'conflict', files: merge.files };
    const sha = await commitTree({
      vault,
      local: input.local,
      tree: merge.tree,
      parent: main,
      merged: head,
      message: `Merge ${taskId}: ${subject(input.title)}`,
      identity: input.identity,
      now: new Date(),
    });
    await input.beforePush?.();
    const pushed = await pushRefs({ ...input, updates: [{ ref: mainRef, sha, expected: main }] });
    if (pushed.ok) return { status: 'merged', sha };
    if (pushed.error === 'remote') return { status: 'failed', detail: `cannot push ${vault.mainBranch}: ${pushed.detail}` };
    if (tries === MERGE_TRIES) {
      return { status: 'failed', detail: `${vault.mainBranch} kept moving: its push lost the lease ${MERGE_TRIES} times` };
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type Task, isTaskBranch } from '@agflow/core';
import { GitError, addExclude, defaultBranch, git, gitOk } from '../git';

export function taskWorktreePath(root: string, taskId: string): string {
  return join(root, '.worktrees', 'agflow', taskId);
}

/** A push to the task branch goes there with the person's own git login, so only the task's own namespace will do. */
export function assertTaskBranch(taskId: string, branch: string): void {
  if (!isTaskBranch(taskId, branch)) {
    throw new Error(
      `${branch} is not an agflow task branch (agflow/${taskId}-<name>), so submit will not push to it. ` +
        `Release ${taskId} and claim it again with claim_task to get a proper branch.`,
    );
  }
}

/**
 * Where the task's work continues (design 6.4): the claim answer's workRef and workSha. The ref may be a WIP,
 * late-work or take-over ref, or a branch; either may be null, not both.
 */
export interface WorkPosition {
  ref: string | null;
  sha: string | null;
}

/** The task's work position; null when it has none, and its branch starts from main as in M1. */
export function workPositionOf(task: Pick<Task, 'workRef' | 'workSha'>): WorkPosition | null {
  return task.workRef === null && task.workSha === null ? null : { ref: task.workRef, sha: task.workSha };
}

/** A commit a task branch started from, and the ref that named it (null for a position given only as a SHA). */
export interface StartPoint {
  ref: string | null;
  sha: string;
}

export interface TaskWorktree {
  path: string;
  created: boolean;
  branchCreated: boolean;
  /**
   * For a worktree that was already there on another branch (say the task's branch of an earlier epoch): that branch,
   * or its commit when it was detached. The claim switched the worktree to the task branch, and a refused claim
   * switches it back. Null otherwise.
   */
  switchedFrom: string | null;
  /** Where a created branch started, when it started from a work position; null otherwise (M1's starts). */
  start: StartPoint | null;
  /** Origin's head of the task branch as the claim fetched it, for a branch it created; null when origin has none. */
  remoteHead: string | null;
}

export const describeStart = (start: StartPoint): string =>
  start.ref ? `${start.ref} at ${start.sha.slice(0, 7)}` : start.sha.slice(0, 7);

export const describePosition = (position: WorkPosition): string =>
  position.sha ? describeStart({ ref: position.ref, sha: position.sha }) : (position.ref ?? 'nowhere');

/** A worktree and branch this claim created: they hold no work yet. */
const isFresh = (worktree: TaskWorktree): boolean => worktree.created && worktree.branchCreated;

const isAncestor = (cwd: string, sha: string, of: string): boolean => git(cwd, ['merge-base', '--is-ancestor', sha, of]).code === 0;

const hasLocalBranch = (root: string, branch: string): boolean => git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).code === 0;

const samePosition = (a: WorkPosition, b: WorkPosition): boolean => a.ref === b.ref && a.sha === b.sha;

const hasCommit = (root: string, sha: string): boolean => git(root, ['cat-file', '-e', `${sha}^{commit}`]).code === 0;

/**
 * Fetches the work position from origin with the person's own git credentials and returns its commit. The SHA is the
 * hub's record, so it wins over wherever the ref has moved since; a position given only as a SHA is fetched by it
 * (GitHub serves any reachable commit that way).
 */
export function fetchWorkPosition(root: string, position: WorkPosition): StartPoint {
  const { ref, sha } = position;
  if (sha && hasCommit(root, sha)) return { ref, sha };
  if (ref) {
    const fetched = git(root, ['fetch', '--quiet', 'origin', ref]);
    if (fetched.code === 0 && !sha) return { ref, sha: gitOk(root, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}']) };
    if (fetched.code === 0 && sha && hasCommit(root, sha)) return { ref, sha };
  }
  if (sha && git(root, ['fetch', '--quiet', 'origin', sha]).code === 0 && hasCommit(root, sha)) return { ref, sha };
  throw new GitError(
    `agflow could not fetch the task's work position (${ref ?? sha}${ref && sha ? ` at ${sha.slice(0, 7)}` : ''}) from origin. ` +
      "Check that this repository's origin is the project's repository and that you can fetch from it, then try again.",
  );
}

/**
 * A worktree that is already there is the person's own and is used as it is, but on the task branch: one left from an
 * earlier claim may be on the task's branch of an earlier epoch, while the claim records a new name (design 6.14). It
 * switches in place, so its commits and uncommitted changes come along; a switch git refuses refuses the claim.
 */
function existingWorktree(root: string, path: string, branch: string): TaskWorktree {
  const kept: TaskWorktree = { path, created: false, branchCreated: false, switchedFrom: null, start: null, remoteHead: null };
  // A leftover directory that is not a worktree of its own would let git act on the repository around it.
  if (git(path, ['rev-parse', '--show-toplevel']).stdout !== path) return kept;
  const current = gitOk(path, ['branch', '--show-current']);
  if (current === branch) return kept;
  const switchedFrom = current || gitOk(path, ['rev-parse', 'HEAD']);
  const localBranch = hasLocalBranch(root, branch);
  gitOk(path, localBranch ? ['switch', '--quiet', branch] : ['switch', '--quiet', '-c', branch]);
  return { ...kept, branchCreated: !localBranch, switchedFrom };
}

/**
 * Creates (or reuses) the task's worktree. A new branch starts from the task's work position when it has one, or from
 * the same branch on origin when a previous holder pushed it there on top of that position; without a position, from
 * that branch on origin, otherwise from origin's default branch (or the local one when offline), as in M1. An existing
 * local branch is the person's own and is used as it is; so is an existing worktree, switched to the branch.
 */
export function prepareTaskWorktree(root: string, taskId: string, branch: string, position: WorkPosition | null = null): TaskWorktree {
  const path = taskWorktreePath(root, taskId);
  if (existsSync(path)) return existingWorktree(root, path, branch);
  addExclude(root, '.worktrees/');
  const base = defaultBranch(root);
  const baseFetched = git(root, ['fetch', '--quiet', 'origin', base]).code === 0;
  const remoteBranch = git(root, ['fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]).code === 0;
  if (hasLocalBranch(root, branch)) {
    gitOk(root, ['worktree', 'add', '--quiet', path, branch]);
    return { path, created: true, branchCreated: false, switchedFrom: null, start: null, remoteHead: null };
  }
  const remoteHead = remoteBranch ? gitOk(root, ['rev-parse', `refs/remotes/origin/${branch}`]) : null;
  let start: StartPoint | null = null;
  if (position) {
    start = fetchWorkPosition(root, position);
    // A holder who pushed the task branch after starting from the position has newer work there.
    if (remoteHead && isAncestor(root, start.sha, remoteHead)) start = { ref: `refs/heads/${branch}`, sha: remoteHead };
  }
  const from = start ? start.sha : (remoteHead ?? (baseFetched ? `origin/${base}` : base));
  gitOk(root, ['worktree', 'add', '--quiet', '-b', branch, path, from]);
  return { path, created: true, branchCreated: true, switchedFrom: null, start, remoteHead };
}

/**
 * The claim answer may name a newer position than the one the worktree was prepared from (a WIP pushed meanwhile).
 * A branch this claim created holds no work yet, so it moves there, unless it holds that commit already (it started
 * from a pushed task branch on top of it). Returns the new start, or null when it stays.
 */
export function followWorkPosition(root: string, worktree: TaskWorktree, prepared: WorkPosition | null, now: WorkPosition | null): StartPoint | null {
  if (!isFresh(worktree) || now === null || (prepared !== null && samePosition(prepared, now))) return null;
  const start = fetchWorkPosition(root, now);
  if (isAncestor(worktree.path, start.sha, 'HEAD')) return null;
  gitOk(worktree.path, ['reset', '--quiet', '--hard', start.sha]);
  return start;
}

/**
 * For a worktree or branch that was already there: the work position when the branch lacks it, so the agent merges it
 * rather than lose it. Best effort: null when the position cannot be fetched.
 */
export function positionMissingFrom(root: string, worktree: TaskWorktree, position: WorkPosition | null): StartPoint | null {
  if (isFresh(worktree) || position === null) return null;
  let start: StartPoint;
  try {
    start = fetchWorkPosition(root, position);
  } catch {
    return null;
  }
  return isAncestor(worktree.path, start.sha, 'HEAD') ? null : start;
}

/**
 * For a branch this claim created: origin's task branch when it has commits the branch lacks, as when someone pushed it
 * after the work position was taken; the agent merges them, or its submit's push is refused. Null otherwise.
 */
export function remoteCommitsMissingFrom(worktree: TaskWorktree): string | null {
  if (!isFresh(worktree) || worktree.remoteHead === null) return null;
  return isAncestor(worktree.path, worktree.remoteHead, 'HEAD') ? null : worktree.remoteHead;
}

/** Undoes what prepareTaskWorktree did, for a claim the hub refused. */
export function removeTaskWorktree(root: string, worktree: TaskWorktree, branch: string): void {
  if (worktree.created) {
    git(root, ['worktree', 'remove', '--force', worktree.path]);
    if (worktree.branchCreated) git(root, ['branch', '-D', branch]);
    return;
  }
  if (worktree.switchedFrom === null) return;
  git(worktree.path, ['checkout', '--quiet', worktree.switchedFrom, '--']);
  if (worktree.branchCreated) git(root, ['branch', '-D', branch]);
}

/**
 * Pushes the task branch and returns its head commit. Refuses uncommitted changes, and refuses to push
 * anything but the task's own branch from a worktree that has it checked out.
 */
export function pushTaskBranch(path: string, taskId: string, branch: string): string {
  assertTaskBranch(taskId, branch);
  const checkedOut = gitOk(path, ['branch', '--show-current']);
  if (checkedOut !== branch) {
    throw new Error(
      `The task worktree ${path} is ${checkedOut ? `on branch ${checkedOut}` : 'not on any branch'}, not on ${branch}. ` +
        `Check out ${branch} there and commit your work on it; submit pushes only that branch.`,
    );
  }
  const dirty = gitOk(path, ['status', '--porcelain']);
  if (dirty) throw new Error(`The task worktree has uncommitted changes. Commit them in ${path} first:\n${dirty}`);
  gitOk(path, ['push', '--quiet', '-u', 'origin', `HEAD:refs/heads/${branch}`]);
  return gitOk(path, ['rev-parse', 'HEAD']);
}

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { addExclude, defaultBranch, git, gitOk, slugify } from '../git';

export function taskWorktreePath(root: string, taskId: string): string {
  return join(root, '.worktrees', 'agflow', taskId);
}

export function taskBranchName(taskId: string, title: string): string {
  return `agflow/${taskId}-${slugify(title)}`;
}

/**
 * True for a branch inside the task's own namespace, `agflow/T-<id>-<slug>`. The hub keeps whatever branch
 * name a claim last gave it, and any agent may give it any valid name, so a name from the hub is trusted
 * only when it is one of these: a push goes there with the person's own git login.
 */
export function isTaskBranch(taskId: string, branch: string | null | undefined): branch is string {
  return typeof branch === 'string' && branch.startsWith(`agflow/${taskId}-`);
}

export interface TaskWorktree {
  path: string;
  created: boolean;
  branchCreated: boolean;
}

/**
 * Creates (or reuses) the task's worktree. A new branch starts from the same branch on origin when a
 * previous holder pushed it, otherwise from origin's default branch (or the local one when offline).
 */
export function prepareTaskWorktree(root: string, taskId: string, branch: string): TaskWorktree {
  const path = taskWorktreePath(root, taskId);
  if (existsSync(path)) return { path, created: false, branchCreated: false };
  addExclude(root, '.worktrees/');
  const base = defaultBranch(root);
  const baseFetched = git(root, ['fetch', '--quiet', 'origin', base]).code === 0;
  const remoteBranch = git(root, ['fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]).code === 0;
  const localBranch = git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).code === 0;
  if (localBranch) {
    gitOk(root, ['worktree', 'add', '--quiet', path, branch]);
  } else {
    const start = remoteBranch ? `origin/${branch}` : baseFetched ? `origin/${base}` : base;
    gitOk(root, ['worktree', 'add', '--quiet', '-b', branch, path, start]);
  }
  return { path, created: true, branchCreated: !localBranch };
}

export function removeTaskWorktree(root: string, worktree: TaskWorktree, branch: string): void {
  if (!worktree.created) return;
  git(root, ['worktree', 'remove', '--force', worktree.path]);
  if (worktree.branchCreated) git(root, ['branch', '-D', branch]);
}

/**
 * Pushes the task branch and returns its head commit. Refuses uncommitted changes, and refuses to push
 * anything but the task's own branch from a worktree that has it checked out.
 */
export function pushTaskBranch(path: string, taskId: string, branch: string): string {
  if (!isTaskBranch(taskId, branch)) {
    throw new Error(
      `${branch} is not an agflow task branch (agflow/${taskId}-<name>), so submit will not push to it. ` +
        `Release ${taskId} and claim it again with claim_task to get a proper branch.`,
    );
  }
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

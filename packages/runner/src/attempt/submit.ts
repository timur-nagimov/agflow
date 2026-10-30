// push_submission (design 6.13, X-18, X-33). The runner pushes only to the task's own branch: the one
// AttemptSpec.branch names, in the task's namespace (core's isTaskBranch); any other is refused and reported as
// attempt.violation phase submit, and nothing is pushed. The clone is harvested; uncommitted changes (files over
// 10 MB the snapshot left out included) refuse the submission with dirty, protected changes with protected_paths,
// whose detail tells the agent to merge main when main has changed those paths, rather than revert them. Protected
// changes are judged against the submission base: the restore base, or, once the branch has merged a newer main,
// that merge's base on main, so a branch that followed the advice carries main's own versions and passes as it is.
// The task branch and the WIP ref then move together under the stale-lease rules (pushSubmission). Remote failures
// are retried with a doubling delay until submitRetry passes (remote) or a stop or hold for the attempt arrives
// (interrupted); a refusal that cannot clear (the attempt was fenced, ended or exited) ends the retries at once. The
// outcome is the outbox event attempt.submitted, and the command result repeats it.
import { type AttemptSpec, isTaskBranch, type RunnerEvent } from '@agflow/core';
import { doublingDelay } from '../backoff';
import { mergeBase } from '../git/protect';
import type { SubmitPushOutcome } from '../git/push';
import { type GitEnvironment, runGit } from '../git/run';
import type { Vault } from '../git/vault';
import { clipViolationPaths } from './workspace';

/** attempt.submitted's data: the outcome of one push_submission. */
export type SubmittedData = Extract<RunnerEvent, { type: 'attempt.submitted' }>['data'];

/** What push_submission carries for the controller. */
export interface SubmitCommand {
  fence: AttemptSpec['fence'];
  submissionId: string;
  branch: string;
  expectedBranchSha: string | null;
  adoptable: string[];
}

/**
 * What a push_submission did: an outcome, reported as attempt.submitted; or a refusal with no outcome: a fence that
 * is not the attempt's, or a branch that is not its own (reported as a violation).
 */
export type SubmitResult =
  | { ok: true; outcome: SubmittedData }
  | { ok: false; error: 'stale_fence' | 'branch_refused' };

/** The waits between tries of a submission push: 1 s, doubling to a minute, while submitRetry lasts. */
export const SUBMIT_RETRY_DELAY = { base: 1_000, cap: 60_000 } as const;

/** Whether a push_submission names the attempt's own branch: AttemptSpec.branch, in the task's namespace (X-18). */
export function isOwnBranch(spec: Pick<AttemptSpec, 'taskId' | 'branch'>, branch: string): boolean {
  return spec.taskId !== null && spec.branch === branch && isTaskBranch(spec.taskId, branch);
}

/** A list of paths for a detail, clipped as violations are. */
function listed(paths: readonly string[]): string {
  return clipViolationPaths(paths).join(', ');
}

/** dirty's detail: the paths with uncommitted changes, files over 10 MB the snapshot left out included. */
export function dirtyDetail(paths: readonly string[]): string {
  return (
    `the clone has uncommitted changes: ${listed(paths)}. Commit them, or remove what does not belong in the ` +
    'submission, then submit again.'
  );
}

/**
 * The base a submission's protected paths are judged against. A branch that merged main since the restore base
 * carries main's versions as of that merge: merge-base(the vault's main, head), when it descends from the restore
 * base. Otherwise the restore base. Either is a commit of main, which agents cannot write, so only main's own versions
 * of protected paths pass.
 */
export async function submissionBase(input: {
  vault: Vault;
  local: GitEnvironment;
  restoreBase: string;
  head: string;
}): Promise<string> {
  const { vault, local, restoreBase, head } = input;
  const merged = await mergeBase({ vault, local }, `refs/heads/${vault.mainBranch}`, head);
  if (merged === null || merged === restoreBase) return restoreBase;
  const args = [`--git-dir=${vault.path}`, 'merge-base', '--is-ancestor', restoreBase, merged];
  const descends = await runGit(local, args, { check: false });
  return descends.code === 0 ? merged : restoreBase;
}

/**
 * protected_paths' detail: the paths, and how to fix them. A path whose version on the vault's main differs from the
 * submission base changed on main since, so the agent merges main rather than revert it.
 */
export async function protectedDetail(input: {
  vault: Vault;
  local: GitEnvironment;
  base: string;
  paths: readonly string[];
}): Promise<string> {
  const { vault, local, base, paths } = input;
  const main = vault.mainBranch;
  const range = [base, `refs/heads/${main}`];
  const diff = await runGit(local, [`--git-dir=${vault.path}`, 'diff-tree', '-r', '-z', '--name-only', ...range], {
    check: false,
  });
  const changedOnMain = new Set(diff.code === 0 ? diff.stdout.split('\0').filter((path) => path !== '') : []);
  const newer = paths.filter((path) => changedOnMain.has(path));
  const intro = `the branch changes protected paths, which agents may not change: ${listed(paths)}.`;
  if (newer.length > 0) {
    return (
      `${intro} ${main} has changed ${listed(newer)} since your branch started: merge it rather than reverting them ` +
      `(\`git fetch origin && git merge origin/${main}\`), then submit again.`
    );
  }
  return `${intro} Revert them to the versions your branch started from, commit, and submit again.`;
}

export interface SubmitPushRetryInput {
  /** One try: the push, or why it may not run now (a remote outcome). */
  push(): Promise<SubmitPushOutcome>;
  /** submitRetry. */
  budgetMs: number;
  /** Whether a stop or hold for the attempt arrived since the submission began. */
  interrupted(): boolean;
  /** Resolves when a stop or hold arrives, so a wait ends at once. */
  stopArrived(): Promise<void>;
  /** Called before each wait. */
  onRetry(outcome: SubmitPushOutcome, delayMs: number): void;
  /** Whether a remote outcome may clear on a later try; every remote outcome by default. */
  retryable?(outcome: SubmitPushOutcome): boolean;
  /** Bun.sleep by default. */
  sleep?: (ms: number) => Promise<void>;
  /** Date.now by default. */
  now?: () => number;
}

/**
 * Runs the push until it lands or is refused, retrying remote failures with SUBMIT_RETRY_DELAY until budgetMs has
 * passed, the last try at its end. Gives the last outcome, or 'interrupted' once a stop or hold arrived: before a
 * try, after a failed one, or during a wait.
 */
export async function pushSubmissionWithRetries(
  input: SubmitPushRetryInput,
): Promise<SubmitPushOutcome | 'interrupted'> {
  const sleep = input.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = input.now ?? Date.now;
  const retryable = input.retryable ?? (() => true);
  const deadline = now() + input.budgetMs;
  for (let attempt = 0; ; attempt++) {
    if (input.interrupted()) return 'interrupted';
    const outcome = await input.push();
    if (outcome.error !== 'remote' || !retryable(outcome)) return outcome;
    if (input.interrupted()) return 'interrupted';
    const remaining = deadline - now();
    if (remaining <= 0) return outcome;
    const delayMs = Math.min(doublingDelay(attempt, SUBMIT_RETRY_DELAY), remaining);
    input.onRetry(outcome, delayMs);
    await Promise.race([sleep(delayMs), input.stopArrived()]);
  }
}

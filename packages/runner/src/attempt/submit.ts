// push_submission (design 6.13, X-18, X-33). The runner pushes only to the task's own branch: the one
// AttemptSpec.branch names, in the task's namespace (core's isTaskBranch); any other is refused and reported as
// attempt.violation phase submit, and nothing is pushed. The clone is harvested; uncommitted changes (files over
// 10 MB the snapshot left out included) refuse the submission with dirty, protected changes with protected_paths,
// whose detail tells the agent to merge main when main has changed those paths, rather than revert them. Protected
// changes are judged against the submission base: the restore base, or, once the branch has merged a newer main,
// that merge's base on main, so a branch that followed the advice carries main's own versions and passes as it is.
// Then main merges into the branch, unless the branch holds it already: a conflict refuses the submission with
// merge_conflict, naming the files, and leaves the clone alone; a clean merge becomes a commit on the branch in the
// clone. The project's check (.agflow/config.json on main) runs in the clone on the result, after the dependencies are
// prepared again when main merged in, and a failure of either refuses the submission with check_failed and the end of
// its output. Under the open profile a failed preparation refuses nothing: the check runs anyway, and its output ends
// with a note of the failure. What the check gave travels with the outcome either way; a passed one names the check's
// own files that the branch changes (checkOwnFiles), which keep the hub from accepting it by itself.
// The task branch and the WIP ref then move together under the stale-lease rules (pushSubmission). Remote failures
// are retried with a doubling delay until submitRetry has passed since the submission began (remote) or a stop or
// hold for the attempt arrives (interrupted); a refusal that cannot clear (the attempt was fenced, ended or exited)
// ends the retries at once. The outcome is the outbox event attempt.submitted, and the command result repeats it.
import { posix } from 'node:path';
import { type AttemptSpec, CHECK_TAIL_MAX, isTaskBranch, type RunnerEvent, type SubmissionCheck } from '@agflow/core';
import { doublingDelay } from '../backoff';
import { mergeBase } from '../git/protect';
import type { SubmitPushOutcome } from '../git/push';
import { type GitEnvironment, runGit } from '../git/run';
import type { Vault } from '../git/vault';
import { PREP_CONFIG_PATH } from '../prep/config';
import type { CheckRun } from '../seams';
import { clip } from './pump';
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

/**
 * merge_conflict's detail: main does not merge into the branch cleanly, the files where, and how the agent merges it
 * itself. The clone is left as it was.
 */
export function conflictDetail(files: readonly string[], main: string): string {
  const where = files.length > 0 ? ` These files conflict: ${listed(files)}.` : '';
  return (
    `${main} does not merge into your branch cleanly.${where} Merge it yourself (\`git fetch origin && git merge ` +
    `origin/${main}\`), resolve the conflicts, run the project's check, commit, and submit again.`
  );
}

/** The lines of a check's output its refusal and its tail keep. */
export const CHECK_TAIL_LINES = 60;

/** The last CHECK_TAIL_LINES lines of a check's output, cut to its last CHECK_TAIL_MAX bytes. */
export function checkTail(output: string): string {
  const lines = output.replace(/\n+$/, '').split('\n').slice(-CHECK_TAIL_LINES).join('\n');
  const bytes = Buffer.from(lines);
  if (bytes.length <= CHECK_TAIL_MAX) return lines;
  let start = bytes.length - CHECK_TAIL_MAX;
  // The cut can land inside a character: it starts at the next whole one.
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString('utf8');
}

/** A check that did not run: none, with why in its tail. */
export function noCheck(command: string | null, why: string): SubmissionCheck {
  return { status: 'none', command, durationMs: 0, tail: checkTail(why) };
}

/** What a check that ran gives: passed only when it exited 0 in time. */
export function checkOf(command: string, run: CheckRun): SubmissionCheck {
  const passed = run.code === 0 && run.signal === null && !run.timedOut;
  return { status: passed ? 'passed' : 'failed', command, durationMs: Math.round(run.durationMs), tail: checkTail(run.logTail) };
}

/**
 * The check's own files among those a branch changes: .agflow/config.json, which names the check, and any file the
 * command names as a word, such as scripts/check.sh in `bash scripts/check.sh`, also when the word spells it
 * ./scripts//check.sh, a/../scripts/check.sh or $PWD/scripts/check.sh (${PWD}/, $(pwd)/ and `pwd`/ too), quotes part
 * of it, as in "$PWD"/scripts/check.sh, or follows an =, as in --config=scripts/check.json. Files the check reaches
 * only another way, such as a script that check.sh calls or a test, are not among them.
 */
export function checkOwnFiles(command: string, changed: readonly string[]): string[] {
  // $(pwd) and `pwd` become $PWD, which the split keeps whole. A quote ends a path in code the command runs, as in
  // python3 -c "run(['scripts/check.sh'])", but not in "$PWD"/scripts/check.sh, so the words are split both ways.
  const text = command.replace(/\$\(pwd\)|`pwd`/g, '$PWD');
  const words = [text, text.replace(/["']/g, '')].flatMap((each) => each.split(/[\s;&|()<>'"`=]+/));
  const paths = new Set(words.map((word) => posix.normalize(word.replace(/^\$(?:PWD|\{PWD\})\/+/, ''))));
  return changed.filter((path) => path === PREP_CONFIG_PATH || paths.has(path));
}

/** check_failed's detail: how the check failed, what the agent does about it, and the end of its output. */
export function checkFailedDetail(check: SubmissionCheck, run: CheckRun, timeoutMs: number, main: string): string {
  const limit = timeoutMs % 60_000 === 0 ? `${timeoutMs / 60_000} min` : `${timeoutMs} ms`;
  const how = run.timedOut
    ? `timed out after ${limit}`
    : run.signal !== null
      ? `was killed by ${run.signal}`
      : `exited with code ${run.code ?? 'unknown'}`;
  const intro =
    `the project's check \`${check.command}\` ${how}, run on your branch with ${main} merged in. Run it yourself, ` +
    'make it pass, commit, and submit again.';
  return check.tail === '' ? intro : `${intro} The last lines of its output:\n${check.tail}`;
}

/** A check that did not run because the dependencies, prepared again after main merged in, failed: failed, with why. */
export function prepFailedCheck(
  command: string,
  prep: { error: string | null; logTail: string | null },
): SubmissionCheck {
  const output = [prep.logTail?.trimEnd() ?? '', prep.error ?? 'the preparation failed'].filter((part) => part !== '');
  return { status: 'failed', command, durationMs: 0, tail: checkTail(output.join('\n')) };
}

/** check_failed's detail when the dependencies could not be prepared for the check: what the agent does about it. */
export function prepFailedDetail(check: SubmissionCheck, main: string): string {
  return (
    `the dependencies could not be prepared again after ${main} merged into your branch, so the project's check ` +
    `\`${check.command}\` did not run. Call prepare_dependencies, fix what makes it fail, commit, and submit again. ` +
    `The last lines of its output:\n${check.tail}`
  );
}

/**
 * The line that ends the check's output under the open profile when the dependencies, prepared again after main
 * merged in, failed: there the check runs anyway, since the agent can install what it needs itself.
 */
export function prepFailedNote(error: string | null, main: string): string {
  const why = clip((error ?? 'the preparation failed').replace(/\s+/g, ' ').trim(), 300);
  return `The dependencies could not be prepared again after ${main} merged in (${why}). The check ran anyway.`;
}

export interface SubmitPushRetryInput {
  /** One try: the push, or why it may not run now (a remote outcome). */
  push(): Promise<SubmitPushOutcome>;
  /** What is left of submitRetry; with nothing left, the push still makes its one try. */
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

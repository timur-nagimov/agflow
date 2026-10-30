// Pushes (design 7.3, 6.13, 6.18). Every push runs in the vault with the remote environment, always
// `--atomic --porcelain --no-verify`, with `--force-with-lease=<ref>:<exact sha>` for each ref (empty to create it):
// never --force, a bare lease or a + refspec. A push that finds the ref already at its commit reports = and counts
// as success. WIP pushes lease on the attempt's previous WIP sha; late work goes to new refs beside the WIP ref; a
// submission moves the task branch and the WIP ref together and follows the stale-lease rules; fenced deletes
// remove refs only at the sha the hub recorded. Network, server, auth and timeout failures are all `remote`.
import { lateWorkRef, type SubmitError } from '@agflow/core';
import { type GitEnvironment, gitOk, runGit } from './run';
import type { Vault } from './vault';

export interface PushGit {
  vault: Vault;
  /** The local environment, for questions about the vault's commits. */
  local: GitEnvironment;
  /** The remote environment for the vault (remoteGitEnv with gitDir: the vault). */
  remote: GitEnvironment;
}

export interface RefUpdate {
  ref: string;
  /** The commit to push; null deletes the ref. */
  sha: string | null;
  /** The sha the ref must have on the remote; null: it must not exist. */
  expected: string | null;
}

export interface PushRefResult {
  ref: string;
  /**
   * ok: created, moved or deleted; up_to_date: already at the commit (=); stale: the lease failed; refused: rejected
   * by the remote, or left alone because another ref of the atomic push failed.
   */
  status: 'ok' | 'up_to_date' | 'stale' | 'refused';
  /** git's summary: "new reference", "stale info", "atomic push failed", "remote rejected (...)"... */
  detail: string;
}

export type PushResult =
  | { ok: true; refs: PushRefResult[] }
  | { ok: false; error: 'stale' | 'remote'; refs: PushRefResult[]; detail: string };

const SHA = /^[0-9a-f]{40}$/;

function requireSha(sha: string, what: string): string {
  if (!SHA.test(sha)) throw new Error(`${what} must be a full commit sha, not ${JSON.stringify(sha)}`);
  return sha;
}

/** The arguments of a push: every ref leased on its exact expected sha, every refspec without a +. */
export function pushArgs(updates: readonly RefUpdate[]): string[] {
  if (updates.length === 0) throw new Error('a push needs at least one ref');
  const leases = updates.map((update) => {
    const expected = update.expected === null ? '' : requireSha(update.expected, 'a lease');
    return `--force-with-lease=${update.ref}:${expected}`;
  });
  const refspecs = updates.map((update) =>
    update.sha === null ? `:${update.ref}` : `${requireSha(update.sha, 'a pushed commit')}:${update.ref}`,
  );
  return ['push', '--atomic', '--porcelain', '--no-verify', ...leases, 'origin', ...refspecs];
}

/** One porcelain line: "<flag>\t<from>:<to>\t<summary>", the summary "[word]", "[word] (reason)" or text. */
function parseLine(line: string): PushRefResult | null {
  const [flag, refspec, summary] = line.split('\t');
  if (flag === undefined || refspec === undefined || summary === undefined || flag.length !== 1) return null;
  const ref = refspec.slice(refspec.lastIndexOf(':') + 1);
  const reason = summary.match(/\(([^)]*)\)\s*$/)?.[1];
  const word = summary.match(/^\[([^\]]*)\]/)?.[1];
  const detail = reason ?? word ?? summary.trim();
  if (flag === '=') return { ref, status: 'up_to_date', detail };
  if (flag !== '!') return { ref, status: 'ok', detail };
  return { ref, status: reason === 'stale info' ? 'stale' : 'refused', detail };
}

/**
 * One atomic push of the updates. Gives ok when every ref was moved or was already at its commit; stale when a
 * lease failed (nothing moved); remote for everything else: an unreachable or refusing remote, a timeout.
 */
export async function pushRefs(input: PushGit & { updates: readonly RefUpdate[] }): Promise<PushResult> {
  const args = pushArgs(input.updates);
  const result = await runGit(input.remote, [`--git-dir=${input.vault.path}`, ...args], { check: false });
  const refs = result.stdout
    .split('\n')
    .map(parseLine)
    .filter((ref): ref is PushRefResult => ref !== null);
  const wanted = new Set(input.updates.map((update) => update.ref));
  const complete = refs.length === wanted.size && refs.every((ref) => wanted.has(ref.ref));
  const landed = refs.every((ref) => ref.status === 'ok' || ref.status === 'up_to_date');
  if (!result.timedOut && result.code === 0 && complete && landed) return { ok: true, refs };
  const stale = refs.find((ref) => ref.status === 'stale');
  if (stale && !result.timedOut) return { ok: false, error: 'stale', refs, detail: `${stale.ref}: stale info` };
  const refused = refs.find((ref) => ref.status === 'refused' && ref.detail !== 'atomic push failed');
  const detail = result.timedOut
    ? `the push timed out after ${input.remote.timeoutMs} ms`
    : refused
      ? `${refused.ref}: ${refused.detail}`
      : result.stderr.trim() || `git push exited with ${result.code}`;
  return { ok: false, error: 'remote', refs, detail };
}

/** The attempt's WIP ref to sha, leased on the previous WIP sha (null: the ref must not exist yet). */
export function pushWip(input: PushGit & { ref: string; sha: string; previous: string | null }): Promise<PushResult> {
  return pushRefs({ ...input, updates: [{ ref: input.ref, sha: input.sha, expected: input.previous }] });
}

/** The highest late-work number tried before giving up. */
const LATE_WORK_MAX = 1000;

export type LateWorkResult = { ok: true; ref: string; n: number } | { ok: false; error: 'remote'; detail: string };

/**
 * Late work and hand-backs: a new ref beside the WIP ref, lateWorkRef(prefix, attempt, n), created with an empty
 * lease from n = 1, moving to the next n while one exists. A ref already at sha is the landing of an earlier try.
 */
export async function pushLateWork(
  input: PushGit & { wipRefPrefix: string; attemptId: string; sha: string },
): Promise<LateWorkResult> {
  for (let n = 1; n <= LATE_WORK_MAX; n++) {
    const ref = lateWorkRef(input.wipRefPrefix, input.attemptId, n);
    const result = await pushRefs({ ...input, updates: [{ ref, sha: input.sha, expected: null }] });
    if (result.ok) return { ok: true, ref, n };
    if (result.error === 'remote') return { ok: false, error: 'remote', detail: result.detail };
  }
  return { ok: false, error: 'remote', detail: `late-work refs 1 to ${LATE_WORK_MAX} all exist` };
}

/** The remote's shas for the refs, read with ls-remote; a ref the remote lacks is absent from the map. */
export async function lsRemote(git: PushGit, refs: string[]): Promise<Map<string, string>> {
  const result = await runGit(git.remote, [`--git-dir=${git.vault.path}`, 'ls-remote', 'origin', ...refs]);
  const heads = new Map<string, string>();
  for (const line of result.stdout.split('\n')) {
    const [sha, ref] = line.split('\t');
    // ls-remote matches patterns against the end of each name; only the exact names count.
    if (sha !== undefined && ref !== undefined && SHA.test(sha) && refs.includes(ref)) heads.set(ref, sha);
  }
  return heads;
}

export interface SubmitPushOutcome {
  ok: boolean;
  /** The submitted commit. */
  headSha: string;
  /** The task branch's head on the remote after the push: the submitted commit, the one that refused it, or null. */
  remoteHead: string | null;
  error: Extract<SubmitError, 'needs_merge' | 'branch_moved' | 'remote'> | null;
  detail: string | null;
}

export interface SubmissionInput extends PushGit {
  taskId: string;
  wipRefPrefix: string;
  /** The task branch, without refs/heads/. */
  branch: string;
  /** The attempt's WIP ref. */
  wipRef: string;
  /** The harvested commit to submit. */
  sha: string;
  /** push_submission.expectedBranchSha: the branch head the hub recorded, perhaps abbreviated; null: none. */
  expectedBranchSha: string | null;
  /** The attempt's previous WIP sha; null: none yet. */
  previousWip: string | null;
  /** push_submission.adoptable: shas the hub knows as agflow work for the task, perhaps abbreviated. */
  adoptable: readonly string[];
}

/**
 * push_submission's push (design 6.13): the task branch and the WIP ref to one commit, atomically. On a stale
 * branch lease it reads the remote head (and fetches it into the vault), then:
 * 1. a remote head the submitted commit contains, or one in adoptable, is adopted as the lease, with one retry;
 * 2. a remote head that descends from an adoptable sha (someone added commits on top of agflow work) refuses with
 *    needs_merge, which the agent fixes by merging the branch;
 * 3. any other head refuses with branch_moved.
 * The WIP ref belongs to the attempt: a remote value the commit contains or the hub lists is adopted the same way.
 * The remote branch never moves on a refusal.
 */
export async function pushSubmission(input: SubmissionInput): Promise<SubmitPushOutcome> {
  const { sha, branch } = input;
  requireSha(sha, 'a submitted commit');
  const branchRef = `refs/heads/${branch}`;
  const outcome = (error: SubmitPushOutcome['error'], remoteHead: string | null, detail: string | null) => ({
    ok: error === null,
    headSha: sha,
    remoteHead,
    error,
    detail,
  });
  const isAncestor = (ancestor: string, descendant: string) =>
    gitOk(input.local, [`--git-dir=${input.vault.path}`, 'merge-base', '--is-ancestor', ancestor, descendant]);
  // Recorded shas may be abbreviated (at least 7 hex).
  const known = input.adoptable.filter((entry) => /^[0-9a-f]{7,40}$/.test(entry));
  const matches = (head: string | null, recorded: string | null) =>
    head === recorded || (head !== null && recorded !== null && recorded.length >= 7 && head.startsWith(recorded));
  const adoptable = async (head: string) =>
    known.some((entry) => head.startsWith(entry)) || (await isAncestor(head, sha));

  let leases = { branch: input.expectedBranchSha, wip: input.previousWip };
  for (let attempt = 0; ; attempt++) {
    // A lease needs an exact sha: an abbreviated recorded head is resolved from the remote first.
    if (leases.branch === null || SHA.test(leases.branch)) {
      const updates = [
        { ref: branchRef, sha, expected: leases.branch },
        { ref: input.wipRef, sha, expected: leases.wip },
      ];
      const result = await pushRefs({ ...input, updates });
      if (result.ok) return outcome(null, sha, null);
      if (result.error === 'remote') return outcome('remote', null, result.detail);
    }
    let heads: Map<string, string>;
    try {
      heads = await lsRemote(input, [branchRef, input.wipRef]);
      await input.vault.refresh(input.taskId, [...heads.keys()], input.wipRefPrefix);
    } catch (error) {
      return outcome('remote', null, error instanceof Error ? error.message : String(error));
    }
    const remoteHead = heads.get(branchRef) ?? null;
    const remoteWip = heads.get(input.wipRef) ?? null;
    if (!matches(remoteHead, leases.branch)) {
      if (remoteHead === null) return outcome('branch_moved', null, `${branch} was deleted on the remote`);
      if (!(await adoptable(remoteHead))) {
        for (const entry of known) {
          if (await isAncestor(entry, remoteHead)) {
            const fix = `git fetch origin && git merge origin/${branch}`;
            return outcome('needs_merge', remoteHead, `${branch} has commits on top of agflow work; run \`${fix}\``);
          }
        }
        return outcome('branch_moved', remoteHead, `${branch} moved to ${remoteHead}, which is not agflow work`);
      }
    }
    // The WIP ref is the attempt's own: another value there is adopted on the same terms, never pushed over.
    if (!matches(remoteWip, leases.wip) && remoteWip !== null && !(await adoptable(remoteWip))) {
      return outcome('remote', remoteHead, `${input.wipRef} is at ${remoteWip}, which this attempt did not push`);
    }
    if (attempt === 1) return outcome('remote', remoteHead, `${branch} kept moving while it was pushed`);
    leases = { branch: remoteHead, wip: remoteWip };
  }
}

export interface DeleteRefResult {
  ref: string;
  /** deleted, or already gone; moved: left alone at remoteSha; failed: the remote could not be reached. */
  status: 'deleted' | 'gone' | 'moved' | 'failed';
  remoteSha: string | null;
  detail: string | null;
}

/** delete_refs (design 6.18): each ref is deleted only while it is still at its expected sha, one push each. */
export async function deleteRefsFenced(
  input: PushGit & { refs: readonly { ref: string; expectedSha: string }[] },
): Promise<DeleteRefResult[]> {
  const results: DeleteRefResult[] = [];
  for (const { ref, expectedSha } of input.refs) {
    const pushed = await pushRefs({ ...input, updates: [{ ref, sha: null, expected: expectedSha }] });
    if (pushed.ok) {
      results.push({ ref, status: 'deleted', remoteSha: null, detail: null });
    } else if (pushed.error === 'remote') {
      results.push({ ref, status: 'failed', remoteSha: null, detail: pushed.detail });
    } else {
      // A lease on a ref that does not exist fails as stale too.
      const heads = await lsRemote(input, [ref]).catch(() => null);
      if (heads === null) results.push({ ref, status: 'failed', remoteSha: null, detail: 'ls-remote failed' });
      else {
        const remoteSha = heads.get(ref) ?? null;
        results.push({ ref, status: remoteSha === null ? 'gone' : 'moved', remoteSha, detail: null });
      }
    }
  }
  return results;
}

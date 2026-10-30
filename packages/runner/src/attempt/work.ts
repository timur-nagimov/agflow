// An attempt's work and its WIP pushes (design 7.3, X-11). collectWork is every harvest's common part: the clone's
// commits through the quarantine, its uncommitted work as one snapshot commit, and the protected paths stripped
// against the restore base, the result pinned in the vault at refs/agflow-local/<attempt>/head. canPushWip is the one
// predicate that decides every push to a WIP ref: a welcome since the last clock gap, an attempt not known fenced,
// ended or exited, and a heartbeat_ack (or welcome) younger than welcome.timings.wipGraceMs. While it fails, the
// harvest waits in the vault. The snapshot reads every file itself with links refused, so a swap of a path for a link
// gets nothing from outside the clone; as a second layer, the attempt's recorded and snapshotted groups are paused
// (SIGSTOP) while a harvest reads their clone, and live commands reach a paused agent when the harvest ends. A
// process they do not cover (a tool's background child) still runs then. A clone the agent replaced with a link is
// never harvested.
import type { AttemptSpec } from '@agflow/core';
import { harvestCommits } from '../git/harvest';
import { resolveRestoreBase, stripProtected } from '../git/protect';
import { type GitEnvironment, runGit } from '../git/run';
import { snapshotWork } from '../git/snapshot';
import type { Vault } from '../git/vault';
import type { RunnerPaths } from '../paths';
import { killGroup, type ProcessIdentity } from '../processes';
import { assertCloneDirectory } from './workspace';

/** The longest attempt.wip.logStat: 4,000 characters (X-3). */
export const LOG_STAT_MAX = 4_000;
/** The commits logStat lists at most: 4,000 characters never hold more, and the history is the agent's. */
export const LOG_STAT_COMMITS = 100;
/** How long logStat may take; it gives no stat after that. */
export const LOG_STAT_TIMEOUT_MS = 30_000;

export interface WorkInput {
  vault: Vault;
  local: GitEnvironment;
  paths: Pick<RunnerPaths, 'quarantine'>;
  clone: string;
  spec: Pick<AttemptSpec, 'attemptId' | 'restore'>;
  /** The task branch, AttemptSpec.branch. */
  branch: string;
  /** The author and committer of the runner's commits: runner.json's commitIdentity. */
  identity: { name: string; email: string };
  now?: Date;
}

export interface WorkResult {
  /** The harvested head: the clone's committed work. */
  head: string;
  /** What a push carries: the head with the uncommitted work, protected changes undone. */
  sha: string;
  /** sha's tree. */
  tree: string;
  /** Protected paths taken out against the restore base. */
  stripped: string[];
  /** Files over 10 MB left out. */
  skipped: string[];
  /** Embedded repositories captured as files. */
  embedded: string[];
  /** The harvest's warnings: HEAD on another branch, say. */
  warnings: string[];
}

/**
 * Harvests the clone, snapshots its uncommitted work and strips protected changes against the restore base. The
 * result is pinned as the attempt's head, where it waits until it is pushed. Never runs git in the clone.
 */
export async function collectWork(input: WorkInput): Promise<WorkResult> {
  const { vault, local, clone, spec, identity } = input;
  // Through a link, the harvest would push whatever repository and files it points at.
  await assertCloneDirectory(clone);
  const now = input.now ?? new Date();
  const harvest = await harvestCommits({
    vault,
    local,
    paths: input.paths,
    clone,
    attemptId: spec.attemptId,
    branch: input.branch,
  });
  const snapshot = await snapshotWork({ vault, local, clone, head: harvest.head, identity, now });
  const base = await resolveRestoreBase(vault, spec);
  const strip = await stripProtected({ vault, local }, {
    base,
    head: snapshot.sha,
    paths: spec.restore.paths,
    identity,
    now,
  });
  await vault.pin(spec.attemptId, { head: strip.sha });
  const tree = await runGit(local, [`--git-dir=${vault.path}`, 'rev-parse', `${strip.sha}^{tree}`]);
  return {
    head: harvest.head,
    sha: strip.sha,
    tree: tree.stdout.trim(),
    stripped: strip.stripped,
    skipped: snapshot.skipped,
    embedded: snapshot.embedded,
    warnings: harvest.warnings,
  };
}

/**
 * `git log --stat` of the newest LOG_STAT_COMMITS commits since main, clipped to LOG_STAT_MAX characters; empty when
 * git cannot tell in LOG_STAT_TIMEOUT_MS.
 */
export async function logStat(input: { vault: Vault; local: GitEnvironment; sha: string }): Promise<string> {
  const { vault, local, sha } = input;
  const args = ['log', '--stat', '--no-color', `--max-count=${LOG_STAT_COMMITS}`, `refs/heads/${vault.mainBranch}..${sha}`];
  const log = await runGit(local, [`--git-dir=${vault.path}`, ...args], {
    check: false,
    timeoutMs: LOG_STAT_TIMEOUT_MS,
  });
  const text = log.code === 0 && !log.timedOut ? log.stdout.trimEnd() : '';
  return text.length <= LOG_STAT_MAX ? text : `${text.slice(0, LOG_STAT_MAX - 1)}…`;
}

/** What canPushWip reads of the link. */
export interface WipGate {
  /** A welcome arrived since the last clock gap. */
  welcomeSinceGap(): boolean;
  /** Awake ms since the last heartbeat_ack or welcome; null before the first. */
  ackAgeMs(): number | null;
  /** welcome.timings.wipGraceMs; null before the first welcome. */
  wipGraceMs(): number | null;
}

/** The gate of a live link (LinkClient), read on the awake clock. */
export function wipGateOf(
  link: {
    readonly welcomeSinceGap: boolean;
    readonly lastAckAt: number | null;
    readonly welcome: { timings: { wipGraceMs: number } } | null;
  },
  clock: { awakeNow(): number },
): WipGate {
  return {
    welcomeSinceGap: () => link.welcomeSinceGap,
    ackAgeMs: () => {
      const at = link.lastAckAt;
      return at === null ? null : clock.awakeNow() - at;
    },
    wipGraceMs: () => link.welcome?.timings.wipGraceMs ?? null,
  };
}

/** What the runner knows about the attempt that forbids WIP pushes. */
export interface WipStanding {
  fenced: boolean;
  ended: boolean;
  /** attempt.exited was reported for its process: the WIP ref never moves after it. */
  exited: boolean;
}

/** Why a push to the attempt's WIP ref may not go now; null when it may (X-11). */
export function wipRefusal(gate: WipGate, attempt: WipStanding): string | null {
  if (attempt.fenced) return 'the attempt was re-fenced';
  if (attempt.ended) return 'the hub ended the attempt';
  if (attempt.exited) return 'the attempt already reported its exit';
  if (!gate.welcomeSinceGap()) return 'the hub has not welcomed the runner since its last clock gap';
  const age = gate.ackAgeMs();
  const grace = gate.wipGraceMs();
  if (age === null || grace === null || age >= grace) return 'the hub has not answered within the WIP grace';
  return null;
}

/** Whether a push to the attempt's WIP ref may go now (X-11). */
export function canPushWip(gate: WipGate, attempt: WipStanding): boolean {
  return wipRefusal(gate, attempt) === null;
}

/** The runner's consecutive failed WIP pushes over all its attempts (attempt.wip_failed.failures, X-3). */
export class WipFailures {
  private count = 0;

  /** Counts one more failure; gives the new count. */
  failed(): number {
    this.count += 1;
    return this.count;
  }

  succeeded(): void {
    this.count = 0;
  }
}

/**
 * Runs work while the groups are stopped (SIGSTOP), and lets them go on (SIGCONT) when it ends, however it ends. Each
 * signal checks the group's identity first, as every group signal does.
 */
export async function withPausedGroups<T>(groups: readonly ProcessIdentity[], work: () => Promise<T>): Promise<T> {
  const paused: ProcessIdentity[] = [];
  try {
    for (const group of groups) {
      if (paused.some((other) => other.pgid === group.pgid)) continue;
      if (await killGroup(group, 'SIGSTOP')) paused.push(group);
    }
    return await work();
  } finally {
    for (const group of paused) await killGroup(group, 'SIGCONT');
  }
}

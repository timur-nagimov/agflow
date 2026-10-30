// The vault (design 7.3): one bare repository per project, written only by the runner. It fetches from origin with
// the remote environment, holds each clone's pins under refs/agflow-local/, serves base checkouts of main as
// Claude's project configuration root, and consolidates its objects without ever pruning what a clone may borrow.
// Every change to its refs or worktrees runs under one lock per vault, shared by every Vault object for that path,
// as are the base checkouts' reference counts.
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { localPinRefs, taskRefGlob } from '@agflow/core';
import type { RunnerPaths } from '../paths';
import { type GitEnvironment, GitError, gitOk, localGitEnv, type RunGitOptions, remoteGitEnv, runGit } from './run';

/** A position to start from: the hub's work-position ref and the sha it recorded, if any (AttemptSpec.start). */
export interface StartRef {
  ref: string;
  sha: string | null;
}

/** The commit an attempt actually starts from. */
export interface StartPosition {
  ref: string;
  sha: string;
  /** The sha the hub recorded for the position. */
  recordedSha: string | null;
  /** The tip differs from the recorded sha: pre-fence work the hub had not heard of (attempt.spawned.startSha). */
  differs: boolean;
}

/** A base checkout of main in use by one attempt; release it when the attempt no longer runs. */
export interface BaseCheckout {
  path: string;
  sha: string;
  release(): Promise<void>;
}

export interface VaultOptions {
  paths: RunnerPaths;
  /** The project key (projectKey) naming the vault and the work directories. */
  project: string;
  repo: { url: string; mainBranch: string };
  /** The local environment; localGitEnv(paths) by default. */
  local?: GitEnvironment;
  /**
   * Built for each fetch, so a change to the owner's git configuration applies; remoteGitEnv for the vault by
   * default.
   */
  remote?: () => Promise<GitEnvironment>;
}

const LOCAL_PINS = 'refs/agflow-local/';
const SHA = /^[0-9a-f]{40}$/;
/** A recorded sha: core's CommitShaSchema allows abbreviations, which M1's records may hold. */
const RECORDED_SHA = /^[0-9a-f]{7,40}$/;

/** The tail of the lock chain of each vault path. */
const locks = new Map<string, Promise<void>>();
/** The attempts using each base checkout, by vault path and sha; read and changed only under the vault's lock. */
const baseUsers = new Map<string, Map<string, Set<string>>>();

export class Vault {
  readonly path: string;
  readonly project: string;
  readonly mainBranch: string;
  /** The local environment every command on the vault runs with. */
  readonly local: GitEnvironment;
  private readonly paths: RunnerPaths;
  private readonly url: string;
  private readonly remote: () => Promise<GitEnvironment>;

  constructor(options: VaultOptions) {
    this.paths = options.paths;
    this.project = options.project;
    this.path = options.paths.vault(options.project);
    this.url = options.repo.url;
    this.mainBranch = options.repo.mainBranch;
    this.local = options.local ?? localGitEnv(options.paths);
    // The owner's includes conditional on the repository (an SSH key per organisation, say) apply to the vault.
    this.remote = options.remote ?? (() => remoteGitEnv({ gitDir: this.path }));
  }

  /** Runs fn once every earlier holder of this vault's lock is done; a failure releases it too. */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = locks.get(this.path) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => mine);
    locks.set(this.path, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (locks.get(this.path) === tail) locks.delete(this.path);
    }
  }

  /** Creates the bare vault if needed, and keeps its origin URL, HEAD and gc.auto=0 as the runner wants them. */
  async ensure(): Promise<void> {
    await this.withLock(async () => {
      if (!existsSync(join(this.path, 'HEAD'))) {
        await runGit(this.local, ['init', '--quiet', '--bare', `--initial-branch=${this.mainBranch}`, this.path]);
      }
      await this.git(['config', 'remote.origin.url', this.url]);
      await this.git(['config', 'gc.auto', '0']);
      await this.git(['symbolic-ref', 'HEAD', `refs/heads/${this.mainBranch}`]);
    });
  }

  /**
   * Before a start or resume: fetches main, the task's refs under the WIP prefix and its agflow/<task>-* branches,
   * then a start ref none of those cover, then start.sha by SHA if the vault still lacks it. A local pin is never
   * fetched. Only the first fetch must succeed: a start ref gone from origin is absent, and a sha origin no longer
   * serves is not needed once the ref resolved. resolveStart reports a position the vault does not hold.
   */
  async fetchForAttempt(
    attempt: { taskId: string | null; start: StartRef },
    wipRefPrefix: string,
  ): Promise<void> {
    await this.fetch(this.taskRefspecs(attempt.taskId, wipRefPrefix));
    const { ref, sha } = attempt.start;
    if (!ref.startsWith(LOCAL_PINS) && !this.covered(ref, attempt.taskId, wipRefPrefix)) {
      await this.fetchIfPresent(ref);
    }
    // git cannot fetch an abbreviation; resolveStart resolves one the vault holds.
    if (sha === null || !SHA.test(sha) || (await this.hasCommit(sha))) return;
    try {
      await this.fetch([sha]);
    } catch (error) {
      if ((await this.commitOf(ref)) === null) throw error;
    }
  }

  /** refresh_vault: the task's refspecs and the named refs, so a late-work ref is there before the holder merges it. */
  async refresh(taskId: string, refs: string[], wipRefPrefix: string): Promise<void> {
    const refspecs = this.taskRefspecs(taskId, wipRefPrefix);
    for (const ref of refs) {
      if (ref.startsWith(LOCAL_PINS)) throw new Error(`${ref} is a local pin and is never fetched`);
      if (!this.covered(ref, taskId, wipRefPrefix)) refspecs.push(`+${ref}:${ref}`);
    }
    await this.fetch(refspecs);
  }

  /**
   * The tip the vault holds for a start position; a ref it lacks falls back to the recorded sha, if held. A
   * recorded abbreviation counts as the commit it names in the vault.
   */
  async resolveStart(start: StartRef): Promise<StartPosition> {
    const recorded = start.sha === null ? null : await this.resolveCommit(start.sha);
    const sha = (await this.commitOf(start.ref)) ?? recorded;
    if (sha === null) {
      const at = start.sha === null ? '' : ` (recorded at ${start.sha})`;
      throw new Error(`the start position ${start.ref}${at} is not in the vault`);
    }
    return { ref: start.ref, sha, recordedSha: start.sha, differs: start.sha !== null && sha !== recorded };
  }

  /** Whether the vault holds the commit. */
  hasCommit(sha: string): Promise<boolean> {
    if (!SHA.test(sha)) return Promise.resolve(false);
    return gitOk(this.local, [`--git-dir=${this.path}`, 'cat-file', '-e', `${sha}^{commit}`]);
  }

  /** Writes an attempt's pins of the objects its clone borrows. */
  async pin(attemptId: string, shas: { start?: string; head?: string }): Promise<void> {
    const refs = localPinRefs(attemptId);
    const lines = (['start', 'head'] as const).flatMap((name) => {
      const sha = shas[name];
      if (sha === undefined) return [];
      if (!SHA.test(sha)) throw new Error(`not a commit sha: ${JSON.stringify(sha)}`);
      return [`update ${refs[name]} ${sha}\n`];
    });
    if (lines.length === 0) return;
    await this.withLock(() => this.git(['update-ref', '--stdin'], { input: lines.join('') }));
  }

  /** cleanup_attempt: removes every pin of this attempt and of no other. */
  async deletePins(attemptId: string): Promise<void> {
    const { start } = localPinRefs(attemptId);
    const prefix = start.slice(0, start.lastIndexOf('/') + 1);
    await this.withLock(async () => {
      const listed = await this.git(['for-each-ref', '--format=%(refname)', prefix]);
      const refs = listed.stdout.split('\n').filter((ref) => ref.startsWith(prefix));
      if (refs.length === 0) return;
      await this.git(['update-ref', '--stdin'], { input: refs.map((ref) => `delete ${ref}\n`).join('') });
    });
  }

  /**
   * A checkout of main for one attempt at <vaults>/<project>.base/<sha12>, detached at sha (the vault's main by
   * default). Attempts on the same sha share it; the last release removes it.
   */
  async acquireBaseCheckout(attemptId: string, sha?: string): Promise<BaseCheckout> {
    const target = sha ?? (await this.commitOf(`refs/heads/${this.mainBranch}`));
    if (target === null) throw new Error(`the vault has no ${this.mainBranch} to check out`);
    const path = this.paths.baseCheckout(this.project, target);
    await this.withLock(async () => {
      const bases = this.bases();
      const users = bases.get(target) ?? new Set<string>();
      // A directory no attempt uses may be a checkout an earlier process left half done: made again, never trusted.
      if (users.size === 0) {
        await this.removeCheckout(path);
        await this.git(['worktree', 'add', '--quiet', '--detach', path, target]);
      }
      users.add(attemptId);
      bases.set(target, users);
    });
    return { path, sha: target, release: () => this.releaseBaseCheckout(attemptId, target) };
  }

  private async releaseBaseCheckout(attemptId: string, sha: string): Promise<void> {
    await this.withLock(async () => {
      const bases = this.bases();
      const users = bases.get(sha);
      if (!users?.delete(attemptId) || users.size > 0) return;
      bases.delete(sha);
      await this.removeCheckout(this.paths.baseCheckout(this.project, sha));
    });
  }

  /** This vault's base checkouts by sha, with the attempts that use each, shared by every Vault object for it. */
  private bases(): Map<string, Set<string>> {
    let bases = baseUsers.get(this.path);
    if (!bases) {
      bases = new Map();
      baseUsers.set(this.path, bases);
    }
    return bases;
  }

  /**
   * Packs the vault's objects. While any clone of the project exists it keeps every unreachable object, which a
   * clone may still borrow (repack -a -d --keep-unreachable); only when none exists does it prune.
   */
  async consolidate(): Promise<{ pruned: boolean }> {
    return this.withLock(async () => {
      if (this.clonesExist()) {
        await this.git(['repack', '-a', '-d', '-q', '--keep-unreachable']);
        return { pruned: false };
      }
      await this.git(['repack', '-a', '-d', '-q']);
      await this.git(['prune', '--expire=now']);
      await this.git(['worktree', 'prune']);
      return { pruned: true };
    });
  }

  private clonesExist(): boolean {
    const work = join(this.paths.work, this.project);
    return existsSync(work) && readdirSync(work).length > 0;
  }

  private taskRefspecs(taskId: string | null, wipRefPrefix: string): string[] {
    const main = `refs/heads/${this.mainBranch}`;
    const refspecs = [`+${main}:${main}`];
    if (taskId !== null) {
      const wip = taskRefGlob(wipRefPrefix, taskId);
      const branches = `refs/heads/agflow/${taskId}-*`;
      refspecs.push(`+${wip}:${wip}`, `+${branches}:${branches}`);
    }
    return refspecs;
  }

  /** Whether the task refspecs already fetch this ref. */
  private covered(ref: string, taskId: string | null, wipRefPrefix: string): boolean {
    if (ref === `refs/heads/${this.mainBranch}`) return true;
    if (taskId === null) return false;
    return (
      ref.startsWith(taskRefGlob(wipRefPrefix, taskId).slice(0, -1)) || ref.startsWith(`refs/heads/agflow/${taskId}-`)
    );
  }

  private async fetch(refspecs: string[]): Promise<void> {
    const remote = await this.remote();
    await this.withLock(() =>
      runGit(remote, [`--git-dir=${this.path}`, 'fetch', '--quiet', '--no-tags', 'origin', ...refspecs]),
    );
  }

  /**
   * Fetches one ref, which origin may no longer have (a hand-back branch merged and deleted, say). Whether it is
   * gone is asked with ls-remote --exit-code (2: no such ref), since git's own message may be translated.
   */
  private async fetchIfPresent(ref: string): Promise<void> {
    try {
      await this.fetch([`+${ref}:${ref}`]);
    } catch (error) {
      if (!(error instanceof GitError) || error.timedOut) throw error;
      const remote = await this.remote();
      const listed = await runGit(remote, [`--git-dir=${this.path}`, 'ls-remote', '--exit-code', 'origin', ref], {
        check: false,
      });
      if (listed.code !== 2) throw error;
    }
  }

  private async commitOf(ref: string): Promise<string | null> {
    const result = await this.git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { check: false });
    const sha = result.stdout.trim();
    return result.code === 0 && SHA.test(sha) ? sha : null;
  }

  /** The full sha of a recorded sha (7 to 40 hex) the vault holds; an ambiguous abbreviation counts as missing. */
  private async resolveCommit(sha: string): Promise<string | null> {
    return RECORDED_SHA.test(sha) ? this.commitOf(sha) : null;
  }

  private async removeCheckout(path: string): Promise<void> {
    await this.git(['worktree', 'remove', '--force', path], { check: false });
    rmSync(path, { recursive: true, force: true });
    await this.git(['worktree', 'prune']);
  }

  private git(args: string[], options: RunGitOptions = {}) {
    return runGit(this.local, [`--git-dir=${this.path}`, ...args], options);
  }
}

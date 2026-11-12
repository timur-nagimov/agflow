// Stall facts (design 7.5, 6.8): one FactsTracker per attempt builds the AttemptFacts each heartbeat carries. Every
// age and activeMs comes from the awake clock, so sleep and freeze gaps are left out. File changes come from one
// recursive watch of the clone (.agflow/run/ ignored), commits from a watch on .git/logs/HEAD, and a periodic check
// notices a deleted clone, which silences the watcher. A tool's cap is core's capForCommand, so the hub and the
// runner read commands the same way (X-18); activeMs counts only the phases starting and turn (X-35). Turns that fail
// with a vendor error count toward neither no-progress nor loops (design 6.8). What adapters report is kept within
// the heartbeat's schema here, since one bad value would make the hub drop the whole heartbeat.
import { createHash } from 'node:crypto';
import { existsSync, type FSWatcher, watch } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type AttemptFacts,
  type AttemptPhase,
  type AttemptSpec,
  capForCommand,
  type Fence,
  isLongCommand,
} from '@agflow/core';
import type { AgentEvent } from './adapters/types';
import type { AwakeClock } from './clock';
import { readCloneHead } from './git/clone';
import { type GitEnvironment, RUN_DIR_EXCLUDE, runGit } from './git/run';
import type { Vault } from './git/vault';

/** How often the clone's existence is checked by default. */
export const CLONE_CHECK_MS = 15_000;

/** The phases activeMs counts (X-35). */
const ACTIVE_PHASES: readonly AttemptPhase[] = ['starting', 'turn'];

export interface FactsTrackerOptions {
  attemptId: string;
  fence: Fence;
  /** The clone's path. */
  clone: string;
  toolCaps: AttemptSpec['toolCaps'];
  clock: Pick<AwakeClock, 'awakeNow'>;
  /** The diff fingerprint, taken at the start and after each completed turn: diffFingerprint for this attempt. */
  fingerprint(): Promise<string>;
  /** 'starting' by default. */
  phase?: AttemptPhase;
  /** CLONE_CHECK_MS by default. */
  existenceCheckMs?: number;
  /** Called once, when the clone is found gone. */
  onCloneGone?(): void;
  /**
   * Whether to watch the clone's files and commits, which fsAgeMs and commitAgeMs come from; true by default. Tests of
   * the other facts turn it off: on Linux (CI), a recursive watch closed right after it starts can stop Bun's worker
   * pool for the rest of the process.
   */
  watch?: boolean;
}

interface ToolInFlight {
  name: string;
  command: string | null;
  startedAt: number;
  /** capForCommand's cap for the command. */
  capMs: number;
  background?: boolean;
}

/** A path the tree watcher reports that is the runner's own: .agflow/run/ and the .agflow directory holding it. */
function runnerOwned(name: string): boolean {
  return name === '.agflow' || name === '.agflow/run' || name.startsWith('.agflow/run/');
}

export class FactsTracker {
  private readonly options: FactsTrackerOptions;
  private fence: Fence;
  private phase: AttemptPhase;
  private phaseSince: number;
  private activeBefore = 0;
  private vendorErrorSince: number | null = null;
  private lastEventAt: number;
  private lastFsAt: number | null = null;
  private lastCommitAt: number | null = null;
  private readonly tools = new Map<string, ToolInFlight>();
  private lastCall: string | null = null;
  private repeatedCalls = 0;
  /** The loop count as the running turn found it, restored if the turn fails with a vendor error. */
  private callsBeforeTurn: { lastCall: string | null; repeatedCalls: number } | null = null;
  private turns = 0;
  private turnsWithoutProgress = 0;
  /** Tool progress is visible immediately, until that turn's fingerprint commits its count (or the turn fails). */
  private readonly toolProgressTurns = new Set<number>();
  private continuations = 0;
  private contextUsed: number | null = null;
  private fingerprint: string | null = null;
  /** Fingerprints are taken in turn order. */
  private progress: Promise<void> = Promise.resolve();
  private treeWatcher: FSWatcher | null = null;
  private commitWatcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private gone = false;
  private closed = false;

  constructor(options: FactsTrackerOptions) {
    this.options = options;
    this.fence = options.fence;
    this.phase = options.phase ?? 'starting';
    const now = options.clock.awakeNow();
    this.phaseSince = now;
    this.lastEventAt = now;
  }

  /** Starts the watches and the existence check, and takes the first fingerprint. */
  async start(): Promise<void> {
    if (this.options.watch !== false) {
      this.watchTree();
      this.watchCommits();
    }
    this.timer = setInterval(() => this.checkClone(), this.options.existenceCheckMs ?? CLONE_CHECK_MS);
    this.timer.unref?.();
    this.fingerprint = await this.options.fingerprint().catch(() => null);
  }

  close(): void {
    this.closed = true;
    this.treeWatcher?.close();
    this.commitWatcher?.close();
    this.treeWatcher = null;
    this.commitWatcher = null;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Whether the clone was found gone. */
  get cloneGone(): boolean {
    return this.gone;
  }

  setFence(fence: Fence): void {
    this.fence = fence;
  }

  setPhase(phase: AttemptPhase): void {
    const now = this.now();
    if (ACTIVE_PHASES.includes(this.phase)) this.activeBefore += now - this.phaseSince;
    this.phase = phase;
    this.phaseSince = now;
    // Vendor errors stay continuous through the retry turns between them; anything else ends them.
    if (phase === 'vendor_error') this.vendorErrorSince ??= now;
    else if (phase !== 'turn') this.vendorErrorSince = null;
  }

  continuationSent(): void {
    this.continuations += 1;
  }

  /** Every agent event the controller reads. */
  observe(event: AgentEvent): void {
    const now = this.now();
    this.lastEventAt = now;
    // The model answers again: a period of vendor errors is over, even if this retry turn fails later.
    const output = event.type === 'text' || event.type === 'tool_started' || event.type === 'tool_ended';
    if (output && this.phase !== 'vendor_error') this.vendorErrorSince = null;
    switch (event.type) {
      case 'turn_started':
        this.turns += 1;
        this.callsBeforeTurn = { lastCall: this.lastCall, repeatedCalls: this.repeatedCalls };
        return;
      case 'tool_started': {
        this.toolProgressTurns.add(this.turns);
        const { name, command } = event;
        const capMs = capForCommand(this.options.toolCaps, command);
        this.tools.set(event.toolId, { name, command, startedAt: now, capMs });
        const call = JSON.stringify([name, event.input]);
        this.repeatedCalls = call === this.lastCall ? this.repeatedCalls + 1 : 1;
        this.lastCall = call;
        return;
      }
      case 'tool_backgrounded': {
        const tool = this.tools.get(event.toolId);
        if (tool) tool.background = true;
        return;
      }
      case 'tool_progress':
        // Waiting on a command is interleaved activity (e.g. with check_inbox), not another identical call.
        // Only a known, still-open tool can break the sequence; its original clock and cap stay intact.
        if (this.tools.has(event.toolId)) {
          this.toolProgressTurns.add(this.turns);
          this.lastCall = null;
          this.repeatedCalls = 0;
        }
        return;
      case 'tool_ended':
        this.tools.delete(event.toolId);
        return;
      case 'turn_ended':
        for (const [id, tool] of this.tools) if (!tool.background) this.tools.delete(id);
        if (event.outcome === 'completed') {
          this.vendorErrorSince = null;
          this.afterCompletedTurn(event.toolCalls);
        } else if (event.outcome === 'failed' && event.errorKind === 'vendor' && this.callsBeforeTurn !== null) {
          // The vendor failed the turn: its calls count toward no loop.
          ({ lastCall: this.lastCall, repeatedCalls: this.repeatedCalls } = this.callsBeforeTurn);
        }
        if (event.outcome !== 'completed') this.toolProgressTurns.delete(this.turns);
        this.callsBeforeTurn = null;
        return;
      case 'context':
        // A share of the window, 0..1; a sum over a turn's requests can pass 1.
        this.contextUsed = Number.isFinite(event.used) ? Math.min(1, Math.max(0, event.used)) : null;
        return;
      default:
        return;
    }
  }

  /** Resolves once the fingerprints of every completed turn so far are taken. */
  settled(): Promise<void> {
    return this.progress;
  }

  facts(): AttemptFacts {
    this.checkClone();
    const now = this.now();
    let tool: AttemptFacts['tool'] = null;
    // With calls in parallel, the one nearest to or furthest past its own cap: caps differ by command, so a younger
    // call can be past a smaller cap while an older long one is not. Ties go to the older call.
    for (const inFlight of this.tools.values()) {
      const ageMs = now - inFlight.startedAt;
      if (tool !== null) {
        const over = ageMs - inFlight.capMs;
        const reported = tool.ageMs - (tool.capMs ?? 0);
        if (over < reported || (over === reported && ageMs <= tool.ageMs)) continue;
      }
      const { command, capMs } = inFlight;
      tool = {
        // The heartbeat's schema needs a name.
        name: inFlight.name === '' ? 'tool' : inFlight.name,
        command,
        long: command !== null && isLongCommand(command),
        capMs,
        ageMs,
      };
    }
    const active = ACTIVE_PHASES.includes(this.phase) ? now - this.phaseSince : 0;
    return {
      attemptId: this.options.attemptId,
      fence: this.fence,
      phase: this.phase,
      eventAgeMs: now - this.lastEventAt,
      tool,
      fsAgeMs: this.lastFsAt === null ? null : now - this.lastFsAt,
      commitAgeMs: this.lastCommitAt === null ? null : now - this.lastCommitAt,
      turns: this.turns,
      turnsWithoutProgress: this.toolProgressTurns.size > 0 ? 0 : this.turnsWithoutProgress,
      repeatedCalls: this.repeatedCalls,
      continuations: this.continuations,
      vendorErrorMs: this.vendorErrorSince === null ? 0 : now - this.vendorErrorSince,
      activeMs: this.activeBefore + active,
      contextUsed: this.contextUsed,
    };
  }

  private now(): number {
    return this.options.clock.awakeNow();
  }

  /** A completed turn with no tool call and no change to the fingerprint made no progress. */
  private afterCompletedTurn(toolCalls: number): void {
    const turn = this.turns;
    this.progress = this.progress.then(async () => {
      const fingerprint = await this.options.fingerprint().catch(() => null);
      // A tool proves progress even if the clone cannot be read. Otherwise an unreadable clone tells nothing.
      if (toolCalls > 0 || this.toolProgressTurns.has(turn)) this.turnsWithoutProgress = 0;
      else if (fingerprint !== null) {
        this.turnsWithoutProgress = fingerprint === this.fingerprint ? this.turnsWithoutProgress + 1 : 0;
      }
      if (fingerprint !== null) this.fingerprint = fingerprint;
      this.toolProgressTurns.delete(turn);
    });
  }

  private watchTree(): void {
    try {
      this.treeWatcher = watch(this.options.clone, { recursive: true }, (_type, name) => {
        const path = typeof name === 'string' ? name : null;
        if (path !== null && runnerOwned(path)) return;
        this.lastFsAt = this.now();
        // The tree watcher may see the reflog too; the commit watch is the one that must.
        if (path === '.git/logs/HEAD') this.lastCommitAt = this.lastFsAt;
      });
      this.treeWatcher.on('error', () => {
        this.treeWatcher?.close();
        this.treeWatcher = null;
      });
    } catch {
      this.treeWatcher = null;
    }
  }

  /** .git/logs/HEAD may not exist yet, or be replaced by git; the existence check attaches the watch again. */
  private watchCommits(): void {
    const log = join(this.options.clone, '.git', 'logs', 'HEAD');
    if (this.options.watch === false || this.closed || this.commitWatcher !== null || !existsSync(log)) return;
    try {
      const watcher = watch(log, (type) => {
        this.lastCommitAt = this.now();
        if (type === 'rename') this.dropCommitWatcher(watcher);
      });
      watcher.on('error', () => this.dropCommitWatcher(watcher));
      this.commitWatcher = watcher;
    } catch {
      this.commitWatcher = null;
    }
  }

  private dropCommitWatcher(watcher: FSWatcher): void {
    watcher.close();
    if (this.commitWatcher === watcher) this.commitWatcher = null;
  }

  private checkClone(): void {
    if (this.closed || this.gone) return;
    if (!existsSync(this.options.clone)) {
      this.gone = true;
      this.options.onCloneGone?.();
      return;
    }
    this.watchCommits();
  }
}

export interface FingerprintInput {
  vault: Vault;
  /** The local environment, localGitEnv(paths). */
  local: GitEnvironment;
  clone: string;
  /** The commit compared against while the vault does not hold the clone's HEAD (new commits not harvested yet). */
  startSha: string;
  /** A runner-owned index file kept between fingerprints, so only changed files are hashed again. */
  index: string;
}

/** The paths in NUL-separated git output: `diff-files --raw -z` pairs, or `ls-files -z` names. */
function listedPaths(diffFiles: string, untracked: string): string[] {
  const paths: string[] = [];
  const fields = diffFiles.split('\0');
  for (let i = 0; i + 1 < fields.length; i += 2) paths.push(fields[i + 1] as string);
  for (const name of untracked.split('\0')) if (name !== '') paths.push(name);
  return paths;
}

/**
 * The diff fingerprint (design 7.5, Q11): a hash of HEAD read as a file, the changes of the work tree against HEAD's
 * commit as the vault sees them with --work-tree, and each listed path's size and mtime, so editing a file that is
 * already modified changes it too. No git runs in the clone, and nothing in it is written.
 */
export async function diffFingerprint(input: FingerprintInput): Promise<string> {
  const { vault, local, clone } = input;
  // Read as files, with no link followed: an unreadable HEAD is part of the fingerprint as such.
  const head = await readCloneHead(clone).catch(() => null);
  const headSha = head?.sha ?? null;
  const base = headSha !== null && (await vault.hasCommit(headSha)) ? headSha : input.startSha;
  const git = (args: string[]) =>
    runGit(local, [`--git-dir=${vault.path}`, `--work-tree=${clone}`, ...args], {
      cwd: clone,
      env: { GIT_INDEX_FILE: input.index },
      check: false,
    });
  // A one-tree merge keeps the stat data of unchanged entries, so the refresh hashes only files that changed.
  await git(['read-tree', '-m', base]);
  await git(['update-index', '-q', '--refresh']);
  const diff = await git(['diff-files', '--raw', '-z', '--ignore-submodules=dirty', '--', ':(top)', RUN_DIR_EXCLUDE]);
  const untracked = await git(['ls-files', '-z', '--others', '--exclude-standard', '--', ':(top)', RUN_DIR_EXCLUDE]);
  const hash = createHash('sha256');
  hash.update(`${JSON.stringify(head)}\0${base}\0${diff.stdout}\0${untracked.stdout}\0`);
  for (const path of listedPaths(diff.stdout, untracked.stdout)) {
    const stat = await lstat(join(clone, path)).catch(() => null);
    hash.update(stat === null ? `${path}\0-\0` : `${path}\0${stat.size}\0${stat.mtimeMs}\0`);
  }
  return hash.digest('hex');
}

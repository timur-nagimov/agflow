// The attempt controller (design 13): one per attempt, owning everything about it that is not vendor-specific. Its
// lifecycle and git work runs on the attempt's serial queue, one job at a time. A start is admitted first (X-3):
// a draining runner, a full capacity, a vendor that is not ready and the health seam each refuse it with one of
// core's START_REFUSALS, reported as attempt.failed_to_start with refused set, and nothing starts. An admitted
// start then prepares the clone (workspace.ts) and a worker's dependencies, in phase preparing, through the seam,
// and verifies the clone's project config last. Any failure after admission, a clone that cannot be prepared or a
// failed preparation say, releases what the start took and is one attempt.failed_to_start with refused null (X-40),
// its texts clipped.
// The agent then starts (launch.ts): its group is recorded before any of its events is read, the facts tracker
// starts, and its started event becomes attempt.spawned with the start tip the clone was made at. Its other events go
// through the event pump (pump.ts); deliver, interrupt and decide_approval act on the live session at once, never
// behind the serial queue, so an approval raised during a handoff turn does not wait for the stop.
// A worker's work is pushed to its WIP ref every wip interval while the clone changed, and before the agent starts
// in a clone that already existed (work.ts); canPushWip decides each push, and a harvest it forbids waits in the
// vault for the next welcome. Leads are never harvested.
// When the agent exits, the exit job (exit.ts) runs on the queue: an exit the runner did not request first kills
// every recorded group and sweeps the clone (X-15); then the final harvest and push, the transcript tail, the
// voided approvals, and only then attempt.exited. Work the final push could not place goes to a late-work ref.
// Stops, holds and the runner's own stops (stop.ts) run on the queue too: they prepare the agent (an interrupt, a
// handoff turn, or the end of the running turn), run the stop ladder and do the same exit work, once per process.
// What the runner sends the agent on its own, continuations, vendor-error retries, quota waits and the one nudge
// after an outage, is the turn policy's (turns.ts). A resume (resume.ts) stops a live process first, then prepares
// the clone the attempt has and resumes its session with the new fence and token. A submission (submit.ts) harvests
// the clone and pushes the task branch and the WIP ref together; a stop or hold arriving meanwhile ends its retries.
// A take-over (takeover.ts) stops the agent with a handoff turn, pushes its work, and hands the clone to a person
// with a .git the runner built; attempt.taken_over takes attempt.exited's place. A cleanup (cleanup.ts) stops a live
// process, saves the clone's work that is not on the origin as late work, uploads the transcript tail and removes
// the attempt's files; a hand-back (handback.ts) pushes a taken-over clone's work to a late-work ref first.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AttemptFacts,
  type AttemptPhase,
  type AttemptSpec,
  compareFence,
  type ExitCause,
  type Fence,
  type InjectedMessage,
  type StartRefusal,
  type StoppedBy,
  lateWorkRef,
  localPinRefs,
  type Vendor,
} from '@agflow/core';
import type {
  AgentEvent,
  AgentLaunch,
  AgentSession,
  AgflowCommand,
  ExitInfo,
  VendorAdapter,
} from '../adapters/types';
import type { AttemptRecord, AttemptStore } from '../attempt-store';
import type { AwakeClock } from '../clock';
import { type RunnerConfig, vendorHomes } from '../config';
import { buildAgentEnv } from '../env';
import { diffFingerprint, FactsTracker } from '../facts';
import { lsRemote, pushLateWork, pushSubmission, type PushResult, pushWip, type SubmitPushOutcome } from '../git/push';
import { detectProtected, resolveRestoreBase, restoreProtected } from '../git/protect';
import { type GitEnvironment, runGit } from '../git/run';
import { cloneExists } from '../git/clone';
import type { Vault } from '../git/vault';
import type { RunnerHubHttp } from '../hub-http';
import type { Logger } from '../log';
import type { NewEvent, Outbox } from '../outbox';
import type { RunnerPaths } from '../paths';
import type { SerialQueue } from '../queue';
import { removeAgentTools } from '../run-dir';
import { boundedWait, findCloneProcesses, type ProcessIdentity } from '../processes';
import type { DependencyPreparer, Notifier, RunnerHealth } from '../seams';
import { killAndSweep, runStopLadder } from '../stop-ladder';
import { vendorBinary } from '../vendor/pins';
import { clipPushError, EVENTS_AFTER_EXIT_MS, LateWorkRetries, pushWithRetries, uploadTranscriptTail } from './exit';
import { buildLaunch, ProcessRegistration } from './launch';
import { ACTIVITY_SUMMARY_MAX, clip, EventPump, type PumpEvent } from './pump';
import {
  RESUME_SEND_MS,
  RESUME_STOP_REASON,
  type ResumeInput,
  type ResumeOutcome,
  reopenClone,
  resumedSpec,
} from './resume';
import {
  dirtyDetail,
  isOwnBranch,
  protectedDetail,
  pushSubmissionWithRetries,
  type SubmitCommand,
  submissionBase,
  type SubmitResult,
  type SubmittedData,
} from './submit';
import {
  inspectAgentGitDir,
  type LocalCommandInput,
  moveNestedGitDirs,
  replaceGitDir,
  TAKEOVER_STOP_REASON,
  takeoverCommands,
  type TakeoverOutcome,
} from './takeover';
import { TurnPolicy } from './turns';
import { CLEANUP_STOP_REASON, type CleanupOutcome, removeTree } from './cleanup';
import { type HandBackOutcome, type HandBackSource, processRunningNote, stopCodexDaemon } from './handback';
import { prepareForStop, RUNNER_STOP_REASON, type StopOptions, type StopOutcome, TurnWatch } from './stop';
import {
  canPushWip,
  collectWork,
  logStat,
  type WipFailures,
  type WipGate,
  type WipStanding,
  type WorkResult,
  withPausedGroups,
  wipRefusal,
} from './work';
import {
  clipStartError,
  clipViolationPaths,
  finishWorkspace,
  openWorkspace,
  type PreparedWorkspace,
  prepareOpened,
  prepareWorkspace,
} from './workspace';

export interface ControllerDeps {
  /** The runner's settings as they are now: capacity, draining, models and timings change while it runs. */
  config(): RunnerConfig;
  paths: RunnerPaths;
  store: AttemptStore;
  outbox: Outbox;
  /** Shared by every controller; each runs its work under its attempt id. */
  queue: SerialQueue;
  /** The project's vault. */
  vault: Vault;
  /** The local environment, localGitEnv(paths). */
  local: GitEnvironment;
  adapters: ReadonlyMap<Vendor, VendorAdapter>;
  health: RunnerHealth;
  preparer: DependencyPreparer;
  notifier: Notifier;
  logger: Logger;
  /** The attempts that hold a capacity slot now (holdsSlot: a live process or a start under way), this one excluded. */
  liveAttempts(): number;
  /** Whether the vendor's last preflight found it ready. */
  vendorReady(vendor: Vendor): boolean;
  /** welcome.wipRefPrefix, which names the task's refs the vault fetches. */
  wipRefPrefix(): string;
  /** Where Claude attempts' private temporary directories go: /tmp. */
  tmpRoot: string;
  /** How the runner runs agflow: the bridge is `<agflow> mcp --vendor <v> --runner`. */
  agflow: AgflowCommand;
  /**
   * The CLI version a new attempt of the vendor starts with: the runtime gives pinnedCliVersion for this platform,
   * which throws for a platform with no pin, so the start fails as any other.
   */
  cliVersion(vendor: Vendor): string;
  /** How the agent's process is identified for the registry: processIdentity by default. */
  identify?: (pid: number) => Promise<ProcessIdentity | null>;
  /** The awake clock, which every age the facts report is read on. */
  clock: Pick<AwakeClock, 'awakeNow'>;
  /** The remote environment of the vault's pushes: remoteGitEnv with the vault as gitDir. */
  remote(): Promise<GitEnvironment>;
  /** What canPushWip reads of the link. */
  wipGate: WipGate;
  /** The runner's consecutive failed WIP pushes, shared by every controller. */
  wipFailures: WipFailures;
  /** Where transcript tails go: POST /api/runner/attempts/:id/transcript. */
  hub: Pick<RunnerHubHttp, 'uploadTranscript'>;
  /** How long a handoff note is waited for: welcome.timings.handoffMs, or runner.json's handoff before a welcome. */
  handoffMs(): number;
  /** Whether the link to the hub is up: no continuation is sent while it is down. */
  linkUp(): boolean;
}

/** The agent process of the attempt's current start or resume, while the controller follows it. */
interface LiveAgent {
  /** The command's spec, agent token included: it lives only here, in memory. */
  spec: AttemptSpec;
  workspace: PreparedWorkspace;
  launch: AgentLaunch;
  session: AgentSession;
  registration: ProcessRegistration;
  facts: FactsTracker;
  pump: EventPump;
  /** Its turns, as stops wait on them. */
  watch: TurnWatch;
  /** What the runner sends it on its own. */
  policy: TurnPolicy;
  /** The runner-owned directory of the facts' fingerprint index. */
  factsDir: string;
  /** Settles once the agent's events have ended. */
  events: Promise<void>;
  /** Settles once the agent's events have ended and its exit was dealt with. */
  done: Promise<void>;
  /** Started by a resume: attempt.spawned carries no start sha. */
  resumed: boolean;
  /** A stop or hold arrived for it: nothing more is sent to it. */
  stopping: boolean;
  /** The handoff notes it had written when the first stop arrived; a stop asks again unless one came after. */
  handoffsAtStop: number | null;
  /** Its exit was dealt with: attempt.exited is reported once per process. */
  finished: boolean;
}

/** How an exit came about: the ladder step that ended it, and the runner's own cause. */
interface ExitContext {
  stoppedBy: StoppedBy;
  cause: ExitCause | null;
  /** The runner asked for the exit; an unrequested one is killed and swept before the harvest (X-15). */
  requested: boolean;
}

/** What the final work harvested, noted as soon as it is known: what a failure after the harvest still has. */
interface Harvested {
  /** What a push carries. */
  sha: string | null;
  /** The clone's committed work, which a take-over's new .git starts at. */
  head: string | null;
}

/**
 * The final work's part of attempt.exited, and what still has to go to a late-work ref. Work unchanged since the last
 * push, or since the start when none was pushed, gives that work as finalSha (the start's sha then), the last push or
 * null as finalWip, no pushError and nothing late: finalWip null with pushError null is no work left behind.
 */
interface FinalWork {
  finalSha: string | null;
  finalWip: { ref: string; sha: string } | null;
  pushError: string | null;
  late: { sha: string; now: boolean } | null;
}

export type StartOutcome = { started: true } | { started: false; refused: StartRefusal | null; error: string };

/**
 * What a WIP push did: pushed; unchanged since the last push; held in the vault (canPushWip forbade it); failed
 * (reported as attempt.wip_failed); skipped, for an attempt with no WIP (a lead) or no clone.
 */
export type WipOutcome =
  | { status: 'pushed'; ref: string; sha: string }
  | { status: 'unchanged' }
  | { status: 'held'; sha: string }
  | { status: 'failed'; error: string }
  | { status: 'skipped' };

/** What deliver and interrupt give: done, or why not (a fence that is not the attempt's, or no live agent). */
export type LiveOutcome = { ok: true } | { ok: false; error: 'stale_fence' | 'not_running' };

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether the agent wrote a handoff note after its first stop arrived: an older one does not spare the handoff turn. */
function handoffSinceStop(live: LiveAgent): boolean {
  return live.pump.handoffs > (live.handoffsAtStop ?? live.pump.handoffs);
}

/** Runs one step of a start, its error prefixed with what failed. */
async function startStep<T>(what: string, step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    throw new Error(`${what}: ${describe(error)}`);
  }
}

export class AttemptController {
  private currentFence: Fence | null = null;
  private currentPhase: AttemptPhase | null = null;
  private prepared: PreparedWorkspace | null = null;
  private live: LiveAgent | null = null;
  /** The last start's or resume's spec, without its token. */
  private current: Omit<AttemptSpec, 'agentToken'> | null = null;
  private readonly standing: WipStanding = { fenced: false, ended: false, exited: false };
  /** The work the WIP ref holds as last pushed: its tree, and its head when known. */
  private lastWork: { head: string | null; tree: string } | null = null;
  /** A harvest canPushWip held back, pushed after the next welcome. */
  private heldWork: WorkResult | null = null;
  /** The clone the WIP pushes harvest: the last start's or resume's, from the moment it is opened. */
  private cloneDir: string | null = null;
  /** Work whose WIP push failed as remote: the server may still have applied it (adoptLanded). */
  private unconfirmed: WorkResult | null = null;
  /** Harvest warnings already reported as notes. */
  private readonly warned = new Set<string>();
  /**
   * A harvest failed since the last one that worked: a clone that keeps failing is reported once, not every tick,
   * however git words the failure each time.
   */
  private harvestFailing = false;
  /** Protected paths already reported as violations. */
  private readonly reported = new Set<string>();
  private wipTimer: ReturnType<typeof setInterval> | null = null;
  private late: LateWorkRetries | null = null;
  /** Stops, holds and resumes that arrived so far; a submission's retries end when it moves. */
  private stopsArrived = 0;
  private readonly stopListeners = new Set<() => void>();

  constructor(
    readonly attemptId: string,
    private readonly deps: ControllerDeps,
  ) {}

  /** The attempt's fence: its spec's, then each resume's; null before a start. */
  get fence(): Fence | null {
    return this.currentFence;
  }

  /** The phase AttemptFacts reports; null before a start. */
  get phase(): AttemptPhase | null {
    return this.currentPhase;
  }

  /**
   * Whether the attempt holds a capacity slot: from the moment its start passes the core's checks, through its live
   * process, until its exit. The runtime counts these for every other controller's admission.
   */
  get holdsSlot(): boolean {
    return this.currentPhase !== null;
  }

  /** The clone the last start prepared; null before one. */
  get workspace(): PreparedWorkspace | null {
    return this.prepared;
  }

  /** The live agent's session; null when no process runs. */
  get session(): AgentSession | null {
    return this.live?.session ?? null;
  }

  /** The facts the next heartbeat carries; null when no process runs. */
  facts(): AttemptFacts | null {
    return this.live?.facts.facts() ?? null;
  }

  /** Runs a job on this attempt's serial queue. */
  enqueue<T>(job: () => Promise<T>): Promise<T> {
    return this.deps.queue.run(this.attemptId, job);
  }

  /** Resolves once the queued jobs and the live agent's events have all been dealt with. */
  async settled(): Promise<void> {
    for (;;) {
      await this.deps.queue.idle(this.attemptId);
      const live = this.live;
      if (live === null) return;
      await live.done;
      if (this.live === live) return;
    }
  }

  /** Stops the controller's timers: the WIP timer and the late-work retries. */
  close(): void {
    this.stopWipTimer();
    this.late?.cancel();
    this.late = null;
  }

  /**
   * After a restart (the runtime calls it at the first welcome): late work a previous run left pending, as its record's
   * lateWorkSha names it, is retried until it lands, as the exit's retries were. The attempt has exited, so its WIP
   * ref is never pushed again. Does nothing when nothing is pending or the retries already run.
   */
  resumeLateWork(): void {
    const record = this.deps.store.get(this.attemptId);
    if (record === null || record.lateWorkSha === null || this.late !== null) return;
    this.current ??= record.spec;
    this.currentFence ??= record.fence;
    this.standing.exited = true;
    this.startLateWork(record.lateWorkSha, true);
  }

  /** deliver: the messages go to the live agent at once, in order, with one line about `more` (X-4). */
  async deliver(command: { fence: Fence; messages: InjectedMessage[]; more: number }): Promise<LiveOutcome> {
    const live = this.liveAt(command.fence);
    if (!('pump' in live)) return live;
    await live.pump.deliver(command.messages, command.more);
    return { ok: true };
  }

  /**
   * The plain interrupt; queued messages still run. With a fence it is the hub's interrupt command (the Agents view's
   * Interrupt); without one, the runner's own. outage marks a running turn as ended by an outage (needs_login), so
   * the agent gets the one nudge after the next welcome (X-38).
   */
  async interrupt(command: { fence?: Fence; outage?: boolean }): Promise<LiveOutcome> {
    const live = command.fence === undefined ? this.live : this.liveAt(command.fence);
    if (live === null) return { ok: false, error: 'not_running' };
    if (!('pump' in live)) return live;
    if (command.outage) await live.policy.interruptForOutage();
    else await live.session.interrupt();
    return { ok: true };
  }

  /**
   * decide_approval, answered at once: applied is false for a fence that is not the attempt's, an agent that is
   * gone, or a request that was answered or voided.
   */
  async decideApproval(command: {
    fence: Fence;
    approvalId: string;
    decision: 'approve' | 'decline';
    reason: string | null;
  }): Promise<{ applied: boolean }> {
    const live = this.liveAt(command.fence);
    if (!('pump' in live)) return { applied: false };
    return { applied: await live.pump.answer(command.approvalId, command.decision, command.reason) };
  }

  /**
   * stop_attempt (design 6.8): the interrupt when a tool is in flight or interruptFirst is set, the handoff turn when
   * asked for, then the stop ladder and the exit work. keepClone needs nothing here: a stop never removes the clone or
   * the session, cleanup_attempt does.
   */
  stop(command: {
    fence: Fence;
    reason: string;
    handoff: boolean;
    interruptFirst: boolean;
    keepClone: boolean;
  }): Promise<StopOutcome> {
    const { fence, reason, handoff, interruptFirst } = command;
    if (this.isCurrentFence(fence)) this.stopArriving();
    return this.enqueue(async () => {
      const live = this.liveAt(fence);
      if (!('pump' in live)) return live;
      return this.stopLive(live, { handoff, interruptFirst, reason, cause: null });
    });
  }

  /**
   * hold_attempt (design 6.13): no further continuation; the running turn may end by itself, for at most hold, so the
   * agent sees its submit's result; then the agent is stopped without a handoff turn, its WIP pushed, and its clone
   * and session kept.
   */
  hold(command: { fence: Fence }): Promise<StopOutcome> {
    if (this.isCurrentFence(command.fence)) this.stopArriving();
    return this.enqueue(async () => {
      const live = this.liveAt(command.fence);
      if (!('pump' in live)) return live;
      live.stopping = true;
      await boundedWait(live.watch.turnEnded(), this.deps.config().timings.hold);
      return this.stopLive(live, { handoff: false, interruptFirst: false, reason: 'the attempt is held', cause: null });
    });
  }

  /**
   * The runner's own stops (X-7, X-41): runner_stop with a handoff turn (agflow runner stop and uninstall) or without
   * one (the disk and battery guards), and suspend, which records the attempt as suspended. The exit reports cause.
   */
  stopForRunner(cause: ExitCause, options: { handoff: boolean }): Promise<StopOutcome> {
    this.stopArriving();
    return this.enqueue(async () => {
      const live = this.live;
      if (live === null) return { ok: false, error: 'not_running' };
      const { handoff } = options;
      return this.stopLive(live, { handoff, interruptFirst: false, reason: RUNNER_STOP_REASON, cause });
    });
  }

  /**
   * resume_attempt: a live process is stopped first, without a handoff turn, its work pushed; then the clone the
   * attempt has is prepared again and its session resumed with the new fence and token, the CLI version it started
   * with, and the prompt and messages after it. A command with an older fence is refused; one with the current fence
   * and a live process is done already.
   */
  resume(command: ResumeInput): Promise<ResumeOutcome> {
    if (this.currentFence === null || compareFence(command.fence, this.currentFence) > 0) this.stopArriving();
    return this.enqueue(async () => {
      const record = this.deps.store.get(this.attemptId);
      const current = this.currentFence ?? record?.fence ?? null;
      if (current !== null && compareFence(command.fence, current) < 0) return { resumed: false, error: 'stale_fence' };
      const same = current !== null && compareFence(command.fence, current) === 0;
      if (this.live !== null && same) return { resumed: true };
      if (record === null) {
        const failed = this.failedToStart(command.fence, `${this.attemptId} has no record on this runner`);
        return { resumed: false, error: failed.error };
      }
      if (this.live !== null) {
        const options = { handoff: false, interruptFirst: false, reason: RESUME_STOP_REASON, cause: null };
        await this.stopLive(this.live, options);
      }
      const spec = resumedSpec(record.spec, command);
      this.currentFence = spec.fence;
      this.currentPhase = 'starting';
      const { agentToken: _token, ...stored } = spec;
      this.current = stored;
      this.standing.fenced = false;
      this.standing.exited = false;
      this.prepared = null;
      this.cloneDir = null;
      this.deps.store.update(this.attemptId, { spec: stored, fence: spec.fence, state: 'starting', finalizedAt: null });
      try {
        await this.resumeAdmitted(spec, record, command);
        return { resumed: true };
      } catch (error) {
        // The clone's work goes out before the failure is reported, under the new fence.
        await this.releaseBaseCheckout();
        await this.wipJob().catch((pushError) => {
          this.deps.logger.warn('cannot push the work of a failed resume', {
            attemptId: this.attemptId,
            error: describe(pushError),
          });
        });
        const failed = this.failedToStart(spec.fence, describe(error));
        return { resumed: false, error: failed.error };
      }
    });
  }

  /**
   * push_submission (design 6.13): only to the attempt's own task branch; the clone harvested and refused when dirty
   * or with protected changes; then the task branch and the WIP ref together, remote failures retried until
   * submitRetry passes or a stop or hold arrives. The outcome is reported as attempt.submitted and given back.
   */
  submit(command: SubmitCommand): Promise<SubmitResult> {
    // A stop that arrives while the submission still waits on the queue ends its retries too.
    const stops = this.stopsArrived;
    return this.enqueue(async () => {
      const record = this.deps.store.get(this.attemptId);
      const spec = this.current ?? record?.spec ?? null;
      const fence = this.currentFence ?? record?.fence ?? null;
      if (spec === null || fence === null || compareFence(command.fence, fence) !== 0) {
        return { ok: false, error: 'stale_fence' };
      }
      if (!isOwnBranch(spec, command.branch)) {
        this.report(fence, { type: 'attempt.violation', data: { phase: 'submit', paths: [command.branch] } });
        return { ok: false, error: 'branch_refused' };
      }
      const outcome = await this.submission(spec, command, record?.clone ?? null, stops);
      this.report(fence, { type: 'attempt.submitted', data: outcome });
      return { ok: true, outcome };
    });
  }

  /**
   * prepare_takeover (design 6.12): the live agent is interrupted, asked for a handoff note and stopped; then, or at
   * once for an agent that is gone (a command resent after a restart), the WIP is harvested and pushed, the protected
   * paths restored, the clone's .git replaced with one the runner builds, and attempt.taken_over reported in place of
   * attempt.exited. A failure after the stop still reports attempt.taken_over, with local null and the error.
   */
  prepareTakeover(command: { fence: Fence; person: string }): Promise<TakeoverOutcome> {
    if (this.isCurrentFence(command.fence)) this.stopArriving();
    return this.enqueue(async () => {
      const record = this.deps.store.get(this.attemptId);
      const fence = this.currentFence ?? record?.fence ?? null;
      if (record === null || fence === null || compareFence(command.fence, fence) !== 0) {
        return { ok: false, error: 'stale_fence' };
      }
      const spec = this.current ?? record.spec;
      const { taskId, branch, wipRef } = spec;
      if (spec.role !== 'worker' || taskId === null || branch === null || wipRef === null) {
        return { ok: false, error: 'not_running' };
      }
      // A controller made after a restart knows the attempt only from its record.
      this.currentFence = fence;
      this.current = spec;
      const clone = this.cloneDir ?? record.clone;
      const harvested: Harvested = { sha: null, head: null };
      const final = await this.stopForTakeover(clone, harvested);
      let local: LocalCommandInput | null = null;
      let error = final.pushError;
      try {
        local = await this.handOver({ spec, clone, head: harvested.head, failure: final.pushError });
      } catch (failure) {
        this.deps.logger.error('the take-over failed', { attemptId: this.attemptId, error: describe(failure) });
        error = describe(failure);
      }
      const commands = takeoverCommands({
        local,
        wipRefPrefix: this.deps.wipRefPrefix(),
        taskId,
        wipRef,
        branch,
        person: command.person,
      });
      if (local !== null && commands.local === null) {
        error = 'the agent never started a session, so there is none to resume';
      }
      const takenOverSeq = this.report(fence, {
        type: 'attempt.taken_over',
        data: {
          commands,
          wipSha: final.finalWip?.sha ?? null,
          error: error === null ? null : clipPushError(error),
        },
      });
      return { ok: true, takenOverSeq };
    });
  }

  /**
   * cleanup_attempt (design 6.4, 7.8): a live process is stopped with the ladder first. The clone's work that is not
   * yet on the origin goes to a new late-work ref before anything is deleted; a push that fails keeps everything and
   * gives the reason. Then the transcript tail is uploaded, the attempt's files and pins removed, and the record kept
   * with endedAt and no clone. A cleanup that already ran answers ok.
   */
  cleanup(): Promise<CleanupOutcome> {
    this.stopArriving();
    return this.enqueue(() => this.cleanupJob({ saveWork: true }));
  }

  /**
   * hand_back (design 6.12, X-37): with the clone source, the runner-home Codex daemon is stopped, a process still in
   * the clone refuses the hand-back with its pids, and otherwise the clone's work, harvested and stripped like a
   * WIP, goes to a new late-work ref, reported as attempt.handed_back, before the attempt is cleaned up. A ref source
   * only fetches the ref into the vault (X-2).
   */
  handBack(command: { source: HandBackSource }): Promise<HandBackOutcome> {
    return this.enqueue(async () => {
      const record = this.deps.store.get(this.attemptId);
      if (record === null) return { ok: false, error: `${this.attemptId} has no record on this runner` };
      this.current ??= record.spec;
      this.currentFence ??= record.fence;
      const spec = this.current;
      const { source } = command;
      if (source.kind === 'ref') return this.fetchHandedBackRef(spec, source.ref);
      const { taskId, branch } = spec;
      if (spec.role !== 'worker' || taskId === null || branch === null) {
        return { ok: false, error: `${this.attemptId} is not a task attempt` };
      }
      const clone = record.clone;
      if (clone === null || !cloneExists(clone)) return { ok: false, error: `the clone of ${this.attemptId} is gone` };
      await this.stopRunnerCodexDaemon(record);
      const found = await findCloneProcesses(clone);
      if (found.skipped !== null) {
        // A clone someone may still be writing to is never harvested and removed unchecked.
        const error = `cannot look for processes in the clone: ${found.skipped}`;
        this.deps.logger.warn('cannot look for processes in the clone', { attemptId: this.attemptId, error });
        this.note(`hand-back refused: ${error}`);
        return { ok: false, error: clipPushError(error) };
      }
      if (found.processes.length > 0) {
        const pids = found.processes.map((row) => row.pid);
        this.note(processRunningNote(pids));
        return { ok: false, error: 'process_running', pids };
      }
      let work: WorkResult;
      try {
        work = await this.collect(spec, clone, branch);
      } catch (error) {
        return { ok: false, error: clipPushError(`cannot harvest the clone: ${describe(error)}`) };
      }
      // Every path stripped from the person's work, whatever the agent's pushes reported before: their feedback.
      const fence = this.currentFence ?? spec.fence;
      if (work.stripped.length > 0) {
        const paths = clipViolationPaths(work.stripped);
        this.report(fence, { type: 'attempt.violation', data: { phase: 'wip', paths } });
      }
      const { vault, local, store } = this.deps;
      let pushed: Awaited<ReturnType<typeof pushLateWork>>;
      try {
        pushed = await pushLateWork({
          vault,
          local,
          remote: await this.deps.remote(),
          wipRefPrefix: this.deps.wipRefPrefix(),
          attemptId: this.attemptId,
          sha: work.sha,
        });
      } catch (error) {
        pushed = { ok: false, error: 'remote', detail: describe(error) };
      }
      if (!pushed.ok) return { ok: false, error: clipPushError(`cannot push the hand-back: ${pushed.detail}`) };
      // The person's work holds the agent's: late work of the agent still pending is settled with it, whatever the
      // cleanup below does, so no later run pushes that older work after the hand-back.
      this.late?.cancel();
      this.late = null;
      store.update(this.attemptId, { lateWorkCount: pushed.n, lateWorkSha: null, pushError: null });
      const handedBack = { ref: pushed.ref, sha: work.sha };
      this.report(fence, { type: 'attempt.handed_back', data: handedBack });
      // The hand-back stands whatever the cleanup does; a cleanup that fails is resent by the hub as any other.
      const cleaned = await this.cleanupJob({ saveWork: false });
      if (!cleaned.ok) {
        this.deps.logger.warn('cannot clean up after a hand-back', { attemptId: this.attemptId, error: cleaned.error });
      }
      return { ok: true, handedBack };
    });
  }

  /**
   * A cleanup's work, inside a job: a live process stopped with the ladder, the pending late work pushed and the
   * clone's work saved as late work when saveWork is set, the transcript tail uploaded, and the attempt's files
   * removed.
   */
  private async cleanupJob(options: { saveWork: boolean }): Promise<CleanupOutcome> {
    // The hub queues a cleanup only as it ends the attempt (design 6.4), so its WIP ref never moves again (7.3): a
    // live process's final work is refused there, and saved below as late work.
    this.markEnded();
    if (this.live !== null) {
      const stop = { handoff: false, interruptFirst: false, reason: CLEANUP_STOP_REASON, cause: null };
      await this.stopLive(this.live, stop);
    }
    if (options.saveWork) {
      const pending = await this.pushPendingLateWork();
      if (!pending.ok) return pending;
    }
    const record = this.deps.store.get(this.attemptId);
    if (record === null) return { ok: true };
    this.current ??= record.spec;
    // The exit's late-work retries end here: the cleanup pushes what is left itself, or keeps the clone.
    this.late?.cancel();
    this.late = null;
    const clone = record.clone !== null && cloneExists(record.clone) ? record.clone : null;
    if (clone !== null) {
      if (options.saveWork) {
        const saved = await this.saveLateWork(record.spec, clone, record.lateWorkCount);
        if (!saved.ok) return saved;
      }
      await this.uploadTail(record.spec.vendor, record.sessionRef, clone);
    }
    return this.removeAttempt(record);
  }

  /** A ref hand-back, which protocol-1 hubs never send: the ref fetched into the vault, and no event (X-2). */
  private async fetchHandedBackRef(spec: Omit<AttemptSpec, 'agentToken'>, ref: string): Promise<HandBackOutcome> {
    if (spec.taskId === null) return { ok: false, error: `${this.attemptId} is not a task attempt` };
    try {
      await this.deps.vault.refresh(spec.taskId, [ref], this.deps.wipRefPrefix());
      return { ok: true, handedBack: null };
    } catch (error) {
      return { ok: false, error: clipPushError(`cannot fetch ${ref}: ${describe(error)}`) };
    }
  }

  /**
   * Stops the Codex daemon of the runner's Codex home with the runner's own codex: the attempt's version for a Codex
   * attempt, the current pin otherwise. No pin for this platform, or any failure, is only logged.
   */
  private async stopRunnerCodexDaemon(record: AttemptRecord): Promise<void> {
    const { paths, config, logger } = this.deps;
    let version: string;
    try {
      version = (record.spec.vendor === 'codex' ? record.cliVersion : null) ?? this.deps.cliVersion('codex');
    } catch (error) {
      logger.warn('cannot stop the Codex daemon', { attemptId: this.attemptId, error: describe(error) });
      return;
    }
    await stopCodexDaemon({
      binary: join(paths.runner, vendorBinary('codex', version)),
      home: vendorHomes(config(), paths).codex,
      env: { PATH: config().capturedPath, HOME: paths.homes.codexUser },
    });
  }

  /** upload_transcript (design 6.3): the tail of the attempt's session, read without a live one, posted to the hub. */
  uploadTranscript(): Promise<{ uploaded: boolean }> {
    return this.enqueue(async () => {
      const record = this.deps.store.get(this.attemptId);
      const sessionRef = this.live?.session.sessionRef ?? record?.sessionRef ?? null;
      const clone = this.cloneDir ?? record?.clone ?? null;
      const vendor = (this.current ?? record?.spec)?.vendor;
      if (sessionRef === null || clone === null || vendor === undefined) return { uploaded: false };
      return { uploaded: await this.uploadTail(vendor, sessionRef, clone) };
    });
  }

  /** The hub told the runner the attempt's fence is no longer current: its WIP ref is not pushed again. */
  markFenced(): void {
    this.standing.fenced = true;
  }

  /** The hub ended the attempt (welcome.stop): its WIP ref is not pushed again, and the record says so. */
  markEnded(): void {
    this.standing.ended = true;
    const record = this.deps.store.get(this.attemptId);
    if (record !== null && record.endedAt === null) this.deps.store.update(this.attemptId, { endedAt: Date.now() });
  }

  /** Harvests the clone and pushes its work to the WIP ref if it changed, on the serial queue. */
  pushWip(): Promise<WipOutcome> {
    return this.enqueue(() => this.wipJob());
  }

  /**
   * After each welcome: an agent whose turn ended because of the outage gets its one nudge at once, and a harvest
   * held back while canPushWip failed is pushed.
   */
  async onWelcome(): Promise<void> {
    await this.live?.policy.onWelcome();
    return this.enqueue(async () => {
      const held = this.heldWork;
      const spec = this.current;
      if (held !== null && spec !== null) await this.pushWork(spec, held);
    });
  }

  /**
   * Whether a command's fence is the attempt's: its current one, or its record's before a start. Only such a stop or
   * hold counts as arrived before its turn on the queue; a stale one is refused there and changes nothing.
   */
  private isCurrentFence(fence: Fence): boolean {
    const current = this.currentFence ?? this.deps.store.get(this.attemptId)?.fence ?? null;
    return current !== null && compareFence(fence, current) === 0;
  }

  /** The live agent, when the fence is the attempt's current one. */
  private liveAt(fence: Fence): LiveAgent | Extract<LiveOutcome, { ok: false }> {
    if (this.currentFence === null || compareFence(fence, this.currentFence) !== 0) {
      return { ok: false, error: 'stale_fence' };
    }
    return this.live ?? { ok: false, error: 'not_running' };
  }

  /** start_attempt: admission first; a refused start reports attempt.failed_to_start and starts nothing. */
  start(spec: AttemptSpec): Promise<StartOutcome> {
    return this.enqueue(async () => {
      const refusal = await this.admit(spec);
      if (refusal !== null) {
        const data = { error: refusal.error, refused: refusal.code };
        this.report(spec.fence, { type: 'attempt.failed_to_start', data });
        return { started: false, refused: refusal.code, error: refusal.error };
      }
      this.currentFence = spec.fence;
      this.currentPhase = 'starting';
      const { agentToken: _token, ...current } = spec;
      this.current = current;
      this.standing.exited = false;
      this.prepared = null;
      this.cloneDir = null;
      try {
        await this.startAdmitted(spec);
        return { started: true };
      } catch (error) {
        // Whatever failed, the start gives back what it took, and the hub hears once why.
        await this.releaseBaseCheckout();
        return this.failedToStart(spec.fence, describe(error));
      }
    });
  }

  /**
   * A resume's work after the stop: the clone the attempt has, prepared as for a start, the dependencies and the
   * project config, then the session resumed and the prompt and messages sent; throws on a failure.
   */
  private async resumeAdmitted(spec: AttemptSpec, record: AttemptRecord, command: ResumeInput): Promise<void> {
    const { store } = this.deps;
    const workspace = await startStep('cannot prepare the clone', () => prepareWorkspace(this.deps, spec, reopenClone));
    this.prepared = workspace;
    this.cloneDir = workspace.clone;
    store.update(spec.attemptId, { clone: workspace.clone, tmpDir: workspace.tmpDir });
    const fresh = workspace.violations.filter((path) => !this.reported.has(path));
    if (fresh.length > 0) {
      const listed = clipViolationPaths(fresh);
      this.report(spec.fence, { type: 'attempt.violation', data: { phase: 'start', paths: listed } });
      for (const path of fresh) this.reported.add(path);
    }
    await this.recallPushedWork(workspace.startSha);
    const prep = await this.prepareDependencies(spec, workspace);
    if (prep.error !== null) throw new Error(`dependency preparation failed: ${prep.error}`);
    await startStep('cannot verify the clone', () =>
      finishWorkspace(this.deps, spec, workspace, { prepared: prep.ran }),
    );
    // The version that wrote the session (X-13); one the record lacks is the pin's, recorded now.
    const cliVersion = record.cliVersion ?? this.deps.cliVersion(spec.vendor);
    if (record.cliVersion === null) store.update(spec.attemptId, { cliVersion });
    const resume = record.sessionRef === null ? null : { sessionRef: record.sessionRef };
    await startStep('cannot resume the agent', () =>
      this.launchAgent(spec, workspace, { cliVersion, resume, resumed: true }),
    );
    const live = this.live;
    if (live === null) return;
    const { prompt } = command;
    const sending = (async () => {
      if (prompt !== '') await live.session.send({ id: randomUUID(), text: prompt, authority: 'system' });
      await live.pump.deliver(command.messages, 0);
    })();
    try {
      // Bounded, so an agent that takes no input never holds the attempt's queue.
      const sent = await boundedWait(sending, RESUME_SEND_MS);
      if (!sent.done) this.deps.logger.warn('the resume prompt was not taken in time', { attemptId: this.attemptId });
    } catch (error) {
      // The agent is gone already: its exit is dealt with as any other.
      this.deps.logger.warn('cannot send the resume prompt', { attemptId: this.attemptId, error: describe(error) });
    }
  }

  /** A submission's harvest, checks and push, inside its job; gives its outcome. */
  private async submission(
    spec: Omit<AttemptSpec, 'agentToken'>,
    command: SubmitCommand,
    recordedClone: string | null,
    stops: number,
  ): Promise<SubmittedData> {
    const { vault, local, logger, store, wipGate } = this.deps;
    const branch = command.branch;
    const refused = (fields: Pick<SubmittedData, 'error' | 'detail'> & Partial<SubmittedData>): SubmittedData => ({
      submissionId: command.submissionId,
      ok: false,
      headSha: null,
      remoteHead: null,
      ...fields,
    });
    const clone = this.prepared?.clone ?? recordedClone;
    if (clone === null) return refused({ error: 'remote', detail: 'the attempt has no clone on this runner' });
    // main as it is now, for the advice on protected paths; a fetch that fails leaves the vault's.
    await vault.fetchForAttempt({ taskId: spec.taskId, start: spec.start }, this.deps.wipRefPrefix()).catch((error) => {
      logger.warn('cannot fetch the vault before a submission', { attemptId: this.attemptId, error: describe(error) });
    });
    let work: WorkResult;
    try {
      work = await this.collect(spec, clone, branch);
    } catch (error) {
      return refused({ error: 'remote', detail: `cannot harvest the clone: ${describe(error)}` });
    }
    const headSha = work.head;
    // Every skipped file is an uncommitted change the snapshot left out: the submission would go without it.
    const dirty = [...new Set([...work.uncommitted, ...work.skipped])].sort();
    if (dirty.length > 0) return refused({ error: 'dirty', headSha, detail: dirtyDetail(dirty) });
    let sha = work.sha;
    let tree = work.tree;
    if (work.stripped.length > 0) {
      const restoreBase = await resolveRestoreBase(vault, spec);
      const base = await submissionBase({ vault, local, restoreBase, head: work.head });
      const paths =
        base === restoreBase
          ? work.stripped
          : (await detectProtected({ vault, local }, { base, head: work.head, paths: spec.restore.paths })).map(
              (change) => change.path,
            );
      if (paths.length > 0) {
        const detail = await protectedDetail({ vault, local, base, paths });
        return refused({ error: 'protected_paths', headSha, detail });
      }
      // The branch merged main and carries main's own versions: it goes as it is, not stripped back to the start.
      sha = work.head;
      tree = (await runGit(local, [`--git-dir=${vault.path}`, 'rev-parse', `${sha}^{tree}`])).stdout.trim();
    }
    const wipRef = spec.wipRef as string;
    const settled = () => this.standing.fenced || this.standing.ended || this.standing.exited;
    const pushed = await pushSubmissionWithRetries({
      budgetMs: this.deps.config().timings.submitRetry,
      interrupted: () => this.stopsArrived !== stops,
      stopArrived: () => this.nextStop(),
      // Only the link's gate clears by itself; a fenced, ended or exited attempt never pushes again.
      retryable: () => !settled(),
      onRetry: (outcome, delayMs) => {
        const { detail } = outcome;
        logger.warn('a submission push failed; retrying', { attemptId: this.attemptId, delayMs, detail });
      },
      push: async (): Promise<SubmitPushOutcome> => {
        const notNow = wipRefusal(wipGate, this.standing);
        if (notNow !== null) return { ok: false, headSha, remoteHead: null, error: 'remote', detail: notNow };
        try {
          return await pushSubmission({
            vault,
            local,
            remote: await this.deps.remote(),
            taskId: spec.taskId as string,
            wipRefPrefix: this.deps.wipRefPrefix(),
            branch,
            wipRef,
            sha,
            expectedBranchSha: command.expectedBranchSha,
            previousWip: store.get(this.attemptId)?.pushedSha ?? null,
            adoptable: command.adoptable,
          });
        } catch (error) {
          return { ok: false, headSha, remoteHead: null, error: 'remote', detail: describe(error) };
        }
      },
    });
    if (pushed === 'interrupted') {
      return refused({ error: 'interrupted', headSha, detail: 'a stop or hold arrived while the push was retried' });
    }
    if (pushed.ok) {
      store.update(this.attemptId, { wipSha: sha, pushedSha: sha, lastPushAt: Date.now() });
      this.lastWork = { head: work.head, tree };
      this.heldWork = null;
      this.deps.wipFailures.succeeded();
    }
    const { ok, remoteHead, error, detail } = pushed;
    return { submissionId: command.submissionId, ok, headSha, remoteHead, error, detail };
  }

  /** Resolves when the next stop, hold or resume arrives. */
  private nextStop(): Promise<void> {
    return new Promise<void>((resolve) => {
      const listener = () => {
        this.stopListeners.delete(listener);
        resolve();
      };
      this.stopListeners.add(listener);
    });
  }

  /** Releases the base checkout of a start that failed; a failure is only logged. */
  private async releaseBaseCheckout(): Promise<void> {
    try {
      await this.prepared?.baseCheckout?.release();
    } catch (error) {
      this.deps.logger.warn('cannot release a base checkout', { attemptId: this.attemptId, error: describe(error) });
    }
  }

  /** An admitted start's work: the clone, the dependencies, the project config and the agent; throws on a failure. */
  private async startAdmitted(spec: AttemptSpec): Promise<void> {
    const { store, paths, vault } = this.deps;
    if (store.get(spec.attemptId) === null) {
      store.create(spec, { clone: paths.clone(vault.project, spec.attemptId), tmpDir: null, cliVersion: null });
    } else {
      store.update(spec.attemptId, { finalizedAt: null });
    }
    const opened = await startStep('cannot prepare the clone', () => openWorkspace(this.deps, spec));
    this.cloneDir = opened.clone;
    store.update(spec.attemptId, { clone: opened.clone });
    await this.recallPushedWork(opened.startSha);
    // An existing clone holds work from before: it is pushed as the agent left it, before anything in it is written
    // or restored, so its protected changes are stripped and reported.
    if (!opened.created) await this.wipJob();
    const workspace = await startStep('cannot prepare the clone', () => prepareOpened(this.deps, spec, opened));
    this.prepared = workspace;
    store.update(spec.attemptId, { clone: workspace.clone, tmpDir: workspace.tmpDir });
    const fresh = workspace.violations.filter((path) => !this.reported.has(path));
    if (fresh.length > 0) {
      const listed = clipViolationPaths(fresh);
      this.report(spec.fence, { type: 'attempt.violation', data: { phase: 'start', paths: listed } });
      for (const path of fresh) this.reported.add(path);
    }
    const prep = await this.prepareDependencies(spec, workspace);
    if (prep.error !== null) throw new Error(`dependency preparation failed: ${prep.error}`);
    await startStep('cannot verify the clone', () =>
      finishWorkspace(this.deps, spec, workspace, { prepared: prep.ran }),
    );
    const cliVersion = this.deps.cliVersion(spec.vendor);
    store.update(spec.attemptId, { cliVersion });
    await startStep('cannot start the agent', () =>
      this.launchAgent(spec, workspace, { cliVersion, resume: null, resumed: false }),
    );
  }

  /**
   * Starts the agent through its vendor's adapter, then follows its events. The facts tracker runs from the launch
   * on, and the process is recorded before the first event is read.
   */
  private async launchAgent(
    spec: AttemptSpec,
    workspace: PreparedWorkspace,
    options: { cliVersion: string; resume: AgentLaunch['resume']; resumed: boolean },
  ): Promise<void> {
    const { store, logger, config, paths, agflow, local, vault } = this.deps;
    const adapter = this.deps.adapters.get(spec.vendor);
    if (!adapter) throw new Error(`no ${spec.vendor} adapter on this runner`);
    const registration = new ProcessRegistration(store, spec.attemptId, workspace.clone, logger, this.deps.identify);
    const launch = buildLaunch({
      spec,
      workspace,
      config: config(),
      paths,
      agflow,
      cliVersion: options.cliVersion,
      resume: options.resume,
      registration,
    });
    const factsDir = await mkdtemp(join(tmpdir(), 'agflow-facts-'));
    let session: AgentSession;
    try {
      session = await adapter.start(launch);
    } catch (error) {
      await rm(factsDir, { recursive: true, force: true });
      throw error;
    }
    const facts = new FactsTracker({
      attemptId: spec.attemptId,
      fence: spec.fence,
      clone: workspace.clone,
      toolCaps: spec.toolCaps,
      clock: this.deps.clock,
      phase: 'starting',
      fingerprint: () =>
        diffFingerprint({
          vault,
          local,
          clone: workspace.clone,
          startSha: workspace.startSha,
          index: join(factsDir, 'index'),
        }),
    });
    await facts.start();
    const pump = new EventPump({
      spec,
      session,
      adapter,
      store,
      notifier: this.deps.notifier,
      logger,
      clone: workspace.clone,
      vault: vault.path,
      startSha: workspace.startSha,
      report: (event) => this.report(this.currentFence ?? spec.fence, event),
      setPhase: (phase) => this.setPhase(phase),
      root: () => registration.recorded(),
      firstOutputReported: options.resume !== null,
    });
    const watch = new TurnWatch();
    const live: LiveAgent = {
      spec,
      workspace,
      launch,
      session,
      registration,
      facts,
      pump,
      watch,
      policy: new TurnPolicy({
        attemptId: spec.attemptId,
        spec: () => this.current ?? spec,
        session,
        inTurn: () => watch.inTurn,
        stopping: () => live.stopping,
        linkUp: () => this.deps.linkUp(),
        allowPaidUsage: () => config().allowPaidUsage[spec.vendor],
        timings: () => config().timings,
        setPhase: (phase) => this.setPhase(phase),
        report: (event) => this.report(this.currentFence ?? spec.fence, event),
        continuationSent: () => facts.continuationSent(),
        logger,
      }),
      factsDir,
      events: Promise.resolve(),
      done: Promise.resolve(),
      resumed: options.resumed,
      stopping: false,
      handoffsAtStop: null,
      finished: false,
    };
    this.live = live;
    live.done = this.follow(live).catch((error) => {
      logger.error('following the agent failed', { attemptId: this.attemptId, error: describe(error) });
    });
    if (spec.role === 'worker') {
      this.wipTimer = setInterval(() => {
        this.pushWip().catch((error) => {
          logger.error('a WIP push failed', { attemptId: this.attemptId, error: describe(error) });
        });
      }, config().timings.wip);
      this.wipTimer.unref?.();
    }
  }

  private stopWipTimer(): void {
    if (this.wipTimer !== null) clearInterval(this.wipTimer);
    this.wipTimer = null;
  }

  /** What the WIP ref holds as last pushed, so only changed work is pushed: the start, when nothing was pushed. */
  private async recallPushedWork(startSha: string): Promise<void> {
    const pushed = this.deps.store.get(this.attemptId)?.pushedSha ?? null;
    const sha = pushed ?? startSha;
    const { local, vault } = this.deps;
    const tree = await runGit(local, [`--git-dir=${vault.path}`, 'rev-parse', '--verify', '--quiet', `${sha}^{tree}`], {
      check: false,
    });
    this.lastWork = tree.code === 0 ? { head: pushed === null ? sha : null, tree: tree.stdout.trim() } : null;
  }

  /** A WIP push of the clone's work, inside a job of the serial queue. */
  private async wipJob(): Promise<WipOutcome> {
    const spec = this.current;
    const clone = this.cloneDir;
    if (spec === null || spec.role !== 'worker' || spec.branch === null || spec.wipRef === null || clone === null) {
      return { status: 'skipped' };
    }
    // A timer job queued behind the exit: the final push had the last word.
    if (this.standing.exited) return { status: 'skipped' };
    let work: WorkResult;
    try {
      work = await this.collect(spec, clone, spec.branch);
    } catch (error) {
      return this.harvestFailed(describe(error));
    }
    // Protected changes are reported whatever happens next: a change only there strips back to the pushed tree.
    this.reportViolations(work.stripped);
    const last = this.lastWork;
    if (last !== null && last.tree === work.tree && (last.head === null || last.head === work.head)) {
      return { status: 'unchanged' };
    }
    return this.pushWork(spec, work);
  }

  /**
   * collectWork with the attempt's processes paused while it reads the clone, as a second layer: the snapshot reads
   * every file itself, with links refused. Its warnings are reported as notes.
   */
  private async collect(spec: Omit<AttemptSpec, 'agentToken'>, clone: string, branch: string): Promise<WorkResult> {
    const { vault, local, paths, store } = this.deps;
    const groups = this.live === null ? [] : [...store.processes(this.attemptId), ...this.live.pump.groups()];
    const work = await withPausedGroups(groups, () =>
      collectWork({ vault, local, paths, clone, spec, branch, identity: this.deps.config().commitIdentity }),
    );
    this.harvestFailing = false;
    this.reportWarnings(work.warnings);
    return work;
  }

  /** Pushes harvested work to the WIP ref when canPushWip allows it, and holds it in the vault otherwise. */
  private async pushWork(spec: Omit<AttemptSpec, 'agentToken'>, work: WorkResult): Promise<WipOutcome> {
    const { store, wipGate } = this.deps;
    const ref = spec.wipRef;
    if (ref === null) return { status: 'skipped' };
    if (!canPushWip(wipGate, this.standing)) {
      this.heldWork = work;
      store.update(this.attemptId, { wipSha: work.sha });
      return { status: 'held', sha: work.sha };
    }
    await this.refreshVault(spec);
    let result = await this.tryWipPush(ref, work.sha);
    if (!result.ok && result.error === 'stale' && (await this.adoptLanded(spec, ref))) {
      result = await this.tryWipPush(ref, work.sha);
    }
    if (!result.ok) {
      this.heldWork = work;
      if (result.error === 'remote') this.unconfirmed = work;
      store.update(this.attemptId, { wipSha: work.sha });
      return this.wipFailed(`cannot push ${ref}: ${result.detail}`);
    }
    this.unconfirmed = null;
    await this.wipPushed(spec, ref, work);
    return { status: 'pushed', ref, sha: work.sha };
  }

  /**
   * Fetches main and the task's refs into the vault before a WIP push (design 7.3), so the agent's `git fetch origin
   * main` and logStat see main as it is. A failure is logged; the push runs, and reports its own failure.
   */
  private async refreshVault(spec: Omit<AttemptSpec, 'agentToken'>): Promise<void> {
    if (spec.taskId === null) return;
    try {
      await this.deps.vault.refresh(spec.taskId, [], this.deps.wipRefPrefix());
    } catch (error) {
      this.deps.logger.warn('cannot fetch the vault before a WIP push', {
        attemptId: this.attemptId,
        error: describe(error),
      });
    }
  }

  /** One push of the WIP ref to sha, leased on what it held as last pushed; a throw is a remote failure. */
  private async tryWipPush(ref: string, sha: string): Promise<PushResult> {
    const { store, vault, local } = this.deps;
    const previous = store.get(this.attemptId)?.pushedSha ?? null;
    try {
      return await pushWip({ vault, local, remote: await this.deps.remote(), ref, sha, previous });
    } catch (error) {
      return { ok: false, error: 'remote', refs: [], detail: describe(error) };
    }
  }

  /**
   * A stale lease after a WIP push that failed as remote (a timeout, say): the server may have applied that push
   * after all. When the remote's WIP ref holds its sha, it is the attempt's own push: adopted as pushed and reported,
   * never counted as a failure. Gives whether it was.
   */
  private async adoptLanded(spec: Omit<AttemptSpec, 'agentToken'>, ref: string): Promise<boolean> {
    const landed = this.unconfirmed;
    this.unconfirmed = null;
    if (landed === null) return false;
    const { vault, local } = this.deps;
    let heads: Map<string, string>;
    try {
      heads = await lsRemote({ vault, local, remote: await this.deps.remote() }, [ref]);
    } catch (error) {
      this.deps.logger.warn('cannot read the WIP ref after a stale lease', {
        attemptId: this.attemptId,
        error: describe(error),
      });
      return false;
    }
    if (heads.get(ref) !== landed.sha) return false;
    await this.wipPushed(spec, ref, landed);
    return true;
  }

  /**
   * A WIP push landed: attempt.wip, its agent-controlled lists clipped, then the record. A report the outbox refuses
   * leaves the record as it was, so the next tick pushes again (an idempotent '=') and reports again.
   */
  private async wipPushed(spec: Omit<AttemptSpec, 'agentToken'>, ref: string, work: WorkResult): Promise<void> {
    const { vault, local, store } = this.deps;
    this.report(this.currentFence ?? spec.fence, {
      type: 'attempt.wip',
      data: {
        ref,
        sha: work.sha,
        stripped: clipViolationPaths(work.stripped),
        skipped: clipViolationPaths(work.skipped),
        embedded: clipViolationPaths(work.embedded),
        logStat: await logStat({ vault, local, sha: work.sha }),
      },
    });
    store.update(this.attemptId, { wipSha: work.sha, pushedSha: work.sha, lastPushAt: Date.now() });
    this.heldWork = null;
    this.lastWork = { head: work.head, tree: work.tree };
    this.deps.wipFailures.succeeded();
  }

  /** attempt.violation phase wip for stripped paths not reported before, clipped. */
  private reportViolations(stripped: readonly string[]): void {
    const fresh = stripped.filter((path) => !this.reported.has(path));
    if (fresh.length === 0) return;
    for (const path of fresh) this.reported.add(path);
    const fence = this.currentFence ?? this.current?.fence;
    if (fence) {
      this.report(fence, { type: 'attempt.violation', data: { phase: 'wip', paths: clipViolationPaths(fresh) } });
    }
  }

  /** attempt.wip_failed, with the runner's consecutive failures over all its attempts. */
  private wipFailed(error: string): WipOutcome {
    const failures = this.deps.wipFailures.failed();
    const fence = this.currentFence ?? this.current?.fence;
    if (fence) this.report(fence, { type: 'attempt.wip_failed', data: { error, failures } });
    return { status: 'failed', error };
  }

  /**
   * A harvest that failed. The clone is the agent's, so this is no failed WIP push and never counts toward the
   * runner's failures (X-3), which would keep work from the whole runner: it is logged, and reported as a note once
   * until a harvest works again.
   */
  private harvestFailed(error: string): WipOutcome {
    const text = `cannot harvest the clone: ${error}`;
    this.deps.logger.warn('cannot harvest the clone', { attemptId: this.attemptId, error });
    if (!this.harvestFailing) {
      this.harvestFailing = true;
      this.note(text);
    }
    return { status: 'failed', error: text };
  }

  /** Each harvest warning (HEAD on another branch, say) logged and reported as a note, once. */
  private reportWarnings(warnings: readonly string[]): void {
    for (const warning of warnings) {
      if (this.warned.has(warning)) continue;
      this.warned.add(warning);
      this.deps.logger.warn('a harvest warning', { attemptId: this.attemptId, warning });
      this.note(warning);
    }
  }

  /** attempt.activity kind note, clipped as every summary is. */
  private note(text: string): void {
    const fence = this.currentFence ?? this.current?.fence;
    const summary = clip(text, ACTIVITY_SUMMARY_MAX);
    if (fence) this.report(fence, { type: 'attempt.activity', data: { kind: 'note', summary } });
  }

  /**
   * Reads the agent's events, once its process is recorded; once it has exited, deals with its exit. Its events are
   * waited for a bounded time after the exit, since an escaped process that inherited its pipes can hold them open:
   * the exit's kill and sweep end that process, and with it the events.
   */
  private async follow(live: LiveAgent): Promise<void> {
    await live.registration.recorded();
    live.events = this.readEvents(live);
    const exit = await live.session.exited;
    await boundedWait(live.events, EVENTS_AFTER_EXIT_MS);
    await this.enqueue(() => this.finishExit(live, exit, { stoppedBy: 'none', cause: null, requested: false }));
  }

  /**
   * Reads the agent's events until they end. An event the runner fails to handle is logged and the next one read,
   * so one bad event never ends supervision; events that fail to arrive have ended.
   */
  private async readEvents(live: LiveAgent): Promise<void> {
    const iterator = live.session.events[Symbol.asyncIterator]();
    try {
      for (;;) {
        let next: IteratorResult<AgentEvent>;
        try {
          next = await iterator.next();
        } catch (error) {
          this.deps.logger.error("the agent's events failed", { attemptId: this.attemptId, error: describe(error) });
          return;
        }
        // Events read after the exit was dealt with come from a process that still holds the agent's pipes: they
        // would report a dead attempt as live, or under a resumed process's fence.
        if (next.done || live.finished) return;
        const event = next.value;
        await this.guarded(event, () => live.facts.observe(event));
        await this.guarded(event, () => (event.type === 'started' ? this.spawned(live, event) : live.pump.handle(event)));
        await this.guarded(event, () => live.watch.observe(event));
        await this.guarded(event, () => live.policy.observe(event));
      }
    } finally {
      live.watch.end();
    }
  }

  /** Runs one step of an event's handling; a failure is logged, never thrown. */
  private async guarded(event: AgentEvent, step: () => void | Promise<void>): Promise<void> {
    try {
      await step();
    } catch (error) {
      const fields = { attemptId: this.attemptId, type: event.type, error: describe(error) };
      this.deps.logger.error('cannot handle an agent event', fields);
    }
  }

  /**
   * A stop or hold arrives: the live agent gets nothing more, and a submission retrying its push ends, even before
   * the stop's turn on the queue.
   */
  private stopArriving(): void {
    const live = this.live;
    if (live !== null) {
      live.stopping = true;
      live.handoffsAtStop ??= live.pump.handoffs;
    }
    this.stopsArrived += 1;
    for (const listener of [...this.stopListeners]) listener();
  }

  /** Prepares the live agent as the options say, runs the stop ladder, then the exit work. */
  private async stopLive(live: LiveAgent, options: StopOptions): Promise<StopOutcome> {
    live.stopping = true;
    live.handoffsAtStop ??= live.pump.handoffs;
    const { timings } = this.deps.config();
    await prepareForStop({
      session: live.session,
      watch: live.watch,
      toolInFlight: () => live.pump.toolInFlight,
      handoffWritten: () => handoffSinceStop(live),
      options,
      interruptMs: timings.stopInterrupt,
      handoffMs: this.deps.handoffMs(),
    });
    this.setPhase('stopping');
    const ladder = await runStopLadder({
      session: live.session,
      turnEnded: () => live.watch.turnEnded(),
      groups: () => this.groupsOf(live),
      clone: live.workspace.clone,
      timings,
    });
    await boundedWait(live.events, EVENTS_AFTER_EXIT_MS);
    // Killed, with its exit not reported in time.
    const exit = ladder.exit ?? { code: null, signal: ladder.stoppedBy === 'sigkill' ? 'SIGKILL' : null };
    const context = { stoppedBy: ladder.stoppedBy, cause: options.cause, requested: true };
    const exitedSeq = await this.finishExit(live, exit, context);
    if (exitedSeq === null) return { ok: false, error: 'not_running' };
    return { ok: true, stoppedBy: ladder.stoppedBy, exitedSeq };
  }

  /**
   * Steps 1-3 of a take-over: a live agent interrupted, asked for a handoff note and stopped with the ladder, and its
   * final work done, with no attempt.exited; a gone one's clone harvested and pushed. Either way the WIP ref never
   * moves again: the person pushes to their take-over ref.
   */
  private async stopForTakeover(clone: string | null, harvested: Harvested): Promise<FinalWork> {
    const live = this.live;
    if (live !== null) {
      live.stopping = true;
      live.handoffsAtStop ??= live.pump.handoffs;
      const { timings } = this.deps.config();
      await prepareForStop({
        session: live.session,
        watch: live.watch,
        toolInFlight: () => live.pump.toolInFlight,
        handoffWritten: () => handoffSinceStop(live),
        options: { handoff: true, interruptFirst: true, reason: TAKEOVER_STOP_REASON },
        interruptMs: timings.stopInterrupt,
        handoffMs: this.deps.handoffMs(),
      });
      this.setPhase('stopping');
      const ladder = await runStopLadder({
        session: live.session,
        turnEnded: () => live.watch.turnEnded(),
        groups: () => this.groupsOf(live),
        clone: live.workspace.clone,
        timings,
      });
      await boundedWait(live.events, EVENTS_AFTER_EXIT_MS);
      const context: ExitContext = { stoppedBy: ladder.stoppedBy, cause: null, requested: true };
      const final = await this.endProcess(live, context, harvested);
      if (final !== null) {
        this.standing.exited = true;
        await this.cleanUpExit(live, final, context);
        return final;
      }
    }
    this.deps.store.update(this.attemptId, { finalizedAt: null });
    let final: FinalWork;
    try {
      if (clone === null) throw new Error(`${this.attemptId} has no clone on this runner`);
      final = await this.finalWork(clone, harvested);
    } catch (error) {
      final = this.finalWorkFailed(error, harvested);
    }
    this.standing.exited = true;
    this.recordFinalWork('stopped', final);
    if (final.late !== null) this.startLateWork(final.late.sha, final.late.now);
    return { ...final, pushError: final.pushError === null ? null : clipPushError(final.pushError) };
  }

  /**
   * Steps 4 and 5 of a take-over: the protected paths restored in the clone, every nested .git the agent left moved
   * aside, and the clone's .git replaced, the agent's ones inspected where they went; gives what the local command
   * resumes. Throws when a step fails, or when the harvest did (failure).
   */
  private async handOver(input: {
    spec: Omit<AttemptSpec, 'agentToken'>;
    clone: string | null;
    head: string | null;
    failure: string | null;
  }): Promise<LocalCommandInput> {
    const { spec, clone, head } = input;
    if (clone === null) throw new Error(`${this.attemptId} has no clone on this runner`);
    if (head === null) throw new Error(input.failure ?? 'the clone was not harvested');
    const { vault, local, paths, store } = this.deps;
    const base = await resolveRestoreBase(vault, spec);
    await restoreProtected({ vault, local }, { clone, base, paths: spec.restore.paths });
    const branch = spec.branch as string;
    const forensics = paths.forensics(this.attemptId);
    const nested = await moveNestedGitDirs({ clone, forensics });
    const moved = await replaceGitDir({ vault, local, clone, branch, head, forensics });
    const inspected = [
      ...(moved === null ? [] : [{ gitDir: moved, label: '.git' }]),
      ...nested.map((entry) => ({ gitDir: entry.moved, label: entry.path })),
    ];
    const found = new Set(nested.map((entry) => entry.path));
    for (const { gitDir, label } of inspected) {
      try {
        for (const path of await inspectAgentGitDir({ gitDir, local, vault, label })) found.add(path);
      } catch (error) {
        // The inspection is a report on the agent's .git; the clone is the person's already.
        const fields = { attemptId: this.attemptId, label, error: describe(error) };
        this.deps.logger.warn("cannot inspect the agent's .git", fields);
        found.add(label);
      }
    }
    if (found.size > 0) {
      const fence = this.currentFence ?? spec.fence;
      const listed = clipViolationPaths([...found]);
      this.report(fence, { type: 'attempt.violation', data: { phase: 'takeover', paths: listed } });
    }
    const record = store.get(this.attemptId);
    // The version that wrote the session (X-13).
    const cliVersion = record?.cliVersion ?? this.deps.cliVersion(spec.vendor);
    return {
      vendor: spec.vendor,
      cliVersion,
      sessionRef: record?.sessionRef ?? null,
      clone,
      runnerDir: paths.runner,
      home: vendorHomes(this.deps.config(), paths)[spec.vendor],
    };
  }

  /** The groups a kill reaches: the recorded ones and those the descendant snapshots found. */
  private async groupsOf(live: LiveAgent): Promise<ProcessIdentity[]> {
    await live.pump.settled();
    return [...this.deps.store.processes(this.attemptId), ...live.pump.groups()];
  }

  /**
   * Everything after the agent's exit, on the serial queue and once per process: for an unrequested exit the kill
   * and sweep first, then the final work, the transcript tail and the voided approvals, and attempt.exited last. A
   * step that fails still leads to attempt.exited, its pushError naming the failure, and to the cleanup, so the
   * attempt never stays live without a process. Gives attempt.exited's seq; null when the exit was already dealt with.
   */
  private async finishExit(live: LiveAgent, exit: ExitInfo, context: ExitContext): Promise<number | null> {
    const final = await this.endProcess(live, context);
    if (final === null) return null;
    // Work left for a late-work ref is on record before the exit is reported, so a restart still pushes it.
    if (final.late !== null) this.recordLateWork(final.late.sha);
    try {
      return this.report(this.currentFence ?? live.spec.fence, {
        type: 'attempt.exited',
        data: {
          code: exit.code,
          signal: exit.signal,
          stoppedBy: context.stoppedBy,
          handoffWritten: live.pump.handoffWritten,
          cause: context.cause,
          finalSha: final.finalSha,
          finalWip: final.finalWip,
          pushError: final.pushError,
        },
      });
    } finally {
      // The WIP ref never moves after attempt.exited, and nothing of the process is left, whatever failed.
      this.standing.exited = true;
      await this.cleanUpExit(live, final, context);
    }
  }

  /**
   * A process's end, once: for an unrequested exit the kill and sweep first, then the exit's work (endWork). Gives
   * null when the process was already dealt with. Its report and cleanup are the caller's: attempt.exited, or
   * attempt.taken_over.
   */
  private async endProcess(
    live: LiveAgent,
    context: ExitContext,
    harvested: Harvested = { sha: null, head: null },
  ): Promise<FinalWork | null> {
    if (live.finished) return null;
    live.finished = true;
    live.policy.close();
    this.stopWipTimer();
    if (!context.requested) {
      try {
        await killAndSweep({ groups: () => this.groupsOf(live), clone: live.workspace.clone });
      } catch (error) {
        const fields = { attemptId: this.attemptId, error: describe(error) };
        this.deps.logger.error('cannot kill and sweep after an exit', fields);
      }
    }
    return this.endWork(live, harvested);
  }

  /**
   * The exit's work before attempt.exited: the pump closed, the final work, the transcript tail and the voided
   * approvals. A failure is logged and gives a final work with finalWip null and the failure as pushError; work
   * already harvested then goes to a late-work ref.
   */
  private async endWork(live: LiveAgent, harvested: Harvested): Promise<FinalWork> {
    let final: FinalWork;
    try {
      live.pump.close();
      await live.pump.settled();
      live.facts.close();
      this.setPhase('stopping');
      final = await this.finalWork(live.workspace.clone, harvested);
    } catch (error) {
      final = this.finalWorkFailed(error, harvested);
    }
    await uploadTranscriptTail({
      adapter: this.deps.adapters.get(live.spec.vendor) as VendorAdapter,
      hub: this.deps.hub,
      attemptId: this.attemptId,
      sessionRef: live.session.sessionRef,
      clone: live.workspace.clone,
      logger: this.deps.logger,
    });
    try {
      live.pump.voidAll();
    } catch (error) {
      this.deps.logger.error('cannot void the pending approvals', { attemptId: this.attemptId, error: describe(error) });
    }
    return { ...final, pushError: final.pushError === null ? null : clipPushError(final.pushError) };
  }

  /** A final work that threw: finalWip null, the failure as pushError, and work already harvested left for late work. */
  private finalWorkFailed(error: unknown, harvested: Harvested): FinalWork {
    this.deps.logger.error('the final work failed', { attemptId: this.attemptId, error: describe(error) });
    const sha = harvested.sha;
    const pushError = `the final work failed: ${describe(error)}`;
    return { finalSha: sha, finalWip: null, pushError, late: sha === null ? null : { sha, now: false } };
  }

  /** Persist the outcome before completion: a crash or failed write must never hide pending work from purge. */
  private recordFinalWork(state: 'stopped' | 'suspended', final: FinalWork): void {
    this.deps.store.update(this.attemptId, {
      state,
      pushError: final.pushError,
      ...(final.late === null ? {} : { lateWorkSha: final.late.sha }),
    });
    this.deps.store.update(this.attemptId, { finalizedAt: Date.now() });
  }

  /** After attempt.exited: the record, the registry, the base checkout and the facts' files; then the late work. */
  private async cleanUpExit(live: LiveAgent, final: FinalWork, context: ExitContext): Promise<void> {
    const { store, logger } = this.deps;
    const state = context.cause === 'suspend' ? 'suspended' : 'stopped';
    try {
      this.recordFinalWork(state, final);
      store.forgetProcesses(this.attemptId);
    } catch (error) {
      logger.error('cannot record the exit', { attemptId: this.attemptId, error: describe(error) });
    }
    try {
      await live.workspace.baseCheckout?.release();
    } catch (error) {
      logger.warn('cannot release a base checkout', { attemptId: this.attemptId, error: describe(error) });
    }
    await rm(live.factsDir, { recursive: true, force: true }).catch(() => {});
    if (this.live === live) this.live = null;
    this.currentPhase = null;
    if (final.late !== null) this.startLateWork(final.late.sha, final.late.now);
  }

  /**
   * The final harvest, strip and push of a worker, with retries for up to finalPush, canPushWip asked before each
   * try. Work canPushWip keeps from the WIP ref, or that the push could not place, is left for a late-work ref; a lead
   * has no harvest. The harvest's sha and head are noted in harvested as soon as they are known.
   */
  private async finalWork(clone: string, harvested: Harvested): Promise<FinalWork> {
    const spec = this.current;
    const none: FinalWork = { finalSha: null, finalWip: null, pushError: null, late: null };
    if (spec === null || spec.role !== 'worker' || spec.branch === null || spec.wipRef === null) return none;
    const { store, vault, local, wipGate, config } = this.deps;
    const ref = spec.wipRef;
    let work: WorkResult;
    try {
      work = await this.collect(spec, clone, spec.branch);
    } catch (error) {
      return { ...none, pushError: `cannot harvest the clone: ${describe(error)}` };
    }
    harvested.sha = work.sha;
    harvested.head = work.head;
    // Protected changes are reported whatever happens next: a change only there strips back to the pushed tree.
    this.reportViolations(work.stripped);
    const pushed = store.get(this.attemptId)?.pushedSha ?? null;
    const last = this.lastWork;
    if (last !== null && last.tree === work.tree && (last.head === null || last.head === work.head)) {
      return { ...none, finalSha: work.sha, finalWip: pushed === null ? null : { ref, sha: pushed } };
    }
    const result = await pushWithRetries({
      budgetMs: config().timings.finalPush,
      refusal: () => wipRefusal(wipGate, this.standing),
      push: async () => {
        const previous = store.get(this.attemptId)?.pushedSha ?? null;
        try {
          return await pushWip({ vault, local, remote: await this.deps.remote(), ref, sha: work.sha, previous });
        } catch (error) {
          return { ok: false, error: 'remote', refs: [], detail: describe(error) };
        }
      },
    });
    if (!result.ok && result.error === 'refused') {
      // Known ended: the hub expects no WIP, and takes the work as late work.
      const pushError = this.standing.ended ? null : `the final WIP push was not allowed: ${result.detail}`;
      return { finalSha: work.sha, finalWip: null, pushError, late: { sha: work.sha, now: true } };
    }
    if (!result.ok) {
      const pushError = `cannot push ${ref}: ${result.detail}`;
      return { finalSha: work.sha, finalWip: null, pushError, late: { sha: work.sha, now: false } };
    }
    // A WIP push like any other (design 7.3), reported before attempt.exited: a handoff note the hub assembles for
    // the exit quotes the newest attempt.wip's git log --stat (6.8, X-3).
    await this.wipPushed(spec, ref, work);
    return { ...none, finalSha: work.sha, finalWip: { ref, sha: work.sha } };
  }

  /**
   * Retries the work to late-work refs until one lands (attempt.late_work); never gated by canPushWip. The record's
   * lateWorkSha keeps the work pending across a restart (resumeLateWork) until it lands.
   */
  private startLateWork(sha: string, now: boolean): void {
    this.recordLateWork(sha);
    this.late?.cancel();
    const retries: LateWorkRetries = new LateWorkRetries({
      delay: this.deps.config().timings.lateRetry,
      logger: this.deps.logger,
      attemptId: this.attemptId,
      // A try already queued when the retries were cancelled, as a cleanup or a hand-back took the work over, does
      // nothing: the same work would go to a second late-work ref.
      attempt: () =>
        this.enqueue(async () => (this.late === retries && retries.active ? this.lateWorkJob(sha) : { ok: true })),
    });
    this.late = retries;
    retries.start(now);
  }

  /** The record's lateWorkSha: the work waits for a late-work ref. A failure is logged; the retries still run. */
  private recordLateWork(sha: string): void {
    try {
      this.deps.store.update(this.attemptId, { lateWorkSha: sha });
    } catch (error) {
      const fields = { attemptId: this.attemptId, error: describe(error) };
      this.deps.logger.error('cannot record the pending late work', fields);
    }
  }

  private async lateWorkJob(sha: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const spec = this.current;
    if (spec === null || spec.taskId === null) return { ok: true };
    const { vault, local, store } = this.deps;
    const pushed = await pushLateWork({
      vault,
      local,
      remote: await this.deps.remote(),
      wipRefPrefix: this.deps.wipRefPrefix(),
      attemptId: this.attemptId,
      sha,
    });
    if (!pushed.ok) return { ok: false, error: pushed.detail };
    store.update(this.attemptId, { lateWorkCount: pushed.n, pushError: null, lateWorkSha: null });
    this.report(this.currentFence ?? spec.fence, {
      type: 'attempt.late_work',
      data: { taskId: spec.taskId, ref: pushed.ref, sha },
    });
    return { ok: true };
  }

  /**
   * A cleanup's first step: late work still pending (the record's lateWorkSha) is pushed before anything is deleted.
   * It is the exit's own harvest, which the vault holds whatever became of the clone. A push that fails keeps
   * everything, and the retries go on: the hub never sends a failed cleanup again. Work the vault no longer holds is
   * dropped from the record: nothing is left to push.
   */
  private async pushPendingLateWork(): Promise<CleanupOutcome> {
    this.late?.cancel();
    this.late = null;
    const record = this.deps.store.get(this.attemptId);
    const sha = record?.lateWorkSha ?? null;
    if (record === null || sha === null) return { ok: true };
    this.current ??= record.spec;
    if ((await this.treeOf(sha)) === null) {
      this.deps.logger.warn('the pending late work is gone from the vault', { attemptId: this.attemptId, sha });
      this.deps.store.update(this.attemptId, { lateWorkSha: null });
      return { ok: true };
    }
    const pushed = await this.lateWorkJob(sha).catch((error) => ({ ok: false as const, error: describe(error) }));
    if (pushed.ok) return pushed;
    this.startLateWork(sha, false);
    return { ok: false, error: clipPushError(`cannot push the late work: ${pushed.error}`) };
  }

  /**
   * A worker clone's work as it is now, harvested and stripped, pushed to a new late-work ref unless the attempt's
   * start, its WIP ref or one of its late-work refs already holds it. A lead has no WIP and is never harvested. Only a
   * failure to reach the origin keeps the clone, and that work is then late work, pending in the record and retried
   * until it lands, as the hub never sends a failed cleanup again. A clone that cannot be harvested (its .git removed,
   * say) never will be, so that is noted and the cleanup goes on.
   */
  private async saveLateWork(
    spec: Omit<AttemptSpec, 'agentToken'>,
    clone: string,
    lateWorkCount: number,
  ): Promise<CleanupOutcome> {
    const { taskId, branch, wipRef } = spec;
    if (spec.role !== 'worker' || taskId === null || branch === null || wipRef === null) return { ok: true };
    const { vault, local } = this.deps;
    let work: WorkResult;
    try {
      work = await this.collect(spec, clone, branch);
    } catch (error) {
      this.harvestFailed(describe(error));
      return { ok: true };
    }
    this.reportViolations(work.stripped);
    // By tree: every harvest of uncommitted work makes a new snapshot commit, even of the same files.
    const resolved = (): CleanupOutcome => {
      this.deps.store.update(this.attemptId, { pushError: null });
      return { ok: true };
    };
    if ((await this.treeOf(localPinRefs(this.attemptId).start)) === work.tree) return resolved();
    try {
      const prefix = this.deps.wipRefPrefix();
      const late = Array.from({ length: lateWorkCount }, (_, index) => lateWorkRef(prefix, this.attemptId, index + 1));
      const heads = await lsRemote({ vault, local, remote: await this.deps.remote() }, [wipRef, ...late]);
      for (const sha of new Set(heads.values())) {
        if ((await this.treeOf(sha)) === work.tree) return resolved();
      }
      const pushed = await this.lateWorkJob(work.sha);
      if (pushed.ok) return pushed;
      this.startLateWork(work.sha, false);
      return { ok: false, error: clipPushError(`cannot push the late work: ${pushed.error}`) };
    } catch (error) {
      // Unchecked against the origin's refs, which could not be read: at worst a late-work ref holds a tree twice.
      this.startLateWork(work.sha, false);
      return { ok: false, error: clipPushError(`cannot save the clone's work: ${describe(error)}`) };
    }
  }

  /** The tree of a commit or ref in the vault; null when the vault has none. */
  private async treeOf(rev: string): Promise<string | null> {
    const { vault, local } = this.deps;
    const args = [`--git-dir=${vault.path}`, 'rev-parse', '--verify', '--quiet', `${rev}^{tree}`];
    const tree = await runGit(local, args, { check: false });
    return tree.code === 0 ? tree.stdout.trim() : null;
  }

  /** Uploads the session's transcript tail; gives whether one was posted. A failure is logged, never thrown. */
  private uploadTail(vendor: Vendor, sessionRef: string | null, clone: string): Promise<boolean> {
    const adapter = this.deps.adapters.get(vendor);
    if (sessionRef === null || !adapter) return Promise.resolve(false);
    const { hub, logger } = this.deps;
    return uploadTranscriptTail({ adapter, hub, attemptId: this.attemptId, sessionRef, clone, logger });
  }

  /**
   * The removals of a cleanup, each logged when it fails: the vendor's transcript, the clone, the vault pins, the
   * private tmp dir, the tools, quarantine and forensics directories, and the base checkout. Only when all went is
   * the record marked cleaned up; otherwise the first failure is the answer, and a resent cleanup tries again.
   */
  private async removeAttempt(record: AttemptRecord): Promise<CleanupOutcome> {
    const { paths, vault, store, logger } = this.deps;
    const id = this.attemptId;
    const project = vault.project;
    const adapter = this.deps.adapters.get(record.spec.vendor);
    const sessionRef = record.sessionRef;
    const clone = record.clone ?? paths.clone(project, id);
    const steps: [string, () => Promise<void>][] = [
      ['the transcript', async () => {
        if (sessionRef !== null && adapter) await adapter.deleteTranscript({ sessionRef, clone });
      }],
      ['the clone', () => removeTree(clone)],
      ['the pins', () => vault.deletePins(id)],
      ['the private tmp dir', async () => {
        if (record.tmpDir !== null) await removeTree(record.tmpDir);
      }],
      ['the tools directory', async () => removeAgentTools(paths.agentTools(project, id))],
      ['the quarantine', () => removeTree(paths.quarantine(project, id))],
      ['the forensics directory', () => removeTree(paths.forensics(id))],
      ['the base checkout', async () => {
        await this.prepared?.baseCheckout?.release();
      }],
    ];
    let failed: string | null = null;
    for (const [what, step] of steps) {
      try {
        await step();
      } catch (error) {
        logger.warn(`cannot remove ${what}`, { attemptId: id, error: describe(error) });
        failed ??= `cannot remove ${what}: ${describe(error)}`;
      }
    }
    if (failed !== null) return { ok: false, error: clipPushError(failed) };
    const ended = { state: 'ended', endedAt: record.endedAt ?? Date.now() } as const;
    store.update(id, { ...ended, clone: null, tmpDir: null, lateWorkSha: null });
    this.close();
    this.prepared = null;
    this.cloneDir = null;
    this.currentPhase = null;
    return { ok: true };
  }

  /** The phase the controller and the facts report. */
  private setPhase(phase: AttemptPhase): void {
    this.currentPhase = phase;
    this.live?.facts.setPhase(phase);
  }

  /** The agent's started event: attempt.spawned with the start tip the clone was made at. */
  private spawned(live: LiveAgent, event: Extract<AgentEvent, { type: 'started' }>): void {
    const { spec, launch, session, workspace } = live;
    if (launch.resume !== null && event.sessionRef !== launch.resume.sessionRef) live.pump.freshSession();
    this.deps.store.update(spec.attemptId, { state: 'running', sessionRef: event.sessionRef });
    this.report(spec.fence, {
      type: 'attempt.spawned',
      data: {
        sessionRef: event.sessionRef,
        pid: session.pid,
        model: launch.model,
        cliVersion: launch.cliVersion,
        permissionMode: event.permissionMode,
        startSha: live.resumed ? null : workspace.startSha,
      },
    });
  }

  /**
   * Step 4 of the clone (design 7.7), for workers only, in phase preparing. Reports attempt.prepared with requestId
   * null when a preparation ran; gives whether one ran, and its error when it failed.
   */
  private async prepareDependencies(
    spec: AttemptSpec,
    workspace: PreparedWorkspace,
  ): Promise<{ ran: boolean; error: string | null }> {
    const { preparer, vault, paths } = this.deps;
    if (spec.role !== 'worker' || !preparer.available) return { ran: false, error: null };
    const env = buildAgentEnv({
      vendor: spec.vendor,
      spec,
      clone: workspace.clone,
      tools: workspace.runDir.tools,
      tmpDir: workspace.tmpDir,
      config: this.deps.config(),
      paths,
    });
    this.currentPhase = 'preparing';
    let outcome: Awaited<ReturnType<DependencyPreparer['prepare']>>;
    try {
      outcome = await preparer.prepare({
        attemptId: spec.attemptId,
        vendor: spec.vendor,
        clone: workspace.clone,
        vault,
        baseSha: workspace.base,
        env,
        requestId: null,
      });
    } catch (error) {
      outcome = { ran: true, ok: false, error: describe(error), logTail: null };
    } finally {
      this.currentPhase = 'starting';
    }
    if (!outcome.ran) return { ran: false, error: null };
    const { ok, error, logTail } = outcome;
    this.report(spec.fence, { type: 'attempt.prepared', data: { requestId: null, ok, error, logTail } });
    return { ran: true, error: ok ? null : (error ?? 'the preparation failed') };
  }

  /** attempt.failed_to_start for a start the runner tried: refused null, class infra, the error clipped. */
  private failedToStart(fence: Fence, error: string): Extract<StartOutcome, { started: false }> {
    this.currentPhase = null;
    const clipped = clipStartError(error);
    this.report(fence, { type: 'attempt.failed_to_start', data: { error: clipped, refused: null } });
    return { started: false, refused: null, error: clipped };
  }

  /** The core's checks in order, then the health seam's; null admits the start. */
  private async admit(spec: AttemptSpec): Promise<{ code: StartRefusal; error: string } | null> {
    const config = this.deps.config();
    if (config.draining) return { code: 'draining', error: 'the runner is draining and takes no new attempts' };
    if (this.deps.liveAttempts() >= config.capacity) {
      return { code: 'at_capacity', error: `the runner is at its capacity of ${config.capacity} attempts` };
    }
    if (!this.deps.adapters.has(spec.vendor) || !this.deps.vendorReady(spec.vendor)) {
      return { code: 'vendor_not_ready', error: `${spec.vendor} is not ready on this runner` };
    }
    // The slot is taken before the seam is asked, with no await since the capacity check, so a start of another
    // attempt admitted meanwhile counts it; a refusal gives it back.
    const previous = this.currentPhase;
    this.currentPhase = 'starting';
    let code: StartRefusal | null;
    try {
      code = await this.deps.health.admit(spec);
    } catch (error) {
      this.currentPhase = previous;
      throw error;
    }
    if (code === null) return null;
    this.currentPhase = previous;
    return { code, error: `the runner refused the start: ${code}` };
  }

  /** Appends one of this attempt's events with the fence it belongs to; gives its seq. */
  private report(fence: Fence, event: PumpEvent): number {
    return this.deps.outbox.append({ ...event, attemptId: this.attemptId, fence } as NewEvent).seq;
  }
}

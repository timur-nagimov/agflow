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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AttemptFacts,
  type AttemptPhase,
  type AttemptSpec,
  compareFence,
  type Fence,
  type InjectedMessage,
  type StartRefusal,
  type Vendor,
} from '@agflow/core';
import type { AgentEvent, AgentLaunch, AgentSession, AgflowCommand, VendorAdapter } from '../adapters/types';
import type { AttemptStore } from '../attempt-store';
import type { AwakeClock } from '../clock';
import type { RunnerConfig } from '../config';
import { buildAgentEnv } from '../env';
import { diffFingerprint, FactsTracker } from '../facts';
import { lsRemote, type PushResult, pushWip } from '../git/push';
import { type GitEnvironment, runGit } from '../git/run';
import type { Vault } from '../git/vault';
import type { Logger } from '../log';
import type { NewEvent, Outbox } from '../outbox';
import type { RunnerPaths } from '../paths';
import type { SerialQueue } from '../queue';
import type { ProcessIdentity } from '../processes';
import type { DependencyPreparer, Notifier, RunnerHealth } from '../seams';
import { buildLaunch, ProcessRegistration } from './launch';
import { ACTIVITY_SUMMARY_MAX, clip, EventPump, type PumpEvent } from './pump';
import {
  canPushWip,
  collectWork,
  logStat,
  type WipFailures,
  type WipGate,
  type WipStanding,
  type WorkResult,
  withPausedGroups,
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
  /** The runner-owned directory of the facts' fingerprint index. */
  factsDir: string;
  /** Settles once the agent's events have ended. */
  done: Promise<void>;
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

  /** deliver: the messages go to the live agent at once, in order, with one line about `more` (X-4). */
  async deliver(command: { fence: Fence; messages: InjectedMessage[]; more: number }): Promise<LiveOutcome> {
    const live = this.liveAt(command.fence);
    if (!('pump' in live)) return live;
    await live.pump.deliver(command.messages, command.more);
    return { ok: true };
  }

  /** interrupt (the Agents view's Interrupt): the plain interrupt; queued messages still run. */
  async interrupt(command: { fence: Fence }): Promise<LiveOutcome> {
    const live = this.liveAt(command.fence);
    if (!('pump' in live)) return live;
    await live.session.interrupt();
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

  /** After each welcome: a harvest held back while canPushWip failed is pushed now. */
  onWelcome(): Promise<void> {
    return this.enqueue(async () => {
      const held = this.heldWork;
      const spec = this.current;
      if (held !== null && spec !== null) await this.pushWork(spec, held);
    });
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
    await startStep('cannot start the agent', () => this.launchAgent(spec, workspace, { cliVersion, resume: null }));
  }

  /**
   * Starts the agent through its vendor's adapter, then follows its events. The facts tracker runs from the launch
   * on, and the process is recorded before the first event is read.
   */
  private async launchAgent(
    spec: AttemptSpec,
    workspace: PreparedWorkspace,
    options: { cliVersion: string; resume: AgentLaunch['resume'] },
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
    });
    const live: LiveAgent = {
      spec,
      workspace,
      launch,
      session,
      registration,
      facts,
      pump,
      factsDir,
      done: Promise.resolve(),
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
   * Reads the agent's events, once its process is recorded, until they end. An event the runner fails to handle is
   * logged and the next one read, so one bad event never ends supervision; events that fail to arrive have ended.
   */
  private async follow(live: LiveAgent): Promise<void> {
    await live.registration.recorded();
    const iterator = live.session.events[Symbol.asyncIterator]();
    for (;;) {
      let next: IteratorResult<AgentEvent>;
      try {
        next = await iterator.next();
      } catch (error) {
        this.deps.logger.error("the agent's events failed", { attemptId: this.attemptId, error: describe(error) });
        break;
      }
      if (next.done) break;
      const event = next.value;
      await this.guarded(event, () => live.facts.observe(event));
      await this.guarded(event, () => (event.type === 'started' ? this.spawned(live, event) : live.pump.handle(event)));
    }
    await live.session.exited;
    this.stopWipTimer();
    live.pump.close();
    await live.pump.settled();
    live.facts.close();
    await rm(live.factsDir, { recursive: true, force: true });
    if (this.live === live) this.live = null;
    this.currentPhase = null;
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

  /** The phase the controller and the facts report. */
  private setPhase(phase: AttemptPhase): void {
    this.currentPhase = phase;
    this.live?.facts.setPhase(phase);
  }

  /** The agent's started event: attempt.spawned with the start tip the clone was made at. */
  private spawned(live: LiveAgent, event: Extract<AgentEvent, { type: 'started' }>): void {
    const { spec, launch, session, workspace } = live;
    this.deps.store.update(spec.attemptId, { state: 'running', sessionRef: event.sessionRef });
    this.report(spec.fence, {
      type: 'attempt.spawned',
      data: {
        sessionRef: event.sessionRef,
        pid: session.pid,
        model: launch.model,
        cliVersion: launch.cliVersion,
        permissionMode: event.permissionMode,
        startSha: workspace.startSha,
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
  private failedToStart(fence: Fence, error: string): StartOutcome {
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

  /** Appends one of this attempt's events with the fence it belongs to. */
  private report(fence: Fence, event: PumpEvent): void {
    this.deps.outbox.append({ ...event, attemptId: this.attemptId, fence } as NewEvent);
  }
}

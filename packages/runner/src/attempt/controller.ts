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
import type { GitEnvironment } from '../git/run';
import type { Vault } from '../git/vault';
import type { Logger } from '../log';
import type { NewEvent, Outbox } from '../outbox';
import type { RunnerPaths } from '../paths';
import type { SerialQueue } from '../queue';
import type { ProcessIdentity } from '../processes';
import type { DependencyPreparer, Notifier, RunnerHealth } from '../seams';
import { buildLaunch, ProcessRegistration } from './launch';
import { EventPump, type PumpEvent } from './pump';
import {
  clipStartError,
  clipViolationPaths,
  finishWorkspace,
  type PreparedWorkspace,
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
      this.prepared = null;
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
    const workspace = await startStep('cannot prepare the clone', () => prepareWorkspace(this.deps, spec));
    this.prepared = workspace;
    store.update(spec.attemptId, { clone: workspace.clone, tmpDir: workspace.tmpDir });
    if (workspace.violations.length > 0) {
      const listed = clipViolationPaths(workspace.violations);
      this.report(spec.fence, { type: 'attempt.violation', data: { phase: 'start', paths: listed } });
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

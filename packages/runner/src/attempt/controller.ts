// The attempt controller (design 13): one per attempt, owning everything about it that is not vendor-specific. Its
// lifecycle and git work runs on the attempt's serial queue, one job at a time. A start is admitted first (X-3):
// a draining runner, a full capacity, a vendor that is not ready and the health seam each refuse it with one of
// core's START_REFUSALS, reported as attempt.failed_to_start with refused set, and nothing starts. An admitted
// start then prepares the clone (workspace.ts) and a worker's dependencies, in phase preparing, through the seam,
// and verifies the clone's project config last. Any failure after admission, a clone that cannot be prepared or a
// failed preparation say, releases what the start took and is one attempt.failed_to_start with refused null (X-40),
// its texts clipped.
import type { AttemptPhase, AttemptSpec, Fence, StartRefusal, Vendor } from '@agflow/core';
import type { VendorAdapter } from '../adapters/types';
import type { AttemptStore } from '../attempt-store';
import type { RunnerConfig } from '../config';
import { buildAgentEnv } from '../env';
import type { GitEnvironment } from '../git/run';
import type { Vault } from '../git/vault';
import type { Logger } from '../log';
import type { NewEvent, Outbox } from '../outbox';
import type { RunnerPaths } from '../paths';
import type { SerialQueue } from '../queue';
import type { DependencyPreparer, Notifier, RunnerHealth } from '../seams';
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
}

export type StartOutcome = { started: true } | { started: false; refused: StartRefusal | null; error: string };

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

  /** Runs a job on this attempt's serial queue. */
  enqueue<T>(job: () => Promise<T>): Promise<T> {
    return this.deps.queue.run(this.attemptId, job);
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

  /** An admitted start's work: the clone, the dependencies and the project config; throws on a failure. */
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
  private report(fence: Fence, event: DistributiveOmit<AttemptEvent, 'attemptId' | 'fence'>): void {
    this.deps.outbox.append({ ...event, attemptId: this.attemptId, fence } as NewEvent);
  }
}

type AttemptEvent = Extract<NewEvent, { attemptId: string }>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

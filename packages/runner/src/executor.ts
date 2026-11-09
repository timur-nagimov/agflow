// The command executor (design 6.3, "Commands"; 6.4; 6.18; 7.7). It turns the hub's commands into controller and
// runner work:
// - Journal: each command is validated with core's RunnerCommandSchema, recorded as running before it executes and as
//   done with its result after. A resend while it runs joins the first execution (by id, or by design 6.3's
//   idempotency keys); a resend when done gets the stored result. An unknown or invalid command answers unsupported
//   and is never journaled; a command for an attempt this runner has no record of answers unknown_attempt.
// - Ordering: an attempt's lifecycle and git commands go to its controller, whose serial queue runs them in arrival
//   order, which is the hub's seq order; deliver, interrupt and decide_approval act on the live session at once.
//   Different attempts run concurrently; the runner's own commands (refresh_vault, preflight, delete_refs,
//   update_settings) run one at a time.
// - welcome.stop is applied before any command that follows the welcome: each attempt named there is marked ended at
//   once, a live process is stopped without a handoff turn (its new work goes to a late-work ref), and later commands
//   for it answer attempt_ended, except those that outlive an attempt: cleanup_attempt, upload_transcript and
//   hand_back (X-36).
// - pause() holds new commands until resume(), which runs them in order; work already dispatched goes on (X-7).
// - After a restart, journal rows left running are run again when their handler is idempotent (RESTARTABLE_COMMANDS)
//   and answered interrupted otherwise. start_attempt and resume_attempt are never re-run: the journal keeps no agent
//   token, and the hub resends them with a fresh one. update_settings runs again when the hub sends it again.
// - update_settings (X-12): each hello starts a new lineage, and one taken before the latest hello answers nothing,
//   its row left running for the hub to send it again after the welcome; a hub restored from a backup sends only the
//   ones it still has. One that fails, or would skip a version (SettingsSync.echo), waits: a failed one runs again
//   after a short backoff, and each that waits runs, in version order, once the ones before it have; the next hello
//   leaves those still waiting unanswered. One whose journal row cannot be written is taken again after the backoff;
//   any other command answers that failure.
import { type RunnerCommand, type RunnerCommandKind, RunnerCommandSchema, type Vendor } from '@agflow/core';
import type { PreflightResult, VendorAdapter } from './adapters/types';
import type { AttemptController } from './attempt/controller';
import { type ClockSource, systemClock } from './clock';
import type { RunnerConfig } from './config';
import { deleteRefsFenced } from './git/push';
import type { GitEnvironment } from './git/run';
import type { Vault } from './git/vault';
import type { CommandResult, Journal, JournaledCommand, JournalEntry } from './journal';
import type { CommandMessage, WelcomeMessage } from './link';
import type { Logger } from './log';
import type { Outbox } from './outbox';
import { SerialQueue } from './queue';
import { SettingsSync } from './settings-sync';
import type { VendorReport } from './vendors';

/** The commands whose handlers are idempotent, so a row a previous run left running is run again (design 6.3). */
export const RESTARTABLE_COMMANDS: ReadonlySet<RunnerCommandKind> = new Set<RunnerCommandKind>([
  'push_submission',
  'prepare_takeover',
  'hand_back',
  'cleanup_attempt',
  'upload_transcript',
  'refresh_vault',
  'delete_refs',
  'update_settings',
  'preflight',
  'prepare_dependencies',
]);

/** The commands that outlive their attempt: the hub keeps them when it ends one, and the runner runs them then too. */
const OUTLIVE_ATTEMPT: ReadonlySet<RunnerCommandKind> = new Set<RunnerCommandKind>([
  'cleanup_attempt',
  'upload_transcript',
  'hand_back',
]);

export interface CommandExecutorOptions {
  journal: Journal;
  /** The attempt's controller, made when there is none yet (a new start, or a record left by a previous run). */
  controller(attemptId: string): AttemptController;
  /** Whether the runner knows the attempt: it has a controller or a record in runner.db. */
  known(attemptId: string): boolean;
  config(): RunnerConfig;
  /** Writes runner.json and makes config() give the new settings. */
  saveConfig(config: RunnerConfig): void;
  outbox: Outbox;
  vault: Vault;
  local: GitEnvironment;
  /** The remote environment of the vault's pushes. */
  remote(): Promise<GitEnvironment>;
  wipRefPrefix(): string;
  adapters: ReadonlyMap<Vendor, VendorAdapter>;
  /** Told each preflight a preflight command ran, so the runner's vendor readiness follows it. */
  preflighted?(result: PreflightResult): void;
  /**
   * What runner.vendors carries after a preflight command: every vendor's latest preflight, the new one included,
   * each with its own preflightAt. The hub replaces the runner's whole vendor list with it (design 6.3).
   */
  vendors(): Pick<VendorReport, 'vendors' | 'quota'>;
  logger: Logger;
  /** The timers of the settings retries; the system's by default. */
  timers?: Pick<ClockSource, 'setTimeout' | 'clearTimeout'>;
}

/** The wait before an update_settings that failed runs again; it doubles at each failure, up to the cap. */
const SETTINGS_RETRY_MS = 1_000;
const SETTINGS_RETRY_CAP_MS = 60_000;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** When a command came: the lineage of the hub that sent it, and the outbox's newest seq then. */
interface Sighting {
  lineage: number;
  outboxSeq: number;
}

/** A command executing now. */
interface Execution {
  result: Promise<CommandResult | null>;
  /** The lineage that sent it last: a resend from a restored hub joins the execution, and makes it current. */
  lineage: number;
  /** The outbox's newest seq when it first came (Journal.begin): an echo answers no edit made after that. */
  outboxSeq: number;
}

/** An update_settings left waiting (X-12): its result comes once it runs, or null at the next hello. */
interface Waits {
  waits: Promise<CommandResult | null>;
}

/** An update_settings whose journal row could not be written, to be taken again as it came, or as a resend made it. */
interface Retake {
  timer: unknown;
  seen: Sighting;
  resolve(result: CommandResult | null): void;
}

/** One update_settings waiting, as it came. */
interface Waiting {
  command: Extract<RunnerCommand, { kind: 'update_settings' }>;
  execution: Execution;
  resolve(result: CommandResult | null): void;
}

/** The attempt a command is about, if any. */
function attemptOf(command: RunnerCommand | JournaledCommand): string | null {
  if (command.kind === 'start_attempt') return command.attempt.attemptId;
  return 'attemptId' in command ? command.attemptId : null;
}

/**
 * A controller's outcome as a command result: a refusal (ok, started or resumed false, with an error) answers ok
 * false with its error; anything else is the result's data.
 */
function resultOf(outcome: object): CommandResult {
  const refused =
    ('ok' in outcome && outcome.ok === false) ||
    ('started' in outcome && outcome.started === false) ||
    ('resumed' in outcome && outcome.resumed === false);
  if (refused && 'error' in outcome && typeof outcome.error === 'string') return { ok: false, error: outcome.error };
  return { ok: true, data: outcome };
}

/** A result that repeats an outcome the outbox reports too: ok as the outcome's, with its error and all of it. */
function outcomeResult(outcome: { ok: boolean; error: string | null }): CommandResult {
  return outcome.ok || outcome.error === null
    ? { ok: outcome.ok, data: outcome }
    : { ok: false, error: outcome.error, data: outcome };
}

export class CommandExecutor {
  /** Each command executing now, by its first id. */
  private readonly active = new Map<string, Execution>();
  /** The attempts welcome.stop named. */
  private readonly ended = new Set<string>();
  /** Commands that arrived while paused, in order. */
  private readonly held: (() => void)[] = [];
  /** The runner's own commands, one at a time. */
  private readonly runnerQueue = new SerialQueue();
  private paused = false;
  /** Each hello starts a new lineage: an update_settings taken before the latest one answers nothing (X-12). */
  private lineage = 0;
  /** The update_settings of this lineage that failed or would skip a version, by command id, as they came. */
  private readonly waiting = new Map<string, Waiting>();
  private readonly timers: Pick<ClockSource, 'setTimeout' | 'clearTimeout'>;
  private retryTimer: unknown = null;
  private retryMs = SETTINGS_RETRY_MS;
  /** The update_settings whose journal row could not be written, each taken again when its timer fires, by id. */
  private readonly retakes = new Map<string, Retake>();
  private closed = false;
  /** Settings sync (X-12): update_settings runs its echoes here, and the runtime shares it. */
  readonly settings: SettingsSync;

  constructor(private readonly options: CommandExecutorOptions) {
    const { outbox, logger } = options;
    this.timers = options.timers ?? systemClock;
    this.settings = new SettingsSync({
      config: () => options.config(),
      saveConfig: (next) => options.saveConfig(next),
      outbox,
      logger,
    });
  }

  /** Holds new commands until resume(); commands already dispatched go on. */
  pause(): void {
    this.paused = true;
  }

  /** Runs the held commands in their arrival order, and every new one at once again. */
  resume(): void {
    this.paused = false;
    for (const run of this.held.splice(0)) {
      try {
        run();
      } catch (error) {
        this.options.logger.error('a held command failed', { error: describe(error) });
      }
    }
  }

  /**
   * Each hello, as the link builds it, starts a new lineage (X-12). An update_settings taken before it answers nothing
   * when it runs, and those waiting answer nothing now: the hub sends them again after the welcome, if it still has
   * them. Run between this hello and its welcome, one from a hub that a restore replaced would move the snapshot past
   * the version this hello reports, which the restored hub reconciles against.
   */
  helloSent(): void {
    this.lineage += 1;
    this.stopWaiting();
  }

  /** The runner closes: no retry runs any more, and what waits answers nothing. */
  close(): void {
    this.closed = true;
    this.stopWaiting();
  }

  /**
   * Each welcome, before any command that follows it. welcome.stop: every named attempt is marked ended at once, then
   * each live process is stopped. Resolves once those stops are done.
   */
  async onWelcome(welcome: Pick<WelcomeMessage, 'stop'>): Promise<void> {
    const { controller, known, logger } = this.options;
    const stopping: { attemptId: string; reason: string }[] = [];
    for (const { attemptId, reason } of welcome.stop) {
      this.ended.add(attemptId);
      if (!known(attemptId)) continue;
      controller(attemptId).markEnded();
      stopping.push({ attemptId, reason });
    }
    await Promise.all(
      stopping.map(async ({ attemptId, reason }) => {
        try {
          await controller(attemptId).stopEnded(reason);
        } catch (error) {
          logger.error('cannot stop an attempt the hub ended', { attemptId, error: describe(error) });
        }
      }),
    );
  }

  /**
   * LinkHandlers.onCommand: journals the command and runs it, or answers it from the journal; null answers nothing
   * (update_settings, X-12).
   */
  onCommand(message: CommandMessage): Promise<CommandResult | null> {
    return this.take(message, { lineage: this.lineage, outboxSeq: this.options.outbox.lastSeq() });
  }

  /**
   * Journals the command and runs it, or answers it from the journal. Never throws: a journal that cannot be written
   * (a full disk, say) takes an update_settings again after the backoff, so the echoes after it wait for it rather
   * than for a reconnect, and answers any other command with the failure.
   */
  private take(message: CommandMessage, seen: Sighting): Promise<CommandResult | null> {
    try {
      return this.takeNow(message, seen);
    } catch (error) {
      if (RunnerCommandSchema.safeParse(message.command).data?.kind !== 'update_settings') return Promise.reject(error);
      return this.retake(message, seen, error);
    }
  }

  private takeNow(message: CommandMessage, seen: Sighting): Promise<CommandResult | null> {
    const parsed = RunnerCommandSchema.safeParse(message.command);
    if (!parsed.success) return Promise.resolve({ ok: false, error: 'unsupported' });
    const command = parsed.data;
    const begun = this.options.journal.begin(message.id, message.seq, command, seen.outboxSeq);
    if (begun.state === 'done') return Promise.resolve(begun.result);
    if (begun.state === 'running') {
      const active = this.active.get(begun.commandId);
      if (active) {
        active.lineage = Math.max(active.lineage, seen.lineage);
        return active.result;
      }
      // Left running by a previous run, not recovered yet, or left unanswered.
      const entry = this.options.journal.get(begun.commandId);
      if (entry === null) return Promise.resolve({ ok: false, error: 'interrupted' });
      return this.replay(entry, seen.lineage);
    }
    if (this.refusedAsEnded(command)) {
      const result: CommandResult = { ok: false, error: 'attempt_ended' };
      this.options.journal.finish(message.id, result);
      return Promise.resolve(result);
    }
    return this.schedule(message.id, command, seen);
  }

  /**
   * After a restart, once the first welcome's stop list is applied: the rows a previous run left running. An
   * update_settings waits for the hub to send it again, which it does after each welcome while the command is
   * pending; a hub restored from a backup without it never does, so an echo of settings the restore lost is never
   * applied (X-12).
   */
  async recover(): Promise<void> {
    const entries = this.options.journal.running().filter((entry) => entry.kind !== 'update_settings');
    await Promise.all(
      entries.map((entry) => this.active.get(entry.commandId)?.result ?? this.replay(entry, this.lineage)),
    );
  }

  /**
   * After an acknowledgement, and after each welcome: once every runner command received before it has run (held
   * ones included, so a pause holds this too), an acknowledged settings edit still unanswered gets a probe
   * (SettingsSync.probeUnanswered). Resolves once that check ran.
   */
  settingsAcknowledged(options: { welcome: boolean }): Promise<void> {
    const checked = Promise.withResolvers<void>();
    const check = () => {
      this.runnerQueue
        .run('runner', async () => this.settings.probeUnanswered(options))
        .catch((error) => this.options.logger.error('cannot check the settings edits', { error: describe(error) }))
        .then(checked.resolve);
    };
    if (this.paused) this.held.push(check);
    else check();
    return checked.promise;
  }

  /** Whether welcome.stop ended the command's attempt and the command does not outlive it. */
  private refusedAsEnded(command: RunnerCommand): boolean {
    const attemptId = attemptOf(command);
    return attemptId !== null && this.ended.has(attemptId) && !OUTLIVE_ATTEMPT.has(command.kind);
  }

  /**
   * A journal row left running: run again when its handler is idempotent, answered interrupted otherwise. It keeps
   * the outbox position it first came at.
   */
  private replay(entry: JournalEntry, lineage: number): Promise<CommandResult | null> {
    const { commandId, command } = entry;
    const parsed = RESTARTABLE_COMMANDS.has(command.kind) ? RunnerCommandSchema.safeParse(command) : null;
    if (parsed === null || !parsed.success) {
      const result: CommandResult = { ok: false, error: parsed === null ? 'interrupted' : 'unsupported' };
      this.options.journal.finish(commandId, result);
      return Promise.resolve(result);
    }
    const outboxSeq = entry.outboxSeq ?? Number.MAX_SAFE_INTEGER;
    return this.schedule(commandId, parsed.data, { lineage, outboxSeq });
  }

  /**
   * Runs the command now, or when the executor resumes; its result is journaled, then given. A command that answers
   * nothing leaves its row running.
   */
  private schedule(commandId: string, command: RunnerCommand, seen: Sighting): Promise<CommandResult | null> {
    const result = Promise.withResolvers<CommandResult | null>();
    const execution: Execution = { result: result.promise, ...seen };
    this.active.set(commandId, execution);
    const run = () => {
      this.execute(commandId, command, execution)
        // An update_settings left waiting gives its result once it runs (X-12).
        .then((done) => (done !== null && 'waits' in done ? done.waits : done))
        .catch((error): CommandResult => {
          const fields = { commandId, kind: command.kind, error: describe(error) };
          this.options.logger.error('a command failed', fields);
          return { ok: false, error: describe(error) };
        })
        .then((done) => {
          if (done !== null) this.options.journal.finish(commandId, done);
          return done;
        })
        // Gone before the result is given: a resend after an unanswered run runs it again.
        .finally(() => this.active.delete(commandId))
        .then(result.resolve, result.reject);
    };
    if (this.paused) this.held.push(run);
    else run();
    return result.promise;
  }

  /**
   * One command's work. An attempt's command reaches its controller with no await before it, so the controller's
   * queue takes it in arrival order.
   */
  private async execute(
    commandId: string,
    command: RunnerCommand,
    execution: Execution,
  ): Promise<CommandResult | Waits | null> {
    const attemptId = attemptOf(command);
    if (attemptId === null) {
      return this.runnerQueue.run('runner', () => this.runnerCommand(commandId, command, execution));
    }
    // A command held by a pause meets a welcome.stop that came meanwhile.
    if (this.refusedAsEnded(command)) return { ok: false, error: 'attempt_ended' };
    if (command.kind !== 'start_attempt' && !this.options.known(attemptId)) {
      return { ok: false, error: 'unknown_attempt' };
    }
    const controller = this.options.controller(attemptId);
    switch (command.kind) {
      case 'start_attempt':
        return resultOf(await controller.start(command.attempt));
      case 'resume_attempt':
        return resultOf(await controller.resume(command));
      case 'stop_attempt':
        return resultOf(await controller.stop(command));
      case 'hold_attempt':
        return resultOf(await controller.hold(command));
      case 'deliver':
        return resultOf(await controller.deliver(command));
      case 'interrupt':
        return resultOf(await controller.interrupt(command));
      case 'decide_approval':
        return resultOf(await controller.decideApproval(command));
      case 'push_submission': {
        const submitted = await controller.submit(command);
        return submitted.ok ? outcomeResult(submitted.outcome) : resultOf(submitted);
      }
      case 'prepare_takeover':
        return resultOf(await controller.prepareTakeover(command));
      case 'hand_back': {
        const handed = await controller.handBack(command);
        if (handed.ok) return { ok: true, data: handed };
        // process_running names the pids the person must end, as data: { pids } (X-37); the hub reads nothing else.
        return 'pids' in handed
          ? { ok: false, error: handed.error, data: { pids: handed.pids } }
          : { ok: false, error: handed.error };
      }
      case 'cleanup_attempt':
        return resultOf(await controller.cleanup());
      case 'upload_transcript':
        return resultOf(await controller.uploadTranscript());
      case 'prepare_dependencies': {
        // The command id is the request's id (X-40), which the hub returned to the agent.
        const requested = await controller.prepareRequested({ fence: command.fence, requestId: commandId });
        return requested.ok ? outcomeResult(requested.prepared) : resultOf(requested);
      }
      default:
        return { ok: false, error: 'unsupported' };
    }
  }

  /** The runner's own commands. */
  private async runnerCommand(
    commandId: string,
    command: RunnerCommand,
    execution: Execution,
  ): Promise<CommandResult | Waits | null> {
    const { vault, outbox } = this.options;
    switch (command.kind) {
      case 'refresh_vault':
        // A late-work ref the hub tells the current holder to merge: fetched before the agent asks for it.
        await vault.refresh(command.taskId, command.refs, this.options.wipRefPrefix());
        return { ok: true };
      case 'preflight': {
        const adapter = this.options.adapters.get(command.vendor);
        if (!adapter) return { ok: false, error: `no ${command.vendor} adapter on this runner` };
        // Run first: an optional call would skip its argument, the preflight itself, without the callback.
        const result = await adapter.preflight();
        this.options.preflighted?.(result);
        const { vendors, quota } = this.options.vendors();
        outbox.append({ type: 'runner.vendors', data: { vendors, quota } });
        return { ok: true };
      }
      case 'delete_refs': {
        // Each ref is deleted only at the sha the hub recorded; one that moved or is gone is reported as it is.
        const results = await deleteRefsFenced({
          vault,
          local: this.options.local,
          remote: await this.options.remote(),
          refs: command.refs,
        });
        const failed = results.find((result) => result.status === 'failed');
        return failed ? { ok: false, error: 'remote', data: results } : { ok: true, data: results };
      }
      case 'update_settings':
        return this.settingsEcho(commandId, command, execution);
      default:
        return { ok: false, error: 'unsupported' };
    }
  }

  /**
   * update_settings: the echo becomes the snapshot, and runner.json the snapshot with the edits still in flight
   * (SettingsSync.echo, X-12). One taken before the latest hello answers nothing: its version may be one a restored hub
   * hands out again with other settings, and the hub sends it again after the welcome, if it still has it. One that
   * fails, or would skip a version, waits (runWaiting), so a failure stalls no later echo until a reconnect.
   */
  private settingsEcho(
    commandId: string,
    command: Extract<RunnerCommand, { kind: 'update_settings' }>,
    execution: Execution,
  ): CommandResult | Waits | null {
    if (this.closed) return null;
    if (execution.lineage < this.lineage) {
      this.options.logger.warn('left unanswered an update_settings from before the last hello', {
        version: command.version,
      });
      return null;
    }
    if (this.runEcho(command, execution) === 'ran') {
      this.runWaiting();
      return { ok: true };
    }
    const waits = Promise.withResolvers<CommandResult | null>();
    this.waiting.set(commandId, { command, execution, resolve: waits.resolve });
    return { waits: waits.promise };
  }

  /** One echo's run: ran, waits (it would skip a version), or failed, which arms a retry. */
  private runEcho(
    command: Extract<RunnerCommand, { kind: 'update_settings' }>,
    execution: Execution,
  ): 'ran' | 'waits' | 'failed' {
    try {
      if (!this.settings.echo(command, execution.outboxSeq)) return 'waits';
      this.retryMs = SETTINGS_RETRY_MS;
      return 'ran';
    } catch (error) {
      const fields = { version: command.version, error: describe(error), retryMs: this.retryMs };
      this.options.logger.error('an update_settings failed; it runs again shortly', fields);
      this.retryLater();
      return 'failed';
    }
  }

  /**
   * The waiting update_settings, in version order, each run again until none can run: after an echo ran, and when a
   * retry comes. A failure stops the round; the retry after it starts again.
   */
  private runWaiting(): void {
    for (let ran = true; ran && this.waiting.size > 0; ) {
      ran = false;
      const waiting = [...this.waiting].sort(([, a], [, b]) => a.command.version - b.command.version);
      for (const [commandId, entry] of waiting) {
        const outcome = this.runEcho(entry.command, entry.execution);
        if (outcome === 'failed') return;
        if (outcome === 'waits') continue;
        this.waiting.delete(commandId);
        entry.resolve({ ok: true });
        ran = true;
      }
    }
  }

  /** Runs the waiting update_settings again after the backoff, on the runner's queue. */
  private retryLater(): void {
    if (this.retryTimer !== null || this.closed) return;
    const ms = this.retryMs;
    this.retryMs = Math.min(ms * 2, SETTINGS_RETRY_CAP_MS);
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null;
      this.runnerQueue
        .run('runner', async () => this.runWaiting())
        .catch((error) => {
          this.options.logger.error('cannot run the settings echoes again', { error: describe(error) });
        });
    }, ms);
  }

  /**
   * An update_settings whose journal row could not be written, taken again (with where it first came) after the
   * settings backoff; its result is the one taken then. The next hello or close() answers it nothing.
   */
  private retake(message: CommandMessage, seen: Sighting, error: unknown): Promise<CommandResult | null> {
    if (this.closed) return Promise.resolve(null);
    const ms = this.retryMs;
    this.retryMs = Math.min(ms * 2, SETTINGS_RETRY_CAP_MS);
    this.options.logger.error('cannot journal an update_settings; it is taken again shortly', {
      commandId: message.id,
      error: describe(error),
      retryMs: ms,
    });
    // A command the hub sent once is taken once: a resend while one waits shares its wait, and makes it current, as a
    // resend that joins an execution does; it keeps where it first came.
    const earlier = this.retakes.get(message.id);
    if (earlier !== undefined) {
      earlier.seen = { ...earlier.seen, lineage: Math.max(earlier.seen.lineage, seen.lineage) };
      const shared = Promise.withResolvers<CommandResult | null>();
      const resolve = earlier.resolve;
      earlier.resolve = (result) => {
        resolve(result);
        shared.resolve(result);
      };
      return shared.promise;
    }
    const taken = Promise.withResolvers<CommandResult | null>();
    const retake: Retake = {
      timer: this.timers.setTimeout(() => {
        if (this.retakes.get(message.id) !== retake) return;
        this.retakes.delete(message.id);
        this.take(message, retake.seen).then(retake.resolve, () => retake.resolve(null));
      }, ms),
      seen,
      resolve: taken.resolve,
    };
    this.retakes.set(message.id, retake);
    return taken.promise;
  }

  /**
   * Ends the retries; what waits answers nothing, its journal row left running (or never written) for the hub to send
   * it again.
   */
  private stopWaiting(): void {
    if (this.retryTimer !== null) this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryMs = SETTINGS_RETRY_MS;
    const waiting = [...this.waiting.values()];
    this.waiting.clear();
    for (const entry of waiting) entry.resolve(null);
    const retakes = [...this.retakes.values()];
    this.retakes.clear();
    for (const retake of retakes) {
      this.timers.clearTimeout(retake.timer);
      retake.resolve(null);
    }
  }
}

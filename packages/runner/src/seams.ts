// The seams M2c fills (X-7), each with a default that changes nothing, so the runner core runs and is tested without
// the service around it: RunnerHealth (admission, heartbeat health and the reported state), DependencyPreparer
// (design 7.7) and Notifier (design 6.10).
import type { AttemptSpec, Runner, RunnerMessage, StartRefusal, Vendor } from '@agflow/core';
import type { Vault } from './git/vault';

type Hello = Extract<RunnerMessage, { t: 'hello' }>;

/** What each heartbeat carries about the machine. */
export interface HealthReport {
  power: Runner['power'];
  disk: Runner['disk'];
  /** Ms from now during which the runner takes no new attempt (wake, battery, disk); null when it takes them. */
  acceptingUntil: number | null;
}

/** The state hello and runner.state report. */
export interface HealthState {
  state: Hello['state'];
  detail: string | null;
}

export interface RunnerHealth {
  /** Asked for each start_attempt after the core's own checks: one of core's START_REFUSALS, or null to admit. */
  admit(spec: AttemptSpec): StartRefusal | null | Promise<StartRefusal | null>;
  heartbeat(): HealthReport;
  state(): HealthState;
}

/** Admits every start and reports nothing about the machine. */
export const defaultHealth: RunnerHealth = Object.freeze({
  admit: () => null,
  heartbeat: () => ({ power: null, disk: null, acceptingUntil: null }),
  state: () => ({ state: 'ok' as const, detail: null }),
});

export interface PrepareInput {
  attemptId: string;
  vendor: Vendor;
  clone: string;
  /**
   * The project's vault: the preparer reads its config there at baseSha, and restores the protected paths through it
   * (restoreProtected) before it runs anything in the clone.
   */
  vault: Vault;
  /** The restore base (X-16). */
  baseSha: string;
  /** The agent environment the preparation runs with. */
  env: Record<string, string>;
  /** The prepare_dependencies command's id; null for a preparation before a start or resume (X-40). */
  requestId: string | null;
}

/** What attempt.prepared reports; ran is false when the project configures no preparation. */
export interface PrepareOutcome {
  ran: boolean;
  ok: boolean;
  error: string | null;
  logTail: string | null;
}

export interface DependencyPreparer {
  /** Whether this runner can prepare dependencies at all; it feeds hello's profile.dependencyPrep. */
  readonly available: boolean;
  prepare(input: PrepareInput): Promise<PrepareOutcome>;
}

/** Prepares nothing and reports that it cannot. */
export const skipDependencyPreparer: DependencyPreparer = Object.freeze({
  available: false,
  prepare: async () => ({ ran: false, ok: true, error: null, logTail: null }),
});

export interface Notification {
  /**
   * The kind of notification. A notifier may drop a repeat of a key it showed recently (M2c's macOS notifier drops
   * repeats within NOTIFY_REPEAT_MS); it never replaces a notification already shown.
   */
  key: string;
  title: string;
  body: string;
}

export interface Notifier {
  notify(notification: Notification): void | Promise<void>;
}

/** Posts nothing. */
export const silentNotifier: Notifier = Object.freeze({ notify: () => {} });

// The service's RunnerHealth (design 7.8, 7.9, X-41): admission holds for waking, battery, disk and needs_login, the
// state hello and runner.state report, the heartbeat's machine facts, and the guards that stop the agents below 8%
// battery or half of minFreeGb. Power is sampled on a timer so the battery guard also works with the link down; free
// space is read on use. A guard warns once per crossing but, while it stays tripped, stops whatever holds a slot again
// at each evaluation: a resume skips admit, and a stop can reach no agent (the handle not bound yet), so one call per
// crossing could leave agents running. Each agent is still stopped once: a stopped one holds no slot.
import type { StartRefusal } from '@agflow/core';
import { type ClockGap, type ClockSource, systemClock } from '../clock';
import type { RunnerConfig } from '../config';
import { type Logger, noopLogger } from '../log';
import type { RunnerPaths } from '../paths';
import type { HealthReport, RunnerHealth } from '../seams';
import { AgflowUsage, diskFreeBytes } from './disk';
import { type PowerSample, samplePower } from './power';

/** Below this battery percentage on battery power, the runner stops its agents (design 7.9). */
export const BATTERY_STOP_PERCENT = 8;
/** minFreeGb counts decimal gigabytes, as macOS reports free space. */
export const GB = 1_000_000_000;

export interface AdmissionInput {
  now: number;
  /** Epoch ms when the wake hold ends; null without one. */
  wakingUntil: number | null;
  power: PowerSample | null;
  freeBytes: number | null;
  needsLogin: boolean;
  minFreeGb: number;
  batteryDrainPercent: number;
}

export interface AdmissionDecision {
  /** The first of needs_login, waking, battery_low and disk_low that applies. */
  refusal: StartRefusal | null;
  waking: boolean;
  batteryLow: boolean;
  batteryStop: boolean;
  diskLow: boolean;
  diskStop: boolean;
}

/**
 * Unknown power or free space holds nothing; only battery power (a UPS included) can be low. The battery stop level is
 * a hold too, whatever batteryDrainPercent says, so the hub places nothing on a runner that would stop it at once.
 */
export function admissionDecision(input: AdmissionInput): AdmissionDecision {
  const { now, wakingUntil, power, freeBytes, needsLogin, minFreeGb, batteryDrainPercent } = input;
  const waking = wakingUntil !== null && now < wakingUntil;
  const percent = power?.source === 'battery' ? power.batteryPercent : null;
  const batteryLow = percent !== null && percent < Math.max(batteryDrainPercent, BATTERY_STOP_PERCENT);
  const batteryStop = percent !== null && percent < BATTERY_STOP_PERCENT;
  const diskLow = freeBytes !== null && freeBytes < minFreeGb * GB;
  const diskStop = freeBytes !== null && freeBytes < (minFreeGb * GB) / 2;
  const refusal = needsLogin
    ? 'needs_login'
    : waking
      ? 'waking'
      : batteryLow
        ? 'battery_low'
        : diskLow
          ? 'disk_low'
          : null;
  return { refusal, waking, batteryLow, batteryStop, diskLow, diskStop };
}

export interface ServiceHealth extends RunnerHealth {
  /**
   * RunnerEvents.gap: no new attempts until wakeHold after it; a later end is never shortened, and the hold never
   * reaches further than that gap's wakeHold from now, even after the wall clock steps back.
   */
  gap(gap: ClockGap): void;
  setNeedsLogin(on: boolean): void;
  /** The crash-loop guard's last error; null clears it (undrain). */
  setCrashLoop(detail: string | null): void;
  /** The last power sample; null before the first or when it failed. */
  power(): PowerSample | null;
  /** Samples power now and runs the guards; overlapping calls share the sample under way. */
  sample(): Promise<void>;
  /** Samples at once and then every sampleEveryMs. */
  start(): void;
  close(): void;
}

export interface ServiceHealthOptions {
  paths: RunnerPaths;
  /** runner.json's values, read on every use so an edit applies at once. */
  config: () => Pick<RunnerConfig, 'minFreeGb' | 'batteryDrainPercent' | 'timings'>;
  /** The interval heartbeats go at now: welcome's override, or timings.heartbeat. */
  heartbeatMs: () => number;
  /** RunnerHandle.stopAgents, bound by the host once the handle exists; it may throw until then. */
  stopAgents: (cause: 'runner_stop', options: { handoff: false }) => Promise<unknown>;
  samplePower?: () => Promise<PowerSample | null>;
  /** diskFreeBytes(AGFLOW_HOME) by default. */
  freeBytes?: () => number | null;
  /** agflow's own disk usage: an AgflowUsage over AGFLOW_HOME by default. */
  usage?: { current(): number };
  now?: () => number;
  clock?: ClockSource;
  /** 60 s. */
  sampleEveryMs?: number;
  /** Called after each power sample and each heartbeat: the host re-evaluates keep-awake there. */
  onSample?: () => void;
  logger?: Logger;
}

export function createServiceHealth(options: ServiceHealthOptions): ServiceHealth {
  const clock = options.clock ?? systemClock;
  const now = options.now ?? (() => clock.now());
  const logger = options.logger ?? noopLogger;
  const readPower = options.samplePower ?? samplePower;
  const readFreeBytes = options.freeBytes ?? (() => diskFreeBytes(options.paths.home));
  const usage = options.usage ?? new AgflowUsage({ root: options.paths.home, now });
  let power: PowerSample | null = null;
  let wakingUntil: number | null = null;
  /** The wakeHold of the gap that set wakingUntil. */
  let wakingFor = 0;
  let needsLogin = false;
  let crashLoop: string | null = null;
  let batteryTripped = false;
  let diskTripped = false;
  let stopping = false;
  let inFlight: Promise<void> | null = null;
  let timer: unknown = null;

  /** One stop call at a time; a stop with no agent to reach returns at once, so repeating it costs little. */
  function stop(): void {
    stopping = true;
    const failed = (error: unknown) => logger.error('guard stop failed', { error: String(error) });
    const done = () => {
      stopping = false;
    };
    try {
      options.stopAgents('runner_stop', { handoff: false }).catch(failed).finally(done);
    } catch (error) {
      failed(error);
      done();
    }
  }

  function evaluate() {
    const config = options.config();
    const at = now();
    if (wakingUntil !== null && wakingUntil - at > wakingFor) wakingUntil = at + wakingFor;
    const freeBytes = readFreeBytes();
    const decision = admissionDecision({
      ...config,
      now: at,
      wakingUntil,
      power,
      freeBytes,
      needsLogin,
    });
    if (decision.batteryStop && !batteryTripped) {
      logger.warn('battery guard stopping agents', { guard: 'battery', value: power?.batteryPercent ?? null });
    }
    if (decision.diskStop && !diskTripped) {
      logger.warn('disk guard stopping agents', { guard: 'disk', value: freeBytes });
    }
    batteryTripped = decision.batteryStop;
    diskTripped = decision.diskStop;
    // stopping is set before the host runs, so a reentrant health read starts no second call.
    if ((batteryTripped || diskTripped) && !stopping) stop();
    return { decision, at, freeBytes, minFreeGb: config.minFreeGb };
  }

  function notify(): void {
    try {
      options.onSample?.();
    } catch (error) {
      logger.error('health sample observer failed', { error: String(error) });
    }
  }

  function sample(): Promise<void> {
    if (inFlight) return inFlight;
    inFlight = Promise.resolve()
      .then(async () => {
        try {
          power = await readPower();
        } catch (error) {
          power = null;
          logger.error('power sample failed', { error: String(error) });
        }
        evaluate();
        notify();
      })
      // The timer does not await this: a throwing config read must not become an unhandled rejection.
      .catch((error) => logger.error('health evaluation failed', { error: String(error) }))
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  return {
    gap(gap) {
      const hold = options.config().timings.wakeHold;
      const end = gap.at + hold;
      if (wakingUntil === null || end > wakingUntil) {
        wakingUntil = end;
        wakingFor = hold;
      }
    },
    setNeedsLogin(on) {
      needsLogin = on;
    },
    setCrashLoop(detail) {
      crashLoop = detail;
    },
    power: () => power,
    sample,
    start() {
      if (timer !== null) return;
      timer = clock.setInterval(() => void sample(), options.sampleEveryMs ?? 60_000);
      void sample();
    },
    close() {
      if (timer !== null) clock.clearInterval(timer);
      timer = null;
    },
    admit: () => evaluate().decision.refusal,
    heartbeat() {
      const { decision, at, freeBytes } = evaluate();
      // A hold with no end goes out as two heartbeat intervals; the next heartbeat renews it.
      const hold = Math.max(
        decision.waking && wakingUntil !== null ? wakingUntil - at : 0,
        decision.batteryLow || decision.diskLow ? 2 * options.heartbeatMs() : 0,
      );
      const report: HealthReport = {
        power,
        disk: freeBytes === null ? null : { freeBytes, agflowBytes: usage.current() },
        acceptingUntil: hold > 0 ? hold : null,
      };
      notify();
      return report;
    },
    state() {
      const { decision, minFreeGb } = evaluate();
      if (crashLoop !== null) return { state: 'crash_loop', detail: crashLoop };
      // The detail stays fixed for a threshold: a change of it goes out as a persisted runner.state event, and the
      // heartbeat's disk.freeBytes already carries the live number.
      if (decision.diskLow) return { state: 'disk_low', detail: `free space below ${minFreeGb} GB` };
      return { state: 'ok', detail: null };
    },
  };
}

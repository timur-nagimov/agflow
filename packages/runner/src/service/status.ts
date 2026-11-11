// The control socket's public status contract (design 7.1, 7.8, X-41, X-42). Project fields explicitly: neither
// credentials nor an attempt spec belongs on a socket reachable by every process running as this user.
import { existsSync } from 'node:fs';
import type { RunnerVendor } from '@agflow/core';
import type { AttemptRecord } from '../attempt-store';
import type { RunnerConfig } from '../config';
import type { RunnerPaths } from '../paths';
import type { AttemptStatus, RunnerStatus } from '../runner';
import type { HealthReport, HealthState } from '../seams';
import { LAUNCHD_LABEL, plistPath } from './launchd';
import { type LockOwner, readLockOwner, type RunnerLock, type RunnerMode } from './lock';
import { tailLines } from './log';
import type { NeedsLoginState } from './needs-login';
import { type LastExit, ServiceRuns } from './runs';
import { defaultExec, type Exec } from './system';

/** Decimal gigabytes, as minFreeGb counts them. */
const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

type StatusAttempt = Omit<AttemptStatus, 'process'> & {
  ageMs: number | null;
  pid: number | null;
  pgid: number | null;
  /** ps's identity string, preserved verbatim for process-group identity checks. */
  lstart: string | null;
};

interface RunningStatus {
  running: true;
  pid: number;
  mode: RunnerMode;
  startedAt: number;
  runnerId: string | null;
  name: string;
  hubUrl: string | null;
  link: RunnerStatus['link'];
  state: HealthState['state'];
  reason: string | null;
  needsLogin: NeedsLoginState;
  draining: boolean;
  capacity: number;
  freeSlots: number;
  power: HealthReport['power'];
  disk: HealthReport['disk'];
  /** Epoch milliseconds, converted from the heartbeat's duration. */
  acceptingUntil: number | null;
  keepAwake: { mode: RunnerConfig['keepAwake']; held: boolean };
  dependencyPrep: boolean;
  vendors: RunnerVendor[];
  attempts: StatusAttempt[];
  keptClones: { attemptId: string; clone: string; error: string }[];
  warnings: string[];
}

interface OfflineStatus {
  running: false;
  bestEffort: true;
  plistInstalled: boolean;
  disabled: boolean | null;
  lastExit: LastExit | null;
  lockHolder: Pick<LockOwner, 'pid' | 'mode'> | null;
  logLines: string[];
  warnings: string[];
}

export type RunnerStatusReport = RunningStatus | OfflineStatus;

interface StatusInput {
  status: RunnerStatus | null;
  owner: RunnerLock['owner'];
  config: Pick<RunnerConfig, 'name' | 'capacity' | 'draining' | 'keepAwake' | 'minFreeGb'>;
  hubUrl: string | null;
  health: HealthState;
  heartbeat: HealthReport;
  needsLogin: NeedsLoginState;
  keepAwakeHeld: boolean;
  dependencyPrep: boolean;
  records: readonly Pick<AttemptRecord, 'attemptId' | 'createdAt' | 'state' | 'clone' | 'pushError' | 'lateWorkSha'>[];
  /** The host checks existence; building a report itself performs no I/O. */
  existingClones: readonly string[];
  now: number;
}

export function buildStatusReport(input: StatusInput): RunningStatus {
  const { status, config, heartbeat, needsLogin } = input;
  const settings = status?.settings ?? config;
  const records = new Map(input.records.map((record) => [record.attemptId, record]));
  const attempts = (status?.attempts ?? []).map((attempt): StatusAttempt => {
    const record = records.get(attempt.attemptId);
    return {
      attemptId: attempt.attemptId,
      taskId: attempt.taskId,
      role: attempt.role,
      vendor: attempt.vendor,
      state: attempt.state,
      phase: attempt.phase,
      ageMs: record ? Math.max(0, input.now - record.createdAt) : null,
      lastPushAt: attempt.lastPushAt,
      wipSha: attempt.wipSha,
      pushedSha: attempt.pushedSha,
      pushError: attempt.pushError,
      lateWorkSha: attempt.lateWorkSha,
      pid: attempt.process?.pid ?? null,
      pgid: attempt.process?.pgid ?? null,
      lstart: attempt.process?.lstart ?? null,
    };
  });
  const clones = new Set(input.existingClones);
  const reason =
    input.health.state === 'disk_low' && heartbeat.disk !== null
      ? `${gb(heartbeat.disk.freeBytes)} free, below the ${config.minFreeGb} GB minimum`
      : input.health.detail;
  return {
    running: true,
    pid: input.owner.pid,
    mode: input.owner.mode,
    startedAt: Date.parse(input.owner.startedAt),
    runnerId: status?.runnerId ?? null,
    name: config.name,
    hubUrl: input.hubUrl,
    link: status?.link ?? (needsLogin.on ? 'needs_login' : 'idle'),
    state: input.health.state,
    reason,
    needsLogin: { on: needsLogin.on, reason: needsLogin.reason, since: needsLogin.since },
    draining: settings.draining,
    capacity: settings.capacity,
    freeSlots: Math.max(0, settings.capacity - attempts.filter((attempt) => attempt.phase !== null).length),
    power:
      heartbeat.power === null
        ? null
        : {
            source: heartbeat.power.source,
            batteryPercent: heartbeat.power.batteryPercent,
            lowPowerMode: heartbeat.power.lowPowerMode,
          },
    disk:
      heartbeat.disk === null
        ? null
        : {
            freeBytes: heartbeat.disk.freeBytes,
            agflowBytes: heartbeat.disk.agflowBytes,
          },
    acceptingUntil: heartbeat.acceptingUntil === null ? null : input.now + heartbeat.acceptingUntil,
    keepAwake: { mode: settings.keepAwake, held: input.keepAwakeHeld },
    dependencyPrep: input.dependencyPrep,
    vendors: (status?.vendors ?? []).map((vendor) => ({
      vendor: vendor.vendor,
      ready: vendor.ready,
      problem: vendor.problem,
      cliVersion: vendor.cliVersion,
      ownerCliVersion: vendor.ownerCliVersion,
      accountId: vendor.accountId,
      plan: vendor.plan,
      managedPolicy: vendor.managedPolicy,
      models: { lead: vendor.models.lead, worker: vendor.models.worker },
      ceilings: { fiveHour: vendor.ceilings.fiveHour, weekly: vendor.ceilings.weekly },
      allowPaidUsage: vendor.allowPaidUsage,
      degraded: vendor.degraded,
      preflightAt: vendor.preflightAt,
    })),
    attempts,
    // Only an exited attempt keeps its clone for a failed or pending push; a resumed one can carry a stale error.
    keptClones: input.records.flatMap((record) =>
      (record.state === 'ended' || record.state === 'stopped') &&
      record.clone !== null &&
      (record.pushError !== null || record.lateWorkSha !== null) &&
      clones.has(record.clone)
        ? [{
            attemptId: record.attemptId,
            clone: record.clone,
            error: record.pushError ?? `final work ${record.lateWorkSha} has not reached a late-work ref yet`,
          }]
        : [],
    ),
    warnings: [],
  };
}

// agflow runner stop disables the job too, so the warning names both causes rather than blaming macOS.
export const LOGIN_ITEMS_WARNING =
  'launchd has the runner disabled: agflow runner stop does this, and so does switching agflow off in ' +
  'System Settings > General > Login Items; run agflow runner install to enable it again ' +
  '(allow agflow in Login Items first if macOS disabled it)';

export function parseLaunchdDisabled(output: string, label = LAUNCHD_LABEL): boolean | null {
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*"([^"]+)"\s*=>\s*(disabled|enabled|true|false)\s*[,;]?\s*$/);
    if (match?.[1] === label) return match[2] === 'disabled' || match[2] === 'true';
  }
  return null;
}

interface LaunchdStatusOptions {
  exec?: Exec;
  label?: string;
  uid?: number;
}

/** A missing command, unavailable GUI session or timeout leaves launchd's state unknown. */
export async function launchdDisabled(options: LaunchdStatusOptions = {}): Promise<boolean | null> {
  try {
    const result = await (options.exec ?? defaultExec)(
      ['launchctl', 'print-disabled', `gui/${options.uid ?? process.getuid!()}`],
      { timeoutMs: 3_000 },
    );
    return result.exitCode === 0 && !result.timedOut ? parseLaunchdDisabled(result.stdout, options.label) : null;
  } catch {
    return null;
  }
}

export async function offlineStatus(
  options: LaunchdStatusOptions & { paths: RunnerPaths; home?: string; launchd?: boolean },
): Promise<OfflineStatus> {
  const disabled = options.launchd === false ? null : await launchdDisabled(options);
  const owner = readLockOwner(options.paths);
  return {
    running: false,
    bestEffort: true,
    plistInstalled: options.launchd !== false && existsSync(plistPath({ home: options.home, label: options.label })),
    disabled,
    lastExit: new ServiceRuns(options.paths).lastExit({ running: owner !== null }),
    lockHolder: owner === null ? null : { pid: owner.pid, mode: owner.mode },
    logLines: tailLines(options.paths, 20),
    warnings: disabled ? [LOGIN_ITEMS_WARNING] : [],
  };
}

const time = (at: number | null) => (at === null ? 'unknown' : new Date(at).toISOString());
const line = (label: string, value: string) => `${label.padEnd(14)} ${value}`;

export function formatStatus(report: RunnerStatusReport): string {
  const lines: string[] = [];
  if (report.running) {
    lines.push(
      line('Runner', `${report.runnerId ?? 'pending'} (${report.name})`),
      line('Service', `pid ${report.pid}, ${report.mode}, started ${time(report.startedAt)}`),
      line('Hub', report.hubUrl ?? 'unknown'),
      line('Link', report.link),
      line('State', `${report.state}${report.reason ? `: ${report.reason}` : ''}`),
    );
    if (report.needsLogin.on) {
      lines.push(
        line(
          'Needs login',
          `needs_login: ${report.needsLogin.reason}; run agflow login (since ${time(report.needsLogin.since)})`,
        ),
      );
    }
    lines.push(
      line('Draining', String(report.draining)),
      line('Capacity', `${report.capacity}, free slots: ${report.freeSlots}`),
      line(
        'Power',
        report.power === null
          ? 'unknown'
          : `${report.power.source}, battery ${report.power.batteryPercent ?? 'unknown'}%, ` +
              `low power ${report.power.lowPowerMode}`,
      ),
      line(
        'Disk',
        report.disk === null
          ? 'unknown'
          : `${gb(report.disk.freeBytes)} free, agflow uses ${gb(report.disk.agflowBytes)}`,
      ),
      line('Accepting', report.acceptingUntil === null ? 'no timed hold' : `held until ${time(report.acceptingUntil)}`),
      line('Keep-awake', `${report.keepAwake.mode}, held: ${report.keepAwake.held}`),
      line('Dependencies', report.dependencyPrep ? 'available' : 'unavailable'),
    );
    for (const vendor of report.vendors) {
      lines.push(
        line(
          vendor.vendor,
          `${vendor.ready ? 'ready' : (vendor.problem ?? 'not ready')}; CLI ${vendor.cliVersion ?? 'unknown'}, ` +
            `owner CLI ${vendor.ownerCliVersion ?? 'unknown'}, plan ${vendor.plan ?? 'unknown'}`,
        ),
      );
    }
    for (const attempt of report.attempts) {
      lines.push(
        line(
          'Attempt',
          `${attempt.attemptId} task ${attempt.taskId ?? '-'} ${attempt.role} ${attempt.vendor} ` +
            `${attempt.state}/${attempt.phase ?? '-'} ` +
            `age ${attempt.ageMs === null ? 'unknown' : `${Math.floor(attempt.ageMs / 1_000)}s`} ` +
            `last push ${time(attempt.lastPushAt)} pid/pgid ${attempt.pid ?? '-'}/${attempt.pgid ?? '-'}`,
        ),
      );
    }
    for (const clone of report.keptClones)
      lines.push(line('Kept clone', `${clone.attemptId} ${clone.clone}: ${clone.error}`));
  } else {
    lines.push(
      'Runner is not running or not answering; best effort status.',
      line('Plist', report.plistInstalled ? 'installed' : 'not installed'),
      line('Launchd', report.disabled === null ? 'disabled state unknown' : report.disabled ? 'disabled' : 'enabled'),
      line(
        'Last exit',
        report.lastExit === null
          ? 'unknown'
          : `${report.lastExit.reason} at ${time(report.lastExit.at)} ` +
              `(code ${report.lastExit.code ?? 'unknown'}, clean: ${report.lastExit.clean})`,
      ),
    );
    if (report.lockHolder !== null)
      lines.push(
        line('Lock holder', `pid ${report.lockHolder.pid ?? 'unknown'}, ${report.lockHolder.mode ?? 'unknown'}`),
      );
    lines.push('Last log lines:', ...report.logLines);
  }
  for (const warning of report.warnings) lines.push(`Warning: ${warning}`);
  return `${lines.join('\n')}\n`;
}

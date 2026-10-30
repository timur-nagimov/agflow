// The runner registry (design 6.1, 6.3): runner rows, their identity checks at hello, the state the hub derives for
// them, and the Runner view the API and the scheduler read.
import {
  CLOSE_CODES,
  PROTOCOL_VERSION,
  type ProfileSummary,
  type Runner,
  type RunnerMessage,
  type RunnerSettings,
  type RunnerState,
  type RunnerVendor,
  type StartRefusal,
  type Vendor,
} from '@agflow/core';
import { verifySessionHash } from './auth';
import { type CommandRow, type StoredCommand, cancelPendingSettings, enqueueCommand } from './commands';
import { type HubContext, afterCommit, tx } from './context';
import { nextId } from './db';
import { notFound } from './errors';
import type { Emit } from './events';

export type HelloMessage = Extract<RunnerMessage, { t: 'hello' }>;

/** What a runner reports about its own state in hello and runner.state; the hub derives the rest. */
export type ReportedState = HelloMessage['state'];

/** runners.info: what the runner reports, and the hub-confirmed settings that have no column of their own. */
export interface RunnerInfo {
  agflowVersion: string;
  platform: string;
  vendors: RunnerVendor[];
  profile: ProfileSummary;
  git: Runner['git'];
  power: Runner['power'];
  disk: Runner['disk'];
  ceilings: RunnerSettings['ceilings'];
  allowPaidUsage: RunnerSettings['allowPaidUsage'];
  /**
   * The runner's last refused start since its last heartbeat (X-3): placement passes the runner over until the next
   * heartbeat clears it. Rows written before it existed have none.
   */
  startRefusal?: StartRefusalMark | null;
  /**
   * Attempts its last hello reported stopped or suspended while it was not ok (X-36): their resumes wait for
   * runner.state ok. Rows written before it existed have none.
   */
  deferredResumes?: string[];
}

/** A refused start: the runner's code for it, and when the hub heard of it. */
export interface StartRefusalMark {
  code: StartRefusal;
  at: number;
}

/** A vendor's hub-owned marks on one runner; runner messages never set them (design 6.3). */
export interface VendorHold {
  /** Continuous vendor errors (design 6.8): no placement before this time. */
  degradedUntil: number | null;
  /** Consecutive failed starts, refusals excluded (design 6.9). */
  failedStarts: number;
  /** Set by two failed starts or an expired login; a vendor report with a later preflightAt clears it. */
  notReadySince: number | null;
}

export type VendorHolds = Partial<Record<Vendor, VendorHold>>;

export interface RunnerRow {
  id: string;
  seq: number;
  runner_key: string;
  machine_id: string;
  owner: string;
  name: string;
  state: RunnerState;
  state_detail: string | null;
  last_error: string | null;
  capacity: number;
  keep_awake: Runner['keepAwake'];
  draining: number;
  settings_version: number;
  protocol: number;
  info: string;
  vendor_holds: string;
  accepting_until: number | null;
  connection_id: string | null;
  session_hash: string | null;
  last_seen_at: number;
  created_at: number;
  retired_at: number | null;
  /** Its starting, running and quota_wait attempts, a lead's included: the ones that take a slot. */
  active_attempts: number;
}

const RUNNER_SELECT = `SELECT runners.*, (SELECT COUNT(*) FROM attempts WHERE attempts.runner_id = runners.id
  AND attempts.status IN ('starting', 'running', 'quota_wait')) AS active_attempts FROM runners`;

export const runnerInfo = (row: Pick<RunnerRow, 'info'>): RunnerInfo => JSON.parse(row.info) as RunnerInfo;
export const vendorHolds = (row: Pick<RunnerRow, 'vendor_holds'>): VendorHolds =>
  JSON.parse(row.vendor_holds) as VendorHolds;

const NOT_READY_PROBLEM = 'marked not ready by the hub until a preflight passes';

/** The runner's vendors with the hub's own view laid over the report: its marks and its copy of the settings. */
function vendorsOf(info: RunnerInfo, holds: VendorHolds, now: number): RunnerVendor[] {
  return info.vendors.map((reported) => {
    const hold = holds[reported.vendor];
    const notReady = hold?.notReadySince != null;
    return {
      ...reported,
      ready: reported.ready && !notReady,
      problem: notReady && reported.ready ? NOT_READY_PROBLEM : reported.problem,
      ceilings: info.ceilings[reported.vendor] ?? reported.ceilings,
      allowPaidUsage: info.allowPaidUsage[reported.vendor] ?? reported.allowPaidUsage,
      degraded: hold?.degradedUntil != null && now < hold.degradedUntil,
    };
  });
}

export function rowToRunner(row: RunnerRow, now: number): Runner {
  const info = runnerInfo(row);
  // A refused start is why the runner takes no attempt until its next heartbeat, so the card says so (X-49); the
  // link's own detail stays in state_detail and shows again once the heartbeat clears the refusal.
  const refusal = info.startRefusal ?? null;
  return {
    id: row.id,
    owner: row.owner,
    name: row.name,
    state: row.state,
    stateDetail: refusal ? `refused a start: ${refusal.code}` : row.state_detail,
    lastError: row.last_error,
    capacity: row.capacity,
    keepAwake: row.keep_awake,
    draining: row.draining === 1,
    settingsVersion: row.settings_version,
    protocol: row.protocol,
    agflowVersion: info.agflowVersion,
    platform: info.platform,
    vendors: vendorsOf(info, vendorHolds(row), now),
    profile: info.profile,
    git: info.git,
    power: info.power,
    disk: info.disk,
    acceptingUntil: row.accepting_until,
    activeAttempts: row.active_attempts,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
  };
}

export function findRunnerRow(ctx: HubContext, id: string): RunnerRow | null {
  return ctx.db.query(`${RUNNER_SELECT} WHERE runners.id = $id`).get({ id }) as RunnerRow | null;
}

/** Retired runners included: their rows stay, so their key keeps being refused. */
export function findRunnerByKey(ctx: HubContext, runnerKey: string): RunnerRow | null {
  return ctx.db.query(`${RUNNER_SELECT} WHERE runners.runner_key = $runnerKey`).get({ runnerKey }) as RunnerRow | null;
}

export function findRunner(ctx: HubContext, id: string): Runner | null {
  const row = findRunnerRow(ctx, id);
  return row ? rowToRunner(row, ctx.now()) : null;
}

export function getRunner(ctx: HubContext, id: string): Runner {
  const runner = findRunner(ctx, id);
  if (!runner) throw notFound(`runner ${id}`);
  return runner;
}

/** Runner rows in id order; retired ones only when asked for. */
export function findRunnerRows(ctx: HubContext, options: { retired?: boolean } = {}): RunnerRow[] {
  return ctx.db
    .query(`${RUNNER_SELECT} ${options.retired ? '' : 'WHERE runners.retired_at IS NULL'} ORDER BY runners.seq`)
    .all() as RunnerRow[];
}

/** Runners in id order; retired ones only when asked for. */
export function listRunners(ctx: HubContext, options: { retired?: boolean } = {}): Runner[] {
  const now = ctx.now();
  return findRunnerRows(ctx, options).map((row) => rowToRunner(row, now));
}

// ---------------------------------------------------------------------------
// Identity (design 6.3)
// ---------------------------------------------------------------------------

/** What a hello must carry for the hub to judge it, even one it cannot otherwise read. */
export interface HelloIdentity {
  protocol: number;
  runnerKey: string;
  machineId: string;
}

const RETIRED_REASON = 'this runner was retired; run agflow runner setup';

export type IdentifyResult =
  | { ok: true; runner: RunnerRow; registered: boolean }
  | { ok: false; code: (typeof CLOSE_CODES)['refused' | 'incompatible']; reason: string };

/**
 * The checks of a hello in order: a known key from another user or machine, or a retired runner, gets 4403; then a
 * protocol outside [minProtocol, PROTOCOL_VERSION] gets 4426, and a known runner reads incompatible. runner is null
 * for an unknown key that passes, which only a readable hello may register.
 */
export function checkRunnerIdentity(
  ctx: HubContext,
  user: string,
  hello: HelloIdentity,
): { ok: true; runner: RunnerRow | null } | Extract<IdentifyResult, { ok: false }> {
  const row = findRunnerByKey(ctx, hello.runnerKey);
  if (row && row.retired_at !== null) {
    return { ok: false, code: CLOSE_CODES.refused, reason: RETIRED_REASON };
  }
  if (row && (row.owner !== user.toLowerCase() || row.machine_id !== hello.machineId)) {
    return {
      ok: false,
      code: CLOSE_CODES.refused,
      reason: `this runner belongs to ${row.owner} on another machine; run agflow runner setup`,
    };
  }
  const min = ctx.config.minProtocol;
  if (hello.protocol < min || hello.protocol > PROTOCOL_VERSION) {
    const reason =
      `runner protocol ${hello.protocol} is not supported: ` + `this hub accepts protocol ${min} to ${PROTOCOL_VERSION}`;
    if (row) {
      // A runner with a working link keeps its state: the refused hello came from a second process (design 6.3).
      ctx.db
        .query(
          `UPDATE runners SET state = 'incompatible', state_detail = $reason, protocol = $protocol
           WHERE id = $id AND connection_id IS NULL`,
        )
        .run({ id: row.id, reason, protocol: hello.protocol });
    }
    return { ok: false, code: CLOSE_CODES.incompatible, reason };
  }
  return { ok: true, runner: row };
}

/**
 * Identifies the runner a hello speaks for. An unknown key registers a new runner, R-<n>, owned by the session's user
 * and bound to the hello's machine; the owner never changes. The runner starts offline with settings version 0, so
 * settings sync confirms the reported settings as version 1.
 */
export function identifyRunner(ctx: HubContext, user: string, hello: HelloMessage): IdentifyResult {
  return tx(ctx, () => {
    const checked = checkRunnerIdentity(ctx, user, hello);
    if (!checked.ok) return checked;
    if (checked.runner) {
      // The runner may have been upgraded, or refused as incompatible before.
      ctx.db
        .query('UPDATE runners SET protocol = $protocol WHERE id = $id')
        .run({ id: checked.runner.id, protocol: hello.protocol });
      return { ok: true, runner: findRunnerRow(ctx, checked.runner.id) as RunnerRow, registered: false };
    }
    const seq = nextId(ctx.db, 'runner');
    const id = `R-${seq}`;
    const info: RunnerInfo = {
      agflowVersion: hello.agflowVersion,
      platform: hello.platform,
      vendors: hello.vendors,
      profile: hello.profile,
      git: hello.git,
      power: null,
      disk: null,
      ceilings: hello.settings.ceilings,
      allowPaidUsage: hello.settings.allowPaidUsage,
      startRefusal: null,
    };
    const now = ctx.now();
    ctx.db
      .query(
        `INSERT INTO runners (id, seq, runner_key, machine_id, owner, name, state, capacity, keep_awake, draining,
           settings_version, protocol, info, last_seen_at, created_at)
         VALUES ($id, $seq, $key, $machine, $owner, $name, 'offline', $capacity, $keepAwake, $draining, 0, $protocol,
           $info, $now, $now)`,
      )
      .run({
        id,
        seq,
        key: hello.runnerKey,
        machine: hello.machineId,
        owner: user.toLowerCase(),
        name: hello.name,
        capacity: hello.settings.capacity,
        keepAwake: hello.settings.keepAwake,
        draining: hello.settings.draining ? 1 : 0,
        protocol: hello.protocol,
        info: JSON.stringify(info),
        now,
      });
    return { ok: true, runner: findRunnerRow(ctx, id) as RunnerRow, registered: true };
  });
}

/**
 * Stores what a hello reports about the runner: its name, version, platform, profile, git readiness and vendors (a
 * hello with git.ready sets it back after failed WIP pushes).
 */
export function recordHelloInfo(ctx: HubContext, runnerId: string, hello: HelloMessage): void {
  const row = findRunnerRow(ctx, runnerId);
  if (!row) throw notFound(`runner ${runnerId}`);
  const info: RunnerInfo = {
    ...runnerInfo(row),
    agflowVersion: hello.agflowVersion,
    platform: hello.platform,
    profile: hello.profile,
    git: hello.git,
  };
  ctx.db
    .query('UPDATE runners SET name = $name, info = $info WHERE id = $id')
    .run({ id: runnerId, name: hello.name, info: JSON.stringify(info) });
  applyVendorReport(ctx, runnerId, hello.vendors);
}

/** What each heartbeat reports about the runner itself. */
export type HeartbeatInfo = Pick<Extract<RunnerMessage, { t: 'heartbeat' }>, 'power' | 'disk' | 'acceptingUntil'>;

/**
 * Records a heartbeat: power, disk and the time it was seen. acceptingUntil comes as ms from now, so clocks need
 * not agree, and is stored as epoch ms; null clears it. A heartbeat also clears the last refused start: the runner
 * may take attempts again (X-3).
 */
export function recordHeartbeatInfo(ctx: HubContext, runnerId: string, heartbeat: HeartbeatInfo): void {
  const row = findRunnerRow(ctx, runnerId);
  if (!row) throw notFound(`runner ${runnerId}`);
  const now = ctx.now();
  const info: RunnerInfo = { ...runnerInfo(row), power: heartbeat.power, disk: heartbeat.disk, startRefusal: null };
  ctx.db
    .query('UPDATE runners SET info = $info, accepting_until = $acceptingUntil, last_seen_at = $now WHERE id = $id')
    .run({
      id: runnerId,
      info: JSON.stringify(info),
      acceptingUntil: heartbeat.acceptingUntil === null ? null : now + heartbeat.acceptingUntil,
      now,
    });
}

/**
 * A refused start (attempt.failed_to_start with refused set): it shows on the runner's card as its last error, and
 * no attempt is placed on the runner until its next heartbeat (design 6.3, X-3).
 */
export function recordStartRefusal(ctx: HubContext, runnerId: string, code: StartRefusal): void {
  const row = existingRow(ctx, runnerId);
  const info: RunnerInfo = { ...runnerInfo(row), startRefusal: { code, at: ctx.now() } };
  ctx.db
    .query('UPDATE runners SET info = $info, last_error = $error WHERE id = $id')
    .run({ id: runnerId, info: JSON.stringify(info), error: `refused a start: ${code}` });
}

/**
 * Failed WIP pushes (attempt.wip_failed with 3 or more in a row, X-3): the runner's git is not ready, with the error,
 * until a later push goes through or a hello with git.ready.
 */
export function markGitNotReady(ctx: HubContext, runnerId: string, problem: string): void {
  const info = runnerInfo(existingRow(ctx, runnerId));
  info.git = { ...info.git, ready: false, problem };
  ctx.db.query('UPDATE runners SET info = $info WHERE id = $id').run({ id: runnerId, info: JSON.stringify(info) });
}

/** A push went through (attempt.wip, or late work): the runner's git is ready, and pushed last now. */
export function markGitPushed(ctx: HubContext, runnerId: string): void {
  const info = runnerInfo(existingRow(ctx, runnerId));
  info.git = { ready: true, problem: null, lastPushAt: ctx.now() };
  ctx.db.query('UPDATE runners SET info = $info WHERE id = $id').run({ id: runnerId, info: JSON.stringify(info) });
}

/** Records the attempts whose resumes wait for the runner's runner.state ok; an empty list clears them. */
export function setDeferredResumes(ctx: HubContext, runnerId: string, attemptIds: string[]): void {
  const info = runnerInfo(existingRow(ctx, runnerId));
  info.deferredResumes = attemptIds;
  ctx.db.query('UPDATE runners SET info = $info WHERE id = $id').run({ id: runnerId, info: JSON.stringify(info) });
}

/** The attempts whose resumes waited for runner.state ok, which are no longer recorded once taken. */
export function takeDeferredResumes(ctx: HubContext, runnerId: string): string[] {
  const deferred = runnerInfo(existingRow(ctx, runnerId)).deferredResumes ?? [];
  if (deferred.length > 0) setDeferredResumes(ctx, runnerId, []);
  return deferred;
}

// ---------------------------------------------------------------------------
// State (design 6.3)
// ---------------------------------------------------------------------------

export interface RunnerStateInput {
  /** The runner has a link. */
  linked: boolean;
  /** The CLI session its link used still verifies. */
  sessionValid: boolean;
  reported: ReportedState;
}

/** incompatible is set by a refused hello (checkRunnerIdentity) and lasts until a hello passes. */
export function deriveRunnerState(input: RunnerStateInput): Exclude<RunnerState, 'incompatible'> {
  if (!input.linked) return input.sessionValid ? 'offline' : 'needs_login';
  return input.reported === 'ok' ? 'online' : input.reported;
}

export interface LinkInfo {
  connectionId: string;
  /** The CLI session the link authenticated with. */
  sessionHash: string;
  state: ReportedState;
  stateDetail: string | null;
}

/** Records the runner's new link and the state it reports; a report that is not ok also becomes lastError. */
export function markLinked(ctx: HubContext, emit: Emit, runnerId: string, link: LinkInfo): void {
  const row = findRunnerRow(ctx, runnerId);
  if (!row) throw notFound(`runner ${runnerId}`);
  ctx.db
    .query(
      `UPDATE runners SET connection_id = $connectionId, session_hash = $sessionHash, state = $state,
         state_detail = $detail, last_error = CASE WHEN $reported = 'ok' THEN last_error ELSE $detail END,
         last_seen_at = $now
       WHERE id = $id`,
    )
    .run({
      id: runnerId,
      connectionId: link.connectionId,
      sessionHash: link.sessionHash,
      state: deriveRunnerState({ linked: true, sessionValid: true, reported: link.state }),
      reported: link.state,
      detail: link.stateDetail,
      now: ctx.now(),
    });
  emit({ type: 'runner.online', actor: `runner:${runnerId}`, subject: runnerId, data: { runnerId, name: row.name } });
}

/**
 * runner.state over the runner's link: crash_loop or disk_low as reported, with the detail as lastError, or online
 * again with ok. It emits no event: runner.updated names changed settings, and pages reload runners on their own.
 */
export function setReportedState(ctx: HubContext, runnerId: string, reported: ReportedState, detail: string | null): void {
  existingRow(ctx, runnerId);
  const state = deriveRunnerState({ linked: true, sessionValid: true, reported });
  ctx.db
    .query(
      `UPDATE runners SET state = $state, state_detail = $detail,
         last_error = CASE WHEN $reported = 'ok' THEN last_error ELSE $detail END
       WHERE id = $id`,
    )
    .run({ id: runnerId, state, reported, detail });
}

function sessionVerifies(ctx: HubContext, row: Pick<RunnerRow, 'session_hash'>): boolean {
  return row.session_hash !== null && verifySessionHash(ctx, row.session_hash) !== null;
}

function emitOffline(emit: Emit, row: Pick<RunnerRow, 'id' | 'name'>, state: RunnerState): void {
  emit({
    type: 'runner.offline',
    actor: 'system',
    subject: row.id,
    data: { runnerId: row.id, name: row.name, state },
  });
}

/**
 * The runner's link closed: it is offline, or needs_login when the session its link used no longer verifies. A close
 * from a connection that is no longer the runner's link changes nothing: false.
 */
export function markUnlinked(ctx: HubContext, emit: Emit, runnerId: string, connectionId: string): boolean {
  const row = findRunnerRow(ctx, runnerId);
  if (!row || row.connection_id !== connectionId) return false;
  const state = deriveRunnerState({ linked: false, sessionValid: sessionVerifies(ctx, row), reported: 'ok' });
  ctx.db
    .query('UPDATE runners SET connection_id = NULL, state = $state, state_detail = NULL WHERE id = $id')
    .run({ id: runnerId, state });
  emitOffline(emit, row, state);
  return true;
}

/**
 * A starting hub has no links yet: runners an earlier hub process left linked are unlinked, offline or needs_login.
 * Returns how many.
 */
export function unlinkAll(ctx: HubContext): number {
  return tx(ctx, (emit) => {
    const rows = ctx.db
      .query(`${RUNNER_SELECT} WHERE connection_id IS NOT NULL ORDER BY seq`)
      .all() as RunnerRow[];
    for (const row of rows) markUnlinked(ctx, emit, row.id, row.connection_id as string);
    return rows.length;
  });
}

/**
 * The auth sweep's half for runners: an offline runner whose session expired or was signed out needs a new login.
 * Returns the runners it marked.
 */
export function refreshNeedsLogin(ctx: HubContext): string[] {
  return tx(ctx, (emit) => {
    const rows = ctx.db
      .query(`${RUNNER_SELECT} WHERE state = 'offline' AND connection_id IS NULL AND retired_at IS NULL ORDER BY seq`)
      .all() as RunnerRow[];
    const marked: string[] = [];
    for (const row of rows) {
      if (sessionVerifies(ctx, row)) continue;
      ctx.db.query("UPDATE runners SET state = 'needs_login' WHERE id = $id").run({ id: row.id });
      emitOffline(emit, row, 'needs_login');
      marked.push(row.id);
    }
    return marked;
  });
}

/**
 * Retires the runner: its key is refused from now on. A connected runner's link closes with 4403 once the transaction
 * commits, so the runner records why and stops. False when it was already retired.
 */
export function markRetired(ctx: HubContext, emit: Emit, runnerId: string, actor: string): boolean {
  const row = findRunnerRow(ctx, runnerId);
  if (!row) throw notFound(`runner ${runnerId}`);
  if (row.retired_at !== null) return false;
  ctx.db.query('UPDATE runners SET retired_at = $now WHERE id = $id').run({ id: runnerId, now: ctx.now() });
  emit({ type: 'runner.retired', actor, subject: runnerId, data: { runnerId, name: row.name } });
  afterCommit(ctx, () => ctx.link.closeRunner(runnerId, CLOSE_CODES.refused, RETIRED_REASON));
  return true;
}

// ---------------------------------------------------------------------------
// Settings sync (design 6.3): runner.json is the source, and only the hub assigns versions. Ceilings and paid usage
// are records per vendor, and each vendor's entry counts as its own field, as on the runner.
// ---------------------------------------------------------------------------

export type SettingsValues = Omit<RunnerSettings, 'version'>;
export type SettingsChanges = Partial<SettingsValues>;

/** The settings the hub confirmed last, with their version. */
export function runnerSettings(row: RunnerRow): RunnerSettings {
  const info = runnerInfo(row);
  return {
    capacity: row.capacity,
    keepAwake: row.keep_awake,
    draining: row.draining === 1,
    ceilings: info.ceilings,
    allowPaidUsage: info.allowPaidUsage,
    version: row.settings_version,
  };
}

/** Writes the given fields at the given version; per-vendor records merge vendor by vendor. */
function writeSettings(ctx: HubContext, row: RunnerRow, changes: SettingsChanges, version: number): void {
  const info = runnerInfo(row);
  if (changes.ceilings) info.ceilings = { ...info.ceilings, ...changes.ceilings };
  if (changes.allowPaidUsage) info.allowPaidUsage = { ...info.allowPaidUsage, ...changes.allowPaidUsage };
  ctx.db
    .query(
      `UPDATE runners SET capacity = $capacity, keep_awake = $keepAwake, draining = $draining,
         settings_version = $version, info = $info
       WHERE id = $id`,
    )
    .run({
      id: row.id,
      capacity: changes.capacity ?? row.capacity,
      keepAwake: changes.keepAwake ?? row.keep_awake,
      draining: changes.draining === undefined ? row.draining : changes.draining ? 1 : 0,
      version,
      info: JSON.stringify(info),
    });
}

function settingsCommand(settings: SettingsChanges, version: number): StoredCommand {
  return { kind: 'update_settings', settings, version };
}

function existingRow(ctx: HubContext, runnerId: string): RunnerRow {
  const row = findRunnerRow(ctx, runnerId);
  if (!row) throw notFound(`runner ${runnerId}`);
  return row;
}

/**
 * Compares a hello's settings snapshot with the hub's (design 6.3, "Settings sync"), in the hello's transaction:
 * - stored: a new runner (version 0 here) has its reported settings stored at version 1 and echoed;
 * - unchanged: equal versions;
 * - sent: the runner's version is older, as when its owner changed settings in the browser meanwhile, so the hub
 *   sends all of its settings;
 * - adopted: the runner's version is newer, which only a restored hub sees, so the hub takes its values and version
 *   and cancels the older update_settings it still had queued.
 */
export function reconcileHelloSettings(
  ctx: HubContext,
  runnerId: string,
  reported: RunnerSettings,
): 'stored' | 'unchanged' | 'sent' | 'adopted' {
  const row = existingRow(ctx, runnerId);
  const { version, ...values } = reported;
  if (row.settings_version === 0) {
    writeSettings(ctx, row, values, 1);
    enqueueCommand(ctx, runnerId, settingsCommand(values, 1));
    return 'stored';
  }
  if (version === row.settings_version) return 'unchanged';
  if (version > row.settings_version) {
    writeSettings(ctx, row, values, version);
    cancelPendingSettings(ctx, runnerId);
    return 'adopted';
  }
  const { version: hubVersion, ...hubValues } = runnerSettings(row);
  enqueueCommand(ctx, runnerId, settingsCommand(hubValues, hubVersion));
  return 'sent';
}

/** Applies changes at the hub's version + 1, queues their update_settings echo, and emits runner.updated. */
function changeSettings(
  ctx: HubContext,
  emit: Emit,
  row: RunnerRow,
  changes: SettingsChanges,
  actor: string,
): CommandRow {
  const version = row.settings_version + 1;
  writeSettings(ctx, row, changes, version);
  emit({
    type: 'runner.updated',
    actor,
    subject: row.id,
    data: { runnerId: row.id, name: row.name, fields: Object.keys(changes) },
  });
  return enqueueCommand(ctx, row.id, settingsCommand(changes, version));
}

/**
 * runner.settings: the runner's local edits (drain, undrain, a hand edit, the crash-loop self-drain). They apply
 * whatever the event's baseVersion, because the runner sends again only edits that still differ from what the hub
 * echoed. Returns the queued update_settings echo.
 */
export function applyRunnerSettings(ctx: HubContext, emit: Emit, runnerId: string, changes: SettingsChanges): CommandRow {
  return changeSettings(ctx, emit, existingRow(ctx, runnerId), changes, `runner:${runnerId}`);
}

/** The owner's PATCH /api/runners/:id: a new version, sent to the runner with update_settings. */
export function patchRunnerSettings(
  ctx: HubContext,
  emit: Emit,
  runnerId: string,
  patch: SettingsChanges,
  actor: string,
): Runner {
  changeSettings(ctx, emit, existingRow(ctx, runnerId), patch, actor);
  return getRunner(ctx, runnerId);
}

// ---------------------------------------------------------------------------
// Vendor reports and the hub's vendor holds (design 6.3, 6.8, 6.9)
// ---------------------------------------------------------------------------

const NO_HOLD: VendorHold = { degradedUntil: null, failedStarts: 0, notReadySince: null };

function changeHold(
  ctx: HubContext,
  runnerId: string,
  vendor: Vendor,
  change: (hold: VendorHold) => VendorHold,
): VendorHold {
  const holds = vendorHolds(existingRow(ctx, runnerId));
  const next = change({ ...NO_HOLD, ...holds[vendor] });
  holds[vendor] = next;
  ctx.db
    .query('UPDATE runners SET vendor_holds = $holds WHERE id = $id')
    .run({ id: runnerId, holds: JSON.stringify(holds) });
  return next;
}

/**
 * Stores the vendors a hello or runner.vendors reports. Their degraded flags are ignored: the hub's holds decide. A
 * report of a preflight run after a not-ready mark clears the mark.
 */
export function applyVendorReport(ctx: HubContext, runnerId: string, vendors: RunnerVendor[]): void {
  const row = existingRow(ctx, runnerId);
  const info = runnerInfo(row);
  info.vendors = vendors;
  const holds = vendorHolds(row);
  for (const report of vendors) {
    const hold = holds[report.vendor];
    if (hold?.notReadySince != null && report.preflightAt !== null && report.preflightAt > hold.notReadySince) {
      holds[report.vendor] = { ...hold, notReadySince: null };
    }
  }
  ctx.db
    .query('UPDATE runners SET info = $info, vendor_holds = $holds WHERE id = $id')
    .run({ id: runnerId, info: JSON.stringify(info), holds: JSON.stringify(holds) });
}

/** Continuous vendor errors: no new attempts of the vendor on this runner for degradedMs (design 6.8). */
export function setDegraded(ctx: HubContext, runnerId: string, vendor: Vendor): void {
  const until = ctx.now() + ctx.config.degradedMs;
  changeHold(ctx, runnerId, vendor, (hold) => ({ ...hold, degradedUntil: until }));
}

/**
 * Marks the vendor not ready on this runner (two failed starts, an expired login) and asks the runner for a preflight,
 * whose later report clears the mark. The failed-start count starts again. False when it was marked already.
 */
export function markVendorNotReady(ctx: HubContext, runnerId: string, vendor: Vendor): boolean {
  const current = vendorHolds(existingRow(ctx, runnerId))[vendor];
  if (current?.notReadySince != null) return false;
  const now = ctx.now();
  changeHold(ctx, runnerId, vendor, (hold) => ({ ...hold, notReadySince: now, failedStarts: 0 }));
  enqueueCommand(ctx, runnerId, { kind: 'preflight', vendor });
  return true;
}

/** Counts a failed start of the vendor on this runner (refusals are not counted); returns the consecutive count. */
export function recordFailedStart(ctx: HubContext, runnerId: string, vendor: Vendor): number {
  return changeHold(ctx, runnerId, vendor, (hold) => ({ ...hold, failedStarts: hold.failedStarts + 1 })).failedStarts;
}

/** A start that worked ends the run of failed ones. */
export function resetFailedStarts(ctx: HubContext, runnerId: string, vendor: Vendor): void {
  changeHold(ctx, runnerId, vendor, (hold) => ({ ...hold, failedStarts: 0 }));
}

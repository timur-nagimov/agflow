// runner.json (design 7.1, 12 and 15.1): the runner's identity, its settings and the snapshot of the ones the hub
// last confirmed, the environment captured at setup, and every runner timing. It holds no secrets and no vendor
// pins (those live in vendor/pins.ts, X-10). The settings sync rules of design 6.3 are pure functions here (X-12),
// so the executor and the runtime only call them.
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import { type RunnerSettings, RunnerSettingsSchema, type Vendor, VendorSchema } from '@agflow/core';
import { z } from 'zod';
import type { RunnerPaths } from './paths';

/** The connectivity variables setup captures from the owner's login shell and agents inherit (design 7.1, 7.6). */
export const CONNECTIVITY_VARS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'GIT_SSL_CAINFO',
] as const;
export type ConnectivityVar = (typeof CONNECTIVITY_VARS)[number];

const Ms = z.number().int().positive();

/** A delay that starts at base and doubles up to cap. */
function doubling(base: number, cap: number) {
  return z
    .strictObject({ base: Ms.default(base), cap: Ms.default(cap) })
    .prefault({})
    .refine((delay) => delay.cap >= delay.base, { error: 'cap must be at least base' });
}

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** Design 12's runner timings in milliseconds. Outside test mode the defaults are also the minimums (X-30). */
export const RunnerTimingsSchema = z
  .strictObject({
    /** Overridden by welcome.timings. */
    heartbeat: Ms.default(15 * SECOND),
    /** Overridden by welcome.timings. */
    deadLink: Ms.default(45 * SECOND),
    handshake: Ms.default(10 * SECOND),
    backoffBase: Ms.default(SECOND),
    backoffCap: Ms.default(30 * SECOND),
    tickGap: Ms.default(5 * SECOND),
    continuationWait: Ms.default(5 * SECOND),
    hold: Ms.default(2 * MINUTE),
    /** Overridden by welcome.timings. */
    handoff: Ms.default(3 * MINUTE),
    wip: Ms.default(10 * MINUTE),
    finalPush: Ms.default(60 * SECOND),
    /** AGFLOW_BRIDGE_POLL_MS for the bridge. */
    bridgePoll: Ms.default(2 * SECOND),
    /** AGFLOW_BRIDGE_POLL_MAX_MS for the bridge. */
    bridgePollMax: Ms.default(3 * MINUTE),
    suspend: Ms.default(45 * SECOND),
    wakeHold: Ms.default(2 * MINUTE),
    crashLoopWindow: Ms.default(10 * MINUTE),
    loginProbe: Ms.default(60 * SECOND),
    stopInterrupt: Ms.default(5 * SECOND),
    stopClose: Ms.default(2 * SECOND),
    stopKill: Ms.default(5 * SECOND),
    vendorErrorBackoff: doubling(30 * SECOND, 10 * MINUTE),
    /** Turn retries in quota_wait when the reset time is unknown. */
    quotaUnknown: Ms.default(30 * MINUTE),
    /** Late-work pushes after a pushError. */
    lateRetry: doubling(30 * SECOND, 10 * MINUTE),
    /** How long remote failures of a submission push are retried. */
    submitRetry: Ms.default(15 * MINUTE),
    /** One dependency preparation. */
    prep: Ms.default(15 * MINUTE),
    preflightEvery: Ms.default(6 * HOUR),
    /** How long acknowledged events are kept, so a restored hub can catch up. */
    eventRetention: Ms.default(48 * HOUR),
  })
  .prefault({});
export type RunnerTimings = z.output<typeof RunnerTimingsSchema>;

export const DEFAULT_TIMINGS: RunnerTimings = RunnerTimingsSchema.parse({});

/** A canonical absolute path: what realpath gives, without a trailing slash. */
const CanonicalPath = z
  .string()
  .refine((path) => isAbsolute(path), { error: 'must be an absolute path' })
  .refine((path) => path === '/' || !path.endsWith('/'), { error: 'must not end with a trailing slash' })
  .refine((path) => normalize(path) === path, { error: 'must be a canonical path' });

const Name = z.string().min(1);
const Ceilings = z.strictObject({ fiveHour: z.number().min(0).max(1), weekly: z.number().min(0).max(1) });

const ceilings = () => Ceilings.prefault({ fiveHour: 0.85, weekly: 0.85 });
const paidUsage = () => z.boolean().default(false);
const models = (lead: string, worker: string) =>
  z.strictObject({ lead: Name.default(lead), worker: Name.default(worker) }).prefault({});

/** Section 15.1. Honoured only with AGFLOW_TEST=1 (isTestMode); `agflow runner install` refuses it. */
export const RunnerTestBlockSchema = z.strictObject({
  /** Added to Claude's environment after the allowlist. */
  claudeEnv: z.record(z.string(), z.string()).default({}),
  /** Given to Codex as -c flags, one per top-level key; no config.toml is written. */
  codexConfig: z.record(z.string(), z.json()).default({}),
  /** Preflight reports the vendor ready with problem and plan 'test mode' and core's TEST_ACCOUNT_ID. */
  skipAuthChecks: z.boolean().default(false),
  /** Accept any positive timing, below the production minimums too. */
  allowShortTimings: z.boolean().default(false),
});
export type RunnerTestBlock = z.output<typeof RunnerTestBlockSchema>;

export const RunnerConfigSchema = z
  .strictObject({
    runnerKey: Name,
    /** The Mac's IOPlatformUUID; a copied home folder is refused at start. */
    machineId: Name,
    name: Name,
    // The settings the hub shows and the owner may change (RunnerSettings, design 6.3).
    capacity: z.number().int().min(1).max(16).default(2),
    keepAwake: z.enum(['off', 'ac', 'always']).default('ac'),
    draining: z.boolean().default(false),
    ceilings: z.strictObject({ claude: ceilings(), codex: ceilings() }).prefault({}),
    allowPaidUsage: z.strictObject({ claude: paidUsage(), codex: paidUsage() }).prefault({}),
    /** The snapshot of the settings the hub last confirmed; a new runner.json confirms its own at version 0. */
    confirmedSettings: RunnerSettingsSchema.optional(),
    profile: z.enum(['standard', 'auto']).default('standard'),
    models: z
      .strictObject({
        claude: models('claude-opus-5-5', 'claude-sonnet-5-5'),
        codex: models('gpt-6.1-sol', 'gpt-6.1-sol'),
      })
      .prefault({}),
    minFreeGb: z.number().min(0).default(10),
    batteryDrainPercent: z.number().min(0).max(100).default(20),
    /** CLAUDE_CONFIG_DIR and CODEX_HOME exactly as setup created them; null means the layout's homes (vendorHomes). */
    homes: z
      .strictObject({ claude: CanonicalPath.nullable().default(null), codex: CanonicalPath.nullable().default(null) })
      .prefault({}),
    /** The owner's login-shell PATH, captured at setup. */
    capturedPath: z.string().min(1).default('/usr/bin:/bin:/usr/sbin:/sbin'),
    connectivity: z.partialRecord(z.enum(CONNECTIVITY_VARS), z.string()).default({}),
    /** The author and committer of agent commits; setup takes the owner's git identity. */
    commitIdentity: z
      .strictObject({ name: Name, email: Name })
      .default({ name: 'agflow agent', email: 'agent@agflow.invalid' }),
    timings: RunnerTimingsSchema,
    test: RunnerTestBlockSchema.optional(),
  })
  .transform((config) => ({
    ...config,
    // A copy, so an in-place edit of the live settings never changes the snapshot too.
    confirmedSettings: config.confirmedSettings ?? { ...structuredClone(localSettings(config)), version: 0 },
  }));
export type RunnerConfig = z.output<typeof RunnerConfigSchema>;
export type RunnerConfigInput = z.input<typeof RunnerConfigSchema>;

type Env = Record<string, string | undefined>;

/** Test mode needs both AGFLOW_TEST=1 and a test block in runner.json. */
export function isTestMode(config: Pick<RunnerConfig, 'test'>, env: Env = process.env): boolean {
  return env.AGFLOW_TEST === '1' && config.test !== undefined;
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .flatMap((issue) => {
      if (issue.code === 'unrecognized_keys') {
        return issue.keys.map((key) => `runner.json: ${[...issue.path, key].join('.')}: unknown field`);
      }
      return [`runner.json: ${issue.path.join('.') || '(root)'}: ${issue.message}`];
    })
    .join('\n');
}

function parseConfig(value: unknown): RunnerConfig {
  const parsed = RunnerConfigSchema.safeParse(value);
  if (!parsed.success) throw new Error(describeIssues(parsed.error));
  return parsed.data;
}

/** Timings below the defaults, unless test mode allows short ones. */
function checkMinimums(config: RunnerConfig, env: Env): void {
  if (isTestMode(config, env) && config.test?.allowShortTimings) return;
  const problems: string[] = [];
  const check = (name: string, value: number, minimum: number) => {
    if (value < minimum) {
      problems.push(`runner.json: timings.${name}: ${value} ms is below the minimum of ${minimum} ms`);
    }
  };
  for (const [name, minimum] of Object.entries(DEFAULT_TIMINGS)) {
    const value = config.timings[name as keyof RunnerTimings];
    if (typeof minimum === 'number' && typeof value === 'number') {
      check(name, value, minimum);
    } else if (typeof minimum === 'object' && typeof value === 'object') {
      check(`${name}.base`, value.base, minimum.base);
      check(`${name}.cap`, value.cap, minimum.cap);
    }
  }
  if (problems.length > 0) {
    throw new Error(`${problems.join('\n')}\n(shorter timings need AGFLOW_TEST=1 and test.allowShortTimings)`);
  }
}

/** Reads runner.json with its defaults; an invalid file is refused with the field named. */
export function loadRunnerConfig(path: string, env: Env = process.env): RunnerConfig {
  if (!existsSync(path)) throw new Error(`${path} does not exist; run agflow runner setup`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  const config = parseConfig(raw);
  checkMinimums(config, env);
  return config;
}

/**
 * Writes runner.json atomically (a temporary file renamed over it) with mode 0600. The config is validated first, so
 * nothing outside the schema, a secret included, is ever written.
 */
export function saveRunnerConfig(path: string, config: RunnerConfig): void {
  const valid = parseConfig(config);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.runner.json.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(valid, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * The real path of the nearest existing ancestor joined with the rest, so a home that does not exist yet is still
 * canonical when AGFLOW_HOME sits behind a symlink (/tmp, /var/folders, a moved ~/.agflow).
 */
function canonicalPath(path: string): string {
  const missing: string[] = [];
  let existing = path;
  while (!existsSync(existing)) {
    missing.unshift(basename(existing));
    existing = dirname(existing);
  }
  return join(realpathSync(existing), ...missing);
}

/**
 * The vendor homes: runner.json's canonical strings, or the layout's made canonical when setup recorded none. Claude's
 * guard compares real paths with <CLAUDE_CONFIG_DIR>/projects/, so a symlinked home would let it fail open (7.6).
 */
export function vendorHomes(config: RunnerConfig, paths: RunnerPaths): Record<Vendor, string> {
  return {
    claude: config.homes.claude ?? canonicalPath(paths.homes.claude),
    codex: config.homes.codex ?? canonicalPath(paths.homes.codex),
  };
}

// Settings sync (design 6.3). hello carries the confirmed snapshot only; local edits travel as runner.settings after
// welcome; an update_settings echo replaces the snapshot and runner.json, except pending local edits. Ceilings and
// paid usage are records per vendor, and both sides treat each vendor's entry as its own field: an edit names only
// the vendors it changed, and an echo naming one vendor leaves the other as it was.

export type SettingsValues = Omit<RunnerSettings, 'version'>;
export type SettingsEdits = Partial<SettingsValues>;

const SCALAR_FIELDS = ['capacity', 'keepAwake', 'draining'] as const;
const VENDOR_FIELDS = ['ceilings', 'allowPaidUsage'] as const;
const VENDORS = VendorSchema.options;

function localSettings(config: SettingsValues): SettingsValues {
  const { capacity, keepAwake, draining, ceilings, allowPaidUsage } = config;
  return { capacity, keepAwake, draining, ceilings, allowPaidUsage };
}

/** The snapshot hello reports: the last settings the hub confirmed, with their version. */
export function settingsOf(config: RunnerConfig): RunnerSettings {
  return config.confirmedSettings;
}

/**
 * The fields runner.json changed since the snapshot, and for the per-vendor records only the vendors it changed; sent
 * as runner.settings after each welcome.
 */
export function localSettingsEdits(config: RunnerConfig): SettingsEdits {
  const local = localSettings(config);
  const snapshot = config.confirmedSettings;
  const result: Record<string, unknown> = {};
  for (const field of SCALAR_FIELDS) {
    if (local[field] !== snapshot[field]) result[field] = local[field];
  }
  for (const field of VENDOR_FIELDS) {
    const changed = VENDORS.filter(
      (vendor) => local[field][vendor] !== undefined && !Bun.deepEquals(local[field][vendor], snapshot[field][vendor]),
    );
    if (changed.length > 0) {
      result[field] = Object.fromEntries(changed.map((vendor) => [vendor, structuredClone(local[field][vendor])]));
    }
  }
  return result as SettingsEdits;
}

/** runner.json's own settings, local edits included: what the runner applies now. */
export function localSettingsOf(config: RunnerConfig): SettingsValues {
  return structuredClone(localSettings(config));
}

/**
 * A local edit (drain, undrain, the crash-loop self-drain): runner.json takes the patch, and changed holds the fields,
 * and of the per-vendor records the vendors, whose value it changed; runner.settings sends those. An empty changed
 * means the patch changed nothing.
 */
export function editLocalSettings(
  config: RunnerConfig,
  patch: SettingsEdits,
): { config: RunnerConfig; changed: SettingsEdits } {
  const changed: Record<string, unknown> = {};
  const next: RunnerConfig = structuredClone(config);
  for (const field of SCALAR_FIELDS) {
    const value = patch[field];
    if (value !== undefined && value !== config[field]) {
      changed[field] = value;
      Object.assign(next, { [field]: value });
    }
  }
  for (const field of VENDOR_FIELDS) {
    const given: Partial<Record<Vendor, unknown>> = patch[field] ?? {};
    const vendors = VENDORS.filter(
      (vendor) => given[vendor] !== undefined && !Bun.deepEquals(given[vendor], config[field][vendor]),
    );
    if (vendors.length === 0) continue;
    const values = Object.fromEntries(vendors.map((vendor) => [vendor, structuredClone(given[vendor])]));
    changed[field] = values;
    Object.assign(next, { [field]: { ...next[field], ...values } });
  }
  return { config: next, changed: changed as SettingsEdits };
}

/**
 * The snapshot with runner.settings edits laid over it in order: what the hub holds once it has applied them. Of the
 * per-vendor records an edit replaces only the vendors it names.
 */
export function settingsAfterEdits(snapshot: RunnerSettings, edits: readonly SettingsEdits[]): RunnerSettings {
  const result = structuredClone(snapshot);
  for (const edit of edits) {
    for (const field of SCALAR_FIELDS) {
      if (edit[field] !== undefined) Object.assign(result, { [field]: edit[field] });
    }
    for (const field of VENDOR_FIELDS) {
      const given = edit[field];
      if (given !== undefined) Object.assign(result, { [field]: { ...result[field], ...structuredClone(given) } });
    }
  }
  return result;
}

/**
 * Whether settings are the hub's whole settings, as hello's echoes carry them, which set the snapshot whatever came
 * before: every field named, and in each per-vendor record every vendor the snapshot's record holds. The hub's records
 * hold every vendor the runner's snapshot does (it stored what the runner reported, and merges vendor by vendor), and
 * an owner's PATCH that names every field but not those vendors is an edit like any other.
 */
export function isWholeSettings(settings: SettingsEdits, snapshot: RunnerSettings): boolean {
  if (![...SCALAR_FIELDS, ...VENDOR_FIELDS].every((field) => settings[field] !== undefined)) return false;
  return VENDOR_FIELDS.every((field) => {
    const given: Partial<Record<Vendor, unknown>> = settings[field] ?? {};
    return VENDORS.every((vendor) => snapshot[field][vendor] === undefined || given[vendor] !== undefined);
  });
}

/**
 * Applies an update_settings echo: it becomes the snapshot, and runner.json takes its values except for pending local
 * edits, which keep their value and are returned to be sent again. Both are judged on the edits in flight (X-12):
 * before is the old snapshot with the edits in flight before the echo laid over it, which runner.json holds unless it
 * was edited by other means; after is the new snapshot with the edits still in flight laid over it. A field (or a
 * vendor of the per-vendor records) is pending when runner.json differs from both; any other takes after. With no
 * edits in flight, before and after are the two snapshots.
 */
export function applySettingsEcho(
  config: RunnerConfig,
  echo: { settings: SettingsEdits; version: number },
  inFlight: { before: readonly SettingsEdits[]; after: readonly SettingsEdits[] } = { before: [], after: [] },
): { config: RunnerConfig; pending: SettingsEdits } {
  const old = config.confirmedSettings;
  const given = structuredClone(echo.settings);
  const snapshot: RunnerSettings = {
    capacity: given.capacity ?? old.capacity,
    keepAwake: given.keepAwake ?? old.keepAwake,
    draining: given.draining ?? old.draining,
    ceilings: { ...structuredClone(old.ceilings), ...given.ceilings },
    allowPaidUsage: { ...old.allowPaidUsage, ...given.allowPaidUsage },
    version: echo.version,
  };
  const before = settingsAfterEdits(old, inFlight.before);
  const after = settingsAfterEdits(snapshot, inFlight.after);
  const local = localSettings(config);
  const pending: Record<string, unknown> = {};
  const next: RunnerConfig = { ...config, confirmedSettings: snapshot };
  for (const field of SCALAR_FIELDS) {
    if (local[field] !== before[field] && local[field] !== after[field]) pending[field] = local[field];
    else Object.assign(next, { [field]: after[field] });
  }
  for (const field of VENDOR_FIELDS) {
    const merged: Record<string, unknown> = {};
    const kept: Record<string, unknown> = {};
    for (const vendor of VENDORS) {
      const mine = local[field][vendor];
      const theirs = after[field][vendor];
      const pendingHere =
        mine !== undefined && !Bun.deepEquals(mine, before[field][vendor]) && !Bun.deepEquals(mine, theirs);
      if (pendingHere) kept[vendor] = structuredClone(mine);
      merged[vendor] = structuredClone(pendingHere || theirs === undefined ? mine : theirs);
    }
    Object.assign(next, { [field]: merged });
    if (Object.keys(kept).length > 0) pending[field] = kept;
  }
  return { config: next, pending: pending as SettingsEdits };
}

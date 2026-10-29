// The runner link, protocol 1 (design 6.3): the messages, commands, attempt specs and events the hub and runners
// exchange over a runner's WebSocket, and the closed code lists senders import. Both sides import these schemas,
// and each schema is pinned to its TypeScript type, so the types, the core types and the wire format cannot drift
// apart.
import { z } from 'zod';
import { isValidWipRefPrefix, parseAttemptId } from './naming';
import { BranchSchema, CommitShaSchema, RoleSchema, TaskIdSchema, VendorSchema } from './schemas';
import type {
  AgentRole,
  Approval,
  AttemptFacts,
  AttemptLogEntry,
  AttemptPhase,
  Fence,
  ProfileSummary,
  Runner,
  RunnerVendor,
  StopCause,
  Vendor,
  VendorQuota,
} from './types';

export const PROTOCOL_VERSION = 1;

/** The WebSocket close codes the hub ends a runner's link with. */
export const CLOSE_CODES = {
  /** The key belongs to another owner or machine, or the runner was retired. */
  refused: 4403,
  /** Another connection with the same key and machine replaced this one. */
  replaced: 4409,
  /** The runner's protocol is outside the range the hub supports. */
  incompatible: 4426,
} as const;

/** The account id every adapter reports in test mode: the first 16 hex of sha256('agflow-test') (design 15.1). */
export const TEST_ACCOUNT_ID = '337c8a0a2e66c1e6';

// The closed code lists of design 6.3's event table. Senders import them instead of writing literals, and any
// other value makes the event a reject.

/** attempt.failed_to_start.refused: why a runner turned a start down without trying it. */
export const START_REFUSALS = [
  'draining',
  'at_capacity',
  'vendor_not_ready',
  'disk_low',
  'battery_low',
  'waking',
  'needs_login',
] as const;
export type StartRefusal = (typeof START_REFUSALS)[number];

/** attempt.activity kinds, each also an attempt_log kind. Adapter warnings are sent as note. */
export const ACTIVITY_KINDS = [
  'tool',
  'turn',
  'text',
  'compaction',
  'vendor_error',
  'note',
] as const satisfies readonly AttemptLogEntry['kind'][];
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** attempt.violation phases. A hand-back from the clone reports wip. */
export const VIOLATION_PHASES = ['start', 'wip', 'submit', 'takeover'] as const;
export type ViolationPhase = (typeof VIOLATION_PHASES)[number];

/** attempt.submitted error codes. */
export const SUBMIT_ERRORS = [
  'dirty',
  'protected_paths',
  'needs_merge',
  'branch_moved',
  'remote',
  'interrupted',
] as const;
export type SubmitError = (typeof SUBMIT_ERRORS)[number];

/** The submit refusals that go back to the agent to fix. */
export const FIXABLE_SUBMIT_ERRORS = [
  'dirty',
  'protected_paths',
  'needs_merge',
] as const satisfies readonly SubmitError[];

/** attempt.exited.cause: the runner's own stops. Every other exit has null. */
export const EXIT_CAUSES = ['suspend', 'runner_stop'] as const;
export type ExitCause = (typeof EXIT_CAUSES)[number];

/** attempt.exited.stoppedBy: the step of the stop ladder that ended the process, or none (design 7.4). */
export const STOPPED_BY = ['interrupt', 'close', 'sigterm', 'sigkill', 'none'] as const;
export type StoppedBy = (typeof STOPPED_BY)[number];

/** attempt.vendor_outcome kinds. denials and session_budget count as the stall rule budget. */
export const VENDOR_OUTCOME_KINDS = ['auth', 'context', 'policy', 'denials', 'session_budget'] as const;
export type VendorOutcomeKind = (typeof VENDOR_OUTCOME_KINDS)[number];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** runner.json is the source; only the hub assigns versions (design 6.3, "Settings sync"). */
export interface RunnerSettings {
  capacity: number;
  keepAwake: 'off' | 'ac' | 'always';
  draining: boolean;
  ceilings: Partial<Record<Vendor, { fiveHour: number; weekly: number }>>;
  allowPaidUsage: Partial<Record<Vendor, boolean>>;
  /** 0 until the hub first confirms the settings. */
  version: number;
}

export interface LiveAttempt {
  attemptId: string;
  fence: Fence;
  /**
   * starting: before attempt.spawned; running: the process is alive (a worker, or a lead in a turn); idle: a
   * lead's process waits between wake-ups; stopped: no process; suspended: stopped by a suspend.
   */
  state: 'starting' | 'running' | 'idle' | 'stopped' | 'suspended';
  sessionRef: string | null;
  /** The clone still exists. */
  clone: boolean;
}

/** Runners omit reports for a vendor whose account id is unknown. */
export interface AccountQuotaReport {
  vendor: Vendor;
  accountId: string;
  quota: VendorQuota;
}

/**
 * An event as an events message carries it: { seq, at, type, attemptId?, fence?, data }. The message checks only
 * what the hub needs to apply and acknowledge a batch in order. parseRunnerEvent reads the rest of each event on
 * its own, so a bad event becomes a reject and never fails its batch.
 */
export type RawRunnerEvent = { seq: number; at: number; type: string; [key: string]: unknown };

export type RunnerMessage =
  | {
      t: 'hello';
      protocol: number;
      runnerKey: string;
      machineId: string;
      name: string;
      agflowVersion: string;
      platform: string;
      /** The last hub-confirmed snapshot, never local edits. */
      settings: RunnerSettings;
      vendors: RunnerVendor[];
      quota: AccountQuotaReport[];
      profile: ProfileSummary;
      git: Runner['git'];
      state: 'ok' | 'crash_loop' | 'disk_low';
      stateDetail: string | null;
      /** New whenever runner.db is new. */
      outboxEpoch: string;
      /** The lowest event seq the runner still keeps (acknowledged ones are kept 48 h). */
      firstSeq: number;
      /** The highest event seq the runner holds; firstSeq − 1 when the outbox is empty. */
      lastSeq: number;
      lastHubEpoch: number | null;
      /** Every attempt whose start or resume the runner has recorded. */
      attempts: LiveAttempt[];
    }
  | {
      t: 'heartbeat';
      at: number;
      attempts: AttemptFacts[];
      power: Runner['power'];
      disk: Runner['disk'];
      /** Ms from now during which the runner takes no new attempt (wake, battery, disk). */
      acceptingUntil: number | null;
    }
  | { t: 'events'; outboxEpoch: string; events: RawRunnerEvent[] }
  | { t: 'result'; commandId: string; ok: boolean; data?: unknown; error?: string };

export type HubMessage =
  | {
      t: 'welcome';
      runnerId: string;
      hubEpoch: number;
      hubTime: number;
      ackedSeq: number;
      wipRefPrefix: string;
      stop: { attemptId: string; reason: string }[];
      /** They override runner.json. wipGraceMs, runnerLeaseMs / 3, bounds WIP pushes during a link outage (7.3). */
      timings: { heartbeatMs: number; deadLinkMs: number; handoffMs: number; wipGraceMs: number };
    }
  | { t: 'ack'; outboxEpoch: string; seq: number } // cumulative
  | { t: 'heartbeat_ack'; at: number; hubTime: number }
  | { t: 'command'; id: string; seq: number; command: RunnerCommand };

export type RunnerCommand =
  | { kind: 'start_attempt'; attempt: AttemptSpec }
  | {
      kind: 'resume_attempt';
      attemptId: string;
      fence: Fence;
      agentToken: string;
      /**
       * The quoted review feedback (ladder step 1), the wake-up delivery (a holding lead), or "the runner
       * restarted; continue from your last step" (reconciliation, restore).
       */
      prompt: string;
      messages: InjectedMessage[];
      /** Recomputed by the hub, like restore and acceptanceIds. */
      taskPack: string | null;
      restore: AttemptSpec['restore'];
      acceptanceIds: string[];
    }
  | {
      kind: 'deliver';
      attemptId: string;
      fence: Fence;
      messages: InjectedMessage[];
      /** Messages that did not fit; the runner adds one line about them (design 6.7). */
      more: number;
    }
  | { kind: 'interrupt'; attemptId: string; fence: Fence } // the Agents view's Interrupt action
  | {
      kind: 'stop_attempt';
      attemptId: string;
      fence: Fence;
      cause: StopCause;
      reason: string;
      /** Ask for a handoff note first (design 6.8). */
      handoff: boolean;
      /** Interrupt the turn before asking (stuck tools, quiet agents, loops). */
      interruptFirst: boolean;
      /** True for stop-and-hold, so a person can still take the clone over. */
      keepClone: boolean;
    }
  | { kind: 'hold_attempt'; attemptId: string; fence: Fence }
  | {
      kind: 'push_submission';
      attemptId: string;
      fence: Fence;
      submissionId: string;
      branch: string;
      expectedBranchSha: string | null;
      /** Shas the hub accepts as the remote head (design 6.13). */
      adoptable: string[];
    }
  | { kind: 'prepare_takeover'; attemptId: string; fence: Fence; person: string }
  | {
      kind: 'hand_back';
      attemptId: string;
      /**
       * Protocol-1 hubs send only the clone source; a runner given a ref source fetches the ref into its vault and
       * answers ok, with no event.
       */
      source: { kind: 'clone' } | { kind: 'ref'; ref: string; sha: string };
    }
  | { kind: 'cleanup_attempt'; attemptId: string }
  | {
      kind: 'decide_approval';
      attemptId: string;
      fence: Fence;
      approvalId: string;
      decision: 'approve' | 'decline';
      reason: string | null;
    }
  | { kind: 'upload_transcript'; attemptId: string } // for attempts that ended lost, when their runner says hello
  | { kind: 'prepare_dependencies'; attemptId: string; fence: Fence; requestId: string }
  | { kind: 'refresh_vault'; taskId: string; refs: string[] } // with a late-work message to the current holder
  | { kind: 'preflight'; vendor: Vendor } // after the hub sets a not-ready mark
  | { kind: 'delete_refs'; refs: { ref: string; expectedSha: string }[] }
  | { kind: 'update_settings'; settings: Partial<Omit<RunnerSettings, 'version'>>; version: number };

export type RunnerCommandKind = RunnerCommand['kind'];

export interface InjectedMessage {
  /**
   * 0: hub text with no message row (the lead's situation report); runners never report it as delivered or
   * acknowledged.
   */
  messageId: number;
  authority: 'person' | 'agent' | 'system';
  /** Formatted and quoted by the hub. */
  text: string;
}

export interface AttemptSpec {
  attemptId: string;
  taskId: string | null;
  role: AgentRole;
  vendor: Vendor;
  /** Null: the runner's models[vendor][role]. */
  model: string | null;
  fence: Fence;
  agentToken: string;
  hubUrl: string;
  repo: { url: string; mainBranch: string };
  /** The task's work position, or main. */
  start: { ref: string; sha: string | null };
  /** 'agflow/T-42-<slug>'; from epoch 2 'agflow/T-42-e2-<slug>'; null for leads. */
  branch: string | null;
  wipRef: string | null;
  /**
   * paths: protected-class patterns with this task's exemptions applied, matched only with core's
   * matchesProtectedPattern. base: 'refs/heads/<mainBranch>', which the runner resolves in its vault (design 7.3);
   * null: the start commit.
   */
  restore: { paths: string[]; base: string | null };
  /** For continuation prompts. */
  acceptanceIds: string[];
  /** Computed by the hub; the runner reports the cap it applied in AttemptFacts.tool.capMs. */
  toolCaps: {
    /** toolCapMs */
    defaultMs: number;
    /** longToolCapMs, for commands matching longPatterns (stall.ts). */
    longMs: number;
    /** Per task check: max(longToolCapMs, timeoutS × 1000 + 10 min). */
    checks: { cmd: string; capMs: number }[];
  };
  /** .agflow/run/task.md, composed by the hub; agent text quoted. */
  taskPack: string;
  /** The static brief (Codex developerInstructions, .agflow/run/brief.md). */
  brief: string;
  firstPrompt: string;
  /** Ask for a restatement first. */
  successor: boolean;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** True when A and B are the same type under the compiler's identity check: both ways, optional fields included. */
type Same<A, B> = (<X>() => X extends A ? 1 : 2) extends (<X>() => X extends B ? 1 : 2) ? true : false;

/**
 * Pins a schema to the type it parses: its output must be exactly T. A field or a value that only one side has
 * fails the typecheck, so a change to a type cannot leave its schema behind, or the other way round.
 */
export function schemaFor<T>() {
  return <S extends z.ZodType<T>>(
    schema: S & (Same<z.output<S>, T> extends true ? unknown : 'differs from its type'),
  ): z.ZodType<T> => schema;
}

/** Times (epoch ms), durations, ages, counts, sizes and seqs. */
const NonNegativeInt = z.number().int().min(0);
const PositiveInt = z.number().int().positive();
/** Utilization, a ceiling or a share of the context window. */
const Fraction = z.number().min(0).max(1);
/** Names, versions and ids; free text such as errors and details may be empty. */
const Name = z.string().min(1);

/** 'T-42-a3', 'T-42-e2-a3', 'lead-a5' or 'lead-e2-a5'. Runners name clones, pins and refs after it. */
export const AttemptIdSchema = z
  .string()
  .refine((id) => parseAttemptId(id) !== null, 'expected an attempt id like T-42-a3, T-42-e2-a3 or lead-a5');
export const RunnerIdSchema = z.string().regex(/^R-\d+$/, 'expected a runner id like R-3');
export const SubmissionIdSchema = z.string().regex(/^S-\d+$/, 'expected a submission id like S-9');
/** '<hubEpoch>-<runnerId>-<seq>', so command ids never repeat across restores. */
export const CommandIdSchema = z.string().regex(/^\d+-R-\d+-\d+$/, 'expected a command id like 1-R-3-17');
/** The first 16 hex of the sha256 of the account identity (email or organisation). */
export const AccountIdSchema = z.string().regex(/^[0-9a-f]{16}$/, 'expected an account id of 16 hex digits');
/** A full ref name, such as refs/heads/main or refs/agflow/T-42/a3, under git's rules for names. */
export const RefSchema = BranchSchema.refine((ref) => ref.startsWith('refs/'), 'expected a full ref name under refs/');
/**
 * A sha in full, as runners read it from git. The hub records, compares and fetches by these shas, so an abbreviated
 * one could name another commit, or differ from the same commit written in full. Shas that M1's records may hold
 * abbreviated (start shas, branch heads, adoptable shas) keep CommitShaSchema.
 */
export const FullShaSchema = z.string().regex(/^[0-9a-f]{40}$/, 'expected a full commit sha of 40 hex digits');
/** 'agt_' and 32 random bytes in base64url (design 6.5). */
const AgentTokenSchema = z.string().regex(/^agt_[A-Za-z0-9_-]{43}$/, 'expected an agent token');

export const AttemptPhaseSchema = schemaFor<AttemptPhase>()(
  z.enum(['starting', 'preparing', 'turn', 'idle', 'waiting_approval', 'quota_wait', 'vendor_error', 'stopping']),
);

export const StopCauseSchema = schemaFor<StopCause>()(
  z.enum([
    'stall_silent',
    'stall_hung_tool',
    'stall_loop',
    'stall_no_progress',
    'stall_budget',
    'stop',
    'stop_hold',
    'replace',
    'quota',
    'vendor_error',
    'context',
    'policy',
    'auth',
    'cancel',
    'blocked',
    'impossible',
    'released',
    'takeover',
    'rotation',
    'branch_moved',
  ]),
);

export const FenceSchema = schemaFor<Fence>()(z.strictObject({ epoch: PositiveInt, counter: PositiveInt }));

export const AttemptFactsSchema = schemaFor<AttemptFacts>()(
  z.strictObject({
    attemptId: AttemptIdSchema,
    fence: FenceSchema,
    phase: AttemptPhaseSchema,
    eventAgeMs: NonNegativeInt,
    tool: z
      .strictObject({
        name: Name,
        command: z.string().nullable(),
        long: z.boolean(),
        capMs: PositiveInt.nullable(),
        ageMs: NonNegativeInt,
      })
      .nullable(),
    fsAgeMs: NonNegativeInt.nullable(),
    commitAgeMs: NonNegativeInt.nullable(),
    turns: NonNegativeInt,
    turnsWithoutProgress: NonNegativeInt,
    repeatedCalls: NonNegativeInt,
    continuations: NonNegativeInt,
    vendorErrorMs: NonNegativeInt,
    activeMs: NonNegativeInt,
    contextUsed: Fraction.nullable(),
  }),
);

const CeilingsSchema = z.strictObject({ fiveHour: Fraction, weekly: Fraction });

export const RunnerVendorSchema = schemaFor<RunnerVendor>()(
  z.strictObject({
    vendor: VendorSchema,
    cliVersion: Name.nullable(),
    ownerCliVersion: Name.nullable(),
    ready: z.boolean(),
    problem: z.string().nullable(),
    accountId: AccountIdSchema.nullable(),
    plan: z.string().nullable(),
    managedPolicy: z.boolean(),
    models: z.strictObject({ lead: Name, worker: Name }),
    ceilings: CeilingsSchema,
    allowPaidUsage: z.boolean(),
    degraded: z.boolean(),
    preflightAt: NonNegativeInt.nullable(),
  }),
);

export const VendorQuotaSchema = schemaFor<VendorQuota>()(
  z.strictObject({
    state: z.enum(['ok', 'exhausted', 'unknown']),
    resetsAt: NonNegativeInt.nullable(),
    windows: z.strictObject({ fiveHour: Fraction.nullable(), weekly: Fraction.nullable() }),
    paidUsage: z.enum(['disabled', 'enabled', 'in_use', 'unknown']),
    updatedAt: NonNegativeInt,
  }),
);

export const ProfileSummarySchema = schemaFor<ProfileSummary>()(
  z.strictObject({ name: z.enum(['standard', 'auto']), weakened: z.array(Name), dependencyPrep: z.boolean() }),
);

export const AccountQuotaReportSchema = schemaFor<AccountQuotaReport>()(
  z.strictObject({ vendor: VendorSchema, accountId: AccountIdSchema, quota: VendorQuotaSchema }),
);

// update_settings carries any of these without the version; capacity has the bounds of the Runners card.
const settingsFields = {
  capacity: z.number().int().min(1).max(16),
  keepAwake: z.enum(['off', 'ac', 'always']),
  draining: z.boolean(),
  ceilings: z.partialRecord(VendorSchema, CeilingsSchema),
  allowPaidUsage: z.partialRecord(VendorSchema, z.boolean()),
};

export const RunnerSettingsSchema = schemaFor<RunnerSettings>()(
  z.strictObject({ ...settingsFields, version: NonNegativeInt }),
);

/**
 * Some settings without their version: what update_settings sets, runner.settings reports and an owner's
 * PATCH /api/runners/:id sends, so all three share these bounds.
 */
export const RunnerSettingsChangesSchema = z.strictObject(settingsFields).partial();

export const RunnerGitSchema = schemaFor<Runner['git']>()(
  z.strictObject({ ready: z.boolean(), problem: z.string().nullable(), lastPushAt: NonNegativeInt.nullable() }),
);

export const RunnerPowerSchema = schemaFor<NonNullable<Runner['power']>>()(
  z.strictObject({
    source: z.enum(['ac', 'battery', 'unknown']),
    batteryPercent: z.number().min(0).max(100).nullable(),
    lowPowerMode: z.boolean(),
  }),
);

export const RunnerDiskSchema = schemaFor<NonNullable<Runner['disk']>>()(
  z.strictObject({ freeBytes: NonNegativeInt, agflowBytes: NonNegativeInt }),
);

/** The state a runner reports in hello and runner.state; the hub derives the rest. */
const ReportedStateSchema = z.enum(['ok', 'crash_loop', 'disk_low']);

export const LiveAttemptSchema = schemaFor<LiveAttempt>()(
  z.strictObject({
    attemptId: AttemptIdSchema,
    fence: FenceSchema,
    state: z.enum(['starting', 'running', 'idle', 'stopped', 'suspended']),
    sessionRef: Name.nullable(),
    clone: z.boolean(),
  }),
);

export const InjectedMessageSchema = schemaFor<InjectedMessage>()(
  z
    .strictObject({ messageId: NonNegativeInt, authority: z.enum(['person', 'agent', 'system']), text: Name })
    .refine(
      (message) => message.messageId !== 0 || message.authority === 'system',
      'message 0 is hub text with no message row, so its authority is system',
    ),
);

const RestoreSchema = z.strictObject({ paths: z.array(Name), base: RefSchema.nullable() });

/**
 * A lead attempt has a lead attempt id and no task, branch or WIP ref; a worker has all three, and its attempt
 * id names its task. The runner builds clone paths and refs from these, so they must agree.
 */
function idsAgree(spec: Pick<AttemptSpec, 'attemptId' | 'taskId' | 'role' | 'branch' | 'wipRef'>): boolean {
  const lead = spec.role === 'lead';
  return (
    parseAttemptId(spec.attemptId)?.taskId === spec.taskId &&
    [spec.taskId, spec.branch, spec.wipRef].every((value) => (value === null) === lead)
  );
}

export const AttemptSpecSchema = schemaFor<AttemptSpec>()(
  z
    .strictObject({
      attemptId: AttemptIdSchema,
      taskId: TaskIdSchema.nullable(),
      role: RoleSchema,
      vendor: VendorSchema,
      model: Name.nullable(),
      fence: FenceSchema,
      agentToken: AgentTokenSchema,
      hubUrl: z.url({ protocol: /^https?$/, error: 'expected the hub URL, http or https' }),
      // Any remote git accepts: a URL, an scp-like address or a local path.
      repo: z.strictObject({ url: Name, mainBranch: BranchSchema }),
      start: z.strictObject({ ref: RefSchema, sha: CommitShaSchema.nullable() }),
      branch: BranchSchema.nullable(),
      wipRef: RefSchema.nullable(),
      restore: RestoreSchema,
      acceptanceIds: z.array(Name),
      toolCaps: z.strictObject({
        defaultMs: PositiveInt,
        longMs: PositiveInt,
        checks: z.array(z.strictObject({ cmd: Name, capMs: PositiveInt })),
      }),
      taskPack: z.string(),
      brief: z.string(),
      firstPrompt: z.string(),
      successor: z.boolean(),
    })
    .refine(
      idsAgree,
      'a lead attempt has no task, branch or WIP ref; a worker has all three, and its id names its task',
    ),
);

const attemptFields = { attemptId: AttemptIdSchema, fence: FenceSchema };

export const RunnerCommandSchema = schemaFor<RunnerCommand>()(
  z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('start_attempt'), attempt: AttemptSpecSchema }),
    z.strictObject({
      kind: z.literal('resume_attempt'),
      ...attemptFields,
      agentToken: AgentTokenSchema,
      prompt: z.string(),
      messages: z.array(InjectedMessageSchema),
      taskPack: z.string().nullable(),
      restore: RestoreSchema,
      acceptanceIds: z.array(Name),
    }),
    z.strictObject({
      kind: z.literal('deliver'),
      ...attemptFields,
      messages: z.array(InjectedMessageSchema),
      more: NonNegativeInt,
    }),
    z.strictObject({ kind: z.literal('interrupt'), ...attemptFields }),
    z.strictObject({
      kind: z.literal('stop_attempt'),
      ...attemptFields,
      cause: StopCauseSchema,
      reason: z.string(),
      handoff: z.boolean(),
      interruptFirst: z.boolean(),
      keepClone: z.boolean(),
    }),
    z.strictObject({ kind: z.literal('hold_attempt'), ...attemptFields }),
    z.strictObject({
      kind: z.literal('push_submission'),
      ...attemptFields,
      submissionId: SubmissionIdSchema,
      branch: BranchSchema,
      expectedBranchSha: CommitShaSchema.nullable(),
      adoptable: z.array(CommitShaSchema),
    }),
    z.strictObject({ kind: z.literal('prepare_takeover'), ...attemptFields, person: Name }),
    z.strictObject({
      kind: z.literal('hand_back'),
      attemptId: AttemptIdSchema,
      source: z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('clone') }),
        // A full sha, because the next runner may fetch the ref by it (design 6.12).
        z.strictObject({ kind: z.literal('ref'), ref: RefSchema, sha: FullShaSchema }),
      ]),
    }),
    z.strictObject({ kind: z.literal('cleanup_attempt'), attemptId: AttemptIdSchema }),
    z.strictObject({
      kind: z.literal('decide_approval'),
      ...attemptFields,
      // Minted by the runner as a UUID (design 6.10).
      approvalId: z.uuid(),
      decision: z.enum(['approve', 'decline']),
      reason: z.string().nullable(),
    }),
    z.strictObject({ kind: z.literal('upload_transcript'), attemptId: AttemptIdSchema }),
    // The request id is the prepare_dependencies command's own id (design 7.7).
    z.strictObject({ kind: z.literal('prepare_dependencies'), ...attemptFields, requestId: CommandIdSchema }),
    z.strictObject({ kind: z.literal('refresh_vault'), taskId: TaskIdSchema, refs: z.array(RefSchema) }),
    z.strictObject({ kind: z.literal('preflight'), vendor: VendorSchema }),
    z.strictObject({
      kind: z.literal('delete_refs'),
      // Only refs whose sha the hub recorded from a runner or a ref hand-back are deleted, so each sha is full.
      refs: z.array(z.strictObject({ ref: RefSchema, expectedSha: FullShaSchema })),
    }),
    z.strictObject({
      kind: z.literal('update_settings'),
      settings: RunnerSettingsChangesSchema,
      version: PositiveInt,
    }),
  ]),
);

/** The 17 command kinds of protocol 1, in the order of design 6.3. */
export const RUNNER_COMMAND_KINDS = [
  'start_attempt',
  'resume_attempt',
  'deliver',
  'interrupt',
  'stop_attempt',
  'hold_attempt',
  'push_submission',
  'prepare_takeover',
  'hand_back',
  'cleanup_attempt',
  'decide_approval',
  'upload_transcript',
  'prepare_dependencies',
  'refresh_vault',
  'preflight',
  'delete_refs',
  'update_settings',
] as const satisfies readonly RunnerCommandKind[];

/** The oldest protocol that understands each command kind. The hub never sends a command to an older runner. */
export const COMMAND_MIN_PROTOCOL: Readonly<Record<RunnerCommandKind, number>> = {
  start_attempt: 1,
  resume_attempt: 1,
  deliver: 1,
  interrupt: 1,
  stop_attempt: 1,
  hold_attempt: 1,
  push_submission: 1,
  prepare_takeover: 1,
  hand_back: 1,
  cleanup_attempt: 1,
  decide_approval: 1,
  upload_transcript: 1,
  prepare_dependencies: 1,
  refresh_vault: 1,
  preflight: 1,
  delete_refs: 1,
  update_settings: 1,
};

const HelloSchema = z
  .strictObject({
    t: z.literal('hello'),
    // Any version parses here. A hello this schema cannot read, such as a newer runner's, still gives its version,
    // key and machine through parseRunnerMessage, so the hub can refuse a version outside its range with 4426
    // either way.
    protocol: PositiveInt,
    runnerKey: Name,
    machineId: Name,
    name: Name,
    agflowVersion: Name,
    platform: Name,
    settings: RunnerSettingsSchema,
    vendors: z.array(RunnerVendorSchema),
    quota: z.array(AccountQuotaReportSchema),
    profile: ProfileSummarySchema,
    git: RunnerGitSchema,
    state: ReportedStateSchema,
    stateDetail: z.string().nullable(),
    outboxEpoch: Name,
    firstSeq: PositiveInt,
    lastSeq: NonNegativeInt,
    lastHubEpoch: PositiveInt.nullable(),
    attempts: z.array(LiveAttemptSchema),
  })
  .refine((hello) => hello.lastSeq >= hello.firstSeq - 1, {
    error: 'lastSeq must be at least firstSeq − 1, which an empty outbox reports',
    path: ['lastSeq'],
  });

// Loose on purpose: an event's attemptId, fence, data and any other key are parseRunnerEvent's to judge, so a bad
// one fails only its own event.
const RawRunnerEventSchema = z.looseObject({ seq: PositiveInt, at: NonNegativeInt, type: Name });

export const RunnerMessageSchema = schemaFor<RunnerMessage>()(
  z.discriminatedUnion('t', [
    HelloSchema,
    z.strictObject({
      t: z.literal('heartbeat'),
      at: NonNegativeInt,
      attempts: z.array(AttemptFactsSchema),
      power: RunnerPowerSchema.nullable(),
      disk: RunnerDiskSchema.nullable(),
      acceptingUntil: NonNegativeInt.nullable(),
    }),
    z.strictObject({ t: z.literal('events'), outboxEpoch: Name, events: z.array(RawRunnerEventSchema) }),
    z.strictObject({
      t: z.literal('result'),
      commandId: CommandIdSchema,
      ok: z.boolean(),
      data: z.unknown().optional(),
      error: z.string().optional(),
    }),
  ]),
);

export const HubMessageSchema = schemaFor<HubMessage>()(
  z.discriminatedUnion('t', [
    z.strictObject({
      t: z.literal('welcome'),
      runnerId: RunnerIdSchema,
      hubEpoch: PositiveInt,
      hubTime: NonNegativeInt,
      ackedSeq: NonNegativeInt,
      wipRefPrefix: z
        .string()
        .refine(isValidWipRefPrefix, 'expected a WIP ref prefix: a namespace under refs/ that ends with "/"'),
      stop: z.array(z.strictObject({ attemptId: AttemptIdSchema, reason: z.string() })),
      timings: z.strictObject({
        heartbeatMs: PositiveInt,
        deadLinkMs: PositiveInt,
        handoffMs: PositiveInt,
        wipGraceMs: PositiveInt,
      }),
    }),
    z.strictObject({ t: z.literal('ack'), outboxEpoch: Name, seq: NonNegativeInt }),
    z.strictObject({ t: z.literal('heartbeat_ack'), at: NonNegativeInt, hubTime: NonNegativeInt }),
    z.strictObject({ t: z.literal('command'), id: CommandIdSchema, seq: PositiveInt, command: RunnerCommandSchema }),
  ]),
);

// ---------------------------------------------------------------------------
// Runner events
// ---------------------------------------------------------------------------

const eventFields = { seq: PositiveInt, at: NonNegativeInt };

/** attempt.* and approval.* events name their attempt and carry its fence. */
function attemptEvent<T extends `attempt.${string}` | `approval.${string}`, D extends z.ZodRawShape>(type: T, data: D) {
  return z.strictObject({ ...eventFields, type: z.literal(type), ...attemptFields, data: z.strictObject(data) });
}

/** runner.* events are about the runner itself, so they carry neither. */
function runnerEvent<T extends `runner.${string}`, D extends z.ZodRawShape>(type: T, data: D) {
  return z.strictObject({ ...eventFields, type: z.literal(type), data: z.strictObject(data) });
}

export const ApprovalKindSchema = schemaFor<Approval['kind']>()(z.enum(['command', 'file_change', 'other']));

export const ApprovalDetailSchema = schemaFor<Approval['detail']>()(
  z.strictObject({
    command: z.string().optional(),
    cwd: z.string().optional(),
    reason: z.string().optional(),
    diff: z.string().optional(),
    manifestDiff: z.string().optional(),
    grantRoot: z.string().optional(),
  }),
);

/** attempt.wip.logStat: git log --stat of the WIP since main, clipped by the runner; handoff notes quote it. */
const LOG_STAT_MAX = 4_000;

// The event table of design 6.3, in its order: one schema per type. Runners read shas from git, so every sha an
// event reports is full.
const EVENT_SCHEMAS = [
  attemptEvent('attempt.spawned', {
    sessionRef: Name,
    pid: PositiveInt,
    model: Name,
    cliVersion: Name,
    permissionMode: Name.nullable(),
    // Null on a resume.
    startSha: FullShaSchema.nullable(),
  }),
  attemptEvent('attempt.failed_to_start', { error: z.string(), refused: z.enum(START_REFUSALS).nullable() }),
  attemptEvent('attempt.activity', { kind: z.enum(ACTIVITY_KINDS), summary: z.string() }),
  attemptEvent('attempt.first_output', { text: z.string() }),
  // Runners never report message 0 (hub text), but it parses, so the hub can ignore it without rejecting the event.
  attemptEvent('attempt.delivered', { messageIds: z.array(NonNegativeInt) }),
  attemptEvent('attempt.acknowledged', { messageIds: z.array(NonNegativeInt) }),
  attemptEvent('attempt.quota', {
    vendor: VendorSchema,
    // Null when the runner does not know the account: the hub then moves the attempt and updates no account.
    accountId: AccountIdSchema.nullable(),
    quota: VendorQuotaSchema,
  }),
  attemptEvent('attempt.prepared', {
    // Null for a preparation the runner ran before a start or resume.
    requestId: CommandIdSchema.nullable(),
    ok: z.boolean(),
    error: z.string().nullable(),
    logTail: z.string().nullable(),
  }),
  attemptEvent('attempt.wip', {
    ref: RefSchema,
    sha: FullShaSchema,
    // Protected paths taken out of the WIP, files over 10 MB left out, and embedded repositories (design 7.3).
    stripped: z.array(Name),
    skipped: z.array(Name),
    embedded: z.array(Name),
    logStat: z.string().max(LOG_STAT_MAX),
  }),
  // failures: the runner's consecutive failed WIP pushes, over all its attempts.
  attemptEvent('attempt.wip_failed', { error: z.string(), failures: PositiveInt }),
  attemptEvent('attempt.violation', { phase: z.enum(VIOLATION_PHASES), paths: z.array(Name) }),
  attemptEvent('attempt.submitted', {
    submissionId: SubmissionIdSchema,
    ok: z.boolean(),
    headSha: FullShaSchema.nullable(),
    remoteHead: FullShaSchema.nullable(),
    error: z.enum(SUBMIT_ERRORS).nullable(),
    detail: z.string().nullable(),
  })
    // The hub records a success and fails a refusal, so an outcome must not contradict itself.
    .refine(({ data }) => data.ok === (data.error === null), {
      error: 'a submission succeeds (ok) exactly when it has no error code',
      path: ['data', 'error'],
    })
    .refine(({ data }) => !data.ok || data.headSha !== null, {
      error: 'a successful submission reports the head it pushed',
      path: ['data', 'headSha'],
    }),
  attemptEvent('attempt.taken_over', {
    // local is null when the take-over failed after the agent stopped.
    commands: z.strictObject({ local: Name.nullable(), anywhere: Name }),
    wipSha: FullShaSchema.nullable(),
    error: z.string().nullable(),
  }),
  attemptEvent('attempt.handed_back', { ref: RefSchema, sha: FullShaSchema }),
  attemptEvent('attempt.vendor_outcome', { kind: z.enum(VENDOR_OUTCOME_KINDS), detail: z.string().nullable() }),
  attemptEvent('attempt.exited', {
    code: z.number().int().nullable(),
    signal: Name.nullable(),
    stoppedBy: z.enum(STOPPED_BY),
    handoffWritten: z.boolean(),
    cause: z.enum(EXIT_CAUSES).nullable(),
    // The harvested head, whenever the harvest succeeded.
    finalSha: FullShaSchema.nullable(),
    // Null when no final WIP was pushed: the push failed (pushError), the attempt had already ended (its work goes
    // to a late-work ref), or a lead, which has no WIP.
    finalWip: z.strictObject({ ref: RefSchema, sha: FullShaSchema }).nullable(),
    pushError: z.string().nullable(),
  }),
  // The hub files the late work of an attempt it does not know under taskId, so it must be the task the attempt id
  // names. Leads have no WIP, so no late work either.
  attemptEvent('attempt.late_work', { taskId: TaskIdSchema, ref: RefSchema, sha: FullShaSchema }).refine(
    (event) => parseAttemptId(event.attemptId)?.taskId === event.data.taskId,
    { error: 'expected the task the attempt id names; a lead attempt has no late work', path: ['data', 'taskId'] },
  ),
  runnerEvent('runner.vendors', { vendors: z.array(RunnerVendorSchema), quota: z.array(AccountQuotaReportSchema) }),
  // The hub applies the changes and echoes update_settings at its own version + 1; only the hub assigns versions.
  runnerEvent('runner.settings', { settings: RunnerSettingsChangesSchema, baseVersion: NonNegativeInt }),
  runnerEvent('runner.state', { state: ReportedStateSchema, detail: z.string().nullable() }),
  attemptEvent('approval.requested', {
    // Minted by the runner as a UUID, like decide_approval's.
    approvalId: z.uuid(),
    kind: ApprovalKindSchema,
    summary: z.string(),
    detail: ApprovalDetailSchema,
  }),
  attemptEvent('approval.voided', { approvalId: z.uuid() }),
] as const;

export type RunnerEvent = z.output<(typeof EVENT_SCHEMAS)[number]>;
export type RunnerEventType = RunnerEvent['type'];
/** The data of each event type. */
export type RunnerEventData = { [E in RunnerEvent as E['type']]: E['data'] };

/** The 22 event types of protocol 1, in the order of design 6.3's event table. */
export const RUNNER_EVENT_TYPES: readonly RunnerEventType[] = EVENT_SCHEMAS.map((schema) => schema.shape.type.value);

const EVENT_SCHEMA_BY_TYPE = new Map<string, z.ZodType<RunnerEvent>>(
  EVENT_SCHEMAS.map((schema) => [schema.shape.type.value, schema]),
);

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** What the parsers give instead of throwing: the value, or an error that says what is wrong and where. */
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** A runner message the hub cannot read still gives a hello's protocol, key and machine, when it has them. */
export type ParsedRunnerMessage =
  | { ok: true; value: RunnerMessage }
  | { ok: false; error: string; hello: { protocol: number; runnerKey: string; machineId: string } | null };

/** A hub message the runner cannot read still names the command it carried, when it has a valid id. */
export type ParsedHubMessage = { ok: true; value: HubMessage } | { ok: false; error: string; commandId: string | null };

function parseJson(text: string): Parsed<unknown> {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: `not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function parseWith<T>(schema: z.ZodType<T>, value: unknown): Parsed<T> {
  const parsed = schema.safeParse(value);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: z.prettifyError(parsed.error) };
}

// Enough of a hello to refuse it: a newer runner's hello may differ from protocol 1's in anything else.
const HelloEnvelopeSchema = z.looseObject({
  t: z.literal('hello'),
  protocol: PositiveInt,
  runnerKey: Name,
  machineId: Name,
});

/**
 * Reads a runner's message on the hub. Events stay raw: parseRunnerEvent reads each one on its own. A hello the hub
 * cannot read fails with its protocol, key and machine, so the hub can still refuse a version outside its range
 * with 4426 and record the runner as incompatible. If the hub closed the link as a bad first message instead, a
 * newer runner would reconnect forever rather than stop.
 */
export function parseRunnerMessage(text: string): ParsedRunnerMessage {
  const json = parseJson(text);
  if (!json.ok) return { ...json, hello: null };
  const parsed = parseWith(RunnerMessageSchema, json.value);
  if (parsed.ok) return parsed;
  const envelope = HelloEnvelopeSchema.safeParse(json.value);
  if (!envelope.success) return { ...parsed, hello: null };
  const { protocol, runnerKey, machineId } = envelope.data;
  return { ...parsed, hello: { protocol, runnerKey, machineId } };
}

// Enough of a command message to answer it.
const CommandEnvelopeSchema = z.looseObject({ t: z.literal('command'), id: CommandIdSchema });

/**
 * Reads the hub's message on a runner. A command the runner cannot read (an unknown kind, an invalid payload)
 * fails with its id, so the runner can answer it { ok: false, error: 'unsupported' } rather than leave the hub
 * resending it after every welcome.
 */
export function parseHubMessage(text: string): ParsedHubMessage {
  const json = parseJson(text);
  if (!json.ok) return { ...json, commandId: null };
  const parsed = parseWith(HubMessageSchema, json.value);
  if (parsed.ok) return parsed;
  const envelope = CommandEnvelopeSchema.safeParse(json.value);
  return { ...parsed, commandId: envelope.success ? envelope.data.id : null };
}

/**
 * Reads one event of an events message. The hub applies each event on its own, so an invalid one becomes a
 * reject and never fails its batch. An unknown type or bad data gives an error that names the type; nothing
 * throws.
 */
export function parseRunnerEvent(event: unknown): Parsed<RunnerEvent> {
  const type = typeof event === 'object' && event !== null && 'type' in event ? event.type : undefined;
  if (typeof type !== 'string') return { ok: false, error: 'an event needs a type' };
  const schema = EVENT_SCHEMA_BY_TYPE.get(type);
  if (!schema) return { ok: false, error: `unknown event type ${JSON.stringify(type)}` };
  const parsed = parseWith(schema, event);
  return parsed.ok ? parsed : { ok: false, error: `${type}: ${parsed.error}` };
}

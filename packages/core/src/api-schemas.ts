// The HTTP API that M2 adds (design 6.16): the request and response bodies of the routes for runners, attempts,
// approvals, agent actions, take-over and hand-back, runner submissions, dependency preparation and the lead, and the
// error codes their callers tell apart. Request bodies are strict, like M1's; queries stay loose, because proxies and
// caches add parameters. Each value schema is pinned to its core type, so the hub's answers and their readers cannot
// drift apart.
import { z } from 'zod';
import { parseAttemptId } from './naming';
import {
  AccountIdSchema,
  ApprovalDetailSchema,
  ApprovalKindSchema,
  AttemptFactsSchema,
  AttemptIdSchema,
  AttemptPhaseSchema,
  CommandIdSchema,
  FenceSchema,
  FullShaSchema,
  ProfileSummarySchema,
  RefSchema,
  RunnerDiskSchema,
  RunnerGitSchema,
  RunnerIdSchema,
  RunnerPowerSchema,
  type RunnerSettings,
  RunnerSettingsChangesSchema,
  RunnerVendorSchema,
  StopCauseSchema,
  SubmissionIdSchema,
  VendorQuotaSchema,
  schemaFor,
} from './runner-protocol';
import {
  CommitShaSchema,
  HandoffInputSchema,
  ReasonInputSchema,
  RoleSchema,
  SubmitInputSchema,
  TaskIdSchema,
  VendorSchema,
} from './schemas';
import type {
  AccountQuota,
  Approval,
  Attempt,
  AttemptEndReason,
  AttemptLogEntry,
  AttemptStatus,
  FailureClass,
  LeadNote,
  LeadSeat,
  PrepareRequest,
  Project,
  Runner,
  RunnerState,
  SubmissionRecord,
} from './types';

/** Times (epoch ms), durations, counts and sizes. */
const NonNegativeInt = z.number().int().min(0);
const PositiveInt = z.number().int().positive();
/** Names, logins, versions and commands; free text such as errors and summaries may be empty. */
const Name = z.string().min(1);

export const AgentIdSchema = z.string().regex(/^A-\d+$/, 'expected an agent id like A-3');

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

/**
 * The hub's refusals of agent tokens (design 6.5): 401 attempt_ended, whose body also names the end reason, and 401
 * attempt_refenced while a restore re-fences the attempt; 403 agent_not_allowed on a route outside the agents'
 * allowlist.
 */
export const AGENT_ERRORS = ['attempt_ended', 'attempt_refenced', 'agent_not_allowed'] as const;
export type AgentError = (typeof AGENT_ERRORS)[number];

/** The 409 codes of a refused take-over (design 6.12); the page then offers Stop and hold instead. */
export const TAKEOVER_REFUSALS = ['runner_offline', 'not_running', 'submission_pending'] as const;
export type TakeoverRefusal = (typeof TAKEOVER_REFUSALS)[number];

// ---------------------------------------------------------------------------
// Value schemas
// ---------------------------------------------------------------------------

const RunnerStateSchema = schemaFor<RunnerState>()(
  z.enum(['online', 'offline', 'needs_login', 'incompatible', 'crash_loop', 'disk_low']),
);

const AttemptStatusSchema = schemaFor<AttemptStatus>()(z.enum(['starting', 'running', 'quota_wait', 'holding', 'ended']));

const AttemptEndReasonSchema = schemaFor<AttemptEndReason>()(
  z.enum([
    'accepted',
    'rejected',
    'cancelled',
    'released',
    'blocked',
    'stalled',
    'crashed',
    'failed_to_start',
    'stopped',
    'replaced',
    'lost',
    'taken_over',
    'rotated',
    'superseded',
  ]),
);

const FailureClassSchema = schemaFor<FailureClass>()(z.enum(['infra', 'agent', 'review']));

const ApprovalStatusSchema = schemaFor<Approval['status']>()(
  z.enum(['pending', 'approved', 'declined', 'expired', 'void']),
);

/** True when the attempt id names this task; a lead attempt's names none. */
const namesTask = (attemptId: string, taskId: string | null): boolean => parseAttemptId(attemptId)?.taskId === taskId;

export const RunnerSchema = schemaFor<Runner>()(
  z.strictObject({
    id: RunnerIdSchema,
    owner: Name,
    name: Name,
    state: RunnerStateSchema,
    stateDetail: z.string().nullable(),
    lastError: z.string().nullable(),
    capacity: PositiveInt,
    keepAwake: z.enum(['off', 'ac', 'always']),
    draining: z.boolean(),
    settingsVersion: NonNegativeInt,
    protocol: PositiveInt,
    agflowVersion: Name,
    platform: Name,
    vendors: z.array(RunnerVendorSchema),
    profile: ProfileSummarySchema,
    git: RunnerGitSchema,
    power: RunnerPowerSchema.nullable(),
    disk: RunnerDiskSchema.nullable(),
    acceptingUntil: NonNegativeInt.nullable(),
    activeAttempts: NonNegativeInt,
    lastSeenAt: NonNegativeInt,
    createdAt: NonNegativeInt,
  }),
);

export const AccountQuotaSchema = schemaFor<AccountQuota>()(
  z.strictObject({
    owner: Name,
    vendor: VendorSchema,
    accountId: AccountIdSchema,
    quota: VendorQuotaSchema,
    ownerAway: z.boolean(),
  }),
);

export const AttemptSchema = schemaFor<Attempt>()(
  z
    .strictObject({
      id: AttemptIdSchema,
      taskId: TaskIdSchema.nullable(),
      number: PositiveInt,
      role: RoleSchema,
      agentId: AgentIdSchema,
      runnerId: RunnerIdSchema.nullable(),
      vendor: VendorSchema,
      model: Name.nullable(),
      sessionRef: Name.nullable(),
      fence: FenceSchema,
      status: AttemptStatusSchema,
      endReason: AttemptEndReasonSchema.nullable(),
      failureClass: FailureClassSchema.nullable(),
      failureSignature: z.string().nullable(),
      startRef: RefSchema.nullable(),
      // A live chat's start sha and submitted head may come from M1's records, abbreviated. WIP shas come only from
      // runners, which report them in full.
      startSha: CommitShaSchema.nullable(),
      wipRef: RefSchema.nullable(),
      wipSha: FullShaSchema.nullable(),
      submittedSha: CommitShaSchema.nullable(),
      resumable: z.boolean(),
      reviewRounds: NonNegativeInt,
      wakeups: NonNegativeInt,
      activeMs: NonNegativeInt,
      phase: AttemptPhaseSchema.nullable(),
      facts: AttemptFactsSchema.nullable(),
      stopRequested: z
        .strictObject({
          cause: StopCauseSchema,
          reason: z.string(),
          by: Name,
          handoff: z.boolean(),
          deferred: z.boolean(),
          at: NonNegativeInt,
        })
        .nullable(),
      takeover: z
        .strictObject({ local: Name.nullable(), anywhere: Name, ref: RefSchema, error: z.string().nullable() })
        .nullable(),
      leaseExpiresAt: NonNegativeInt.nullable(),
      quotaResetsAt: NonNegativeInt.nullable(),
      startedAt: NonNegativeInt,
      endedAt: NonNegativeInt.nullable(),
      lastActivityAt: NonNegativeInt,
    })
    // The seat's attempts ('lead-a5') are a lead's. A task attempt records its agent's role, which may be lead too:
    // M1 lets a live lead claim a task.
    .refine(
      (attempt) =>
        namesTask(attempt.id, attempt.taskId) &&
        parseAttemptId(attempt.id)?.number === attempt.number &&
        (attempt.taskId !== null || attempt.role === 'lead'),
      "an attempt's id names its task and number; a lead attempt has no task and the role lead",
    ),
);

export const AttemptLogEntrySchema = schemaFor<AttemptLogEntry>()(
  z.strictObject({
    id: PositiveInt,
    attemptId: AttemptIdSchema,
    ts: NonNegativeInt,
    kind: z.enum([
      'tool',
      'turn',
      'text',
      'delivery',
      'quota',
      'violation',
      'compaction',
      'vendor_error',
      'rejected',
      'note',
    ]),
    summary: z.string(),
  }),
);

export const ApprovalSchema = schemaFor<Approval>()(
  z
    .strictObject({
      // Minted by the runner as a UUID (design 6.10).
      id: z.uuid(),
      attemptId: AttemptIdSchema,
      fence: FenceSchema,
      runnerId: RunnerIdSchema,
      owner: Name,
      taskId: TaskIdSchema.nullable(),
      agentId: AgentIdSchema,
      kind: ApprovalKindSchema,
      summary: z.string(),
      detail: ApprovalDetailSchema,
      status: ApprovalStatusSchema,
      decidedBy: Name.nullable(),
      createdAt: NonNegativeInt,
      expiresAt: NonNegativeInt,
      decidedAt: NonNegativeInt.nullable(),
    })
    .refine((approval) => namesTask(approval.attemptId, approval.taskId), {
      error: 'expected the task its attempt id names; a lead attempt has none',
      path: ['taskId'],
    }),
);

export const SubmissionRecordSchema = schemaFor<SubmissionRecord>()(
  z
    .strictObject({
      id: SubmissionIdSchema,
      taskId: TaskIdSchema,
      attemptId: AttemptIdSchema,
      status: z.enum(['pending', 'submitted', 'failed']),
      summary: z.string(),
      evidence: z.array(z.string()),
      headSha: FullShaSchema.nullable(),
      error: z.string().nullable(),
      requestedAt: NonNegativeInt,
      decidedAt: NonNegativeInt.nullable(),
    })
    .refine((submission) => namesTask(submission.attemptId, submission.taskId), {
      error: 'expected the task its attempt id names',
      path: ['taskId'],
    }),
);

export const LeadSeatSchema = schemaFor<LeadSeat>()(
  z.strictObject({
    kind: z.enum(['live', 'runner', 'none']),
    agentId: AgentIdSchema.nullable(),
    attemptId: AttemptIdSchema.nullable(),
    runnerId: RunnerIdSchema.nullable(),
    since: NonNegativeInt.nullable(),
    wakeups: NonNegativeInt,
    runnerLeads: z.boolean(),
  }),
);

export const LeadNoteSchema = schemaFor<LeadNote>()(
  z
    .strictObject({
      id: PositiveInt,
      // A runner lead's attempt; null for a live lead's note.
      attemptId: AttemptIdSchema.nullable(),
      kind: z.enum(['handoff', 'restatement']),
      body: z.string(),
      author: Name,
      createdAt: NonNegativeInt,
    })
    .refine((note) => note.attemptId === null || namesTask(note.attemptId, null), {
      error: "expected a lead attempt's id",
      path: ['attemptId'],
    }),
);

export const PrepareRequestSchema = schemaFor<PrepareRequest>()(
  z.strictObject({
    // The prepare_dependencies command's own id (design 7.7).
    id: CommandIdSchema,
    attemptId: AttemptIdSchema,
    status: z.enum(['pending', 'ok', 'failed']),
    error: z.string().nullable(),
    logTail: z.string().nullable(),
    requestedAt: NonNegativeInt,
    finishedAt: NonNegativeInt.nullable(),
  }),
);

export const ProjectSchema = schemaFor<Project>()(
  z.strictObject({ name: Name, repo: Name, paused: z.boolean(), runnerLeads: z.boolean() }),
);

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** M1's routes read an empty query parameter as absent (`?assignee=`), and so do these queries. */
const absentIfEmpty = (value: unknown): unknown => (value === '' ? undefined : value);

function param<S extends z.ZodType>(schema: S) {
  return z.preprocess(absentIfEmpty, schema.optional());
}

/** `?status=a,b`: values separated by commas. */
function commaList<S extends z.ZodType>(values: S) {
  return z.preprocess((value) => (typeof value === 'string' ? value.split(',') : value), z.array(values));
}

/** PATCH /api/runners/:id: the owner's changes, with the bounds update_settings applies (capacity 1..16, ceilings 0..1). */
export const RunnerPatchInputSchema = schemaFor<Partial<Omit<RunnerSettings, 'version'>>>()(
  RunnerSettingsChangesSchema.refine((patch) => Object.keys(patch).length > 0, 'the patch is empty'),
);

/** POST /api/runner/retire, for agflow runner uninstall. */
export const RunnerRetireInputSchema = z.strictObject({ runnerKey: Name });

/** The largest transcript tail a runner uploads, in UTF-8 bytes (64 KB); the hub refuses a larger one. */
export const TRANSCRIPT_TAIL_MAX_BYTES = 65_536;

/** POST /api/runner/attempts/:id/transcript: the end of an attempt's transcript, for an assembled handoff note. */
export const TranscriptInputSchema = z.strictObject({
  // UTF-8 never takes fewer bytes than the string has UTF-16 units, so a longer string is refused before it is encoded.
  tail: z
    .string()
    .refine(
      (tail) =>
        tail.length <= TRANSCRIPT_TAIL_MAX_BYTES && new TextEncoder().encode(tail).length <= TRANSCRIPT_TAIL_MAX_BYTES,
      'expected a tail of at most 64 KB',
    ),
});

/** GET /api/attempts?task=&role=&status=&runner=&limit= */
export const AttemptsQuerySchema = z.object({
  task: param(TaskIdSchema),
  role: param(RoleSchema),
  status: param(commaList(AttemptStatusSchema)),
  runner: param(RunnerIdSchema),
  // 200 by default; like M1's event list, a larger limit gets the cap of 1000.
  limit: z.preprocess(
    absentIfEmpty,
    z.coerce
      .number()
      .int()
      .min(1)
      .default(200)
      .transform((limit) => Math.min(limit, 1000)),
  ),
});

/** POST /api/agents/:id/stop. hold: stop and hold, so a person can still take the clone over. */
export const AgentStopInputSchema = ReasonInputSchema.extend({ hold: z.boolean().default(false) });

/** POST /api/agents/:id/replace. */
export const AgentReplaceInputSchema = ReasonInputSchema;

/**
 * POST /api/tasks/:id/handback: from the runner's clone, or from a pushed ref. The sha is in full, because the next
 * runner may fetch the ref by it.
 */
export const HandbackInputSchema = z.strictObject({
  source: z.union([z.literal('clone'), z.strictObject({ ref: RefSchema, sha: FullShaSchema })]),
});

/** GET /api/approvals?status=, the caller's own approvals. */
export const ApprovalsQuerySchema = z.object({ status: param(commaList(ApprovalStatusSchema)) });

/** POST /api/approvals/:id. Approve maps only to the vendor's one-time accept (design 6.10). */
export const ApprovalDecisionInputSchema = z.strictObject({ decision: z.enum(['approve', 'decline']) });

/** POST /api/staffing (request_agents): the hub clamps count to [0, cap]; a vendor sets the project's preference. */
export const StaffingInputSchema = z.strictObject({
  count: NonNegativeInt,
  vendor: VendorSchema.optional(),
  reason: ReasonInputSchema.shape.reason,
});

/**
 * POST /api/tasks/:id/submit with an agent token. The runner pushes the branch the hub gave the attempt, so a runner
 * agent names neither a branch nor a head; the other fields keep M1's bounds.
 */
export const RunnerSubmitInputSchema = SubmitInputSchema.omit({ branch: true, headSha: true });

/** POST /api/prepare: the agent token names the attempt, so the body is empty. */
export const PrepareInputSchema = z.strictObject({});

/** POST /api/lead/handoff: the lead's note for its successor, with the bounds of a task handoff. */
export const LeadHandoffInputSchema = HandoffInputSchema;

/** PATCH /api/project: may the scheduler start leads on runners. */
export const ProjectPatchInputSchema = z.strictObject({ runnerLeads: z.boolean() });

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/** GET /api/runners. */
export const RunnersResponseSchema = z.strictObject({
  runners: z.array(RunnerSchema),
  accounts: z.array(AccountQuotaSchema),
});

/** PATCH /api/runners/:id. */
export const RunnerResponseSchema = z.strictObject({ runner: RunnerSchema });

/** GET /api/attempts, newest first. */
export const AttemptsResponseSchema = z.strictObject({ attempts: z.array(AttemptSchema) });

/** GET /api/attempts/:id. */
export const AttemptDetailResponseSchema = z.strictObject({
  attempt: AttemptSchema,
  log: z.array(AttemptLogEntrySchema),
});

/** POST /api/agents/:id/stop and /replace. */
export const AttemptResponseSchema = z.strictObject({ attempt: AttemptSchema });

/** GET /api/approvals. */
export const ApprovalsResponseSchema = z.strictObject({ approvals: z.array(ApprovalSchema) });

/** POST /api/approvals/:id. */
export const ApprovalResponseSchema = z.strictObject({ approval: ApprovalSchema });

/** POST /api/staffing: the running workers and the new target. */
export const StaffingResponseSchema = z.strictObject({ running: NonNegativeInt, target: NonNegativeInt });

/** 202 from POST /api/tasks/:id/submit with an agent token, and GET /api/submissions/:id. */
export const SubmissionResponseSchema = z.strictObject({ submission: SubmissionRecordSchema });

/** 202 from POST /api/prepare, and GET /api/prepare/:id. */
export const PrepareResponseSchema = z.strictObject({ request: PrepareRequestSchema });

/** 202 from POST /api/tasks/:id/takeover and /handback: the attempt taken over. */
export const TakeoverResponseSchema = z.strictObject({ attemptId: AttemptIdSchema });

/** GET /api/lead/notes. */
export const LeadNotesResponseSchema = z.strictObject({ notes: z.array(LeadNoteSchema) });

/** GET /api/runner/whoami: the CLI token's user. */
export const WhoamiResponseSchema = z.strictObject({ user: Name });

/** Retiring a runner, a transcript, an interrupt and a lead handoff answer only that they were done. */
export const OkResponseSchema = z.strictObject({ ok: z.literal(true) });

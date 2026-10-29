import { describe, expect, expectTypeOf, test } from 'bun:test';
import type { z } from 'zod';
import {
  AGENT_ERRORS,
  AccountQuotaSchema,
  AgentReplaceInputSchema,
  AgentStopInputSchema,
  ApprovalDecisionInputSchema,
  ApprovalResponseSchema,
  ApprovalSchema,
  ApprovalsQuerySchema,
  ApprovalsResponseSchema,
  AttemptDetailResponseSchema,
  AttemptLogEntrySchema,
  AttemptResponseSchema,
  AttemptSchema,
  AttemptsQuerySchema,
  AttemptsResponseSchema,
  HandbackInputSchema,
  LeadHandoffInputSchema,
  LeadNoteSchema,
  LeadNotesResponseSchema,
  LeadSeatSchema,
  OkResponseSchema,
  PrepareInputSchema,
  PrepareRequestSchema,
  PrepareResponseSchema,
  ProjectPatchInputSchema,
  ProjectSchema,
  RunnerPatchInputSchema,
  RunnerResponseSchema,
  RunnerRetireInputSchema,
  RunnerSchema,
  RunnerSubmitInputSchema,
  RunnersResponseSchema,
  StaffingInputSchema,
  StaffingResponseSchema,
  SubmissionRecordSchema,
  SubmissionResponseSchema,
  TAKEOVER_REFUSALS,
  TRANSCRIPT_TAIL_MAX_BYTES,
  TakeoverResponseSchema,
  TranscriptInputSchema,
  WhoamiResponseSchema,
} from '../src/api-schemas';
import { type RunnerSettings, TEST_ACCOUNT_ID } from '../src/runner-protocol';
import type {
  AccountQuota,
  Approval,
  Attempt,
  AttemptFacts,
  AttemptLogEntry,
  Fence,
  LeadNote,
  LeadSeat,
  PrepareRequest,
  Project,
  Runner,
  RunnerVendor,
  SubmissionRecord,
  VendorQuota,
} from '../src/types';

const at = 1_767_225_600_000;
const fence: Fence = { epoch: 1, counter: 7 };
const sha = (char: string) => char.repeat(40);

const quota: VendorQuota = {
  state: 'ok',
  resetsAt: at + 3_600_000,
  windows: { fiveHour: 0.42, weekly: 0.31 },
  paidUsage: 'disabled',
  updatedAt: at,
};

const vendor: RunnerVendor = {
  vendor: 'claude',
  cliVersion: '2.1.285',
  ownerCliVersion: null,
  ready: true,
  problem: null,
  accountId: TEST_ACCOUNT_ID,
  plan: 'Claude Max',
  managedPolicy: false,
  models: { lead: 'claude-opus-5-5', worker: 'claude-sonnet-5-5' },
  ceilings: { fiveHour: 0.85, weekly: 0.85 },
  allowPaidUsage: false,
  degraded: false,
  preflightAt: at,
};

const runner: Runner = {
  id: 'R-1',
  owner: 'timur',
  name: 'timur-mbp',
  state: 'online',
  stateDetail: null,
  lastError: null,
  capacity: 3,
  keepAwake: 'ac',
  draining: false,
  settingsVersion: 4,
  protocol: 1,
  agflowVersion: '0.1.0',
  platform: 'darwin-arm64',
  vendors: [vendor],
  profile: { name: 'standard', weakened: [], dependencyPrep: true },
  git: { ready: true, problem: null, lastPushAt: at - 60_000 },
  power: { source: 'ac', batteryPercent: 88, lowPowerMode: false },
  disk: { freeBytes: 120_000_000_000, agflowBytes: 3_000_000_000 },
  acceptingUntil: null,
  activeAttempts: 2,
  lastSeenAt: at,
  createdAt: at - 86_400_000,
};

// An offline runner that last reported nothing about power or disk, and takes no work for a while.
const quietRunner: Runner = {
  ...runner,
  id: 'R-2',
  state: 'needs_login',
  stateDetail: 'the CLI login expired',
  lastError: 'the CLI login expired',
  power: null,
  disk: null,
  acceptingUntil: at + 120_000,
  activeAttempts: 0,
};

const account: AccountQuota = { owner: 'timur', vendor: 'claude', accountId: TEST_ACCOUNT_ID, quota, ownerAway: false };

const facts: AttemptFacts = {
  attemptId: 'T-42-a3',
  fence,
  phase: 'turn',
  eventAgeMs: 4_000,
  tool: null,
  fsAgeMs: 30_000,
  commitAgeMs: null,
  turns: 6,
  turnsWithoutProgress: 0,
  repeatedCalls: 1,
  continuations: 2,
  vendorErrorMs: 0,
  activeMs: 600_000,
  contextUsed: 0.35,
};

const attempt: Attempt = {
  id: 'T-42-a3',
  taskId: 'T-42',
  number: 3,
  role: 'worker',
  agentId: 'A-7',
  runnerId: 'R-1',
  vendor: 'claude',
  model: 'claude-sonnet-5-5',
  sessionRef: 'sess-1',
  fence,
  status: 'running',
  endReason: null,
  failureClass: null,
  failureSignature: null,
  startRef: 'refs/agflow/T-42/a2',
  startSha: sha('a'),
  wipRef: 'refs/agflow/T-42/a3',
  wipSha: sha('b'),
  submittedSha: null,
  resumable: true,
  reviewRounds: 0,
  wakeups: 0,
  activeMs: 600_000,
  phase: 'turn',
  facts,
  stopRequested: null,
  takeover: null,
  leaseExpiresAt: at + 300_000,
  quotaResetsAt: null,
  startedAt: at - 600_000,
  endedAt: null,
  lastActivityAt: at,
};

const takenOver: Attempt = {
  ...attempt,
  status: 'ended',
  endReason: 'taken_over',
  phase: null,
  facts: null,
  stopRequested: { cause: 'takeover', reason: 'taken over by timur', by: 'user:timur', handoff: true, deferred: false, at },
  takeover: {
    local: 'cd ~/.agflow/work/app/T-42-a3 && claude --resume sess-1',
    anywhere: 'git fetch origin refs/agflow/T-42/a3 && git switch -c agflow/T-42-add-login FETCH_HEAD',
    ref: 'refs/agflow/T-42/takeover-timur',
    error: null,
  },
  leaseExpiresAt: null,
  endedAt: at,
};

const leadAttempt: Attempt = {
  ...attempt,
  id: 'lead-e2-a5',
  taskId: null,
  number: 5,
  role: 'lead',
  agentId: 'A-9',
  fence: { epoch: 2, counter: 1 },
  startRef: 'refs/heads/main',
  startSha: sha('c'),
  wipRef: null,
  wipSha: null,
  wakeups: 4,
  facts: null,
  phase: 'idle',
};

const logEntry: AttemptLogEntry = { id: 1, attemptId: 'T-42-a3', ts: at, kind: 'tool', summary: 'Bash: bun test' };

const approval: Approval = {
  id: '6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f',
  attemptId: 'T-42-a3',
  fence,
  runnerId: 'R-1',
  owner: 'timur',
  taskId: 'T-42',
  agentId: 'A-7',
  kind: 'command',
  summary: 'npm install left-pad',
  detail: { command: 'npm install left-pad', cwd: '/work/app/T-42-a3', reason: 'needs the network' },
  status: 'pending',
  decidedBy: null,
  createdAt: at,
  expiresAt: at + 900_000,
  decidedAt: null,
};

const declined: Approval = { ...approval, status: 'declined', decidedBy: 'timur', decidedAt: at + 60_000 };

const submission: SubmissionRecord = {
  id: 'S-9',
  taskId: 'T-42',
  attemptId: 'T-42-a3',
  status: 'submitted',
  summary: 'The login form validates its fields.',
  evidence: ['bun test: 42 pass'],
  headSha: sha('d'),
  error: null,
  requestedAt: at,
  decidedAt: at + 30_000,
};

const leadSeat: LeadSeat = {
  kind: 'runner',
  agentId: 'A-9',
  attemptId: 'lead-e2-a5',
  runnerId: 'R-1',
  since: at,
  wakeups: 4,
  runnerLeads: true,
};

const leadNote: LeadNote = {
  id: 3,
  attemptId: 'lead-e2-a5',
  kind: 'handoff',
  body: 'T-42 waits for review; T-43 is blocked on the API key.',
  author: 'agent:A-9',
  createdAt: at,
};

const prepareRequest: PrepareRequest = {
  id: '1-R-1-17',
  attemptId: 'T-42-a3',
  status: 'ok',
  error: null,
  logTail: 'Saved lockfile',
  requestedAt: at,
  finishedAt: at + 20_000,
};

const project: Project = { name: 'demo', repo: 'https://github.com/acme/demo', paused: false, runnerLeads: false };

const parses = (schema: z.ZodType, value: unknown) => schema.safeParse(value).success;

function without(value: object, key: string): object {
  const copy = { ...value } as Record<string, unknown>;
  delete copy[key];
  return copy;
}

describe('request bodies', () => {
  // One minimal valid body per request schema of design 6.16.
  const bodies: Array<[string, z.ZodType, object]> = [
    ['RunnerPatchInputSchema', RunnerPatchInputSchema, { capacity: 3 }],
    ['RunnerRetireInputSchema', RunnerRetireInputSchema, { runnerKey: 'rk_7d3f0b52' }],
    ['TranscriptInputSchema', TranscriptInputSchema, { tail: 'I added the form.' }],
    ['AgentStopInputSchema', AgentStopInputSchema, { reason: 'wrong approach' }],
    ['AgentReplaceInputSchema', AgentReplaceInputSchema, { reason: 'stuck on the same error' }],
    ['HandbackInputSchema', HandbackInputSchema, { source: 'clone' }],
    ['ApprovalDecisionInputSchema', ApprovalDecisionInputSchema, { decision: 'decline' }],
    ['StaffingInputSchema', StaffingInputSchema, { count: 2, reason: 'two tasks are ready' }],
    ['RunnerSubmitInputSchema', RunnerSubmitInputSchema, { summary: 'The login form validates its fields.' }],
    ['PrepareInputSchema', PrepareInputSchema, {}],
    ['LeadHandoffInputSchema', LeadHandoffInputSchema, { note: 'T-42 waits for review.' }],
    ['ProjectPatchInputSchema', ProjectPatchInputSchema, { runnerLeads: false }],
  ];

  for (const [name, schema, body] of bodies) {
    test(`${name} is strict: it refuses a key it does not know`, () => {
      expect(parses(schema, body)).toBe(true);
      expect(parses(schema, { ...body, bogus: 1 })).toBe(false);
    });
  }

  test("a runner agent's submit body is { summary, evidence } only: the runner pushes, so a branch or headSha is refused", () => {
    expect(RunnerSubmitInputSchema.parse({ summary: 's', evidence: ['bun test: 42 pass'] })).toEqual({
      summary: 's',
      evidence: ['bun test: 42 pass'],
    });
    expect(RunnerSubmitInputSchema.parse({ summary: 's' })).toEqual({ summary: 's', evidence: [] });
    expect(parses(RunnerSubmitInputSchema, { summary: 's', branch: 'agflow/T-42-add-login' })).toBe(false);
    expect(parses(RunnerSubmitInputSchema, { summary: 's', headSha: sha('d') })).toBe(false);
    // The rest are M1's bounds.
    expect(parses(RunnerSubmitInputSchema, { summary: '' })).toBe(false);
    expect(parses(RunnerSubmitInputSchema, { summary: 's', evidence: [''] })).toBe(false);
  });

  test("a hand-back source is 'clone', or a ref under refs/ with a full 40-hex sha", () => {
    const handBack = (source: unknown) => parses(HandbackInputSchema, { source });
    expect(handBack('clone')).toBe(true);
    expect(handBack({ ref: 'refs/agflow/T-42/takeover-timur', sha: sha('e') })).toBe(true);
    expect(HandbackInputSchema.parse({ source: { ref: 'refs/heads/fix', sha: sha('e') } })).toEqual({
      source: { ref: 'refs/heads/fix', sha: sha('e') },
    });
    for (const bad of [
      'ref',
      { kind: 'clone' },
      // The next runner may fetch it by sha, so a short or uppercase one is refused.
      { ref: 'refs/agflow/T-42/takeover-timur', sha: 'eeeeeee' },
      { ref: 'refs/agflow/T-42/takeover-timur', sha: sha('E') },
      { ref: 'agflow/T-42-add-login', sha: sha('e') },
      { ref: 'refs/agflow/../heads/main', sha: sha('e') },
      { ref: 'refs/agflow/T-42/takeover-timur' },
      { sha: sha('e') },
      { ref: 'refs/agflow/T-42/takeover-timur', sha: sha('e'), kind: 'ref' },
    ]) {
      expect([bad, handBack(bad)]).toEqual([bad, false]);
    }
    expect(parses(HandbackInputSchema, {})).toBe(false);
  });

  test('a transcript tail is at most 64 KB of UTF-8', () => {
    expect(TRANSCRIPT_TAIL_MAX_BYTES).toBe(65_536);
    expect(parses(TranscriptInputSchema, { tail: 'x'.repeat(65_536) })).toBe(true);
    expect(parses(TranscriptInputSchema, { tail: 'x'.repeat(65_537) })).toBe(false);
    // Bytes, not characters: '中' takes three, so 21,845 of them are 65,535 bytes and 21,846 are 65,538.
    expect(parses(TranscriptInputSchema, { tail: '中'.repeat(21_845) })).toBe(true);
    expect(parses(TranscriptInputSchema, { tail: '中'.repeat(21_846) })).toBe(false);
    expect(parses(TranscriptInputSchema, { tail: '' })).toBe(true);
    expect(parses(TranscriptInputSchema, {})).toBe(false);
  });

  test('a staffing count is a non-negative integer, with an optional vendor and a reason', () => {
    const staffing = (body: object) => parses(StaffingInputSchema, { count: 2, reason: 'ready work', ...body });
    for (const count of [0, 1, 40]) expect([count, staffing({ count })]).toEqual([count, true]);
    for (const count of [-1, 1.5, '2', null]) expect([count, staffing({ count })]).toEqual([count, false]);
    expect(staffing({ vendor: 'codex' })).toBe(true);
    expect(staffing({ vendor: 'gemini' })).toBe(false);
    expect(staffing({ reason: '' })).toBe(false);
    expect(parses(StaffingInputSchema, { count: 2 })).toBe(false);
  });

  test('RunnerPatchInputSchema takes capacity 1..16, ceilings 0..1 per window and the keepAwake values', () => {
    const patch = (body: object) => parses(RunnerPatchInputSchema, body);
    for (const capacity of [1, 8, 16]) expect([capacity, patch({ capacity })]).toEqual([capacity, true]);
    for (const capacity of [0, 17, 2.5, -1]) expect([capacity, patch({ capacity })]).toEqual([capacity, false]);
    // 0 keeps that vendor off the runner.
    for (const ceilings of [{ claude: { fiveHour: 0, weekly: 1 } }, { codex: { fiveHour: 0.5, weekly: 0.85 } }]) {
      expect([ceilings, patch({ ceilings })]).toEqual([ceilings, true]);
    }
    for (const ceilings of [
      { claude: { fiveHour: 1.01, weekly: 0.5 } },
      { claude: { fiveHour: 0.5, weekly: -0.1 } },
      { claude: { fiveHour: 0.5 } },
      { claude: { fiveHour: 0.5, weekly: 0.5, daily: 0.5 } },
      { gemini: { fiveHour: 0.5, weekly: 0.5 } },
    ]) {
      expect([ceilings, patch({ ceilings })]).toEqual([ceilings, false]);
    }
    for (const keepAwake of ['off', 'ac', 'always']) expect([keepAwake, patch({ keepAwake })]).toEqual([keepAwake, true]);
    expect(patch({ keepAwake: 'never' })).toBe(false);
    expect(patch({ draining: true, allowPaidUsage: { codex: true } })).toBe(true);
    expect(patch({ allowPaidUsage: { codex: 'yes' } })).toBe(false);
    // Only the hub assigns versions, and an empty patch changes nothing.
    expect(patch({ capacity: 3, version: 5 })).toBe(false);
    expect(patch({})).toBe(false);
  });

  test("the runner patch is the settings without their version, as the web's patch type is", () => {
    expectTypeOf<z.output<typeof RunnerPatchInputSchema>>().toEqualTypeOf<Partial<Omit<RunnerSettings, 'version'>>>();
    const full = {
      capacity: 2,
      keepAwake: 'always',
      draining: true,
      ceilings: { claude: { fiveHour: 0.7, weekly: 0.9 } },
      allowPaidUsage: { claude: false },
    } as const;
    expect(RunnerPatchInputSchema.parse(full)).toEqual(full);
  });

  test('stopping an agent takes a reason and an optional hold, false unless asked', () => {
    expect(AgentStopInputSchema.parse({ reason: 'wrong approach' })).toEqual({ reason: 'wrong approach', hold: false });
    expect(AgentStopInputSchema.parse({ reason: 'let me look', hold: true })).toEqual({ reason: 'let me look', hold: true });
    expect(parses(AgentStopInputSchema, { reason: '' })).toBe(false);
    expect(parses(AgentStopInputSchema, { reason: 'r', hold: 'yes' })).toBe(false);
    expect(parses(AgentStopInputSchema, { hold: true })).toBe(false);
    expect(parses(AgentReplaceInputSchema, { reason: 'r', hold: true })).toBe(false);
    expect(parses(AgentReplaceInputSchema, {})).toBe(false);
  });

  test('the other bodies check their values', () => {
    expect(parses(ApprovalDecisionInputSchema, { decision: 'approve' })).toBe(true);
    for (const decision of ['accept', 'approved', 'deny', '']) {
      expect([decision, parses(ApprovalDecisionInputSchema, { decision })]).toEqual([decision, false]);
    }
    expect(parses(ProjectPatchInputSchema, { runnerLeads: true })).toBe(true);
    expect(parses(ProjectPatchInputSchema, {})).toBe(false);
    expect(parses(ProjectPatchInputSchema, { runnerLeads: 'off' })).toBe(false);
    expect(parses(RunnerRetireInputSchema, { runnerKey: '' })).toBe(false);
    // The token names the attempt, so a preparation request carries nothing.
    expect(parses(PrepareInputSchema, { attemptId: 'T-42-a3' })).toBe(false);
    // A lead handoff has the bounds of a task handoff.
    expect(parses(LeadHandoffInputSchema, { note: 'x'.repeat(16_000) })).toBe(true);
    expect(parses(LeadHandoffInputSchema, { note: 'x'.repeat(16_001) })).toBe(false);
    expect(parses(LeadHandoffInputSchema, { note: '' })).toBe(false);
  });
});

describe('queries', () => {
  test('the attempts query takes a task, a role, a comma-separated status list, a runner and a limit', () => {
    const query = { task: 'T-4', role: 'worker', status: 'starting,running', runner: 'R-1', limit: '50' };
    expect(AttemptsQuerySchema.parse(query)).toEqual({
      task: 'T-4',
      role: 'worker',
      status: ['starting', 'running'],
      runner: 'R-1',
      limit: 50,
    });
    expect(AttemptsQuerySchema.parse({ status: 'ended' })).toEqual({ status: ['ended'], limit: 200 });
    for (const bad of [
      { status: 'running,bogus' },
      { status: 'running,' },
      { task: 'T-x' },
      { task: 'T-4-a1' },
      { role: 'boss' },
      { runner: 'R-x' },
    ]) {
      expect([bad, parses(AttemptsQuerySchema, bad)]).toEqual([bad, false]);
    }
  });

  test('the attempts limit defaults to 200 and caps at 1000', () => {
    expect(AttemptsQuerySchema.parse({})).toEqual({ limit: 200 });
    expect(AttemptsQuerySchema.parse({ limit: '1' }).limit).toBe(1);
    expect(AttemptsQuerySchema.parse({ limit: '1000' }).limit).toBe(1000);
    expect(AttemptsQuerySchema.parse({ limit: '5000' }).limit).toBe(1000);
    for (const limit of ['0', '-3', '2.5', 'many']) {
      expect([limit, parses(AttemptsQuerySchema, { limit })]).toEqual([limit, false]);
    }
  });

  test('the approvals query takes a comma-separated status list', () => {
    expect(ApprovalsQuerySchema.parse({ status: 'pending' })).toEqual({ status: ['pending'] });
    expect(ApprovalsQuerySchema.parse({ status: 'approved,declined,expired,void' })).toEqual({
      status: ['approved', 'declined', 'expired', 'void'],
    });
    expect(ApprovalsQuerySchema.parse({})).toEqual({});
    expect(parses(ApprovalsQuerySchema, { status: 'open' })).toBe(false);
  });

  test('queries stay loose and, like M1, read an empty parameter as absent', () => {
    expect(AttemptsQuerySchema.parse({ task: '', role: '', status: '', runner: '', limit: '', t: '1' })).toEqual({
      limit: 200,
    });
    expect(ApprovalsQuerySchema.parse({ status: '', t: '1' })).toEqual({});
  });
});

describe('responses', () => {
  test('the value schemas are typed against the core interfaces', () => {
    expectTypeOf<z.output<typeof RunnerSchema>>().toEqualTypeOf<Runner>();
    expectTypeOf<z.output<typeof AccountQuotaSchema>>().toEqualTypeOf<AccountQuota>();
    expectTypeOf<z.output<typeof AttemptSchema>>().toEqualTypeOf<Attempt>();
    expectTypeOf<z.output<typeof AttemptLogEntrySchema>>().toEqualTypeOf<AttemptLogEntry>();
    expectTypeOf<z.output<typeof ApprovalSchema>>().toEqualTypeOf<Approval>();
    expectTypeOf<z.output<typeof SubmissionRecordSchema>>().toEqualTypeOf<SubmissionRecord>();
    expectTypeOf<z.output<typeof LeadSeatSchema>>().toEqualTypeOf<LeadSeat>();
    expectTypeOf<z.output<typeof LeadNoteSchema>>().toEqualTypeOf<LeadNote>();
    expectTypeOf<z.output<typeof PrepareRequestSchema>>().toEqualTypeOf<PrepareRequest>();
    expectTypeOf<z.output<typeof ProjectSchema>>().toEqualTypeOf<Project>();
  });

  // Each route's answer: a fixture of its core type in the route's wrapper.
  const answers: Array<[string, z.ZodType, object]> = [
    ['RunnersResponseSchema', RunnersResponseSchema, { runners: [runner, quietRunner], accounts: [account] }],
    ['RunnerResponseSchema', RunnerResponseSchema, { runner: { ...runner, capacity: 4, settingsVersion: 5 } }],
    ['AttemptsResponseSchema', AttemptsResponseSchema, { attempts: [attempt, takenOver, leadAttempt] }],
    ['AttemptDetailResponseSchema', AttemptDetailResponseSchema, { attempt: takenOver, log: [logEntry] }],
    ['AttemptResponseSchema', AttemptResponseSchema, { attempt: { ...attempt, stopRequested: takenOver.stopRequested } }],
    ['ApprovalsResponseSchema', ApprovalsResponseSchema, { approvals: [approval, declined] }],
    ['ApprovalResponseSchema', ApprovalResponseSchema, { approval: declined }],
    ['StaffingResponseSchema', StaffingResponseSchema, { running: 2, target: 4 }],
    ['SubmissionResponseSchema', SubmissionResponseSchema, { submission }],
    ['PrepareResponseSchema', PrepareResponseSchema, { request: prepareRequest }],
    ['TakeoverResponseSchema', TakeoverResponseSchema, { attemptId: 'T-42-a3' }],
    ['LeadNotesResponseSchema', LeadNotesResponseSchema, { notes: [leadNote] }],
    ['WhoamiResponseSchema', WhoamiResponseSchema, { user: 'timur' }],
    ['OkResponseSchema', OkResponseSchema, { ok: true }],
    // PATCH /api/project answers the project itself.
    ['ProjectSchema', ProjectSchema, project],
  ];

  for (const [name, schema, answer] of answers) {
    test(`${name} parses its answer and refuses a key it does not know`, () => {
      expect(schema.safeParse(answer).data).toEqual(answer);
      expect(parses(schema, { ...answer, bogus: 1 })).toBe(false);
      for (const key of Object.keys(answer)) expect([key, parses(schema, without(answer, key))]).toEqual([key, false]);
    });
  }

  test('the values inside an answer are strict and checked too', () => {
    expect(parses(RunnerSchema, { ...runner, bogus: 1 })).toBe(false);
    expect(parses(RunnerSchema, { ...runner, state: 'sleeping' })).toBe(false);
    expect(parses(RunnerSchema, { ...runner, id: 'runner-1' })).toBe(false);
    expect(parses(RunnerSchema, { ...runner, git: { ...runner.git, bogus: 1 } })).toBe(false);
    expect(parses(AttemptSchema, { ...attempt, status: 'paused' })).toBe(false);
    expect(parses(AttemptSchema, { ...attempt, wipSha: 'bbbbbbb' })).toBe(false);
    expect(parses(AttemptSchema, { ...takenOver, takeover: { ...takenOver.takeover, ref: 'takeover-timur' } })).toBe(false);
    expect(parses(ApprovalSchema, { ...approval, id: 'approval-1' })).toBe(false);
    expect(parses(ApprovalSchema, { ...approval, status: 'open' })).toBe(false);
    expect(parses(AttemptLogEntrySchema, { ...logEntry, kind: 'warning' })).toBe(false);
    expect(parses(AccountQuotaSchema, { ...account, accountId: null })).toBe(false);
    expect(parses(PrepareRequestSchema, { ...prepareRequest, id: 'P-1' })).toBe(false);
    expect(parses(StaffingResponseSchema, { running: -1, target: 4 })).toBe(false);
    // A refusal is an error status with a code, never a 200 that says ok: false.
    expect(parses(OkResponseSchema, { ok: false })).toBe(false);
    expect(parses(ProjectSchema, { ...project, runnerLeads: undefined })).toBe(false);
    expect(parses(LeadSeatSchema, leadSeat)).toBe(true);
    const empty = { kind: 'none', agentId: null, attemptId: null, runnerId: null, since: null, wakeups: 0, runnerLeads: false };
    expect(parses(LeadSeatSchema, empty)).toBe(true);
    expect(parses(LeadSeatSchema, { ...empty, kind: 'chat' })).toBe(false);
  });

  test("an attempt's id names its task and number; a lead attempt has no task and the role lead", () => {
    expect(parses(AttemptSchema, leadAttempt)).toBe(true);
    // A live lead's claim: a task attempt records its agent's role, and M1 lets a lead claim a task.
    expect(parses(AttemptSchema, { ...attempt, role: 'lead', runnerId: null })).toBe(true);
    for (const bad of [
      { ...attempt, taskId: 'T-41' },
      { ...attempt, number: 4 },
      { ...attempt, id: 'lead-a3', taskId: null },
      { ...leadAttempt, taskId: 'T-42' },
      { ...leadAttempt, role: 'worker' },
      { ...attempt, id: 'T-42' },
    ]) {
      expect([bad.id, bad.taskId, bad.role, parses(AttemptSchema, bad)]).toEqual([bad.id, bad.taskId, bad.role, false]);
    }
  });

  test('approvals, submissions and lead notes name the task of their attempt', () => {
    const leadApproval = { ...approval, attemptId: 'lead-a5', taskId: null, agentId: 'A-9' };
    expect(parses(ApprovalSchema, leadApproval)).toBe(true);
    expect(parses(ApprovalSchema, { ...approval, taskId: 'T-41' })).toBe(false);
    expect(parses(ApprovalSchema, { ...leadApproval, taskId: 'T-42' })).toBe(false);
    expect(parses(SubmissionRecordSchema, { ...submission, taskId: 'T-41' })).toBe(false);
    expect(parses(SubmissionRecordSchema, { ...submission, attemptId: 'lead-a5' })).toBe(false);
    // A live lead's notes have no attempt; a runner lead's name its lead attempt.
    expect(parses(LeadNoteSchema, { ...leadNote, attemptId: null })).toBe(true);
    expect(parses(LeadNoteSchema, { ...leadNote, attemptId: 'T-42-a3' })).toBe(false);
  });
});

describe('error codes', () => {
  test("AGENT_ERRORS are design 6.5's refusals of agent tokens, TAKEOVER_REFUSALS design 6.12's 409 codes", () => {
    expect([...AGENT_ERRORS]).toEqual(['attempt_ended', 'attempt_refenced', 'agent_not_allowed']);
    expect([...TAKEOVER_REFUSALS]).toEqual(['runner_offline', 'not_running', 'submission_pending']);
  });
});

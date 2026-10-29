import { describe, expect, expectTypeOf, test } from 'bun:test';
import type { z } from 'zod';
import {
  AccountQuotaReportSchema,
  type AttemptSpec,
  AttemptFactsSchema,
  AttemptSpecSchema,
  CLOSE_CODES,
  COMMAND_MIN_PROTOCOL,
  FenceSchema,
  type HubMessage,
  HubMessageSchema,
  type InjectedMessage,
  InjectedMessageSchema,
  LiveAttemptSchema,
  PROTOCOL_VERSION,
  type Parsed,
  ProfileSummarySchema,
  RUNNER_COMMAND_KINDS,
  type RunnerCommand,
  type RunnerCommandKind,
  RunnerCommandSchema,
  type RunnerMessage,
  RunnerMessageSchema,
  type RunnerSettings,
  RunnerSettingsSchema,
  RunnerVendorSchema,
  TEST_ACCOUNT_ID,
  VendorQuotaSchema,
  parseHubMessage,
  parseRunnerMessage,
} from '../src/runner-protocol';
import type { AttemptFacts, Fence, ProfileSummary, RunnerVendor, VendorQuota } from '../src/types';

const at = 1_767_225_600_000;
const fence: Fence = { epoch: 1, counter: 7 };
const token = `agt_${'x'.repeat(43)}`;
const sha = (char: string) => char.repeat(40);

const quota: VendorQuota = {
  state: 'ok',
  resetsAt: at + 3_600_000,
  windows: { fiveHour: 0.42, weekly: 0.1 },
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

const profile: ProfileSummary = { name: 'standard', weakened: [], dependencyPrep: true };

const settings: RunnerSettings = {
  capacity: 2,
  keepAwake: 'ac',
  draining: false,
  ceilings: { claude: { fiveHour: 0.85, weekly: 0.85 } },
  allowPaidUsage: { claude: false },
  version: 3,
};

const tool = { name: 'Bash', command: 'bun test', long: true, capMs: 5_400_000, ageMs: 12_000 };

const facts: AttemptFacts = {
  attemptId: 'T-42-a3',
  fence,
  phase: 'turn',
  eventAgeMs: 4_000,
  tool,
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

const restore: AttemptSpec['restore'] = { paths: ['.claude/**', '.github/workflows/**'], base: 'refs/heads/main' };

const spec: AttemptSpec = {
  attemptId: 'T-42-a3',
  taskId: 'T-42',
  role: 'worker',
  vendor: 'claude',
  model: null,
  fence,
  agentToken: token,
  hubUrl: 'https://hub.example.com',
  repo: { url: 'git@github.com:acme/app.git', mainBranch: 'main' },
  start: { ref: 'refs/agflow/T-42/a2', sha: sha('a') },
  branch: 'agflow/T-42-add-login',
  wipRef: 'refs/agflow/T-42/a3',
  restore,
  acceptanceIds: ['A1', 'A2'],
  toolCaps: { defaultMs: 1_800_000, longMs: 5_400_000, checks: [{ cmd: 'bun test', capMs: 5_400_000 }] },
  taskPack: '# T-42 Add login',
  brief: 'You are an agflow worker.',
  firstPrompt: 'Read .agflow/run/task.md, then start.',
  successor: false,
};

const leadSpec: AttemptSpec = {
  ...spec,
  attemptId: 'lead-e2-a5',
  taskId: null,
  role: 'lead',
  fence: { epoch: 2, counter: 1 },
  start: { ref: 'refs/heads/main', sha: null },
  branch: null,
  wipRef: null,
  restore: { paths: [], base: null },
  acceptanceIds: [],
  successor: true,
};

const messages: InjectedMessage[] = [
  { messageId: 0, authority: 'system', text: 'Situation report: 3 tasks in progress.' },
  { messageId: 17, authority: 'person', text: '> timur: please add a test for the empty password' },
];

// One command of each kind; the mapped type makes the compiler insist on all 17.
const commands: { [K in RunnerCommandKind]: Extract<RunnerCommand, { kind: K }> } = {
  start_attempt: { kind: 'start_attempt', attempt: spec },
  resume_attempt: {
    kind: 'resume_attempt',
    attemptId: 'T-42-a3',
    fence,
    agentToken: token,
    prompt: 'The runner restarted; continue from your last step.',
    messages,
    taskPack: null,
    restore,
    acceptanceIds: ['A1'],
  },
  deliver: { kind: 'deliver', attemptId: 'T-42-a3', fence, messages, more: 2 },
  interrupt: { kind: 'interrupt', attemptId: 'T-42-a3', fence },
  stop_attempt: {
    kind: 'stop_attempt',
    attemptId: 'T-42-a3',
    fence,
    cause: 'stall_hung_tool',
    reason: 'a tool call ran past its cap',
    handoff: true,
    interruptFirst: true,
    keepClone: false,
  },
  hold_attempt: { kind: 'hold_attempt', attemptId: 'T-42-a3', fence },
  push_submission: {
    kind: 'push_submission',
    attemptId: 'T-42-a3',
    fence,
    submissionId: 'S-9',
    branch: 'agflow/T-42-add-login',
    expectedBranchSha: null,
    adoptable: [sha('b'), 'abc1234'],
  },
  prepare_takeover: { kind: 'prepare_takeover', attemptId: 'T-42-a3', fence, person: 'timur' },
  hand_back: { kind: 'hand_back', attemptId: 'T-42-a3', source: { kind: 'clone' } },
  cleanup_attempt: { kind: 'cleanup_attempt', attemptId: 'T-42-a3' },
  decide_approval: {
    kind: 'decide_approval',
    attemptId: 'T-42-a3',
    fence,
    approvalId: '6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f',
    decision: 'approve',
    reason: null,
  },
  upload_transcript: { kind: 'upload_transcript', attemptId: 'T-42-a3' },
  prepare_dependencies: { kind: 'prepare_dependencies', attemptId: 'T-42-a3', fence, requestId: '1-R-3-17' },
  refresh_vault: { kind: 'refresh_vault', taskId: 'T-42', refs: ['refs/agflow/T-42/a2-late-1'] },
  preflight: { kind: 'preflight', vendor: 'codex' },
  delete_refs: { kind: 'delete_refs', refs: [{ ref: 'refs/agflow/T-42/a3', expectedSha: sha('c') }] },
  update_settings: { kind: 'update_settings', settings: { capacity: 3, draining: false }, version: 4 },
};

type Variant<M extends { t: string }, T extends M['t']> = Extract<M, { t: T }>;

const hello: Variant<RunnerMessage, 'hello'> = {
  t: 'hello',
  protocol: PROTOCOL_VERSION,
  runnerKey: 'rk_7d3f0b52',
  machineId: '1B2C3D4E-5F60-4718-9A2B-3C4D5E6F7081',
  name: 'timur-mbp',
  agflowVersion: '0.1.0',
  platform: 'darwin-arm64',
  settings,
  vendors: [vendor],
  quota: [{ vendor: 'claude', accountId: TEST_ACCOUNT_ID, quota }],
  profile,
  git: { ready: true, problem: null, lastPushAt: at - 60_000 },
  state: 'ok',
  stateDetail: null,
  outboxEpoch: 'f3a9c2d1',
  firstSeq: 41,
  lastSeq: 57,
  lastHubEpoch: 1,
  attempts: [{ attemptId: 'T-42-a3', fence, state: 'running', sessionRef: 'sess-1', clone: true }],
};

const heartbeat: Variant<RunnerMessage, 'heartbeat'> = {
  t: 'heartbeat',
  at,
  attempts: [facts],
  power: { source: 'battery', batteryPercent: 64, lowPowerMode: false },
  disk: { freeBytes: 120_000_000_000, agflowBytes: 3_000_000_000 },
  acceptingUntil: null,
};

const events: Variant<RunnerMessage, 'events'> = {
  t: 'events',
  outboxEpoch: 'f3a9c2d1',
  events: [
    { seq: 58, at, type: 'attempt.first_output', attemptId: 'T-42-a3', fence, data: { text: 'I will add the form.' } },
    { seq: 59, at, type: 'runner.state', data: { state: 'ok', detail: null } },
  ],
};

const runnerMessages: RunnerMessage[] = [
  hello,
  heartbeat,
  events,
  { t: 'result', commandId: '1-R-3-17', ok: true, data: { applied: true } },
  { t: 'result', commandId: '1-R-3-18', ok: false, error: 'unsupported' },
  { t: 'result', commandId: '1-R-3-19', ok: true },
];

const welcome: Variant<HubMessage, 'welcome'> = {
  t: 'welcome',
  runnerId: 'R-3',
  hubEpoch: 1,
  hubTime: at,
  ackedSeq: 40,
  wipRefPrefix: 'refs/agflow/',
  stop: [{ attemptId: 'T-40-a1', reason: 'the runner lease expired' }],
  timings: { heartbeatMs: 15_000, deadLinkMs: 45_000, handoffMs: 180_000, wipGraceMs: 300_000 },
};

const commandMessage = (command: RunnerCommand, seq = 17): Variant<HubMessage, 'command'> => ({
  t: 'command',
  id: `1-R-3-${seq}`,
  seq,
  command,
});

const hubMessages: HubMessage[] = [
  welcome,
  { t: 'ack', outboxEpoch: 'f3a9c2d1', seq: 57 },
  { t: 'heartbeat_ack', at, hubTime: at + 4 },
  ...RUNNER_COMMAND_KINDS.map((kind, i) => commandMessage(commands[kind], i + 1)),
];

const fromRunner = (message: unknown) => parseRunnerMessage(JSON.stringify(message));
const fromHub = (message: unknown) => parseHubMessage(JSON.stringify(message));

function errorOf(result: Parsed<unknown>): string {
  if (result.ok) throw new Error(`expected an error, got ${JSON.stringify(result.value)}`);
  return result.error;
}

function without(value: object, key: string): object {
  const copy = { ...value } as Record<string, unknown>;
  delete copy[key];
  return copy;
}

describe('round trips', () => {
  test('every runner message variant round-trips through parseRunnerMessage', () => {
    for (const message of runnerMessages) expect(fromRunner(message)).toEqual({ ok: true, value: message });
  });

  test('every hub message variant round-trips through parseHubMessage, a command of each kind included', () => {
    for (const message of hubMessages) expect(fromHub(message)).toEqual({ ok: true, value: message });
  });

  test('each of the 17 command kinds round-trips through RunnerCommandSchema', () => {
    expect(RUNNER_COMMAND_KINDS).toHaveLength(17);
    expect(new Set(RUNNER_COMMAND_KINDS).size).toBe(17);
    for (const kind of RUNNER_COMMAND_KINDS) {
      expect([kind, RunnerCommandSchema.safeParse(commands[kind]).data]).toEqual([kind, commands[kind]]);
    }
  });

  test('RUNNER_COMMAND_KINDS matches the RunnerCommand union', () => {
    expectTypeOf<(typeof RUNNER_COMMAND_KINDS)[number]>().toEqualTypeOf<RunnerCommand['kind']>();
    expect(Object.keys(commands).sort()).toEqual([...RUNNER_COMMAND_KINDS].sort());
  });

  test('a lead attempt spec round-trips too', () => {
    expect(RunnerCommandSchema.safeParse({ kind: 'start_attempt', attempt: leadSpec }).data).toEqual({
      kind: 'start_attempt',
      attempt: leadSpec,
    });
  });
});

describe('strict objects', () => {
  test('an unknown key gives an error result, in a message or deep inside it', () => {
    for (const message of runnerMessages) expect(errorOf(fromRunner({ ...message, bogus: 1 }))).toContain('bogus');
    for (const message of hubMessages) expect(errorOf(fromHub({ ...message, bogus: 1 }))).toContain('bogus');
    expect(errorOf(fromRunner({ ...hello, git: { ...hello.git, bogus: 1 } }))).toContain('bogus');
    expect(errorOf(fromRunner({ ...heartbeat, attempts: [{ ...facts, bogus: 1 }] }))).toContain('bogus');
    const deep = { kind: 'start_attempt', attempt: { ...spec, start: { ...spec.start, bogus: 1 } } };
    expect(errorOf(fromHub(commandMessage(deep as never)))).toContain('bogus');
  });

  test('a missing field gives an error result', () => {
    // A result's data and error are the only optional fields.
    for (const message of runnerMessages) {
      for (const key of Object.keys(message).filter((k) => k !== 'data' && k !== 'error')) {
        expect([message.t, key, fromRunner(without(message, key)).ok]).toEqual([message.t, key, false]);
      }
    }
    for (const message of hubMessages) {
      for (const key of Object.keys(message)) {
        expect([message.t, key, fromHub(without(message, key)).ok]).toEqual([message.t, key, false]);
      }
    }
    for (const kind of RUNNER_COMMAND_KINDS) {
      const command = commands[kind];
      for (const key of Object.keys(command).filter((k) => k !== 'kind')) {
        expect([kind, key, RunnerCommandSchema.safeParse(without(command, key)).success]).toEqual([kind, key, false]);
      }
    }
  });

  test('a wrong or missing discriminator gives an error result', () => {
    expect(fromRunner({ ...heartbeat, t: 'heartbeat_ack' }).ok).toBe(false);
    expect(fromRunner({ ...hello, t: 'welcome' }).ok).toBe(false);
    expect(fromRunner(without(hello, 't')).ok).toBe(false);
    expect(fromHub({ ...welcome, t: 'hello' }).ok).toBe(false);
    expect(RunnerCommandSchema.safeParse({ ...commands.interrupt, kind: 'pause' }).success).toBe(false);
    expect(RunnerCommandSchema.safeParse(without(commands.interrupt, 'kind')).success).toBe(false);
    // A message's discriminator is t, a command's is kind: one is never read as the other.
    expect(RunnerCommandSchema.safeParse({ ...commands.interrupt, t: 'interrupt' }).success).toBe(false);
  });

  test('invalid JSON and values that are not objects are reported, never thrown', () => {
    for (const text of ['', '{', 'not json', '{"t":"hello",}', '42', 'null', '[]', '"hello"']) {
      expect([text, parseRunnerMessage(text).ok]).toEqual([text, false]);
      expect([text, parseHubMessage(text).ok]).toEqual([text, false]);
    }
    expect(errorOf(parseRunnerMessage('{'))).toContain('JSON');
  });
});

describe('hello', () => {
  test('requires every field of design 6.3', () => {
    for (const key of Object.keys(hello).filter((k) => k !== 't')) {
      expect([key, fromRunner(without(hello, key)).ok]).toEqual([key, false]);
    }
  });

  test('lastSeq is at least firstSeq − 1, which an empty outbox reports', () => {
    expect(fromRunner({ ...hello, firstSeq: 58, lastSeq: 57 }).ok).toBe(true);
    expect(fromRunner({ ...hello, firstSeq: 1, lastSeq: 0 }).ok).toBe(true);
    expect(errorOf(fromRunner({ ...hello, firstSeq: 59, lastSeq: 57 }))).toContain('lastSeq');
    expect(fromRunner({ ...hello, firstSeq: 0, lastSeq: 0 }).ok).toBe(false);
  });

  test('carries the confirmed settings with their version', () => {
    expect(fromRunner({ ...hello, settings: without(settings, 'version') }).ok).toBe(false);
    // 0: settings the hub has not confirmed yet, from a runner it has never seen.
    expect(fromRunner({ ...hello, settings: { ...settings, version: 0 } }).ok).toBe(true);
    expect(fromRunner({ ...hello, settings: { ...settings, capacity: 0 } }).ok).toBe(false);
    const gemini = { ...settings, ceilings: { gemini: { fiveHour: 1, weekly: 1 } } };
    expect(fromRunner({ ...hello, settings: gemini }).ok).toBe(false);
  });

  test('any protocol number parses, so the hub can refuse an unsupported one with 4426', () => {
    expect(fromRunner({ ...hello, protocol: 2 }).ok).toBe(true);
    expect(fromRunner({ ...hello, protocol: 0 }).ok).toBe(false);
  });

  test('a hello the hub cannot read still gives its protocol, key and machine, so a newer runner gets 4426', () => {
    const helloOf = (message: unknown) => {
      const parsed = fromRunner(message);
      if (parsed.ok) throw new Error(`expected an error, got ${JSON.stringify(parsed.value)}`);
      return parsed.hello;
    };
    const newer = { protocol: 2, runnerKey: hello.runnerKey, machineId: hello.machineId };
    // A protocol-2 hello with a field protocol 1 does not know, and one that kept little of protocol 1's shape.
    expect(helloOf({ ...hello, protocol: 2, resumeTokens: ['rt_1'] })).toEqual(newer);
    expect(helloOf({ t: 'hello', ...newer, capabilities: { compaction: true } })).toEqual(newer);
    // An unreadable protocol-1 hello gives them too: the hub supports that version, so it closes the link instead.
    expect(helloOf({ ...hello, git: null })).toEqual({ ...newer, protocol: 1 });
    // Without a usable version, key and machine there is nothing to refuse.
    for (const bad of [
      without(hello, 'protocol'),
      { ...hello, protocol: 0 },
      { ...hello, protocol: '2' },
      without(hello, 'runnerKey'),
      { ...hello, machineId: '' },
      { ...heartbeat, bogus: 1 },
    ]) {
      expect([bad, helloOf(bad)]).toEqual([bad, null]);
    }
    expect(parseRunnerMessage('{')).toMatchObject({ ok: false, hello: null });
  });

  test('LiveAttempt.state is starting, running, idle, stopped or suspended', () => {
    for (const state of ['starting', 'running', 'idle', 'stopped', 'suspended']) {
      const attempt = { attemptId: 'T-42-a3', fence, state, sessionRef: null, clone: false };
      expect([state, LiveAttemptSchema.safeParse(attempt).success]).toEqual([state, true]);
    }
    for (const state of ['ended', 'holding', 'quota_wait', '']) {
      const attempt = { attemptId: 'T-42-a3', fence, state, sessionRef: null, clone: false };
      expect([state, LiveAttemptSchema.safeParse(attempt).success]).toEqual([state, false]);
    }
  });
});

describe('welcome', () => {
  test('requires timings { heartbeatMs, deadLinkMs, handoffMs, wipGraceMs }', () => {
    expect(fromHub(without(welcome, 'timings')).ok).toBe(false);
    for (const key of Object.keys(welcome.timings)) {
      expect([key, fromHub({ ...welcome, timings: without(welcome.timings, key) }).ok]).toEqual([key, false]);
    }
    expect(fromHub({ ...welcome, timings: { ...welcome.timings, wipGraceMs: 0 } }).ok).toBe(false);
  });

  test('names a WIP ref prefix the runner can push under', () => {
    expect(fromHub({ ...welcome, wipRefPrefix: 'refs/heads/agflow-wip/' }).ok).toBe(true);
    for (const prefix of ['refs/agflow', 'agflow/', 'refs/agflow-local/']) {
      expect([prefix, fromHub({ ...welcome, wipRefPrefix: prefix }).ok]).toEqual([prefix, false]);
    }
  });
});

describe('the events envelope', () => {
  test('leaves data, attemptId and fence to parseRunnerEvent', () => {
    const odd = {
      ...events,
      events: [{ seq: 60, at, type: 'attempt.wip', attemptId: 7, fence: 'e1.7', data: 'anything' }],
    };
    expect(fromRunner(odd)).toEqual({ ok: true, value: odd });
    const bare = { ...events, events: [{ seq: 61, at, type: 'attempt.bogus', data: null, extra: true }] };
    expect(fromRunner(bare)).toEqual({ ok: true, value: bare });
  });

  test("checks outboxEpoch and each event's seq, at and type", () => {
    const event = events.events[0];
    expect(fromRunner(without(events, 'outboxEpoch')).ok).toBe(false);
    expect(fromRunner({ ...events, outboxEpoch: '' }).ok).toBe(false);
    for (const bad of [
      without(event, 'seq'),
      { ...event, seq: 0 },
      { ...event, seq: 1.5 },
      { ...event, seq: '58' },
      without(event, 'at'),
      { ...event, at: -1 },
      without(event, 'type'),
      { ...event, type: '' },
      { ...event, type: 5 },
    ]) {
      expect([bad, fromRunner({ ...events, events: [bad] }).ok]).toEqual([bad, false]);
    }
  });
});

describe('value schemas', () => {
  test('are typed against the core interfaces', () => {
    expectTypeOf<z.output<typeof FenceSchema>>().toEqualTypeOf<Fence>();
    expectTypeOf<z.output<typeof AttemptFactsSchema>>().toEqualTypeOf<AttemptFacts>();
    expectTypeOf<z.output<typeof RunnerVendorSchema>>().toEqualTypeOf<RunnerVendor>();
    expectTypeOf<z.output<typeof VendorQuotaSchema>>().toEqualTypeOf<VendorQuota>();
    expectTypeOf<z.output<typeof ProfileSummarySchema>>().toEqualTypeOf<ProfileSummary>();
    expectTypeOf<z.output<typeof RunnerSettingsSchema>>().toEqualTypeOf<RunnerSettings>();
    expectTypeOf<z.output<typeof AttemptSpecSchema>>().toEqualTypeOf<AttemptSpec>();
    expectTypeOf<z.output<typeof InjectedMessageSchema>>().toEqualTypeOf<InjectedMessage>();
    expectTypeOf<z.output<typeof RunnerCommandSchema>>().toEqualTypeOf<RunnerCommand>();
    expectTypeOf<z.output<typeof RunnerMessageSchema>>().toEqualTypeOf<RunnerMessage>();
    expectTypeOf<z.output<typeof HubMessageSchema>>().toEqualTypeOf<HubMessage>();
    for (const [schema, value] of [
      [FenceSchema, fence],
      [RunnerVendorSchema, vendor],
      [VendorQuotaSchema, quota],
      [ProfileSummarySchema, profile],
      [AccountQuotaReportSchema, { vendor: 'codex', accountId: TEST_ACCOUNT_ID, quota }],
    ] as const) {
      expect(schema.safeParse(value).data).toEqual(value);
    }
  });

  test('fences, account ids and quota windows are checked', () => {
    for (const bad of [{ epoch: 0, counter: 1 }, { epoch: 1, counter: 0 }, { epoch: 1.5, counter: 1 }, { epoch: 1 }]) {
      expect([bad, FenceSchema.safeParse(bad).success]).toEqual([bad, false]);
    }
    expect(RunnerVendorSchema.safeParse({ ...vendor, accountId: null }).success).toBe(true);
    expect(RunnerVendorSchema.safeParse({ ...vendor, accountId: 'timur@example.com' }).success).toBe(false);
    expect(VendorQuotaSchema.safeParse({ ...quota, windows: { fiveHour: null, weekly: 1 } }).success).toBe(true);
    expect(VendorQuotaSchema.safeParse({ ...quota, windows: { fiveHour: 1.2, weekly: 0 } }).success).toBe(false);
    expect(AccountQuotaReportSchema.safeParse({ vendor: 'claude', accountId: null, quota }).success).toBe(false);
  });

  test('AttemptFacts ages are non-negative integers and contextUsed is 0..1 or null', () => {
    const ages = ['eventAgeMs', 'fsAgeMs', 'turns', 'turnsWithoutProgress', 'repeatedCalls', 'continuations'] as const;
    for (const key of [...ages, 'vendorErrorMs', 'activeMs'] as const) {
      for (const bad of [-1, 1.5, '3']) {
        expect([key, bad, AttemptFactsSchema.safeParse({ ...facts, [key]: bad }).success]).toEqual([key, bad, false]);
      }
    }
    expect(AttemptFactsSchema.safeParse({ ...facts, tool: { ...tool, ageMs: -5 } }).success).toBe(false);
    expect(AttemptFactsSchema.safeParse({ ...facts, tool: { ...tool, capMs: null } }).success).toBe(true);
    expect(AttemptFactsSchema.safeParse({ ...facts, fsAgeMs: null, tool: null }).success).toBe(true);
    for (const used of [0, 0.5, 1, null]) {
      expect([used, AttemptFactsSchema.safeParse({ ...facts, contextUsed: used }).success]).toEqual([used, true]);
    }
    for (const used of [-0.1, 1.01, 70]) {
      expect([used, AttemptFactsSchema.safeParse({ ...facts, contextUsed: used }).success]).toEqual([used, false]);
    }
  });
});

describe('commands', () => {
  test('COMMAND_MIN_PROTOCOL maps all 17 kinds to 1', () => {
    expect(Object.keys(COMMAND_MIN_PROTOCOL).sort()).toEqual([...RUNNER_COMMAND_KINDS].sort());
    for (const kind of RUNNER_COMMAND_KINDS) expect([kind, COMMAND_MIN_PROTOCOL[kind]]).toEqual([kind, 1]);
    expect(PROTOCOL_VERSION).toBe(1);
  });

  test('start_attempt and resume_attempt carry an agent token', () => {
    const bare = { kind: 'start_attempt', attempt: without(spec, 'agentToken') };
    expect(RunnerCommandSchema.safeParse(bare).success).toBe(false);
    expect(RunnerCommandSchema.safeParse(without(commands.resume_attempt, 'agentToken')).success).toBe(false);
    expect(RunnerCommandSchema.safeParse({ ...commands.resume_attempt, agentToken: 'cli_token' }).success).toBe(false);
  });

  test('decide_approval carries a fence and the approval id', () => {
    expect(RunnerCommandSchema.safeParse(without(commands.decide_approval, 'fence')).success).toBe(false);
    expect(RunnerCommandSchema.safeParse(without(commands.decide_approval, 'approvalId')).success).toBe(false);
    expect(RunnerCommandSchema.safeParse({ ...commands.decide_approval, decision: 'accept' }).success).toBe(false);
  });

  test("hand_back's source is { kind: 'clone' } or { kind: 'ref', ref, sha } with a full sha", () => {
    const handBack = (source: unknown) => RunnerCommandSchema.safeParse({ ...commands.hand_back, source }).success;
    expect(handBack({ kind: 'clone' })).toBe(true);
    expect(handBack({ kind: 'ref', ref: 'refs/agflow/T-42/takeover-timur', sha: sha('d') })).toBe(true);
    expect(handBack({ kind: 'ref', ref: 'refs/agflow/T-42/takeover-timur', sha: 'ddddddd' })).toBe(false);
    expect(handBack({ kind: 'ref', ref: 'refs/agflow/T-42/takeover-timur' })).toBe(false);
    expect(handBack({ kind: 'ref', ref: 'agflow/T-42-x', sha: sha('d') })).toBe(false);
    expect(handBack({ kind: 'clone', ref: 'refs/agflow/T-42/a3' })).toBe(false);
    expect(handBack('clone')).toBe(false);
  });

  test('delete_refs expects full shas; start, expected and adoptable shas may be abbreviated M1 values', () => {
    const short = 'abc1234';
    const deleteRefs = (expectedSha: string) =>
      RunnerCommandSchema.safeParse({ ...commands.delete_refs, refs: [{ ref: 'refs/agflow/T-42/a3', expectedSha }] });
    expect(deleteRefs(sha('c')).success).toBe(true);
    expect(deleteRefs(short).success).toBe(false);
    expect(AttemptSpecSchema.safeParse({ ...spec, start: { ...spec.start, sha: short } }).success).toBe(true);
    const push = { ...commands.push_submission, expectedBranchSha: short, adoptable: [short] };
    expect(RunnerCommandSchema.safeParse(push).success).toBe(true);
  });

  test('deliver carries how many messages did not fit', () => {
    expect(RunnerCommandSchema.safeParse(without(commands.deliver, 'more')).success).toBe(false);
    expect(RunnerCommandSchema.safeParse({ ...commands.deliver, more: -1 }).success).toBe(false);
    expect(RunnerCommandSchema.safeParse({ ...commands.deliver, more: 0 }).success).toBe(true);
  });

  test('update_settings carries changed settings without their version, and the version the hub gave them', () => {
    const update = (changes: unknown) =>
      RunnerCommandSchema.safeParse({ ...commands.update_settings, settings: changes }).success;
    expect(update({})).toBe(true);
    expect(update(without(settings, 'version'))).toBe(true);
    expect(update({ version: 4 })).toBe(false);
    expect(update({ capacity: 17 })).toBe(false);
    expect(update({ keepAwake: 'never' })).toBe(false);
    expect(RunnerCommandSchema.safeParse({ ...commands.update_settings, version: 0 }).success).toBe(false);
  });

  test('restore.base is a ref under refs/ or null', () => {
    const withBase = (base: unknown) => AttemptSpecSchema.safeParse({ ...spec, restore: { ...restore, base } }).success;
    expect(withBase('refs/heads/main')).toBe(true);
    expect(withBase(null)).toBe(true);
    for (const base of ['main', 'heads/main', 'refs/heads/../main', 'refs/heads/main/', '', sha('a')]) {
      expect([base, withBase(base)]).toEqual([base, false]);
    }
    const resume = (base: unknown) => ({ ...commands.resume_attempt, restore: { ...restore, base } });
    expect(RunnerCommandSchema.safeParse(resume('refs/heads/main')).success).toBe(true);
    expect(RunnerCommandSchema.safeParse(resume('main')).success).toBe(false);
  });

  test("an attempt spec's ids agree: a lead has no task, branch or WIP ref, and a worker's id names its task", () => {
    expect(AttemptSpecSchema.safeParse(leadSpec).success).toBe(true);
    for (const bad of [
      { ...spec, attemptId: 'T-41-a3' },
      { ...spec, attemptId: 'lead-a3' },
      { ...spec, role: 'lead' },
      { ...spec, branch: null },
      { ...spec, wipRef: null },
      { ...leadSpec, taskId: 'T-42' },
      { ...leadSpec, role: 'worker' },
      { ...leadSpec, branch: 'agflow/T-42-add-login' },
      { ...leadSpec, wipRef: 'refs/agflow/T-42/a3' },
      { ...spec, attemptId: '../T-42-a3' },
    ]) {
      const parsed = AttemptSpecSchema.safeParse(bad).success;
      expect([bad.attemptId, bad.role, parsed]).toEqual([bad.attemptId, bad.role, false]);
    }
  });

  test('a command the runner cannot read still names its id, so the runner can answer it unsupported', () => {
    const pause = { kind: 'pause', attemptId: 'T-42-a3' };
    const unknownKind = fromHub({ ...commandMessage(commands.interrupt), command: pause });
    expect(unknownKind).toMatchObject({ ok: false, commandId: '1-R-3-17' });
    const invalid = fromHub(commandMessage({ ...commands.interrupt, fence: { epoch: 1 } } as never, 18));
    expect(invalid).toMatchObject({ ok: false, commandId: '1-R-3-18' });
    expect(fromHub({ t: 'command', id: '1-R-3-19', seq: 19 })).toMatchObject({ ok: false, commandId: '1-R-3-19' });
    expect(fromHub({ ...welcome, hubEpoch: 0 })).toMatchObject({ ok: false, commandId: null });
    const noId = { t: 'command', seq: 19, command: commands.interrupt };
    expect(fromHub(noId)).toMatchObject({ ok: false, commandId: null });
    expect(parseHubMessage('{')).toMatchObject({ ok: false, commandId: null });
  });
});

describe('injected messages and constants', () => {
  test('InjectedMessage accepts messageId 0 with authority system: hub text with no message row', () => {
    const report = { messageId: 0, authority: 'system', text: 'Situation report' };
    expect(InjectedMessageSchema.safeParse(report).success).toBe(true);
    expect(InjectedMessageSchema.safeParse({ messageId: 0, authority: 'person', text: 'hi' }).success).toBe(false);
    expect(InjectedMessageSchema.safeParse({ messageId: -1, authority: 'system', text: 'hi' }).success).toBe(false);
    expect(InjectedMessageSchema.safeParse({ messageId: 3, authority: 'lead', text: 'hi' }).success).toBe(false);
  });

  test("TEST_ACCOUNT_ID is the first 16 hex of sha256('agflow-test')", async () => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('agflow-test'));
    const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    expect(TEST_ACCOUNT_ID).toBe('337c8a0a2e66c1e6');
    expect(TEST_ACCOUNT_ID).toBe(hex.slice(0, 16));
  });

  test('CLOSE_CODES names 4403, 4409 and 4426', () => {
    expect(CLOSE_CODES).toEqual({ refused: 4403, replaced: 4409, incompatible: 4426 });
  });
});

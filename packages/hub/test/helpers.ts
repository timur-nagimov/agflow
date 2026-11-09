import type { Agent, AgentRole, Attempt, LeadNote, RunnerCommandKind, RunnerVendor, Task, Vendor } from '@agflow/core';
import {
  AGFLOW_VERSION,
  type NewTask,
  type NewTaskInput,
  NewTaskSchema,
  TEST_ACCOUNT_ID,
  attemptId,
  leadAttemptId,
  taskBranchName,
  wipRef,
} from '@agflow/core';
import { getAgent, startLiveSession } from '../src/agents';
import { insertAttempt, issueFence, nextAttemptNumber } from '../src/attempt-store';
import type { StoredCommand } from '../src/commands';
import { type FetchFn, HUB_RUNNER_DEFAULTS, type HubConfig, type HubContext, createContext, tx } from '../src/context';
import { nextId } from '../src/db';
import { takeSeat, updateHubState } from '../src/hub-state';
import { getTask, move, setAgentTask } from '../src/task-store';
import { createTasks } from '../src/tasks';

export class TestClock {
  t = Date.UTC(2026, 9, 26, 12, 0, 0);
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

/**
 * The hub ticked all along while the test clock jumped ahead: the next clock check finds no downtime and opens no
 * recovery window (design 6.14). Tests that skip minutes before a tick call it, as the scheduler's timer would have
 * ticked every tickMs meanwhile.
 */
export function markHubAlive(ctx: HubContext): void {
  updateHubState(ctx, { lastAliveAt: ctx.now() });
}

export function makeConfig(overrides: Partial<HubConfig> = {}): HubConfig {
  return {
    ...HUB_RUNNER_DEFAULTS,
    publicUrl: 'http://hub.test',
    auth: 'dev',
    allowedUsers: ['alice', 'bob'],
    projectName: 'demo',
    projectRepo: 'https://github.com/acme/demo',
    leaseMs: 2 * 60 * 60_000,
    reminderMs: 30 * 60_000,
    maxOpenTasks: 200,
    maxTasksPerHour: 60,
    secureCookies: false,
    ...overrides,
  };
}

export function createTestContext(
  overrides: Partial<HubConfig> = {},
  fetchFn?: FetchFn,
): { ctx: HubContext; clock: TestClock } {
  const clock = new TestClock();
  const ctx = createContext({ dbPath: ':memory:', config: makeConfig(overrides), now: clock.now, fetch: fetchFn });
  return { ctx, clock };
}

export function newTask(overrides: Partial<NewTaskInput> = {}): NewTask {
  return NewTaskSchema.parse({
    title: 'Do the thing',
    objective: 'Make the thing work',
    acceptance: [{ id: 'A1', assertion: 'The thing works' }],
    ...overrides,
  });
}

let sessionCounter = 0;

/** Registers a live agent the way the SessionStart hook does. */
export function addAgent(ctx: HubContext, user = 'alice', role: AgentRole = 'worker', vendor: Vendor = 'claude'): Agent {
  sessionCounter += 1;
  return startLiveSession(ctx, user, { vendor, sessionId: `session-${sessionCounter}`, role }).agent;
}

export interface RunnerAttemptOptions {
  /** A ready task; by default a new one. */
  taskId?: string | undefined;
  /** A runner made by an earlier call; by default a new one. */
  runnerId?: string | undefined;
  owner?: string | undefined;
  vendor?: Vendor | undefined;
}

export interface RunnerAttempt {
  runner: { id: string };
  agent: Agent;
  attempt: Attempt;
  task: Task;
}

/** A ready vendor on a runner in test mode (design 15.1). */
export function testVendor(vendor: Vendor): RunnerVendor {
  return {
    vendor,
    cliVersion: null,
    ownerCliVersion: null,
    ready: true,
    problem: 'test mode',
    accountId: TEST_ACCOUNT_ID,
    plan: 'test mode',
    managedPolicy: false,
    models:
      vendor === 'claude'
        ? { lead: 'claude-opus-5-5', worker: 'claude-sonnet-5-5' }
        : { lead: 'gpt-6.1-sol', worker: 'gpt-6.1-sol' },
    ceilings: { fiveHour: 0.85, weekly: 0.85 },
    allowPaidUsage: false,
    degraded: false,
    preflightAt: null,
  };
}

/** An online runner of the owner's, offering the vendors in test mode, with room for two attempts; returns its id. */
export function addRunner(ctx: HubContext, options: { owner?: string; vendors?: Vendor[] } = {}): string {
  const owner = options.owner ?? 'alice';
  const now = ctx.now();
  const seq = nextId(ctx.db, 'runner');
  const runnerId = `R-${seq}`;
  const info = {
    agflowVersion: AGFLOW_VERSION,
    platform: 'darwin-arm64',
    vendors: (options.vendors ?? ['claude']).map(testVendor),
    profile: { name: 'standard', weakened: [], dependencyPrep: true },
    git: { ready: true, problem: null, lastPushAt: null },
    power: { source: 'ac', batteryPercent: null, lowPowerMode: false },
    disk: { freeBytes: 100e9, agflowBytes: 0 },
    ceilings: {},
    allowPaidUsage: {},
  };
  ctx.db
    .query(
      `INSERT INTO runners (id, seq, runner_key, machine_id, owner, name, state, capacity, protocol, info,
         last_seen_at, created_at)
       VALUES ($id, $seq, $key, $machine, $owner, $name, 'online', 2, 1, $info, $now, $now)`,
    )
    .run({
      id: runnerId,
      seq,
      key: `runner-key-${seq}`,
      machine: `machine-${seq}`,
      owner,
      name: `${owner}-laptop-${seq}`,
      info: JSON.stringify(info),
      now,
    });
  return runnerId;
}

/**
 * A runner worker holding a task as if its runner had reported attempt.spawned: an online runner, its agent, and a
 * running attempt with a fence and a runner lease that is the task's current attempt. It mints no agent token and
 * queues no start_attempt command (the scheduler's path does both). The task is claimed with no M1 lease.
 */
export function addRunnerAttempt(ctx: HubContext, options: RunnerAttemptOptions = {}): RunnerAttempt {
  const owner = options.owner ?? 'alice';
  const vendor = options.vendor ?? 'claude';
  const taskId = options.taskId ?? createTasks(ctx, [newTask()], `user:${owner}`)[0]?.id;
  if (!taskId) throw new Error('no task to attempt');
  return tx(ctx, (emit) => {
    const now = ctx.now();
    const runnerId = options.runnerId ?? addRunner(ctx, { owner, vendors: [vendor] });
    const agentSeq = nextId(ctx.db, 'agent');
    const agentId = `A-${agentSeq}`;
    const number = nextAttemptNumber(ctx, taskId);
    const fence = issueFence(ctx);
    const id = attemptId(taskId, number, fence.epoch);
    ctx.db
      .query(
        `INSERT INTO agents (id, seq, login, vendor, role, origin, label, current_task, last_seen_at, created_at,
           runner_id, attempt_id)
         VALUES ($id, $seq, $owner, $vendor, 'worker', 'runner', $label, NULL, $now, $now, $runnerId, $attemptId)`,
      )
      .run({ id: agentId, seq: agentSeq, owner, vendor, label: id, now, runnerId, attemptId: id });
    const attempt = insertAttempt(ctx, {
      id,
      taskId,
      number,
      role: 'worker',
      agentId,
      runnerId,
      vendor,
      fence,
      status: 'running',
      wipRef: wipRef(ctx.config.wipRefPrefix, id),
      leaseExpiresAt: now + ctx.config.runnerLeaseMs,
    });
    const task = getTask(ctx, taskId);
    const claimed = move(ctx, emit, task, 'claimed', `agent:${agentId}`, {
      changes: { assignee: agentId, branch: task.branch ?? taskBranchName(taskId, task.title, fence.epoch) },
    });
    setAgentTask(ctx, agentId, taskId);
    return { runner: { id: runnerId }, agent: getAgent(ctx, agentId), attempt, task: claimed };
  });
}

/**
 * A runner lead holding the seat, as the scheduler starts one: an agent and a running lead attempt on a new runner of
 * alice's (made with a worker attempt of its own); lead attempts number from 1 per hub.
 */
export function addRunnerLead(ctx: HubContext): { agent: Agent; attempt: Attempt } {
  const { runner } = addRunnerAttempt(ctx);
  return tx(ctx, (emit) => {
    const seq = nextId(ctx.db, 'agent');
    const agentId = `A-${seq}`;
    const number = nextAttemptNumber(ctx, null);
    const fence = issueFence(ctx);
    const id = leadAttemptId(number, fence.epoch);
    ctx.db
      .query(
        `INSERT INTO agents (id, seq, login, vendor, role, origin, label, current_task, last_seen_at, created_at,
           runner_id, attempt_id)
         VALUES ($id, $seq, 'alice', 'claude', 'lead', 'runner', $label, NULL, $now, $now, $runnerId, $attemptId)`,
      )
      .run({ id: agentId, seq, label: id, now: ctx.now(), runnerId: runner.id, attemptId: id });
    const attempt = insertAttempt(ctx, {
      id,
      taskId: null,
      number,
      role: 'lead',
      agentId,
      runnerId: runner.id,
      vendor: 'claude',
      fence,
      status: 'running',
      leaseExpiresAt: ctx.now() + ctx.config.runnerLeaseMs,
    });
    takeSeat(ctx, emit, agentId, 'runner', 'system');
    return { agent: getAgent(ctx, agentId), attempt };
  });
}

/** A lead_notes row, as POST /api/lead/handoff or the hub's failover stores one, written now. */
export function addLeadNote(
  ctx: HubContext,
  note: { body: string; author: string; attemptId: string | null; kind?: LeadNote['kind'] },
): void {
  ctx.db
    .query(
      `INSERT INTO lead_notes (attempt_id, kind, body, author, created_at)
       VALUES ($attemptId, $kind, $body, $author, $now)`,
    )
    .run({ attemptId: note.attemptId, kind: note.kind ?? 'handoff', body: note.body, author: note.author, now: ctx.now() });
}

/** One tokenless command of each kind for the attempt; the mapped type makes the compiler insist on all 17. */
export function sampleCommands(attempt: Attempt): { [K in RunnerCommandKind]: Extract<StoredCommand, { kind: K }> } {
  const { id: attemptId, fence } = attempt;
  const restore = { paths: ['.claude/**'], base: 'refs/heads/main' };
  return {
    start_attempt: {
      kind: 'start_attempt',
      attempt: {
        attemptId,
        taskId: attempt.taskId,
        role: 'worker',
        vendor: 'claude',
        model: null,
        fence,
        hubUrl: 'http://hub.test',
        repo: { url: 'https://github.com/acme/demo', mainBranch: 'main' },
        start: { ref: 'refs/heads/main', sha: null },
        branch: 'agflow/T-1-do-the-thing',
        wipRef: 'refs/agflow/T-1/a1',
        restore,
        acceptanceIds: ['A1'],
        toolCaps: { defaultMs: 1_800_000, longMs: 5_400_000, checks: [] },
        taskPack: '# T-1',
        brief: 'You are an agflow worker.',
        firstPrompt: 'Start.',
        successor: false,
      },
    },
    resume_attempt: {
      kind: 'resume_attempt',
      attemptId,
      fence,
      prompt: 'The runner restarted; continue from your last step.',
      messages: [{ messageId: 4, authority: 'person', text: '> alice: also add a test' }],
      taskPack: null,
      restore,
      acceptanceIds: ['A1'],
    },
    deliver: { kind: 'deliver', attemptId, fence, messages: [], more: 0 },
    interrupt: { kind: 'interrupt', attemptId, fence },
    stop_attempt: {
      kind: 'stop_attempt',
      attemptId,
      fence,
      cause: 'stop',
      reason: 'a person stopped it',
      handoff: true,
      interruptFirst: false,
      keepClone: false,
    },
    hold_attempt: { kind: 'hold_attempt', attemptId, fence },
    push_submission: {
      kind: 'push_submission',
      attemptId,
      fence,
      submissionId: 'S-1',
      branch: 'agflow/T-1-do-the-thing',
      expectedBranchSha: null,
      adoptable: [],
    },
    prepare_takeover: { kind: 'prepare_takeover', attemptId, fence, person: 'alice' },
    hand_back: { kind: 'hand_back', attemptId, source: { kind: 'clone' } },
    cleanup_attempt: { kind: 'cleanup_attempt', attemptId },
    decide_approval: {
      kind: 'decide_approval',
      attemptId,
      fence,
      approvalId: '6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f',
      decision: 'approve',
      reason: null,
    },
    upload_transcript: { kind: 'upload_transcript', attemptId },
    prepare_dependencies: { kind: 'prepare_dependencies', attemptId, fence, requestId: '1-R-1-9' },
    refresh_vault: { kind: 'refresh_vault', taskId: attempt.taskId ?? 'T-1', refs: ['refs/agflow/T-1/a1-late-1'] },
    preflight: { kind: 'preflight', vendor: 'codex' },
    delete_refs: { kind: 'delete_refs', refs: [{ ref: 'refs/agflow/T-1/a1', expectedSha: 'c'.repeat(40) }] },
    update_settings: { kind: 'update_settings', settings: { capacity: 3 }, version: 2 },
  };
}

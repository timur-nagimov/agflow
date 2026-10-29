import type { Agent, AgentRole, Attempt, RunnerVendor, Task, Vendor } from '@agflow/core';
import {
  AGFLOW_VERSION,
  type NewTask,
  type NewTaskInput,
  NewTaskSchema,
  TEST_ACCOUNT_ID,
  attemptId,
  taskBranchName,
  wipRef,
} from '@agflow/core';
import { getAgent, startLiveSession } from '../src/agents';
import { insertAttempt, issueFence, nextAttemptNumber } from '../src/attempt-store';
import { type FetchFn, HUB_RUNNER_DEFAULTS, type HubConfig, type HubContext, createContext, tx } from '../src/context';
import { nextId } from '../src/db';
import { getTask, move, setAgentTask } from '../src/task-store';
import { createTasks } from '../src/tasks';

export class TestClock {
  t = Date.UTC(2026, 9, 26, 12, 0, 0);
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
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
function testVendor(vendor: Vendor): RunnerVendor {
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
    let runnerId = options.runnerId;
    if (!runnerId) {
      const seq = nextId(ctx.db, 'runner');
      runnerId = `R-${seq}`;
      const info = {
        agflowVersion: AGFLOW_VERSION,
        platform: 'darwin-arm64',
        vendors: [testVendor(vendor)],
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
    }
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

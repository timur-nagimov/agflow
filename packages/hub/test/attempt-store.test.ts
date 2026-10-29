import { describe, expect, test } from 'bun:test';
import {
  type AgentStatus,
  type AttemptFacts,
  AttemptSchema,
  type AttemptStatus,
  TEST_ACCOUNT_ID,
  attemptId,
  leadAttemptId,
} from '@agflow/core';
import { getAgent, listAgents } from '../src/agents';
import {
  type AttemptChanges,
  appendAttemptLog,
  attemptLog,
  attemptSubject,
  findAttempt,
  getAttempt,
  insertAttempt,
  issueFence,
  listAttempts,
  nextAttemptNumber,
  openAttemptOf,
  updateAttempt,
} from '../src/attempt-store';
import { HubError } from '../src/errors';
import { search } from '../src/search';
import { claimTask, createTasks, getTask, getTaskDetail } from '../src/tasks';
import { addAgent, addRunnerAttempt, createTestContext, newTask } from './helpers';

type Ctx = ReturnType<typeof createTestContext>['ctx'];

/** A live chat's attempt on the task, as a live claim records it. */
function liveAttempt(ctx: Ctx, taskId: string, status: AttemptStatus = 'running') {
  const agent = addAgent(ctx);
  const number = nextAttemptNumber(ctx, taskId);
  const fence = issueFence(ctx);
  return insertAttempt(ctx, {
    id: attemptId(taskId, number, fence.epoch),
    taskId,
    number,
    role: 'worker',
    agentId: agent.id,
    runnerId: null,
    vendor: 'claude',
    fence,
    status,
  });
}

function leadAttempt(ctx: Ctx, runnerId: string | null = null, status: AttemptStatus = 'running') {
  const number = nextAttemptNumber(ctx, null);
  const fence = issueFence(ctx);
  return insertAttempt(ctx, {
    id: leadAttemptId(number, fence.epoch),
    taskId: null,
    number,
    role: 'lead',
    agentId: 'A-99',
    runnerId,
    vendor: 'codex',
    fence,
    status,
  });
}

describe('attempt rows', () => {
  test('a new attempt starts with its fence and empty facts, and becomes the task current attempt', () => {
    const { ctx } = createTestContext();
    const [task] = createTasks(ctx, [newTask()], 'user:alice');
    const attempt = liveAttempt(ctx, task.id);
    expect(attempt).toEqual({
      id: 'T-1-a1',
      taskId: 'T-1',
      number: 1,
      role: 'worker',
      agentId: attempt.agentId,
      runnerId: null,
      vendor: 'claude',
      model: null,
      sessionRef: null,
      fence: { epoch: 1, counter: 1 },
      status: 'running',
      endReason: null,
      failureClass: null,
      failureSignature: null,
      startRef: null,
      startSha: null,
      wipRef: null,
      wipSha: null,
      submittedSha: null,
      resumable: true,
      reviewRounds: 0,
      wakeups: 0,
      activeMs: 0,
      phase: null,
      facts: null,
      stopRequested: null,
      takeover: null,
      leaseExpiresAt: null,
      quotaResetsAt: null,
      startedAt: ctx.now(),
      endedAt: null,
      lastActivityAt: ctx.now(),
    });
    expect(AttemptSchema.parse(attempt)).toEqual(attempt);
    expect(getTask(ctx, task.id).currentAttempt).toBe('T-1-a1');
  });

  test('a row maps to an Attempt with its facts, stop request and take-over parsed', () => {
    const { ctx, clock } = createTestContext();
    const { attempt } = addRunnerAttempt(ctx);
    const facts: AttemptFacts = {
      attemptId: attempt.id,
      fence: attempt.fence,
      phase: 'turn',
      eventAgeMs: 2_000,
      tool: { name: 'Bash', command: 'bun test', long: true, capMs: 90 * 60_000, ageMs: 30_000 },
      fsAgeMs: 10_000,
      commitAgeMs: null,
      turns: 3,
      turnsWithoutProgress: 0,
      repeatedCalls: 1,
      continuations: 0,
      vendorErrorMs: 0,
      activeMs: 60_000,
      contextUsed: 0.2,
    };
    clock.advance(5_000);
    const stopRequested = {
      cause: 'stop' as const,
      reason: 'enough',
      by: 'user:alice',
      handoff: true,
      deferred: false,
      at: ctx.now(),
    };
    const takeover = {
      local: 'cd /work && git switch agflow/T-1-do-the-thing',
      anywhere: 'git fetch origin refs/agflow/T-1/takeover-alice',
      ref: 'refs/agflow/T-1/takeover-alice',
      error: null,
    };
    updateAttempt(ctx, attempt.id, {
      model: 'claude-sonnet-5-5',
      sessionRef: 'session-1',
      phase: 'turn',
      facts,
      factsAt: ctx.now(),
      stopRequested,
      takeover,
      wipSha: 'f'.repeat(40),
      resumable: false,
      activeMs: 60_000,
      lastActivityAt: ctx.now(),
    });
    const read = getAttempt(ctx, attempt.id);
    expect(read).toMatchObject({
      model: 'claude-sonnet-5-5',
      sessionRef: 'session-1',
      phase: 'turn',
      facts,
      stopRequested,
      takeover,
      wipSha: 'f'.repeat(40),
      resumable: false,
      activeMs: 60_000,
      lastActivityAt: ctx.now(),
    });
    expect(AttemptSchema.parse(read)).toEqual(read);
    // Null clears a field; one left out keeps its value.
    updateAttempt(ctx, attempt.id, { stopRequested: null, fence: { epoch: 1, counter: 9 } });
    expect(getAttempt(ctx, attempt.id)).toMatchObject({ stopRequested: null, takeover, fence: { epoch: 1, counter: 9 } });
  });

  test('insertAttempt stores the start position, the WIP ref and the lease', () => {
    const { ctx } = createTestContext();
    const [task] = createTasks(ctx, [newTask()], 'user:alice');
    const fence = issueFence(ctx);
    const attempt = insertAttempt(ctx, {
      id: attemptId(task.id, 1, fence.epoch),
      taskId: task.id,
      number: 1,
      role: 'worker',
      agentId: 'A-3',
      runnerId: 'R-2',
      vendor: 'codex',
      fence,
      status: 'starting',
      startRef: 'refs/agflow/T-1/a0',
      startSha: 'a'.repeat(40),
      wipRef: 'refs/agflow/T-1/a1',
      leaseExpiresAt: 1_234,
    });
    expect(ctx.db.query('SELECT * FROM attempts WHERE id = $id').get({ id: attempt.id })).toMatchObject({
      task_id: task.id,
      number: 1,
      role: 'worker',
      agent_id: 'A-3',
      runner_id: 'R-2',
      vendor: 'codex',
      fence_epoch: 1,
      fence_counter: 1,
      status: 'starting',
      start_ref: 'refs/agflow/T-1/a0',
      start_sha: 'a'.repeat(40),
      wip_ref: 'refs/agflow/T-1/a1',
      lease_expires_at: 1_234,
      started_at: ctx.now(),
      last_activity_at: ctx.now(),
    });
  });

  test('updateAttempt writes every field to its own column', () => {
    const { ctx } = createTestContext();
    const { attempt } = addRunnerAttempt(ctx);
    const facts: AttemptFacts = {
      attemptId: attempt.id,
      fence: attempt.fence,
      phase: 'idle',
      eventAgeMs: 1,
      tool: null,
      fsAgeMs: null,
      commitAgeMs: null,
      turns: 2,
      turnsWithoutProgress: 0,
      repeatedCalls: 0,
      continuations: 0,
      vendorErrorMs: 0,
      activeMs: 5,
      contextUsed: null,
    };
    // Typed Required, so a new field must be added here too.
    const changes: Required<AttemptChanges> = {
      model: 'gpt-6.1-sol',
      sessionRef: 'session-9',
      fence: { epoch: 1, counter: 77 },
      status: 'ended',
      endReason: 'stalled',
      failureClass: 'agent',
      failureSignature: 'sig-1',
      startRef: 'refs/heads/main',
      startSha: '1'.repeat(40),
      wipRef: 'refs/agflow/T-1/a1-x',
      wipSha: '2'.repeat(40),
      submittedSha: '3'.repeat(40),
      resumable: false,
      reviewRounds: 4,
      wakeups: 5,
      activeMs: 6,
      resumeLog: [{ at: 7, cause: 'runner_restart' }],
      phase: 'idle',
      facts,
      factsAt: 8,
      stopRequested: { cause: 'cancel', reason: 'r', by: 'user:bob', handoff: false, deferred: true, at: 9 },
      takeover: { local: 'l', anywhere: 'a', ref: 'refs/agflow/T-1/takeover-bob', error: 'e' },
      finalSha: '4'.repeat(40),
      compactionSummary: 'compacted',
      transcriptTail: 'tail',
      leaseExpiresAt: 10,
      quotaResetsAt: 11,
      endedAt: 12,
      lastActivityAt: 13,
    };
    updateAttempt(ctx, attempt.id, changes);
    expect(ctx.db.query('SELECT * FROM attempts WHERE id = $id').get({ id: attempt.id })).toMatchObject({
      model: 'gpt-6.1-sol',
      session_ref: 'session-9',
      fence_epoch: 1,
      fence_counter: 77,
      status: 'ended',
      end_reason: 'stalled',
      failure_class: 'agent',
      failure_signature: 'sig-1',
      start_ref: 'refs/heads/main',
      start_sha: '1'.repeat(40),
      wip_ref: 'refs/agflow/T-1/a1-x',
      wip_sha: '2'.repeat(40),
      submitted_sha: '3'.repeat(40),
      resumable: 0,
      review_rounds: 4,
      wakeups: 5,
      active_ms: 6,
      resume_log: JSON.stringify(changes.resumeLog),
      phase: 'idle',
      facts: JSON.stringify(facts),
      facts_at: 8,
      stop_requested: JSON.stringify(changes.stopRequested),
      takeover: JSON.stringify(changes.takeover),
      final_sha: '4'.repeat(40),
      compaction_summary: 'compacted',
      transcript_tail: 'tail',
      lease_expires_at: 10,
      quota_resets_at: 11,
      ended_at: 12,
      last_activity_at: 13,
    });
  });

  test('findAttempt answers null and getAttempt 404 for an unknown id', () => {
    const { ctx } = createTestContext();
    expect(findAttempt(ctx, 'T-9-a1')).toBeNull();
    expect(() => getAttempt(ctx, 'T-9-a1')).toThrow(HubError);
    expect(() => getAttempt(ctx, 'T-9-a1')).toThrow('attempt T-9-a1 not found');
  });
});

describe('fences and numbers', () => {
  test('a fence carries the hub epoch and a counter that only grows', () => {
    const { ctx } = createTestContext();
    expect(issueFence(ctx)).toEqual({ epoch: 1, counter: 1 });
    expect(issueFence(ctx)).toEqual({ epoch: 1, counter: 2 });
    ctx.db.run('UPDATE project SET epoch = 2');
    expect(issueFence(ctx)).toEqual({ epoch: 2, counter: 3 });
  });

  test('task attempts are numbered per task; lead attempts by the lead seat counter', () => {
    const { ctx } = createTestContext();
    const [a, b] = createTasks(ctx, [newTask(), newTask()], 'user:alice');
    expect(nextAttemptNumber(ctx, a.id)).toBe(1);
    liveAttempt(ctx, a.id, 'ended');
    liveAttempt(ctx, a.id, 'ended');
    expect(nextAttemptNumber(ctx, a.id)).toBe(3);
    expect(nextAttemptNumber(ctx, b.id)).toBe(1);
    expect(leadAttempt(ctx).id).toBe('lead-a1');
    ctx.db.run('UPDATE project SET epoch = 2');
    expect(leadAttempt(ctx).id).toBe('lead-e2-a2');
    expect(liveAttempt(ctx, b.id).id).toBe('T-2-e2-a1');
  });

  test('openAttemptOf names the task attempt that has not ended', () => {
    const { ctx } = createTestContext();
    const [task] = createTasks(ctx, [newTask()], 'user:alice');
    expect(openAttemptOf(ctx, task.id)).toBeNull();
    const first = liveAttempt(ctx, task.id);
    expect(openAttemptOf(ctx, task.id)?.id).toBe(first.id);
    updateAttempt(ctx, first.id, { status: 'ended', endReason: 'released', endedAt: ctx.now() });
    expect(openAttemptOf(ctx, task.id)).toBeNull();
    // The schema keeps a task to one open attempt.
    const second = liveAttempt(ctx, task.id, 'holding');
    expect(() => liveAttempt(ctx, task.id)).toThrow('UNIQUE');
    expect(openAttemptOf(ctx, task.id)?.id).toBe(second.id);
  });
});

describe('listAttempts', () => {
  test('filters by task, role, status and runner, newest first', () => {
    const { ctx, clock } = createTestContext();
    const first = addRunnerAttempt(ctx);
    clock.advance(1_000);
    const second = addRunnerAttempt(ctx, { runnerId: first.runner.id });
    clock.advance(1_000);
    const other = addRunnerAttempt(ctx, { owner: 'bob' });
    clock.advance(1_000);
    const lead = leadAttempt(ctx, other.runner.id, 'holding');
    clock.advance(1_000);
    const live = liveAttempt(ctx, createTasks(ctx, [newTask()], 'user:alice')[0].id, 'quota_wait');
    const ids = (filter: Parameters<typeof listAttempts>[1]) => listAttempts(ctx, filter).map((attempt) => attempt.id);
    expect(ids({})).toEqual([live.id, lead.id, other.attempt.id, second.attempt.id, first.attempt.id]);
    expect(ids({ task: second.task.id })).toEqual([second.attempt.id]);
    expect(ids({ role: 'lead' })).toEqual([lead.id]);
    expect(ids({ status: ['holding', 'quota_wait'] })).toEqual([live.id, lead.id]);
    expect(ids({ runner: first.runner.id })).toEqual([second.attempt.id, first.attempt.id]);
    expect(ids({ runner: other.runner.id, role: 'worker' })).toEqual([other.attempt.id]);
    expect(ids({ limit: 2 })).toEqual([live.id, lead.id]);
  });

  test('attempts that start in the same millisecond keep the order they were created in', () => {
    const { ctx } = createTestContext();
    const first = leadAttempt(ctx);
    const second = leadAttempt(ctx);
    expect(listAttempts(ctx).map((attempt) => attempt.id)).toEqual([second.id, first.id]);
  });
});

describe('the attempt log', () => {
  test('entries come back oldest first, and each attempt keeps its newest 500', () => {
    const { ctx, clock } = createTestContext();
    const { attempt } = addRunnerAttempt(ctx);
    const other = leadAttempt(ctx);
    appendAttemptLog(ctx, other.id, 'note', 'kept');
    for (let n = 1; n <= 503; n++) {
      appendAttemptLog(ctx, attempt.id, 'tool', `entry ${n}`);
      clock.advance(1);
    }
    const log = attemptLog(ctx, attempt.id);
    expect(log).toHaveLength(500);
    expect(log[0]).toMatchObject({ attemptId: attempt.id, kind: 'tool', summary: 'entry 4' });
    expect(log.at(-1)?.summary).toBe('entry 503');
    expect(log.at(-1)?.ts).toBe(ctx.now() - 1);
    expect(attemptLog(ctx, other.id).map((entry) => entry.summary)).toEqual(['kept']);
  });

  test('a long summary is clipped', () => {
    const { ctx } = createTestContext();
    const attempt = leadAttempt(ctx);
    appendAttemptLog(ctx, attempt.id, 'text', 'x'.repeat(5_000));
    expect(attemptLog(ctx, attempt.id)[0]?.summary).toHaveLength(2_000);
  });
});

describe('runner agents', () => {
  test('a runner agent is active while starting or running, idle in quota_wait or holding, gone once ended', () => {
    const { ctx, clock } = createTestContext();
    const { agent, attempt } = addRunnerAttempt(ctx);
    // A runner agent's own last_seen_at does not decide: a laptop asleep for hours still holds its attempt.
    clock.advance(3 * 60 * 60_000);
    const expected: [AttemptStatus, AgentStatus][] = [
      ['starting', 'active'],
      ['running', 'active'],
      ['quota_wait', 'idle'],
      ['holding', 'idle'],
      ['ended', 'gone'],
    ];
    for (const [status, agentStatus] of expected) {
      updateAttempt(ctx, attempt.id, { status });
      expect([status, getAgent(ctx, agent.id).status]).toEqual([status, agentStatus]);
      // The list reads the same join.
      expect([status, listAgents(ctx).find((entry) => entry.id === agent.id)?.status]).toEqual([status, agentStatus]);
    }
  });

  test('live agents keep the M1 rule', () => {
    const { ctx, clock } = createTestContext();
    const live = addAgent(ctx);
    const [task] = createTasks(ctx, [newTask()], 'user:alice');
    claimTask(ctx, task.id, live);
    expect(getAgent(ctx, live.id).status).toBe('active');
    clock.advance(3 * 60 * 60_000);
    expect(getAgent(ctx, live.id).status).toBe('gone');
  });
});

describe('attempt counts and subjects', () => {
  test('attemptCount counts every attempt of the task, runner and live alike', () => {
    const { ctx } = createTestContext();
    const { task, attempt } = addRunnerAttempt(ctx);
    expect(getTask(ctx, task.id).attemptCount).toBe(1);
    updateAttempt(ctx, attempt.id, { status: 'ended', endReason: 'crashed', failureClass: 'infra', endedAt: ctx.now() });
    liveAttempt(ctx, task.id);
    expect(getTask(ctx, task.id).attemptCount).toBe(2);
    expect(getTask(ctx, task.id).currentAttempt).toBe('T-1-a2');
    expect(search(ctx, task.id).tasks[0]?.attemptCount).toBe(2);
    const [fresh] = createTasks(ctx, [newTask()], 'user:alice');
    expect(fresh.attemptCount).toBe(0);
  });

  test("an attempt's events take the task id as subject, or the attempt id for a lead attempt", () => {
    const { ctx } = createTestContext();
    const { attempt } = addRunnerAttempt(ctx);
    expect(attemptSubject(attempt)).toBe('T-1');
    expect(attemptSubject(leadAttempt(ctx))).toBe('lead-a1');
  });

  test('the task detail lists its attempts newest first', () => {
    const { ctx, clock } = createTestContext();
    const { task, attempt } = addRunnerAttempt(ctx);
    updateAttempt(ctx, attempt.id, { status: 'ended', endReason: 'stalled', failureClass: 'agent', endedAt: ctx.now() });
    clock.advance(1_000);
    const next = liveAttempt(ctx, task.id);
    expect(getTaskDetail(ctx, task.id).attempts.map((entry) => entry.id)).toEqual([next.id, attempt.id]);
  });
});

describe('addRunnerAttempt', () => {
  test('creates a runner, its agent and a running attempt that holds the task', () => {
    const { ctx } = createTestContext();
    const { runner, agent, attempt, task } = addRunnerAttempt(ctx, { owner: 'bob', vendor: 'codex' });
    expect(runner.id).toBe('R-1');
    expect(ctx.db.query('SELECT owner, state, capacity FROM runners WHERE id = $id').get({ id: runner.id })).toEqual({
      owner: 'bob',
      state: 'online',
      capacity: 2,
    });
    const info = JSON.parse((ctx.db.query('SELECT info FROM runners').get() as { info: string }).info);
    expect(info.vendors).toEqual([expect.objectContaining({ vendor: 'codex', ready: true, accountId: TEST_ACCOUNT_ID })]);
    expect(agent).toMatchObject({
      user: 'bob',
      vendor: 'codex',
      role: 'worker',
      origin: 'runner',
      runnerId: runner.id,
      attemptId: attempt.id,
      currentTask: task.id,
      status: 'active',
    });
    expect(attempt).toMatchObject({
      id: 'T-1-a1',
      taskId: task.id,
      agentId: agent.id,
      runnerId: runner.id,
      vendor: 'codex',
      status: 'running',
      wipRef: 'refs/agflow/T-1/a1',
      leaseExpiresAt: ctx.now() + ctx.config.runnerLeaseMs,
    });
    expect(task).toMatchObject({
      status: 'claimed',
      assignee: agent.id,
      currentAttempt: attempt.id,
      branch: 'agflow/T-1-do-the-thing',
      // The runner lease is on the attempt; the M1 task lease stays empty for runner attempts.
      leaseExpiresAt: null,
      attemptCount: 1,
    });
  });

  test('takes an existing task and runner', () => {
    const { ctx } = createTestContext();
    const [a, b] = createTasks(ctx, [newTask({ title: 'A' }), newTask({ title: 'B' })], 'user:alice');
    const first = addRunnerAttempt(ctx, { taskId: b.id });
    const second = addRunnerAttempt(ctx, { taskId: a.id, runnerId: first.runner.id });
    expect(first.task.id).toBe(b.id);
    expect(second.runner.id).toBe(first.runner.id);
    expect(second.attempt).toMatchObject({ id: 'T-1-a1', runnerId: first.runner.id });
    expect((ctx.db.query('SELECT COUNT(*) AS n FROM runners').get() as { n: number }).n).toBe(1);
  });
});

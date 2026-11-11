import { describe, expect, test } from 'bun:test';
import {
  AttemptSpecSchema,
  RunnerCommandSchema,
  computeToolCaps,
  restoreSet,
  taskBranchName,
} from '@agflow/core';
import { getAgent } from '../src/agents';
import { findAttempt, listAttempts, updateAttempt } from '../src/attempt-store';
import { startPositionFor, startRunnerAttempt } from '../src/attempts';
import { resolveAgentToken } from '../src/auth';
import { buildBrief, composeTaskPack, firstPrompt } from '../src/brief';
import { pendingCommands, toWireCommand } from '../src/commands';
import { tx } from '../src/context';
import { listEvents } from '../src/events';
import { getHubState } from '../src/hub-state';
import { getTask, move, writeTask } from '../src/task-store';
import { createTasks } from '../src/tasks';
import { addAgent, addRunner, createTestContext, newTask } from './helpers';

type Ctx = ReturnType<typeof createTestContext>['ctx'];

function setup() {
  const { ctx, clock } = createTestContext();
  const runnerId = addRunner(ctx, { owner: 'bob', vendors: ['claude', 'codex'] });
  const [task] = createTasks(
    ctx,
    [
      newTask({
        title: 'Fix the parser',
        acceptance: [
          { id: 'A1', assertion: 'Nested lists parse.' },
          { id: 'A2', assertion: 'Docs mention nesting.' },
        ],
        checks: [{ name: 'unit', cmd: 'bun test', timeoutS: 7200 }],
      }),
    ],
    'user:alice',
  );
  if (!task) throw new Error('no task');
  return { ctx, clock, runnerId, task };
}

const counts = (ctx: Ctx) =>
  ctx.db
    .query(
      `SELECT (SELECT COUNT(*) FROM agents) AS agents, (SELECT COUNT(*) FROM attempts) AS attempts,
         (SELECT COUNT(*) FROM runner_commands) AS commands, (SELECT COUNT(*) FROM events) AS events`,
    )
    .get();

const branchHead = (ctx: Ctx, id: string) =>
  (ctx.db.query('SELECT branch_head FROM tasks WHERE id = $id').get({ id }) as { branch_head: string | null }).branch_head;

describe('starting a runner attempt', () => {
  test('creates the agent, the attempt, the claim and start_attempt in one transaction, and emits attempt.started', () => {
    const { ctx, runnerId, task } = setup();
    const { attempt, agent, command } = startRunnerAttempt(ctx, { runnerId, taskId: task.id, role: 'worker', vendor: 'codex' });
    expect(agent).toMatchObject({
      user: 'bob',
      vendor: 'codex',
      role: 'worker',
      origin: 'runner',
      runnerId,
      attemptId: attempt.id,
      currentTask: task.id,
      label: attempt.id,
      status: 'active',
    });
    expect(attempt).toMatchObject({
      id: `${task.id}-a1`,
      taskId: task.id,
      number: 1,
      role: 'worker',
      agentId: agent.id,
      runnerId,
      vendor: 'codex',
      status: 'starting',
      leaseExpiresAt: ctx.now() + ctx.config.runnerLeaseMs,
    });
    expect(attempt.fence).toEqual({ epoch: 1, counter: expect.any(Number) });
    expect(getTask(ctx, task.id)).toMatchObject({
      status: 'claimed',
      assignee: agent.id,
      currentAttempt: attempt.id,
      branch: taskBranchName(task.id, task.title, 1),
      // Runner attempts hold a runner lease, never M1's task lease.
      leaseExpiresAt: null,
    });
    expect(command).toMatchObject({ runnerId, kind: 'start_attempt', attemptId: attempt.id, fence: attempt.fence });
    expect(pendingCommands(ctx, runnerId, 1).map((row) => row.id)).toEqual([command.id]);
    const started = listEvents(ctx.db).filter((event) => event.type === 'attempt.started');
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      actor: 'system',
      subject: task.id,
      data: { attemptId: attempt.id, taskId: task.id, agentId: agent.id, runnerId, vendor: 'codex', role: 'worker' },
    });
    const claimed = listEvents(ctx.db).filter((event) => event.type === 'task.claimed');
    expect(claimed.map((event) => [event.subject, event.data])).toEqual([
      [task.id, { from: 'ready', assignee: agent.id, attemptId: attempt.id }],
    ]);
  });

  test('a failure leaves nothing behind', () => {
    const { ctx, runnerId, task } = setup();
    const before = counts(ctx);
    ctx.db.run(
      "CREATE TRIGGER no_commands BEFORE INSERT ON runner_commands BEGIN SELECT RAISE(ABORT, 'the disk is full'); END",
    );
    expect(() => startRunnerAttempt(ctx, { runnerId, taskId: task.id, role: 'worker', vendor: 'claude' })).toThrow(
      'the disk is full',
    );
    expect(counts(ctx)).toEqual(before);
    expect(getTask(ctx, task.id)).toMatchObject({ status: 'ready', assignee: null, currentAttempt: null, branch: null });
  });

  test('a second open attempt is refused, and so is a task that is not ready or a runner that does not exist', () => {
    const { ctx, runnerId, task } = setup();
    const first = startRunnerAttempt(ctx, { runnerId, taskId: task.id, role: 'worker', vendor: 'claude' });
    expect(() => startRunnerAttempt(ctx, { runnerId, taskId: task.id, role: 'worker', vendor: 'claude' })).toThrow(
      `${task.id} already has an open attempt, ${first.attempt.id}`,
    );
    // Even back at ready, the task's open attempt keeps a new one out until it ends.
    tx(ctx, (emit) => move(ctx, emit, getTask(ctx, task.id), 'ready', 'system'));
    expect(() => startRunnerAttempt(ctx, { runnerId, taskId: task.id, role: 'worker', vendor: 'claude' })).toThrow(
      'already has an open attempt',
    );
    const [other] = createTasks(ctx, [newTask({ title: 'Other' })], 'user:alice');
    if (!other) throw new Error('no task');
    tx(ctx, (emit) => move(ctx, emit, other, 'cancelled', 'user:alice'));
    expect(() => startRunnerAttempt(ctx, { runnerId, taskId: other.id, role: 'worker', vendor: 'claude' })).toThrow(
      `${other.id} is cancelled, not ready`,
    );
    expect(() => startRunnerAttempt(ctx, { runnerId: 'R-99', taskId: task.id, role: 'worker', vendor: 'claude' })).toThrow(
      'runner R-99 not found',
    );
    expect(listAttempts(ctx)).toHaveLength(1);
  });

  test('ids and names follow naming.ts at epoch 1 and 2', () => {
    const { ctx, runnerId, task } = setup();
    const first = startRunnerAttempt(ctx, { runnerId, taskId: task.id, role: 'worker', vendor: 'claude' });
    expect(first.attempt.id).toBe('T-1-a1');
    expect(first.attempt.wipRef).toBe('refs/agflow/T-1/a1');
    expect(getTask(ctx, task.id).branch).toBe('agflow/T-1-fix-the-parser');

    // After a restore the epoch is 2: new attempts, refs and branches carry it.
    ctx.db.run('UPDATE project SET epoch = 2');
    const [fresh] = createTasks(ctx, [newTask({ title: 'Fix the lexer' })], 'user:alice');
    if (!fresh) throw new Error('no task');
    const second = startRunnerAttempt(ctx, { runnerId, taskId: fresh.id, role: 'worker', vendor: 'claude' });
    expect(second.attempt.id).toBe('T-2-e2-a1');
    expect(second.attempt.fence.epoch).toBe(2);
    expect(second.attempt.wipRef).toBe('refs/agflow/T-2/e2-a1');
    expect(getTask(ctx, fresh.id).branch).toBe('agflow/T-2-e2-fix-the-lexer');
    const spec = (pendingCommands(ctx, runnerId, 1).at(-1)?.command as { attempt: { branch: string } }).attempt;
    expect(spec.branch).toBe('agflow/T-2-e2-fix-the-lexer');

    // A successor numbers on from the task's earlier attempts. Its branch was named at epoch 1, before the restore,
    // so it gets the current epoch's name, and the head recorded for the old name goes with it.
    updateAttempt(ctx, first.attempt.id, { status: 'ended', endReason: 'stopped', endedAt: ctx.now() });
    tx(ctx, (emit) =>
      move(ctx, emit, getTask(ctx, task.id), 'ready', 'system', {
        changes: { assignee: null, branchHead: 'd'.repeat(40) },
      }),
    );
    const third = startRunnerAttempt(ctx, { runnerId, taskId: task.id, role: 'worker', vendor: 'claude' });
    expect(third.attempt.id).toBe('T-1-e2-a2');
    expect(third.attempt.wipRef).toBe('refs/agflow/T-1/e2-a2');
    expect(getTask(ctx, task.id).branch).toBe('agflow/T-1-e2-fix-the-parser');
    expect(branchHead(ctx, task.id)).toBeNull();

    // A branch named at the current epoch is the task's own: the next attempt keeps it and its recorded head.
    updateAttempt(ctx, third.attempt.id, { status: 'ended', endReason: 'stopped', endedAt: ctx.now() });
    tx(ctx, (emit) =>
      move(ctx, emit, getTask(ctx, task.id), 'ready', 'system', {
        changes: { assignee: null, branchHead: 'e'.repeat(40) },
      }),
    );
    startRunnerAttempt(ctx, { runnerId, taskId: task.id, role: 'worker', vendor: 'claude' });
    expect(getTask(ctx, task.id).branch).toBe('agflow/T-1-e2-fix-the-parser');
    expect(branchHead(ctx, task.id)).toBe('e'.repeat(40));
  });

  test("a claim's branch outside the task's namespace is replaced by the task branch", () => {
    const { ctx, runnerId, task } = setup();
    writeTask(ctx, task.id, { branch: 'feature/parser' });
    startRunnerAttempt(ctx, { runnerId, taskId: task.id, role: 'worker', vendor: 'claude' });
    expect(getTask(ctx, task.id).branch).toBe('agflow/T-1-fix-the-parser');
  });
});

describe('the attempt spec', () => {
  test('starts from main without a work position, and carries the restore set, acceptance ids, caps and texts', () => {
    const { ctx, runnerId, task } = setup();
    const { attempt, agent, command } = startRunnerAttempt(ctx, {
      runnerId,
      taskId: task.id,
      role: 'worker',
      vendor: 'claude',
      model: 'claude-opus-5-5',
    });
    if (command.command.kind !== 'start_attempt') throw new Error('not a start');
    const spec = command.command.attempt;
    const held = getTask(ctx, task.id);
    expect(spec).toEqual({
      attemptId: attempt.id,
      taskId: task.id,
      role: 'worker',
      vendor: 'claude',
      model: 'claude-opus-5-5',
      fence: attempt.fence,
      hubUrl: 'http://hub.test',
      repo: { url: 'https://github.com/acme/demo', mainBranch: 'main' },
      start: { ref: 'refs/heads/main', sha: null },
      branch: 'agflow/T-1-fix-the-parser',
      wipRef: 'refs/agflow/T-1/a1',
      restore: { paths: restoreSet(held), base: 'refs/heads/main' },
      acceptanceIds: ['A1', 'A2'],
      toolCaps: computeToolCaps(ctx.config, held.checks),
      taskPack: composeTaskPack(held),
      brief: buildBrief(ctx, getAgent(ctx, agent.id)),
      firstPrompt: firstPrompt({ role: 'worker', taskId: task.id, successor: false }),
      successor: false,
    });
    expect(spec.toolCaps.checks).toEqual([{ cmd: 'bun test', capMs: 7200 * 1000 + 10 * 60_000 }]);
    expect(spec.restore.paths).toContain('.claude/**');
    expect(spec.brief).toContain('the runner pushes for you');
    expect(attempt).toMatchObject({ startRef: 'refs/heads/main', startSha: null });
  });

  test('starts from the work position, and a successor restates first', () => {
    const { ctx, runnerId, task } = setup();
    const sha = 'c'.repeat(40);
    writeTask(ctx, task.id, { workRef: 'refs/agflow/T-1/a1', workSha: sha });
    expect(startPositionFor(ctx, getTask(ctx, task.id))).toEqual({ ref: 'refs/agflow/T-1/a1', sha });
    expect(startPositionFor(ctx, null)).toEqual({ ref: 'refs/heads/main', sha: null });
    // An earlier live-chat attempt makes this one a successor.
    ctx.db.run(
      `INSERT INTO attempts (id, task_id, number, role, agent_id, runner_id, vendor, fence_epoch, fence_counter, status,
         end_reason, started_at, ended_at, last_activity_at)
       VALUES ('T-1-a1', 'T-1', 1, 'worker', 'A-9', NULL, 'claude', 1, 1, 'ended', 'released', 0, 0, 0)`,
    );
    const { attempt, command } = startRunnerAttempt(ctx, { runnerId, taskId: task.id, role: 'worker', vendor: 'claude' });
    if (command.command.kind !== 'start_attempt') throw new Error('not a start');
    expect(attempt).toMatchObject({ id: 'T-1-a2', startRef: 'refs/agflow/T-1/a1', startSha: sha });
    expect(command.command.attempt).toMatchObject({
      start: { ref: 'refs/agflow/T-1/a1', sha },
      successor: true,
      firstPrompt: firstPrompt({ role: 'worker', taskId: task.id, successor: true }),
    });
    expect(command.command.attempt.brief).toContain('## Handoff from the previous attempt');
  });

  test('the stored payload has no token; each wire command mints one for the attempt and its fence', () => {
    const { ctx, runnerId, task } = setup();
    const { attempt, command } = startRunnerAttempt(ctx, { runnerId, taskId: task.id, role: 'worker', vendor: 'claude' });
    const { payload } = ctx.db.query('SELECT payload FROM runner_commands WHERE id = $id').get({ id: command.id }) as {
      payload: string;
    };
    expect(payload).not.toContain('agt_');
    expect(JSON.parse(payload).attempt).not.toHaveProperty('agentToken');
    const wire = toWireCommand(ctx, command);
    expect(RunnerCommandSchema.parse(wire.command).kind).toBe('start_attempt');
    if (wire.command.kind !== 'start_attempt') throw new Error('not a start');
    expect(AttemptSpecSchema.parse(wire.command.attempt).agentToken).toStartWith('agt_');
    expect(resolveAgentToken(ctx, wire.command.attempt.agentToken).attempt.id).toBe(attempt.id);
  });
});

describe('lead attempts', () => {
  test('have no task, branch or WIP ref, start at main and take the seat', () => {
    const { ctx, runnerId } = setup();
    const live = addAgent(ctx, 'alice', 'lead');
    expect(getHubState(ctx).leadAgentId).toBe(live.id);
    // A live lead holds the seat: no runner lead starts.
    expect(() => startRunnerAttempt(ctx, { runnerId, taskId: null, role: 'lead', vendor: 'claude' })).toThrow(
      `${live.id} holds the lead seat`,
    );
    ctx.db.run("UPDATE hub_state SET lead_agent_id = NULL, lead_kind = NULL, lead_since = NULL");
    const { attempt, agent, command } = startRunnerAttempt(ctx, { runnerId, taskId: null, role: 'lead', vendor: 'claude' });
    expect(attempt).toMatchObject({
      id: 'lead-a1',
      taskId: null,
      role: 'lead',
      wipRef: null,
      startRef: 'refs/heads/main',
      status: 'starting',
      leaseExpiresAt: ctx.now() + ctx.config.runnerLeaseMs,
    });
    expect(agent).toMatchObject({ role: 'lead', currentTask: null, attemptId: 'lead-a1' });
    expect(getHubState(ctx)).toMatchObject({ leadAgentId: agent.id, leadKind: 'runner' });
    // The live lead's row is demoted, so only the seat holder reads as lead.
    expect(getAgent(ctx, live.id).role).toBe('worker');
    const wire = toWireCommand(ctx, command).command;
    if (wire.kind !== 'start_attempt') throw new Error('not a start');
    const spec = AttemptSpecSchema.parse(wire.attempt);
    expect(spec).toMatchObject({
      taskId: null,
      branch: null,
      wipRef: null,
      start: { ref: 'refs/heads/main', sha: null },
      restore: { paths: restoreSet(null), base: 'refs/heads/main' },
      acceptanceIds: [],
      taskPack: '',
      successor: false,
      firstPrompt: firstPrompt({ role: 'lead', taskId: null, successor: false }),
    });
    expect(spec.brief).toContain('the lead manager');
    expect(listEvents(ctx.db).find((event) => event.type === 'attempt.started')?.subject).toBe('lead-a1');
    expect(listEvents(ctx.db).filter((event) => event.type === 'lead.seat_changed').at(-1)?.data).toMatchObject({
      kind: 'runner',
      agentId: agent.id,
      attemptId: 'lead-a1',
    });
    // A second lead while this one holds the seat is refused.
    expect(() => startRunnerAttempt(ctx, { runnerId, taskId: null, role: 'lead', vendor: 'claude' })).toThrow(
      'holds the lead seat',
    );
    expect(findAttempt(ctx, 'lead-a2')).toBeNull();
  });

  test('a worker attempt needs a task, and a lead attempt none', () => {
    const { ctx, runnerId, task } = setup();
    expect(() => startRunnerAttempt(ctx, { runnerId, taskId: null, role: 'worker', vendor: 'claude' })).toThrow(
      'a worker attempt needs a task',
    );
    expect(() => startRunnerAttempt(ctx, { runnerId, taskId: task.id, role: 'lead', vendor: 'claude' })).toThrow(
      'a lead attempt takes no task',
    );
  });
});

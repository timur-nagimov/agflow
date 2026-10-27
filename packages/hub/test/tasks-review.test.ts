import { describe, expect, test } from 'bun:test';
import { ACTIVE_MS, getAgent } from '../src/agents';
import { HubError } from '../src/errors';
import { listEvents } from '../src/events';
import { listMessages } from '../src/messages';
import {
  acceptTask,
  blockTask,
  claimTask,
  createTasks,
  declareImpossible,
  getTask,
  listTasks,
  markMerged,
  rejectTask,
  releaseTask,
  submitTask,
  unblockTask,
} from '../src/tasks';
import { addAgent, createTestContext, newTask } from './helpers';

function submitted(ctx: ReturnType<typeof createTestContext>['ctx']) {
  const agent = addAgent(ctx);
  const [task] = createTasks(ctx, [newTask({ title: 'Login' })], 'user:alice');
  claimTask(ctx, task.id, agent, 'agflow/T-1-login');
  submitTask(ctx, task.id, agent, { summary: 'Done.', evidence: ['bun test: 12 pass'], headSha: 'abc1234' });
  return { agent, task: getTask(ctx, task.id) };
}

describe('submitting', () => {
  test('stores the submission, frees the agent and tells the lead', () => {
    const { ctx } = createTestContext();
    const { agent, task } = submitted(ctx);
    expect(task.status).toBe('submitted');
    expect(task.submission).toMatchObject({ summary: 'Done.', branch: 'agflow/T-1-login', headSha: 'abc1234', by: agent.id });
    expect(getAgent(ctx, agent.id).currentTask).toBeNull();
    expect(listMessages(ctx, { target: 'lead' })[0]?.body).toContain('was submitted by');
  });

  test('only the holder can submit', () => {
    const { ctx } = createTestContext();
    const holder = addAgent(ctx);
    const other = addAgent(ctx, 'bob');
    const [task] = createTasks(ctx, [newTask()], 'user:alice');
    claimTask(ctx, task.id, holder);
    expect(() => submitTask(ctx, task.id, other, { summary: 'x', evidence: [] })).toThrow(HubError);
  });
});

describe('reviewing', () => {
  test('accepting unblocks dependents and tells the author', () => {
    const { ctx } = createTestContext();
    const agent = addAgent(ctx);
    const [a, b] = createTasks(ctx, [newTask({ title: 'A' }), newTask({ title: 'B', dependsOn: ['#1'] })], 'user:alice');
    claimTask(ctx, a.id, agent);
    submitTask(ctx, a.id, agent, { summary: 'ok', evidence: [] });
    expect(acceptTask(ctx, a.id, 'agent:A-9', 'Nice.').status).toBe('accepted');
    expect(getTask(ctx, b.id).status).toBe('ready');
    expect(listMessages(ctx, { target: `agent:${agent.id}` })[0]?.body).toBe(`${a.id} was accepted. Nice.`);
  });

  test('an agent cannot accept its own submission, but a person can', () => {
    const { ctx } = createTestContext();
    const lead = addAgent(ctx, 'alice', 'lead');
    const [task] = createTasks(ctx, [newTask()], 'user:alice');
    claimTask(ctx, task.id, lead);
    submitTask(ctx, task.id, lead, { summary: 'Done.', evidence: [] });
    expect(() => acceptTask(ctx, task.id, `agent:${lead.id}`)).toThrow(HubError);
    expect(() => acceptTask(ctx, task.id, `agent:${lead.id}`)).toThrow('cannot accept its own work');
    expect(getTask(ctx, task.id).status).toBe('submitted');
    expect(acceptTask(ctx, task.id, 'user:alice').status).toBe('accepted');
  });

  test('the lead can accept the work of another agent', () => {
    const { ctx } = createTestContext();
    const lead = addAgent(ctx, 'alice', 'lead');
    const worker = addAgent(ctx, 'bob');
    const [task] = createTasks(ctx, [newTask()], 'user:alice');
    claimTask(ctx, task.id, worker);
    submitTask(ctx, task.id, worker, { summary: 'Done.', evidence: [] });
    expect(acceptTask(ctx, task.id, `agent:${lead.id}`).status).toBe('accepted');
  });

  test('rejected work goes back to its author while the author is active', () => {
    const { ctx } = createTestContext();
    const { agent, task } = submitted(ctx);
    const back = rejectTask(ctx, task.id, 'agent:A-9', 'Handle expired tokens.');
    expect(back).toMatchObject({ status: 'claimed', assignee: agent.id, feedback: 'Handle expired tokens.' });
    expect(getAgent(ctx, agent.id).currentTask).toBe(task.id);
    expect(listMessages(ctx, { target: `agent:${agent.id}` })[0]?.body).toContain('Handle expired tokens.');
  });

  test('rejected work returns to the pool when the author is gone', () => {
    const { ctx, clock } = createTestContext();
    const { task } = submitted(ctx);
    clock.advance(ACTIVE_MS + 1);
    expect(rejectTask(ctx, task.id, 'user:alice', 'Redo.')).toMatchObject({ status: 'ready', assignee: null, feedback: 'Redo.' });
  });

  test('rejected work returns to the pool when sending it back would overlap a held task', () => {
    const { ctx } = createTestContext();
    const author = addAgent(ctx);
    const other = addAgent(ctx, 'bob');
    const [a, b] = createTasks(
      ctx,
      [newTask({ ownedPaths: ['src/auth/**'] }), newTask({ ownedPaths: ['src/auth/login.ts'] })],
      'user:alice',
    );
    claimTask(ctx, a.id, author);
    submitTask(ctx, a.id, author, { summary: 'Done.', evidence: [] });
    claimTask(ctx, b.id, other);
    expect(rejectTask(ctx, a.id, 'user:alice', 'Redo.')).toMatchObject({ status: 'ready', assignee: null, feedback: 'Redo.' });
    expect(getAgent(ctx, author.id).currentTask).toBeNull();
    expect(listTasks(ctx, { status: ['claimed', 'working'] }).map((task) => task.id)).toEqual([b.id]);
    expect(() => claimTask(ctx, a.id, author)).toThrow(`overlap ${b.id}`);
    releaseTask(ctx, b.id, other, 'switching tasks');
    expect(claimTask(ctx, a.id, author).status).toBe('claimed');
  });

  test('rejected work still goes back to its author when held tasks own other paths', () => {
    const { ctx } = createTestContext();
    const author = addAgent(ctx);
    const other = addAgent(ctx, 'bob');
    const [a, b] = createTasks(ctx, [newTask({ ownedPaths: ['src/auth/**'] }), newTask({ ownedPaths: ['docs/**'] })], 'user:alice');
    claimTask(ctx, a.id, author);
    submitTask(ctx, a.id, author, { summary: 'Done.', evidence: [] });
    claimTask(ctx, b.id, other);
    expect(rejectTask(ctx, a.id, 'user:alice', 'Redo.')).toMatchObject({ status: 'claimed', assignee: author.id });
    expect(getAgent(ctx, author.id).currentTask).toBe(a.id);
  });

  test('only submitted tasks can be accepted or rejected', () => {
    const { ctx } = createTestContext();
    const [task] = createTasks(ctx, [newTask()], 'user:alice');
    expect(() => acceptTask(ctx, task.id, 'user:alice')).toThrow('only submitted tasks');
    expect(() => rejectTask(ctx, task.id, 'user:alice', 'no')).toThrow('only submitted tasks');
  });

  test('accepted work can be marked merged with its commit', () => {
    const { ctx } = createTestContext();
    const { task } = submitted(ctx);
    expect(() => markMerged(ctx, task.id, 'user:alice')).toThrow('only accepted tasks');
    acceptTask(ctx, task.id, 'user:alice');
    expect(markMerged(ctx, task.id, 'user:alice', 'def5678')).toMatchObject({ status: 'merged', mergedSha: 'def5678' });
  });
});

describe('blocking', () => {
  test('a blocked task frees the agent and tells the lead; unblocking makes it ready', () => {
    const { ctx } = createTestContext();
    const agent = addAgent(ctx);
    const [task] = createTasks(ctx, [newTask()], 'user:alice');
    claimTask(ctx, task.id, agent);
    expect(blockTask(ctx, task.id, agent, 'Need DB credentials.')).toMatchObject({
      status: 'blocked',
      blockedKind: 'agent',
      assignee: null,
    });
    expect(listMessages(ctx, { target: 'lead' })[0]?.body).toContain('Need DB credentials.');
    expect(unblockTask(ctx, task.id, 'user:alice', 'Added them.').status).toBe('ready');
  });

  test('declaring a task impossible records a distinct event', () => {
    const { ctx } = createTestContext();
    const agent = addAgent(ctx);
    const [task] = createTasks(ctx, [newTask()], 'user:alice');
    claimTask(ctx, task.id, agent);
    expect(declareImpossible(ctx, task.id, agent, 'A1 contradicts A2.').blockedKind).toBe('impossible');
    expect(listEvents(ctx.db, { subject: task.id }).map((event) => event.type)).toContain('task.impossible');
  });

  test('unblocking keeps a task blocked while its dependencies are unmet', () => {
    const { ctx } = createTestContext();
    const agent = addAgent(ctx);
    const [a, b] = createTasks(ctx, [newTask({ title: 'A' }), newTask({ title: 'B', dependsOn: ['#1'] })], 'user:alice');
    claimTask(ctx, a.id, agent);
    blockTask(ctx, a.id, agent, 'stuck');
    unblockTask(ctx, a.id, 'user:alice');
    expect(unblockTask(ctx, b.id, 'user:alice')).toMatchObject({ status: 'blocked', blockedReason: `waiting on ${a.id}` });
  });
});

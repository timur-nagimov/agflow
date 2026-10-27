import { describe, expect, test } from 'bun:test';
import { getAgent, touchAgent } from '../src/agents';
import { HubError } from '../src/errors';
import { listMessages } from '../src/messages';
import { setPaused } from '../src/project';
import {
  cancelTask,
  claimTask,
  createTasks,
  forceRelease,
  getTask,
  listTaskNotes,
  releaseTask,
  reportProgress,
  resumeClaim,
  sweepLeases,
} from '../src/tasks';
import { addAgent, createTestContext, newTask } from './helpers';

describe('claiming', () => {
  test('a claim assigns the task, records the branch and starts a lease', () => {
    const { ctx } = createTestContext();
    const agent = addAgent(ctx);
    const [task] = createTasks(ctx, [newTask()], 'user:alice');
    const claimed = claimTask(ctx, task.id, agent, 'agflow/T-1-thing');
    expect(claimed).toMatchObject({ status: 'claimed', assignee: agent.id, branch: 'agflow/T-1-thing' });
    expect(claimed.leaseExpiresAt).toBe(ctx.now() + ctx.config.leaseMs);
    expect(getAgent(ctx, agent.id).currentTask).toBe(task.id);
  });

  test('a task can only be claimed once, and an agent holds one task at a time', () => {
    const { ctx } = createTestContext();
    const first = addAgent(ctx);
    const second = addAgent(ctx, 'bob');
    const [a, b] = createTasks(ctx, [newTask(), newTask()], 'user:alice');
    claimTask(ctx, a.id, first);
    expect(() => claimTask(ctx, a.id, second)).toThrow('not ready');
    expect(() => claimTask(ctx, b.id, first)).toThrow(`you already hold ${a.id}`);
  });

  test('nothing can be claimed while the project is paused', () => {
    const { ctx } = createTestContext();
    const agent = addAgent(ctx);
    const [task] = createTasks(ctx, [newTask()], 'user:alice');
    setPaused(ctx, true, 'user:alice');
    expect(() => claimTask(ctx, task.id, agent)).toThrow('paused');
  });

  test('tasks with overlapping owned paths cannot be held at the same time', () => {
    const { ctx } = createTestContext();
    const first = addAgent(ctx);
    const second = addAgent(ctx, 'bob');
    const [a, b, c] = createTasks(
      ctx,
      [newTask({ ownedPaths: ['src/auth/**'] }), newTask({ ownedPaths: ['src/auth/login.ts'] }), newTask({ ownedPaths: ['docs/**'] })],
      'user:alice',
    );
    claimTask(ctx, a.id, first);
    expect(() => claimTask(ctx, b.id, second)).toThrow(`overlap ${a.id}`);
    expect(claimTask(ctx, c.id, second).status).toBe('claimed');
  });
});

describe('working on a task', () => {
  test('progress moves the task to working and is stored as a note', () => {
    const { ctx } = createTestContext();
    const agent = addAgent(ctx);
    const [task] = createTasks(ctx, [newTask()], 'user:alice');
    claimTask(ctx, task.id, agent);
    expect(reportProgress(ctx, task.id, agent, 'Wrote the parser.').status).toBe('working');
    expect(listTaskNotes(ctx, task.id).map((note) => `${note.kind}: ${note.body}`)).toEqual(['progress: Wrote the parser.']);
  });

  test('only the holder can report progress', () => {
    const { ctx } = createTestContext();
    const holder = addAgent(ctx);
    const other = addAgent(ctx, 'bob');
    const [task] = createTasks(ctx, [newTask()], 'user:alice');
    claimTask(ctx, task.id, holder);
    expect(() => reportProgress(ctx, task.id, other, 'hi')).toThrow(HubError);
  });

  test('releasing returns the task to the pool and frees the agent', () => {
    const { ctx } = createTestContext();
    const agent = addAgent(ctx);
    const [task] = createTasks(ctx, [newTask()], 'user:alice');
    claimTask(ctx, task.id, agent);
    expect(releaseTask(ctx, task.id, agent, 'out of time')).toMatchObject({ status: 'ready', assignee: null });
    expect(getAgent(ctx, agent.id).currentTask).toBeNull();
  });

  test('a person can force-release a claim, and the holder is told', () => {
    const { ctx } = createTestContext();
    const agent = addAgent(ctx);
    const [task] = createTasks(ctx, [newTask()], 'user:alice');
    claimTask(ctx, task.id, agent);
    expect(forceRelease(ctx, task.id, 'user:bob', 'went home').status).toBe('ready');
    expect(listMessages(ctx, { target: `agent:${agent.id}` })[0]?.body).toContain('released by user:bob');
  });

  test('cancelling a held task tells the holder', () => {
    const { ctx } = createTestContext();
    const agent = addAgent(ctx);
    const [task] = createTasks(ctx, [newTask()], 'user:alice');
    claimTask(ctx, task.id, agent);
    cancelTask(ctx, task.id, 'goal changed', 'agent:A-9');
    expect(getAgent(ctx, agent.id).currentTask).toBeNull();
    expect(listMessages(ctx, { target: `agent:${agent.id}` })[0]?.body).toContain('was cancelled: goal changed');
  });
});

describe('leases', () => {
  test('agent activity renews the lease; an expired lease makes the task ready again', () => {
    const { ctx, clock } = createTestContext();
    const agent = addAgent(ctx);
    const [task] = createTasks(ctx, [newTask()], 'user:alice');
    claimTask(ctx, task.id, agent);
    clock.advance(ctx.config.leaseMs - 1000);
    touchAgent(ctx, agent.id);
    clock.advance(2000);
    expect(sweepLeases(ctx)).toEqual([]);
    clock.advance(ctx.config.leaseMs);
    expect(sweepLeases(ctx)).toEqual([task.id]);
    expect(getTask(ctx, task.id)).toMatchObject({ status: 'ready', assignee: null });
    expect(getAgent(ctx, agent.id).currentTask).toBeNull();
    expect(listMessages(ctx, { target: 'lead' })[0]?.body).toContain('went stale');
  });

  test("the same person's new session can take over a claim", () => {
    const { ctx } = createTestContext();
    const oldSession = addAgent(ctx, 'alice');
    const newSession = addAgent(ctx, 'alice');
    const stranger = addAgent(ctx, 'bob');
    const [task] = createTasks(ctx, [newTask()], 'user:alice');
    claimTask(ctx, task.id, oldSession);
    expect(() => resumeClaim(ctx, task.id, stranger)).toThrow("someone else's agent");
    expect(resumeClaim(ctx, task.id, newSession).assignee).toBe(newSession.id);
    expect(getAgent(ctx, oldSession.id).currentTask).toBeNull();
    expect(getAgent(ctx, newSession.id).currentTask).toBe(task.id);
  });
});

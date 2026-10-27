import { describe, expect, test } from 'bun:test';
import { ACTIVE_MS, getAgent, touchAgent } from '../src/agents';
import { HubError } from '../src/errors';
import { listEvents } from '../src/events';
import { listMessages } from '../src/messages';
import { setPaused } from '../src/project';
import {
  acceptTask,
  cancelTask,
  claimTask,
  createTasks,
  forceRelease,
  getTask,
  getTaskDetail,
  listTaskNotes,
  rejectTask,
  releaseTask,
  reportProgress,
  resumeClaim,
  submitTask,
  sweepLeases,
  updateTask,
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

  for (const outcome of ['accepted', 'rejected', 'cancelled'] as const) {
    test(`work waiting for review keeps its owned paths until it is ${outcome}`, () => {
      const { ctx, clock } = createTestContext();
      const author = addAgent(ctx);
      const [a, b] = createTasks(
        ctx,
        [newTask({ ownedPaths: ['src/auth/**'] }), newTask({ ownedPaths: ['src/auth/login.ts'] })],
        'user:alice',
      );
      claimTask(ctx, a.id, author);
      submitTask(ctx, a.id, author, { summary: 'Done.', evidence: [] });
      // The author has left, so rejected work returns to the pool instead of to them.
      clock.advance(ACTIVE_MS + 1);
      const other = addAgent(ctx, 'bob');
      expect(() => claimTask(ctx, b.id, other)).toThrow(`${b.id} owns paths that overlap ${a.id}, which is waiting for review`);
      if (outcome === 'accepted') acceptTask(ctx, a.id, 'user:alice');
      if (outcome === 'rejected') rejectTask(ctx, a.id, 'user:alice', 'Redo.');
      if (outcome === 'cancelled') cancelTask(ctx, a.id, 'Not needed.', 'user:alice');
      expect(claimTask(ctx, b.id, other).status).toBe('claimed');
    });
  }

  test('a task with unmet dependencies is moved to blocked instead of being claimed', () => {
    const { ctx } = createTestContext();
    const first = addAgent(ctx);
    const second = addAgent(ctx, 'bob');
    const [a, b] = createTasks(ctx, [newTask({ title: 'A' }), newTask({ title: 'B' })], 'user:alice');
    claimTask(ctx, b.id, first);
    // A dependency added while the task is held leaves it held, so it comes back to the pool ready.
    updateTask(ctx, b.id, { dependsOn: [a.id] }, 'user:alice');
    releaseTask(ctx, b.id, first, 'A has to come first');
    expect(getTask(ctx, b.id).status).toBe('ready');
    expect(() => claimTask(ctx, b.id, second)).toThrow(`${b.id} cannot be claimed: it is waiting on ${a.id}`);
    expect(getTask(ctx, b.id)).toMatchObject({
      status: 'blocked',
      blockedKind: 'deps',
      blockedReason: `waiting on ${a.id}`,
      assignee: null,
    });
    expect(getAgent(ctx, second.id).currentTask).toBeNull();
    claimTask(ctx, a.id, second);
    submitTask(ctx, a.id, second, { summary: 'Done.', evidence: [] });
    acceptTask(ctx, a.id, 'user:alice');
    expect(claimTask(ctx, b.id, first).status).toBe('claimed');
  });
});

describe('amending a held task', () => {
  test('the holder is told which parts of the contract changed', () => {
    const { ctx } = createTestContext();
    const agent = addAgent(ctx);
    const [task] = createTasks(ctx, [newTask({ title: 'Parser' })], 'user:alice');
    updateTask(ctx, task.id, { title: 'JSON parser' }, 'user:alice');
    claimTask(ctx, task.id, agent);
    // A patch that changes nothing sends nothing, and unchanged fields are left out.
    updateTask(ctx, task.id, { priority: 5 }, 'agent:A-9');
    updateTask(ctx, task.id, { objective: 'Parse JSON and YAML', priority: 5, ownedPaths: ['src/parser/**'] }, 'agent:A-9');
    const notices = listMessages(ctx, { target: `agent:${agent.id}` });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ from: 'system', taskId: task.id });
    expect(notices[0]?.body).toBe(
      [
        `agent:A-9 amended ${task.id}, which you hold. Changed: objective, ownedPaths.`,
        'Call get_task to read the new contract and follow it from now on.',
      ].join('\n'),
    );
  });

  test('a held task cannot gain owned paths that overlap another held task', () => {
    const { ctx } = createTestContext();
    const first = addAgent(ctx);
    const second = addAgent(ctx, 'bob');
    const third = addAgent(ctx, 'bob');
    const [a, b, c] = createTasks(
      ctx,
      [newTask({ ownedPaths: ['src/auth/**'] }), newTask({ ownedPaths: ['docs/**'] }), newTask({ ownedPaths: ['src/billing/**'] })],
      'user:alice',
    );
    claimTask(ctx, a.id, first);
    claimTask(ctx, b.id, second);
    expect(() => updateTask(ctx, b.id, { ownedPaths: ['docs/**', 'src/auth/login.ts'] }, 'user:alice')).toThrow(
      `${b.id} would own paths that overlap ${a.id}, which ${first.id} is working on`,
    );
    expect(getTask(ctx, b.id).ownedPaths).toEqual(['docs/**']);
    expect(listMessages(ctx, { target: `agent:${second.id}` })).toEqual([]);
    // Nobody holds c yet, so b may take its paths; it is c's claim that is refused.
    expect(updateTask(ctx, b.id, { ownedPaths: ['docs/**', 'src/billing/**'] }, 'user:alice').ownedPaths).toEqual([
      'docs/**',
      'src/billing/**',
    ]);
    expect(() => claimTask(ctx, c.id, third)).toThrow(`overlap ${b.id}`);
  });

  test('only the paths a held task gains are checked, against work waiting for review too', () => {
    const { ctx } = createTestContext();
    const first = addAgent(ctx);
    const second = addAgent(ctx, 'bob');
    const [a, b] = createTasks(ctx, [newTask({ ownedPaths: ['src/auth/**'] }), newTask({ ownedPaths: ['docs/**'] })], 'user:alice');
    claimTask(ctx, a.id, first);
    claimTask(ctx, b.id, second);
    submitTask(ctx, b.id, second, { summary: 'Done.', evidence: [] });
    // Nobody works on b during its review, so its paths may change, here into a's.
    updateTask(ctx, b.id, { ownedPaths: ['docs/**', 'src/auth/README.md'] }, 'user:alice');
    expect(() => updateTask(ctx, a.id, { ownedPaths: ['src/auth/**', 'docs/auth.md'] }, 'user:alice')).toThrow(
      `${a.id} would own paths that overlap ${b.id}, which is waiting for review`,
    );
    // The overlap that is already there does not stop a change that adds no new one.
    expect(updateTask(ctx, a.id, { ownedPaths: ['src/auth/**', 'tests/auth/**'] }, 'user:alice').ownedPaths).toEqual([
      'src/auth/**',
      'tests/auth/**',
    ]);
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

describe('task detail', () => {
  test('lists a short history whole, oldest first', () => {
    const { ctx } = createTestContext();
    const agent = addAgent(ctx);
    const [task] = createTasks(ctx, [newTask()], 'user:alice');
    claimTask(ctx, task.id, agent);
    reportProgress(ctx, task.id, agent, 'first');
    const { events } = getTaskDetail(ctx, task.id);
    expect(events.map((event) => event.type)).toEqual(['task.created', 'task.claimed', 'task.working', 'task.progress']);
    expect(events).toEqual(listEvents(ctx.db, { subject: task.id }));
  });

  test('past 500 events it keeps the newest ones, still oldest first', () => {
    const { ctx } = createTestContext();
    const agent = addAgent(ctx);
    const [task] = createTasks(ctx, [newTask()], 'user:alice');
    claimTask(ctx, task.id, agent);
    for (let step = 0; step < 600; step++) reportProgress(ctx, task.id, agent, `step ${step}`);
    const everything = listEvents(ctx.db, { subject: task.id, limit: 1000 });
    expect(everything.length).toBeGreaterThan(500);
    const { events } = getTaskDetail(ctx, task.id);
    expect(events).toHaveLength(500);
    // The last events are in, so a history that shows the newest first keeps up with the task.
    expect(events.at(-1)?.data).toMatchObject({ note: 'step 599' });
    expect(events).toEqual(everything.slice(-500));
    expect(events.map((event) => event.id)).toEqual(events.map((event) => event.id).sort((a, b) => a - b));
    // The oldest ones are the ones that drop out.
    expect(events.map((event) => event.type)).not.toContain('task.created');
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

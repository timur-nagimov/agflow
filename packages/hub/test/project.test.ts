import { describe, expect, test } from 'bun:test';
import { listEvents } from '../src/events';
import { getProject, setDeadline, setPaused } from '../src/project';
import { createTestContext } from './helpers';

describe('project', () => {
  test('starts unpaused, with runner leads on, no deadline and the configured name and repo', () => {
    const { ctx } = createTestContext();
    expect(getProject(ctx)).toEqual({
      name: 'demo',
      repo: 'https://github.com/acme/demo',
      paused: false,
      runnerLeads: true,
      deadlineAt: null,
    });
  });

  test('pausing and resuming record events; repeating is a no-op', () => {
    const { ctx } = createTestContext();
    expect(setPaused(ctx, true, 'user:alice').paused).toBe(true);
    setPaused(ctx, true, 'user:alice');
    expect(setPaused(ctx, false, 'user:bob').paused).toBe(false);
    expect(listEvents(ctx.db).map((event) => `${event.type} ${event.actor}`)).toEqual([
      'project.paused user:alice',
      'project.resumed user:bob',
    ]);
  });

  test('setting and clearing the deadline record project.deadline_set; repeating is a no-op', () => {
    const { ctx } = createTestContext();
    const deadline = Date.UTC(2026, 10, 16, 15, 0, 0);
    expect(setDeadline(ctx, deadline, 'user:alice').deadlineAt).toBe(deadline);
    expect(getProject(ctx).deadlineAt).toBe(deadline);
    setDeadline(ctx, deadline, 'user:alice');
    expect(setDeadline(ctx, null, 'user:bob').deadlineAt).toBeNull();
    expect(listEvents(ctx.db).map((event) => [event.type, event.actor, event.data])).toEqual([
      ['project.deadline_set', 'user:alice', { deadlineAt: deadline }],
      ['project.deadline_set', 'user:bob', { deadlineAt: null }],
    ]);
  });
});

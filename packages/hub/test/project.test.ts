import { describe, expect, test } from 'bun:test';
import { listEvents } from '../src/events';
import { getProject, setPaused } from '../src/project';
import { createTestContext } from './helpers';

describe('project', () => {
  test('starts unpaused, with runner leads on and the configured name and repo', () => {
    const { ctx } = createTestContext();
    expect(getProject(ctx)).toEqual({ name: 'demo', repo: 'https://github.com/acme/demo', paused: false, runnerLeads: true });
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
});

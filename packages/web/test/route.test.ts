import { describe, expect, test } from 'bun:test';
import { navViewOf, parseRoute, routeHref } from '../src/route';

describe('routes', () => {
  test('parses every view', () => {
    expect(parseRoute('')).toEqual({ view: 'board' });
    expect(parseRoute('#/board')).toEqual({ view: 'board' });
    expect(parseRoute('#/goal')).toEqual({ view: 'goal' });
    expect(parseRoute('#/task/T-12')).toEqual({ view: 'task', id: 'T-12' });
    expect(parseRoute('#/agents')).toEqual({ view: 'agents' });
    expect(parseRoute('#/messages')).toEqual({ view: 'messages' });
    expect(parseRoute('#/timeline')).toEqual({ view: 'timeline' });
    expect(parseRoute('#/knowledge')).toEqual({ view: 'knowledge' });
  });

  test('a messages route can preselect a valid target', () => {
    expect(parseRoute('#/messages?to=agent%3AA-3')).toEqual({ view: 'messages', to: 'agent:A-3' });
    expect(parseRoute('#/messages?to=lead')).toEqual({ view: 'messages', to: 'lead' });
    expect(parseRoute('#/messages?to=nobody')).toEqual({ view: 'messages' });
  });

  test('unknown paths and bad task ids fall back to the board', () => {
    expect(parseRoute('#/nope')).toEqual({ view: 'board' });
    expect(parseRoute('#/task/12')).toEqual({ view: 'board' });
    expect(parseRoute('#/task/T-1%3Cscript%3E')).toEqual({ view: 'board' });
  });

  test('hrefs round-trip', () => {
    for (const route of [
      { view: 'board' },
      { view: 'task', id: 'T-7' },
      { view: 'messages', to: 'task:T-7' },
      { view: 'messages' },
      { view: 'knowledge' },
    ] as const) {
      expect(parseRoute(routeHref(route))).toEqual(route);
    }
  });

  test('a task page highlights the board in the navigation', () => {
    expect(navViewOf({ view: 'task', id: 'T-1' })).toBe('board');
    expect(navViewOf({ view: 'agents' })).toBe('agents');
  });
});

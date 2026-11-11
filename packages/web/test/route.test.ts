import { describe, expect, test } from 'bun:test';
import { APPROVALS_ROUTE, type HubEvent, RunnerIdSchema } from '@agflow/core';
import { NAV, inTimelineSubject, navViewOf, parseRoute, routeHref, timelineQuery } from '../src/route';

describe('routes', () => {
  test('parses every view', () => {
    expect(parseRoute('')).toEqual({ view: 'board' });
    expect(parseRoute('#/board')).toEqual({ view: 'board' });
    expect(parseRoute('#/goal')).toEqual({ view: 'goal' });
    expect(parseRoute('#/task/T-12')).toEqual({ view: 'task', id: 'T-12' });
    expect(parseRoute('#/agents')).toEqual({ view: 'agents' });
    expect(parseRoute('#/runners')).toEqual({ view: 'runners' });
    expect(parseRoute('#/approvals')).toEqual({ view: 'approvals' });
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
      { view: 'runners' },
      { view: 'approvals' },
      { view: 'attempt', id: 'T-42-a3' },
      { view: 'attempt', id: 'lead-e2-a5' },
    ] as const) {
      expect(parseRoute(routeHref(route))).toEqual(route);
    }
  });

  test('a task page highlights the board in the navigation', () => {
    expect(navViewOf({ view: 'task', id: 'T-1' })).toBe('board');
    expect(navViewOf({ view: 'agents' })).toBe('agents');
    expect(navViewOf({ view: 'runners' })).toBe('runners');
    expect(navViewOf({ view: 'approvals' })).toBe('approvals');
  });

  test("an attempt page takes every id core's parseAttemptId reads, from any epoch, leads included", () => {
    for (const id of ['T-42-a3', 'T-42-e2-a3', 'lead-a5', 'lead-e2-a5']) {
      expect(parseRoute(`#/attempt/${id}`)).toEqual({ view: 'attempt', id });
      expect(routeHref({ view: 'attempt', id })).toBe(`#/attempt/${id}`);
    }
  });

  test('a malformed attempt id falls back to the board', () => {
    for (const id of ['', 'T-42', 'T-42-a0', 'T-42-e1-a3', 'T-42-a03', 'lead', 'lead-x5', 'A-3', 'T-42-a3%3Cscript%3E']) {
      expect(parseRoute(`#/attempt/${id}`)).toEqual({ view: 'board' });
    }
  });

  test("a task's attempt highlights the board, and a lead's attempt the agents", () => {
    expect(navViewOf({ view: 'attempt', id: 'T-42-a3' })).toBe('board');
    expect(navViewOf({ view: 'attempt', id: 'T-42-e2-a3' })).toBe('board');
    expect(navViewOf({ view: 'attempt', id: 'lead-a5' })).toBe('agents');
    expect(navViewOf({ view: 'attempt', id: 'lead-e2-a5' })).toBe('agents');
  });

  test('the navigation lists Runners right after Agents', () => {
    const views = NAV.map((item) => item.view);
    expect(views.indexOf('runners')).toBe(views.indexOf('agents') + 1);
    expect(NAV.find((item) => item.view === 'runners')?.label).toBe('Runners');
  });

  test("the Approvals page is at core's APPROVALS_ROUTE, which runner notifications print", () => {
    expect(routeHref({ view: 'approvals' })).toBe(APPROVALS_ROUTE);
    expect(parseRoute(APPROVALS_ROUTE)).toEqual({ view: 'approvals' });
  });

  test('a timeline route takes a runner or an attempt as its subject, and they round-trip', () => {
    for (const subject of ['R-1', 'T-8-a1', 'T-8-e2-a3', 'lead-a5', 'lead-e2-a5']) {
      const route = { view: 'timeline', subject } as const;
      expect(parseRoute(`#/timeline?subject=${subject}`)).toEqual(route);
      expect(routeHref(route)).toBe(`#/timeline?subject=${subject}`);
      expect(parseRoute(routeHref(route))).toEqual(route);
    }
    expect(routeHref({ view: 'timeline' })).toBe('#/timeline');
    expect(navViewOf({ view: 'timeline', subject: 'R-1' })).toBe('timeline');
  });

  test('other timeline subjects are dropped', () => {
    for (const subject of ['', 'T-8', 'R-', 'R-1x', 'A-3', 'lead', 'T-8-a0', 'R-1%3Cscript%3E', 'r-1']) {
      expect(parseRoute(`#/timeline?subject=${subject}`)).toEqual({ view: 'timeline' });
    }
  });

  test("the runner subjects are the ids core's RunnerIdSchema accepts", () => {
    for (const id of ['R-1', 'R-42', 'R-', 'R-1x', 'XR-1', 'R-1 ']) {
      const parsed = parseRoute(`#/timeline?subject=${encodeURIComponent(id)}`);
      expect('subject' in parsed).toBe(RunnerIdSchema.safeParse(id).success);
    }
  });

  test("a task attempt's events are asked for by its task and kept by data.attemptId; a lead attempt is its own subject", () => {
    expect(timelineQuery('R-1')).toEqual({ subject: 'R-1', attemptId: null });
    expect(timelineQuery('T-8-a1')).toEqual({ subject: 'T-8', attemptId: 'T-8-a1' });
    expect(timelineQuery('T-8-e2-a3')).toEqual({ subject: 'T-8', attemptId: 'T-8-e2-a3' });
    expect(timelineQuery('lead-a5')).toEqual({ subject: 'lead-a5', attemptId: null });

    const event = (subject: string | null, data: Record<string, unknown> = {}): HubEvent => ({
      id: 1,
      ts: 0,
      type: 'attempt.wip',
      actor: 'runner:R-1',
      subject,
      data,
    });
    expect(inTimelineSubject(event('R-1'), 'R-1')).toBe(true);
    expect(inTimelineSubject(event('T-8', { runnerId: 'R-1' }), 'R-1')).toBe(false);
    expect(inTimelineSubject(event('T-8', { attemptId: 'T-8-a1' }), 'T-8-a1')).toBe(true);
    expect(inTimelineSubject(event('T-8', { attemptId: 'T-8-a2' }), 'T-8-a1')).toBe(false);
    // The task's own events (a person's move, say) name no attempt.
    expect(inTimelineSubject(event('T-8'), 'T-8-a1')).toBe(false);
    expect(inTimelineSubject(event('lead-a5', { attemptId: 'lead-a5' }), 'lead-a5')).toBe(true);
    expect(inTimelineSubject(event(null), 'lead-a5')).toBe(false);
  });

  test('the navigation lists Approvals right after Runners', () => {
    const views = NAV.map((item) => item.view);
    expect(views.indexOf('approvals')).toBe(views.indexOf('runners') + 1);
    expect(NAV.find((item) => item.view === 'approvals')?.label).toBe('Approvals');
  });
});

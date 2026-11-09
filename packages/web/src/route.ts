import { TARGET_PATTERN, parseAttemptId } from '@agflow/core';

export type Route =
  | { view: 'board' }
  | { view: 'goal' }
  | { view: 'task'; id: string }
  /** Any attempt, a lead's included; the id is one core's parseAttemptId reads. */
  | { view: 'attempt'; id: string }
  | { view: 'agents' }
  | { view: 'runners' }
  /** At core's APPROVALS_ROUTE, which runner notifications print; route.test.ts compares the two (X-48). */
  | { view: 'approvals' }
  | { view: 'messages'; to?: string }
  | { view: 'timeline' }
  | { view: 'knowledge' };

export type NavView = Exclude<Route['view'], 'task' | 'attempt'>;

export const NAV: { view: NavView; label: string }[] = [
  { view: 'board', label: 'Board' },
  { view: 'goal', label: 'Goal' },
  { view: 'agents', label: 'Agents' },
  { view: 'runners', label: 'Runners' },
  { view: 'approvals', label: 'Approvals' },
  { view: 'messages', label: 'Messages' },
  { view: 'timeline', label: 'Timeline' },
  { view: 'knowledge', label: 'Knowledge' },
];

const TASK_ID = /^T-\d+$/;

/** Reads a route from a location hash such as "#/task/T-12", "#/attempt/T-12-a2" or "#/messages?to=lead". */
export function parseRoute(hash: string): Route {
  const [path = '', search = ''] = hash.replace(/^#/, '').split('?', 2);
  const [view, id = ''] = path.split('/').filter(Boolean);
  switch (view) {
    case 'goal':
    case 'agents':
    case 'runners':
    case 'approvals':
    case 'timeline':
    case 'knowledge':
      return { view };
    case 'messages': {
      const to = new URLSearchParams(search).get('to');
      return to && TARGET_PATTERN.test(to) ? { view, to } : { view };
    }
    case 'task':
      return TASK_ID.test(id) ? { view, id } : { view: 'board' };
    case 'attempt':
      return parseAttemptId(id) ? { view, id } : { view: 'board' };
    default:
      return { view: 'board' };
  }
}

export function routeHref(route: Route): string {
  switch (route.view) {
    case 'task':
      return `#/task/${route.id}`;
    case 'attempt':
      return `#/attempt/${route.id}`;
    case 'messages':
      return route.to ? `#/messages?to=${encodeURIComponent(route.to)}` : '#/messages';
    default:
      return `#/${route.view}`;
  }
}

/** The navigation entry to highlight: a task page and a task's attempt belong to the board, a lead's attempt to Agents. */
export function navViewOf(route: Route): NavView {
  switch (route.view) {
    case 'task':
      return 'board';
    case 'attempt':
      return parseAttemptId(route.id)?.taskId === null ? 'agents' : 'board';
    default:
      return route.view;
  }
}

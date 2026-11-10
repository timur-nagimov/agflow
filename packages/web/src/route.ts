import { type HubEvent, TARGET_PATTERN, parseAttemptId } from '@agflow/core';

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
  /** Optionally the events of one runner or one attempt (X-23); timelineQuery says how they are asked for. */
  | { view: 'timeline'; subject?: string }
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
/** Core's RunnerIdSchema, repeated because the web takes no values from core's zod modules (X-48); the test compares. */
const RUNNER_ID = /^R-\d+$/;

/** A subject the timeline can follow: a runner, or an attempt, a lead's included. */
function isTimelineSubject(subject: string): boolean {
  return RUNNER_ID.test(subject) || parseAttemptId(subject) !== null;
}

/** Reads a route from a location hash such as "#/task/T-12", "#/attempt/T-12-a2" or "#/messages?to=lead". */
export function parseRoute(hash: string): Route {
  const [path = '', search = ''] = hash.replace(/^#/, '').split('?', 2);
  const [view, id = ''] = path.split('/').filter(Boolean);
  switch (view) {
    case 'goal':
    case 'agents':
    case 'runners':
    case 'approvals':
    case 'knowledge':
      return { view };
    case 'timeline': {
      const subject = new URLSearchParams(search).get('subject');
      return subject && isTimelineSubject(subject) ? { view, subject } : { view };
    }
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
    case 'timeline':
      return route.subject ? `#/timeline?subject=${encodeURIComponent(route.subject)}` : '#/timeline';
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

/**
 * How the timeline asks for a subject's events (design 6.17, X-23). A runner's and a lead attempt's events carry them
 * as their subject. A task attempt's carry its task, so they are asked for by the task and kept by data.attemptId.
 */
export function timelineQuery(subject: string): { subject: string; attemptId: string | null } {
  const taskId = parseAttemptId(subject)?.taskId ?? null;
  return taskId === null ? { subject, attemptId: null } : { subject: taskId, attemptId: subject };
}

/** Whether an event belongs to the timeline's subject, for the live events that arrive while it is open. */
export function inTimelineSubject(event: Pick<HubEvent, 'subject' | 'data'>, subject: string): boolean {
  const query = timelineQuery(subject);
  if (event.subject !== query.subject) return false;
  return query.attemptId === null || event.data.attemptId === query.attemptId;
}

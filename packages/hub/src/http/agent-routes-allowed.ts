// The only routes a runner agent's token may use (design 6.5): the ones its bridge calls. Every other route answers
// 403 agent_not_allowed, whatever it is or whenever it was added, because the check runs before any route.

/**
 * What the route asks of the agent beyond its token; the route's handler enforces it.
 * - read: any agent may read.
 * - self: it acts on the calling agent's own brief, inbox and messages.
 * - holder: the holder test (requireHolder in tasks.ts).
 * - own: only records of the agent's own attempt.
 * - lead: only while the agent holds the lead seat (design 6.11).
 */
export type AgentRouteAccess = 'read' | 'self' | 'holder' | 'own' | 'lead';

export interface AgentRoute {
  method: 'GET' | 'POST' | 'PATCH';
  /** A Hono pattern; a ':name' parameter matches exactly one path segment. */
  path: string;
  access: AgentRouteAccess;
}

const HOLDER_ACTIONS = ['progress', 'handoff', 'submit', 'block', 'impossible', 'release'];
const LEAD_TASK_ACTIONS = ['cancel', 'accept', 'reject', 'unblock', 'merged'];

export const AGENT_ROUTES: readonly AgentRoute[] = [
  { method: 'POST', path: '/api/fetch-submission', access: 'lead' },
  { method: 'GET', path: '/api/fetch-submission/:id', access: 'lead' },
  { method: 'GET', path: '/api/brief', access: 'self' },
  { method: 'GET', path: '/api/goal', access: 'read' },
  { method: 'GET', path: '/api/status', access: 'read' },
  { method: 'GET', path: '/api/search', access: 'read' },
  { method: 'GET', path: '/api/events', access: 'read' },
  { method: 'GET', path: '/api/tasks', access: 'read' },
  { method: 'GET', path: '/api/tasks/:id', access: 'read' },
  ...HOLDER_ACTIONS.map((action): AgentRoute => ({ method: 'POST', path: `/api/tasks/:id/${action}`, access: 'holder' })),
  { method: 'GET', path: '/api/submissions/:id', access: 'own' },
  { method: 'POST', path: '/api/prepare', access: 'own' },
  { method: 'GET', path: '/api/prepare/:id', access: 'own' },
  { method: 'POST', path: '/api/inbox', access: 'self' },
  { method: 'POST', path: '/api/inbox/ack', access: 'self' },
  { method: 'POST', path: '/api/messages', access: 'self' },
  { method: 'POST', path: '/api/tasks', access: 'lead' },
  { method: 'PATCH', path: '/api/tasks/:id', access: 'lead' },
  ...LEAD_TASK_ACTIONS.map((action): AgentRoute => ({ method: 'POST', path: `/api/tasks/:id/${action}`, access: 'lead' })),
  { method: 'POST', path: '/api/goal/notes', access: 'lead' },
  { method: 'POST', path: '/api/staffing', access: 'lead' },
  { method: 'POST', path: '/api/agents/:id/stop', access: 'lead' },
  { method: 'POST', path: '/api/agents/:id/replace', access: 'lead' },
  { method: 'POST', path: '/api/lead/handoff', access: 'lead' },
  { method: 'GET', path: '/api/lead/notes', access: 'lead' },
];

const segments = (path: string): string[] => path.split('/');

const COMPILED = AGENT_ROUTES.map((route) => ({ route, segments: segments(route.path) }));

function matches(pattern: string[], path: string[]): boolean {
  if (pattern.length !== path.length) return false;
  return pattern.every((part, index) => {
    const actual = path[index] as string;
    return part.startsWith(':') ? actual !== '' : part === actual;
  });
}

/** The allowlist entry for a request, matched like the router matches it; HEAD is answered by GET routes. */
export function agentRouteFor(method: string, path: string): AgentRoute | null {
  const verb = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
  const parts = segments(path);
  return COMPILED.find((entry) => entry.route.method === verb && matches(entry.segments, parts))?.route ?? null;
}

export function isAgentRouteAllowed(method: string, path: string): boolean {
  return agentRouteFor(method, path) !== null;
}

import type {
  AccountQuota,
  Agent,
  AgentRole,
  Approval,
  Attempt,
  AttemptLogEntry,
  AttemptStatus,
  DiffLine,
  GoalNote,
  GoalVersion,
  HubEvent,
  HubStatus,
  Message,
  MessageView,
  NewTaskInput,
  Project,
  Runner,
  RunnerSettings,
  SearchResult,
  Task,
  TaskDetail,
} from '@agflow/core';
import { TASK_ACTIONS, type TaskAction } from './format';

export interface Me {
  user: string;
  via: 'web' | 'cli';
  agent: Agent | null;
}

export interface AuthConfig {
  mode: 'dev' | 'github';
  project: string;
}

export interface GoalState {
  current: GoalVersion | null;
  notes: GoalNote[];
}

export type EventQuery = { after?: number; limit?: number; subject?: string; latest?: boolean };
export type MessageQuery = { target?: string; taskId?: string; limit?: number };
export type NewMessage = { to: string; body: string; taskId?: string; standingRule?: boolean };

/** GET /api/runners: every runner, and the accounts their vendors share. */
export interface RunnerList {
  runners: Runner[];
  accounts: AccountQuota[];
}

/** The owner's changes to a runner's settings (PATCH /api/runners/:id); the hub bumps the version. */
export type RunnerPatch = Partial<Omit<RunnerSettings, 'version'>>;

/** GET /api/attempts filters; status takes several values, and the hub answers newest first. */
export type AttemptQuery = { task?: string; role?: AgentRole; status?: AttemptStatus[]; runner?: string; limit?: number };

/** GET /api/attempts/:id. */
export interface AttemptDetail {
  attempt: Attempt;
  log: AttemptLogEntry[];
}

/**
 * The body of each runner-agent route under /api/agents/:id/, as core's AgentStopInputSchema and
 * AgentReplaceInputSchema take it: stop and replace need a reason, only stop holds ("stop and hold"), and interrupt
 * takes none. Core has no plain type for them, so they are written out here; the hub stays the validator.
 */
export interface AgentActionBodies {
  interrupt: Record<string, never>;
  stop: { reason: string; hold?: boolean };
  replace: { reason: string };
}
export type AgentAction = keyof AgentActionBodies;

/** Where a hand-back takes the work from: the runner's clone, or a pushed ref at a full 40-hex sha. */
export type HandbackSource = 'clone' | { ref: string; sha: string };

/** An error answer from the hub, carrying its message for people. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

type QueryValue = string | number | boolean | readonly string[] | undefined;

/**
 * Skips empty values; a list becomes the comma list the hub's filters take (`status=starting,running`). The hub
 * decodes "%2C" and "," alike, so commas are left readable; a "%2C" typed by someone is encoded as "%252C" and stays
 * apart. URLSearchParams also turns a lone surrogate into U+FFFD, where encodeURIComponent would throw.
 */
function queryString(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === false || value === '') continue;
    if (typeof value === 'object') {
      if (value.length > 0) search.set(key, value.join(','));
      continue;
    }
    search.set(key, value === true ? '1' : String(value));
  }
  const text = search.toString().replaceAll('%2C', ',');
  return text ? `?${text}` : '';
}

/** The hub's REST API. `onUnauthorized` runs when the session has ended. */
export function createApi(fetchFn: FetchFn, onUnauthorized: () => void = () => {}) {
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetchFn(path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await response.text();
    let json: unknown = null;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch {
      json = null;
    }
    if (!response.ok) {
      if (response.status === 401) onUnauthorized();
      const error = (json ?? {}) as { error?: string; message?: string };
      throw new ApiError(response.status, error.error ?? 'http_error', error.message ?? `${method} ${path} failed (${response.status})`);
    }
    return json as T;
  }

  return {
    authConfig: () => request<AuthConfig>('GET', '/api/auth-config'),
    me: () => request<Me>('GET', '/api/me'),
    signOut: () => request<{ ok: true }>('POST', '/auth/logout'),

    status: () => request<HubStatus>('GET', '/api/status'),
    setPaused: (paused: boolean) => request<Project>('POST', '/api/project/pause', { paused }),
    setRunnerLeads: (runnerLeads: boolean) => request<Project>('PATCH', '/api/project', { runnerLeads }),

    goal: () => request<GoalState>('GET', '/api/goal'),
    goalHistory: async () => (await request<{ versions: GoalVersion[] }>('GET', '/api/goal/history')).versions,
    goalDiff: async (from: number, to: number) =>
      (await request<{ lines: DiffLine[] }>('GET', `/api/goal/diff${queryString({ from, to })}`)).lines,
    saveGoal: (text: string, baseVersion: number) => request<GoalVersion>('PUT', '/api/goal', { text, baseVersion }),

    tasks: async () => (await request<{ tasks: Task[] }>('GET', '/api/tasks')).tasks,
    task: (id: string) => request<TaskDetail>('GET', `/api/tasks/${encodeURIComponent(id)}`),
    createTask: async (input: NewTaskInput) => {
      const { tasks } = await request<{ tasks: Task[] }>('POST', '/api/tasks', { tasks: [input] });
      return tasks[0] as Task;
    },
    taskAction: async (id: string, action: TaskAction, body: Record<string, string>) =>
      (await request<{ task: Task }>('POST', `/api/tasks/${encodeURIComponent(id)}/${TASK_ACTIONS[action].path}`, body)).task,

    takeOver: async (taskId: string) =>
      (await request<{ attemptId: string }>('POST', `/api/tasks/${encodeURIComponent(taskId)}/takeover`, {})).attemptId,
    handBack: async (taskId: string, source: HandbackSource) =>
      (await request<{ attemptId: string }>('POST', `/api/tasks/${encodeURIComponent(taskId)}/handback`, { source }))
        .attemptId,

    agents: async () => (await request<{ agents: Agent[] }>('GET', '/api/agents')).agents,
    /** Interrupt answers only that it was sent (null); stop and replace answer the attempt they stopped. */
    agentAction: async <A extends AgentAction>(
      id: string,
      action: A,
      ...[body]: A extends 'interrupt' ? [] : [AgentActionBodies[A]]
    ): Promise<A extends 'interrupt' ? null : Attempt> => {
      const path = `/api/agents/${encodeURIComponent(id)}/${action}`;
      const { attempt } = await request<{ attempt?: Attempt }>('POST', path, body ?? {});
      return (attempt ?? null) as A extends 'interrupt' ? null : Attempt;
    },

    runners: () => request<RunnerList>('GET', '/api/runners'),
    updateRunner: async (id: string, patch: RunnerPatch) =>
      (await request<{ runner: Runner }>('PATCH', `/api/runners/${encodeURIComponent(id)}`, patch)).runner,
    retireRunner: async (id: string): Promise<void> => {
      await request<{ ok: true }>('DELETE', `/api/runners/${encodeURIComponent(id)}`);
    },

    attempts: async (query: AttemptQuery = {}) =>
      (await request<{ attempts: Attempt[] }>('GET', `/api/attempts${queryString(query)}`)).attempts,
    attempt: (id: string) => request<AttemptDetail>('GET', `/api/attempts/${encodeURIComponent(id)}`),

    approvals: async (status: Approval['status'][] = []) =>
      (await request<{ approvals: Approval[] }>('GET', `/api/approvals${queryString({ status })}`)).approvals,
    decideApproval: async (id: string, decision: 'approve' | 'decline') =>
      (await request<{ approval: Approval }>('POST', `/api/approvals/${encodeURIComponent(id)}`, { decision })).approval,

    messages: async (query: MessageQuery = {}) =>
      (await request<{ messages: MessageView[] }>('GET', `/api/messages${queryString(query)}`)).messages,
    sendMessage: async (message: NewMessage) =>
      (await request<{ message: Message }>('POST', '/api/messages', message)).message,
    rules: async () => (await request<{ rules: Message[] }>('GET', '/api/rules')).rules,
    removeRule: (id: number) => request<{ ok: true }>('DELETE', `/api/rules/${id}`),

    events: async (query: EventQuery = {}) =>
      (await request<{ events: HubEvent[] }>('GET', `/api/events${queryString(query)}`)).events,
    search: (q: string) => request<SearchResult>('GET', `/api/search${queryString({ q })}`),
  };
}

export type Api = ReturnType<typeof createApi>;

let sessionEnded: () => void = () => {};

/** Registers what to do when any request finds the session gone (the app shows the sign-in page). */
export function onSessionEnded(listener: () => void): void {
  sessionEnded = listener;
}

export const api: Api = createApi((input, init) => fetch(input, init), () => sessionEnded());

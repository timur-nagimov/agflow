import type {
  Agent,
  DiffLine,
  GoalNote,
  GoalVersion,
  HubEvent,
  HubStatus,
  Message,
  MessageView,
  NewTaskInput,
  Project,
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

function queryString(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === false || value === '') continue;
    search.set(key, value === true ? '1' : String(value));
  }
  const text = search.toString();
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

    agents: async () => (await request<{ agents: Agent[] }>('GET', '/api/agents')).agents,

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

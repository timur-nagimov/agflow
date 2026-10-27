import type {
  Agent,
  AgentRole,
  GoalNote,
  GoalVersion,
  HubEvent,
  HubStatus,
  LiveInbox,
  LivePeek,
  Message,
  NewTaskInput,
  SearchResult,
  StopCheckResult,
  Task,
  TaskDetail,
  TaskPatch,
  TaskStatus,
  Vendor,
} from '@agflow/core';

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class HubClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HubClientError';
  }
}

export interface HubClientOptions {
  baseUrl: string;
  token?: string | undefined;
  agentId?: string | undefined;
  fetch?: FetchFn | undefined;
  timeoutMs?: number | undefined;
}

export type CliLoginPoll = { status: 'pending' } | { status: 'expired' } | { status: 'approved'; token: string; user: string };

export interface SubmitBody {
  summary: string;
  evidence: string[];
  branch?: string | undefined;
  headSha?: string | undefined;
}

export interface MessageBody {
  to: string;
  body: string;
  taskId?: string | undefined;
  replyTo?: number | undefined;
}

const q = encodeURIComponent;

export class HubClient {
  readonly baseUrl: string;
  agentId: string | undefined;
  private readonly token: string | undefined;
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;

  constructor(options: HubClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.agentId = options.agentId;
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (this.agentId) headers['x-agflow-agent'] = this.agentId;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new HubClientError(0, 'unreachable', `cannot reach the agflow hub at ${this.baseUrl}: ${reason}`);
    }
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!response.ok) {
      const error = (json ?? {}) as { error?: string; message?: string };
      throw new HubClientError(
        response.status,
        error.error ?? 'http_error',
        error.message ?? `${method} ${path} failed with HTTP ${response.status}`,
      );
    }
    return json as T;
  }

  // Sign-in
  authConfig() {
    return this.request<{ mode: 'github' | 'dev'; project: string }>('GET', '/api/auth-config');
  }
  me() {
    return this.request<{ user: string; via: 'web' | 'cli'; agent: Agent | null }>('GET', '/api/me');
  }
  pollCliLogin(code: string) {
    return this.request<CliLoginPoll>('GET', `/api/cli-login/poll?code=${q(code)}`);
  }

  // Live sessions (hooks)
  sessionStart(input: { vendor: Vendor; sessionId: string; role: AgentRole; label?: string | undefined }) {
    return this.request<{ agentId: string; role: AgentRole; brief: string }>('POST', '/api/live/session-start', input);
  }
  hello(code: string) {
    return this.request<{ agentId: string; role: AgentRole; vendor: Vendor }>('POST', '/api/live/hello', { code });
  }
  liveInbox(vendor: Vendor, sessionId: string) {
    return this.request<LiveInbox>('GET', `/api/live/inbox?vendor=${vendor}&sessionId=${q(sessionId)}`);
  }
  peek(vendor: Vendor, sessionId: string) {
    return this.request<LivePeek>('GET', `/api/live/peek?vendor=${vendor}&sessionId=${q(sessionId)}`);
  }
  stopCheck(input: { vendor: Vendor; sessionId: string; stopHookActive: boolean }) {
    return this.request<StopCheckResult>('POST', '/api/live/stop-check', input);
  }

  // Reading
  status() {
    return this.request<HubStatus>('GET', '/api/status');
  }
  goal() {
    return this.request<{ current: GoalVersion | null; notes: GoalNote[] }>('GET', '/api/goal');
  }
  tasks(status?: TaskStatus[]) {
    const query = status && status.length > 0 ? `?status=${status.join(',')}` : '';
    return this.request<{ tasks: Task[] }>('GET', `/api/tasks${query}`);
  }
  task(id: string) {
    return this.request<TaskDetail>('GET', `/api/tasks/${q(id)}`);
  }
  brief() {
    return this.request<{ brief: string }>('GET', '/api/brief');
  }
  search(query: string) {
    return this.request<SearchResult>('GET', `/api/search?q=${q(query)}`);
  }
  events(after = 0, limit = 50) {
    return this.request<{ events: HubEvent[] }>('GET', `/api/events?after=${after}&limit=${limit}`);
  }

  // Messages
  takeInbox() {
    return this.request<{ messages: Message[] }>('POST', '/api/inbox');
  }
  ack(ids: number[]) {
    return this.request<{ ok: true }>('POST', '/api/inbox/ack', { ids });
  }
  send(body: MessageBody) {
    return this.request<{ message: Message }>('POST', '/api/messages', body);
  }

  // Working on a task
  claim(id: string, branch?: string) {
    return this.request<{ task: Task }>('POST', `/api/tasks/${q(id)}/claim`, { branch });
  }
  resumeClaim(id: string) {
    return this.request<{ task: Task }>('POST', `/api/tasks/${q(id)}/resume-claim`);
  }
  progress(id: string, note: string) {
    return this.request<{ task: Task }>('POST', `/api/tasks/${q(id)}/progress`, { note });
  }
  handoff(id: string, note: string) {
    return this.request<{ ok: true }>('POST', `/api/tasks/${q(id)}/handoff`, { note });
  }
  submit(id: string, body: SubmitBody) {
    return this.request<{ task: Task }>('POST', `/api/tasks/${q(id)}/submit`, body);
  }
  block(id: string, reason: string) {
    return this.request<{ task: Task }>('POST', `/api/tasks/${q(id)}/block`, { reason });
  }
  impossible(id: string, evidence: string) {
    return this.request<{ task: Task }>('POST', `/api/tasks/${q(id)}/impossible`, { evidence });
  }
  release(id: string, reason: string) {
    return this.request<{ task: Task }>('POST', `/api/tasks/${q(id)}/release`, { reason });
  }

  // Lead
  createTasks(tasks: NewTaskInput[]) {
    return this.request<{ tasks: Task[] }>('POST', '/api/tasks', { tasks });
  }
  updateTask(id: string, patch: TaskPatch) {
    return this.request<{ task: Task }>('PATCH', `/api/tasks/${q(id)}`, patch);
  }
  cancel(id: string, reason: string) {
    return this.request<{ task: Task }>('POST', `/api/tasks/${q(id)}/cancel`, { reason });
  }
  accept(id: string, note?: string) {
    return this.request<{ task: Task }>('POST', `/api/tasks/${q(id)}/accept`, { note });
  }
  reject(id: string, feedback: string) {
    return this.request<{ task: Task }>('POST', `/api/tasks/${q(id)}/reject`, { feedback });
  }
  unblock(id: string, note?: string) {
    return this.request<{ task: Task }>('POST', `/api/tasks/${q(id)}/unblock`, { note });
  }
  markMerged(id: string, sha?: string) {
    return this.request<{ task: Task }>('POST', `/api/tasks/${q(id)}/merged`, { sha });
  }
  addGoalNote(text: string) {
    return this.request<GoalNote>('POST', '/api/goal/notes', { text });
  }
}

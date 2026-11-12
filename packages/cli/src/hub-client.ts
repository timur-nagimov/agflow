import {
  type AgentStopInputSchema,
  BRIDGE_HEADER,
  BRIDGE_VERSION,
  type RunnerRetireInputSchema,
  type RunnerSubmitInputSchema,
  type StaffingInputSchema,
  WhoamiResponseSchema,
} from '@agflow/core';
import type {
  Agent,
  AgentRole,
  Attempt,
  FetchSubmissionRequest,
  GoalNote,
  GoalVersion,
  HubEvent,
  HubStatus,
  LeadNote,
  LiveInbox,
  LivePeek,
  Message,
  NewTaskInput,
  PrepareRequest,
  SearchResult,
  StopCheckResult,
  SubmissionRecord,
  Task,
  TaskDetail,
  TaskPatch,
  TaskStatus,
  Vendor,
} from '@agflow/core';
import type { z } from 'zod';

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class HubClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** The reason of the hub's body: the attempt's end reason for 401 attempt_ended, null when it gave none. */
    readonly reason: string | null = null,
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

/** A runner agent's submit: the runner pushes the branch the hub gave its attempt, so it names no branch or head. */
export type RunnerSubmitBody = z.input<typeof RunnerSubmitInputSchema>;
export type StaffingBody = z.input<typeof StaffingInputSchema>;
export type AgentStopBody = z.input<typeof AgentStopInputSchema>;

export interface MessageBody {
  to: string;
  body: string;
  taskId?: string | undefined;
  replyTo?: number | undefined;
}

const q = encodeURIComponent;

/** The hub takes every bearer with this prefix for a runner agent's token (design 6.5). */
const AGENT_TOKEN_PREFIX = 'agt_';

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

  /** Whether the bearer is a runner agent's token, which names the agent itself. */
  get viaAgentToken(): boolean {
    return this.token?.startsWith(AGENT_TOKEN_PREFIX) ?? false;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    // The bridge header tells the hub this client can start a live claim from a WIP ref (design 10).
    const headers: Record<string, string> = { accept: 'application/json', [BRIDGE_HEADER]: String(BRIDGE_VERSION) };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    // The hub refuses X-Agflow-Agent next to an agent token.
    if (this.agentId && !this.viaAgentToken) headers['x-agflow-agent'] = this.agentId;
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
      const error = (json ?? {}) as { error?: string; message?: string; reason?: unknown };
      throw new HubClientError(
        response.status,
        error.error ?? 'http_error',
        error.message ?? `${method} ${path} failed with HTTP ${response.status}`,
        typeof error.reason === 'string' ? error.reason : null,
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

  // Runner
  async runnerWhoami() {
    return WhoamiResponseSchema.parse(await this.request('GET', '/api/runner/whoami'));
  }
  retireRunner(runnerKey: string) {
    const body: z.input<typeof RunnerRetireInputSchema> = { runnerKey };
    return this.request<{ ok: boolean }>('POST', '/api/runner/retire', body);
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

  // A runner agent (design 6.13, 7.7): a submit the runner pushes, and dependency preparation, each polled until done
  submitWork(id: string, body: RunnerSubmitBody) {
    return this.request<{ submission: SubmissionRecord }>('POST', `/api/tasks/${q(id)}/submit`, body);
  }
  submission(id: string) {
    return this.request<{ submission: SubmissionRecord }>('GET', `/api/submissions/${q(id)}`);
  }
  requestPrepare() {
    return this.request<{ request: PrepareRequest }>('POST', '/api/prepare', {});
  }
  prepareRequest(id: string) {
    return this.request<{ request: PrepareRequest }>('GET', `/api/prepare/${q(id)}`);
  }

  requestSubmissionFetch(taskId: string) {
    return this.request<{ request: FetchSubmissionRequest }>('POST', '/api/fetch-submission', { task_id: taskId });
  }
  submissionFetch(id: string) {
    return this.request<{ request: FetchSubmissionRequest }>('GET', `/api/fetch-submission/${q(id)}`);
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
  staffing(body: StaffingBody) {
    return this.request<{ running: number; target: number }>('POST', '/api/staffing', body);
  }
  stopAgent(agentId: string, body: AgentStopBody) {
    return this.request<{ attempt: Attempt }>('POST', `/api/agents/${q(agentId)}/stop`, body);
  }
  replaceAgent(agentId: string, reason: string) {
    return this.request<{ attempt: Attempt }>('POST', `/api/agents/${q(agentId)}/replace`, { reason });
  }
  leadHandoff(note: string) {
    return this.request<{ ok: true }>('POST', '/api/lead/handoff', { note });
  }
  leadNotes() {
    return this.request<{ notes: LeadNote[] }>('GET', '/api/lead/notes');
  }
}

// A person's API client (design 6.16, 6.17): signed in through dev sign-in with a browser session, as the web UI is,
// so it may do what only people in the browser do (take over, hand back, act on agents, turn runner leads off). It
// wraps the M1 and M2 routes the scenarios call. The M2 answers parse with core's response schemas, so a hub that
// drifts from the contract fails the harness; M1's answers have core types only. Every unexpected status throws a
// HubCallError that carries the method, the path, the status and the body.
import { randomUUID } from 'node:crypto';
import {
  type AccountQuota,
  type AgentRole,
  type Attempt,
  type AttemptLogEntry,
  AttemptDetailResponseSchema,
  AttemptResponseSchema,
  AttemptsResponseSchema,
  type GoalVersion,
  type HubEvent,
  type HubStatus,
  type LeadNote,
  LeadNotesResponseSchema,
  type Message,
  type MessageView,
  type NewTaskInput,
  OkResponseSchema,
  type Project,
  ProjectSchema,
  type Runner,
  RunnersResponseSchema,
  type Task,
  type TaskDetail,
  TakeoverResponseSchema,
} from '@agflow/core';
import type { CliLoginPoll } from '../../../hub/src/auth';

/** A hub answer with a status the call did not expect, or a hub the call could not reach (status 0). */
export class HubCallError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(status === 0 ? `${method} ${path} failed: ${body}` : `${method} ${path} answered ${status}: ${body}`);
    this.name = 'HubCallError';
  }
}

/** Each call gives up after this long; scenarios wait on state with deadlines of their own. */
const CALL_TIMEOUT_MS = 30_000;
/** How long cliToken polls an approved login, which the hub answers at once. */
const POLL_TIMEOUT_MS = 10_000;

type Query = Record<string, string | number | boolean | undefined>;

function withQuery(path: string, query: Query = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `${path}?${text}` : path;
}

interface CallOptions {
  body?: unknown;
  /** The statuses that count as success; [200] by default. */
  expect?: readonly number[];
  headers?: Record<string, string>;
}

/** One call to the hub; the parsed JSON answer, or a HubCallError for any other status. */
async function call(hubUrl: string, method: string, path: string, options: CallOptions = {}): Promise<unknown> {
  const headers: Record<string, string> = { accept: 'application/json', ...options.headers };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  let response: Response;
  try {
    response = await fetch(`${hubUrl}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: 'manual',
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch (error) {
    throw new HubCallError(method, path, 0, error instanceof Error ? error.message : String(error));
  }
  const text = await response.text();
  if (!(options.expect ?? [200]).includes(response.status)) throw new HubCallError(method, path, response.status, text);
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new HubCallError(method, path, response.status, `not JSON: ${text}`);
  }
}

export interface AttemptsQuery {
  task?: string;
  role?: AgentRole;
  runner?: string;
  /** One status, or several. */
  status?: Attempt['status'] | Attempt['status'][];
  limit?: number;
}

export interface EventsQuery {
  after?: number;
  subject?: string;
  limit?: number;
  /** The newest events first. */
  latest?: boolean;
}

export interface MessagesQuery {
  taskId?: string;
  target?: string;
  limit?: number;
}

export interface SendMessage {
  /** lead, all, humans, agent:A-<n> or task:T-<n>. */
  to: string;
  body: string;
  taskId?: string;
}

/** POST /api/tasks/:id/handback: from the runner's clone, or from a pushed ref with its full sha. */
export type HandbackSource = 'clone' | { ref: string; sha: string };

export interface AgentStopInput {
  reason: string;
  /** Stop and hold, so a person can still take the clone over. */
  hold?: boolean;
}

export interface Person {
  readonly login: string;
  readonly hubUrl: string;
  /** Any call with the person's session, for routes the wrappers leave out. */
  request(method: string, path: string, options?: CallOptions): Promise<unknown>;

  // M1
  status(): Promise<HubStatus>;
  project(): Promise<Project>;
  /** Saves a new goal version on top of the current one. */
  setGoal(text: string): Promise<GoalVersion>;
  createTasks(tasks: NewTaskInput[]): Promise<Task[]>;
  /** The task with its notes, events, messages, attempts and submissions. */
  task(id: string): Promise<TaskDetail>;
  accept(taskId: string, note?: string): Promise<Task>;
  unblock(taskId: string, note?: string): Promise<Task>;
  send(message: SendMessage): Promise<Message>;
  /** Newest first, each with its deliveries. */
  messages(query?: MessagesQuery): Promise<MessageView[]>;
  events(query?: EventsQuery): Promise<HubEvent[]>;

  // M2
  runners(): Promise<{ runners: Runner[]; accounts: AccountQuota[] }>;
  setRunnerLeads(on: boolean): Promise<Project>;
  /** Newest first. */
  attempts(query?: AttemptsQuery): Promise<Attempt[]>;
  attempt(id: string): Promise<{ attempt: Attempt; log: AttemptLogEntry[] }>;
  leadNotes(): Promise<LeadNote[]>;
  /** 202: the attempt taken over. */
  takeover(taskId: string): Promise<string>;
  /** 202: the attempt whose work is handed back. */
  handback(taskId: string, source: HandbackSource): Promise<string>;
  /** 200, or 202 while a pending submission defers the stop. */
  stopAgent(agentId: string, input: AgentStopInput): Promise<Attempt>;
  replaceAgent(agentId: string, reason: string): Promise<Attempt>;
  interruptAgent(agentId: string): Promise<void>;
}

/** Signs the person in through dev sign-in and keeps the session cookie, as a browser does. */
export async function signIn(hubUrl: string, login: string): Promise<Person> {
  const path = `/auth/dev?user=${encodeURIComponent(login)}`;
  let response: Response;
  try {
    response = await fetch(`${hubUrl}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
  } catch (error) {
    throw new HubCallError('GET', path, 0, error instanceof Error ? error.message : String(error));
  }
  const text = await response.text();
  // The cookie's name=value, without its attributes, is what a browser sends back.
  const cookie = response.headers.getSetCookie()[0]?.split(';')[0];
  if (response.status !== 302 || !cookie) throw new HubCallError('GET', path, response.status, text);
  return createPerson(hubUrl, login, cookie);
}

function createPerson(hubUrl: string, login: string, cookie: string): Person {
  const request = (method: string, path: string, options: CallOptions = {}) =>
    call(hubUrl, method, path, { ...options, headers: { cookie, ...options.headers } });
  const get = (path: string, query?: Query) => request('GET', withQuery(path, query));
  const post = (path: string, body: unknown, expect?: readonly number[]) => request('POST', path, { body, expect });
  const task = (id: string) => `/api/tasks/${encodeURIComponent(id)}`;
  const agent = (id: string) => `/api/agents/${encodeURIComponent(id)}`;

  return {
    login,
    hubUrl,
    request,

    status: async () => (await get('/api/status')) as HubStatus,
    project: async () => ProjectSchema.parse(await get('/api/project')),
    async setGoal(text) {
      const { current } = (await get('/api/goal')) as { current: GoalVersion | null };
      const body = { text, baseVersion: current?.version ?? 0 };
      return (await request('PUT', '/api/goal', { body })) as GoalVersion;
    },
    createTasks: async (tasks) => ((await post('/api/tasks', { tasks }, [201])) as { tasks: Task[] }).tasks,
    task: async (id) => (await get(task(id))) as TaskDetail,
    accept: async (id, note) => ((await post(`${task(id)}/accept`, { note })) as { task: Task }).task,
    unblock: async (id, note) => ((await post(`${task(id)}/unblock`, { note })) as { task: Task }).task,
    send: async (message) => ((await post('/api/messages', message, [201])) as { message: Message }).message,
    messages: async (query = {}) => ((await get('/api/messages', { ...query })) as { messages: MessageView[] }).messages,
    events: async (query = {}) => {
      const { latest, ...rest } = query;
      return ((await get('/api/events', { ...rest, latest: latest ? 1 : undefined })) as { events: HubEvent[] }).events;
    },

    runners: async () => RunnersResponseSchema.parse(await get('/api/runners')),
    setRunnerLeads: async (on) =>
      ProjectSchema.parse(await request('PATCH', '/api/project', { body: { runnerLeads: on } })),
    attempts: async (query = {}) => {
      const status = Array.isArray(query.status) ? query.status.join(',') : query.status;
      return AttemptsResponseSchema.parse(await get('/api/attempts', { ...query, status })).attempts;
    },
    attempt: async (id) => AttemptDetailResponseSchema.parse(await get(`/api/attempts/${encodeURIComponent(id)}`)),
    leadNotes: async () => LeadNotesResponseSchema.parse(await get('/api/lead/notes')).notes,
    takeover: async (id) => TakeoverResponseSchema.parse(await post(`${task(id)}/takeover`, undefined, [202])).attemptId,
    handback: async (id, source) =>
      TakeoverResponseSchema.parse(await post(`${task(id)}/handback`, { source }, [202])).attemptId,
    stopAgent: async (id, input) =>
      AttemptResponseSchema.parse(await post(`${agent(id)}/stop`, input, [200, 202])).attempt,
    replaceAgent: async (id, reason) =>
      AttemptResponseSchema.parse(await post(`${agent(id)}/replace`, { reason }, [200, 202])).attempt,
    interruptAgent: async (id) => {
      OkResponseSchema.parse(await post(`${agent(id)}/interrupt`, undefined));
    },
  };
}

/**
 * A CLI token for the person, as `agflow login` gets one: the person approves a fresh code with the browser session,
 * and the CLI side polls for the token. Each runner owner's runner links with it.
 */
export async function cliToken(person: Person, label = 'agflow e2e runner'): Promise<string> {
  const code = randomUUID();
  await person.request('POST', '/api/cli-login/approve', { body: { code, label } });
  const path = `/api/cli-login/poll?code=${code}`;
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const poll = (await call(person.hubUrl, 'GET', path)) as CliLoginPoll;
    if (poll.status === 'approved') return poll.token;
    if (poll.status === 'expired' || Date.now() > deadline) {
      throw new HubCallError('GET', path, 200, JSON.stringify(poll));
    }
    await Bun.sleep(100);
  }
}

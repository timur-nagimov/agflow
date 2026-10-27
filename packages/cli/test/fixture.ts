import type { AgentRole, Vendor } from '@agflow/core';
import { startLiveSession } from '@agflow/hub/src/agents';
import { createSession } from '@agflow/hub/src/auth';
import { type HubConfig, type HubContext, createContext } from '@agflow/hub/src/context';
import { type App, createApp } from '@agflow/hub/src/http/app';
import { type FetchFn, HubClient } from '../src/hub-client';

export const HUB_URL = 'http://hub.test';

export interface LiveAgent {
  agentId: string;
  sessionId: string;
  helloCode: string;
  client: HubClient;
}

export interface HubFixture {
  ctx: HubContext;
  app: App;
  clock: { t: number };
  fetch: FetchFn;
  tokenFor(user: string, kind?: 'cli' | 'web'): string;
  client(user?: string, agentId?: string): HubClient;
  /** Registers a live session the way the SessionStart hook does; the returned client is already bound. */
  liveAgent(user?: string, role?: AgentRole, vendor?: Vendor): LiveAgent;
}

let sessions = 0;

export function hubFixture(overrides: Partial<HubConfig> = {}): HubFixture {
  const clock = { t: Date.UTC(2026, 9, 27, 12, 0, 0) };
  const config: HubConfig = {
    publicUrl: HUB_URL,
    auth: 'dev',
    allowedUsers: ['alice', 'bob'],
    projectName: 'demo',
    projectRepo: 'https://github.com/acme/demo',
    leaseMs: 2 * 60 * 60_000,
    reminderMs: 30 * 60_000,
    maxOpenTasks: 200,
    maxTasksPerHour: 60,
    secureCookies: false,
    ...overrides,
  };
  const ctx = createContext({ dbPath: ':memory:', config, now: () => clock.t });
  const app = createApp(ctx);
  const fetchFn: FetchFn = async (input, init) => app.request(input instanceof Request ? input : String(input), init);
  const tokens = new Map<string, string>();
  const tokenFor = (user: string, kind: 'cli' | 'web' = 'cli') => {
    const key = `${user}:${kind}`;
    let token = tokens.get(key);
    if (!token) {
      token = createSession(ctx, user, kind);
      tokens.set(key, token);
    }
    return token;
  };
  const client = (user = 'alice', agentId?: string) =>
    new HubClient({ baseUrl: HUB_URL, token: tokenFor(user), agentId, fetch: fetchFn });
  const liveAgent = (user = 'alice', role: AgentRole = 'worker', vendor: Vendor = 'claude'): LiveAgent => {
    sessions += 1;
    const sessionId = `session-${sessions}`;
    const started = startLiveSession(ctx, user, { vendor, sessionId, role });
    return { agentId: started.agent.id, sessionId, helloCode: started.helloCode, client: client(user, started.agent.id) };
  };
  return { ctx, app, clock, fetch: fetchFn, tokenFor, client, liveAgent };
}

/** Extracts the hello code from a brief. */
export function helloCodeIn(brief: string): string {
  return brief.match(/code "([A-Z2-9]{6})"/)?.[1] ?? '';
}

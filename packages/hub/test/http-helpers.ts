import type { AgentRole, Vendor } from '@agflow/core';
import { createSession } from '../src/auth';
import type { FetchFn, HubConfig } from '../src/context';
import { createApp } from '../src/http/app';
import { createTestContext } from './helpers';

export interface CallOptions {
  user?: string;
  via?: 'web' | 'cli';
  agent?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface CallResult {
  status: number;
  /** Parsed JSON body; `any` keeps assertions on arbitrary payloads short. */
  json: any;
  headers: Headers;
}

export function createTestHub(overrides: Partial<HubConfig> = {}, fetchFn?: FetchFn) {
  const { ctx, clock } = createTestContext(overrides, fetchFn);
  const app = createApp(ctx);
  const tokens = new Map<string, string>();

  function tokenFor(user: string, via: 'web' | 'cli'): string {
    const key = `${user}:${via}`;
    let token = tokens.get(key);
    if (!token) {
      token = createSession(ctx, user, via);
      tokens.set(key, token);
    }
    return token;
  }

  async function call(method: string, path: string, options: CallOptions = {}): Promise<CallResult> {
    const headers: Record<string, string> = { ...options.headers };
    if (options.user) {
      const via = options.via ?? 'cli';
      const token = tokenFor(options.user, via);
      if (via === 'web') headers.cookie = `agflow_session=${token}`;
      else headers.authorization = `Bearer ${token}`;
    }
    if (options.agent) headers['x-agflow-agent'] = options.agent;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    const response = await app.request(path, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: response.status, json, headers: response.headers };
  }

  /** Registers a live session through the hook endpoint (mounted in Task 23) and returns its agent id. */
  async function liveAgent(user: string, sessionId: string, role: AgentRole = 'worker', vendor: Vendor = 'claude'): Promise<string> {
    const result = await call('POST', '/api/live/session-start', { user, body: { vendor, sessionId, role } });
    if (result.status !== 200) throw new Error(`session-start failed: ${JSON.stringify(result.json)}`);
    return result.json.agentId as string;
  }

  return { ctx, clock, app, call, tokenFor, liveAgent };
}

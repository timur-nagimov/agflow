import type { Agent } from '@agflow/core';
import type { Context } from 'hono';
import { z } from 'zod';
import { badRequest, forbidden, unauthorized, unsupportedMediaType } from '../errors';
import type { AppEnv, Principal } from './app';

export type Ctx = Context<AppEnv>;

export async function readBody<S extends z.ZodType>(c: Ctx, schema: S): Promise<z.output<S>> {
  // Pages on other sites can send text/plain and form bodies without a CORS preflight, but not JSON ones, so a body
  // must be declared as JSON. A missing or unreadable body is left to the parse below.
  const type = c.req.header('content-type')?.split(';')[0].trim().toLowerCase();
  if (type !== 'application/json' && (await c.req.text().catch(() => ''))) {
    throw unsupportedMediaType('the request body must be sent as application/json');
  }
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    throw badRequest('the request body must be JSON');
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw badRequest(z.prettifyError(parsed.error));
  return parsed.data;
}

export function readQuery<S extends z.ZodType>(c: Ctx, schema: S): z.output<S> {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) throw badRequest(z.prettifyError(parsed.error));
  return parsed.data;
}

export function principal(c: Ctx): Principal {
  const p = c.get('principal');
  if (!p) throw unauthorized();
  return p;
}

/** A person signed in to the web UI (cookie session), not an agent. */
export function human(c: Ctx): Principal {
  const p = principal(c);
  if (p.agent || p.via !== 'web') throw forbidden('only a person signed in to the web UI can do this');
  return p;
}

/** The calling agent, named by the X-Agflow-Agent header after hello. */
export function agentOf(c: Ctx): Agent {
  const p = principal(c);
  if (!p.agent) throw forbidden('agents must call hello first; people use the web UI');
  return p.agent;
}

/**
 * The agent acting on a held task, with the agent token it called with (null for a live agent). The holder test
 * resolves the token again inside its transaction (requireHolder).
 */
export function holderOf(c: Ctx): { agent: Agent; token: string | null } {
  const p = principal(c);
  return { agent: agentOf(c), token: p.via === 'agent' ? p.token : null };
}

export function leadOrHuman(c: Ctx): Principal {
  const p = principal(c);
  if (p.agent) {
    if (p.agent.role !== 'lead') throw forbidden('only the lead or a person can do this');
    return p;
  }
  if (p.via !== 'web') throw forbidden('agents must call hello first; people use the web UI');
  return p;
}

export function agentOrHuman(c: Ctx): Principal {
  const p = principal(c);
  if (!p.agent && p.via !== 'web') throw forbidden('agents must call hello first; people use the web UI');
  return p;
}

export function actor(p: Principal): string {
  return p.agent ? `agent:${p.agent.id}` : `user:${p.user}`;
}

export function intParam(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}

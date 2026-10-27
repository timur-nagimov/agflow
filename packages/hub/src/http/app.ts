import { type Agent, TransitionError } from '@agflow/core';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { findAgent, touchAgent } from '../agents';
import { verifySession } from '../auth';
import type { HubContext } from '../context';
import { HubError, forbidden } from '../errors';
import { mountAgentRoutes } from './agent-routes';
import { mountAuthRoutes } from './auth-routes';
import { mountCliLoginPage } from './cli-login-page';
import { mountEventRoutes } from './event-routes';
import { mountGithubRoutes } from './github-routes';
import { mountMessageRoutes } from './message-routes';
import { mountProjectRoutes } from './project-routes';
import { mountStatic } from './static';
import { mountTaskRoutes } from './task-routes';

export const SESSION_COOKIE = 'agflow_session';

export interface Principal {
  user: string;
  via: 'web' | 'cli';
  agent: Agent | null;
  token: string;
}

export type AppEnv = { Variables: { principal: Principal | null } };
export type App = Hono<AppEnv>;

export function resolvePrincipal(
  ctx: HubContext,
  authorization: string | undefined,
  cookie: string | undefined,
  agentId: string | undefined,
): Principal | null {
  const bearer = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : undefined;
  const token = bearer || cookie;
  if (!token) return null;
  const session = verifySession(ctx, token);
  if (!session) return null;
  let agent: Agent | null = null;
  if (agentId) {
    const found = findAgent(ctx, agentId);
    if (!found) throw new HubError(401, 'unknown_agent', `unknown agent ${agentId}; call hello again`);
    if (found.user !== session.user) throw forbidden('this agent belongs to another user');
    touchAgent(ctx, found.id);
    agent = findAgent(ctx, found.id);
  }
  return { user: session.user, via: session.kind, agent, token };
}

export function createApp(ctx: HubContext): App {
  const app = new Hono<AppEnv>();
  app.onError((error, c) => {
    if (error instanceof HubError) return c.json({ error: error.code, message: error.message }, error.status);
    if (error instanceof TransitionError) return c.json({ error: 'invalid_transition', message: error.message }, 409);
    console.error(error);
    return c.json({ error: 'internal', message: 'internal error' }, 500);
  });
  app.notFound((c) => c.json({ error: 'not_found', message: `no route for ${c.req.method} ${c.req.path}` }, 404));
  app.use('*', async (c, next) => {
    c.set(
      'principal',
      resolvePrincipal(ctx, c.req.header('authorization'), getCookie(c, SESSION_COOKIE), c.req.header('x-agflow-agent')),
    );
    await next();
  });
  mountAuthRoutes(app, ctx);
  mountGithubRoutes(app, ctx);
  mountProjectRoutes(app, ctx);
  mountTaskRoutes(app, ctx);
  mountAgentRoutes(app, ctx);
  mountMessageRoutes(app, ctx);
  mountEventRoutes(app, ctx);
  mountCliLoginPage(app, ctx);
  if (ctx.config.webDist) mountStatic(app, ctx.config.webDist);
  return app;
}

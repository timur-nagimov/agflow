import { type Agent, TransitionError } from '@agflow/core';
import { type Context, Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { findAgent, touchAgent } from '../agents';
import { isAgentToken, resolveAgentToken, verifySession } from '../auth';
import type { HubContext } from '../context';
import { HubError, agentNotAllowed, forbidden } from '../errors';
import { mountAgentRoutes } from './agent-routes';
import { isAgentRouteAllowed } from './agent-routes-allowed';
import { mountAttemptRoutes } from './attempt-routes';
import { mountAuthRoutes } from './auth-routes';
import { mountCliLoginPage } from './cli-login-page';
import { mountEventRoutes } from './event-routes';
import { mountGithubRoutes } from './github-routes';
import { mountMessageRoutes } from './message-routes';
import { mountProjectRoutes } from './project-routes';
import { type RunnerLinkUpgrade, mountRunnerRoutes } from './runner-routes';
import { mountStatic } from './static';
import { mountTaskRoutes } from './task-routes';

export const SESSION_COOKIE = 'agflow_session';

export interface Principal {
  user: string;
  /** agent: a runner agent's token, which always names its agent. */
  via: 'web' | 'cli' | 'agent';
  agent: Agent | null;
  token: string;
}

export type AppEnv = { Variables: { principal: Principal | null } };
export type App = Hono<AppEnv>;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function bearerToken(authorization: string | undefined): string | undefined {
  return authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : undefined;
}

/** A URL's origin; null if the URL is malformed or its origin is opaque, so that it never matches an Origin of "null". */
function originOf(url: string): string | null {
  const origin = URL.canParse(url) ? new URL(url).origin : 'null';
  return origin === 'null' ? null : origin;
}

/**
 * Whether a browser sent this request from a page outside the hub. The hub's own pages are at its public URL or at
 * the address the request was sent to (the Host header). Clients that send neither Origin nor Sec-Fetch-Site, such
 * as curl and scripts, are not browsers.
 */
function crossOrigin(c: Context<AppEnv>, hubOrigin: string | null): boolean {
  const site = c.req.header('sec-fetch-site');
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return true;
  const origin = c.req.header('origin');
  if (origin === undefined) return false;
  const host = c.req.header('host');
  const requestOrigin = host ? originOf(`${new URL(c.req.url).protocol}//${host}`) : null;
  return origin !== hubOrigin && origin !== requestOrigin;
}

export function resolvePrincipal(
  ctx: HubContext,
  authorization: string | undefined,
  cookie: string | undefined,
  agentId: string | undefined,
): Principal | null {
  const bearer = bearerToken(authorization);
  // An agent token is never looked up as a session, and it names its own agent.
  if (bearer && isAgentToken(bearer)) {
    if (agentId) throw agentNotAllowed('an agent token names its agent; X-Agflow-Agent is refused with it');
    const grant = resolveAgentToken(ctx, bearer);
    return { user: grant.user, via: 'agent', agent: grant.agent, token: bearer };
  }
  const token = bearer || cookie;
  if (!token) return null;
  const session = verifySession(ctx, token);
  if (!session) return null;
  let agent: Agent | null = null;
  if (agentId) {
    const found = findAgent(ctx, agentId);
    if (!found) throw new HubError(401, 'unknown_agent', `unknown agent ${agentId}; call hello again`);
    if (found.user !== session.user) throw forbidden('this agent belongs to another user');
    // The owner's CLI token must not stand in for a runner agent, whose authority is its own scoped token.
    if (found.origin === 'runner') throw forbidden('a runner agent acts only with its own agent token');
    touchAgent(ctx, found.id);
    agent = findAgent(ctx, found.id);
  }
  return { user: session.user, via: session.kind, agent, token };
}

export interface AppOptions {
  /** Opens runner links; startHub passes its server's. Without it, GET /api/runner/ws upgrades nothing. */
  upgradeRunnerLink?: RunnerLinkUpgrade | undefined;
}

export function createApp(ctx: HubContext, options: AppOptions = {}): App {
  const app = new Hono<AppEnv>();
  const hubOrigin = originOf(ctx.config.publicUrl);
  app.onError((error, c) => {
    if (error instanceof HubError) {
      return c.json({ error: error.code, message: error.message, ...error.extra }, error.status);
    }
    if (error instanceof TransitionError) return c.json({ error: 'invalid_transition', message: error.message }, 409);
    console.error(error);
    return c.json({ error: 'internal', message: 'internal error' }, 500);
  });
  app.notFound((c) => c.json({ error: 'not_found', message: `no route for ${c.req.method} ${c.req.path}` }, 404));
  if (ctx.config.auth === 'dev') {
    // Dev sign-in needs no password. Listening on loopback keeps other machines out, but a web page can still reach
    // the hub through the browser by pointing a domain of its own at 127.0.0.1 (DNS rebinding). The browser then
    // sends that domain in the Host header, so a dev hub answers only requests addressed to loopback or its public URL.
    const hosts = new Set(['localhost', '127.0.0.1', '[::1]', URL.parse(ctx.config.publicUrl)?.hostname]);
    app.use('*', async (c, next) => {
      const host = c.req.header('host');
      const hostname = URL.parse(host === undefined ? c.req.url : `http://${host}`)?.hostname;
      if (!hostname || !hosts.has(hostname)) throw forbidden('a dev hub answers only at localhost or its public URL');
      await next();
    });
  }
  app.use('*', async (c, next) => {
    const authorization = c.req.header('authorization');
    const cookie = getCookie(c, SESSION_COOKIE);
    // SameSite=Lax still sends the cookie with requests from the same site, such as another port on localhost or a
    // sibling subdomain, so a write that relies on the cookie must come from the hub's own pages. Browsers never
    // attach a Bearer token on their own, so the CLI and agents are not checked.
    if (cookie && !bearerToken(authorization) && !SAFE_METHODS.has(c.req.method) && crossOrigin(c, hubOrigin)) {
      throw forbidden('cross-site request refused');
    }
    const principal = resolvePrincipal(ctx, authorization, cookie, c.req.header('x-agflow-agent'));
    // Agent tokens reach only their bridge's routes, checked here so that no route can forget it.
    if (principal?.via === 'agent' && !isAgentRouteAllowed(c.req.method, c.req.path)) {
      throw agentNotAllowed(`an agent token cannot use ${c.req.method} ${c.req.path}`);
    }
    c.set('principal', principal);
    await next();
  });
  mountAuthRoutes(app, ctx);
  mountGithubRoutes(app, ctx);
  mountProjectRoutes(app, ctx);
  mountTaskRoutes(app, ctx);
  mountAgentRoutes(app, ctx);
  mountAttemptRoutes(app, ctx);
  mountMessageRoutes(app, ctx);
  mountEventRoutes(app, ctx);
  mountRunnerRoutes(app, ctx, options.upgradeRunnerLink);
  mountCliLoginPage(app, ctx);
  if (ctx.config.webDist) mountStatic(app, ctx.config.webDist);
  return app;
}

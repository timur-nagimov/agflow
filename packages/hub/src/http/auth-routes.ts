import { CliLoginApproveInputSchema } from '@agflow/core';
import { deleteCookie, setCookie } from 'hono/cookie';
import { SESSION_TTL, approveCliLogin, createSession, deleteSession, pollCliLogin } from '../auth';
import type { HubContext } from '../context';
import { notFound } from '../errors';
import { getProject } from '../project';
import { type App, SESSION_COOKIE } from './app';
import { type Ctx, human, principal, readBody } from './util';

/** Only same-site paths are allowed as post-login redirects. */
export function safeReturnTo(value: string | undefined): string {
  return value?.startsWith('/') && !value.startsWith('//') ? value : '/';
}

export function startWebSession(c: Ctx, ctx: HubContext, user: string, returnTo: string): Response {
  const token = createSession(ctx, user, 'web');
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: ctx.config.secureCookies,
    path: '/',
    maxAge: SESSION_TTL.web / 1000,
  });
  return c.redirect(returnTo);
}

export function mountAuthRoutes(app: App, ctx: HubContext): void {
  app.get('/api/auth-config', (c) => c.json({ mode: ctx.config.auth, project: getProject(ctx).name }));

  app.get('/api/me', (c) => {
    const p = principal(c);
    return c.json({ user: p.user, via: p.via, agent: p.agent });
  });

  app.get('/auth/dev', (c) => {
    if (ctx.config.auth !== 'dev') throw notFound('page');
    return startWebSession(c, ctx, c.req.query('user') ?? '', safeReturnTo(c.req.query('returnTo')));
  });

  app.post('/auth/logout', (c) => {
    const p = c.get('principal');
    if (p) deleteSession(ctx, p.token);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  app.post('/api/cli-login/approve', async (c) => {
    const p = human(c);
    const input = await readBody(c, CliLoginApproveInputSchema);
    approveCliLogin(ctx, input.code, p.user, input.label);
    return c.json({ ok: true });
  });

  app.get('/api/cli-login/poll', (c) => c.json(pollCliLogin(ctx, c.req.query('code') ?? '')));
}

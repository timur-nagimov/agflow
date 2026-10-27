import { consumeOAuthState, createOAuthState } from '../auth';
import type { HubContext } from '../context';
import { badRequest, notFound } from '../errors';
import { githubLogin } from '../github';
import type { App } from './app';
import { safeReturnTo, startWebSession } from './auth-routes';

export function mountGithubRoutes(app: App, ctx: HubContext): void {
  app.get('/auth/github', (c) => {
    if (ctx.config.auth !== 'github') throw notFound('page');
    const state = createOAuthState(ctx, safeReturnTo(c.req.query('returnTo')));
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', ctx.config.githubClientId ?? '');
    url.searchParams.set('redirect_uri', `${ctx.config.publicUrl}/auth/github/callback`);
    url.searchParams.set('scope', 'read:user');
    url.searchParams.set('state', state);
    return c.redirect(url.toString());
  });

  app.get('/auth/github/callback', async (c) => {
    if (ctx.config.auth !== 'github') throw notFound('page');
    const saved = consumeOAuthState(ctx, c.req.query('state') ?? '');
    if (!saved) throw badRequest('the sign-in link expired; start again');
    const code = c.req.query('code');
    if (!code) throw badRequest('GitHub did not return a code');
    const login = await githubLogin(ctx, code);
    return startWebSession(c, ctx, login, saved.returnTo);
  });
}

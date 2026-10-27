import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { OAUTH_STATE_TTL, consumeOAuthState, createOAuthState } from '../auth';
import type { HubContext } from '../context';
import { badRequest, notFound } from '../errors';
import { githubLogin } from '../github';
import type { App } from './app';
import { safeReturnTo, startWebSession } from './auth-routes';

/**
 * The browser that starts a sign-in keeps its state in this cookie, and the callback accepts only that state. Otherwise
 * someone could finish their own GitHub authorization and get another person's browser to open the callback link,
 * signing that browser in under their account.
 */
const STATE_COOKIE = 'agflow_oauth_state';

function stateCookieOptions(ctx: HubContext) {
  return { httpOnly: true, sameSite: 'Lax', secure: ctx.config.secureCookies, path: '/auth/github' } as const;
}

export function mountGithubRoutes(app: App, ctx: HubContext): void {
  app.get('/auth/github', (c) => {
    if (ctx.config.auth !== 'github') throw notFound('page');
    const state = createOAuthState(ctx, safeReturnTo(c.req.query('returnTo')));
    setCookie(c, STATE_COOKIE, state, { ...stateCookieOptions(ctx), maxAge: OAUTH_STATE_TTL / 1000 });
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', ctx.config.githubClientId ?? '');
    url.searchParams.set('redirect_uri', `${ctx.config.publicUrl}/auth/github/callback`);
    url.searchParams.set('state', state);
    return c.redirect(url.toString());
  });

  app.get('/auth/github/callback', async (c) => {
    if (ctx.config.auth !== 'github') throw notFound('page');
    const state = c.req.query('state') ?? '';
    // A different cookie may belong to a sign-in still under way in this browser, so it is left in place.
    if (!state || getCookie(c, STATE_COOKIE) !== state) {
      throw badRequest('this sign-in was started in another browser or has expired; start again');
    }
    deleteCookie(c, STATE_COOKIE, stateCookieOptions(ctx));
    const saved = consumeOAuthState(ctx, state);
    if (!saved) throw badRequest('the sign-in link expired; start again');
    const code = c.req.query('code');
    if (!code) throw badRequest('GitHub did not return a code');
    const login = await githubLogin(ctx, code);
    return startWebSession(c, ctx, login, saved.returnTo);
  });
}

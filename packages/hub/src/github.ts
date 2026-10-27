import type { HubContext } from './context';
import { HubError } from './errors';

/** Exchanges an OAuth code for the person's GitHub login. GitHub's access token is discarded. */
export async function githubLogin(ctx: HubContext, code: string): Promise<string> {
  const tokenResponse = await ctx.fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: ctx.config.githubClientId,
      client_secret: ctx.config.githubClientSecret,
      code,
      redirect_uri: `${ctx.config.publicUrl}/auth/github/callback`,
    }),
  });
  const tokenJson = (await tokenResponse.json()) as { access_token?: string; error_description?: string };
  if (!tokenResponse.ok || !tokenJson.access_token) {
    throw new HubError(401, 'github_failed', tokenJson.error_description ?? 'GitHub sign-in failed');
  }
  const userResponse = await ctx.fetch('https://api.github.com/user', {
    headers: {
      authorization: `Bearer ${tokenJson.access_token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'agflow-hub',
    },
  });
  const user = (await userResponse.json()) as { login?: string | null };
  if (!userResponse.ok || !user.login) throw new HubError(401, 'github_failed', 'could not read the GitHub user');
  return user.login;
}

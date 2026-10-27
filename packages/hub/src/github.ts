import type { HubContext } from './context';
import { HubError } from './errors';

const githubFailed = (message: string) => new HubError(401, 'github_failed', message);

interface GithubReply {
  ok: boolean;
  body: Record<string, unknown>;
}

/**
 * Calls GitHub and reads its JSON reply. GitHub being unreachable or answering with something other than a JSON object,
 * such as an HTML error page during an outage, fails the sign-in instead of becoming a server error.
 */
async function callGithub(ctx: HubContext, url: string, init: RequestInit): Promise<GithubReply> {
  let response: Response;
  try {
    response = await ctx.fetch(url, init);
  } catch {
    throw githubFailed('could not reach GitHub; try again');
  }
  const body: unknown = await response.json().catch(() => null);
  if (typeof body !== 'object' || body === null) {
    throw githubFailed(`GitHub sent an unexpected reply (HTTP ${response.status}); try again`);
  }
  return { ok: response.ok, body: body as Record<string, unknown> };
}

/** Exchanges an OAuth code for the person's GitHub login. GitHub's access token is discarded. */
export async function githubLogin(ctx: HubContext, code: string): Promise<string> {
  const token = await callGithub(ctx, 'https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: ctx.config.githubClientId,
      client_secret: ctx.config.githubClientSecret,
      code,
      redirect_uri: `${ctx.config.publicUrl}/auth/github/callback`,
    }),
  });
  const { access_token: accessToken, error_description: description } = token.body;
  if (!token.ok || typeof accessToken !== 'string' || !accessToken) {
    throw githubFailed(typeof description === 'string' && description ? description : 'GitHub sign-in failed');
  }
  const user = await callGithub(ctx, 'https://api.github.com/user', {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'agflow-hub',
    },
  });
  const { login } = user.body;
  if (!user.ok || typeof login !== 'string' || !login) throw githubFailed('could not read the GitHub user');
  return login;
}

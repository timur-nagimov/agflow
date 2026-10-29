// The runner link's HTTP side (design 6.3, 6.16): the WebSocket upgrade at /api/runner/ws, and the whoami probe a
// runner calls after a refused upgrade, because a refused WebSocket client sees only "Expected 101".
import { sessionHashOf } from '../auth';
import { unauthorized, upgradeRequired } from '../errors';
import type { LinkSession } from '../gateway';
import type { App, Principal } from './app';
import { type Ctx, principal } from './util';

/** Upgrades the request to a runner link signed in with the session; false when it is no WebSocket handshake. */
export type RunnerLinkUpgrade = (request: Request, session: LinkSession) => boolean;

/**
 * Only a CLI session opens the runner link or passes its probe. A browser's cookie never does, so a page cannot open
 * a link with the cookie the browser attaches; agent tokens never get here (the route allowlist refuses them).
 */
function cliSession(c: Ctx): Principal {
  const p = principal(c);
  if (p.via !== 'cli') throw unauthorized('the runner link needs a CLI token: run agflow login');
  return p;
}

export function mountRunnerRoutes(app: App, upgrade: RunnerLinkUpgrade | undefined): void {
  app.get('/api/runner/whoami', (c) => c.json({ user: cliSession(c).user }));

  app.get('/api/runner/ws', (c) => {
    const p = cliSession(c);
    const handshake = c.req.header('upgrade')?.toLowerCase() === 'websocket';
    if (!handshake || !upgrade?.(c.req.raw, { user: p.user, sessionHash: sessionHashOf(p.token) })) {
      throw upgradeRequired('GET /api/runner/ws opens the runner link: send a WebSocket handshake');
    }
    // Bun answers the handshake itself once the upgrade succeeds, and ignores this response.
    return new Response(null);
  });
}

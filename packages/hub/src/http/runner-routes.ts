// The runner link's HTTP side (design 6.3, 6.16): the WebSocket upgrade at /api/runner/ws, the whoami probe a runner
// calls after a refused upgrade, because a refused WebSocket client sees only "Expected 101", and the transcript tails
// runners upload. Also the Runners page's routes: the list, the owner's settings and retiring a runner.
import { RunnerPatchInputSchema, RunnerRetireInputSchema, TranscriptInputSchema } from '@agflow/core';
import { retireRunnerAttempts } from '../attempts';
import { sessionHashOf } from '../auth';
import { type HubContext, tx } from '../context';
import { notFound, unauthorized, upgradeRequired } from '../errors';
import type { LinkSession } from '../gateway';
import { clearOwnerAway, listAccounts } from '../quota';
import { storeTranscriptTail } from '../recovery';
import { listRunners, markRetired, ownedRunnerRow, ownedRunnerRowByKey, patchRunnerSettings } from '../runners';
import type { App, Principal } from './app';
import { type Ctx, actor, human, principal, readBody } from './util';

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

/** The owner's runner while it is in service: a retired one has left the list and takes no settings. */
function runnerInService(ctx: HubContext, runnerId: string, user: string): void {
  if (ownedRunnerRow(ctx, runnerId, user).retired_at !== null) throw notFound(`runner ${runnerId}`);
}

/**
 * Retires the runner (design 6.16): its open attempts end lost, its key is refused from now on, and its card goes.
 * Retiring a retired runner changes nothing.
 */
function retire(ctx: HubContext, runnerId: string, by: string): void {
  tx(ctx, (emit) => {
    retireRunnerAttempts(ctx, runnerId, by);
    markRetired(ctx, emit, runnerId, by);
  });
}

export function mountRunnerRoutes(app: App, ctx: HubContext, upgrade: RunnerLinkUpgrade | undefined): void {
  app.get('/api/runner/whoami', (c) => c.json({ user: cliSession(c).user }));

  app.get('/api/runners', (c) => {
    principal(c);
    return c.json({ runners: listRunners(ctx), accounts: listAccounts(ctx) });
  });

  app.patch('/api/runners/:id', async (c) => {
    const p = human(c);
    const runnerId = c.req.param('id');
    runnerInService(ctx, runnerId, p.user);
    const patch = await readBody(c, RunnerPatchInputSchema);
    const runner = tx(ctx, (emit) => {
      // Checked again: the runner may have been retired while the body arrived.
      runnerInService(ctx, runnerId, p.user);
      // Changing one of their runners is the owner acting, which ends their away marks (design 6.10, X-39).
      clearOwnerAway(ctx, p.user);
      return patchRunnerSettings(ctx, emit, runnerId, patch, actor(p));
    });
    return c.json({ runner });
  });

  app.delete('/api/runners/:id', (c) => {
    const p = human(c);
    const row = ownedRunnerRow(ctx, c.req.param('id'), p.user);
    retire(ctx, row.id, actor(p));
    return c.json({ ok: true });
  });

  app.post('/api/runner/retire', async (c) => {
    const p = cliSession(c);
    const { runnerKey } = await readBody(c, RunnerRetireInputSchema);
    retire(ctx, ownedRunnerRowByKey(ctx, runnerKey, p.user).id, actor(p));
    return c.json({ ok: true });
  });

  app.post('/api/runner/attempts/:id/transcript', async (c) => {
    const p = cliSession(c);
    const { tail } = await readBody(c, TranscriptInputSchema);
    storeTranscriptTail(ctx, p.user, c.req.param('id'), tail);
    return c.json({ ok: true });
  });

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

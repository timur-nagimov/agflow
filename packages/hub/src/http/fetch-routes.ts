// Internet for runner agents (design 5, Unattended options): the lead, or a person in the web UI, grants a task
// internet access and takes it back, and a runner agent asks the hub to download one public URL. All three routes
// answer 403 fetch_disabled while AGFLOW_AGENT_FETCH is off.
import { FetchGrantInputSchema, FetchUrlInputSchema } from '@agflow/core';
import { fetchForAgent, grantFetch, requireAgentFetch, revokeFetch } from '../agent-fetch';
import type { HubContext } from '../context';
import { forbidden } from '../errors';
import type { App } from './app';
import { actor, leadBody, leadOrHuman, principal, readBody } from './util';

export function mountFetchRoutes(app: App, ctx: HubContext): void {
  // Who may ask comes first, so a worker hears that only the lead grants, whatever the setting.
  app.post('/api/tasks/:id/fetch-grant', async (c) => {
    leadOrHuman(c, ctx);
    requireAgentFetch(ctx);
    const { lead, body } = await leadBody(c, ctx, FetchGrantInputSchema);
    return c.json({ task: grantFetch(ctx, c.req.param('id'), actor(lead), body.reason) });
  });

  app.delete('/api/tasks/:id/fetch-grant', (c) => {
    const lead = leadOrHuman(c, ctx);
    return c.json({ task: revokeFetch(ctx, c.req.param('id'), actor(lead)) });
  });

  // Only a runner agent's own token fetches: never a person, a CLI token or a live chat, whose computers have a
  // network of their own, and whose tokens runners hold.
  app.post('/api/fetch', async (c) => {
    const p = principal(c);
    if (p.via !== 'agent' || !p.agent) throw forbidden('only a runner agent fetches through the hub, with its agent token');
    requireAgentFetch(ctx);
    const { url } = await readBody(c, FetchUrlInputSchema);
    return c.json(await fetchForAgent(ctx, p.token, url));
  });
}

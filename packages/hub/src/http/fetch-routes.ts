// Internet for runner agents (design 5, Unattended options): the lead, or a person in the web UI, grants a task
// internet access and takes it back. Both routes answer 403 fetch_disabled while AGFLOW_AGENT_FETCH is off.
import { FetchGrantInputSchema } from '@agflow/core';
import { grantFetch, requireAgentFetch, revokeFetch } from '../agent-fetch';
import type { HubContext } from '../context';
import type { App } from './app';
import { actor, leadBody, leadOrHuman } from './util';

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
}

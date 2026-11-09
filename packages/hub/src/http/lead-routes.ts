// The lead's routes (design 6.16): POST /api/staffing is request_agents, for the seat holder, live or on a runner,
// and for people in the web UI.
import { StaffingInputSchema } from '@agflow/core';
import type { HubContext } from '../context';
import { requestAgents } from '../scheduler';
import type { App } from './app';
import { leadBody } from './util';

export function mountLeadRoutes(app: App, ctx: HubContext): void {
  app.post('/api/staffing', async (c) => {
    const { body } = await leadBody(c, ctx, StaffingInputSchema);
    return c.json(requestAgents(ctx, { count: body.count, vendor: body.vendor }));
  });
}

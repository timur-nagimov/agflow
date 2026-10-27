import { HelloInputSchema, LiveSessionQuerySchema, SessionStartInputSchema, StopCheckInputSchema } from '@agflow/core';
import { helloAgent, listAgents, startLiveSession } from '../agents';
import { buildBrief } from '../brief';
import type { HubContext } from '../context';
import { liveInbox, peekInbox, stopCheck } from '../live';
import type { App } from './app';
import { principal, readBody, readQuery } from './util';

export function mountAgentRoutes(app: App, ctx: HubContext): void {
  app.get('/api/agents', (c) => {
    principal(c);
    return c.json({ agents: listAgents(ctx) });
  });

  app.post('/api/live/session-start', async (c) => {
    const p = principal(c);
    const input = await readBody(c, SessionStartInputSchema);
    const { agent, helloCode, leadSeatTakenBy } = startLiveSession(ctx, p.user, input);
    return c.json({ agentId: agent.id, role: agent.role, brief: buildBrief(ctx, agent, { helloCode, leadSeatTakenBy }) });
  });

  app.post('/api/live/hello', async (c) => {
    const p = principal(c);
    const { code } = await readBody(c, HelloInputSchema);
    const agent = helloAgent(ctx, p.user, code);
    return c.json({ agentId: agent.id, role: agent.role, vendor: agent.vendor });
  });

  app.get('/api/live/inbox', (c) => {
    const p = principal(c);
    const query = readQuery(c, LiveSessionQuerySchema);
    return c.json(liveInbox(ctx, p.user, query.vendor, query.sessionId));
  });

  app.get('/api/live/peek', (c) => {
    const p = principal(c);
    const query = readQuery(c, LiveSessionQuerySchema);
    return c.json(peekInbox(ctx, p.user, query.vendor, query.sessionId));
  });

  app.post('/api/live/stop-check', async (c) => {
    const p = principal(c);
    const input = await readBody(c, StopCheckInputSchema);
    return c.json(stopCheck(ctx, p.user, input));
  });
}

import {
  type Attempt,
  AgentReplaceInputSchema,
  AgentStopInputSchema,
  HelloInputSchema,
  LiveSessionQuerySchema,
  SessionStartInputSchema,
  StopCheckInputSchema,
} from '@agflow/core';
import { helloAgent, listAgents, startLiveSession } from '../agents';
import { interruptAgent, replaceAgent, stopAgent } from '../attempts';
import { buildBrief } from '../brief';
import type { HubContext } from '../context';
import { liveInbox, peekInbox, stopCheck } from '../live';
import type { App } from './app';
import { type Ctx, actor, human, leadBody, principal, readBody, readQuery } from './util';

/** A stop held back for a pending submission is accepted, not yet in effect: 202 (design 6.13). */
const stopAnswer = (c: Ctx, attempt: Attempt) => c.json({ attempt }, attempt.stopRequested?.deferred ? 202 : 200);

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

  // The agent actions of design 6.16, on runner agents only: people act on any of them, the seat holder on workers.
  app.post('/api/agents/:id/stop', async (c) => {
    const { lead, body } = await leadBody(c, ctx, AgentStopInputSchema);
    const input = { agentId: c.req.param('id'), reason: body.reason, hold: body.hold, by: actor(lead) };
    return stopAnswer(c, stopAgent(ctx, input).attempt);
  });

  app.post('/api/agents/:id/replace', async (c) => {
    const { lead, body } = await leadBody(c, ctx, AgentReplaceInputSchema);
    const input = { agentId: c.req.param('id'), reason: body.reason, by: actor(lead) };
    return stopAnswer(c, replaceAgent(ctx, input).attempt);
  });

  app.post('/api/agents/:id/interrupt', (c) => {
    const p = human(c);
    interruptAgent(ctx, c.req.param('id'), actor(p));
    return c.json({ ok: true });
  });

  app.post('/api/live/stop-check', async (c) => {
    const p = principal(c);
    const input = await readBody(c, StopCheckInputSchema);
    return c.json(stopCheck(ctx, p.user, input));
  });
}

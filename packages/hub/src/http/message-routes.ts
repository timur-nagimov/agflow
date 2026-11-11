import { AckInputSchema, SendMessageInputSchema } from '@agflow/core';
import { buildBrief } from '../brief';
import type { HubContext } from '../context';
import { badRequest, forbidden } from '../errors';
import { holdsSeat } from '../hub-state';
import { ackMessages, listMessages, listStandingRules, removeStandingRule, sendMessage, takeInbox } from '../messages';
import type { App } from './app';
import { actor, agentOf, agentOrHuman, human, intParam, principal, readBody } from './util';

export function mountMessageRoutes(app: App, ctx: HubContext): void {
  app.get('/api/messages', (c) => {
    principal(c);
    return c.json({
      messages: listMessages(ctx, {
        taskId: c.req.query('taskId') || undefined,
        target: c.req.query('target') || undefined,
        limit: intParam(c.req.query('limit')),
      }),
    });
  });

  app.post('/api/messages', async (c) => {
    const p = agentOrHuman(c);
    const input = await readBody(c, SendMessageInputSchema);
    if (input.standingRule && p.agent) throw forbidden('only people can set standing rules');
    if (input.to === 'all' && p.agent && !holdsSeat(ctx, p.agent.id)) {
      throw forbidden('only the lead or a person can message everyone');
    }
    const message = sendMessage(ctx, {
      from: actor(p),
      to: input.to,
      body: input.body,
      taskId: input.taskId,
      replyTo: input.replyTo,
      standingRule: input.standingRule,
    });
    return c.json({ message }, 201);
  });

  app.post('/api/inbox', (c) => c.json({ messages: takeInbox(ctx, agentOf(c)) }));

  app.post('/api/inbox/ack', async (c) => {
    const agent = agentOf(c);
    const { ids } = await readBody(c, AckInputSchema);
    ackMessages(ctx, agent, ids);
    return c.json({ ok: true });
  });

  app.get('/api/rules', (c) => {
    principal(c);
    return c.json({ rules: listStandingRules(ctx) });
  });

  app.delete('/api/rules/:id', (c) => {
    const p = human(c);
    const id = intParam(c.req.param('id'));
    if (id === undefined) throw badRequest('expected a numeric rule id');
    removeStandingRule(ctx, id, actor(p));
    return c.json({ ok: true });
  });

  app.get('/api/brief', (c) => c.json({ brief: buildBrief(ctx, agentOf(c)) }));
}

// The lead's routes (design 6.16): POST /api/staffing is request_agents, for the seat holder, live or on a runner,
// and for people in the web UI. The seat holder writes its lead handoff, and it and people read the lead notes.
import { LeadHandoffInputSchema, StaffingInputSchema, TaskIdSchema } from '@agflow/core';
import { z } from 'zod';
import { getSubmissionFetch, requestSubmissionFetch } from '../fetch-submission';
import type { HubContext } from '../context';
import { forbidden } from '../errors';
import { listLeadNotes, writeLeadHandoff } from '../lead';
import { requestAgents } from '../scheduler';
import type { App } from './app';
import { leadBody, leadOrHuman, principal } from './util';

export function mountLeadRoutes(app: App, ctx: HubContext): void {
  app.post('/api/fetch-submission', async (c) => {
    const { lead, body } = await leadBody(c, ctx, z.strictObject({ task_id: TaskIdSchema }));
    if (!lead.agent) throw forbidden('only the seated lead can fetch a submission');
    const request = requestSubmissionFetch(ctx, lead.agent, body.task_id);
    return c.json({ request }, request.status === 'pending' ? 202 : 200);
  });

  app.get('/api/fetch-submission/:id', (c) => {
    const lead = leadOrHuman(c, ctx);
    if (!lead.agent) throw forbidden('only the seated lead can fetch a submission');
    return c.json({ request: getSubmissionFetch(ctx, lead.agent, c.req.param('id')) });
  });

  app.post('/api/staffing', async (c) => {
    const { body } = await leadBody(c, ctx, StaffingInputSchema);
    return c.json(requestAgents(ctx, { count: body.count, vendor: body.vendor }));
  });

  // A lead handoff is the seat holder's own note for its successor; people write to the lead as messages.
  app.post('/api/lead/handoff', async (c) => {
    const { lead, body } = await leadBody(c, ctx, LeadHandoffInputSchema);
    if (!lead.agent) throw forbidden('only the lead writes a lead handoff');
    writeLeadHandoff(ctx, lead.agent, body.note);
    return c.json({ ok: true });
  });

  // People read them anywhere, the CLI included; of the agents only the seat holder does.
  app.get('/api/lead/notes', (c) => {
    if (principal(c).agent) leadOrHuman(c, ctx);
    return c.json({ notes: listLeadNotes(ctx) });
  });
}

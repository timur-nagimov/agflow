// Approvals (design 6.10, 6.16): people list their own, and only the owner, in a browser, answers one. A CLI token or
// a live agent is no browser. Agent tokens get here only with AGFLOW_LEAD_APPROVALS on, and then only the token of the
// runner agent holding the lead seat lists and answers (design 5, Unattended options); with it off they are refused as
// on any route outside the agents' allowlist.
import { ApprovalDecisionInputSchema, ApprovalsQuerySchema } from '@agflow/core';
import {
  type AnsweringLead,
  approvalNotLead,
  decideApproval,
  decideApprovalAsLead,
  listApprovals,
  listLeadApprovals,
} from '../approvals';
import { resolveAgentToken } from '../auth';
import type { HubContext } from '../context';
import { agentNotAllowed } from '../errors';
import { holdsSeat } from '../hub-state';
import type { App } from './app';
import { type Ctx, human, principal, readBody, readQuery } from './util';

/** A person's body: the decision alone, as before the lead's reason joined the schema. */
const OwnerDecisionInputSchema = ApprovalDecisionInputSchema.omit({ reason: true });

/**
 * The lead behind an agent token. While the setting is off it answers what the allowlist answers a route it does not
 * list, so nothing tells the two apart. The token is resolved again: the attempt may have ended, or the seat moved,
 * while a body arrived.
 */
function leadByToken(c: Ctx, ctx: HubContext, token: string): AnsweringLead {
  if (!ctx.config.leadApprovals) throw agentNotAllowed(`an agent token cannot use ${c.req.method} ${c.req.path}`);
  const { agent, attempt } = resolveAgentToken(ctx, token);
  if (!holdsSeat(ctx, agent.id)) throw approvalNotLead();
  return { agentId: agent.id, attemptId: attempt.id };
}

export function mountApprovalRoutes(app: App, ctx: HubContext): void {
  app.get('/api/approvals', (c) => {
    const p = principal(c);
    // The lead's listing is always the pending ones it may answer; ?status= is a person's filter.
    if (p.via === 'agent') return c.json({ approvals: listLeadApprovals(ctx, leadByToken(c, ctx, p.token)) });
    const { status } = readQuery(c, ApprovalsQuerySchema);
    return c.json({ approvals: listApprovals(ctx, p.user, status) });
  });

  app.post('/api/approvals/:id', async (c) => {
    const caller = principal(c);
    if (caller.via === 'agent') {
      // Checked before the body is read, so others are refused at once, and again once it has arrived.
      leadByToken(c, ctx, caller.token);
      const { decision, reason } = await readBody(c, ApprovalDecisionInputSchema);
      const lead = leadByToken(c, ctx, caller.token);
      return c.json({ approval: decideApprovalAsLead(ctx, c.req.param('id'), lead, decision, reason) });
    }
    const p = human(c);
    const { decision } = await readBody(c, OwnerDecisionInputSchema);
    return c.json({ approval: decideApproval(ctx, c.req.param('id'), p.user, decision) });
  });
}

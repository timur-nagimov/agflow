// Approvals (design 6.10, 6.16): people list their own, and only the owner, in a browser, answers one. Agent tokens
// never get here (the route allowlist refuses them), and a CLI token or a live agent is no browser.
import { ApprovalDecisionInputSchema, ApprovalsQuerySchema } from '@agflow/core';
import { decideApproval, listApprovals } from '../approvals';
import type { HubContext } from '../context';
import type { App } from './app';
import { human, principal, readBody, readQuery } from './util';

export function mountApprovalRoutes(app: App, ctx: HubContext): void {
  app.get('/api/approvals', (c) => {
    const p = principal(c);
    const { status } = readQuery(c, ApprovalsQuerySchema);
    return c.json({ approvals: listApprovals(ctx, p.user, status) });
  });

  app.post('/api/approvals/:id', async (c) => {
    const p = human(c);
    const { decision } = await readBody(c, ApprovalDecisionInputSchema);
    return c.json({ approval: decideApproval(ctx, c.req.param('id'), p.user, decision) });
  });
}

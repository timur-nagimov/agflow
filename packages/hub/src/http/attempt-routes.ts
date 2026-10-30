import { AttemptsQuerySchema, PrepareInputSchema } from '@agflow/core';
import { attemptLog, getAttempt, listAttempts } from '../attempt-store';
import type { HubContext } from '../context';
import { forbidden } from '../errors';
import { getPreparation, requestPreparation } from '../prepare';
import { getSubmission } from '../submissions';
import type { App } from './app';
import { type Ctx, principal, readBody, readQuery } from './util';

export function mountAttemptRoutes(app: App, ctx: HubContext): void {
  app.get('/api/attempts', (c) => {
    principal(c);
    const query = readQuery(c, AttemptsQuerySchema);
    return c.json({
      attempts: listAttempts(ctx, {
        task: query.task,
        role: query.role,
        status: query.status,
        runner: query.runner,
        limit: query.limit,
      }),
    });
  });

  app.get('/api/attempts/:id', (c) => {
    principal(c);
    const attempt = getAttempt(ctx, c.req.param('id'));
    return c.json({ attempt, log: attemptLog(ctx, attempt.id) });
  });

  // The submitting agent polls its submission; people read any (design 6.16).
  app.get('/api/submissions/:id', (c) => {
    const p = principal(c);
    return c.json({ submission: getSubmission(ctx, c.req.param('id'), p.agent?.id ?? null) });
  });

  // Dependency preparation: the agent token names the attempt (design 7.7).
  app.post('/api/prepare', async (c) => {
    const { token } = runnerAgent(c);
    await readBody(c, PrepareInputSchema);
    return c.json({ request: requestPreparation(ctx, token) }, 202);
  });

  app.get('/api/prepare/:id', (c) => {
    const { agentId } = runnerAgent(c);
    return c.json({ request: getPreparation(ctx, c.req.param('id'), agentId) });
  });
}

/** A runner agent calling with its agent token: only it asks for and reads dependency preparations. */
function runnerAgent(c: Ctx): { agentId: string; token: string } {
  const p = principal(c);
  if (p.via !== 'agent' || !p.agent) throw forbidden('only a runner agent prepares dependencies, with its agent token');
  return { agentId: p.agent.id, token: p.token };
}

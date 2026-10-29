import { AttemptsQuerySchema } from '@agflow/core';
import { attemptLog, getAttempt, listAttempts } from '../attempt-store';
import type { HubContext } from '../context';
import type { App } from './app';
import { principal, readQuery } from './util';

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
}

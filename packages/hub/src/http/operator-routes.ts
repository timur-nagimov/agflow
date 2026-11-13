// The operator's routes: the few people's controls an operator script needs to run a project without a browser. They
// exist only when AGFLOW_OPERATOR_TOKEN is set, and that token lives only in the hub's server environment, never on a
// laptop where agents run: a person's CLI token, which runners hold, still cannot do any of this.
import { createHash, timingSafeEqual } from 'node:crypto';
import { MarkMergedInputSchema, NoteInputSchema, SendMessageInputSchema } from '@agflow/core';
import type { Context } from 'hono';
import type { HubContext } from '../context';
import { unauthorized } from '../errors';
import { sendMessage } from '../messages';
import { markMerged, unblockTask } from '../tasks';
import type { App, AppEnv } from './app';
import { readBody } from './util';

/** The header that carries the operator token. */
export const OPERATOR_HEADER = 'x-agflow-operator';

const digest = (value: string) => createHash('sha256').update(value).digest();

export function mountOperatorRoutes(app: App, ctx: HubContext): void {
  const { operatorToken, operatorUser } = ctx.config;
  if (!operatorToken || !operatorUser) return;
  const expected = digest(operatorToken);
  /** The operator's actor, the person it acts as; anything but the exact token is refused. */
  const operator = (c: Context<AppEnv>): string => {
    const given = c.req.header(OPERATOR_HEADER);
    if (!given || !timingSafeEqual(digest(given), expected)) throw unauthorized('the operator token is missing or wrong');
    return `user:${operatorUser}`;
  };

  app.post('/api/operator/tasks/:id/merged', async (c) => {
    const who = operator(c);
    const { sha } = await readBody(c, MarkMergedInputSchema);
    return c.json({ task: markMerged(ctx, c.req.param('id'), who, sha) });
  });

  app.post('/api/operator/tasks/:id/unblock', async (c) => {
    const who = operator(c);
    const { note } = await readBody(c, NoteInputSchema);
    return c.json({ task: unblockTask(ctx, c.req.param('id'), who, note) });
  });

  app.post('/api/operator/messages', async (c) => {
    const who = operator(c);
    const input = await readBody(c, SendMessageInputSchema);
    const message = sendMessage(ctx, {
      from: who,
      to: input.to,
      body: input.body,
      taskId: input.taskId,
      replyTo: input.replyTo,
      standingRule: input.standingRule,
    });
    return c.json({ message }, 201);
  });
}

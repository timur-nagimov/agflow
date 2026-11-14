// The operator's routes: the few people's controls an operator script, or agflow start, needs to run a project without
// a browser. They exist only when AGFLOW_OPERATOR_TOKEN is set. The token stays on the server, or in the owner's
// Keychain for agflow start, apart from the CLI login: a person's CLI token, which runners hold, still cannot do any of
// this.
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  MarkMergedInputSchema,
  NoteInputSchema,
  type OperatorProject,
  ProjectResetInputSchema,
  SendMessageInputSchema,
  UpdateGoalInputSchema,
} from '@agflow/core';
import type { Context } from 'hono';
import type { HubContext } from '../context';
import { unauthorized } from '../errors';
import { updateGoal } from '../goal';
import { sendMessage } from '../messages';
import { getProject } from '../project';
import { resetProject } from '../reset';
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

  app.put('/api/operator/goal', async (c) => {
    const who = operator(c);
    const input = await readBody(c, UpdateGoalInputSchema);
    return c.json(updateGoal(ctx, input, who));
  });

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

  // agflow start reads the main branch before it seeds the repository: attempts start from that branch only.
  app.get('/api/operator/project', (c) => {
    operator(c);
    const answer: OperatorProject = { project: getProject(ctx), mainBranch: ctx.config.mainBranch };
    return c.json(answer);
  });

  // A new project in place of the current one (agflow start): reset.ts says what goes and what stays.
  app.post('/api/operator/project/reset', async (c) => {
    const who = operator(c);
    const input = await readBody(c, ProjectResetInputSchema);
    const deadlineAt = input.deadline === null ? null : Date.parse(input.deadline);
    return c.json(resetProject(ctx, { ...input, deadlineAt }, who));
  });
}

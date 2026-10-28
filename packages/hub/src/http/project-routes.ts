import {
  GoalDiffQuerySchema,
  GoalNoteInputSchema,
  type HubStatus,
  PauseInputSchema,
  UpdateGoalInputSchema,
  diffGoal,
} from '@agflow/core';
import { currentLead, listAgents } from '../agents';
import type { HubContext } from '../context';
import { notFound } from '../errors';
import {
  addGoalNote,
  currentGoalVersion,
  getCurrentGoal,
  getGoalVersion,
  listGoalNotes,
  listGoalVersions,
  updateGoal,
} from '../goal';
import { listMessages } from '../messages';
import { getProject, setPaused } from '../project';
import { listTasks } from '../tasks';
import type { App } from './app';
import { actor, human, leadOrHuman, principal, readBody, readQuery } from './util';

export function mountProjectRoutes(app: App, ctx: HubContext): void {
  app.get('/api/project', (c) => {
    principal(c);
    return c.json(getProject(ctx));
  });

  app.post('/api/project/pause', async (c) => {
    const p = human(c);
    const { paused } = await readBody(c, PauseInputSchema);
    return c.json(setPaused(ctx, paused, actor(p)));
  });

  app.get('/api/status', (c) => {
    principal(c);
    const counts: Record<string, number> = {};
    for (const task of listTasks(ctx)) counts[task.status] = (counts[task.status] ?? 0) + 1;
    const project = getProject(ctx);
    const lead = currentLead(ctx);
    const status: HubStatus = {
      project,
      goalVersion: currentGoalVersion(ctx),
      lead,
      // Only live chats lead so far, and nothing records when one took the seat.
      leadSeat: {
        kind: lead ? 'live' : 'none',
        agentId: lead?.id ?? null,
        attemptId: null,
        runnerId: null,
        since: null,
        wakeups: 0,
        runnerLeads: project.runnerLeads,
      },
      // A hub starts at epoch 1; only a restore raises it.
      epoch: 1,
      counts,
      activeAgents: listAgents(ctx).filter((agent) => agent.status === 'active').length,
      humansInbox: listMessages(ctx, { target: 'humans', limit: 20 }),
    };
    return c.json(status);
  });

  app.get('/api/goal', (c) => {
    principal(c);
    const current = getCurrentGoal(ctx);
    return c.json({ current, notes: current ? listGoalNotes(ctx, current.version) : [] });
  });

  app.get('/api/goal/history', (c) => {
    principal(c);
    return c.json({ versions: listGoalVersions(ctx) });
  });

  app.get('/api/goal/diff', (c) => {
    principal(c);
    const query = readQuery(c, GoalDiffQuerySchema);
    const to = getGoalVersion(ctx, query.to);
    if (!to) throw notFound(`goal v${query.to}`);
    const from = query.from > 0 ? getGoalVersion(ctx, query.from) : null;
    return c.json({ lines: diffGoal(from?.text ?? '', to.text) });
  });

  app.put('/api/goal', async (c) => {
    const p = human(c);
    const input = await readBody(c, UpdateGoalInputSchema);
    return c.json(updateGoal(ctx, input, actor(p)));
  });

  app.post('/api/goal/notes', async (c) => {
    const p = leadOrHuman(c);
    const { text } = await readBody(c, GoalNoteInputSchema);
    return c.json(addGoalNote(ctx, text, actor(p)), 201);
  });
}

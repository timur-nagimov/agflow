import {
  GoalDiffQuerySchema,
  GoalNoteInputSchema,
  type HubStatus,
  PauseInputSchema,
  ProjectPatchInputSchema,
  UpdateGoalInputSchema,
  diffGoal,
} from '@agflow/core';
import { getAgent, listAgents } from '../agents';
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
import { hubEpoch, leadSeat } from '../hub-state';
import { setRunnerLeads } from '../lead';
import { listMessages } from '../messages';
import { getProject, setPaused } from '../project';
import { listTasks } from '../task-store';
import type { App } from './app';
import { actor, human, leadBody, principal, readBody, readQuery } from './util';

export function mountProjectRoutes(app: App, ctx: HubContext): void {
  app.get('/api/project', (c) => {
    principal(c);
    return c.json(getProject(ctx));
  });

  // Runner leads off rotates the runner lead out, so a person's live lead can take the seat (design 6.11).
  app.patch('/api/project', async (c) => {
    const p = human(c);
    const { runnerLeads } = await readBody(c, ProjectPatchInputSchema);
    return c.json(setRunnerLeads(ctx, runnerLeads, actor(p)));
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
    const seat = leadSeat(ctx);
    const status: HubStatus = {
      project,
      goalVersion: currentGoalVersion(ctx),
      // The seat holder's agent, for the readers that predate leadSeat (the CLI's status, M1 pages).
      lead: seat.agentId ? getAgent(ctx, seat.agentId) : null,
      leadSeat: seat,
      epoch: hubEpoch(ctx),
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
    const { lead, body: { text } } = await leadBody(c, ctx, GoalNoteInputSchema);
    return c.json(addGoalNote(ctx, text, actor(lead)), 201);
  });
}

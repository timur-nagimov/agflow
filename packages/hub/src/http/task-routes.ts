import {
  ClaimInputSchema,
  CreateTasksInputSchema,
  FeedbackInputSchema,
  HandoffInputSchema,
  ImpossibleInputSchema,
  MarkMergedInputSchema,
  NoteInputSchema,
  ProgressInputSchema,
  ReasonInputSchema,
  SubmitInputSchema,
  TaskPatchSchema,
  type TaskStatus,
} from '@agflow/core';
import type { HubContext } from '../context';
import {
  acceptTask,
  blockTask,
  cancelTask,
  claimTask,
  createTasks,
  declareImpossible,
  forceRelease,
  getTaskDetail,
  markMerged,
  rejectTask,
  releaseTask,
  reportProgress,
  resumeClaim,
  submitTask,
  unblockTask,
  updateTask,
  writeHandoff,
} from '../tasks';
import { listTasks } from '../task-store';
import type { App } from './app';
import { actor, agentOf, holderOf, human, leadBody, principal, readBody } from './util';

export function mountTaskRoutes(app: App, ctx: HubContext): void {
  app.get('/api/tasks', (c) => {
    principal(c);
    const status = c.req.query('status');
    return c.json({
      tasks: listTasks(ctx, {
        status: status ? (status.split(',') as TaskStatus[]) : undefined,
        assignee: c.req.query('assignee') || undefined,
      }),
    });
  });

  app.get('/api/tasks/:id', (c) => {
    principal(c);
    return c.json(getTaskDetail(ctx, c.req.param('id')));
  });

  // The lead or a person.
  app.post('/api/tasks', async (c) => {
    const { lead, body: { tasks } } = await leadBody(c, ctx, CreateTasksInputSchema);
    return c.json({ tasks: createTasks(ctx, tasks, actor(lead)) }, 201);
  });

  app.patch('/api/tasks/:id', async (c) => {
    const { lead, body: patch } = await leadBody(c, ctx, TaskPatchSchema);
    return c.json({ task: updateTask(ctx, c.req.param('id'), patch, actor(lead)) });
  });

  app.post('/api/tasks/:id/cancel', async (c) => {
    const { lead, body: { reason } } = await leadBody(c, ctx, ReasonInputSchema);
    return c.json({ task: cancelTask(ctx, c.req.param('id'), reason, actor(lead)) });
  });

  app.post('/api/tasks/:id/accept', async (c) => {
    const { lead, body: { note } } = await leadBody(c, ctx, NoteInputSchema);
    return c.json({ task: acceptTask(ctx, c.req.param('id'), actor(lead), note) });
  });

  app.post('/api/tasks/:id/reject', async (c) => {
    const { lead, body: { feedback } } = await leadBody(c, ctx, FeedbackInputSchema);
    return c.json({ task: rejectTask(ctx, c.req.param('id'), actor(lead), feedback) });
  });

  app.post('/api/tasks/:id/unblock', async (c) => {
    const { lead, body: { note } } = await leadBody(c, ctx, NoteInputSchema);
    return c.json({ task: unblockTask(ctx, c.req.param('id'), actor(lead), note) });
  });

  app.post('/api/tasks/:id/merged', async (c) => {
    const { lead, body: { sha } } = await leadBody(c, ctx, MarkMergedInputSchema);
    return c.json({ task: markMerged(ctx, c.req.param('id'), actor(lead), sha) });
  });

  // People only.
  app.post('/api/tasks/:id/release-claim', async (c) => {
    const p = human(c);
    const { reason } = await readBody(c, ReasonInputSchema);
    return c.json({ task: forceRelease(ctx, c.req.param('id'), actor(p), reason) });
  });

  // The agent doing the work.
  app.post('/api/tasks/:id/claim', async (c) => {
    const agent = agentOf(c);
    const { branch } = await readBody(c, ClaimInputSchema);
    return c.json({ task: claimTask(ctx, c.req.param('id'), agent, branch) });
  });

  app.post('/api/tasks/:id/resume-claim', (c) => {
    const agent = agentOf(c);
    return c.json({ task: resumeClaim(ctx, c.req.param('id'), agent) });
  });

  // The holder; the token is checked again in the action's transaction, since the body arrives after it was resolved.
  app.post('/api/tasks/:id/progress', async (c) => {
    const { agent, token } = holderOf(c);
    const { note } = await readBody(c, ProgressInputSchema);
    return c.json({ task: reportProgress(ctx, c.req.param('id'), agent, note, token) });
  });

  app.post('/api/tasks/:id/submit', async (c) => {
    const { agent, token } = holderOf(c);
    const input = await readBody(c, SubmitInputSchema);
    return c.json({ task: submitTask(ctx, c.req.param('id'), agent, input, token) });
  });

  app.post('/api/tasks/:id/block', async (c) => {
    const { agent, token } = holderOf(c);
    const { reason } = await readBody(c, ReasonInputSchema);
    return c.json({ task: blockTask(ctx, c.req.param('id'), agent, reason, 'agent', token) });
  });

  app.post('/api/tasks/:id/impossible', async (c) => {
    const { agent, token } = holderOf(c);
    const { evidence } = await readBody(c, ImpossibleInputSchema);
    return c.json({ task: declareImpossible(ctx, c.req.param('id'), agent, evidence, token) });
  });

  app.post('/api/tasks/:id/handoff', async (c) => {
    const { agent, token } = holderOf(c);
    const { note } = await readBody(c, HandoffInputSchema);
    writeHandoff(ctx, c.req.param('id'), agent, note, token);
    return c.json({ ok: true });
  });

  app.post('/api/tasks/:id/release', async (c) => {
    const { agent, token } = holderOf(c);
    const { reason } = await readBody(c, ReasonInputSchema);
    return c.json({ task: releaseTask(ctx, c.req.param('id'), agent, reason, token) });
  });
}

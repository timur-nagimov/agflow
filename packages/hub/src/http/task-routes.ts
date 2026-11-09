import {
  BRIDGE_HEADER,
  ClaimInputSchema,
  CreateTasksInputSchema,
  FeedbackInputSchema,
  HandbackInputSchema,
  HandoffInputSchema,
  ImpossibleInputSchema,
  MarkMergedInputSchema,
  NoteInputSchema,
  ProgressInputSchema,
  ReasonInputSchema,
  RunnerSubmitInputSchema,
  SubmitInputSchema,
  TaskPatchSchema,
  type TaskStatus,
} from '@agflow/core';
import type { HubContext } from '../context';
import { requestSubmission } from '../submissions';
import { requestHandback, requestTakeover } from '../takeover';
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
import { actor, agentOf, holderOf, human, intParam, leadBody, principal, readBody } from './util';

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

  // A person in the browser takes a runner agent's work over (design 6.12).
  app.post('/api/tasks/:id/takeover', (c) => {
    const p = human(c);
    return c.json(requestTakeover(ctx, c.req.param('id'), p.user), 202);
  });

  // The person who took over, or anyone once the runner is not online, hands the work back (design 6.12, X-24).
  app.post('/api/tasks/:id/handback', async (c) => {
    const p = human(c);
    const { source } = await readBody(c, HandbackInputSchema);
    return c.json(requestHandback(ctx, c.req.param('id'), { source, login: p.user }), 202);
  });

  // The agent doing the work.
  app.post('/api/tasks/:id/claim', async (c) => {
    const agent = agentOf(c);
    const { branch } = await readBody(c, ClaimInputSchema);
    const bridge = intParam(c.req.header(BRIDGE_HEADER)) ?? null;
    return c.json({ task: claimTask(ctx, c.req.param('id'), agent, branch, bridge) });
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

  // A runner agent's submit is a request the runner pushes (design 6.13); a live chat's records its branch at once.
  app.post('/api/tasks/:id/submit', async (c) => {
    const { agent, token } = holderOf(c);
    if (agent.origin === 'runner') {
      const input = await readBody(c, RunnerSubmitInputSchema);
      return c.json({ submission: requestSubmission(ctx, c.req.param('id'), agent, input, token) }, 202);
    }
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

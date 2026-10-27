import { type AgentRole, type Task, type TaskStatus, TargetSchema, TaskIdSchema, formatMessages } from '@agflow/core';
import { z } from 'zod';
import type { HubClient } from '../hub-client';

export interface ToolState {
  agentId: string | null;
  role: AgentRole | null;
}

export interface ToolContext {
  client: HubClient | null;
  state: ToolState;
  cwd: string;
}

export interface ToolDef {
  name: string;
  description: string;
  input: Record<string, z.ZodType>;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
}

export function defineTool<S extends Record<string, z.ZodType>>(
  name: string,
  description: string,
  input: S,
  run: (args: z.output<z.ZodObject<S>>, ctx: ToolContext) => Promise<string>,
): ToolDef {
  return { name, description, input, run: (args, ctx) => run(args as z.output<z.ZodObject<S>>, ctx) };
}

export class ToolError extends Error {
  override name = 'ToolError';
}

export function hub(ctx: ToolContext): HubClient {
  if (!ctx.client) throw new ToolError('This computer is not signed in to agflow. Ask the person to run `agflow login --hub <url>`.');
  return ctx.client;
}

/** The client acting as this chat's agent; requires hello first. */
export function asAgent(ctx: ToolContext): HubClient {
  const client = hub(ctx);
  if (!ctx.state.agentId) throw new ToolError('Call the agflow tool hello first, with the code from your agflow brief.');
  return client;
}

export function taskLine(task: Task): string {
  const owner = task.assignee ? ` · ${task.assignee}` : '';
  const blocked = task.status === 'blocked' && task.blockedReason ? ` · ${task.blockedReason}` : '';
  return `${task.id} [${task.status}] p${task.priority} ${task.title}${owner}${blocked}`;
}

export const lines = (parts: Array<string | false | null | undefined | 0>) => parts.filter(Boolean).join('\n');

export const sharedTools: ToolDef[] = [
  defineTool(
    'hello',
    'Connect this chat to agflow. Call it first, with the code from your agflow brief.',
    { code: z.string().min(4).max(20) },
    async ({ code }, ctx) => {
      const client = hub(ctx);
      const result = await client.hello(code);
      client.agentId = result.agentId;
      ctx.state.agentId = result.agentId;
      ctx.state.role = result.role;
      const next = result.role === 'lead' ? 'Use get_status and list_tasks to see the plan.' : 'Use list_tasks to find ready work and claim_task to take it.';
      return `Connected as agflow agent ${result.agentId} (${result.role}). ${next}`;
    },
  ),
  defineTool(
    'get_brief',
    'Your current agflow brief: goal, standing rules, your task or the situation report, and unread messages.',
    {},
    async (_args, ctx) => (await asAgent(ctx).brief()).brief,
  ),
  defineTool('get_goal', "The project's current goal and the lead's interpretation notes.", {}, async (_args, ctx) => {
    const { current, notes } = await hub(ctx).goal();
    if (!current) return 'No goal has been set yet.';
    return lines([
      `Goal v${current.version} (by ${current.author}):`,
      current.text,
      notes.length > 0 && `\nInterpretation notes:\n${notes.map((note) => `- ${note.text} (${note.author})`).join('\n')}`,
    ]);
  }),
  defineTool(
    'list_tasks',
    'List tasks, optionally filtered by status, for example ["ready"].',
    { status: z.array(z.string()).max(15).optional() },
    async ({ status }, ctx) => {
      const { tasks } = await hub(ctx).tasks(status as TaskStatus[] | undefined);
      return tasks.length > 0 ? tasks.map(taskLine).join('\n') : 'No tasks match.';
    },
  ),
  defineTool('get_task', 'One task: contract, status, notes and recent messages.', { id: TaskIdSchema }, async ({ id }, ctx) => {
    const detail = await hub(ctx).task(id);
    const task = detail.task;
    return lines([
      taskLine(task),
      `Objective: ${task.objective}`,
      task.why && `Why: ${task.why}`,
      `Acceptance criteria:\n${task.acceptance.map((criterion) => `- ${criterion.id}: ${criterion.assertion}`).join('\n')}`,
      task.ownedPaths.length > 0 && `Owned paths: ${task.ownedPaths.join(', ')}`,
      task.dependsOn.length > 0 && `Depends on: ${task.dependsOn.join(', ')}`,
      task.branch && `Branch: ${task.branch}`,
      task.feedback && `Latest review feedback: ${task.feedback}`,
      task.submission && `Submission: ${task.submission.summary}`,
      detail.notes.length > 0 && `Notes:\n${detail.notes.map((note) => `- [${note.kind}] ${note.body}`).join('\n')}`,
      detail.messages.length > 0 && `Recent messages:\n${formatMessages(detail.messages.slice(0, 10).reverse())}`,
    ]);
  }),
  defineTool(
    'check_inbox',
    "Read your new agflow messages. People's instructions take precedence over agents'.",
    {},
    async (_args, ctx) => {
      const { messages } = await asAgent(ctx).takeInbox();
      return messages.length > 0 ? formatMessages(messages) : 'No new messages.';
    },
  ),
  defineTool(
    'ack_messages',
    'Mark messages as acted on.',
    { ids: z.array(z.number().int().positive()).min(1).max(200) },
    async ({ ids }, ctx) => {
      await asAgent(ctx).ack(ids);
      return `Acknowledged ${ids.length} message(s).`;
    },
  ),
  defineTool(
    'send_message',
    'Send a message. "to" is "lead", "humans", "all" (lead only), "agent:A-<n>" or "task:T-<n>".',
    {
      to: TargetSchema,
      body: z.string().min(1).max(8000),
      task_id: TaskIdSchema.optional(),
      reply_to: z.number().int().positive().optional(),
    },
    async ({ to, body, task_id, reply_to }, ctx) => {
      const { message } = await asAgent(ctx).send({ to, body, taskId: task_id, replyTo: reply_to });
      return `Sent message #${message.id} to ${message.to}.`;
    },
  ),
  defineTool('search', 'Search tasks, messages and the goal by text.', { query: z.string().min(1).max(200) }, async ({ query }, ctx) => {
    const result = await hub(ctx).search(query);
    const found = lines([
      result.goal && `Goal v${result.goal.version}: …${result.goal.snippet}…`,
      result.tasks.length > 0 && `Tasks:\n${result.tasks.map(taskLine).join('\n')}`,
      result.messages.length > 0 && `Messages:\n${formatMessages(result.messages)}`,
    ]);
    return found || 'Nothing found.';
  }),
];

export const workerTools: ToolDef[] = [
  defineTool('resume_claim', 'Take over a task that one of your own earlier chats holds.', { id: TaskIdSchema }, async ({ id }, ctx) => {
    const { task } = await asAgent(ctx).resumeClaim(id);
    return `You now hold ${task.id}${task.branch ? ` (branch ${task.branch})` : ''}.`;
  }),
  defineTool(
    'report_progress',
    'Record progress on the task you hold. This also keeps your claim alive.',
    { task_id: TaskIdSchema, note: z.string().min(1).max(4000) },
    async ({ task_id, note }, ctx) => {
      const { task } = await asAgent(ctx).progress(task_id, note);
      return `Progress recorded; ${task.id} is ${task.status}.`;
    },
  ),
  defineTool(
    'write_handoff',
    'Leave a handoff note for whoever continues your task: what is done, what remains, commands run and results, decisions, failed approaches, the next step.',
    { task_id: TaskIdSchema, note: z.string().min(1).max(16_000) },
    async ({ task_id, note }, ctx) => {
      await asAgent(ctx).handoff(task_id, note);
      return `Handoff note saved on ${task_id}.`;
    },
  ),
  defineTool(
    'declare_blocked',
    'Stop work on your task because something outside it blocks you. The lead is told.',
    { task_id: TaskIdSchema, reason: z.string().min(1).max(4000) },
    async ({ task_id, reason }, ctx) => {
      const { task } = await asAgent(ctx).block(task_id, reason);
      return `${task.id} is blocked; the lead has been told.`;
    },
  ),
  defineTool(
    'declare_impossible',
    'Report that your task cannot be done as specified (for example, acceptance criteria contradict each other), with evidence.',
    { task_id: TaskIdSchema, evidence: z.string().min(1).max(8000) },
    async ({ task_id, evidence }, ctx) => {
      const { task } = await asAgent(ctx).impossible(task_id, evidence);
      return `${task.id} is marked impossible as specified; the lead will decide.`;
    },
  ),
  defineTool(
    'release_task',
    'Give your task back so someone else can take it.',
    { task_id: TaskIdSchema, reason: z.string().min(1).max(4000) },
    async ({ task_id, reason }, ctx) => {
      const { task } = await asAgent(ctx).release(task_id, reason);
      return `Released ${task.id}; it is ${task.status} again.`;
    },
  ),
];

export const allTools: ToolDef[] = [...sharedTools, ...workerTools];

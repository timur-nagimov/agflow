import { describe, expect, test } from 'bun:test';
import { NewTaskSchema } from '@agflow/core';
import { updateGoal } from '@agflow/hub/src/goal';
import { sendMessage } from '@agflow/hub/src/messages';
import { claimTask, createTasks, getTask } from '@agflow/hub/src/tasks';
import { getAgent } from '@agflow/hub/src/agents';
import type { HubClient } from '../src/hub-client';
import { type ToolContext, allTools } from '../src/mcp/tools';
import { helloCodeIn, hubFixture } from './fixture';

const newTask = (title: string) => NewTaskSchema.parse({ title, objective: `Do ${title}`, acceptance: [{ id: 'A1', assertion: `${title} works` }] });
const tool = (name: string) => {
  const found = allTools.find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
};
const call = (name: string, args: Record<string, unknown>, ctx: ToolContext) => tool(name).run(args, ctx);
const contextFor = (client: HubClient | null, agentId: string | null = null): ToolContext => ({
  client,
  state: { agentId, role: agentId ? 'worker' : null },
  cwd: '/tmp',
});

describe('shared tools', () => {
  test('hello binds the chat to the agent registered by the SessionStart hook', async () => {
    const hub = hubFixture();
    const client = hub.client('alice');
    const brief = (await client.sessionStart({ vendor: 'claude', sessionId: 's1', role: 'worker' })).brief;
    const ctx = contextFor(client);
    await expect(call('check_inbox', {}, ctx)).rejects.toThrow('Call the agflow tool hello first');
    expect(await call('hello', { code: helloCodeIn(brief) }, ctx)).toContain('Connected as agflow agent A-1 (worker)');
    expect(ctx.state).toEqual({ agentId: 'A-1', role: 'worker' });
    expect(await call('check_inbox', {}, ctx)).toBe('No new messages.');
  });

  test('without a sign-in every tool explains how to sign in', async () => {
    await expect(call('list_tasks', {}, contextFor(null))).rejects.toThrow('agflow login');
  });

  test('reads the goal, tasks and one task in model-friendly text', async () => {
    const hub = hubFixture();
    updateGoal(hub.ctx, { text: 'Ship the parser.', baseVersion: 0 }, 'user:alice');
    createTasks(hub.ctx, [newTask('Parser'), newTask('Docs')], 'user:alice');
    const ctx = contextFor(hub.client('alice'));
    expect(await call('get_goal', {}, ctx)).toContain('Goal v1 (by user:alice):\nShip the parser.');
    expect(await call('list_tasks', { status: ['ready'] }, ctx)).toBe('T-1 [ready] p5 Parser\nT-2 [ready] p5 Docs');
    const detail = await call('get_task', { id: 'T-1' }, ctx);
    expect(detail).toContain('Objective: Do Parser');
    expect(detail).toContain('- A1: Parser works');
  });

  test('inbox, messages and search', async () => {
    const hub = hubFixture();
    const live = hub.liveAgent('alice');
    const ctx = contextFor(live.client, live.agentId);
    sendMessage(hub.ctx, { from: 'user:bob', to: `agent:${live.agentId}`, body: 'Use pnpm.' });
    expect(await call('check_inbox', {}, ctx)).toContain('[agflow message #');
    expect(await call('send_message', { to: 'humans', body: 'Need the API key.' }, ctx)).toMatch(/^Sent message #\d+ to humans\.$/);
    expect(await call('search', { query: 'API key' }, ctx)).toContain('Need the API key.');
    expect(await call('search', { query: 'nothing-like-this' }, ctx)).toBe('Nothing found.');
  });
});

describe('worker tools', () => {
  test('progress, handoff, block, release and resume', async () => {
    const hub = hubFixture();
    createTasks(hub.ctx, [newTask('Parser')], 'user:alice');
    const live = hub.liveAgent('alice');
    const ctx = contextFor(live.client, live.agentId);
    claimTask(hub.ctx, 'T-1', getAgent(hub.ctx, live.agentId));
    expect(await call('report_progress', { task_id: 'T-1', note: 'Tokenizer done' }, ctx)).toBe('Progress recorded; T-1 is working.');
    expect(await call('write_handoff', { task_id: 'T-1', note: 'Next: AST' }, ctx)).toBe('Handoff note saved on T-1.');
    expect(await call('release_task', { task_id: 'T-1', reason: 'out of time' }, ctx)).toBe('Released T-1; it is ready again.');
    claimTask(hub.ctx, 'T-1', getAgent(hub.ctx, live.agentId));
    expect(await call('declare_blocked', { task_id: 'T-1', reason: 'Need credentials' }, ctx)).toBe('T-1 is blocked; the lead has been told.');
    expect(getTask(hub.ctx, 'T-1').status).toBe('blocked');
    const again = hub.liveAgent('alice');
    createTasks(hub.ctx, [newTask('Docs')], 'user:alice');
    claimTask(hub.ctx, 'T-2', getAgent(hub.ctx, live.agentId));
    expect(await call('resume_claim', { id: 'T-2' }, contextFor(again.client, again.agentId))).toBe('You now hold T-2.');
  });
});

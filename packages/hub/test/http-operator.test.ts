import { describe, expect, test } from 'bun:test';
import { loadConfig } from '../src/config';
import { addAgent } from './helpers';
import { createTestHub } from './http-helpers';

const TOKEN = 'op-0123456789abcdef0123456789abcdef';
const oneTask = { tasks: [{ title: 'Parser', objective: 'Parse input', acceptance: [{ id: 'A1', assertion: 'parses' }] }] };
const op = (token = TOKEN) => ({ headers: { 'x-agflow-operator': token } });

/** A task the lead has accepted, ready to be marked merged. */
async function acceptedTask(hub: ReturnType<typeof createTestHub>): Promise<{ id: string; lead: string }> {
  const lead = addAgent(hub.ctx, 'alice', 'lead');
  const worker = addAgent(hub.ctx, 'bob');
  const id: string = (await hub.call('POST', '/api/tasks', { user: 'alice', agent: lead.id, body: oneTask })).json.tasks[0].id;
  const asWorker = { user: 'bob', agent: worker.id };
  await hub.call('POST', `/api/tasks/${id}/claim`, { ...asWorker, body: { branch: 'agflow/T-1-parser' } });
  await hub.call('POST', `/api/tasks/${id}/submit`, { ...asWorker, body: { summary: 'done', headSha: 'abc1234' } });
  expect((await hub.call('POST', `/api/tasks/${id}/accept`, { user: 'alice', agent: lead.id, body: {} })).json.task.status).toBe('accepted');
  return { id, lead: lead.id };
}

describe('operator routes', () => {
  test('without an operator token the routes do not exist', async () => {
    const hub = createTestHub();
    const { id } = await acceptedTask(hub);
    expect((await hub.call('POST', `/api/operator/tasks/${id}/merged`, { ...op(), body: {} })).status).toBe(404);
  });

  test('a wrong or missing operator token, or a person\'s CLI token, is refused', async () => {
    const hub = createTestHub({ operatorToken: TOKEN, operatorUser: 'alice' });
    const { id } = await acceptedTask(hub);
    const path = `/api/operator/tasks/${id}/merged`;
    expect((await hub.call('POST', path, { ...op(`${TOKEN}x`), body: {} })).status).toBe(401);
    expect((await hub.call('POST', path, { body: {} })).status).toBe(401);
    expect((await hub.call('POST', path, { user: 'alice', via: 'cli', body: {} })).status).toBe(401);
    expect((await hub.call('GET', `/api/tasks/${id}`, { user: 'alice', via: 'web' })).json.task.status).toBe('accepted');
  });

  test('the operator marks a task merged and unblocks one, acting as its person', async () => {
    const hub = createTestHub({ operatorToken: TOKEN, operatorUser: 'alice' });
    const { id, lead } = await acceptedTask(hub);
    const merged = await hub.call('POST', `/api/operator/tasks/${id}/merged`, { ...op(), body: { sha: 'def5678' } });
    expect(merged.json.task).toMatchObject({ status: 'merged', mergedSha: 'def5678' });
    const detail = await hub.call('GET', `/api/tasks/${id}`, { user: 'alice', via: 'web' });
    const event = detail.json.events.find((e: { type: string }) => e.type === 'task.merged');
    expect(event.actor).toBe('user:alice');

    const worker = addAgent(hub.ctx, 'bob');
    const other: string = (await hub.call('POST', '/api/tasks', { user: 'alice', agent: lead, body: oneTask })).json.tasks[0].id;
    await hub.call('POST', `/api/tasks/${other}/claim`, { user: 'bob', agent: worker.id, body: { branch: 'agflow/T-2-parser' } });
    await hub.call('POST', `/api/tasks/${other}/block`, { user: 'bob', agent: worker.id, body: { reason: 'waits for T-1' } });
    expect((await hub.call('GET', `/api/tasks/${other}`, { user: 'alice', via: 'web' })).json.task.status).toBe('blocked');
    const unblocked = await hub.call('POST', `/api/operator/tasks/${other}/unblock`, { ...op(), body: { note: 'T-1 is in main' } });
    expect(unblocked.status).toBe(200);
    expect(unblocked.json.task.status).not.toBe('blocked');
  });

  test('the operator messages the lead as its person', async () => {
    const hub = createTestHub({ operatorToken: TOKEN, operatorUser: 'alice' });
    addAgent(hub.ctx, 'alice', 'lead');
    const sent = await hub.call('POST', '/api/operator/messages', { ...op(), body: { to: 'lead', body: 'T-1 is in main' } });
    expect(sent.status).toBe(201);
    expect(sent.json.message).toMatchObject({ from: 'user:alice', body: 'T-1 is in main' });
  });

  test('the operator sets the goal as its person, with the usual version check', async () => {
    const hub = createTestHub({ operatorToken: TOKEN, operatorUser: 'alice' });
    const set = await hub.call('PUT', '/api/operator/goal', { ...op(), body: { text: 'Ship the afisha', baseVersion: 0 } });
    expect(set.status).toBe(200);
    expect(set.json).toMatchObject({ version: 1, text: 'Ship the afisha' });
    const goal = await hub.call('GET', '/api/goal', { user: 'alice', via: 'web' });
    expect(goal.json.current).toMatchObject({ version: 1, text: 'Ship the afisha' });
    const stale = await hub.call('PUT', '/api/operator/goal', { ...op(), body: { text: 'Another', baseVersion: 0 } });
    expect(stale.status).toBe(409);
    expect((await hub.call('PUT', '/api/operator/goal', { ...op(`${TOKEN}x`), body: { text: 'x', baseVersion: 1 } })).status).toBe(401);
  });

  test('the config asks for a long token and an allowed operator', () => {
    const base = {
      AGFLOW_AUTH: 'dev',
      AGFLOW_ALLOWED_USERS: 'alice,bob',
      AGFLOW_PROJECT_NAME: 'demo',
      AGFLOW_PROJECT_REPO: 'https://github.com/acme/demo',
    };
    expect(loadConfig(base).config.operatorToken ?? null).toBeNull();
    expect(() => loadConfig({ ...base, AGFLOW_OPERATOR_TOKEN: 'short', AGFLOW_OPERATOR_USER: 'alice' })).toThrow(/32/);
    expect(() => loadConfig({ ...base, AGFLOW_OPERATOR_TOKEN: TOKEN })).toThrow(/AGFLOW_OPERATOR_USER/);
    expect(() => loadConfig({ ...base, AGFLOW_OPERATOR_TOKEN: TOKEN, AGFLOW_OPERATOR_USER: 'mallory' })).toThrow(/AGFLOW_ALLOWED_USERS/);
    const config = loadConfig({ ...base, AGFLOW_OPERATOR_TOKEN: TOKEN, AGFLOW_OPERATOR_USER: 'Alice' }).config;
    expect(config).toMatchObject({ operatorToken: TOKEN, operatorUser: 'alice' });
  });
});

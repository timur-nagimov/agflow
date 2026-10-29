import { describe, expect, test } from 'bun:test';
import { createTasks } from '../src/tasks';
import { addAgent, newTask } from './helpers';
import { createTestHub } from './http-helpers';

describe('goal routes', () => {
  test('only people in the web UI edit the goal, with conflict detection', async () => {
    const hub = createTestHub();
    const lead = addAgent(hub.ctx, 'alice', 'lead');
    const body = { text: 'Ship it.', baseVersion: 0 };
    expect((await hub.call('PUT', '/api/goal', { user: 'alice', via: 'cli', body })).status).toBe(403);
    expect((await hub.call('PUT', '/api/goal', { user: 'alice', agent: lead.id, body })).status).toBe(403);
    const saved = await hub.call('PUT', '/api/goal', { user: 'alice', via: 'web', body });
    expect(saved.json).toMatchObject({ version: 1, author: 'user:alice' });
    expect((await hub.call('PUT', '/api/goal', { user: 'bob', via: 'web', body: { text: 'Other', baseVersion: 0 } })).status).toBe(409);
  });

  test('current goal with notes, history and diff', async () => {
    const hub = createTestHub();
    const lead = addAgent(hub.ctx, 'alice', 'lead');
    await hub.call('PUT', '/api/goal', { user: 'alice', via: 'web', body: { text: 'one\ntwo', baseVersion: 0 } });
    await hub.call('PUT', '/api/goal', { user: 'alice', via: 'web', body: { text: 'one\nthree', baseVersion: 1 } });
    const note = await hub.call('POST', '/api/goal/notes', { user: 'alice', agent: lead.id, body: { text: 'Reading "three" as v3 of the API.' } });
    expect(note.status).toBe(201);
    const goal = await hub.call('GET', '/api/goal', { user: 'bob', via: 'web' });
    expect(goal.json.current.version).toBe(2);
    expect(goal.json.notes.map((n: { text: string }) => n.text)).toEqual(['Reading "three" as v3 of the API.']);
    expect((await hub.call('GET', '/api/goal/history', { user: 'bob', via: 'web' })).json.versions).toHaveLength(2);
    const diff = await hub.call('GET', '/api/goal/diff?from=1&to=2', { user: 'bob', via: 'web' });
    expect(diff.json.lines).toEqual([
      { op: ' ', text: 'one' },
      { op: '-', text: 'two' },
      { op: '+', text: 'three' },
    ]);
  });

  test('a worker cannot add goal notes', async () => {
    const hub = createTestHub();
    const worker = addAgent(hub.ctx, 'bob');
    expect((await hub.call('POST', '/api/goal/notes', { user: 'bob', agent: worker.id, body: { text: 'x' } })).status).toBe(403);
  });

  test('invalid bodies are a 400 with a readable message', async () => {
    const hub = createTestHub();
    const result = await hub.call('PUT', '/api/goal', { user: 'alice', via: 'web', body: { text: '', baseVersion: 0 } });
    expect(result.status).toBe(400);
    expect(result.json.message).toContain('text');
  });
});

describe('project and status routes', () => {
  test('pause is for people in the web UI', async () => {
    const hub = createTestHub();
    expect((await hub.call('POST', '/api/project/pause', { user: 'alice', via: 'cli', body: { paused: true } })).status).toBe(403);
    expect((await hub.call('POST', '/api/project/pause', { user: 'alice', via: 'web', body: { paused: true } })).json.paused).toBe(true);
    expect((await hub.call('GET', '/api/project', { user: 'bob' })).json).toMatchObject({ name: 'demo', paused: true });
  });

  test('status summarises the project', async () => {
    const hub = createTestHub();
    const lead = addAgent(hub.ctx, 'alice', 'lead');
    createTasks(hub.ctx, [newTask(), newTask()], `agent:${lead.id}`);
    const status = await hub.call('GET', '/api/status', { user: 'bob', via: 'web' });
    expect(status.json).toMatchObject({ goalVersion: 0, counts: { ready: 2 }, activeAgents: 1, humansInbox: [] });
    expect(status.json.lead.id).toBe(lead.id);
  });

  test('the project lets the scheduler start leads on runners by default', async () => {
    const hub = createTestHub();
    expect((await hub.call('GET', '/api/project', { user: 'bob' })).json.runnerLeads).toBe(true);
    expect((await hub.call('GET', '/api/status', { user: 'bob' })).json.project.runnerLeads).toBe(true);
  });

  test('status names the lead seat and the hub epoch, and keeps the lead', async () => {
    const hub = createTestHub();
    const seat = { attemptId: null, runnerId: null, since: null, wakeups: 0, runnerLeads: true };
    const before = await hub.call('GET', '/api/status', { user: 'bob', via: 'web' });
    expect(before.json).toMatchObject({ lead: null, leadSeat: { kind: 'none', agentId: null, ...seat }, epoch: 1 });
    const lead = addAgent(hub.ctx, 'alice', 'lead');
    const after = await hub.call('GET', '/api/status', { user: 'bob', via: 'web' });
    expect(after.json.lead).toMatchObject({ id: lead.id, role: 'lead' });
    expect(after.json.leadSeat).toEqual({ kind: 'live', agentId: lead.id, ...seat, since: hub.ctx.now() });
    expect(after.json.epoch).toBe(1);
  });
});

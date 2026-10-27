import { describe, expect, test } from 'bun:test';
import { createTasks } from '../src/tasks';
import { addAgent, newTask } from './helpers';
import { createTestHub } from './http-helpers';

const oneTask = { tasks: [{ title: 'Parser', objective: 'Parse input', acceptance: [{ id: 'A1', assertion: 'parses' }] }] };

describe('task routes', () => {
  test('the M1 loop: the lead plans, a worker claims and submits, the lead accepts, a person marks it merged', async () => {
    const hub = createTestHub();
    const lead = addAgent(hub.ctx, 'alice', 'lead');
    const worker = addAgent(hub.ctx, 'bob');
    const created = await hub.call('POST', '/api/tasks', { user: 'alice', agent: lead.id, body: oneTask });
    expect(created.status).toBe(201);
    const id: string = created.json.tasks[0].id;
    const asWorker = { user: 'bob', agent: worker.id };
    expect((await hub.call('POST', `/api/tasks/${id}/claim`, { ...asWorker, body: { branch: 'agflow/T-1-parser' } })).json.task.status).toBe('claimed');
    expect((await hub.call('POST', `/api/tasks/${id}/progress`, { ...asWorker, body: { note: 'halfway' } })).json.task.status).toBe('working');
    expect((await hub.call('POST', `/api/tasks/${id}/submit`, { ...asWorker, body: { summary: 'done', headSha: 'abc1234' } })).json.task.status).toBe('submitted');
    expect((await hub.call('POST', `/api/tasks/${id}/accept`, { user: 'alice', agent: lead.id, body: {} })).json.task.status).toBe('accepted');
    expect((await hub.call('POST', `/api/tasks/${id}/merged`, { user: 'alice', via: 'web', body: { sha: 'def5678' } })).json.task.status).toBe('merged');
    const detail = await hub.call('GET', `/api/tasks/${id}`, { user: 'alice', via: 'web' });
    expect(detail.json.task).toMatchObject({ mergedSha: 'def5678', branch: 'agflow/T-1-parser' });
    expect(detail.json.notes.map((note: { body: string }) => note.body)).toEqual(['halfway']);
    const taskEvents = detail.json.events.map((event: { type: string }) => event.type).filter((type: string) => type.startsWith('task.'));
    expect(taskEvents).toEqual(['task.created', 'task.claimed', 'task.working', 'task.progress', 'task.submitted', 'task.accepted', 'task.merged']);
  });

  test('workers and bare CLI tokens cannot plan; people and the lead can', async () => {
    const hub = createTestHub();
    const worker = addAgent(hub.ctx, 'bob');
    expect((await hub.call('POST', '/api/tasks', { user: 'bob', agent: worker.id, body: oneTask })).status).toBe(403);
    expect((await hub.call('POST', '/api/tasks', { user: 'bob', via: 'cli', body: oneTask })).status).toBe(403);
    expect((await hub.call('POST', '/api/tasks', { user: 'bob', via: 'web', body: oneTask })).status).toBe(201);
  });

  test('claiming needs an agent; force-release needs a person in the web UI', async () => {
    const hub = createTestHub();
    const worker = addAgent(hub.ctx, 'bob');
    const [task] = createTasks(hub.ctx, [newTask()], 'user:alice');
    expect((await hub.call('POST', `/api/tasks/${task.id}/claim`, { user: 'bob', body: {} })).status).toBe(403);
    await hub.call('POST', `/api/tasks/${task.id}/claim`, { user: 'bob', agent: worker.id, body: {} });
    const release = { reason: 'went home' };
    expect((await hub.call('POST', `/api/tasks/${task.id}/release-claim`, { user: 'alice', via: 'cli', body: release })).status).toBe(403);
    expect((await hub.call('POST', `/api/tasks/${task.id}/release-claim`, { user: 'alice', via: 'web', body: release })).json.task.status).toBe('ready');
  });

  test('invalid transitions are 409, unknown tasks 404', async () => {
    const hub = createTestHub();
    const [task] = createTasks(hub.ctx, [newTask()], 'user:alice');
    expect((await hub.call('POST', `/api/tasks/${task.id}/merged`, { user: 'alice', via: 'web', body: {} })).status).toBe(409);
    expect((await hub.call('GET', '/api/tasks/T-99', { user: 'alice', via: 'web' })).status).toBe(404);
  });

  test('tasks can be listed by status', async () => {
    const hub = createTestHub();
    const worker = addAgent(hub.ctx, 'bob');
    const [a] = createTasks(hub.ctx, [newTask(), newTask()], 'user:alice');
    await hub.call('POST', `/api/tasks/${a.id}/claim`, { user: 'bob', agent: worker.id, body: {} });
    const ready = await hub.call('GET', '/api/tasks?status=ready', { user: 'bob', via: 'web' });
    expect(ready.json.tasks.map((task: { id: string }) => task.id)).toEqual(['T-2']);
    const mine = await hub.call('GET', `/api/tasks?assignee=${worker.id}`, { user: 'bob', via: 'web' });
    expect(mine.json.tasks.map((task: { id: string }) => task.id)).toEqual(['T-1']);
  });
});

import { describe, expect, test } from 'bun:test';
import { loadConfig } from '../src/config';
import { addAgent } from './helpers';
import { createTestHub } from './http-helpers';

const task = (title: string, dependsOn?: string[]) => ({
  tasks: [{ title, objective: 'Do it', acceptance: [{ id: 'A1', assertion: 'works' }], ...(dependsOn ? { dependsOn } : {}) }],
});

/** Two tasks, the second depending on the first; the first is accepted by the lead. */
async function acceptedWithDependent(hub: ReturnType<typeof createTestHub>): Promise<{ first: string; second: string }> {
  const lead = addAgent(hub.ctx, 'alice', 'lead');
  const worker = addAgent(hub.ctx, 'bob');
  const asLead = { user: 'alice', agent: lead.id };
  const asWorker = { user: 'bob', agent: worker.id };
  const first: string = (await hub.call('POST', '/api/tasks', { ...asLead, body: task('First') })).json.tasks[0].id;
  const second: string = (await hub.call('POST', '/api/tasks', { ...asLead, body: task('Second', [first]) })).json.tasks[0].id;
  await hub.call('POST', `/api/tasks/${first}/claim`, { ...asWorker, body: { branch: 'agflow/T-1-first' } });
  await hub.call('POST', `/api/tasks/${first}/submit`, { ...asWorker, body: { summary: 'done', headSha: 'abc1234' } });
  expect((await hub.call('POST', `/api/tasks/${first}/accept`, { ...asLead, body: {} })).json.task.status).toBe('accepted');
  return { first, second };
}

const statusOf = async (hub: ReturnType<typeof createTestHub>, id: string) =>
  (await hub.call('GET', `/api/tasks/${id}`, { user: 'alice', via: 'web' })).json.task;

describe('dependencies that need a merge', () => {
  test('by default an accepted dependency releases its dependents', async () => {
    const hub = createTestHub();
    const { second } = await acceptedWithDependent(hub);
    expect((await statusOf(hub, second)).status).toBe('ready');
  });

  test('with dependenciesNeedMerge a dependent waits for the merge, then is released by it', async () => {
    const hub = createTestHub({ dependenciesNeedMerge: true });
    const { first, second } = await acceptedWithDependent(hub);
    expect(await statusOf(hub, second)).toMatchObject({ status: 'blocked', blockedKind: 'deps' });
    const merged = await hub.call('POST', `/api/tasks/${first}/merged`, { user: 'alice', via: 'web', body: { sha: 'def5678' } });
    expect(merged.json.task.status).toBe('merged');
    expect((await statusOf(hub, second)).status).toBe('ready');
  });

  test('AGFLOW_DEPENDENCIES_NEED_MERGE=1 turns it on', () => {
    const base = {
      AGFLOW_AUTH: 'dev',
      AGFLOW_ALLOWED_USERS: 'alice',
      AGFLOW_PROJECT_NAME: 'demo',
      AGFLOW_PROJECT_REPO: 'https://github.com/acme/demo',
    };
    expect(loadConfig(base).config.dependenciesNeedMerge).toBe(false);
    expect(loadConfig({ ...base, AGFLOW_DEPENDENCIES_NEED_MERGE: '1' }).config.dependenciesNeedMerge).toBe(true);
    expect(() => loadConfig({ ...base, AGFLOW_DEPENDENCIES_NEED_MERGE: 'yes' })).toThrow(/AGFLOW_DEPENDENCIES_NEED_MERGE/);
  });
});

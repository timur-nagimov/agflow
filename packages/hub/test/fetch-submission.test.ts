import { describe, expect, test } from 'bun:test';
import { mintAgentToken } from '../src/auth';
import { findCommand, recordResult } from '../src/commands';
import { endAttempt } from '../src/attempts';
import { buildBrief } from '../src/brief';
import { flushDeliveries } from '../src/delivery';
import { sendMessage, unreadFor } from '../src/messages';
import { writeTask } from '../src/task-store';
import { claimTask, createTasks, submitTask } from '../src/tasks';
import { addAgent, addRunnerAttempt, addRunnerLead, newTask } from './helpers';
import { createTestHub } from './http-helpers';

const HEAD = 'a'.repeat(40);
const branch = 'person-review';
const ref = `refs/heads/${branch}`;
function setup(live = false, headSha = HEAD) {
  const hub = createTestHub();
  const worker = addAgent(hub.ctx);
  const task = createTasks(hub.ctx, [newTask()], 'user:alice')[0]!;
  claimTask(hub.ctx, task.id, worker);
  submitTask(hub.ctx, task.id, worker, { summary: 'Ready', evidence: [], branch, headSha });
  const lead = live ? { agent: addAgent(hub.ctx, 'alice', 'lead'), attempt: null } : addRunnerLead(hub.ctx);
  const auth = lead.attempt ? { headers: { authorization: `Bearer ${mintAgentToken(hub.ctx, lead.attempt)}` } }
    : { user: 'alice', agent: lead.agent.id };
  const request = () => hub.call('POST', '/api/fetch-submission', { ...auth, body: { task_id: task.id } });
  const poll = (id: string) => hub.call('GET', `/api/fetch-submission/${id}`, auth);
  return { hub, worker, task, lead, auth, request, poll };
}

describe('fetch_submission', () => {
  test('the seated runner lead queues its own refresh and polls the verified head', async () => {
    const { hub, lead, task, request, poll } = setup();
    const answer = await request();
    expect(answer.status).toBe(202);
    const id = answer.json.request.id;
    expect(answer.json.request).toMatchObject({ status: 'pending', branch, head_sha: HEAD });
    expect(findCommand(hub.ctx, id)).toMatchObject({ runnerId: lead.attempt!.runnerId, attemptId: lead.attempt!.id,
      command: { kind: 'refresh_vault', taskId: task.id, refs: [ref] } });
    expect((await request()).json.request.id).toBe(id);
    expect((await poll(id)).json.request.status).toBe('pending');
    recordResult(hub.ctx, lead.attempt!.runnerId!, { commandId: id, ok: true, data: { refs: { [ref]: HEAD } } });
    expect((await poll(id)).json.request).toMatchObject({ status: 'ok', branch, head_sha: HEAD, error: null });
    expect(buildBrief(hub.ctx, lead.agent)).toContain('fetch_submission');
    expect(buildBrief(hub.ctx, lead.agent)).toContain('FETCH_HEAD');
  });

  test.each([7, 39])('fetches a submission accepted by the API with a %i-character head SHA', async (length) => {
    const hub = createTestHub();
    const worker = addAgent(hub.ctx);
    const task = createTasks(hub.ctx, [newTask()], 'user:alice')[0]!;
    claimTask(hub.ctx, task.id, worker);
    const headSha = HEAD.slice(0, length);
    const submitted = await hub.call('POST', `/api/tasks/${task.id}/submit`, {
      user: 'alice', agent: worker.id, body: { summary: 'Ready', evidence: [], branch, headSha },
    });
    expect(submitted.status).toBe(200);
    expect(submitted.json.task.submission.headSha).toBe(headSha);
    const lead = addRunnerLead(hub.ctx);
    const auth = { headers: { authorization: `Bearer ${mintAgentToken(hub.ctx, lead.attempt)}` } };
    const requested = await hub.call('POST', '/api/fetch-submission', { ...auth, body: { task_id: task.id } });
    expect(requested.status).toBe(202);
    const id = requested.json.request.id;
    expect(requested.json.request).toMatchObject({ status: 'pending', head_sha: headSha });
    recordResult(hub.ctx, lead.attempt.runnerId!, { commandId: id, ok: true, data: { refs: { [ref]: HEAD } } });
    const fetched = await hub.call('GET', `/api/fetch-submission/${id}`, auth);
    expect(fetched.json.request).toMatchObject({ status: 'ok', branch, head_sha: HEAD, error: null });
  });

  test.each([
    HEAD.slice(0, 7), HEAD.slice(0, 39), `${HEAD}a`, `${HEAD.slice(0, 39)}g`,
    'b'.repeat(40), null, 123,
  ])('refuses an invalid or mismatched runner SHA for an abbreviated submission: %j', async (fetchedSha) => {
    const { hub, lead, request, poll } = setup(false, HEAD.slice(0, 7));
    const id = (await request()).json.request.id;
    recordResult(hub.ctx, lead.attempt!.runnerId!, { commandId: id, ok: true, data: { refs: { [ref]: fetchedSha } } });
    const read = (await poll(id)).json.request;
    expect(read.status).toBe('failed');
    expect(read.error).toContain('submitted head');
  });

  test.each([
    { ok: false, error: 'remote denied access' },
    { ok: true, data: { refs: { [ref]: 'b'.repeat(40) } } },
    { ok: true },
  ])('relays failure or refuses an unverified/moved head: %j', async (result) => {
    const { hub, lead, request, poll } = setup();
    const id = (await request()).json.request.id;
    recordResult(hub.ctx, lead.attempt!.runnerId!, { commandId: id, ...result });
    const read = (await poll(id)).json.request;
    expect(read.status).toBe('failed');
    expect(read.error).toContain(result.ok ? 'submitted head' : 'remote denied access');
  });

  test('a changed submission branch gets a new fetch instead of reusing an unanswered older one', async () => {
    const { hub, task, request } = setup();
    const old = (await request()).json.request.id;
    const current = hub.ctx.db.query('SELECT submission FROM tasks WHERE id = ?').get(task.id) as { submission: string };
    writeTask(hub.ctx, task.id, { submission: { ...JSON.parse(current.submission), branch: 'revised-review' } });
    const next = (await request()).json.request;
    expect(next.id).not.toBe(old);
    expect(next).toMatchObject({ status: 'pending', branch: 'revised-review' });
    expect(findCommand(hub.ctx, old)?.status).toBe('cancelled');
  });

  test('offline at enqueue or during polling is a clear error', async () => {
    const { hub, lead, request, poll } = setup();
    const id = (await request()).json.request.id;
    hub.ctx.db.query("UPDATE runners SET state = 'offline' WHERE id = ?").run(lead.attempt!.runnerId);
    expect((await request()).json.message).toContain('offline');
    expect((await poll(id)).json.message).toContain('offline');
  });

  test('worker, person and replaced lead cannot fetch; the successor cannot poll the previous lead request', async () => {
    const { hub, worker, lead, task, request, poll } = setup();
    const id = (await request()).json.request.id;
    for (const auth of [{ user: 'alice', agent: worker.id }, { user: 'alice', via: 'web' as const }]) {
      expect((await hub.call('POST', '/api/fetch-submission', { ...auth, body: { task_id: task.id } })).status).toBe(403);
    }
    const runnerWorker = addRunnerAttempt(hub.ctx);
    const workerAuth = { headers: { authorization: `Bearer ${mintAgentToken(hub.ctx, runnerWorker.attempt)}` } };
    expect((await hub.call('POST', '/api/fetch-submission', { ...workerAuth, body: { task_id: task.id } })).status).toBe(403);
    expect((await hub.call('GET', `/api/fetch-submission/${id}`, workerAuth)).status).toBe(403);
    endAttempt(hub.ctx, { attemptId: lead.attempt!.id, trigger: 'crashed', error: 'gone' });
    expect((await poll(id)).status).toBe(401);
    expect(findCommand(hub.ctx, id)?.status).toBe('cancelled');
    const next = addRunnerLead(hub.ctx);
    expect((await hub.call('GET', `/api/fetch-submission/${id}`, {
      headers: { authorization: `Bearer ${mintAgentToken(hub.ctx, next.attempt)}` },
    })).status).toBe(403);
  });

  test('no submission is refused, and a live lead gets its own remote note without a command', async () => {
    const { hub, auth, request } = setup(true);
    const empty = createTasks(hub.ctx, [newTask()], 'user:alice')[0]!;
    expect((await hub.call('POST', '/api/fetch-submission', { ...auth, body: { task_id: empty.id } })).json.message)
      .toContain('no submission');
    expect((await request()).json.request).toMatchObject({ status: 'ok', branch, head_sha: HEAD, note: expect.stringContaining('own git remote') });
    expect(hub.ctx.db.query("SELECT id FROM runner_commands WHERE kind = 'refresh_vault'").all()).toHaveLength(0);
  });

  test('pending refresh reserves no messages: a person and a task-tagged message remain readable and deliverable', async () => {
    const { hub, lead, task, request } = setup();
    expect((await request()).status).toBe(202);
    sendMessage(hub.ctx, { from: 'user:alice', to: 'lead', body: 'Answer me now', taskId: task.id });
    expect(unreadFor(hub.ctx, lead.agent).some((message) => message.body === 'Answer me now')).toBe(true);
    hub.clock.advance(hub.ctx.config.deliveryBatchMs);
    flushDeliveries(hub.ctx);
    const rows = hub.ctx.db.query("SELECT payload FROM runner_commands WHERE kind = 'deliver'").all() as { payload: string }[];
    expect(rows.some((row) => row.payload.includes('Answer me now'))).toBe(true);
  });
});

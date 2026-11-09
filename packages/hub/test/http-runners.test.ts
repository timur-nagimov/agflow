import { describe, expect, test } from 'bun:test';
import { OkResponseSchema, RunnerResponseSchema, RunnersResponseSchema, TEST_ACCOUNT_ID } from '@agflow/core';
import { getAttempt, updateAttempt } from '../src/attempt-store';
import { requestStop } from '../src/attempts';
import { mintAgentToken } from '../src/auth';
import { pendingCommands } from '../src/commands';
import { tx } from '../src/context';
import { listEvents } from '../src/events';
import { accountFor, setOwnerAway, upsertAccountQuota } from '../src/quota';
import { findRunnerRow, getRunner } from '../src/runners';
import { getTask } from '../src/tasks';
import { addRunner, addRunnerAttempt, addRunnerLead } from './helpers';
import { createTestHub } from './http-helpers';

type Hub = ReturnType<typeof createTestHub>;

const eventsOf = (hub: Hub, type: string) => listEvents(hub.ctx.db).filter((event) => event.type === type);

const settingsCommands = (hub: Hub, runnerId: string) =>
  pendingCommands(hub.ctx, runnerId, 1)
    .map((row) => row.command)
    .filter((command) => command.kind === 'update_settings');

/** Alice's Codex account, reported by her runner, then marked away by an expired approval. */
function awayAccount(hub: Hub, runnerId: string): void {
  const windows = { fiveHour: 0.1, weekly: 0.1 };
  const quota = { state: 'ok', resetsAt: null, windows, paidUsage: 'disabled' } as const;
  tx(hub.ctx, (emit) => {
    upsertAccountQuota(hub.ctx, emit, {
      owner: 'alice',
      runnerId,
      report: { vendor: 'codex', accountId: TEST_ACCOUNT_ID, quota: { ...quota, updatedAt: hub.ctx.now() } },
    });
    setOwnerAway(hub.ctx, emit, { owner: 'alice', vendor: 'codex', accountId: TEST_ACCOUNT_ID, approvalId: 'ap-1' });
  });
}

describe('GET /api/runners', () => {
  test('answers { runners, accounts } to signed-in people, without retired runners', async () => {
    const hub = createTestHub();
    const first = addRunner(hub.ctx);
    const second = addRunner(hub.ctx, { owner: 'bob' });
    awayAccount(hub, first);
    hub.ctx.db.query('UPDATE runners SET retired_at = 1 WHERE id = $id').run({ id: second });
    for (const via of ['web', 'cli'] as const) {
      const answer = await hub.call('GET', '/api/runners', { user: 'bob', via });
      expect(answer.status).toBe(200);
      const body = RunnersResponseSchema.parse(answer.json);
      expect(body.runners.map((runner) => runner.id)).toEqual([first]);
      expect(body.accounts.map((account) => [account.owner, account.vendor, account.ownerAway])).toEqual([
        ['alice', 'codex', true],
      ]);
    }
    expect((await hub.call('GET', '/api/runners')).status).toBe(401);
  });
});

describe('PATCH /api/runners/:id', () => {
  test('the owner in a browser changes the settings at a new version, sent with update_settings', async () => {
    const hub = createTestHub();
    const id = addRunner(hub.ctx, { vendors: ['claude', 'codex'] });
    awayAccount(hub, id);
    const before = getRunner(hub.ctx, id).settingsVersion;
    const patch = {
      capacity: 16,
      keepAwake: 'always',
      draining: true,
      ceilings: { claude: { fiveHour: 0, weekly: 0.5 }, codex: { fiveHour: 1, weekly: 1 } },
      allowPaidUsage: { codex: true },
    } as const;
    const answer = await hub.call('PATCH', `/api/runners/${id}`, { user: 'alice', via: 'web', body: patch });
    expect(answer.status).toBe(200);
    const { runner } = RunnerResponseSchema.parse(answer.json);
    expect(runner).toMatchObject({ capacity: 16, keepAwake: 'always', draining: true, settingsVersion: before + 1 });
    // The per-vendor settings show on the runner's vendors.
    expect(runner.vendors.map((slot) => [slot.vendor, slot.ceilings, slot.allowPaidUsage])).toEqual([
      ['claude', { fiveHour: 0, weekly: 0.5 }, false],
      ['codex', { fiveHour: 1, weekly: 1 }, true],
    ]);
    expect(settingsCommands(hub, id)).toEqual([{ kind: 'update_settings', settings: patch, version: before + 1 }]);
    // Changing one of their runners is the owner acting (design 6.10, Owner away).
    expect(accountFor(hub.ctx, 'alice', 'codex', TEST_ACCOUNT_ID)?.ownerAway).toBe(false);
    expect(eventsOf(hub, 'runner.updated').map((event) => [event.actor, event.subject, event.data])).toEqual([
      ['user:alice', id, { runnerId: id, name: `alice-laptop-${id.slice(2)}`, fields: Object.keys(patch) }],
    ]);
  });

  test('values outside the bounds, unknown fields and an empty patch get 400, and change nothing', async () => {
    const hub = createTestHub();
    const id = addRunner(hub.ctx);
    const bad = [
      { capacity: 0 },
      { capacity: 17 },
      { capacity: 1.5 },
      { ceilings: { claude: { fiveHour: 1.1, weekly: 0.5 } } },
      { ceilings: { codex: { fiveHour: 0.5, weekly: -0.1 } } },
      { ceilings: { codex: { fiveHour: 0.5 } } },
      { keepAwake: 'sometimes' },
      { colour: 'red' },
      {},
    ];
    for (const body of bad) {
      const answer = await hub.call('PATCH', `/api/runners/${id}`, { user: 'alice', via: 'web', body });
      const label = JSON.stringify(body);
      expect([label, answer.status, answer.json.error]).toEqual([label, 400, 'bad_request']);
    }
    expect(getRunner(hub.ctx, id).capacity).toBe(2);
    expect(settingsCommands(hub, id)).toEqual([]);
    const lowest = await hub.call('PATCH', `/api/runners/${id}`, { user: 'alice', via: 'web', body: { capacity: 1 } });
    expect([lowest.status, lowest.json.runner.capacity]).toEqual([200, 1]);
  });

  test('another person, a CLI token and an agent get 403; an unknown or retired runner 404', async () => {
    const hub = createTestHub();
    const id = addRunner(hub.ctx);
    const body = { capacity: 3 };
    const bob = await hub.call('PATCH', `/api/runners/${id}`, { user: 'bob', via: 'web', body });
    expect([bob.status, bob.json.error]).toEqual([403, 'forbidden']);
    const cli = await hub.call('PATCH', `/api/runners/${id}`, { user: 'alice', body });
    expect([cli.status, cli.json.error]).toEqual([403, 'forbidden']);
    const live = await hub.liveAgent('alice', 'session-1');
    const agent = await hub.call('PATCH', `/api/runners/${id}`, { user: 'alice', agent: live, body });
    expect([agent.status, agent.json.error]).toEqual([403, 'forbidden']);
    const { attempt } = addRunnerAttempt(hub.ctx);
    const token = mintAgentToken(hub.ctx, attempt);
    const runnerAgent = await hub.call('PATCH', `/api/runners/${id}`, {
      headers: { authorization: `Bearer ${token}` },
      body,
    });
    expect([runnerAgent.status, runnerAgent.json.error]).toEqual([403, 'agent_not_allowed']);
    const unknown = await hub.call('PATCH', '/api/runners/R-99', { user: 'alice', via: 'web', body });
    expect(unknown.status).toBe(404);
    hub.ctx.db.query('UPDATE runners SET retired_at = 1 WHERE id = $id').run({ id });
    const retired = await hub.call('PATCH', `/api/runners/${id}`, { user: 'alice', via: 'web', body });
    expect(retired.status).toBe(404);
    expect(getRunner(hub.ctx, id).capacity).toBe(2);
  });
});

describe('retiring a runner', () => {
  /** A runner with a worker holding a task, a worker whose task is submitted, and the runner lead. */
  function busyRunner(hub: Hub) {
    const held = addRunnerAttempt(hub.ctx);
    const runnerId = held.runner.id;
    const submitted = addRunnerAttempt(hub.ctx, { runnerId });
    updateAttempt(hub.ctx, submitted.attempt.id, { status: 'holding', leaseExpiresAt: null });
    hub.ctx.db.query("UPDATE tasks SET status = 'submitted' WHERE id = $id").run({ id: submitted.task.id });
    const lead = addRunnerLead(hub.ctx);
    hub.ctx.db.query('UPDATE attempts SET runner_id = $runnerId WHERE id = $id').run({ runnerId, id: lead.attempt.id });
    return { runnerId, held, submitted, lead };
  }

  function expectRetired(hub: Hub, runner: ReturnType<typeof busyRunner>, actor: string): void {
    const { runnerId, held, submitted, lead } = runner;
    expect(findRunnerRow(hub.ctx, runnerId)?.retired_at).toBe(hub.ctx.now());
    for (const { attempt } of [held, submitted, lead]) {
      expect(getAttempt(hub.ctx, attempt.id)).toMatchObject({ status: 'ended', endReason: 'lost' });
    }
    expect(getTask(hub.ctx, held.task.id).status).toBe('ready');
    const moves = eventsOf(hub, 'task.stale').map((event) => event.subject);
    expect(moves).toEqual([held.task.id]);
    expect(getTask(hub.ctx, submitted.task.id).status).toBe('submitted');
    expect(eventsOf(hub, 'runner.retired').map((event) => [event.actor, event.subject])).toEqual([[actor, runnerId]]);
  }

  test('DELETE /api/runners/:id by the owner in a browser ends its open attempts lost and retires it', async () => {
    const hub = createTestHub();
    const runner = busyRunner(hub);
    const answer = await hub.call('DELETE', `/api/runners/${runner.runnerId}`, { user: 'alice', via: 'web' });
    expect([answer.status, OkResponseSchema.parse(answer.json)]).toEqual([200, { ok: true }]);
    expectRetired(hub, runner, 'user:alice');
    // The card goes.
    const list = await hub.call('GET', '/api/runners', { user: 'alice', via: 'web' });
    expect(list.json.runners.map((card: { id: string }) => card.id)).not.toContain(runner.runnerId);
    // Retiring again changes nothing.
    const again = await hub.call('DELETE', `/api/runners/${runner.runnerId}`, { user: 'alice', via: 'web' });
    expect(again.status).toBe(200);
    expect(eventsOf(hub, 'runner.retired')).toHaveLength(1);
  });

  test('a take-over in flight ends taken_over, keeps its clone for the hand-back and the task blocked', async () => {
    const hub = createTestHub();
    const taken = addRunnerAttempt(hub.ctx);
    const reason = 'alice takes it over';
    requestStop(hub.ctx, { attemptId: taken.attempt.id, cause: 'takeover', reason, by: 'user:alice' });
    const answer = await hub.call('DELETE', `/api/runners/${taken.runner.id}`, { user: 'alice', via: 'web' });
    expect(answer.status).toBe(200);
    expect(getAttempt(hub.ctx, taken.attempt.id)).toMatchObject({ status: 'ended', endReason: 'taken_over' });
    const kinds = pendingCommands(hub.ctx, taken.runner.id, 1).map((row) => row.command.kind);
    expect(kinds).not.toContain('cleanup_attempt');
    expect(getTask(hub.ctx, taken.task.id)).toMatchObject({ status: 'blocked', blockedKind: 'takeover' });
  });

  test('DELETE by another person or a CLI token gets 403, for an unknown runner 404', async () => {
    const hub = createTestHub();
    const { runnerId } = busyRunner(hub);
    const bob = await hub.call('DELETE', `/api/runners/${runnerId}`, { user: 'bob', via: 'web' });
    expect(bob.status).toBe(403);
    const cli = await hub.call('DELETE', `/api/runners/${runnerId}`, { user: 'alice' });
    expect(cli.status).toBe(403);
    expect((await hub.call('DELETE', '/api/runners/R-99', { user: 'alice', via: 'web' })).status).toBe(404);
    expect(findRunnerRow(hub.ctx, runnerId)?.retired_at).toBeNull();
  });

  test('POST /api/runner/retire with the owner CLI token and the runner key does the same', async () => {
    const hub = createTestHub();
    const runner = busyRunner(hub);
    const runnerKey = findRunnerRow(hub.ctx, runner.runnerId)?.runner_key as string;
    const bob = await hub.call('POST', '/api/runner/retire', { user: 'bob', body: { runnerKey } });
    expect(bob.status).toBe(403);
    const web = await hub.call('POST', '/api/runner/retire', { user: 'alice', via: 'web', body: { runnerKey } });
    expect(web.status).toBe(401);
    const unknown = await hub.call('POST', '/api/runner/retire', { user: 'alice', body: { runnerKey: 'no-such-key' } });
    expect(unknown.status).toBe(404);
    expect(findRunnerRow(hub.ctx, runner.runnerId)?.retired_at).toBeNull();
    const answer = await hub.call('POST', '/api/runner/retire', { user: 'alice', body: { runnerKey } });
    expect([answer.status, answer.json]).toEqual([200, { ok: true }]);
    expectRetired(hub, runner, 'user:alice');
  });
});

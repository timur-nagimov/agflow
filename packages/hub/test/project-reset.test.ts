import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type LiveAttempt, TEST_ACCOUNT_ID, type Task } from '@agflow/core';
import { createSession, mintAgentToken } from '../src/auth';
import { enqueueCommand } from '../src/commands';
import { type HubContext, tx } from '../src/context';
import { GOING_AWAY_CLOSE, Gateway } from '../src/gateway';
import { addGoalNote, updateGoal } from '../src/goal';
import { getHubState, hubEpoch } from '../src/hub-state';
import { listStandingRules, sendMessage } from '../src/messages';
import { accountFor, setOwnerAway } from '../src/quota';
import { COUNTER_ADVANCE } from '../src/restore';
import { recordFailedStart, setLimited } from '../src/runners';
import { idleSlotMinutes, runTick, sampleSlots, withWaitReason } from '../src/scheduler';
import { createTasks } from '../src/tasks';
import { connectFakeRunner, settle } from './fake-runner';
import { addAgent, addLeadNote, addRunner, addRunnerAttempt, addRunnerLead, newTask, sampleCommands } from './helpers';
import { createTestHub } from './http-helpers';

const TOKEN = 'op-0123456789abcdef0123456789abcdef';
const op = (token = TOKEN) => ({ headers: { 'x-agflow-operator': token } });
const RESET = {
  name: 'afisha',
  repo: 'https://github.com/acme/afisha',
  deadline: '2026-11-16T18:00:00+03:00',
  goal: 'Implement SPEC.md completely.',
  rules: ['Stack: Python 3, managed with uv.', 'Keep the demo working.'],
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function backupDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agflow-reset-'));
  dirs.push(dir);
  return dir;
}

const count = (ctx: HubContext, table: string): number =>
  (ctx.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

const counters = (ctx: HubContext): Record<string, number> =>
  Object.fromEntries(
    (ctx.db.query('SELECT name, value FROM counters').all() as { name: string; value: number }[]).map((row) => [
      row.name,
      row.value,
    ]),
  );

/** The tables a reset empties, each given a row by fill(). */
const EMPTIED = [
  'tasks',
  'task_notes',
  'attempts',
  'attempt_log',
  'agent_tokens',
  'submissions',
  'approvals',
  'deliveries',
  'pending_deliveries',
  'goal_notes',
  'lead_notes',
  'task_fetch_grants',
  'agent_fetches',
  'runner_event_rejects',
];

/** An old project with a row in every table a reset empties, and in those it keeps. */
function fill(ctx: HubContext) {
  updateGoal(ctx, { text: 'The old goal', baseVersion: 0 }, 'user:alice');
  addGoalNote(ctx, 'an old note', 'user:alice');
  const live = addAgent(ctx, 'bob');
  const lead = addRunnerLead(ctx);
  const worker = addRunnerAttempt(ctx);
  const task = createTasks(ctx, [newTask({ title: 'Left behind' })], 'user:alice')[0];
  ctx.db.run(`UPDATE agents SET current_task = '${task?.id}' WHERE id = '${live.id}'`);
  const agentToken = mintAgentToken(ctx, worker.attempt);
  const message = sendMessage(ctx, { from: 'user:alice', to: 'all', body: 'an old rule', standingRule: true });
  const now = ctx.now();
  const { id: attemptId, fence } = worker.attempt;
  const values = { attemptId, taskId: worker.task.id, agentId: worker.agent.id, runnerId: worker.runner.id, now };
  ctx.db.query('INSERT INTO deliveries (message_id, agent_id, delivered_at) VALUES ($id, $agentId, $now)').run({
    id: message.id,
    agentId: worker.agent.id,
    now,
  });
  ctx.db
    .query("INSERT INTO pending_deliveries (message_id, attempt_id, command_id, created_at) VALUES (1, $attemptId, 'c', $now)")
    .run({ attemptId, now });
  ctx.db
    .query("INSERT INTO task_notes (task_id, kind, body, author, created_at) VALUES ($taskId, 'progress', 'b', 'a', $now)")
    .run({ taskId: worker.task.id, now });
  ctx.db
    .query("INSERT INTO attempt_log (attempt_id, ts, kind, summary) VALUES ($attemptId, $now, 'note', 'x')")
    .run({ attemptId, now });
  ctx.db
    .query(
      `INSERT INTO submissions (id, task_id, attempt_id, status, summary, evidence, requested_at)
       VALUES ('S-1', $taskId, $attemptId, 'pending', 'done', '[]', $now)`,
    )
    .run({ taskId: worker.task.id, attemptId, now });
  ctx.db
    .query(
      `INSERT INTO approvals (id, attempt_id, fence_epoch, fence_counter, runner_id, owner, task_id, agent_id, kind,
         summary, detail, status, created_at, expires_at)
       VALUES ('6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f', $attemptId, $epoch, $counter, $runnerId, 'alice', $taskId,
         $agentId, 'command', 'run', '{}', 'pending', $now, $now)`,
    )
    .run({ ...values, epoch: fence.epoch, counter: fence.counter });
  ctx.db
    .query("INSERT INTO task_fetch_grants (task_id, granted_by, reason, granted_at) VALUES ($taskId, 'user:alice', 'r', $now)")
    .run({ taskId: worker.task.id, now });
  ctx.db
    .query(
      `INSERT INTO agent_fetches (at, attempt_id, task_id, agent_id, url, bytes)
       VALUES ($now, $attemptId, $taskId, $agentId, 'https://example.com', 0)`,
    )
    .run({ attemptId, taskId: worker.task.id, agentId: worker.agent.id, now });
  ctx.db
    .query(
      `INSERT INTO runner_event_rejects (runner_id, outbox_epoch, seq, type, error, raw, at)
       VALUES ($runnerId, 'e', 1, 'x', 'bad', '{}', $now)`,
    )
    .run({ runnerId: worker.runner.id, now });
  addLeadNote(ctx, { body: 'old handoff', author: 'agent:A-1', attemptId: lead.attempt.id });
  const commands = sampleCommands(worker.attempt);
  for (const kind of ['stop_attempt', 'refresh_vault', 'delete_refs', 'update_settings', 'preflight'] as const) {
    enqueueCommand(ctx, worker.runner.id, commands[kind]);
  }
  ctx.db.run(
    `INSERT INTO vendor_accounts (owner, vendor, account_id, quota, updated_at) VALUES ('alice', 'claude', 'acct', '{}', 1)`,
  );
  ctx.db.run("UPDATE project SET paused = 1, worker_target = 1, vendor_pref = 'codex', vendor_pref_until = 1");
  ctx.db.run('UPDATE hub_state SET dispatch_paused_until = 1, last_lead_review_at = 1, restored_at = 1');
  for (const table of EMPTIED) expect([table, count(ctx, table) > 0]).toEqual([table, true]);
  return { live, agentToken };
}

describe('the project reset', () => {
  test('archives the database, empties the project, keeps people and runners, raises the epoch and sets goal and rules', async () => {
    const dir = backupDir();
    const hub = createTestHub({ operatorToken: TOKEN, operatorUser: 'alice', backupDir: dir });
    const { ctx } = hub;
    const { live, agentToken } = fill(ctx);
    hub.tokenFor('bob', 'cli');
    const sessions = count(ctx, 'sessions');
    const before = counters(ctx);
    const lastEvent = (ctx.db.query('SELECT MAX(id) AS id FROM events').get() as { id: number }).id;
    const epoch = hubEpoch(ctx);

    const reset = await hub.call('POST', '/api/operator/project/reset', { ...op(), body: RESET });
    expect(reset.status).toBe(200);
    const archive = join(dir, readdirSync(dir).find((name) => name.startsWith('agflow-archive-demo-')) as string);
    expect(reset.json).toEqual({
      project: {
        name: 'afisha',
        repo: 'https://github.com/acme/afisha',
        paused: false,
        runnerLeads: true,
        deadlineAt: Date.parse('2026-11-16T15:00:00Z'),
      },
      archive,
      epoch: epoch + 1,
      goalVersion: 1,
    });
    // The restore tool's floor: a backup from before the reset is restored above the reset's epoch.
    expect(readFileSync(join(dir, 'epoch'), 'utf8')).toBe(`${epoch + 1}\n`);

    // The archive holds the old project, whole.
    const archived = new Database(archive, { readonly: true });
    try {
      expect(archived.query('SELECT name FROM project').get()).toEqual({ name: 'demo' });
      expect((archived.query('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n).toBe(3);
    } finally {
      archived.close();
    }

    for (const table of EMPTIED) expect([table, count(ctx, table)]).toEqual([table, 0]);
    // The runner's own commands stay; those about the old work go.
    const kinds = ctx.db.query('SELECT kind FROM runner_commands ORDER BY kind').all() as { kind: string }[];
    expect(kinds.map((row) => row.kind)).toEqual(['preflight', 'update_settings']);
    // Runner agents go; a person's live agent stays, holding no task.
    expect(ctx.db.query('SELECT id, current_task FROM agents').all()).toEqual([{ id: live.id, current_task: null }]);
    expect(count(ctx, 'runners')).toBe(2);
    expect(count(ctx, 'vendor_accounts')).toBe(1);
    expect(count(ctx, 'sessions')).toBe(sessions);
    expect((await hub.call('GET', '/api/runners', { user: 'bob', via: 'cli' })).status).toBe(200);

    const project = ctx.db.query('SELECT * FROM project').get() as Record<string, unknown>;
    expect(project).toMatchObject({
      name: 'afisha',
      repo: 'https://github.com/acme/afisha',
      deadline_at: Date.parse('2026-11-16T15:00:00Z'),
      paused: 0,
      worker_target: null,
      vendor_pref: null,
      vendor_pref_until: null,
      epoch: epoch + 1,
    });
    expect(getHubState(ctx)).toMatchObject({
      leadAgentId: null,
      leadKind: null,
      leadSince: null,
      dispatchPausedUntil: null,
      lastLeadReviewAt: null,
      restoredAt: null,
    });
    for (const name of ['task', 'agent', 'runner', 'lead_attempt', 'submission']) {
      expect([name, counters(ctx)[name]]).toEqual([name, (before[name] as number) + COUNTER_ADVANCE]);
    }
    // New ids follow the old project's, so nothing a runner or a browser kept names a new row.
    const events = ctx.db.query('SELECT id, type, actor, data FROM events ORDER BY id').all() as {
      id: number;
      type: string;
      actor: string;
      data: string;
    }[];
    expect(events[0]?.id).toBeGreaterThan(lastEvent + COUNTER_ADVANCE);
    expect(events[0]).toMatchObject({ type: 'project.reset', actor: 'user:alice' });
    expect(JSON.parse(events[0]?.data as string)).toEqual({
      name: 'afisha',
      repo: 'https://github.com/acme/afisha',
      deadlineAt: Date.parse('2026-11-16T15:00:00Z'),
      previous: 'demo',
      epoch: epoch + 1,
      archive,
    });
    // The deadline's own event, as the deadline routes record it.
    expect(events[1]).toMatchObject({ type: 'project.deadline_set', actor: 'user:alice' });
    expect(JSON.parse(events[1]?.data as string)).toEqual({ deadlineAt: Date.parse('2026-11-16T15:00:00Z') });
    const created = await hub.call('POST', '/api/tasks', {
      user: 'alice',
      via: 'web',
      body: { tasks: [{ title: 'First', objective: 'Start', acceptance: [{ id: 'A1', assertion: 'started' }] }] },
    });
    expect(created.json.tasks[0].id).toBe(`T-${(before.task as number) + COUNTER_ADVANCE + 1}`);

    const goal = await hub.call('GET', '/api/goal', { user: 'alice', via: 'web' });
    expect(goal.json.current).toMatchObject({ version: 1, text: 'Implement SPEC.md completely.', author: 'user:alice' });
    expect(listStandingRules(ctx).map((rule) => [rule.from, rule.to, rule.body])).toEqual([
      ['user:alice', 'all', 'Stack: Python 3, managed with uv.'],
      ['user:alice', 'all', 'Keep the demo working.'],
    ]);
    // The old attempt's token is unknown now: its agent hears that the attempt ended.
    const old = await hub.call('GET', '/api/status', { headers: { authorization: `Bearer ${agentToken}` } });
    expect([old.status, old.json.error]).toEqual([401, 'attempt_ended']);
  });

  test('without a backup folder no archive is written; the deadline may be none', async () => {
    const hub = createTestHub({ operatorToken: TOKEN, operatorUser: 'alice' });
    const reset = await hub.call('POST', '/api/operator/project/reset', { ...op(), body: { ...RESET, deadline: null } });
    expect(reset.status).toBe(200);
    expect(reset.json).toMatchObject({ archive: null, epoch: 2, goalVersion: 1 });
    expect(hub.ctx.db.query('SELECT deadline_at FROM project').get()).toEqual({ deadline_at: null });
    expect(hub.ctx.db.query("SELECT type FROM events WHERE type = 'project.deadline_set'").all()).toEqual([]);
    // What agflow start reads first: the branch the seed goes on.
    expect((await hub.call('GET', '/api/operator/project', op())).json).toMatchObject({
      project: { name: 'afisha', repo: 'https://github.com/acme/afisha', paused: false },
      mainBranch: 'main',
    });
  });

  test('refuses a wrong token, a deadline without its offset and a multi-line name, changing nothing', async () => {
    const hub = createTestHub({ operatorToken: TOKEN, operatorUser: 'alice', backupDir: backupDir() });
    createTasks(hub.ctx, [newTask()], 'user:alice');
    const path = '/api/operator/project/reset';
    expect((await hub.call('GET', '/api/operator/project', op(`${TOKEN}x`))).status).toBe(401);
    expect((await hub.call('POST', path, { ...op(`${TOKEN}x`), body: RESET })).status).toBe(401);
    expect((await hub.call('POST', path, { user: 'alice', via: 'cli', body: RESET })).status).toBe(401);
    // The deadline rule is the deadline routes' own (DeadlineInputSchema).
    for (const deadline of ['2026-11-16T18:00', '2026-11-16T18:00:00']) {
      const refused = await hub.call('POST', path, { ...op(), body: { ...RESET, deadline } });
      expect(refused.status).toBe(400);
      expect(refused.json.message).toContain('such as 2026-11-16T18:00:00+03:00');
    }
    expect((await hub.call('POST', path, { ...op(), body: { ...RESET, name: 'two\nlines' } })).status).toBe(400);
    expect(count(hub.ctx, 'tasks')).toBe(1);
    expect(hubEpoch(hub.ctx)).toBe(1);
  });

  test("runners say hello again: the old project's attempts are stopped and the welcome names the new project", async () => {
    const hub = createTestHub({ operatorToken: TOKEN, operatorUser: 'alice' });
    const { ctx } = hub;
    const gateway = new Gateway(ctx);
    const token = createSession(ctx, 'alice', 'cli');
    const live: LiveAttempt[] = [];
    const runner = await connectFakeRunner(ctx, gateway, { token, attempts: () => live });
    expect(runner.welcome?.project).toEqual({ name: 'demo', repo: 'https://github.com/acme/demo' });
    const { attempt } = addRunnerAttempt(ctx, { runnerId: 'R-1' });
    live.push({ attemptId: attempt.id, fence: attempt.fence, state: 'running', sessionRef: 's-1', clone: true });
    // A protocol 2 runner hears no project: its welcome schema has no room for one.
    const older = await connectFakeRunner(ctx, gateway, {
      token,
      protocol: 2,
      runnerKey: 'runner-key-2',
      machineId: 'machine-2',
    });
    expect(older.welcome).not.toHaveProperty('project');

    expect((await hub.call('POST', '/api/operator/project/reset', { ...op(), body: RESET })).status).toBe(200);
    await settle();
    expect(runner.closedWith).toEqual({ code: GOING_AWAY_CLOSE, reason: 'the project was reset; say hello again' });
    expect(older.closedWith?.code).toBe(GOING_AWAY_CLOSE);

    const welcome = await runner.reconnect();
    await settle();
    expect(welcome?.hubEpoch).toBe(2);
    expect(welcome?.project).toEqual({ name: 'afisha', repo: 'https://github.com/acme/afisha' });
    expect(welcome?.stop).toEqual([{ attemptId: attempt.id, reason: 'the hub does not know this attempt' }]);
  });

  test("clears the owner-away marks, the failed starts and the scheduler's memory; quota limits stay", async () => {
    const hub = createTestHub({ operatorToken: TOKEN, operatorUser: 'alice' });
    const { ctx, clock } = hub;
    const runnerId = addRunner(ctx);
    const task = createTasks(ctx, [newTask()], 'user:alice')[0] as Task;
    sampleSlots(ctx);
    // Alice let an approval expire, so the task waits for her; her runner failed a start, and her account's lead
    // model met its limit.
    tx(ctx, (emit) =>
      setOwnerAway(ctx, emit, { owner: 'alice', vendor: 'claude', accountId: TEST_ACCOUNT_ID, approvalId: 'P-1' }),
    );
    recordFailedStart(ctx, runnerId, 'claude');
    const resetsAt = ctx.now() + 60 * 60_000;
    setLimited(ctx, runnerId, { vendor: 'claude', role: 'lead', resetsAt });
    runTick(ctx);
    clock.advance(15_000);
    const reason = () => withWaitReason(ctx, task).waitReason;
    const hold = () => {
      const row = ctx.db.query('SELECT vendor_holds FROM runners WHERE id = $id').get({ id: runnerId });
      return JSON.parse((row as { vendor_holds: string }).vendor_holds).claude;
    };
    expect([reason(), idleSlotMinutes(ctx)]).toEqual([`no runner can take it: ${runnerId} claude owner away`, 0.5]);
    expect(hold()).toMatchObject({ failedStarts: 1 });

    expect((await hub.call('POST', '/api/operator/project/reset', { ...op(), body: RESET })).status).toBe(200);
    // The new project may use alice's account at once, and her runner's failed starts of the old one count no more.
    expect(accountFor(ctx, 'alice', 'claude', TEST_ACCOUNT_ID)?.ownerAway).toBe(false);
    // A limit is the account's, not the project's: it holds until its reset.
    expect(hold()).toEqual({
      degradedUntil: null,
      failedStarts: 0,
      notReadySince: null,
      limitedUntil: { lead: resetsAt },
    });
    // No task waits for an old reason, and the free slot minutes count again from nothing.
    expect([reason(), idleSlotMinutes(ctx)]).toEqual([null, 0]);
  });
});

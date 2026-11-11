import { afterEach, describe, expect, test } from 'bun:test';
import { DEFAULT_WIP_REF_PREFIX, lateWorkRef, takeoverRef } from '../packages/core/src/naming';
import type { Approval, Attempt, Runner } from '../packages/core/src/types';
import { getAgent } from '../packages/hub/src/agents';
import { attemptLog, getAttempt, listAttempts } from '../packages/hub/src/attempt-store';
import { createSession } from '../packages/hub/src/auth';
import { createContext, type HubConfig } from '../packages/hub/src/context';
import { flushDeliveries, unacknowledgedDeliveries } from '../packages/hub/src/delivery';
import { listEvents } from '../packages/hub/src/events';
import { listLeadNotes } from '../packages/hub/src/lead';
import { sendMessage } from '../packages/hub/src/messages';
import { storeRunnerLeads } from '../packages/hub/src/project';
import { type HubServer, startHub } from '../packages/hub/src/server';
import { findSubmission } from '../packages/hub/src/submission-store';
import { getTask, listTaskNotes } from '../packages/hub/src/task-store';
import { createTasks } from '../packages/hub/src/tasks';
import { makeConfig, newTask, testVendor } from '../packages/hub/test/helpers';
import { type DemoRunner, startDemoRunner } from './demo-runner';

const hubs: HubServer[] = [];
const runners: DemoRunner[] = [];

afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.close();
  for (const hub of hubs.splice(0)) await hub.stop();
});

/** Polls until the predicate holds; the hub and the runner talk over a real socket. */
async function until(what: string, predicate: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

/**
 * A hub on a free port with the scheduler created stopped, and alice's demo runner R-1 linked to it. Runner leads are
 * off unless asked for, so a tick starts only the workers a test expects.
 */
async function setup(options: { runnerLeads?: boolean; config?: Partial<HubConfig> } = {}) {
  const ctx = createContext({ dbPath: ':memory:', config: makeConfig(options.config) });
  storeRunnerLeads(ctx, options.runnerLeads ?? false);
  const hub = startHub(ctx, { scheduler: 'manual', timers: false });
  hubs.push(hub);
  const runner = await startDemoRunner({
    url: hub.url,
    token: createSession(ctx, 'alice', 'cli'),
    runnerKey: 'demo-runner-key-1',
    machineId: 'demo-machine-1',
    name: "alice's MacBook Pro",
    settings: { capacity: 3 },
    vendors: [testVendor('claude')],
    profile: { name: 'auto', weakened: ['network allowlist'], dependencyPrep: false },
    power: { source: 'battery', batteryPercent: 64, lowPowerMode: false },
    disk: { freeBytes: 82e9, agflowBytes: 3e9 },
  });
  runners.push(runner);
  const cookie = `agflow_session=${createSession(ctx, 'alice', 'web')}`;
  /** alice in the browser. */
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(new URL(path, hub.url), {
      method,
      headers: { cookie, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  };
  return { ctx, hub, runner, call };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** A new ready task that the next tick starts on the runner; resolves once its attempt runs. */
async function startWorker({ ctx, hub }: Setup, title = 'Fix the parser'): Promise<Attempt> {
  const [task] = createTasks(ctx, [newTask({ title })], 'user:alice');
  if (!task) throw new Error('no task');
  const started = hub.scheduler?.tick().started ?? [];
  expect(started.map((attempt) => attempt.taskId)).toEqual([task.id]);
  const attemptId = started[0]?.id as string;
  await until(`${attemptId} to run`, () => getAttempt(ctx, attemptId).status === 'running');
  return getAttempt(ctx, attemptId);
}

describe('a demo runner on a real hub', () => {
  test('its hello registers it, and GET /api/runners shows it online with its vendors, profile, power and disk', async () => {
    const { call } = await setup();
    const listed = async () => ((await call('GET', '/api/runners')).json.runners as Runner[])[0];
    await until('the first heartbeat', async () => (await listed())?.power !== null);
    expect(await listed()).toMatchObject({
      id: 'R-1',
      owner: 'alice',
      name: "alice's MacBook Pro",
      state: 'online',
      capacity: 3,
      vendors: [{ vendor: 'claude', ready: true }],
      profile: { name: 'auto', weakened: ['network allowlist'], dependencyPrep: false },
      power: { source: 'battery', batteryPercent: 64, lowPowerMode: false },
      disk: { freeBytes: 82e9, agflowBytes: 3e9 },
    });
  });

  test('the hub dispatches a ready task to it, and the attempt runs with the model and session it reported', async () => {
    const demo = await setup();
    const attempt = await startWorker(demo);
    expect(attempt).toMatchObject({
      runnerId: 'R-1',
      status: 'running',
      model: 'claude-sonnet-5-5',
      sessionRef: `session-${attempt.id}`,
    });
    expect(demo.runner.attempt(attempt.id)).toMatchObject({ taskId: attempt.taskId, running: true });
  });

  test("a person's stop: a handoff note with the agent token, then the exit with the final WIP", async () => {
    const demo = await setup();
    const { ctx, runner, call } = demo;
    const attempt = await startWorker(demo);
    const stop = await call('POST', `/api/agents/${attempt.agentId}/stop`, { reason: 'Enough for today' });
    expect(stop.status).toBe(200);
    await until('the stop', () => getAttempt(ctx, attempt.id).status === 'ended');
    const head = runner.attempt(attempt.id).head;
    expect(getAttempt(ctx, attempt.id)).toMatchObject({ endReason: 'stopped', wipRef: attempt.wipRef, wipSha: head });
    const taskId = attempt.taskId as string;
    expect(getTask(ctx, taskId)).toMatchObject({ status: 'ready', workRef: attempt.wipRef, workSha: head });
    const handoffs = listTaskNotes(ctx, taskId).filter((note) => note.kind === 'handoff');
    expect(handoffs).toMatchObject([{ attemptId: attempt.id, author: `agent:${attempt.agentId}` }]);
    expect(handoffs[0]?.body).toContain('Enough for today');
    expect(runner.errors).toEqual([]);
  });

  test("a successor's start reports its first output, which the hub keeps as a restatement note", async () => {
    const demo = await setup();
    const { ctx, hub, runner, call } = demo;
    const first = await startWorker(demo);
    await call('POST', `/api/agents/${first.agentId}/replace`, { reason: 'Try a fresh session' });
    const taskId = first.taskId as string;
    await until('the task to be ready', () => getTask(ctx, taskId).status === 'ready');
    const [second] = hub.scheduler?.tick().started ?? [];
    expect(second?.taskId).toBe(taskId);
    await until('the restatement', () => listTaskNotes(ctx, taskId).some((note) => note.kind === 'restatement'));
    const restatement = listTaskNotes(ctx, taskId).find((note) => note.kind === 'restatement');
    expect(restatement).toMatchObject({ attemptId: second?.id, author: `agent:${second?.agentId}` });
    expect(runner.attempt(second?.id as string).successor).toBe(true);
  });

  test("an approval it raises shows for its owner, and the owner's decision reaches it as decide_approval", async () => {
    const demo = await setup();
    const { ctx, runner, call } = demo;
    const attempt = await startWorker(demo);
    const approvalId = runner.requestApproval(attempt.id, {
      kind: 'command',
      summary: 'bun add zod',
      detail: { command: 'bun add zod', cwd: '/Users/alice/.agflow/work/T-1-a1', reason: 'the parser needs zod' },
    });
    const pending = async () => (await call('GET', '/api/approvals?status=pending')).json.approvals as Approval[];
    await until('the approval', async () => (await pending()).length === 1);
    expect(await pending()).toMatchObject([{ id: approvalId, attemptId: attempt.id, owner: 'alice', kind: 'command' }]);
    expect((await call('POST', `/api/approvals/${approvalId}`, { decision: 'approve' })).status).toBe(200);
    const decided = () => runner.fake.commands.map((message) => message.command).find((c) => c.kind === 'decide_approval');
    await until('decide_approval', () => decided() !== undefined);
    expect(decided()).toMatchObject({ attemptId: attempt.id, approvalId, decision: 'approve' });
    // With no approval left, the agent goes on with its turn.
    await until('the turn phase', () => getAttempt(ctx, attempt.id).phase === 'turn');
  });

  test('of two pending approvals, deciding one leaves the attempt waiting for the other', async () => {
    const demo = await setup();
    const { ctx, runner, call } = demo;
    const attempt = await startWorker(demo);
    const ask = (summary: string) =>
      runner.requestApproval(attempt.id, {
        kind: 'command',
        summary,
        detail: { command: summary, cwd: '/Users/alice/.agflow/work/T-1-a1', reason: 'the parser needs it' },
      });
    const [first, second] = [ask('bun add zod'), ask('bun add yaml')];
    await until('waiting_approval', () => getAttempt(ctx, attempt.id).phase === 'waiting_approval');
    expect((await call('POST', `/api/approvals/${first}`, { decision: 'decline' })).status).toBe(200);
    const decisions = () => runner.fake.commands.filter((message) => message.command.kind === 'decide_approval');
    await until('the first decision', () => decisions().length === 1);
    runner.fake.heartbeat();
    await runner.settled();
    expect(getAttempt(ctx, attempt.id).phase).toBe('waiting_approval');
    expect((await call('POST', `/api/approvals/${second}`, { decision: 'approve' })).status).toBe(200);
    await until('the turn phase', () => getAttempt(ctx, attempt.id).phase === 'turn');
  });

  test('a submit gets push_submission: a scripted refusal fails it, and a push records it', async () => {
    const demo = await setup();
    const { ctx, runner } = demo;
    const attempt = await startWorker(demo);
    const refused = (await runner.submit(
      attempt.id,
      { summary: 'Parser fixed.' },
      { error: 'needs_merge', detail: 'main moved since the attempt started' },
    )) as { submission: { id: string } };
    await until('the refusal', () => findSubmission(ctx, refused.submission.id)?.status === 'failed');
    expect(findSubmission(ctx, refused.submission.id)?.error).toBe('needs_merge: main moved since the attempt started');
    const pushed = (await runner.submit(attempt.id, { summary: 'Parser fixed, merged with main.' })) as {
      submission: { id: string };
    };
    await until('the submission', () => findSubmission(ctx, pushed.submission.id)?.status === 'submitted');
    const head = runner.attempt(attempt.id).head;
    expect(findSubmission(ctx, pushed.submission.id)?.headSha).toBe(head);
    expect(getTask(ctx, attempt.taskId as string).status).toBe('submitted');
    // The attempt holds for its review, and the runner ends its process but keeps the clone.
    await until('the hold', () => !runner.attempt(attempt.id).running);
    expect(getAttempt(ctx, attempt.id).status).toBe('holding');
    expect(runner.attempt(attempt.id).clone).toBe(true);
  });

  test('a take-over gets prepare_takeover and ends taken_over with the commands; the clone hands it back', async () => {
    const demo = await setup();
    const { ctx, runner, call } = demo;
    const attempt = await startWorker(demo);
    const taskId = attempt.taskId as string;
    expect((await call('POST', `/api/tasks/${taskId}/takeover`)).status).toBe(202);
    await until('the take-over', () => getAttempt(ctx, attempt.id).status === 'ended');
    const ref = takeoverRef(DEFAULT_WIP_REF_PREFIX, taskId, 'alice');
    const ended = getAttempt(ctx, attempt.id);
    expect(ended).toMatchObject({ endReason: 'taken_over', wipSha: runner.attempt(attempt.id).head });
    expect(ended.takeover).toMatchObject({ ref, error: null, handingBack: null });
    expect(ended.takeover?.local).toContain(`--resume session-${attempt.id}`);
    expect(ended.takeover?.anywhere).toContain(`HEAD:${ref}`);
    expect(getTask(ctx, taskId)).toMatchObject({ status: 'blocked', blockedKind: 'takeover' });
    // A take-over reports no attempt.exited (design 6.12).
    expect(attemptLog(ctx, attempt.id).filter((entry) => entry.summary.includes('exited'))).toEqual([]);
    expect(runner.attempt(attempt.id)).toMatchObject({ running: false, clone: true, takenOverBy: 'alice' });

    expect((await call('POST', `/api/tasks/${taskId}/handback`, { source: 'clone' })).status).toBe(202);
    await until('the hand-back', () => getTask(ctx, taskId).status === 'ready');
    const late = lateWorkRef(DEFAULT_WIP_REF_PREFIX, attempt.id, 1);
    expect(getTask(ctx, taskId)).toMatchObject({ workRef: late, workSha: runner.attempt(attempt.id).head });
  });

  test('a delivery is answered delivered, then acknowledged', async () => {
    const demo = await setup({ config: { deliveryBatchMs: 0 } });
    const { ctx, runner } = demo;
    const attempt = await startWorker(demo);
    const message = sendMessage(ctx, { from: 'user:alice', to: `agent:${attempt.agentId}`, body: 'Use the new lexer.' });
    expect(flushDeliveries(ctx).commands).toHaveLength(1);
    // The hub turns attempt.delivered into message.delivered, and attempt.acknowledged into message.acknowledged.
    const types = () =>
      listEvents(ctx.db)
        .filter((event) => event.type === 'message.delivered' || event.type === 'message.acknowledged')
        .map((event) => [event.type, (event.data as { ids: number[] }).ids]);
    await until('the acknowledgement', () => types().length === 2);
    await runner.settled();
    expect(types()).toEqual([
      ['message.delivered', [message.id]],
      ['message.acknowledged', [message.id]],
    ]);
    const delivery = ctx.db
      .query('SELECT acked_at FROM deliveries WHERE message_id = $id AND agent_id = $agentId')
      .get({ id: message.id, agentId: attempt.agentId }) as { acked_at: number | null } | null;
    expect(delivery?.acked_at).not.toBeNull();
    expect(unacknowledgedDeliveries(ctx, attempt.agentId)).toEqual([]);
    expect(runner.errors).toEqual([]);
  });

  test("lateWork pushes an ended attempt's work, which the hub notes for the successor to merge", async () => {
    const demo = await setup();
    const { ctx, hub, runner, call } = demo;
    const first = await startWorker(demo);
    const taskId = first.taskId as string;
    await call('POST', `/api/agents/${first.agentId}/replace`, { reason: 'Try a fresh session' });
    await until('the task to be ready', () => getTask(ctx, taskId).status === 'ready');
    expect(hub.scheduler?.tick().started.map((attempt) => attempt.taskId)).toEqual([taskId]);
    const pushed = runner.lateWork(first.id);
    const ref = lateWorkRef(DEFAULT_WIP_REF_PREFIX, first.id, 1);
    expect(pushed).toEqual({ ref, sha: runner.attempt(first.id).head });
    const lateNotes = () => listTaskNotes(ctx, taskId).filter((note) => note.kind === 'late_work');
    await until('the late-work note', () => lateNotes().length === 1);
    expect(lateNotes()[0]).toMatchObject({ attemptId: first.id });
    expect(lateNotes()[0]?.body).toContain(ref);
  });

  test('holdPlacement keeps new work off the runner until it ends', async () => {
    const demo = await setup();
    const { ctx, hub, runner, call } = demo;
    const accepting = async () =>
      ((await call('GET', '/api/runners')).json.runners as Runner[])[0]?.acceptingUntil ?? null;
    const until60s = Date.now() + 60_000;
    runner.holdPlacement(until60s);
    await until('the hold', async () => (await accepting()) !== null);
    // The heartbeat sends ms from now, so the hub stores the same time, give or take the trip.
    expect(Math.abs(((await accepting()) as number) - until60s)).toBeLessThan(2_000);
    const [task] = createTasks(ctx, [newTask({ title: 'Fix the parser' })], 'user:alice');
    expect(hub.scheduler?.tick().started).toEqual([]);
    runner.holdPlacement(null);
    await until('the end of the hold', async () => (await accepting()) === null);
    const started = hub.scheduler?.tick().started ?? [];
    expect(started.map((attempt) => [attempt.taskId, attempt.runnerId])).toEqual([[task?.id, 'R-1']]);
  });

  test('settled() gives up at its timeout when scripted work hangs', async () => {
    const demo = await setup();
    let release = () => {};
    demo.runner.onStart(() => new Promise<void>((resolve) => (release = resolve)));
    try {
      await startWorker(demo);
      const started = Date.now();
      await expect(demo.runner.settled(100)).rejects.toThrow('did not settle within 100 ms');
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      release();
    }
  });

  test("a runner lead's stop writes its lead handoff through POST /api/lead/handoff", async () => {
    const { ctx, hub, runner, call } = await setup({ runnerLeads: true });
    const lead = hub.scheduler?.tick().lead;
    if (!lead) throw new Error('no runner lead started');
    await until('the lead to run', () => getAttempt(ctx, lead.id).status === 'running');
    expect(getAgent(ctx, lead.agentId).role).toBe('lead');
    await call('POST', `/api/agents/${lead.agentId}/stop`, { reason: 'Hand over to a live chat' });
    await until('the stop', () => getAttempt(ctx, lead.id).status === 'ended');
    expect(listLeadNotes(ctx).filter((note) => note.kind === 'handoff')).toMatchObject([
      { attemptId: lead.id, author: `agent:${lead.agentId}` },
    ]);
    expect(runner.errors).toEqual([]);
  });

  test('after disconnect() the runner shows offline; reconnect() brings it back with its attempts', async () => {
    const demo = await setup();
    const { ctx, runner, call } = demo;
    const attempt = await startWorker(demo);
    const state = async () => ((await call('GET', '/api/runners')).json.runners as Runner[])[0]?.state;
    runner.disconnect();
    await until('offline', async () => (await state()) === 'offline');
    await runner.reconnect();
    await until('online', async () => (await state()) === 'online');
    expect(listAttempts(ctx, { runner: 'R-1' }).map((open) => [open.id, open.status])).toEqual([[attempt.id, 'running']]);
  });
});

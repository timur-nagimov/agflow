import { describe, expect, test } from 'bun:test';
import type { Attempt, AttemptFacts, RawRunnerEvent, RunnerEventData } from '@agflow/core';
import { getAttempt, updateAttempt } from '../src/attempt-store';
import { endAttempt, renewLeases } from '../src/attempts';
import { type CommandRow, pendingCommands } from '../src/commands';
import { type HubContext, tx } from '../src/context';
import { flushDeliveries } from '../src/delivery';
import { applyRunnerEvents } from '../src/events-in';
import { insertLeadNote, seatHolderId } from '../src/hub-state';
import { checkHoldingLeads, ensureLead, wakeHoldingLead } from '../src/lead';
import { markDelivered, sendMessage } from '../src/messages';
import { setPaused } from '../src/project';
import { runTick } from '../src/scheduler';
import { startHub } from '../src/server';
import { getTask } from '../src/task-store';
import { createTasks } from '../src/tasks';
import { addAgent, addRunner, createTestContext, newTask } from './helpers';

const MINUTE = 60_000;

/** Polls until the predicate holds, failing at the deadline; for waits on real timers. */
async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms`);
    await Bun.sleep(5);
  }
}

/** The lead the tick starts, which must start one. */
function tickLead(ctx: HubContext): Attempt {
  const { lead } = runTick(ctx);
  if (!lead) throw new Error('the tick started no lead');
  return lead;
}

/** A runner lead on R-1 (one Claude runner), running. */
function runningLead() {
  const { ctx, clock } = createTestContext();
  const runnerId = addRunner(ctx);
  const lead = tickLead(ctx);
  updateAttempt(ctx, lead.id, { status: 'running', phase: 'idle' });
  return { ctx, clock, runnerId, lead: getAttempt(ctx, lead.id) };
}

/** The lead's process exited on its own while idle, so it holds. */
function holdingLead() {
  const setup = runningLead();
  updateAttempt(setup.ctx, setup.lead.id, { status: 'holding', leaseExpiresAt: null });
  return setup;
}

let seq = 0;

/** The runner reports the attempt's process gone on its own, at its current fence. */
function exited(ctx: HubContext, attempt: Attempt): void {
  const data: RunnerEventData['attempt.exited'] = {
    code: 0,
    signal: null,
    stoppedBy: 'none',
    handoffWritten: false,
    cause: null,
    finalSha: null,
    finalWip: null,
    pushError: null,
  };
  const fence = getAttempt(ctx, attempt.id).fence;
  const raw: RawRunnerEvent = {
    seq: ++seq,
    at: ctx.now(),
    type: 'attempt.exited',
    attemptId: attempt.id,
    fence,
    data,
  };
  const batch = { outboxEpoch: 'outbox-1', events: [raw] };
  applyRunnerEvents(ctx, attempt.runnerId as string, batch, { restoreReplay: false });
  expect(ctx.db.query('SELECT error FROM runner_event_rejects').all()).toEqual([]);
}

/** The resume_attempt commands queued for the attempt. */
const resumes = (ctx: HubContext, attempt: Attempt): CommandRow[] =>
  pendingCommands(ctx, attempt.runnerId as string, 1).filter(
    (row) => row.command.kind === 'resume_attempt' && row.command.attemptId === attempt.id,
  );

/** The newest start_attempt queued on the runner. */
function startOn(ctx: HubContext, runnerId: string) {
  const command = pendingCommands(ctx, runnerId, 1)
    .map((row) => row.command)
    .filter((one) => one.kind === 'start_attempt')
    .at(-1);
  if (command?.kind !== 'start_attempt') throw new Error(`no start_attempt on ${runnerId}`);
  return command;
}

/** The brief of the newest start_attempt queued on the runner. */
const briefOn = (ctx: HubContext, runnerId: string): string => startOn(ctx, runnerId).attempt.brief;

/** The runner reports a failed start or resume of the attempt, at its current fence. */
function failedToStart(ctx: HubContext, attempt: Attempt): void {
  const data: RunnerEventData['attempt.failed_to_start'] = { error: 'the session is gone', refused: null };
  const fence = getAttempt(ctx, attempt.id).fence;
  const type = 'attempt.failed_to_start';
  const raw: RawRunnerEvent = { seq: ++seq, at: ctx.now(), type, attemptId: attempt.id, fence, data };
  const batch = { outboxEpoch: 'outbox-1', events: [raw] };
  applyRunnerEvents(ctx, attempt.runnerId as string, batch, { restoreReplay: false });
  expect(ctx.db.query('SELECT error FROM runner_event_rejects').all()).toEqual([]);
}

const leadNotes = (ctx: HubContext) =>
  ctx.db.query('SELECT attempt_id, kind, author FROM lead_notes ORDER BY id').all() as {
    attempt_id: string | null;
    kind: string;
    author: string;
  }[];

const flush = (ctx: HubContext) =>
  flushDeliveries(ctx, (attempt, unread) => wakeHoldingLead(ctx, attempt, unread));

describe('starting a runner lead', () => {
  test('with the seat empty, the tick starts one on the best runner, takes the seat and demotes other leads', () => {
    const { ctx, clock } = createTestContext();
    addRunner(ctx, { vendors: ['codex'] });
    const claude = addRunner(ctx, { vendors: ['claude'] });
    // A live lead that has not been seen for liveLeadGraceMs no longer holds the seat.
    const live = addAgent(ctx, 'alice', 'lead');
    clock.advance(ctx.config.liveLeadGraceMs);
    expect(seatHolderId(ctx)).toBeNull();

    const lead = tickLead(ctx);
    expect(lead).toMatchObject({ role: 'lead', taskId: null, runnerId: claude, vendor: 'claude', status: 'starting' });
    expect(seatHolderId(ctx)).toBe(lead.agentId);
    const roles = ctx.db.query('SELECT id, role FROM agents ORDER BY seq').all();
    expect(roles).toEqual([
      { id: live.id, role: 'worker' },
      { id: lead.agentId, role: 'lead' },
    ]);
    expect(startOn(ctx, claude).attempt).toMatchObject({ attemptId: lead.id, role: 'lead' });
  });

  test('the lead starts before dispatch, which sees the slot it takes', () => {
    const { ctx } = createTestContext();
    const runnerId = addRunner(ctx);
    const [first, second] = createTasks(ctx, [newTask({ title: 'One' }), newTask({ title: 'Two' })], 'user:alice');
    // The runner has two slots: the lead's and one worker's.
    const result = runTick(ctx);
    expect(result.lead).toMatchObject({ role: 'lead', runnerId });
    expect(result.started.map((attempt) => [attempt.taskId, attempt.runnerId])).toEqual([[first?.id, runnerId]]);
    expect(getTask(ctx, second?.id as string).status).toBe('ready');
  });

  test('none while the project is paused, or with runner leads off', () => {
    const { ctx } = createTestContext();
    addRunner(ctx);
    setPaused(ctx, true, 'user:alice');
    expect(runTick(ctx).lead).toBeNull();
    setPaused(ctx, false, 'user:alice');
    ctx.db.run('UPDATE project SET runner_leads = 0 WHERE id = 1');
    expect(runTick(ctx).lead).toBeNull();
    expect(seatHolderId(ctx)).toBeNull();
    ctx.db.run('UPDATE project SET runner_leads = 1 WHERE id = 1');
    expect(ensureLead(ctx)).not.toBeNull();
  });

  test('a runner lead holds the seat while starting, running, quota_wait or holding', () => {
    const { ctx, lead } = runningLead();
    addRunner(ctx);
    for (const status of ['starting', 'running', 'quota_wait', 'holding'] as const) {
      // A reset a minute away: the lead waits for it rather than being replaced.
      updateAttempt(ctx, lead.id, { status, quotaResetsAt: status === 'quota_wait' ? ctx.now() + MINUTE : null });
      expect([status, seatHolderId(ctx)]).toEqual([status, lead.agentId]);
      const result = runTick(ctx);
      expect([status, result.lead, result.reconciled.quotaWaits]).toEqual([status, null, []]);
      expect(getAttempt(ctx, lead.id).stopRequested).toBeNull();
    }
  });
});

describe('a holding lead', () => {
  test('a delivery resumes it with the delivery as prompt', () => {
    const { ctx, clock, lead } = holdingLead();
    // Nothing unread: it holds.
    expect(flush(ctx).commands).toEqual([]);
    const message = sendMessage(ctx, { from: 'user:alice', to: 'lead', body: 'Look at T-7.' });
    clock.advance(ctx.config.deliveryBatchMs);
    const { commands } = flush(ctx);
    expect(commands.map((row) => row.command.kind)).toEqual(['resume_attempt']);
    expect(getAttempt(ctx, lead.id).status).toBe('starting');
    const [resume] = resumes(ctx, lead);
    if (resume?.command.kind !== 'resume_attempt') throw new Error('no resume');
    expect(resume.command.prompt).toContain('new messages');
    expect(resume.command.messages.map((one) => one.messageId)).toEqual([message.id]);
  });

  test("startHub's delivery timers wake it", async () => {
    const { ctx } = createTestContext({ deliveryBatchMs: 0 });
    addRunner(ctx);
    const lead = tickLead(ctx);
    updateAttempt(ctx, lead.id, { status: 'holding', leaseExpiresAt: null });
    const hub = startHub(ctx, { scheduler: false, timers: true });
    try {
      sendMessage(ctx, { from: 'user:alice', to: 'lead', body: 'Wake up.' });
      await until(() => getAttempt(ctx, lead.id).status === 'starting');
    } finally {
      await hub.stop();
    }
  });

  test('one that exited in a turn resumes at once with its unacknowledged deliveries', () => {
    const { ctx, lead } = runningLead();
    const message = sendMessage(ctx, { from: 'user:alice', to: 'lead', body: 'Plan the parser work.' });
    tx(ctx, (emit) => markDelivered(ctx, emit, lead.agentId, [message.id]));
    updateAttempt(ctx, lead.id, { phase: 'turn' });
    exited(ctx, lead);
    expect(getAttempt(ctx, lead.id).status).toBe('starting');
    const [resume] = resumes(ctx, lead);
    if (resume?.command.kind !== 'resume_attempt') throw new Error('no resume');
    expect(resume.command.prompt).toContain('during a turn');
    expect(resume.command.messages.map((one) => one.messageId)).toEqual([message.id]);
  });

  test('one that exited idle holds until its next delivery', () => {
    const { ctx, lead } = runningLead();
    exited(ctx, lead);
    expect(getAttempt(ctx, lead.id).status).toBe('holding');
    expect(resumes(ctx, lead)).toEqual([]);
  });

  test('its runner offline for runnerLeaseMs ends it lost and empties the seat', () => {
    const { ctx, clock, runnerId, lead } = holdingLead();
    ctx.db.query("UPDATE runners SET state = 'offline', last_seen_at = $now WHERE id = $id").run({
      id: runnerId,
      now: ctx.now(),
    });
    clock.advance(ctx.config.runnerLeaseMs - 1);
    expect(checkHoldingLeads(ctx)).toEqual([]);
    clock.advance(1);
    expect(checkHoldingLeads(ctx)).toEqual([lead.id]);
    expect(getAttempt(ctx, lead.id)).toMatchObject({ status: 'ended', endReason: 'lost', failureClass: 'infra' });
    expect(seatHolderId(ctx)).toBeNull();
  });

  test('a delivery that finds its runner offline ends it lost', () => {
    const { ctx, clock, runnerId, lead } = holdingLead();
    ctx.db.query("UPDATE runners SET state = 'offline' WHERE id = $id").run({ id: runnerId });
    sendMessage(ctx, { from: 'user:alice', to: 'lead', body: 'Are you there?' });
    clock.advance(ctx.config.deliveryBatchMs);
    expect(flush(ctx).commands).toEqual([]);
    expect(getAttempt(ctx, lead.id).endReason).toBe('lost');
    expect(seatHolderId(ctx)).toBeNull();
  });

  test('a runner with no link in any state counts as offline: after runnerLeaseMs, or at a delivery', () => {
    for (const state of ['needs_login', 'incompatible'] as const) {
      const { ctx, clock, runnerId, lead } = holdingLead();
      const unlinked = 'UPDATE runners SET state = $state, connection_id = NULL, last_seen_at = $now WHERE id = $id';
      ctx.db.query(unlinked).run({ id: runnerId, state, now: ctx.now() });
      clock.advance(ctx.config.runnerLeaseMs - 1);
      expect([state, checkHoldingLeads(ctx)]).toEqual([state, []]);
      clock.advance(1);
      expect([state, checkHoldingLeads(ctx)]).toEqual([state, [lead.id]]);
      expect(getAttempt(ctx, lead.id).endReason).toBe('lost');
      expect(seatHolderId(ctx)).toBeNull();

      const woken = holdingLead();
      woken.ctx.db.query(unlinked).run({ id: woken.runnerId, state, now: woken.ctx.now() });
      sendMessage(woken.ctx, { from: 'user:alice', to: 'lead', body: 'Are you there?' });
      woken.clock.advance(woken.ctx.config.deliveryBatchMs);
      expect(flush(woken.ctx).commands).toEqual([]);
      expect([state, getAttempt(woken.ctx, woken.lead.id).endReason]).toEqual([state, 'lost']);
      expect(seatHolderId(woken.ctx)).toBeNull();
    }
  });

  test('a linked runner that is not ready keeps it holding through a delivery', () => {
    const { ctx, clock, runnerId, lead } = holdingLead();
    ctx.db
      .query("UPDATE runners SET state = 'disk_low', connection_id = 'link-1', last_seen_at = $now WHERE id = $id")
      .run({ id: runnerId, now: ctx.now() });
    sendMessage(ctx, { from: 'user:alice', to: 'lead', body: 'Are you there?' });
    clock.advance(ctx.config.runnerLeaseMs);
    expect(flush(ctx).commands).toEqual([]);
    expect(checkHoldingLeads(ctx)).toEqual([]);
    expect(getAttempt(ctx, lead.id).status).toBe('holding');
    expect(seatHolderId(ctx)).toBe(lead.agentId);
  });

  test('one that is not resumable ends lost', () => {
    const { ctx, lead } = holdingLead();
    updateAttempt(ctx, lead.id, { resumable: false });
    expect(checkHoldingLeads(ctx)).toEqual([lead.id]);
    expect(getAttempt(ctx, lead.id).endReason).toBe('lost');
  });

  test('the tick ends one that cannot be resumed before it starts the next lead', () => {
    const { ctx, runnerId, lead } = holdingLead();
    updateAttempt(ctx, lead.id, { resumable: false });
    const result = runTick(ctx);
    expect(result.reconciled.holdingLeads).toEqual([lead.id]);
    expect(result.lead).toMatchObject({ role: 'lead', runnerId });
    expect(result.lead?.id).not.toBe(lead.id);
    expect(seatHolderId(ctx)).toBe(result.lead?.agentId as string);
  });
});

describe('failover', () => {
  test('after crashed or lost the next lead starts on another runner, from the newest lead handoff', () => {
    const { ctx } = createTestContext();
    const first = addRunner(ctx);
    const second = addRunner(ctx);
    const one = tickLead(ctx);
    expect(one.runnerId).toBe(first);
    insertLeadNote(ctx, {
      attemptId: one.id,
      kind: 'handoff',
      body: 'Next: review T-3, then plan the CLI.',
      author: `agent:${one.agentId}`,
    });
    endAttempt(ctx, { attemptId: one.id, trigger: 'crashed', error: 'the agent exited' });
    // It wrote its handoff, so nothing is assembled.
    expect(leadNotes(ctx)).toHaveLength(1);

    const two = tickLead(ctx);
    expect(two.runnerId).toBe(second);
    expect(briefOn(ctx, second)).toContain('Next: review T-3, then plan the CLI.');

    // Lost without a handoff: one is assembled and stored as a lead note, and the next lead starts from it.
    endAttempt(ctx, { attemptId: two.id, trigger: 'lost' });
    expect(leadNotes(ctx).at(-1)).toEqual({ attempt_id: two.id, kind: 'handoff', author: 'system' });
    const three = tickLead(ctx);
    expect(three.runnerId).toBe(first);
    expect(briefOn(ctx, first)).toContain('Lead handoff assembled by agflow');
  });

  test("an assembled note quotes the lead handoff the lost lead started from, for the next lead's brief", () => {
    const { ctx, lead } = runningLead();
    insertLeadNote(ctx, {
      attemptId: lead.id,
      kind: 'handoff',
      body: 'Plan: parser first, then the CLI.',
      author: `agent:${lead.agentId}`,
    });
    endAttempt(ctx, { attemptId: lead.id, trigger: 'rotation' });
    const two = tickLead(ctx);
    endAttempt(ctx, { attemptId: two.id, trigger: 'lost' });
    expect(leadNotes(ctx).at(-1)).toEqual({ attempt_id: two.id, kind: 'handoff', author: 'system' });
    const three = tickLead(ctx);
    const brief = briefOn(ctx, three.runnerId as string);
    expect(brief).toContain('Lead handoff assembled by agflow');
    expect(brief).toContain('Plan: parser first, then the CLI.');
  });

  test('with no other runner, the next lead starts on the same one', () => {
    const { ctx, runnerId, lead } = runningLead();
    endAttempt(ctx, { attemptId: lead.id, trigger: 'crashed', error: 'the agent exited' });
    expect(tickLead(ctx).runnerId).toBe(runnerId);
  });
});

describe('lead endings and liveness', () => {
  test('a lead that ends stopped, replaced or rotated without a lead handoff gets an assembled lead note', () => {
    for (const trigger of ['stop', 'replace', 'rotation'] as const) {
      const { ctx, lead } = runningLead();
      endAttempt(ctx, { attemptId: lead.id, trigger });
      const assembled = { attempt_id: lead.id, kind: 'handoff', author: 'system' };
      expect([trigger, leadNotes(ctx)]).toEqual([trigger, [assembled]]);
    }
    const { ctx, lead } = runningLead();
    const author = `agent:${lead.agentId}`;
    insertLeadNote(ctx, { attemptId: lead.id, kind: 'handoff', body: 'Done for now.', author });
    endAttempt(ctx, { attemptId: lead.id, trigger: 'stop' });
    expect(leadNotes(ctx)).toHaveLength(1);
  });

  test('a lead whose resume fails gets an assembled lead note; one that never started gets none', () => {
    const { ctx, clock, lead } = holdingLead();
    updateAttempt(ctx, lead.id, { sessionRef: 'session-1' });
    sendMessage(ctx, { from: 'user:alice', to: 'lead', body: 'Look at T-7.' });
    clock.advance(ctx.config.deliveryBatchMs);
    expect(flush(ctx).commands.map((row) => row.command.kind)).toEqual(['resume_attempt']);
    failedToStart(ctx, lead);
    expect(getAttempt(ctx, lead.id).endReason).toBe('failed_to_start');
    expect(leadNotes(ctx)).toEqual([{ attempt_id: lead.id, kind: 'handoff', author: 'system' }]);

    const fresh = tickLead(ctx);
    failedToStart(ctx, fresh);
    expect(getAttempt(ctx, fresh.id).endReason).toBe('failed_to_start');
    expect(leadNotes(ctx)).toHaveLength(1);
  });

  test("the lead agent's last_seen_at follows its lease", () => {
    const { ctx, clock, runnerId, lead } = runningLead();
    clock.advance(10 * MINUTE);
    const facts: AttemptFacts = {
      attemptId: lead.id,
      fence: lead.fence,
      phase: 'idle',
      eventAgeMs: 5_000,
      tool: null,
      fsAgeMs: null,
      commitAgeMs: null,
      turns: 2,
      turnsWithoutProgress: 0,
      repeatedCalls: 0,
      continuations: 0,
      vendorErrorMs: 0,
      activeMs: 60_000,
      contextUsed: 0.2,
    };
    tx(ctx, (emit) => renewLeases(ctx, emit, runnerId, [facts]));
    expect(getAttempt(ctx, lead.id).leaseExpiresAt).toBe(ctx.now() + ctx.config.runnerLeaseMs);
    expect(ctx.db.query('SELECT last_seen_at FROM agents WHERE id = $id').get({ id: lead.agentId })).toEqual({
      last_seen_at: ctx.now(),
    });
  });
});

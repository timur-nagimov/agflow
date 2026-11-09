import { describe, expect, test } from 'bun:test';
import type { Attempt, AttemptFacts, Message, RawRunnerEvent, RunnerEventData } from '@agflow/core';
import { getAttempt, updateAttempt } from '../src/attempt-store';
import { endAttempt, renewLeases, requestStop } from '../src/attempts';
import { type CommandRow, pendingCommands } from '../src/commands';
import { type HubContext, tx } from '../src/context';
import { DELIVERY_CHAR_LIMIT, flushDeliveries, injectedMessage } from '../src/delivery';
import { listEvents } from '../src/events';
import { applyRunnerEvents } from '../src/events-in';
import { getHubState, insertLeadNote, seatHolderId } from '../src/hub-state';
import { checkHoldingLeads, ensureLead, periodicLeadReview, rotateLeadIfDue, wakeHoldingLead } from '../src/lead';
import { listMessages, markDelivered, sendMessage } from '../src/messages';
import { setPaused } from '../src/project';
import { runTick } from '../src/scheduler';
import { startHub } from '../src/server';
import { getTask } from '../src/task-store';
import { createTasks } from '../src/tasks';
import { addAgent, addRunner, addRunnerAttempt, createTestContext, markHubAlive, newTask } from './helpers';

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
    markHubAlive(ctx);
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
      expect([status, result.lead, result.reconciled?.quotaWaits]).toEqual([status, null, []]);
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
    // The situation report goes first (design 6.11).
    expect(resume.command.messages.map((one) => one.messageId)).toEqual([0, message.id]);
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
    expect(result.reconciled?.holdingLeads).toEqual([lead.id]);
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

describe('wake-ups', () => {
  /** The deliver commands queued for the attempt. */
  const delivers = (ctx: HubContext, attempt: Attempt) =>
    pendingCommands(ctx, attempt.runnerId as string, 1).flatMap((row) =>
      row.command.kind === 'deliver' && row.command.attemptId === attempt.id ? [row.command] : [],
    );

  const rowsOf = (ctx: HubContext, attemptId: string) =>
    (
      ctx.db.query('SELECT message_id FROM pending_deliveries WHERE attempt_id = $attemptId').all({ attemptId }) as {
        message_id: number;
      }[]
    ).map((row) => row.message_id);

  test('every delivery to a runner lead starts with the situation report, hub text, and counts a wake-up', () => {
    const { ctx, clock, lead } = runningLead();
    const first = sendMessage(ctx, { from: 'user:alice', to: 'lead', body: 'Plan the parser work.' });
    clock.advance(ctx.config.deliveryBatchMs);
    flush(ctx);
    const [deliver] = delivers(ctx, lead);
    const [report, message] = deliver?.messages ?? [];
    expect(report).toMatchObject({ messageId: 0, authority: 'system' });
    expect(report?.text).toContain('## Situation report');
    expect(message?.messageId).toBe(first.id);
    // The report has no message row, so nothing is in flight for it.
    expect(rowsOf(ctx, lead.id)).toEqual([first.id]);
    expect(getAttempt(ctx, lead.id).wakeups).toBe(1);

    sendMessage(ctx, { from: 'user:alice', to: 'lead', body: 'And the CLI.' });
    clock.advance(ctx.config.deliveryBatchMs);
    flush(ctx);
    expect(delivers(ctx, lead).map((command) => command.messages[0]?.messageId)).toEqual([0, 0]);
    expect(getAttempt(ctx, lead.id).wakeups).toBe(2);
  });

  test("a holding lead's resume is its delivery: the report goes first, and it counts", () => {
    const { ctx, clock, lead } = holdingLead();
    const message = sendMessage(ctx, { from: 'user:alice', to: 'lead', body: 'Look at T-7.' });
    clock.advance(ctx.config.deliveryBatchMs);
    flush(ctx);
    const [resume] = resumes(ctx, lead);
    if (resume?.command.kind !== 'resume_attempt') throw new Error('no resume');
    expect(resume.command.messages.map((one) => [one.messageId, one.authority])).toEqual([
      [0, 'system'],
      [message.id, 'person'],
    ]);
    expect(getAttempt(ctx, lead.id).wakeups).toBe(1);
  });

  /** Two messages to the target whose formatted texts add up to exactly DELIVERY_CHAR_LIMIT. */
  function filling(ctx: HubContext, to: string): [Message, Message] {
    const first = sendMessage(ctx, { from: 'user:alice', to, body: 'a'.repeat(DELIVERY_CHAR_LIMIT / 2 - 200) });
    const header = injectedMessage(first).text.length - first.body.length;
    const rest = DELIVERY_CHAR_LIMIT - injectedMessage(first).text.length;
    const second = sendMessage(ctx, { from: 'user:alice', to, body: 'b'.repeat(rest - header) });
    expect(injectedMessage(first).text.length + injectedMessage(second).text.length).toBe(DELIVERY_CHAR_LIMIT);
    return [first, second];
  }

  test('the situation report counts toward the limit of a lead delivery', () => {
    const { ctx, clock, lead } = runningLead();
    const [first] = filling(ctx, 'lead');
    clock.advance(ctx.config.deliveryBatchMs);
    flush(ctx);
    const [deliver] = delivers(ctx, lead);
    expect([deliver?.messages.map((one) => one.messageId), deliver?.more]).toEqual([[0, first.id], 1]);

    // A worker's delivery has no report, so the same two fit in one.
    const worker = createTestContext();
    const held = addRunnerAttempt(worker.ctx);
    const pair = filling(worker.ctx, `agent:${held.agent.id}`);
    worker.clock.advance(worker.ctx.config.deliveryBatchMs);
    flush(worker.ctx);
    const [batch] = delivers(worker.ctx, held.attempt);
    expect([batch?.messages.map((one) => one.messageId), batch?.more]).toEqual([pair.map((one) => one.id), 0]);
  });

  test("a worker's delivery has no report and counts nothing", () => {
    const { ctx, clock } = createTestContext();
    const held = addRunnerAttempt(ctx);
    const message = sendMessage(ctx, { from: 'user:alice', to: `agent:${held.agent.id}`, body: 'Use the new API.' });
    clock.advance(ctx.config.deliveryBatchMs);
    flush(ctx);
    expect(delivers(ctx, held.attempt).map((command) => command.messages.map((one) => one.messageId))).toEqual([
      [message.id],
    ]);
    expect(getAttempt(ctx, held.attempt.id).wakeups).toBe(0);
  });
});

describe('the periodic review', () => {
  const reviews = (ctx: HubContext) =>
    listMessages(ctx, { target: 'lead' }).filter((message) => message.from === 'system');

  test('a review message goes to the lead every leadReviewMs while a task is held or submitted', () => {
    const { ctx, clock } = runningLead();
    // Nothing held: no review, and no clock runs.
    expect(periodicLeadReview(ctx)).toBeNull();
    expect(getHubState(ctx).lastLeadReviewAt).toBeNull();
    const held = addRunnerAttempt(ctx);
    const working = addRunnerAttempt(ctx);
    ctx.db.query("UPDATE tasks SET status = 'working' WHERE id = $id").run({ id: working.task.id });
    const submitted = addRunnerAttempt(ctx);
    ctx.db.query("UPDATE tasks SET status = 'submitted' WHERE id = $id").run({ id: submitted.task.id });
    // The clock starts when work is held; the first review comes leadReviewMs later.
    expect(periodicLeadReview(ctx)).toBeNull();
    expect(getHubState(ctx).lastLeadReviewAt).toBe(ctx.now());
    clock.advance(ctx.config.leadReviewMs - 1);
    expect(periodicLeadReview(ctx)).toBeNull();
    clock.advance(1);
    const review = periodicLeadReview(ctx);
    expect(review).toMatchObject({ from: 'system', to: 'lead' });
    expect(review?.body).toContain(`${held.task.id} [claimed]`);
    expect(review?.body).toContain(`${working.task.id} [working]`);
    expect(review?.body).toContain(`${submitted.task.id} [submitted]`);
    expect(getHubState(ctx).lastLeadReviewAt).toBe(ctx.now());
    expect(periodicLeadReview(ctx)).toBeNull();
    // The tick runs it; the runners stay connected meanwhile.
    const later = ctx.now() + 2 * ctx.config.leadReviewMs;
    ctx.db.query("UPDATE attempts SET lease_expires_at = $later WHERE status != 'ended'").run({ later });
    clock.advance(ctx.config.leadReviewMs);
    markHubAlive(ctx);
    expect(runTick(ctx).reconciled?.leadReview).toBe(true);
    expect(reviews(ctx)).toHaveLength(2);
    // Once nothing is held or submitted, the clock stops.
    ctx.db.run("UPDATE tasks SET status = 'done'");
    expect(periodicLeadReview(ctx)).toBeNull();
    expect(getHubState(ctx).lastLeadReviewAt).toBeNull();
  });

  test('none while the seat is empty; a lead that takes the seat gets the review that is due', () => {
    const { ctx, clock } = createTestContext();
    addRunnerAttempt(ctx);
    expect(periodicLeadReview(ctx)).toBeNull();
    clock.advance(ctx.config.leadReviewMs);
    expect(periodicLeadReview(ctx)).toBeNull();
    expect(reviews(ctx)).toEqual([]);
    // The clock kept running, so the review comes as soon as a lead holds the seat.
    clock.advance(MINUTE);
    addAgent(ctx, 'alice', 'lead');
    expect(periodicLeadReview(ctx)).toMatchObject({ from: 'system', to: 'lead' });
  });
});

describe('rotation', () => {
  /** A runner lead on R-1, running, and R-2 with more free slots, which a fresh lead would otherwise prefer. */
  function rotationSetup(overrides: Partial<HubContext['config']> = {}) {
    const { ctx, clock } = createTestContext(overrides);
    const runnerId = addRunner(ctx);
    const lead = tickLead(ctx);
    updateAttempt(ctx, lead.id, { status: 'running', phase: 'idle' });
    const roomier = addRunner(ctx);
    ctx.db.query('UPDATE runners SET capacity = 8 WHERE id = $id').run({ id: roomier });
    return { ctx, clock, runnerId, lead: getAttempt(ctx, lead.id) };
  }

  const stopsOf = (ctx: HubContext, attempt: Attempt) =>
    pendingCommands(ctx, attempt.runnerId as string, 1).flatMap((row) =>
      row.command.kind === 'stop_attempt' && row.command.attemptId === attempt.id ? [row.command] : [],
    );

  test('at leadRotateWakeups the lead is asked for a handoff and rotated; the next lead prefers its runner', () => {
    const { ctx, runnerId, lead } = rotationSetup({ leadRotateWakeups: 3 });
    updateAttempt(ctx, lead.id, { wakeups: 2 });
    expect(rotateLeadIfDue(ctx)).toBeNull();
    updateAttempt(ctx, lead.id, { wakeups: 3 });
    expect(rotateLeadIfDue(ctx)).toBe(lead.id);
    expect(getAttempt(ctx, lead.id).stopRequested).toMatchObject({ cause: 'rotation', handoff: true, by: 'system' });
    const [stop] = stopsOf(ctx, lead);
    expect(stop).toMatchObject({ cause: 'rotation', handoff: true });
    expect(stop?.reason).toContain('write_handoff');
    // One clause, which the runner's handoff prompt quotes.
    expect(stop?.reason).toStartWith('the lead rotates after 3 wake-ups;');
    expect(stop?.reason.endsWith('.')).toBe(false);
    const [rotated] = listEvents(ctx.db).filter((event) => event.type === 'lead.rotated');
    expect(rotated?.data).toMatchObject({ attemptId: lead.id, agentId: lead.agentId, runnerId });
    // Asked once.
    expect(rotateLeadIfDue(ctx)).toBeNull();
    expect(stopsOf(ctx, lead)).toHaveLength(1);

    insertLeadNote(ctx, { attemptId: lead.id, kind: 'handoff', body: 'Next: T-4.', author: `agent:${lead.agentId}` });
    exited(ctx, lead);
    expect(getAttempt(ctx, lead.id)).toMatchObject({ status: 'ended', endReason: 'rotated', failureClass: null });
    expect(seatHolderId(ctx)).toBeNull();
    const next = tickLead(ctx);
    expect(next.runnerId).toBe(runnerId);
    expect(briefOn(ctx, runnerId)).toContain('Next: T-4.');
  });

  test('context used past 0.7 rotates it too; the tick does it', () => {
    const { ctx, lead } = rotationSetup();
    const facts: AttemptFacts = {
      attemptId: lead.id,
      fence: lead.fence,
      phase: 'idle',
      eventAgeMs: 5_000,
      tool: null,
      fsAgeMs: null,
      commitAgeMs: null,
      turns: 9,
      turnsWithoutProgress: 0,
      repeatedCalls: 0,
      continuations: 0,
      vendorErrorMs: 0,
      activeMs: 60_000,
      contextUsed: 0.7,
    };
    updateAttempt(ctx, lead.id, { facts, factsAt: ctx.now() });
    expect(runTick(ctx).reconciled?.rotated).toBeNull();
    updateAttempt(ctx, lead.id, { facts: { ...facts, contextUsed: 0.71 }, factsAt: ctx.now() });
    expect(runTick(ctx).reconciled?.rotated).toBe(lead.id);
    expect(getAttempt(ctx, lead.id).stopRequested?.reason).toContain('71%');
  });

  test('a lead that is not running, or is stopping already, is not rotated', () => {
    const { ctx, lead } = rotationSetup({ leadRotateWakeups: 1 });
    updateAttempt(ctx, lead.id, { wakeups: 1 });
    for (const status of ['starting', 'quota_wait', 'holding'] as const) {
      updateAttempt(ctx, lead.id, { status });
      expect([status, rotateLeadIfDue(ctx)]).toEqual([status, null]);
    }
    updateAttempt(ctx, lead.id, { status: 'running' });
    requestStop(ctx, { attemptId: lead.id, cause: 'stop', reason: 'enough', by: 'user:alice' });
    expect(rotateLeadIfDue(ctx)).toBeNull();
    expect(getAttempt(ctx, lead.id).stopRequested?.cause).toBe('stop');
  });

  test('while the project is paused, a due lead is rotated only after the unpause', () => {
    const { ctx, runnerId, lead } = rotationSetup({ leadRotateWakeups: 3 });
    updateAttempt(ctx, lead.id, { wakeups: 3 });
    setPaused(ctx, true, 'user:alice');
    expect(runTick(ctx).reconciled?.rotated).toBeNull();
    expect(getAttempt(ctx, lead.id).stopRequested).toBeNull();
    expect(seatHolderId(ctx)).toBe(lead.agentId);
    setPaused(ctx, false, 'user:alice');
    expect(runTick(ctx).reconciled?.rotated).toBe(lead.id);
    exited(ctx, lead);
    expect(getAttempt(ctx, lead.id).endReason).toBe('rotated');
    expect(runTick(ctx).lead).toMatchObject({ role: 'lead', runnerId });
  });
});

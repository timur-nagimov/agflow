import { describe, expect, test } from 'bun:test';
import { type EndingTrigger, type TaskStatus, failureSignature } from '@agflow/core';
import { getAgent } from '../src/agents';
import { getAttempt, insertAttempt, issueFence, updateAttempt } from '../src/attempt-store';
import { endAttempt, startRunnerAttempt } from '../src/attempts';
import { mintAgentToken, resolveAgentToken } from '../src/auth';
import { enqueueCommand, findCommand, pendingCommands } from '../src/commands';
import { tx } from '../src/context';
import { listEvents } from '../src/events';
import { assembleHandoffNote } from '../src/handoff';
import { getHubState, takeSeat } from '../src/hub-state';
import { addNote, getTask, listTaskNotes, move, writeTask } from '../src/task-store';
import { createTasks } from '../src/tasks';
import { addAgent, addRunner, addRunnerAttempt, createTestContext, newTask } from './helpers';

type Ctx = ReturnType<typeof createTestContext>['ctx'];

function setup() {
  const { ctx, clock } = createTestContext();
  const held = addRunnerAttempt(ctx);
  return { ctx, clock, held };
}

const kinds = (ctx: Ctx, runnerId: string) => pendingCommands(ctx, runnerId, 1).map((row) => row.kind);

describe('ending an attempt', () => {
  test('sets the end, emits attempt.ended, revokes its tokens and cancels its commands but three kinds', () => {
    const { ctx, clock, held } = setup();
    const { attempt, runner } = held;
    const token = mintAgentToken(ctx, attempt);
    const queued = (['deliver', 'interrupt', 'cleanup_attempt', 'upload_transcript', 'hand_back'] as const).map((kind) =>
      enqueueCommand(
        ctx,
        runner.id,
        kind === 'deliver'
          ? { kind, attemptId: attempt.id, fence: attempt.fence, messages: [], more: 0 }
          : kind === 'interrupt'
            ? { kind, attemptId: attempt.id, fence: attempt.fence }
            : kind === 'hand_back'
              ? { kind, attemptId: attempt.id, source: { kind: 'clone' } }
              : { kind, attemptId: attempt.id },
      ),
    );
    clock.advance(5_000);
    const error = 'git push failed for /Users/bob/.agflow/vaults/demo.git: exit 128';
    const ending = endAttempt(ctx, { attemptId: attempt.id, trigger: 'crashed', error });
    expect(ending?.attempt).toMatchObject({
      status: 'ended',
      endReason: 'crashed',
      failureClass: 'infra',
      failureSignature: failureSignature('crashed', error),
      endedAt: ctx.now(),
      leaseExpiresAt: null,
    });
    expect(getAttempt(ctx, attempt.id)).toEqual(ending?.attempt as never);
    expect(() => resolveAgentToken(ctx, token)).toThrow(expect.objectContaining({ code: 'attempt_ended' }));
    // Revoked, not only refused: retention deletes only revoked tokens.
    expect(
      ctx.db
        .query('SELECT COUNT(*) AS n FROM agent_tokens WHERE attempt_id = $id AND revoked_at IS NULL')
        .get({ id: attempt.id }),
    ).toEqual({ n: 0 });
    expect(queued.map((row) => findCommand(ctx, row.id)?.status)).toEqual([
      'cancelled',
      'cancelled',
      'pending',
      'pending',
      'pending',
    ]);
    const ended = listEvents(ctx.db).filter((event) => event.type === 'attempt.ended');
    expect(ended.map((event) => [event.subject, event.data])).toEqual([
      [
        held.task.id,
        {
          attemptId: attempt.id,
          taskId: held.task.id,
          agentId: held.agent.id,
          runnerId: runner.id,
          endReason: 'crashed',
          failureClass: 'infra',
        },
      ],
    ]);
    // An ended attempt ends once.
    expect(endAttempt(ctx, { attemptId: attempt.id, trigger: 'lost' })).toBeNull();
    expect(getAttempt(ctx, attempt.id).endReason).toBe('crashed');
  });

  test('only infra endings record a signature, and a row that ends nothing is refused', () => {
    const { ctx, held } = setup();
    const ending = endAttempt(ctx, { attemptId: held.attempt.id, trigger: 'stall_loop', error: 'loop' });
    expect(ending?.attempt).toMatchObject({ endReason: 'stalled', failureClass: 'agent', failureSignature: null });
    const lost = addRunnerAttempt(ctx, { runnerId: held.runner.id });
    expect(endAttempt(ctx, { attemptId: lost.attempt.id, trigger: 'lost' })?.attempt.failureSignature).toBeNull();
    const kept = addRunnerAttempt(ctx, { runnerId: held.runner.id });
    for (const trigger of ['submission', 'review_resume', 'suspend', 'lead_exit'] as const) {
      expect(() => endAttempt(ctx, { attemptId: kept.attempt.id, trigger })).toThrow(`${trigger} does not end an attempt`);
    }
    expect(getAttempt(ctx, kept.attempt.id).status).toBe('running');
  });
});

describe('cleanup', () => {
  test('is queued for every runner attempt but taken_over ones awaiting a hand-back; live ones queue nothing', () => {
    const { ctx, held } = setup();
    endAttempt(ctx, { attemptId: held.attempt.id, trigger: 'stop' });
    expect(kinds(ctx, held.runner.id)).toEqual(['cleanup_attempt']);
    expect(pendingCommands(ctx, held.runner.id, 1)[0]?.command).toEqual({
      kind: 'cleanup_attempt',
      attemptId: held.attempt.id,
    });

    // The clone of a take-over waits for the hand-back while its task is still blocked as taken over, whatever ended
    // the attempt.
    const takeover = { cause: 'takeover', reason: 'taken over by alice', by: 'user:alice', handoff: false } as const;
    const takenOver = () => {
      const taken = addRunnerAttempt(ctx, { runnerId: held.runner.id });
      updateAttempt(ctx, taken.attempt.id, { stopRequested: { ...takeover, deferred: false, at: ctx.now() } });
      writeTask(ctx, taken.task.id, { status: 'blocked', blockedKind: 'takeover', blockedReason: takeover.reason });
      return taken;
    };
    const taken = takenOver();
    endAttempt(ctx, { attemptId: taken.attempt.id, trigger: 'takeover' });
    endAttempt(ctx, { attemptId: takenOver().attempt.id, trigger: 'crashed' });
    expect(kinds(ctx, held.runner.id)).toEqual(['cleanup_attempt']);
    // One whose task was cancelled meanwhile can have no hand-back: its clone goes.
    const cancelled = takenOver();
    writeTask(ctx, cancelled.task.id, { status: 'cancelled' });
    endAttempt(ctx, { attemptId: cancelled.attempt.id, trigger: 'takeover' });
    expect(kinds(ctx, held.runner.id)).toEqual(['cleanup_attempt', 'cleanup_attempt']);

    // A live chat's attempt has no runner, so nothing is queued and its task is M1's to move.
    const live = addAgent(ctx, 'bob');
    const liveAttempt = tx(ctx, () =>
      insertAttempt(ctx, {
        id: `${taken.task.id}-a2`,
        taskId: taken.task.id,
        number: 2,
        role: 'worker',
        agentId: live.id,
        runnerId: null,
        vendor: 'claude',
        fence: issueFence(ctx),
        status: 'running',
      }),
    );
    const before = ctx.db.query('SELECT COUNT(*) AS n FROM runner_commands').get();
    const ending = endAttempt(ctx, { attemptId: liveAttempt.id, trigger: 'released' });
    expect(ending?.attempt.endReason).toBe('released');
    expect(ctx.db.query('SELECT COUNT(*) AS n FROM runner_commands').get()).toEqual(before);
    expect(ending?.moved).toEqual([]);
  });
});

describe('holder fields', () => {
  test("the agent's current task is cleared, and the task's assignee unless it is submitted or accepted", () => {
    const { ctx, held } = setup();
    expect(getAgent(ctx, held.agent.id).currentTask).toBe(held.task.id);
    endAttempt(ctx, { attemptId: held.attempt.id, trigger: 'stop' });
    expect(getAgent(ctx, held.agent.id).currentTask).toBeNull();
    expect(getTask(ctx, held.task.id)).toMatchObject({ status: 'ready', assignee: null });

    // A submitted task keeps its assignee: it names whose work is in review.
    const submitted = addRunnerAttempt(ctx, { runnerId: held.runner.id });
    tx(ctx, (emit) => move(ctx, emit, getTask(ctx, submitted.task.id), 'submitted', 'system'));
    updateAttempt(ctx, submitted.attempt.id, { status: 'holding' });
    endAttempt(ctx, { attemptId: submitted.attempt.id, trigger: 'cancel' });
    expect(getTask(ctx, submitted.task.id)).toMatchObject({ status: 'submitted', assignee: submitted.agent.id });
    expect(getAgent(ctx, submitted.agent.id).currentTask).toBeNull();

    // A task blocked at request time keeps its status, and loses its holder when the attempt ends.
    const blocked = addRunnerAttempt(ctx, { runnerId: held.runner.id });
    tx(ctx, (emit) =>
      move(ctx, emit, getTask(ctx, blocked.task.id), 'blocked', 'system', { changes: { blockedKind: 'paused' } }),
    );
    endAttempt(ctx, { attemptId: blocked.attempt.id, trigger: 'stop_hold' });
    expect(getTask(ctx, blocked.task.id)).toMatchObject({ status: 'blocked', blockedKind: 'paused', assignee: null });

    // An accepted task keeps its assignee too: it names whose work was merged.
    const accepted = addRunnerAttempt(ctx, { runnerId: held.runner.id });
    tx(ctx, (emit) => {
      const submittedTask = move(ctx, emit, getTask(ctx, accepted.task.id), 'submitted', 'system');
      move(ctx, emit, submittedTask, 'accepted', 'user:alice');
    });
    updateAttempt(ctx, accepted.attempt.id, { status: 'holding', leaseExpiresAt: null });
    endAttempt(ctx, { attemptId: accepted.attempt.id, trigger: 'accepted' });
    expect(getTask(ctx, accepted.task.id)).toMatchObject({ status: 'accepted', assignee: accepted.agent.id });
    expect(getAgent(ctx, accepted.agent.id).currentTask).toBeNull();
  });
});

describe('task moves on exit', () => {
  const onExit: [EndingTrigger, TaskStatus[]][] = [
    ['stop', ['ready']],
    ['replace', ['ready']],
    ['stall_silent', ['ready']],
    ['quota', ['ready']],
    ['released', ['ready']],
    ['runner_stop', ['ready']],
    ['crashed', ['ready']],
    ['failed_to_start', ['ready']],
    ['refused_start', ['ready']],
    ['lost', ['stale', 'ready']],
    ['cancel', []],
    ['blocked', []],
    ['superseded', []],
  ];

  test('each on-exit row moves a claimed or working task that names the attempt', () => {
    const { ctx, held } = setup();
    for (const [trigger, path] of onExit) {
      for (const status of ['claimed', 'working'] as const) {
        const one = addRunnerAttempt(ctx, { runnerId: held.runner.id });
        if (status === 'working') tx(ctx, (emit) => move(ctx, emit, getTask(ctx, one.task.id), 'working', 'system'));
        const after = listEvents(ctx.db, { latest: true, limit: 1 })[0]?.id ?? 0;
        const ending = endAttempt(ctx, { attemptId: one.attempt.id, trigger, actor: 'system' });
        expect([trigger, status, ending?.moved]).toEqual([trigger, status, path]);
        expect([trigger, getTask(ctx, one.task.id).status]).toEqual([trigger, path.at(-1) ?? status]);
        // Each status on the path is its own move, and names the attempt (X-23).
        const moves = listEvents(ctx.db, { after, subject: one.task.id })
          .filter((event) => event.type.startsWith('task.'))
          .map((event) => [event.type, event.data.attemptId]);
        expect([trigger, status, moves]).toEqual([trigger, status, path.map((to) => [`task.${to}`, one.attempt.id])]);
      }
    }
  });

  test('other tasks keep their status: one in another status, or one that names another attempt', () => {
    const { ctx, held } = setup();
    tx(ctx, (emit) =>
      move(ctx, emit, getTask(ctx, held.task.id), 'blocked', 'system', { changes: { blockedKind: 'agent' } }),
    );
    expect(endAttempt(ctx, { attemptId: held.attempt.id, trigger: 'stop' })?.moved).toEqual([]);
    expect(getTask(ctx, held.task.id).status).toBe('blocked');

    const other = addRunnerAttempt(ctx, { runnerId: held.runner.id });
    writeTask(ctx, other.task.id, { currentAttempt: 'T-9-a9' });
    expect(endAttempt(ctx, { attemptId: other.attempt.id, trigger: 'crashed' })?.moved).toEqual([]);
    expect(getTask(ctx, other.task.id)).toMatchObject({ status: 'claimed', assignee: other.agent.id });
  });
});

describe('assembled notes and the seat', () => {
  test('a note with the attempt id is stored when the row asks and the agent wrote none', () => {
    const { ctx, held } = setup();
    // stop: if none written; the agent wrote none.
    endAttempt(ctx, { attemptId: held.attempt.id, trigger: 'stop' });
    const notes = listTaskNotes(ctx, held.task.id);
    expect(notes.map((note) => [note.kind, note.author, note.attemptId])).toEqual([
      ['handoff', 'system', held.attempt.id],
    ]);
    expect(notes[0]?.body).toBe(assembleHandoffNote(ctx, getAttempt(ctx, held.attempt.id)).body);

    // stop again, but the agent wrote its own: nothing is assembled.
    const wrote = addRunnerAttempt(ctx, { runnerId: held.runner.id });
    addNote(ctx, wrote.task.id, 'handoff', 'next: fix the lexer', `agent:${wrote.agent.id}`, wrote.attempt.id);
    expect(endAttempt(ctx, { attemptId: wrote.attempt.id, trigger: 'stop' })?.noteAdded).toBe(false);
    expect(listTaskNotes(ctx, wrote.task.id).map((note) => note.author)).toEqual([`agent:${wrote.agent.id}`]);

    // quota: always, even after the agent's own note.
    const quota = addRunnerAttempt(ctx, { runnerId: held.runner.id });
    addNote(ctx, quota.task.id, 'handoff', 'mine', `agent:${quota.agent.id}`, quota.attempt.id);
    expect(endAttempt(ctx, { attemptId: quota.attempt.id, trigger: 'quota' })?.noteAdded).toBe(true);
    expect(listTaskNotes(ctx, quota.task.id).map((note) => note.author)).toEqual([`agent:${quota.agent.id}`, 'system']);

    // cancel: never.
    const cancelled = addRunnerAttempt(ctx, { runnerId: held.runner.id });
    expect(endAttempt(ctx, { attemptId: cancelled.attempt.id, trigger: 'cancel' })?.noteAdded).toBe(false);
    expect(listTaskNotes(ctx, cancelled.task.id)).toEqual([]);
  });

  test('ending the seat holder empties the seat and emits lead.seat_changed', () => {
    const { ctx } = createTestContext();
    const runnerId = addRunner(ctx);
    const { attempt, agent } = startRunnerAttempt(ctx, { runnerId, taskId: null, role: 'lead', vendor: 'claude' });
    expect(getHubState(ctx).leadAgentId).toBe(agent.id);
    const ending = endAttempt(ctx, { attemptId: attempt.id, trigger: 'crashed' });
    expect(ending).toMatchObject({ task: null, moved: [], noteAdded: false });
    expect(getHubState(ctx)).toMatchObject({ leadAgentId: null, leadKind: null });
    expect(listEvents(ctx.db).filter((event) => event.type === 'lead.seat_changed').at(-1)?.data).toEqual({
      kind: 'none',
      agentId: null,
      attemptId: null,
      runnerId: null,
    });
    expect(listEvents(ctx.db).find((event) => event.type === 'attempt.ended')?.subject).toBe(attempt.id);
    // The start_attempt still pending is cancelled with the rest; only the cleanup goes out.
    expect(kinds(ctx, runnerId)).toEqual(['cleanup_attempt']);

    // A lead attempt that no longer holds the seat leaves the holder in it.
    const next = startRunnerAttempt(ctx, { runnerId, taskId: null, role: 'lead', vendor: 'claude' });
    const live = addAgent(ctx, 'alice');
    tx(ctx, (emit) => takeSeat(ctx, emit, live.id, 'live', 'user:alice'));
    const changes = listEvents(ctx.db).filter((event) => event.type === 'lead.seat_changed').length;
    endAttempt(ctx, { attemptId: next.attempt.id, trigger: 'superseded' });
    expect(getHubState(ctx)).toMatchObject({ leadAgentId: live.id, leadKind: 'live' });
    expect(listEvents(ctx.db).filter((event) => event.type === 'lead.seat_changed')).toHaveLength(changes);
  });

  test("ending a task attempt of the seat holder leaves the seat as it was", () => {
    const { ctx } = createTestContext();
    const lead = addAgent(ctx, 'alice', 'lead');
    const [task] = createTasks(ctx, [newTask()], 'user:alice');
    if (!task) throw new Error('no task');
    // A live lead may claim a task; its attempt is the lead's, but it holds the task, not the seat.
    const attempt = tx(ctx, () =>
      insertAttempt(ctx, {
        id: `${task.id}-a1`,
        taskId: task.id,
        number: 1,
        role: 'lead',
        agentId: lead.id,
        runnerId: null,
        vendor: 'claude',
        fence: issueFence(ctx),
        status: 'running',
      }),
    );
    endAttempt(ctx, { attemptId: attempt.id, trigger: 'released' });
    expect(getHubState(ctx)).toMatchObject({ leadAgentId: lead.id, leadKind: 'live' });
  });
});

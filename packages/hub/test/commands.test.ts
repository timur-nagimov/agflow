import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import {
  type Attempt,
  type Fence,
  HubMessageSchema,
  RUNNER_COMMAND_KINDS,
  type RunnerCommandKind,
} from '@agflow/core';
import { issueFence, updateAttempt } from '../src/attempt-store';
import { resolveAgentToken } from '../src/auth';
import {
  type CommandRow,
  RESULT_HANDLERS,
  type StoredCommand,
  cancelPendingCommands,
  enqueueCommand,
  findCommand,
  markSent,
  pendingCommands,
  pendingResumeOf,
  recordResult,
  toWireCommand,
} from '../src/commands';
import { type HubContext, afterCommit, tx } from '../src/context';
import { addRunnerAttempt, createTestContext } from './helpers';

const sha = (char: string) => char.repeat(40);

/** One tokenless command of each kind for the attempt; the mapped type makes the compiler insist on all 17. */
function samples(attempt: Attempt): { [K in RunnerCommandKind]: Extract<StoredCommand, { kind: K }> } {
  const { id: attemptId, fence } = attempt;
  const restore = { paths: ['.claude/**'], base: 'refs/heads/main' };
  return {
    start_attempt: {
      kind: 'start_attempt',
      attempt: {
        attemptId,
        taskId: attempt.taskId,
        role: 'worker',
        vendor: 'claude',
        model: null,
        fence,
        hubUrl: 'http://hub.test',
        repo: { url: 'https://github.com/acme/demo', mainBranch: 'main' },
        start: { ref: 'refs/heads/main', sha: null },
        branch: 'agflow/T-1-do-the-thing',
        wipRef: 'refs/agflow/T-1/a1',
        restore,
        acceptanceIds: ['A1'],
        toolCaps: { defaultMs: 1_800_000, longMs: 5_400_000, checks: [] },
        taskPack: '# T-1',
        brief: 'You are an agflow worker.',
        firstPrompt: 'Start.',
        successor: false,
      },
    },
    resume_attempt: {
      kind: 'resume_attempt',
      attemptId,
      fence,
      prompt: 'The runner restarted; continue from your last step.',
      messages: [{ messageId: 4, authority: 'person', text: '> alice: also add a test' }],
      taskPack: null,
      restore,
      acceptanceIds: ['A1'],
    },
    deliver: { kind: 'deliver', attemptId, fence, messages: [], more: 0 },
    interrupt: { kind: 'interrupt', attemptId, fence },
    stop_attempt: {
      kind: 'stop_attempt',
      attemptId,
      fence,
      cause: 'stop',
      reason: 'a person stopped it',
      handoff: true,
      interruptFirst: false,
      keepClone: false,
    },
    hold_attempt: { kind: 'hold_attempt', attemptId, fence },
    push_submission: {
      kind: 'push_submission',
      attemptId,
      fence,
      submissionId: 'S-1',
      branch: 'agflow/T-1-do-the-thing',
      expectedBranchSha: null,
      adoptable: [],
    },
    prepare_takeover: { kind: 'prepare_takeover', attemptId, fence, person: 'alice' },
    hand_back: { kind: 'hand_back', attemptId, source: { kind: 'clone' } },
    cleanup_attempt: { kind: 'cleanup_attempt', attemptId },
    decide_approval: {
      kind: 'decide_approval',
      attemptId,
      fence,
      approvalId: '6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f',
      decision: 'approve',
      reason: null,
    },
    upload_transcript: { kind: 'upload_transcript', attemptId },
    prepare_dependencies: { kind: 'prepare_dependencies', attemptId, fence, requestId: '1-R-1-9' },
    refresh_vault: { kind: 'refresh_vault', taskId: attempt.taskId ?? 'T-1', refs: ['refs/agflow/T-1/a1-late-1'] },
    preflight: { kind: 'preflight', vendor: 'codex' },
    delete_refs: { kind: 'delete_refs', refs: [{ ref: 'refs/agflow/T-1/a1', expectedSha: sha('c') }] },
    update_settings: { kind: 'update_settings', settings: { capacity: 3 }, version: 2 },
  };
}

function enqueue(ctx: HubContext, runnerId: string, command: StoredCommand): CommandRow {
  return tx(ctx, () => enqueueCommand(ctx, runnerId, command));
}

const ids = (rows: CommandRow[]) => rows.map((row) => row.id);

// Modules register their handlers when imported, and test files share one module registry, so each test puts the
// registry back as it found it rather than emptying it.
let registered: typeof RESULT_HANDLERS = {};
beforeEach(() => {
  registered = { ...RESULT_HANDLERS };
});
afterEach(() => {
  for (const kind of RUNNER_COMMAND_KINDS) delete RESULT_HANDLERS[kind];
  Object.assign(RESULT_HANDLERS, registered);
});

describe('the command queue', () => {
  test("ids are '<epoch>-<runner>-<seq>' with seq per runner and epoch, and pending ones come in seq order", () => {
    const { ctx } = createTestContext();
    const first = addRunnerAttempt(ctx);
    const second = addRunnerAttempt(ctx);
    const r1 = first.runner.id;
    const r2 = second.runner.id;
    const preflight: StoredCommand = { kind: 'preflight', vendor: 'claude' };
    expect(enqueue(ctx, r1, preflight).id).toBe(`1-${r1}-1`);
    expect(enqueue(ctx, r1, preflight).id).toBe(`1-${r1}-2`);
    expect(enqueue(ctx, r2, preflight)).toMatchObject({ id: `1-${r2}-1`, seq: 1, hubEpoch: 1, status: 'pending' });
    ctx.db.run('UPDATE project SET epoch = 2');
    expect(enqueue(ctx, r1, preflight)).toMatchObject({ id: `2-${r1}-1`, seq: 1, hubEpoch: 2 });
    expect(ids(pendingCommands(ctx, r1, 1))).toEqual([`1-${r1}-1`, `1-${r1}-2`, `2-${r1}-1`]);
    expect(ids(pendingCommands(ctx, r2, 1))).toEqual([`1-${r2}-1`]);
  });

  test('every kind can be enqueued, never reaches a runner older than its protocol, and goes out valid', () => {
    const { ctx } = createTestContext();
    const { runner, attempt } = addRunnerAttempt(ctx);
    const commands = samples(attempt);
    for (const kind of RUNNER_COMMAND_KINDS) {
      const row = enqueue(ctx, runner.id, commands[kind]);
      expect(row.kind).toBe(kind);
      const wire = toWireCommand(ctx, row);
      expect([kind, HubMessageSchema.safeParse(wire).success]).toEqual([kind, true]);
      expect(wire).toMatchObject({ t: 'command', id: row.id, seq: row.seq, command: { kind } });
    }
    expect(pendingCommands(ctx, runner.id, 1).map((row) => row.kind)).toEqual([...RUNNER_COMMAND_KINDS]);
    // Every kind needs protocol 1, so a runner below it gets nothing.
    expect(pendingCommands(ctx, runner.id, 0)).toEqual([]);
  });

  test('commands record their attempt and fence', () => {
    const { ctx } = createTestContext();
    const { runner, attempt } = addRunnerAttempt(ctx);
    const commands = samples(attempt);
    expect(enqueue(ctx, runner.id, commands.start_attempt)).toMatchObject({ attemptId: attempt.id, fence: attempt.fence });
    expect(enqueue(ctx, runner.id, commands.stop_attempt)).toMatchObject({ attemptId: attempt.id, fence: attempt.fence });
    expect(enqueue(ctx, runner.id, commands.cleanup_attempt)).toMatchObject({ attemptId: attempt.id, fence: null });
    expect(enqueue(ctx, runner.id, commands.preflight)).toMatchObject({ attemptId: null, fence: null });
  });
});

describe('agent tokens in commands', () => {
  test('start and resume are stored without a token; each wire copy carries a fresh one, and older ones stay valid', () => {
    const { ctx } = createTestContext();
    const { runner, attempt, agent } = addRunnerAttempt(ctx);
    const commands = samples(attempt);
    // A caller that passes a token still gets none stored.
    const withToken = { kind: 'start_attempt', attempt: { ...commands.start_attempt.attempt, agentToken: 'agt_secret' } };
    const start = enqueue(ctx, runner.id, withToken as StoredCommand);
    const resume = enqueue(ctx, runner.id, { ...commands.resume_attempt, agentToken: 'agt_secret' } as StoredCommand);
    const payloads = (ctx.db.query('SELECT payload FROM runner_commands').all() as { payload: string }[]).map(
      (row) => row.payload,
    );
    for (const payload of payloads) expect(payload).not.toContain('agentToken');
    expect(payloads.join()).not.toContain('agt_');

    const tokens: string[] = [];
    for (let send = 0; send < 2; send++) {
      const startWire = toWireCommand(ctx, findCommand(ctx, start.id) as CommandRow);
      const resumeWire = toWireCommand(ctx, findCommand(ctx, resume.id) as CommandRow);
      if (startWire.command.kind !== 'start_attempt' || resumeWire.command.kind !== 'resume_attempt') {
        throw new Error('wrong kinds');
      }
      tokens.push(startWire.command.attempt.agentToken, resumeWire.command.agentToken);
    }
    expect(new Set(tokens).size).toBe(4);
    for (const token of tokens) {
      const grant = resolveAgentToken(ctx, token);
      expect([grant.agent.id, grant.attempt.id, grant.attempt.fence]).toEqual([agent.id, attempt.id, attempt.fence]);
    }
    const stored = ctx.db.query('SELECT fence_epoch, fence_counter FROM agent_tokens').all();
    expect(stored).toEqual(Array(4).fill({ fence_epoch: attempt.fence.epoch, fence_counter: attempt.fence.counter }));
    expect(JSON.stringify(ctx.db.query('SELECT * FROM runner_commands').all())).not.toContain('agt_');
  });
});

describe('cancellation', () => {
  test('cancelPendingCommands cancels all but cleanup_attempt, upload_transcript and hand_back, and cancelled ones are never resent', () => {
    const { ctx } = createTestContext();
    const { runner, attempt } = addRunnerAttempt(ctx);
    const other = addRunnerAttempt(ctx, { runnerId: runner.id });
    const commands = samples(attempt);
    for (const kind of RUNNER_COMMAND_KINDS) enqueue(ctx, runner.id, commands[kind]);
    const unrelated = enqueue(ctx, runner.id, { kind: 'interrupt', attemptId: other.attempt.id, fence: other.attempt.fence });
    const done = enqueue(ctx, runner.id, { kind: 'hold_attempt', attemptId: attempt.id, fence: attempt.fence });
    recordResult(ctx, runner.id, { commandId: done.id, ok: true });

    const cancelled = tx(ctx, () => cancelPendingCommands(ctx, attempt.id));
    const attemptKinds = new Set<RunnerCommandKind>([
      'start_attempt',
      'resume_attempt',
      'deliver',
      'interrupt',
      'stop_attempt',
      'hold_attempt',
      'push_submission',
      'prepare_takeover',
      'decide_approval',
      'prepare_dependencies',
    ]);
    expect(new Set(cancelled.map((row) => row.kind))).toEqual(attemptKinds);
    expect(cancelled.every((row) => row.status === 'cancelled')).toBe(true);
    expect(findCommand(ctx, done.id)?.status).toBe('done');
    expect(pendingCommands(ctx, runner.id, 1).map((row) => row.kind)).toEqual([
      'hand_back',
      'cleanup_attempt',
      'upload_transcript',
      'refresh_vault',
      'preflight',
      'delete_refs',
      'update_settings',
      'interrupt',
    ]);
    expect(findCommand(ctx, unrelated.id)?.status).toBe('pending');
    // A late result for a cancelled command changes nothing.
    expect(recordResult(ctx, runner.id, { commandId: cancelled[0]?.id as string, ok: true })).toBeNull();
    expect(findCommand(ctx, cancelled[0]?.id as string)?.status).toBe('cancelled');
  });

  test("pendingResumeOf finds the attempt's pending resume", () => {
    const { ctx } = createTestContext();
    const { runner, attempt } = addRunnerAttempt(ctx);
    expect(pendingResumeOf(ctx, attempt.id)).toBeNull();
    const resume = enqueue(ctx, runner.id, samples(attempt).resume_attempt);
    expect(pendingResumeOf(ctx, attempt.id)?.id).toBe(resume.id);
    tx(ctx, () => cancelPendingCommands(ctx, attempt.id));
    expect(pendingResumeOf(ctx, attempt.id)).toBeNull();
  });
});

describe('results', () => {
  test("recordResult stores done or failed, runs the kind's RESULT_HANDLERS entry, and ignores unknown ids", () => {
    const { ctx, clock } = createTestContext();
    const { runner, attempt } = addRunnerAttempt(ctx);
    const seen: [string, boolean, unknown][] = [];
    RESULT_HANDLERS.hand_back = (_ctx, emit, command, result) => {
      seen.push([command.id, result.ok, result.data]);
      emit({ type: 'test.hand_back_result', actor: 'system', data: { id: command.id } });
    };
    const handBack = enqueue(ctx, runner.id, samples(attempt).hand_back);
    const preflight = enqueue(ctx, runner.id, { kind: 'preflight', vendor: 'claude' });
    clock.advance(5_000);
    const done = recordResult(ctx, runner.id, { commandId: handBack.id, ok: true, data: { sha: sha('d') } });
    expect(done).toMatchObject({ status: 'done', result: { ok: true, data: { sha: sha('d') } }, doneAt: ctx.now() });
    expect(seen).toEqual([[handBack.id, true, { sha: sha('d') }]]);
    const failed = recordResult(ctx, runner.id, { commandId: preflight.id, ok: false, error: 'unsupported' });
    expect(failed).toMatchObject({ status: 'failed', result: { ok: false, error: 'unsupported' } });
    expect(seen).toHaveLength(1);
    // Repeats, other runners' results and unknown ids are ignored.
    expect(recordResult(ctx, runner.id, { commandId: handBack.id, ok: false })).toBeNull();
    // Command ids can be guessed, so a pending command answers only to its own runner.
    const pending = enqueue(ctx, runner.id, { kind: 'preflight', vendor: 'codex' });
    expect(recordResult(ctx, 'R-99', { commandId: pending.id, ok: true })).toBeNull();
    expect(findCommand(ctx, pending.id)?.status).toBe('pending');
    expect(recordResult(ctx, runner.id, { commandId: `1-${runner.id}-999`, ok: true })).toBeNull();
    expect(seen).toHaveLength(1);
    expect(ctx.db.query("SELECT COUNT(*) AS n FROM events WHERE type = 'test.hand_back_result'").get()).toEqual({ n: 1 });
  });

  test('a failed result reaches its handler too', () => {
    const { ctx } = createTestContext();
    const { runner, attempt } = addRunnerAttempt(ctx);
    const seen: [string, boolean, string | undefined][] = [];
    RESULT_HANDLERS.hand_back = (_ctx, _emit, command, result) => {
      seen.push([command.status, result.ok, result.error]);
    };
    const handBack = enqueue(ctx, runner.id, { kind: 'hand_back', attemptId: attempt.id, source: { kind: 'clone' } });
    recordResult(ctx, runner.id, { commandId: handBack.id, ok: false, error: 'process_running' });
    expect(seen).toEqual([['failed', false, 'process_running']]);
  });

  test('markSent records when a command last went out', () => {
    const { ctx, clock } = createTestContext();
    const { runner } = addRunnerAttempt(ctx);
    const row = enqueue(ctx, runner.id, { kind: 'preflight', vendor: 'claude' });
    expect(row.sentAt).toBeNull();
    markSent(ctx, row.id);
    expect(findCommand(ctx, row.id)?.sentAt).toBe(ctx.now());
    clock.advance(1_000);
    markSent(ctx, row.id);
    expect(findCommand(ctx, row.id)?.sentAt).toBe(ctx.now());
  });
});

describe('after commit', () => {
  test('the link is flushed only after commit, once per runner, never after a rollback', () => {
    const { ctx } = createTestContext();
    const { runner, attempt } = addRunnerAttempt(ctx);
    const flushed: string[] = [];
    ctx.link = { flush: (runnerId) => flushed.push(runnerId) };
    tx(ctx, () => {
      enqueueCommand(ctx, runner.id, { kind: 'interrupt', attemptId: attempt.id, fence: attempt.fence });
      enqueueCommand(ctx, runner.id, { kind: 'preflight', vendor: 'claude' });
      expect(flushed).toEqual([]);
    });
    expect(flushed).toEqual([runner.id]);

    expect(() =>
      tx(ctx, () => {
        enqueueCommand(ctx, runner.id, { kind: 'preflight', vendor: 'codex' });
        throw new Error('rolled back');
      }),
    ).toThrow('rolled back');
    expect(flushed).toEqual([runner.id]);
    expect(pendingCommands(ctx, runner.id, 1)).toHaveLength(2);
  });

  test('work of an inner transaction that rolls back is dropped; the rest runs after the outer commit', () => {
    const { ctx } = createTestContext();
    const order: string[] = [];
    const published: string[] = [];
    ctx.bus.subscribe((event) => published.push(event.type));
    tx(ctx, (emit) => {
      afterCommit(ctx, () => order.push('outer'));
      emit({ type: 'test.outer', actor: 'system' });
      expect(() =>
        tx(ctx, (innerEmit) => {
          afterCommit(ctx, () => order.push('rolled back'));
          innerEmit({ type: 'test.rolled_back', actor: 'system' });
          throw new Error('inner');
        }),
      ).toThrow('inner');
      tx(ctx, (innerEmit) => {
        afterCommit(ctx, () => order.push('inner'));
        innerEmit({ type: 'test.inner', actor: 'system' });
      });
      expect([order, published]).toEqual([[], []]);
    });
    expect(order).toEqual(['outer', 'inner']);
    expect(published).toEqual(['test.outer', 'test.inner']);
  });

  test('work that throws is logged and keeps neither the rest nor the committed tx() from finishing', () => {
    const { ctx } = createTestContext();
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const order: string[] = [];
      const result = tx(ctx, () => {
        afterCommit(ctx, () => {
          throw new Error('link down');
        });
        afterCommit(ctx, () => order.push('second'));
        return 'committed';
      });
      expect([result, order]).toEqual(['committed', ['second']]);
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
  });

  test('afterCommit refuses a transaction not opened with tx(), where its work would run before the commit', () => {
    const { ctx } = createTestContext();
    expect(() => ctx.db.transaction(() => afterCommit(ctx, () => {}))()).toThrow(
      'afterCommit needs a transaction opened with tx()',
    );
  });

  test('outside a transaction the work runs at once', () => {
    const { ctx } = createTestContext();
    const order: string[] = [];
    afterCommit(ctx, () => order.push('now'));
    expect(order).toEqual(['now']);
  });

  test('a re-fence cancels the old fence and keeps the new one pending', () => {
    const { ctx } = createTestContext();
    const { runner, attempt } = addRunnerAttempt(ctx);
    const oldStop = enqueue(ctx, runner.id, samples(attempt).stop_attempt);
    const fence: Fence = issueFence(ctx);
    tx(ctx, () => {
      cancelPendingCommands(ctx, attempt.id);
      updateAttempt(ctx, attempt.id, { fence });
      enqueueCommand(ctx, runner.id, { ...samples({ ...attempt, fence }).resume_attempt });
    });
    expect(findCommand(ctx, oldStop.id)?.status).toBe('cancelled');
    expect(pendingCommands(ctx, runner.id, 1).map((row) => [row.kind, row.fence])).toEqual([['resume_attempt', fence]]);
  });
});

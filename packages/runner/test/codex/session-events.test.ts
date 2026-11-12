import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { BRIDGE_ANSWERS, TEST_ACCOUNT_ID } from '@agflow/core';
import { createHash } from 'node:crypto';
import { CODEX_VERSION } from '../../src/adapters/codex/binary';
import { agflowTerminal, codexToolEnded, codexToolStarted } from '../../src/adapters/codex/items';
import type { ServerNotification } from '../../src/adapters/codex/protocol';
import type { CodexErrorInfo, RateLimitSnapshot, ThreadItem } from '../../src/adapters/codex/protocol/v2';
import { FactsTracker } from '../../src/facts';
import { CodexSession } from '../../src/adapters/codex/session';
import type { AgentEvent, TerminalTool } from '../../src/adapters/types';
import { codexMessages as m, FAKE_THREAD_ID as MAIN, fakeTurnId, readCodexRecord, type ScriptedAnswers } from './peer';
import probes from './probe-messages.json';
import { alive, cleanupSessions, collect, mcp, sessionFixture } from './session-fixture';

const TURN = fakeTurnId(1);
const CHILD = 'child-thread';
const started: AgentEvent = {
  type: 'started',
  sessionRef: MAIN,
  model: 'requested-model',
  cliVersion: CODEX_VERSION,
  permissionMode: 'on-request',
};
const turnStarted: AgentEvent = { type: 'turn_started' };
const begin = (id = TURN, thread = MAIN) => m.turnStarted(thread, m.turn({ id, status: 'inProgress' }));
const finish = (id = TURN, thread = MAIN) => m.turnCompleted(thread, m.turn({ id, status: 'completed' }));
const turnEnded = (toolCalls = 0): AgentEvent => ({
  type: 'turn_ended',
  outcome: 'completed',
  toolCalls,
  error: null,
  errorKind: null,
});
const toolEnded = (
  toolId: string,
  patch: Partial<Extract<AgentEvent, { type: 'tool_ended' }>> = {},
): Extract<AgentEvent, { type: 'tool_ended' }> => ({
  type: 'tool_ended',
  toolId,
  ok: true,
  denied: false,
  terminal: null,
  hubUnreachable: false,
  ...patch,
});
const command = (id = 'exec-1') => m.commandExecutionItem({ id, command: 'echo hi', cwd: '/tmp' });

afterEach(() => {
  mock.restore();
  cleanupSessions();
});

async function run(notes: ServerNotification[], answers: ScriptedAnswers = {}): Promise<AgentEvent[]> {
  const f = sessionFixture({
    answers: {
      ...answers,
      'turn/start': { then: [...notes.map((notify) => ({ notify })), { crash: { code: 0 } }] },
    },
  });
  const session = await CodexSession.start(f.launch, f.options);
  const events = await collect(session.events);
  expect(await session.exited).toEqual({ code: 0, signal: null });
  await session.close();
  return events;
}

const terminals: [string, TerminalTool][] = [
  ['submit', 'submit'],
  ['write_handoff', 'handoff'],
  ['declare_blocked', 'blocked'],
  ['declare_impossible', 'impossible'],
  ['release_task', 'released'],
];

describe('Codex item mapping', () => {
  for (const [wrapped, inner] of [
    ["/bin/zsh -c 'echo hi'", 'echo hi'],
    ["/bin/bash -lc 'echo hi\n  pwd'", 'echo hi\n  pwd'],
    // shlex's own forms: a script with a quote is double-quoted, or split into mixed chunks.
    ['/bin/zsh -c "echo \'hello\'"', "echo 'hello'"],
    ["/bin/zsh -c 'echo \"it'\"'\"'s\"'", 'echo "it\'s"'],
    ['/bin/zsh -c "printf \'%s\\\\n\' x"', "printf '%s\\n' x"],
    ['/bin/bash -lc "git commit -m \\"it\'s done\\""', 'git commit -m "it\'s done"'],
    ['echo  hi && pwd', 'echo  hi && pwd'],
    ["python3 -c 'print(1)'", "python3 -c 'print(1)'"],
    ["/bin/zsh -c 'echo hi' && pwd", "/bin/zsh -c 'echo hi' && pwd"],
    ['/bin/zsh -c "echo $HOME"', '/bin/zsh -c "echo $HOME"'],
    ["/bin/zsh -c 'echo hi", "/bin/zsh -c 'echo hi"],
  ]) {
    test(`unwraps only a shell command: ${wrapped}`, () => {
      expect(codexToolStarted({ ...command(), command: wrapped })).toEqual({
        type: 'tool_started',
        toolId: 'exec-1',
        name: 'exec_command',
        input: inner,
        command: inner,
      });
    });
  }

  test('a file change carries its patches, so different edits of one file are different calls', () => {
    const edit = (diff: string) =>
      codexToolStarted(
        m.fileChangeItem({
          id: 'patch',
          changes: [{ path: 'src/foo.ts', kind: { type: 'update', move_path: null }, diff }],
        }),
      );
    expect(edit('+import x')).toEqual({
      type: 'tool_started',
      toolId: 'patch',
      name: 'apply_patch',
      input: 'src/foo.ts\n+import x',
      command: null,
    });
    expect(edit('+import x')!.input).not.toBe(edit('+function y() {}')!.input);
  });

  test('only a completed command with exit code zero is ok', () => {
    for (const status of ['inProgress', 'completed', 'failed', 'declined'] as const) {
      for (const exitCode of [0, 1, null]) {
        expect(codexToolEnded({ ...command(), status, exitCode })).toEqual(
          toolEnded('exec-1', {
            ok: status === 'completed' && exitCode === 0,
            denied: status === 'declined',
          }),
        );
      }
    }
  });

  test('non-tool items have no tool or terminal mapping', () => {
    for (const item of [m.agentMessageItem('hello'), m.contextCompactionItem(), m.userMessageItem('hello')]) {
      expect(codexToolStarted(item)).toBeNull();
      expect(codexToolEnded(item)).toBeNull();
      expect(agflowTerminal(item)).toBeNull();
    }
  });

  for (const [tool, terminal] of terminals) {
    test(`${tool} counts only a completed agflow result, independently of its text`, () => {
      for (const status of ['inProgress', 'completed', 'failed'] as const) {
        for (const result of ['submitted at abc', 'submission pending', BRIDGE_ANSWERS.hubUnreachable, 'anything']) {
          const item = m.mcpToolCallItem({ id: 'mcp', tool, args: {}, status, result });
          expect(agflowTerminal(item)).toBe(status === 'completed' ? terminal : null);
          expect(agflowTerminal({ ...item, server: 'other' })).toBeNull();
        }
      }
    });
  }
});

describe('CodexSession events', () => {
  test('exec-session polls stay on the original command, including inbox checks between polls', async () => {
    const exec = { ...command(), command: '/bin/zsh -lc \'bun test\'', processId: '32054', source: 'unifiedExecStartup' as const };
    const notes: ServerNotification[] = [begin(), m.itemStarted(MAIN, TURN, exec)];
    for (let n = 0; n < 5; n++) {
      notes.push({ method: 'item/commandExecution/terminalInteraction', params: {
        threadId: MAIN, turnId: TURN, itemId: exec.id, processId: '32054', stdin: '',
      } });
      notes.push(m.itemCompleted(MAIN, TURN, m.mcpToolCallItem({ id: `inbox-${n}`, tool: 'check_inbox', args: {}, status: 'completed' })));
    }
    notes.push(m.itemCompleted(MAIN, TURN, { ...exec, status: 'completed', exitCode: 0 }), finish());
    const events = await run(notes);
    expect(events.filter(e => e.type === 'tool_progress')).toEqual(
      Array.from({ length: 5 }, () => ({ type: 'tool_progress', toolId: exec.id })));
    expect(events.filter(e => e.type === 'tool_started' && e.name === 'exec_command')).toHaveLength(1);
    expect(events.filter(e => e.type === 'tool_ended' && e.toolId === exec.id)).toEqual([toolEnded(exec.id)]);
    expect(events).toContainEqual(turnEnded(6));
    let now = 0;
    const facts = new FactsTracker({ attemptId: 'T-1-a1', fence: { epoch: 1, counter: 1 }, clone: import.meta.dir,
      toolCaps: { defaultMs: 30_000, longMs: 90_000, checks: [] }, clock: { awakeNow: () => now }, fingerprint: async () => 'same' });
    try {
      for (const event of events) {
        if (event.type === 'tool_progress') now += 1000;
        facts.observe(event);
        if (event.type === 'tool_progress') {
          expect(facts.facts()).toMatchObject({ repeatedCalls: 0,
            tool: { command: 'bun test', long: true, capMs: 90_000, ageMs: now } });
        }
      }
      expect(facts.facts().tool).toBeNull();
    } finally { facts.close(); }
  });

  test('each newly executed, finished identical command is still a call', async () => {
    const events = await run([begin(), ...Array.from({ length: 3 }, (_, n) => {
      const exec = { ...command(`exec-${n}`), command: 'bun test', status: 'completed' as const, exitCode: 0 };
      return m.itemCompleted(MAIN, TURN, exec);
    }), finish()]);
    expect(events.filter(e => e.type === 'tool_started')).toHaveLength(3);
    expect(events).toContainEqual(turnEnded(3));
  });

  test('keeps the returned active id before turn/started and emits one start for it', async () => {
    const id = 'returned-turn';
    const f = sessionFixture({
      answers: {
        'turn/start': {
          result: { turn: m.turn({ id, status: 'inProgress' }) },
          then: [
            { delayMs: 50 },
            { notify: begin(id) },
            { notify: begin(id) },
            { notify: finish(id) },
            { crash: { code: 0 } },
          ],
        },
      },
    });
    const session = await CodexSession.start(f.launch, f.options);
    expect(alive(session.pid)).toBe(true);
    expect(session.activeTurnId).toBe(id);
    expect(await collect(session.events)).toEqual([started, turnStarted, turnEnded()]);
    expect(session.activeTurnId).toBeNull();
    await session.close();
  });

  test('a turn that ends before its turn/start answer is handled does not stay active', async () => {
    // The answer and the turn's notifications arrive together; the rpc lets the answer's caller run first.
    const f = sessionFixture({
      answers: { 'turn/start': { then: [{ notify: begin() }, { notify: finish() }, { crash: { code: 0 } }] } },
    });
    const session = await CodexSession.start(f.launch, f.options);
    expect(await collect(session.events)).toEqual([started, turnStarted, turnEnded()]);
    expect(session.activeTurnId).toBeNull();
    await session.close();
  });

  test('maps a completed turn with a command, file change and MCP call', async () => {
    const exec = probes.commandExecutionCompleted.params.item as ThreadItem;
    const patch = m.fileChangeItem({
      id: 'patch',
      changes: [
        { path: 'one.ts', kind: { type: 'add' }, diff: '+one' },
        { path: 'two.ts', kind: { type: 'delete' }, diff: '-two' },
      ],
    });
    const call = m.mcpToolCallItem({ id: 'mcp', tool: 'report_progress', args: { note: 'done', n: 1 } });
    expect(
      await run([
        begin(),
        m.itemStarted(MAIN, TURN, { ...exec, status: 'inProgress' } as ThreadItem),
        m.itemCompleted(MAIN, TURN, exec),
        m.itemStarted(MAIN, TURN, patch),
        m.itemCompleted(MAIN, TURN, { ...patch, status: 'completed' }),
        m.itemStarted(MAIN, TURN, call),
        m.itemCompleted(MAIN, TURN, { ...call, status: 'completed' }),
        finish(),
      ]),
    ).toEqual([
      started,
      turnStarted,
      {
        type: 'tool_started',
        toolId: exec.id,
        name: 'exec_command',
        input: 'echo hi > probe.txt && cat probe.txt',
        command: 'echo hi > probe.txt && cat probe.txt',
      },
      toolEnded(exec.id),
      {
        type: 'tool_started',
        toolId: 'patch',
        name: 'apply_patch',
        input: 'one.ts\n+one\ntwo.ts\n-two',
        command: null,
      },
      toolEnded('patch'),
      {
        type: 'tool_started',
        toolId: 'mcp',
        name: 'mcp__agflow__report_progress',
        input: '{"note":"done","n":1}',
        command: null,
      },
      toolEnded('mcp'),
      turnEnded(3),
    ]);
  });

  test('supplies missing starts for declined commands, declined patches and MCP error results', async () => {
    const exec = probes.commandExecutionDeclined.params.item as ThreadItem;
    const call = probes.mcpToolCallFailed.params.item as ThreadItem;
    const patch = m.fileChangeItem({ id: 'patch', changes: [], status: 'declined' });
    expect(
      await run([begin(), ...[exec, patch, call].map((item) => m.itemCompleted(MAIN, TURN, item)), finish()]),
    ).toEqual([
      started,
      turnStarted,
      {
        type: 'tool_started',
        toolId: exec.id,
        name: 'exec_command',
        input: 'touch /tmp/m2e-probe/outside.txt; echo done',
        command: 'touch /tmp/m2e-probe/outside.txt; echo done',
      },
      toolEnded(exec.id, { ok: false, denied: true }),
      { type: 'tool_started', toolId: 'patch', name: 'apply_patch', input: '', command: null },
      toolEnded('patch', { ok: false, denied: true }),
      { type: 'tool_started', toolId: call.id, name: 'mcp__agflow__submit', input: '{"note":"x"}', command: null },
      toolEnded(call.id, { ok: false }),
      turnEnded(3),
    ]);
  });

  test('maps every terminal on normal results and no terminal on failed results', async () => {
    const notes: ServerNotification[] = [begin()];
    const expected: AgentEvent[] = [started, turnStarted];
    for (const [tool, terminal] of terminals) {
      for (const status of ['completed', 'failed'] as const) {
        const id = `${tool}-${status}`;
        notes.push(
          m.itemCompleted(MAIN, TURN, m.mcpToolCallItem({ id, tool, args: {}, status, result: 'submission pending' })),
        );
        expected.push(
          { type: 'tool_started', toolId: id, name: `mcp__agflow__${tool}`, input: '{}', command: null },
          toolEnded(id, { ok: status === 'completed', terminal: status === 'completed' ? terminal : null }),
        );
      }
    }
    expect(await run([...notes, finish()])).toEqual([...expected, turnEnded(10)]);
  });

  test('hubUnreachable requires an exact failed agflow answer', async () => {
    const items = [
      m.mcpToolCallItem({
        id: 'unreachable',
        tool: 'check_inbox',
        args: {},
        status: 'failed',
        result: BRIDGE_ANSWERS.hubUnreachable,
      }),
      m.mcpToolCallItem({
        id: 'ok',
        tool: 'check_inbox',
        args: {},
        status: 'completed',
        result: BRIDGE_ANSWERS.hubUnreachable,
      }),
      m.mcpToolCallItem({
        id: 'suffix',
        tool: 'check_inbox',
        args: {},
        status: 'failed',
        result: `${BRIDGE_ANSWERS.hubUnreachable} extra`,
      }),
      m.mcpToolCallItem({
        id: 'transport',
        tool: 'check_inbox',
        args: {},
        status: 'failed',
        error: BRIDGE_ANSWERS.hubUnreachable,
      }),
      {
        ...m.mcpToolCallItem({
          id: 'other',
          tool: 'submit',
          args: {},
          status: 'failed',
          result: BRIDGE_ANSWERS.hubUnreachable,
        }),
        server: 'other',
      },
    ];
    const events = await run(items.map((item) => m.itemCompleted(MAIN, TURN, item)));
    expect(events.filter((event) => event.type === 'tool_ended')).toEqual([
      toolEnded('unreachable', { ok: false, hubUnreachable: true }),
      toolEnded('ok'),
      toolEnded('suffix', { ok: false }),
      toolEnded('transport', { ok: false }),
      toolEnded('other', { ok: false }),
    ]);
  });

  test('child tools count as progress while turns, text, context and errors follow only the main thread', async () => {
    const item = command('child-exec');
    const usage = { total: { input: 1000, output: 10 }, last: { input: 100, output: 5 } };
    expect(
      await run([
        begin(),
        begin('child-turn', CHILD),
        m.itemStarted(CHILD, 'child-turn', item),
        m.itemCompleted(CHILD, 'child-turn', { ...item, status: 'completed', exitCode: 0 }),
        m.itemCompleted(CHILD, 'child-turn', m.agentMessageItem('hidden')),
        m.tokenUsageUpdated(CHILD, 'child-turn', usage, 200),
        m.error(CHILD, 'child-turn', m.turnError('usageLimitExceeded', 'hidden error')),
        finish('child-turn', CHILD),
        m.itemStarted(MAIN, TURN, m.agentMessageItem('partial')),
        m.itemCompleted(MAIN, TURN, m.agentMessageItem('main text')),
        finish(),
        begin('second'),
        finish('second'),
      ]),
    ).toEqual([
      started,
      turnStarted,
      { type: 'tool_started', toolId: 'child-exec', name: 'exec_command', input: 'echo hi', command: 'echo hi' },
      toolEnded('child-exec'),
      { type: 'text', text: 'main text' },
      turnEnded(1),
      turnStarted,
      turnEnded(),
    ]);
  });

  test('a turn that ends with tools open ends them first, and their late completions are not reported', async () => {
    const exec = command('open-exec');
    const call = m.mcpToolCallItem({ id: 'open-mcp', tool: 'check_inbox', args: {} });
    const child = command('child-exec');
    const done = { ...command('done-exec'), status: 'completed' as const, exitCode: 0 };
    const next = command('next-exec');
    const toolStarted = (id: string, name = 'exec_command'): AgentEvent => ({
      type: 'tool_started',
      toolId: id,
      name,
      input: name === 'exec_command' ? 'echo hi' : '{}',
      command: name === 'exec_command' ? 'echo hi' : null,
    });
    expect(
      await run([
        begin(),
        // An interrupt with a command approval pending: Codex never completes that command's item.
        m.itemStarted(MAIN, TURN, exec),
        m.itemStarted(MAIN, TURN, call),
        m.itemStarted(CHILD, 'child-turn', child),
        m.itemStarted(MAIN, TURN, done),
        m.itemCompleted(MAIN, TURN, done),
        m.turnCompleted(MAIN, m.turn({ id: TURN, status: 'interrupted' })),
        m.itemCompleted(MAIN, TURN, { ...exec, status: 'declined' }),
        m.itemCompleted(CHILD, 'child-turn', { ...child, status: 'completed', exitCode: 0 }),
        begin('next'),
        m.itemStarted(MAIN, 'next', next),
        m.turnCompleted(
          MAIN,
          m.turn({ id: 'next', status: 'failed', error: m.turnError('internalServerError', 'gone') }),
        ),
      ]),
    ).toEqual([
      started,
      turnStarted,
      toolStarted('open-exec'),
      toolStarted('open-mcp', 'mcp__agflow__check_inbox'),
      toolStarted('child-exec'),
      toolStarted('done-exec'),
      toolEnded('done-exec'),
      // A child's tool counted for the main turn, so it ends with it too.
      toolEnded('open-exec', { ok: false }),
      toolEnded('open-mcp', { ok: false }),
      toolEnded('child-exec', { ok: false }),
      { type: 'turn_ended', outcome: 'interrupted', toolCalls: 4, error: null, errorKind: null },
      turnStarted,
      toolStarted('next-exec'),
      toolEnded('next-exec', { ok: false }),
      { type: 'turn_ended', outcome: 'failed', toolCalls: 1, error: 'gone', errorKind: 'vendor' },
    ]);
  });

  test("a child turn's end ends the tools still open in that turn, during a main turn or after it", async () => {
    const during = command('child-exec');
    const late = command('late-child-exec');
    const interrupted = (id: string) => m.turnCompleted(CHILD, m.turn({ id, status: 'interrupted' }));
    expect(
      await run([
        begin(),
        begin('child-turn', CHILD),
        m.itemStarted(CHILD, 'child-turn', during),
        // Interrupted with no item/completed for its command, while the main turn keeps running.
        interrupted('child-turn'),
        m.itemCompleted(CHILD, 'child-turn', { ...during, status: 'declined' }),
        m.itemCompleted(MAIN, TURN, m.agentMessageItem('still running')),
        finish(),
        // A child turn after the main turn ended: its tool counts for no main turn.
        begin('late-child-turn', CHILD),
        m.itemStarted(CHILD, 'late-child-turn', late),
        interrupted('late-child-turn'),
        begin('second'),
        finish('second'),
      ]),
    ).toEqual([
      started,
      turnStarted,
      { type: 'tool_started', toolId: 'child-exec', name: 'exec_command', input: 'echo hi', command: 'echo hi' },
      toolEnded('child-exec', { ok: false }),
      { type: 'text', text: 'still running' },
      turnEnded(1),
      { type: 'tool_started', toolId: 'late-child-exec', name: 'exec_command', input: 'echo hi', command: 'echo hi' },
      toolEnded('late-child-exec', { ok: false }),
      turnStarted,
      turnEnded(),
    ]);
  });

  test('context uses last input tokens and skips unknown or zero windows', async () => {
    const tokenUsage = probes.tokenUsageUpdated.params.tokenUsage;
    expect(
      await run(
        [258400, null, 0].map((modelContextWindow) => ({
          method: 'thread/tokenUsage/updated',
          params: { threadId: MAIN, turnId: TURN, tokenUsage: { ...tokenUsage, modelContextWindow } },
        })),
      ),
    ).toEqual([started, { type: 'context', used: 100 / 258400 }]);
  });

  test('interrupted and completed turns discard errors; retry errors do not fail a turn', async () => {
    const error = m.turnError('internalServerError', 'retrying');
    expect(
      await run([
        begin(),
        m.error(MAIN, TURN, error, true),
        finish(),
        begin('next'),
        m.error(MAIN, 'next', error),
        m.turnCompleted(MAIN, m.turn({ id: 'next', status: 'interrupted', error })),
        begin('last'),
        finish('last'),
      ]),
    ).toEqual([
      started,
      turnStarted,
      turnEnded(),
      turnStarted,
      { type: 'turn_ended', outcome: 'interrupted', toolCalls: 0, error: null, errorKind: null },
      turnStarted,
      turnEnded(),
    ]);
  });

  for (const info of [
    'internalServerError',
    { httpConnectionFailed: { httpStatusCode: 500 } },
  ] satisfies CodexErrorInfo[]) {
    test(`final 500 error wins over the completed turn's error: ${JSON.stringify(info)}`, async () => {
      expect(
        await run([
          begin(),
          m.error(MAIN, TURN, m.turnError(info, 'final error')),
          m.turnCompleted(MAIN, m.turn({ id: TURN, status: 'failed', error: m.turnError('unauthorized', 'fallback') })),
        ]),
      ).toEqual([
        started,
        turnStarted,
        {
          type: 'turn_ended',
          outcome: 'failed',
          toolCalls: 0,
          error: 'final error',
          errorKind: 'vendor',
        },
      ]);
    });
  }

  test('failed turns fall back to their own error, ignoring retry and steer-rejection errors', async () => {
    expect(
      await run([
        begin(),
        m.error(MAIN, TURN, m.turnError('unauthorized', 'retry'), true),
        m.error(MAIN, TURN, m.turnError({ activeTurnNotSteerable: { turnKind: 'review' } }, 'steer')),
        m.turnCompleted(MAIN, m.turn({ id: TURN, status: 'failed', error: m.turnError('cyberPolicy', 'blocked') })),
      ]),
    ).toEqual([
      started,
      turnStarted,
      {
        type: 'turn_ended',
        outcome: 'failed',
        toolCalls: 0,
        error: 'blocked',
        errorKind: 'policy',
      },
    ]);
  });

  test('a failed turn keeps its tool count and ignores final errors from other threads or turns', async () => {
    const item = { ...command(), status: 'completed' as const, exitCode: 0 };
    expect(
      await run([
        begin(),
        m.itemCompleted(MAIN, TURN, item),
        m.error(CHILD, TURN, m.turnError('usageLimitExceeded', 'child error')),
        m.error(MAIN, 'another-turn', m.turnError('unauthorized', 'another turn')),
        m.turnCompleted(MAIN, m.turn({ id: TURN, status: 'failed', error: m.turnError('sandboxError', 'failed') })),
      ]),
    ).toEqual([
      started,
      turnStarted,
      { type: 'tool_started', toolId: item.id, name: 'exec_command', input: 'echo hi', command: 'echo hi' },
      toolEnded(item.id),
      { type: 'turn_ended', outcome: 'failed', toolCalls: 1, error: 'failed', errorKind: 'vendor' },
    ]);
  });

  test('merges sparse rate limits and preserves the secondary window and paid usage facts', async () => {
    const now = 1793200000000;
    spyOn(Date, 'now').mockReturnValue(now);
    const primary = { usedPercent: 25, windowDurationMins: 300, resetsAt: 1793207969 };
    const secondary = { usedPercent: 50, windowDurationMins: 10080, resetsAt: 1793290769 };
    expect(
      await run([
        m.rateLimitsUpdated({ primary, secondary, credits: { hasCredits: true, unlimited: false, balance: null } }),
        m.rateLimitsUpdated({ primary: { ...primary, usedPercent: 100 }, secondary: null }),
      ]),
    ).toEqual([
      started,
      {
        type: 'quota',
        accountId: null,
        quota: {
          state: 'ok',
          resetsAt: 1793290769000,
          windows: { fiveHour: 0.25, weekly: 0.5 },
          paidUsage: 'enabled',
          updatedAt: now,
        },
      },
      {
        type: 'quota',
        accountId: null,
        quota: {
          state: 'ok',
          resetsAt: 1793207969000,
          windows: { fiveHour: 1, weekly: 0.5 },
          paidUsage: 'in_use',
          updatedAt: now,
        },
      },
    ]);
  });

  test('recorded usage-limit sequence emits exhausted quota in milliseconds before the failed turn', async () => {
    const now = 1793200000000;
    spyOn(Date, 'now').mockReturnValue(now);
    const quota: AgentEvent = {
      type: 'quota',
      accountId: null,
      quota: {
        state: 'exhausted',
        resetsAt: 1793207969000,
        windows: { fiveHour: 1, weekly: 0.1 },
        paidUsage: 'disabled',
        updatedAt: now,
      },
    };
    const error = m.turnError('usageLimitExceeded', probes.usageLimitError.params.error.message);
    expect(
      await run([
        begin(),
        probes.usageLimitRateLimits as ServerNotification,
        m.error(MAIN, TURN, error),
        m.turnCompleted(MAIN, m.turn({ id: TURN, status: 'failed' })),
      ]),
    ).toEqual([
      started,
      turnStarted,
      quota,
      quota,
      {
        type: 'turn_ended',
        outcome: 'failed',
        toolCalls: 0,
        error: error.message,
        errorKind: 'quota',
      },
    ]);
  });

  test('quota failure without a snapshot reports an unknown reset', async () => {
    const now = 1793200000000;
    spyOn(Date, 'now').mockReturnValue(now);
    expect(
      await run([
        begin(),
        m.turnCompleted(
          MAIN,
          m.turn({ id: TURN, status: 'failed', error: m.turnError('usageLimitExceeded', 'limit') }),
        ),
      ]),
    ).toEqual([
      started,
      turnStarted,
      {
        type: 'quota',
        accountId: null,
        quota: {
          state: 'exhausted',
          resetsAt: null,
          windows: { fiveHour: null, weekly: null },
          paidUsage: 'unknown',
          updatedAt: now,
        },
      },
      { type: 'turn_ended', outcome: 'failed', toolCalls: 0, error: 'limit', errorKind: 'quota' },
    ]);
  });

  test('a quota failure without a known reset asks account/rateLimits/read before it ends the turn', async () => {
    const now = 1793200000000;
    spyOn(Date, 'now').mockReturnValue(now);
    const f = sessionFixture({
      answers: {
        'account/rateLimits/read': {
          delayMs: 50,
          result: {
            ordinaryUsageAllowed: false,
            rateLimits: probes.usageLimitRateLimits.params.rateLimits as RateLimitSnapshot,
            rateLimitsByLimitId: null,
            rateLimitResetCredits: null,
            accountId: null,
            rateLimitUpsell: null,
          },
        },
        'turn/start': {
          then: [
            { notify: begin() },
            {
              notify: m.turnCompleted(
                MAIN,
                m.turn({ id: TURN, status: 'failed', error: m.turnError('usageLimitExceeded', 'limit') }),
              ),
            },
            { delayMs: 200 },
            { crash: { code: 0 } },
          ],
        },
      },
    });
    const session = await CodexSession.start(f.launch, f.options);
    expect(await collect(session.events)).toEqual([
      started,
      turnStarted,
      {
        type: 'quota',
        accountId: null,
        quota: {
          state: 'exhausted',
          resetsAt: 1793207969000,
          windows: { fiveHour: 1, weekly: 0.1 },
          paidUsage: 'disabled',
          updatedAt: now,
        },
      },
      { type: 'turn_ended', outcome: 'failed', toolCalls: 0, error: 'limit', errorKind: 'quota' },
    ]);
    await session.close();
    expect(readCodexRecord(f.bin)[0]!.requests.map(({ method }) => method)).toContain('account/rateLimits/read');
  });

  for (const skipAuthChecks of [false, true]) {
    test(`quota events carry the session's account id with skipAuthChecks=${skipAuthChecks}`, async () => {
      const f = sessionFixture({
        answers: {
          'account/read': {
            result: {
              account: { type: 'chatgpt', email: 'owner@example.com', planType: 'plus' },
              requiresOpenaiAuth: true,
            },
          },
          'turn/start': {
            then: [
              { notify: begin() },
              { notify: probes.usageLimitRateLimits as ServerNotification },
              {
                notify: m.turnCompleted(
                  MAIN,
                  m.turn({ id: TURN, status: 'failed', error: m.turnError('usageLimitExceeded', 'limit') }),
                ),
              },
              { crash: { code: 0 } },
            ],
          },
        },
      });
      const session = await CodexSession.start(f.launch, { ...f.options, skipAuthChecks });
      const accountId = skipAuthChecks
        ? TEST_ACCOUNT_ID
        : createHash('sha256').update('owner@example.com').digest('hex').slice(0, 16);
      const quotas = (await collect(session.events)).filter((event) => event.type === 'quota');
      expect(quotas.map((event) => event.accountId)).toEqual([accountId, accountId]);
      await session.close();
      expect(readCodexRecord(f.bin)[0]!.requests.some(({ method }) => method === 'account/read')).toBe(!skipAuthChecks);
    });
  }

  test('warning kinds are one-line notes, including warnings buffered during start checks', async () => {
    expect(
      await run(
        [
          m.warning('ordinary\n warning'),
          m.configWarning('config\n summary', 'fix\n it'),
          { method: 'deprecationNotice', params: { summary: 'old\n setting', details: 'use new' } },
          {
            method: 'model/rerouted',
            params: { threadId: MAIN, turnId: TURN, fromModel: 'one', toModel: 'two', reason: 'highRiskCyberActivity' },
          },
        ],
        {
          'thread/start': { then: [{ notify: m.warning('during checks', MAIN) }] },
          'mcpServerStatus/list': { result: mcp(), delayMs: 30 },
        },
      ),
    ).toEqual([
      started,
      { type: 'warning', text: 'codex warning: during checks' },
      { type: 'warning', text: 'codex warning: ordinary warning' },
      { type: 'warning', text: 'codex configuration warning: config summary: fix it' },
      { type: 'warning', text: 'codex deprecation: old setting: use new' },
      { type: 'warning', text: 'codex model rerouted: one -> two (highRiskCyberActivity)' },
    ]);
  });

  test('drains notifications that reach stdout after the process exit', async () => {
    // An escaped holder writes them 100 ms after the peer exits: ending the events at the exit would lose them.
    const notes = Array.from({ length: 20 }, (_, i) => m.warning(`after exit ${i}`));
    const f = sessionFixture({
      answers: {
        'turn/start': { then: [{ spawnPipeHolder: { detached: true, notify: notes } }, { crash: { code: 0 } }] },
      },
    });
    const session = await CodexSession.start(f.launch, f.options);
    try {
      expect(await collect(session.events)).toEqual([
        started,
        ...notes.map((note): AgentEvent => ({ type: 'warning', text: `codex warning: ${note.params.message}` })),
      ]);
      expect(await session.exited).toEqual({ code: 0, signal: null });
    } finally {
      for (const pid of readCodexRecord(f.bin)[0]?.pipeHolders ?? []) process.kill(pid, 'SIGKILL');
      await session.close();
    }
  }, 3000);

  test('bounds the stdout wait after exit when an escaped process holds it open', async () => {
    const f = sessionFixture({
      answers: {
        'turn/start': {
          then: [{ spawnPipeHolder: { detached: true } }, { notify: m.warning('before exit') }, { crash: { code: 0 } }],
        },
      },
    });
    const session = await CodexSession.start(f.launch, f.options);
    try {
      expect(await collect(session.events)).toEqual([started, { type: 'warning', text: 'codex warning: before exit' }]);
      expect(await session.exited).toEqual({ code: 0, signal: null });
    } finally {
      for (const pid of readCodexRecord(f.bin)[0]?.pipeHolders ?? []) {
        process.kill(pid, 'SIGKILL');
      }
      await session.close();
    }
  }, 3000);
});

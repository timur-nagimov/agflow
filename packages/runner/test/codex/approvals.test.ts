import { afterEach, describe, expect, test } from 'bun:test';
import { approvalFromRequest, decisionResponse } from '../../src/adapters/codex/approvals';
import { CODEX_VERSION } from '../../src/adapters/codex/binary';
import type { CodexServerRequestMethod } from '../../src/adapters/codex/methods';
import type { RequestPermissionProfile } from '../../src/adapters/codex/protocol/v2';
import { CodexSession } from '../../src/adapters/codex/session';
import type { AgentEvent } from '../../src/adapters/types';
import {
  codexMessages as m,
  FAKE_THREAD_ID as MAIN,
  fakeTurnId,
  readCodexRecord,
  type ScriptedServerRequest,
  type ScriptedStep,
} from './peer';
import probes from './probe-messages.json';
import { cleanupSessions, firstInput, sessionFixture, until, type SessionFixture } from './session-fixture';

const TURN = fakeTurnId(1);
const commandMethod = 'item/commandExecution/requestApproval';
const fileMethod = 'item/fileChange/requestApproval';
const permissionsMethod = 'item/permissions/requestApproval';
const command = { ...probes.commandApprovalRequest, id: 'command' } as Extract<
  ScriptedServerRequest,
  { method: typeof commandMethod }
>;
const commandDetail = {
  command: probes.commandApprovalRequest.params.command,
  cwd: probes.commandApprovalRequest.params.cwd,
  reason: probes.commandApprovalRequest.params.reason,
};
const started: AgentEvent = {
  type: 'started',
  sessionRef: MAIN,
  model: 'requested-model',
  cliVersion: CODEX_VERSION,
  permissionMode: 'on-request',
};
const permissions = {
  network: { enabled: true },
  fileSystem: {
    read: ['/read'],
    write: ['/write'],
    globScanMaxDepth: 2,
    entries: [{ path: { type: 'glob_pattern', pattern: '/extra/**' }, access: 'read' }],
  },
} satisfies RequestPermissionProfile;
const permissionRequest = m.permissionsApprovalRequest({
  threadId: MAIN,
  turnId: TURN,
  itemId: 'permissions',
  cwd: '/clone',
  permissions,
  reason: 'need access',
  id: 'permissions',
});
const patch = m.fileChangeItem({
  id: 'patch',
  changes: [
    { path: 'one.ts', kind: { type: 'add' }, diff: '+one' },
    { path: 'two.ts', kind: { type: 'delete' }, diff: '-two' },
  ],
});
const patchRequest = m.fileChangeApprovalRequest({
  threadId: MAIN,
  turnId: TURN,
  itemId: patch.id,
  grantRoot: '/extra',
  reason: 'write files',
  id: 'patch',
});
const finish = () => m.turnCompleted(MAIN, m.turn({ id: TURN, status: 'completed' }));
const unknownFiles = 'the changed files are unknown: no file-change item was seen';
const requested = `Permissions: ${JSON.stringify(permissions)}`;
const ended: AgentEvent = { type: 'turn_ended', outcome: 'completed', toolCalls: 0, error: null, errorKind: null };
const answers = (f: SessionFixture) => readCodexRecord(f.bin)[0]!.answers.map(({ at, ...answer }) => answer);
const requests = (f: SessionFixture) =>
  readCodexRecord(f.bin)[0]!
    .requests.filter(({ method }) => method === 'turn/steer' || method === 'turn/start')
    .map(({ method, params }) => ({ method, params }));
const input = (text: string) => [{ type: 'text', text, text_elements: [] }];

async function running(steps: ScriptedStep[], extra: Parameters<typeof sessionFixture>[0] = {}) {
  const f = sessionFixture({ ...extra, answers: { 'turn/start': { then: steps }, ...extra.answers } });
  const session = await CodexSession.start(f.launch, f.options);
  const events: AgentEvent[] = [];
  const draining = (async () => {
    for await (const event of session.events) events.push(event);
  })();
  return {
    f,
    session,
    events,
    async close() {
      await session.close();
      await draining;
    },
  };
}

function approvals(events: AgentEvent[]) {
  return events.filter(
    (event): event is Extract<AgentEvent, { type: 'approval_request' }> => event.type === 'approval_request',
  );
}

function approval(
  id: string,
  kind: 'command' | 'file_change' | 'other',
  summary: string,
  detail: Extract<AgentEvent, { type: 'approval_request' }>['detail'],
): Extract<AgentEvent, { type: 'approval_request' }> {
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  return { type: 'approval_request', approvalId: id, kind, summary, detail };
}

afterEach(cleanupSessions);

describe('Codex approval mapping', () => {
  test('keeps the full recorded command and omits absent detail keys', () => {
    expect(approvalFromRequest(commandMethod, command.params)).toEqual({
      threadId: MAIN,
      turnId: probes.commandApprovalRequest.params.turnId,
      itemId: probes.commandApprovalRequest.params.itemId,
      kind: 'command',
      summary: `Run command: ${commandDetail.command}`,
      detail: commandDetail,
    });
    expect(approvalFromRequest(commandMethod, { ...command.params, command: null, cwd: null, reason: null })).toEqual({
      threadId: MAIN,
      turnId: probes.commandApprovalRequest.params.turnId,
      itemId: probes.commandApprovalRequest.params.itemId,
      kind: 'command',
      summary: 'Run command',
      detail: {},
    });
    expect(approvalFromRequest(fileMethod, patchRequest.params)).toEqual({
      threadId: MAIN,
      turnId: TURN,
      itemId: patch.id,
      kind: 'file_change',
      summary: 'Apply file changes',
      detail: { reason: `write files\n${unknownFiles}`, grantRoot: '/extra' },
    });
  });

  test('a file change shows each change with its kind and every path it touches', () => {
    const move = m.fileChangeItem({
      id: patch.id,
      changes: [
        {
          path: '/clone/notes.sh',
          kind: { type: 'update', move_path: '/Users/me/Library/LaunchAgents/x.plist' },
          diff: '@@ -1 +1 @@\n-a\n+b',
        },
        { path: '/clone/one.ts', kind: { type: 'update', move_path: null }, diff: '+one' },
        ...patch.changes,
      ],
    });
    expect(approvalFromRequest(fileMethod, { ...patchRequest.params, reason: null }, move)?.detail).toEqual({
      diff: [
        'move /clone/notes.sh -> /Users/me/Library/LaunchAgents/x.plist\n@@ -1 +1 @@\n-a\n+b',
        'update /clone/one.ts\n+one',
        'add one.ts\n+one',
        'delete two.ts\n-two',
      ].join('\n'),
      grantRoot: '/extra',
    });
  });

  test('bounds what an approval carries, whatever the agent asks to run or write', () => {
    const huge = 'x'.repeat(2 * 1024 * 1024);
    const bounded = (approval: ReturnType<typeof approvalFromRequest>) => {
      expect(approval).not.toBeNull();
      const { kind, summary, detail } = approval!;
      expect(Buffer.byteLength(JSON.stringify({ kind, summary, detail }))).toBeLessThan(300_000);
      expect(approval!.summary.length).toBeLessThanOrEqual(501);
      expect(approval!.summary).not.toContain('\n');
      return approval!;
    };
    const run = bounded(
      approvalFromRequest(commandMethod, { ...command.params, command: `cat <<EOF\n${huge}\nEOF`, reason: huge }),
    );
    expect(run.summary).toBe('Run command: cat <<EOF…');
    expect(run.detail.command).toEndWith(`\n[truncated: ${huge.length + 14} bytes in total]`);
    expect(run.detail.reason).toEndWith(`\n[truncated: ${huge.length} bytes in total]`);
    const stdin = bounded(approvalFromRequest(commandMethod, { ...command.params, kind: 'writeStdin', command: huge }));
    expect(stdin.summary).toBe(`Stdin input to running command: ${'x'.repeat(500 - 32)}…`);
    const item = m.fileChangeItem({ id: patch.id, changes: [{ path: 'big.txt', kind: { type: 'add' }, diff: huge }] });
    expect(bounded(approvalFromRequest(fileMethod, patchRequest.params, item)).detail.diff).toContain('[truncated: ');
    const wide = { ...permissions, fileSystem: { ...permissions.fileSystem, read: [huge] } };
    bounded(approvalFromRequest(permissionsMethod, { ...permissionRequest.params, permissions: wide }));
    // A cut never splits a character.
    const emoji = bounded(approvalFromRequest(commandMethod, { ...command.params, command: '😀'.repeat(400_000) }));
    expect(emoji.detail.command).toStartWith('😀'.repeat(16_384));
    expect(emoji.detail.command).not.toContain('\uFFFD');
    expect(emoji.summary).toBe(`Run command: ${'😀'.repeat(243)}…`);
  });

  test('uses accept or decline only, and grants no permissions on decline', () => {
    for (const method of [commandMethod, fileMethod] as const) {
      expect(decisionResponse(method, 'approve')).toEqual({ decision: 'accept' });
      expect(decisionResponse(method, 'decline')).toEqual({ decision: 'decline' });
    }
    expect(decisionResponse(permissionsMethod, 'approve', permissions)).toEqual({ permissions, scope: 'turn' });
    expect(decisionResponse(permissionsMethod, 'approve', { network: { enabled: true }, fileSystem: null })).toEqual({
      permissions: { network: { enabled: true } },
      scope: 'turn',
    });
    expect(decisionResponse(permissionsMethod, 'decline', permissions)).toEqual({ permissions: {}, scope: 'turn' });
  });

  test('rejects malformed identities, detail and permission profiles', () => {
    for (const params of [
      null,
      [],
      {},
      { ...command.params, threadId: 1 },
      { ...command.params, itemId: undefined },
      { ...command.params, cwd: 3 },
      { ...command.params, kind: 'unknown' },
      { ...command.params, reason: [] },
    ]) {
      expect(approvalFromRequest(commandMethod, params)).toBeNull();
    }
    for (const profile of [
      null,
      {},
      { network: { enabled: 'yes' }, fileSystem: null },
      { ...permissions, surprise: true },
      { ...permissions, fileSystem: { read: null, write: [3] } },
    ]) {
      expect(approvalFromRequest(permissionsMethod, { ...permissionRequest.params, permissions: profile })).toBeNull();
    }
    expect(approvalFromRequest(fileMethod, { ...patchRequest.params, grantRoot: 1 })).toBeNull();
  });
});

describe('CodexSession approvals', () => {
  test('relays the recorded request under a UUID and accepts only once without voiding its answer', async () => {
    const r = await running([{ request: command }]);
    await until(() => approvals(r.events).length === 1);
    const id = approvals(r.events)[0]!.approvalId;
    expect(r.events).toEqual([
      started,
      approval(id, 'command', `Run command: ${commandDetail.command}`, commandDetail),
    ]);
    expect(answers(r.f)).toEqual([]);
    expect(await r.session.answerApproval('unknown', 'approve', null)).toBe(false);
    expect(await r.session.answerApproval(id, 'approve', null)).toBe(true);
    expect(await r.session.answerApproval(id, 'decline', null)).toBe(false);
    await until(() => answers(r.f).length === 1);
    await r.close();
    expect(answers(r.f)).toEqual([{ id: 'command', result: { decision: 'accept' } }]);
    expect(r.events).toEqual([
      started,
      approval(id, 'command', `Run command: ${commandDetail.command}`, commandDetail),
    ]);
  });

  test('writeStdin describes the command field as stdin input and ignores session-wide offers', async () => {
    const text = 'yes\n';
    const req = {
      ...command,
      params: {
        ...command.params,
        kind: 'writeStdin',
        command: text,
        availableDecisions: ['acceptForSession', 'cancel'],
      },
    } as ScriptedServerRequest;
    const r = await running([{ request: req }]);
    await until(() => approvals(r.events).length === 1);
    const id = approvals(r.events)[0]!.approvalId;
    const display = `Stdin input to running command: ${text}`;
    // The summary is one line; the detail keeps the input as it is.
    expect(r.events).toEqual([
      started,
      approval(id, 'command', 'Stdin input to running command: yes…', { ...commandDetail, command: display }),
    ]);
    expect(await r.session.answerApproval(id, 'approve', null)).toBe(true);
    await until(() => answers(r.f).length === 1);
    await r.close();
    expect(answers(r.f)).toEqual([{ id: 'command', result: { decision: 'accept' } }]);
  });

  test('file changes keep per-thread item diffs until completion and show grantRoot', async () => {
    const r = await running([
      { notify: m.itemStarted(MAIN, TURN, patch) },
      {
        notify: m.itemStarted('child', TURN, {
          ...patch,
          changes: [{ path: 'child', kind: { type: 'add' }, diff: '+child' }],
        }),
      },
      {
        request: patchRequest,
        afterAnswer: [
          { notify: m.serverRequestResolved(MAIN, 'patch') },
          { notify: m.itemCompleted(MAIN, TURN, { ...patch, status: 'completed' }) },
          { request: { ...patchRequest, id: 'after-completion' } },
        ],
      },
    ]);
    await until(() => approvals(r.events).length === 1);
    const id = approvals(r.events)[0]!.approvalId;
    expect(approvals(r.events)).toEqual([
      approval(id, 'file_change', 'Apply file changes', {
        diff: 'add one.ts\n+one\ndelete two.ts\n-two',
        reason: 'write files',
        grantRoot: '/extra',
      }),
    ]);
    expect(await r.session.answerApproval(id, 'approve', null)).toBe(true);
    await until(() => approvals(r.events).length === 2);
    const next = approvals(r.events)[1]!.approvalId;
    expect(approvals(r.events)[1]).toEqual(
      approval(next, 'file_change', 'Apply file changes', {
        reason: `write files\n${unknownFiles}`,
        grantRoot: '/extra',
      }),
    );
    expect(await r.session.answerApproval(next, 'decline', null)).toBe(true);
    await until(() => answers(r.f).length === 2);
    await r.close();
    expect(answers(r.f)).toEqual([
      { id: 'patch', result: { decision: 'accept' } },
      { id: 'after-completion', result: { decision: 'decline' } },
    ]);
  });

  for (const decision of ['approve', 'decline'] as const) {
    test(`permissions ${decision} grants only the requested profile for the turn`, async () => {
      const r = await running([{ request: permissionRequest }]);
      await until(() => approvals(r.events).length === 1);
      const id = approvals(r.events)[0]!.approvalId;
      expect(r.events).toEqual([
        started,
        approval(id, 'other', 'Request permissions for this turn', {
          cwd: '/clone',
          reason: `need access\n${requested}`,
        }),
      ]);
      expect(await r.session.answerApproval(id, decision, null)).toBe(true);
      await until(() => answers(r.f).length === 1);
      await r.close();
      expect(answers(r.f)).toEqual([
        { id: 'permissions', result: { permissions: decision === 'approve' ? permissions : {}, scope: 'turn' } },
      ]);
    });
  }

  test('elicitations, user input and unknown requests are answered immediately without relay', async () => {
    const question = { id: 'q1', header: 'Choice', question: 'Which?', isOther: false, isSecret: false, options: null };
    const r = await running([
      {
        request: m.elicitationRequest({
          threadId: MAIN,
          turnId: TURN,
          serverName: 'agflow',
          message: 'ask',
          id: 'elicit',
        }),
      },
      {
        request: m.userInputRequest({
          threadId: MAIN,
          turnId: TURN,
          itemId: 'input',
          questions: [question, { ...question, id: 'q2' }],
          id: 'input',
        }),
      },
      { request: { method: 'unknown/request', params: {}, id: 'unknown' } as unknown as ScriptedServerRequest },
    ]);
    await until(() => answers(r.f).length === 3);
    await r.close();
    expect(r.events).toEqual([started]);
    expect(answers(r.f).sort((a, b) => String(a.id).localeCompare(String(b.id)))).toEqual([
      { id: 'elicit', result: { action: 'decline', content: null, _meta: null } },
      {
        id: 'input',
        result: {
          answers: {
            q1: { answers: ['no person is available; decide yourself or use declare_blocked'] },
            q2: { answers: ['no person is available; decide yourself or use declare_blocked'] },
          },
        },
      },
      { id: 'unknown', error: { code: -32601, message: 'unhandled server request: unknown/request' } },
    ]);
  });

  for (const [method, result] of [
    [commandMethod, { decision: 'decline' }],
    [fileMethod, { decision: 'decline' }],
    [permissionsMethod, { permissions: {}, scope: 'turn' }],
    ['mcpServer/elicitation/request', { action: 'decline', content: null, _meta: null }],
    ['item/tool/requestUserInput', { answers: {} }],
  ] as [CodexServerRequestMethod, unknown][]) {
    test(`malformed ${method} is declined with a warning`, async () => {
      const r = await running([{ request: { method, params: { threadId: MAIN }, id: 42 } as ScriptedServerRequest }]);
      await until(() => answers(r.f).length === 1);
      await r.close();
      expect(answers(r.f)).toEqual([{ id: 42, result }]);
      expect(r.events).toEqual([
        started,
        { type: 'warning', text: `codex approval: cannot parse ${method}; declined` },
      ]);
    });
  }

  test('withdrawal voids only the matching unanswered request and settles it with a harmless decline', async () => {
    const r = await running([], {
      answers: {
        'turn/start': { then: [{ request: command }] },
        'turn/interrupt': {
          then: [
            { notify: m.serverRequestResolved('another-thread', 'command') },
            // A marker between the withdrawals: only the second one may void the request.
            { notify: m.threadStatusChanged(MAIN, ['waitingOnApproval']) },
            { notify: m.serverRequestResolved(MAIN, 'command') },
            { notify: m.serverRequestResolved(MAIN, 'command') },
          ],
        },
      },
    });
    await until(() => approvals(r.events).length === 1);
    const id = approvals(r.events)[0]!.approvalId;
    await r.session.interrupt();
    await until(() => r.events.some((event) => event.type === 'approval_void'));
    expect(await r.session.answerApproval(id, 'approve', null)).toBe(false);
    await until(() => answers(r.f).length === 1);
    await r.close();
    expect(r.events).toEqual([
      started,
      approval(id, 'command', `Run command: ${commandDetail.command}`, commandDetail),
      { type: 'waiting_approval', waiting: true },
      { type: 'approval_void', approvalId: id },
    ]);
    expect(answers(r.f)).toEqual([{ id: 'command', result: { decision: 'decline' } }]);
  });

  for (const active of [true, false]) {
    test(`a decline reason is steered into the asking turn only, with active=${active}`, async () => {
      const reason = 'the owner did not answer; continue without it or declare_blocked';
      const r = await running([], {
        answers: {
          'turn/start': { then: [{ request: command }, ...(!active ? [{ notify: finish() }] : [])] },
          // A turn that has ended refuses the steer; the note is then dropped rather than starting a turn.
          'turn/steer': active
            ? { then: [{ notify: finish() }] }
            : { error: { code: -32600, message: 'no active turn to steer' } },
        },
      });
      await until(() => approvals(r.events).length === 1 && (active || r.session.activeTurnId === null));
      const id = approvals(r.events)[0]!.approvalId;
      expect(await r.session.answerApproval(id, 'decline', reason)).toBe(true);
      expect(await r.session.answerApproval(id, 'decline', reason)).toBe(false);
      await until(() => r.events.length === (active ? 3 : 4));
      await r.close();
      expect(answers(r.f)).toEqual([{ id: 'command', result: { decision: 'decline' } }]);
      expect(requests(r.f)).toEqual([
        { method: 'turn/start', params: { threadId: MAIN, input: firstInput(r.f.launch.firstPrompt) } },
        {
          method: 'turn/steer',
          params: {
            threadId: MAIN,
            expectedTurnId: probes.commandApprovalRequest.params.turnId,
            input: input(`System note: ${reason}`),
          },
        },
      ]);
      expect(r.events).toEqual([
        started,
        approval(id, 'command', `Run command: ${commandDetail.command}`, commandDetail),
        ended,
        ...(active
          ? []
          : [
              {
                type: 'warning' as const,
                text: 'codex approval note: codex turn/steer failed: no active turn to steer',
              },
            ]),
      ]);
    });
  }

  test("a child thread's decline reason goes to that thread's turn", async () => {
    const child = {
      ...command,
      params: { ...command.params, threadId: 'child', turnId: 'child-turn' },
    } as ScriptedServerRequest;
    const r = await running([{ request: child }]);
    await until(() => approvals(r.events).length === 1);
    expect(await r.session.answerApproval(approvals(r.events)[0]!.approvalId, 'decline', 'not now')).toBe(true);
    await until(() => requests(r.f).length === 2);
    await r.close();
    expect(requests(r.f)[1]).toEqual({
      method: 'turn/steer',
      params: { threadId: 'child', expectedTurnId: 'child-turn', input: input('System note: not now') },
    });
  });

  test('combines waiting flags across threads and relays child approvals in this session', async () => {
    const child = { ...command, params: { ...command.params, threadId: 'child' } } as ScriptedServerRequest;
    const r = await running([
      { notify: m.threadStatusChanged(MAIN, ['waitingOnApproval']) },
      { notify: m.threadStatusChanged('child', ['waitingOnApproval']) },
      { notify: m.threadStatusChanged(MAIN, 'idle') },
      {
        request: child,
        afterAnswer: [
          { notify: m.serverRequestResolved('child', 'command') },
          { notify: m.threadStatusChanged('child', ['waitingOnUserInput']) },
          { notify: m.threadStatusChanged('child', 'idle') },
        ],
      },
    ]);
    await until(() => approvals(r.events).length === 1);
    const id = approvals(r.events)[0]!.approvalId;
    expect(await r.session.answerApproval(id, 'approve', null)).toBe(true);
    await until(() => r.events.some((event) => event.type === 'waiting_approval' && !event.waiting));
    await r.close();
    expect(r.events).toEqual([
      started,
      { type: 'waiting_approval', waiting: true },
      approval(id, 'command', `Run command: ${commandDetail.command}`, commandDetail),
      { type: 'waiting_approval', waiting: false },
    ]);
    expect(answers(r.f)).toEqual([{ id: 'command', result: { decision: 'accept' } }]);
  });

  test('buffers requests before started alongside their preceding item notifications', async () => {
    const r = await running([], {
      answers: { 'thread/start': { then: [{ notify: m.itemStarted(MAIN, TURN, patch) }, { request: patchRequest }] } },
    });
    await until(() => approvals(r.events).length === 1);
    const id = approvals(r.events)[0]!.approvalId;
    expect(r.events).toEqual([
      started,
      {
        type: 'tool_started',
        toolId: 'patch',
        name: 'apply_patch',
        input: 'one.ts\n+one\ntwo.ts\n-two',
        command: null,
      },
      approval(id, 'file_change', 'Apply file changes', {
        diff: 'add one.ts\n+one\ndelete two.ts\n-two',
        reason: 'write files',
        grantRoot: '/extra',
      }),
    ]);
    expect(await r.session.answerApproval(id, 'approve', null)).toBe(true);
    await until(() => answers(r.f).length === 1);
    await r.close();
  });

  test('exit forgets pending requests without emitting void events', async () => {
    const r = await running([], {
      answers: { 'turn/start': { then: [{ request: command }] }, 'turn/interrupt': { then: [{ crash: { code: 0 } }] } },
    });
    await until(() => approvals(r.events).length === 1);
    const id = approvals(r.events)[0]!.approvalId;
    await r.session.interrupt();
    await r.session.exited;
    expect(await r.session.answerApproval(id, 'approve', null)).toBe(false);
    await r.close();
    expect(r.events).toEqual([
      started,
      approval(id, 'command', `Run command: ${commandDetail.command}`, commandDetail),
    ]);
    expect(answers(r.f)).toEqual([]);
  });
});

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { VendorQuota } from '@agflow/core';
import type { AgentEvent } from '@agflow/runner';
import { FakeAdapter, type FakeStep } from '../src/fake-adapter';
import { killLater, record, runCleanups, setup, start, tempDir, turnEnded } from './fake-helpers';

afterEach(runCleanups);

// Every test here runs git or agent processes, which take several times as long on a machine loaded by other suites.
setDefaultTimeout(30_000);

const ERROR_KINDS = ['quota', 'vendor', 'auth', 'context', 'policy', 'denials', 'session_budget'] as const;

const waitingFor = (approvalId: string) => (event: AgentEvent) =>
  event.type === 'approval_request' && event.approvalId === approvalId;

describe('scripted failures', () => {
  test('end the turn as failed with each errorKind', async () => {
    const { launch } = await setup();
    const session = await start(launch, {
      turns: ERROR_KINDS.map((kind): FakeStep[] => [
        { do: 'tool', command: 'true' },
        { do: 'fail', kind, error: `${kind} trouble` },
        { do: 'text', text: 'never said' },
      ]),
    });
    const reader = record(session);
    for (const [i, kind] of ERROR_KINDS.entries()) {
      if (i > 0) await session.send({ id: `m${i}`, text: 'go on', authority: 'system' });
      await reader.waitFor((event) => event.type === 'turn_ended' && event.errorKind === kind);
    }
    const ended = reader.events.filter((event) => event.type === 'turn_ended');
    expect(ended).toEqual(
      ERROR_KINDS.map((kind) => ({
        type: 'turn_ended',
        outcome: 'failed',
        toolCalls: 1,
        error: `${kind} trouble`,
        errorKind: kind,
      })),
    );
    expect(reader.events.some((event) => event.type === 'text')).toBe(false);
  });
});

describe('scripted reports', () => {
  test('quota, context, compaction and warning events appear as scripted', async () => {
    const { launch } = await setup();
    const quota: VendorQuota = {
      state: 'ok',
      resetsAt: 1_800_000_000_000,
      windows: { fiveHour: 0.97, weekly: 0.4 },
      paidUsage: 'in_use',
      updatedAt: 1_700_000_000_000,
    };
    const session = await start(launch, {
      turns: [
        [
          { do: 'quota', quota, accountId: 'acct-1' },
          { do: 'context', used: 0.82 },
          { do: 'compacted', summary: 'the story so far' },
          { do: 'warning', text: 'auto-compaction ran' },
          { do: 'quota', quota: { ...quota, state: 'exhausted', paidUsage: 'disabled' } },
        ],
      ],
    });
    const reader = record(session);
    await reader.waitFor(turnEnded);
    expect(reader.events.slice(2, -1)).toEqual([
      { type: 'quota', accountId: 'acct-1', quota },
      { type: 'context', used: 0.82 },
      { type: 'compacted', summary: 'the story so far' },
      { type: 'warning', text: 'auto-compaction ran' },
      { type: 'quota', accountId: null, quota: { ...quota, state: 'exhausted', paidUsage: 'disabled' } },
    ]);
  });
});

describe('scripted approvals', () => {
  test('raise approval_request and waiting_approval, and the tool follows the answer', async () => {
    const { launch } = await setup();
    const session = await start(launch, {
      turns: [
        [
          {
            do: 'approval',
            approvalId: 'A-1',
            kind: 'command',
            summary: 'run the deploy script',
            detail: { command: './deploy.sh', cwd: launch.clone },
          },
          { do: 'approval', approvalId: 'A-2', kind: 'file_change', summary: 'edit the lockfile' },
          { do: 'text', text: 'done' },
        ],
      ],
    });
    const reader = record(session);
    await reader.waitFor(waitingFor('A-1'));
    expect(await session.answerApproval('A-404', 'approve', null)).toBe(false);
    expect(await session.answerApproval('A-1', 'approve', null)).toBe(true);
    expect(await session.answerApproval('A-1', 'approve', null)).toBe(false);
    await reader.waitFor(waitingFor('A-2'));
    expect(await session.answerApproval('A-2', 'decline', 'not now')).toBe(true);
    await reader.waitFor(turnEnded);
    expect(reader.events.slice(1)).toEqual([
      { type: 'turn_started' },
      { type: 'tool_started', toolId: 'toolu_1', name: 'Bash', input: 'run the deploy script', command: './deploy.sh' },
      {
        type: 'approval_request',
        approvalId: 'A-1',
        kind: 'command',
        summary: 'run the deploy script',
        detail: { command: './deploy.sh', cwd: launch.clone },
      },
      { type: 'waiting_approval', waiting: true },
      { type: 'waiting_approval', waiting: false },
      { type: 'tool_ended', toolId: 'toolu_1', ok: true, denied: false, terminal: null, hubUnreachable: false },
      { type: 'tool_started', toolId: 'toolu_2', name: 'Edit', input: 'edit the lockfile', command: null },
      { type: 'approval_request', approvalId: 'A-2', kind: 'file_change', summary: 'edit the lockfile', detail: {} },
      { type: 'waiting_approval', waiting: true },
      { type: 'waiting_approval', waiting: false },
      { type: 'tool_ended', toolId: 'toolu_2', ok: false, denied: true, terminal: null, hubUnreachable: false },
      { type: 'text', text: 'done' },
      { type: 'turn_ended', outcome: 'completed', toolCalls: 2, error: null, errorKind: null },
    ]);
  });

  test('a voided request ends the wait; answering it afterwards is refused', async () => {
    const { launch } = await setup();
    const session = await start(launch, {
      turns: [
        [
          { do: 'approval', approvalId: 'A-1', kind: 'other', summary: 'open the network', voidAfterMs: 100 },
          { do: 'approval', approvalId: 'A-2', kind: 'command', summary: 'rm -rf build' },
        ],
      ],
    });
    const reader = record(session);
    await reader.waitFor((event) => event.type === 'approval_void');
    expect(await session.answerApproval('A-1', 'approve', null)).toBe(false);
    await reader.waitFor(waitingFor('A-2'));
    // An interrupt voids the request it is waiting on.
    await session.interrupt();
    const ended = await reader.waitFor(turnEnded);
    expect(ended).toMatchObject({ outcome: 'interrupted', toolCalls: 2 });
    expect(await session.answerApproval('A-2', 'approve', null)).toBe(false);
    const flow = reader.events.flatMap((event) =>
      event.type === 'approval_void'
        ? [`void ${event.approvalId}`]
        : event.type === 'waiting_approval'
          ? [`waiting ${event.waiting}`]
          : event.type === 'tool_ended'
            ? [`tool ${event.ok} ${event.denied}`]
            : [],
    );
    expect(flow).toEqual([
      'waiting true',
      'void A-1',
      'waiting false',
      'tool false false',
      'waiting true',
      'void A-2',
      'waiting false',
      'tool false false',
    ]);
  });

  test('enrichApproval, when configured, adds its detail field; otherwise the adapter has none', async () => {
    const request = { kind: 'command' as const, summary: 'npm install', detail: { command: 'npm install' } };
    const input = { clone: '/tmp/clone', vault: '/tmp/vault', startSha: 'a'.repeat(40), request };
    expect(new FakeAdapter({ script: { turns: [] } }).enrichApproval).toBeUndefined();
    const adapter = new FakeAdapter({ script: { turns: [] }, enrichDetail: { manifestDiff: '+ left-pad' } });
    expect(await adapter.enrichApproval?.(input)).toEqual({ command: 'npm install', manifestDiff: '+ left-pad' });
  });
});

describe('transcripts', () => {
  test('readTranscriptTail reads the last assistant turns without a session; deleteTranscript drops them', async () => {
    const { launch, clone } = await setup();
    const transcriptDir = tempDir('agflow-fake-transcripts-');
    const adapter = new FakeAdapter({
      transcriptDir,
      script: {
        turns: [
          [{ do: 'text', text: 'first answer' }],
          [
            { do: 'text', text: 'second answer' },
            { do: 'text', text: 'and more' },
          ],
        ],
      },
    });
    const session = await adapter.start(launch);
    killLater(session.pid);
    const reader = record(session);
    await reader.waitFor(turnEnded);
    await session.send({ id: 'm1', text: 'continue', authority: 'person' });
    await reader.waitFor((event) => event.type === 'acknowledged');
    await session.close();
    await session.exited;
    const later = new FakeAdapter({ transcriptDir, script: { turns: [] } });
    const ref = { sessionRef: session.sessionRef, clone };
    const full = 'first answer\n\nsecond answer\nand more';
    expect(await later.readTranscriptTail({ ...ref, maxChars: 1_000 })).toBe(full);
    expect(await later.readTranscriptTail({ ...ref, maxChars: 12 })).toBe(full.slice(-12));
    expect(await later.readTranscriptTail({ sessionRef: 'never-ran', clone, maxChars: 100 })).toBeNull();
    await later.deleteTranscript(ref);
    expect(await later.readTranscriptTail({ ...ref, maxChars: 1_000 })).toBeNull();
    expect(existsSync(join(transcriptDir, `${session.sessionRef}.jsonl`))).toBe(false);
  });
});

describe('resume', () => {
  test('a session that ran a turn is resumed; one that never did starts fresh with a new sessionRef', async () => {
    const { launch } = await setup();
    const transcriptDir = tempDir('agflow-fake-transcripts-');
    const adapter = new FakeAdapter({
      transcriptDir,
      script: (current) =>
        current.resume ? { turns: [[{ do: 'text', text: 'resumed' }]] } : { turns: [[{ do: 'text', text: 'fresh' }]] },
    });
    const first = await adapter.start(launch);
    killLater(first.pid);
    await record(first).waitFor(turnEnded);
    await first.close();
    await first.exited;

    const resumed = await adapter.start({ ...launch, resume: { sessionRef: first.sessionRef } });
    killLater(resumed.pid);
    expect(resumed.sessionRef).toBe(first.sessionRef);
    const resumedReader = record(resumed);
    await resumedReader.waitFor((event) => event.type === 'started');
    await Bun.sleep(100);
    expect(resumedReader.events.map((event) => event.type)).toEqual(['started']);
    await resumed.close();
    await resumed.exited;

    const unborn = await adapter.start({ ...launch, resume: { sessionRef: 'never-ran-a-turn' } });
    killLater(unborn.pid);
    expect(unborn.sessionRef).not.toBe('never-ran-a-turn');
    expect(unborn.sessionRef).toMatch(/^[0-9a-f-]{36}$/);
    const unbornReader = record(unborn);
    await unbornReader.waitFor(turnEnded);
    expect(unbornReader.events[0]).toMatchObject({ type: 'started', sessionRef: unborn.sessionRef });
    // A fresh session: the first prompt starts a turn at once, with the script of a new launch.
    expect(unbornReader.events.find((event) => event.type === 'text')).toEqual({ type: 'text', text: 'fresh' });
  });
});

// The real pinned app-server's errors and approvals (design 15, 9.2, 9.3, 6.10, 7.8): quota, vendor and context
// failures, rate-limit headers, escalated commands and patches that ask the owner, withdrawn requests, and transcript
// deletion, all against the scripted provider with zero model use.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { TEST_ACCOUNT_ID } from '@agflow/core';
import {
  COMPACTION_PROMPT_PREFIX,
  rateLimitHeaders,
  reply,
  type ResponsesRequest,
  rules,
} from '@agflow/testkit/src/codex/index';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentEvent } from '../../../src/adapters/types';
import { until } from '../session-fixture';
import { type CodexHarness, EventLog, smokeCodexBinary, startCodexHarness } from './harness';

setDefaultTimeout(120_000);

const bin = await smokeCodexBinary();
let h: CodexHarness | null = null;
afterEach(async () => {
  try {
    // Every external connection would have met the refusing proxy: none was even tried.
    expect(h?.proxy.refused ?? []).toEqual([]);
  } finally {
    await h?.close();
    h = null;
  }
});

const CONTINUATION = 'System note: The context window filled up and was compacted.';

/** The rollout files under a Codex home, by name. */
function rollouts(codexHome: string): string[] {
  const sessions = join(codexHome, 'sessions');
  if (!existsSync(sessions)) return [];
  return readdirSync(sessions, { recursive: true, encoding: 'utf8' }).filter((name) => name.endsWith('.jsonl'));
}

describe.skipIf(bin === null)('the real app-server: errors and quota', () => {
  test('a 429 usage_limit_reached reports the exhausted quota in ms and a quota failure', async () => {
    const limit = reply.usageLimit(3_600);
    h = await startCodexHarness(bin!, { handler: () => limit });
    const session = await (await h.attempt()).start();
    const log = new EventLog(session.events);
    const ended = await log.next('turn_ended');
    expect(ended).toMatchObject({ outcome: 'failed', toolCalls: 0, errorKind: 'quota' });
    const exhausted: AgentEvent = {
      type: 'quota',
      accountId: TEST_ACCOUNT_ID,
      quota: {
        state: 'exhausted',
        // The five-hour window's reset, from epoch seconds to ms.
        resetsAt: Number(limit.headers!['x-codex-primary-reset-at']) * 1000,
        windows: { fiveHour: 1, weekly: 0.4 },
        paidUsage: 'unknown',
        updatedAt: expect.any(Number),
      },
    };
    // The headers' account/rateLimits/updated, then the failure's own report, both before the end.
    expect(log.events.slice(1).map((event) => event.type)).toEqual(['turn_started', 'quota', 'quota', 'turn_ended']);
    expect(log.of('quota')).toEqual([exhausted, exhausted]);
    expect(h.provider.requests).toHaveLength(1);
  });

  test('a 500 from the provider ends the turn as a vendor failure', async () => {
    h = await startCodexHarness(bin!, {
      handler: () => reply.httpError(500, { error: { type: 'server_error', message: 'The scripted server broke.' } }),
    });
    const session = await (await h.attempt()).start();
    const log = new EventLog(session.events);
    expect(await log.next('turn_ended')).toEqual({
      type: 'turn_ended',
      outcome: 'failed',
      toolCalls: 0,
      error: expect.any(String),
      errorKind: 'vendor',
    });
    // Retries are off in test mode: Codex gave up after the one request.
    expect(h.provider.requests).toHaveLength(1);
    expect(log.of('quota')).toEqual([]);
  });

  test('context_length_exceeded runs one compaction and a continuation that completes the work', async () => {
    h = await startCodexHarness(bin!, {
      handler: rules([
        { marker: 'Work on', reply: reply.failed('context_length_exceeded', 'Your input exceeds the context window.') },
        { marker: CONTINUATION, reply: reply.text('Continuing after the compaction.') },
      ]),
    });
    const session = await (await h.attempt()).start();
    const log = new EventLog(session.events);
    const ended = await log.next('turn_ended');
    expect(ended).toMatchObject({ outcome: 'completed', errorKind: null });
    // The failed turn's end is hidden: one turn_ended, after the compaction and the continuation.
    expect(log.of('turn_ended')).toHaveLength(1);
    expect(log.of('compacted')).toHaveLength(1);
    // The failed turn and the continuation; the compaction turn is hidden.
    expect(log.of('turn_started')).toHaveLength(2);
    const kinds = h.provider.requests.map((request) =>
      request.isCompaction ? 'compaction' : (request.lastUserText ?? '').slice(0, 20),
    );
    expect(kinds).toEqual([expect.stringMatching(/^Work on/), 'compaction', CONTINUATION.slice(0, 20)]);
    expect(h.provider.requests[1]!.lastUserText).toStartWith(COMPACTION_PROMPT_PREFIX);
    expect(log.of('text').map((event) => event.text)).toEqual(['Continuing after the compaction.']);
  });

  test('a second context_length_exceeded ends the continuation as a context failure', async () => {
    h = await startCodexHarness(bin!, {
      handler: rules([{ reply: reply.failed('context_length_exceeded', 'Your input exceeds the context window.') }]),
    });
    const session = await (await h.attempt()).start();
    const log = new EventLog(session.events);
    expect(await log.next('turn_ended')).toEqual({
      type: 'turn_ended',
      outcome: 'failed',
      toolCalls: 0,
      error: expect.any(String),
      errorKind: 'context',
    });
    // One compaction only: the continuation's failure is the attempt's context outcome.
    expect(h.provider.requests.filter((request) => request.isCompaction)).toHaveLength(1);
    expect(h.provider.requests.at(-1)!.lastUserText).toStartWith(CONTINUATION);
    await session.close();
    await log.done;
    expect(log.of('turn_ended')).toHaveLength(1);
  });

  test("rate-limit headers on a normal turn report both windows' utilization", async () => {
    const now = Math.floor(Date.now() / 1000);
    const headers = rateLimitHeaders({
      primary: { usedPercent: 25, windowMinutes: 300, resetAt: now + 3_600 },
      secondary: { usedPercent: 60, windowMinutes: 10_080, resetAt: now + 86_400 },
      credits: { hasCredits: false, unlimited: false },
    });
    h = await startCodexHarness(bin!, { handler: () => ({ ...reply.text('Within limits.'), headers }) });
    const session = await (await h.attempt()).start();
    const log = new EventLog(session.events);
    expect(await log.next('turn_ended')).toMatchObject({ outcome: 'completed' });
    expect(log.of('quota').at(-1)).toEqual({
      type: 'quota',
      accountId: TEST_ACCOUNT_ID,
      quota: {
        state: 'ok',
        // The limiting window is the fuller one, the weekly.
        resetsAt: (now + 86_400) * 1000,
        windows: { fiveHour: 0.25, weekly: 0.6 },
        paidUsage: 'disabled',
        updatedAt: expect.any(Number),
      },
    });
  });
});

describe.skipIf(bin === null)('the real app-server: approvals', () => {
  test('a declined escalation ends the item declined, and the turn continues with the steered reason', async () => {
    const reason = 'The owner declined: nothing outside the clone.';
    h = await startCodexHarness(bin!);
    const marker = join(h.dir, 'declined-marker');
    h.provider.setHandler((request: ResponsesRequest) => {
      if ((request.lastUserText ?? '').includes(reason)) return reply.text('Understood, staying inside the clone.');
      if (request.toolOutputsSinceUser === 0) {
        return reply.shell({ cmd: `touch ${marker}`, escalate: { justification: 'Write the marker outside.' } });
      }
      // Held until the steered note is in, so the turn samples again after it.
      return reply.hang(reply.shell({ cmd: 'true' }));
    });
    const a = await h.attempt();
    const session = await a.start();
    const log = new EventLog(session.events);
    const asked = await log.next('approval_request');
    expect(asked).toEqual({
      type: 'approval_request',
      approvalId: expect.any(String),
      kind: 'command',
      summary: expect.stringContaining(`touch ${marker}`),
      detail: {
        command: expect.stringContaining(`touch ${marker}`),
        cwd: a.clone,
        reason: 'Write the marker outside.',
      },
    });
    expect(await log.next('waiting_approval')).toEqual({ type: 'waiting_approval', waiting: true });
    expect(await session.answerApproval(asked.approvalId, 'decline', reason)).toBe(true);
    // A second answer finds nothing pending.
    expect(await session.answerApproval(asked.approvalId, 'approve', null)).toBe(false);
    const declined = await log.next('tool_ended');
    expect(declined).toMatchObject({ ok: false, denied: true });
    expect(await log.next('waiting_approval', { where: (event) => !event.waiting })).toEqual({
      type: 'waiting_approval',
      waiting: false,
    });
    await until(() => {
      h!.provider.release();
      return h!.provider.requests.some((request) => (request.lastUserText ?? '').includes(reason));
    }, 30_000);
    expect(await log.next('turn_ended')).toMatchObject({ outcome: 'completed' });
    expect(log.of('turn_started')).toHaveLength(1);
    expect(log.of('text').at(-1)?.text).toBe('Understood, staying inside the clone.');
    expect(h.provider.requests.flatMap((request) => request.toolOutputs).map((output) => output.output)).toContainEqual(
      expect.stringContaining('rejected by user'),
    );
    // The runner's own answer is no withdrawal.
    expect(log.of('approval_void')).toEqual([]);
    expect(existsSync(marker)).toBe(false);
  });

  test('an approved escalation runs the command outside the sandbox', async () => {
    h = await startCodexHarness(bin!);
    const marker = join(h.dir, 'approved-marker');
    h.provider.setHandler(
      rules([
        {
          toolOutputs: 0,
          reply: reply.shell({ cmd: `touch ${marker}`, escalate: { justification: 'Write the marker outside.' } }),
        },
        { toolOutputs: 1, reply: reply.text('The marker is written.') },
      ]),
    );
    const a = await h.attempt();
    expect(marker.startsWith(`${a.clone}/`)).toBe(false);
    const session = await a.start();
    const log = new EventLog(session.events);
    const asked = await log.next('approval_request');
    expect(await session.answerApproval(asked.approvalId, 'approve', null)).toBe(true);
    expect(await log.next('turn_ended')).toMatchObject({ outcome: 'completed', toolCalls: 1 });
    expect(log.of('tool_ended')).toEqual([expect.objectContaining({ ok: true, denied: false })]);
    expect(existsSync(marker)).toBe(true);
    expect(log.of('approval_void')).toEqual([]);
  });

  test('apply_patch to a path outside the clone asks for a file change with the diff', async () => {
    h = await startCodexHarness(bin!);
    const outside = join(h.dir, 'outside.txt');
    const patch = ['*** Begin Patch', `*** Add File: ${outside}`, '+written from the clone', '*** End Patch'].join(
      '\n',
    );
    h.provider.setHandler(
      rules([
        { toolOutputs: 0, reply: reply.patch(patch) },
        { toolOutputs: 1, reply: reply.text('The patch was declined.') },
      ]),
    );
    const session = await (await h.attempt()).start();
    const log = new EventLog(session.events);
    const asked = await log.next('approval_request');
    expect(asked).toMatchObject({ kind: 'file_change', summary: 'Apply file changes' });
    expect(asked.detail.diff).toContain(`add ${outside}`);
    expect(asked.detail.diff).toContain('written from the clone');
    expect(await session.answerApproval(asked.approvalId, 'decline', null)).toBe(true);
    expect(await log.next('turn_ended')).toMatchObject({ outcome: 'completed' });
    expect(log.of('tool_ended')).toEqual([expect.objectContaining({ ok: false, denied: true })]);
    expect(existsSync(outside)).toBe(false);
  });

  test('an interrupt while a request is pending voids it', async () => {
    h = await startCodexHarness(bin!);
    const marker = join(h.dir, 'interrupted-marker');
    h.provider.setHandler(
      rules([
        {
          toolOutputs: 0,
          reply: reply.shell({ cmd: `touch ${marker}`, escalate: { justification: 'Write the marker outside.' } }),
        },
      ]),
    );
    const session = await (await h.attempt()).start();
    const log = new EventLog(session.events);
    const asked = await log.next('approval_request');
    await session.interrupt();
    expect(await log.next('approval_void')).toEqual({ type: 'approval_void', approvalId: asked.approvalId });
    expect(await log.next('turn_ended')).toMatchObject({ outcome: 'interrupted', toolCalls: 1 });
    // Codex never completes the command it asked about: the turn's end ends it, before turn_ended.
    const [command] = log.of('tool_started');
    expect(log.of('tool_started')).toEqual([
      expect.objectContaining({ name: 'exec_command', command: `touch ${marker}` }),
    ]);
    expect(log.events.filter((event) => event.type === 'tool_ended' || event.type === 'turn_ended')).toEqual([
      { type: 'tool_ended', toolId: command!.toolId, ok: false, denied: false, terminal: null, hubUnreachable: false },
      expect.objectContaining({ type: 'turn_ended' }),
    ]);
    expect(await session.answerApproval(asked.approvalId, 'approve', null)).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });
});

describe.skipIf(bin === null)('the real app-server: transcripts', () => {
  test('deleteTranscript of an ended session removes its rollout, and the tail is then null', async () => {
    h = await startCodexHarness(bin!, { handler: () => reply.text('The transcript holds this answer.') });
    const a = await h.attempt();
    const session = await a.start();
    const log = new EventLog(session.events);
    await log.next('turn_ended');
    await session.close();
    await log.done;
    const codexHome = a.launch.env.CODEX_HOME!;
    const input = { sessionRef: session.sessionRef, clone: a.clone };
    expect(rollouts(codexHome).filter((name) => name.includes(session.sessionRef))).toHaveLength(1);
    expect(await h.adapter.readTranscriptTail({ ...input, maxChars: 1_000 })).toBe('The transcript holds this answer.');
    await h.adapter.deleteTranscript(input);
    expect(rollouts(codexHome).filter((name) => name.includes(session.sessionRef))).toEqual([]);
    expect(await h.adapter.readTranscriptTail({ ...input, maxChars: 1_000 })).toBeNull();
    // A second deletion finds no rollout, which counts as deleted.
    await h.adapter.deleteTranscript(input);
  });
});

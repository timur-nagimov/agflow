import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { InjectedMessage } from '@agflow/core';
import { FakeAdapter, type FakeAdapterOptions, type FakeScript, type TranscriptLine } from '@agflow/testkit';
import type { AgentSession, VendorAdapter } from '../src/adapters/types';
import { APPROVAL_DETAIL_FIELD_MAX_BYTES, APPROVAL_NOT_FORWARDED, APPROVAL_SUMMARY_MAX } from '../src/attempt/pump';
import type { Outbox } from '../src/outbox';
import { listProcesses } from '../src/processes';
import type { Notification } from '../src/seams';
import { cleanupRunnerFixtures, createRunnerFixture, FIXTURE_PROJECT, type RunnerFixture, waitFor } from './fixture';

afterEach(cleanupRunnerFixtures);

// Every test here runs git or agent processes, which take several times as long on a machine loaded by other suites.
setDefaultTimeout(30_000);

type Sent = Parameters<AgentSession['send']>[0];

/** A fake adapter whose sessions record what the runner sends them. */
function recordingAdapter(options: FakeAdapterOptions, sent: Sent[]): VendorAdapter & { fake: FakeAdapter } {
  const fake = new FakeAdapter(options);
  return {
    fake,
    vendor: fake.vendor,
    preflight: () => fake.preflight(),
    readTranscriptTail: (input) => fake.readTranscriptTail(input),
    deleteTranscript: (input) => fake.deleteTranscript(input),
    enrichApproval: fake.enrichApproval,
    async start(launch) {
      const session = await fake.start(launch);
      const send = session.send.bind(session);
      return Object.assign(Object.create(session) as AgentSession, {
        events: session.events,
        send: async (message: Sent) => {
          sent.push(message);
          await send(message);
        },
      });
    },
  };
}

/** The fixture with one recording claude adapter playing the script. */
async function setup(script: FakeScript, more: Partial<FakeAdapterOptions> = {}) {
  const f = await createRunnerFixture();
  const sent: Sent[] = [];
  const adapter = recordingAdapter({ vendor: 'claude', skipAuthChecks: true, script, ...more }, sent);
  f.adapters.set('claude', adapter);
  return { f, sent, adapter };
}

const activities = (f: RunnerFixture) => f.events('attempt.activity').map((event) => event.data);
const turnsEnded = (f: RunnerFixture) => activities(f).filter((data) => data.kind === 'turn').length;
const messageIds = (f: RunnerFixture, type: 'attempt.delivered' | 'attempt.acknowledged') =>
  f.events(type).flatMap((event) => event.data.messageIds);
const message = (messageId: number, authority: InjectedMessage['authority'], text: string) => ({
  messageId,
  authority,
  text,
});

/** The user lines of the attempt's fake transcript so far. */
function userLines(f: RunnerFixture): string[] {
  const sessionRef = f.events('attempt.spawned')[0]?.data.sessionRef;
  const clone = f.paths.clone(FIXTURE_PROJECT, 'T-4-a1');
  const file = join(clone, '.agflow', 'run', 'fake-transcripts', `${sessionRef}.jsonl`);
  if (sessionRef === undefined || !existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as TranscriptLine)
    .filter((line) => line.role === 'user')
    .map((line) => line.text);
}

const FENCE = { epoch: 1, counter: 1 };

describe('AttemptController: the event pump', () => {
  test('tools, turns, text, compactions, vendor errors and warnings become attempt.activity', async () => {
    const { f } = await setup({
      turns: [
        [
          { do: 'text', text: 'x'.repeat(2_000) },
          { do: 'tool', command: 'true' },
          { do: 'compacted', summary: 'the plan so far' },
          { do: 'warning', text: 'the context is nearly full' },
        ],
        [{ do: 'fail', kind: 'vendor', error: 'overloaded_error' }],
      ],
    });
    const controller = f.controller();
    await controller.start(f.spec());
    await waitFor(() => turnsEnded(f) === 1);
    expect(await controller.deliver({ fence: FENCE, messages: [message(5, 'person', 'go on')], more: 0 })).toEqual({
      ok: true,
    });
    await waitFor(() => activities(f).some((data) => data.kind === 'vendor_error'));
    const seen = activities(f);
    expect(seen.map((data) => data.kind)).toEqual(['text', 'tool', 'compaction', 'note', 'turn', 'vendor_error']);
    expect(seen[0]?.summary.length).toBeLessThanOrEqual(500);
    expect(seen[0]?.summary.startsWith('xxxx')).toBe(true);
    expect(seen.slice(1).map((data) => data.summary)).toEqual([
      'Bash: true',
      'the plan so far',
      'the context is nearly full',
      'turn completed with 1 tool call',
      'overloaded_error',
    ]);
    expect(f.events('attempt.activity')[0]?.fence).toEqual(FENCE);
  });

  test("only a successor's first assistant text becomes attempt.first_output", async () => {
    const script: FakeScript = { turns: [[{ do: 'text', text: 'State: nothing done yet.' }, { do: 'text', text: 'Next.' }]] };
    const successor = await setup(script);
    await successor.f.controller().start(successor.f.spec({ successor: true }));
    await waitFor(() => turnsEnded(successor.f) === 1);
    expect(successor.f.events('attempt.first_output').map((event) => event.data)).toEqual([
      { text: 'State: nothing done yet.' },
    ]);
    const first = await setup(script);
    await first.f.controller().start(first.f.spec());
    await waitFor(() => turnsEnded(first.f) === 1);
    expect(first.f.events('attempt.first_output')).toEqual([]);
  });

  test('deliver sends messages in order with their authority, reports their hub ids but never 0', async () => {
    const { f, sent } = await setup({ turns: [[]] });
    const controller = f.controller();
    await controller.start(f.spec());
    await waitFor(() => turnsEnded(f) === 1);
    const messages = [
      message(11, 'person', 'from alice'),
      message(0, 'system', 'the situation report'),
      message(12, 'agent', 'from the lead'),
    ];
    expect(await controller.deliver({ fence: FENCE, messages, more: 2 })).toEqual({ ok: true });
    const more = '2 more agflow messages are waiting: call check_inbox';
    // Each message the idle agent takes starts a turn of its own; the line about the rest comes last.
    await waitFor(() => userLines(f).includes(more));
    await waitFor(() => turnsEnded(f) === 5);
    expect(userLines(f)).toEqual(['Start working on T-4.', 'from alice', 'the situation report', 'from the lead', more]);
    expect(messageIds(f, 'attempt.delivered')).toEqual([11, 12]);
    expect(messageIds(f, 'attempt.acknowledged')).toEqual([11, 12]);
    expect(sent.map(({ text, authority }) => ({ text, authority }))).toEqual([
      { text: 'from alice', authority: 'person' },
      { text: 'the situation report', authority: 'system' },
      { text: 'from the lead', authority: 'agent' },
      { text: more, authority: 'system' },
    ]);
  });

  test('the interrupt command ends the turn without cancelling queued messages', async () => {
    const { f } = await setup({ turns: [[], [{ do: 'sleep', ms: 20_000 }], []] });
    const controller = f.controller();
    await controller.start(f.spec());
    await waitFor(() => turnsEnded(f) === 1);
    await controller.deliver({ fence: FENCE, messages: [message(21, 'person', 'start sleeping')], more: 0 });
    await waitFor(() => messageIds(f, 'attempt.delivered').includes(21));
    await controller.deliver({ fence: FENCE, messages: [message(22, 'person', 'queued')], more: 0 });
    expect(await controller.interrupt({ fence: FENCE })).toEqual({ ok: true });
    await waitFor(() => activities(f).some((data) => data.summary === 'turn interrupted'));
    await waitFor(() => messageIds(f, 'attempt.acknowledged').includes(22));
    expect(messageIds(f, 'attempt.delivered')).toEqual([21, 22]);
    expect(await controller.interrupt({ fence: { epoch: 1, counter: 9 } })).toEqual({
      ok: false,
      error: 'stale_fence',
    });
  });

  test('an approval request is relayed with the fence and the enriched detail, and the owner notified once', async () => {
    const notifications: Notification[] = [];
    const { f } = await setup(
      {
        turns: [
          [
            {
              do: 'approval',
              kind: 'command',
              summary: 'npm install left-pad',
              detail: { command: 'npm install left-pad', cwd: '/work' },
              approvalId: 'vendor-request-1',
            },
          ],
        ],
      },
      { enrichDetail: { manifestDiff: '+ "left-pad": "1.3.0"' } },
    );
    const controller = f.controller('T-4-a1', { notifier: { notify: (note) => void notifications.push(note) } });
    await controller.start(f.spec());
    const [requested] = await waitFor(
      () => f.events('approval.requested').length > 0 && f.events('approval.requested'),
    );
    const approvalId = requested?.data.approvalId as string;
    expect(approvalId).toMatch(/^[0-9a-f-]{36}$/);
    expect(approvalId).not.toBe('vendor-request-1');
    expect(requested?.fence).toEqual(FENCE);
    expect(requested?.data).toEqual({
      approvalId,
      kind: 'command',
      summary: 'npm install left-pad',
      detail: { command: 'npm install left-pad', cwd: '/work', manifestDiff: '+ "left-pad": "1.3.0"' },
    });
    await waitFor(() => controller.phase === 'waiting_approval');
    expect(notifications).toEqual([
      {
        key: approvalId,
        title: expect.stringContaining('T-4-a1'),
        body: 'npm install left-pad\nhttp://127.0.0.1:9#/approvals',
      },
    ]);
    const decide = (fence = FENCE) =>
      controller.decideApproval({ fence, approvalId, decision: 'approve', reason: null });
    expect(await decide({ epoch: 1, counter: 2 })).toEqual({ applied: false });
    expect(await decide()).toEqual({ applied: true });
    await waitFor(() => turnsEnded(f) === 1);
    expect(controller.phase).toBe('idle');
    expect(await decide()).toEqual({ applied: false });
    expect(notifications).toHaveLength(1);
  });

  test('an approval with a huge summary and detail is clipped to fit the outbox, and the agent is still followed', async () => {
    const { f } = await setup(
      {
        turns: [
          [{ do: 'approval', kind: 'command', summary: `npm install ${'x'.repeat(10_000)}`, detail: { command: 'npm i' } }],
          [{ do: 'text', text: 'after the approval' }],
        ],
      },
      { enrichDetail: { manifestDiff: `+${'"dep": "1.0.0",\n'.repeat(100_000)}` } },
    );
    const controller = f.controller();
    await controller.start(f.spec());
    const [requested] = await waitFor(
      () => f.events('approval.requested').length > 0 && f.events('approval.requested'),
    );
    const data = requested?.data;
    expect(data?.summary.length).toBe(APPROVAL_SUMMARY_MAX);
    expect(data?.summary.startsWith('npm install xxx')).toBe(true);
    expect(data?.detail.command).toBe('npm i');
    expect(data?.detail.manifestDiff?.endsWith('\n[clipped]')).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(data?.detail.manifestDiff))).toBeLessThanOrEqual(
      APPROVAL_DETAIL_FIELD_MAX_BYTES,
    );
    // The pump goes on: an answer applies, and a delivery is reported.
    const approvalId = data?.approvalId as string;
    expect(await controller.decideApproval({ fence: FENCE, approvalId, decision: 'approve', reason: null })).toEqual({
      applied: true,
    });
    await waitFor(() => turnsEnded(f) === 1);
    await controller.deliver({ fence: FENCE, messages: [message(41, 'person', 'go on')], more: 0 });
    await waitFor(() => messageIds(f, 'attempt.delivered').includes(41));
  });

  test('an approval request the outbox refuses is declined with the reason, and the agent goes on', async () => {
    const answers: [string, string, string | null][] = [];
    const notifications: Notification[] = [];
    const { f, adapter } = await setup({
      turns: [
        [{ do: 'approval', kind: 'command', summary: 'npm install', approvalId: 'vendor-request-1' }],
        [{ do: 'text', text: 'after the refusal' }],
      ],
    });
    const start = adapter.start.bind(adapter);
    adapter.start = async (launch) => {
      const session = await start(launch);
      const answer = session.answerApproval.bind(session);
      session.answerApproval = (approvalId, decision, reason) => {
        answers.push([approvalId, decision, reason]);
        return answer(approvalId, decision, reason);
      };
      return session;
    };
    const outbox = Object.create(f.outbox) as Outbox;
    outbox.append = (event) => {
      if (event.type === 'approval.requested') {
        throw new Error('the outbox refused a approval.requested event of 2000000 bytes: too large (1048576 max)');
      }
      return f.outbox.append(event);
    };
    const controller = f.controller('T-4-a1', { outbox, notifier: { notify: (note) => void notifications.push(note) } });
    await controller.start(f.spec());
    await waitFor(() => turnsEnded(f) === 1);
    expect(answers).toEqual([['vendor-request-1', 'decline', APPROVAL_NOT_FORWARDED]]);
    expect(f.events('approval.requested')).toEqual([]);
    expect(notifications).toEqual([]);
    expect(activities(f)).toContainEqual({ kind: 'note', summary: APPROVAL_NOT_FORWARDED });
    expect(f.logger.entries).toContainEqual({
      level: 'warn',
      message: 'cannot relay an approval request; it is declined',
      fields: {
        attemptId: 'T-4-a1',
        error: 'the outbox refused a approval.requested event of 2000000 bytes: too large (1048576 max)',
      },
    });
    // Nothing waits on it: the pump goes on with the next turn.
    await controller.deliver({ fence: FENCE, messages: [message(42, 'person', 'go on')], more: 0 });
    await waitFor(() => messageIds(f, 'attempt.delivered').includes(42));
    await waitFor(() => turnsEnded(f) === 2);
  });

  test('an event the runner fails to handle is logged, and the next events are handled', async () => {
    const { f } = await setup({ turns: [[{ do: 'text', text: 'first' }, { do: 'text', text: 'second' }]] });
    let refused = false;
    const outbox = Object.create(f.outbox) as Outbox;
    outbox.append = (event) => {
      if (!refused && event.type === 'attempt.activity') {
        refused = true;
        throw new Error('the outbox refused the event');
      }
      return f.outbox.append(event);
    };
    const controller = f.controller('T-4-a1', { outbox });
    await controller.start(f.spec());
    await waitFor(() => turnsEnded(f) === 1);
    expect(activities(f).filter((data) => data.kind === 'text')).toEqual([{ kind: 'text', summary: 'second' }]);
    expect(f.logger.entries).toContainEqual({
      level: 'error',
      message: 'cannot handle an agent event',
      fields: { attemptId: 'T-4-a1', type: 'text', error: 'the outbox refused the event' },
    });
  });

  test('decide_approval does not apply to a voided request or a dead process', async () => {
    const { f } = await setup({
      turns: [
        [{ do: 'approval', kind: 'other', summary: 'first', voidAfterMs: 100 }],
        [{ do: 'approval', kind: 'other', summary: 'second' }],
      ],
    });
    const controller = f.controller();
    await controller.start(f.spec());
    const [voided] = await waitFor(() => f.events('approval.voided').length > 0 && f.events('approval.voided'));
    const [first] = f.events('approval.requested');
    expect(voided?.data.approvalId).toBe(first?.data.approvalId as string);
    const answer = (approvalId: string) =>
      controller.decideApproval({ fence: FENCE, approvalId, decision: 'decline', reason: 'no' });
    expect(await answer(first?.data.approvalId as string)).toEqual({ applied: false });
    await controller.deliver({ fence: FENCE, messages: [message(30, 'person', 'again')], more: 0 });
    const second = await waitFor(() => f.events('approval.requested')[1]);
    const pid = controller.session?.pid as number;
    process.kill(-pid, 'SIGKILL');
    await waitFor(() => controller.session === null);
    expect(await answer(second.data.approvalId)).toEqual({ applied: false });
  });

  test('a tool start snapshots descendants and records their groups', async () => {
    const { f } = await setup({
      // exec: the tool's group leader is sleep itself, whether sh runs a lone command in its place (macOS) or not.
      turns: [[{ do: 'tool', command: 'exec sleep 30', wait: false }, { do: 'tool', command: 'true' }]],
    });
    const controller = f.controller();
    await controller.start(f.spec());
    await waitFor(() => turnsEnded(f) === 1);
    const pid = controller.session?.pid as number;
    const groups = await waitFor(() => {
      const recorded = f.store.processes('T-4-a1');
      return recorded.length >= 2 && recorded;
    });
    const tool = groups.find((group) => group.pgid !== pid);
    expect(tool?.clone).toBe(groups[0]?.clone as string);
    const [row] = await listProcesses([tool?.pgid as number]);
    expect(row?.command).toBe('sleep 30');
  }, 60_000);
});

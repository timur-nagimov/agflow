// Delivery, interrupts and the stop with the real claude (design 15, 8.3, 7.4), gated by AGFLOW_SMOKE=1 (X-20). The
// Bash commands wait for a file the test creates, a held scripted reply keeps a model call open until the interrupt,
// and a sent message counts as queued only once the CLI's transcript records it, so the test decides the order of
// events, never a sleep.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterToolResult, bashTool, hold, reply, rules, userSays } from '@agflow/testkit/src/anthropic';
import { claudeProjectDir } from '../../src/adapters/claude/paths';
import { boundedWait, listProcesses } from '../../src/processes';
import { waitFor } from '../fixture';
import {
  type ClaudeSmoke,
  cleanupClaudeSmokes,
  claudeSmokeGate,
  type SmokeSession,
  smokeDescribe,
  startClaudeSmoke,
} from './harness';

// A cold start of the CLI, its sandbox, the bridge and the brief hook, on a machine other suites may load.
setDefaultTimeout(180_000);

afterEach(cleanupClaudeSmokes);

const gate = claudeSmokeGate();

/** The stop ladder's close step (7.4): stdin EOF, then 2 s before the group gets SIGTERM. */
const CLOSE_BUDGET_MS = 2_000;

/** A Bash command that runs until the test creates the file. */
function waitingCommand(file: string): string {
  return `until [ -e '${file}' ]; do sleep 0.1; done; echo released`;
}

/** Polls an asynchronous check until it holds, or fails after timeoutMs. */
async function until(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`waited ${timeoutMs} ms in vain`);
    await Bun.sleep(50);
  }
}

/** Resolves once the model's call of the tool reached the CLI: the turn is in that tool's step. */
async function inTool(session: SmokeSession, toolId: string): Promise<void> {
  await session.next('tool_started', (event) => event.toolId === toolId);
}

/**
 * Resolves once the CLI read the message from its input and queued it: 2.1.285 then writes a queue-operation enqueue
 * line holding the text into the session's transcript. Before that, the message could still arrive after the tool's
 * step or the interrupt it is meant to precede.
 */
async function queued(smoke: ClaudeSmoke, session: SmokeSession, text: string): Promise<void> {
  const transcript = join(claudeProjectDir(smoke.claudeHome, smoke.clone), `${session.session.sessionRef}.jsonl`);
  const enqueued = (line: string) => {
    try {
      const entry = JSON.parse(line) as { type?: unknown; operation?: unknown; content?: unknown };
      return entry.type === 'queue-operation' && entry.operation === 'enqueue' && entry.content === text;
    } catch {
      // The line the CLI is still writing.
      return false;
    }
  };
  await waitFor(() => existsSync(transcript) && readFileSync(transcript, 'utf8').split('\n').some(enqueued), 30_000);
}

smokeDescribe(gate, 'the real claude: delivery, interrupts and stop', () => {
  test('a message sent while Bash runs is folded in after its result, then delivered and acknowledged', async () => {
    const PROMPT = 'Run the slow check.';
    const NOTE = 'A note for you while that runs: keep going.';
    const smoke = await startClaudeSmoke();
    const release = join(smoke.tmpDir, 'release-fold');
    smoke.server.setHandler(
      rules(
        { when: afterToolResult('toolu_fold_1'), reply: reply('Done, and I saw your note.') },
        { when: userSays(PROMPT), reply: reply(bashTool({ command: waitingCommand(release), id: 'toolu_fold_1' })) },
      ),
    );
    const session = await smoke.start({ prompt: PROMPT });
    await inTool(session, 'toolu_fold_1');
    await session.session.send({ id: 'msg-note', text: NOTE, authority: 'person' });
    await queued(smoke, session, NOTE);
    writeFileSync(release, '');
    const ended = await session.next('turn_ended');
    expect(ended).toMatchObject({ outcome: 'completed', error: null, toolCalls: 1 });
    // The model saw the note with the tool's result, in the same turn.
    const folded = smoke.server.requests.find((request) => afterToolResult('toolu_fold_1')(request));
    expect(folded?.lastToolResult?.text).toContain('released');
    expect(folded?.userTexts.some((text) => text.includes(NOTE))).toBe(true);
    expect(session.events.filter((event) => event.type === 'turn_started')).toHaveLength(1);
    const delivered = session.events.findIndex((event) => event.type === 'delivered' && event.id === 'msg-note');
    const acknowledged = session.events.findIndex((event) => event.type === 'acknowledged' && event.id === 'msg-note');
    expect(delivered).toBeGreaterThanOrEqual(0);
    expect(acknowledged).toBeGreaterThan(delivered);
    expect(smoke.isolationProblems()).toEqual([]);
  });

  test('a plain interrupt ends the turn interrupted and leaves a queued message to run next', async () => {
    const PROMPT = 'Think about the task.';
    const NOTE = 'When you can: look at the README.';
    const smoke = await startClaudeSmoke({
      handler: rules(
        { when: userSays(NOTE), reply: reply('Picked up the note.') },
        // Never released: the model call is still streaming when the interrupt comes.
        { when: userSays(PROMPT), reply: hold('never', reply('Thinking done.')) },
      ),
    });
    const session = await smoke.start({ prompt: PROMPT });
    await waitFor(() => smoke.server.requests.some((request) => request.mainLoop && userSays(PROMPT)(request)));
    await session.session.send({ id: 'msg-queued', text: NOTE, authority: 'person' });
    await queued(smoke, session, NOTE);
    await session.session.interrupt();
    expect(await session.next('turn_ended')).toMatchObject({ outcome: 'interrupted', errorKind: null });
    const interrupted = session.events.findIndex((event) => event.type === 'turn_ended');
    // The queued message starts the next turn, which the model answers.
    expect(await session.next('turn_ended', () => true, { from: interrupted + 1 })).toMatchObject({
      outcome: 'completed',
      error: null,
    });
    expect(smoke.server.requests.some((request) => request.mainLoop && userSays(NOTE)(request))).toBe(true);
    expect(await session.next('acknowledged', (event) => event.id === 'msg-queued')).toBeDefined();
    expect(smoke.isolationProblems()).toEqual([]);
  });

  test('an interrupt with cancelQueued ends the turn interrupted, and nothing queued runs', async () => {
    const PROMPT = 'Run the long check.';
    const DROPPED = 'This note is dropped by the stop.';
    const LATER = 'Say hello.';
    const smoke = await startClaudeSmoke();
    const release = join(smoke.tmpDir, 'release-never');
    smoke.server.setHandler(
      rules(
        { when: userSays(LATER), reply: reply('Hello.') },
        { when: userSays(DROPPED), reply: reply('I should never see this.') },
        { when: userSays(PROMPT), reply: reply(bashTool({ command: waitingCommand(release), id: 'toolu_stop_1' })) },
      ),
    );
    const session = await smoke.start({ prompt: PROMPT });
    await inTool(session, 'toolu_stop_1');
    await session.session.send({ id: 'msg-dropped', text: DROPPED, authority: 'person' });
    await queued(smoke, session, DROPPED);
    await session.session.interrupt({ cancelQueued: true });
    expect(await session.next('turn_ended')).toMatchObject({ outcome: 'interrupted', errorKind: null });
    // The next message runs alone: the dropped one reached no request, not even as history.
    const interrupted = session.events.findIndex((event) => event.type === 'turn_ended');
    await session.session.send({ id: 'msg-later', text: LATER, authority: 'person' });
    expect(await session.next('turn_ended', () => true, { from: interrupted + 1 })).toMatchObject({
      outcome: 'completed',
    });
    const mentions = smoke.server.requests.filter((request) => JSON.stringify(request.body).includes(DROPPED));
    expect(mentions).toEqual([]);
    expect(session.events.filter((event) => 'id' in event && event.id === 'msg-dropped')).toEqual([]);
    expect(smoke.isolationProblems()).toEqual([]);
  });

  test('close() ends the CLI within the stop budget and leaves no process in its group', async () => {
    const PROMPT = 'Say hello.';
    const smoke = await startClaudeSmoke({ handler: rules({ when: userSays(PROMPT), reply: reply('Hello.') }) });
    const session = await smoke.start({ prompt: PROMPT });
    expect(await session.next('turn_ended')).toMatchObject({ outcome: 'completed' });
    const group = session.session.pid;
    expect(group).toBeGreaterThan(0);
    // The bridge runs in the CLI's group.
    expect((await listProcesses()).filter((row) => row.pgid === group).length).toBeGreaterThan(1);
    const closed = Date.now();
    await session.session.close();
    const exit = await boundedWait(session.session.exited, CLOSE_BUDGET_MS);
    expect(exit).toEqual({ done: true, value: { code: 0, signal: null } });
    await until(async () => (await listProcesses()).every((row) => row.pgid !== group), CLOSE_BUDGET_MS);
    expect(Date.now() - closed).toBeLessThan(CLOSE_BUDGET_MS);
    await session.ended;
    expect(smoke.isolationProblems()).toEqual([]);
  });
});

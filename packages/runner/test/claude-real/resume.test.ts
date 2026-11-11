// Resume, vendor errors, compaction and the transcript with the real claude (design 15, 8.3, 8.4, 7.8), gated by
// AGFLOW_SMOKE=1 (X-20). Retries are off (CLAUDE_CODE_MAX_RETRIES=0), so an API error reaches the adapter at once.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AnthropicHandler,
  afterToolResult,
  bashTool,
  fail,
  reply,
  rules,
  userSays,
} from '@agflow/testkit/src/anthropic';
import { claudeProjectDir } from '../../src/adapters/claude/paths';
import { cleanupClaudeSmokes, claudeSmokeGate, type SmokeSession, smokeDescribe, startClaudeSmoke } from './harness';

// A cold start of the CLI, its sandbox, the bridge and the brief hook, on a machine other suites may load.
setDefaultTimeout(180_000);

afterEach(cleanupClaudeSmokes);

const gate = claudeSmokeGate();

/** Ends the input and waits for the CLI to exit and the events to end. */
async function closed(session: SmokeSession): Promise<void> {
  await session.session.close();
  await session.ended;
}

smokeDescribe(gate, 'the real claude: resume, vendor errors, compaction and the transcript', () => {
  test('a resume continues the conversation, and the brief hook fires again', async () => {
    const FIRST = 'Remember the word heliotrope.';
    const SECOND = 'Which word did I ask you to remember?';
    const smoke = await startClaudeSmoke({
      handler: rules(
        { when: userSays(SECOND), reply: reply('You asked me to remember heliotrope.') },
        { when: userSays(FIRST), reply: reply('I will remember heliotrope.') },
      ),
    });
    const first = await smoke.start({ prompt: FIRST });
    expect(await first.next('turn_ended')).toMatchObject({ outcome: 'completed' });
    await closed(first);
    const sessionRef = first.session.sessionRef;

    const resumed = await smoke.start({ resume: sessionRef });
    expect(resumed.session.sessionRef).toBe(sessionRef);
    // As the controller does once the start resolved: the resume's message starts its first turn.
    await resumed.session.send({ id: 'msg-resume', text: SECOND, authority: 'system' });
    expect(await resumed.next('turn_ended')).toMatchObject({ outcome: 'completed', error: null });
    expect(await resumed.next('started')).toMatchObject({ sessionRef });
    // The model sees the earlier turn, in the same session.
    const request = smoke.server.requests.find((candidate) => candidate.mainLoop && userSays(SECOND)(candidate));
    expect(request?.sessionId).toBe(sessionRef);
    const history = JSON.stringify(request?.messages);
    expect(history).toContain(FIRST);
    expect(history).toContain('I will remember heliotrope.');
    // The brief hook ran for the start and again for the resume.
    expect(smoke.hubRequests.filter((hub) => hub.path === '/api/brief' && hub.status === 200)).toHaveLength(2);
    expect(smoke.isolationProblems()).toEqual([]);
  });

  test('resuming a session that never ran a turn starts a fresh session with a new sessionRef', async () => {
    const PROMPT = 'Start working on the task.';
    const smoke = await startClaudeSmoke({ handler: rules({ when: userSays(PROMPT), reply: reply('Starting.') }) });
    // The real CLI leaves the session that never ran a turn: it dies in its SessionStart hook, while the hub holds the
    // brief. 2.1.285 writes a session's transcript only once that hook ended, together with the first user line, so
    // the session it leaves has its session-env directory and no transcript.
    const brief = smoke.holdHub('/api/brief');
    const dying = smoke.start({ prompt: 'This prompt never reaches the model.' });
    await brief.reached;
    const [first] = smoke.pids;
    if (first === undefined) throw new Error('the first launch registered no process');
    process.kill(-first, 'SIGTERM');
    const [settled] = await Promise.allSettled([dying]);
    if (settled.status === 'fulfilled') await settled.value.ended;
    const sessions = readdirSync(join(smoke.claudeHome, 'session-env'));
    expect(sessions).toHaveLength(1);
    const never = sessions[0] ?? '';
    expect(existsSync(join(claudeProjectDir(smoke.claudeHome, smoke.clone), `${never}.jsonl`))).toBe(false);
    brief.release();

    const before = smoke.server.requests.length;
    const session = await smoke.start({ resume: never, prompt: PROMPT });
    expect(session.session.sessionRef).not.toBe(never);
    expect(await session.next('started')).toMatchObject({ sessionRef: session.session.sessionRef });
    expect(await session.next('turn_ended')).toMatchObject({ outcome: 'completed' });
    const request = smoke.server.requests.find((candidate) => candidate.mainLoop && userSays(PROMPT)(candidate));
    expect(request?.sessionId).toBe(session.session.sessionRef);
    expect(smoke.server.requests.slice(before).filter((candidate) => candidate.sessionId === never)).toEqual([]);
    // One launch, one process (X-50): no resume was spawned first.
    expect(smoke.pids).toHaveLength(2);
    expect(smoke.isolationProblems()).toEqual([]);
  });

  test('a 529 or 500 gives a failed turn with errorKind vendor, and a 429 a vendor error, not quota', async () => {
    const sent: [prompt: string, status: number][] = [
      ['Overloaded call.', 529],
      ['Broken call.', 500],
      ['Limited call.', 429],
    ];
    // A failed turn adds no assistant message, so a later request's newest user entry still holds the earlier
    // prompts: the rules check the newest prompt first.
    const smoke = await startClaudeSmoke({
      maxRetries: 0,
      handler: rules(
        ...[...sent].reverse().map(([prompt, status]) => ({ when: userSays(prompt), reply: fail(status) })),
      ),
    });
    const session = await smoke.start({ prompt: sent[0]?.[0] });
    for (const [index, [prompt, status]] of sent.entries()) {
      const from = session.events.length;
      if (index > 0) await session.session.send({ id: `msg-${index}`, text: prompt, authority: 'system' });
      const ended = await session.next('turn_ended', () => true, { from });
      expect(ended).toMatchObject({ outcome: 'failed', errorKind: 'vendor' });
      // The turn failed with its own prompt's status, not an earlier one's.
      expect(ended.error).toContain(String(status));
      // Retries are off: one request per prompt.
      expect(smoke.server.requests.filter((request) => request.mainLoop && userSays(prompt)(request))).toHaveLength(1);
    }
    expect(session.events.filter((event) => event.type === 'quota')).toEqual([]);
    expect(smoke.isolationProblems()).toEqual([]);
  });

  test('/compact gives compacted with the scripted summary', async () => {
    const PROMPT = 'Say hello in one word.';
    const SUMMARY = 'Summary: the agent said hello; nothing else happened.';
    const main = rules({ when: userSays(PROMPT), reply: reply('Hello.') });
    const handler: AnthropicHandler = (request) => (request.compaction ? reply(SUMMARY) : main(request));
    const smoke = await startClaudeSmoke({ handler });
    const session = await smoke.start({ prompt: PROMPT });
    expect(await session.next('turn_ended')).toMatchObject({ outcome: 'completed' });
    await session.session.send({ id: 'msg-compact', text: '/compact', authority: 'system' });
    const compacted = await session.next('compacted');
    expect(compacted.summary).toContain(SUMMARY);
    expect(smoke.server.requests.some((request) => request.compaction)).toBe(true);
    expect(smoke.isolationProblems()).toEqual([]);
  });

  test('after the exit, the transcript tail holds the last assistant text; deleteTranscript removes it', async () => {
    const PROMPT = 'Print a long listing.';
    const LAST = 'The listing is long; I am done.';
    // Output this long is persisted beside the transcript instead of kept in it.
    const LONG = 'yes a | head -c 120000';
    const smoke = await startClaudeSmoke({
      handler: rules(
        { when: afterToolResult('toolu_long_1'), reply: reply(LAST) },
        { when: userSays(PROMPT), reply: reply(bashTool({ command: LONG, id: 'toolu_long_1' })) },
      ),
    });
    const session = await smoke.start({ prompt: PROMPT });
    expect(await session.next('turn_ended')).toMatchObject({ outcome: 'completed' });
    await closed(session);
    const ref = { sessionRef: session.session.sessionRef, clone: smoke.clone };
    expect(await smoke.adapter.readTranscriptTail({ ...ref, maxChars: 2_000 })).toEndWith(LAST);
    const project = claudeProjectDir(smoke.claudeHome, smoke.clone);
    const transcript = join(project, `${ref.sessionRef}.jsonl`);
    const toolResults = join(project, ref.sessionRef, 'tool-results');
    expect(existsSync(transcript)).toBe(true);
    expect(readdirSync(toolResults).length).toBeGreaterThan(0);
    await smoke.adapter.deleteTranscript(ref);
    expect(existsSync(transcript)).toBe(false);
    expect(existsSync(join(project, ref.sessionRef))).toBe(false);
    expect(await smoke.adapter.readTranscriptTail({ ...ref, maxChars: 2_000 })).toBeNull();
    expect(smoke.isolationProblems()).toEqual([]);
  });
});

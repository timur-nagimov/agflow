// The real pinned app-server's lifecycle (design 15, 9.2, 9.4, 7.4, 9.1): delivery at rest and mid-turn, agent
// messages, interrupt, resume after a kill and of a thread that never ran, the graceful close, concurrent starts on a
// fresh home and a command longer than exec_command's yield, all against the scripted provider with zero model use.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { reply, rules } from '@agflow/testkit/src/codex/index';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appServerArgs, appServerEnv, codexToolsNote, threadOverrides } from '../../../src/adapters/codex/config';
import { openAppServer } from '../../../src/adapters/codex/process';
import { vendorBinary } from '../../../src/vendor/pins';
import { alive, until } from '../session-fixture';
import { type CodexHarness, EventLog, type HarnessAttempt, smokeCodexBinary, startCodexHarness } from './harness';

setDefaultTimeout(120_000);

const bin = await smokeCodexBinary();
let h: CodexHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const HOLD = 'HOLD-THIS-TURN';

/** The provider's raw input items of a type, as Codex sent them. */
function inputItems(index: number, type: string): Record<string, unknown>[] {
  const input = h!.provider.requests[index]!.body.input as Record<string, unknown>[];
  return input.filter((item) => item.type === type);
}

describe.skipIf(bin === null)('the real app-server lifecycle', () => {
  test('a person message to an idle session starts a turn, then is delivered and acknowledged', async () => {
    h = await startCodexHarness(bin!);
    const session = await (await h.attempt()).start();
    const log = new EventLog(session.events);
    await log.next('turn_ended');
    const from = log.events.length;
    await session.send({ id: 'msg-1', text: 'Please also update the docs.', authority: 'person' });
    await log.next('turn_ended', { from });
    expect(log.events.slice(from).map((event) => event.type)).toEqual([
      'delivered',
      'turn_started',
      'text',
      'context',
      'quota',
      'acknowledged',
      'turn_ended',
    ]);
    expect(log.of('delivered')).toEqual([{ type: 'delivered', id: 'msg-1' }]);
    expect(log.of('acknowledged')).toEqual([{ type: 'acknowledged', id: 'msg-1' }]);
    // A new turn: the message is the request's newest user text, with no tool output after it.
    expect(h.provider.requests.at(-1)).toMatchObject({
      threadId: session.sessionRef,
      lastUserText: 'Please also update the docs.',
      toolOutputsSinceUser: 0,
    });
    expect(log.of('turn_started')).toHaveLength(2);
  });

  test('a delivery during a held response is steered into the turn and reaches the next provider request', async () => {
    h = await startCodexHarness(bin!, {
      handler: rules([
        // The held reply is a command, so the turn samples again after it and carries the steered message.
        { marker: HOLD, toolOutputs: 0, reply: reply.hang(reply.shell({ cmd: 'echo first' })) },
        { marker: 'Mid-turn note', reply: reply.text('Noted.') },
      ]),
    });
    const session = await (await h.attempt({ firstPrompt: `${HOLD}: start the work.` })).start();
    const log = new EventLog(session.events);
    await until(() => h!.provider.requests.length === 1, 30_000);
    await session.send({ id: 'msg-2', text: 'Mid-turn note: keep the API stable.', authority: 'person' });
    expect(log.of('delivered')).toEqual([{ type: 'delivered', id: 'msg-2' }]);
    expect(log.of('acknowledged')).toEqual([]);
    expect(h.provider.release()).toBe(1);
    const ended = await log.next('turn_ended');
    expect(ended).toMatchObject({ outcome: 'completed', toolCalls: 1 });
    expect(h.provider.requests.slice(1).map((request) => request.lastUserText)).toEqual([
      'Mid-turn note: keep the API stable.',
    ]);
    // One turn took both: it acknowledged the message before it ended.
    expect(log.of('turn_started')).toHaveLength(1);
    expect(log.events.findIndex((event) => event.type === 'acknowledged')).toBeLessThan(log.events.indexOf(ended));
    expect(log.of('acknowledged')).toEqual([{ type: 'acknowledged', id: 'msg-2' }]);
  });

  test("an agent's message reaches the provider as agflow's agent_message function_call_output", async () => {
    h = await startCodexHarness(bin!);
    const a = await h.attempt();
    const session = await a.start();
    const log = new EventLog(session.events);
    await log.next('turn_ended');
    const from = log.events.length;
    await session.send({ id: 'msg-3', text: 'From A-2: the API is done.', authority: 'agent' });
    await log.next('turn_ended', { from });
    const index = h.provider.requests.length - 1;
    expect(inputItems(index, 'function_call_output')).toEqual([
      {
        type: 'function_call_output',
        id: expect.any(String),
        name: 'agent_message',
        namespace: 'agflow',
        output: 'From A-2: the API is done.',
      },
    ]);
    expect(h.provider.requests[index]!.toolOutputs).toEqual([
      {
        type: 'function_call_output',
        callId: null,
        name: 'agent_message',
        output: 'From A-2: the API is done.',
        parts: ['From A-2: the API is done.'],
      },
    ]);
    // Tool authority, below the person's (design 5, 9.2): the newest user text is still the first prompt alone,
    // the tools note stays in developer instructions, and the agent's text is in no message item.
    expect(h.provider.requests[index]).toMatchObject({ toolOutputsSinceUser: 1 });
    expect(h.provider.requests[index]!.lastUserText).toBe(a.launch.firstPrompt);
    expect(h.provider.requests[index]!.instructions).toContain(a.launch.brief);
    expect(h.provider.requests[index]!.instructions).toContain(codexToolsNote(a.launch.bridge.tools));
    expect(
      inputItems(index, 'message')
        .flatMap((item) => item.content as { text?: string }[])
        .map((part) => part.text ?? '')
        .filter((text) => text.includes('From A-2: the API is done.')),
    ).toEqual([]);
    expect(
      log.events.slice(from).filter((event) => event.type === 'delivered' || event.type === 'acknowledged'),
    ).toEqual([
      { type: 'delivered', id: 'msg-3' },
      { type: 'acknowledged', id: 'msg-3' },
    ]);
  });

  test('an interrupt during a held response ends the turn interrupted, and the next send starts a new turn', async () => {
    h = await startCodexHarness(bin!, { handler: rules([{ marker: HOLD, reply: reply.hang() }]) });
    const session = await (await h.attempt({ firstPrompt: `${HOLD}: a long answer.` })).start();
    const log = new EventLog(session.events);
    await until(() => h!.provider.requests.length === 1, 30_000);
    await session.interrupt();
    expect(await log.next('turn_ended')).toEqual({
      type: 'turn_ended',
      outcome: 'interrupted',
      toolCalls: 0,
      error: null,
      errorKind: null,
    });
    await until(() => h!.provider.requests[0]!.aborted);
    const from = log.events.length;
    await session.send({ id: 'msg-4', text: 'Start again, briefly.', authority: 'person' });
    expect(await log.next('turn_ended', { from })).toMatchObject({ outcome: 'completed' });
    expect(log.of('turn_started')).toHaveLength(2);
    expect(h.provider.requests.at(-1)?.lastUserText).toBe('Start again, briefly.');
  });

  test('after a SIGKILL of the process group, a resume continues the same thread with its history', async () => {
    h = await startCodexHarness(bin!, {
      handler: rules([{ marker: 'Work on', reply: reply.text('First answer: the plan is ready.') }]),
    });
    const a = await h.attempt();
    const session = await a.start();
    const log = new EventLog(session.events);
    await log.next('turn_ended');
    process.kill(-session.pid, 'SIGKILL');
    expect(await session.exited).toEqual({ code: null, signal: 'SIGKILL' });
    await log.done;

    const resumed = await a.start(session.sessionRef);
    expect(resumed.sessionRef).toBe(session.sessionRef);
    expect(resumed.pid).not.toBe(session.pid);
    expect(a.registered).toEqual([session.pid, resumed.pid]);
    const resumedLog = new EventLog(resumed.events);
    // A resume sends no prompt of its own: the runner's resume prompt arrives as a message.
    await resumedLog.next('started');
    expect(h.provider.requests).toHaveLength(1);
    await resumed.send({ id: 'msg-5', text: 'Resume where you left off.', authority: 'person' });
    await resumedLog.next('turn_ended');
    const last = h.provider.requests.at(-1)!;
    expect(last).toMatchObject({ threadId: session.sessionRef, lastUserText: 'Resume where you left off.' });
    const said = inputItems(h.provider.requests.length - 1, 'message')
      .flatMap((item) => item.content as { text?: string }[])
      .map((part) => part.text);
    expect(said).toContain(a.launch.firstPrompt);
    expect(said).toContain('First answer: the plan is ready.');
  });

  test('resuming a thread that never ran a turn starts a fresh thread with the first prompt', async () => {
    h = await startCodexHarness(bin!);
    const a = await h.attempt();
    // A thread/start with nothing after it, as when a start dies before its first turn: Codex keeps no rollout.
    const codexHome = a.launch.env.CODEX_HOME!;
    const userHome = a.launch.env.HOME!;
    for (const home of [codexHome, userHome]) mkdirSync(home, { recursive: true, mode: 0o700 });
    const app = await openAppServer({
      bin: join(h.paths.runner, vendorBinary('codex', a.launch.cliVersion)),
      args: appServerArgs(h.config.test!.codexConfig),
      env: appServerEnv({ base: a.launch.env, bridgeEnv: a.launch.bridge.env, codexHome, userHome }),
      cwd: userHome,
      expectedVersion: a.launch.cliVersion,
      logFile: join(h.dir, 'never-ran.log'),
    });
    let neverRan: string;
    try {
      neverRan = (await app.rpc.request('thread/start', threadOverrides(a.launch, userHome))).thread.id;
    } finally {
      await app.end();
    }
    const session = await a.start(neverRan);
    const log = new EventLog(session.events);
    expect(session.sessionRef).not.toBe(neverRan);
    expect(await log.next('started')).toMatchObject({ sessionRef: session.sessionRef });
    await log.next('turn_ended');
    expect(h.provider.requests).toHaveLength(1);
    expect(h.provider.requests[0]).toMatchObject({ threadId: session.sessionRef });
    // The fallback uses the same contract as a fresh start: prompt alone, with the tools note in instructions.
    expect(h.provider.requests[0]!.lastUserText).toBe(a.launch.firstPrompt);
    expect(h.provider.requests[0]!.instructions).toContain(a.launch.brief);
    expect(h.provider.requests[0]!.instructions).toContain(codexToolsNote(a.launch.bridge.tools));
    // One app-server run: the fallback starts the fresh thread in the same process.
    expect(a.registered).toEqual([session.pid]);
  });

  test("close() ends the app-server with exit 0 and ends a background command's process", async () => {
    // exec_command yields after half a second while sleep runs on as a background session of the app-server.
    const background = [
      "const started = await tools.exec_command({ cmd: 'echo $$ > background.pid; exec sleep 300', yield_time_ms: 500 });",
      'text(JSON.stringify(started));',
    ].join('\n');
    h = await startCodexHarness(bin!, {
      handler: rules([
        { toolOutputs: 0, reply: reply.code(background) },
        { toolOutputs: 1, reply: reply.text('The server runs in the background.') },
      ]),
    });
    const a = await h.attempt();
    const session = await a.start();
    const log = new EventLog(session.events);
    expect(await log.next('turn_ended')).toMatchObject({ outcome: 'completed' });
    const pid = Number(readFileSync(join(a.clone, 'background.pid'), 'utf8').trim());
    expect(alive(pid)).toBe(true);
    await session.close();
    expect(await session.exited).toEqual({ code: 0, signal: null });
    await until(() => !alive(pid));
    await log.done;
  });

  test('two sessions started at once on a fresh runner Codex home both start', async () => {
    h = await startCodexHarness(bin!);
    const [first, second] = await Promise.all([h.attempt(), h.attempt()]);
    const sessions = await Promise.all([first!.start(), second!.start()]);
    expect(new Set(sessions.map((session) => session.sessionRef)).size).toBe(2);
    const logs = sessions.map((session) => new EventLog(session.events));
    for (const log of logs) expect(await log.next('turn_ended')).toMatchObject({ outcome: 'completed' });
    expect(first!.registered).toHaveLength(1);
    expect(second!.registered).toHaveLength(1);
  });

  test("a 35 s command completes inside one exec call, past exec_command's 30 s yield", async () => {
    h = await startCodexHarness(bin!, {
      handler: rules([
        { toolOutputs: 0, reply: reply.shell({ cmd: 'sleep 35 && echo slept', timeoutMs: 60_000 }) },
        { toolOutputs: 1, reply: reply.text('The long command finished.') },
      ]),
    });
    const attempt: HarnessAttempt = await h.attempt();
    const session = await attempt.start();
    const log = new EventLog(session.events);
    expect(await log.next('turn_ended', { ms: 90_000 })).toMatchObject({ outcome: 'completed', toolCalls: 1 });
    expect(log.of('tool_started')).toEqual([
      {
        type: 'tool_started',
        toolId: expect.any(String),
        name: 'exec_command',
        input: 'sleep 35 && echo slept',
        command: 'sleep 35 && echo slept',
      },
    ]);
    expect(log.of('tool_ended')).toEqual([
      {
        type: 'tool_ended',
        toolId: log.of('tool_started')[0]!.toolId,
        ok: true,
        denied: false,
        terminal: null,
        hubUnreachable: false,
      },
    ]);
    // The exec call's one output carries the command's exit and its output.
    expect(h.provider.requests[1]!.toolOutputs).toHaveLength(1);
    expect(h.provider.requests[1]!.toolOutputs[0]!.output).toMatch(/"exit_code":0/);
    expect(h.provider.requests[1]!.toolOutputs[0]!.output).toContain('slept');
  });
});

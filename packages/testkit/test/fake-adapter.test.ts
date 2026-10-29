import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TEST_ACCOUNT_ID } from '@agflow/core';
import {
  type AgentEvent,
  type AgentLaunch,
  type AgentSession,
  agentGitEnv,
  processIdentity,
  removeAgentTools,
  standardProfile,
  writeRunDir,
} from '@agflow/runner';
import { FAKE_AGENT_PATH, FakeAdapter, type FakeAdapterOptions, type FakeScript } from '../src/fake-adapter';
import { gitIn, originRepo } from '../src/git-fixtures';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

// Every test here runs git or agent processes, which take several times as long on a machine loaded by other suites.
setDefaultTimeout(30_000);

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Kills a process group at the end of the test, whatever state it is in. */
function killLater(pgid: number): void {
  cleanups.push(() => {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  });
}

const IDENTITY = { name: 'Agent Smith', email: 'agent@agflow.invalid' };

/** A clone on its task branch with the agent's .agflow/run/, and a launch for it. */
async function setup(overrides: Partial<AgentLaunch> = {}): Promise<{ launch: AgentLaunch; clone: string }> {
  const origin = await originRepo({ 'README.md': '# demo\n' });
  cleanups.push(() => origin.remove());
  const clone = join(tempDir('agflow-fake-clone-'), 'T-4-a1');
  await gitIn(tmpdir(), ['clone', '--quiet', origin.path, clone]);
  await gitIn(clone, ['checkout', '--quiet', '-b', 'agflow/T-4-tidy']);
  const tools = join(tempDir('agflow-fake-tools-'), 'T-4-a1');
  cleanups.push(() => removeAgentTools(tools));
  const runDir = writeRunDir({ clone, tools, taskPack: '# T-4\n', brief: 'brief', identity: IDENTITY });
  // As the runner's clones do, so the agent's `git add -A` leaves .agflow/run/ out.
  appendFileSync(join(clone, '.git', 'info', 'exclude'), '/.agflow/run/\n');
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: tempDir('agflow-fake-home-'), ...agentGitEnv(runDir) };
  const launch: AgentLaunch = {
    attemptId: 'T-4-a1',
    role: 'worker',
    model: 'fake-model',
    cliVersion: '9.9.9',
    clone,
    baseCheckout: null,
    projectConfigVerified: true,
    tmpDir: runDir.tmp,
    env,
    bridge: { command: '/bin/false', args: [], env: {} },
    profile: standardProfile,
    brief: 'brief',
    firstPrompt: 'start working',
    resume: null,
    logFile: join(tempDir('agflow-fake-logs-'), 'T-4-a1.log'),
    registerProcess: () => {},
    ...overrides,
  };
  return { launch, clone };
}

async function start(
  launch: AgentLaunch,
  script: FakeScript,
  options: Omit<FakeAdapterOptions, 'script'> = {},
): Promise<AgentSession> {
  const session = await new FakeAdapter({ ...options, script }).start(launch);
  killLater(session.pid);
  return session;
}

/** Reads every event of a session in the background. */
function record(session: AgentSession) {
  const events: AgentEvent[] = [];
  void (async () => {
    for await (const event of session.events) events.push(event);
  })();
  return {
    events,
    types: () =>
      events.map((event) =>
        event.type === 'delivered' || event.type === 'acknowledged' ? `${event.type} ${event.id}` : event.type,
      ),
    async waitFor(check: (event: AgentEvent) => boolean, timeoutMs = 5_000): Promise<AgentEvent> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = events.find(check);
        if (found) return found;
        if (Date.now() > deadline) throw new Error(`no such event in ${JSON.stringify(events)}`);
        await Bun.sleep(5);
      }
    },
  };
}

const turnEnded = (event: AgentEvent) => event.type === 'turn_ended';
const countOf = (events: AgentEvent[], type: AgentEvent['type']) =>
  events.filter((event) => event.type === type).length;

async function waitFile(path: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path) || readFileSync(path, 'utf8').trim() === '') {
    if (Date.now() > deadline) throw new Error(`${path} never appeared`);
    await Bun.sleep(10);
  }
  return readFileSync(path, 'utf8').trim();
}

describe('FakeAdapter.start', () => {
  test('runs the fake agent detached in its own group, registered before its output is read', async () => {
    const order: string[] = [];
    const { launch } = await setup({ registerProcess: (pid) => order.push(`register ${pid}`) });
    const session = await start(launch, { turns: [] });
    expect(order).toEqual([`register ${session.pid}`]);
    expect(FAKE_AGENT_PATH.endsWith('fake-agent.ts')).toBe(true);
    const identity = await processIdentity(session.pid);
    expect(identity?.pgid).toBe(session.pid);
    const reader = record(session);
    await reader.waitFor(turnEnded);
    expect(reader.events[0]).toEqual({
      type: 'started',
      sessionRef: session.sessionRef,
      model: 'fake-model',
      cliVersion: '9.9.9',
      permissionMode: 'acceptEdits',
    });
    expect(session.sessionRef).toMatch(/^[0-9a-f-]{36}$/);
    expect(reader.types()).toEqual(['started', 'turn_started', 'turn_ended']);
  });

  test('kills the agent and rejects when registerProcess throws, before it plays any of its script', async () => {
    const out = join(tempDir('agflow-fake-out-'), 'written');
    let pid = 0;
    const { launch, clone } = await setup({
      registerProcess: (registered) => {
        pid = registered;
        throw new Error('runner.db is gone');
      },
    });
    const adapter = new FakeAdapter({
      script: { turns: [[{ do: 'sleep', ms: 200 }, { do: 'tool', command: `touch '${out}'` }]] },
    });
    await expect(adapter.start(launch)).rejects.toThrow('runner.db is gone');
    expect(pid).toBeGreaterThan(0);
    expect(await processIdentity(pid)).toBeNull();
    expect(adapter.launches).toEqual([]);
    await Bun.sleep(400);
    expect(existsSync(out)).toBe(false);
    expect(await gitIn(clone, ['status', '--porcelain'])).toBe('');
  });

  test("loads neither a bunfig.toml nor a .env from the clone", async () => {
    const { launch, clone } = await setup();
    const marker = join(tempDir('agflow-fake-out-'), 'preloaded');
    writeFileSync(join(clone, 'preload.ts'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n`);
    writeFileSync(join(clone, 'bunfig.toml'), 'preload = ["./preload.ts"]\n');
    writeFileSync(join(clone, '.env'), 'AGFLOW_FAKE_PROBE=from-dotenv\n');
    const out = join(tempDir('agflow-fake-out-'), 'probe');
    const session = await start(launch, {
      turns: [[{ do: 'tool', command: `printf '%s' "\${AGFLOW_FAKE_PROBE:-unset}" > '${out}'` }]],
    });
    const reader = record(session);
    await reader.waitFor(turnEnded);
    expect(readFileSync(out, 'utf8')).toBe('unset');
    expect(existsSync(marker)).toBe(false);
  });

  test('a script larger than the argument limit still starts', async () => {
    const { launch, clone } = await setup();
    const content = 'x'.repeat(2 * 1024 * 1024);
    const session = await start(launch, { turns: [[{ do: 'write', path: 'big.txt', content }]] });
    const reader = record(session);
    await reader.waitFor(turnEnded);
    expect(readFileSync(join(clone, 'big.txt'), 'utf8')).toHaveLength(content.length);
  });

  test('a resumed session keeps its sessionRef and waits for a message instead of the first prompt', async () => {
    const { launch } = await setup({ resume: { sessionRef: 'session-7' } });
    const session = await start(launch, { turns: [[{ do: 'text', text: 'resumed' }]] });
    expect(session.sessionRef).toBe('session-7');
    const reader = record(session);
    await reader.waitFor((event) => event.type === 'started');
    await Bun.sleep(100);
    expect(reader.types()).toEqual(['started']);
    await session.send({ id: 'm1', text: 'go on', authority: 'system' });
    await reader.waitFor((event) => event.type === 'acknowledged');
    expect(reader.types()).toEqual([
      'started',
      'delivered m1',
      'turn_started',
      'text',
      'turn_ended',
      'acknowledged m1',
    ]);
  });
});

describe('the fake agent script', () => {
  test('writes files, commits with the launch identity, runs a tool in its own group and emits text', async () => {
    const { launch, clone } = await setup();
    const out = join(tempDir('agflow-fake-out-'), 'tool');
    const session = await start(launch, {
      turns: [
        [
          { do: 'write', path: 'src/a.ts', content: 'export const a = 1;\n' },
          { do: 'write', path: 'README.md', content: null },
          { do: 'commit', message: 'add a' },
          { do: 'tool', command: `echo "$$ $(ps -o pgid= -p $$)" > '${out}'` },
          { do: 'text', text: 'all done' },
        ],
      ],
    });
    const reader = record(session);
    const ended = await reader.waitFor(turnEnded);
    expect(ended).toEqual({ type: 'turn_ended', outcome: 'completed', toolCalls: 4, error: null, errorKind: null });
    expect(reader.types()).toEqual([
      'started',
      'turn_started',
      ...Array.from({ length: 4 }, () => ['tool_started', 'tool_ended']).flat(),
      'text',
      'turn_ended',
    ]);
    const tools = reader.events.filter((event) => event.type === 'tool_started');
    expect(tools.map((event) => event.type === 'tool_started' && [event.name, event.command])).toEqual([
      ['Write', null],
      ['Write', null],
      ['Bash', "git add -A && git commit -q -m 'add a'"],
      ['Bash', `echo "$$ $(ps -o pgid= -p $$)" > '${out}'`],
    ]);
    const results = reader.events.flatMap((event) => (event.type === 'tool_ended' ? [event.ok] : []));
    expect(results).toEqual([true, true, true, true]);
    expect(reader.events.find((event) => event.type === 'text')).toEqual({ type: 'text', text: 'all done' });
    expect(await gitIn(clone, ['log', '-1', '--format=%an <%ae>|%cn <%ce>|%s'])).toBe(
      'Agent Smith <agent@agflow.invalid>|Agent Smith <agent@agflow.invalid>|add a',
    );
    expect(await gitIn(clone, ['ls-tree', '-r', '--name-only', 'HEAD'])).toBe('src/a.ts');
    expect(await gitIn(clone, ['status', '--porcelain'])).toBe('');
    const [pid, pgid] = (await waitFile(out)).split(/\s+/).map(Number);
    expect(pgid).toBe(pid as number);
    expect(pgid).not.toBe(session.pid);
  });

  test('terminal tools report terminal on success only, and a hub-unreachable answer sets hubUnreachable', async () => {
    const { launch } = await setup();
    const session = await start(launch, {
      turns: [
        [
          { do: 'terminal', tool: 'submit' },
          { do: 'terminal', tool: 'blocked' },
          { do: 'terminal', tool: 'impossible' },
          { do: 'terminal', tool: 'released' },
          { do: 'terminal', tool: 'handoff' },
          { do: 'terminal', tool: 'submit', answer: 'refused' },
          { do: 'terminal', tool: 'submit', answer: 'hub_unreachable' },
        ],
      ],
    });
    const reader = record(session);
    await reader.waitFor(turnEnded);
    const names = reader.events.flatMap((event) => (event.type === 'tool_started' ? [event.name] : []));
    expect(names).toEqual([
      'mcp__agflow__submit',
      'mcp__agflow__declare_blocked',
      'mcp__agflow__declare_impossible',
      'mcp__agflow__release_task',
      'mcp__agflow__write_handoff',
      'mcp__agflow__submit',
      'mcp__agflow__submit',
    ]);
    const ended = reader.events.flatMap((event) =>
      event.type === 'tool_ended' ? [[event.ok, event.terminal, event.hubUnreachable, event.denied]] : [],
    );
    expect(ended).toEqual([
      [true, 'submit', false, false],
      [true, 'blocked', false, false],
      [true, 'impossible', false, false],
      [true, 'released', false, false],
      [true, 'handoff', false, false],
      [false, null, false, false],
      [false, null, true, false],
    ]);
  });

  test('a scripted tool child in its own group keeps running after the agent exits', async () => {
    const { launch } = await setup();
    const out = join(tempDir('agflow-fake-out-'), 'pid');
    const session = await start(launch, {
      turns: [[{ do: 'tool', command: `echo $$ > '${out}'; exec sleep 30`, wait: false }, { do: 'exit', code: 3 }]],
    });
    const reader = record(session);
    expect(await session.exited).toEqual({ code: 3, signal: null });
    const pid = Number(await waitFile(out));
    killLater(pid);
    const tool = await processIdentity(pid);
    expect(tool?.pgid).toBe(pid);
    expect(countOf(reader.events, 'turn_ended')).toBe(0);
  });
});

describe('FakeAdapter sessions', () => {
  test('send() emits delivered when the input is taken and acknowledged when its turn ends', async () => {
    const { launch } = await setup();
    const session = await start(launch, {
      turns: [[{ do: 'sleep', ms: 300 }, { do: 'text', text: 'first' }], [{ do: 'text', text: 'second' }]],
    });
    const reader = record(session);
    await reader.waitFor((event) => event.type === 'turn_started');
    // Taken mid-turn at the next step, as Claude folds a message into the running turn.
    await session.send({ id: 'm1', text: 'also this', authority: 'person' });
    await reader.waitFor(turnEnded);
    await reader.waitFor((event) => event.type === 'acknowledged');
    await session.send({ id: 'm2', text: 'next', authority: 'agent' });
    await reader.waitFor((event) => event.type === 'acknowledged' && event.id === 'm2');
    expect(reader.types()).toEqual([
      'started',
      'turn_started',
      'delivered m1',
      'text',
      'turn_ended',
      'acknowledged m1',
      'delivered m2',
      'turn_started',
      'text',
      'turn_ended',
      'acknowledged m2',
    ]);
  });

  test('interrupt() ends the turn as interrupted; queued messages run next unless cancelled', async () => {
    const { launch } = await setup();
    const session = await start(launch, {
      turns: [[{ do: 'sleep', ms: 30_000 }], [{ do: 'text', text: 'after' }], [{ do: 'sleep', ms: 30_000 }]],
    });
    const reader = record(session);
    await reader.waitFor((event) => event.type === 'turn_started');
    await session.send({ id: 'm1', text: 'queued', authority: 'person' });
    await Bun.sleep(50);
    await session.interrupt();
    await reader.waitFor((event) => event.type === 'acknowledged' && event.id === 'm1');
    await session.send({ id: 'm2', text: 'long one', authority: 'person' });
    await reader.waitFor((event) => event.type === 'delivered' && event.id === 'm2');
    await session.send({ id: 'm3', text: 'dropped', authority: 'person' });
    await Bun.sleep(50);
    await session.interrupt({ cancelQueued: true });
    await reader.waitFor((event) => event.type === 'acknowledged' && event.id === 'm2');
    await Bun.sleep(200);
    expect(reader.types()).toEqual([
      'started',
      'turn_started',
      'turn_ended',
      'delivered m1',
      'turn_started',
      'text',
      'turn_ended',
      'acknowledged m1',
      'delivered m2',
      'turn_started',
      'turn_ended',
      'acknowledged m2',
    ]);
    const outcomes = reader.events.flatMap((event) => (event.type === 'turn_ended' ? [event.outcome] : []));
    expect(outcomes).toEqual(['interrupted', 'completed', 'interrupted']);
  });

  test('interrupt() during a tool that waits ends the turn and fails the tool', async () => {
    const { launch } = await setup();
    const out = join(tempDir('agflow-fake-out-'), 'pid');
    const session = await start(launch, {
      turns: [[{ do: 'tool', command: `echo $$ > '${out}'; exec sleep 30` }, { do: 'text', text: 'never' }]],
    });
    const reader = record(session);
    killLater(Number(await waitFile(out)));
    await session.interrupt();
    expect(await reader.waitFor(turnEnded)).toEqual({
      type: 'turn_ended',
      outcome: 'interrupted',
      toolCalls: 1,
      error: null,
      errorKind: null,
    });
    expect(reader.events.find((event) => event.type === 'tool_ended')).toMatchObject({ ok: false, terminal: null });
    expect(countOf(reader.events, 'text')).toBe(0);
  });

  test('a script that ignores interrupts and EOF mid-turn keeps running after interrupt() and close()', async () => {
    const { launch } = await setup();
    const session = await start(launch, {
      ignoreInterrupt: true,
      ignoreEofMidTurn: true,
      turns: [[{ do: 'sleep', ms: 30_000 }]],
    });
    const reader = record(session);
    await reader.waitFor((event) => event.type === 'turn_started');
    await session.interrupt({ cancelQueued: true });
    await session.close();
    await Bun.sleep(300);
    expect(await processIdentity(session.pid)).not.toBeNull();
    expect(countOf(reader.events, 'turn_ended')).toBe(0);
  });

  test('SIGTERM ends the agent with exit code 143, unless the script ignores it', async () => {
    const { launch } = await setup();
    const plain = await start(launch, { turns: [[{ do: 'sleep', ms: 30_000 }]] });
    await record(plain).waitFor((event) => event.type === 'turn_started');
    process.kill(-plain.pid, 'SIGTERM');
    expect(await plain.exited).toEqual({ code: 143, signal: null });

    const stubborn = await start(launch, { ignoreSigterm: true, turns: [[{ do: 'sleep', ms: 30_000 }]] });
    await record(stubborn).waitFor((event) => event.type === 'turn_started');
    process.kill(-stubborn.pid, 'SIGTERM');
    await Bun.sleep(300);
    expect(await processIdentity(stubborn.pid)).not.toBeNull();
    process.kill(-stubborn.pid, 'SIGKILL');
    expect(await stubborn.exited).toEqual({ code: null, signal: 'SIGKILL' });
  });

  test("a tool child that inherits the agent's pipes keeps its events open after it exits", async () => {
    const { launch } = await setup();
    const out = join(tempDir('agflow-fake-out-'), 'pid');
    const session = await start(launch, {
      turns: [
        [
          { do: 'tool', command: `echo $$ > '${out}'; exec sleep 30`, wait: false, inheritPipes: true },
          { do: 'exit', code: 0 },
        ],
      ],
    });
    let ended = false;
    void (async () => {
      for await (const _event of session.events);
      ended = true;
    })();
    expect(await session.exited).toEqual({ code: 0, signal: null });
    const pid = Number(await waitFile(out));
    killLater(pid);
    await Bun.sleep(200);
    expect(ended).toBe(false);
    process.kill(-pid, 'SIGKILL');
    const deadline = Date.now() + 5_000;
    while (!ended && Date.now() < deadline) await Bun.sleep(10);
    expect(ended).toBe(true);
  });

  test('close() ends an idle agent and an agent mid-turn', async () => {
    const { launch } = await setup();
    const idle = await start(launch, { turns: [] });
    const idleReader = record(idle);
    await idleReader.waitFor(turnEnded);
    await idle.close();
    expect(await idle.exited).toEqual({ code: 0, signal: null });

    const busy = await start(launch, { turns: [[{ do: 'sleep', ms: 30_000 }]] });
    const busyReader = record(busy);
    await busyReader.waitFor((event) => event.type === 'turn_started');
    await busy.close();
    expect(await busy.exited).toEqual({ code: 0, signal: null });
    expect(countOf(busyReader.events, 'turn_ended')).toBe(0);
  });

  test('a script that ignores EOF mid-turn finishes the turn before it exits, as Claude does', async () => {
    const { launch } = await setup();
    const session = await start(launch, {
      ignoreEofMidTurn: true,
      turns: [[{ do: 'sleep', ms: 300 }, { do: 'text', text: 'finished anyway' }]],
    });
    const reader = record(session);
    await reader.waitFor((event) => event.type === 'turn_started');
    await session.close();
    expect(await session.exited).toEqual({ code: 0, signal: null });
    expect(reader.types().slice(-2)).toEqual(['text', 'turn_ended']);
  });

  test('a signalled agent reports its signal; its stderr goes to the attempt log', async () => {
    const { launch } = await setup();
    const session = await start(launch, { turns: [[{ do: 'log', text: 'to stderr' }, { do: 'sleep', ms: 30_000 }]] });
    const reader = record(session);
    await reader.waitFor((event) => event.type === 'turn_started');
    await Bun.sleep(100);
    process.kill(-session.pid, 'SIGKILL');
    expect(await session.exited).toEqual({ code: null, signal: 'SIGKILL' });
    expect(readFileSync(launch.logFile, 'utf8')).toContain('to stderr');
  });
});

describe('FakeAdapter.preflight', () => {
  test('reports what the fake is told, with an empty weakened list', async () => {
    const quota = {
      state: 'ok' as const,
      resetsAt: null,
      windows: { fiveHour: 0.2, weekly: null },
      paidUsage: 'disabled' as const,
      updatedAt: 1,
    };
    const adapter = new FakeAdapter({
      vendor: 'codex',
      cliVersion: '0.159.2',
      facts: { ready: false, problem: 'not logged in', ownerCliVersion: '0.150.0' },
      quota,
      script: { turns: [] },
    });
    expect(adapter.vendor).toBe('codex');
    expect(await adapter.preflight()).toEqual({
      facts: {
        vendor: 'codex',
        cliVersion: '0.159.2',
        ownerCliVersion: '0.150.0',
        ready: false,
        problem: 'not logged in',
        accountId: null,
        plan: null,
        managedPolicy: false,
      },
      quota,
      weakened: [],
    });
  });

  test('with skipAuthChecks it reports ready, problem and plan test mode, and TEST_ACCOUNT_ID', async () => {
    const adapter = new FakeAdapter({ skipAuthChecks: true, facts: { ready: false }, script: { turns: [] } });
    const result = await adapter.preflight();
    expect(result.facts).toMatchObject({
      vendor: 'claude',
      ready: true,
      problem: 'test mode',
      plan: 'test mode',
      accountId: TEST_ACCOUNT_ID,
    });
    expect(result.weakened).toEqual([]);
  });

  test('started reports the scripted permission mode, null included', async () => {
    const { launch } = await setup();
    const adapter = new FakeAdapter({ vendor: 'codex', script: { turns: [], permissionMode: null } });
    const session = await adapter.start(launch);
    killLater(session.pid);
    const reader = record(session);
    expect(await reader.waitFor((event) => event.type === 'started')).toMatchObject({ permissionMode: null });
  });

  test('the basic fake keeps no transcript and raises no approvals', async () => {
    const adapter = new FakeAdapter({ script: { turns: [] } });
    expect(await adapter.readTranscriptTail({ sessionRef: 's', clone: '/tmp', maxChars: 100 })).toBeNull();
    await adapter.deleteTranscript({ sessionRef: 's', clone: '/tmp' });
    const { launch } = await setup();
    const session = await start(launch, { turns: [] });
    expect(await session.answerApproval('A-1', 'approve', null)).toBe(false);
  });
});

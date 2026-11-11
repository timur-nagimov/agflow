// The real claude's start (design 15, 15.1, 8.1, 8.2, 10), gated by AGFLOW_SMOKE=1 (X-20): the session the adapter
// starts is the one its options ask for, the hub's runner brief reaches the model through the brief hook, the bridge
// acts as the runner agent, neither loads a bunfig.toml or .env from the repository, preflight in test mode uses no
// model, and nothing leaves for another host.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TEST_ACCOUNT_ID } from '@agflow/core';
import { resolveAgentToken } from '@agflow/hub/src/auth';
import { updateGoal } from '@agflow/hub/src/goal';
import { afterToolResult, agflowTool, bashTool, briefHas, reply, rules, userSays } from '@agflow/testkit/src/anthropic';
import { CLAUDE_BUILTIN_PLUGINS } from '../../src/adapters/claude/checks';
import { CLAUDE_BUILTIN_TOOLS, claudeEmptyDir } from '../../src/adapters/claude/options';
import { CLAUDE_CLI_VERSION, claudePin } from '../../src/adapters/claude/pin';
import { vendorPlatform } from '../../src/vendor/pins';
import {
  cleanupClaudeSmokes,
  claudeSmokeGate,
  SMOKE_AGFLOW,
  SMOKE_MODEL,
  smokeDescribe,
  startClaudeSmoke,
} from './harness';

// A cold start of the CLI, its sandbox, the bridge and the brief hook, on a machine other suites may load.
setDefaultTimeout(180_000);

afterEach(cleanupClaudeSmokes);

/** Removed after each test, after its harness. */
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const gate = claudeSmokeGate();

const PROMPT = 'Start working on the task.';

describe('claudeSmokeGate', () => {
  test('without AGFLOW_SMOKE=1 the suite is skipped with the reason', () => {
    expect(claudeSmokeGate({ env: {} })).toEqual({ run: false, bin: null, reason: 'AGFLOW_SMOKE=1 not set' });
    const switches = ['AGFLOW_SMOKE', 'AGFLOW_SANDBOX_CHECKS'];
    const sandbox = claudeSmokeGate({ env: { AGFLOW_SMOKE: '1' }, switches });
    expect(sandbox.reason).toBe('AGFLOW_SANDBOX_CHECKS=1 not set');
  });

  test('without the pinned binary the suite is skipped with the reason', () => {
    const home = mkdtempSync(join(tmpdir(), 'agflow-gate-'));
    try {
      const missing = join(home, 'claude');
      const result = claudeSmokeGate({ env: { AGFLOW_SMOKE: '1', AGFLOW_CLAUDE_BIN: missing }, home });
      expect(result.run).toBe(false);
      if (claudePin(vendorPlatform()) === null) {
        expect(result.reason).toBe(`agflow pins no claude for ${vendorPlatform()}`);
      } else {
        expect(result.reason).toContain(`AGFLOW_CLAUDE_BIN ${missing} is missing`);
        expect(result.reason).toContain('bun run vendor:install');
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

smokeDescribe(gate, 'the real claude starts', () => {
  test('start gives started with the full model id and acceptEdits, and the first-turn checks pass', async () => {
    const smoke = await startClaudeSmoke({ handler: rules({ when: userSays(PROMPT), reply: reply('Ready.') }) });
    const session = await smoke.start({ prompt: PROMPT });
    expect(await session.next('started')).toEqual({
      type: 'started',
      sessionRef: session.session.sessionRef,
      model: SMOKE_MODEL,
      cliVersion: CLAUDE_CLI_VERSION,
      permissionMode: 'acceptEdits',
    });
    const first = await session.session.firstInit;
    expect(first?.problems).toEqual([]);
    const init = first?.init;
    if (!init) throw new Error('no system/init');
    // Only the built-ins asked for, plus the bridge's tools.
    const builtins = init.tools.filter((tool) => !tool.startsWith('mcp__'));
    expect(builtins.sort()).toEqual([...CLAUDE_BUILTIN_TOOLS].sort());
    const bridged = init.tools.filter((tool) => tool.startsWith('mcp__'));
    expect(bridged).toContain('mcp__agflow__get_goal');
    expect(bridged.every((tool) => tool.startsWith('mcp__agflow__'))).toBe(true);
    const servers = init.mcp_servers.map(({ name, status }) => ({ name, status }));
    expect(servers).toEqual([{ name: 'agflow', status: 'connected' }]);
    for (const plugin of init.plugins) {
      expect(CLAUDE_BUILTIN_PLUGINS).toContainEqual({ name: plugin.name, path: plugin.path });
    }
    expect(await session.next('turn_ended')).toMatchObject({ outcome: 'completed', error: null });
    // What the model is offered is the same set; 2.1.285 offers its Task tool to the model as Agent.
    const request = smoke.server.requests.find((candidate) => candidate.mainLoop);
    expect(request?.model).toBe(SMOKE_MODEL);
    const offered = init.tools.map((tool) => (tool === 'Task' ? 'Agent' : tool));
    expect(request?.tools.slice().sort()).toEqual(offered.sort());
    expect(smoke.isolationProblems()).toEqual([]);
  });

  test("the hub's runner brief reaches the model through the brief hook, with the working directory", async () => {
    const smoke = await startClaudeSmoke({ handler: rules({ when: userSays(PROMPT), reply: reply('Ready.') }) });
    const session = await smoke.start({ prompt: PROMPT });
    await session.next('turn_ended');
    const first = smoke.server.requests.find((request) => request.mainLoop);
    if (!first) throw new Error('no main-loop request');
    // The marker is in the task's title, which only the hub's brief carries; the clone's path only the hook adds.
    expect(briefHas(smoke.briefMarker)(first)).toBe(true);
    expect(briefHas(`You are agflow agent ${smoke.agent.id}`)(first)).toBe(true);
    expect(briefHas(`Your working directory: ${smoke.clone}`)(first)).toBe(true);
    expect(smoke.hubRequests).toContainEqual({
      method: 'GET',
      path: '/api/brief',
      bearer: smoke.token,
      agentHeader: null,
      status: 200,
    });
    expect(smoke.isolationProblems()).toEqual([]);
  });

  test("a bridge call succeeds without a denial, and the hub sees the runner agent's principal", async () => {
    const smoke = await startClaudeSmoke({
      handler: rules(
        { when: afterToolResult('toolu_goal_1'), reply: reply('I read the goal.') },
        { when: userSays(PROMPT), reply: reply(agflowTool({ tool: 'get_goal', id: 'toolu_goal_1' })) },
      ),
    });
    const goal = `Ship the smoke test ${smoke.briefMarker}`;
    updateGoal(smoke.hub.ctx, { text: goal, baseVersion: 0 }, 'user:alice');
    const session = await smoke.start({ prompt: PROMPT });
    expect(await session.next('turn_ended')).toMatchObject({ outcome: 'completed', error: null, errorKind: null });
    expect(await session.next('tool_ended', (event) => event.toolId === 'toolu_goal_1')).toMatchObject({
      ok: true,
      denied: false,
      terminal: null,
      hubUnreachable: false,
    });
    // The model got the hub's answer, not a denial.
    const answered = smoke.server.requests.find((request) => afterToolResult('toolu_goal_1')(request));
    expect(answered?.lastToolResult?.isError).toBe(false);
    expect(answered?.lastToolResult?.text).toContain(goal);
    // The bridge asked with the agent token alone, and the hub resolved it to the runner agent.
    const asked = smoke.hubRequests.filter((request) => request.path === '/api/goal');
    expect(asked).toEqual([{ method: 'GET', path: '/api/goal', bearer: smoke.token, agentHeader: null, status: 200 }]);
    const grant = resolveAgentToken(smoke.hub.ctx, smoke.token);
    expect(grant.agent.id).toBe(smoke.agent.id);
    expect(grant.agent.origin).toBe('runner');
    expect(grant.attempt.id).toBe(smoke.attempt.id);
    expect(smoke.isolationProblems()).toEqual([]);
  });

  test('a committed bunfig.toml and .env reach neither the bridge nor the brief hook, nor on a resume', async () => {
    // Both run outside the sandbox with the agent token, and Bun loads the bunfig.toml (its preload) and the .env of
    // its working directory: neither may start in the clone or the base checkout, which hold the repository's files.
    const probe = realpathSync(mkdtempSync(join(tmpdir(), 'agflow-planted-')));
    cleanups.push(() => rmSync(probe, { recursive: true, force: true }));
    const preloadRan = join(probe, 'preload-ran');
    const runs = join(probe, 'runs');
    // The test's own preload, outside every checkout, notes each agflow run: where it ran, its arguments, and the
    // planted variable if it reached the process.
    const instrument = join(probe, 'instrument.ts');
    const note = '{ cwd: process.cwd(), argv: process.argv.slice(2), planted: process.env.AGFLOW_PLANTED ?? null }';
    const append = `appendFileSync(${JSON.stringify(runs)}, JSON.stringify(${note}) + '\\n');`;
    writeFileSync(instrument, `import { appendFileSync } from 'node:fs';\n${append}\n`);
    const agflow = { command: SMOKE_AGFLOW.command, args: ['--preload', instrument, ...SMOKE_AGFLOW.args] };
    const AGAIN = 'Carry on with the task.';
    const smoke = await startClaudeSmoke({
      agflow,
      files: {
        'bunfig.toml': "preload = ['./probe-preload.ts']\n",
        'probe-preload.ts': `require('node:fs').appendFileSync(${JSON.stringify(preloadRan)}, 'ran\\n');\n`,
        '.env': 'AGFLOW_PLANTED=from-the-repository\n',
      },
      handler: rules(
        { when: userSays(AGAIN), reply: reply('Carrying on.') },
        { when: userSays(PROMPT), reply: reply('Ready.') },
      ),
    });
    for (const checkout of [smoke.clone, smoke.baseCheckout]) {
      expect(existsSync(join(checkout, 'bunfig.toml')) && existsSync(join(checkout, '.env'))).toBe(true);
    }
    const first = await smoke.start({ prompt: PROMPT });
    expect(await first.next('turn_ended')).toMatchObject({ outcome: 'completed' });
    await first.session.close();
    await first.ended;
    // A resume starts the bridge and runs the brief hook again.
    const resumed = await smoke.start({ resume: first.session.sessionRef });
    await resumed.session.send({ id: 'msg-again', text: AGAIN, authority: 'system' });
    expect(await resumed.next('turn_ended')).toMatchObject({ outcome: 'completed' });
    await resumed.session.close();
    await resumed.ended;

    const seen = readFileSync(runs, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as { cwd: string; argv: string[]; planted: string | null });
    const bridges = seen.filter((run) => run.argv.join(' ') === 'mcp --vendor claude --runner');
    const hooks = seen.filter((run) => run.argv.join(' ') === 'hook brief --runner');
    expect([bridges.length, hooks.length, seen.length]).toEqual([2, 2, 4]);
    // Both start in the Claude home's empty directory, nowhere near a checkout.
    const checkouts = [smoke.clone, smoke.baseCheckout];
    for (const run of seen) {
      expect(run.planted).toBeNull();
      expect(checkouts.some((checkout) => `${run.cwd}/`.startsWith(`${checkout}/`))).toBe(false);
      expect(run.cwd).toBe(claudeEmptyDir(smoke.claudeHome));
    }
    expect(existsSync(preloadRan)).toBe(false);
    expect(smoke.hubRequests.filter((hub) => hub.path === '/api/brief' && hub.status === 200)).toHaveLength(2);

    // Even run in the clone, selfCommand()'s two Bun flags load neither.
    const inClone = (args: string[]) => {
      const run = Bun.spawnSync([agflow.command, ...args, '--version'], {
        cwd: smoke.clone,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: smoke.home },
      });
      expect(run.exitCode).toBe(0);
      return JSON.parse(readFileSync(runs, 'utf8').trim().split('\n').at(-1) ?? '{}');
    };
    expect(inClone(agflow.args)).toEqual({ cwd: smoke.clone, argv: ['--version'], planted: null });
    expect(existsSync(preloadRan)).toBe(false);
    // The plant works: plain `bun main.ts` run in the clone loads both.
    const plain = agflow.args.filter((arg) => arg !== '--no-env-file' && arg !== '--config=/dev/null');
    expect(plain).toHaveLength(agflow.args.length - 2);
    expect(inClone(plain)).toEqual({ cwd: smoke.clone, argv: ['--version'], planted: 'from-the-repository' });
    expect(existsSync(preloadRan)).toBe(true);
    expect(smoke.isolationProblems()).toEqual([]);
  });

  test("preflight in test mode reports ready with 'test mode' and TEST_ACCOUNT_ID, and uses no model", async () => {
    const smoke = await startClaudeSmoke();
    const result = await smoke.adapter.preflight();
    expect(result.facts).toMatchObject({
      vendor: 'claude',
      cliVersion: CLAUDE_CLI_VERSION,
      ready: true,
      problem: 'test mode',
      plan: 'test mode',
      accountId: TEST_ACCOUNT_ID,
      managedPolicy: false,
    });
    expect(result.weakened).toEqual([]);
    expect(smoke.server.requests).toEqual([]);
    expect(smoke.hubRequests).toEqual([]);
    expect(smoke.isolationProblems()).toEqual([]);
  });

  test('the proxy refused nothing: the scripted server and the hub were the only hosts contacted', async () => {
    const smoke = await startClaudeSmoke();
    const note = { task_id: smoke.task.id, note: 'Looked around.' };
    smoke.server.setHandler(
      rules(
        { when: afterToolResult('toolu_hosts_2'), reply: reply('Done.') },
        {
          when: afterToolResult('toolu_hosts_1'),
          reply: reply(agflowTool({ tool: 'report_progress', args: note, id: 'toolu_hosts_2' })),
        },
        { when: userSays(PROMPT), reply: reply(bashTool({ command: 'git status --short', id: 'toolu_hosts_1' })) },
      ),
    );
    const session = await smoke.start({ prompt: PROMPT });
    expect(await session.next('turn_ended')).toMatchObject({ outcome: 'completed' });
    for (const toolId of ['toolu_hosts_1', 'toolu_hosts_2']) {
      expect(await session.next('tool_ended', (event) => event.toolId === toolId)).toMatchObject({ ok: true });
    }
    await session.session.close();
    await session.ended;
    expect(smoke.server.requests.length).toBeGreaterThan(0);
    expect(smoke.hubRequests.map((request) => request.path)).toEqual(
      expect.arrayContaining(['/api/brief', `/api/tasks/${smoke.task.id}/progress`]),
    );
    expect(smoke.proxy.refused).toEqual([]);
    expect(smoke.isolationProblems()).toEqual([]);
  });
});

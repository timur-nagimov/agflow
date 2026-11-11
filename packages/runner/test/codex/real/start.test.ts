// The real pinned app-server at start (design 15, 9.2, 10): the start checks, the tool surface the pinned slug offers,
// a Code Mode command and the real bridge, all against the scripted provider with zero model use.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { handoffWritten } from '@agflow/hub/src/handoff';
import { reply, rules, toolSurface } from '@agflow/testkit/src/codex/index';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODEX_VERSION } from '../../../src/adapters/codex';
import { codexToolsNote } from '../../../src/adapters/codex/config';
import { until } from '../session-fixture';
import {
  type CodexHarness,
  DEFAULT_ORIGIN_FILES,
  EventLog,
  REPO_SKILL_MARKER,
  smokeCodexBinary,
  startCodexHarness,
} from './harness';

setDefaultTimeout(120_000);

const bin = await smokeCodexBinary();
const fixture = JSON.parse(readFileSync(join(import.meta.dir, '..', 'fixtures', 'tool-surface.json'), 'utf8')) as {
  model: string;
  namespaces: { name: string; tools: string[] }[];
  described: string[];
  available: string[];
};
/** The agflow tools the worker's bridge serves, as the pinned slug offers them. */
const agflowTools = fixture.available.filter((name) => name.startsWith('mcp__agflow__'));

const dirs: string[] = [];
let h: CodexHarness | null = null;
afterEach(async () => {
  try {
    await h?.close();
  } finally {
    h = null;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  }
});

/** A directory outside every clone and the harness, removed after the test. */
function scratchDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

/** The text a Code Mode exec call returned to the model, after Codex's "Output:" header. */
function execText(output: string): string {
  return output.slice(output.indexOf('Output:\n') + 'Output:\n'.length).trim();
}

test('the local suites run only with AGFLOW_SMOKE=1 and a located pin', async () => {
  const dir = scratchDir('agflow-codex-smoke-gate-');
  const stub = join(dir, 'codex');
  writeFileSync(stub, `#!/bin/sh\necho "codex-cli ${CODEX_VERSION}"\n`, { mode: 0o755 });
  // An empty home: no runner vendor directory to fall back on.
  const home = join(dir, 'home');
  mkdirSync(home);
  expect(await smokeCodexBinary({ env: { AGFLOW_SMOKE: '1', AGFLOW_CODEX_BIN: stub }, home })).toBe(stub);
  expect(await smokeCodexBinary({ env: { AGFLOW_SMOKE: '0', AGFLOW_CODEX_BIN: stub }, home })).toBeNull();
  expect(await smokeCodexBinary({ env: { AGFLOW_CODEX_BIN: stub }, home })).toBeNull();
  expect(await smokeCodexBinary({ env: { AGFLOW_SMOKE: '1' }, home })).toBeNull();
});

describe.skipIf(bin === null)('the real app-server at start', () => {
  for (const projectConfigVerified of [true, false]) {
    test(`start and resume with a committed .codex/config.toml (${projectConfigVerified ? 'trusted' : 'untrusted'}) pass the checks without a configWarning`, async () => {
      h = await startCodexHarness(bin!);
      const a = await h.attempt({ projectConfigVerified });
      expect(existsSync(join(a.clone, '.codex', 'config.toml'))).toBe(true);
      // A configWarning, or an MCP server or skill the checks refuse, would make start() reject.
      const session = await a.start();
      const log = new EventLog(session.events);
      expect(await log.next('started')).toEqual({
        type: 'started',
        sessionRef: session.sessionRef,
        model: a.launch.model,
        cliVersion: a.launch.cliVersion,
        permissionMode: 'on-request',
      });
      await log.next('turn_ended');
      const untrusted = projectConfigVerified ? [] : [expect.stringContaining('the thread runs untrusted')];
      expect(log.of('warning').map((event) => event.text)).toEqual(untrusted);
      // Only a trusted thread reads the project's config (effort 'high'); an untrusted one keeps the default.
      const reasoning = { effort: projectConfigVerified ? 'high' : 'low' };
      expect(h.provider.requests[0]).toMatchObject({
        model: a.launch.model,
        threadId: session.sessionRef,
        body: { reasoning },
      });
      // The repo skill loads either way (design 9.2), and the skills check allowed it.
      expect(JSON.stringify(h.provider.requests[0]!.body.input)).toContain(REPO_SKILL_MARKER);
      // Developer instructions retain the brief and role tools across compaction and resume.
      expect(h.provider.requests[0]!.instructions).toContain(a.launch.brief);
      expect(h.provider.requests[0]!.instructions).toContain(codexToolsNote(a.launch.bridge.tools));
      expect(h.provider.requests[0]!.lastUserText).toBe(a.launch.firstPrompt);
      // web_search 'disabled' is checked only through the absence of a configWarning (design 15): start() rejects on
      // one, and the warnings above hold only the untrusted note.
      await session.close();

      const resumed = await a.start(session.sessionRef);
      const resumedLog = new EventLog(resumed.events);
      expect(resumed.sessionRef).toBe(session.sessionRef);
      expect(await resumedLog.next('started')).toMatchObject({ sessionRef: session.sessionRef });
      // A resume sends no prompt of its own. The resumed thread applies the same trust: its next request carries the
      // same effort.
      expect(h.provider.requests).toHaveLength(1);
      await resumed.send({ id: 'msg-1', text: 'Carry on.', authority: 'person' });
      await resumedLog.next('turn_ended');
      expect(h.provider.requests).toHaveLength(2);
      expect(h.provider.requests[1]).toMatchObject({ threadId: session.sessionRef, body: { reasoning } });
      expect(h.provider.requests[1]!.instructions).toContain(codexToolsNote(a.launch.bridge.tools));
      await resumed.close();
      await resumedLog.done;
      expect(resumedLog.of('warning').map((event) => event.text)).toEqual(untrusted);
    });
  }

  test('the tool surface of the pinned slug equals tool-surface.json', async () => {
    h = await startCodexHarness(bin!, {
      handler: rules([
        { toolOutputs: 0, reply: reply.code('text(JSON.stringify(ALL_TOOLS.map((tool) => tool.name)));') },
        { toolOutputs: 1, reply: reply.text('Listed the tools.') },
      ]),
    });
    const session = await (await h.attempt()).start();
    const log = new EventLog(session.events);
    await log.next('turn_ended');
    const [first, second] = h.provider.requests;
    const surface = toolSurface(first!);
    const recorded = {
      model: first!.model,
      namespaces: surface?.namespaces,
      described: surface?.nested,
      available: JSON.parse(execText(second!.toolOutputs[0]!.output)),
    };
    expect(recorded).toEqual(fixture);
    // Code Mode: one freeform exec, and the shell, patch and agflow tools nested inside it. The agflow tools are
    // deferred: not described in exec's text, but on the tools object and in ALL_TOOLS.
    expect(fixture.namespaces[0]?.tools).toContain('exec');
    expect(fixture.available).toEqual(expect.arrayContaining(['exec_command', 'write_stdin', 'apply_patch']));
    expect(agflowTools).toEqual(
      [
        'ack_messages',
        'check_inbox',
        'declare_blocked',
        'declare_impossible',
        'get_brief',
        'get_goal',
        'get_task',
        'hello',
        'list_tasks',
        'prepare_dependencies',
        'release_task',
        'report_progress',
        'search',
        'send_message',
        'submit',
        'write_handoff',
      ].map((name) => `mcp__agflow__${name}`),
    );
    // The persistent tools note names exactly the available bridge tools, with the MCP prefix.
    const lines = (first!.instructions ?? '').split('\n');
    const note = lines.find((line) => line.startsWith('Your agflow tools are ')) ?? '';
    const named = note.slice('Your agflow tools are '.length, note.indexOf('. Code Mode does not describe them'));
    expect(named.split(', ').sort()).toEqual(agflowTools);
  });

  test('a Code Mode command turn reports the inner command, then a completed turn', async () => {
    h = await startCodexHarness(bin!, {
      handler: rules([
        { toolOutputs: 0, reply: reply.shell({ cmd: 'echo made > made.txt && cat made.txt' }) },
        { toolOutputs: 1, reply: reply.text('The command ran.') },
      ]),
    });
    const a = await h.attempt();
    const session = await a.start();
    const log = new EventLog(session.events);
    const ended = await log.next('turn_ended');
    const started = log.of('tool_started');
    expect(started).toEqual([
      {
        type: 'tool_started',
        toolId: expect.any(String),
        name: 'exec_command',
        input: 'echo made > made.txt && cat made.txt',
        command: 'echo made > made.txt && cat made.txt',
      },
    ]);
    expect(log.of('tool_ended')).toEqual([
      {
        type: 'tool_ended',
        toolId: started[0]!.toolId,
        ok: true,
        denied: false,
        terminal: null,
        hubUnreachable: false,
      },
    ]);
    expect(ended).toEqual({
      type: 'turn_ended',
      outcome: 'completed',
      toolCalls: 1,
      error: null,
      errorKind: null,
    });
    expect(readFileSync(join(a.clone, 'made.txt'), 'utf8')).toBe('made\n');
    expect(execText(h.provider.requests[1]!.toolOutputs[0]!.output)).toContain('made');
  });

  test('the bridge: hello needs no hub call, write_handoff reaches the hub, and neither asks for approval', async () => {
    h = await startCodexHarness(bin!);
    const a = await h.attempt();
    const taskId = a.attempt.taskId!;
    h.provider.setHandler(
      rules([
        { toolOutputs: 0, reply: reply.mcp({ tool: 'hello', args: {} }) },
        // Held, so the hub's requests can be read between the two calls.
        {
          toolOutputs: 1,
          reply: reply.hang(reply.mcp({ tool: 'write_handoff', args: { task_id: taskId, note: 'Halfway.' } })),
        },
        { toolOutputs: 2, reply: reply.text('Handed off.') },
      ]),
    );
    const session = await a.start();
    const log = new EventLog(session.events);
    const helloEnded = await log.next('tool_ended');
    await until(() => h!.provider.requests.length === 2);
    expect(execText(h.provider.requests[1]!.toolOutputs[0]!.output)).toContain(
      `You are already connected to agflow as attempt ${a.attempt.id}`,
    );
    // The bridge calls the hub neither at startup nor for hello.
    expect(h.hubRequests).toEqual([]);
    expect(h.provider.release()).toBe(1);
    const ended = await log.next('turn_ended');
    expect(ended).toMatchObject({ outcome: 'completed', toolCalls: 2 });
    expect(log.of('tool_started').map((event) => [event.name, event.command])).toEqual([
      ['mcp__agflow__hello', null],
      ['mcp__agflow__write_handoff', null],
    ]);
    expect(helloEnded).toMatchObject({ ok: true, terminal: null, hubUnreachable: false });
    expect(log.of('tool_ended')[1]).toMatchObject({ ok: true, denied: false, terminal: 'handoff' });
    expect(h.hubRequests).toEqual([`POST /api/tasks/${taskId}/handoff`]);
    expect(handoffWritten(h.hub.ctx, a.attempt)).toBe(true);
    expect(log.of('approval_request')).toEqual([]);
    expect(log.of('waiting_approval')).toEqual([]);
  });

  for (const projectConfigVerified of [true, false]) {
    test(`a committed bunfig.toml preload and .env never reach the bridge (${projectConfigVerified ? 'trusted' : 'untrusted'})`, async () => {
      // The bridge runs outside the sandbox with the agent token, and Bun loads both from its working directory: it
      // must not start in the clone.
      const marker = join(scratchDir('agflow-planted-bunfig-'), 'preload-ran');
      h = await startCodexHarness(bin!, {
        files: {
          ...DEFAULT_ORIGIN_FILES,
          'bunfig.toml': 'preload = ["./planted.ts"]\n',
          'planted.ts': `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(marker)}, 'ran\\n');\n`,
          '.env': 'AGFLOW_PLANTED_ENV=from-clone\n',
        },
        handler: rules([
          { toolOutputs: 0, reply: reply.mcp({ tool: 'hello', args: {} }) },
          { toolOutputs: 1, reply: reply.text('Said hello.') },
        ]),
      });
      const a = await h.attempt({ projectConfigVerified });
      expect(existsSync(join(a.clone, 'bunfig.toml'))).toBe(true);
      const session = await a.start();
      const log = new EventLog(session.events);
      expect(await log.next('turn_ended')).toMatchObject({ outcome: 'completed', toolCalls: 1 });
      expect(execText(h.provider.requests[1]!.toolOutputs[0]!.output)).toContain(
        `You are already connected to agflow as attempt ${a.attempt.id}`,
      );
      await session.close();
      await log.done;
      // A resume starts the bridge again.
      const resumed = await a.start(session.sessionRef);
      const resumedLog = new EventLog(resumed.events);
      await resumedLog.next('started');
      await resumed.close();
      await resumedLog.done;
      expect(existsSync(marker)).toBe(false);
    });
  }

  test('a bridge started without AGFLOW_ROLE makes thread/start fail and start() reject', async () => {
    h = await startCodexHarness(bin!);
    // Only the bridge's own variables reach it (env_vars): the app-server's AGFLOW_ROLE does not.
    const a = await h.attempt({ bridgeEnv: ({ AGFLOW_ROLE: _role, ...env }) => env });
    expect(a.launch.env.AGFLOW_ROLE).toBe('worker');
    const error = await a.start().then(
      () => null,
      (error: unknown) => error as Error,
    );
    expect(error?.message).toMatch(/^codex thread\/start failed: .*required MCP servers failed/);
    expect(a.registered).toHaveLength(1);
    expect(h.provider.requests).toEqual([]);
  });

  test('the refusing proxy granted no connection: no request left the machine', async () => {
    h = await startCodexHarness(bin!, {
      handler: rules([
        { toolOutputs: 0, reply: reply.shell({ cmd: 'printenv HTTPS_PROXY; git status --short' }) },
        { toolOutputs: 1, reply: reply.mcp({ tool: 'get_brief', args: {} }) },
        { toolOutputs: 2, reply: reply.text('Done.') },
      ]),
    });
    const session = await (await h.attempt()).start();
    const log = new EventLog(session.events);
    await log.next('turn_ended');
    await session.close();
    await log.done;
    // The proxy settings reached tool commands, and the bridge reached the loopback hub past the proxy.
    expect(execText(h.provider.requests[1]!.toolOutputs[0]!.output)).toContain(h.proxy.url);
    expect(h.hubRequests).toEqual(['GET /api/brief']);
    // Every external connection would have met the proxy, which refuses and records it: none was even tried.
    expect(h.proxy.refused).toEqual([]);
    expect(h.provider.requests.map((request) => request.unmatched)).toEqual([false, false, false]);
  });
});

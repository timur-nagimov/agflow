import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AnthropicRequest, parseAnthropicRequest } from '../src/anthropic/request';
import { parseResponsesRequest, type ResponsesRequest } from '../src/codex/request';
import {
  attemptIdIn,
  BASH_MAX_TIMEOUT_MS,
  CLOSING_TEXT,
  claudeReply,
  codexReply,
  GATE_DIR,
  gate,
  nextStep,
  PLAYBOOK_ERROR,
  type Program,
  react,
  say,
  shell,
  tool,
} from '../src/harness/playbook';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agflow-playbook-'));
  dirs.push(dir);
  return dir;
}

const HOME = '/private/tmp/agf-e2e/r2';
const clone = (attempt: string) => `${HOME}/work/demo/${attempt}`;
const TOOLS = ['Bash', 'Read', 'mcp__agflow__submit'].map((name) => ({ name, description: name, input_schema: {} }));

/** A brief as the runner builds it: the hub's text, then its own "Your working directory" line (X-17). */
function brief(attempt: string, note = ''): string {
  return `You are a worker on T-7.\n${note}\n\nYour working directory: ${clone(attempt)}`;
}

/**
 * The role 'system' entry Claude Code 2.1.285 sends near the start of the messages: the SessionStart hook's brief,
 * then its own environment section, which names the clone's resolved path.
 */
function claudeContext(attempt: string, note = ''): string {
  return [
    `SessionStart hook additional context: ${brief(attempt, note)}`,
    '',
    '# Environment',
    'You have been invoked in the following environment: ',
    ` - Primary working directory: ${clone(attempt)}`,
    ' - Is a git repository: true',
  ].join('\n');
}

function claudeRequest(body: Record<string, unknown>): AnthropicRequest {
  return parseAnthropicRequest({ model: 'claude-test', stream: true, tools: TOOLS, ...body }, {});
}

function codexRequest(input: unknown[]): ResponsesRequest {
  return parseResponsesRequest(
    { model: 'gpt-test', input },
    { index: 0, method: 'POST', path: '/v1/responses', headers: {} },
  );
}

const userText = (value: string) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text: value }] });
const developer = (value: string) => ({
  type: 'message',
  role: 'developer',
  content: [{ type: 'input_text', text: value }],
});
const environment = (cwd: string) => userText(`<environment_context>\n  <cwd>${cwd}</cwd>\n</environment_context>`);

describe('attemptIdIn', () => {
  test('reads the attempt from the hook context and environment entry Claude Code 2.1.285 sends', () => {
    const note = ['Handoff note from T-7-a1:', `> Your working directory: ${clone('T-7-a1')}`].join('\n');
    for (const attempt of ['T-7-a2', 'T-7-e2-a1', 'lead-a3']) {
      const request = claudeRequest({
        system: 'You are Claude Code.',
        messages: [
          { role: 'user', content: 'Start the task.' },
          { role: 'system', content: [{ type: 'text', text: claudeContext(attempt, note) }] },
        ],
      });
      expect(attemptIdIn(request)).toBe(attempt);
    }
    // A message delivered later that names another clone comes after the agent's own context, so it cannot win.
    const later = claudeRequest({
      system: 'You are Claude Code.',
      messages: [
        { role: 'user', content: 'Start the task.' },
        { role: 'system', content: [{ type: 'text', text: claudeContext('T-7-a2') }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'e2e-s0', name: 'Bash', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e2e-s0', content: 'ok' }] },
        { role: 'system', content: [{ type: 'text', text: `From lead:\nYour working directory: ${clone('T-7-a1')}` }] },
      ],
    });
    expect(attemptIdIn(later)).toBe('T-7-a2');
  });

  test('reads the attempt from a Claude system prompt or a brief in a user entry', () => {
    const fromSystem = claudeRequest({
      system: [
        { type: 'text', text: 'You are Claude Code.' },
        {
          type: 'text',
          text: `# Environment\n - Primary working directory: ${clone('T-7-a2')}\n - Is a git repository: true`,
        },
      ],
      messages: [{ role: 'user', content: 'Start the task.' }],
    });
    expect(attemptIdIn(fromSystem)).toBe('T-7-a2');
    const fromUser = claudeRequest({
      system: 'You are Claude Code.',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: `<system-reminder>\n${brief('T-7-e2-a1')}\n</system-reminder>` },
            { type: 'text', text: 'Start the task.' },
          ],
        },
      ],
    });
    expect(attemptIdIn(fromUser)).toBe('T-7-e2-a1');
  });

  test('reads the attempt from Codex developer instructions or environment context', () => {
    const fromInstructions = codexRequest([
      developer('Codex base prompt.'),
      developer(brief('T-7-a2')),
      userText('Start the task.'),
    ]);
    expect(attemptIdIn(fromInstructions)).toBe('T-7-a2');
    const fromEnvironment = codexRequest([developer('Codex base prompt.'), environment(clone('lead-a3'))]);
    expect(attemptIdIn(fromEnvironment)).toBe('lead-a3');
    const successor = codexRequest([developer('Codex base prompt.'), developer(brief('T-7-e2-a1'))]);
    expect(attemptIdIn(successor)).toBe('T-7-e2-a1');
  });

  test('ignores attempt ids elsewhere, such as in a quoted handoff note', () => {
    const note = [
      'Handoff note from T-7-a1:',
      `> I worked in ${clone('T-7-a1')} and committed a.txt.`,
      `> Your working directory: ${clone('T-7-a1')}`,
      `Your working directory: ${clone('T-7-a1')}`,
    ].join('\n');
    const claude = claudeRequest({
      system: 'You are Claude Code.',
      messages: [{ role: 'user', content: [{ type: 'text', text: brief('T-7-a2', note) }] }],
    });
    expect(attemptIdIn(claude)).toBe('T-7-a2');
    const codex = codexRequest([developer('Codex base prompt.'), developer(brief('T-7-a2', note))]);
    expect(attemptIdIn(codex)).toBe('T-7-a2');
    // A note alone names no working directory of this agent.
    const noteOnly = codexRequest([developer('Codex base prompt.'), userText(`See ${clone('T-7-a1')} for my work.`)]);
    expect(attemptIdIn(noteOnly)).toBeNull();
    const notAnAttempt = codexRequest([environment(`${HOME}/work/demo/notes`)]);
    expect(attemptIdIn(notAnAttempt)).toBeNull();
  });

  test('gives null for auxiliary requests', () => {
    const title = parseAnthropicRequest(
      {
        model: 'claude-test',
        system: `Primary working directory: ${clone('T-7-a2')}`,
        messages: [{ role: 'user', content: 'Write a title for this conversation.' }],
      },
      {},
    );
    expect(attemptIdIn(title)).toBeNull();
    const compaction = codexRequest([
      developer('Codex base prompt.'),
      developer(brief('T-7-a2')),
      userText('You are performing a CONTEXT CHECKPOINT COMPACTION. Summarise.'),
    ]);
    expect(attemptIdIn(compaction)).toBeNull();
  });
});

/** One turn of a conversation, written once for both vendors. */
type Turn =
  | { prompt: string }
  | { call: string }
  | { result: string; text?: string; isError?: boolean }
  | { inject: string }
  /** A message to an idle agent: a new prompt for Claude, a call-less agent_message output for Codex. */
  | { message: string };

/** The request a vendor sends after these turns: Claude folds mid-turn text in as a system entry. */
function conversation(vendor: 'claude' | 'codex', turns: Turn[]): AnthropicRequest | ResponsesRequest {
  if (vendor === 'claude') {
    const messages = turns.map((turn) => {
      if ('prompt' in turn) return { role: 'user', content: turn.prompt };
      if ('message' in turn) return { role: 'user', content: turn.message };
      if ('call' in turn) {
        return { role: 'assistant', content: [{ type: 'tool_use', id: turn.call, name: 'Bash', input: {} }] };
      }
      if ('result' in turn) {
        return {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: turn.result,
              content: turn.text ?? 'ok',
              is_error: turn.isError === true,
            },
          ],
        };
      }
      return { role: 'system', content: [{ type: 'text', text: turn.inject }] };
    });
    return claudeRequest({ system: `Primary working directory: ${clone('T-7-a1')}`, messages });
  }
  const input = turns.map((turn) => {
    if ('prompt' in turn || 'inject' in turn) return userText('prompt' in turn ? turn.prompt : turn.inject);
    if ('call' in turn) return { type: 'custom_tool_call', name: 'exec', call_id: turn.call, input: 'text(1)' };
    if ('message' in turn) {
      return { type: 'function_call_output', name: 'agent_message', namespace: 'agflow', output: turn.message };
    }
    return { type: 'custom_tool_call_output', call_id: turn.result, output: turn.text ?? 'ok' };
  });
  return codexRequest([developer('Codex base prompt.'), environment(clone('T-7-a1')), ...input]);
}

const PROGRAM: Program = {
  steps: [shell('echo zero'), shell('echo one'), tool('write_handoff', { note: 'two' }), shell('echo three')],
  reactions: [react('MSG-42', [shell('echo r0'), tool('send_message', { to: 'lead', text: 'r1' })])],
};

function stepOf(vendor: 'claude' | 'codex', turns: Turn[]): string {
  const next = nextStep(PROGRAM, conversation(vendor, turns));
  return next.kind === 'step' ? next.callId : next.kind;
}

/** Steps 0..n-1 called and answered. */
function ran(count: number, prefix = 'e2e-s'): Turn[] {
  return Array.from({ length: count }, (_, step) => [
    { call: `${prefix}${step}` },
    { result: `${prefix}${step}` },
  ]).flat();
}

for (const vendor of ['claude', 'codex'] as const) {
  describe(`nextStep (${vendor})`, () => {
    test('gives step 0 for a fresh conversation, then step n+1 after the result of step n', () => {
      const fresh = nextStep(PROGRAM, conversation(vendor, [{ prompt: 'Start the task.' }]));
      expect(fresh).toEqual({ kind: 'step', step: PROGRAM.steps[0] as never, callId: 'e2e-s0' });
      expect(stepOf(vendor, [{ prompt: 'Start.' }, ...ran(1)])).toBe('e2e-s1');
      expect(stepOf(vendor, [{ prompt: 'Start.' }, ...ran(3)])).toBe('e2e-s3');
    });

    test('moves on after an interrupted or aborted result', () => {
      const interrupted = [
        { prompt: 'Start.' },
        { call: 'e2e-s0' },
        { result: 'e2e-s0', text: '[Request interrupted by user for tool use]', isError: true },
      ];
      expect(stepOf(vendor, interrupted)).toBe('e2e-s1');
      const aborted: Turn[] = [
        { prompt: 'Start.' },
        ...ran(1),
        { call: 'e2e-s1' },
        { result: 'e2e-s1', text: 'aborted' },
      ];
      expect(stepOf(vendor, aborted)).toBe('e2e-s2');
    });

    test('gives the same step again for a retried request whose history is unchanged', () => {
      const turns: Turn[] = [{ prompt: 'Start.' }, ...ran(2)];
      expect(stepOf(vendor, turns)).toBe('e2e-s2');
      expect(stepOf(vendor, turns)).toBe('e2e-s2');
      // A call without a result yet (the request that carried it failed) is not a step that ran.
      expect(stepOf(vendor, [...turns, { call: 'e2e-s2' }])).toBe('e2e-s2');
    });

    test('continues a resumed conversation at the step after the last one that ran', () => {
      const resumed: Turn[] = [
        { prompt: 'Start.' },
        ...ran(3),
        { prompt: 'The runner restarted; continue from your last step.' },
      ];
      expect(stepOf(vendor, resumed)).toBe('e2e-s3');
    });

    test('runs a reaction once, the first time its marker is injected after the program started', () => {
      const injected: Turn[] = [
        { prompt: 'Start.' },
        ...ran(2),
        { inject: 'A message for you: MSG-42, please answer.' },
      ];
      expect(stepOf(vendor, injected)).toBe('e2e-r0-s0');
      const reacting = [...injected, ...ran(1, 'e2e-r0-s')];
      expect(stepOf(vendor, reacting)).toBe('e2e-r0-s1');
      const reacted = [...injected, ...ran(2, 'e2e-r0-s')];
      // The program continues where it was.
      expect(stepOf(vendor, reacted)).toBe('e2e-s2');
      // The marker again, later: the reaction does not run twice.
      const again: Turn[] = [...reacted, { call: 'e2e-s2' }, { result: 'e2e-s2' }, { inject: 'MSG-42 again' }];
      expect(stepOf(vendor, again)).toBe('e2e-s3');
    });

    test('runs a reaction to a message delivered to the idle agent, mid-program or after the last step', () => {
      const message = { message: 'from lead: MSG-42' };
      expect(stepOf(vendor, [{ prompt: 'Start.' }, ...ran(2), message])).toBe('e2e-r0-s0');
      expect(stepOf(vendor, [{ prompt: 'Start.' }, ...ran(4), message])).toBe('e2e-r0-s0');
      expect(stepOf(vendor, [{ prompt: 'Start.' }, ...ran(4), message, ...ran(2, 'e2e-r0-s')])).toBe('done');
      // A message that came before the program started is not one to react to.
      expect(stepOf(vendor, [message, { prompt: 'Start.' }])).toBe('e2e-s0');
      expect(stepOf(vendor, [message, { prompt: 'Start.' }, ...ran(1)])).toBe('e2e-s1');
    });

    test('ignores a marker that came before the program started', () => {
      expect(stepOf(vendor, [{ prompt: 'Start. MSG-42' }])).toBe('e2e-s0');
      expect(stepOf(vendor, [{ prompt: 'Start. MSG-42' }, ...ran(1)])).toBe('e2e-s1');
    });

    test('answers closing text after the last step, so a continuation prompt never restarts it', () => {
      const finished: Turn[] = [{ prompt: 'Start.' }, ...ran(4)];
      expect(nextStep(PROGRAM, conversation(vendor, finished))).toEqual({ kind: 'done' });
      const nudged: Turn[] = [...finished, { prompt: 'Continue with the task.' }];
      expect(nextStep(PROGRAM, conversation(vendor, nudged))).toEqual({ kind: 'done' });
      // A reaction triggered after the end still runs, then the program closes again.
      expect(stepOf(vendor, [...finished, { inject: 'MSG-42' }])).toBe('e2e-r0-s0');
      expect(stepOf(vendor, [...finished, { inject: 'MSG-42' }, ...ran(2, 'e2e-r0-s')])).toBe('done');
    });

    test("ignores tool calls that are not the program's own", () => {
      const foreign: Turn[] = [{ prompt: 'Start.' }, { call: 'toolu_other' }, { result: 'toolu_other' }];
      expect(stepOf(vendor, foreign)).toBe('e2e-s0');
    });
  });
}

describe('steps', () => {
  test("a step's optional text comes before its tool call in the same reply", () => {
    const step = say('Restating: a1 committed a.txt; I continue with b.txt.', shell('ls'));
    const claude = claudeReply({ kind: 'step', step, callId: 'e2e-s0' });
    expect(claude.kind === 'message' && claude.content.map((block) => block.type)).toEqual(['text', 'tool_use']);
    expect(claude.kind === 'message' && claude.content[0]).toEqual({
      type: 'text',
      text: 'Restating: a1 committed a.txt; I continue with b.txt.',
    });
    const codex = codexReply({ kind: 'step', step, callId: 'e2e-s0' });
    expect(codex.output.map((item) => item.type)).toEqual(['message', 'custom_tool_call']);
    expect(JSON.stringify(codex.output[0])).toContain('Restating: a1 committed a.txt');
  });

  test('gate(name) compiles to one command that waits for .agflow/run/e2e/<name>, relative to the clone', async () => {
    expect(GATE_DIR).toBe('.agflow/run/e2e');
    const step = gate('ready');
    expect(step).toMatchObject({ kind: 'shell', gate: 'ready', timeoutMs: BASH_MAX_TIMEOUT_MS });
    // One simple command with a literal script, which Claude Code can approve: no expansion, substitution or group.
    expect(step.cmd).toStartWith("perl -e '");
    expect(step.cmd).toEndWith("'");
    expect(step.cmd.slice("perl -e '".length, -1)).not.toContain("'");
    expect(step.cmd).toContain('-e ".agflow/run/e2e/ready"');
    const dir = tempDir();
    const proc = Bun.spawn(['sh', '-c', step.cmd], { cwd: dir, stdout: 'pipe', stderr: 'ignore' });
    await Bun.sleep(400);
    expect(proc.exitCode).toBeNull();
    mkdirSync(join(dir, GATE_DIR), { recursive: true });
    writeFileSync(join(dir, GATE_DIR, 'ready'), '');
    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stdout).text()).toBe('gate ready is open\n');
    for (const name of ['', '.', '..', 'a/b', "it's"]) expect(() => gate(name)).toThrow('not a gate name');
    expect(gate('later', { timeoutMs: 30_000 }).timeoutMs).toBe(30_000);
  });

  test('a gate nobody opens gives up on its own, 5 s before its step times out, with exit 124', async () => {
    expect(gate('ready').cmd).toContain('time + 595;');
    expect(gate('later', { timeoutMs: 30_000 }).cmd).toContain('time + 25;');
    const step = gate('never', { timeoutMs: 6_000 });
    expect(step.cmd).toContain('time + 1;');
    const started = Date.now();
    const proc = Bun.spawn(['sh', '-c', step.cmd], { cwd: tempDir(), stdout: 'pipe', stderr: 'ignore' });
    expect(await proc.exited).toBe(124);
    expect(Date.now() - started).toBeLessThan(step.timeoutMs);
    expect(await new Response(proc.stdout).text()).toBe('agflow gate never timed out\n');
  });

  test('shell timeouts are explicit and at most Bash maximum; tool names are identifiers', () => {
    expect(shell('ls').timeoutMs).toBe(120_000);
    expect(shell('ls', { timeoutMs: BASH_MAX_TIMEOUT_MS }).timeoutMs).toBe(600_000);
    for (const timeoutMs of [0, -1, 1.5, BASH_MAX_TIMEOUT_MS + 1]) {
      expect(() => shell('ls', { timeoutMs })).toThrow("a step's timeout must be");
    }
    expect(() => tool('mcp__agflow__submit()')).toThrow('not a tool name');
    expect(() => react('', [])).toThrow('a reaction needs a marker');
  });
});

describe('Claude replies', () => {
  test('a shell step is a Bash tool_use with an explicit timeout and the step call id', () => {
    const built = claudeReply({ kind: 'step', step: shell('sleep 30', { timeoutMs: 45_000 }), callId: 'e2e-s4' });
    expect(built).toMatchObject({ kind: 'message', stopReason: 'tool_use' });
    expect(built.kind === 'message' && built.content).toEqual([
      {
        type: 'tool_use',
        id: 'e2e-s4',
        name: 'Bash',
        input: { command: 'sleep 30', timeout: 45_000, description: 'Run e2e step e2e-s4' },
      },
    ]);
    const waiting = claudeReply({ kind: 'step', step: gate('go'), callId: 'e2e-r1-s0' });
    expect(waiting.kind === 'message' && waiting.content[0]).toMatchObject({
      id: 'e2e-r1-s0',
      input: { timeout: 600_000, description: 'Wait for gate go' },
    });
  });

  test('a tool step is mcp__agflow__<tool> with the step call id', () => {
    const built = claudeReply({ kind: 'step', step: tool('submit', { summary: 'done' }), callId: 'e2e-s2' });
    expect(built.kind === 'message' && built.content).toEqual([
      { type: 'tool_use', id: 'e2e-s2', name: 'mcp__agflow__submit', input: { summary: 'done' } },
    ]);
  });

  test('the end is closing text, and an error is a playbook error', () => {
    expect(claudeReply({ kind: 'done' })).toMatchObject({ stopReason: 'end_turn', content: [{ text: CLOSING_TEXT }] });
    const error = claudeReply({ kind: 'error', message: 'broken' });
    expect(error.kind === 'message' && error.content).toEqual([{ type: 'text', text: `${PLAYBOOK_ERROR}: broken` }]);
  });
});

describe('Codex replies', () => {
  /** Runs a Code Mode exec script with fake tools, as codex-code-mode-host would. */
  async function runScript(source: string, tools: Record<string, (args: any) => Promise<unknown>>): Promise<unknown[]> {
    const texts: unknown[] = [];
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    await new AsyncFunction('tools', 'text', source)(tools, (value: unknown) => texts.push(value));
    return texts;
  }

  test("a shell step is one exec cell that does not yield before the step's timeout", async () => {
    const step = gate('go', { timeoutMs: 90_000 });
    const built = codexReply({ kind: 'step', step, callId: 'e2e-s3' });
    expect(built.output).toHaveLength(1);
    const cell = built.output[0] as Record<string, any>;
    expect(cell).toMatchObject({ type: 'custom_tool_call', name: 'exec', call_id: 'e2e-s3' });
    const source = cell.input as string;
    const pragma = source.split('\n')[0] as string;
    expect(pragma.startsWith('// @exec: ')).toBe(true);
    expect(JSON.parse(pragma.slice('// @exec: '.length)).yield_time_ms).toBeGreaterThanOrEqual(90_000);
    // The cell waits for the command until the step's own deadline, polling past exec_command's yields.
    expect(source).toContain('Date.now() + 90000');
    const calls: [string, any][] = [];
    const texts = await runScript(source, {
      exec_command: async (args) => {
        calls.push(['exec_command', args]);
        return { session_id: 9, output: '', wall_time_seconds: 30 };
      },
      write_stdin: async (args) => {
        calls.push(['write_stdin', args]);
        return calls.length < 3
          ? { session_id: 9, output: '', wall_time_seconds: 30 }
          : { exit_code: 0, output: 'gate go is open\n', wall_time_seconds: 1 };
      },
    });
    // exec_command gets no timeout_ms: the pinned 0.159.2 declares none, and the cell's own deadline bounds the step.
    expect(calls[0]?.[1]).toEqual({ cmd: step.cmd, yield_time_ms: 30_000 });
    expect(calls.map(([name]) => name)).toEqual(['exec_command', 'write_stdin', 'write_stdin']);
    expect(texts).toEqual([{ exit_code: 0, output: 'gate go is open\n', wall_time_seconds: 1 }]);
  });

  test('a tool step calls the agflow tool through exec with the step call id', async () => {
    const built = codexReply({ kind: 'step', step: tool('write_handoff', { note: 'next: c.txt' }), callId: 'e2e-s1' });
    const cell = built.output[0] as Record<string, any>;
    expect(cell).toMatchObject({ type: 'custom_tool_call', name: 'exec', call_id: 'e2e-s1' });
    const seen: unknown[] = [];
    await runScript(cell.input, {
      mcp__agflow__write_handoff: async (args) => {
        seen.push(args);
        return { content: [{ type: 'text', text: 'saved' }] };
      },
    });
    expect(seen).toEqual([{ note: 'next: c.txt' }]);
  });

  test('a cell that says it is still running is a playbook error, not the step result', () => {
    const yielded = codexRequest([
      developer('Codex base prompt.'),
      environment(clone('T-7-a1')),
      userText('Start.'),
      { type: 'custom_tool_call', name: 'exec', call_id: 'e2e-s0', input: 'text(1)' },
      { type: 'custom_tool_call_output', call_id: 'e2e-s0', output: 'ok' },
      { type: 'custom_tool_call', name: 'exec', call_id: 'e2e-s1', input: 'text(1)' },
      {
        type: 'custom_tool_call_output',
        call_id: 'e2e-s1',
        output: [{ type: 'input_text', text: 'Script running with cell ID 4\nWall time 10.0 seconds' }],
      },
    ]);
    const next = nextStep(PROGRAM, yielded);
    expect(next.kind).toBe('error');
    expect(next.kind === 'error' && next.message).toContain('e2e-s1');
    const answer = codexReply(next);
    expect(JSON.stringify(answer.output)).toContain(PLAYBOOK_ERROR);
    expect(codexReply({ kind: 'done' }).output).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'message' })]),
    );
    expect(JSON.stringify(codexReply({ kind: 'done' }).output)).toContain(CLOSING_TEXT);
  });

  test('a cell whose command still ran at its deadline is a playbook error; one that exited is a result', () => {
    const cell = (json: string) =>
      codexRequest([
        developer('Codex base prompt.'),
        environment(clone('T-7-a1')),
        userText('Start.'),
        { type: 'custom_tool_call', name: 'exec', call_id: 'e2e-s0', input: 'text(1)' },
        {
          type: 'custom_tool_call_output',
          call_id: 'e2e-s0',
          output: [
            { type: 'input_text', text: 'Script completed\nWall time 20.0 seconds\nOutput:\n' },
            { type: 'input_text', text: json },
          ],
        },
      ]);
    const running = nextStep(PROGRAM, cell('{"session_id":9,"wall_time_seconds":20,"output":"waiting"}'));
    expect(running.kind === 'error' && running.message).toContain('e2e-s0 did not finish');
    // The command's own output naming a session is escaped inside the JSON, so it is not the cell's session_id.
    const exited = nextStep(PROGRAM, cell('{"exit_code":0,"wall_time_seconds":1,"output":"{\\"session_id\\": 3}"}'));
    expect(exited).toMatchObject({ kind: 'step', callId: 'e2e-s1' });
  });
});

describe('unfinished steps', () => {
  for (const vendor of ['claude', 'codex'] as const) {
    test(`a gate that timed out is a playbook error (${vendor})`, () => {
      const turns: Turn[] = [
        { prompt: 'Start.' },
        { call: 'e2e-s0' },
        { result: 'e2e-s0', text: 'agflow gate g1 timed out\nExit code 124', isError: true },
      ];
      const next = nextStep(PROGRAM, conversation(vendor, turns));
      expect(next.kind === 'error' && next.message).toContain('its gate timed out');
    });
  }

  test('a step Claude Code denied without running it is a playbook error', () => {
    const denied =
      'Permission for this tool use was denied. It requires approval, and this session has no approval surface. ' +
      'What required approval: Contains brace with quote character (expansion obfuscation)';
    const turns: Turn[] = [{ prompt: 'Start.' }, { call: 'e2e-s0' }, { result: 'e2e-s0', text: denied, isError: true }];
    const next = nextStep(PROGRAM, conversation('claude', turns));
    expect(next.kind === 'error' && next.message).toContain(
      'Claude Code denied it without running it (Contains brace with quote character (expansion obfuscation))',
    );
  });

  test('a command Claude moved to the background is a playbook error', () => {
    for (const output of [
      'Command did not complete within its 5s timeout and was moved to the background (ID: bash_1).',
      'Command was moved to the background (ID: bash_2) so that a message that arrived while it was running can reach' +
        ' you.',
    ]) {
      const turns: Turn[] = [{ prompt: 'Start.' }, { call: 'e2e-s0' }, { result: 'e2e-s0', text: output }];
      const next = nextStep(PROGRAM, conversation('claude', turns));
      expect(next.kind === 'error' && next.message).toContain('moved to the background');
    }
  });
});

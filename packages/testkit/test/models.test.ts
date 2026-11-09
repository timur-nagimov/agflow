import { afterEach, describe, expect, test } from 'bun:test';
import { claudeTestEnv } from '../src/anthropic/env';
import { UNSCRIPTED_TEXT } from '../src/anthropic/server';
import { DEFAULT_REPLY_TEXT } from '../src/codex/replies';
import { codexTestConfig } from '../src/codex/test-config';
import { type Models, startModels } from '../src/harness/models';
import { CLOSING_TEXT, type Program, type Programs, shell, tool } from '../src/harness/playbook';

const started: Models[] = [];
afterEach(async () => {
  for (const models of started.splice(0)) await models.close();
});

/** Models that answer a request without a program at once, so the tests of unmatched requests do not wait. */
async function models(programs: Programs = {}, programWaitMs = 0): Promise<Models> {
  const value = await startModels({ programs, programWaitMs });
  started.push(value);
  return value;
}

const clone = (attempt: string) => `/private/tmp/agf-e2e/r1/work/demo/${attempt}`;
const PROGRAM: Program = { steps: [shell('echo one > one.txt'), tool('submit', { summary: 'one.txt' })] };

type Block = Record<string, unknown>;
type Message = { role: string; content: string | Block[] };

/** A Claude main-loop request, sent as the CLI sends it (without streaming, to read the reply at once). */
async function claude(target: Models, system: string, messages: Message[], tools = ['Bash']): Promise<Block> {
  const response = await fetch(`${target.anthropic.url}/v1/messages?beta=true`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
    body: JSON.stringify({
      model: 'claude-test',
      max_tokens: 1024,
      stream: false,
      system: [{ type: 'text', text: system }],
      tools: tools.map((name) => ({ name, description: name, input_schema: { type: 'object' } })),
      messages,
    }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Block;
}

const message = (role: string, value: string) => ({
  type: 'message',
  role,
  content: [{ type: 'input_text', text: value }],
});
const developer = (value: string) => message('developer', value);
const user = (value: string) => message('user', value);
const environment = (cwd: string) => user(`<environment_context>\n  <cwd>${cwd}</cwd>\n</environment_context>`);

/** A Codex request whose input follows the base prompt; gives the output items of the streamed reply. */
async function codex(target: Models, input: Block[]): Promise<Block[]> {
  const response = await fetch(`${target.responses.url}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'thread-id': 'thread-1' },
    body: JSON.stringify({ model: 'gpt-test', stream: true, input: [developer('Codex base prompt.'), ...input] }),
  });
  expect(response.status).toBe(200);
  const completed = (await response.text())
    .split('\n\n')
    .map((block) => block.match(/^data: (.*)$/m)?.[1])
    .filter((data): data is string => data !== undefined)
    .map((data) => JSON.parse(data) as Block)
    .find((event) => event.type === 'response.completed');
  return ((completed?.response as Block | undefined)?.output ?? []) as Block[];
}

describe('startModels', () => {
  test("routes a Claude request to the program of the clone's attempt; an unknown attempt is unmatched", async () => {
    const cluster = await models({ 'T-1-a1': PROGRAM });
    const answered = await claude(cluster, `Primary working directory: ${clone('T-1-a1')}`, [
      { role: 'user', content: 'Start the task.' },
    ]);
    expect(answered.content).toEqual([
      {
        type: 'tool_use',
        id: 'e2e-s0',
        name: 'Bash',
        input: { command: 'echo one > one.txt', timeout: 120_000, description: 'Run e2e step e2e-s0' },
      },
    ]);
    const unknown = await claude(cluster, `Primary working directory: ${clone('T-9-a1')}`, [
      { role: 'user', content: 'Start the task.' },
    ]);
    expect(unknown.content).toEqual([{ type: 'text', text: UNSCRIPTED_TEXT }]);
    expect(cluster.unmatched().map((recorded) => recorded.attemptId)).toEqual(['T-9-a1']);
    // An auxiliary request (a title: no tools) gets the harmless default and is not unmatched.
    await claude(cluster, `Primary working directory: ${clone('T-1-a1')}`, [{ role: 'user', content: 'Title?' }], []);
    expect(cluster.unmatched()).toHaveLength(1);
    expect(cluster.requestsFor('T-1-a1').map((recorded) => recorded.answer)).toEqual([
      { kind: 'step', step: PROGRAM.steps[0], callId: 'e2e-s0' },
    ]);
  });

  test('routes a Codex request the same way, as an exec cell with the encoded call id', async () => {
    const cluster = await models({ 'T-1-a1': PROGRAM });
    const first = await codex(cluster, [environment(clone('T-1-a1')), user('Start the task.')]);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ type: 'custom_tool_call', name: 'exec', call_id: 'e2e-s0' });
    expect(first[0]?.input).toContain('echo one > one.txt');
    const second = await codex(cluster, [
      environment(clone('T-1-a1')),
      user('Start the task.'),
      { type: 'custom_tool_call', name: 'exec', call_id: 'e2e-s0', input: '' },
      { type: 'custom_tool_call_output', call_id: 'e2e-s0', output: [{ type: 'input_text', text: 'exit 0' }] },
    ]);
    expect(second[0]).toMatchObject({ type: 'custom_tool_call', name: 'exec', call_id: 'e2e-s1' });
    expect(second[0]?.input).toContain('mcp__agflow__submit');
    const unknown = await codex(cluster, [environment(clone('T-9-a1')), user('Start the task.')]);
    expect(JSON.stringify(unknown)).toContain(DEFAULT_REPLY_TEXT);
    expect(cluster.unmatched().map((recorded) => [recorded.vendor, recorded.attemptId])).toEqual([['codex', 'T-9-a1']]);
    // A compaction is auxiliary: its default summary answers it, and it is not unmatched.
    await codex(cluster, [
      environment(clone('T-1-a1')),
      user('You are performing a CONTEXT CHECKPOINT COMPACTION. Summarise.'),
    ]);
    expect(cluster.unmatched()).toHaveLength(1);
  });

  test("requestsFor gives an attempt's requests in arrival order with their text flattened", async () => {
    const cluster = await models({ 'T-1-a1': PROGRAM, 'T-1-a2': PROGRAM });
    const system = `You are Claude Code. MARK-SYSTEM\nPrimary working directory: ${clone('T-1-a1')}`;
    await claude(cluster, system, [{ role: 'user', content: 'Start. MARK-USER' }]);
    await codex(cluster, [environment(clone('T-1-a2')), user('Start.')]);
    await claude(cluster, system, [
      { role: 'user', content: 'Start. MARK-USER' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'MARK-OWN-WORDS' },
          { type: 'tool_use', id: 'e2e-s0', name: 'Bash', input: { command: 'echo MARK-OWN-CALL' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e2e-s0', content: 'MARK-RESULT' }] },
      { role: 'system', content: [{ type: 'text', text: 'A message from alice: MARK-INJECTED' }] },
    ]);
    const a1 = cluster.requestsFor('T-1-a1');
    expect(a1.map((recorded) => [recorded.vendor, recorded.answer?.kind === 'step' && recorded.answer.callId])).toEqual(
      [
        ['claude', 'e2e-s0'],
        ['claude', 'e2e-s1'],
      ],
    );
    expect(a1[0]?.seq).toBeLessThan(a1[1]?.seq as number);
    expect(a1[1]?.text).toContain('MARK-SYSTEM');
    for (const marker of ['MARK-SYSTEM', 'MARK-USER', 'MARK-RESULT', 'MARK-INJECTED']) {
      expect(cluster.sawText('T-1-a1', marker)).toBe(true);
    }
    // What the agent saw, not what it said: its own words and calls do not count.
    expect(cluster.sawText('T-1-a1', 'MARK-OWN-WORDS')).toBe(false);
    expect(cluster.sawText('T-1-a1', 'MARK-OWN-CALL')).toBe(false);
    expect(cluster.sawText('T-1-a2', 'MARK-USER')).toBe(false);

    await codex(cluster, [
      developer(`You are a worker. MARK-BRIEF\n\nYour working directory: ${clone('T-1-a2')}`),
      environment(clone('T-1-a2')),
      user('Start.'),
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'MARK-CODEX-WORDS' }] },
      { type: 'custom_tool_call', name: 'exec', call_id: 'e2e-s0', input: 'text("MARK-CODEX-CALL")' },
      { type: 'custom_tool_call_output', call_id: 'e2e-s0', output: [{ type: 'input_text', text: 'MARK-OUTPUT' }] },
      user('A message from alice: MARK-STEER'),
    ]);
    expect(cluster.requestsFor('T-1-a2').map((recorded) => recorded.vendor)).toEqual(['codex', 'codex']);
    for (const marker of ['MARK-BRIEF', 'MARK-OUTPUT', 'MARK-STEER']) {
      expect(cluster.sawText('T-1-a2', marker)).toBe(true);
    }
    expect(cluster.sawText('T-1-a2', 'MARK-CODEX-CALL')).toBe(false);
    expect(cluster.sawText('T-1-a2', 'MARK-CODEX-WORDS')).toBe(false);
    expect(cluster.requestsFor('T-1-a3')).toEqual([]);
  });

  test('addPrograms adds programs for later requests and keeps the others', async () => {
    const cluster = await models({ 'T-1-a1': PROGRAM });
    const successor: Program = { steps: [tool('write_handoff', { note: 'two' })] };
    const start = (attempt: string) =>
      claude(cluster, `Primary working directory: ${clone(attempt)}`, [{ role: 'user', content: 'Start the task.' }]);
    expect((await start('T-1-a2')).content).toEqual([{ type: 'text', text: UNSCRIPTED_TEXT }]);
    cluster.addPrograms({ 'T-1-a2': successor });
    expect((await start('T-1-a2')).content).toEqual([
      { type: 'tool_use', id: 'e2e-s0', name: 'mcp__agflow__write_handoff', input: { note: 'two' } },
    ]);
    // The program added earlier still answers.
    expect((await start('T-1-a1')).content).toMatchObject([{ type: 'tool_use', id: 'e2e-s0', name: 'Bash' }]);
    expect(cluster.unmatched().map((recorded) => recorded.attemptId)).toEqual(['T-1-a2']);
    // A finished program answers its closing text.
    const finished = await claude(cluster, `Primary working directory: ${clone('T-1-a2')}`, [
      { role: 'user', content: 'Start the task.' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'e2e-s0', name: 'mcp__agflow__write_handoff', input: {} }],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e2e-s0', content: 'saved' }] },
    ]);
    expect(finished.content).toEqual([{ type: 'text', text: CLOSING_TEXT }]);
  });

  test('a request for an attempt without a program waits for addPrograms, within the grace', async () => {
    const cluster = await models({ 'T-1-a1': PROGRAM }, 5_000);
    const start = (attempt: string) =>
      claude(cluster, `Primary working directory: ${clone(attempt)}`, [{ role: 'user', content: 'Start the task.' }]);
    const early = start('T-1-a2');
    await Bun.sleep(200);
    // Nothing is recorded while it waits.
    expect(cluster.requestsFor('T-1-a2')).toEqual([]);
    cluster.addPrograms({ 'T-1-a2': PROGRAM });
    expect((await early).content).toMatchObject([{ type: 'tool_use', id: 'e2e-s0', name: 'Bash' }]);
    expect(cluster.unmatched()).toEqual([]);
    expect(cluster.requestsFor('T-1-a2').map((recorded) => recorded.answer?.kind)).toEqual(['step']);
    // An attempt nobody adds gets the default once the grace runs out.
    const short = await models({}, 300);
    const began = Date.now();
    const late = await claude(short, `Primary working directory: ${clone('T-9-a1')}`, [
      { role: 'user', content: 'Start the task.' },
    ]);
    expect(Date.now() - began).toBeGreaterThanOrEqual(250);
    expect(late.content).toEqual([{ type: 'text', text: UNSCRIPTED_TEXT }]);
    expect(short.unmatched().map((recorded) => recorded.attemptId)).toEqual(['T-9-a1']);
  });

  test('claudeEnv and codexConfig point the CLIs at the servers and the proxy', async () => {
    const cluster = await models();
    expect(cluster.proxyUrl).toBe(cluster.proxy.url);
    expect(cluster.claudeEnv).toEqual(claudeTestEnv({ baseUrl: cluster.anthropic.url, proxyUrl: cluster.proxyUrl }));
    expect(cluster.claudeEnv.HTTPS_PROXY).toBe(cluster.proxyUrl);
    expect(cluster.codexConfig).toEqual(codexTestConfig(cluster.responses.url));
  });

  test('externalAttempts lists what the proxy refused; close() stops both servers and the proxy', async () => {
    const cluster = await startModels();
    expect(cluster.externalAttempts()).toEqual([]);
    await fetch('https://example.com/', { proxy: cluster.proxy.url }).catch(() => undefined);
    expect(cluster.externalAttempts()).toEqual([
      { kind: 'connect', method: 'CONNECT', target: 'example.com:443', at: expect.any(Number) },
    ]);
    await cluster.close();
    await cluster.close();
    const urls = [`${cluster.anthropic.url}/v1/messages`, `${cluster.responses.url}/responses`, cluster.proxy.url];
    for (const url of urls) {
      const outcome = await fetch(url, { method: 'POST', body: '{}' }).then(
        () => 'answered',
        () => 'refused',
      );
      expect(outcome).toBe('refused');
    }
  });
});

import { afterEach, describe, expect, test } from 'bun:test';
import { AGFLOW_VERSION } from '@agflow/core';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODEX_VERSION } from '../../src/adapters/codex/binary';
import { appServerArgs } from '../../src/adapters/codex/config';
import { RpcError, RpcTimeout } from '../../src/adapters/codex/rpc';
import { deleteCodexTranscript, readCodexTranscriptTail } from '../../src/adapters/codex/transcript';
import { RunnerConfigSchema, vendorHomes } from '../../src/config';
import { runnerPaths } from '../../src/paths';
import { vendorBinary } from '../../src/vendor/pins';
import { codexScenario, readCodexRecord, writeCodexShim, type ScriptedAnswer } from './peer';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sessionRef = '01a1c0b5-f5db-7140-8021-694831838113';
const recorded = readFileSync(join(import.meta.dir, 'fixtures/rollout.jsonl'), 'utf8');
const expected =
  'Turn two: running the tests first.\nTurn two: the tests pass.\n\n' +
  'Turn three: "quoted" text\nwith a second line.\n\nTurn four: done.';

function tempHome(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agflow-codex-transcript-')));
  dirs.push(dir);
  return dir;
}

function rollout(home: string, text = recorded, id = sessionRef, date = '2026/11/09'): void {
  const dir = join(home, 'sessions', date);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `rollout-2026-11-09T17-28-32-${id}.jsonl`), text);
}

function message(text: string) {
  return {
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
  };
}

const started = { type: 'event_msg', payload: { type: 'task_started' } };
const jsonl = (records: unknown[]) => records.map((record) => JSON.stringify(record)).join('\n') + '\n';

describe('readCodexTranscriptTail', () => {
  test('reads exactly the last three assistant turns from the recorded rollout, keeping the end when clipped', async () => {
    const codexHome = tempHome();
    rollout(codexHome);
    expect(await readCodexTranscriptTail({ codexHome, sessionRef, maxChars: 4000 })).toBe(expected);
    expect(await readCodexTranscriptTail({ codexHome, sessionRef, maxChars: 24 })).toBe(expected.slice(-24));
    expect(await readCodexTranscriptTail({ codexHome, sessionRef, maxChars: 0 })).toBe('');
  });

  test('includes text before task_started and fewer than three nonempty turns, joining only output_text parts', async () => {
    const codexHome = tempHome();
    rollout(
      codexHome,
      jsonl([
        message('Before the first turn'),
        started,
        {
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'output_text', text: 'First ' },
              { type: 'input_text', text: 'hidden' },
              null,
              { type: 'output_text', text: 42 },
              { type: 'output_text', text: 'message' },
            ],
          },
        },
        message('Second message'),
        started,
        message(''),
        started,
      ]),
    );
    expect(await readCodexTranscriptTail({ codexHome, sessionRef, maxChars: 4000 })).toBe(
      'Before the first turn\n\nFirst message\nSecond message',
    );
  });

  test('empty turns do not displace the last three turns with assistant text', async () => {
    const codexHome = tempHome();
    rollout(codexHome, recorded + jsonl([started, message(''), started, started]));
    expect(await readCodexTranscriptTail({ codexHome, sessionRef, maxChars: 4000 })).toBe(expected);
  });

  test('a file without assistant text returns an empty string', async () => {
    const codexHome = tempHome();
    rollout(
      codexHome,
      jsonl([
        started,
        {
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Prompt' }],
          },
        },
        { type: 'event_msg', payload: { type: 'item_completed', text: 'not assistant text' } },
      ]),
    );
    expect(await readCodexTranscriptTail({ codexHome, sessionRef, maxChars: 4000 })).toBe('');
  });

  test('skips malformed lines and shapes inserted into the recorded rollout', async () => {
    const codexHome = tempHome();
    const bad =
      'not JSON\n' +
      jsonl([
        null,
        42,
        'text',
        [],
        { type: 'response_item' },
        { type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'wrong' } },
        { type: 'response_item', payload: null },
        { type: 'event_msg', payload: [] },
      ]);
    rollout(codexHome, recorded.split('\n').join('\n' + bad));
    expect(await readCodexTranscriptTail({ codexHome, sessionRef, maxChars: 4000 })).toBe(expected);
  });

  test('never reads another thread, including longer ids with the same suffix or other creation dates', async () => {
    const codexHome = tempHome();
    const foreign = jsonl([started, message('Another thread must never appear')]);
    rollout(codexHome, foreign, 'different-thread');
    rollout(codexHome, foreign, `x${sessionRef}`);
    rollout(codexHome, foreign, `other-${sessionRef}`);
    rollout(codexHome, foreign, 'subagent-thread', '2025/01/02');
    expect(await readCodexTranscriptTail({ codexHome, sessionRef, maxChars: 4000 })).toBeNull();
    rollout(codexHome);
    expect(await readCodexTranscriptTail({ codexHome, sessionRef, maxChars: 4000 })).toBe(expected);
    expect(await readCodexTranscriptTail({ codexHome, sessionRef: 'missing', maxChars: 4000 })).toBeNull();
    expect(await readCodexTranscriptTail({ codexHome, sessionRef: '../../../outside', maxChars: 4000 })).toBeNull();
  });

  test('returns null without a sessions directory', async () => {
    expect(await readCodexTranscriptTail({ codexHome: tempHome(), sessionRef, maxChars: 4000 })).toBeNull();
  });

  test('finds the thread under an older creation date', async () => {
    const codexHome = tempHome();
    rollout(codexHome, recorded, sessionRef, '2025/01/02');
    expect(await readCodexTranscriptTail({ codexHome, sessionRef, maxChars: 4000 })).toBe(expected);
  });

  test('does not leave a low surrogate when clipping through a pair', async () => {
    const codexHome = tempHome();
    rollout(codexHome, jsonl([message('prefix😀end')]));
    expect(await readCodexTranscriptTail({ codexHome, sessionRef, maxChars: 4 })).toBe('end');
    expect(await readCodexTranscriptTail({ codexHome, sessionRef, maxChars: 5 })).toBe('😀end');
  });
});

function setup(answer: ScriptedAnswer<'thread/delete'> = { result: {} }) {
  const paths = runnerPaths(join(tempHome(), 'agflow'));
  const bin = join(paths.runner, vendorBinary('codex', CODEX_VERSION));
  writeCodexShim(bin, codexScenario({ answers: { 'thread/delete': answer } }));
  const input: Parameters<typeof deleteCodexTranscript>[0] = {
    sessionRef,
    paths,
    config: RunnerConfigSchema.parse({
      runnerKey: 'runner',
      machineId: 'machine',
      name: 'test',
      capturedPath: '/usr/bin:/bin',
    }),
    env: {},
    requestTimeoutMs: 200,
  };
  return { bin, input };
}

function ended(bin: string) {
  const runs = readCodexRecord(bin);
  expect(runs).toHaveLength(1);
  expect(runs[0]?.exit).toMatchObject({ reason: 'eof', code: 0, signal: null });
  return runs[0]!;
}

describe('deleteCodexTranscript', () => {
  test('initializes the current pin, deletes the thread, and ends the process in the runner homes', async () => {
    const { bin, input } = setup();
    await deleteCodexTranscript(input);
    const run = ended(bin);
    expect(run.requests.map(({ method, params }) => ({ method, params }))).toEqual([
      {
        method: 'initialize',
        params: { clientInfo: { name: 'agflow', title: null, version: AGFLOW_VERSION }, capabilities: null },
      },
      { method: 'thread/delete', params: { threadId: sessionRef } },
    ]);
    expect(run.env).toEqual({
      PATH: '/usr/bin:/bin',
      CODEX_HOME: vendorHomes(input.config, input.paths).codex,
      HOME: input.paths.homes.codexUser,
      GIT_DIR: '/dev/null',
    });
    expect(run.cwd).toBe(input.paths.homes.codexUser);
    expect(run.argv).toEqual(appServerArgs(null));
    for (const home of [run.env.CODEX_HOME!, run.env.HOME!]) expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(input.paths.logs, 'codex-transcripts.log'), 'utf8')).toContain('thread/delete');
  });

  test('uses the configured home, captured connectivity, and only allowed user variables', async () => {
    const { bin, input } = setup();
    input.config.homes.codex = join(tempHome(), 'custom-codex');
    input.config.connectivity = { HTTPS_PROXY: 'http://127.0.0.1:9', SSL_CERT_FILE: '/tmp/ca' };
    input.env = {
      USER: 'test',
      LOGNAME: 'test',
      LANG: 'C',
      SHELL: '/bin/zsh',
      LC_ALL: 'C',
      PATH: '/unwanted',
      HTTPS_PROXY: 'http://unwanted',
      HOME: '/unwanted',
      CODEX_HOME: '/unwanted',
      OPENAI_API_KEY: 'secret',
      AGFLOW_AGENT_TOKEN: 'secret',
      CODEX_MANAGED_TEST: '1',
    };
    await deleteCodexTranscript(input);
    expect(ended(bin).env).toEqual({
      PATH: '/usr/bin:/bin',
      ...input.config.connectivity,
      USER: 'test',
      LOGNAME: 'test',
      LANG: 'C',
      SHELL: '/bin/zsh',
      LC_ALL: 'C',
      CODEX_HOME: input.config.homes.codex,
      HOME: input.paths.homes.codexUser,
      GIT_DIR: '/dev/null',
    });
  });

  for (const enabled of [false, true]) {
    test(`test configuration overrides are ${enabled ? 'enabled' : 'ignored'} with AGFLOW_TEST=${enabled ? 1 : 0}`, async () => {
      const { bin, input } = setup();
      input.config.test = RunnerConfigSchema.parse({
        ...input.config,
        test: { codexConfig: { model_provider: 'scripted' } },
      }).test!;
      input.env = { AGFLOW_TEST: enabled ? '1' : '0' };
      await deleteCodexTranscript(input);
      expect(ended(bin).argv).toEqual(appServerArgs(enabled ? input.config.test.codexConfig : null));
    });
  }

  test('an already deleted rollout counts as success', async () => {
    const { bin, input } = setup({ error: { code: -32600, message: `no rollout found for thread id ${sessionRef}` } });
    await expect(deleteCodexTranscript(input)).resolves.toBeUndefined();
    ended(bin);
  });

  for (const error of [
    { code: -32600, message: 'cannot delete a running thread', data: { reason: 'busy' } },
    { code: -32603, message: `no rollout found for thread id ${sessionRef}` },
    { code: -32600, message: 'other error: no rollout found' },
  ]) {
    test(`rejects ${error.code}: ${error.message} and ends the process`, async () => {
      const { bin, input } = setup({ error });
      const result = deleteCodexTranscript(input);
      await expect(result).rejects.toBeInstanceOf(RpcError);
      await expect(result).rejects.toMatchObject({ ...error, method: 'thread/delete' });
      ended(bin);
    });
  }

  test('a request timeout rejects and ends the process', async () => {
    const { bin, input } = setup({ silent: true });
    await expect(deleteCodexTranscript(input)).rejects.toBeInstanceOf(RpcTimeout);
    ended(bin);
  });

  test('a missing binary rejects with binary missing', async () => {
    const { bin, input } = setup();
    rmSync(bin);
    await expect(deleteCodexTranscript(input)).rejects.toThrow('binary missing');
    expect(readCodexRecord(bin)).toEqual([]);
  });
});

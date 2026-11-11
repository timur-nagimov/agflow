import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRIDGE_ANSWERS } from '@agflow/core';
import { listAgents } from '@agflow/hub/src/agents';
import { updateAttempt } from '@agflow/hub/src/attempt-store';
import { buildBrief } from '@agflow/hub/src/brief';
import { sendMessage } from '@agflow/hub/src/messages';
import { saveCredentials } from '../src/credentials';
import { handleHook, runBriefHook, runHook } from '../src/hooks';
import { main } from '../src/main';
import { HUB_URL, helloCodeIn, hubFixture } from './fixture';

const contextOf = (output: Record<string, unknown>) =>
  (output.hookSpecificOutput as { additionalContext: string } | undefined)?.additionalContext ?? '';
const configDirForTest = () => mkdtempSync(join(tmpdir(), 'agflow-cfg-'));
/** A Claude runner agent's hook environment, as the runner sets it (design 7.6). */
const runnerEnv = (hubUrl: string, token: string, configDir: string) => ({
  AGFLOW_AGENT_TOKEN: token,
  AGFLOW_HUB_URL: hubUrl,
  AGFLOW_CLONE: '/work/demo/T-1-a1',
  AGFLOW_CONFIG_DIR: configDir,
});

describe('handleHook', () => {
  test('session start registers the chat and returns the brief as context', async () => {
    const hub = hubFixture();
    const output = await handleHook('session-start', { session_id: 's1', cwd: '/work/demo' }, { client: hub.client('alice'), vendor: 'codex', role: 'worker' });
    expect(output.hookSpecificOutput).toMatchObject({ hookEventName: 'SessionStart' });
    expect(helloCodeIn(contextOf(output))).toMatch(/^[A-Z2-9]{6}$/);
    expect(listAgents(hub.ctx)).toEqual([expect.objectContaining({ vendor: 'codex', sessionId: 's1', label: 'demo' })]);
  });

  test('a prompt brings new messages as context, once', async () => {
    const hub = hubFixture();
    const ctx = { client: hub.client('alice'), vendor: 'claude' as const, role: 'worker' as const };
    await handleHook('session-start', { session_id: 's1' }, ctx);
    const agentId = listAgents(hub.ctx)[0]?.id ?? '';
    sendMessage(hub.ctx, { from: 'user:bob', to: `agent:${agentId}`, body: 'Use pnpm.' });
    const first = await handleHook('user-prompt-submit', { session_id: 's1' }, ctx);
    expect(first.hookSpecificOutput).toMatchObject({ hookEventName: 'UserPromptSubmit' });
    expect(contextOf(first)).toContain('Use pnpm.');
    expect(await handleHook('user-prompt-submit', { session_id: 's1' }, ctx)).toEqual({});
  });

  test('stop continues the turn while messages wait, and allows it otherwise', async () => {
    const hub = hubFixture();
    const ctx = { client: hub.client('alice'), vendor: 'claude' as const, role: 'worker' as const };
    await handleHook('session-start', { session_id: 's1' }, ctx);
    expect(await handleHook('stop', { session_id: 's1', stop_hook_active: false }, ctx)).toEqual({});
    sendMessage(hub.ctx, { from: 'user:bob', to: `agent:${listAgents(hub.ctx)[0]?.id}`, body: 'One more thing.' });
    const blocked = await handleHook('stop', { session_id: 's1', stop_hook_active: false }, ctx);
    expect(blocked).toMatchObject({ decision: 'block' });
    expect(String(blocked.reason)).toContain('check_inbox');
    expect(await handleHook('stop', { session_id: 's1', stop_hook_active: true }, ctx)).toEqual({});
  });

  test('input without a session id produces no output', async () => {
    const hub = hubFixture();
    expect(await handleHook('stop', {}, { client: hub.client('alice'), vendor: 'claude', role: 'worker' })).toEqual({});
  });
});

describe('runHook', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'agflow-cfg-'));

  test('without a sign-in, session start explains what to do', async () => {
    const output = await runHook('session-start', 'claude', 'worker', { readStdin: async () => '{"session_id":"s1"}', dir: dir() });
    expect(contextOf(output)).toContain('agflow login');
    expect(await runHook('stop', 'claude', 'worker', { readStdin: async () => '{"session_id":"s1"}', dir: dir() })).toEqual({});
  });

  test('an unreachable hub never breaks the chat and is logged', async () => {
    const where = dir();
    saveCredentials({ hubUrl: HUB_URL, token: 't', user: 'alice' }, where);
    const failing = async () => {
      throw new Error('ECONNREFUSED');
    };
    const start = await runHook('session-start', 'claude', 'worker', { readStdin: async () => '{"session_id":"s1"}', dir: where, fetch: failing });
    expect(contextOf(start)).toContain('could not reach its hub');
    expect(await runHook('stop', 'codex', 'worker', { readStdin: async () => 'not json', dir: where, fetch: failing })).toEqual({});
    expect(readFileSync(join(where, 'hook.log'), 'utf8')).toContain('session-start: cannot reach the agflow hub');
  });
});

describe('runBriefHook', () => {
  test("prints the runner brief as SessionStart context, ending with 'Your working directory: <AGFLOW_CLONE>'", async () => {
    const hub = hubFixture();
    const worker = hub.runnerAgent();
    const where = configDirForTest();
    const output = await runBriefHook({ env: runnerEnv(HUB_URL, worker.token, where), fetch: hub.fetch });
    const brief = buildBrief(hub.ctx, worker.agent);
    expect(output).toEqual({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `${brief.replace(/\n+$/, '')}\n\nYour working directory: /work/demo/T-1-a1`,
      },
    });
    expect(brief).toContain(worker.task?.branch ?? 'no branch');
    expect(helloCodeIn(brief)).toBe('');
    expect(existsSync(join(where, 'hook.log'))).toBe(false);
  });

  test('a 401 or an unreachable hub gives an explanation as context and is logged', async () => {
    const hub = hubFixture();
    const worker = hub.runnerAgent();
    const where = configDirForTest();
    updateAttempt(hub.ctx, worker.attempt.id, { status: 'ended', endReason: 'stopped', endedAt: hub.ctx.now() });
    const ended = await runBriefHook({ env: runnerEnv(HUB_URL, worker.token, where), fetch: hub.fetch });
    expect(contextOf(ended)).toBe(BRIDGE_ANSWERS.attemptEnded('stopped'));
    // A restore re-fences every attempt: the hub refuses the old fence until the runner resumes it.
    const refenced = hub.runnerAgent();
    hub.ctx.db.run('UPDATE project SET epoch = 2');
    expect(contextOf(await runBriefHook({ env: runnerEnv(HUB_URL, refenced.token, where), fetch: hub.fetch }))).toBe(BRIDGE_ANSWERS.attemptRefenced);
    const failing = async () => {
      throw new Error('ECONNREFUSED');
    };
    const unreachable = await runBriefHook({ env: runnerEnv(HUB_URL, worker.token, where), fetch: failing });
    expect(contextOf(unreachable)).toStartWith('agflow could not load your brief (cannot reach the agflow hub at http://hub.test');
    expect(contextOf(unreachable)).toContain('Read .agflow/run/brief.md and .agflow/run/task.md in /work/demo/T-1-a1');
    const log = readFileSync(join(where, 'hook.log'), 'utf8').trim().split('\n');
    expect(log).toHaveLength(3);
    expect(log[0]).toContain('brief: Your agflow attempt has ended (stopped)');
    expect(log[1]).toContain(`brief: ${BRIDGE_ANSWERS.attemptRefenced}`);
    expect(log[2]).toContain('brief: cannot reach the agflow hub at http://hub.test: ECONNREFUSED');
  });

  test('a missing variable is named in the context and the log', async () => {
    const where = configDirForTest();
    const env: Record<string, string | undefined> = runnerEnv(HUB_URL, 'agt_x', where);
    env.AGFLOW_AGENT_TOKEN = undefined;
    const output = await runBriefHook({ env, fetch: async () => new Response('{}') });
    expect(contextOf(output)).toContain('AGFLOW_AGENT_TOKEN is not set');
    expect(readFileSync(join(where, 'hook.log'), 'utf8')).toContain('brief: AGFLOW_AGENT_TOKEN is not set');
    // Without AGFLOW_CONFIG_DIR the hook logs nowhere, least of all in the owner's own CLI config under HOME.
    const home = configDirForTest();
    const noDir: Record<string, string | undefined> = { ...runnerEnv(HUB_URL, 'agt_x', where), AGFLOW_CONFIG_DIR: undefined, HOME: home };
    expect(contextOf(await runBriefHook({ env: noDir, fetch: async () => new Response('{}') }))).toContain('AGFLOW_CONFIG_DIR is not set');
    expect(existsSync(join(home, '.config', 'agflow'))).toBe(false);
  });
});

describe('agflow hook brief', () => {
  test('--runner reads its environment only: a credentials.json in AGFLOW_CONFIG_DIR is ignored, and it exits 0', async () => {
    const hub = hubFixture();
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: hub.app.fetch });
    try {
      const worker = hub.runnerAgent();
      const where = configDirForTest();
      // Alice's own sign-in, pointing at a hub that is not there: the hook must not use it.
      saveCredentials({ hubUrl: 'http://127.0.0.1:9', token: hub.tokenFor('alice'), user: 'alice' }, where);
      const hook = Bun.spawn([process.execPath, join(import.meta.dir, '..', 'src', 'main.ts'), 'hook', 'brief', '--runner'], {
        env: { PATH: process.env.PATH ?? '', HOME: where, ...runnerEnv(`http://127.0.0.1:${server.port}`, worker.token, where) },
        stdin: new TextEncoder().encode('{"session_id":"s1","source":"startup"}'),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, code] = await Promise.all([new Response(hook.stdout).text(), hook.exited]);
      expect(code).toBe(0);
      const output = JSON.parse(stdout) as Record<string, unknown>;
      expect(contextOf(output)).toBe(`${buildBrief(hub.ctx, worker.agent).replace(/\n+$/, '')}\n\nYour working directory: /work/demo/T-1-a1`);
      expect(existsSync(join(where, 'hook.log'))).toBe(false);
    } finally {
      server.stop(true);
    }
  }, 30_000);

  test('without --runner, brief is an unknown event, as in M1', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (text: string) => void out.push(text), err: (text: string) => void err.push(text) };
    expect(await main(['hook', 'brief'], io)).toBe(0);
    expect(err.join('')).toContain('unknown hook event "brief"');
    expect(out.join('')).toBe('{}');
  });
});

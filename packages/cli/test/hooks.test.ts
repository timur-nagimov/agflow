import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listAgents } from '@agflow/hub/src/agents';
import { sendMessage } from '@agflow/hub/src/messages';
import { saveCredentials } from '../src/credentials';
import { handleHook, runHook } from '../src/hooks';
import { HUB_URL, helloCodeIn, hubFixture } from './fixture';

const contextOf = (output: Record<string, unknown>) =>
  (output.hookSpecificOutput as { additionalContext: string } | undefined)?.additionalContext ?? '';

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

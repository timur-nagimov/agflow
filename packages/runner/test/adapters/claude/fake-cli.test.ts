import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claudeRecording,
  FAKE_CLAUDE_BIN,
  fakeClaudeEnv,
  type RecordingStep,
  readFakeClaudeLog,
} from '@agflow/testkit/src/fake-claude';
import { query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { createGuardHook } from '../../../src/adapters/claude/guard';

// macOS's first exec of a new script is slow.
const TIMEOUT = 30_000;
const SESSION = '11111111-2222-4333-8444-555555555555';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const frame = (value: Record<string, unknown>): RecordingStep => ({ frame: value });

const turn: RecordingStep[] = [
  frame({ type: 'command_lifecycle', command_uuid: '$LAST_USER_UUID', state: 'started', session_id: '$SESSION' }),
  frame({
    type: 'system',
    subtype: 'init',
    session_id: '$SESSION',
    cwd: '$CWD',
    model: '$MODEL',
    permissionMode: '$PERMISSION_MODE',
    tools: ['Bash'],
    mcp_servers: [],
    apiKeySource: 'none',
    claude_code_version: '2.1.285',
    uuid: '$UUID',
  }),
  {
    hook: {
      event: 'PreToolUse',
      input: {
        hook_event_name: 'PreToolUse',
        session_id: '$SESSION',
        transcript_path: '/dev/null',
        cwd: '$CWD',
        tool_name: 'Bash',
        tool_input: { command: 'git push origin HEAD' },
        tool_use_id: 'toolu_1',
      },
      toolUseId: 'toolu_1',
    },
  },
  frame({
    type: 'assistant',
    message: { role: 'assistant', model: '$MODEL', content: [{ type: 'text', text: 'Hello from the recording.' }] },
    parent_tool_use_id: null,
    session_id: '$SESSION',
    uuid: '$UUID',
  }),
  frame({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Hello from the recording.',
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    stop_reason: 'end_turn',
    session_id: '$SESSION',
    total_cost_usd: 0,
    usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    modelUsage: {},
    permission_denials: [],
    terminal_reason: 'completed',
    uuid: '$UUID',
    user_message_uuids: ['$LAST_USER_UUID'],
  }),
];

describe('the fake claude through the Agent SDK', () => {
  test(
    'initializationResult(), one turn with a hook callback, and close() work',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'agflow-fake-cli-'));
      dirs.push(dir);
      const env = fakeClaudeEnv({ recording: claudeRecording({ turns: [turn] }), dir });
      const scope = {
        clone: join(dir, 'clone'),
        tmpDir: join(dir, 'tmp'),
        workRoot: join(dir, 'work'),
        claudeHome: dir,
        home: dir,
      };
      const inbox: SDKUserMessage[] = [
        {
          type: 'user',
          message: { role: 'user', content: 'go' },
          parent_tool_use_id: null,
          uuid: 'aaaaaaaa-0000-4000-8000-000000000001',
        },
      ];
      const q = query({
        prompt: (async function* () {
          yield* inbox;
          // A finite input would close stdin and end the session; this one stays open until close().
          await new Promise(() => {});
        })(),
        options: {
          pathToClaudeCodeExecutable: FAKE_CLAUDE_BIN,
          cwd: dir,
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
          sessionId: SESSION,
          model: 'claude-sonnet-5-5',
          permissionMode: 'acceptEdits',
          hooks: { PreToolUse: [createGuardHook(scope)] },
        },
      });
      const init = await q.initializationResult();
      expect(init.account).toEqual({
        email: 'agent@example.invalid',
        organization: 'org-00000000-0000-4000-8000-000000000000',
        subscriptionType: 'max',
        tokenSource: 'claude.ai',
        apiProvider: 'firstParty',
      });
      const seen: SDKMessage[] = [];
      for await (const message of q) {
        seen.push(message);
        if (message.type === 'result') break;
      }
      const system = seen.find((message) => message.type === 'system' && message.subtype === 'init');
      expect(system).toMatchObject({ session_id: SESSION, model: 'claude-sonnet-5-5', permissionMode: 'acceptEdits' });
      const result = seen.find((message) => message.type === 'result');
      expect(result).toMatchObject({ subtype: 'success', session_id: SESSION, result: 'Hello from the recording.' });
      expect((result as { user_message_uuids?: string[] }).user_message_uuids).toEqual([
        'aaaaaaaa-0000-4000-8000-000000000001',
      ]);
      q.close();
      const log = await readFakeClaudeLog(env.FAKE_CLAUDE_LOG as string);
      const argv = log.find((entry) => entry.kind === 'argv');
      expect(argv?.kind === 'argv' && argv.argv).toContain(`--session-id=${SESSION}`);
      expect(log.find((entry) => entry.kind === 'control')).toMatchObject({ request: { subtype: 'initialize' } });
      expect(log.find((entry) => entry.kind === 'user')).toMatchObject({
        message: { uuid: 'aaaaaaaa-0000-4000-8000-000000000001' },
      });
      // The SDK answered the hook with the guard's verdict.
      expect(log.find((entry) => entry.kind === 'hook_answer')).toMatchObject({
        event: 'PreToolUse',
        answer: { subtype: 'success', response: { hookSpecificOutput: { permissionDecision: 'deny' } } },
      });
      // close() ends stdin; the fake exits 0 on EOF while idle.
      for (let tries = 0; tries < 100; tries += 1) {
        if ((await readFakeClaudeLog(env.FAKE_CLAUDE_LOG as string)).some((entry) => entry.kind === 'exit')) break;
        await Bun.sleep(50);
      }
      expect((await readFakeClaudeLog(env.FAKE_CLAUDE_LOG as string)).at(-1)).toMatchObject({ kind: 'exit', code: 0 });
    },
    TIMEOUT,
  );
});

// What the CodexSession tests share: a launch in temp homes, a fake-peer shim at the launch's vendor binary path, the
// start-check answers that pass, and the assertions every failed start makes. Test files call cleanupSessions from
// afterEach.
import { expect } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRIDGE_TOOL_NAMES } from '../../src/adapters/bridge-tools';
import { CODEX_VERSION } from '../../src/adapters/codex/binary';
import type { ParamsOf, ResultOf } from '../../src/adapters/codex/methods';
import type { SkillMetadata } from '../../src/adapters/codex/protocol/v2';
import { CodexSession, type CodexSessionOptions } from '../../src/adapters/codex/session';
import type { AgentEvent, AgentLaunch } from '../../src/adapters/types';
import { standardProfile } from '../../src/profile';
import { vendorBinary } from '../../src/vendor/pins';
import { codexScenario, readCodexRecord, writeCodexShim, type CodexRun, type ScriptedAnswers } from './peer';

const dirs: string[] = [];
const pids: number[] = [];
/** Kills every app-server group the fixtures registered and removes their directories. */
export function cleanupSessions(): void {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** The tools the fake agflow bridge lists, out of order: Codex lists them by name from a map. */
export const BRIDGE_TOOLS = [...BRIDGE_TOOL_NAMES.worker].reverse();

export function mcp(
  names = ['agflow'],
  nextCursor: string | null = null,
  tools: readonly string[] = BRIDGE_TOOLS,
): ResultOf<'mcpServerStatus/list'> {
  return {
    data: names.map((name) => ({
      name,
      runtimeStatus: 'connected',
      pluginId: null,
      httpOrigin: null,
      serverInfo: null,
      serverCapabilities: null,
      tools: Object.fromEntries(tools.map((tool) => [tool, { name: tool, inputSchema: { type: 'object' } }])),
      toolsError: null,
      resources: [],
      resourceTemplates: [],
      authStatus: 'unsupported',
    })),
    nextCursor,
  };
}

/** The first turn carries only the launch's prompt; the tool note is in developer instructions. */
export function firstInput(prompt: string): ParamsOf<'turn/start'>['input'] {
  return [{ type: 'text', text: prompt, text_elements: [] }];
}

export function skills(scope: SkillMetadata['scope'], pluginId: string | null = null): ResultOf<'skills/list'> {
  return {
    data: [
      {
        cwd: '/tmp',
        errors: [],
        skills: [{ name: 'example-skill', description: 'test', path: '/tmp/SKILL.md', scope, enabled: true, pluginId }],
      },
    ],
  };
}

export interface SessionFixture {
  options: CodexSessionOptions;
  launch: AgentLaunch;
  bin: string;
  /** registerProcess calls, which also assert that no output was read yet. */
  registrations: { pid: number; at: number }[];
  /** The peer's answers; change them, then call write(). */
  answers: ScriptedAnswers;
  write(): void;
}

/** A launch at version's binary whose start checks pass; resume makes it a resume launch of that thread. */
export function sessionFixture(
  input: { answers?: ScriptedAnswers; version?: string; resume?: string | null } = {},
): SessionFixture {
  const version = input.version ?? CODEX_VERSION;
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agflow-codex-session-')));
  dirs.push(dir);
  const options: CodexSessionOptions = {
    runnerDir: join(dir, 'runner'),
    codexHome: join(dir, 'codex-home'),
    userHome: join(dir, 'user-home'),
    requestTimeoutMs: 300,
  };
  const clone = join(dir, 'clone');
  for (const path of [clone, options.codexHome, options.userHome]) mkdirSync(path);
  const bin = join(options.runnerDir, vendorBinary('codex', version));
  const registrations: SessionFixture['registrations'] = [];
  const launch: AgentLaunch = {
    attemptId: 'T-42-a3',
    role: 'worker',
    model: 'requested-model',
    cliVersion: version,
    clone,
    baseCheckout: null,
    projectConfigVerified: true,
    tmpDir: join(clone, '.agflow/run/tmp'),
    env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' },
    bridge: {
      command: '/fake/agflow',
      args: ['mcp', '--vendor', 'codex', '--runner'],
      env: { AGFLOW_AGENT_TOKEN: 'test-token', AGFLOW_ATTEMPT_ID: 'T-42-a3', NODE_USE_SYSTEM_CA: '1' },
      tools: BRIDGE_TOOL_NAMES.worker,
    },
    profile: standardProfile,
    brief: 'Work in this clone.',
    firstPrompt: 'Please implement the task.\nRun tests.',
    resume: input.resume ? { sessionRef: input.resume } : null,
    logFile: join(dir, 'attempt.log'),
    registerProcess(pid) {
      pids.push(pid);
      registrations.push({ pid, at: Date.now() });
      expect(!existsSync(launch.logFile) || readFileSync(launch.logFile).length === 0).toBe(true);
      expect(readCodexRecord(bin)[0]?.initializedAt ?? null).toBeNull();
    },
  };
  const answers: ScriptedAnswers = {
    'mcpServerStatus/list': { result: mcp() },
    'skills/list': { result: skills('system') },
    ...input.answers,
  };
  const write = () => {
    writeCodexShim(bin, codexScenario({ version, stderr: ['session stderr'], answers }));
  };
  write();
  return { options, launch, bin, registrations, answers, write };
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A start that must fail: one line containing reason, one app-server run that has exited. */
export async function rejectedStart(f: SessionFixture, reason: string): Promise<CodexRun> {
  const error = await CodexSession.start(f.launch, f.options).then(
    () => null,
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(reason);
  expect((error as Error).message).not.toMatch(/[\r\n]|\s{2}/);
  const runs = readCodexRecord(f.bin);
  expect(runs).toHaveLength(1);
  expect(runs[0]!.exit).not.toBeNull();
  expect(alive(f.registrations[0]!.pid)).toBe(false);
  return runs[0]!;
}

export async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const result: AgentEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

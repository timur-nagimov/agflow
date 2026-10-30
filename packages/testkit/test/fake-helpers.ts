// Helpers for the fake adapter's tests: a clone with its run directory and a launch for it, sessions started from
// a script and killed at the end of the test, and a recorder of their events.
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentEvent,
  type AgentLaunch,
  type AgentSession,
  agentGitEnv,
  removeAgentTools,
  standardProfile,
  writeRunDir,
} from '@agflow/runner';
import { FakeAdapter, type FakeAdapterOptions, type FakeScript } from '../src/fake-adapter';
import { gitIn, originRepo } from '../src/git-fixtures';

const cleanups: (() => void)[] = [];

/** Runs every cleanup a test registered, newest first; each test file calls it from afterEach. */
export function runCleanups(): void {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
}

export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Kills a process group at the end of the test, whatever state it is in. */
export function killLater(pgid: number): void {
  cleanups.push(() => {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  });
}

export const IDENTITY = { name: 'Agent Smith', email: 'agent@agflow.invalid' };

/** A clone on its task branch with the agent's .agflow/run/, and a launch for it. */
export async function setup(overrides: Partial<AgentLaunch> = {}): Promise<{ launch: AgentLaunch; clone: string }> {
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

export async function start(
  launch: AgentLaunch,
  script: FakeScript,
  options: Omit<FakeAdapterOptions, 'script'> = {},
): Promise<AgentSession> {
  const session = await new FakeAdapter({ ...options, script }).start(launch);
  killLater(session.pid);
  return session;
}

/** Reads every event of a session in the background. */
export function record(session: AgentSession) {
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
    async waitFor(check: (event: AgentEvent) => boolean, timeoutMs = 15_000): Promise<AgentEvent> {
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

export const turnEnded = (event: AgentEvent) => event.type === 'turn_ended';
export const countOf = (events: AgentEvent[], type: AgentEvent['type']) =>
  events.filter((event) => event.type === type).length;

export async function waitFile(path: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path) || readFileSync(path, 'utf8').trim() === '') {
    if (Date.now() > deadline) throw new Error(`${path} never appeared`);
    await Bun.sleep(10);
  }
  return readFileSync(path, 'utf8').trim();
}

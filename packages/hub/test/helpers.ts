import type { Agent, AgentRole, Vendor } from '@agflow/core';
import { type NewTask, type NewTaskInput, NewTaskSchema } from '@agflow/core';
import { startLiveSession } from '../src/agents';
import { type FetchFn, HUB_RUNNER_DEFAULTS, type HubConfig, type HubContext, createContext } from '../src/context';

export class TestClock {
  t = Date.UTC(2026, 9, 26, 12, 0, 0);
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

export function makeConfig(overrides: Partial<HubConfig> = {}): HubConfig {
  return {
    ...HUB_RUNNER_DEFAULTS,
    publicUrl: 'http://hub.test',
    auth: 'dev',
    allowedUsers: ['alice', 'bob'],
    projectName: 'demo',
    projectRepo: 'https://github.com/acme/demo',
    leaseMs: 2 * 60 * 60_000,
    reminderMs: 30 * 60_000,
    maxOpenTasks: 200,
    maxTasksPerHour: 60,
    secureCookies: false,
    ...overrides,
  };
}

export function createTestContext(
  overrides: Partial<HubConfig> = {},
  fetchFn?: FetchFn,
): { ctx: HubContext; clock: TestClock } {
  const clock = new TestClock();
  const ctx = createContext({ dbPath: ':memory:', config: makeConfig(overrides), now: clock.now, fetch: fetchFn });
  return { ctx, clock };
}

export function newTask(overrides: Partial<NewTaskInput> = {}): NewTask {
  return NewTaskSchema.parse({
    title: 'Do the thing',
    objective: 'Make the thing work',
    acceptance: [{ id: 'A1', assertion: 'The thing works' }],
    ...overrides,
  });
}

let sessionCounter = 0;

/** Registers a live agent the way the SessionStart hook does. */
export function addAgent(ctx: HubContext, user = 'alice', role: AgentRole = 'worker', vendor: Vendor = 'claude'): Agent {
  sessionCounter += 1;
  return startLiveSession(ctx, user, { vendor, sessionId: `session-${sessionCounter}`, role }).agent;
}

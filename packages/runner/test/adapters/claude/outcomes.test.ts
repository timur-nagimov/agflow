import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { VendorQuota } from '@agflow/core';
import { linkClaudeBinary } from '@agflow/testkit/src/anthropic';
import { FAKE_CLAUDE_BIN, fakeClaudeEnv, loadRecording } from '@agflow/testkit/src/fake-claude';
import {
  CLAUDE_SCENARIOS,
  recordingOf,
  runScenario,
  SYNTHESISED_LIMIT_TEXT,
  SYNTHESISED_OVERAGE_TEXT,
  SYNTHESISED_RESET,
  scratchLaunch,
} from '../../../scripts/record-claude-stream';
import { ClaudeAdapter } from '../../../src/adapters/claude/adapter';
import { CLAUDE_CLI_VERSION } from '../../../src/adapters/claude/pin';
import type { AgentEvent, AgentLaunch, AgentSession } from '../../../src/adapters/types';
import { isLimitHit } from '../../../src/attempt/turns';
import { runnerPaths } from '../../../src/paths';
import { standardProfile } from '../../../src/profile';

// macOS's first exec of a new script is slow, more so under load.
const TIMEOUT = 30_000;

const dirs: string[] = [];
const groups = new Set<number>();
const sessions: AgentSession[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  for (const pgid of groups) {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  groups.clear();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

beforeAll(() => {
  // Warm the script and Bun's transpile cache once, so the first test does not pay for it.
  Bun.spawnSync([FAKE_CLAUDE_BIN, '--version'], { env: { PATH: '/usr/bin:/bin', FAKE_CLAUDE_BUN: process.execPath } });
}, TIMEOUT);

/** An adapter whose pinned claude is the fake, and a launch that replays the recording. */
function setup(scenario: string): { adapter: ClaudeAdapter; launch: AgentLaunch } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agflow-claude-outcomes-')));
  dirs.push(root);
  const paths = runnerPaths(join(root, '.agflow'));
  linkClaudeBinary(paths.home, CLAUDE_CLI_VERSION, FAKE_CLAUDE_BIN);
  const clone = join(paths.work, 'p-1', 'T-1-a1');
  const tmpDir = join(root, 'tmp');
  const home = join(root, 'home');
  for (const dir of [clone, tmpDir, home, paths.homes.claude]) mkdirSync(dir, { recursive: true });
  const launch: AgentLaunch = {
    attemptId: 'T-1-a1',
    role: 'worker',
    model: 'claude-sonnet-5-5',
    cliVersion: CLAUDE_CLI_VERSION,
    clone,
    baseCheckout: paths.baseCheckout('p-1', '0123456789abcdef'),
    projectConfigVerified: true,
    tmpDir,
    env: {
      HOME: home,
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      CLAUDE_CONFIG_DIR: paths.homes.claude,
      CLAUDE_CODE_TMPDIR: tmpDir,
      ...fakeClaudeEnv({ recording: loadRecording(scenario), dir: join(root, 'fake') }),
    },
    bridge: { command: '/usr/bin/false', args: ['mcp', '--vendor', 'claude', '--runner'], env: {}, tools: [] },
    profile: standardProfile,
    brief: 'brief',
    firstPrompt: 'Say hello in one word.',
    resume: null,
    logFile: join(root, 'attempt.log'),
    registerProcess: (pid) => groups.add(pid),
  };
  const adapter = new ClaudeAdapter({
    agflow: { command: '/usr/bin/false', args: [] },
    paths,
    vendorHomes: { claude: paths.homes.claude, codex: paths.homes.codex },
  });
  return { adapter, launch };
}

/** Starts the recording's session and gives its events up to the end of its first turn. */
async function firstTurn(scenario: string, before?: (adapter: ClaudeAdapter) => void): Promise<AgentEvent[]> {
  const { adapter, launch } = setup(scenario);
  before?.(adapter);
  const session = await adapter.start(launch);
  sessions.push(session);
  const events: AgentEvent[] = [];
  for await (const event of session.events) {
    events.push(event);
    if (event.type === 'turn_ended') break;
  }
  return events;
}

const of = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) =>
  events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type);

const turnEnded = (events: AgentEvent[]) => of(events, 'turn_ended').at(-1);

describe('quota through a live session', () => {
  test(
    'a limit hit gives quota exhausted, then turn_ended failed with errorKind quota',
    async () => {
      const events = await firstTurn('limit-hit');
      const [quota] = of(events, 'quota');
      expect(quota).toMatchObject({
        accountId: null,
        quota: { state: 'exhausted', resetsAt: SYNTHESISED_RESET * 1000, windows: { fiveHour: 1 } },
      });
      expect(events.indexOf(quota as AgentEvent)).toBeLessThan(events.indexOf(turnEnded(events) as AgentEvent));
      expect(turnEnded(events)).toMatchObject({ outcome: 'failed', errorKind: 'quota', error: SYNTHESISED_LIMIT_TEXT });
    },
    TIMEOUT,
  );

  test(
    'overage in use gives quota with paidUsage in_use and the notice; the adapter does not fail the turn itself',
    async () => {
      const events = await firstTurn('overage-in-use');
      const quotas = of(events, 'quota');
      expect(quotas.length).toBeGreaterThan(0);
      for (const { quota } of quotas) expect(quota).toMatchObject({ state: 'ok', paidUsage: 'in_use' });
      // The controller decides by allowPaidUsage (X-14): a limit hit only where the owner does not allow it.
      expect(isLimitHit((quotas[0] as (typeof quotas)[number]).quota, false)).toBe(true);
      expect(isLimitHit((quotas[0] as (typeof quotas)[number]).quota, true)).toBe(false);
      expect(of(events, 'warning')).toContainEqual({ type: 'warning', text: SYNTHESISED_OVERAGE_TEXT });
      expect(turnEnded(events)).toMatchObject({ outcome: 'completed', errorKind: null });
    },
    TIMEOUT,
  );
});

describe('other outcomes through a live session', () => {
  for (const [scenario, kind] of [
    ['auth-expired', 'auth'],
    ['context-overflow', 'context'],
    ['policy-refusal', 'policy'],
  ] as const) {
    test(
      `${scenario} ends the turn failed with errorKind ${kind}`,
      async () => {
        const events = await firstTurn(scenario);
        expect(turnEnded(events)).toMatchObject({ outcome: 'failed', errorKind: kind, error: expect.any(String) });
        expect(of(events, 'quota')).toEqual([]);
      },
      TIMEOUT,
    );
  }

  test(
    'an api_retry with 429 gives a warning and the last known quota, never exhausted; after the retries, vendor',
    async () => {
      const known: VendorQuota = {
        state: 'exhausted',
        resetsAt: Date.now() - 60_000,
        windows: { fiveHour: 1, weekly: 0.4 },
        paidUsage: 'disabled',
        updatedAt: Date.now() - 120_000,
      };
      const events = await firstTurn('api-retry-429', (adapter) => adapter.quota.update(null, known));
      expect(of(events, 'warning')).toEqual([
        { type: 'warning', text: 'The API answered 429 (rate_limit); retry 1 of 1 in 1 s.' },
      ]);
      const quotas = of(events, 'quota');
      expect(quotas).toHaveLength(1);
      expect(quotas[0]?.quota).toMatchObject({ state: 'unknown', windows: known.windows, paidUsage: 'disabled' });
      expect(isLimitHit(quotas[0]?.quota as VendorQuota, false)).toBe(false);
      expect(turnEnded(events)).toMatchObject({ outcome: 'failed', errorKind: 'vendor' });
    },
    TIMEOUT,
  );

  test(
    'an overloaded error after the retries gives errorKind vendor, and no quota',
    async () => {
      const events = await firstTurn('vendor-error');
      expect(of(events, 'warning')).toEqual([
        { type: 'warning', text: expect.stringMatching(/^The API answered 529 \(overloaded\); retry 1 of 1/) },
      ]);
      expect(of(events, 'quota')).toEqual([]);
      expect(turnEnded(events)).toMatchObject({ outcome: 'failed', errorKind: 'vendor' });
    },
    TIMEOUT,
  );
});

describe('the outcome recordings', () => {
  const captured = ['auth-expired', 'context-overflow', 'policy-refusal', 'api-retry-429', 'vendor-error'];
  for (const name of [...captured, 'limit-hit', 'overage-in-use']) {
    test(
      `${name} replays through the recorder as it was written`,
      async () => {
        const recording = loadRecording(name);
        expect(recording.header).toMatchObject({
          cliVersion: CLAUDE_CLI_VERSION,
          source: captured.includes(name) ? 'captured' : 'synthesised',
        });
        const scenario = CLAUDE_SCENARIOS.find((entry) => entry.name === name);
        if (!scenario) throw new Error(`no scenario ${name}`);
        const launch = scratchLaunch({ bin: FAKE_CLAUDE_BIN, model: recording.header.model, env: {} });
        try {
          Object.assign(launch.launch.env, fakeClaudeEnv({ recording, dir: join(launch.root, 'fake') }));
          const run = await runScenario(scenario, launch);
          const again = recordingOf(run, recording.header, launch, { live: false });
          expect(again.turns).toEqual(recording.turns);
          expect(again.answers).toEqual(recording.answers);
        } finally {
          launch.cleanup();
        }
      },
      TIMEOUT,
    );
  }
});

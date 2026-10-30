import { afterEach, describe, expect, jest, setDefaultTimeout, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AttemptPhase,
  type AttemptSpec,
  TEST_ACCOUNT_ID,
  VENDOR_OUTCOME_KINDS,
  type VendorQuota,
} from '@agflow/core';
import type { FakeScript, FakeStep, TranscriptLine } from '@agflow/testkit';
import type { PumpEvent } from '../src/attempt/pump';
import {
  continuationPrompt,
  OUTAGE_NUDGE,
  QUOTA_RESUME_PROMPT,
  TurnPolicy,
  vendorRetryDelay,
  vendorRetryPrompt,
} from '../src/attempt/turns';
import { DEFAULT_TIMINGS } from '../src/config';
import { noopLogger } from '../src/log';
import {
  cleanupRunnerFixtures,
  createRunnerFixture as createFixture,
  FIXTURE_PROJECT,
  type RunnerFixture,
  type RunnerFixtureOptions,
  waitFor,
} from './fixture';

afterEach(cleanupRunnerFixtures);

// Every test here runs git or agent processes, which take several times as long on a machine loaded by other suites.
setDefaultTimeout(30_000);

/** The fixture, with a continuationWait of 100 ms unless the options give one. */
function createRunnerFixture(options: RunnerFixtureOptions = {}): Promise<RunnerFixture> {
  const timings = { continuationWait: 100, ...options.config?.timings };
  return createFixture({ ...options, config: { ...options.config, timings } });
}

const PROMPT = 'Start working on T-4.';
const LONG_SLEEP = { do: 'sleep', ms: 30_000 } as const;
const DAY_MS = 24 * 60 * 60 * 1_000;
const SUBMIT = { do: 'terminal', tool: 'submit' } as const;

/** A worker spec of task T-<n>, attempt a1. */
function specOf(f: RunnerFixture, n: number, overrides: Partial<AttemptSpec> = {}): AttemptSpec {
  return f.spec({
    attemptId: `T-${n}-a1`,
    taskId: `T-${n}`,
    branch: `agflow/T-${n}-x`,
    wipRef: `refs/agflow/T-${n}/a1`,
    ...overrides,
  });
}

/** A script per attempt, by the number of its task. */
function scripts(byTask: Record<number, FakeScript>) {
  return (launch: { attemptId: string }): FakeScript => {
    const n = Number(launch.attemptId.match(/\d+/)?.[0]);
    const script = byTask[n];
    if (!script) throw new Error(`no script for ${launch.attemptId}`);
    return script;
  };
}

/** The user lines of the attempt's fake transcript so far. */
function userTexts(f: RunnerFixture, attemptId: string): string[] {
  const spawned = f.events('attempt.spawned').filter((event) => event.attemptId === attemptId);
  const sessionRef = spawned.at(-1)?.data.sessionRef;
  if (sessionRef === undefined) return [];
  const file = join(f.paths.clone(FIXTURE_PROJECT, attemptId), '.agflow', 'run', 'fake-transcripts', `${sessionRef}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as TranscriptLine)
    .filter((line) => line.role === 'user')
    .map((line) => line.text);
}

/**
 * Records, while it runs, when each user line of the attempt's transcript appeared (Date.now, as events' at): the
 * moments the agent took the runner's messages. stop(count) waits until count lines were seen, then stops.
 */
function watchUserTexts(f: RunnerFixture, attemptId: string): { times: number[]; stop(count: number): Promise<void> } {
  const times: number[] = [];
  const timer = setInterval(() => {
    const count = userTexts(f, attemptId).length;
    while (times.length < count) times.push(Date.now());
  }, 5);
  return {
    times,
    stop: async (count) => {
      await waitFor(() => times.length >= count);
      clearInterval(timer);
    },
  };
}

/** Turns ended so far: each ends with one turn or vendor_error activity. */
const turnsEnded = (f: RunnerFixture, attemptId: string) =>
  f.events('attempt.activity').filter(
    (event) => event.attemptId === attemptId && (event.data.kind === 'turn' || event.data.kind === 'vendor_error'),
  ).length;

const quotaOf = (overrides: Partial<VendorQuota>): VendorQuota => ({
  state: 'ok',
  resetsAt: null,
  windows: { fiveHour: 0.5, weekly: 0.2 },
  paidUsage: 'disabled',
  updatedAt: Date.now(),
  ...overrides,
});

describe('AttemptController: continuation', () => {
  test('a completed worker turn without a terminal tool gets one continuation listing the acceptance ids', async () => {
    const f = await createRunnerFixture({ script: { turns: [[], [SUBMIT]] } });
    const controller = f.controller();
    await controller.start(f.spec({ acceptanceIds: ['A1', 'A2'] }));
    await waitFor(() => turnsEnded(f, 'T-4-a1') === 2);
    await Bun.sleep(400);
    expect(userTexts(f, 'T-4-a1')).toEqual([PROMPT, continuationPrompt(['A1', 'A2'])]);
    expect(controller.facts()?.continuations).toBe(1);
    expect(continuationPrompt(['A1', 'A2'])).toContain('A1, A2');
  });

  test('no continuation after a failed or interrupted turn, a terminal tool, a hold or stop in the wait, or a lead', async () => {
    const terminal = (tool: 'submit' | 'blocked' | 'impossible' | 'released', answer?: 'refused') => ({
      turns: [[{ do: 'terminal' as const, tool, ...(answer ? { answer } : {}) }], [SUBMIT]],
    });
    const f = await createRunnerFixture({
      config: { timings: { continuationWait: 1_000 } },
      script: scripts({
        1: { turns: [[{ do: 'fail', kind: 'policy' }]] },
        2: { turns: [[LONG_SLEEP]] },
        3: terminal('submit'),
        4: terminal('blocked'),
        5: terminal('impossible'),
        6: terminal('released'),
        7: { turns: [[]] },
        8: { turns: [[]] },
        9: { turns: [[]] },
        10: terminal('submit', 'refused'),
      }),
    });
    const fence = { epoch: 1, counter: 1 };
    let interrupted: ReturnType<RunnerFixture['controller']> | null = null;
    for (const n of [1, 2, 3, 4, 5, 6, 10]) {
      const controller = f.controller(`T-${n}-a1`);
      if (n === 2) interrupted = controller;
      await controller.start(specOf(f, n));
    }
    await f.controller('lead-a9').start(f.spec({ attemptId: 'lead-a9', taskId: null, role: 'lead', branch: null, wipRef: null }));
    await waitFor(() => interrupted?.phase === 'turn');
    expect(await interrupted?.interrupt({ fence })).toEqual({ ok: true });
    // A hold and a stop that arrive within continuationWait of the turn's end, and wait on the queue behind other
    // work past it: their arrival alone keeps the continuation back.
    const held = f.controller('T-7-a1');
    const stopped = f.controller('T-8-a1');
    await Promise.all([held.start(specOf(f, 7)), stopped.start(specOf(f, 8))]);
    await waitFor(() => turnsEnded(f, 'T-7-a1') === 1 && turnsEnded(f, 'T-8-a1') === 1);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    void f.queue.run('T-7-a1', () => gate);
    void f.queue.run('T-8-a1', () => gate);
    const holding = held.hold({ fence });
    const stopping = stopped.stop({ fence, reason: 'stopped', handoff: false, interruptFirst: false, keepClone: false });
    await Bun.sleep(1_500);
    expect(userTexts(f, 'T-7-a1')).toEqual([PROMPT]);
    expect(userTexts(f, 'T-8-a1')).toEqual([PROMPT]);
    release();
    expect(await holding).toMatchObject({ ok: true });
    expect(await stopping).toMatchObject({ ok: true });
    await waitFor(() => turnsEnded(f, 'T-10-a1') === 2, 8_000);
    await Bun.sleep(1_500);
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) expect([n, userTexts(f, `T-${n}-a1`)]).toEqual([n, [PROMPT]]);
    expect(userTexts(f, 'lead-a9')).toEqual([PROMPT]);
    // A refused submit is no terminal tool.
    expect(userTexts(f, 'T-10-a1')).toEqual([PROMPT, continuationPrompt(['A1'])]);
  }, 60_000);
});

describe('AttemptController: outages', () => {
  test('no continuation while the link is down or after a hub-unreachable answer; one nudge after the welcome', async () => {
    const f = await createRunnerFixture({
      script: scripts({
        1: { turns: [[], [SUBMIT]] },
        2: { turns: [[{ do: 'terminal', tool: 'submit', answer: 'hub_unreachable' }], [SUBMIT]] },
        3: { turns: [[LONG_SLEEP], [SUBMIT]] },
      }),
    });
    const down = f.controller('T-1-a1');
    const unreachable = f.controller('T-2-a1');
    const interrupted = f.controller('T-3-a1');
    f.link.up = false;
    await down.start(specOf(f, 1));
    await waitFor(() => turnsEnded(f, 'T-1-a1') === 1);
    await unreachable.start(specOf(f, 2));
    await interrupted.start(specOf(f, 3));
    await waitFor(() => turnsEnded(f, 'T-2-a1') === 1 && interrupted.phase === 'turn');
    // needs_login: the runner interrupts the turn and marks it for the nudge.
    await interrupted.interrupt({ outage: true });
    await waitFor(() => turnsEnded(f, 'T-3-a1') === 1);
    await Bun.sleep(300);
    for (const attemptId of ['T-1-a1', 'T-2-a1', 'T-3-a1']) expect(userTexts(f, attemptId)).toEqual([PROMPT]);
    f.link.up = true;
    for (const controller of [down, unreachable, interrupted]) await controller.onWelcome();
    for (const controller of [down, unreachable, interrupted]) await controller.onWelcome();
    await waitFor(() => [1, 2, 3].every((n) => turnsEnded(f, `T-${n}-a1`) === 2));
    await Bun.sleep(300);
    // The continuation that fell due while the link was down goes after the welcome; the others get the nudge.
    expect(userTexts(f, 'T-1-a1')).toEqual([PROMPT, continuationPrompt(['A1'])]);
    expect(userTexts(f, 'T-2-a1')).toEqual([PROMPT, OUTAGE_NUDGE]);
    expect(userTexts(f, 'T-3-a1')).toEqual([PROMPT, OUTAGE_NUDGE]);
    expect(OUTAGE_NUDGE).toBe('the agflow hub is reachable again; retry the tool that failed');
  });

  test('with the link up, a hub-unreachable answer gets one nudge when its turn ends and no continuation', async () => {
    const unreachable = { do: 'terminal', tool: 'submit', answer: 'hub_unreachable' } as const;
    const f = await createRunnerFixture({ script: { turns: [[unreachable], [unreachable], [SUBMIT]] } });
    const controller = f.controller();
    await controller.start(f.spec());
    await waitFor(() => turnsEnded(f, 'T-4-a1') === 2);
    // The second failure gets no second nudge before a welcome: a hub that keeps failing is no loop.
    await Bun.sleep(3 * 100 + 200);
    expect(userTexts(f, 'T-4-a1')).toEqual([PROMPT, OUTAGE_NUDGE]);
    await controller.onWelcome();
    await waitFor(() => turnsEnded(f, 'T-4-a1') === 3);
    await Bun.sleep(300);
    expect(userTexts(f, 'T-4-a1')).toEqual([PROMPT, OUTAGE_NUDGE, OUTAGE_NUDGE]);
  });

  test('a welcome that arrives while the marked turn still runs gives the nudge when that turn ends', async () => {
    const unreachable = { do: 'terminal', tool: 'submit', answer: 'hub_unreachable' } as const;
    const f = await createRunnerFixture({ script: { turns: [[unreachable, { do: 'sleep', ms: 600 }], [SUBMIT]] } });
    const controller = f.controller();
    f.link.up = false;
    await controller.start(f.spec());
    await waitFor(() => controller.phase === 'turn');
    await Bun.sleep(150);
    // The link as the policy reads it stays down: only the welcome says the hub is back.
    await controller.onWelcome();
    await waitFor(() => turnsEnded(f, 'T-4-a1') === 2);
    await Bun.sleep(300);
    expect(userTexts(f, 'T-4-a1')).toEqual([PROMPT, OUTAGE_NUDGE]);
  });
});

describe('AttemptController: vendor errors', () => {
  test('a vendor error sets vendor_error and retries with a doubling delay, outside every budget', async () => {
    const call = { do: 'tool', command: 'true' } as const;
    const failed: FakeStep[] = [call, { do: 'fail', kind: 'vendor', error: 'overloaded' }];
    const f = await createRunnerFixture({
      config: { timings: { vendorErrorBackoff: { base: 150, cap: 1_000 } } },
      script: { turns: [failed, failed, [call, LONG_SLEEP]] },
    });
    const controller = f.controller();
    await controller.start(f.spec());
    const taken = watchUserTexts(f, 'T-4-a1');
    await waitFor(() => controller.phase === 'vendor_error');
    await waitFor(() => userTexts(f, 'T-4-a1').length === 3 && controller.phase === 'turn', 5_000);
    await taken.stop(3);
    const retries = f.logger.entries.filter((entry) => entry.message.startsWith('the vendor failed the turn'));
    expect(retries.map((entry) => entry.fields.delayMs)).toEqual([150, 300]);
    // The waits themselves: from each failed turn's end to the agent taking the retry.
    const failedAt = f.events('attempt.activity')
      .filter((event) => event.data.kind === 'vendor_error')
      .map((event) => event.at);
    expect((taken.times[1] as number) - (failedAt[0] as number)).toBeGreaterThanOrEqual(150);
    expect((taken.times[2] as number) - (failedAt[1] as number)).toBeGreaterThanOrEqual(300);
    expect(userTexts(f, 'T-4-a1')).toEqual([PROMPT, vendorRetryPrompt('claude'), vendorRetryPrompt('claude')]);
    await waitFor(() => controller.facts()?.repeatedCalls === 1);
    expect(controller.facts()).toMatchObject({ continuations: 0, turnsWithoutProgress: 0, repeatedCalls: 1 });
    expect(f.events('attempt.activity').filter((event) => event.data.kind === 'vendor_error')).toHaveLength(2);
    // The defaults: 30 s, doubling, up to 10 minutes.
    expect([0, 1, 2, 3, 4, 5, 9].map((n) => vendorRetryDelay(n, DEFAULT_TIMINGS))).toEqual([
      30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000,
    ]);
  });
});

describe('AttemptController: quota', () => {
  test('a limit hit interrupts the turn, waits in quota_wait and resumes at resetsAt with attempt.quota ok', async () => {
    let resetsAt = 0;
    const f = await createRunnerFixture({
      script: () => {
        resetsAt = Date.now() + 1_200;
        const quota = quotaOf({ state: 'exhausted', resetsAt, windows: { fiveHour: 1, weekly: 0.4 } });
        return { turns: [[{ do: 'quota', quota, accountId: TEST_ACCOUNT_ID }, LONG_SLEEP], [SUBMIT]] };
      },
    });
    const controller = f.controller();
    await controller.start(f.spec());
    await waitFor(() => controller.phase === 'quota_wait');
    const [exhausted] = await waitFor(() => f.events('attempt.quota').length === 1 && f.events('attempt.quota'));
    expect(exhausted?.data).toMatchObject({ vendor: 'claude', accountId: TEST_ACCOUNT_ID, quota: { state: 'exhausted', resetsAt } });
    expect(controller.facts()?.phase).toBe('quota_wait');
    // The interrupted turn's end comes from the agent after the interrupt, so its note may follow the quota report.
    await waitFor(() => f.events('attempt.activity').some((event) => event.data.summary === 'turn interrupted'));
    await waitFor(() => turnsEnded(f, 'T-4-a1') === 2, 5_000);
    expect(Date.now()).toBeGreaterThanOrEqual(resetsAt);
    const reports = f.events('attempt.quota');
    expect(reports.map((event) => event.data.quota.state)).toEqual(['exhausted', 'ok']);
    expect(reports[1]?.data.accountId).toBe(TEST_ACCOUNT_ID);
    expect(userTexts(f, 'T-4-a1')).toEqual([PROMPT, QUOTA_RESUME_PROMPT]);
  });

  test('with an unknown reset the turn is retried every quotaUnknown', async () => {
    const f = await createRunnerFixture({
      config: { timings: { quotaUnknown: 300 } },
      script: { turns: [[{ do: 'fail', kind: 'quota' }], [{ do: 'fail', kind: 'quota' }], [SUBMIT]] },
    });
    const controller = f.controller();
    await controller.start(f.spec());
    await waitFor(() => turnsEnded(f, 'T-4-a1') === 3, 20_000);
    await waitFor(() => userTexts(f, 'T-4-a1').length === 3);
    // Bun timers can fire 1 ms early against Date.now() (also seen on Linux). Allow that rounding in the
    // outbox timestamps; TurnPolicy.armWait itself re-arms an early timer against its own clock.
    const quotaAt = f.events('attempt.quota').map((event) => event.at);
    expect(quotaAt).toHaveLength(4);
    expect((quotaAt[1] as number) - (quotaAt[0] as number)).toBeGreaterThanOrEqual(300 - 1);
    expect((quotaAt[3] as number) - (quotaAt[2] as number)).toBeGreaterThanOrEqual(300 - 1);
    const reports = f.events('attempt.quota').map((event) => event.data);
    expect(reports.map((data) => [data.quota.state, data.quota.resetsAt, data.accountId])).toEqual([
      ['exhausted', null, null],
      ['ok', null, null],
      ['exhausted', null, null],
      ['ok', null, null],
    ]);
    expect(userTexts(f, 'T-4-a1')).toEqual([PROMPT, QUOTA_RESUME_PROMPT, QUOTA_RESUME_PROMPT]);
  });

  test('a limit that still holds at the reported reset is waited for quotaUnknown, not retried at once', async () => {
    const f = await createRunnerFixture({
      config: { timings: { quotaUnknown: 800 } },
      script: () => {
        const quota = quotaOf({ state: 'exhausted', resetsAt: Date.now() + 300 });
        return { turns: [[{ do: 'quota', quota, accountId: TEST_ACCOUNT_ID }, LONG_SLEEP], [{ do: 'fail', kind: 'quota' }], [SUBMIT]] };
      },
    });
    const controller = f.controller();
    const taken = watchUserTexts(f, 'T-4-a1');
    await controller.start(f.spec());
    await waitFor(() => turnsEnded(f, 'T-4-a1') === 3, 5_000);
    await taken.stop(3);
    const reports = f.events('attempt.quota').map((event) => [event.data.quota.state, event.data.quota.resetsAt]);
    expect(reports).toEqual([
      ['exhausted', expect.any(Number)],
      ['ok', expect.any(Number)],
      ['exhausted', null],
      ['ok', null],
    ]);
    const failedAt = f.events('attempt.activity').find((event) => event.data.summary.startsWith('turn failed (quota)'))?.at;
    expect((taken.times[2] as number) - (failedAt as number)).toBeGreaterThanOrEqual(800);
    expect(userTexts(f, 'T-4-a1')).toEqual([PROMPT, QUOTA_RESUME_PROMPT, QUOTA_RESUME_PROMPT]);
  });

  test('a reset further ahead than the longest timer keeps the wait: no early end, no resume prompt', async () => {
    const resetsAt = Date.now() + 30 * DAY_MS;
    const quota = quotaOf({ state: 'exhausted', resetsAt, windows: { fiveHour: 0.3, weekly: 1 } });
    const f = await createRunnerFixture({
      script: { turns: [[{ do: 'quota', quota, accountId: TEST_ACCOUNT_ID }, LONG_SLEEP], [SUBMIT]] },
    });
    const controller = f.controller();
    await controller.start(f.spec());
    await waitFor(() => f.events('attempt.quota').length > 0 && turnsEnded(f, 'T-4-a1') > 0);
    await Bun.sleep(500);
    expect(f.events('attempt.quota').map((event) => [event.data.quota.state, event.data.quota.resetsAt])).toEqual([
      ['exhausted', resetsAt],
    ]);
    expect(controller.phase).toBe('quota_wait');
    expect(userTexts(f, 'T-4-a1')).toEqual([PROMPT]);
  });

  test('the wait of a far reset is armed again until the reset passes, then ends with the resume prompt', () => {
    jest.useFakeTimers();
    try {
      const reports: PumpEvent[] = [];
      const phases: AttemptPhase[] = [];
      const sent: string[] = [];
      const policy = new TurnPolicy({
        attemptId: 'T-4-a1',
        spec: () => ({ role: 'worker', vendor: 'claude', acceptanceIds: ['A1'] }),
        session: {
          send: async (message) => {
            sent.push(message.text);
          },
          interrupt: async () => {},
        },
        inTurn: () => false,
        stopping: () => false,
        linkUp: () => true,
        allowPaidUsage: () => false,
        timings: () => ({ ...DEFAULT_TIMINGS, quotaUnknown: 1_000 }),
        setPhase: (phase) => phases.push(phase),
        report: (event) => reports.push(event),
        continuationSent: () => {},
        logger: noopLogger,
      });
      const resetsAt = Date.now() + 30 * DAY_MS;
      const quota = quotaOf({ state: 'exhausted', resetsAt, updatedAt: Date.now() });
      policy.observe({ type: 'quota', accountId: TEST_ACCOUNT_ID, quota });
      const states = () => reports.flatMap((event) => (event.type === 'attempt.quota' ? [event.data.quota.state] : []));
      expect(states()).toEqual(['exhausted']);
      // Past the longest delay a timer takes, and on to a minute before the reset: the wait goes on.
      jest.advanceTimersByTime(2 ** 31);
      jest.advanceTimersByTime(resetsAt - Date.now() - 60_000);
      expect(states()).toEqual(['exhausted']);
      expect(phases).toEqual(['quota_wait']);
      expect(sent).toEqual([]);
      jest.advanceTimersByTime(60_000);
      expect(states()).toEqual(['exhausted', 'ok']);
      expect(phases).toEqual(['quota_wait', 'idle']);
      expect(sent).toEqual([QUOTA_RESUME_PROMPT]);
      policy.close();
    } finally {
      jest.useRealTimers();
    }
  });

  test('a wait of quotaUnknown never ends early by the runner clock, though its timer fires early', () => {
    jest.useFakeTimers();
    try {
      const reports: PumpEvent[] = [];
      // The runner's clock against the timers': a timer that fires early finds less time gone than it waited.
      let lag = 0;
      const policy = new TurnPolicy({
        attemptId: 'T-4-a1',
        spec: () => ({ role: 'worker', vendor: 'claude', acceptanceIds: ['A1'] }),
        session: { send: async () => {}, interrupt: async () => {} },
        inTurn: () => false,
        stopping: () => false,
        linkUp: () => true,
        allowPaidUsage: () => false,
        timings: () => ({ ...DEFAULT_TIMINGS, quotaUnknown: 1_000 }),
        setPhase: () => {},
        report: (event) => reports.push(event),
        continuationSent: () => {},
        logger: noopLogger,
        now: () => Date.now() - lag,
      });
      policy.observe({ type: 'quota', accountId: TEST_ACCOUNT_ID, quota: quotaOf({ state: 'exhausted', resetsAt: null }) });
      const states = () => reports.flatMap((event) => (event.type === 'attempt.quota' ? [event.data.quota.state] : []));
      lag = 5;
      jest.advanceTimersByTime(1_000);
      expect(states()).toEqual(['exhausted']);
      jest.advanceTimersByTime(5);
      expect(states()).toEqual(['exhausted', 'ok']);
      policy.close();
    } finally {
      jest.useRealTimers();
    }
  });

  test('the wait holds when the hit turn completes anyway, with no continuation and the account left alone', async () => {
    const paid = quotaOf({ paidUsage: 'in_use', resetsAt: Date.now() + 60_000 });
    const f = await createRunnerFixture({
      config: { allowPaidUsage: { claude: false, codex: false } },
      // The interrupt loses the race: the turn completes after the hit.
      script: { turns: [[{ do: 'quota', quota: paid, accountId: TEST_ACCOUNT_ID }]], ignoreInterrupt: true },
    });
    const controller = f.controller();
    await controller.start(f.spec());
    await waitFor(() => turnsEnded(f, 'T-4-a1') === 1);
    await Bun.sleep(600);
    expect(controller.phase).toBe('quota_wait');
    expect(userTexts(f, 'T-4-a1')).toEqual([PROMPT]);
    // Paid usage in use is this runner's refusal, not the account's exhaustion.
    expect(f.events('attempt.quota').map((event) => [event.data.quota.state, event.data.accountId])).toEqual([
      ['exhausted', null],
    ]);
  });

  test('a delivery during a paid-usage wait is interrupted and the wait goes on', async () => {
    const paid = quotaOf({ paidUsage: 'in_use', resetsAt: Date.now() + 60_000 });
    const f = await createRunnerFixture({
      config: { allowPaidUsage: { claude: false, codex: false } },
      script: { turns: [[{ do: 'quota', quota: paid }, LONG_SLEEP], [LONG_SLEEP]] },
    });
    const controller = f.controller();
    await controller.start(f.spec());
    await waitFor(() => controller.phase === 'quota_wait' && turnsEnded(f, 'T-4-a1') === 1);
    const message = { messageId: 7, authority: 'person' as const, text: 'how is it going?' };
    expect(await controller.deliver({ fence: { epoch: 1, counter: 1 }, messages: [message], more: 0 })).toEqual({ ok: true });
    await waitFor(() => turnsEnded(f, 'T-4-a1') === 2);
    await Bun.sleep(400);
    expect(controller.phase).toBe('quota_wait');
    const summaries = f.events('attempt.activity').map((event) => event.data.summary);
    expect(summaries.filter((summary) => summary === 'turn interrupted')).toHaveLength(2);
    expect(userTexts(f, 'T-4-a1')).toEqual([PROMPT, message.text]);
    expect(f.events('attempt.quota')).toHaveLength(1);
  });

  test('paid usage in use is a limit hit while allowPaidUsage is false for the vendor, for both vendors', async () => {
    const paid = quotaOf({ paidUsage: 'in_use', resetsAt: Date.now() + 60_000 });
    const f = await createRunnerFixture({
      config: { allowPaidUsage: { claude: false, codex: true } },
      script: { turns: [[{ do: 'quota', quota: paid }, { do: 'sleep', ms: 500 }]] },
    });
    const run = async (n: number, vendor: 'claude' | 'codex') => {
      const controller = f.controller(`T-${n}-a1`);
      await controller.start(specOf(f, n, { vendor }));
      await waitFor(() => turnsEnded(f, `T-${n}-a1`) === 1);
      return controller;
    };
    const claudeHit = await run(1, 'claude');
    const codexAllowed = await run(2, 'codex');
    f.config.allowPaidUsage = { claude: true, codex: false };
    const claudeAllowed = await run(3, 'claude');
    const codexHit = await run(4, 'codex');
    const hits = f.events('attempt.quota').map((event) => [event.attemptId, event.data.vendor, event.data.quota.state]);
    expect(hits).toEqual([
      ['T-1-a1', 'claude', 'exhausted'],
      ['T-4-a1', 'codex', 'exhausted'],
    ]);
    expect([claudeHit.phase, codexHit.phase]).toEqual(['quota_wait', 'quota_wait']);
    expect([claudeAllowed.phase, codexAllowed.phase]).not.toContain('quota_wait');
    const summaries = (attemptId: string) =>
      f.events('attempt.activity').filter((event) => event.attemptId === attemptId).map((event) => event.data.summary);
    expect(summaries('T-1-a1')).toContain('turn interrupted');
    expect(summaries('T-3-a1')).toContain('turn completed with 0 tool calls');
  });
});

describe('AttemptController: vendor outcomes', () => {
  test('auth, context, policy, denials and session_budget outcomes are reported with their detail', async () => {
    const byTask: Record<number, FakeScript> = {};
    VENDOR_OUTCOME_KINDS.forEach((kind, index) => {
      byTask[index + 1] = { turns: [[{ do: 'fail', kind, error: `the ${kind} detail` }]] };
    });
    const f = await createRunnerFixture({ script: scripts(byTask) });
    for (const [index] of VENDOR_OUTCOME_KINDS.entries()) await f.controller(`T-${index + 1}-a1`).start(specOf(f, index + 1));
    await waitFor(() => f.events('attempt.vendor_outcome').length === VENDOR_OUTCOME_KINDS.length);
    const outcomes = f.events('attempt.vendor_outcome').map((event) => [event.attemptId, event.data]);
    expect(outcomes).toEqual(
      VENDOR_OUTCOME_KINDS.map((kind, index) => [`T-${index + 1}-a1`, { kind, detail: `the ${kind} detail` }]),
    );
    await Bun.sleep(300);
    for (const [index] of VENDOR_OUTCOME_KINDS.entries()) expect(userTexts(f, `T-${index + 1}-a1`)).toEqual([PROMPT]);
  }, 60_000);
});

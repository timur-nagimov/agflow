import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { type AttemptSpec, TEST_ACCOUNT_ID, type VendorQuota } from '@agflow/core';
import { cleanupRunnerFixtures, createRunnerFixture, fixtureAgentToken, type RunnerFixture, waitFor } from './fixture';
import {
  cleanupRunnerSetups,
  hellos,
  runCommand as run,
  setupRunner as setup,
  setupSpec as specOf,
} from './runner-setup';

afterEach(async () => {
  await cleanupRunnerFixtures();
  await cleanupRunnerSetups();
});

// Every test here runs git or agent processes, which take several times as long on a machine loaded by other suites.
setDefaultTimeout(30_000);

const LONG_SLEEP = { do: 'sleep', ms: 30_000 } as const;

/** A lead's spec: no task, branch or WIP ref. */
const leadSpec = (f: Pick<RunnerFixture, 'spec'>, attemptId = 'lead-a1'): AttemptSpec =>
  f.spec({ attemptId, taskId: null, role: 'lead', branch: null, wipRef: null });

describe('the slots an attempt takes, as the hub counts them', () => {
  test("a lead's start is admitted on a full runner, and the lead takes no slot", async () => {
    const f = await createRunnerFixture();
    f.liveAttempts = f.config.capacity;
    const lead = f.controller('lead-a1');
    expect(await lead.start(leadSpec(f))).toEqual({ started: true });
    expect([lead.holdsSlot, lead.takesSlot]).toEqual([true, false]);
    const worker = await f.controller('T-4-a1').start(f.spec());
    expect(worker).toMatchObject({ started: false, refused: 'at_capacity' });
  });

  test('hold_attempt frees the slot the moment it arrives; a review resume takes it again', async () => {
    const f = await createRunnerFixture({ script: { turns: [[LONG_SLEEP], [LONG_SLEEP]] } });
    const controller = f.controller();
    const spec = f.spec();
    expect(await controller.start(spec)).toEqual({ started: true });
    await waitFor(() => controller.phase === 'turn');
    expect(controller.takesSlot).toBe(true);
    // The hub frees the slot as it records the submission, and sends hold_attempt in the same breath.
    const held = controller.hold({ fence: spec.fence });
    expect([controller.holdsSlot, controller.takesSlot]).toEqual([true, false]);
    expect(await held).toMatchObject({ ok: true });
    const resume = {
      fence: { epoch: 1, counter: 2 },
      agentToken: fixtureAgentToken('T-4-a1 resumed'),
      prompt: 'Review feedback: rename the helper.',
      messages: [],
      taskPack: '# T-4 Tidy the app, round 2\n',
      restore: spec.restore,
      acceptanceIds: ['A1'],
    };
    expect(await controller.resume(resume)).toEqual({ resumed: true });
    expect(controller.takesSlot).toBe(true);
  });

  test('a worker waiting for its quota takes no slot, and takes it again when the wait ends', async () => {
    const f = await createRunnerFixture({
      script: () => {
        const quota: VendorQuota = {
          state: 'exhausted',
          resetsAt: Date.now() + 1_500,
          windows: { fiveHour: 1, weekly: 0.4 },
          paidUsage: 'disabled',
          updatedAt: Date.now(),
        };
        return { turns: [[{ do: 'quota', quota, accountId: TEST_ACCOUNT_ID }, LONG_SLEEP], [LONG_SLEEP]] };
      },
    });
    const controller = f.controller();
    await controller.start(f.spec());
    await waitFor(() => controller.phase === 'quota_wait');
    expect([controller.holdsSlot, controller.takesSlot]).toEqual([true, false]);
    // At the reset the wait ends with attempt.quota ok, which moves the hub's attempt back to running.
    await waitFor(() => f.events('attempt.quota').length === 2, 10_000);
    expect(controller.takesSlot).toBe(true);
  });
});

describe("the runner's admission", () => {
  test('a start goes into the slot a held worker freed, and a lead runs beside a full capacity', async () => {
    const s = await setup();
    await s.start({ config: { capacity: 1 }, script: { turns: [[LONG_SLEEP]] } });
    await s.hub.waitFor(() => hellos(s.hub).length > 0);
    const spec = (n: number, counter: number) =>
      specOf(s, {
        attemptId: `T-${n}-a1`,
        taskId: `T-${n}`,
        branch: `agflow/T-${n}-x`,
        wipRef: `refs/agflow/T-${n}/a1`,
        fence: { epoch: 1, counter },
      });
    const first = spec(4, 1);
    expect(await run(s.hub, { kind: 'start_attempt', attempt: first })).toMatchObject({ ok: true });
    const lead = specOf(s, {
      attemptId: 'lead-a1',
      taskId: null,
      role: 'lead',
      branch: null,
      wipRef: null,
      fence: { epoch: 1, counter: 2 },
    });
    expect(await run(s.hub, { kind: 'start_attempt', attempt: lead })).toMatchObject({ ok: true });
    expect(await run(s.hub, { kind: 'start_attempt', attempt: spec(5, 3) })).toMatchObject({
      ok: false,
      error: 'the runner is at its capacity of 1 attempts',
    });
    // The hub records the submission and sends hold_attempt; the next start, right behind it, finds the slot free.
    s.hub.command({ kind: 'hold_attempt', attemptId: first.attemptId, fence: first.fence });
    expect(await run(s.hub, { kind: 'start_attempt', attempt: spec(6, 4) })).toMatchObject({ ok: true });
  });
});

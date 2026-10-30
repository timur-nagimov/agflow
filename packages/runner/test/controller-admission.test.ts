import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import {
  AttemptSpecSchema,
  parseRunnerEvent,
  RunnerCommandSchema,
  START_REFUSALS,
  type StartRefusal,
} from '@agflow/core';
import type { AttemptController } from '../src/attempt/controller';
import { SerialQueue } from '../src/queue';
import { defaultHealth, type RunnerHealth, silentNotifier, skipDependencyPreparer } from '../src/seams';
import { cleanupRunnerFixtures, createRunnerFixture } from './fixture';

afterEach(cleanupRunnerFixtures);

// Every test here runs git or agent processes, which take several times as long on a machine loaded by other suites.
setDefaultTimeout(30_000);

/** A promise and its resolve, for jobs the test releases by hand. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

describe('SerialQueue', () => {
  test("runs one attempt's work in order and different attempts' work concurrently", async () => {
    const queue = new SerialQueue();
    const order: string[] = [];
    const first = gate();
    const a1 = queue.run('T-4-a1', async () => {
      order.push('a1 start');
      await first.opened;
      order.push('a1 end');
    });
    const a2 = queue.run('T-4-a1', async () => {
      order.push('a2');
    });
    // Another attempt does not wait for T-4-a1's first job.
    await queue.run('T-5-a1', async () => {
      order.push('b1');
    });
    expect(order).toEqual(['a1 start', 'b1']);
    first.open();
    await Promise.all([a1, a2]);
    expect(order).toEqual(['a1 start', 'b1', 'a1 end', 'a2']);
  });

  test('a failed job does not block the next, and its caller gets the error', async () => {
    const queue = new SerialQueue();
    const failed = queue.run('T-4-a1', async () => {
      throw new Error('git failed');
    });
    const next = queue.run('T-4-a1', async () => 'ran');
    await expect(failed).rejects.toThrow('git failed');
    expect(await next).toBe('ran');
    await queue.idle('T-4-a1');
  });
});

describe('AttemptController admission', () => {
  test('draining, a full capacity and a vendor that is not ready are refused, and nothing starts', async () => {
    const f = await createRunnerFixture();
    f.config.draining = true;
    expect(await f.controller('T-4-a1').start(f.spec())).toMatchObject({ started: false, refused: 'draining' });
    f.config.draining = false;
    f.liveAttempts = f.config.capacity;
    const full = await f.controller('T-4-a2').start(f.spec({ attemptId: 'T-4-a2' }));
    expect(full).toMatchObject({ started: false, refused: 'at_capacity' });
    f.liveAttempts = 0;
    f.ready.codex = false;
    const codex = await f.controller('T-4-a3').start(f.spec({ attemptId: 'T-4-a3', vendor: 'codex' }));
    expect(codex).toMatchObject({ started: false, refused: 'vendor_not_ready' });
    const refused = f.events('attempt.failed_to_start');
    expect(refused.map((event) => [event.attemptId, event.data.refused])).toEqual([
      ['T-4-a1', 'draining'],
      ['T-4-a2', 'at_capacity'],
      ['T-4-a3', 'vendor_not_ready'],
    ]);
    expect(refused[0]?.fence).toEqual({ epoch: 1, counter: 1 });
    expect(f.events()).toHaveLength(3);
    expect(f.store.list()).toEqual([]);
    expect(f.fakes.claude?.launches).toEqual([]);
    expect(f.fakes.codex?.launches).toEqual([]);
  });

  test('two starts at once with one slot left: the first takes it, the second is refused at_capacity', async () => {
    const f = await createRunnerFixture();
    f.config.capacity = 1;
    const controllers: AttemptController[] = [];
    // The runtime's count: the other controllers that hold a slot.
    const liveAttempts = (self: string) => () =>
      controllers.filter((controller) => controller.attemptId !== self && controller.holdsSlot).length;
    // A seam that takes its time, as a disk check does.
    const health: RunnerHealth = {
      ...defaultHealth,
      admit: async () => {
        await Bun.sleep(20);
        return null;
      },
    };
    for (const attemptId of ['T-4-a1', 'T-5-a1']) {
      controllers.push(f.controller(attemptId, { health, liveAttempts: liveAttempts(attemptId) }));
    }
    const other = f.spec({ attemptId: 'T-5-a1', taskId: 'T-5', branch: 'agflow/T-5-x', wipRef: 'refs/agflow/T-5/a1' });
    const [first, second] = await Promise.all([controllers[0]?.start(f.spec()), controllers[1]?.start(other)]);
    expect(first).toEqual({ started: true });
    expect(second).toMatchObject({ started: false, refused: 'at_capacity' });
    expect(controllers[0]?.holdsSlot).toBe(true);
    expect(controllers[1]?.holdsSlot).toBe(false);
  });

  test('a seam refusal gives the slot back', async () => {
    const f = await createRunnerFixture();
    const controller = f.controller('T-4-a1', { health: { ...defaultHealth, admit: () => 'battery_low' } });
    expect(await controller.start(f.spec())).toMatchObject({ started: false, refused: 'battery_low' });
    expect(controller.holdsSlot).toBe(false);
  });

  test('a vendor with no adapter is not ready', async () => {
    const f = await createRunnerFixture();
    f.adapters.delete('codex');
    const result = await f.controller().start(f.spec({ vendor: 'codex' }));
    expect(result).toMatchObject({ started: false, refused: 'vendor_not_ready' });
  });

  test("the core's checks come first, then the health seam, whose refusal is reported with its code", async () => {
    const f = await createRunnerFixture();
    const asked: string[] = [];
    const health: RunnerHealth = {
      ...defaultHealth,
      admit: async (spec): Promise<StartRefusal> => {
        asked.push(spec.attemptId);
        return 'disk_low';
      },
    };
    f.config.draining = true;
    await f.controller('T-4-a1', { health }).start(f.spec());
    expect(asked).toEqual([]);
    f.config.draining = false;
    const result = await f.controller('T-4-a2', { health }).start(f.spec({ attemptId: 'T-4-a2' }));
    expect(result).toMatchObject({ started: false, refused: 'disk_low' });
    expect(asked).toEqual(['T-4-a2']);
    expect(f.events('attempt.failed_to_start').at(-1)?.data).toMatchObject({ refused: 'disk_low' });
    expect(f.store.get('T-4-a2')).toBeNull();
  });

  test('every START_REFUSALS code round-trips through parseRunnerEvent', async () => {
    const f = await createRunnerFixture();
    for (const [index, code] of START_REFUSALS.entries()) {
      const attemptId = `T-4-a${index + 1}`;
      const health: RunnerHealth = { ...defaultHealth, admit: () => code };
      await f.controller(attemptId, { health }).start(f.spec({ attemptId }));
    }
    const events = f.events('attempt.failed_to_start');
    expect(events).toHaveLength(START_REFUSALS.length);
    for (const [index, event] of events.entries()) {
      const parsed = parseRunnerEvent(JSON.parse(JSON.stringify(event)));
      expect(parsed.ok).toBe(true);
      if (parsed.ok && parsed.value.type === 'attempt.failed_to_start') {
        expect(parsed.value.data.refused).toBe(START_REFUSALS[index] as StartRefusal);
      }
    }
  });

  test('an admitted start is recorded as starting, with its fence', async () => {
    const f = await createRunnerFixture();
    const controller = f.controller();
    expect(controller.fence).toBeNull();
    expect(await controller.start(f.spec({ fence: { epoch: 1, counter: 7 } }))).toEqual({ started: true });
    expect(controller.fence).toEqual({ epoch: 1, counter: 7 });
    expect(f.store.get('T-4-a1')).toMatchObject({ state: 'starting', fence: { epoch: 1, counter: 7 } });
    expect(f.events('attempt.failed_to_start')).toEqual([]);
  });
});

describe('the fixture', () => {
  test("spec() builds a valid AttemptSpec, a worker's and a lead's, that a start_attempt carries", async () => {
    const f = await createRunnerFixture();
    const worker = f.spec();
    const lead = f.spec({ attemptId: 'lead-a1', taskId: null, role: 'lead', branch: null, wipRef: null });
    for (const spec of [worker, lead]) {
      expect(AttemptSpecSchema.safeParse(spec).success).toBe(true);
      expect(RunnerCommandSchema.safeParse({ kind: 'start_attempt', attempt: spec }).success).toBe(true);
    }
    expect(lead.agentToken).not.toBe(worker.agentToken);
  });
});

describe('seam defaults', () => {
  test('admit everything, report no power, disk or acceptingUntil and state ok, prepare and post nothing', async () => {
    const f = await createRunnerFixture();
    expect(await defaultHealth.admit(f.spec())).toBeNull();
    expect(defaultHealth.heartbeat()).toEqual({ power: null, disk: null, acceptingUntil: null });
    expect(defaultHealth.state()).toEqual({ state: 'ok', detail: null });
    expect(skipDependencyPreparer.available).toBe(false);
    const outcome = await skipDependencyPreparer.prepare({
      attemptId: 'T-4-a1',
      vendor: 'claude',
      clone: f.paths.clone('demo-0123456789', 'T-4-a1'),
      vault: f.vault,
      baseSha: f.origin.mainSha,
      env: {},
      requestId: null,
    });
    expect(outcome).toEqual({ ran: false, ok: true, error: null, logTail: null });
    expect(await silentNotifier.notify({ key: 'approval:1', title: 'Approval needed', body: 'T-4' })).toBeUndefined();
  });
});

import { describe, expect, test } from 'bun:test';
import { type Vendor, liveChatOnly, needsOpenProfile, protectedViolations, runnerForbiddenPaths } from '@agflow/core';
import { listAttempts } from '../src/attempt-store';
import { type HubContext, tx } from '../src/context';
import { DEMO_CHECK_PATHS, demoCheckContract, ensureDemoCheck } from '../src/demo-check';
import { listMessages } from '../src/messages';
import { setDeadline } from '../src/project';
import { runTick } from '../src/scheduler';
import { getTask, listTasks, move } from '../src/task-store';
import { cancelTask, updateTask } from '../src/tasks';
import { addRunner, addRunnerAttempt, createTestContext } from './helpers';

/** A task a runner attempt of the vendor finished: accepted, and merged when asked; returns its id. */
function finish(ctx: HubContext, vendor: Vendor, merged = false): string {
  const { task } = addRunnerAttempt(ctx, { vendor });
  tx(ctx, (emit) => {
    const submitted = move(ctx, emit, getTask(ctx, task.id), 'submitted', 'system');
    const accepted = move(ctx, emit, submitted, 'accepted', 'user:alice');
    if (merged) move(ctx, emit, accepted, 'merged', 'user:alice');
  });
  return task.id;
}

const demoChecks = (ctx: HubContext) => listTasks(ctx).filter((task) => task.createdBy === 'system');

describe('the demo check', () => {
  test('after every N tasks accepted, while nothing marks tasks merged, the hub creates one, by system', () => {
    const { ctx } = createTestContext({ demoCheckEvery: 3 });
    finish(ctx, 'claude');
    finish(ctx, 'claude');
    expect(ensureDemoCheck(ctx)).toBeNull();
    finish(ctx, 'codex');
    const check = ensureDemoCheck(ctx);
    expect(check).toMatchObject({
      title: 'Demo check after 3 tasks',
      createdBy: 'system',
      status: 'ready',
      kind: 'code',
      priority: 1,
      ownedPaths: [...DEMO_CHECK_PATHS],
      dependsOn: [],
    });
    // The clock reads 2026-10-26 12:00 UTC.
    const named = ['clean checkout of main', 'AGENTS.md', 'scripts/demo.sh', 'SPEC.md', 'docs/qa/2026-10-26-1200/'];
    for (const words of named) expect(check?.objective).toContain(words);
    expect(check?.acceptance.map((criterion) => criterion.id)).toEqual(['A1', 'A2', 'A3', 'A4']);
    // The lead is told what to do with its defects.
    const told = listMessages(ctx, {}).filter((message) => message.to === 'lead' && message.taskId === check?.id);
    expect(told.map((message) => message.from)).toEqual(['system']);
    expect(told[0]?.body).toContain('fix task');
  });

  test('not a second one while one is open; the next comes N tasks after the last one was created', () => {
    const { ctx } = createTestContext({ demoCheckEvery: 2 });
    finish(ctx, 'claude');
    finish(ctx, 'codex');
    const first = ensureDemoCheck(ctx);
    expect(first?.title).toBe('Demo check after 2 tasks');
    expect(ensureDemoCheck(ctx)).toBeNull();
    finish(ctx, 'claude');
    finish(ctx, 'codex');
    expect(ensureDemoCheck(ctx)).toBeNull();
    cancelTask(ctx, first?.id as string, 'the product does not start yet', 'user:alice');
    const second = ensureDemoCheck(ctx);
    expect(second?.title).toBe('Demo check after 4 tasks');
    expect(ensureDemoCheck(ctx)).toBeNull();
    expect(demoChecks(ctx).map((task) => task.title)).toEqual(['Demo check after 2 tasks', 'Demo check after 4 tasks']);
  });

  test('a closed check counts no tasks of its own, and the next waits for N more', () => {
    const { ctx } = createTestContext({ demoCheckEvery: 2 });
    finish(ctx, 'claude');
    finish(ctx, 'codex');
    const first = ensureDemoCheck(ctx);
    tx(ctx, (emit) => {
      const claimed = move(ctx, emit, getTask(ctx, first?.id as string), 'claimed', 'system');
      const submitted = move(ctx, emit, claimed, 'submitted', 'system');
      move(ctx, emit, submitted, 'accepted', 'user:alice');
    });
    expect(ensureDemoCheck(ctx)).toBeNull();
    finish(ctx, 'claude');
    expect(ensureDemoCheck(ctx)).toBeNull();
    finish(ctx, 'claude');
    expect(ensureDemoCheck(ctx)?.title).toBe('Demo check after 4 tasks');
  });

  test('a check keeps counting as one when someone renames it', () => {
    const { ctx } = createTestContext({ demoCheckEvery: 2 });
    finish(ctx, 'claude');
    finish(ctx, 'codex');
    const id = ensureDemoCheck(ctx)?.id as string;
    updateTask(ctx, id, { title: 'QA pass: run the product from main' }, 'user:alice');
    finish(ctx, 'claude');
    finish(ctx, 'codex');
    // Still open, so no second one.
    expect(ensureDemoCheck(ctx)).toBeNull();
    tx(ctx, (emit) => {
      const claimed = move(ctx, emit, getTask(ctx, id), 'claimed', 'system');
      const submitted = move(ctx, emit, claimed, 'submitted', 'system');
      move(ctx, emit, submitted, 'accepted', 'user:alice');
    });
    // Accepted, it is not one of the tasks done.
    expect(ensureDemoCheck(ctx)?.title).toBe('Demo check after 4 tasks');
  });

  test('once something marks tasks merged, merged tasks count, not accepted ones', () => {
    const { ctx } = createTestContext({ demoCheckEvery: 2 });
    finish(ctx, 'claude');
    finish(ctx, 'claude', true);
    // Two accepted, but only one merged.
    expect(ensureDemoCheck(ctx)).toBeNull();
    finish(ctx, 'codex', true);
    expect(ensureDemoCheck(ctx)?.title).toBe('Demo check after 2 tasks');
  });

  test('with auto merge, only merged tasks count: accepted work is not on main yet', () => {
    const { ctx } = createTestContext({ demoCheckEvery: 2, autoMerge: true });
    const first = finish(ctx, 'claude');
    const second = finish(ctx, 'codex');
    expect(ensureDemoCheck(ctx)).toBeNull();
    tx(ctx, (emit) => {
      for (const id of [first, second]) move(ctx, emit, getTask(ctx, id), 'merged', 'user:alice');
    });
    expect(ensureDemoCheck(ctx)?.title).toBe('Demo check after 2 tasks');
  });

  test('owns no protected path under any runner profile, so any runner may take it', () => {
    const contract = demoCheckContract(5, Date.UTC(2026, 10, 15, 14, 30), null);
    const check = { ownedPaths: contract.ownedPaths, kind: contract.kind, createdBy: 'system' };
    const changed = ['docs/STATUS.md', 'docs/qa/2026-11-15-1430/home.png', 'scripts/demo.sh'];
    for (const profile of ['standard', 'auto', 'open'] as const) {
      expect([profile, runnerForbiddenPaths(check, profile), protectedViolations(changed, check, profile)]).toEqual([
        profile,
        [],
        [],
      ]);
    }
    expect([liveChatOnly(check), needsOpenProfile(check)]).toEqual([false, false]);
  });

  test('is off at 0, and in a config built without it', () => {
    for (const overrides of [{ demoCheckEvery: 0 }, {}]) {
      const { ctx } = createTestContext(overrides);
      for (let n = 0; n < 6; n++) finish(ctx, 'claude', true);
      expect(ensureDemoCheck(ctx)).toBeNull();
      expect(demoChecks(ctx)).toEqual([]);
    }
  });

  test('its vendor hint is the vendor that implemented fewer of the last N tasks, and none on a tie', () => {
    const { ctx } = createTestContext({ demoCheckEvery: 3 });
    finish(ctx, 'codex');
    finish(ctx, 'codex');
    finish(ctx, 'claude');
    const first = ensureDemoCheck(ctx);
    expect(first?.vendorHint).toBe('claude');
    cancelTask(ctx, first?.id as string, 'next one', 'user:alice');
    // Only the last three count: claude twice and codex once.
    finish(ctx, 'claude');
    finish(ctx, 'claude');
    finish(ctx, 'codex');
    const second = ensureDemoCheck(ctx);
    expect(second?.vendorHint).toBe('codex');

    const even = createTestContext({ demoCheckEvery: 2 }).ctx;
    finish(even, 'claude');
    finish(even, 'codex');
    expect(ensureDemoCheck(even)?.vendorHint).toBeUndefined();
  });

  test('in the last hour before the deadline one task done is enough; before that hour and after the deadline, N', () => {
    const { ctx, clock } = createTestContext({ demoCheckEvery: 5 });
    const hour = 60 * 60_000;
    setDeadline(ctx, ctx.now() + 2 * hour, 'user:alice');
    finish(ctx, 'claude');
    expect(ensureDemoCheck(ctx)).toBeNull();
    clock.advance(hour);
    const first = ensureDemoCheck(ctx);
    expect(first?.title).toBe('Demo check after 1 task');
    cancelTask(ctx, first?.id as string, 'next one', 'user:alice');
    finish(ctx, 'codex');
    const second = ensureDemoCheck(ctx);
    expect(second?.title).toBe('Demo check after 2 tasks');
    cancelTask(ctx, second?.id as string, 'next one', 'user:alice');
    clock.advance(hour);
    finish(ctx, 'claude');
    expect(ensureDemoCheck(ctx)).toBeNull();
    // Off stays off.
    const off = createTestContext({ demoCheckEvery: 0 });
    setDeadline(off.ctx, off.ctx.now() + hour, 'user:alice');
    finish(off.ctx, 'claude');
    expect(ensureDemoCheck(off.ctx)).toBeNull();
  });

  test('the tick creates it before dispatch', () => {
    const { ctx } = createTestContext({ demoCheckEvery: 1 });
    ctx.db.run('UPDATE project SET runner_leads = 0 WHERE id = 1');
    finish(ctx, 'claude');
    // A free runner with both vendors: the check's hint, codex, is there at once, so it need not wait for it.
    addRunner(ctx, { vendors: ['claude', 'codex'] });
    runTick(ctx);
    const [check] = demoChecks(ctx);
    expect(check?.title).toBe('Demo check after 1 task');
    // So the check started in the same tick, on the vendor that implemented fewer tasks.
    expect(getTask(ctx, check?.id as string).status).toBe('claimed');
    expect(listAttempts(ctx, { task: check?.id as string }).map((attempt) => attempt.vendor)).toEqual(['codex']);
  });
});

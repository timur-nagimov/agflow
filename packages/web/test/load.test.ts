import { describe, expect, test } from 'bun:test';
import { type AccountLoad, type HubLoad, PLACEMENT_REFUSALS, type ProjectLoad } from '@agflow/core';
import { createApi } from '../src/api';
import {
  accountName,
  accountStateText,
  accountTone,
  deadlineText,
  overCeiling,
  queueText,
  resetText,
  slotText,
  slotsText,
  stripNumbers,
  windowText,
  workerLimit,
  workersText,
} from '../src/load';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// 14:00 local time, so the clock times below read the same in every time zone.
const NOW = new Date(2026, 9, 29, 14, 0).getTime();

function account(overrides: Partial<AccountLoad> = {}): AccountLoad {
  return {
    owner: 'alice',
    vendor: 'claude',
    accountId: 'a1b2c3d4e5f60718',
    plan: 'Claude Max',
    busy: 1,
    capacity: 2,
    fiveHour: 0.42,
    weekly: 0.1,
    ceilings: { fiveHour: 0.85, weekly: 0.85 },
    resetsAt: NOW + 2 * HOUR,
    state: 'ok',
    ...overrides,
  };
}

function project(overrides: Partial<ProjectLoad> = {}): ProjectLoad {
  return {
    workers: { running: 2, target: null, cap: 4 },
    slots: { capacity: 6, busy: 4, idle: 2 },
    idleSlotMinutes: 12.5,
    tasks: {
      ready: 3,
      dispatchable: 1,
      blockedOnDependencies: 4,
      submitted: { count: 2, oldestAgeMs: 12 * MINUTE },
      acceptedNotMerged: { count: 0, oldestAgeMs: null },
      mergedLastHour: 5,
    },
    deadline: { at: null, leftMs: null },
    ...overrides,
  };
}

describe('the Load page', () => {
  test('an account reads as owner, vendor and plan, with its slots and both windows against the ceilings', () => {
    expect(accountName(account())).toBe('alice · Claude Code · Claude Max');
    expect(accountName(account({ vendor: 'codex', plan: null }))).toBe('alice · Codex');
    expect(slotText(account())).toBe('1 of 2');
    expect(windowText(0.42, 0.85)).toBe('42% of 85%');
    expect(windowText(null, 0.85)).toBe('unknown of 85%');
    expect([overCeiling(0.9, 0.85), overCeiling(0.85, 0.85), overCeiling(0.5, 0.85), overCeiling(null, 0)]).toEqual([
      true,
      true,
      false,
      false,
    ]);
    expect(resetText(NOW + 2 * HOUR, NOW)).toBe('16:00');
    expect(resetText(null, NOW)).toBe('unknown');
  });

  test("an account's state is Ready, or placement's refusal in words, each with a tone", () => {
    expect([accountStateText('ok'), accountTone('ok')]).toEqual(['Ready', 'done']);
    expect([accountStateText('full'), accountTone('full')]).toEqual(['Full', 'active']);
    expect([accountStateText('offline'), accountTone('offline')]).toEqual(['Offline', 'closed']);
    expect([accountStateText('exhausted'), accountTone('exhausted')]).toEqual(['Quota used up', 'wait']);
    expect(accountStateText('ceiling')).toBe('At its quota ceiling');
    for (const refusal of PLACEMENT_REFUSALS) expect(accountStateText(refusal)).toMatch(/^[A-Z]/);
  });

  test("the project's workers, slots, queues and deadline", () => {
    expect(workersText({ running: 2, target: null, cap: 4 })).toBe('2 running of 4, the cap');
    expect(workersText({ running: 1, target: 3, cap: 4 })).toBe("1 running of 3, the lead's target (the cap is 4)");
    expect(workerLimit({ running: 1, target: 0, cap: 4 })).toBe(0);
    expect(slotsText({ capacity: 6, busy: 4, idle: 2 })).toBe('4 of 6 taken, 2 free');
    expect(queueText({ count: 2, oldestAgeMs: 12 * MINUTE })).toBe('2, the oldest for 12 min');
    expect(queueText({ count: 0, oldestAgeMs: null })).toBe('none');
    expect(deadlineText({ at: null, leftMs: null }, NOW)).toBe('none set');
    expect(deadlineText({ at: NOW + 5 * HOUR + 20 * MINUTE, leftMs: 5 * HOUR + 20 * MINUTE }, NOW)).toBe(
      '19:20, 5 h 20 min left',
    );
    expect(deadlineText({ at: NOW - 10 * MINUTE, leftMs: -10 * MINUTE }, NOW)).toBe('13:50, passed 10 min ago');
  });

  test('the strip shows workers running of the limit, the ready tasks and the free slots', () => {
    const load: HubLoad = { now: NOW, accounts: [account()], project: project() };
    expect(stripNumbers(load)).toEqual({ workers: '2/4', ready: 3, dispatchable: 1, idle: 2 });
    const targeted = { ...load, project: project({ workers: { running: 1, target: 2, cap: 4 } }) };
    expect(stripNumbers(targeted).workers).toBe('1/2');
  });

  test('the page reads GET /api/load', async () => {
    const calls: string[] = [];
    const api = createApi(async (input) => {
      calls.push(input);
      return new Response(JSON.stringify({ now: NOW, accounts: [], project: project() }));
    });
    expect((await api.load()).project.tasks.ready).toBe(3);
    expect(calls).toEqual(['/api/load']);
  });
});

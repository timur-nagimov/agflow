import { describe, expect, test } from 'bun:test';
import {
  TASK_TRANSITIONS,
  TransitionError,
  assertTransition,
  canTransition,
  isClosed,
  isDone,
  isHeld,
} from '../src/task-state';
import type { TaskStatus } from '../src/types';

const ALL: TaskStatus[] = [
  'draft', 'ready', 'claimed', 'working', 'submitted', 'checking', 'reviewing',
  'accepted', 'merging', 'merged', 'rejected', 'stale', 'blocked', 'cancelled', 'failed',
];

describe('task state machine', () => {
  test('defines transitions for every status', () => {
    expect(Object.keys(TASK_TRANSITIONS).sort()).toEqual([...ALL].sort());
  });

  test('allows the M1 happy path', () => {
    const path: TaskStatus[] = ['ready', 'claimed', 'working', 'submitted', 'accepted', 'merged'];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i] as TaskStatus, path[i + 1] as TaskStatus)).toBe(true);
    }
  });

  test('rejected work can return to its author or to the pool', () => {
    expect(canTransition('rejected', 'claimed')).toBe(true);
    expect(canTransition('rejected', 'ready')).toBe(true);
  });

  test('work cannot skip review', () => {
    expect(canTransition('ready', 'accepted')).toBe(false);
    expect(canTransition('working', 'accepted')).toBe(false);
  });

  test('terminal statuses have no exits', () => {
    for (const status of ['merged', 'cancelled', 'failed'] as TaskStatus[]) {
      expect(TASK_TRANSITIONS[status]).toEqual([]);
    }
  });

  test('assertTransition throws a TransitionError with both statuses', () => {
    expect(() => assertTransition('ready', 'merged')).toThrow(TransitionError);
    expect(() => assertTransition('ready', 'merged')).toThrow('a task cannot move from ready to merged');
  });

  test('status predicates', () => {
    expect(isHeld('claimed')).toBe(true);
    expect(isHeld('working')).toBe(true);
    expect(isHeld('submitted')).toBe(false);
    expect(isDone('accepted')).toBe(true);
    expect(isDone('submitted')).toBe(false);
    expect(isClosed('cancelled')).toBe(true);
    expect(isClosed('blocked')).toBe(false);
  });
});

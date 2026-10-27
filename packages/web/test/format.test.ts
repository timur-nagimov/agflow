import { describe, expect, test } from 'bun:test';
import type { Task } from '@agflow/core';
import { actionBody, actionHint, actionsFor, columnCounts, columnOf, groupTasks, statusLabel } from '../src/format';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'T-1',
    title: 'Parser',
    kind: 'code',
    objective: 'Parse input',
    why: '',
    nonGoals: [],
    acceptance: [{ id: 'A1', assertion: 'parses' }],
    checks: [],
    ownedPaths: [],
    dependsOn: [],
    priority: 5,
    status: 'ready',
    assignee: null,
    branch: null,
    goalVersion: 1,
    leaseExpiresAt: null,
    blockedKind: null,
    blockedReason: null,
    submission: null,
    feedback: null,
    mergedSha: null,
    createdBy: 'agent:A-1',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('board columns', () => {
  test('a task waiting on dependencies is still to do; one blocked by its agent needs attention', () => {
    expect(columnOf(task({ status: 'blocked', blockedKind: 'deps' }))).toBe('todo');
    expect(columnOf(task({ status: 'blocked', blockedKind: 'agent' }))).toBe('attention');
    expect(columnOf(task({ status: 'blocked', blockedKind: 'impossible' }))).toBe('attention');
    expect(statusLabel('blocked', 'deps')).toBe('Waiting');
    expect(statusLabel('blocked', 'agent')).toBe('Blocked');
  });

  test('every status lands in a column', () => {
    expect(columnOf(task({ status: 'working' }))).toBe('doing');
    expect(columnOf(task({ status: 'submitted' }))).toBe('review');
    expect(columnOf(task({ status: 'merged' }))).toBe('done');
    expect(columnOf(task({ status: 'cancelled' }))).toBe('closed');
  });

  test('open columns sort by priority (0 first), finished ones by recency', () => {
    const groups = groupTasks([
      task({ id: 'T-1', priority: 5 }),
      task({ id: 'T-2', priority: 0 }),
      task({ id: 'T-3', priority: 5 }),
      task({ id: 'T-4', status: 'accepted', updatedAt: 1 }),
      task({ id: 'T-5', status: 'merged', updatedAt: 2 }),
    ]);
    expect(groups.todo.map((t) => t.id)).toEqual(['T-2', 'T-1', 'T-3']);
    expect(groups.done.map((t) => t.id)).toEqual(['T-5', 'T-4']);
    expect(columnCounts([task(), task({ status: 'working' })])).toMatchObject({ todo: 1, doing: 1, done: 0 });
  });
});

describe('task actions', () => {
  test('people get the actions that fit the status', () => {
    expect(actionsFor(task({ status: 'submitted' }))).toEqual(['accept', 'reject', 'cancel']);
    expect(actionsFor(task({ status: 'accepted' }))).toEqual(['merged']);
    expect(actionsFor(task({ status: 'blocked' }))).toEqual(['unblock', 'cancel']);
    expect(actionsFor(task({ status: 'working' }))).toEqual(['release', 'cancel']);
    expect(actionsFor(task({ status: 'ready' }))).toEqual(['cancel']);
    expect(actionsFor(task({ status: 'merged' }))).toEqual([]);
  });

  test('a hint explains what the actions are for', () => {
    expect(actionHint(task({ status: 'working', assignee: 'A-2' }))).toBe(
      'A-2 is working on this. Release the claim only if the agent is stuck or gone.',
    );
    expect(actionHint(task({ status: 'accepted' }))).toBe('Accepted. Merge its branch, then mark it merged.');
    expect(actionHint(task({ status: 'ready' }))).toBe('');
  });

  test('bodies carry the text in the right field, and required text is enforced', () => {
    expect(actionBody('reject', '  Add tests. ')).toEqual({ feedback: 'Add tests.' });
    expect(actionBody('reject', '   ')).toBeNull();
    expect(actionBody('accept', '')).toEqual({});
    expect(actionBody('merged', 'abc1234')).toEqual({ sha: 'abc1234' });
    expect(actionBody('release', 'went home')).toEqual({ reason: 'went home' });
  });
});

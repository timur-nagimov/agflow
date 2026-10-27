import { describe, expect, test } from 'bun:test';
import { updateGoal } from '../src/goal';
import { sendMessage } from '../src/messages';
import { search } from '../src/search';
import { createTasks } from '../src/tasks';
import { createTestContext, newTask } from './helpers';

describe('search', () => {
  test('finds tasks by words in their contract and by id', () => {
    const { ctx } = createTestContext();
    createTasks(ctx, [newTask({ title: 'Token refresh' }), newTask({ title: 'Billing export' })], 'user:alice');
    expect(search(ctx, 'refresh').tasks.map((task) => task.title)).toEqual(['Token refresh']);
    expect(search(ctx, 't-2').tasks.map((task) => task.id)).toEqual(['T-2']);
  });

  test('a search by task id lists that task first, even when newer tasks mention it', () => {
    const { ctx } = createTestContext();
    createTasks(ctx, [newTask({ title: 'First' }), newTask({ title: 'Second' })], 'user:alice');
    // More tasks than one page of results, all newer than T-2 and all naming it in their contract.
    const followUps = Array.from({ length: 21 }, (_, index) =>
      newTask({ title: `Follow-up ${index + 1}`, dependsOn: ['T-2'] }),
    );
    createTasks(ctx, followUps, 'user:alice');
    const { tasks } = search(ctx, 't-2');
    expect(tasks).toHaveLength(20);
    expect(tasks[0]?.id).toBe('T-2');
    expect(tasks[1]?.id).toBe('T-23');
  });

  test('finds messages and a goal snippet', () => {
    const { ctx } = createTestContext();
    updateGoal(ctx, { text: 'Build a CLI that syncs calendars.', baseVersion: 0 }, 'user:alice');
    sendMessage(ctx, { from: 'user:alice', to: 'lead', body: 'Calendars must be read-only.' });
    const result = search(ctx, 'calendars');
    expect(result.messages.map((message) => message.body)).toContain('Calendars must be read-only.');
    expect(result.goal).toEqual({ version: 1, snippet: 'Build a CLI that syncs calendars.' });
  });

  test('treats % and _ literally', () => {
    const { ctx } = createTestContext();
    createTasks(ctx, [newTask({ title: '100% coverage' }), newTask({ title: 'plain' })], 'user:alice');
    expect(search(ctx, '100%').tasks.map((task) => task.title)).toEqual(['100% coverage']);
    expect(search(ctx, '_').tasks).toEqual([]);
  });

  test('an empty query returns nothing', () => {
    const { ctx } = createTestContext();
    expect(search(ctx, '   ')).toEqual({ tasks: [], messages: [], goal: null });
  });
});

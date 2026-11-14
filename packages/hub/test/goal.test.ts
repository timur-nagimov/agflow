import { describe, expect, test } from 'bun:test';
import { HubError } from '../src/errors';
import { listEvents } from '../src/events';
import {
  GOAL_CUT,
  addGoalNote,
  clipGoal,
  currentGoalVersion,
  getCurrentGoal,
  listGoalNotes,
  listGoalVersions,
  updateGoal,
} from '../src/goal';
import { listMessages } from '../src/messages';
import { createTestContext } from './helpers';

describe('goal', () => {
  test('starts empty', () => {
    const { ctx } = createTestContext();
    expect(getCurrentGoal(ctx)).toBeNull();
    expect(currentGoalVersion(ctx)).toBe(0);
  });

  test('the first goal becomes v1 and asks the lead to plan', () => {
    const { ctx } = createTestContext();
    const goal = updateGoal(ctx, { text: 'Ship a CLI.', baseVersion: 0 }, 'user:alice');
    expect(goal).toMatchObject({ version: 1, text: 'Ship a CLI.', author: 'user:alice' });
    const [message] = listMessages(ctx, { target: 'lead' });
    expect(message?.from).toBe('system');
    expect(message?.body).toContain('create_tasks');
    expect(message?.body).toContain('Before you plan, read the whole goal with get_goal, and SPEC.md in the repository');
    expect(message?.body).not.toContain(GOAL_CUT);
  });

  test('a long first goal is cut in the message, which says so and names get_goal', () => {
    const { ctx } = createTestContext();
    const text = `${'requirement\n'.repeat(1000)}the last line`;
    updateGoal(ctx, { text, baseVersion: 0 }, 'user:alice');
    const [message] = listMessages(ctx, { target: 'lead' });
    expect(message?.body).toContain(`${clipGoal(text, 4000)}\n\nBefore you plan`);
    expect(message?.body).toContain(`${GOAL_CUT}\n\nBefore you plan`);
    expect(message?.body).not.toContain('the last line');
    expect(getCurrentGoal(ctx)?.text).toBe(text);
  });

  test('clipGoal keeps a goal that fits and ends a cut one with GOAL_CUT, within the limit', () => {
    expect(clipGoal('Ship a CLI.', 11)).toBe('Ship a CLI.');
    const cut = clipGoal('x'.repeat(5000), 2500);
    expect(cut).toHaveLength(2500);
    expect(cut).toEndWith('… cut here: call `get_goal` for the whole goal.');
    // With less room than the cut line takes, the cut line alone remains.
    expect(clipGoal('x'.repeat(100), 10)).toBe(GOAL_CUT);
  });

  test('an edit against an old version is a conflict', () => {
    const { ctx } = createTestContext();
    updateGoal(ctx, { text: 'v1', baseVersion: 0 }, 'user:alice');
    updateGoal(ctx, { text: 'v2', baseVersion: 1 }, 'user:alice');
    expect(() => updateGoal(ctx, { text: 'late', baseVersion: 1 }, 'user:bob')).toThrow(HubError);
    expect(currentGoalVersion(ctx)).toBe(2);
  });

  test('saving identical text creates no version', () => {
    const { ctx } = createTestContext();
    updateGoal(ctx, { text: 'same', baseVersion: 0 }, 'user:alice');
    updateGoal(ctx, { text: 'same', baseVersion: 1 }, 'user:alice');
    expect(listGoalVersions(ctx)).toHaveLength(1);
  });

  test('an edit records the diff and tells the lead', () => {
    const { ctx } = createTestContext();
    updateGoal(ctx, { text: 'Ship a CLI.\nUse Bun.', baseVersion: 0 }, 'user:alice');
    updateGoal(ctx, { text: 'Ship a CLI.\nUse Node.', baseVersion: 1 }, 'user:alice');
    const event = listEvents(ctx.db).filter((e) => e.type === 'goal.updated').at(-1);
    expect(event?.data).toMatchObject({ version: 2, previousVersion: 1, changes: '- Use Bun.\n+ Use Node.' });
    const latest = listMessages(ctx, { target: 'lead' })[0];
    expect(latest?.body).toContain('from v1 to v2');
    expect(latest?.body).toContain('+ Use Node.');
  });

  test('versions are listed newest first and notes attach to the current version', () => {
    const { ctx } = createTestContext();
    updateGoal(ctx, { text: 'a', baseVersion: 0 }, 'user:alice');
    updateGoal(ctx, { text: 'b', baseVersion: 1 }, 'user:alice');
    addGoalNote(ctx, 'Reading "b" as the CLI only.', 'agent:A-1');
    expect(listGoalVersions(ctx).map((v) => v.version)).toEqual([2, 1]);
    expect(listGoalNotes(ctx, 2).map((n) => n.text)).toEqual(['Reading "b" as the CLI only.']);
    expect(listGoalNotes(ctx, 1)).toEqual([]);
  });
});

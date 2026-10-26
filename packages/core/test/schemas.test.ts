import { describe, expect, test } from 'bun:test';
import {
  ClaimInputSchema,
  NewTaskSchema,
  SendMessageInputSchema,
  StopCheckInputSchema,
  SubmitInputSchema,
  TaskPatchSchema,
} from '../src/schemas';
import { parseTarget } from '../src/targets';

describe('parseTarget', () => {
  test('parses every target form', () => {
    expect(parseTarget('lead')).toEqual({ kind: 'lead' });
    expect(parseTarget('all')).toEqual({ kind: 'all' });
    expect(parseTarget('humans')).toEqual({ kind: 'humans' });
    expect(parseTarget('agent:A-3')).toEqual({ kind: 'agent', id: 'A-3' });
    expect(parseTarget('task:T-12')).toEqual({ kind: 'task', id: 'T-12' });
  });

  test('rejects anything else', () => {
    expect(parseTarget('agent:bob')).toBeNull();
    expect(parseTarget('everyone')).toBeNull();
    expect(parseTarget('task:12')).toBeNull();
  });
});

describe('NewTaskSchema', () => {
  test('fills defaults for a minimal task', () => {
    const task = NewTaskSchema.parse({
      title: 'Add login',
      objective: 'Users can sign in',
      acceptance: [{ id: 'A1', assertion: 'Sign-in works' }],
    });
    expect(task.kind).toBe('code');
    expect(task.why).toBe('');
    expect(task.priority).toBe(5);
    expect(task.dependsOn).toEqual([]);
    expect(task.ownedPaths).toEqual([]);
  });

  test('accepts batch references in dependsOn', () => {
    const task = NewTaskSchema.parse({
      title: 't',
      objective: 'o',
      acceptance: [{ id: 'A1', assertion: 'a' }],
      dependsOn: ['#1', 'T-4'],
    });
    expect(task.dependsOn).toEqual(['#1', 'T-4']);
  });

  test('requires at least one acceptance criterion', () => {
    expect(NewTaskSchema.safeParse({ title: 't', objective: 'o', acceptance: [] }).success).toBe(false);
  });
});

describe('other schemas', () => {
  test('an empty task patch is rejected', () => {
    expect(TaskPatchSchema.safeParse({}).success).toBe(false);
    expect(TaskPatchSchema.safeParse({ priority: 1 }).success).toBe(true);
  });

  test('task patches cannot use batch references', () => {
    expect(TaskPatchSchema.safeParse({ dependsOn: ['#1'] }).success).toBe(false);
  });

  test('messages need a valid target', () => {
    expect(SendMessageInputSchema.safeParse({ to: 'lead', body: 'hi' }).success).toBe(true);
    expect(SendMessageInputSchema.safeParse({ to: 'agent:x', body: 'hi' }).success).toBe(false);
  });

  test('stop checks default stopHookActive to false', () => {
    expect(StopCheckInputSchema.parse({ vendor: 'codex', sessionId: 's' }).stopHookActive).toBe(false);
  });

  test('branches and commit shas are validated', () => {
    expect(ClaimInputSchema.safeParse({ branch: 'agflow/T-1-login' }).success).toBe(true);
    expect(ClaimInputSchema.safeParse({ branch: 'bad branch' }).success).toBe(false);
    expect(SubmitInputSchema.safeParse({ summary: 's', headSha: 'abc1234' }).success).toBe(true);
    expect(SubmitInputSchema.safeParse({ summary: 's', headSha: 'xyz' }).success).toBe(false);
  });
});

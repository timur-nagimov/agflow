import { describe, expect, test } from 'bun:test';
import { type ZodType, prettifyError } from 'zod';
import {
  AckInputSchema,
  ClaimInputSchema,
  CliLoginApproveInputSchema,
  CreateTasksInputSchema,
  FeedbackInputSchema,
  GoalDiffQuerySchema,
  GoalNoteInputSchema,
  HandoffInputSchema,
  HelloInputSchema,
  ImpossibleInputSchema,
  LiveSessionQuerySchema,
  MarkMergedInputSchema,
  NewTaskSchema,
  NoteInputSchema,
  PauseInputSchema,
  ProgressInputSchema,
  ReasonInputSchema,
  SendMessageInputSchema,
  SessionStartInputSchema,
  StopCheckInputSchema,
  SubmitInputSchema,
  TaskPatchSchema,
  UpdateGoalInputSchema,
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

describe('unknown keys', () => {
  const task = { title: 't', objective: 'o', acceptance: [{ id: 'A1', assertion: 'a' }] };

  // One minimal valid body per request-body schema.
  const bodies: Array<[string, ZodType, object]> = [
    ['NewTaskSchema', NewTaskSchema, task],
    ['CreateTasksInputSchema', CreateTasksInputSchema, { tasks: [task] }],
    ['TaskPatchSchema', TaskPatchSchema, { priority: 1 }],
    ['UpdateGoalInputSchema', UpdateGoalInputSchema, { text: 'goal', baseVersion: 0 }],
    ['GoalNoteInputSchema', GoalNoteInputSchema, { text: 'note' }],
    ['PauseInputSchema', PauseInputSchema, { paused: true }],
    ['SendMessageInputSchema', SendMessageInputSchema, { to: 'lead', body: 'hi' }],
    ['AckInputSchema', AckInputSchema, { ids: [1] }],
    ['ClaimInputSchema', ClaimInputSchema, {}],
    ['ProgressInputSchema', ProgressInputSchema, { note: 'n' }],
    ['SubmitInputSchema', SubmitInputSchema, { summary: 's' }],
    ['ReasonInputSchema', ReasonInputSchema, { reason: 'r' }],
    ['ImpossibleInputSchema', ImpossibleInputSchema, { evidence: 'e' }],
    ['HandoffInputSchema', HandoffInputSchema, { note: 'n' }],
    ['FeedbackInputSchema', FeedbackInputSchema, { feedback: 'f' }],
    ['NoteInputSchema', NoteInputSchema, {}],
    ['MarkMergedInputSchema', MarkMergedInputSchema, {}],
    ['SessionStartInputSchema', SessionStartInputSchema, { vendor: 'claude', sessionId: 's' }],
    ['HelloInputSchema', HelloInputSchema, { code: 'ABCDEF' }],
    ['StopCheckInputSchema', StopCheckInputSchema, { vendor: 'codex', sessionId: 's' }],
    ['CliLoginApproveInputSchema', CliLoginApproveInputSchema, { code: 'x'.repeat(32) }],
  ];

  for (const [name, schema, body] of bodies) {
    test(`${name} rejects a key it does not know`, () => {
      expect(schema.safeParse(body).success).toBe(true);
      expect(schema.safeParse({ ...body, bogus: 1 }).success).toBe(false);
    });
  }

  test('snake_case keys from the spec are rejected, not silently dropped', () => {
    expect(NewTaskSchema.safeParse({ ...task, depends_on: ['T-1'] }).success).toBe(false);
    expect(NewTaskSchema.safeParse({ ...task, owned_paths: ['src/auth/**'] }).success).toBe(false);
    expect(NewTaskSchema.safeParse({ ...task, non_goals: ['x'] }).success).toBe(false);
    expect(TaskPatchSchema.safeParse({ title: 'T', owned_paths: ['x'] }).success).toBe(false);
    expect(
      StopCheckInputSchema.safeParse({ vendor: 'claude', sessionId: 's', stop_hook_active: true }).success,
    ).toBe(false);
  });

  test('the error names the unknown key, so the 400 tells the caller what to fix', () => {
    const result = NewTaskSchema.safeParse({ ...task, depends_on: ['T-1'] });
    expect(result.success).toBe(false);
    if (!result.success) expect(prettifyError(result.error)).toContain('depends_on');
  });

  test('nested contract objects are strict too', () => {
    const check = { name: 'unit', cmd: 'bun test' };
    expect(NewTaskSchema.safeParse({ ...task, checks: [check] }).success).toBe(true);
    expect(NewTaskSchema.safeParse({ ...task, checks: [{ ...check, timeout_s: 900 }] }).success).toBe(false);
    expect(NewTaskSchema.safeParse({ ...task, checks: [{ ...check, timeoutS: 900 }] }).success).toBe(true);
    const evidence = { kind: 'command', cmd: 'bun test', expect: 'exit 0' };
    const withEvidence = (extra: object) => ({
      ...task,
      acceptance: [{ id: 'A1', assertion: 'a', evidence: { ...evidence, ...extra } }],
    });
    expect(NewTaskSchema.safeParse(withEvidence({})).success).toBe(true);
    expect(NewTaskSchema.safeParse(withEvidence({ command: 'x' })).success).toBe(false);
    expect(
      NewTaskSchema.safeParse({ ...task, acceptance: [{ id: 'A1', assertion: 'a', assert: 'b' }] }).success,
    ).toBe(false);
  });

  test('query schemas stay loose, because proxies and caches add parameters', () => {
    expect(LiveSessionQuerySchema.safeParse({ vendor: 'claude', sessionId: 's', t: '1' }).success).toBe(true);
    expect(GoalDiffQuerySchema.safeParse({ from: '1', to: '2', t: '1' }).success).toBe(true);
  });
});

describe('ownedPaths', () => {
  const task = { title: 't', objective: 'o', acceptance: [{ id: 'A1', assertion: 'a' }] };

  test('accept repo-relative globs', () => {
    const supported = [
      'src/auth/**',
      './docs/*.md',
      'README.md',
      'src/{auth,billing}/**',
      'packages/@acme/core/**',
    ];
    for (const path of supported) {
      expect(NewTaskSchema.safeParse({ ...task, ownedPaths: [path] }).success).toBe(true);
    }
  });

  test('reject syntax the overlap test cannot reason about', () => {
    const unsupported = [
      '/abs/**',
      '../outside/**',
      'src/../docs/**',
      '!docs/**',
      './!docs/**',
      'src\\auth\\**',
      'src/@(auth|billing)/**',
      'src/auth|docs/**',
    ];
    for (const path of unsupported) {
      expect(NewTaskSchema.safeParse({ ...task, ownedPaths: [path] }).success).toBe(false);
      expect(TaskPatchSchema.safeParse({ ownedPaths: [path] }).success).toBe(false);
    }
  });
});

import { describe, expect, test } from 'bun:test';
import { formatMessages } from '../src/format';
import { pathsOverlap, patternPrefix } from '../src/paths';
import type { Message } from '../src/types';

describe('patternPrefix', () => {
  test('keeps the literal part before the first wildcard', () => {
    expect(patternPrefix('src/auth/**')).toBe('src/auth/');
    expect(patternPrefix('./docs/*.md')).toBe('docs/');
    expect(patternPrefix('README.md')).toBe('README.md');
    expect(patternPrefix('**/*.ts')).toBe('');
  });
});

describe('pathsOverlap', () => {
  test('separate folders do not overlap', () => {
    expect(pathsOverlap(['src/auth/**'], ['src/billing/**'])).toBe(false);
  });

  test('a folder overlaps files inside it', () => {
    expect(pathsOverlap(['src/**'], ['src/auth/login.ts'])).toBe(true);
  });

  test('a leading wildcard overlaps everything', () => {
    expect(pathsOverlap(['**/*.ts'], ['docs/readme.md'])).toBe(true);
  });

  test('sibling files with a shared stem do not overlap', () => {
    expect(pathsOverlap(['src/auth.ts'], ['src/auth.test.ts'])).toBe(false);
  });

  test('empty lists never overlap', () => {
    expect(pathsOverlap([], ['src/**'])).toBe(false);
  });
});

describe('formatMessages', () => {
  const base: Message = {
    id: 7,
    from: 'user:alice',
    to: 'agent:A-1',
    body: 'Use pnpm.',
    taskId: null,
    replyTo: null,
    standingRule: false,
    ruleActive: false,
    createdAt: 0,
  };

  test('labels each message with id, sender and task', () => {
    expect(formatMessages([base, { ...base, id: 8, taskId: 'T-2', body: 'Second' }])).toBe(
      '[agflow message #7 from user:alice]\nUse pnpm.\n\n[agflow message #8 from user:alice about T-2]\nSecond',
    );
  });

  test('marks standing rules', () => {
    expect(formatMessages([{ ...base, standingRule: true }])).toContain('(standing rule)');
  });
});

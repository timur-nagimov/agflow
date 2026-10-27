import { describe, expect, test } from 'bun:test';
import { UsageError, choiceFlag, parseArgs, stringFlag } from '../src/args';

describe('parseArgs', () => {
  test('splits positionals and flags', () => {
    expect(parseArgs(['hook', 'stop', '--vendor', 'codex', '--role=lead', '--verbose'])).toEqual({
      positional: ['hook', 'stop'],
      flags: { vendor: 'codex', role: 'lead', verbose: true },
    });
  });

  test('a flag followed by another flag is boolean', () => {
    expect(parseArgs(['--dry-run', '--hub', 'http://x']).flags).toEqual({ 'dry-run': true, hub: 'http://x' });
  });
});

describe('flag helpers', () => {
  test('stringFlag ignores boolean flags', () => {
    expect(stringFlag(parseArgs(['--hub']), 'hub')).toBeUndefined();
    expect(stringFlag(parseArgs(['--hub', 'u']), 'hub')).toBe('u');
  });

  test('choiceFlag validates and defaults', () => {
    expect(choiceFlag(parseArgs([]), 'role', ['worker', 'lead'], 'worker')).toBe('worker');
    expect(choiceFlag(parseArgs(['--role', 'lead']), 'role', ['worker', 'lead'], 'worker')).toBe('lead');
    expect(() => choiceFlag(parseArgs(['--role', 'boss']), 'role', ['worker', 'lead'], 'worker')).toThrow(UsageError);
  });
});

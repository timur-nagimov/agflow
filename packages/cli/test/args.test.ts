import { describe, expect, test } from 'bun:test';
import { UsageError, choiceFlag, listFlag, parseArgs, stringFlag } from '../src/args';

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

  test('a flag given more than once keeps every value; stringFlag reads the last', () => {
    const args = parseArgs(['start', '--spec', 'a.md', '--spec=b.pdf', '--spec', 'https://x/c', '--repo', 'o/r']);
    expect(args.flags).toEqual({ spec: ['a.md', 'b.pdf', 'https://x/c'], repo: 'o/r' });
    expect(listFlag(args, 'spec')).toEqual(['a.md', 'b.pdf', 'https://x/c']);
    expect(listFlag(args, 'repo')).toEqual(['o/r']);
    expect(listFlag(args, 'collaborator')).toEqual([]);
    expect(stringFlag(args, 'spec')).toBe('https://x/c');
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

import { describe, expect, test } from 'bun:test';
import { AGFLOW_VERSION } from '@agflow/core';
import { main } from '../src/main';

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (text: string) => void out.push(text), err: (text: string) => void err.push(text) }, out, err };
}

describe('main', () => {
  test('prints the version', async () => {
    const { io, out } = capture();
    expect(await main(['version'], io)).toBe(0);
    expect(out.join('')).toBe(`${AGFLOW_VERSION}\n`);
  });

  test('prints help with no command', async () => {
    const { io, out } = capture();
    expect(await main([], io)).toBe(0);
    expect(out.join('')).toContain('agflow join');
  });

  test('an unknown command is a usage error', async () => {
    const { io, err } = capture();
    expect(await main(['fly'], io)).toBe(2);
    expect(err.join('')).toContain('unknown command "fly"');
  });
});

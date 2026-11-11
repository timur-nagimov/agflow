import { describe, expect, test } from 'bun:test';
import { compareFence, fenceEquals, formatFence, isNewerFence, parseFence } from '../src/fence';
import type { Fence } from '../src/types';

const fence = (epoch: number, counter: number): Fence => ({ epoch, counter });

describe('fence order', () => {
  test('compareFence orders by epoch first, then by counter', () => {
    expect(compareFence(fence(1, 5), fence(1, 7))).toBe(-1);
    expect(compareFence(fence(1, 7), fence(1, 5))).toBe(1);
    expect(compareFence(fence(1, 7), fence(1, 7))).toBe(0);
    // A restore raises the epoch, so a fence issued after it is newer however small its counter is.
    expect(compareFence(fence(2, 1), fence(1, 900))).toBe(1);
    expect(compareFence(fence(1, 900), fence(2, 1))).toBe(-1);
  });

  test('compareFence compares numbers, not text', () => {
    const fences = [fence(2, 3), fence(1, 10), fence(2, 1), fence(1, 2), fence(10, 1)];
    expect([...fences].sort(compareFence)).toEqual([fence(1, 2), fence(1, 10), fence(2, 1), fence(2, 3), fence(10, 1)]);
  });

  test('fenceEquals and isNewerFence agree with compareFence', () => {
    const fences = [fence(1, 1), fence(1, 2), fence(1, 10), fence(2, 1), fence(3, 7)];
    for (const a of fences) {
      for (const b of fences) {
        expect([a, b, fenceEquals(a, b)]).toEqual([a, b, compareFence(a, b) === 0]);
        expect([a, b, isNewerFence(a, b)]).toEqual([a, b, compareFence(a, b) > 0]);
      }
    }
  });
});

describe('fence text', () => {
  test('formatFence gives e<epoch>.<counter>', () => {
    expect(formatFence(fence(1, 17))).toBe('e1.17');
    expect(formatFence(fence(2, 3))).toBe('e2.3');
  });

  test('parseFence round-trips formatFence', () => {
    for (const f of [fence(1, 1), fence(1, 17), fence(2, 3), fence(12, 40_000)]) {
      expect(parseFence(formatFence(f))).toEqual(f);
    }
    for (const text of ['e1.1', 'e3.250']) {
      expect(formatFence(parseFence(text) as Fence)).toBe(text);
    }
  });

  test('parseFence returns null for malformed text', () => {
    const malformed = [
      '',
      'e1',
      '1.17',
      'e1.',
      'e.17',
      'E1.17',
      ' e1.17',
      'e1.17 ',
      'e1.17\n',
      'e1,17',
      'e1.17.3',
      'e-1.17',
      'e1.-17',
      'e1.1e3',
      'e1.0x1',
      // Epochs start at 1 and counters come from a counter that starts at 1.
      'e0.17',
      'e1.0',
      // Only the form formatFence writes, so one fence has one text.
      'e01.17',
      'e1.017',
      'e99999999999999999999.1',
    ];
    for (const text of malformed) expect([text, parseFence(text)]).toEqual([text, null]);
  });
});

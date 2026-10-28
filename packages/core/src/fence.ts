import type { Fence } from './types';

/**
 * Orders fences: by epoch, then by counter, as numbers. A restore raises the epoch, so a fence issued
 * after it is newer than every fence from before it, whatever their counters. Gives -1, 0 or 1.
 */
export function compareFence(a: Fence, b: Fence): number {
  return Math.sign(a.epoch - b.epoch || a.counter - b.counter);
}

export function fenceEquals(a: Fence, b: Fence): boolean {
  return compareFence(a, b) === 0;
}

/** True when `a` was issued after `b`. */
export function isNewerFence(a: Fence, b: Fence): boolean {
  return compareFence(a, b) > 0;
}

/** 'e<epoch>.<counter>', for logs and pages. */
export function formatFence(fence: Fence): string {
  return `e${fence.epoch}.${fence.counter}`;
}

// Epochs start at 1 and counters come from a counter that starts at 1. Leading zeros are refused, so
// every fence has exactly one text.
const FENCE_TEXT = /^e([1-9]\d*)\.([1-9]\d*)$/;

/** Reads what formatFence writes; null for anything else. */
export function parseFence(text: string): Fence | null {
  const match = text.match(FENCE_TEXT);
  if (!match) return null;
  const epoch = Number(match[1]);
  const counter = Number(match[2]);
  return Number.isSafeInteger(epoch) && Number.isSafeInteger(counter) ? { epoch, counter } : null;
}

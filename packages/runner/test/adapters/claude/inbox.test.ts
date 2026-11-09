import { describe, expect, test } from 'bun:test';
import { ClaudeInbox } from '../../../src/adapters/claude/inbox';

describe('ClaudeInbox', () => {
  test('it yields pushed items in order, and waits while empty', async () => {
    const inbox = new ClaudeInbox<string>();
    inbox.push('a');
    inbox.push('b');
    const reader = inbox[Symbol.asyncIterator]();
    expect(await reader.next()).toEqual({ value: 'a', done: false });
    expect(await reader.next()).toEqual({ value: 'b', done: false });
    let taken: IteratorResult<string> | null = null;
    const waiting = reader.next().then((result) => {
      taken = result;
    });
    await Bun.sleep(10);
    expect(taken).toBeNull();
    inbox.push('c');
    await waiting;
    expect(taken as unknown as IteratorResult<string>).toEqual({ value: 'c', done: false });
  });

  test('it ends on end(): queued items first, then done; pushes after the end are refused', async () => {
    const inbox = new ClaudeInbox<string>();
    const reader = inbox[Symbol.asyncIterator]();
    const waiting = reader.next();
    inbox.end();
    expect(await waiting).toEqual({ value: undefined, done: true });

    const other = new ClaudeInbox<string>();
    other.push('last');
    other.end();
    other.end();
    expect(other.ended).toBe(true);
    expect(() => other.push('late')).toThrow(/the inbox has ended/);
    const seen: string[] = [];
    for await (const item of other) seen.push(item);
    expect(seen).toEqual(['last']);
  });

  test('it allows a single iterator', () => {
    const inbox = new ClaudeInbox<string>();
    inbox[Symbol.asyncIterator]();
    expect(() => inbox[Symbol.asyncIterator]()).toThrow(/a single iterator/);
  });

  test('a reader that stops ends the inbox', async () => {
    const inbox = new ClaudeInbox<string>();
    inbox.push('a');
    inbox.push('b');
    for await (const item of inbox) {
      expect(item).toBe('a');
      break;
    }
    expect(inbox.ended).toBe(true);
    expect(() => inbox.push('c')).toThrow(/the inbox has ended/);
  });
});

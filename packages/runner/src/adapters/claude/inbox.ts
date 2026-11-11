// A single-consumer queue that an async iterator drains (design 8.2, 3): a session's input, which query() reads as
// its prompt, and the session's events. The input must stay open for the whole session, because a finite one would
// close the CLI's stdin and end the session; it ends only when the session closes.
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

export class ClaudeInbox<T = SDKUserMessage> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private waiting: ((result: IteratorResult<T>) => void) | null = null;
  private done = false;
  private iterated = false;

  get ended(): boolean {
    return this.done;
  }

  /** Queues an item, or hands it to the waiting reader; refused once the inbox has ended. */
  push(item: T): void {
    if (this.done) throw new Error('the inbox has ended');
    const waiting = this.waiting;
    this.waiting = null;
    if (waiting) waiting({ value: item, done: false });
    else this.items.push(item);
  }

  /** No more items: the reader gets what is queued, then the end. Idempotent. */
  end(): void {
    this.done = true;
    const waiting = this.waiting;
    this.waiting = null;
    waiting?.({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    // A second reader would take items the first one expects.
    if (this.iterated) throw new Error('the inbox allows a single iterator');
    this.iterated = true;
    return {
      next: () => {
        if (this.items.length > 0) return Promise.resolve({ value: this.items.shift() as T, done: false });
        if (this.done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
      return: () => {
        // The reader stopped: what it left is dropped, and nothing more is taken.
        this.items.length = 0;
        this.end();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

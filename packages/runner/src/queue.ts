// The serial queue (design 13): an attempt's lifecycle and git work runs one job at a time, in the order it was
// queued, while different attempts' work runs concurrently. A job that fails releases the queue like one that
// succeeds; its caller gets the error.

export class SerialQueue {
  private readonly tails = new Map<string, Promise<void>>();

  /** Runs job once every job queued earlier under the same key has settled. */
  run<T>(key: string, job: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(job);
    const tail = result.then(
      () => {},
      () => {},
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  /** Resolves once every job queued so far under the key has settled. */
  idle(key: string): Promise<void> {
    return this.tails.get(key) ?? Promise.resolve();
  }
}

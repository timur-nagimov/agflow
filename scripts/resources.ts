import { mkdtempSync, realpathSync, rmSync } from 'node:fs';

type Child = { kill(signal?: number | NodeJS.Signals): void; exited: Promise<number> };

/** Scratch resources for command-line tools. Register directories before the processes that use them. */
export class ScriptResources {
  private actions: Array<() => unknown | Promise<unknown>> = [];
  private closing: Promise<void> | undefined;
  private readonly interrupt = () => this.signal(130);
  private readonly terminate = () => this.signal(143);

  constructor() {
    process.on('SIGINT', this.interrupt);
    process.on('SIGTERM', this.terminate);
  }

  directory(prefix: string): string {
    if (this.closing) throw new Error('script is closing');
    const dir = mkdtempSync(prefix);
    this.defer(() => rmSync(dir, { recursive: true, force: true }));
    return realpathSync(dir);
  }

  defer(action: () => unknown | Promise<unknown>): void {
    if (this.closing) throw new Error('script is closing');
    this.actions.push(action);
  }

  child<T extends Child>(child: T): T {
    if (this.closing) { child.kill('SIGKILL'); throw new Error('script is closing'); }
    this.defer(async () => {
      child.kill('SIGTERM');
      const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000);
      try { await child.exited; } finally { clearTimeout(timeout); }
    });
    return child;
  }

  /** Own an asynchronous acquisition even when a signal arrives before it resolves. */
  acquire<T>(work: Promise<T>, dispose: (value: T) => unknown | Promise<unknown>): Promise<T> {
    this.defer(async () => {
      let value: T;
      try { value = await work; } catch { return; }
      await dispose(value);
    });
    return work.then((value) => { this.checkOpen(); return value; });
  }

  /** Let an in-flight operation release its own children before removing the files it uses. */
  waitFor<T>(work: Promise<T>, cancel: () => void = () => {}): Promise<T> {
    this.defer(async () => { cancel(); await work.catch(() => {}); });
    return work.then((value) => { this.checkOpen(); return value; });
  }

  checkOpen(): void { if (this.closing) throw new Error('script is closing'); }

  [Symbol.asyncDispose](): Promise<void> { return this.close(); }

  close(): Promise<void> {
    // Assign the promise before invoking callbacks: a signal and a finally block may both close the scope.
    return this.closing ??= Promise.resolve().then(async () => {
      const errors: unknown[] = [];
      try {
        for (const action of this.actions.reverse()) {
          try { await action(); } catch (error) { errors.push(error); }
        }
      } finally {
        process.off('SIGINT', this.interrupt);
        process.off('SIGTERM', this.terminate);
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'script cleanup failed');
    });
  }

  private signal(code: number): void {
    void this.close().catch((error) => console.error(error)).finally(() => process.exit(code));
  }
}

export async function withScriptResources<T>(run: (resources: ScriptResources) => Promise<T>): Promise<T> {
  const resources = new ScriptResources();
  try { return await run(resources); } finally { await resources.close(); }
}

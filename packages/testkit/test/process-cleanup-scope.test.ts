import { afterAll, afterEach, expect, test } from 'bun:test';
import { cleanupTestProcesses, registerTestCleanup } from '../src/process-cleanup';

const closed: number[] = [];
const server = () => Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('cleanup') });

// Bun 1.3.11 invokes these hooks without the async test body's AsyncLocalStorage context.
// They must still belong to the current test, and must run before its scope is closed.
afterEach(async () => {
  const cleanupServer = server();
  await cleanupServer.stop(true);
});
afterAll(async () => {
  const cleanupServer = server();
  await cleanupServer.stop(true);
});

test('an async test owns resources even when its teardown loses the async context', async () => {
  registerTestCleanup(() => { closed.push(1); });
  await Bun.sleep(1);
});

test('the previous scope was reaped without closing the root or the next teardown', async () => {
  expect(closed).toEqual([1]);
  registerTestCleanup(() => { closed.push(2); });
  await Bun.sleep(1);
});

test('cleanup callbacks may create resources while late test continuations remain refused', async () => {
  let cleaned = false;
  registerTestCleanup(async () => {
    await Promise.resolve();
    const cleanupServer = server();
    await cleanupServer.stop(true);
    cleaned = true;
  });
  const late = new Promise<string>((resolve) => {
    setTimeout(() => {
      try {
        const lateServer = server();
        lateServer.stop(true);
        resolve('started');
      } catch (error) { resolve((error as Error).message); }
    }, 20);
  });
  await cleanupTestProcesses();
  expect(cleaned).toBe(true);
  expect(await late).toContain('test scope already closed');
});

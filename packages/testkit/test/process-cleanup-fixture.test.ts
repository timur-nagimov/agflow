import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { bindTestProcessScope, cleanupTestProcesses } from '../src/process-cleanup';

const serve = () => Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('alive') });

describe('shared fixture ownership', () => {
  let start: typeof serve;
  let shared: ReturnType<typeof serve>;
  let url: string;

  beforeAll(() => {
    start = bindTestProcessScope(serve);
    shared = start();
  });
  afterAll(() => shared.stop(true));

  test('a fixture replaces its resource in a test', async () => {
    await shared.stop(true);
    shared = start();
    url = shared.url.href;
    expect(await (await fetch(url)).text()).toBe('alive');
  });

  test('the replacement survives per-test cleanup', async () => {
    expect(await (await fetch(url)).text()).toBe('alive');
    const local = serve();
    const localUrl = local.url.href;
    await cleanupTestProcesses();
    await expect(fetch(localUrl)).rejects.toThrow();
    expect(await (await fetch(url)).text()).toBe('alive');
    expect(() => start()).toThrow('test scope already closed');
  });
});

describe('per-test fixture ownership', () => {
  let start: typeof serve;

  test('a bound fixture is still cleaned up with its owning test', async () => {
    start = bindTestProcessScope(serve);
    const local = start();
    const url = local.url.href;
    expect(await (await fetch(url)).text()).toBe('alive');
    await cleanupTestProcesses();
    await expect(fetch(url)).rejects.toThrow();
  });

  test('a new test cannot reopen a fixture whose owner has closed', () => {
    expect(() => start()).toThrow('test scope already closed');
  });
});

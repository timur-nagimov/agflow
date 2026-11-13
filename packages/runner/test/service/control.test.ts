import { afterEach, describe, expect, test } from 'bun:test';
import type { Subprocess } from 'bun';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runnerPaths } from '../../src/paths';
import { acquireRunnerLock, type RunnerLock } from '../../src/service/lock';
import {
  checkSocketPath,
  controlRequest,
  ControlUnavailableError,
  startControlServer,
  type ControlRoutes,
  type ControlServer,
} from '../../src/service/control';

const dirs: string[] = [];
const locks: RunnerLock[] = [];
const servers: ControlServer[] = [];
const children: Subprocess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill('SIGKILL');
    await child.exited;
  }
  for (const server of servers.splice(0)) await server.stop();
  for (const lock of locks.splice(0)) lock.release();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch() {
  const dir = mkdtempSync('/tmp/agf-ctl-');
  dirs.push(dir);
  return runnerPaths(dir);
}

async function serve(routes: ControlRoutes = {}) {
  const paths = scratch();
  const lock = await acquireRunnerLock(paths, { mode: 'foreground' });
  locks.push(lock);
  const server = startControlServer({ paths, lock, routes });
  servers.push(server);
  return { paths, lock, server };
}

describe('runner.sock', () => {
  test('serves GET and POST JSON, query parameters and empty bodies, with private socket permissions', async () => {
    const { paths, lock, server } = await serve({
      'GET /health': (_body, query) => ({ ok: true, values: query.getAll('a') }),
      'POST /drain': async (body, query) => ({ body: body ?? null, reason: query.get('reason') }),
      'POST /stop': () => undefined,
    });
    expect(server.path).toBe(paths.socket);
    expect(statSync(paths.socket).isSocket()).toBe(true);
    expect(statSync(paths.socket).mode & 0o777).toBe(0o600);
    expect(await controlRequest<unknown>(paths, 'GET', '/health?a=one&a=two')).toEqual({
      ok: true,
      values: ['one', 'two'],
    });
    expect(await controlRequest<unknown>(paths, 'POST', '/drain?reason=owner', { draining: true })).toEqual({
      body: { draining: true },
      reason: 'owner',
    });
    expect(await controlRequest<unknown>(paths, 'POST', '/drain')).toEqual({ body: null, reason: null });
    expect(await controlRequest<unknown>(paths, 'POST', '/stop')).toBeNull();
    await server.stop();
    await server.stop();
    expect(existsSync(paths.socket)).toBe(false);
    expect(lock.held).toBe(true);
  });

  test('uses JSON errors for unknown routes, wrong methods, malformed JSON and thrown handlers', async () => {
    const { paths } = await serve({
      'POST /drain': () => true,
      'GET /broken': () => {
        throw new Error('cannot drain now');
      },
    });
    for (const [method, path, body, status] of [
      ['GET', '/absent', undefined, 404],
      ['GET', '/drain', undefined, 404],
      ['POST', '/drain', '{broken', 400],
      ['GET', '/broken', undefined, 500],
    ] as const) {
      const response = await fetch(`http://localhost${path}`, { unix: paths.socket, method, body });
      expect(response.status).toBe(status);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(await response.json()).toMatchObject({ error: expect.any(String) });
    }
    await expect(controlRequest<unknown>(paths, 'GET', '/broken')).rejects.toThrow('cannot drain now');
    const error = await controlRequest<unknown>(paths, 'GET', '/absent').catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ControlUnavailableError);
  });

  test('only the matching live lock can replace a real socket left by a SIGKILLed process', async () => {
    const paths = scratch();
    const ready = join(paths.home, 'ready');
    const script = join(paths.home, 'socket.ts');
    writeFileSync(script, `
import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync(${JSON.stringify(paths.runner)});
Bun.serve({ unix: ${JSON.stringify(paths.socket)}, fetch: () => Response.json({ ok: true }) });
writeFileSync(${JSON.stringify(ready)}, 'ready');
`);
    const child = Bun.spawn([process.execPath, script], { stdout: 'ignore', stderr: 'inherit' });
    children.push(child);
    const deadline = Date.now() + 3_000;
    while (!existsSync(ready)) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error('socket child did not become ready');
      await Bun.sleep(10);
    }
    child.kill('SIGKILL');
    await child.exited;
    expect(statSync(paths.socket).isSocket()).toBe(true);
    await expect(controlRequest<unknown>(paths, 'GET', '/health')).rejects.toBeInstanceOf(ControlUnavailableError);
    const other = await acquireRunnerLock(scratch(), { mode: 'foreground' });
    locks.push(other);
    expect(() => startControlServer({ paths, lock: other, routes: {} })).toThrow('lock');
    const lock = await acquireRunnerLock(paths, { mode: 'foreground' });
    locks.push(lock);
    lock.release();
    expect(() => startControlServer({ paths, lock, routes: {} })).toThrow('lock');
    expect(statSync(paths.socket).isSocket()).toBe(true);
    const live = await acquireRunnerLock(paths, { mode: 'foreground' });
    locks.push(live);
    servers.push(startControlServer({ paths, lock: live, routes: { 'GET /health': () => ({ ok: true }) } }));
    expect(await controlRequest<unknown>(paths, 'GET', '/health')).toEqual({ ok: true });
    expect(statSync(paths.socket).mode & 0o777).toBe(0o600);
  });

  test('a second server cannot unlink the first server socket', async () => {
    const { paths, lock } = await serve({ 'GET /health': () => true });
    expect(() => startControlServer({ paths, lock, routes: {} })).toThrow();
    expect(await controlRequest<unknown>(paths, 'GET', '/health')).toBe(true);
  });

  test('a late stop leaves a new owner’s socket intact', async () => {
    const { paths, lock, server } = await serve();
    lock.release();
    const next = await acquireRunnerLock(paths, { mode: 'service' });
    locks.push(next);
    servers.push(startControlServer({ paths, lock: next, routes: { 'GET /health': () => 'new owner' } }));
    await server.stop();
    expect(statSync(paths.socket).isSocket()).toBe(true);
    expect(await controlRequest<unknown>(paths, 'GET', '/health')).toBe('new owner');
  });

  test('missing listeners and a request deadline are ControlUnavailableError', async () => {
    await expect(controlRequest<unknown>(scratch(), 'GET', '/status')).rejects.toBeInstanceOf(ControlUnavailableError);
    const pending = Promise.withResolvers<void>();
    try {
      const { paths, server } = await serve({ 'GET /status': () => pending.promise });
      const started = Date.now();
      const error = await controlRequest<unknown>(paths, 'GET', '/status', undefined, { timeoutMs: 40 }).catch(
        (error: unknown) => error,
      );
      expect(error).toBeInstanceOf(ControlUnavailableError);
      expect((error as Error).message).toContain('40 ms');
      expect(Date.now() - started).toBeLessThan(1_000);
      // Shutdown must close the listener while the handler is still unresponsive.
      server.stop();
      await expect(controlRequest<unknown>(paths, 'GET', '/status')).rejects.toBeInstanceOf(ControlUnavailableError);
    } finally {
      // Bun's stop(true) promise waits for handlers even after closing their connections. Release this test
      // fixture only after proving the deadline and forced shutdown, so the cleanup hook can await the server.
      pending.resolve();
    }
  });

  test('refuses paths over 103 bytes on both sides and names AGFLOW_HOME', async () => {
    expect(() => checkSocketPath('/' + 'a'.repeat(102))).not.toThrow();
    const { paths, lock } = await serve();
    for (const socket of ['/' + 'a'.repeat(103), '/' + 'é'.repeat(52)]) {
      expect(() => checkSocketPath(socket)).toThrow(socket);
      expect(() => startControlServer({ paths: { ...paths, socket }, lock, routes: {} })).toThrow('AGFLOW_HOME');
      await expect(controlRequest<unknown>({ ...paths, socket }, 'GET', '/health')).rejects.toThrow('AGFLOW_HOME');
    }
  });
});

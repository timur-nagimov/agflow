import { afterEach, describe, expect, test } from 'bun:test';
import type { Subprocess } from 'bun';
import { dlopen, FFIType } from 'bun:ffi';
import { existsSync, fstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runnerPaths } from '../../src/paths';
import { acquireRunnerLock, AlreadyRunningError, readLockOwner, type RunnerLock } from '../../src/service/lock';

const dirs: string[] = [];
const locks: RunnerLock[] = [];
const children: Subprocess[] = [];
const descendants: number[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill('SIGKILL');
    await child.exited;
  }
  for (const pid of descendants.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  for (const lock of locks.splice(0)) lock.release();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch() {
  const dir = mkdtempSync('/tmp/agf-lock-');
  dirs.push(dir);
  return runnerPaths(dir);
}

// F_GETFD reads no variadic argument, so a two-argument declaration is exact on every ABI.
const libc = dlopen(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
  fcntl: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});
const F_GETFD = 1;
const FD_CLOEXEC = 1;

/** This process's descriptors open on the lock file. */
function lockFds(paths: ReturnType<typeof runnerPaths>): number[] {
  const { dev, ino } = statSync(paths.lock);
  return readdirSync('/dev/fd')
    .map(Number)
    .filter((fd) => {
      try {
        const stat = fstatSync(fd);
        return stat.dev === dev && stat.ino === ino;
      } catch {
        // The descriptor readdir used for /dev/fd itself is closed by now.
        return false;
      }
    });
}

async function holder(paths: ReturnType<typeof runnerPaths>, spawnChild = false) {
  const ready = join(paths.home, 'ready.json');
  const script = join(paths.home, 'holder.ts');
  writeFileSync(script, `
import { acquireRunnerLock } from ${JSON.stringify(join(import.meta.dir, '../../src/service/lock.ts'))};
import { runnerPaths } from ${JSON.stringify(join(import.meta.dir, '../../src/paths.ts'))};
import { writeFileSync } from 'node:fs';
const lock = await acquireRunnerLock(runnerPaths(${JSON.stringify(paths.home)}), { mode: 'foreground' });
const child = ${spawnChild}
  ? Bun.spawn(['/bin/sleep', '30'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
  : null;
process.on('SIGTERM', () => { lock.release(); process.exit(0); });
writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ pid: process.pid, childPid: child?.pid }));
console.log(process.pid);
setInterval(() => {}, 1000);
`);
  const child = Bun.spawn([process.execPath, script], { stdout: 'ignore', stderr: 'inherit' });
  children.push(child);
  const deadline = Date.now() + 3_000;
  while (!existsSync(ready)) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error('lock holder did not become ready');
    await Bun.sleep(10);
  }
  const identity = JSON.parse(readFileSync(ready, 'utf8')) as { pid: number; childPid?: number };
  if (identity.childPid) descendants.push(identity.childPid);
  return { child, ...identity };
}

describe('runner.lock', () => {
  test('creates private state, records its owner, and releases without deleting or replacing the inode', async () => {
    const paths = scratch();
    expect(readLockOwner(paths)).toBeNull();
    const lock = await acquireRunnerLock(paths, { mode: 'service' });
    locks.push(lock);
    expect(lock.path).toBe(paths.lock);
    expect(lock.held).toBe(true);
    expect(lock.owner).toMatchObject({ pid: process.pid, mode: 'service' });
    expect(Number.isFinite(Date.parse(lock.owner.startedAt))).toBe(true);
    expect(readLockOwner(paths)).toEqual(lock.owner);
    expect(JSON.parse(readFileSync(paths.lock, 'utf8'))).toEqual(lock.owner);
    expect(statSync(paths.runner).mode & 0o777).toBe(0o700);
    expect(statSync(paths.lock).mode & 0o777).toBe(0o600);
    const [fd, ...others] = lockFds(paths);
    expect(others).toEqual([]);
    expect(libc.symbols.fcntl(fd!, F_GETFD) & FD_CLOEXEC).toBe(FD_CLOEXEC);
    const inode = statSync(paths.lock).ino;
    lock.release();
    lock.release();
    expect(lock.held).toBe(false);
    expect(readLockOwner(paths)).toBeNull();
    const next = await acquireRunnerLock(paths, { mode: 'foreground' });
    locks.push(next);
    expect(statSync(paths.lock).ino).toBe(inode);
    expect(readLockOwner(paths)).toEqual(next.owner);
  });

  test('a second process fails immediately with the holder pid and mode', async () => {
    const paths = scratch();
    const { pid } = await holder(paths);
    expect(lockFds(paths)).toEqual([]);
    const started = Date.now();
    const error = await acquireRunnerLock(paths, { mode: 'foreground' }).catch((error: unknown) => error);
    expect(lockFds(paths)).toEqual([]);
    expect(error).toBeInstanceOf(AlreadyRunningError);
    expect(error).toMatchObject({
      pid,
      mode: 'foreground',
      holder: { pid, mode: 'foreground' },
      message: `the runner is already running (pid ${pid}); use agflow runner status`,
    });
    expect(Date.now() - started).toBeLessThan(500);
    expect(readLockOwner(paths)).toMatchObject({ pid, mode: 'foreground' });
  });

  test('service waiting keeps the event loop alive, reports the holder once, and acquires after release', async () => {
    const paths = scratch();
    const { child, pid } = await holder(paths);
    const seen: unknown[] = [];
    let acquired = false;
    const waiting = acquireRunnerLock(paths, {
      mode: 'service',
      wait: true,
      pollMs: 10,
      onWait: (owner) => {
        seen.push(owner);
      },
    }).then((lock) => {
      locks.push(lock);
      acquired = true;
      return lock;
    });
    await Bun.sleep(60);
    expect(acquired).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ pid, mode: 'foreground' });
    child.kill('SIGTERM');
    await child.exited;
    const lock = await waiting;
    expect(lock.owner.mode).toBe('service');
    expect(readLockOwner(paths)).toEqual(lock.owner);
    expect(seen).toHaveLength(1);
  });

  // FD_CLOEXEC keeps the child from inheriting the lock; Bun.spawn also closes non-stdio descriptors.
  test('SIGKILL frees the lock even while a long-lived child survives', async () => {
    const paths = scratch();
    const { child, childPid } = await holder(paths, true);
    expect(childPid).toBeNumber();
    child.kill('SIGKILL');
    await child.exited;
    expect(() => process.kill(childPid!, 0)).not.toThrow();
    expect(readLockOwner(paths)).toBeNull();
    locks.push(await acquireRunnerLock(paths, { mode: 'foreground' }));
  });

  test('malformed or incomplete identity reads as held with unknown fields, never as unlocked', async () => {
    const paths = scratch();
    locks.push(await acquireRunnerLock(paths, { mode: 'foreground' }));
    for (const text of ['', '{broken', '{"pid":-1,"mode":"wrong"}', 'null']) {
      writeFileSync(paths.lock, text);
      expect(readLockOwner(paths)).toEqual({ pid: null, mode: null, startedAt: null });
      await expect(acquireRunnerLock(paths, { mode: 'foreground' })).rejects.toThrow('pid unknown');
    }
    locks[0].release();
    expect(readLockOwner(paths)).toBeNull();
  });

  test('an aborted waiter closes its fd and can be followed by another acquisition', async () => {
    const paths = scratch();
    const lock = await acquireRunnerLock(paths, { mode: 'foreground' });
    locks.push(lock);
    const held = lockFds(paths);
    const abort = new AbortController();
    const waiting = acquireRunnerLock(paths, { mode: 'service', wait: true, signal: abort.signal });
    abort.abort();
    await expect(waiting).rejects.toThrow();
    expect(lockFds(paths)).toEqual(held);
    lock.release();
    locks.push(await acquireRunnerLock(paths, { mode: 'foreground' }));
  });

  test('a passing status probe never makes a foreground start refuse', async () => {
    const paths = scratch();
    locks.push(await acquireRunnerLock(paths, { mode: 'foreground' }));
    locks.pop()!.release();
    const stop = join(paths.home, 'stop');
    const script = join(paths.home, 'probe.ts');
    writeFileSync(script, `
import { readLockOwner } from ${JSON.stringify(join(import.meta.dir, '../../src/service/lock.ts'))};
import { runnerPaths } from ${JSON.stringify(join(import.meta.dir, '../../src/paths.ts'))};
import { existsSync } from 'node:fs';
const paths = runnerPaths(${JSON.stringify(paths.home)});
console.log('probing');
while (!existsSync(${JSON.stringify(stop)})) readLockOwner(paths);
`);
    const probe = Bun.spawn([process.execPath, script], { stdout: 'pipe', stderr: 'inherit' });
    children.push(probe);
    await probe.stdout.getReader().read();
    try {
      for (let i = 0; i < 2_000; i++) (await acquireRunnerLock(paths, { mode: 'foreground' })).release();
    } finally {
      writeFileSync(stop, '');
    }
    expect(await probe.exited).toBe(0);
  });
});

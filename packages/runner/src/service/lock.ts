// One instance per runner home (design 7.1). Keep the inode: unlinking a locked file defeats flock.
import { dlopen, FFIType, read, type Pointer } from 'bun:ffi';
import { closeSync, constants, fchmodSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import type { RunnerPaths } from '../paths';

export type RunnerMode = 'foreground' | 'service';
export interface LockOwner {
  pid: number | null;
  mode: RunnerMode | null;
  startedAt: string | null;
}

export interface RunnerLock {
  readonly path: string;
  readonly owner: Readonly<{ pid: number; mode: RunnerMode; startedAt: string }>;
  readonly held: boolean;
  release(): void;
}

export class AlreadyRunningError extends Error {
  readonly pid: number | null;
  readonly mode: RunnerMode | null;

  constructor(readonly holder: LockOwner) {
    super(`the runner is already running (pid ${holder.pid ?? 'unknown'}); use agflow runner status`);
    this.name = 'AlreadyRunningError';
    this.pid = holder.pid;
    this.mode = holder.mode;
  }
}

const LOCK_SH = 1;
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
const EINTR = 4;
// fs.constants has no O_CLOEXEC; openSync passes the raw flag through.
const O_CLOEXEC = process.platform === 'darwin' ? 0x1000000 : 0o2000000;
// A status probe holds LOCK_SH for a moment; that is not a running runner.
const PROBE_GRACE_MS = 50;

function loadNative() {
  const mac = process.platform === 'darwin';
  if (!mac && process.platform !== 'linux') {
    throw new Error(`runner locks are unsupported on ${process.platform}; expected macOS or Linux`);
  }
  const library = dlopen(mac ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    [mac ? '__error' : '__errno_location']: { args: [], returns: FFIType.ptr },
  });
  return {
    flock: library.symbols.flock,
    errno: () => read.i32(library.symbols[mac ? '__error' : '__errno_location']() as Pointer),
    wouldBlock: mac ? 35 : 11,
  };
}

let native: ReturnType<typeof loadNative> | undefined;
function api() {
  return (native ??= loadNative());
}

function flock(fd: number, operation: number): boolean {
  const lib = api();
  while (lib.flock(fd, operation) !== 0) {
    const errno = lib.errno();
    if (errno === EINTR) continue;
    if (errno === lib.wouldBlock) return false;
    throw new Error(`flock failed (errno ${errno})`);
  }
  return true;
}

function openLock(path: string, create: boolean): number {
  // Agents must never keep the runner's lock alive after the runner crashes. Set at open: fcntl is variadic,
  // and on Apple arm64 a fixed-argument FFI call never delivers F_SETFD's argument.
  const flags = create ? constants.O_RDWR | constants.O_CREAT : constants.O_RDONLY;
  return openSync(path, flags | O_CLOEXEC, 0o600);
}

function ownerFromFd(fd: number): LockOwner {
  try {
    const owner = JSON.parse(readFileSync(fd, 'utf8'));
    if (
      owner &&
      Number.isSafeInteger(owner.pid) &&
      owner.pid > 0 &&
      (owner.mode === 'foreground' || owner.mode === 'service') &&
      typeof owner.startedAt === 'string' &&
      Number.isFinite(Date.parse(owner.startedAt))
    ) {
      return { pid: owner.pid, mode: owner.mode, startedAt: owner.startedAt };
    }
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  // flock is authoritative, including the brief window before the owner writes its identity.
  return { pid: null, mode: null, startedAt: null };
}

/** null means unlocked; unknown fields mean held but its identity is not readable yet. */
export function readLockOwner(paths: RunnerPaths): LockOwner | null {
  let fd: number;
  try {
    fd = openLock(paths.lock, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    if (flock(fd, LOCK_SH | LOCK_NB)) {
      flock(fd, LOCK_UN);
      return null;
    }
    return ownerFromFd(fd);
  } finally {
    closeSync(fd);
  }
}

const heldLocks = new WeakSet<RunnerLock>();

/** The control server requires a real acquisition in this process for this home. */
export function assertRunnerLock(lock: RunnerLock, paths: RunnerPaths): void {
  if (!heldLocks.has(lock) || !lock.held || lock.owner.pid !== process.pid || lock.path !== paths.lock) {
    throw new Error(`a held runner lock for ${paths.lock} is required to bind the control socket`);
  }
}

export interface AcquireRunnerLockOptions {
  mode: RunnerMode;
  wait?: boolean;
  onWait?: (holder: LockOwner) => void;
  pollMs?: number;
  signal?: AbortSignal;
}

/**
 * Takes runner.lock before anything touches runner.db. A foreground start fails at once with AlreadyRunningError;
 * the service waits (wait: true) so launchd's KeepAlive does not loop.
 */
export async function acquireRunnerLock(paths: RunnerPaths, options: AcquireRunnerLockOptions): Promise<RunnerLock> {
  const pollMs = options.pollMs ?? 100;
  if (!Number.isFinite(pollMs) || pollMs <= 0) throw new Error('lock pollMs must be positive');
  options.signal?.throwIfAborted();
  mkdirSync(paths.runner, { recursive: true, mode: 0o700 });
  const fd = openLock(paths.lock, true);
  try {
    let notified = false;
    let probeDeadline: number | undefined;
    while (!flock(fd, LOCK_EX | LOCK_NB)) {
      if (!notified) {
        const holder = readLockOwner(paths);
        if (holder === null) {
          // Only shared probes (status, install, stop) hold it: retry briefly instead of refusing.
          probeDeadline ??= Date.now() + PROBE_GRACE_MS;
          if (Date.now() < probeDeadline) {
            await delay(1, undefined, { signal: options.signal });
            continue;
          }
        }
        const owner = holder ?? { pid: null, mode: null, startedAt: null };
        if (!options.wait) throw new AlreadyRunningError(owner);
        notified = true;
        options.onWait?.(owner);
      }
      await delay(pollMs, undefined, { signal: options.signal });
    }
    options.signal?.throwIfAborted();
    const owner = Object.freeze({ pid: process.pid, mode: options.mode, startedAt: new Date().toISOString() });
    fchmodSync(fd, 0o600);
    ftruncateSync(fd, 0);
    const bytes = Buffer.from(`${JSON.stringify(owner)}\n`);
    for (let offset = 0; offset < bytes.length; ) {
      offset += writeSync(fd, bytes, offset, bytes.length - offset, offset);
    }
    let held = true;
    const lock: RunnerLock = Object.freeze({
      path: paths.lock,
      owner,
      get held() {
        return held;
      },
      release() {
        if (!held) return;
        held = false;
        heldLocks.delete(lock);
        try {
          flock(fd, LOCK_UN);
        } finally {
          closeSync(fd);
        }
      },
    });
    heldLocks.add(lock);
    return lock;
  } catch (error) {
    // Closing also releases flock if recording the identity failed after acquisition.
    closeSync(fd);
    throw error;
  }
}

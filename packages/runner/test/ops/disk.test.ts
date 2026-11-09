import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, statfsSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunnerDiskSchema } from '@agflow/core';
import { AgflowUsage, diskFreeBytes } from '../../src/ops/disk';
import { agflowHome } from '../../src/paths';
import type { Exec, ExecResult } from '../../src/service/system';
import { recordingExec } from '../service-helpers';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agf-disk-'));
  dirs.push(dir);
  return dir;
}

describe('diskFreeBytes', () => {
  test('reads user-available bytes on AGFLOW_HOME and produces a valid disk sample', () => {
    const root = agflowHome({ AGFLOW_HOME: scratch() });
    const before = statfsSync(root);
    const freeBytes = diskFreeBytes(root)!;
    const after = statfsSync(root);
    expect(freeBytes).toBeGreaterThan(0);
    // Other processes can allocate between statfs calls.
    expect(Math.abs(freeBytes - before.bavail * before.bsize)).toBeLessThan(64 * 1024 * 1024);
    expect(Math.abs(freeBytes - after.bavail * after.bsize)).toBeLessThan(64 * 1024 * 1024);
    expect(RunnerDiskSchema.parse({ freeBytes, agflowBytes: 0 })).toEqual({ freeBytes, agflowBytes: 0 });
  });

  test('returns null when AGFLOW_HOME does not exist yet', () => {
    expect(diskFreeBytes(join(scratch(), 'missing'))).toBeNull();
  });
});

describe('AgflowUsage', () => {
  test('returns immediately, shares in-flight work and runs at most once per interval', async () => {
    let now = 0;
    const pending: ((result: ExecResult) => void)[] = [];
    const calls = recordingExec();
    const exec: Exec = (argv, options) => {
      void calls(argv, options);
      return new Promise((resolve) => pending.push(resolve));
    };
    const usage = new AgflowUsage({ root: '/agflow home', exec, now: () => now, intervalMs: 100, timeoutMs: 17 });
    expect(usage.current()).toBe(0);
    const first = usage.refresh();
    await Promise.resolve();
    expect(calls.calls).toEqual([{ argv: ['du', '-skH', '/agflow home'], options: { timeoutMs: 17 } }]);
    now = 101;
    for (let i = 0; i < 10; i++) expect(usage.current()).toBe(0);
    expect(usage.refresh()).toBe(first);
    expect(pending).toHaveLength(1);
    pending[0]({ exitCode: 0, stdout: '12\t/agflow home\n', stderr: '', timedOut: false });
    await first;
    expect(usage.current()).toBe(12 * 1024);
    const second = usage.refresh();
    await Promise.resolve();
    expect(pending).toHaveLength(2);
    pending[1]({ exitCode: 0, stdout: '24\t/agflow home\n', stderr: '', timedOut: false });
    await second;
    now = 200;
    expect(usage.current()).toBe(24 * 1024);
    await usage.refresh();
    expect(pending).toHaveLength(2);
  });

  test('defaults to ten minutes and a two-minute timeout, including refresh calls', async () => {
    let now = 0;
    const exec = recordingExec([], { stdout: '1\t/root\n' });
    const usage = new AgflowUsage({ root: '/root', exec, now: () => now });
    await usage.refresh();
    expect(usage.current()).toBe(1024);
    now = 599_999;
    await usage.refresh();
    expect(exec.calls).toHaveLength(1);
    now = 600_000;
    await usage.refresh();
    expect(exec.calls).toHaveLength(2);
    expect(exec.calls[0].options?.timeoutMs).toBe(120_000);
  });

  test('keeps the last value after timeouts, bad output and exceptions, then retries', async () => {
    let now = 0;
    let result: Partial<ExecResult> | Error = { stdout: '5\t/root\n' };
    let calls = 0;
    const exec: Exec = async () => {
      calls++;
      if (result instanceof Error) throw result;
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false, ...result };
    };
    const usage = new AgflowUsage({ root: '/root', exec, now: () => now, intervalMs: 10 });
    await usage.refresh();
    for (const failure of [
      { timedOut: true, stdout: '99\t/root\n' }, { exitCode: 1 },
      { stdout: 'garbage' }, { stdout: '-1\t/root\n' }, { stdout: '1.5\t/root\n' },
      { stdout: '999999999999999999999\t/root\n' }, new Error('spawn failed'),
    ]) {
      result = failure;
      now += 10;
      await usage.refresh();
      expect(usage.current()).toBe(5 * 1024);
      const count = calls;
      await usage.refresh();
      expect(calls).toBe(count);
    }
    result = { stdout: '0\t/root\n' };
    now += 10;
    await usage.refresh();
    expect(usage.current()).toBe(0);
  });

  test('uses a total printed despite unreadable files and a nonzero exit', async () => {
    const usage = new AgflowUsage({
      root: '/root',
      exec: recordingExec([], { exitCode: 1, stdout: '42\t/root\n', stderr: 'Permission denied' }),
    });
    await usage.refresh();
    expect(usage.current()).toBe(42 * 1024);
    expect(RunnerDiskSchema.parse({ freeBytes: 1, agflowBytes: usage.current() }).agflowBytes).toBe(42 * 1024);
  });

  test('measures a real temporary directory with du on macOS and Linux', async () => {
    const root = scratch();
    const file = join(root, 'known');
    writeFileSync(file, Buffer.alloc(128 * 1024, 97));
    const usage = new AgflowUsage({ root });
    await usage.refresh();
    expect(usage.current()).toBeGreaterThanOrEqual(statSync(file).blocks * 512);
    expect(usage.current()).toBeGreaterThan(0);
    expect(usage.current() % 1024).toBe(0);
  });

  test('measures the target of a symlinked root', async () => {
    const dir = scratch();
    const target = join(dir, 'target');
    mkdirSync(target);
    const file = join(target, 'known');
    writeFileSync(file, Buffer.alloc(1024 * 1024, 97));
    const root = join(dir, 'home');
    symlinkSync(target, root);
    const usage = new AgflowUsage({ root });
    await usage.refresh();
    expect(usage.current()).toBeGreaterThanOrEqual(statSync(file).blocks * 512);
  });
});

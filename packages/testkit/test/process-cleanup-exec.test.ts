import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupTestProcesses, PROCESS_SCOPE, snapshotProcesses } from '../src/process-cleanup';

const snapshot = snapshotProcesses;

for (const mode of ['detached', 'shared', 'orphan'] as const) {
  test(`cleanup reaps an exec-cleared child and its unmarked detached descendant (${mode})`, async () => {
    snapshot(); // Fail before starting the intentional leak when ps is sandbox-denied.
    const home = mkdtempSync(join(tmpdir(), 'agflow-cleanup-exec-'));
    const replacement = `
      const child = Bun.spawn(['/bin/sleep', '30'], {
        detached: true, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', env: {},
      });
      console.log(JSON.stringify({ descendant: child.pid }));
      await child.exited;
    `;
    // Start with a marked Bun process, then replace that very PID with an uninstrumented, empty-env Bun.
    // No Python dependency or macOS platform-binary environment hiding can mask the marker transition.
    const program = `
      import { dlopen, FFIType, ptr } from 'bun:ffi';
      const { symbols } = dlopen(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
        execve: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      });
      const args = [process.execPath, '--eval', ${JSON.stringify(replacement)}].map(value => Buffer.from(value + '\\0'));
      const argv = new BigUint64Array([...args.map(value => BigInt(ptr(value))), 0n]);
      const envp = new BigUint64Array([0n]);
      console.log(JSON.stringify({ ready: process.pid }));
      await Bun.stdin.text();
      const code = symbols.execve(ptr(args[0]), ptr(argv), ptr(envp));
      throw new Error('execve returned ' + code);
    `;
    const launcher = mode !== 'orphan' ? program : `
      const child = Bun.spawn([process.execPath, '--eval', ${JSON.stringify(program)}], {
        detached: true, stdin: 'pipe', stdout: 'pipe', stderr: 'inherit',
      });
      const reader = child.stdout.getReader();
      process.stdout.write((await reader.read()).value);
      await Bun.stdin.text();
      child.stdin.end();
      process.stdout.write((await reader.read()).value);
      child.unref();
      process.exit(0);
    `;
    let proc: ReturnType<typeof Bun.spawn> | undefined;
    let target: number | undefined;
    let targetIdentity: string | null | undefined;
    let descendant: number | undefined;
    let descendantIdentity: string | null | undefined;
    try {
      const child = Bun.spawn([process.execPath, '--eval', launcher], {
        cwd: home, detached: mode !== 'shared', stdin: 'pipe', stdout: 'pipe', stderr: 'inherit',
        env: { HOME: home, PATH: '/usr/bin:/bin' },
      });
      proc = child;
      const reader = child.stdout.getReader();
      target = JSON.parse(new TextDecoder().decode((await reader.read()).value)).ready;
      const before = snapshot().find(row => row.pid === target)!;
      targetIdentity = before.identity;
      expect(before.command).toContain(`${PROCESS_SCOPE}=`);
      expect(typeof before.identity).toBe('string');
      child.stdin.end();
      descendant = JSON.parse(new TextDecoder().decode((await reader.read()).value)).descendant;
      if (mode === 'orphan') expect(await child.exited).toBe(0);
      const rows = snapshot();
      const after = rows.find(row => row.pid === target)!;
      expect(after.identity).toBe(before.identity);
      expect(after.lstart).toBe(before.lstart);
      expect(after.pgid).toBe(before.pgid);
      expect(after.command).not.toContain(`${PROCESS_SCOPE}=`);
      const grandchild = rows.find(row => row.pid === descendant)!;
      descendantIdentity = grandchild.identity;
      expect(typeof descendantIdentity).toBe('string');
      expect(grandchild.command).not.toContain(`${PROCESS_SCOPE}=`);
      expect(grandchild.ppid).toBe(before.pid);
      expect(grandchild.pgid).toBe(grandchild.pid);

      await cleanupTestProcesses();
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      // An orphan can remain a zombie until init reaps it; a live sleeper is a leak.
      const survivors = snapshot().filter(row => !row.stat.startsWith('Z'));
      expect(survivors.some(row => row.pid === target && row.identity === targetIdentity)).toBe(false);
      expect(survivors.some(row => row.pid === descendant && row.identity === descendantIdentity)).toBe(false);
    } finally {
      proc?.kill('SIGKILL');
      if (proc) await proc.exited;
      for (const [pid, identity] of [[target, targetIdentity], [descendant, descendantIdentity]] as const) {
        if (pid === undefined) continue;
        const remaining = snapshot().find(row => row.pid === pid && row.identity === identity);
        if (remaining && !remaining.stat.startsWith('Z')) {
          try { process.kill(pid, 'SIGKILL'); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          }
        }
      }
      rmSync(home, { recursive: true, force: true });
    }
  }, 10_000);
}

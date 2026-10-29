import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttemptStore } from '../src/attempt-store';
import { openRunnerDb } from '../src/db';
import {
  boundedWait,
  DescendantTracker,
  drainToLog,
  killGroup,
  listProcesses,
  parseLsofCwds,
  PS_COLUMNS,
  PS_ENV,
  parsePs,
  type ProcessIdentity,
  processIdentity,
  recordGroup,
  sameProcess,
  sweepCloneProcesses,
} from '../src/processes';
import { requireLsofOnMacOS } from './prerequisites';

// Every test here runs git or agent processes, which take several times as long on a machine loaded by other suites.
setDefaultTimeout(30_000);

const dirs: string[] = [];
const groups = new Set<number>();
afterEach(() => {
  for (const pgid of groups) {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  groups.clear();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** Starts a shell script as the leader of its own group, as the runner starts agents. */
function spawnGroup(script: string, options: { cwd?: string; stdin?: 'pipe' | 'ignore' } = {}) {
  const proc = Bun.spawn(['sh', '-c', script], {
    cwd: options.cwd,
    detached: true,
    stdin: options.stdin ?? 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  groups.add(proc.pid);
  return proc;
}

/** True once the process is gone or only a zombie waiting to be reaped. */
async function gone(pid: number): Promise<boolean> {
  const rows = await listProcesses();
  const row = rows.find((candidate) => candidate.pid === pid);
  return row === undefined || row.stat.startsWith('Z');
}

async function until(check: () => Promise<boolean> | boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
    await Bun.sleep(20);
  }
}

/** A pid written by the script, once the file holds a whole line. */
async function pidFrom(file: string): Promise<number> {
  let text = '';
  await until(() => {
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return false;
    }
    return text.endsWith('\n');
  });
  return Number(text.trim());
}

const LSTART = /^[A-Z][a-z]{2} [A-Z][a-z]{2} {1,2}\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/;

describe('processIdentity and recordGroup', () => {
  test('a detached child has its own group and an lstart, and recordGroup stores it for the attempt', async () => {
    const proc = spawnGroup('exec sleep 30');
    const identity = await processIdentity(proc.pid);
    expect(identity).toEqual({ pid: proc.pid, pgid: proc.pid, lstart: expect.stringMatching(LSTART) });
    const db = openRunnerDb(join(tempDir('agflow-proc-db-'), 'runner.db'));
    try {
      const store = new AttemptStore(db);
      const record = recordGroup(store, 'T-4-a1', '/w/demo/T-4-a1', identity as ProcessIdentity);
      expect(record).toEqual({ attemptId: 'T-4-a1', clone: '/w/demo/T-4-a1', ...(identity as ProcessIdentity) });
      expect(store.processes('T-4-a1')).toEqual([record]);
    } finally {
      db.close();
    }
  });

  test('a process that is gone has no identity', async () => {
    const proc = Bun.spawn(['true'], { stdout: 'ignore', stderr: 'ignore' });
    await proc.exited;
    expect(await processIdentity(proc.pid)).toBeNull();
  });

  test('sameProcess compares pid and lstart', () => {
    const a = { pid: 10, pgid: 10, lstart: 'Thu Oct 29 13:04:14 2026' };
    const regrouped: ProcessIdentity = { ...a, pgid: 11 };
    expect(sameProcess(a, regrouped)).toBe(true);
    expect(sameProcess(a, { ...a, lstart: 'Thu Oct 29 13:04:15 2026' })).toBe(false);
    expect(sameProcess(a, { ...a, pid: 11 })).toBe(false);
  });
});

describe('killGroup', () => {
  test('signals the whole group while the identity matches', async () => {
    const dir = tempDir('agflow-proc-kill-');
    const proc = spawnGroup(`sleep 30 & echo $! > ${dir}/member; wait`);
    const member = await pidFrom(join(dir, 'member'));
    const identity = (await processIdentity(proc.pid)) as ProcessIdentity;
    expect(await killGroup(identity, 'SIGKILL')).toBe(true);
    await until(() => gone(proc.pid));
    await until(() => gone(member));
  });

  test('signals nothing when the recorded lstart differs, as after PID reuse', async () => {
    const proc = spawnGroup('exec sleep 30');
    const identity = (await processIdentity(proc.pid)) as ProcessIdentity;
    const reused = { ...identity, lstart: 'Thu Jan  1 00:00:00 1970' };
    expect(await killGroup(reused, 'SIGKILL')).toBe(false);
    await Bun.sleep(50);
    expect(await processIdentity(proc.pid)).toEqual(identity);
  });

  test('never signals process group 1 or 0, even for the real identity of pid 1', async () => {
    const launchd = (await processIdentity(1)) as ProcessIdentity;
    expect(launchd.pgid).toBe(1);
    // A real kill(-1) would signal every process the user owns, so the signals are recorded instead.
    const sent: [number, string | number | undefined][] = [];
    const realKill = process.kill;
    process.kill = ((pid: number, signal?: string | number) => {
      sent.push([pid, signal]);
      return true;
    }) as typeof process.kill;
    try {
      expect(await killGroup(launchd, 'SIGKILL')).toBe(false);
      expect(await killGroup({ pid: 0, pgid: 0, lstart: launchd.lstart }, 'SIGKILL')).toBe(false);
    } finally {
      process.kill = realKill;
    }
    expect(sent).toEqual([]);
  });
});

describe('DescendantTracker', () => {
  test('a snapshot keeps a grandchild that started its own group after its parent exited', async () => {
    const dir = tempDir('agflow-proc-tree-');
    // The middle shell starts the grandchild in a group of its own, then waits for a line on stdin and exits.
    const middle = `sh -c 'perl -e "setpgrp(0, 0); exec @ARGV" sleep 30 & echo $! > ${dir}/grandchild; read line'`;
    const agent = spawnGroup(`${middle}; sleep 30`, { stdin: 'pipe' });
    const grandchild = await pidFrom(join(dir, 'grandchild'));
    groups.add(grandchild);
    await until(async () => (await processIdentity(grandchild))?.pgid === grandchild);
    const root = (await processIdentity(agent.pid)) as ProcessIdentity;
    const tracker = new DescendantTracker();
    await tracker.snapshot([root]);
    expect(tracker.groups().map((group) => group.pgid)).toContain(grandchild);
    // The middle shell exits; the grandchild is reparented and no longer descends from the agent.
    const parent = (await listProcesses()).find((row) => row.pid === grandchild)?.ppid as number;
    expect(parent).not.toBe(root.pid);
    const stdin = agent.stdin as import('bun').FileSink;
    stdin.write('go\n');
    await stdin.end();
    await until(() => gone(parent));
    await tracker.snapshot([root]);
    const tracked = tracker.groups().find((group) => group.pgid === grandchild) as ProcessIdentity;
    expect(tracked).toEqual((await processIdentity(grandchild)) as ProcessIdentity);
    expect(tracker.groups().map((group) => group.pgid)).toContain(root.pgid);
    expect(await killGroup(tracked, 'SIGKILL')).toBe(true);
    await until(() => gone(grandchild));
    // A group whose members are all gone is forgotten.
    await tracker.snapshot([root]);
    expect(tracker.groups().map((group) => group.pgid)).not.toContain(grandchild);
  });

  test('works from injected ps rows: descendants of the roots and their groups', async () => {
    const lstart = 'Thu Oct 29 13:04:14 2026';
    const row = (pid: number, ppid: number, pgid: number) => ({ pid, ppid, pgid, stat: 'S', lstart, command: 'x' });
    let rows = [row(100, 1, 100), row(101, 100, 100), row(102, 101, 102), row(103, 102, 102), row(200, 1, 200)];
    const tracker = new DescendantTracker(async () => rows);
    await tracker.snapshot([{ pid: 100, pgid: 100, lstart }]);
    expect(tracker.groups()).toEqual([
      { pid: 100, pgid: 100, lstart },
      { pid: 102, pgid: 102, lstart },
    ]);
    // 102 exits and 103 is reparented to launchd: its group is still known through 103.
    rows = [row(100, 1, 100), row(101, 100, 100), row(103, 1, 102), row(200, 1, 200)];
    await tracker.snapshot([{ pid: 100, pgid: 100, lstart }]);
    expect(tracker.groups()).toEqual([
      { pid: 100, pgid: 100, lstart },
      { pid: 103, pgid: 102, lstart },
    ]);
    // A new process that reuses a remembered pid with another start time is not adopted.
    rows = [row(100, 1, 100), { ...row(103, 1, 102), lstart: 'Thu Oct 29 14:00:00 2026' }];
    await tracker.snapshot([{ pid: 100, pgid: 100, lstart }]);
    expect(tracker.groups()).toEqual([{ pid: 100, pgid: 100, lstart }]);
  });
});

describe('sweepCloneProcesses', () => {
  test.skipIf(process.platform !== 'darwin')(
    'kills a process whose cwd is inside the clone and leaves one outside it (the runner supports darwin-arm64 only; design 7.1)',
    async () => {
      requireLsofOnMacOS();
      const clone = tempDir('agflow-proc-clone-');
      mkdirSync(join(clone, 'src', 'deep'), { recursive: true });
      const outside = tempDir('agflow-proc-outside-');
      const inside = spawnGroup('exec sleep 30', { cwd: join(clone, 'src', 'deep') });
      const elsewhere = spawnGroup('exec sleep 30', { cwd: outside });
      await until(async () => (await processIdentity(inside.pid)) !== null);
      const result = await sweepCloneProcesses(clone);
      expect(result).toEqual({ killed: [inside.pid], skipped: null });
      await until(() => gone(inside.pid));
      expect(await gone(elsewhere.pid)).toBe(false);
    },
  );

  test('refuses an empty, relative or root clone path before running lsof', async () => {
    const dir = tempDir('agflow-proc-lsof-');
    const marker = join(dir, 'ran');
    const lsof = join(dir, 'lsof');
    writeFileSync(lsof, `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(lsof, 0o755);
    for (const clone of ['', 'work/T-4-a1', '/', '/tmp/../']) {
      await expect(sweepCloneProcesses(clone, { lsof })).rejects.toThrow(/clone/);
    }
    expect(existsSync(marker)).toBe(false);
  });

  test('is skipped with a reason where lsof is missing', async () => {
    const clone = tempDir('agflow-proc-clone-');
    expect(await sweepCloneProcesses(clone, { lsof: '/nonexistent/lsof' })).toEqual({
      killed: [],
      skipped: 'lsof is not available (/nonexistent/lsof)',
    });
  });
});

describe('parsers', () => {
  test('parsePs reads rows whose commands contain spaces, with padded days', () => {
    const output = [
      '    1     0     1 Ss   Fri Oct 23 21:09:55 2026     /sbin/launchd',
      '  335     1   335 Ss   Fri Oct  2 21:10:36 2026     /usr/libexec/UserEventAgent (System)',
      '73157 66440 73157 S+   Thu Oct 29 13:46:05 2026     /bin/zsh -c echo "a  b" && sleep 1',
      '  400   335   335 Z    Thu Oct 29 13:46:05 2026     ',
      '',
    ].join('\n');
    expect(parsePs(output)).toEqual([
      { pid: 1, ppid: 0, pgid: 1, stat: 'Ss', lstart: 'Fri Oct 23 21:09:55 2026', command: '/sbin/launchd' },
      {
        pid: 335,
        ppid: 1,
        pgid: 335,
        stat: 'Ss',
        lstart: 'Fri Oct  2 21:10:36 2026',
        command: '/usr/libexec/UserEventAgent (System)',
      },
      {
        pid: 73157,
        ppid: 66440,
        pgid: 73157,
        stat: 'S+',
        lstart: 'Thu Oct 29 13:46:05 2026',
        command: '/bin/zsh -c echo "a  b" && sleep 1',
      },
      { pid: 400, ppid: 335, pgid: 335, stat: 'Z', lstart: 'Thu Oct 29 13:46:05 2026', command: '' },
    ]);
  });

  test('ps run with PS_COLUMNS and PS_ENV gives rows whose lstart matches processIdentity', async () => {
    // PS_ENV wins over a caller's own locale and time zone.
    const local = { ...process.env, LC_ALL: 'de_DE.UTF-8', TZ: 'Asia/Tokyo' };
    const proc = Bun.spawn(['ps', '-axo', PS_COLUMNS], { env: { ...local, ...PS_ENV }, stdout: 'pipe' });
    const rows = parsePs(await new Response(proc.stdout).text());
    const own = rows.find((row) => row.pid === process.pid);
    expect(own?.lstart).toBe((await processIdentity(process.pid))?.lstart as string);
  });

  test('parseLsofCwds reads lsof -Fpn records into pid and cwd', () => {
    const records = ['p411', 'fcwd', 'n/', 'p672', 'fcwd', 'n/private/tmp/work dir/T-4-a1', 'p700', 'fcwd', ''];
    const output = records.join('\n');
    expect(parseLsofCwds(output)).toEqual([
      { pid: 411, cwd: '/' },
      { pid: 672, cwd: '/private/tmp/work dir/T-4-a1' },
    ]);
  });
});

describe('drainToLog and boundedWait', () => {
  test('drainToLog keeps at most its bound and never stalls the writer', async () => {
    const log = join(tempDir('agflow-proc-log-'), 'logs', 'T-4-a1.log');
    const script = 'head -c 2000000 /dev/zero | tr "\\0" x';
    const proc = Bun.spawn(['sh', '-c', script], { stdout: 'pipe', stderr: 'ignore' });
    const drained = await drainToLog(proc.stdout, log, { maxBytes: 1_000 });
    expect(await proc.exited).toBe(0);
    expect(drained).toEqual({ bytes: 2_000_000, kept: 1_000 });
    const text = readFileSync(log, 'utf8');
    expect(text.startsWith('x'.repeat(1_000))).toBe(true);
    expect(text.slice(1_000)).toBe('\n[agflow: output truncated after 1000 bytes]\n');
    expect(statSync(log).size).toBeLessThan(1_100);
  });

  test('drainToLog appends to a log that other writers share', async () => {
    const log = join(tempDir('agflow-proc-log-'), 'attempt.log');
    writeFileSync(log, 'runner: started\n');
    const proc = Bun.spawn(['sh', '-c', 'echo agent output'], { stdout: 'pipe', stderr: 'ignore' });
    expect(await drainToLog(proc.stdout, log, { maxBytes: 1_000 })).toEqual({ bytes: 13, kept: 13 });
    expect(readFileSync(log, 'utf8')).toBe('runner: started\nagent output\n');
  });

  test('boundedWait returns after its bound while a grandchild still holds the pipe', async () => {
    const log = join(tempDir('agflow-proc-log-'), 'attempt.log');
    const script = 'sleep 30 & echo started';
    const proc = Bun.spawn(['sh', '-c', script], { detached: true, stdout: 'pipe', stderr: 'ignore' });
    groups.add(proc.pid);
    const drain = drainToLog(proc.stdout, log, { maxBytes: 1_000 });
    expect(await proc.exited).toBe(0);
    const started = Date.now();
    expect(await boundedWait(drain, 150)).toEqual({ done: false });
    expect(Date.now() - started).toBeLessThan(1_000);
    process.kill(-proc.pid, 'SIGKILL');
    expect(await boundedWait(drain, 5_000)).toEqual({ done: true, value: { bytes: 8, kept: 8 } });
    expect(readFileSync(log, 'utf8')).toBe('started\n');
  });
});

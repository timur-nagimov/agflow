import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  descendantsOf,
  freezeTree,
  isAlive,
  listProcesses,
  processesInDir,
  signalGroup,
  thawTree,
  waitUntilGone,
} from '../src/harness/proc';

const pids = new Set<number>();
const dirs: string[] = [];
afterEach(() => {
  for (const pid of pids) {
    for (const signal of ['SIGCONT', 'SIGKILL'] as const) {
      try {
        process.kill(pid, signal);
      } catch {
        // Already gone.
      }
    }
  }
  pids.clear();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Why the tests that look for processes by their cwd do not run here, or null: they need lsof, which macOS ships. */
const NO_LSOF =
  process.platform !== 'darwin' && Bun.which('lsof') === null
    ? 'lsof is not on PATH; the runner supports darwin-arm64 only (design 7.1), where /usr/sbin has it'
    : null;

/** Why the tests of what macOS's lsof reports do not run here, or null. */
const NOT_MACOS = process.platform !== 'darwin' ? 'the runner supports darwin-arm64 only; design 7.1' : null;

/** test, or test.skip with the reason in its title, so a skipped run says why. */
function testUnless(reason: string | null): (name: string, body: () => Promise<void>) => void {
  return (name, body) => (reason === null ? test(name, body) : test.skip(`${name} (skipped: ${reason})`, body));
}

/** A directory under /tmp, given by its /tmp path, which is a link to /private/tmp on macOS. */
function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join('/tmp', prefix));
  dirs.push(dir);
  return dir;
}

/** Starts a shell script as the leader of its own group, as the runner starts agents. */
function spawnGroup(script: string, options: { cwd?: string } = {}) {
  const proc = Bun.spawn(['sh', '-c', script], {
    cwd: options.cwd,
    detached: true,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  pids.add(proc.pid);
  return proc;
}

async function until(check: () => Promise<boolean> | boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
    await Bun.sleep(20);
  }
}

/** The pid a script wrote to file, once the file holds a whole line. */
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
  const pid = Number(text.trim());
  pids.add(pid);
  return pid;
}

/**
 * sh with a background sleep in its group, a background sleep that leads a group of its own, and a nested sh whose
 * sleep is a grandchild. Each pid goes to a file of its own in dir.
 */
async function spawnTree(dir: string) {
  const script = [
    `sleep 31 & echo $! > ${dir}/child`,
    `perl -e 'setpgrp(0, 0); exec @ARGV' sleep 32 & echo $! > ${dir}/own`,
    `sh -c 'sleep 33 & echo $! > ${dir}/grandchild; wait' & echo $! > ${dir}/nested`,
    'wait',
  ].join('\n');
  const root = spawnGroup(script);
  const [child, ownGroup, nested, grandchild] = await Promise.all(
    ['child', 'own', 'nested', 'grandchild'].map((name) => pidFrom(join(dir, name))),
  );
  await until(async () => (await listProcesses([ownGroup as number]))[0]?.pgid === ownGroup);
  return {
    root: root.pid,
    child: child as number,
    ownGroup: ownGroup as number,
    nested: nested as number,
    grandchild: grandchild as number,
  };
}

async function stats(list: number[]): Promise<Map<number, string>> {
  return new Map((await listProcesses(list)).map((row) => [row.pid, row.stat]));
}

describe('descendantsOf', () => {
  test('finds the children and grandchildren of a spawned tree and no unrelated process', async () => {
    const tree = await spawnTree(tmpDir('agflow-proc-'));
    const unrelated = spawnGroup('exec sleep 34');
    const found = await descendantsOf(tree.root);
    expect(found.map((row) => row.pid).sort((a, b) => a - b)).toEqual(
      [tree.child, tree.ownGroup, tree.nested, tree.grandchild].sort((a, b) => a - b),
    );
    expect(found.find((row) => row.pid === tree.ownGroup)?.pgid).toBe(tree.ownGroup);
    expect(found.find((row) => row.pid === tree.child)?.pgid).toBe(tree.root);
    expect(found.map((row) => row.pid)).not.toContain(unrelated.pid);
    expect(found.map((row) => row.pid)).not.toContain(tree.root);
    expect(await descendantsOf(unrelated.pid)).toEqual([]);
  });
});

describe('freezeTree and thawTree', () => {
  test('freeze stops the root first, then every descendant; thaw resumes them all', async () => {
    const tree = await spawnTree(tmpDir('agflow-proc-'));
    const all = [tree.root, tree.child, tree.ownGroup, tree.nested, tree.grandchild];
    const frozen = await freezeTree(tree.root);
    expect(frozen[0]).toBe(tree.root);
    expect([...frozen].sort((a, b) => a - b)).toEqual([...all].sort((a, b) => a - b));
    await until(async () => [...(await stats(all)).values()].every((stat) => stat.startsWith('T')));
    const thawed = await thawTree(tree.root);
    expect([...thawed].sort((a, b) => a - b)).toEqual([...all].sort((a, b) => a - b));
    await until(async () => [...(await stats(all)).values()].every((stat) => !stat.startsWith('T')));
    expect((await stats(all)).size).toBe(all.length);
  });
});

describe('signalGroup', () => {
  test('kills every member of a detached group and leaves the test process alive', async () => {
    const dir = tmpDir('agflow-proc-');
    const root = spawnGroup(`sleep 35 & echo $! > ${dir}/first; sleep 36 & echo $! > ${dir}/second; wait`);
    const members = await Promise.all([pidFrom(join(dir, 'first')), pidFrom(join(dir, 'second'))]);
    expect(await signalGroup(root.pid, 'SIGKILL')).toBe(true);
    for (const pid of [root.pid, ...members]) await waitUntilGone(pid, { timeoutMs: 5_000 });
    expect(await isAlive(process.pid)).toBe(true);
    // The group is gone now: nothing is signalled.
    expect(await signalGroup(root.pid, 'SIGKILL')).toBe(false);
  });

  test("refuses group 0, group 1 and the test process's own group", async () => {
    const own = (await listProcesses([process.pid]))[0]?.pgid as number;
    for (const pgid of [0, 1, own]) {
      await expect(signalGroup(pgid, 'SIGTERM')).rejects.toThrow(/refusing to signal group/);
    }
    expect(await isAlive(process.pid)).toBe(true);
  });
});

describe('processesInDir', () => {
  testUnless(NO_LSOF)(
    'finds a process whose cwd is inside a directory given by its /tmp or /private/tmp path',
    async () => {
      const dir = tmpDir('agflow-proc-dir-');
      mkdirSync(join(dir, 'work', 'T-1-a1'), { recursive: true });
      const outside = tmpDir('agflow-proc-out-');
      const inside = spawnGroup('exec sleep 37', { cwd: join(dir, 'work', 'T-1-a1') });
      const elsewhere = spawnGroup('exec sleep 38', { cwd: outside });
      await until(async () => (await processesInDir(dir)).length > 0);
      for (const given of [dir, realpathSync(dir)]) {
        const found = await processesInDir(given);
        expect(found.map((row) => row.pid)).toEqual([inside.pid]);
        expect(found[0]?.command).toContain('sleep 37');
      }
      expect((await processesInDir(outside)).map((row) => row.pid)).toEqual([elsewhere.pid]);
    },
  );

  // A removed cwd is found by the resolved path macOS's lsof reports for it.
  testUnless(NOT_MACOS)(
    'finds a process whose cwd was removed under either path; a path that never existed gives nothing',
    async () => {
      const dir = tmpDir('agflow-proc-gone-');
      const clone = join(dir, 'work', 'demo', 'T-1-a1');
      mkdirSync(clone, { recursive: true });
      const survivor = spawnGroup('exec sleep 40', { cwd: clone });
      await until(async () => (await processesInDir(dir)).length > 0);
      // Remove the whole tree above the clone, as a cleanup that runs while something still works in it.
      rmSync(join(dir, 'work'), { recursive: true, force: true });
      for (const given of [clone, join(realpathSync(dir), 'work', 'demo', 'T-1-a1'), dir]) {
        expect((await processesInDir(given)).map((row) => row.pid)).toEqual([survivor.pid]);
      }
      expect(await processesInDir(join(dir, 'missing'))).toEqual([]);
    },
  );

  test('refuses a relative path', async () => {
    await expect(processesInDir('work/demo')).rejects.toThrow('not absolute');
  });
});

describe('waitUntilGone', () => {
  test('resolves when a pid exits, and rejects naming the pid after its timeout', async () => {
    const short = spawnGroup('sleep 0.2');
    await waitUntilGone(short.pid, { timeoutMs: 5_000 });
    expect(await isAlive(short.pid)).toBe(false);
    const long = spawnGroup('exec sleep 39');
    await expect(waitUntilGone(long.pid, { timeoutMs: 200 })).rejects.toThrow(
      `process ${long.pid} is still running after 200 ms`,
    );
    expect(await isAlive(long.pid)).toBe(true);
  });
});

describe('trackProcess', () => {
  const PROC = join(import.meta.dir, '../src/harness/proc.ts');

  /**
   * A bun process that tracks a frozen tree, as a cluster tracks a frozen runner, writes the pids it froze, and then
   * ends as `how` says, without any afterAll.
   */
  async function endTracking(how: 'exit' | 'SIGTERM'): Promise<number[]> {
    const dir = tmpDir('agflow-track-');
    const script = join(dir, 'track.ts');
    const end = how === 'exit' ? 'process.exit(0);' : "process.kill(process.pid, 'SIGTERM'); await Bun.sleep(60_000);";
    writeFileSync(
      script,
      [
        `import { freezeTree, trackProcess } from ${JSON.stringify(PROC)};`,
        "const root = Bun.spawn(['sh', '-c', 'sleep 41 & sleep 42 & wait'], { stdin: 'ignore' });",
        'trackProcess(root);',
        'await Bun.sleep(300);',
        'const frozen = await freezeTree(root.pid);',
        `await Bun.write(${JSON.stringify(join(dir, 'frozen'))}, frozen.join(' ') + '\\n');`,
        end,
      ].join('\n'),
    );
    const tracker = Bun.spawn([process.execPath, script], { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' });
    const code = await tracker.exited;
    const frozen = readFileSync(join(dir, 'frozen'), 'utf8').trim().split(' ').map(Number);
    for (const pid of frozen) pids.add(pid);
    expect({ code, stderr: await new Response(tracker.stderr).text() }).toEqual({
      code: how === 'exit' ? 0 : 143,
      stderr: '',
    });
    return frozen;
  }

  test('a tracked tree, frozen, is killed when the process exits without closing it', async () => {
    const frozen = await endTracking('exit');
    expect(frozen.length).toBe(3);
    for (const pid of frozen) await waitUntilGone(pid, { timeoutMs: 5_000 });
  });

  test('a tracked tree, frozen, is killed when SIGTERM ends the process, which exits 128 + 15', async () => {
    const frozen = await endTracking('SIGTERM');
    expect(frozen.length).toBe(3);
    for (const pid of frozen) await waitUntilGone(pid, { timeoutMs: 5_000 });
  });
});


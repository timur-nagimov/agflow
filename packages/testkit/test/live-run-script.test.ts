import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { Attempt, Task } from '@agflow/core';
import { runnerPaths } from '@agflow/runner/src/paths';
import { createRunnerConfig } from '@agflow/runner/src/service/runner-json';
import { VENDOR_PINS, vendorBinary } from '@agflow/runner/src/vendor/pins';
import { gitIn } from '../src/git-fixtures';
import type { Cluster } from '../src/harness/cluster';
import type { ProcessInfo } from '../src/harness/proc';
import { E2E_PLATFORM } from '../src/harness/env';
import { CLUSTER_CLOSED, confirmTakeoverReady, inLiveCluster, LIVE_OPTIONS, runTakeoverCheck, type TakeoverPerson } from '../src/live';
import { RAN_TO_END, type ScenarioResult } from '../src/scenarios/result';
import { TAKEOVER } from '../src/scenarios/takeover';

const ROOT = join(import.meta.dir, '../../..');
const SCRIPT = join(ROOT, 'scripts/live-run.ts');
const RUNBOOK = join(ROOT, 'docs/m2-live-run.md');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmpDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join('/tmp', prefix)));
  dirs.push(dir);
  return dir;
}

/** The script run as `bun run live-run` runs it, with a scratch HOME and AGFLOW_HOME. */
async function liveRun(args: string[], agflowHome: string): Promise<{ code: number; output: string }> {
  const proc = Bun.spawn([process.execPath, '--no-env-file', SCRIPT, ...args], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: tmpDir('agf-home-'), AGFLOW_HOME: agflowHome },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, output: `${stdout}${stderr}` };
}

describe('scripts/live-run.ts', () => {
  test('--help prints the options and exits 0 without starting anything', async () => {
    const agflowHome = tmpDir('agf-live-');
    const { code, output } = await liveRun(['--help'], agflowHome);
    expect(code).toBe(0);
    for (const option of LIVE_OPTIONS) expect(output).toContain(option.flag);
    expect(output).not.toContain('Checking');
    expect(existsSync(join(agflowHome, 'runner'))).toBe(false);
  }, 30_000);

  test('an unknown option exits 2 with the usage', async () => {
    const { code, output } = await liveRun(['--scenarios', 'lost-laptop'], tmpDir('agf-live-'));
    expect(code).toBe(2);
    expect(output).toContain("unknown scenario 'lost-laptop'");
    expect(output).toContain('Usage: bun run live-run');
  }, 30_000);

  test('with a logged-out vendor home, it stops before the hub starts and names the vendor and setup', async () => {
    const agflowHome = tmpDir('agf-live-');
    mkdirSync(join(agflowHome, 'runner', 'homes', 'claude'), { recursive: true });
    // The pinned claude a setup installed, stood in for by a script that reports no login.
    const pins = VENDOR_PINS[E2E_PLATFORM];
    if (!pins) throw new Error(`no ${E2E_PLATFORM} pins`);
    const claude = join(agflowHome, 'runner', vendorBinary('claude', pins.claude.version));
    mkdirSync(dirname(claude), { recursive: true });
    writeFileSync(claude, '#!/bin/sh\necho \'{"loggedIn": false}\'\nexit 1\n');
    chmodSync(claude, 0o755);
    const { code, output } = await liveRun(['--runners', 'claude', '--scenarios', 'killed-agent'], agflowHome);
    expect(code).toBe(1);
    expect(output).toContain('claude: not logged in to Claude');
    expect(output).toContain('`agflow runner setup`');
    expect(output).not.toContain('The hub is at');
  }, 30_000);
});

/** A cluster stand-in with what inLiveCluster reads of it, whose close does what it is given. */
function closingCluster(close: () => Promise<void>): { cluster: Cluster; closes: { keep?: boolean }[] } {
  const closes: { keep?: boolean }[] = [];
  const cluster = {
    hub: { url: 'http://127.0.0.1:1' },
    dir: '/tmp/agf-e2e-fake',
    close: (options: { keep?: boolean } = {}) => {
      closes.push(options);
      return close();
    },
  } as unknown as Cluster;
  return { cluster, closes };
}

const PASSED: ScenarioResult = {
  scenario: 'killed agent',
  vendor: 'claude',
  checks: [{ name: RAN_TO_END, passed: true, detail: '1 checks made' }],
  passed: true,
  dump: null,
};

describe('inLiveCluster', () => {
  test("gives the body's results and closes the cluster, keeping its files only when asked", async () => {
    const { cluster, closes } = closingCluster(async () => {});
    const results = await inLiveCluster('killed-agent', 'claude', async () => cluster, false, async () => [PASSED]);
    expect(results).toEqual([PASSED]);
    expect(closes).toEqual([{ keep: false }]);
  });

  test('never throws: a failed close, a body that throws and a cluster that does not start each add a failed result', async () => {
    const lines: string[] = [];
    const log = (line = '') => lines.push(line);
    const failing = closingCluster(() => Promise.reject(new Error('closing the cluster:\nprocess 42 still ran')));
    const run = async () => [PASSED];
    const closed = await inLiveCluster('killed-agent', 'codex', async () => failing.cluster, false, run, log);
    expect(closed.map((result) => [result.scenario, result.passed])).toEqual([
      ['killed agent', true],
      ['killed-agent: the cluster', false],
    ]);
    expect(closed[1]?.checks.map((check) => check.name)).toEqual([CLUSTER_CLOSED]);
    expect(closed[1]?.checks[0]?.detail).toContain('process 42 still ran');
    // close() keeps its first outcome: it is not called again.
    expect(failing.closes).toEqual([{ keep: false }]);
    expect(lines).toContain('FAILED: closing the cluster: closing the cluster:\nprocess 42 still ran');

    const thrown = closingCluster(async () => {});
    const stopped = await inLiveCluster('lost-lead', 'claude', async () => thrown.cluster, false, async () => {
      throw new Error('the hub went away');
    });
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toMatchObject({ scenario: 'lost-lead', passed: false });
    expect(stopped[0]?.checks[0]).toMatchObject({ name: RAN_TO_END, passed: false });
    expect(stopped[0]?.checks[0]?.detail).toContain('the hub went away');
    // A failed cluster keeps its files.
    expect(thrown.closes).toEqual([{ keep: true }]);

    const unstartable = () => Promise.reject(new Error('no port'));
    const unstarted = await inLiveCluster('closed-laptop', 'claude', unstartable, false, run);
    expect(unstarted).toHaveLength(1);
    expect(unstarted[0]).toMatchObject({ scenario: 'closed-laptop: the cluster', passed: false });
  });
});

describe('runTakeoverCheck', () => {
  test("after a take-over that failed, it never calls the person's hand-back nor runs git in the clone", async () => {
    const root = tmpDir('agf-takeover-');
    // The agent's own .git, still in the clone: its fsmonitor leaves a mark whenever git status runs there.
    const clone = join(root, 'clone');
    mkdirSync(clone);
    await gitIn(clone, ['init', '--quiet']);
    const mark = join(root, 'fsmonitor-ran');
    const monitor = join(root, 'fsmonitor.sh');
    writeFileSync(monitor, `#!/bin/sh\ntouch '${mark}'\n`);
    chmodSync(monitor, 0o755);
    await gitIn(clone, ['config', 'core.fsmonitor', monitor]);
    writeFileSync(join(clone, 'b.txt'), 'b\n');
    // The trap works: git status in the clone runs it.
    await gitIn(clone, ['status', '--porcelain']);
    expect(existsSync(mark)).toBe(true);
    rmSync(mark);

    const homes = { claude: join(root, 'claude'), codex: join(root, 'codex') };
    for (const home of Object.values(homes)) mkdirSync(home);
    const paths = runnerPaths(join(root, 'agflow'));
    const config = createRunnerConfig({
      machineId: 'machine',
      name: 'alice-mac',
      capturedPath: '/usr/bin:/bin',
      connectivity: {},
      commitIdentity: null,
      homes,
    });
    const taskId = 'T-1';
    const a1 = 'T-1-a1';
    // The runner reported the take-over with an error, before it replaced the clone's .git (design 6.12).
    const attempt = {
      id: a1,
      agentId: 'A-1',
      vendor: 'claude',
      status: 'ended',
      endReason: 'taken_over',
      endedAt: 2,
      sessionRef: 'session-1',
      wipRef: null,
      wipSha: null,
      takeover: {
        local: null,
        anywhere: '',
        ref: 'refs/agflow/T-1/takeover/alice',
        error: 'restore failed: .claude/settings.json',
        handingBack: null,
      },
    } as unknown as Attempt;
    const task = {
      id: taskId,
      status: 'blocked',
      blockedKind: 'takeover',
      blockedReason: 'taken over by alice',
      branch: 'agflow/T-1-files',
    } as unknown as Task;
    // The long command a1 runs in its clone when the person takes over, as the process lookup reports it: a stand-in
    // for lsof, which a Linux CI may lack.
    const looked: string[] = [];
    const processesIn = async (dir: string): Promise<ProcessInfo[]> => {
      looked.push(dir);
      const lstart = 'Thu Jan  1 00:00:00 2026';
      return [{ pid: 4242, ppid: 1, pgid: 4242, stat: 'S', lstart, command: TAKEOVER.longCommand }];
    };
    const cluster = {
      vendor: 'claude',
      origin: { path: join(root, 'origin.git') },
      person: {
        login: 'alice',
        createTasks: async () => [task],
        attempt: async () => ({ attempt, log: [] }),
        task: async () => ({ task, notes: [] }),
      },
      runnerOf: async () => ({ home: { paths, config }, clonePath: () => clone }),
      waitForEvent: async () => ({ id: 1, type: 'attempt.ended', subject: taskId, data: { attemptId: a1 } }),
      async waitFor<T>(what: string, check: () => Promise<T | null | undefined | false>): Promise<T> {
        const deadline = Date.now() + 20_000;
        for (;;) {
          const value = await check();
          if (value !== null && value !== undefined && value !== false) return value;
          if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
          await Bun.sleep(50);
        }
      },
      dump: async () => 'the dump',
    } as unknown as Cluster;
    let handedBack = false;
    const person: TakeoverPerson = {
      takeOver: async () => {},
      handBack: async () => {
        handedBack = true;
        return { resumed: true };
      },
    };
    const results = await runTakeoverCheck(cluster, person, { scripted: false, processesIn });
    expect(looked).toEqual([clone]);
    expect(handedBack).toBe(false);
    expect(existsSync(mark)).toBe(false);
    const [own, takeover] = results;
    expect(own?.checks.map((check) => [check.name, check.passed])).toEqual([[RAN_TO_END, false]]);
    expect(own?.checks[0]?.detail).toContain('the take-over did not hand the clone over');
    expect(own?.checks[0]?.detail).toContain('restore failed: .claude/settings.json');
    // The take-over's own checks say why they ran no git in the clone.
    const replaced = takeover?.checks.find((check) => check.name === TAKEOVER.checks.gitReplaced);
    expect(replaced?.passed).toBe(false);
    expect(replaced?.detail).toContain('not run');
  }, 30_000);
});

describe('the runbook', () => {
  test('names every option parseLiveArgs accepts and has a Results section', () => {
    const runbook = readFileSync(RUNBOOK, 'utf8');
    for (const option of LIVE_OPTIONS) expect(runbook).toContain(`\`${option.flag}`);
    expect(runbook).toMatch(/^## Results$/m);
  });
});

describe('package.json', () => {
  test('the root script `bun run live-run` runs scripts/live-run.ts, kept awake', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['live-run']).toBe('caffeinate -i bun scripts/live-run.ts');
  });
});

describe('take-over readiness', () => {
  test('explains the window and waits before starting each vendor cluster', async () => {
    const order: string[] = [];
    for (const vendor of ['claude', 'codex'] as const) {
      const { cluster } = closingCluster(async () => {});
      await inLiveCluster('take-over check', vendor, async () => {
        order.push(`start ${vendor}`);
        return cluster;
      }, false, async () => [PASSED], () => {}, () => confirmTakeoverReady(vendor, {
        isTTY: true,
        log: (line = '') => order.push(line),
        ask: (question) => { order.push(question); return ''; },
      }));
      const start = order.indexOf(`start ${vendor}`);
      expect(order[start - 1]).toContain('Press Enter');
      expect(order[start - 2]).toContain('10 minutes');
      expect(order[start - 2]).toContain(vendor);
    }
  });

  test('non-TTY input and a typed q never start the cluster', async () => {
    for (const [isTTY, answer] of [[false, null], [true, 'q'], [true, ' Skip ']] as const) {
      let starts = 0;
      const result = await inLiveCluster('take-over check', 'codex', async () => {
        starts++;
        throw new Error('must not start');
      }, false, async () => [], () => {}, () => confirmTakeoverReady('codex', {
        isTTY, log: () => {}, ask: () => answer,
      }));
      expect(starts).toBe(0);
      expect(result[0]?.passed).toBe(false);
      expect(result[0]?.checks[0]?.detail).toMatch(/TTY|skipped/);
    }
  });

  test('a bare Enter starts the cluster: Bun prompt() gives null for an empty line', async () => {
    const { cluster } = closingCluster(async () => {});
    let starts = 0;
    const result = await inLiveCluster('take-over check', 'claude', async () => {
      starts++;
      return cluster;
    }, false, async () => [PASSED], () => {}, () => confirmTakeoverReady('claude', {
      isTTY: true, log: () => {}, ask: () => null,
    }));
    expect(starts).toBe(1);
    expect(result.every((entry) => entry.passed)).toBe(true);
  });
});

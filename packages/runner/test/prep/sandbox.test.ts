import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import { memoryLogger } from '../../src/log';
import { runnerPaths } from '../../src/paths';
import { type PrepCommand, prepEnv, prepLayout, prepPolicy, writePrepToolConfig } from '../../src/prep/plan';
import { checkPrepSandbox, PrepSandbox, type SandboxBackend } from '../../src/prep/sandbox';
import { standardProfile } from '../../src/profile';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agflow-prep-sandbox-')));
  dirs.push(root);
  const home = join(root, 'owner');
  const paths = runnerPaths(join(home, '.agflow'));
  const prep = paths.prep('project');
  const layout = prepLayout(prep);
  const clones = [paths.clone('project', 'one'), paths.clone('project', 'two')];
  const otherProject = paths.clone('other', 'three');
  const outside = join(root, 'outside');
  for (const path of [...clones, otherProject, ...Object.values(layout), outside, join(home, '.ssh')]) {
    mkdirSync(path, { recursive: true });
  }
  writePrepToolConfig(prep);
  const secret = 'secret-that-must-not-reach-the-tail';
  const denied = join(home, '.ssh/id_test');
  writeFileSync(denied, secret);
  // The shared cache; scripts and unknown commands get the per-attempt one.
  const install: PrepCommand = { run: ['bun', 'install'] };
  const spec = (argv: string[], index = 0, entry: PrepCommand = install) => {
    const clone = clones[index]!;
    const tmpDir = join(layout.tmp, `private space's-${index}`);
    mkdirSync(tmpDir, { recursive: true });
    const env = prepEnv({ agentEnv: { PATH: '/usr/bin:/bin' }, clone, prep, tmpDir, entry });
    mkdirSync(env.HOME!, { recursive: true });
    return {
      argv,
      cwd: clone,
      env,
      policy: prepPolicy({
        home,
        paths,
        clone,
        prep,
        tmpDir,
        entry,
        profile: standardProfile,
        vendorHomes: { claude: paths.homes.claude, codex: paths.homes.codex },
      }),
    };
  };
  return { root, home, paths, layout, clones, otherProject, outside, secret, denied, spec };
}

function backend(overrides: Partial<SandboxBackend> = {}): SandboxBackend {
  return {
    initialize: async () => {},
    isSupportedPlatform: () => true,
    checkDependencies: () => ({ errors: [], warnings: [] }),
    wrapWithSandboxArgv: async (command) => ({ argv: ['/bin/sh', '-c', command], env: process.env }),
    cleanupAfterCommand: () => {},
    ...overrides,
  };
}

const options = { allowedDomains: standardProfile.network.allowedDomains };
// One process-global runtime, also shared by the self-check; never reset another test file's manager.
const real = new PrepSandbox(options);

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    // An orphan can briefly be a zombie in Linux CI, pending its reaper.
    if (process.platform === 'linux' && /\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))) return false;
    return true;
  } catch (error) {
    if (['ESRCH', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  }
}

for (const mode of ['pass-through', 'real sandbox'] as const) {
  describe.skipIf(mode === 'real sandbox' && process.platform !== 'darwin')(mode, () => {
    const sandbox = mode === 'real sandbox' ? real : new PrepSandbox({ ...options, manager: backend() });

    test('reports a non-zero exit and both output pipes', async () => {
      const f = fixture();
      const result = await sandbox.run(f.spec(['/bin/sh', '-c', 'echo stdout; echo stderr >&2; exit 3']));
      expect(result.code).toBe(3);
      expect(result.signal).toBeNull();
      expect(result.timedOut).toBe(false);
      expect(result.logTail).toContain('stdout');
      expect(result.logTail).toContain('stderr');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    }, 20_000);

    test('drains large output and caps the UTF-8 tail including its marker', async () => {
      const f = fixture();
      const capped = new PrepSandbox({
        ...options,
        tailBytes: 257,
        ...(mode === 'pass-through' ? { manager: backend() } : {}),
      });
      const result = await capped.run(
        f.spec([
          '/bin/sh',
          '-c',
          'i=0; while [ "$i" -lt 12000 ]; do printf "€🙂abcdefghijk"; i=$((i+1)); done; printf "THE-END"',
        ]),
      );
      expect(result.code).toBe(0);
      expect(Buffer.byteLength(result.logTail)).toBeLessThanOrEqual(257);
      expect(result.logTail).toContain('truncated');
      expect(result.logTail).not.toContain('\uFFFD');
      expect(result.logTail.endsWith('THE-END')).toBe(true);
    }, 20_000);

    test('a timeout kills the whole process group', async () => {
      const f = fixture();
      const pidFile = join(f.clones[0]!, 'child.pid');
      let pid: number | undefined;
      try {
        const result = await sandbox.run({
          ...f.spec(['/bin/sh', '-c', 'sleep 30 & echo $! > child.pid; wait']),
          timeoutMs: 3000,
        });
        expect(result.timedOut).toBe(true);
        expect(result.signal).toBe('SIGKILL');
        pid = Number(readFileSync(pidFile, 'utf8').trim());
        expect(pid).toBeGreaterThan(1);
        const deadline = Date.now() + 2000;
        while (running(pid) && Date.now() < deadline) await Bun.sleep(20);
        expect(running(pid)).toBe(false);
      } finally {
        if (pid && running(pid)) process.kill(pid, 'SIGKILL');
      }
    }, 20_000);

    test('a normal exit kills what the command left running in its group', async () => {
      const f = fixture();
      const late = join(f.layout.cache, 'late');
      let pid: number | undefined;
      try {
        const result = await sandbox.run(
          f.spec(['/bin/sh', '-c', 'sleep 30 & echo $! > child.pid; (sleep 1; echo late > "$1") & exit 0', 'sh', late]),
        );
        expect(result.code).toBe(0);
        pid = Number(readFileSync(join(f.clones[0]!, 'child.pid'), 'utf8').trim());
        const deadline = Date.now() + 2000;
        while (running(pid) && Date.now() < deadline) await Bun.sleep(20);
        expect(running(pid)).toBe(false);
        await Bun.sleep(1500);
        expect(existsSync(late)).toBe(false);
      } finally {
        if (pid && running(pid)) process.kill(pid, 'SIGKILL');
      }
    }, 20_000);
  });
}

describe('PrepSandbox backend contract', () => {
  test('shares initialization, denies incompatible global domains, and passes each policy and cwd', async () => {
    let count = 0;
    let config: SandboxRuntimeConfig | undefined;
    const calls: unknown[][] = [];
    let cleanups = 0;
    const manager = backend({
      initialize: async (value, ask, monitor) => {
        count++;
        config = value;
        expect(ask).toBeUndefined();
        expect(monitor).toBe(false);
      },
      wrapWithSandboxArgv: async (...args) => {
        calls.push(args);
        return { argv: ['/bin/sh', '-c', args[0]], env: process.env };
      },
      cleanupAfterCommand: () => {
        cleanups++;
      },
    });
    const a = new PrepSandbox({ ...options, manager });
    const b = new PrepSandbox({ allowedDomains: [...options.allowedDomains].reverse(), manager });
    expect(a.init()).toBe(a.init());
    await Promise.all([a.init(), b.init()]);
    expect(count).toBe(1);
    expect(config?.network).toMatchObject({ strictAllowlist: true, allowLocalBinding: false, deniedDomains: [] });
    expect(config?.filesystem).toEqual({ allowWrite: [], denyWrite: ['/'], denyRead: ['/'], allowRead: [] });
    await expect(new PrepSandbox({ allowedDomains: ['different.example'], manager }).init()).rejects.toThrow('domains');
    const f = fixture();
    const specs = [f.spec(['/usr/bin/true']), f.spec(['/usr/bin/true'], 1)];
    await Promise.all([a.run(specs[0]!), b.run(specs[1]!)]);
    expect(calls.map((call) => call[2])).toEqual(specs.map((spec) => spec.policy));
    expect(calls.map((call) => call[4])).toEqual(specs.map((spec) => spec.cwd));
    expect(cleanups).toBe(2);
    const wrong = f.spec(['/usr/bin/true']);
    wrong.policy.network.allowedDomains = [];
    await expect(a.run(wrong)).rejects.toThrow('domains');
  });

  test('failed initialization is retained without retrying a partly started global runtime', async () => {
    let calls = 0;
    const sandbox = new PrepSandbox({
      ...options,
      manager: backend({
        initialize: async () => {
          calls++;
          throw new Error('cannot start proxies');
        },
      }),
    });
    await expect(sandbox.init()).rejects.toThrow('cannot start proxies');
    await expect(sandbox.init()).rejects.toThrow('cannot start proxies');
    expect(calls).toBe(1);
  });

  test('quotes argv and TMPDIR, keeps only runtime env differences, and logs no environment', async () => {
    const f = fixture();
    const logger = memoryLogger();
    const manager = backend({
      wrapWithSandboxArgv: async (command) => ({
        argv: ['/bin/sh', '-c', `export TMPDIR=/wrong; ${command}`],
        env: { ...process.env, PREP_RUNTIME_TEST: 'runtime' },
      }),
    });
    const sandbox = new PrepSandbox({ ...options, manager, logger });
    const values = ['', "a'b", '$(touch injected)', 'a\nb', '; touch injected', '`touch injected`'];
    const spec = f.spec([
      '/bin/sh',
      '-c',
      'printf "%s\\n" "$@"; printf "%s\\n" "$TMPDIR" "$PREP_RUNTIME_TEST" "${USER-unset}"; touch "$TMPDIR/ok"',
      'sh',
      ...values,
    ]);
    spec.env.PRIVATE_VALUE = 'do-not-log-this';
    const before = { ...process.env };
    const result = await sandbox.run(spec);
    expect(result.code).toBe(0);
    expect(result.logTail).toBe(`${values.join('\n')}\n${spec.env.TMPDIR}\nruntime\nunset\n`);
    expect(existsSync(join(spec.env.TMPDIR!, 'ok'))).toBe(true);
    expect(existsSync(join(spec.cwd, 'injected'))).toBe(false);
    expect(process.env).toEqual(before);
    expect(logger.entries.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(logger.entries)).not.toContain('do-not-log-this');
  });

  test('abort kills a running command and a pre-aborted signal never wraps', async () => {
    const f = fixture();
    let wraps = 0;
    let cleanups = 0;
    const sandbox = new PrepSandbox({
      ...options,
      manager: backend({
        wrapWithSandboxArgv: async (command) => {
          wraps++;
          return { argv: ['/bin/sh', '-c', command], env: process.env };
        },
        cleanupAfterCommand: () => {
          cleanups++;
        },
      }),
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      const result = await sandbox.run({ ...f.spec(['/bin/sleep', '30']), signal: controller.signal });
      expect(result.signal).toBe('SIGKILL');
      expect(result.timedOut).toBe(false);
      await expect(sandbox.run({ ...f.spec(['/usr/bin/true']), signal: controller.signal })).rejects.toThrow();
      expect(wraps).toBe(1);
      expect(cleanups).toBe(1);
    } finally {
      clearTimeout(timer);
    }
  });

  test('cleans up a successful wrap even when spawning fails', async () => {
    const f = fixture();
    let cleanups = 0;
    const sandbox = new PrepSandbox({
      ...options,
      manager: backend({
        wrapWithSandboxArgv: async () => ({ argv: ['/no-such-agflow-command'], env: process.env }),
        cleanupAfterCommand: () => {
          cleanups++;
        },
      }),
    });
    await expect(sandbox.run(f.spec(['/usr/bin/true']))).rejects.toThrow();
    expect(cleanups).toBe(1);
  });

  test('bounds the pipe wait when an escaped grandchild keeps stdout open', async () => {
    const f = fixture();
    const sandbox = new PrepSandbox({ ...options, manager: backend() });
    const pidFile = join(f.clones[0]!, 'escaped.pid');
    let pid: number | undefined;
    try {
      // setsid takes the sleeper out of the group the normal-exit kill reaches; it inherits both pipes.
      const result = await sandbox.run(
        f.spec([
          '/usr/bin/perl',
          '-MPOSIX',
          '-e',
          'my $pid = fork() // die; if (!$pid) { POSIX::setsid(); exec "/bin/sleep", "30" } ' +
            'open my $f, ">", "escaped.pid" or die; print $f $pid; close $f; print "parent done\\n"; exit 0',
        ]),
      );
      pid = Number(readFileSync(pidFile, 'utf8'));
      expect(result.code).toBe(0);
      expect(result.logTail).toContain('parent done');
      // Only proves it did not wait for the 30 s sleeper.
      expect(result.durationMs).toBeLessThan(15_000);
      expect(running(pid)).toBe(true);
    } finally {
      if (pid === undefined && existsSync(pidFile)) pid = Number(readFileSync(pidFile, 'utf8'));
      if (pid && running(pid)) process.kill(pid, 'SIGKILL');
    }
  }, 20_000);
});

describe.skipIf(process.platform !== 'darwin')('real sandbox boundaries', () => {
  test('reads and writes the clone, cache and private TMPDIR, and captures output', async () => {
    const f = fixture();
    writeFileSync(join(f.clones[0]!, 'package.json'), 'clone-manifest-content\n');
    writeFileSync(join(f.layout.cache, 'entry'), 'cache-entry-content\n');
    const spec = f.spec([
      '/bin/sh',
      '-c',
      'cat package.json "$2" && echo clone > local && echo cache > "$1" && echo temp > "$TMPDIR/temp" && ' +
        'printf "%s\\n" "$TMPDIR" && echo output',
      'sh',
      join(f.layout.cache, 'cached'),
      join(f.layout.cache, 'entry'),
    ]);
    const result = await real.run(spec);
    expect(result.code).toBe(0);
    expect(result.logTail).toContain('clone-manifest-content\ncache-entry-content\n');
    expect(readFileSync(join(spec.cwd, 'local'), 'utf8')).toBe('clone\n');
    expect(readFileSync(join(f.layout.cache, 'cached'), 'utf8')).toBe('cache\n');
    expect(readFileSync(join(spec.env.TMPDIR!, 'temp'), 'utf8')).toBe('temp\n');
    expect(result.logTail).toContain(`${spec.env.TMPDIR}\noutput`);
  }, 20_000);

  test('denies outside, state and other-clone writes, and credential, state and other-clone reads', async () => {
    const f = fixture();
    // First prove the runtime can execute; sandbox startup failure is not evidence of isolation.
    expect((await real.run(f.spec(['/usr/bin/true']))).code).toBe(0);
    for (const dir of [f.outside, f.layout.state, f.clones[1]!]) {
      const target = join(dir, 'forbidden');
      const result = await real.run(f.spec(['/bin/sh', '-c', 'echo bad > "$1"', 'sh', target]));
      expect(result.code).not.toBe(0);
      expect(existsSync(target)).toBe(false);
    }
    const unreadable: [string, string][] = [
      [f.denied, f.secret],
      [join(f.clones[1]!, 'sibling'), 'sibling-clone-content'],
      [join(f.otherProject, 'other'), 'other-project-content'],
      [join(f.layout.state, 'one.json'), 'prep-state-content'],
    ];
    for (const [path, content] of unreadable) {
      if (path !== f.denied) writeFileSync(path, content);
      const result = await real.run(f.spec(['/bin/cat', path]));
      expect(result.code).not.toBe(0);
      expect(result.logTail).not.toContain(content);
    }
    // Only the names of projects and attempts can be listed; a sibling clone's contents cannot.
    expect((await real.run(f.spec(['/bin/ls', f.clones[1]!]))).code).not.toBe(0);
  }, 20_000);

  test('a scripts-off bun install skips lifecycle scripts, even with an agent-written HOME bunfig', async () => {
    const f = fixture();
    const clone = f.clones[0]!;
    const poison = join(f.layout.cache, 'bun', 'POISON');
    writeFileSync(
      join(clone, 'package.json'),
      `${JSON.stringify({
        name: 'prep-scripts',
        private: true,
        scripts: { preinstall: 'touch PRE', postinstall: `touch POST "${poison}"` },
      })}\n`,
    );
    const spec = f.spec([process.execPath, 'install'], 0, { run: ['bun', 'install'] });
    writeFileSync(join(spec.env.HOME!, '.bunfig.toml'), '[install]\nignoreScripts = false\n');
    const result = await real.run(spec);
    expect(result.code).toBe(0);
    for (const marker of [join(clone, 'PRE'), join(clone, 'POST'), poison]) expect(existsSync(marker)).toBe(false);
  }, 30_000);

  test('a scripts-on bun install runs its postinstall but cannot read another clone', async () => {
    const f = fixture();
    const clone = f.clones[0]!;
    writeFileSync(join(f.clones[1]!, 'secret'), 'sibling-secret-content');
    writeFileSync(
      join(clone, 'post.sh'),
      `touch POST; cat "${join(f.clones[1]!, 'secret')}" > leaked 2>/dev/null; exit 0\n`,
    );
    writeFileSync(
      join(clone, 'package.json'),
      `${JSON.stringify({ name: 'prep-scripts', private: true, scripts: { postinstall: 'sh post.sh' } })}\n`,
    );
    const result = await real.run(f.spec([process.execPath, 'install'], 0, { run: ['bun', 'install'], scripts: true }));
    expect(result.code).toBe(0);
    expect(existsSync(join(clone, 'POST'))).toBe(true);
    expect(readFileSync(join(clone, 'leaked'), 'utf8')).not.toContain('sibling-secret-content');
  }, 30_000);

  test('cannot reach a local HTTP server that answers outside the sandbox', async () => {
    const f = fixture();
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('outside-server') });
    try {
      const url = `http://127.0.0.1:${server.port}/`;
      expect(await (await fetch(url)).text()).toBe('outside-server');
      expect((await real.run(f.spec(['/usr/bin/true']))).code).toBe(0);
      for (const args of [[], ['--noproxy', '*']]) {
        const result = await real.run(f.spec(['/usr/bin/curl', '--fail', '--max-time', '2', ...args, url]));
        expect(result.code).not.toBe(0);
        expect(result.logTail).not.toContain('outside-server');
      }
    } finally {
      server.stop(true);
    }
  }, 20_000);

  test('concurrent per-call policies each allow only their own clone', async () => {
    const f = fixture();
    const results = await Promise.all(
      [0, 1].map((index) =>
        real.run(
          f.spec(
            [
              '/bin/sh',
              '-c',
              'sleep 0.1; echo own > own; if echo bad > "$1"; then exit 9; fi',
              'sh',
              join(f.clones[1 - index]!, 'foreign'),
            ],
            index,
          ),
        ),
      ),
    );
    expect(results.map((result) => result.code)).toEqual([0, 0]);
    for (const clone of f.clones) {
      expect(readFileSync(join(clone, 'own'), 'utf8')).toBe('own\n');
      expect(existsSync(join(clone, 'foreign'))).toBe(false);
    }
  }, 20_000);

  test('self-check reports works on macOS', async () => {
    expect(await checkPrepSandbox({ sandbox: real })).toEqual({ works: true, reason: null });
  }, 20_000);
});

describe('checkPrepSandbox', () => {
  const linuxErrors = process.platform === 'linux' ? SandboxManager.checkDependencies().errors : [];
  test.skipIf(linuxErrors.length === 0)('reports the actual missing Linux sandbox dependencies', async () => {
    const result = await checkPrepSandbox({ sandbox: real });
    expect(result.works).toBe(false);
    for (const error of linuxErrors) expect(result.reason).toContain(error);
  });

  test('reports unsupported platforms, missing Linux dependencies, and initialization errors', async () => {
    for (const [manager, reason] of [
      [backend({ isSupportedPlatform: () => false }), 'unsupported'],
      [
        backend({
          checkDependencies: () => ({
            errors: ['bubblewrap (bwrap) not installed', 'socat not installed'],
            warnings: [],
          }),
        }),
        'bubblewrap',
      ],
      [
        backend({
          initialize: async () => {
            throw new Error('cannot start runtime');
          },
        }),
        'cannot start runtime',
      ],
    ] as const) {
      const result = await checkPrepSandbox({ manager });
      expect(result.works).toBe(false);
      expect(result.reason).toContain(reason);
    }
  });

  test('verifies the probe file, reports command failure, and never throws', async () => {
    expect(await checkPrepSandbox({ manager: backend() })).toEqual({ works: true, reason: null });
    for (const command of ['exit 0', 'echo probe-failed >&2; exit 7']) {
      const result = await checkPrepSandbox({
        manager: backend({
          wrapWithSandboxArgv: async () => ({ argv: ['/bin/sh', '-c', command], env: process.env }),
        }),
      });
      expect(result.works).toBe(false);
      expect(result.reason).toBeTruthy();
    }
  });
});

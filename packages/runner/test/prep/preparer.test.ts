import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { verifyPrepMain } from '../../scripts/verify-prep';
import { prepareWorkspace } from '../../src/attempt/workspace';
import { memoryLogger } from '../../src/log';
import { createDependencyPreparer } from '../../src/prep/preparer';
import { prepLayout, prepToolConfig } from '../../src/prep/plan';
import { PrepSandbox, type PrepRunSpec, type SandboxBackend } from '../../src/prep/sandbox';
import { standardProfile } from '../../src/profile';
import type { PrepareInput } from '../../src/seams';
import { cleanupRunnerFixtures, createRunnerFixture, fixtureAgentToken, type RunnerFixture, waitFor } from '../fixture';

afterEach(cleanupRunnerFixtures);

const entry = (command = 'echo run >> runs; echo prepared', when = ['deps.lock'], scripts = false) => ({
  run: ['/bin/sh', '-c', command],
  when,
  scripts,
});
const files = (entries = [entry()]) => ({
  '.agflow/config.json': JSON.stringify({ dependencies: entries }),
  'deps.lock': 'original\n',
  '.npmrc': 'registry=https://registry.npmjs.org/\n',
});
const noRun = { ran: false, ok: true, error: null, logTail: null };

function manager(overrides: Partial<SandboxBackend> = {}): SandboxBackend {
  return {
    initialize: async () => {},
    isSupportedPlatform: () => true,
    checkDependencies: () => ({ errors: [], warnings: [] }),
    wrapWithSandboxArgv: async (command) => ({ argv: ['/bin/sh', '-c', command], env: {} }),
    cleanupAfterCommand: () => {},
    ...overrides,
  };
}

function runner() {
  const calls: PrepRunSpec[] = [];
  const sandbox = new PrepSandbox({ allowedDomains: standardProfile.network.allowedDomains, manager: manager() });
  return {
    calls,
    run: async (spec: PrepRunSpec) => {
      calls.push(spec);
      return sandbox.run(spec);
    },
  };
}

function options(f: RunnerFixture) {
  return { paths: f.paths, store: f.store, config: () => f.config, ownerHome: join(f.home, 'owner') };
}

async function direct(origin: Record<string, string> = files(), role: 'worker' | 'lead' = 'worker') {
  const f = await createRunnerFixture({ files: origin });
  const spec = f.spec({
    vendor: 'codex',
    role,
    ...(role === 'lead' ? { taskId: null, branch: null, wipRef: null } : {}),
  });
  const workspace = await prepareWorkspace(f.deps(), spec);
  f.store.create(spec, { clone: workspace.clone, tmpDir: null, cliVersion: null });
  const input: PrepareInput = {
    attemptId: spec.attemptId,
    vendor: spec.vendor,
    clone: workspace.clone,
    vault: f.vault,
    baseSha: workspace.base,
    env: { PATH: '/usr/bin:/bin' },
    requestId: null,
  };
  const command = runner();
  const preparer = await createDependencyPreparer({ ...options(f), run: command.run });
  return { f, input, command, preparer, clone: workspace.clone };
}

describe('DependencyPreparer seam', () => {
  test('runs once, persists the post-command fingerprint, and reruns a changed lockfile', async () => {
    const d = await direct(files([entry('echo rewritten > deps.lock; echo run >> runs; echo prepared')]));
    expect(await d.preparer.prepare(d.input)).toEqual({ ran: true, ok: true, error: null, logTail: 'prepared\n' });
    const restarted = await createDependencyPreparer({ ...options(d.f), run: d.command.run });
    expect(await restarted.prepare(d.input)).toEqual(noRun);
    writeFileSync(join(d.clone, 'deps.lock'), 'changed\n');
    expect((await restarted.prepare(d.input)).ran).toBe(true);
    expect(readFileSync(join(d.clone, 'runs'), 'utf8')).toBe('run\nrun\n');
    expect(d.command.calls.map((call) => call.cwd)).toEqual([d.clone, d.clone]);
    for (const call of d.command.calls) {
      expect(call.timeoutMs).toBe(d.f.config.timings.prep);
      expect(existsSync(call.env.TMPDIR!)).toBe(false);
    }
  }, 30_000);

  test('a command request runs every entry, restores .npmrc, and carries the last tail', async () => {
    const d = await direct(files([entry(), entry('cat .npmrc; echo second >> runs')]));
    await d.preparer.prepare(d.input);
    writeFileSync(join(d.clone, '.npmrc'), 'agent override\n');
    const result = await d.preparer.prepare({ ...d.input, requestId: 'cmd-123' });
    expect(result).toEqual({ ran: true, ok: true, error: null, logTail: files()['.npmrc'] });
    expect(d.command.calls).toHaveLength(4);
    expect(readFileSync(join(d.clone, 'runs'), 'utf8')).toBe('run\nsecond\nrun\nsecond\n');
  }, 30_000);

  test('protected paths are restored again before an entry that follows one that ran', async () => {
    const d = await direct(files([entry('echo agent override > .npmrc; echo first'), entry('cat .npmrc')]));
    expect(await d.preparer.prepare(d.input)).toEqual({
      ran: true,
      ok: true,
      error: null,
      logTail: files()['.npmrc'],
    });
  }, 30_000);

  test('removes user package config without following parent or final links, before each entry', async () => {
    const check =
      'test ! -e "$HOME/.bunfig.toml" && test ! -e "$HOME/.config/.bunfig.toml" && test ! -e "$CARGO_HOME/config.toml" || exit 9; echo clean';
    const d = await direct(
      files([
        entry(`${check}; echo bad > "$HOME/.bunfig.toml"`),
        entry('test ! -e "$HOME/.bunfig.toml" || exit 9; echo second'),
      ]),
    );
    const home = join(d.clone, '.agflow/run/home');
    const outside = join(d.f.home, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, '.bunfig.toml'), 'precious');
    writeFileSync(join(home, '.bunfig.toml'), '[install]\nbackend="hardlink"\n');
    symlinkSync(outside, join(home, '.config'));
    const cargo = join(d.clone, '.agflow/run/cache/cargo');
    mkdirSync(cargo);
    writeFileSync(join(outside, 'config.toml'), 'precious cargo');
    symlinkSync(join(outside, 'config.toml'), join(cargo, 'config.toml'));
    expect(await d.preparer.prepare(d.input)).toMatchObject({ ok: true, logTail: 'second\n' });
    expect(readFileSync(join(outside, '.bunfig.toml'), 'utf8')).toBe('precious');
    expect(readFileSync(join(outside, 'config.toml'), 'utf8')).toBe('precious cargo');
    expect(d.command.calls).toHaveLength(2);
  }, 30_000);

  test('replaces linked HOME and cache directories without touching their targets', async () => {
    const d = await direct(files([entry('test ! -e "$HOME/.bunfig.toml" || exit 8; echo safe')]));
    const outside = join(d.f.home, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, '.bunfig.toml'), 'precious');
    for (const name of ['home', 'cache']) {
      const path = join(d.clone, '.agflow/run', name);
      rmSync(path, { recursive: true });
      symlinkSync(outside, path);
    }
    expect((await d.preparer.prepare(d.input)).ok).toBe(true);
    expect(readdirSync(outside)).toEqual(['.bunfig.toml']);
  }, 30_000);

  test('links an earlier entry plants never redirect the next cleanup outside the clone', async () => {
    // The first entry runs agent-controlled code: it swaps HOME and the cargo root for links to the owner's files.
    const plant = [
      'rm -rf .agflow/run/home .agflow/run/cache/cargo',
      'ln -s "$OUTSIDE" .agflow/run/home',
      'ln -s "$OUTSIDE" .agflow/run/cache/cargo',
      'echo planted',
    ].join(' && ');
    const check = 'test -d "$HOME" && test ! -L "$HOME" && test ! -L "$CARGO_HOME" || exit 9; echo clean';
    const d = await direct(files([entry(plant), entry(check)]));
    const outside = join(d.f.home, 'outside');
    const owner: Record<string, string> = {
      Library: 'a file where the cleanup expects a directory',
      '.bunfig.toml': 'precious bunfig',
      '.npmrc': 'precious npmrc',
      'config.toml': 'precious cargo',
      '.config/pip/pip.conf': 'precious pip',
    };
    for (const [name, content] of Object.entries(owner)) {
      mkdirSync(dirname(join(outside, name)), { recursive: true });
      writeFileSync(join(outside, name), content);
    }
    expect(await d.preparer.prepare({ ...d.input, env: { ...d.input.env, OUTSIDE: outside } })).toMatchObject({
      ran: true,
      ok: true,
      logTail: 'clean\n',
    });
    for (const [name, content] of Object.entries(owner))
      expect(readFileSync(join(outside, name), 'utf8')).toBe(content);
  }, 30_000);

  test('serializes preparations of one attempt, including a forced request', async () => {
    const d = await direct();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let active = 0;
    let maximum = 0;
    const p = await createDependencyPreparer({
      ...options(d.f),
      run: async (spec) => {
        active++;
        maximum = Math.max(maximum, active);
        entered();
        await gate;
        try {
          return await d.command.run(spec);
        } finally {
          active--;
        }
      },
    });
    const first = p.prepare(d.input);
    await started;
    const second = p.prepare(d.input);
    const requested = p.prepare({ ...d.input, requestId: 'cmd-parallel' });
    release();
    expect((await Promise.all([first, second, requested])).map((outcome) => outcome.ran)).toEqual([true, false, true]);
    expect(maximum).toBe(1);
    expect(d.command.calls).toHaveLength(2);
  }, 30_000);

  test('a failed entry stops the sequence, retains its tail, and is retried', async () => {
    const d = await direct(files([entry('echo install-error; exit 3'), entry('touch must-not-run')]));
    for (let i = 0; i < 2; i++) {
      expect(await d.preparer.prepare(d.input)).toEqual({
        ran: true,
        ok: false,
        error: expect.stringContaining('exited with code 3'),
        logTail: 'install-error\n',
      });
    }
    expect(d.command.calls).toHaveLength(2);
    expect(existsSync(join(d.clone, 'must-not-run'))).toBe(false);
    expect(readdirSync(prepLayout(d.f.paths.prep(d.f.vault.project)).tmp)).toEqual([]);
  }, 30_000);

  test('timeouts, signals, spawn errors and missing records become failed outcomes', async () => {
    const d = await direct();
    for (const [result, error] of [
      [{ code: null, signal: 'SIGKILL', timedOut: true }, 'timed out after 15 min'],
      [{ code: null, signal: 'SIGTERM', timedOut: false }, 'SIGTERM'],
    ] as const) {
      const p = await createDependencyPreparer({
        ...options(d.f),
        run: async () => ({ ...result, logTail: 'tail', durationMs: 1 }),
      });
      expect(await p.prepare(d.input)).toMatchObject({
        ran: true,
        ok: false,
        error: expect.stringContaining(error),
        logTail: 'tail',
      });
    }
    const p = await createDependencyPreparer({
      ...options(d.f),
      run: async () => {
        throw new Error('spawn failed');
      },
    });
    expect(await p.prepare(d.input)).toMatchObject({ ran: true, ok: false, error: 'spawn failed' });
    expect(await p.prepare({ ...d.input, attemptId: 'missing' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('missing'),
    });
    expect(readdirSync(prepLayout(d.f.paths.prep(d.f.vault.project)).tmp)).toEqual([]);
  }, 30_000);

  test('no config, empty entries and leads do nothing; working-tree config has no authority', async () => {
    for (const [origin, role] of [
      [{ 'README.md': 'demo' }, 'worker'],
      [files([]), 'worker'],
      [files(), 'lead'],
    ] as const) {
      const d = await direct(origin, role);
      writeFileSync(join(d.clone, '.agflow/config.json'), JSON.stringify({ dependencies: [entry('touch rogue')] }));
      expect(await d.preparer.prepare(d.input)).toEqual(noRun);
      expect(d.command.calls).toHaveLength(0);
      expect(existsSync(join(d.clone, 'rogue'))).toBe(false);
    }
  }, 30_000);

  test('unavailable requests fail without invoking the runner', async () => {
    const d = await direct();
    const p = await createDependencyPreparer({ ...options(d.f), run: d.command.run, available: false });
    expect(p.available).toBe(false);
    expect(await p.prepare({ ...d.input, requestId: 'cmd-unavailable' })).toEqual({
      ran: false,
      ok: false,
      error: 'not available on this runner',
      logTail: null,
    });
    expect(d.command.calls).toHaveLength(0);
  }, 30_000);

  test('invalid base config and restore failures are reported', async () => {
    const d = await direct({ ...files(), '.agflow/config.json': '{bad json' });
    expect(await d.preparer.prepare(d.input)).toMatchObject({
      ran: true,
      ok: false,
      error: expect.stringContaining('.agflow/config.json'),
    });
    const valid = await direct();
    rmSync(valid.clone, { recursive: true });
    symlinkSync(valid.f.home, valid.clone);
    const before = readdirSync(valid.f.home).sort();
    expect(await valid.preparer.prepare(valid.input)).toMatchObject({
      ran: true,
      ok: false,
      error: `${valid.clone} is not a directory`,
    });
    // Refused before the restore, which would otherwise write the base's files through the link.
    expect(readdirSync(valid.f.home).sort()).toEqual(before);
    expect(valid.command.calls).toHaveLength(0);
  }, 30_000);

  test('only known installs with scripts off get the shared cache and the no-scripts bunfig', async () => {
    const pip = ['python3', '-m', 'pip', 'install', '-r', 'requirements.txt'];
    const d = await direct(
      files([
        { run: ['bun', 'install'], when: [], scripts: false },
        { run: ['bun', 'install'], when: [], scripts: true },
        { run: pip, when: [], scripts: false },
      ]),
    );
    const calls: PrepRunSpec[] = [];
    const p = await createDependencyPreparer({
      ...options(d.f),
      run: async (spec) => {
        calls.push(spec);
        return { code: 0, signal: null, timedOut: false, logTail: '', durationMs: 1 };
      },
    });
    expect((await p.prepare(d.input)).ok).toBe(true);
    const prep = d.f.paths.prep(d.f.vault.project);
    const shared = prepLayout(prep).cache;
    const perAttempt = join(d.clone, '.agflow/run/cache');
    const [normal, scripts, python] = calls;
    expect(normal?.env.BUN_INSTALL_CACHE_DIR).toBe(join(shared, 'bun'));
    expect(normal?.policy.filesystem.allowWrite).toContain(shared);
    expect(normal?.env.npm_config_ignore_scripts).toBe('true');
    expect(normal?.env.XDG_CONFIG_HOME).toBe(prepToolConfig(prep, false));
    expect(readFileSync(join(prepToolConfig(prep, false), '.bunfig.toml'), 'utf8')).toBe(
      '[install]\nignoreScripts = true\n',
    );
    for (const call of [scripts, python]) {
      expect(call?.env.BUN_INSTALL_CACHE_DIR).toBe(join(perAttempt, 'bun'));
      expect(call?.env.PIP_CACHE_DIR).toBe(join(perAttempt, 'pip'));
      expect(call?.policy.filesystem.allowWrite).not.toContain(shared);
      expect(call?.policy.filesystem.allowRead).not.toContain(shared);
    }
    expect(scripts?.env.npm_config_ignore_scripts).toBeUndefined();
    expect(scripts?.env.XDG_CONFIG_HOME).toBe(prepToolConfig(prep, true));
    expect(python?.env.npm_config_ignore_scripts).toBe('true');
  }, 30_000);

  test('availability comes from the sandbox self-check at start', async () => {
    const d = await direct();
    const logger = memoryLogger();
    const broken = new PrepSandbox({
      allowedDomains: standardProfile.network.allowedDomains,
      manager: manager({
        initialize: async () => {
          throw new Error('cannot start proxies');
        },
      }),
    });
    const unavailable = await createDependencyPreparer({ ...options(d.f), sandbox: broken, logger });
    expect(unavailable.available).toBe(false);
    expect(logger.entries).toContainEqual({
      level: 'warn',
      message: 'dependency preparation unavailable',
      fields: { reason: expect.stringContaining('cannot start proxies') },
    });
    expect(await unavailable.prepare({ ...d.input, requestId: 'cmd-x' })).toEqual({
      ran: false,
      ok: false,
      error: 'not available on this runner',
      logTail: null,
    });
    expect(existsSync(join(d.clone, 'runs'))).toBe(false);
    const wraps: string[] = [];
    const working = new PrepSandbox({
      allowedDomains: standardProfile.network.allowedDomains,
      manager: manager({
        wrapWithSandboxArgv: async (command) => {
          wraps.push(command);
          return { argv: ['/bin/sh', '-c', command], env: {} };
        },
      }),
    });
    const available = await createDependencyPreparer({ ...options(d.f), sandbox: working });
    expect(available.available).toBe(true);
    expect(await available.prepare(d.input)).toEqual({ ran: true, ok: true, error: null, logTail: 'prepared\n' });
    // The self-check's probe, then the entry.
    expect(wraps).toHaveLength(2);
    expect(wraps[1]).toContain('echo run >> runs');
    expect(readFileSync(join(d.clone, 'runs'), 'utf8')).toBe('run\n');
  }, 30_000);
});

describe('DependencyPreparer with the controller and fake adapter', () => {
  test('start prepares in the clone during preparing, then resumes only for changed when-files', async () => {
    const f = await createRunnerFixture({ files: files(), script: { turns: [[], [], []] } });
    const command = runner();
    const phases: unknown[] = [];
    const p = await createDependencyPreparer({
      ...options(f),
      run: async (spec) => {
        phases.push(controller.phase);
        return command.run(spec);
      },
    });
    const controller = f.controller('T-4-a1', { preparer: p });
    expect(await controller.start(f.spec())).toEqual({ started: true });
    await waitFor(() => f.events('attempt.activity').length > 0);
    expect(phases).toEqual(['preparing']);
    expect(f.events('attempt.prepared')[0]?.data).toEqual({
      requestId: null,
      ok: true,
      error: null,
      logTail: 'prepared\n',
    });
    expect(f.fakes.claude?.launches).toHaveLength(1);
    const clone = controller.workspace!.clone;
    expect(command.calls[0]?.cwd).toBe(clone);
    for (const counter of [2, 3]) {
      await controller.stop({
        fence: { epoch: 1, counter: counter - 1 },
        reason: 'paused',
        handoff: false,
        interruptFirst: false,
        keepClone: true,
      });
      if (counter === 3) writeFileSync(join(clone, 'deps.lock'), 'changed\n');
      expect(
        await controller.resume({
          fence: { epoch: 1, counter },
          agentToken: fixtureAgentToken(`resume-${counter}`),
          prompt: 'Continue',
          messages: [],
          taskPack: f.spec().taskPack,
          restore: f.spec().restore,
          acceptanceIds: ['A1'],
        }),
      ).toEqual({ resumed: true });
      await waitFor(() => f.events('attempt.activity').length >= counter);
      expect(f.events('attempt.prepared')).toHaveLength(counter === 2 ? 1 : 2);
    }
    expect(phases).toEqual(['preparing', 'preparing']);
    expect(readFileSync(join(clone, 'runs'), 'utf8')).toBe('run\nrun\n');
  }, 60_000);

  test('a failing preparation reports prepared then failed_to_start and never starts an agent', async () => {
    const f = await createRunnerFixture({ files: files([entry('echo failure-tail; exit 3')]) });
    const command = runner();
    const p = await createDependencyPreparer({ ...options(f), run: command.run });
    expect(await f.controller('T-4-a1', { preparer: p }).start(f.spec())).toMatchObject({
      started: false,
      refused: null,
    });
    expect(f.events().map((event) => event.type)).toEqual(['attempt.prepared', 'attempt.failed_to_start']);
    expect(f.events('attempt.prepared')[0]?.data).toMatchObject({
      requestId: null,
      ok: false,
      logTail: 'failure-tail\n',
      error: expect.stringContaining('exited with code 3'),
    });
    expect(f.events('attempt.failed_to_start')[0]?.data).toMatchObject({
      refused: null,
      error: expect.stringContaining('exited with code 3'),
    });
    expect(f.fakes.claude?.launches).toHaveLength(0);
  }, 30_000);

  test('prepare_dependencies runs every entry after restoring .npmrc and reports the command id', async () => {
    const f = await createRunnerFixture({ files: files([entry(), entry('cat .npmrc; echo second >> runs')]) });
    const command = runner();
    const p = await createDependencyPreparer({ ...options(f), run: command.run });
    const controller = f.controller('T-4-a1', { preparer: p });
    expect(await controller.start(f.spec())).toEqual({ started: true });
    await waitFor(() => f.events('attempt.activity').length > 0);
    const clone = controller.workspace!.clone;
    writeFileSync(join(clone, '.npmrc'), 'agent override\n');
    const requestId = '1-R-1-7';
    expect(await controller.prepareRequested({ fence: f.spec().fence, requestId })).toMatchObject({ ok: true });
    const prepared = { requestId, ok: true, error: null, logTail: files()['.npmrc'] };
    const reported = f.events('attempt.prepared').map((event) => event.data);
    expect(reported).toEqual([{ ...prepared, requestId: null }, prepared]);
    // The when-files did not change, and the request still ran both entries again.
    expect(command.calls).toHaveLength(4);
    expect(readFileSync(join(clone, 'runs'), 'utf8')).toBe('run\nsecond\nrun\nsecond\n');
    expect(readFileSync(join(clone, '.npmrc'), 'utf8')).toBe(files()['.npmrc']);
  }, 30_000);

  test('a start without config reports no preparation', async () => {
    const f = await createRunnerFixture();
    const command = runner();
    const p = await createDependencyPreparer({ ...options(f), run: command.run });
    expect(await f.controller('T-4-a1', { preparer: p }).start(f.spec())).toEqual({ started: true });
    expect(f.events('attempt.prepared')).toHaveLength(0);
    expect(command.calls).toHaveLength(0);
  }, 30_000);
});

test('verify-prep rejects extra arguments before doing work', async () => {
  const errors: string[] = [];
  expect(await verifyPrepMain(['extra'], {}, { error: (line) => errors.push(line) })).toBe(1);
  expect(errors).toEqual(['usage: bun run verify:prep']);
});

test.skipIf(process.platform !== 'darwin' || process.env.AGFLOW_SANDBOX_CHECKS !== '1')(
  'verify-prep installs bun and pip fixtures from empty caches without hard links',
  async () => {
    expect(await verifyPrepMain()).toBe(0);
  },
  300_000,
);

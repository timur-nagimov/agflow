import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Vendor } from '@agflow/core';
import { loadRunnerConfig, saveRunnerConfig } from '@agflow/runner/src/config';
import { runnerPaths } from '@agflow/runner/src/paths';
import { createRunnerConfig } from '@agflow/runner/src/service/runner-json';
import { VENDOR_PINS, vendorBinary } from '@agflow/runner/src/vendor/pins';
import { cloneTo, commitFiles, fileAt, gitIn, originRepo, refSha } from '../src/git-fixtures';
import { noScriptedModels, REMOTE_MAIN_SUBJECT, remoteOrigin } from '../src/harness/cluster';
import { E2E_PLATFORM } from '../src/harness/env';
import { prepareRunnerHome, type RunnerHome } from '../src/harness/runner-process';
import {
  checkVendorHome,
  formatResults,
  LIVE_GOAL,
  LIVE_OPTIONS,
  LIVE_SCENARIOS,
  LIVE_WAIT_MS,
  type LiveDefaults,
  liveClusterOptions,
  liveDefaults,
  liveUsage,
  parseLiveArgs,
  toyRepoFiles,
} from '../src/live';
import { CLOSED_LAPTOP } from '../src/scenarios/closed-laptop';
import { KILLED_AGENT } from '../src/scenarios/killed-agent';
import { LOST_LEAD } from '../src/scenarios/lost-lead';
import type { ScenarioResult } from '../src/scenarios/result';
import { TAKEOVER } from '../src/scenarios/takeover';

const dirs: string[] = [];
const homes: RunnerHome[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.remove();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A temporary directory at its real path: vendor homes must be real paths. */
function tmpDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join('/tmp', prefix)));
  dirs.push(dir);
  return dir;
}

/** For tests that run git, bun or a fake CLI several times: a loaded machine takes longer than bun's 5 s. */
const SPAWNS_MS = 30_000;

const PINS = VENDOR_PINS[E2E_PLATFORM];
if (!PINS) throw new Error(`no ${E2E_PLATFORM} pins`);

const DEFAULTS: LiveDefaults = {
  agflowHome: '/Users/alice/.agflow',
  claudeHome: '/Users/alice/.agflow/runner/homes/claude',
  codexHome: '/Users/alice/.agflow/runner/homes/codex',
  connectivity: {},
};

describe('parseLiveArgs', () => {
  test('gives the defaults without options: both vendors, every scenario, a local origin', () => {
    expect(parseLiveArgs([], DEFAULTS)).toEqual({
      help: false,
      ...DEFAULTS,
      runners: ['claude', 'codex'],
      scenarios: [...LIVE_SCENARIOS],
      repo: null,
      takeover: [],
      keep: false,
    });
    expect(LIVE_SCENARIOS).toEqual(['killed-agent', 'closed-laptop', 'lost-lead']);
  });

  test('reads --claude-home, --codex-home, --runners, --scenarios, --repo, --takeover and --keep', () => {
    const argv = [
      '--claude-home',
      '/Users/alice/homes/claude',
      '--codex-home=/Users/alice/homes/codex',
      '--runners',
      'codex',
      '--scenarios',
      'lost-lead,killed-agent,lost-lead',
      '--repo',
      'git@github.com:alice/agflow-toy.git',
      '--takeover',
      'claude,codex',
      '--keep',
    ];
    expect(parseLiveArgs(argv, DEFAULTS)).toEqual({
      help: false,
      agflowHome: DEFAULTS.agflowHome,
      claudeHome: '/Users/alice/homes/claude',
      codexHome: '/Users/alice/homes/codex',
      connectivity: {},
      runners: ['codex'],
      scenarios: ['lost-lead', 'killed-agent'],
      repo: 'git@github.com:alice/agflow-toy.git',
      takeover: ['claude', 'codex'],
      keep: true,
    });
    expect(parseLiveArgs(['--takeover=codex'], DEFAULTS).takeover).toEqual(['codex']);
    expect(parseLiveArgs(['--help'], DEFAULTS).help).toBe(true);
  });

  test('refuses unknown scenarios, vendors and options, and an option without its value', () => {
    expect(() => parseLiveArgs(['--scenarios', 'killed-agent,lost-laptop'], DEFAULTS)).toThrow(
      "unknown scenario 'lost-laptop'",
    );
    expect(() => parseLiveArgs(['--scenarios', ''], DEFAULTS)).toThrow('--scenarios names no scenario');
    expect(() => parseLiveArgs(['--runners', 'claude,gemini'], DEFAULTS)).toThrow("unknown vendor 'gemini'");
    expect(() => parseLiveArgs(['--takeover', 'claude,gemini'], DEFAULTS)).toThrow("unknown vendor 'gemini'");
    expect(() => parseLiveArgs(['--takeover', ','], DEFAULTS)).toThrow('--takeover names no vendor');
    expect(() => parseLiveArgs(['--bogus'], DEFAULTS)).toThrow('unknown option --bogus');
    expect(() => parseLiveArgs(['--repo'], DEFAULTS)).toThrow('--repo needs a value');
    expect(() => parseLiveArgs(['--keep=yes'], DEFAULTS)).toThrow('--keep takes no value');
    expect(() => parseLiveArgs(['killed-agent'], DEFAULTS)).toThrow("unexpected argument 'killed-agent'");
  });

  test('the usage names every option', () => {
    const usage = liveUsage();
    expect(LIVE_OPTIONS.map((option) => option.flag)).toEqual([
      '--claude-home',
      '--codex-home',
      '--runners',
      '--scenarios',
      '--repo',
      '--takeover',
      '--keep',
      '--help',
    ]);
    for (const option of LIVE_OPTIONS) expect(usage).toContain(option.flag);
  });
});

describe('liveDefaults', () => {
  test("come from the AGFLOW_HOME's runner directory: the layout's vendor homes without a runner.json", () => {
    const home = tmpDir('agf-live-');
    expect(liveDefaults(home)).toEqual({
      agflowHome: home,
      claudeHome: join(home, 'runner', 'homes', 'claude'),
      codexHome: join(home, 'runner', 'homes', 'codex'),
      connectivity: {},
    });
  });

  test("and runner.json's vendor homes and connectivity variables once setup recorded them", () => {
    const home = tmpDir('agf-live-');
    const recorded = { claude: join(tmpDir('agf-ch-'), 'claude'), codex: join(tmpDir('agf-xh-'), 'codex') };
    for (const path of Object.values(recorded)) mkdirSync(path);
    const config = createRunnerConfig({
      machineId: 'machine',
      name: 'alice-mac',
      capturedPath: '/usr/bin:/bin',
      connectivity: { HTTPS_PROXY: 'http://proxy.corp:3128', NODE_EXTRA_CA_CERTS: '/etc/corp-ca.pem' },
      commitIdentity: null,
      homes: recorded,
    });
    saveRunnerConfig(runnerPaths(home).config, config);
    expect(liveDefaults(home)).toEqual({
      agflowHome: home,
      claudeHome: recorded.claude,
      codexHome: recorded.codex,
      connectivity: { HTTPS_PROXY: 'http://proxy.corp:3128', NODE_EXTRA_CA_CERTS: '/etc/corp-ca.pem' },
    });
  });
});

describe('liveClusterOptions', () => {
  test("real models on the person's vendor homes, HOME, connectivity and pinned binaries, the toy repository and long waits", () => {
    const connectivity = { NODE_EXTRA_CA_CERTS: '/etc/corp-ca.pem' };
    const args = parseLiveArgs(['--repo', 'git@github.com:alice/agflow-toy.git'], { ...DEFAULTS, connectivity });
    const binaries = {
      claude: join(DEFAULTS.agflowHome, 'runner', vendorBinary('claude', PINS.claude.version)),
      codex: join(DEFAULTS.agflowHome, 'runner', vendorBinary('codex', PINS.codex.version)),
    };
    expect(liveClusterOptions(args, 'codex', 'killed-agent')).toEqual({
      vendor: 'codex',
      models: {
        kind: 'real',
        homes: { claude: DEFAULTS.claudeHome, codex: DEFAULTS.codexHome },
        home: homedir(),
        connectivity,
      },
      binaries,
      files: toyRepoFiles(),
      repo: 'git@github.com:alice/agflow-toy.git',
      runnerLeads: false,
      goal: LIVE_GOAL,
      waitMs: LIVE_WAIT_MS,
    });
    // The lost lead needs a runner lead that follows its goal.
    expect(liveClusterOptions(args, 'claude', 'lost-lead')).toMatchObject({ runnerLeads: true, goal: LOST_LEAD.goal });
    expect(liveClusterOptions(parseLiveArgs([], DEFAULTS), 'claude', 'closed-laptop').repo).toBeUndefined();
  });
});

describe('prepareRunnerHome with real models', () => {
  test("writes a test block with only allowShortTimings, uses the given homes and binaries, and the person's connectivity but no proxy", async () => {
    const person = tmpDir('agf-person-');
    const vendorHomes = { claude: join(person, 'homes', 'claude'), codex: join(person, 'homes', 'codex') };
    for (const path of Object.values(vendorHomes)) mkdirSync(path, { recursive: true });
    // The person's pinned binaries, as setup installs them.
    const binaries = {
      claude: join(person, 'runner', vendorBinary('claude', PINS.claude.version)),
      codex: join(person, 'runner', vendorBinary('codex', PINS.codex.version)),
    };
    for (const file of Object.values(binaries)) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, '#!/bin/sh\nexit 0\n');
      chmodSync(file, 0o755);
    }
    // The person's setup recorded a CA bundle and no proxy.
    const ca = join(person, 'corp-ca.pem');
    const saved = process.env.SSH_AUTH_SOCK;
    process.env.SSH_AUTH_SOCK = '/private/tmp/ssh-agent.sock';
    let home: RunnerHome;
    try {
      home = await prepareRunnerHome({
        dir: join(tmpDir('agf-rh-'), 'alice'),
        name: 'alice-mac',
        credentials: { hubUrl: 'http://127.0.0.1:4000', token: 'agf_cli_token', user: 'alice' },
        vendors: ['claude', 'codex'],
        binaries,
        models: { kind: 'real', homes: vendorHomes, home: person, connectivity: { NODE_EXTRA_CA_CERTS: ca } },
      });
    } finally {
      if (saved === undefined) delete process.env.SSH_AUTH_SOCK;
      else process.env.SSH_AUTH_SOCK = saved;
    }
    homes.push(home);
    const config = loadRunnerConfig(home.paths.config, { AGFLOW_TEST: '1' });
    expect(config.test).toEqual({ claudeEnv: {}, codexConfig: {}, skipAuthChecks: false, allowShortTimings: true });
    const written = JSON.parse(readFileSync(home.paths.config, 'utf8')) as { test: Record<string, unknown> };
    expect(written.test.allowShortTimings).toBe(true);
    expect(written.test.skipAuthChecks).toBe(false);
    expect(config.homes).toEqual(vendorHomes);
    expect(config.connectivity).toEqual({ NODE_EXTRA_CA_CERTS: ca });
    for (const vendor of ['claude', 'codex'] as const) {
      const linked = join(home.paths.runner, vendorBinary(vendor, PINS[vendor].version));
      expect(realpathSync(linked)).toBe(realpathSync(binaries[vendor]));
    }
    // The person's HOME and SSH agent, as in production; still a runner home and CLI config of its own.
    expect(home.home).toBe(person);
    expect(home.env).toMatchObject({
      HOME: person,
      SSH_AUTH_SOCK: '/private/tmp/ssh-agent.sock',
      NODE_EXTRA_CA_CERTS: ca,
      AGFLOW_TEST: '1',
    });
    expect(home.agflowHome.startsWith(`${home.dir}/`)).toBe(true);
    for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY']) expect(home.env[name]).toBeUndefined();
    home.remove();
    homes.splice(0);
    // Removing the runner home leaves the person's HOME and vendor homes alone.
    expect(realpathSync(vendorHomes.claude)).toBe(vendorHomes.claude);
  }, SPAWNS_MS);
});

/** A fake vendor CLI at the version's place under the AGFLOW_HOME: it logs its arguments and prints the output. */
function fakeCli(agflowHome: string, vendor: Vendor, output: string, code = 0): string {
  const file = join(agflowHome, 'runner', vendorBinary(vendor, '9.9.9'));
  const log = join(agflowHome, `${vendor}-args.log`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `#!/bin/sh\necho "$@" >> '${log}'\ncat <<'EOF'\n${output}\nEOF\nexit ${code}\n`);
  chmodSync(file, 0o755);
  return log;
}

describe('checkVendorHome', () => {
  const OPTIONS = { version: '9.9.9' };

  function person(): LiveDefaults {
    const agflowHome = tmpDir('agf-live-');
    const claudeHome = join(agflowHome, 'runner', 'homes', 'claude');
    const codexHome = join(agflowHome, 'runner', 'homes', 'codex');
    for (const path of [claudeHome, codexHome]) mkdirSync(path, { recursive: true });
    return { agflowHome, claudeHome, codexHome, connectivity: {} };
  }

  test('reports a missing vendor home, and a missing binary, without running anything', async () => {
    const live = person();
    const missing = { ...live, claudeHome: join(live.agflowHome, 'nowhere') };
    expect(await checkVendorHome('claude', missing, OPTIONS)).toEqual({
      vendor: 'claude',
      home: missing.claudeHome,
      ok: false,
      detail: `${missing.claudeHome} does not exist`,
    });
    const unbuilt = await checkVendorHome('codex', live, OPTIONS);
    expect(unbuilt.ok).toBe(false);
    expect(unbuilt.detail).toContain('binary missing');
  }, SPAWNS_MS);

  test('reports a logged-out or logged-in home through claudeLoginStatus, which only asks for its status', async () => {
    const live = person();
    const log = fakeCli(live.agflowHome, 'claude', '{"loggedIn": false}', 1);
    expect(await checkVendorHome('claude', live, OPTIONS)).toEqual({
      vendor: 'claude',
      home: live.claudeHome,
      ok: false,
      detail: 'not logged in to Claude',
    });
    fakeCli(live.agflowHome, 'claude', '{"loggedIn": true, "authMethod": "claude.ai", "subscriptionType": "max"}');
    expect(await checkVendorHome('claude', live, OPTIONS)).toEqual({
      vendor: 'claude',
      home: live.claudeHome,
      ok: true,
      detail: 'logged in, plan max',
    });
    // No prompt: the binary only ever ran `auth status --json`.
    expect(readFileSync(log, 'utf8')).toBe('auth status --json\nauth status --json\n');
  }, SPAWNS_MS);

  test('reports a logged-out or logged-in home through codexLoginStatus, which only asks for its status', async () => {
    const live = person();
    const log = fakeCli(live.agflowHome, 'codex', 'Not logged in', 1);
    const loggedOut = await checkVendorHome('codex', live, OPTIONS);
    expect(loggedOut).toMatchObject({ ok: false, detail: 'not logged in to Codex' });
    fakeCli(live.agflowHome, 'codex', 'Logged in using ChatGPT');
    expect(await checkVendorHome('codex', live, OPTIONS)).toEqual({
      vendor: 'codex',
      home: live.codexHome,
      ok: true,
      detail: 'logged in',
    });
    expect(readFileSync(log, 'utf8')).toBe('login status\nlogin status\n');
  }, SPAWNS_MS);
});

describe('toyRepoFiles', () => {
  test('is a small CLI with a test and one research note, committed on main of the created origin', async () => {
    const files = toyRepoFiles();
    expect(Object.keys(files).sort()).toEqual([
      'README.md',
      'notes/research.md',
      'package.json',
      'src/cli.ts',
      'src/count.ts',
      'test/count.test.ts',
    ]);
    const origin = await originRepo(files);
    try {
      for (const [path, content] of Object.entries(files)) {
        expect(await fileAt(origin.path, 'main', path)).toBe(content);
      }
      // The CLI works and its test passes, so a live run's agents start from a green repository.
      const work = await cloneTo(origin.path, join(tmpDir('agf-toy-'), 'toy'));
      writeFileSync(join(work, 'words.txt'), 'one two  three\nfour\n');
      const spawn = { cwd: work, env: { PATH: '/usr/bin:/bin' } };
      const cli = Bun.spawnSync([process.execPath, 'src/cli.ts', 'words.txt'], spawn);
      expect(cli.stdout.toString()).toBe('4\n');
      expect(cli.exitCode).toBe(0);
      const tested = Bun.spawnSync([process.execPath, 'test'], spawn);
      expect(tested.exitCode).toBe(0);
    } finally {
      origin.remove();
    }
  }, SPAWNS_MS);
});

describe('the task texts of a live run', () => {
  test('KILLED_AGENT, CLOSED_LAPTOP, LOST_LEAD and TAKEOVER name every file and command their drivers wait for', () => {
    const killed = KILLED_AGENT.task.objective;
    for (const named of ['a.txt', 'b.txt', 'c.txt', 'write_handoff', KILLED_AGENT.handoff, KILLED_AGENT.longCommand]) {
      expect(killed).toContain(named);
    }
    const closed = CLOSED_LAPTOP.task.objective;
    for (const named of ['a.txt', 'tick.txt', 'c.txt', CLOSED_LAPTOP.tickCommand]) expect(closed).toContain(named);
    for (const named of ['write_handoff', LOST_LEAD.handoff, 'accept_task']) expect(LOST_LEAD.goal).toContain(named);
    expect(LOST_LEAD.task.objective).toContain('review.txt');
    // readyForTakeover waits for b.txt and the long command; the next attempt adds c.txt.
    const takeover = TAKEOVER.task.objective;
    for (const named of ['a.txt', 'b.txt', 'c.txt', 'write_handoff', TAKEOVER.handoff, TAKEOVER.longCommand]) {
      expect(takeover).toContain(named);
    }
  });
});

describe('formatResults', () => {
  const RESULTS: ScenarioResult[] = [
    {
      scenario: 'killed agent',
      vendor: 'claude',
      checks: [
        { name: 'a1 ends crashed, class infra', passed: true, detail: '["crashed","infra"]' },
        { name: 'the scenario ran to its end', passed: true, detail: '2 checks made' },
      ],
      passed: true,
      dump: null,
    },
    {
      scenario: 'lost lead',
      vendor: 'codex',
      checks: [{ name: 'lead-a2 takes the seat', passed: false, detail: 'a | b\nsecond line' }],
      passed: false,
      dump: '=== cluster',
    },
  ];

  test('renders a markdown table of scenario, check, result and detail; results.json holds the same data', () => {
    const { markdown, json } = formatResults(RESULTS);
    expect(markdown.split('\n').slice(0, 2)).toEqual([
      '| Scenario | Check | Result | Detail |',
      '| --- | --- | --- | --- |',
    ]);
    expect(markdown).toContain(
      '| killed agent (claude) | a1 ends crashed, class infra | passed | ["crashed","infra"] |',
    );
    // A cell keeps the table intact: pipes are escaped and lines joined.
    expect(markdown).toContain('| lost lead (codex) | lead-a2 takes the seat | FAILED | a \\| b<br>second line |');
    expect(json).toEqual({
      passed: false,
      rows: [
        {
          scenario: 'killed agent',
          vendor: 'claude',
          check: 'a1 ends crashed, class infra',
          passed: true,
          detail: '["crashed","infra"]',
        },
        {
          scenario: 'killed agent',
          vendor: 'claude',
          check: 'the scenario ran to its end',
          passed: true,
          detail: '2 checks made',
        },
        {
          scenario: 'lost lead',
          vendor: 'codex',
          check: 'lead-a2 takes the seat',
          passed: false,
          detail: 'a | b\nsecond line',
        },
      ],
    });
    expect(markdown.trim().split('\n')).toHaveLength(2 + json.rows.length);
    expect(formatResults([]).json.passed).toBe(false);
  });
});

describe('noScriptedModels', () => {
  test('records nothing and refuses programs: a live run has no scripted servers', async () => {
    const models = noScriptedModels();
    expect([models.requests(), models.requestsFor('T-1-a1'), models.unmatched(), models.externalAttempts()]).toEqual([
      [],
      [],
      [],
      [],
    ]);
    expect(models.sawText('T-1-a1', 'anything')).toBe(false);
    expect(() => models.addPrograms({})).toThrow('real models');
    expect(() => models.anthropic).toThrow('real models');
    await models.close();
  });
});

describe('remoteOrigin', () => {
  const FILES = { 'README.md': '# toy\n' };

  /** Every ref of the repository with its sha: what a mirror push would change. */
  const refsOf = (repo: string) => gitIn(repo, ['for-each-ref', '--format=%(refname) %(objectname)']);

  test('resets an empty remote to main holding the files, and its mirror follows the remote on refresh', async () => {
    const remote = await originRepo({});
    dirs.push(remote.root);
    // An empty remote: no main yet.
    await gitIn(remote.path, ['update-ref', '-d', 'refs/heads/main']);
    const mirrored = await remoteOrigin(remote.path, FILES, join(tmpDir('agf-mirror-'), 'origin'));
    const { origin } = mirrored;
    expect(await refSha(remote.path, 'refs/heads/main')).toBe(origin.mainSha);
    expect(await fileAt(origin.path, origin.mainSha, 'README.md')).toBe('# toy\n');
    expect((await gitIn(origin.path, ['log', '-1', '--format=%s', 'main'])).trim()).toBe(REMOTE_MAIN_SUBJECT);
    const pushed = await commitFiles(remote.path, { branch: 'agflow/T-1-toy', files: { 'a.txt': 'a\n' } });
    expect(await refSha(origin.path, 'refs/heads/agflow/T-1-toy')).toBeNull();
    await mirrored.refresh();
    expect(await refSha(origin.path, 'refs/heads/agflow/T-1-toy')).toBe(pushed);
  }, SPAWNS_MS);

  test('resets a remote an earlier run used, deleting its refs, and refuses one with refs no run made', async () => {
    const remote = await originRepo({});
    dirs.push(remote.root);
    await gitIn(remote.path, ['update-ref', '-d', 'refs/heads/main']);
    await remoteOrigin(remote.path, FILES, join(tmpDir('agf-mirror-'), 'origin'));
    await commitFiles(remote.path, { branch: 'agflow/T-1-toy', files: { 'a.txt': 'a\n' } });
    const wip = await commitFiles(remote.path, { branch: 'wip', files: { 'b.txt': 'b\n' } });
    await gitIn(remote.path, ['update-ref', 'refs/agflow/T-1/a1', wip]);
    await gitIn(remote.path, ['update-ref', '-d', 'refs/heads/wip']);
    const second = await remoteOrigin(remote.path, FILES, join(tmpDir('agf-mirror-'), 'origin'));
    // A new main of the same files: within the same second it is even the same commit.
    expect(await refSha(remote.path, 'refs/heads/main')).toBe(second.origin.mainSha);
    expect(await fileAt(second.origin.path, 'main', 'README.md')).toBe('# toy\n');
    const refs = (await gitIn(remote.path, ['for-each-ref', '--format=%(refname)'])).split('\n').filter(Boolean);
    expect(refs).toEqual(['refs/heads/main']);
    // A ref outside main and agflow's own refs: not a throwaway repository of a live run, and left as it was.
    await commitFiles(remote.path, { branch: 'feature', files: { 'c.txt': 'c\n' } });
    const before = await refsOf(remote.path);
    await expect(remoteOrigin(remote.path, FILES, join(tmpDir('agf-mirror-'), 'origin'))).rejects.toThrow(
      'refs/heads/feature',
    );
    expect(await refsOf(remote.path)).toBe(before);
    // A main that no live run made.
    const other = await originRepo({ 'README.md': '# a real project\n' });
    dirs.push(other.root);
    const untouched = await refsOf(other.path);
    await expect(remoteOrigin(other.path, FILES, join(tmpDir('agf-mirror-'), 'origin'))).rejects.toThrow(
      'not a throwaway repository',
    );
    expect(await refsOf(other.path)).toBe(untouched);
  }, SPAWNS_MS);
});

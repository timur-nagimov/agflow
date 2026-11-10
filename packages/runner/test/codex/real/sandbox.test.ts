// The Codex sandbox checks (design 15 Sandbox checks, 5, 9.1, 9.2, 7.6): what a tool command of the real pinned
// app-server can reach, write and read, which MCP servers and skills a thread loads, and that a filter driver the agent
// plants in its clone's .git/config never runs outside the sandbox. They run only with AGFLOW_SANDBOX_CHECKS=1 (root
// script check:codex-sandbox), because they use the network and a disposable keychain in a scratch HOME.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { gitIn } from '@agflow/testkit';
import { reply, rules } from '@agflow/testkit/src/codex/index';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODEX_VERSION, findCodexBinary } from '../../../src/adapters/codex';
import type { FindCodexOptions } from '../../../src/adapters/codex/binary';
import { appServerArgs, appServerEnv, threadOverrides } from '../../../src/adapters/codex/config';
import { openAppServer } from '../../../src/adapters/codex/process';
import { vendorBinary } from '../../../src/vendor/pins';
import { type CodexHarness, DEFAULT_ORIGIN_FILES, EventLog, type HarnessAttempt, startCodexHarness } from './harness';
import { withScratchKeychain } from './scratch-keychain';

setDefaultTimeout(180_000);

/** The pinned binary when the sandbox checks may run: AGFLOW_SANDBOX_CHECKS=1 and findCodexBinary finds the pin. */
async function sandboxCodexBinary(options: FindCodexOptions = {}): Promise<string | null> {
  const env = options.env ?? process.env;
  return env.AGFLOW_SANDBOX_CHECKS === '1' ? findCodexBinary({ env, home: options.home }) : null;
}

const bin = await sandboxCodexBinary();

const cleanups: (() => void)[] = [];
let h: CodexHarness | null = null;
afterEach(async () => {
  try {
    await h?.close();
  } finally {
    h = null;
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  }
});

/** A directory outside every clone and the harness, removed after the test. */
function scratchDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The text a Code Mode exec call returned to the model, after Codex's "Output:" header. */
function execText(output: string): string {
  return output.slice(output.indexOf('Output:\n') + 'Output:\n'.length).trim();
}

/** `name=value` lines a check script printed. */
function results(output: string): Record<string, string> {
  return Object.fromEntries(
    [...output.matchAll(/^([a-z_]+)=(.*)$/gm)].map((match) => [match[1] as string, match[2] as string]),
  );
}

/** Each check's exit status, printed as `<name>=<status>` after it. */
function checkScript(checks: Record<string, string>): string {
  return Object.entries(checks)
    .map(([name, command]) => `(${command}) >/dev/null 2>&1; echo "${name}=$?"`)
    .join('\n');
}

/**
 * Runs script as one tool command of a fresh session of the attempt and gives the `name=value` lines it printed. The
 * command runs in Codex's sandbox, as every unescalated command does; the turn must complete.
 */
async function sandboxed(a: HarnessAttempt, script: string, secret?: string): Promise<Record<string, string>> {
  h!.provider.setHandler(
    rules([
      { toolOutputs: 0, reply: reply.shell({ cmd: script, timeoutMs: 60_000 }) },
      { toolOutputs: 1, reply: reply.text('The checks ran.') },
    ]),
  );
  const from = h!.provider.requests.length;
  const session = await a.start();
  const log = new EventLog(session.events);
  expect(await log.next('turn_ended', { ms: 90_000 })).toMatchObject({ outcome: 'completed', toolCalls: 1 });
  await session.close();
  await log.done;
  // An escalation would have asked: these commands ran inside the sandbox.
  expect(log.of('approval_request')).toEqual([]);
  const answered = h!.provider.requests.slice(from).find((request) => request.toolOutputsSinceUser === 1);
  const result = JSON.parse(execText(answered!.toolOutputs[0]!.output)) as { output: string };
  if (secret !== undefined) expect(result.output).not.toContain(secret);
  return results(result.output);
}

/**
 * The same script outside the sandbox, in the clone with the agent's environment: the control for every check. It
 * runs asynchronously, since the hub's recording front answers from this process.
 */
async function unsandboxed(a: HarnessAttempt, script: string): Promise<Record<string, string>> {
  const run = Bun.spawn(['/bin/sh', '-c', script], {
    cwd: a.clone,
    env: { ...a.launch.env, HOME: join(a.clone, '.agflow', 'run', 'home'), TMPDIR: a.launch.tmpDir },
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const [output] = await Promise.all([new Response(run.stdout).text(), run.exited]);
  return results(output);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function keychainScript(lookup: string): string {
  // `status` is read-only in zsh, the macOS tool shell. Keep probe variables separate from shell parameters.
  return [
    `agflow_lookup_value=$(${lookup} 2>/dev/null)`,
    'agflow_lookup_exit=$?',
    'printf "keychain_value=%s\\nkeychain=%s\\n" "$agflow_lookup_value" "$agflow_lookup_exit"',
  ].join('\n');
}

describe('the Codex sandbox checks', () => {
  test('results preserves an empty lookup value and its nonzero exit status', () => {
    expect(results('keychain_value=\nkeychain=44\n')).toEqual({ keychain_value: '', keychain: '44' });
  });

  for (const shell of ['/bin/sh', '/bin/zsh']) {
    // the runner supports darwin-arm64 only; design 7.1 (zsh is the macOS tool shell).
    test.skipIf(shell === '/bin/zsh' && process.platform !== 'darwin')(
      `the keychain probe reports refusal and success in ${shell}`, () => {
        const home = scratchDir('agflow-keychain-shell-');
        for (const code of [44, 0]) {
          const secret = 'scratch-test-secret';
          const lookup = `/bin/sh -c ${shellQuote(code === 0 ? `printf %s ${secret}` : `exit ${code}`)}`;
          const run = Bun.spawnSync([shell, '-f', '-c', keychainScript(lookup)], {
            cwd: home,
            env: { PATH: '/usr/bin:/bin', HOME: home, ZDOTDIR: home },
            stdin: 'ignore',
            stdout: 'pipe',
            stderr: 'pipe',
          });
          expect(run.stderr.toString()).toBe('');
          expect(run.exitCode).toBe(0);
          expect(results(run.stdout.toString())).toEqual({
            keychain_value: code === 0 ? secret : '',
            keychain: String(code),
          });
          if (code !== 0) expect(run.stdout.toString()).not.toContain(secret);
        }
      },
    );
  }

  test('run only with AGFLOW_SANDBOX_CHECKS=1 and a located pin', async () => {
    const dir = scratchDir('agflow-codex-sandbox-gate-');
    const stub = join(dir, 'codex');
    writeFileSync(stub, `#!/bin/sh\necho "codex-cli ${CODEX_VERSION}"\n`, { mode: 0o755 });
    const home = join(dir, 'home');
    mkdirSync(home);
    expect(await sandboxCodexBinary({ env: { AGFLOW_SANDBOX_CHECKS: '1', AGFLOW_CODEX_BIN: stub }, home })).toBe(stub);
    expect(await sandboxCodexBinary({ env: { AGFLOW_SANDBOX_CHECKS: '0', AGFLOW_CODEX_BIN: stub }, home })).toBeNull();
    expect(await sandboxCodexBinary({ env: { AGFLOW_CODEX_BIN: stub }, home })).toBeNull();
    expect(await sandboxCodexBinary({ env: { AGFLOW_SANDBOX_CHECKS: '1' }, home })).toBeNull();
  });
});

// the runner supports darwin-arm64 only; design 7.1
describe.skipIf(bin === null || process.platform !== 'darwin')('the Codex sandbox', () => {
  test('tool commands reach neither the hub, a package registry nor a git host, with the proxies bypassed', async () => {
    h = await startCodexHarness(bin!);
    const a = await h.attempt();
    // Drop every proxy and agflow git setting, retaining only a scratch HOME.
    const direct = `env -i PATH=/usr/bin:/bin HOME=${shellQuote(scratchDir('agflow-direct-home-'))}`;
    const script = checkScript({
      hub: `${direct} curl -sS -m 10 -o /dev/null ${a.launch.env.AGFLOW_HUB_URL}/api/tasks`,
      registry: `${direct} curl -sS -m 10 -o /dev/null https://registry.npmjs.org/`,
      git_host: `${direct} GIT_TERMINAL_PROMPT=0 git ls-remote https://github.com/git/git HEAD`,
    });
    // Outside the sandbox the same commands connect: the network is there, so a failure inside is the sandbox's.
    expect(await unsandboxed(a, script)).toEqual({ hub: '0', registry: '0', git_host: '0' });
    const before = h.hubRequests.length;
    const inside = await sandboxed(a, script);
    expect(inside).toEqual({
      hub: expect.not.stringMatching(/^0$/),
      registry: expect.not.stringMatching(/^0$/),
      git_host: expect.not.stringMatching(/^0$/),
    });
    expect(h.hubRequests.slice(before).filter((line) => line.endsWith('/api/tasks'))).toEqual([]);
  });

  test('tool commands write only inside their clone, its .git and its temporary directory', async () => {
    h = await startCodexHarness(bin!);
    const a = await h.attempt();
    // Another attempt of the same runner, never started: its temporary directory is not this agent's.
    const other = await h.attempt();
    const name = `agflow-sandbox-check-${randomUUID()}`;
    const targets = {
      slash_tmp: join('/tmp', name),
      other_tmp: join(other.runDir.tmp, name),
      runner: join(h.paths.runner, name),
      outside_home: join(scratchDir('agflow-forbidden-home-'), name),
    };
    // A failed check would leave its file behind; none may stay, wherever it landed.
    cleanups.push(() => {
      for (const target of Object.values(targets)) rmSync(target, { force: true });
    });
    const forbiddenWrites = Object.fromEntries(
      Object.entries(targets).map(([key, target]) => [key, `echo written > ${shellQuote(target)}`]),
    );
    expect(await unsandboxed(a, checkScript(forbiddenWrites))).toEqual(
      Object.fromEntries(Object.keys(targets).map((key) => [key, '0'])),
    );
    for (const target of Object.values(targets)) {
      expect(readFileSync(target, 'utf8')).toBe('written\n');
      rmSync(target);
    }
    const inside = await sandboxed(
      a,
      [
        'echo "tmpdir_value=$TMPDIR"',
        checkScript({
          clone: 'echo written > written.txt',
          commit: "git add written.txt && git commit -q -m 'A sandboxed commit'",
          tmpdir: `echo written > "$TMPDIR/${name}"`,
          ...forbiddenWrites,
        }),
      ].join('\n'),
    );
    expect(inside).toEqual({
      tmpdir_value: a.runDir.tmp,
      clone: '0',
      commit: '0',
      tmpdir: '0',
      slash_tmp: expect.not.stringMatching(/^0$/),
      other_tmp: expect.not.stringMatching(/^0$/),
      runner: expect.not.stringMatching(/^0$/),
      outside_home: expect.not.stringMatching(/^0$/),
    });
    expect(readFileSync(join(a.clone, 'written.txt'), 'utf8')).toBe('written\n');
    expect(await gitIn(a.clone, ['log', '-1', '--format=%s'])).toBe('A sandboxed commit');
    expect(existsSync(join(a.runDir.tmp, name))).toBe(true);
    for (const target of Object.values(targets)) expect(existsSync(target)).toBe(false);
  });

  test('a disposable scratch keychain is readable outside the sandbox but not from a tool command', async () => {
    h = await startCodexHarness(bin!);
    const a = await h.attempt();
    await withScratchKeychain(scratchDir('agflow-keychain-home-'), async (item) => {
      // Both runs name the same scratch HOME and keychain explicitly. A leak still goes to stdout and the provider.
      const lookup = `HOME=${shellQuote(item.home)} /usr/bin/security find-generic-password -a agflow -s ${shellQuote(item.service)} -w ${shellQuote(item.path)}`;
      const script = keychainScript(lookup);
      const readable = { keychain: '0', keychain_value: item.secret };
      expect(await unsandboxed(a, script)).toEqual(readable);
      expect(await sandboxed(a, script, item.secret)).toEqual({
        keychain: expect.stringMatching(/^[1-9]\d*$/),
        keychain_value: '',
      });
      expect(JSON.stringify(h!.provider.requests.map((request) => request.body))).not.toContain(item.secret);
      // A lock or vanished item must not masquerade as a sandbox refusal.
      expect(await unsandboxed(a, script)).toEqual(readable);
    });
  });

  test("a filter driver planted in the clone's .git/config never runs outside the sandbox", async () => {
    h = await startCodexHarness(bin!);
    const a = await h.attempt();
    const marker = join(scratchDir('agflow-filter-check-'), 'filter-ran');
    const plant = [
      `git config filter.agflowcheck.clean 'touch ${marker}; cat'`,
      "echo '* filter=agflowcheck' > .git/info/attributes",
      'echo changed >> README.md',
      'echo planted',
    ].join(' && ');
    h.provider.setHandler(
      rules([
        { marker: 'Work on', toolOutputs: 0, reply: reply.shell({ cmd: plant }) },
        { marker: 'Work on', toolOutputs: 1, reply: reply.text('Planted.') },
        // Long enough for Codex's per-turn metadata (`git status`) to run while the turn is still open.
        { marker: 'Keep going', toolOutputs: 0, reply: reply.shell({ cmd: 'sleep 4' }) },
        { marker: 'Keep going', toolOutputs: 1, reply: reply.text('Kept going.') },
      ]),
    );
    const session = await a.start();
    const log = new EventLog(session.events);
    await log.next('turn_ended');
    // The sandboxed command could write the clone's .git: the driver is in place.
    expect(await gitIn(a.clone, ['config', 'filter.agflowcheck.clean'])).toBe(`touch ${marker}; cat`);
    const from = log.events.length;
    await session.send({ id: 'msg-1', text: 'Keep going.', authority: 'person' });
    expect(await log.next('turn_ended', { from, ms: 60_000 })).toMatchObject({ outcome: 'completed', toolCalls: 1 });
    await session.close();
    await log.done;
    // A resume runs Codex's thread-start git calls again.
    const resumed = await a.start(session.sessionRef);
    const resumedLog = new EventLog(resumed.events);
    await resumedLog.next('started');
    await resumed.close();
    await resumedLog.done;
    expect(existsSync(marker)).toBe(false);
    // Codex did compute every request's turn metadata, but found no repository for it: with one, the metadata carries
    // a `workspaces` entry from its own `git status`.
    const metadata = h.provider.requests.map((request) => request.headers['x-codex-turn-metadata']);
    expect(metadata.length).toBeGreaterThanOrEqual(4);
    for (const entry of metadata) {
      const parsed = JSON.parse(entry ?? 'null') as Record<string, unknown> | null;
      expect(parsed).toMatchObject({ thread_id: session.sessionRef });
      expect(parsed).not.toHaveProperty('workspaces');
    }
    // The control: an ordinary git status in the clone runs the planted driver.
    Bun.spawnSync(['git', 'status', '--porcelain'], {
      cwd: a.clone,
      env: { PATH: '/usr/bin:/bin', HOME: scratchDir('agflow-filter-home-') },
    });
    expect(existsSync(marker)).toBe(true);
  });

  test("an MCP server planted in the clone's .codex/config.toml loads only when trust is forced", async () => {
    const marker = join(scratchDir('agflow-planted-mcp-'), 'planted-ran');
    const planted = [
      DEFAULT_ORIGIN_FILES['.codex/config.toml'],
      '[mcp_servers.planted]',
      'command = "/bin/sh"',
      `args = ["-c", "touch ${marker}"]`,
      '',
    ].join('\n');
    h = await startCodexHarness(bin!, {
      files: {
        ...DEFAULT_ORIGIN_FILES,
        '.codex/config.toml': planted,
        // Repo skills still load without trust (design 9.2): instructions, like AGENTS.md.
        '.codex/skills/repo-check/SKILL.md': '---\nname: repo-check\ndescription: A repository skill.\n---\n\nCheck.\n',
      },
    });
    const untrusted = await h.attempt({ projectConfigVerified: false });
    const session = await untrusted.start();
    const log = new EventLog(session.events);
    await log.next('turn_ended');
    await session.close();
    await log.done;
    expect(existsSync(marker)).toBe(false);
    expect(JSON.stringify(h.provider.requests[0]!.body)).toContain('repo-check');

    const trusted = await h.attempt({ projectConfigVerified: true });
    const error = await trusted.start().then(
      () => null,
      (error: unknown) => error as Error,
    );
    // The listing omits a server that is starting or failed; its startup status shows it (design 9.2).
    expect(error?.message).toBe('codex thread started unexpected MCP servers: planted');
    // Codex ran it, outside the sandbox, before the check could refuse the thread: trusting a project config trusts
    // its commands, which is why only a verified .codex/ is trusted.
    expect(existsSync(marker)).toBe(true);
  });

  test("a skill in the runner's Codex home fails the start", async () => {
    h = await startCodexHarness(bin!);
    const a = await h.attempt();
    const skill = join(a.launch.env.CODEX_HOME!, 'skills', 'home-check', 'SKILL.md');
    mkdirSync(join(skill, '..'), { recursive: true });
    writeFileSync(skill, '---\nname: home-check\ndescription: A user skill.\n---\n\nCheck.\n');
    const error = await a.start().then(
      () => null,
      (error: unknown) => error as Error,
    );
    expect(error?.message).toBe('codex thread lists user or plugin skills: home-check');
    expect(h.provider.requests).toEqual([]);
  });

  test("a skill in the owner's home given as the launch's HOME does not load", async () => {
    const owner = scratchDir('agflow-owner-home-');
    for (const dir of ['.codex', '.agents']) {
      const skill = join(owner, dir, 'skills', 'owner-check', 'SKILL.md');
      mkdirSync(join(skill, '..'), { recursive: true });
      writeFileSync(skill, '---\nname: owner-check\ndescription: An owner skill.\n---\n\nCheck.\n');
    }
    h = await startCodexHarness(bin!);
    // The app-server's HOME is the codex-user home whatever the launch's environment says.
    const a = await h.attempt({ agentEnv: (env) => ({ ...env, HOME: owner }) });
    const session = await a.start();
    const log = new EventLog(session.events);
    await log.next('turn_ended');
    expect(JSON.stringify(h.provider.requests[0]!.body)).not.toContain('owner-check');
  });

  test('the thread lists no codex_apps, only the agflow bridge', async () => {
    h = await startCodexHarness(bin!);
    const a = await h.attempt();
    const codexHome = a.launch.env.CODEX_HOME!;
    const userHome = h.paths.homes.codexUser;
    for (const home of [codexHome, userHome]) mkdirSync(home, { recursive: true, mode: 0o700 });
    const app = await openAppServer({
      bin: join(h.paths.runner, vendorBinary('codex', a.launch.cliVersion)),
      args: appServerArgs(h.config.test!.codexConfig),
      env: appServerEnv({ base: a.launch.env, bridgeEnv: a.launch.bridge.env, codexHome, userHome }),
      cwd: userHome,
      expectedVersion: a.launch.cliVersion,
      logFile: join(h.dir, 'codex-apps.log'),
    });
    try {
      const { thread } = await app.rpc.request('thread/start', threadOverrides(a.launch, userHome));
      const listed = await app.rpc.request('mcpServerStatus/list', { threadId: thread.id });
      // M2c Task 22 checks preflight in the logged-in runner home; every live start also requires only agflow.
      // This scratch-home check alone cannot establish whether a logged-in home would expose codex_apps.
      expect(listed.data.map((server) => server.name)).toEqual(['agflow']);
      expect((await app.rpc.request('mcpServerStatus/list', {})).data).toEqual([]);
    } finally {
      await app.end();
    }
  });
});

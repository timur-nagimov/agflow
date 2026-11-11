// Setup checks run in the service, with its credentials, remote git environment and shared sandbox (design 7.1).
import type { VendorAdapter } from '../adapters/types';
import { deleteRefsFenced, lsRemote, type PushGit, pushRefs } from '../git/push';
import { remoteGitEnv, runGit } from '../git/run';
import { type FetchFn, RunnerHttpError, RunnerHubHttp } from '../hub-http';
import type { CredentialsProvider, WelcomeMessage } from '../link';
import { parsePmsetSettings } from '../ops/power';
import { checkPrepSandbox, type PrepSandbox } from '../prep/sandbox';
import type { RunnerHandle } from '../runner';
import type { Exec } from './system';

export interface CheckResult {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}

export interface ServiceChecksInput {
  runner: Pick<RunnerHandle, 'vault' | 'status'>;
  welcome: Promise<Pick<WelcomeMessage, 'runnerId' | 'wipRefPrefix'>>;
  /** Gives null for credentials of another hub than the runner's, as createRunner's provider does. */
  credentials: CredentialsProvider;
  /** The runner's hub, which a sign-in hint names. */
  hubUrl: string | null;
  adapters: readonly VendorAdapter[];
  sandbox: PrepSandbox;
  fetch?: FetchFn;
  exec: Exec;
  platform: NodeJS.Platform;
  /** The first welcome can lag startup; 30 s by default. */
  welcomeTimeoutMs?: number;
}

function describe(value: unknown): string {
  return (value instanceof Error ? value.message : String(value)).replace(/[\r\n]+/g, ' ').trim();
}

async function check(name: string, run: () => Promise<Omit<CheckResult, 'name'>>): Promise<CheckResult> {
  try {
    const result = await run();
    return { name, ...result, detail: describe(result.detail) };
  } catch (error) {
    return { name, status: 'fail', detail: describe(error) };
  }
}

async function waitForWelcome(input: ServiceChecksInput) {
  const ms = input.welcomeTimeoutMs ?? 30_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const welcome = await Promise.race([
      input.welcome,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
    if (welcome === null) {
      throw new Error(`no welcome from the hub within ${ms / 1000} s (link: ${input.runner.status().link})`);
    }
    return welcome;
  } finally {
    clearTimeout(timer);
  }
}

async function deleteProbe(git: PushGit, ref: string, expectedSha: string): Promise<void> {
  const [deleted] = await deleteRefsFenced({ ...git, refs: [{ ref, expectedSha }] });
  if (deleted?.status !== 'deleted') {
    throw new Error(deleted?.detail ?? `${ref}: fenced deletion ${deleted?.status ?? 'failed'}`);
  }
}

async function probe(git: PushGit, welcome: Pick<WelcomeMessage, 'runnerId' | 'wipRefPrefix'>): Promise<string> {
  const ref = `${welcome.wipRefPrefix}_probe/${welcome.runnerId}`;
  return git.vault.withLock(async () => {
    const leftover = (await lsRemote(git, [ref])).get(ref);
    if (leftover !== undefined) await deleteProbe(git, ref, leftover);
    // The vault may hold no commits yet. This parentless probe needs neither a fetch nor an owner's identity.
    const repository = `--git-dir=${git.vault.path}`;
    const tree = await runGit(git.local, [repository, 'mktree'], { input: '' });
    const commit = await runGit(
      git.local,
      [repository, 'commit-tree', tree.stdout.trim(), '-m', 'agflow: setup probe'],
      {
        env: {
          GIT_AUTHOR_NAME: 'agflow',
          GIT_AUTHOR_EMAIL: 'agflow@agflow.invalid',
          GIT_COMMITTER_NAME: 'agflow',
          GIT_COMMITTER_EMAIL: 'agflow@agflow.invalid',
        },
      },
    );
    const sha = commit.stdout.trim();
    const pushed = await pushRefs({ ...git, updates: [{ ref, sha, expected: null }] });
    if (!pushed.ok) throw new Error(pushed.detail);
    await deleteProbe(git, ref, sha);
    if ((await lsRemote(git, [ref])).has(ref)) throw new Error(`${ref} still exists after the probe`);
    return `created and deleted ${ref} with exact leases`;
  });
}

/** Each failure is a result, so setup still sees every independent check, in a stable order. */
export async function runServiceChecks(input: ServiceChecksInput): Promise<CheckResult[]> {
  const http = new RunnerHubHttp({ credentials: input.credentials, fetch: input.fetch });
  const [hub, arrival] = await Promise.all([
    check('hub', async () => {
      try {
        const { user } = await http.whoami();
        return { status: 'pass', detail: `signed in as ${user}` };
      } catch (error) {
        const hub = input.hubUrl ?? '<url>';
        if (error instanceof RunnerHttpError && error.status === 401) {
          throw new Error(`the hub refused the CLI sign-in; run agflow login --hub ${hub}`);
        }
        if (error instanceof RunnerHttpError && error.code === 'signed_out') {
          throw new Error(`the CLI is not signed in to the runner's hub; run agflow login --hub ${hub}`);
        }
        throw error;
      }
    }),
    waitForWelcome(input).then(
      (welcome) => ({ welcome, error: null }),
      (error: unknown) => ({ welcome: null, error: describe(error) }),
    ),
  ]);
  if (arrival.error !== null) {
    hub.detail = hub.status === 'fail' ? `${hub.detail}; ${arrival.error}` : arrival.error;
    hub.status = 'fail';
  }
  let git: PushGit | null = null;
  const remote = await check('git ls-remote', async () => {
    const vault = input.runner.vault;
    await vault.ensure();
    git = { vault, local: vault.local, remote: await remoteGitEnv({ gitDir: vault.path }) };
    await runGit(git.remote, [`--git-dir=${vault.path}`, 'ls-remote', 'origin']);
    return { status: 'pass', detail: 'git ls-remote origin succeeded' };
  });
  const push = await check('wip push', async () => {
    if (arrival.welcome === null) throw new Error('skipped: no runner id or WIP prefix from the hub welcome');
    // Repeating an unreachable remote only delays the independent checks and gives the same diagnosis.
    if (remote.status === 'fail') throw new Error(remote.detail);
    return { status: 'pass', detail: await probe(git!, arrival.welcome) };
  });
  const results = [hub, remote, push];
  for (const adapter of input.adapters) {
    results.push(
      await check(adapter.vendor, async () => {
        const { facts } = await adapter.preflight();
        return facts.ready
          ? { status: 'pass', detail: `CLI ${facts.cliVersion ?? 'unknown'}; plan ${facts.plan ?? 'unknown'}` }
          : { status: 'fail', detail: facts.problem ?? 'preflight is not ready' };
      }),
    );
  }
  results.push(
    await check('dependency preparation', async () => {
      const checked = await checkPrepSandbox({ sandbox: input.sandbox });
      return checked.works
        ? { status: 'pass', detail: 'preparation sandbox works' }
        : { status: 'fail', detail: checked.reason ?? 'preparation sandbox failed' };
    }),
  );
  results.push(
    await check('sleep', async () => {
      let minutes: number | null = null;
      if (input.platform === 'darwin') {
        try {
          const settings = await input.exec(['pmset', '-g'], { timeoutMs: 5_000 });
          if (settings.exitCode === 0 && !settings.timedOut) {
            minutes = parsePmsetSettings(settings.stdout).sleepMinutes;
          }
        } catch {
          // Missing pmset and unreadable output are both an unknown timer, not a failed setup.
        }
      }
      if (minutes === null) return { status: 'warn', detail: 'the sleep timer could not be read' };
      if (minutes >= 1 && minutes <= 30) {
        return {
          status: 'warn',
          detail:
            `the Mac sleeps after ${minutes} minutes of idle and agents stop with it; ` +
            'use System Settings > Lock Screen / Battery or sudo pmset -c sleep 0',
        };
      }
      return {
        status: 'pass',
        detail: minutes === 0 ? 'idle sleep is disabled' : `idle sleep after ${minutes} minutes`,
      };
    }),
  );
  return results;
}

export function formatChecks(results: readonly CheckResult[]): string {
  const marks = { pass: 'ok', warn: 'warn', fail: 'FAIL' };
  const lines = results.map((result) => `${marks[result.status]} ${result.name}: ${describe(result.detail)}`);
  const failed = results.filter((result) => result.status === 'fail').length;
  const warnings = results.filter((result) => result.status === 'warn').length;
  const summary = [failed ? `${failed} failed` : '', warnings ? `${warnings} warnings` : ''].filter(Boolean);
  return [...lines, summary.join(', ') || 'all passed'].join('\n');
}

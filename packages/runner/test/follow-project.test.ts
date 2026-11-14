import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitIn, originRepo } from '@agflow/testkit';
import { projectKey } from '../src/paths';
import { waitFor } from './fixture';
import {
  afterThisTest,
  cleanupRunnerSetups,
  hellos,
  runCommand as run,
  SETUP_PROJECT as PROJECT,
  setupRunner as setup,
  setupSpec as specOf,
} from './runner-setup';

afterEach(cleanupRunnerSetups);

// Git and agent processes take several times as long on a machine loaded by other suites.
setDefaultTimeout(30_000);

describe('a project reset on the hub', () => {
  test("the runner stops the old project's attempts and opens the new project's vault, without a restart", async () => {
    const next = await originRepo({ 'SPEC.md': '# afisha\n' });
    afterThisTest(() => next.remove());
    const moved = { name: 'afisha', repo: next.path };
    // After the reset the hub is at a new epoch, names the new project and ends the attempt it no longer knows.
    const s = await setup({
      welcome: (_hello, connection) =>
        connection.index === 0
          ? {}
          : { hubEpoch: 2, project: moved, stop: [{ attemptId: 'T-4-a1', reason: 'the hub does not know this attempt' }] },
    });
    const write = { do: 'write', path: 'work.txt', content: 'old project work\n' } as const;
    const runner = await s.start({ script: { turns: [[write, { do: 'sleep', ms: 60_000 }]] } });
    await s.hub.waitFor(() => hellos(s.hub).length > 0);
    expect(await run(s.hub, { kind: 'start_attempt', attempt: specOf(s) })).toMatchObject({ ok: true });
    await waitFor(() => existsSync(join(s.paths.clone(projectKey(s.hub.url, PROJECT), 'T-4-a1'), 'work.txt')));

    // The reset closes the link; the runner says hello again, and again at the new epoch, as after a restore.
    (await s.hub.connection(0)).close(1001, 'the project was reset; say hello again');
    const exited = await s.hub.waitFor(() => s.hub.events().find((event) => event.type === 'attempt.exited'));
    expect(exited.attemptId).toBe('T-4-a1');
    expect(hellos(s.hub)).toHaveLength(3);
    // The old attempt's last work went to the old repository, through the vault it was made with.
    const late = await s.hub.waitFor(() => s.hub.events().find((event) => event.type === 'attempt.late_work'));
    const ref = (late.data as { ref: string }).ref;
    expect(await gitIn(s.origin.path, ['rev-parse', ref])).toBe((late.data as { sha: string }).sha);
    expect(await gitIn(next.path, ['for-each-ref', 'refs/agflow/'])).toBe('');

    // The new project's vault is open, the project is cached for the next start, and the runner never stopped.
    const key = projectKey(s.hub.url, 'afisha');
    expect(runner.vault.project).toBe(key);
    expect(await gitIn(s.paths.vault(key), ['config', 'remote.origin.url'])).toBe(next.path);
    expect(s.db.meta('project')).toEqual({ hubUrl: s.hub.url, ...moved });
    expect(runner.status().link).toBe('online');

    // A start of the new project fetches from its repository.
    const fresh = specOf(s, {
      attemptId: 'T-1004-e2-a1',
      taskId: 'T-1004',
      fence: { epoch: 2, counter: 1 },
      repo: { url: next.path, mainBranch: 'main' },
      branch: 'agflow/T-1004-e2-spec',
      wipRef: 'refs/agflow/T-1004/e2-a1',
    });
    expect(await run(s.hub, { kind: 'start_attempt', attempt: fresh })).toMatchObject({ ok: true });
    const clone = s.paths.clone(key, 'T-1004-e2-a1');
    await waitFor(() => existsSync(join(clone, 'SPEC.md')));
    expect(readFileSync(join(clone, 'SPEC.md'), 'utf8')).toBe('# afisha\n');
  });

  test("a welcome naming the runner's own project changes nothing", async () => {
    let repo = '';
    const s = await setup({ welcome: () => ({ project: { name: PROJECT, repo } }) });
    repo = s.origin.path;
    const runner = await s.start();
    await s.hub.waitFor(() => hellos(s.hub).length > 0);
    expect(await run(s.hub, { kind: 'preflight', vendor: 'claude' })).toMatchObject({ ok: true });
    expect(runner.vault.project).toBe(projectKey(s.hub.url, PROJECT));
    expect(s.logger.entries.some((entry) => entry.message.includes('another project'))).toBe(false);
  });
});

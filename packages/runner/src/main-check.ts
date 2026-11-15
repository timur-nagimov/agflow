// main's check (check_main, protocol 4). A submission's check runs on its branch with main merged in, but a merge into
// main is checked by nobody, so after each merge the hub asks one runner to check main at the sha agflow merged. The
// runner fetches main, makes a fresh clone detached at the sha, prepares the dependencies as a worker's start does, and
// runs the project's check there as a submission's check runs: .agflow/config.json is read at that sha, and the
// environment is a worker's with no vendor login. The clone goes afterwards. The executor runs one check at a time,
// apart from the runner's other commands, so a check never holds a merge back.
import { type MainCheckResult, restoreSet } from '@agflow/core';
import { removeTree } from './attempt/cleanup';
import { clip } from './attempt/pump';
import { checkOf, noCheck, prepFailedCheck } from './attempt/submit';
import type { RunnerConfig } from './config';
import { buildAgentEnv } from './env';
import { createDetachedClone } from './git/clone';
import type { GitEnvironment } from './git/run';
import type { Vault } from './git/vault';
import type { RunnerPaths } from './paths';
import { readPrepConfig } from './prep/config';
import type { DependencyPreparer, PrepareOutcome } from './seams';

/** The name of the check's clone and tools directory under the project, which no attempt id takes. */
export const MAIN_CHECK = 'main-check';

export interface MainCheckInput {
  /** The sha to check, in full: main as agflow merged it. */
  sha: string;
  vault: Vault;
  /** The local environment, localGitEnv(paths). */
  local: GitEnvironment;
  paths: RunnerPaths;
  preparer: DependencyPreparer;
  config: RunnerConfig;
  wipRefPrefix: string;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The check's environment: a Codex worker's, which never takes runner.env (where a runner with no browser keeps the
 * Claude login), without CODEX_HOME, where Codex keeps its own login, and without the bridge's AGFLOW_ variables.
 */
export function mainCheckEnv(input: Pick<MainCheckInput, 'vault' | 'paths' | 'config'> & { clone: string }) {
  const env = buildAgentEnv({
    vendor: 'codex',
    spec: { attemptId: MAIN_CHECK, role: 'worker', agentToken: '', hubUrl: '' },
    clone: input.clone,
    tools: input.paths.agentTools(input.vault.project, MAIN_CHECK),
    tmpDir: null,
    config: input.config,
    paths: input.paths,
  });
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => name !== 'CODEX_HOME' && !name.startsWith('AGFLOW_')),
  );
}

/** The output with a last line added, when there is one. */
function noted(output: string, note: string): string {
  return note === '' ? output : [output.trimEnd(), note].filter((part) => part !== '').join('\n');
}

/**
 * check_main: fetches main, then checks the sha in a fresh clone at paths.clone(project, MAIN_CHECK), made anew and
 * removed afterwards. The dependencies are prepared first, every entry of the config at the sha. A preparation that
 * fails fails the check, except under the open profile, where the check runs anyway and its output ends with a note of
 * the failure, as at a submission. A check that cannot run (no command, a config that does not read, a runner with no
 * sandbox, a failure to start it) is none, with why in its tail. Throws when the vault cannot get the sha.
 */
export async function checkMain(input: MainCheckInput): Promise<MainCheckResult> {
  const { sha, vault, preparer, config } = input;
  const main = vault.mainBranch;
  await vault.fetchForAttempt({ taskId: null, start: { ref: `refs/heads/${main}`, sha } }, input.wipRefPrefix);
  if (!(await vault.hasCommit(sha))) throw new Error(`${sha} is neither on the origin's ${main} nor in the vault`);
  let command: string | undefined;
  try {
    command = (await readPrepConfig(vault, sha))?.check;
  } catch (error) {
    return { sha, check: noCheck(null, describe(error)) };
  }
  if (command === undefined) return { sha, check: noCheck(null, '') };
  if (!preparer.available || preparer.check === undefined || preparer.prepareFresh === undefined) {
    return { sha, check: noCheck(command, 'this runner cannot run it: it has no sandbox for preparation commands') };
  }
  const clone = input.paths.clone(vault.project, MAIN_CHECK);
  // A runner that stopped during a check left its clone: the check runs in a fresh one.
  await removeTree(clone);
  try {
    await createDetachedClone({ vault, local: input.local, clone, sha });
    const env = mainCheckEnv({ ...input, clone });
    let prep: Omit<PrepareOutcome, 'ran'>;
    try {
      prep = await preparer.prepareFresh({ clone, vault, baseSha: sha, env, restore: restoreSet(null) });
    } catch (error) {
      prep = { ok: false, error: describe(error), logTail: null };
    }
    if (!prep.ok && config.profile !== 'open') return { sha, check: prepFailedCheck(command, prep) };
    const why = clip((prep.error ?? 'the preparation failed').replace(/\s+/g, ' ').trim(), 300);
    const note = prep.ok ? '' : `The dependencies could not be prepared (${why}). The check ran anyway.`;
    const timeoutMs = Math.max(1, Math.round(config.checkMinutes * 60_000));
    try {
      const ran = await preparer.check({ clone, vault, command, env, timeoutMs });
      return { sha, check: checkOf(command, { ...ran, logTail: noted(ran.logTail, note) }) };
    } catch (error) {
      return { sha, check: noCheck(command, noted(`the runner could not run it: ${describe(error)}`, note)) };
    }
  } finally {
    await removeTree(clone);
  }
}

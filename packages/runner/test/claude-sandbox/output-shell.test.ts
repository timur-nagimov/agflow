// Oversized output, other sessions' transcripts and the shell profile with the real claude (design 15, 7.6, 8.2, 5),
// gated by AGFLOW_SANDBOX_CHECKS=1 (X-20), macOS only. Claude Code saves an oversized Bash output in the attempt's
// project directory and tells the model to read it there: 7.6's Read rules name only the runner's sensitive files, and
// the sandbox re-allows that one directory, so both the Read tool and a sandboxed cat must reach it, in both profiles.
// Other sessions' transcripts and the shell snapshot stay out of the sandbox's reach. The shell checks use marker
// profiles in the scratch HOME, never the owner's.
import { afterAll, afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type AnthropicToolResult, bashTool, toolUse } from '@agflow/testkit/src/anthropic';
import { CLAUDE_SHELL } from '../../src/adapters/claude/options';
import { claudeProjectDir } from '../../src/adapters/claude/paths';
import { type ClaudeSmoke, cleanupClaudeSmokes, smokeDescribe, startClaudeSmoke } from '../claude-real/harness';
import {
  CheckTable,
  mismatches,
  otherTranscript,
  PROFILES,
  type ProfileName,
  runAgentSteps,
  sandboxGate,
  startProfileSmoke,
} from './checks';

// A cold start of the CLI, its sandbox, the bridge and the brief hook, on a machine other suites may load.
setDefaultTimeout(300_000);

const table = new CheckTable('Sandbox checks: oversized output, other transcripts and the shell profile');

afterEach(cleanupClaudeSmokes);
afterAll(() => table.print());

const gate = sandboxGate();

const profileSmoke = (profile: ProfileName) => startProfileSmoke(profile, table, { bin: gate.bin ?? undefined });

/** Output this long is saved beside the transcript instead of kept in it. */
const OVERSIZED = 'yes a | head -c 120000';
const SAVED = /Full output saved to: (\S+)/;

/** A sandboxed read that the sandbox refused, as cat reports it. */
const DENIED = 'Operation not permitted';

/** The Bash command that says whether a shell function is defined in agent commands. */
function functionCheck(name: string): string {
  return `type ${name} >/dev/null 2>&1 && echo function-defined || echo function-undefined`;
}

/** refused when the sandbox denied the read, read when the text came back, the result otherwise. */
function sandboxedRead(result: AnthropicToolResult | undefined, expectedText: string): string {
  if (result === undefined) return 'no result';
  if (result.text.includes(expectedText)) return 'read';
  return result.text.includes(DENIED) ? 'refused' : `failed: ${result.text.slice(0, 200)}`;
}

/**
 * A marker profile: outside the sandbox each run appends a line to the runs file; inside, where the write is refused,
 * it stays quiet. It defines the marker function, and puts the given directory first in PATH.
 */
function markerProfile(runs: string, marker: string, pathEntry?: string): string {
  const path = pathEntry === undefined ? '' : `export PATH='${pathEntry}':"$PATH"\n`;
  return `{ echo "$$" >> '${runs}'; } 2>/dev/null\n${marker}() { echo marker; }\n${path}`;
}

function runCount(runs: string): number {
  return existsSync(runs) ? readFileSync(runs, 'utf8').split('\n').filter((line) => line !== '').length : 0;
}

/** A row's text for a number of profile runs. */
function runsText(count: number, processes: number, commands: number): string {
  return `${count} runs for ${processes} Claude processes and ${commands} Bash commands`;
}

// The shell profile (design 5, 8.2). Left to itself, 2.1.285 does more than source ~/.zshrc or ~/.bashrc once per
// process for its snapshot: it runs `<shell> -c env` once per process, the snapshot's shell is a login shell, and every
// sandboxed command starts in a `<shell> -c` wrapper outside the sandbox, in the command's directory and with the
// agent's environment. zsh read ~/.zshenv in each of these and in the agent's own shell inside the sandbox, so its
// functions, variables and PATH reached agent commands, and the login shell read ~/.zprofile and ~/.zlogin; bash read
// ~/.bashrc in each, its standard input being a socket. The adapter therefore runs the CLI's shells as zsh with ZDOTDIR
// its empty directory (options.ts, claudeEmptyDir): zsh reads none of the owner's startup files, only the snapshot
// sources ~/.zshrc, by its path, and ~/.bashrc never runs. The row names keep what 2.1.285 did without that; a check
// that finds otherwise has met a CLI that changed it.

const SESSIONS = 2;

interface ProfileSessions {
  /** Per process, the function checks' outputs, in the order of the names. */
  checks: string[][];
  /** Per process, the PATH agent commands saw. */
  paths: string[];
  /** Per process, the SHELL agent commands saw. */
  shells: string[];
  processes: number;
  commands: number;
}

/**
 * Starts SESSIONS Claude processes, one after another, each running a function check per name and printing PATH and
 * SHELL.
 */
async function runProfileSessions(smoke: ClaudeSmoke, functions: string[]): Promise<ProfileSessions> {
  const steps = [
    ...functions.map((name) => bashTool({ command: functionCheck(name) })),
    bashTool({ command: 'printenv PATH' }),
    bashTool({ command: 'printenv SHELL' }),
  ];
  const checks: string[][] = [];
  const paths: string[] = [];
  const shells: string[] = [];
  for (let session = 0; session < SESSIONS; session++) {
    const { results } = await runAgentSteps(smoke, steps);
    checks.push(results.slice(0, functions.length).map((result) => result.text.trim()));
    paths.push(results[functions.length]?.text.trim() ?? '');
    shells.push(results[functions.length + 1]?.text.trim() ?? '');
  }
  return { checks, paths, shells, processes: SESSIONS, commands: SESSIONS * steps.length };
}

/** Where a profile's directory stands in the PATH agent commands saw. */
function pathPlace(path: string, entry: string): string {
  const entries = path.split(':');
  if (!entries.includes(entry)) return 'absent';
  return entries[0] === entry ? 'first' : 'present';
}

smokeDescribe(gate, 'sandbox checks: oversized output, other transcripts and the shell profile', () => {
  for (const profile of PROFILES) {
    test(`in ${profile}, a saved oversized Bash output can be read with Read and with a sandboxed cat`, async () => {
      const { smoke, permissionMode, skipped } = await profileSmoke(profile);
      if (skipped) return;
      let saved = '';
      const { results, events } = await runAgentSteps(smoke, [
        bashTool({ command: OVERSIZED }),
        (previous) => {
          saved = previous?.text.match(SAVED)?.[1] ?? '';
          return toolUse('Read', { file_path: saved, limit: 3 });
        },
        () => bashTool({ command: `head -c 20 '${saved}'` }),
      ]);
      expect(events.find((event) => event.type === 'started')).toMatchObject({ permissionMode });
      const [, read, cat] = results;
      const readOk = read !== undefined && !read.isError && read.text.includes('1\ta');
      const project = claudeProjectDir(smoke.claudeHome, smoke.clone);
      const rows = table.add(
        {
          check: `${profile}: where the oversized output is saved`,
          expected: "the attempt's project directory",
          observed: saved.startsWith(`${project}/`) ? "the attempt's project directory" : saved || 'not saved',
        },
        {
          check: `${profile}: Read of the saved output`,
          expected: 'read',
          observed: readOk ? 'read' : `failed: ${read?.text.slice(0, 200)}`,
        },
        {
          check: `${profile}: sandboxed cat of the saved output`,
          expected: 'read',
          observed: sandboxedRead(cat, 'a\na'),
        },
      );
      // 7.6's read rules already deny the runner's files one by one (section 15's fallback), so a failure here is not
      // fixed by loosening the sandbox: it goes back for a decision.
      expect(mismatches(rows), 'the saved output is unreadable under 7.6: stop for a decision').toEqual([]);
      expect(smoke.isolationProblems()).toEqual([]);
    });
  }

  test("a sandboxed cat of another session's transcript under the Claude home fails", async () => {
    const smoke = await startClaudeSmoke({ bin: gate.bin ?? undefined });
    const { path, secret } = otherTranscript(smoke);
    const { results } = await runAgentSteps(smoke, [bashTool({ command: `cat '${path}'` })]);
    const rows = table.add({
      check: "sandboxed cat of another session's transcript",
      expected: 'refused',
      observed: sandboxedRead(results[0], secret),
    });
    expect(mismatches(rows)).toEqual([]);
    expect(results[0]?.text).not.toContain(secret);
    expect(smoke.isolationProblems()).toEqual([]);
  });

  test('the shell snapshot lies under the Claude home, and a sandboxed read of it fails', async () => {
    const smoke = await startClaudeSmoke({ bin: gate.bin ?? undefined });
    const snapshots = join(smoke.claudeHome, 'shell-snapshots');
    let snapshot = '';
    const { results } = await runAgentSteps(smoke, [
      bashTool({ command: 'pwd' }),
      // The CLI removes its snapshot when it exits, so it is looked for while the session runs.
      () => {
        const [name] = existsSync(snapshots) ? readdirSync(snapshots) : [];
        snapshot = name === undefined ? '' : join(snapshots, name);
        return bashTool({ command: `head -c 200 '${snapshot}'` });
      },
    ]);
    const rows = table.add(
      {
        check: 'where the shell snapshot lies',
        expected: "the runner's Claude home",
        observed: snapshot === '' ? 'no snapshot' : "the runner's Claude home",
      },
      { check: 'sandboxed read of the shell snapshot', expected: 'refused', observed: sandboxedRead(results[1], '#') },
    );
    expect(mismatches(rows)).toEqual([]);
    expect(smoke.isolationProblems()).toEqual([]);
  });

  test('a marker ~/.zshrc runs once per Claude process, ~/.zshenv never; neither is in agent commands', async () => {
    const smoke = await startClaudeSmoke({ bin: gate.bin ?? undefined, shell: '/bin/zsh' });
    const zshrcRuns = join(smoke.root, 'zshrc-runs');
    const zshenvRuns = join(smoke.root, 'zshenv-runs');
    const loginRuns = join(smoke.root, 'login-runs');
    writeFileSync(join(smoke.home, '.zshrc'), markerProfile(zshrcRuns, 'agflow_zshrc_marker'));
    const zshenvBin = join(smoke.root, 'zshenv-bin');
    writeFileSync(join(smoke.home, '.zshenv'), markerProfile(zshenvRuns, 'agflow_zshenv_marker', zshenvBin));
    for (const file of ['.zprofile', '.zlogin']) {
      writeFileSync(join(smoke.home, file), markerProfile(loginRuns, 'agflow_login_marker'));
    }
    const sessions = await runProfileSessions(smoke, ['agflow_zshrc_marker', 'agflow_zshenv_marker']);
    const { processes, commands } = sessions;
    const rows = table.add(
      {
        check: '~/.zshrc runs outside the sandbox (the snapshot sources it by its path)',
        expected: runsText(processes, processes, commands),
        observed: runsText(runCount(zshrcRuns), processes, commands),
      },
      {
        check: '~/.zshenv runs outside the sandbox (2.1.285 without the empty ZDOTDIR: 2 per process, 1 per command)',
        expected: runsText(0, processes, commands),
        observed: runsText(runCount(zshenvRuns), processes, commands),
      },
      {
        check:
          '~/.zprofile and ~/.zlogin run outside the sandbox (2.1.285 without the empty ZDOTDIR: 1 each per process)',
        expected: runsText(0, processes, commands),
        observed: runsText(runCount(loginRuns), processes, commands),
      },
      ...sessions.checks.flatMap(([zshrc, zshenv], index) => [
        {
          check: `~/.zshrc's function in agent commands (process ${index + 1})`,
          expected: 'function-undefined',
          observed: zshrc ?? 'no result',
        },
        {
          // Inside the sandbox too, zsh read ~/.zshenv.
          check: `~/.zshenv's function in agent commands (process ${index + 1}; without the empty ZDOTDIR: defined)`,
          expected: 'function-undefined',
          observed: zshenv ?? 'no result',
        },
        {
          check: `~/.zshenv's PATH entry in agent commands (process ${index + 1}; without the empty ZDOTDIR: first)`,
          expected: 'absent',
          observed: pathPlace(sessions.paths[index] ?? '', zshenvBin),
        },
      ]),
    );
    expect(mismatches(rows)).toEqual([]);
    expect(smoke.isolationProblems()).toEqual([]);
  });

  test('with SHELL=/bin/bash the CLI runs zsh: a marker ~/.bashrc never runs, ~/.zshrc once per process', async () => {
    const smoke = await startClaudeSmoke({ bin: gate.bin ?? undefined, shell: '/bin/bash' });
    const bashrcRuns = join(smoke.root, 'bashrc-runs');
    const zshrcRuns = join(smoke.root, 'zshrc-runs');
    writeFileSync(join(smoke.home, '.bashrc'), markerProfile(bashrcRuns, 'agflow_bashrc_marker'));
    writeFileSync(join(smoke.home, '.zshrc'), markerProfile(zshrcRuns, 'agflow_zshrc_marker'));
    const sessions = await runProfileSessions(smoke, ['agflow_bashrc_marker']);
    const { processes, commands } = sessions;
    const rows = table.add(
      {
        // design 5 had it once per process, for the snapshot.
        check: '~/.bashrc runs outside the sandbox (2.1.285 with bash as its shell: 2 per process, 1 per command)',
        expected: runsText(0, processes, commands),
        observed: runsText(runCount(bashrcRuns), processes, commands),
      },
      {
        check: "~/.zshrc runs outside the sandbox (the snapshot's, with zsh as the CLI's shell)",
        expected: runsText(processes, processes, commands),
        observed: runsText(runCount(zshrcRuns), processes, commands),
      },
      ...sessions.checks.flatMap(([bashrc], index) => [
        {
          check: `~/.bashrc's function in agent commands (process ${index + 1})`,
          expected: 'function-undefined',
          observed: bashrc ?? 'no result',
        },
        {
          check: `the SHELL of agent commands (process ${index + 1}; without CLAUDE_CODE_SHELL: /bin/bash)`,
          expected: CLAUDE_SHELL,
          observed: sessions.shells[index] ?? 'no result',
        },
      ]),
    );
    expect(mismatches(rows)).toEqual([]);
    expect(smoke.isolationProblems()).toEqual([]);
  });
});

// The in-process tools with the real claude, in both profiles (design 5, 7.6, 8.2, 15; X-29), gated by
// AGFLOW_SANDBOX_CHECKS=1 (X-20), macOS only. Edit, Write and Read run in the CLI's own process, outside the sandbox,
// so the deny rules and the guard are what confine them: the model calls them on the base checkout, the agent's shell
// profile, the Claude home's empty directory (zsh's ZDOTDIR outside the sandbox), a file outside the clone that no rule
// names, the clone's .git/config and another session's transcript, and on the clone, where ordinary work must succeed.
// The auto profile runs only where the scripted server's account offers auto mode.
import { afterAll, afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type AnthropicToolResult, bashTool, toolUse } from '@agflow/testkit/src/anthropic';
import { claudeEmptyDir } from '../../src/adapters/claude/options';
import { type ClaudeSmoke, cleanupClaudeSmokes, smokeDescribe } from '../claude-real/harness';
import {
  type CheckRow,
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

const table = new CheckTable('Sandbox checks: the in-process tools');

afterEach(cleanupClaudeSmokes);
afterAll(() => table.print());

const gate = sandboxGate();

const PROFILE_TEXT = '# The agent profile; the tools must leave it alone.\n';

const OUTSIDE_TEXT = 'Outside the clone; the tools must leave it alone.\n';

/** The guard's refusal of an Edit or Write that only it confines. */
const OUTSIDE_REFUSAL = 'outside the clone and its temporary directory is refused';

type Outcome = 'done' | 'refused' | 'failed';

/**
 * What a call came to, as the model saw it. A refusal names the permission settings or the guard; any other error
 * (an Edit of a file never read, say) is a failure, which no check expects.
 */
function outcome(result: AnthropicToolResult): Outcome {
  if (!result.isError) return 'done';
  return /denied|refused/i.test(result.text) ? 'refused' : 'failed';
}

const read = (path: string) => toolUse('Read', { file_path: path });
const edit = (path: string, from: string, to: string) =>
  toolUse('Edit', { file_path: path, old_string: from, new_string: to });
const write = (path: string, content: string) => toolUse('Write', { file_path: path, content });

/** A row of one call: the expected outcome, and the result's text when the call came to something else. */
function callRow(check: string, expected: Outcome, result: AnthropicToolResult | undefined): CheckRow {
  const observed = result === undefined ? 'no result' : outcome(result);
  return { check, expected, observed: observed === expected ? observed : `${observed}: ${result?.text.slice(0, 200)}` };
}

const profileSmoke = (profile: ProfileName) => startProfileSmoke(profile, table, { bin: gate.bin ?? undefined });

/** git in the clone, with no git configuration but the clone's own; its output. */
function cloneGit(smoke: ClaudeSmoke, args: string[]): string {
  const env = { PATH: process.env.PATH, HOME: smoke.home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  return Bun.spawnSync(['git', '-C', smoke.clone, ...args], { env }).stdout.toString();
}

smokeDescribe(gate, 'sandbox checks: the in-process tools', () => {
  for (const profile of PROFILES) {
    test(`in ${profile}, Edit and Write outside the clone are refused and leave their targets`, async () => {
      const { smoke, permissionMode, skipped } = await profileSmoke(profile);
      if (skipped) return;
      const zshrc = join(smoke.home, '.zshrc');
      writeFileSync(zshrc, PROFILE_TEXT);
      // No deny rule names the scratch root, so only the guard refuses these. Standard refuses the Read there, and an
      // Edit of a file never read fails before any hook, so only auto's Edit reaches the guard; the Write of a new
      // file reaches it in both.
      const outside = join(smoke.root, 'outside.txt');
      writeFileSync(outside, OUTSIDE_TEXT);
      const createdOutside = join(smoke.root, 'created-outside.txt');
      // zsh reads a .zshenv there in every shell the CLI runs outside the sandbox, so only the rules may stand between.
      const emptyZshenv = join(claudeEmptyDir(smoke.claudeHome), '.zshenv');
      const readme = join(smoke.baseCheckout, 'README.md');
      const before = readFileSync(readme, 'utf8');
      const created = join(smoke.baseCheckout, 'agflow-tool-check.md');
      // Each target is read first (standard's acceptEdits denies a Read outside the clone, auto allows it), so an Edit
      // or Write that fails does so on its path, not as unread.
      const { results, events } = await runAgentSteps(smoke, [
        read(readme),
        edit(readme, '# Smoke project', '# Edited by the agent'),
        write(readme, 'Overwritten by the agent.\n'),
        write(created, 'Made by the agent.\n'),
        read(zshrc),
        edit(zshrc, '# The agent profile', 'alias ls=rm'),
        write(zshrc, 'alias ls=rm\n'),
        write(createdOutside, 'Made by the agent.\n'),
        write(emptyZshenv, 'alias ls=rm\n'),
        ...(profile === 'auto' ? [read(outside), edit(outside, 'Outside the clone', 'Edited by the agent')] : []),
      ]);
      expect(events.find((event) => event.type === 'started')).toMatchObject({ permissionMode });
      const [, editBase, writeBase, createBase, , editProfile, writeProfile, createOutside, writeEmpty, , editOutside] =
        results;
      const unchanged =
        readFileSync(readme, 'utf8') === before &&
        !existsSync(created) &&
        readFileSync(zshrc, 'utf8') === PROFILE_TEXT &&
        readFileSync(outside, 'utf8') === OUTSIDE_TEXT &&
        !existsSync(createdOutside) &&
        !existsSync(emptyZshenv);
      const rows = table.add(
        callRow(`${profile}: Edit of the base checkout's README.md`, 'refused', editBase),
        callRow(`${profile}: Write of the base checkout's README.md`, 'refused', writeBase),
        callRow(`${profile}: Write of a new file in the base checkout`, 'refused', createBase),
        callRow(`${profile}: Edit of ~/.zshrc`, 'refused', editProfile),
        callRow(`${profile}: Write of ~/.zshrc`, 'refused', writeProfile),
        callRow(`${profile}: Write of a new file outside the clone`, 'refused', createOutside),
        callRow(`${profile}: Write of .zshenv in the Claude home's empty directory (ZDOTDIR)`, 'refused', writeEmpty),
        ...(profile === 'auto' ? [callRow('auto: Edit of a file outside the clone', 'refused', editOutside)] : []),
        {
          check: `${profile}: the base checkout, ~/.zshrc, the empty directory and the files outside afterwards`,
          expected: 'unchanged',
          observed: unchanged ? 'unchanged' : 'changed',
        },
      );
      expect(mismatches(rows)).toEqual([]);
      // The guard's own reason: in auto, nothing else would refuse these.
      expect(createOutside?.text).toContain(OUTSIDE_REFUSAL);
      if (profile === 'auto') expect(editOutside?.text).toContain(OUTSIDE_REFUSAL);
      expect(smoke.isolationProblems()).toEqual([]);
    });

    test(`in ${profile}, Read, Edit and Write of a clone file, a Bash write and a git commit succeed`, async () => {
      const { smoke, permissionMode, skipped } = await profileSmoke(profile);
      if (skipped) return;
      const app = join(smoke.clone, 'src', 'app.ts');
      const added = join(smoke.clone, 'src', 'added.ts');
      const subject = `Tool check commit in ${profile}`;
      const commitCommand = `git add -A && git commit -q -m '${subject}' && git log -1 --format=%s`;
      const { results, events } = await runAgentSteps(smoke, [
        read(app),
        edit(app, 'export const app = 1;', 'export const app = 2;'),
        write(added, 'export const added = true;\n'),
        // With the agent git environment the runner built: its identity, and no credentials.
        bashTool({ command: `printf 'written by Bash\\n' > notes.txt && ${commitCommand}` }),
      ]);
      expect(events.find((event) => event.type === 'started')).toMatchObject({ permissionMode });
      const [readApp, editApp, writeAdded, commit] = results;
      const committed = cloneGit(smoke, ['log', '-1', '--format=%an <%ae>%n%s']);
      const identity = smoke.config.commitIdentity;
      const everything =
        committed === `${identity.name} <${identity.email}>\n${subject}\n` &&
        readFileSync(app, 'utf8') === 'export const app = 2;\n' &&
        readFileSync(added, 'utf8') === 'export const added = true;\n' &&
        readFileSync(join(smoke.clone, 'notes.txt'), 'utf8') === 'written by Bash\n' &&
        cloneGit(smoke, ['status', '--porcelain']).trim() === '';
      const rows = table.add(
        callRow(`${profile}: Read of a clone file`, 'done', readApp),
        callRow(`${profile}: Edit of a clone file`, 'done', editApp),
        callRow(`${profile}: Write of a new clone file`, 'done', writeAdded),
        callRow(`${profile}: a Bash write and a git commit in the clone`, 'done', commit),
        {
          check: `${profile}: the commit, by the agent identity, holds every change`,
          expected: 'committed',
          observed: everything ? 'committed' : `not committed: ${committed.trim()}`,
        },
      );
      expect(readApp?.text).toContain('export const app = 1;');
      expect(commit?.text).toContain(subject);
      expect(mismatches(rows)).toEqual([]);
      expect(smoke.isolationProblems()).toEqual([]);
    });

    test(`in ${profile}, the guard refuses an Edit of .git/config and a Read of another transcript`, async () => {
      const { smoke, permissionMode, skipped } = await profileSmoke(profile);
      if (skipped) return;
      const gitConfig = join(smoke.clone, '.git', 'config');
      const before = readFileSync(gitConfig, 'utf8');
      const transcript = otherTranscript(smoke);
      const { results, events } = await runAgentSteps(smoke, [
        read(gitConfig),
        edit(gitConfig, '[core]', '[core]\n\thooksPath = /tmp'),
        read(transcript.path),
      ]);
      expect(events.find((event) => event.type === 'started')).toMatchObject({ permissionMode });
      const [, editConfig, readTranscript] = results;
      const rows = table.add(
        callRow(`${profile}: Edit of the clone's .git/config`, 'refused', editConfig),
        callRow(`${profile}: Read of another session's transcript`, 'refused', readTranscript),
      );
      expect(mismatches(rows)).toEqual([]);
      // The guard's own reasons: the rules alone would not refuse either.
      expect(editConfig?.text).toContain('on .git/config or under .git/hooks is refused');
      expect(readTranscript?.text).toContain("another session's Claude project directory");
      expect(readTranscript?.text).not.toContain(transcript.secret);
      expect(readFileSync(gitConfig, 'utf8')).toBe(before);
      expect(smoke.isolationProblems()).toEqual([]);
    });
  }
});

// Boundary 2 for sandboxed commands with the real claude (design 5, 7.6, 15, 8.1; X-29), gated by
// AGFLOW_SANDBOX_CHECKS=1 (X-20), macOS only. The model runs the write probe from the clone through a real sandboxed
// Bash call; the same probe runs outside first, so a refusal inside counts only where the test process can write.
// The Claude home's empty directory is among the refused targets: zsh reads its startup files there outside the sandbox
// (ZDOTDIR), and the bridge and the brief hook start in it (options.ts, claudeEmptyDir).
// What the sandbox does with /tmp/claude is what TMP_CLAUDE_DENYWRITE_ENFORCED records for the pin, and preflight's
// weakened list follows the constant.
import { afterAll, afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, rmdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ensureClaudeEmptyDir } from '../../src/adapters/claude/options';
import { CLAUDE_CLI_VERSION, TMP_CLAUDE_DENYWRITE_ENFORCED } from '../../src/adapters/claude/pin';
import { makeAttemptTmpDir } from '../../src/paths';
import { type ClaudeSmoke, cleanupClaudeSmokes, smokeDescribe, startClaudeSmoke } from '../claude-real/harness';
import {
  type CheckRow,
  CheckTable,
  mismatches,
  outsideEnv,
  type ProbeResults,
  probeCommand,
  runAsAgent,
  runOutside,
  sandboxGate,
} from './checks';

// A cold start of the CLI, its sandbox, the bridge and the brief hook, on a machine other suites may load.
setDefaultTimeout(300_000);

const table = new CheckTable(`Sandbox checks: writes (claude ${CLAUDE_CLI_VERSION})`);
const cleanups = new Set<() => void>();

afterEach(async () => {
  for (const cleanup of [...cleanups]) cleanup();
  cleanups.clear();
  await cleanupClaudeSmokes();
});
afterAll(() => table.print());

const gate = sandboxGate();

/** The shared directories the sandbox runtime lets every command write unless they are denied by name (7.6). */
const SHARED_TMP = ['/tmp/claude', '/private/tmp/claude'];

type Expected = 'written' | 'refused';

interface WriteProbe {
  outside: ProbeResults;
  inside: ProbeResults;
  /** One row per target: refused or written inside, skipped where the test process cannot write either. */
  rows: CheckRow[];
}

/**
 * Runs the write probe outside and then as the agent, for each target, and removes every file either run wrote. A
 * shared directory the outside run had to make goes again too.
 */
async function probeWrites(
  smoke: ClaudeSmoke,
  targets: [label: string, directory: string, expected: Expected][],
): Promise<WriteProbe> {
  for (const path of SHARED_TMP.filter((path) => !existsSync(path))) {
    cleanups.add(() => {
      if (existsSync(path) && readdirSync(path).length === 0) rmdirSync(path);
    });
  }
  const args = targets.flatMap(([label, directory]) => [label, directory]);
  const outside = await runOutside('writes.sh', args, outsideEnv(smoke));
  let inside: ProbeResults = new Map();
  try {
    inside = await runAsAgent(smoke, [probeCommand('writes.sh', args)]);
  } finally {
    for (const results of [outside, inside]) {
      for (const { result, detail } of results.values()) if (result === 'written') rmSync(detail, { force: true });
    }
  }
  const rows = targets.map(([label, , expected]): CheckRow => {
    const before = outside.get(label);
    return {
      check: `sandboxed write to ${label}`,
      expected,
      observed: inside.get(label)?.result ?? 'no answer',
      skipped: before?.result === 'written' ? null : `not writable outside either: ${before?.detail ?? 'no answer'}`,
    };
  });
  return { outside, inside, rows };
}

smokeDescribe(gate, 'sandbox checks: writes', () => {
  test(
    "writes fail in HOME, the base checkout, the Claude home's empty directory and another attempt's tmpDir, " +
      'and work in the clone and its own tmpDir',
    async () => {
      const smoke = await startClaudeSmoke({ bin: gate.bin ?? undefined });
      const other = makeAttemptTmpDir();
      cleanups.add(() => rmSync(other, { recursive: true, force: true }));
      // The runner makes it before every launch; the outside run comes before the first.
      const empty = ensureClaudeEmptyDir(smoke.claudeHome);
      const { rows } = await probeWrites(smoke, [
        ['HOME', smoke.home, 'refused'],
        ['the base checkout', smoke.baseCheckout, 'refused'],
        ["the Claude home's empty directory (ZDOTDIR, the bridge's and hook's cwd)", empty, 'refused'],
        [`another attempt's ${other}`, other, 'refused'],
        ['the clone', smoke.clone, 'written'],
        [`the attempt's own ${smoke.tmpDir}`, smoke.tmpDir, 'written'],
      ]);
      expect(mismatches(table.add(...rows))).toEqual([]);
      expect(rows.filter((row) => row.skipped)).toEqual([]);
      expect(smoke.isolationProblems()).toEqual([]);
    },
  );

  test("the commands' TMPDIR is under the attempt's /tmp/agf/<id>/, and mktemp works there", async () => {
    const smoke = await startClaudeSmoke({ bin: gate.bin ?? undefined });
    const { inside } = await probeWrites(smoke, []);
    const under = (path: string | undefined) => path?.startsWith(`${smoke.tmpDir}/`) ?? false;
    const expected = `under ${smoke.tmpDir}/`;
    const value = inside.get('TMPDIR')?.detail;
    const temporary = inside.get('mktemp');
    const made = temporary?.result === 'written' && under(temporary.detail);
    const rows = table.add(
      { check: "the commands' TMPDIR", expected, observed: under(value) ? expected : (value ?? 'no answer') },
      {
        check: 'a sandboxed mktemp',
        expected: `written ${expected}`,
        observed: made ? `written ${expected}` : `${temporary?.result ?? 'no answer'} ${temporary?.detail ?? ''}`,
      },
    );
    expect(mismatches(rows)).toEqual([]);
    expect(smoke.isolationProblems()).toEqual([]);
  });

  test('writes to ~/.npm/_logs are refused, and /tmp/claude does what TMP_CLAUDE_DENYWRITE_ENFORCED says', async () => {
    const smoke = await startClaudeSmoke({ bin: gate.bin ?? undefined });
    // npm made its log directory already, as it has in the owner's home.
    const npmLogs = join(smoke.home, '.npm', '_logs');
    mkdirSync(npmLogs, { recursive: true });
    const shared: Expected = TMP_CLAUDE_DENYWRITE_ENFORCED ? 'refused' : 'written';
    const { rows } = await probeWrites(smoke, [
      ['~/.npm/_logs', npmLogs, 'refused'],
      ...SHARED_TMP.map((path): [string, string, Expected] => [path, path, shared]),
    ]);
    const { weakened } = await smoke.adapter.preflight();
    const listed = TMP_CLAUDE_DENYWRITE_ENFORCED ? 'not listed' : 'listed';
    rows.push({
      check: "preflight's weakened list names '/tmp/claude'",
      expected: listed,
      observed: weakened.includes('/tmp/claude') ? 'listed' : 'not listed',
    });
    const wrong = mismatches(table.add(...rows));
    expect(
      rows.filter((row) => row.skipped),
      'the shared directories could not be checked from this account, so TMP_CLAUDE_DENYWRITE_ENFORCED is not settled',
    ).toEqual([]);
    const hint = wrong.some((row) => SHARED_TMP.some((path) => row.check.endsWith(path)))
      ? `the sandbox of claude ${CLAUDE_CLI_VERSION} does not do what TMP_CLAUDE_DENYWRITE_ENFORCED ` +
        `(${TMP_CLAUDE_DENYWRITE_ENFORCED}) records: set it to what the sandbox did, so that preflight lists ` +
        `'/tmp/claude' right`
      : 'a sandboxed write went where it should not';
    expect(wrong, hint).toEqual([]);
    expect(smoke.isolationProblems()).toEqual([]);
  });
});

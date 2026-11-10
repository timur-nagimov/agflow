// Bun package scripts and sibling-clone read confinement through real sandboxed Bash calls.
// This regression belongs to Task 29: runAgentSteps is introduced there.
// AGFLOW_SANDBOX_CHECKS=1 and AGFLOW_SMOKE=1 enable the isolated scripted-server harness.
import { afterAll, afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { bashTool } from '@agflow/testkit/src/anthropic';
import { CLAUDE_CLI_VERSION } from '../../src/adapters/claude/pin';
import { cleanupClaudeSmokes, smokeDescribe, startClaudeSmoke } from '../claude-real/harness';
import { CheckTable, runAgentSteps, sandboxGate } from './checks';

// A cold start of the CLI, its sandbox, the bridge and the brief hook, on a machine other suites may load.
setDefaultTimeout(300_000);

const table = new CheckTable(`Sandbox checks: Bun and sibling clones (claude ${CLAUDE_CLI_VERSION})`);

afterEach(cleanupClaudeSmokes);
afterAll(() => table.print());

const gate = sandboxGate();

smokeDescribe(gate, 'sandbox checks: Bun and sibling clones', () => {
  // the runner supports darwin-arm64 only; design 7.1
  test.skipIf(process.platform !== 'darwin')('bun run works while scripts cannot read other attempts in either project', async () => {
    const smoke = await startClaudeSmoke({
      bin: gate.bin ?? undefined,
      files: { 'package.json': JSON.stringify({ scripts: { probe: 'echo BUN_RUN_OK' } }) },
    });
    const targets = [
      join(dirname(smoke.clone), 'other-attempt', 'secret.txt'),
      join(smoke.paths.work, 'other-project', 'other-attempt', 'secret.txt'),
    ];
    const secret = `other-clone-${crypto.randomUUID()}`;
    for (const target of targets) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, secret);
    }
    writeFileSync(join(smoke.clone, 'read-clones.sh'), [
      'printf "READ_PROBE_STARTED\\n"',
      'cat "$1"',
      'printf "SIBLING_STATUS=%s\\n" "$?"',
      'cat "$2"',
      'printf "OTHER_PROJECT_STATUS=%s\\n" "$?"',
      '',
    ].join('\n'));
    const outside = (argv: string[]) => Bun.spawnSync(argv, { cwd: smoke.clone, env: smoke.launch().env });
    const bunControl = outside([process.execPath, 'run', 'probe']);
    expect(bunControl.exitCode).toBe(0);
    expect(bunControl.stdout.toString()).toContain('BUN_RUN_OK');
    const readControl = outside(['/bin/sh', 'read-clones.sh', ...targets]);
    expect(readControl.exitCode).toBe(0);
    expect(readControl.stdout.toString()).toContain(secret);
    expect(readControl.stdout.toString()).toContain('SIBLING_STATUS=0');
    expect(readControl.stdout.toString()).toContain('OTHER_PROJECT_STATUS=0');

    const quote = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;
    const { results } = await runAgentSteps(smoke, [
      bashTool({ command: `${quote(process.execPath)} run probe` }),
      bashTool({ command: ['sh', 'read-clones.sh', ...targets].map(quote).join(' ') }),
    ]);
    const [bun, reads] = results;
    table.add(
      {
        check: 'sandboxed bun run probe',
        expected: 'ran',
        observed: bun?.text.includes('BUN_RUN_OK') ? 'ran' : (bun?.text ?? 'no result'),
      },
      {
        check: 'sandboxed script reads another attempt in the same project',
        expected: 'refused',
        observed: /SIBLING_STATUS=[1-9]\d*/.test(reads?.text ?? '') ? 'refused' : (reads?.text ?? 'no result'),
      },
      {
        check: 'sandboxed script reads another project',
        expected: 'refused',
        observed: /OTHER_PROJECT_STATUS=[1-9]\d*/.test(reads?.text ?? '') ? 'refused' : (reads?.text ?? 'no result'),
      },
    );
    expect(bun?.isError, bun?.text).toBe(false);
    expect(bun?.text).toContain('BUN_RUN_OK');
    // The script ran: a permission prompt denial of its invocation would prove nothing about the filesystem glob.
    expect(reads?.isError, reads?.text).toBe(false);
    expect(reads?.text).toContain('READ_PROBE_STARTED');
    expect(reads?.text).not.toContain(secret);
    expect(reads?.text).toMatch(/SIBLING_STATUS=[1-9]\d*/);
    expect(reads?.text).toMatch(/OTHER_PROJECT_STATUS=[1-9]\d*/);
    expect(smoke.isolationProblems()).toEqual([]);
  });

});

// The testkit imports no runner code, so its Claude binary locator follows the runner's layout and version format by
// convention; these tests hold the two together.
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findClaudeBinary, linkClaudeBinary } from '@agflow/testkit/src/anthropic';
import { CLAUDE_CLI_VERSION, readClaudeVersion } from '../../../src/adapters/claude/pin';
import { runnerPaths } from '../../../src/paths';
import { parseVendorVersion, vendorBinary } from '../../../src/vendor/pins';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agflow-claude-layout-')));
  dirs.push(dir);
  return dir;
}

/** Tests that run a new stub get room for macOS's slow first exec of a new file, more so under load. */
const STUB_TIMEOUT_MS = 30_000;

/**
 * A claude stand-in that prints `<stub>.out`, so one file (one slow first exec) serves every output. The path is
 * written in, because the stub also runs through a link.
 */
function stub(output: string): string {
  const bin = join(tempDir(), 'claude');
  writeFileSync(bin, `#!/bin/sh\ncat '${bin}.out'\n`);
  chmodSync(bin, 0o755);
  writeFileSync(`${bin}.out`, `${output}\n`);
  return bin;
}

describe('the testkit Claude binary layout', () => {
  test('linkClaudeBinary puts the binary where vendorBinary looks under that AGFLOW_HOME', async () => {
    const agflowHome = join(tempDir(), '.agflow');
    const linked = linkClaudeBinary(agflowHome, CLAUDE_CLI_VERSION, stub(`${CLAUDE_CLI_VERSION} (Claude Code)`));
    expect(linked).toBe(join(runnerPaths(agflowHome).runner, vendorBinary('claude', CLAUDE_CLI_VERSION)));
    expect(await readClaudeVersion(linked, CLAUDE_CLI_VERSION)).toEqual({ ok: true, version: CLAUDE_CLI_VERSION });
  }, STUB_TIMEOUT_MS);

  test('findClaudeBinary accepts exactly the output parseVendorVersion reads as the pin', () => {
    const outputs = [
      `${CLAUDE_CLI_VERSION} (Claude Code)`,
      CLAUDE_CLI_VERSION,
      `${CLAUDE_CLI_VERSION} (Claude Code) beta`,
      'codex-cli 0.159.2',
    ];
    const home = tempDir();
    const bin = stub('');
    for (const output of outputs) {
      writeFileSync(`${bin}.out`, `${output}\n`);
      const accepted = findClaudeBinary(CLAUDE_CLI_VERSION, { home, env: { AGFLOW_CLAUDE_BIN: bin } }).path;
      expect({ output, accepted: accepted !== null }).toEqual({
        output,
        accepted: parseVendorVersion('claude', output) === CLAUDE_CLI_VERSION,
      });
    }
  }, STUB_TIMEOUT_MS);
});

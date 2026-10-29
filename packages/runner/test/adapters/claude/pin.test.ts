import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  CLAUDE_CLI_VERSION,
  CLAUDE_SDK_VERSION,
  claudePin,
  readClaudeVersion,
  TMP_CLAUDE_DENYWRITE_ENFORCED,
} from '../../../src/adapters/claude/pin';
import { VENDOR_PINS } from '../../../src/vendor/pins';

const repoRoot = join(import.meta.dir, '..', '..', '..', '..', '..');
const runnerPackage = join(repoRoot, 'packages', 'runner');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Tests that run a new stub get room for macOS's slow first exec of a new file, more so under load. */
const STUB_TIMEOUT_MS = 30_000;

/**
 * An executable shell script standing in for a claude binary. It is run once with --warm, so the first exec's delay
 * (up to seconds on macOS) is paid before the test's own timing starts.
 */
function stub(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'agflow-claude-pin-'));
  dirs.push(dir);
  const bin = join(dir, 'claude');
  writeFileSync(bin, `#!/bin/sh\n[ "$1" = --warm ] && exit 0\n${body}\n`);
  chmodSync(bin, 0o755);
  Bun.spawnSync([bin, '--warm']);
  return bin;
}

describe('the Claude pin', () => {
  test('claudePin gives the darwin-arm64 pin from VENDOR_PINS and null elsewhere', () => {
    expect(claudePin('darwin-arm64')).toEqual(VENDOR_PINS['darwin-arm64']?.claude ?? null);
    expect(claudePin('darwin-arm64')).toMatchObject({ version: '2.1.285', sdkVersion: '0.3.285' });
    expect(claudePin('linux-x64')).toBeNull();
    expect(claudePin('darwin-x64')).toBeNull();
    expect(CLAUDE_CLI_VERSION).toBe('2.1.285');
    expect(CLAUDE_SDK_VERSION).toBe('0.3.285');
  });

  test('the installed Agent SDK is the pinned one and names the pinned CLI', () => {
    const manifest = JSON.parse(
      readFileSync(Bun.resolveSync('@anthropic-ai/claude-agent-sdk/package.json', runnerPackage), 'utf8'),
    );
    expect(manifest.version).toBe(CLAUDE_SDK_VERSION);
    expect(manifest.claudeCodeVersion).toBe(CLAUDE_CLI_VERSION);
  });

  test('no bundled claude platform package is installed', () => {
    const resolved = Bun.resolveSync('@anthropic-ai/claude-agent-sdk/package.json', runnerPackage);
    const scopes = [
      join(dirname(dirname(dirname(resolved))), '@anthropic-ai'),
      join(repoRoot, 'node_modules', '@anthropic-ai'),
      join(runnerPackage, 'node_modules', '@anthropic-ai'),
    ];
    const names = [
      ...readdirSync(join(repoRoot, 'node_modules', '.bun')),
      ...scopes.flatMap((scope) => (existsSync(scope) ? readdirSync(scope) : [])),
    ];
    expect(names.filter((name) => name.includes('claude-agent-sdk-'))).toEqual([]);
  });

  test('the /tmp/claude denyWrite holds on this pin', () => {
    // check:claude-sandbox changes this, together with the constant, when a pin stops enforcing it.
    expect(TMP_CLAUDE_DENYWRITE_ENFORCED).toBe(true);
  });
});

describe('readClaudeVersion', () => {
  test('accepts a binary that prints the expected version', async () => {
    const bin = stub(`echo "2.1.285 (Claude Code)"`);
    expect(await readClaudeVersion(bin, '2.1.285')).toEqual({ ok: true, version: '2.1.285' });
  }, STUB_TIMEOUT_MS);

  test('passes --version and nothing else', async () => {
    const bin = stub(`[ "$*" = "--version" ] && echo "2.1.285 (Claude Code)"`);
    expect(await readClaudeVersion(bin, '2.1.285')).toEqual({ ok: true, version: '2.1.285' });
  }, STUB_TIMEOUT_MS);

  test('without an expected version, reports whatever version the binary has', async () => {
    const bin = stub(`echo "2.1.200 (Claude Code)"`);
    expect(await readClaudeVersion(bin, null)).toEqual({ ok: true, version: '2.1.200' });
  }, STUB_TIMEOUT_MS);

  test('a missing file is a missing binary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agflow-claude-pin-'));
    dirs.push(dir);
    expect(await readClaudeVersion(join(dir, 'claude'), '2.1.285')).toEqual({
      ok: false,
      version: null,
      problem: 'binary missing',
    });
  });

  test('another version names both versions', async () => {
    const bin = stub(`echo "2.1.200 (Claude Code)"`);
    expect(await readClaudeVersion(bin, '2.1.285')).toEqual({
      ok: false,
      version: '2.1.200',
      problem: 'claude 2.1.200, expected 2.1.285',
    });
  }, STUB_TIMEOUT_MS);

  test('other output, or a failing binary, is an unreadable version', async () => {
    const unreadable = { ok: false, version: null, problem: 'unreadable version' } as const;
    // One stub whose output and exit code come from sibling files, so only one new file pays the first exec.
    const bin = stub('cat "$0.out"; exit "$(cat "$0.code")"');
    for (const [out, code] of [
      ['codex-cli 0.159.2\n', '0'],
      ['2.1.285 (Claude Code)\n', '3'],
      ['', '0'],
    ]) {
      writeFileSync(`${bin}.out`, out);
      writeFileSync(`${bin}.code`, code);
      expect(await readClaudeVersion(bin, '2.1.285')).toEqual(unreadable);
    }
  }, STUB_TIMEOUT_MS);

  test('a file that cannot be executed says so', async () => {
    const bin = stub('echo "2.1.285 (Claude Code)"');
    chmodSync(bin, 0o644);
    const result = await readClaudeVersion(bin, '2.1.285');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toStartWith('cannot run claude:');
  }, STUB_TIMEOUT_MS);

  test('a hanging binary is killed with its children after the timeout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agflow-claude-pin-'));
    dirs.push(dir);
    const started = join(dir, 'child-started');
    const alive = join(dir, 'child-alive');
    // The child outlives sh unless the whole group is killed; it writes the second marker if it survives.
    const bin = stub(`(touch '${started}'; sleep 2; touch '${alive}') & sleep 30`);
    const begun = Date.now();
    expect(await readClaudeVersion(bin, '2.1.285', { timeoutMs: 1_000 })).toEqual({
      ok: false,
      version: null,
      problem: 'claude --version timed out after 1000 ms',
    });
    expect(Date.now() - begun).toBeLessThan(5_000);
    expect(existsSync(started)).toBe(true);
    await Bun.sleep(2_000);
    expect(existsSync(alive)).toBe(false);
  }, STUB_TIMEOUT_MS);

  test('a child that keeps the pipes open after the binary exits is held to the timeout', async () => {
    const bin = stub(`echo "2.1.285 (Claude Code)"; (sleep 30) &`);
    const begun = Date.now();
    expect(await readClaudeVersion(bin, '2.1.285', { timeoutMs: 1_000 })).toEqual({
      ok: false,
      version: null,
      problem: 'claude --version timed out after 1000 ms',
    });
    expect(Date.now() - begun).toBeLessThan(5_000);
  }, STUB_TIMEOUT_MS);

  test('runs with the given environment only', async () => {
    const bin = stub(`echo "$AGFLOW_PIN_PROBE (Claude Code)"`);
    expect(await readClaudeVersion(bin, '2.1.285', { env: { AGFLOW_PIN_PROBE: '2.1.285' } })).toEqual({
      ok: true,
      version: '2.1.285',
    });
    process.env.AGFLOW_PIN_PROBE = '2.1.285';
    try {
      expect(await readClaudeVersion(bin, '2.1.285', { env: {} })).toMatchObject({ ok: false });
      // By default only PATH is passed, never the runner's own environment.
      expect(await readClaudeVersion(bin, '2.1.285')).toEqual({
        ok: false,
        version: null,
        problem: 'unreadable version',
      });
    } finally {
      delete process.env.AGFLOW_PIN_PROBE;
    }
  }, STUB_TIMEOUT_MS);
});

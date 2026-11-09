import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VENDOR_PINS } from '@agflow/runner/src/vendor/pins';
import { describeE2e, e2eEnabled, e2eVendors, requireE2e } from '../src/harness/env';

const PINS = VENDOR_PINS['darwin-arm64'];
if (!PINS) throw new Error('VENDOR_PINS has no darwin-arm64 entry');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agflow-e2e-env-'));
  dirs.push(dir);
  return dir;
}

// Each stub is written once per file and linked into place: macOS scans every new executable on its first run.
const stubs = mkdtempSync(join(tmpdir(), 'agflow-e2e-stubs-'));
process.on('exit', () => rmSync(stubs, { recursive: true, force: true }));
const claudeStub = join(stubs, 'claude');
writeFileSync(claudeStub, `#!/bin/sh\necho '${PINS.claude.version} (Claude Code)'\n`);
chmodSync(claudeStub, 0o755);
const codexStub = join(stubs, 'codex');
writeFileSync(codexStub, `#!/bin/sh\necho 'codex-cli ${PINS.codex.version}'\n`);
chmodSync(codexStub, 0o755);

const toolStub = join(stubs, 'tool');
writeFileSync(toolStub, '#!/bin/sh\nexit 0\n');
chmodSync(toolStub, 0o755);

/** A PATH directory that holds only the named tools, as stubs: requireE2e looks for them and runs none. */
function pathWith(...tools: string[]): string {
  const bin = join(tempDir(), 'bin');
  mkdirSync(bin);
  for (const tool of tools) symlinkSync(toolStub, join(bin, tool));
  return bin;
}

describe('e2eEnabled', () => {
  test('is true only with AGFLOW_E2E=1', () => {
    expect(e2eEnabled({})).toBe(false);
    expect(e2eEnabled({ AGFLOW_E2E: '0' })).toBe(false);
    expect(e2eEnabled({ AGFLOW_E2E: 'true' })).toBe(false);
    expect(e2eEnabled({ AGFLOW_E2E: '1' })).toBe(true);
  });
});

describe('e2eVendors', () => {
  test('defaults to claude and codex and honours AGFLOW_E2E_VENDORS', () => {
    expect(e2eVendors({})).toEqual(['claude', 'codex']);
    expect(e2eVendors({ AGFLOW_E2E_VENDORS: '' })).toEqual(['claude', 'codex']);
    expect(e2eVendors({ AGFLOW_E2E_VENDORS: 'codex' })).toEqual(['codex']);
    expect(e2eVendors({ AGFLOW_E2E_VENDORS: ' codex , claude,codex ' })).toEqual(['codex', 'claude']);
  });

  test('refuses an unknown vendor', () => {
    expect(() => e2eVendors({ AGFLOW_E2E_VENDORS: 'claude,gemini' })).toThrow(
      "AGFLOW_E2E_VENDORS names an unknown vendor 'gemini'",
    );
  });
});

describe('requireE2e', () => {
  test('refuses to run without AGFLOW_E2E=1', async () => {
    await expect(requireE2e({ env: {} })).rejects.toThrow('AGFLOW_E2E=1');
  });

  test('throws one message that names every missing prerequisite with its remedy', async () => {
    const env = { AGFLOW_E2E: '1', PATH: tempDir() };
    const error = await requireE2e({ env, platform: 'linux-x64', home: tempDir() }).then(
      () => null,
      (caught: Error) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('the e2e suite (AGFLOW_E2E=1) is missing its prerequisites');
    expect(message).toContain('darwin-arm64');
    expect(message).toContain('linux-x64');
    expect(message).toContain(`claude ${PINS.claude.version}`);
    expect(message).toContain('AGFLOW_CLAUDE_BIN');
    expect(message).toContain(`codex ${PINS.codex.version}`);
    expect(message).toContain('AGFLOW_CODEX_BIN');
    expect(message.match(/bun run vendor:install/g)?.length).toBe(2);
    expect(message).toContain('git is not on PATH');
    expect(message).toContain('lsof is not on PATH');
    expect(message.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(5);
  });

  test('gives the located binaries when every prerequisite is there', async () => {
    const env = {
      AGFLOW_E2E: '1',
      AGFLOW_CLAUDE_BIN: claudeStub,
      AGFLOW_CODEX_BIN: codexStub,
      PATH: pathWith('git', 'lsof'),
    };
    const prereqs = await requireE2e({ env, platform: 'darwin-arm64', home: tempDir() });
    expect(prereqs).toEqual({
      vendors: ['claude', 'codex'],
      pins: PINS,
      binaries: { claude: claudeStub, codex: codexStub },
    });
  });

  test('requires only the vendors AGFLOW_E2E_VENDORS names', async () => {
    const env = { AGFLOW_E2E: '1', AGFLOW_E2E_VENDORS: 'claude', AGFLOW_CLAUDE_BIN: claudeStub };
    const prereqs = await requireE2e({
      env: { ...env, PATH: pathWith('git', 'lsof') },
      platform: 'darwin-arm64',
      home: tempDir(),
    });
    expect(prereqs.vendors).toEqual(['claude']);
    expect(prereqs.binaries).toEqual({ claude: claudeStub });
    const missing = await requireE2e({
      env: { ...env, AGFLOW_E2E_VENDORS: 'codex', PATH: pathWith('git', 'lsof') },
      platform: 'darwin-arm64',
      home: tempDir(),
    }).then(
      () => '',
      (caught: Error) => caught.message,
    );
    expect(missing).toContain(`codex ${PINS.codex.version}`);
    expect(missing).not.toContain('claude');
  });
});

describe('describeE2e', () => {
  let ran = false;
  describeE2e(
    'a gated suite',
    () => {
      test('never runs without AGFLOW_E2E', () => {
        ran = true;
      });
    },
    {},
  );

  test('skips its tests when AGFLOW_E2E is unset', () => {
    expect(ran).toBe(false);
  });
});

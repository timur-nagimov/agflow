import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseVendorVersion, VENDOR_PINS, vendorBinary, vendorPlatform } from '../src/vendor/pins';

const repoRoot = join(import.meta.dir, '..', '..', '..');

describe('VENDOR_PINS', () => {
  test('pins both vendors for the Macs and for Linux cloud runners', () => {
    expect(VENDOR_PINS['darwin-arm64']).toMatchObject({
      claude: {
        version: '2.1.285',
        sdkVersion: '0.3.285',
        package: '@anthropic-ai/claude-agent-sdk-darwin-arm64',
        packageVersion: '0.3.285',
      },
      codex: { version: '0.159.2', package: '@openai/codex', packageVersion: '0.159.2-darwin-arm64' },
    });
    expect(Object.keys(VENDOR_PINS)).toEqual(['darwin-arm64', 'linux-x64', 'linux-arm64']);
    expect(VENDOR_PINS['darwin-x64']).toBeUndefined();
  });

  test('every platform pins the same versions, from its own platform package and tree', () => {
    const triples: Record<string, string> = {
      'darwin-arm64': 'aarch64-apple-darwin',
      'linux-x64': 'x86_64-unknown-linux-musl',
      'linux-arm64': 'aarch64-unknown-linux-musl',
    };
    for (const [platform, pins] of Object.entries(VENDOR_PINS)) {
      expect(pins).toEqual({
        claude: {
          version: '2.1.285',
          sdkVersion: '0.3.285',
          package: `@anthropic-ai/claude-agent-sdk-${platform}`,
          packageVersion: '0.3.285',
          integrity: expect.stringMatching(/^sha512-[A-Za-z0-9+/]{86}==$/),
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
        codex: {
          version: '0.159.2',
          package: '@openai/codex',
          packageVersion: `0.159.2-${platform}`,
          integrity: expect.stringMatching(/^sha512-[A-Za-z0-9+/]{86}==$/),
          tree: `vendor/${triples[platform]}`,
        },
      });
    }
    const all = Object.values(VENDOR_PINS).flatMap((pins) => [pins!.claude, pins!.codex]);
    expect(new Set(all.map((pin) => pin.integrity)).size).toBe(all.length);
  });

  test("each Claude pin is the SDK's own build for its platform", () => {
    const sdk = Bun.resolveSync('@anthropic-ai/claude-agent-sdk/package.json', join(repoRoot, 'packages/runner'));
    const manifest = JSON.parse(readFileSync(join(dirname(sdk), 'manifest.json'), 'utf8'));
    const lock = readFileSync(join(repoRoot, 'bun.lock'), 'utf8');
    for (const [platform, pins] of Object.entries(VENDOR_PINS)) {
      const pin = pins!.claude;
      expect(pin.sha256).toBe(manifest.platforms[platform].checksum);
      const entry = lock.split('\n').find((line) => line.includes(`"${pin.package}@${pin.packageVersion}"`));
      expect(entry?.match(/"sha512-[^"]+"/)?.[0]).toBe(JSON.stringify(pin.integrity));
    }
  });

  test('vendorPlatform names the platform the pins are keyed by', () => {
    expect(vendorPlatform('darwin', 'arm64')).toBe('darwin-arm64');
    expect(vendorPlatform('linux', 'x64')).toBe('linux-x64');
    expect(vendorPlatform()).toBe(`${process.platform}-${process.arch}`);
  });
});

describe('vendorBinary', () => {
  test('gives each binary relative to the runner directory', () => {
    expect(vendorBinary('claude', '2.1.285')).toBe('vendor/claude/2.1.285/claude');
    expect(vendorBinary('codex', '0.159.2')).toBe('vendor/codex/0.159.2/bin/codex');
  });

  test('refuses a version that is not a plain version number', () => {
    expect(() => vendorBinary('claude', '../2.1.285')).toThrow('not a vendor version');
    expect(() => vendorBinary('codex', '')).toThrow('not a vendor version');
  });
});

describe('parseVendorVersion', () => {
  test('reads each vendor version output', () => {
    expect(parseVendorVersion('claude', '2.1.285 (Claude Code)')).toBe('2.1.285');
    expect(parseVendorVersion('claude', '2.1.285 (Claude Code)\n')).toBe('2.1.285');
    expect(parseVendorVersion('codex', 'codex-cli 0.159.2')).toBe('0.159.2');
    expect(parseVendorVersion('codex', 'codex-cli 0.159.2\n')).toBe('0.159.2');
  });

  test('gives null for any other output', () => {
    expect(parseVendorVersion('claude', 'codex-cli 0.159.2')).toBeNull();
    expect(parseVendorVersion('codex', '2.1.285 (Claude Code)')).toBeNull();
    expect(parseVendorVersion('claude', '')).toBeNull();
    expect(parseVendorVersion('claude', 'error: unknown option --version')).toBeNull();
    expect(parseVendorVersion('claude', '2.1 (Claude Code)')).toBeNull();
    expect(parseVendorVersion('codex', 'codex-cli 0.159.2 extra')).toBeNull();
    expect(parseVendorVersion('codex', 'warning\ncodex-cli 0.159.2')).toBeNull();
  });
});

describe('shared workspace files', () => {
  test('the Agent SDK is installed at its pin without any platform package', () => {
    const resolved = Bun.resolveSync('@anthropic-ai/claude-agent-sdk/package.json', join(repoRoot, 'packages/runner'));
    expect(JSON.parse(readFileSync(resolved, 'utf8')).version).toBe('0.3.285');
    const sdkModules = dirname(dirname(dirname(resolved)));
    const store = join(repoRoot, 'node_modules', '.bun');
    const installed = [
      ...readdirSync(store),
      ...(existsSync(join(sdkModules, '@anthropic-ai')) ? readdirSync(join(sdkModules, '@anthropic-ai')) : []),
    ];
    expect(installed.filter((name) => /claude-agent-sdk-/.test(name))).toEqual([]);
  });

  test('bunfig.toml installs no optional dependencies', () => {
    const bunfig = Bun.TOML.parse(readFileSync(join(repoRoot, 'bunfig.toml'), 'utf8')) as { install?: unknown };
    expect(bunfig.install).toEqual({ optional: false });
  });

  test('the root package.json declares the scripts of the runner plans', () => {
    const { scripts } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    expect(scripts).toMatchObject({
      'vendor:install': 'bun packages/runner/scripts/vendor-install.ts',
      'verify:prep': 'bun packages/runner/scripts/verify-prep.ts',
      'verify:service': 'bun packages/runner/scripts/verify-service.ts',
      'record:claude': 'bun packages/runner/scripts/record-claude-stream.ts',
      'smoke:claude': 'AGFLOW_SMOKE=1 bun test packages/runner/test/claude-real',
      'check:claude-sandbox': 'AGFLOW_SMOKE=1 AGFLOW_SANDBOX_CHECKS=1 bun test packages/runner/test/claude-sandbox',
      'gen:codex-protocol': 'bun packages/runner/scripts/gen-codex-protocol.ts',
      'smoke:codex': 'AGFLOW_SMOKE=1 bun test packages/runner/test/codex',
      'check:codex-sandbox':
        'AGFLOW_SMOKE=1 AGFLOW_SANDBOX_CHECKS=1 bun test packages/runner/test/codex/real/sandbox.test.ts',
    });
  });

  test('the runner package has no exports map, so deep imports of its sources resolve', () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'packages/runner/package.json'), 'utf8'));
    expect(manifest.exports).toBeUndefined();
    expect(manifest.main).toBe('./src/index.ts');
  });
});

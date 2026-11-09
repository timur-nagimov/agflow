// Pinned vendor installation and integrity checks (design 7.1, 8.1, 9.1).
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runnerPaths } from '../../src/paths';
import { defaultExec } from '../../src/service/system';
import {
  ensurePinnedVendors,
  ensureVendorBinary,
  VendorInstallError,
  vendorInstallMain,
} from '../../src/vendor/install';
import { type ClaudePin, type PlatformPins, VENDOR_PINS, vendorBinary } from '../../src/vendor/pins';
import { localRegistry, packTarball, recordingExec } from '../service-helpers';

const roots: string[] = [];
const servers: ReturnType<typeof localRegistry>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const sha256 = (content: string) => createHash('sha256').update(content).digest('hex');
const cli = (output: string) => `#!/bin/sh\n[ "$1" = --version ] || exit 99\nprintf '%s\\n' '${output}'\n`;

async function fixture(output = '2.1.285 (Claude Code)') {
  const root = mkdtempSync(join(tmpdir(), 'agf-vi-'));
  roots.push(root);
  const paths = runnerPaths(join(root, 'home'));
  const claude = cli(output);
  const claudeTar = await packTarball({ claude: { content: claude }, 'package.json': { content: '{}' } });
  const tree = 'vendor/aarch64-apple-darwin';
  const codexTar = await packTarball({
    [`${tree}/bin/codex`]: { content: cli('codex-cli 0.159.2'), mode: 0o755 },
    [`${tree}/bin/codex-code-mode-host`]: { content: 'host', mode: 0o755 },
    [`${tree}/codex-path/rg`]: { content: 'rg', mode: 0o755 },
    [`${tree}/codex-resources/resource`]: { content: 'resource' },
    [`${tree}/codex-package.json`]: { content: '{}' },
  });
  const pins: PlatformPins = {
    claude: { ...VENDOR_PINS['darwin-arm64']!.claude, integrity: claudeTar.integrity, sha256: sha256(claude) },
    codex: { ...VENDOR_PINS['darwin-arm64']!.codex, integrity: codexTar.integrity },
  };
  const server = localRegistry([
    { ...pins.claude, bytes: claudeTar.bytes },
    { ...pins.codex, bytes: codexTar.bytes },
  ]);
  servers.push(server);
  mkdirSync(join(root, 'tmp'));
  const env = { AGFLOW_HOME: paths.home, AGFLOW_NPM_REGISTRY: `${server.url}/`, TMPDIR: join(root, 'tmp') };
  return { root, paths, pins, server, env, claude };
}

function emptyVendor(paths: ReturnType<typeof runnerPaths>, vendor = 'claude') {
  expect(readdirSync(join(paths.vendor, vendor))).toEqual([]);
}

describe('vendor installer', () => {
  test('installs only the verified Claude executable at mode 0755, then reuses it without a download', async () => {
    const f = await fixture();
    const binary = await ensureVendorBinary('claude', f.pins.claude, f.paths, { env: f.env });
    expect(binary).toBe(join(f.paths.runner, vendorBinary('claude', f.pins.claude.version)));
    expect(readFileSync(binary, 'utf8')).toBe(f.claude);
    expect(statSync(binary).mode & 0o777).toBe(0o755);
    expect(readdirSync(dirname(binary))).toEqual(['claude']);
    expect(await ensureVendorBinary('claude', f.pins.claude, f.paths, { env: f.env })).toBe(binary);
    expect(f.server.requests).toEqual([
      '/@anthropic-ai/claude-agent-sdk-darwin-arm64/-/claude-agent-sdk-darwin-arm64-0.3.285.tgz',
    ]);
    expect(readdirSync(f.root).sort()).toEqual(['home', 'tmp']);
    expect(readdirSync(f.paths.home)).toEqual(['runner']);
    expect(readdirSync(f.paths.runner)).toEqual(['vendor']);
    expect(readdirSync(join(f.root, 'tmp'))).toEqual([]);
  });

  test('keeps the whole Codex platform tree and reuses a valid executable', async () => {
    const f = await fixture();
    const binary = await ensureVendorBinary('codex', f.pins.codex, f.paths, { env: f.env });
    expect(binary).toBe(join(f.paths.runner, vendorBinary('codex', f.pins.codex.version)));
    const dir = dirname(dirname(binary));
    expect(readFileSync(join(dir, 'codex-path/rg'), 'utf8')).toBe('rg');
    expect(readFileSync(join(dir, 'codex-resources/resource'), 'utf8')).toBe('resource');
    expect(readFileSync(join(dir, 'bin/codex-code-mode-host'), 'utf8')).toBe('host');
    expect(readFileSync(join(dir, 'codex-package.json'), 'utf8')).toBe('{}');
    await ensureVendorBinary('codex', f.pins.codex, f.paths, { env: f.env });
    expect(f.server.requests).toHaveLength(1);
    chmodSync(binary, 0o644);
    await ensureVendorBinary('codex', f.pins.codex, f.paths, { env: f.env });
    expect(f.server.requests).toHaveLength(2);
    expect(statSync(binary).mode & 0o111).not.toBe(0);
  });

  test('publishes only after verification and gives commands private homes inside vendor', async () => {
    const f = await fixture();
    const destination = join(f.paths.vendor, 'claude', f.pins.claude.version);
    const commands: string[] = [];
    await ensureVendorBinary('claude', f.pins.claude, f.paths, {
      env: { ...f.env, HOME: '/unused-owner-home', ANTHROPIC_API_KEY: 'unused-key', CODEX_HOME: '/unused-codex' },
      exec: async (argv, options) => {
        expect(existsSync(destination)).toBe(false);
        expect(options!.cwd!.startsWith(`${f.paths.vendor}/`)).toBe(true);
        for (const name of ['HOME', 'TMPDIR', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']) {
          expect(options!.env![name]!.startsWith(`${f.paths.vendor}/`)).toBe(true);
        }
        expect(options!.env!.ANTHROPIC_API_KEY).toBeUndefined();
        commands.push(argv[0] === 'tar' ? 'tar' : argv[1]!);
        return defaultExec(argv, options);
      },
    });
    expect(commands).toEqual(['tar', '--version']);
    expect(readdirSync(join(f.paths.vendor, 'claude'))).toEqual([f.pins.claude.version]);
  });

  test('refuses a tarball sha512 mismatch before extraction and removes staging', async () => {
    const f = await fixture();
    const pin = { ...f.pins.claude, integrity: 'sha512-wrong' };
    const exec = recordingExec();
    await expect(ensureVendorBinary('claude', pin, f.paths, { env: f.env, exec })).rejects.toThrow(
      `sha512 mismatch for ${pin.package}: expected sha512-wrong, actual ${f.pins.claude.integrity}`,
    );
    expect(exec.calls).toEqual([]);
    emptyVendor(f.paths);
  });

  test('refuses a Claude sha256 mismatch before executing it', async () => {
    const f = await fixture();
    const calls: string[][] = [];
    await expect(
      ensureVendorBinary('claude', { ...f.pins.claude, sha256: 'bad' }, f.paths, {
        env: f.env,
        exec: async (argv, options) => {
          calls.push(argv);
          return defaultExec(argv, options);
        },
      }),
    ).rejects.toThrow(`sha256 mismatch for ${f.pins.claude.package}: expected bad, actual ${f.pins.claude.sha256}`);
    expect(calls.every((argv) => argv[0] === 'tar')).toBe(true);
    emptyVendor(f.paths);
  });

  test('refuses the wrong --version output even when the hashes match', async () => {
    const f = await fixture('9.9.9 (Claude Code)');
    await expect(ensureVendorBinary('claude', f.pins.claude, f.paths, { env: f.env })).rejects.toThrow(
      '--version mismatch for claude: expected 2.1.285, actual "9.9.9 (Claude Code)"',
    );
    emptyVendor(f.paths);
  });

  test('replaces partial or corrupted installs and removes interrupted staging, retaining other versions', async () => {
    const f = await fixture();
    const parent = join(f.paths.vendor, 'claude');
    mkdirSync(join(parent, f.pins.claude.version), { recursive: true });
    mkdirSync(join(parent, '.staging-interrupted'));
    mkdirSync(join(parent, '1.0.0'));
    writeFileSync(join(parent, '1.0.0/claude'), 'old binary');
    const binary = await ensureVendorBinary('claude', f.pins.claude, f.paths, { env: f.env });
    expect(existsSync(join(parent, '.staging-interrupted'))).toBe(false);
    writeFileSync(binary, 'corrupted');
    await ensureVendorBinary('claude', f.pins.claude, f.paths, { env: f.env });
    expect(f.server.requests).toHaveLength(2);
    expect(readFileSync(binary, 'utf8')).toBe(f.claude);
    expect(readFileSync(join(parent, '1.0.0/claude'), 'utf8')).toBe('old binary');
  });

  test.each(['corrupted', 'transient timeout'] as const)(
    'keeps the previous binary after a %s and registry HTTP failure',
    async (failure) => {
      const f = await fixture();
      const binary = await ensureVendorBinary('claude', f.pins.claude, f.paths, { env: f.env });
      if (failure === 'corrupted') writeFileSync(binary, 'corrupted');
      const before = readFileSync(binary, 'utf8');
      let checks = 0;
      await expect(ensureVendorBinary('claude', f.pins.claude, f.paths, {
        env: f.env,
        registry: `${f.server.url}/missing`,
        exec: async (argv, options) => {
          if (argv[1] === '--version' && ++checks === 1) {
            return { exitCode: 137, timedOut: true, stdout: '', stderr: '' };
          }
          return defaultExec(argv, options);
        },
      })).rejects.toThrow('HTTP 404');
      expect(checks).toBe(failure === 'corrupted' ? 0 : 1);
      expect(readFileSync(binary, 'utf8')).toBe(before);
      expect(readdirSync(join(f.paths.vendor, 'claude'))).toEqual([f.pins.claude.version]);
    },
    20_000,
  );

  test('concurrent installers preserve each other’s staging and both publish successfully', async () => {
    const f = await fixture();
    let started!: () => void;
    const extracting = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const secondExtracting = new Promise<void>((resolve) => { release = resolve; });
    const first = ensureVendorBinary('claude', f.pins.claude, f.paths, {
      env: f.env,
      exec: async (argv, options) => {
        if (argv[0] === 'tar') {
          started();
          await secondExtracting;
        }
        return defaultExec(argv, options);
      },
    });
    await extracting;
    const second = ensureVendorBinary('claude', f.pins.claude, f.paths, {
      env: f.env,
      exec: async (argv, options) => {
        if (argv[0] === 'tar') release();
        return defaultExec(argv, options);
      },
    });
    const results = await Promise.allSettled([first, second]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    const binary = join(f.paths.runner, vendorBinary('claude', f.pins.claude.version));
    expect(readFileSync(binary, 'utf8')).toBe(f.claude);
    expect(await ensureVendorBinary('claude', f.pins.claude, f.paths, { env: f.env })).toBe(binary);
    expect(readdirSync(join(f.paths.vendor, 'claude'))).toEqual([f.pins.claude.version]);
  }, 20_000);

  test('restores the previous tree when publishing the verified replacement fails', async () => {
    const f = await fixture();
    const binary = await ensureVendorBinary('claude', f.pins.claude, f.paths, { env: f.env });
    const destination = dirname(binary);
    const rename = fs.rename;
    const publish = spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(from).endsWith('/ready') && to === destination) {
        throw Object.assign(new Error('publish failed'), { code: 'EIO' });
      }
      return rename(from, to);
    });
    let checks = 0;
    try {
      await expect(ensureVendorBinary('claude', f.pins.claude, f.paths, {
        env: f.env,
        exec: async (argv, options) => {
          if (argv[1] === '--version' && ++checks === 1) {
            return { exitCode: 137, timedOut: true, stdout: '', stderr: '' };
          }
          return defaultExec(argv, options);
        },
      })).rejects.toThrow('publish failed');
    } finally {
      publish.mockRestore();
    }
    expect(readFileSync(binary, 'utf8')).toBe(f.claude);
    expect(readdirSync(join(f.paths.vendor, 'claude'))).toEqual([f.pins.claude.version]);
  }, 20_000);

  test.each(['EEXIST', 'ENOTEMPTY'])('verifies and reuses a competing publish after %s', async (code) => {
    const f = await fixture();
    const binary = join(f.paths.runner, vendorBinary('claude', f.pins.claude.version));
    const destination = dirname(binary);
    const rename = fs.rename;
    const publish = spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(from).endsWith('/ready') && to === destination) {
        cpSync(String(from), destination, { recursive: true });
        throw Object.assign(new Error('competing publish'), { code });
      }
      return rename(from, to);
    });
    const checked: string[] = [];
    try {
      expect(await ensureVendorBinary('claude', f.pins.claude, f.paths, {
        env: f.env,
        exec: async (argv, options) => {
          if (argv[1] === '--version') checked.push(argv[0]!);
          return defaultExec(argv, options);
        },
      })).toBe(binary);
    } finally {
      publish.mockRestore();
    }
    expect(checked).toHaveLength(2);
    expect(checked[1]).toBe(binary);
    expect(readFileSync(binary, 'utf8')).toBe(f.claude);
    expect(readdirSync(join(f.paths.vendor, 'claude'))).toEqual([f.pins.claude.version]);
  }, 20_000);

  test('sweeps dead-pid staging and retains staging owned by a live pid', async () => {
    const f = await fixture();
    const child = Bun.spawn(['/bin/sleep', '30']);
    child.kill();
    await child.exited;
    const parent = join(f.paths.vendor, 'claude');
    const dead = join(parent, `.staging-${child.pid}-dead`);
    const live = join(parent, `.staging-${process.pid}-live`);
    mkdirSync(dead, { recursive: true });
    mkdirSync(live);
    writeFileSync(join(live, 'in-progress'), 'keep');
    await ensureVendorBinary('claude', f.pins.claude, f.paths, { env: f.env });
    expect(existsSync(dead)).toBe(false);
    expect(readFileSync(join(live, 'in-progress'), 'utf8')).toBe('keep');
    expect(readdirSync(parent).sort()).toEqual([`.staging-${process.pid}-live`, f.pins.claude.version].sort());
  }, 20_000);

  test.each(['bin/codex-code-mode-host', 'codex-path/rg'])(
    'replaces a Codex tree missing %s',
    async (file) => {
      const f = await fixture();
      const binary = await ensureVendorBinary('codex', f.pins.codex, f.paths, { env: f.env });
      const companion = join(dirname(dirname(binary)), file);
      rmSync(companion);
      expect(await ensureVendorBinary('codex', f.pins.codex, f.paths, { env: f.env })).toBe(binary);
      expect(statSync(companion).isFile()).toBe(true);
      expect(f.server.requests).toHaveLength(2);
    },
    20_000,
  );

  test.each(['bin/codex-code-mode-host', 'codex-path/rg'])(
    'refuses a staged Codex tree missing %s',
    async (file) => {
      const f = await fixture();
      await expect(ensureVendorBinary('codex', f.pins.codex, f.paths, {
        env: f.env,
        exec: async (argv, options) => {
          const result = await defaultExec(argv, options);
          if (argv[0] === 'tar') rmSync(join(argv[4]!, 'package', f.pins.codex.tree, file));
          return result;
        },
      })).rejects.toThrow(file);
      emptyVendor(f.paths, 'codex');
    },
    20_000,
  );

  test('reports HTTP URL and status and cleans staging', async () => {
    const f = await fixture();
    const pin: ClaudePin = { ...f.pins.claude, package: '@test/missing' };
    await expect(ensureVendorBinary('claude', pin, f.paths, { env: f.env })).rejects.toThrow(
      `${f.server.url}/@test/missing/-/missing-${pin.packageVersion}.tgz: HTTP 404`,
    );
    emptyVendor(f.paths);
  });

  test('cleans staging after tar or version command failure', async () => {
    const f = await fixture();
    for (const failure of ['tar', '--version']) {
      await expect(
        ensureVendorBinary('claude', f.pins.claude, f.paths, {
          env: f.env,
          exec: (argv, options) =>
            argv.includes(failure)
              ? Promise.resolve({ exitCode: 1, stdout: '', stderr: 'failed', timedOut: false })
              : defaultExec(argv, options),
        }),
      ).rejects.toBeInstanceOf(VendorInstallError);
      emptyVendor(f.paths);
    }
  });

  test('Claude sha256 equals the installed SDK manifest checksum without network', () => {
    const sdk = Bun.resolveSync('@anthropic-ai/claude-agent-sdk/package.json', join(import.meta.dir, '../..'));
    const pin = VENDOR_PINS['darwin-arm64']!.claude;
    expect(JSON.parse(readFileSync(sdk, 'utf8')).version).toBe(pin.sdkVersion);
    expect(pin.packageVersion).toBe(pin.sdkVersion);
    const manifest = JSON.parse(readFileSync(join(dirname(sdk), 'manifest.json'), 'utf8'));
    expect(pin.sha256).toBe(manifest.platforms['darwin-arm64'].checksum);
    const lock = readFileSync(join(import.meta.dir, '../../../../bun.lock'), 'utf8');
    const entry = lock.split('\n').find((line) => line.includes(`"${pin.package}@${pin.packageVersion}"`));
    expect(entry).toBeDefined();
    expect(entry!.match(/"sha512-[^"]+"/)?.[0]).toBe(JSON.stringify(pin.integrity));
  });

  test('unsupported platforms fail before writing or requesting anything', async () => {
    const f = await fixture();
    await expect(ensurePinnedVendors(f.paths, { platform: 'linux-x64', env: f.env })).rejects.toThrow(
      'unsupported platform linux-x64',
    );
    expect(existsSync(f.paths.home)).toBe(false);
    expect(f.server.requests).toEqual([]);
  });

  test('main installs every supplied pin under AGFLOW_HOME and prints its path', async () => {
    const f = await fixture();
    const lines: string[] = [];
    const errors: string[] = [];
    expect(
      await vendorInstallMain([], f.env, {
        pins: f.pins,
        log: (line) => lines.push(line),
        error: (line) => errors.push(line),
      }),
    ).toBe(0);
    expect(lines).toEqual([
      join(f.paths.runner, vendorBinary('claude', f.pins.claude.version)),
      join(f.paths.runner, vendorBinary('codex', f.pins.codex.version)),
    ]);
    expect(lines.every(existsSync)).toBe(true);
    expect(statSync(f.paths.runner).mode & 0o777).toBe(0o700);
    expect(statSync(f.paths.home).mode & 0o777).toBe(0o700);
    expect(errors).toEqual([]);
    expect(f.server.requests).toHaveLength(2);
  });

  test('main reports an installation failure with a nonzero exit code', async () => {
    const f = await fixture();
    const errors: string[] = [];
    expect(await vendorInstallMain([], f.env, { platform: 'linux-x64', error: (line) => errors.push(line) })).toBe(1);
    expect(errors).toEqual(['unsupported platform linux-x64']);
  });
});

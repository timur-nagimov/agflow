import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  CODEX_VERSION,
  codexBinaryVersion,
  findCodexBinary,
  ownerCodexVersion,
} from '../../src/adapters/codex/binary';
import { VENDOR_PINS } from '../../src/vendor/pins';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agflow-codex-binary-'));
  dirs.push(dir);
  return dir;
}

/** An executable shell script at path; the parent directories are created. */
function script(path: string, body: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function mkdirp(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

// macOS scans every new executable on its first run, which costs over half a second, so each version's stub is
// written once and linked wherever a test needs it.
const stubs = mkdtempSync(join(tmpdir(), 'agflow-codex-stubs-'));
afterAll(() => rmSync(stubs, { recursive: true, force: true }));

/** A link at path to a binary that prints `codex-cli <version>`. */
function versionStub(path: string, version: string): string {
  const target = join(stubs, version);
  if (!existsSync(target)) script(target, `echo "codex-cli ${version}"`);
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path);
  return path;
}

describe('CODEX_VERSION', () => {
  test('is the Codex version of VENDOR_PINS', () => {
    expect(CODEX_VERSION).toBe('0.159.2');
    expect(CODEX_VERSION).toBe(VENDOR_PINS['darwin-arm64']?.codex.version as string);
  });
});

describe('codexBinaryVersion', () => {
  test('parses the version a binary prints', async () => {
    const dir = tempDir();
    expect(await codexBinaryVersion(versionStub(join(dir, 'codex'), '0.159.2'))).toBe('0.159.2');
    expect(await codexBinaryVersion(versionStub(join(dir, 'older'), '0.150.0'))).toBe('0.150.0');
  });

  test('passes --version and nothing else', async () => {
    const dir = tempDir();
    const bin = script(join(dir, 'codex'), `[ "$*" = "--version" ] && echo "codex-cli 0.159.2"`);
    expect(await codexBinaryVersion(bin)).toBe('0.159.2');
  });

  test('gives null for a missing, non-executable, slow or failing binary and for other output', async () => {
    const dir = tempDir();
    expect(await codexBinaryVersion(join(dir, 'missing'))).toBeNull();
    const plain = join(dir, 'plain');
    writeFileSync(plain, '#!/bin/sh\necho "codex-cli 0.159.2"\n');
    expect(await codexBinaryVersion(plain)).toBeNull();
    const started = Date.now();
    const slow = script(join(dir, 'slow'), 'sleep 5; echo "codex-cli 0.159.2"');
    expect(await codexBinaryVersion(slow, { timeoutMs: 200 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(await codexBinaryVersion(script(join(dir, 'fails'), 'echo "codex-cli 0.159.2"; exit 1'))).toBeNull();
    expect(await codexBinaryVersion(script(join(dir, 'other'), 'echo "2.1.285 (Claude Code)"'))).toBeNull();
    expect(await codexBinaryVersion(dir)).toBeNull();
  });

  // Codex writes $CODEX_HOME/tmp/arg0 even for --version, and falls back to ~/.codex without CODEX_HOME.
  test('runs with a throwaway CODEX_HOME and HOME that exist during the run and are removed afterwards', async () => {
    const dir = tempDir();
    const record = join(dir, 'record');
    const bin = script(
      join(dir, 'codex'),
      `[ -d "$CODEX_HOME" ] && [ -d "$HOME" ] && echo "$CODEX_HOME|$HOME" > "${record}"; echo "codex-cli 0.159.2"`,
    );
    expect(await codexBinaryVersion(bin)).toBe('0.159.2');
    const [codexHome, home] = readFileSync(record, 'utf8').trim().split('|') as [string, string];
    for (const value of [codexHome, home]) {
      expect(value).not.toBe(homedir());
      expect(value).not.toStartWith(join(homedir(), '.codex'));
      expect(value).not.toBe(process.env.CODEX_HOME ?? '');
      expect(existsSync(value)).toBe(false);
    }
  });

  test('runs with the homes it is given and leaves them in place', async () => {
    const dir = tempDir();
    const record = join(dir, 'record');
    const bin = script(join(dir, 'codex'), `echo "$CODEX_HOME|$HOME" > "${record}"; echo "codex-cli 0.159.2"`);
    const homes = { codex: mkdirp(join(dir, 'codex-home')), user: mkdirp(join(dir, 'codex-user')) };
    expect(await codexBinaryVersion(bin, { homes })).toBe('0.159.2');
    expect(readFileSync(record, 'utf8').trim()).toBe(`${homes.codex}|${homes.user}`);
    expect(existsSync(homes.codex) && existsSync(homes.user)).toBe(true);
  });

  test('bounds the wait for the output: a helper holding stdout is killed with the group', async () => {
    const dir = tempDir();
    const pidFile = join(dir, 'helper.pid');
    const bin = script(join(dir, 'codex'), `sleep 8 & echo $! > "${pidFile}"; echo "codex-cli 0.159.2"`);
    // The bound leaves room for macOS's first-run scan of the new script.
    const started = Date.now();
    expect(await codexBinaryVersion(bin, { timeoutMs: 2_000 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
    const helper = Number(readFileSync(pidFile, 'utf8').trim());
    await Bun.sleep(50);
    expect(() => process.kill(helper, 0)).toThrow();
  }, 15_000);

  test('bounds the output it keeps: endless output gives null without growing memory', async () => {
    const dir = tempDir();
    const bin = script(join(dir, 'codex'), 'exec yes "codex-cli 0.159.2"');
    const before = process.memoryUsage().rss;
    const started = Date.now();
    expect(await codexBinaryVersion(bin, { timeoutMs: 2_000 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(process.memoryUsage().rss - before).toBeLessThan(256 * 1024 * 1024);
  }, 15_000);
});

describe('findCodexBinary', () => {
  test('takes AGFLOW_CODEX_BIN first', async () => {
    const dir = tempDir();
    const home = join(dir, 'home');
    const fromEnv = versionStub(join(dir, 'env', 'codex'), CODEX_VERSION);
    versionStub(join(home, '.agflow', 'runner', 'vendor', 'codex', CODEX_VERSION, 'bin', 'codex'), CODEX_VERSION);
    expect(await findCodexBinary({ env: { AGFLOW_CODEX_BIN: fromEnv }, home })).toBe(fromEnv);
  });

  test("then the runner's vendor directory under ~/.agflow", async () => {
    const dir = tempDir();
    const home = join(dir, 'home');
    const vendored = versionStub(
      join(home, '.agflow', 'runner', 'vendor', 'codex', CODEX_VERSION, 'bin', 'codex'),
      CODEX_VERSION,
    );
    expect(await findCodexBinary({ env: {}, home })).toBe(vendored);
    expect(await findCodexBinary({ env: { AGFLOW_CODEX_BIN: '' }, home })).toBe(vendored);
  });

  test('skips a candidate at another version or one that does not run', async () => {
    const dir = tempDir();
    const home = join(dir, 'home');
    const other = versionStub(join(dir, 'env', 'codex'), '0.150.0');
    const vendored = versionStub(
      join(home, '.agflow', 'runner', 'vendor', 'codex', CODEX_VERSION, 'bin', 'codex'),
      CODEX_VERSION,
    );
    expect(await findCodexBinary({ env: { AGFLOW_CODEX_BIN: other }, home })).toBe(vendored);
    expect(await findCodexBinary({ env: { AGFLOW_CODEX_BIN: join(dir, 'missing') }, home })).toBe(vendored);
  });

  test('gives null when no candidate is the pin', async () => {
    const dir = tempDir();
    const home = join(dir, 'home');
    versionStub(join(home, '.agflow', 'runner', 'vendor', 'codex', CODEX_VERSION, 'bin', 'codex'), '0.150.0');
    const other = versionStub(join(dir, 'codex'), '0.1.0');
    expect(await findCodexBinary({ env: { AGFLOW_CODEX_BIN: other }, home })).toBeNull();
    expect(await findCodexBinary({ env: {}, home: join(dir, 'empty') })).toBeNull();
  });
});

describe('ownerCodexVersion', () => {
  /**
   * A global npm install: <prefix>/bin/codex links to the @openai/codex wrapper, which must never run (it is Node),
   * and the platform package holds the native binary.
   */
  function npmInstall(dir: string, options: { layout?: 'nested' | 'hoisted' | 'bundled'; version?: string } = {}) {
    const prefix = join(dir, 'prefix');
    const wrapperPackage = join(prefix, 'lib', 'node_modules', '@openai', 'codex');
    const marker = join(dir, 'wrapper-ran');
    writeFileSync(join(mkdirp(wrapperPackage), 'package.json'), JSON.stringify({ name: '@openai/codex' }));
    const wrapper = script(join(wrapperPackage, 'bin', 'codex.js'), `touch "${marker}"; echo "codex-cli 9.9.9"`);
    symlinkSync(wrapper, join(mkdirp(join(prefix, 'bin')), 'codex'));
    const layout = options.layout ?? 'nested';
    // The wrapper's own fallback, without a platform package, is a vendor directory inside its package.
    const platformPackage =
      layout === 'bundled'
        ? wrapperPackage
        : join(layout === 'hoisted' ? join(prefix, 'lib') : wrapperPackage, 'node_modules/@openai/codex-darwin-arm64');
    if (layout !== 'bundled') {
      writeFileSync(
        join(mkdirp(platformPackage), 'package.json'),
        JSON.stringify({ name: '@openai/codex-darwin-arm64', version: '0.150.0-darwin-arm64' }),
      );
    }
    const native = versionStub(
      join(platformPackage, 'vendor', 'aarch64-apple-darwin', 'bin', 'codex'),
      options.version ?? '0.150.0',
    );
    return { bin: join(prefix, 'bin'), marker, native };
  }

  const darwin = { platform: 'darwin', arch: 'arm64' };

  test("resolves the npm wrapper to its platform package's native binary without running the wrapper", async () => {
    const dir = tempDir();
    const install = npmInstall(dir);
    expect(await ownerCodexVersion({ env: { PATH: `${install.bin}:/usr/bin:/bin` }, ...darwin })).toBe('0.150.0');
    expect(existsSync(install.marker)).toBe(false);
  });

  test('finds a platform package hoisted next to the wrapper package, or the vendor directory inside it', async () => {
    const dir = tempDir();
    const hoisted = npmInstall(join(dir, 'hoisted'), { layout: 'hoisted', version: '0.158.0' });
    expect(await ownerCodexVersion({ env: { PATH: hoisted.bin }, ...darwin })).toBe('0.158.0');
    expect(existsSync(hoisted.marker)).toBe(false);
    const bundled = npmInstall(join(dir, 'bundled'), { layout: 'bundled', version: '0.157.0' });
    expect(await ownerCodexVersion({ env: { PATH: bundled.bin }, ...darwin })).toBe('0.157.0');
    expect(existsSync(bundled.marker)).toBe(false);
  });

  test('gives null without codex on PATH, without the platform binary, or for an unknown executable', async () => {
    const dir = tempDir();
    expect(await ownerCodexVersion({ env: { PATH: join(dir, 'nothing') }, ...darwin })).toBeNull();
    const install = npmInstall(join(dir, 'npm'));
    expect(await ownerCodexVersion({ env: { PATH: install.bin }, platform: 'linux', arch: 'x64' })).toBeNull();
    rmSync(install.native);
    expect(await ownerCodexVersion({ env: { PATH: install.bin }, ...darwin })).toBeNull();
    expect(existsSync(install.marker)).toBe(false);
    // A script that is not the npm wrapper could be anything, Node included, so it is never run.
    const other = join(dir, 'other');
    const marker = join(dir, 'other-ran');
    script(join(other, 'codex'), `touch "${marker}"; echo "codex-cli 0.159.2"`);
    expect(await ownerCodexVersion({ env: { PATH: other }, ...darwin })).toBeNull();
    expect(existsSync(marker)).toBe(false);
  });

  // An `npm link` of a source checkout: the wrapper's real directory has no node_modules ancestor, where a module
  // resolver would fall back to Bun's auto-install and fetch the platform package from the registry.
  test('looks for the platform package on disk only, never through a registry', async () => {
    const dir = realpathSync(tempDir());
    const checkout = join(dir, 'checkout', 'codex-cli');
    writeFileSync(join(mkdirp(checkout), 'package.json'), JSON.stringify({ name: '@openai/codex' }));
    const marker = join(dir, 'wrapper-ran');
    const wrapper = script(join(checkout, 'bin', 'codex.js'), `touch "${marker}"; echo "codex-cli 9.9.9"`);
    symlinkSync(wrapper, join(mkdirp(join(dir, 'prefix', 'bin')), 'codex'));
    const requests: string[] = [];
    const registry = Bun.serve({
      port: 0,
      fetch(request) {
        requests.push(new URL(request.url).pathname);
        return new Response('not found', { status: 404 });
      },
    });
    try {
      const source = join(import.meta.dir, '..', '..', 'src', 'adapters', 'codex', 'binary.ts');
      const program = [
        `const { ownerCodexVersion } = await import(${JSON.stringify(source)});`,
        `const version = await ownerCodexVersion({ env: { PATH: ${JSON.stringify(join(dir, 'prefix', 'bin'))} },`,
        `  platform: 'darwin', arch: 'arm64' });`,
        'console.log(JSON.stringify(version));',
      ].join('\n');
      const proc = Bun.spawn([process.execPath, '-e', program], {
        cwd: dir,
        env: { ...process.env, BUN_CONFIG_REGISTRY: registry.url.href, BUN_INSTALL_CACHE_DIR: join(dir, 'cache') },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      expect({ code: await proc.exited, stdout: stdout.trim(), stderr }).toEqual({ code: 0, stdout: 'null', stderr: '' });
    } finally {
      registry.stop(true);
    }
    expect(requests).toEqual([]);
    expect(existsSync(marker)).toBe(false);
  });
});

import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLAUDE_TEST_API_KEY,
  claudeTestEnv,
  findClaudeBinary,
  linkClaudeBinary,
  reply,
  type ScriptedAnthropic,
  startScriptedAnthropic,
} from '../src/anthropic';
import { type RefusingProxy, startRefusingProxy } from '../src/refusing-proxy';

const dirs: string[] = [];
const servers: ScriptedAnthropic[] = [];
const proxies: RefusingProxy[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const proxy of proxies.splice(0)) await proxy.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agflow-claude-env-'));
  dirs.push(dir);
  return dir;
}

/** Tests that run a new stub get room for macOS's slow first exec of a new file, more so under load. */
const STUB_TIMEOUT_MS = 30_000;

/** An executable that prints a version line the way claude does. */
function versionStub(path: string, output: string): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `#!/bin/sh\necho '${output}'\n`);
  chmodSync(path, 0o755);
  return path;
}

describe('claudeTestEnv', () => {
  test('holds exactly the test-mode variables', () => {
    expect(claudeTestEnv({ baseUrl: 'http://127.0.0.1:1234', proxyUrl: 'http://127.0.0.1:5678' })).toEqual({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:1234',
      ANTHROPIC_API_KEY: CLAUDE_TEST_API_KEY,
      CLAUDE_CODE_MAX_RETRIES: '0',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      HTTPS_PROXY: 'http://127.0.0.1:5678',
      HTTP_PROXY: 'http://127.0.0.1:5678',
      NO_PROXY: '127.0.0.1,localhost',
    });
    expect(CLAUDE_TEST_API_KEY).toStartWith('sk-ant-');
  });

  test('a test can raise the retry count', () => {
    const env = claudeTestEnv({ baseUrl: 'http://127.0.0.1:1', proxyUrl: 'http://127.0.0.1:2', maxRetries: 2 });
    expect(env.CLAUDE_CODE_MAX_RETRIES).toBe('2');
  });

  test('a Messages request made with it reaches the scripted server, and external hosts hit the proxy', async () => {
    const server = await startScriptedAnthropic({ handler: () => reply('through the scripted server') });
    servers.push(server);
    const proxy = await startRefusingProxy();
    proxies.push(proxy);
    // A child process gets the environment the way the CLI does: requests follow its proxy variables.
    const script = `
      const env = process.env;
      const response = await fetch(env.ANTHROPIC_BASE_URL + '/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY },
        body: JSON.stringify({ model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'hi' }] }),
      });
      const message = await response.json();
      // A reserved host: should the proxy variables be ignored, the request fails at DNS and reaches nothing.
      const external = await fetch('https://agflow-test.invalid/v1/messages', { method: 'POST' }).then(
        (r) => r.status,
        () => 'failed',
      );
      console.log(JSON.stringify({ status: response.status, text: message.content[0].text, external }));
    `;
    const env = claudeTestEnv({ baseUrl: server.url, proxyUrl: proxy.url });
    const child = Bun.spawn([process.execPath, '-e', script], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ code: await child.exited, stderr }).toEqual({ code: 0, stderr: '' });
    const outcome = JSON.parse(stdout);
    expect(outcome).toMatchObject({ status: 200, text: 'through the scripted server' });
    expect([403, 'failed']).toContain(outcome.external);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.headers['x-api-key']).toBe(CLAUDE_TEST_API_KEY);
    // The proxy saw only the external host, never the scripted server.
    expect(proxy.refused.map((refused) => refused.target)).toEqual(['agflow-test.invalid:443']);
  });
});

describe('findClaudeBinary', () => {
  const VERSION = '2.1.285';

  function vendorPath(home: string, version = VERSION): string {
    return join(home, '.agflow', 'runner', 'vendor', 'claude', version, 'claude');
  }

  test('prefers AGFLOW_CLAUDE_BIN', () => {
    const home = tempDir();
    const explicit = versionStub(join(tempDir(), 'claude'), `${VERSION} (Claude Code)`);
    versionStub(vendorPath(home), `${VERSION} (Claude Code)`);
    expect(findClaudeBinary(VERSION, { home, env: { AGFLOW_CLAUDE_BIN: explicit } })).toEqual({
      path: explicit,
      reason: null,
    });
  }, STUB_TIMEOUT_MS);

  test('falls back to the vendor directory under the home', () => {
    const home = tempDir();
    const vendored = versionStub(vendorPath(home), `${VERSION} (Claude Code)`);
    expect(findClaudeBinary(VERSION, { home, env: {} })).toEqual({ path: vendored, reason: null });
    const wrong = versionStub(join(tempDir(), 'claude'), '2.1.200 (Claude Code)');
    expect(findClaudeBinary(VERSION, { home, env: { AGFLOW_CLAUDE_BIN: wrong } })).toEqual({
      path: vendored,
      reason: null,
    });
  }, STUB_TIMEOUT_MS);

  test('gives null with a reason when no candidate has the version', () => {
    const home = tempDir();
    const none = findClaudeBinary(VERSION, { home, env: {} });
    expect(none.path).toBeNull();
    expect(none.reason).toContain('AGFLOW_CLAUDE_BIN is not set');
    expect(none.reason).toContain(`${vendorPath(home)} is missing`);
    expect(none.reason).toContain('`bun run vendor:install`');

    const wrong = versionStub(join(tempDir(), 'claude'), '2.1.200 (Claude Code)');
    versionStub(vendorPath(home), 'not a version');
    const mismatched = findClaudeBinary(VERSION, { home, env: { AGFLOW_CLAUDE_BIN: wrong } });
    expect(mismatched.path).toBeNull();
    expect(mismatched.reason).toContain(`AGFLOW_CLAUDE_BIN ${wrong} is claude 2.1.200`);
    expect(mismatched.reason).toContain(`${vendorPath(home)} has an unreadable version`);
    expect(mismatched.reason).toContain(`AGFLOW_CLAUDE_BIN to a claude ${VERSION} binary`);
  }, STUB_TIMEOUT_MS);

  test('a hanging binary is given up on', () => {
    const home = tempDir();
    const hanging = join(tempDir(), 'claude');
    writeFileSync(hanging, '#!/bin/sh\nexec sleep 30\n');
    chmodSync(hanging, 0o755);
    const started = Date.now();
    const result = findClaudeBinary(VERSION, { home, env: { AGFLOW_CLAUDE_BIN: hanging }, timeoutMs: 300 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.path).toBeNull();
    expect(result.reason).toContain(`AGFLOW_CLAUDE_BIN ${hanging} did not answer --version`);
  }, STUB_TIMEOUT_MS);
});

describe('linkClaudeBinary', () => {
  test('links a binary into a runner home, where findClaudeBinary finds it', () => {
    const home = tempDir();
    const bin = versionStub(join(tempDir(), 'claude'), '2.1.285 (Claude Code)');
    const linked = linkClaudeBinary(join(home, '.agflow'), '2.1.285', bin);
    expect(linked).toBe(join(home, '.agflow', 'runner', 'vendor', 'claude', '2.1.285', 'claude'));
    expect(lstatSync(linked).isSymbolicLink()).toBe(true);
    expect(readlinkSync(linked)).toBe(bin);
    expect(findClaudeBinary('2.1.285', { home, env: {} })).toEqual({ path: linked, reason: null });
    // Linking again replaces the link.
    const other = versionStub(join(tempDir(), 'claude'), '2.1.285 (Claude Code)');
    expect(linkClaudeBinary(join(home, '.agflow'), '2.1.285', other)).toBe(linked);
    expect(readlinkSync(linked)).toBe(other);
  }, STUB_TIMEOUT_MS);

  test('leaves the binary in place when it is the one found under that very home', () => {
    const home = tempDir();
    const vendored = join(home, '.agflow', 'runner', 'vendor', 'claude', '2.1.285', 'claude');
    versionStub(vendored, '2.1.285 (Claude Code)');
    expect(findClaudeBinary('2.1.285', { home, env: {} })).toEqual({ path: vendored, reason: null });
    expect(linkClaudeBinary(join(home, '.agflow'), '2.1.285', vendored)).toBe(vendored);
    expect(lstatSync(vendored).isFile()).toBe(true);
    expect(findClaudeBinary('2.1.285', { home, env: {} })).toEqual({ path: vendored, reason: null });
    // Also when it is reached through a link to it.
    const viaLink = join(tempDir(), 'claude');
    symlinkSync(vendored, viaLink);
    expect(linkClaudeBinary(join(home, '.agflow'), '2.1.285', viaLink)).toBe(vendored);
    expect(lstatSync(vendored).isFile()).toBe(true);
  }, STUB_TIMEOUT_MS);

  test('refuses a version that is not a plain version number', () => {
    expect(() => linkClaudeBinary(tempDir(), '../2.1.285', '/bin/sh')).toThrow('not a vendor version');
  });
});

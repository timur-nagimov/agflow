import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const sha = 'a'.repeat(40);

function dryRun(args: string[] = [], dirty = false) {
  const dir = mkdtempSync(join(tmpdir(), 'agflow-deploy-test-'));
  dirs.push(dir);
  const stub = (name: string, body: string) => {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  };
  // No repository writes: model only the read-only Git commands used by the dry run.
  stub('git', `case "$*" in\n*status*) ${dirty ? "echo ' M README.md'" : ':'};;\n*rev-parse*) echo ${sha};;\n*) echo 'unexpected git operation' >&2; exit 97;;\nesac`);
  for (const name of ['ssh', 'scp', 'curl', 'yc', 'bun']) stub(name, `echo 'unexpected external command: ${name}' >&2; exit 98`);
  return Bun.spawnSync(['bash', resolve('scripts/deploy-hub.sh'), '--dry-run', ...args], {
    env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir },
  });
}

test('dry run describes the immutable release, activation, health check and rollback without remote commands', () => {
  const result = dryRun(['agflow-admin@hub.example.com', 'https://hub.example.com']);
  expect(result.exitCode).toBe(0);
  const out = result.stdout.toString();
  for (const text of [sha, 'git archive', `/opt/agflow/releases/${sha}`, 'bun install --frozen-lockfile',
    'bun run build:web', 'atomic', 'Caddy', 'https://hub.example.com/api/auth-config', 'last 3', 'rollback']) {
    expect(out).toContain(text);
  }
  expect(result.stderr.toString()).not.toContain('unexpected');
});

test('dirty worktrees are refused even in dry run', () => {
  const result = dryRun(['agflow-admin@hub.example.com', 'https://hub.example.com'], true);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain('dirty');
});

test('deployment refuses unsafe hosts and URLs before any remote action', () => {
  for (const args of [
    ['-oProxyCommand=evil', 'https://hub.example.com'],
    ['agflow-admin@hub.example.com', 'http://hub.example.com'],
    ['agflow-admin@hub.example.com', 'https://hub.example.com/path'],
    ['agflow-admin@hub.example.com', 'https://hub.example.com;evil'],
  ]) expect(dryRun(args).exitCode).not.toBe(0);
});

import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireLsofOnMacOS } from './prerequisites';

test('macOS requires lsof, while portable platforms do not probe for it', () => {
  expect(() => requireLsofOnMacOS('darwin', () => null)).toThrow(
    'macOS test prerequisite: lsof must be available on PATH (include /usr/sbin)',
  );
  const commands: string[] = [];
  requireLsofOnMacOS('darwin', (command) => {
    commands.push(command);
    return '/usr/sbin/lsof';
  });
  expect(commands).toEqual(['lsof']);
  for (const platform of ['linux', 'win32'] as const) {
    requireLsofOnMacOS(platform, () => {
      throw new Error('portable tests must not require lsof');
    });
  }
});

test.skipIf(process.platform !== 'darwin')(
  'missing lsof fails the clone-sweep test (the runner supports darwin-arm64 only; design 7.1)',
  async () => {
    const emptyPath = mkdtempSync(join(tmpdir(), 'agflow-no-lsof-'));
    try {
      const child = Bun.spawn(
        [process.execPath, 'test', join(import.meta.dir, 'processes.test.ts'), '--test-name-pattern', 'kills a process whose cwd'],
        { env: { ...process.env, PATH: emptyPath }, stdout: 'pipe', stderr: 'pipe' },
      );
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code).not.toBe(0);
      expect(stdout + stderr).toContain('macOS test prerequisite: lsof must be available on PATH');
    } finally {
      rmSync(emptyPath, { recursive: true, force: true });
    }
  },
);

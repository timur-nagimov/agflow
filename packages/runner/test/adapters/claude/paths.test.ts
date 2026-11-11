import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claudeProjectDir,
  claudeProjectSlug,
  MAX_CLAUDE_PROJECT_SLUG,
  realPathOf,
} from '../../../src/adapters/claude/paths';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A temporary directory under /tmp, which macOS reaches through the /tmp -> /private/tmp symlink. */
function tmpRoot(): string {
  const dir = mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'agflow-slug-'));
  dirs.push(dir);
  return dir;
}

describe("Claude's project directory", () => {
  test('the slug is the real path of the clone with every non-alphanumeric character replaced by -', () => {
    const root = tmpRoot();
    const clone = join(root, 'x', '.agflow', 'work', 'p', 'T-1-a1');
    mkdirSync(clone, { recursive: true });
    const slug = claudeProjectSlug(clone);
    expect(slug).toBe(realpathSync(clone).replace(/[^A-Za-z0-9]/g, '-'));
    expect(slug.endsWith('-x--agflow-work-p-T-1-a1')).toBe(true);
    if (process.platform === 'darwin') expect(slug.startsWith('-private-tmp-agflow-slug-')).toBe(true);
    expect(claudeProjectDir('/home/claude', clone)).toBe(join('/home/claude', 'projects', slug));
  });

  test('a symlinked clone path and a not yet existing clone get the same slug as the real path would', () => {
    const root = tmpRoot();
    const real = join(root, 'work', 'p', 'T-1-a1');
    mkdirSync(real, { recursive: true });
    symlinkSync(join(root, 'work'), join(root, 'link'));
    expect(claudeProjectSlug(join(root, 'link', 'p', 'T-1-a1'))).toBe(claudeProjectSlug(real));
    expect(claudeProjectSlug(join(root, 'work', 'p', 'T-9-gone'))).toBe(
      `${realpathSync(join(root, 'work', 'p'))}/T-9-gone`.replace(/[^A-Za-z0-9]/g, '-'),
    );
  });

  test('a slug over 200 characters is refused, because the CLI then appends a hash', () => {
    const root = tmpRoot();
    const base = realpathSync(root).length + 1;
    const fits = join(root, 'a'.repeat(MAX_CLAUDE_PROJECT_SLUG - base));
    expect(claudeProjectSlug(fits)).toHaveLength(MAX_CLAUDE_PROJECT_SLUG);
    expect(() => claudeProjectSlug(`${fits}b`)).toThrow(/201 characters/);
  });
});

describe('realPathOf', () => {
  test('resolves symlinks, also dangling ones, and judges a missing path by its nearest existing parent', () => {
    const root = tmpRoot();
    const real = realpathSync(root);
    mkdirSync(join(root, 'dir'));
    symlinkSync(join(root, 'dir'), join(root, 'to-dir'));
    symlinkSync(join(root, 'elsewhere', 'file'), join(root, 'dangling'));
    symlinkSync('loop-b', join(root, 'loop-a'));
    symlinkSync('loop-a', join(root, 'loop-b'));
    expect(realPathOf(join(root, 'to-dir', 'new', 'file.ts'))).toBe(join(real, 'dir', 'new', 'file.ts'));
    expect(realPathOf(join(root, 'dangling'))).toBe(join(real, 'elsewhere', 'file'));
    expect(realPathOf(join(root, 'dir', '..', 'to-dir'))).toBe(join(real, 'dir'));
    expect(() => realPathOf(join(root, 'loop-a', 'x'))).toThrow(/symbolic links/);
  });
});

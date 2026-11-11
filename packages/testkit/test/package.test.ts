import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const testkit = join(import.meta.dir, '..');
const src = join(testkit, 'src');
const transpiler = new Bun.Transpiler({ loader: 'ts' });

/** A relative specifier as Bun resolves it: the file itself, with .ts, or its index.ts. */
function resolveRelative(from: string, specifier: string): string {
  const base = resolve(dirname(from), specifier);
  const found = [base, `${base}.ts`, join(base, 'index.ts')].find((path) => existsSync(path) && path.endsWith('.ts'));
  if (!found) throw new Error(`${relative(testkit, from)} imports ${specifier}, which does not resolve`);
  return found;
}

/**
 * Every source file the main entry reaches through its relative imports and re-exports. Other entries (harness/,
 * scenarios/, live.ts, the vendor fakes) are not reached and may import the runner (design 13).
 */
function mainSources(): string[] {
  const reached = new Set<string>();
  const pending = [join(src, 'index.ts')];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (reached.has(file)) continue;
    reached.add(file);
    // scanImports covers import and export ... from statements and leaves out type-only ones.
    for (const { path } of transpiler.scanImports(readFileSync(file, 'utf8'))) {
      if (path.startsWith('./') || path.startsWith('../')) pending.push(resolveRelative(file, path));
    }
  }
  return [...reached];
}

describe('the testkit package', () => {
  test('its main entry imports runner types only', () => {
    const files = mainSources();
    expect(files).toContain(join(src, 'index.ts'));
    expect(files).toContain(join(src, 'git-fixtures.ts'));
    for (const file of files) {
      const runtime = transpiler.scanImports(readFileSync(file, 'utf8')).map((entry) => entry.path);
      const runner = runtime.filter((path) => path.startsWith('@agflow/runner'));
      expect({ file: relative(testkit, file), runner }).toEqual({ file: relative(testkit, file), runner: [] });
    }
  });

  test('has no exports map, so deep imports of its sources resolve', () => {
    const manifest = JSON.parse(readFileSync(join(testkit, 'package.json'), 'utf8'));
    expect(manifest.exports).toBeUndefined();
    expect(manifest.main).toBe('./src/index.ts');
    expect(manifest.devDependencies['@anthropic-ai/sdk']).toBe('1.3.0');
  });

  test('resolves the runner and its sources by deep import, and the runner resolves the testkit', () => {
    expect(Bun.resolveSync('@agflow/runner/src/vendor/pins.ts', testkit)).toBe(
      join(testkit, '..', 'runner', 'src', 'vendor', 'pins.ts'),
    );
    expect(Bun.resolveSync('@agflow/testkit/src/git-fixtures.ts', join(testkit, '..', 'runner'))).toBe(
      join(src, 'git-fixtures.ts'),
    );
    expect(Bun.resolveSync('@agflow/testkit', join(testkit, '..', 'runner'))).toBe(join(src, 'index.ts'));
  });
});

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

// One value import from a core module that builds zod schemas puts all of zod into the app (decision X-48), so the
// web imports only types from api-schemas.ts, runner-protocol.ts and schemas.ts. zod's issue codes are string
// literals that survive minification; 'invalid_type' marks it in a bundle.
const ZOD_MARK = 'invalid_type';

/**
 * Bundles an entry point as build.ts does and returns the code, which `bun build` prints instead of writing files.
 * It runs in its own process, because Bun.build inside the test runner does not resolve the workspace's packages.
 */
async function bundle(entry: string): Promise<string> {
  const build = Bun.spawn(
    [process.execPath, 'build', '--minify', '--define', 'process.env.NODE_ENV="production"', entry],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const [code, errors, exitCode] = await Promise.all([
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
    build.exited,
  ]);
  expect({ exitCode, errors }).toEqual({ exitCode: 0, errors: '' });
  return code;
}

describe('the browser bundle', () => {
  test('the app builds without zod', async () => {
    const app = await bundle(join(import.meta.dir, '../src/main.tsx'));
    expect(app).toContain('createRoot');
    expect(app.includes(ZOD_MARK)).toBe(false);
  });

  test('the mark finds zod when a zod module is bundled', async () => {
    const schemas = await bundle(join(import.meta.dir, '../../core/src/api-schemas.ts'));
    expect(schemas.includes(ZOD_MARK)).toBe(true);
  });
});

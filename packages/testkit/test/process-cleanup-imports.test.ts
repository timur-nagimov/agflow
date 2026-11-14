import { expect, test } from 'bun:test';
import { join } from 'node:path';

test('the child tracking preload has no runner modules in its import graph', async () => {
  const runnerModules: string[] = [];
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, '../src/process-cleanup-child.ts')],
    target: 'bun',
    plugins: [{
      name: 'track-runner-imports',
      setup(build) {
        build.onLoad({ filter: /[/\\]packages[/\\]runner[/\\]/ }, ({ path }) => {
          runnerModules.push(path);
          return undefined;
        });
      },
    }],
  });
  expect(result.success).toBe(true);
  expect(runnerModules).toEqual([]);
});

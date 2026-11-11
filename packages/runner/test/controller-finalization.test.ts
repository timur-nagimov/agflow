import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AttemptRecord } from '../src/attempt-store';
import { runGit } from '../src/git/run';
import { cleanupRunnerFixtures, createRunnerFixture, FIXTURE_PROJECT, waitFor } from './fixture';

setDefaultTimeout(30_000);
afterEach(cleanupRunnerFixtures);

// Take-over is the last lifecycle added by Task 31; exercise the shared finalization contract through every caller.
for (const mode of ['exit', 'stop', 'suspend', 'takeover', 'stopped takeover'] as const) {
  for (const failure of ['none', 'push', 'harvest'] as const) {
    test(`${mode}: records the ${failure} outcome before finalization`, async () => {
      const f = await createRunnerFixture({
        config: { timings: { finalPush: 1, lateRetry: { base: 60_000, cap: 60_000 } } },
        script: { turns: [
          [{ do: 'write', path: 'work.txt', content: 'unpublished\n' }, { do: 'sleep', ms: 30_000 }],
          [{ do: 'terminal', tool: 'handoff' }],
        ] },
      });
      const controller = f.controller();
      await controller.start(f.spec());
      const clone = f.paths.clone(FIXTURE_PROJECT, 'T-4-a1');
      await waitFor(() => existsSync(join(clone, 'work.txt')) && controller.phase === 'turn');
      expect(f.store.get('T-4-a1')?.finalizedAt).toBeNull();
      const stop = { fence: f.spec().fence, handoff: false, interruptFirst: false, keepClone: true, reason: 'done' };
      if (mode === 'stopped takeover') await controller.stop(stop);
      if (failure === 'push') {
        await runGit(f.local, [`--git-dir=${f.vault.path}`, 'config', 'remote.origin.url', join(f.home, 'missing-origin')]);
        // A stopped take-over harvest must differ from the already pushed tree.
        writeFileSync(join(clone, 'later.txt'), 'new work\n');
      }
      if (failure === 'harvest') rmSync(join(clone, '.git'), { recursive: true, force: true });
      const beforeMarkers: AttemptRecord[] = [];
      const update = f.store.update.bind(f.store);
      f.store.update = (id, patch) => {
        if (patch.finalizedAt != null) beforeMarkers.push(f.store.get(id)!);
        return update(id, patch);
      };
      if (mode === 'exit') {
        await controller.session!.close();
        await controller.settled();
      } else if (mode === 'stop') await controller.stop(stop);
      else if (mode === 'suspend') await controller.stopForRunner('suspend', { handoff: false });
      else await controller.prepareTakeover({ fence: f.spec().fence, person: 'alice' });
      expect(beforeMarkers).toHaveLength(1);
      const before = beforeMarkers[0]!;
      expect(before.finalizedAt).toBeNull();
      expect(before.state).toBe(mode === 'suspend' ? 'suspended' : 'stopped');
      expect(before.pushError).toEqual(failure === 'none' ? null : expect.any(String));
      expect(before.lateWorkSha).toEqual(failure === 'push' ? expect.any(String) : null);
      const record = f.store.get('T-4-a1')!;
      expect(record.finalizedAt).toEqual(expect.any(Number));
      expect(record.pushError).toBe(before.pushError);
      expect(record.lateWorkSha).toBe(before.lateWorkSha);
    });
  }
}

for (const field of ['pushError', 'lateWorkSha'] as const) {
  test(`a failed ${field} write never claims finalization completed`, async () => {
    const f = await createRunnerFixture({
      config: { timings: { finalPush: 1, lateRetry: { base: 60_000, cap: 60_000 } } },
      script: { turns: [[{ do: 'write', path: 'work.txt', content: 'kept\n' }, { do: 'sleep', ms: 30_000 }]] },
    });
    const controller = f.controller();
    await controller.start(f.spec());
    await waitFor(() => existsSync(join(f.paths.clone(FIXTURE_PROJECT, 'T-4-a1'), 'work.txt')));
    await runGit(f.local, [`--git-dir=${f.vault.path}`, 'config', 'remote.origin.url', join(f.home, 'missing-origin')]);
    const update = f.store.update.bind(f.store);
    let refused = false;
    f.store.update = (id, patch) => {
      if (patch[field] != null) {
        refused = true;
        throw new Error(`cannot persist ${field}`);
      }
      return update(id, patch);
    };
    try {
      expect(await controller.stopForRunner('suspend', { handoff: false })).toMatchObject({ ok: true });
      expect(refused).toBe(true);
      expect(f.store.get('T-4-a1')?.finalizedAt).toBeNull();
    } finally {
      f.store.update = update;
    }
  });
}

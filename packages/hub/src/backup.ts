import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { HubContext } from './context';

export function checkIntegrity(ctx: HubContext): void {
  const row = ctx.db.query('PRAGMA integrity_check').get() as { integrity_check: string };
  if (row.integrity_check !== 'ok') throw new Error(`database integrity check failed: ${row.integrity_check}`);
}

/** Writes a consistent snapshot with VACUUM INTO and keeps only the newest `keep` snapshots. */
export function backupDatabase(ctx: HubContext, dir: string, keep = 7): string {
  mkdirSync(dir, { recursive: true });
  const stamp = new Date(ctx.now()).toISOString().replace(/[:.]/g, '-');
  const file = join(dir, `agflow-${stamp}.db`);
  ctx.db.query('VACUUM INTO $file').run({ file });
  const snapshots = readdirSync(dir)
    .filter((name) => name.startsWith('agflow-') && name.endsWith('.db'))
    .sort();
  for (const name of snapshots.slice(0, Math.max(0, snapshots.length - keep))) rmSync(join(dir, name));
  return file;
}

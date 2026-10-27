import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { sweepAuth } from './auth';
import { type BackupKind, backupDatabase, checkIntegrity, dailyBackupDue } from './backup';
import { loadConfig } from './config';
import { createContext } from './context';
import { createApp } from './http/app';
import { sweepLeases } from './tasks';

const { config, port, dbPath, backupDir } = loadConfig(process.env);
mkdirSync(dirname(dbPath), { recursive: true });
const ctx = createContext({ dbPath, config });
checkIntegrity(ctx);

function backup(kind: BackupKind): void {
  try {
    console.log(`backup written to ${backupDatabase(ctx, backupDir, kind)}`);
  } catch (error) {
    console.error(`${kind} backup failed`, error);
  }
}

backup('start');
// A hub restarted more often than every 24 hours never reaches the timer, so a start also writes a missing daily.
if (dailyBackupDue(ctx, backupDir)) backup('daily');
setInterval(() => backup('daily'), 24 * 60 * 60_000);
setInterval(() => {
  try {
    sweepLeases(ctx);
    sweepAuth(ctx);
  } catch (error) {
    console.error('sweep failed', error);
  }
}, 30_000);

const server = Bun.serve({ port, fetch: createApp(ctx).fetch, idleTimeout: 120 });
console.log(`agflow hub for "${config.projectName}" on ${config.publicUrl} (port ${server.port}, sign-in: ${config.auth})`);

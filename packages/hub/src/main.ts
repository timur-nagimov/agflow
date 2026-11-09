import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { type BackupKind, backupDatabase, checkIntegrity, dailyBackupDue } from './backup';
import { loadConfig } from './config';
import { createContext } from './context';
import { startHub } from './server';

const { config, host, port, dbPath, backupDir } = loadConfig(process.env);
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

// The server's own timers sweep sign-ins and dead runner links; its scheduler's tick sweeps the leases, M1's included.
const hub = startHub(ctx, { port, hostname: host, scheduler: 'auto', dbLock: true, timers: true });
console.log(`agflow hub for "${config.projectName}" on ${config.publicUrl} (listening on ${new URL(hub.url).host}, sign-in: ${config.auth})`);

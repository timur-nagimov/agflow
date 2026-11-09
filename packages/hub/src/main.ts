import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { type BackupKind, backupDatabase, checkIntegrity, dailyBackupDue } from './backup';
import { loadConfig } from './config';
import { createContext } from './context';
import { acquireDbLock } from './recovery';
import { startHub } from './server';

const { config, host, port, dbPath, backupDir } = loadConfig(process.env);
mkdirSync(dirname(dbPath), { recursive: true });
// The lock comes before the database is opened: a second hub, or a restore in progress, must not see it touched.
acquireDbLock(dbPath);
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

/** SIGTERM and SIGINT stop the hub and close the database with its WAL checkpointed, then give up the lock. */
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  console.log(`${signal}: stopping the hub`);
  try {
    await hub.stop({ closeDatabase: true });
  } catch (error) {
    console.error('stopping the hub failed', error);
    process.exit(1);
  }
  process.exit(0);
}

process.once('SIGTERM', (signal) => void shutdown(signal));
process.once('SIGINT', (signal) => void shutdown(signal));

// The banner is the process readiness signal: a reader can send a shutdown signal as soon as it appears.
console.log(`agflow hub for "${config.projectName}" on ${config.publicUrl} (listening on ${new URL(hub.url).host}, sign-in: ${config.auth})`);

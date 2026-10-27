import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { sweepAuth } from './auth';
import { backupDatabase, checkIntegrity } from './backup';
import { loadConfig } from './config';
import { createContext } from './context';
import { createApp } from './http/app';
import { sweepLeases } from './tasks';

const { config, port, dbPath, backupDir } = loadConfig(process.env);
mkdirSync(dirname(dbPath), { recursive: true });
const ctx = createContext({ dbPath, config });
checkIntegrity(ctx);

function backup(): void {
  try {
    console.log(`backup written to ${backupDatabase(ctx, backupDir)}`);
  } catch (error) {
    console.error('backup failed', error);
  }
}

backup();
setInterval(backup, 24 * 60 * 60_000);
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

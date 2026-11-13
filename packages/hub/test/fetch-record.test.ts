import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findFetchGrant, grantFetch } from '../src/agent-fetch';
import { backupDatabase } from '../src/backup';
import { createContext } from '../src/context';
import { FETCH_LIMITS } from '../src/fetch-limits';
import { FETCH_RECORD, type FetchRequest, finishFetch, listFetches, recordFetch, trimFetchRecord } from '../src/fetch-record';
import { restoreBackup } from '../src/restore';
import { runRetention } from '../src/retention';
import { createTasks } from '../src/tasks';
import { createTestContext, makeConfig, newTask } from './helpers';

const DAY = 24 * 60 * 60_000;

const asked = (url: string, attemptId = 'T-1-a1'): FetchRequest => ({ attemptId, taskId: 'T-1', agentId: 'A-1', url });
const answered = { finalUrl: 'https://example.com/', status: 200, error: null, bytes: 10, detail: null };

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the record of fetches', () => {
  test('a row is written with the request and gets its outcome when the request ends', () => {
    const { ctx, clock } = createTestContext();
    const at = clock.now();
    const id = recordFetch(ctx, asked('https://example.com/a'));
    const open = { id, at, ...asked('https://example.com/a'), finalUrl: null, status: null, error: null, bytes: 0, detail: null };
    expect(listFetches(ctx)).toEqual([open]);
    clock.advance(3_000);
    finishFetch(ctx, id, answered);
    // The time stays that of the request.
    expect(listFetches(ctx)).toEqual([{ ...open, ...answered }]);
    // A request refused by its URL is whole at once.
    const refused = { finalUrl: null, status: null, error: 'fetch_url_refused', bytes: 0, detail: 'the URL names an IP address' };
    recordFetch(ctx, { ...asked('http://10.0.0.1/'), ...refused });
    expect(listFetches(ctx).at(-1)).toEqual({ id: id + 1, at: clock.now(), ...asked('http://10.0.0.1/'), ...refused });
    expect(listFetches(ctx, { attemptId: 'T-2-a1' })).toEqual([]);
    expect(listFetches(ctx, { attemptId: 'T-1-a1' })).toHaveLength(2);
  });

  test('the URL is kept whole; text from outside is one line, and a site\'s or a failure\'s is cut', () => {
    const { ctx } = createTestContext();
    // The longest URL the route takes: what an agent carries out may be at its end.
    const long = `https://example.com/${'a'.repeat(1954)}?end=the-part-that-matters`;
    expect(long).toHaveLength(2000);
    const id = recordFetch(ctx, asked(long));
    finishFetch(ctx, id, { ...answered, finalUrl: `https://cdn.example.com/${'b'.repeat(600)}` });
    const [kept] = listFetches(ctx);
    expect(kept?.url).toBe(long);
    expect(kept?.finalUrl).toHaveLength(500);
    expect(kept?.finalUrl).toEndWith('…');
    // A line break, a C1 control and an escape character would let a URL or a site forge lines for whoever reads the
    // table in a terminal.
    recordFetch(ctx, {
      ...asked('https://example.com/a\nINSERTED\u0085LINE\u001b[2J '),
      finalUrl: 'https://example.com/b\rforged',
      status: null,
      error: 'fetch_bad_response',
      bytes: 0,
      detail: `could not read\u0085[agflow] forged line\n${'d'.repeat(600)}`,
    });
    const forged = listFetches(ctx).at(-1);
    expect(forged?.url).toBe('https://example.com/a?INSERTED?LINE?[2J?');
    expect(forged?.finalUrl).toBe('https://example.com/b?forged');
    expect(forged?.detail).toStartWith('could not read?[agflow] forged line?ddd');
    expect(forged?.detail).toHaveLength(500);
  });

  test('each new row drops the oldest beyond the row bound', () => {
    const { ctx } = createTestContext();
    const bounds = { ...FETCH_RECORD, maxRows: 3 };
    for (let n = 1; n <= 5; n += 1) recordFetch(ctx, asked(`https://example.com/${n}`, n % 2 ? 'T-1-a1' : 'T-2-a1'), bounds);
    // The bound is the hub's, not an attempt's: another attempt's rows count the same.
    expect(listFetches(ctx).map((row) => row.url)).toEqual(['https://example.com/3', 'https://example.com/4', 'https://example.com/5']);
    // With the hub's own bound nothing goes.
    for (let n = 6; n <= 20; n += 1) recordFetch(ctx, asked(`https://example.com/${n}`));
    expect(listFetches(ctx)).toHaveLength(18);
  });

  test('the daily retention run drops rows past the age bound', () => {
    const { ctx, clock } = createTestContext();
    recordFetch(ctx, asked('https://example.com/old'));
    clock.advance(DAY);
    recordFetch(ctx, asked('https://example.com/newer'));
    clock.advance(FETCH_RECORD.maxAgeMs - DAY - 1);
    expect(runRetention(ctx).fetchesDeleted).toBe(0);
    clock.advance(1);
    expect(runRetention(ctx).fetchesDeleted).toBe(1);
    expect(listFetches(ctx).map((row) => row.url)).toEqual(['https://example.com/newer']);
    clock.advance(DAY);
    expect(trimFetchRecord(ctx)).toBe(1);
    expect(listFetches(ctx)).toEqual([]);
  });

  test('the bounds leave an agent fetching at its limit without a pause two weeks before a row of its own can go', () => {
    // Every recorded request was counted by the rate limit first, so this is the most rows an attempt writes in a day.
    const rowsPerAttemptDay = (FETCH_LIMITS.attemptRequests * DAY) / FETCH_LIMITS.attemptWindowMs;
    expect(rowsPerAttemptDay).toBe(17_280);
    expect(FETCH_RECORD.maxRows / rowsPerAttemptDay).toBeGreaterThanOrEqual(14);
    // The lead and four workers, a default hub's whole staff, all at their limits: still days.
    expect(FETCH_RECORD.maxRows / (5 * rowsPerAttemptDay)).toBeGreaterThanOrEqual(2.5);
    expect(FETCH_RECORD.maxAgeMs).toBe(90 * DAY);
  });

  test("the runbook's query reads the record: newest first, each row with its outcome", () => {
    const runbook = readFileSync(join(import.meta.dir, '../../../docs/deploy-hub.md'), 'utf8');
    // The statement between the quotes of the sqlite3 command under "What agents fetched".
    const query = /sqlite3 -readonly [^\n]*\\\n\s*"(SELECT [^"]*FROM agent_fetches[^"]*)"/.exec(runbook)?.[1];
    if (!query) throw new Error('the runbook shows no query on agent_fetches');
    const { ctx, clock } = createTestContext();
    finishFetch(ctx, recordFetch(ctx, asked('https://example.com/a')), answered);
    clock.advance(1_000);
    recordFetch(ctx, { ...asked('https://inside.example.com/'), finalUrl: null, status: null, error: 'fetch_address_refused', bytes: 0, detail: 'inside.example.com resolves to 10.0.0.5 (private)' });
    recordFetch(ctx, asked('https://example.com/under-way'));
    expect(ctx.db.query(query).all()).toEqual([
      { utc: '2026-10-26 12:00:01', attempt_id: 'T-1-a1', outcome: 'no outcome', bytes: 0, url: 'https://example.com/under-way', final_url: null, detail: null },
      {
        utc: '2026-10-26 12:00:01',
        attempt_id: 'T-1-a1',
        outcome: 'fetch_address_refused',
        bytes: 0,
        url: 'https://inside.example.com/',
        final_url: null,
        detail: 'inside.example.com resolves to 10.0.0.5 (private)',
      },
      { utc: '2026-10-26 12:00:00', attempt_id: 'T-1-a1', outcome: 200, bytes: 10, url: 'https://example.com/a', final_url: 'https://example.com/', detail: null },
    ]);
    // The filters it names are columns of the table.
    const filters = [...runbook.matchAll(/`WHERE ([a-z_]+) = '[^'`]*'`/g)].map((match) => match[1] as string);
    expect(filters).toEqual(['task_id', 'agent_id', 'error']);
    for (const column of filters) {
      expect(() => ctx.db.query(`SELECT COUNT(*) AS n FROM agent_fetches WHERE ${column} = 'x'`).get()).not.toThrow();
    }
  });

  test('a backup carries the record and the grants, and a restore brings both back as the backup had them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agflow-fetch-record-'));
    dirs.push(dir);
    const dbPath = join(dir, 'agflow.db');
    const backupDir = join(dir, 'backups');
    mkdirSync(backupDir);
    const now = Date.UTC(2026, 10, 13, 12, 0, 0);
    const ctx = createContext({ dbPath, config: makeConfig({ agentFetch: true }), now: () => now });
    const [task] = createTasks(ctx, [newTask()], 'user:alice');
    if (!task) throw new Error('no task');
    grantFetch(ctx, task.id, 'user:alice', 'needs the public price list');
    finishFetch(ctx, recordFetch(ctx, asked('https://example.com/before-the-backup')), answered);
    const backupPath = backupDatabase(ctx, backupDir, 'start').file;
    finishFetch(ctx, recordFetch(ctx, asked('https://example.com/after-the-backup')), answered);
    ctx.db.close();
    const { aside } = restoreBackup({ dbPath, backupPath, now: now + 60_000 });
    const restored = createContext({ dbPath, config: makeConfig({ agentFetch: true }), now: () => now + 120_000 });
    try {
      expect(listFetches(restored).map((row) => [row.url, row.status, row.at])).toEqual([['https://example.com/before-the-backup', 200, now]]);
      expect(findFetchGrant(restored, task.id)?.reason).toBe('needs the public price list');
    } finally {
      restored.db.close();
    }
    // What the hub fetched after the backup is on record only in the database the restore put aside.
    const replaced = new Database(aside as string, { readonly: true });
    try {
      expect(replaced.query('SELECT url FROM agent_fetches ORDER BY id').all()).toEqual([
        { url: 'https://example.com/before-the-backup' },
        { url: 'https://example.com/after-the-backup' },
      ]);
    } finally {
      replaced.close();
    }
  });
});

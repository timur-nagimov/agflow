// The record of what the hub fetched for agents (design 5, Unattended options): table agent_fetches, one row for every
// request the hub made or refused by its URL and address rules. The attempt log shows the same requests where people
// look at an attempt, but it keeps only an attempt's newest entries, so the agent's own later activity pushes a fetch
// out of it. This record is the durable one: nothing an agent does writes to it except a fetch, and no route reads it.
// People query the table on the hub (docs/deploy-hub.md, Unattended operation).
import { type HubContext, tx } from './context';
import { clip, oneLine } from './text';

const DAY = 24 * 60 * 60_000;

export interface FetchRecordBounds {
  maxAgeMs: number;
  maxRows: number;
}

/**
 * The record's bounds. Rows older than maxAgeMs go in the daily retention run (design 6.18), and each new row drops
 * the oldest beyond maxRows, so the table stays bounded whatever agents do.
 *
 * Both are far more than an agent writes in days, so an agent cannot bury a request under later ones, as it can in the
 * attempt log. A request reaches the record only once the rate limit has counted it (fetch-limits.ts: 120 for an
 * attempt in any 10 minutes), and it leaves one row, so an attempt adds at most 17,280 rows a day. One agent fetching
 * at its limit without a pause needs 14 days to push a row out. The lead and four workers, a default hub's whole
 * staff, need almost 3 days when all of them do. A row takes a few hundred bytes with an ordinary URL and a few
 * kilobytes with the longest the route accepts, so the full table is tens of megabytes as a rule.
 */
export const FETCH_RECORD: Readonly<FetchRecordBounds> = Object.freeze({ maxAgeMs: 90 * DAY, maxRows: 250_000 });

/** The most the record keeps of where the redirects ended. The site chose it; its start says where the hub went. */
const FINAL_URL_MAX = 500;
/** The most the record keeps of a failure's words. */
const DETAIL_MAX = 500;

/** Who asked for what. */
export interface FetchRequest {
  attemptId: string;
  /** Null for a lead's attempt. */
  taskId: string | null;
  agentId: string;
  /**
   * The URL as the agent sent it. It is kept whole: the URL is what an agent could carry data out in, at its end as
   * well as at its start. Only control characters are replaced, and a URL that holds one is refused before any request.
   */
  url: string;
}

/** How a request ended. */
export interface FetchOutcome {
  /** Where the redirects ended; null when the site gave no answer. */
  finalUrl: string | null;
  /** The site's HTTP status; null when it gave no answer. */
  status: number | null;
  /** Without an answer, the error code the agent was answered, such as fetch_address_refused; null with a status. */
  error: string | null;
  /** Bytes of the body handed to the agent. */
  bytes: number;
  /** A failure in words, with what only people may read: the address a refused name resolves to. */
  detail: string | null;
}

/** One row. A request under way, or one whose end the hub did not live to record, has neither a status nor an error. */
export interface FetchRecord extends FetchRequest, FetchOutcome {
  id: number;
  /** When the request was made. */
  at: number;
}

interface FetchRow {
  id: number;
  at: number;
  attempt_id: string;
  task_id: string | null;
  agent_id: string;
  url: string;
  final_url: string | null;
  status: number | null;
  error: string | null;
  bytes: number;
  detail: string | null;
}

const UNDER_WAY: FetchOutcome = { finalUrl: null, status: null, error: null, bytes: 0, detail: null };

/** The outcome as the table holds it: text from a site or a failure on one line, and cut. */
const stored = (outcome: FetchOutcome) => ({
  finalUrl: outcome.finalUrl === null ? null : clip(oneLine(outcome.finalUrl), FINAL_URL_MAX),
  status: outcome.status,
  error: outcome.error,
  bytes: outcome.bytes,
  detail: outcome.detail === null ? null : clip(oneLine(outcome.detail), DETAIL_MAX),
});

/**
 * Writes the row of a request and returns its id: with its outcome when the hub refused it outright, without one when
 * the hub is about to make it (finishFetch adds the outcome). The oldest rows beyond the row bound go with the insert.
 */
export function recordFetch(
  ctx: HubContext,
  entry: FetchRequest & Partial<FetchOutcome>,
  bounds: FetchRecordBounds = FETCH_RECORD,
): number {
  return tx(ctx, () => {
    const inserted = ctx.db
      .query(
        `INSERT INTO agent_fetches (at, attempt_id, task_id, agent_id, url, final_url, status, error, bytes, detail)
         VALUES ($at, $attemptId, $taskId, $agentId, $url, $finalUrl, $status, $error, $bytes, $detail)`,
      )
      .run({
        at: ctx.now(),
        attemptId: entry.attemptId,
        taskId: entry.taskId,
        agentId: entry.agentId,
        url: oneLine(entry.url),
        ...stored({ ...UNDER_WAY, ...entry }),
      });
    const id = Number(inserted.lastInsertRowid);
    ctx.db.query('DELETE FROM agent_fetches WHERE id <= $oldest').run({ oldest: id - bounds.maxRows });
    return id;
  });
}

/** Writes how the request of a row ended. */
export function finishFetch(ctx: HubContext, id: number, outcome: FetchOutcome): void {
  ctx.db
    .query(
      `UPDATE agent_fetches SET final_url = $finalUrl, status = $status, error = $error, bytes = $bytes, detail = $detail
       WHERE id = $id`,
    )
    .run({ id, ...stored(outcome) });
}

/** The record, oldest first; of one attempt when the filter names it. */
export function listFetches(ctx: HubContext, filter: { attemptId?: string | undefined } = {}): FetchRecord[] {
  const rows = (
    filter.attemptId === undefined
      ? ctx.db.query('SELECT * FROM agent_fetches ORDER BY id').all()
      : ctx.db.query('SELECT * FROM agent_fetches WHERE attempt_id = $attemptId ORDER BY id').all({ attemptId: filter.attemptId })
  ) as FetchRow[];
  return rows.map((row) => ({
    id: row.id,
    at: row.at,
    attemptId: row.attempt_id,
    taskId: row.task_id,
    agentId: row.agent_id,
    url: row.url,
    finalUrl: row.final_url,
    status: row.status,
    error: row.error,
    bytes: row.bytes,
    detail: row.detail,
  }));
}

/** Drops the rows past the age bound, as the daily retention run does. Returns how many went. */
export function trimFetchRecord(ctx: HubContext, bounds: FetchRecordBounds = FETCH_RECORD): number {
  return ctx.db.query('DELETE FROM agent_fetches WHERE at <= $cutoff').run({ cutoff: ctx.now() - bounds.maxAgeMs }).changes;
}

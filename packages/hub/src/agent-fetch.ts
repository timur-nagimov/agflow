// Internet for runner agents, through the hub (design 5, Unattended options). Agents have no network of their own, and
// that stays: with AGFLOW_AGENT_FETCH on, the hub downloads one public URL at a time for a Claude agent and hands the
// bytes back. The lead may always ask; a worker may once the lead, or a person, granted its task. This module holds
// the grants and POST /api/fetch: who may ask, the rate limits (fetch-limits.ts) and the audit trail (the record of
// fetch-record.ts, and the attempt's log). The request itself is public-fetch.ts.
import { createHash } from 'node:crypto';
import { type Attempt, type FetchedUrl, type Task, isClosed, quoteLines } from '@agflow/core';
import { LOG_SUMMARY_MAX, appendAttemptLog } from './attempt-store';
import { resolveAgentToken } from './auth';
import { FETCH_RULES } from './brief';
import { type HubContext, tx } from './context';
import { HubError, conflict } from './errors';
import { FETCH_LIMITS } from './fetch-limits';
import { type FetchOutcome, type FetchRequest, finishFetch, recordFetch } from './fetch-record';
import { holdsSeat } from './hub-state';
import { insertMessage } from './messages';
import { FetchRefusal, parseFetchUrl } from './public-address';
import { type PublicFetchFailure, PublicFetchError, type PublicFetchResult, fetchPublicUrl } from './public-fetch';
import { endFetchGrant, findTask, getTask } from './task-store';
import { clip, oneLine } from './text';

/** 403 while AGFLOW_AGENT_FETCH is off: granting and POST /api/fetch answer it. Taking a grant back still works. */
export const fetchDisabled = () =>
  new HubError(
    403,
    'fetch_disabled',
    'internet access for agents is off on this hub (AGFLOW_AGENT_FETCH is not 1), so nothing can be fetched or ' +
      'granted. Work with what the repository holds; if the task cannot be done without outside data, tell the lead ' +
      'or declare it blocked.',
  );

export function requireAgentFetch(ctx: HubContext): void {
  if (!ctx.config.agentFetch) throw fetchDisabled();
}

export interface FetchGrant {
  taskId: string;
  /** agent:<id> for the lead, user:<login> for a person. */
  grantedBy: string;
  reason: string;
  grantedAt: number;
}

interface FetchGrantRow {
  task_id: string;
  granted_by: string;
  reason: string;
  granted_at: number;
}

export function findFetchGrant(ctx: HubContext, taskId: string): FetchGrant | null {
  const row = ctx.db.query('SELECT * FROM task_fetch_grants WHERE task_id = $taskId').get({ taskId }) as FetchGrantRow | null;
  return row ? { taskId: row.task_id, grantedBy: row.granted_by, reason: row.reason, grantedAt: row.granted_at } : null;
}

/**
 * What the task's agent is told once fetch_url works for it. The reason is its author's text, so it is quoted. Only
 * the agent assigned at that moment gets it; the task's pack tells every later one (brief.ts, composeTaskPack).
 */
const grantNotice = (task: Task, actor: string, reason: string): string =>
  `${actor} granted ${task.id} internet access: fetch_url(url, save_as) now works for this task, for Claude agents. ` +
  `${FETCH_RULES}\nThe reason given for the grant:\n${quoteLines(reason)}`;

/**
 * POST /api/tasks/:id/fetch-grant: the task's Claude agents may use POST /api/fetch from now on. The caller is the seat
 * holder or a person (the route checks). A task that holds a grant keeps it as it is: no second event or message.
 */
export function grantFetch(ctx: HubContext, taskId: string, actor: string, reason: string): Task {
  requireAgentFetch(ctx);
  return tx(ctx, (emit) => {
    const task = getTask(ctx, taskId);
    if (findFetchGrant(ctx, taskId)) return task;
    if (isClosed(task.status)) throw conflict(`${taskId} is ${task.status}; nobody works on it any more`);
    ctx.db
      .query('INSERT INTO task_fetch_grants (task_id, granted_by, reason, granted_at) VALUES ($taskId, $actor, $reason, $now)')
      .run({ taskId, actor, reason, now: ctx.now() });
    emit({ type: 'task.fetch_granted', actor, subject: taskId, data: { taskId, by: actor, reason } });
    if (task.assignee) {
      insertMessage(ctx, emit, { from: 'system', to: `agent:${task.assignee}`, taskId, body: grantNotice(task, actor, reason) });
    }
    return getTask(ctx, taskId);
  });
}

/**
 * DELETE /api/tasks/:id/fetch-grant: the next fetch for the task is refused. Nothing to revoke changes nothing. It
 * works whatever AGFLOW_AGENT_FETCH says: taking access away is always safe.
 */
export function revokeFetch(ctx: HubContext, taskId: string, actor: string): Task {
  return tx(ctx, (emit) => {
    getTask(ctx, taskId);
    endFetchGrant(ctx, emit, taskId, actor);
    return getTask(ctx, taskId);
  });
}

/**
 * A hub that starts with AGFLOW_AGENT_FETCH off ends the grants it finds, each as a revoke by the system, and names
 * their tasks in one log line. A grant that slept through the off period would let its task fetch again the moment
 * the setting came back, with nobody having decided so. Returns the tasks whose grants ended.
 */
export function endGrantsWhileOff(ctx: HubContext): string[] {
  if (ctx.config.agentFetch) return [];
  const ended = tx(ctx, (emit) => {
    const rows = ctx.db.query('SELECT task_id FROM task_fetch_grants ORDER BY granted_at, task_id').all() as { task_id: string }[];
    return rows.map((row) => row.task_id).filter((taskId) => endFetchGrant(ctx, emit, taskId, 'system'));
  });
  if (ended.length > 0) console.log(`AGFLOW_AGENT_FETCH is off: ended the internet access of ${ended.join(', ')}`);
  return ended;
}

// ---------------------------------------------------------------------------
// POST /api/fetch
// ---------------------------------------------------------------------------

/**
 * Codex's sandbox does not keep its agent from reading most of what the owner can (design 5, Reads), and only the
 * missing network contains that. So a Codex agent gets no way to send anything out, grant or no grant.
 */
const vendorRefused = () =>
  new HubError(
    403,
    'fetch_vendor_refused',
    'fetch_url works only for Claude agents: a Codex agent can read files outside its clone, so agflow gives it no ' +
      'way to send anything out. If the task needs data from outside, tell the lead with send_message which sites ' +
      'and why; the lead can fetch it or give the work to a Claude agent.',
  );

/**
 * A stop request ends the fetching at once (design 5, Unattended options), as it ends the agent's other requests
 * (prepare.ts, tasks.ts requireHolder): the attempt itself stays open until its agent exits or the stop times out,
 * and an agent told to stop has no more use for outside data. A cancel of its task and its own release are stops too.
 */
const attemptStopping = (attemptId: string) =>
  new HubError(
    409,
    'fetch_attempt_stopping',
    `your attempt ${attemptId} is being stopped, so nothing more is fetched for it. Write a handoff note if you have ` +
      'not, and stop.',
  );

const notGranted = (message: string) => new HubError(403, 'fetch_not_granted', message);

/** What an agent does once the work is no longer its own. */
const STOP_ADVICE = 'Write a handoff note if you have not, and stop.';

/**
 * A worker fetches on its task's grant, and only while the work is its own: the task is open and this attempt is the
 * one the task names. A grant made for a task is no licence for an attempt the task has left behind, nor for work
 * that is over.
 */
function requireGrant(ctx: HubContext, attempt: Attempt): void {
  const task = attempt.taskId === null ? null : findTask(ctx, attempt.taskId);
  if (!task) throw notGranted('only the lead, or the agent of a task the lead granted internet access, can fetch.');
  if (isClosed(task.status)) {
    throw notGranted(`${task.id} is ${task.status}, so nothing more is fetched for it. ${STOP_ADVICE}`);
  }
  if (task.currentAttempt !== attempt.id) {
    throw notGranted(`your attempt ${attempt.id} no longer holds ${task.id}, so nothing is fetched for it. ${STOP_ADVICE}`);
  }
  if (!findFetchGrant(ctx, task.id)) {
    throw notGranted(
      `${task.id} has no internet access. Ask the lead with send_message (to "lead"): say which sites you need ` +
        'and why. fetch_url works once the lead grants it; you get a message when it does.',
    );
  }
}

const rateLimited = (retryInMs: number) =>
  new HubError(
    429,
    'fetch_rate_limited',
    `this attempt made ${FETCH_LIMITS.attemptRequests} requests in the last ` +
      `${FETCH_LIMITS.attemptWindowMs / 60_000} minutes, the most agflow allows. Try again in about ` +
      `${Math.max(1, Math.ceil(retryInMs / 1000))} seconds, and fetch only what the task needs.`,
  );

const busy = () =>
  new HubError(
    429,
    'fetch_busy',
    'too many fetches are under way at once. Wait for your earlier fetch_url calls to answer, then try again.',
  );

const hostBusy = (host: string) =>
  new HubError(
    429,
    'fetch_host_busy',
    `${host} already has requests waiting: agflow leaves a second between two requests to one site. Try again in a ` +
      'few seconds.',
  );

/** The failures that are the hub's refusal; the rest are the site's or the network's. */
const REFUSALS: readonly PublicFetchFailure[] = ['url_refused', 'address_refused'];

/**
 * The agent's answer to a fetch that gave none. A failure's words may hold text of the site's or the network's (an
 * error of the connection), so they reach the agent on one line, as they reach the log and the record: nothing in
 * them can pose as a line of the hub's.
 */
const answerFor = (error: PublicFetchError): HubError =>
  new HubError(
    REFUSALS.includes(error.code) ? 400 : error.code === 'timeout' ? 504 : 502,
    `fetch_${error.code}`,
    oneLine(error.message),
  );

/** Where the redirects ended. The site chose it, so only its start is shown: it says where the hub went. */
const shownUrl = (url: string): string => clip(oneLine(url), 500);

/** The outcome never grows past this, so the line that carries it is never clipped by the log. */
const OUTCOME_MAX = 1500;

/**
 * The audit trail where people look at an attempt (design 5): every request the hub made or refused to make is on the
 * attempt's log, with the whole URL the agent sent, since the URL is what an agent could carry data out in, at its end
 * as well as at its start. The URL shares a line with the outcome when both fit the log's line. A longer one follows
 * on a line of its own, and the first line gives its length and SHA-256: they tell a reader that nothing is missing,
 * and name a URL the log had to cut (one past the route's bound of 2000 characters). The log keeps only an attempt's
 * newest entries, so the trail that lasts is the record (fetch-record.ts); a line that cannot be written costs the
 * agent nothing, since the record holds the request.
 */
function logFetch(ctx: HubContext, attemptId: string, url: string, outcome: string): void {
  const shown = oneLine(url);
  // The outcome holds a site's and the network's words as well as the hub's, so it is one line like the URL.
  const result = clip(oneLine(outcome), OUTCOME_MAX);
  const line = `fetch GET ${shown}: ${result}`;
  try {
    tx(ctx, () => {
      if (line.length <= LOG_SUMMARY_MAX) {
        appendAttemptLog(ctx, attemptId, 'note', line);
        return;
      }
      const digest = createHash('sha256').update(url).digest('hex');
      const where = `a URL of ${url.length} characters, SHA-256 ${digest}, on the next line`;
      appendAttemptLog(ctx, attemptId, 'note', `fetch GET (${where}): ${result}`);
      appendAttemptLog(ctx, attemptId, 'note', shown);
    });
  } catch (error) {
    console.error(`logging a fetch of attempt ${attemptId} failed`, error);
  }
}

/** A request that got no answer: its words in the attempt's log, and its outcome on the record. */
interface FetchFailure {
  line: string;
  outcome: FetchOutcome;
}

function failureOf(error: unknown): FetchFailure {
  /** code: as the log names the failure; answered: the error code the agent got, which the record keeps. */
  const told = (verdict: 'refused' | 'failed', code: string, answered: string, words: string): FetchFailure => ({
    line: `${verdict} (${code}), 0 bytes: ${words}`,
    outcome: { finalUrl: null, status: null, error: answered, bytes: 0, detail: words },
  });
  if (error instanceof PublicFetchError) {
    // What the agent was told and, in brackets, what only people may read.
    const words = `${error.message}${error.detail === null ? '' : ` [${error.detail}]`}`;
    return told(REFUSALS.includes(error.code) ? 'refused' : 'failed', error.code, `fetch_${error.code}`, words);
  }
  // A redirect led to a host whose slot is too far away: the first hop was made by then.
  if (error instanceof HubError) return told('failed', error.code, error.code, error.message);
  // A fault of the hub's own: the site may have the URL, whatever the hub made of its answer.
  return told('failed', 'internal', 'internal', 'the hub could not finish the request');
}

/**
 * POST /api/fetch: the hub downloads one public URL for the runner agent the token names. Checked in this order, each
 * with its own answer: the setting is on; the attempt is open (the token is resolved again, as the body arrived after
 * the route resolved it); nobody asked it to stop; the attempt is Claude's; the agent holds the lead seat, or its open
 * task names this attempt and holds a grant; the rate limits. Then one GET (public-fetch.ts), on record from before it
 * leaves (fetch-record.ts) and on the attempt's log once it ended, and the bytes. A fetch under way when a stop is
 * asked for runs to its end, within the fetch's own time limit.
 */
export async function fetchForAgent(ctx: HubContext, token: string, rawUrl: string): Promise<FetchedUrl> {
  requireAgentFetch(ctx);
  const { agent, attempt } = resolveAgentToken(ctx, token);
  if (attempt.stopRequested) throw attemptStopping(attempt.id);
  if (attempt.vendor !== 'claude') throw vendorRefused();
  if (!holdsSeat(ctx, agent.id)) requireGrant(ctx, attempt);
  const { limiter, sleep, resolve, transport, limits } = ctx.agentFetch;
  if (!limiter.enter(attempt.id)) throw busy();
  try {
    const retryIn = limiter.admit(attempt.id);
    if (retryIn !== null) throw rateLimited(retryIn);
    /** Takes the host's next slot and waits for it; 429 when it is more than a few seconds away. */
    const takeSlot = async (host: string): Promise<void> => {
      const wait = limiter.reserveHost(host);
      if (wait === null) throw hostBusy(host);
      await sleep(wait);
    };
    const asked: FetchRequest = { attemptId: attempt.id, taskId: attempt.taskId, agentId: agent.id, url: rawUrl };
    let url: URL;
    try {
      url = parseFetchUrl(rawUrl);
    } catch (error) {
      if (!(error instanceof FetchRefusal)) throw error;
      const refusal = new PublicFetchError('url_refused', error.message);
      const failure = failureOf(refusal);
      recordFetch(ctx, { ...asked, ...failure.outcome });
      logFetch(ctx, attempt.id, rawUrl, failure.line);
      throw answerFor(refusal);
    }
    await takeSlot(url.hostname);
    // The request is on record before anything of it leaves the hub, its host name to the resolver included, and it
    // does not leave when the record cannot be written. A hub stopped in the middle still names what went out.
    const recordId = recordFetch(ctx, asked);
    /** The request's end, on the record and in the attempt's log. A failure here never costs the agent its answer. */
    const settle = (outcome: FetchOutcome, line: string): void => {
      try {
        finishFetch(ctx, recordId, outcome);
      } catch (error) {
        console.error(`recording how fetch ${recordId} of attempt ${attempt.id} ended failed`, error);
      }
      logFetch(ctx, attempt.id, rawUrl, line);
    };
    let result: PublicFetchResult;
    try {
      result = await fetchPublicUrl({ resolve, transport }, url.href, {
        ...limits,
        beforeHop: (next) => takeSlot(next.hostname),
      });
    } catch (error) {
      const failure = failureOf(error);
      settle(failure.outcome, failure.line);
      throw error instanceof PublicFetchError ? answerFor(error) : error;
    }
    const from = result.finalUrl === url.href ? '' : `, from ${shownUrl(result.finalUrl)}`;
    settle(
      { finalUrl: result.finalUrl, status: result.status, error: null, bytes: result.bytes, detail: null },
      `${result.status}, ${result.bytes} bytes${from}`,
    );
    return {
      status: result.status,
      finalUrl: result.finalUrl,
      contentType: result.contentType,
      bytes: result.bytes,
      sha256: result.sha256,
      bodyBase64: Buffer.from(result.body.buffer, result.body.byteOffset, result.body.byteLength).toString('base64'),
    };
  } finally {
    limiter.leave(attempt.id);
  }
}

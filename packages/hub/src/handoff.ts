// Assembled handoff notes (design 6.8, 6.11): when an attempt ends without writing its own, or ends in a way that always
// asks for one, the hub puts one together from what it recorded, for the successor or, for a lead, the next lead.
// Only the hub's framing and the goal, which only people set and which the lead's brief also shows as is, are
// unquoted; every other part an agent or a person wrote is quoted under a line naming where it came from.
import { type Attempt, type Message, type TaskNote, formatMessage, quoteLines } from '@agflow/core';
import { unpushedHead } from './attempt-store';
import { BRIEF_HANDOFF_LIMIT, newestLeadHandoff, situationReport } from './brief';
import type { HubContext } from './context';
import { getCurrentGoal } from './goal';
import { insertLeadNote } from './hub-state';
import { type MessageRow, listMessages, rowToMessage } from './messages';
import { getTask, listTaskNotes } from './task-store';
import { clip, quotedWithin } from './text';

/** The most an assembled note takes, its closing line included. */
export const HANDOFF_NOTE_LIMIT = 12_000;

/** An assembled note, ready to store as a task note or a lead note. */
export interface AssembledNote {
  author: 'system';
  body: string;
}

const CLOSING =
  'No handoff note was written; the next step is unknown. Read the transcript tail and the commits before continuing.';
const LEAD_CLOSING =
  'No lead handoff was written, so what the lead planned next is unknown. Read the task list and the open submissions ' +
  'before you act.';

/**
 * Each part's share. With the hub's framing they add up to less than the room the transcript tail and the closing
 * line leave, so every part keeps its place however long the others are. The task pack holds the whole contract, so
 * the objective gets little; quote marks count toward each share.
 */
const LIMITS = {
  title: 200,
  objective: 600,
  /** All the handoff notes shown, together. */
  handoffs: 1000,
  progress: 200,
  wipLog: 1000,
  message: 200,
  compaction: 1000,
  /** About the last 3 assistant turns (design 6.8). */
  transcript: 4000,
  /** The next lead's brief carries the whole goal. */
  goal: 800,
  leadMessage: 180,
} as const;

const HANDOFFS_SHOWN = 3;
const PROGRESS_SHOWN = 5;
const TASK_MESSAGES_SHOWN = 5;
const LEAD_MESSAGES_SHOWN = 20;

/** The last size characters of a text, marked as cut when they are not all of it. */
const tailOf = (text: string, size: number): string =>
  text.length <= size ? text : `…${text.slice(text.length - size + 1)}`;

/**
 * The end of a text, quoted, in at most max characters: a transcript's newest turns matter most. The quote marks
 * count toward max, so the longest tail that still fits once quoted is searched for.
 */
function quotedTail(text: string, max: number): string {
  let low = 0;
  let high = Math.min(text.length, max);
  while (low < high) {
    const size = Math.ceil((low + high) / 2);
    if (quoteLines(tailOf(text, size)).length <= max) low = size;
    else high = size - 1;
  }
  return quoteLines(tailOf(text, low));
}

/** A duration for people: seconds under a minute, minutes under two hours, then hours. */
function duration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  if (ms < 2 * 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${Number((ms / 3_600_000).toFixed(1))} h`;
}

const at = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/** A message as agents read it, its quoted body in at most max characters: the header names the sender. */
function shownMessage(message: Message, max: number): string {
  const [header] = formatMessage({ ...message, body: '' }).split('\n');
  return `${header}\n${quotedWithin(message.body, max)}`;
}

/** Where the newest work is when an attempt's final push failed: on its runner only, until late work brings it. */
function unpushedLine(unpushed: { runnerId: string; sha: string }): string {
  const { runnerId, sha } = unpushed;
  return (
    `Its last commit, ${sha}, is only on runner ${runnerId}: its final push failed. A successor on ${runnerId} ` +
    `starts from it; agflow records it as late work once ${runnerId} pushes it.`
  );
}

/** What the attempt row keeps that the Attempt view leaves out. */
function recorded(ctx: HubContext, attemptId: string): { compaction: string | null; transcript: string | null } {
  const row = ctx.db
    .query('SELECT compaction_summary, transcript_tail FROM attempts WHERE id = $id')
    .get({ id: attemptId }) as { compaction_summary: string | null; transcript_tail: string | null } | null;
  return { compaction: row?.compaction_summary ?? null, transcript: row?.transcript_tail ?? null };
}

/** The git log --stat of the attempt's newest WIP push, from its attempt.wip event (X-3). */
function newestWipLog(ctx: HubContext, attemptId: string): string | null {
  const row = ctx.db
    .query(
      `SELECT json_extract(data, '$.logStat') AS log_stat FROM events
       WHERE type = 'attempt.wip' AND json_extract(data, '$.attemptId') = $attemptId ORDER BY id DESC LIMIT 1`,
    )
    .get({ attemptId }) as { log_stat: string | null } | null;
  return row?.log_stat ?? null;
}

/** Sections joined, cut to the room, then the closing line, which no amount of quoted text can push out. */
function closeNote(sections: string[], tail: string | null, closing: string): AssembledNote {
  const end = tail === null ? `\n\n${closing}` : `\n\n${tail}\n\n${closing}`;
  return { author: 'system', body: `${clip(sections.join('\n\n'), HANDOFF_NOTE_LIMIT - end.length)}${end}` };
}

/**
 * Whether the attempt wrote a handoff: a task's handoff note for a worker, a lead handoff for a lead. A note that
 * carries the attempt's id counts whoever wrote it, so a note the hub assembled for it counts too and is never
 * assembled twice; one without an id counts when its agent wrote it since the attempt started. The hub assembles a
 * note only when none counts.
 */
export function handoffWritten(ctx: HubContext, attempt: Attempt): boolean {
  const params = { author: `agent:${attempt.agentId}`, attemptId: attempt.id, since: attempt.startedAt };
  const ours = '(attempt_id = $attemptId OR (attempt_id IS NULL AND author = $author AND created_at >= $since))';
  if (attempt.taskId === null) {
    return ctx.db.query(`SELECT 1 FROM lead_notes WHERE kind = 'handoff' AND ${ours} LIMIT 1`).get(params) !== null;
  }
  return (
    ctx.db
      .query(`SELECT 1 FROM task_notes WHERE task_id = $taskId AND kind = 'handoff' AND ${ours} LIMIT 1`)
      .get({ ...params, taskId: attempt.taskId }) !== null
  );
}

/** Notes the attempt's agent wrote in this attempt: those carrying its id, or, without an id, written since it began. */
const writtenIn = (attempt: Attempt, note: TaskNote): boolean =>
  note.author === `agent:${attempt.agentId}` &&
  (note.attemptId === attempt.id || (note.attemptId === null && note.createdAt >= attempt.startedAt));

/**
 * The successor's note for a worker attempt (design 6.8): the attempt, what the agent left behind (its own handoff
 * notes first, its last progress notes, its WIP's commits, its compaction summary and its transcript tail), the task
 * and the last messages about it. An ending that always asks for a note may come after the agent wrote its own: the
 * note then says so, and leads with it. Pass the attempt as ended, so its end reason is known.
 */
export function assembleHandoffNote(ctx: HubContext, attempt: Attempt): AssembledNote {
  const task = getTask(ctx, attempt.taskId as string);
  const source = `agent ${attempt.agentId} in attempt ${attempt.id}`;
  const runner = attempt.runnerId ? `on runner ${attempt.runnerId}` : 'in a live chat';
  const model = attempt.model ? `model ${attempt.model}` : 'model not reported';
  const ran = duration((attempt.endedAt ?? ctx.now()) - attempt.startedAt);
  const ended = attempt.endReason ? `ended ${attempt.endReason}` : 'has not ended yet';
  const notes = listTaskNotes(ctx, task.id).filter((note) => writtenIn(attempt, note));
  const handoffs = notes.filter((note) => note.kind === 'handoff').slice(-HANDOFFS_SHOWN);
  const lastHandoff = handoffs.at(-1);
  const intro = lastHandoff
    ? `The previous attempt at ${task.id} ${ended}; agflow put this note together from what it recorded, including ` +
      "the agent's own handoff notes."
    : `The previous attempt at ${task.id} ${ended} without a handoff note, so agflow put this one together from what ` +
      'it recorded.';
  // A failed final push leaves the newest work on one runner only (design 6.8, Replacement step 4).
  const unpushed = unpushedHead(ctx, task, attempt);
  const sections = [
    `# Handoff note assembled by agflow\n${intro} Everything quoted below was written by the agent, a person or a ` +
      'tool, not by agflow.',
    `## The previous attempt\n${attempt.id} by agent ${attempt.agentId} ${runner}: ${attempt.vendor}, ${model}, ran ` +
      `${ran}, ${ended}.${unpushed ? `\n${unpushedLine(unpushed)}` : ''}`,
  ];
  if (handoffs.length > 0) {
    const each = Math.floor(LIMITS.handoffs / handoffs.length);
    sections.push(
      `## Handoff notes by ${source}, newest first\n` +
        [...handoffs]
          .reverse()
          .map((note) => `Written ${at(note.createdAt)}:\n${quotedWithin(note.body, each)}`)
          .join('\n'),
    );
  }
  // The task as it stands: the lead may have rewritten a person's title or objective, so no author is named.
  sections.push(
    `## Task ${task.id}\nTitle:\n${quotedWithin(task.title, LIMITS.title)}\n` +
      `Objective:\n${quotedWithin(task.objective, LIMITS.objective)}`,
  );
  const progress = notes.filter((note) => note.kind === 'progress').slice(-PROGRESS_SHOWN);
  if (progress.length > 0) {
    sections.push(
      `## The last progress notes by ${source}, newest first\n` +
        [...progress]
          .reverse()
          .map((note) => `Reported ${at(note.createdAt)}:\n${quotedWithin(note.body, LIMITS.progress)}`)
          .join('\n'),
    );
  }
  const wipLog = newestWipLog(ctx, attempt.id);
  if (wipLog) {
    sections.push(
      `## Commits on the WIP since main (git log --stat), as ${source} last pushed them\n` +
        quotedWithin(wipLog, LIMITS.wipLog),
    );
  }
  const messages = listMessages(ctx, { taskId: task.id, limit: TASK_MESSAGES_SHOWN });
  if (messages.length > 0) {
    sections.push(
      `## The last messages about ${task.id}, newest first\n` +
        messages.map((message) => shownMessage(message, LIMITS.message)).join('\n\n'),
    );
  }
  const { compaction, transcript } = recorded(ctx, attempt.id);
  if (compaction) sections.push(`## Compaction summary of ${source}\n${quotedWithin(compaction, LIMITS.compaction)}`);
  // The transcript tail comes last and has its room kept, so the other parts can only shorten each other.
  const tail = transcript ? `## Transcript tail of ${source}\n${quotedTail(transcript, LIMITS.transcript)}` : null;
  const closing = lastHandoff
    ? `The agent's last handoff note, written ${at(lastHandoff.createdAt)}, is quoted above; check it against the ` +
      'transcript tail and the commits before continuing.'
    : CLOSING;
  return closeNote(sections, tail, closing);
}

/** The agents that held the lead seat on an attempt, as message senders and targets. */
function leadAgents(ctx: HubContext, attempt: Attempt): string[] {
  const rows = ctx.db.query("SELECT DISTINCT agent_id FROM attempts WHERE role = 'lead'").all() as {
    agent_id: string;
  }[];
  return [...new Set([attempt.agentId, ...rows.map((row) => row.agent_id)])].map((id) => `agent:${id}`);
}

/**
 * The next lead's note when a lead ended without a lead handoff (design 6.11, failover): the last 20 messages to and
 * from the lead, the lead's earlier messages since the newest lead handoff, that handoff itself, the situation report
 * and the goal. What only this note carries comes first, newest first: the next lead's brief quotes only the newest
 * lead handoff, which this note becomes, and only its start, and also shows the situation report and the whole goal,
 * so a cut falls on the oldest material and then on what the brief has anyway.
 */
export function assembleLeadHandoff(ctx: HubContext, attempt: Attempt): AssembledNote {
  const leads = JSON.stringify(leadAgents(ctx, attempt));
  const ended = attempt.endReason ? `ended ${attempt.endReason}` : 'has not ended yet';
  const sections = [
    '# Lead handoff assembled by agflow\n' +
      `The previous lead, agent ${attempt.agentId} in attempt ${attempt.id}, ${ended} without a lead handoff, so agflow ` +
      'put this one together. Everything quoted below was written by an agent or a person, not by agflow.',
  ];
  const last = (
    ctx.db
      .query(
        `SELECT * FROM messages
         WHERE target = 'lead' OR target IN (SELECT value FROM json_each($leads))
           OR sender IN (SELECT value FROM json_each($leads))
         ORDER BY id DESC LIMIT $limit`,
      )
      .all({ leads, limit: LEAD_MESSAGES_SHOWN }) as MessageRow[]
  ).map(rowToMessage);
  if (last.length > 0) {
    sections.push(
      `## The last ${last.length} messages to and from the lead, newest first\n` +
        last.map((message) => shownMessage(message, LIMITS.leadMessage)).join('\n\n'),
    );
  }
  // With no lead handoff to start from, everything the leads sent counts.
  const handoff = newestLeadHandoff(ctx);
  const since = handoff?.createdAt ?? 0;
  const earlier = (
    ctx.db
      .query(
        `SELECT * FROM messages
         WHERE sender IN (SELECT value FROM json_each($leads)) AND created_at >= $since AND id < $before
         ORDER BY id DESC LIMIT $limit`,
      )
      .all({
        leads,
        since,
        before: last.at(-1)?.id ?? Number.MAX_SAFE_INTEGER,
        limit: LEAD_MESSAGES_SHOWN,
      }) as MessageRow[]
  ).map(rowToMessage);
  if (earlier.length > 0) {
    sections.push(
      '## Earlier messages the lead sent since the newest lead handoff, newest first\n' +
        earlier.map((message) => shownMessage(message, LIMITS.leadMessage)).join('\n\n'),
    );
  }
  // This note becomes the newest lead handoff, so the one before it would no longer reach the next lead's brief.
  if (handoff) {
    const source = `${handoff.author} wrote it${handoff.attemptId ? ` in attempt ${handoff.attemptId}` : ''}:`;
    sections.push(
      `## The lead handoff the previous lead started from\n${source}\n` +
        quotedWithin(handoff.body, BRIEF_HANDOFF_LIMIT),
    );
  }
  sections.push(situationReport(ctx));
  const goal = getCurrentGoal(ctx);
  sections.push(
    goal
      ? `## Goal (v${goal.version}), as people set it; your brief has all of it\n${clip(goal.text, LIMITS.goal)}`
      : '## Goal\nNo goal has been set yet.',
  );
  return closeNote(sections, null, LEAD_CLOSING);
}

/** The lead endings that leave the next lead a note: failover (lost, crashed), stops, replacements and rotations. */
const LEAD_NOTE_ENDINGS: readonly NonNullable<Attempt['endReason']>[] = [
  'lost',
  'crashed',
  'stopped',
  'replaced',
  'rotated',
];

/** Whether the lead's ending leaves the next lead a note: a failed start does only when it was a resume that failed. */
function leavesLeadNote(attempt: Attempt): boolean {
  if (attempt.endReason === 'failed_to_start') return attempt.sessionRef !== null;
  return attempt.endReason !== null && LEAD_NOTE_ENDINGS.includes(attempt.endReason);
}

/**
 * Stores an assembled lead handoff for a runner lead that ended without writing one (design 6.11, Failover; X-34), in
 * the ending's transaction: the next lead's brief quotes the newest lead handoff, so it starts from this one. A lead
 * whose resume failed had a session and gets one too; one that never spawned has nothing to hand on. It lives here
 * rather than in lead.ts because endAttempt calls it, and lead.ts starts and resumes leads through attempts.ts. Pass
 * the attempt as ended. Returns whether it stored one.
 */
export function failoverNote(ctx: HubContext, attempt: Attempt): boolean {
  if (attempt.role !== 'lead' || attempt.taskId !== null || attempt.runnerId === null) return false;
  if (!leavesLeadNote(attempt)) return false;
  if (handoffWritten(ctx, attempt)) return false;
  const note = assembleLeadHandoff(ctx, attempt);
  insertLeadNote(ctx, { attemptId: attempt.id, kind: 'handoff', body: note.body, author: note.author });
  return true;
}

import { type GoalNote, type GoalVersion, diffGoal, formatChanges } from '@agflow/core';
import { type HubContext, tx } from './context';
import { conflict } from './errors';
import { insertMessage } from './messages';
import { clip } from './text';

interface GoalRow {
  version: number;
  text: string;
  author: string;
  created_at: number;
}

interface NoteRow {
  id: number;
  goal_version: number;
  text: string;
  author: string;
  created_at: number;
}

const toGoal = (row: GoalRow): GoalVersion => ({
  version: row.version,
  text: row.text,
  author: row.author,
  createdAt: row.created_at,
});

const toNote = (row: NoteRow): GoalNote => ({
  id: row.id,
  goalVersion: row.goal_version,
  text: row.text,
  author: row.author,
  createdAt: row.created_at,
});

export function getCurrentGoal(ctx: HubContext): GoalVersion | null {
  const row = ctx.db.query('SELECT * FROM goal_versions ORDER BY version DESC LIMIT 1').get() as GoalRow | null;
  return row ? toGoal(row) : null;
}

export function getGoalVersion(ctx: HubContext, version: number): GoalVersion | null {
  const row = ctx.db.query('SELECT * FROM goal_versions WHERE version = $version').get({ version }) as GoalRow | null;
  return row ? toGoal(row) : null;
}

export function currentGoalVersion(ctx: HubContext): number {
  return getCurrentGoal(ctx)?.version ?? 0;
}

export function listGoalVersions(ctx: HubContext): GoalVersion[] {
  return (ctx.db.query('SELECT * FROM goal_versions ORDER BY version DESC').all() as GoalRow[]).map(toGoal);
}

export function updateGoal(ctx: HubContext, input: { text: string; baseVersion: number }, actor: string): GoalVersion {
  return tx(ctx, (emit) => {
    const current = getCurrentGoal(ctx);
    const currentVersion = current?.version ?? 0;
    if (input.baseVersion !== currentVersion) {
      throw conflict(`the goal changed since you loaded it (it is now v${currentVersion})`);
    }
    if (current && current.text === input.text) return current;
    const version = currentVersion + 1;
    const now = ctx.now();
    ctx.db
      .query('INSERT INTO goal_versions (version, text, author, created_at) VALUES ($version, $text, $author, $now)')
      .run({ version, text: input.text, author: actor, now });
    const changes = formatChanges(diffGoal(current?.text ?? '', input.text));
    emit({ type: 'goal.updated', actor, data: { version, previousVersion: currentVersion, changes } });
    const body = current
      ? `The goal changed from v${currentVersion} to v${version}.\nChanges:\n${changes}\n\nRe-plan: for each open task planned against an older goal version, keep it, amend it with update_task, or cancel it with cancel_task.`
      : `The first goal (v1) was set:\n${clip(input.text, 4000)}\n\nTurn it into tasks with create_tasks.`;
    insertMessage(ctx, emit, { from: 'system', to: 'lead', body });
    return { version, text: input.text, author: actor, createdAt: now };
  });
}

export function listGoalNotes(ctx: HubContext, version: number): GoalNote[] {
  const rows = ctx.db
    .query('SELECT * FROM goal_notes WHERE goal_version = $version ORDER BY id')
    .all({ version }) as NoteRow[];
  return rows.map(toNote);
}

export function addGoalNote(ctx: HubContext, text: string, actor: string): GoalNote {
  return tx(ctx, (emit) => {
    const row = ctx.db
      .query('INSERT INTO goal_notes (goal_version, text, author, created_at) VALUES ($version, $text, $author, $now) RETURNING *')
      .get({ version: currentGoalVersion(ctx), text, author: actor, now: ctx.now() }) as NoteRow;
    emit({ type: 'goal.note_added', actor, data: { id: row.id } });
    return toNote(row);
  });
}

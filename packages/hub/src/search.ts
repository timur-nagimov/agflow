import type { SearchResult } from '@agflow/core';
import type { HubContext } from './context';
import { getCurrentGoal } from './goal';
import { type MessageRow, rowToMessage } from './messages';
import { type TaskRow, rowToTask } from './task-store';

export function search(ctx: HubContext, query: string): SearchResult {
  const needle = query.trim();
  if (!needle) return { tasks: [], messages: [], goal: null };
  const like = `%${needle.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
  // The task whose id was typed comes first; otherwise newer tasks that merely mention it could push it off the page.
  const tasks = (
    ctx.db
      .query(
        `SELECT * FROM tasks WHERE id = $exact OR contract LIKE $like ESCAPE '\\'
         ORDER BY id = $exact DESC, seq DESC LIMIT 20`,
      )
      .all({ exact: needle.toUpperCase(), like }) as TaskRow[]
  ).map(rowToTask);
  const messages = (
    ctx.db
      .query("SELECT * FROM messages WHERE body LIKE $like ESCAPE '\\' ORDER BY id DESC LIMIT 20")
      .all({ like }) as MessageRow[]
  ).map(rowToMessage);
  const goal = getCurrentGoal(ctx);
  const at = goal ? goal.text.toLowerCase().indexOf(needle.toLowerCase()) : -1;
  return {
    tasks,
    messages,
    goal:
      goal && at >= 0
        ? { version: goal.version, snippet: goal.text.slice(Math.max(0, at - 80), at + needle.length + 80) }
        : null,
  };
}

import type { Project } from '@agflow/core';
import { type HubContext, tx } from './context';

export function getProject(ctx: HubContext): Project {
  const row = ctx.db.query('SELECT name, repo, paused FROM project WHERE id = 1').get() as {
    name: string;
    repo: string;
    paused: number;
  };
  return { name: row.name, repo: row.repo, paused: row.paused === 1 };
}

export function setPaused(ctx: HubContext, paused: boolean, actor: string): Project {
  return tx(ctx, (emit) => {
    const before = getProject(ctx);
    if (before.paused === paused) return before;
    ctx.db.query('UPDATE project SET paused = $paused WHERE id = 1').run({ paused: paused ? 1 : 0 });
    emit({ type: paused ? 'project.paused' : 'project.resumed', actor });
    return getProject(ctx);
  });
}

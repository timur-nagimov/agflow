import type { HubEvent } from '@agflow/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { type Me, api } from './api';
import { COLUMNS, type ColumnKey, columnCounts } from './format';
import { useAction, useData, useRoute } from './hooks';
import { type Hub, HubContext } from './hub';
import { type Connection, useConnection } from './live';
import { NAV, type Route, navViewOf, routeHref } from './route';
import { AgentsView } from './views/AgentsView';
import { BoardView } from './views/BoardView';
import { GoalView } from './views/GoalView';
import { KnowledgeView } from './views/KnowledgeView';
import { MessagesView } from './views/MessagesView';
import { TaskView } from './views/TaskView';
import { TimelineView } from './views/TimelineView';

const statusChanged = (event: HubEvent) =>
  event.type.startsWith('project.') ||
  event.type.startsWith('agent.') ||
  event.type === 'goal.updated' ||
  event.type === 'message.sent';
const taskChanged = (event: HubEvent) => event.type.startsWith('task.');

const CONNECTION: Record<Connection, { label: string; lamp: string }> = {
  connecting: { label: 'Connecting', lamp: 'tone-active' },
  live: { label: 'Live', lamp: 'tone-done pulse' },
  reconnecting: { label: 'Reconnecting', lamp: 'tone-trouble' },
};

const SEEN_KEY = 'agflow.peopleSeen';

export function Shell({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  const route = useRoute();
  const connection = useConnection();
  const status = useData(() => api.status(), [], { relevant: statusChanged, refreshMs: 60_000 });
  const tasks = useData(() => api.tasks(), [], { relevant: taskChanged });
  const [peopleSeen, setPeopleSeen] = useState(() => Number(localStorage.getItem(SEEN_KEY) ?? 0));
  const markPeopleSeen = useCallback((id: number) => {
    if (id <= Number(localStorage.getItem(SEEN_KEY) ?? 0)) return;
    localStorage.setItem(SEEN_KEY, String(id));
    setPeopleSeen(id);
  }, []);
  const hub = useMemo<Hub>(
    () => ({ me, status, tasks, peopleSeen, markPeopleSeen }),
    [me, status, tasks, peopleSeen, markPeopleSeen],
  );
  const project = status.data?.project;
  const counts = tasks.data ? columnCounts(tasks.data) : null;
  const unseen = (status.data?.humansInbox ?? []).filter((message) => message.id > peopleSeen).length;
  const current = navViewOf(route);

  useEffect(() => {
    document.title = project ? `${project.name} · agflow` : 'agflow';
  }, [project?.name]);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [route]);

  return (
    <HubContext.Provider value={hub}>
      <div className="app">
        <nav className="rail" aria-label="Main">
          <a className="brand" href={routeHref({ view: 'board' })}>
            <span className="wordmark">agflow</span>
            <span className="brand-project">{project?.name ?? '\u00a0'}</span>
          </a>
          <ul className="nav">
            {NAV.map((item) => (
              <li key={item.view}>
                <a href={routeHref({ view: item.view } as Route)} aria-current={item.view === current ? 'page' : undefined}>
                  {item.label}
                  {item.view === 'goal' && unseen > 0 ? (
                    <span className="badge" title={`${unseen} new message${unseen === 1 ? '' : 's'} for people`}>
                      {unseen}
                    </span>
                  ) : null}
                </a>
              </li>
            ))}
          </ul>
          <div className="rail-foot">
            <span className="me">{me.user}</span>
            <button className="link" onClick={onSignOut}>
              Sign out
            </button>
          </div>
        </nav>
        <div className="main">
          <header className="strip">
            <span className={`readout connection ${connection}`}>
              <span className={`lamp ${CONNECTION[connection].lamp}`} />
              {CONNECTION[connection].label}
            </span>
            {status.data ? (
              <a className="readout" href={routeHref({ view: 'goal' })}>
                Goal <b>v{status.data.goalVersion}</b>
              </a>
            ) : null}
            {counts
              ? COLUMNS.filter((column) => column.key !== 'closed').map((column) => (
                  <a key={column.key} className={`readout tone-${column.tone}`} href={routeHref({ view: 'board' })}>
                    <span className="dot" />
                    {column.label} <b>{counts[column.key]}</b>
                  </a>
                ))
              : null}
            {status.data ? (
              <a className="readout" href={routeHref({ view: 'agents' })}>
                Agents <b>{status.data.activeAgents}</b>
              </a>
            ) : null}
            {counts ? <Progress counts={counts} /> : null}
          </header>
          {project?.paused ? (
            <div className="banner warn" role="status">
              <b>Paused.</b> Agents finish or hand off what they hold, and no new work starts.
              <ResumeButton />
            </div>
          ) : null}
          {status.data && !status.data.lead ? (
            <div className="banner info" role="status">
              <b>No lead is connected.</b> In the project's repository run <code>agflow join --role lead</code>, then start a
              new Claude Code or Codex chat there.
            </div>
          ) : null}
          <main className="content">
            <View route={route} />
          </main>
        </div>
      </div>
    </HubContext.Provider>
  );
}

function View({ route }: { route: Route }) {
  switch (route.view) {
    case 'board':
      return <BoardView />;
    case 'goal':
      return <GoalView />;
    case 'task':
      return <TaskView key={route.id} id={route.id} />;
    case 'agents':
      return <AgentsView />;
    case 'messages':
      return <MessagesView key={route.to ?? ''} to={route.to} />;
    case 'timeline':
      return <TimelineView />;
    case 'knowledge':
      return <KnowledgeView />;
  }
}

const PROGRESS_ORDER: ColumnKey[] = ['done', 'review', 'doing', 'attention', 'todo'];

function Progress({ counts }: { counts: Record<ColumnKey, number> }) {
  const total = PROGRESS_ORDER.reduce((sum, key) => sum + counts[key], 0);
  if (total === 0) return null;
  return (
    <div className="progress" title={`${counts.done} of ${total} tasks done`}>
      <div className="progress-bar" aria-hidden="true">
        {PROGRESS_ORDER.map((key) =>
          counts[key] > 0 ? (
            <span
              key={key}
              className={`progress-part tone-${COLUMNS.find((column) => column.key === key)?.tone}`}
              style={{ flexGrow: counts[key] }}
            />
          ) : null,
        )}
      </div>
      <span className="progress-label">
        {counts.done}/{total} done
      </span>
    </div>
  );
}

function ResumeButton() {
  const action = useAction();
  return (
    <>
      <button className="small" disabled={action.busy} onClick={() => void action.run(() => api.setPaused(false))}>
        Resume
      </button>
      {action.error ? <span className="error">{action.error}</span> : null}
    </>
  );
}

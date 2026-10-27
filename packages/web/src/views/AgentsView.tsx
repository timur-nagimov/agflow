import type { Vendor } from '@agflow/core';
import { useState } from 'react';
import { api } from '../api';
import { Empty, ErrorBox, Lamp, Loading, PageHead, TaskLink, When } from '../components';
import { useData } from '../hooks';
import { routeHref } from '../route';

const VENDORS: Record<Vendor, string> = { claude: 'Claude Code', codex: 'Codex' };

export function AgentsView() {
  const agents = useData(() => api.agents(), [], {
    relevant: (event) => event.type.startsWith('agent.') || event.type.startsWith('task.'),
    refreshMs: 30_000,
  });
  const [showGone, setShowGone] = useState(false);
  if (!agents.data) return agents.error ? <ErrorBox error={agents.error} onRetry={agents.reload} /> : <Loading />;
  const active = agents.data.filter((agent) => agent.status === 'active').length;
  const idle = agents.data.filter((agent) => agent.status === 'idle').length;
  const gone = agents.data.length - active - idle;
  const shown = agents.data.filter((agent) => showGone || agent.status !== 'gone');

  return (
    <div className="page">
      <PageHead
        title="Agents"
        meta={`${active} active · ${idle} idle`}
        actions={
          <label className="check">
            <input type="checkbox" checked={showGone} onChange={(event) => setShowGone(event.target.checked)} />
            Show disconnected ({gone})
          </label>
        }
      />
      {shown.length === 0 ? (
        <Empty title="No agents connected">
          In the project's repository run <code>agflow join</code>, then start a Claude Code or Codex chat there.
        </Empty>
      ) : (
        <div className="card table-card">
          <table>
            <thead>
              <tr>
                <th>Agent</th>
                <th>Role</th>
                <th>Person</th>
                <th>Runs in</th>
                <th>Working on</th>
                <th>Last seen</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((agent) => (
                <tr key={agent.id} className={`agent-${agent.status}`}>
                  <td>
                    <span className="agent-name">
                      <Lamp status={agent.status} />
                      <span className="mono">{agent.id}</span>
                      {agent.label ? <span className="muted">{agent.label}</span> : null}
                    </span>
                  </td>
                  <td>{agent.role === 'lead' ? <span className="chip tone-review">Lead</span> : 'Worker'}</td>
                  <td>{agent.user}</td>
                  <td>{VENDORS[agent.vendor]}</td>
                  <td>{agent.currentTask ? <TaskLink id={agent.currentTask} /> : <span className="muted">—</span>}</td>
                  <td>
                    <When ts={agent.lastSeenAt} />
                  </td>
                  <td className="cell-action">
                    <a className="button small" href={routeHref({ view: 'messages', to: `agent:${agent.id}` })}>
                      Message
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="hint">Active means seen in the last 10 minutes, idle within 2 hours. Older sessions count as disconnected.</p>
    </div>
  );
}

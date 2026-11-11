import type { Agent, Attempt, AttemptStatus, HubEvent, LeadSeat, Runner } from '@agflow/core';
import { Fragment, useState } from 'react';
import { api } from '../api';
import { phaseLabel, runnerActionsFor } from '../attempts';
import { AttemptLink, Empty, ErrorBox, Lamp, Loading, PageHead, TaskLink, When } from '../components';
import { VENDOR_NAMES } from '../format';
import { useData } from '../hooks';
import { useHub } from '../hub';
import { RunnerActions } from '../RunnerActions';
import { routeHref } from '../route';

/** Every attempt that is not over, in one call (X-24). */
const OPEN_STATUSES: AttemptStatus[] = ['starting', 'running', 'quota_wait', 'holding'];

const agentsChanged = (event: HubEvent) =>
  event.type.startsWith('agent.') || event.type.startsWith('task.') || event.type.startsWith('attempt.');
const attemptsChanged = (event: HubEvent) => event.type.startsWith('attempt.') || event.type.startsWith('agent.');
/**
 * The lead seat moves with lead.* events. A delivery to a runner lead counts a wake-up and sends no event; its
 * acknowledgement is the first event after it.
 */
const seatChanged = (event: HubEvent) =>
  event.type.startsWith('lead.') || event.type.startsWith('attempt.') || event.type === 'message.acknowledged';

/** Where the lead in the seat runs: a live chat, or a runner with its wake-ups since the last rotation (design 11). */
function seatText(seat: LeadSeat): string {
  if (seat.kind === 'live') return 'A live chat';
  return `On ${seat.runnerId} · ${seat.wakeups} wake-up${seat.wakeups === 1 ? '' : 's'} since rotation`;
}

/** Design 11's Agents page: who runs where, on which attempt and in which phase, with the actions on runner agents. */
export function AgentsView() {
  const hub = useHub();
  const { runners } = hub;
  const agents = useData(() => api.agents(), [], { relevant: agentsChanged, refreshMs: 30_000 });
  // Phases come with heartbeats, which send no event, hence the timer.
  const attempts = useData(() => api.attempts({ status: OPEN_STATUSES }), [], {
    relevant: attemptsChanged,
    refreshMs: 30_000,
  });
  const status = useData(() => api.status(), [], { relevant: seatChanged, refreshMs: 30_000 });
  const [showGone, setShowGone] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  if (!agents.data) return agents.error ? <ErrorBox error={agents.error} onRetry={agents.reload} /> : <Loading />;
  const active = agents.data.filter((agent) => agent.status === 'active').length;
  const idle = agents.data.filter((agent) => agent.status === 'idle').length;
  const gone = agents.data.length - active - idle;
  const shown = agents.data.filter((agent) => showGone || agent.status !== 'gone');
  // The hub-wide status stands in until the page's own answers; undefined while neither has, so the seat is unknown.
  const seat = (status.data ?? hub.status.data)?.leadSeat;
  const openAttempts = new Map((attempts.data ?? []).map((attempt) => [attempt.id, attempt]));
  const runnerList = runners.data?.runners ?? [];
  const attemptOf = (agent: Agent): Attempt | null => (agent.attemptId ? (openAttempts.get(agent.attemptId) ?? null) : null);
  const runnerOf = (agent: Agent): Runner | null => runnerList.find((runner) => runner.id === agent.runnerId) ?? null;
  const reload = () => {
    agents.reload();
    attempts.reload();
    status.reload();
  };

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
                <th>Runner</th>
                <th>Attempt</th>
                <th>Phase</th>
                <th>Working on</th>
                <th>Last seen</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((agent) => {
                const attempt = attemptOf(agent);
                const runner = runnerOf(agent);
                // An open row stays open after its action, to say what was sent, even when nothing is left to do.
                const open = expanded === agent.id;
                const actionable = open || runnerActionsFor(attempt, runner).length > 0;
                const inSeat = seat !== undefined && seat.agentId === agent.id;
                return (
                  <Fragment key={agent.id}>
                    <tr className={`agent-${agent.status}`}>
                      <td>
                        <span className="agent-name">
                          <Lamp status={agent.status} />
                          <span className="mono">{agent.id}</span>
                          {agent.label ? <span className="muted">{agent.label}</span> : null}
                        </span>
                      </td>
                      <td>
                        {inSeat ? (
                          <span className="lead-role">
                            <span className="chip tone-review">Lead</span>
                            <span className="lead-seat">{seatText(seat)}</span>
                          </span>
                        ) : agent.role === 'lead' && seat === undefined ? (
                          <span className="chip tone-review">Lead</span>
                        ) : agent.role === 'lead' ? (
                          <span className="muted">Former lead</span>
                        ) : (
                          'Worker'
                        )}
                      </td>
                      <td>{agent.user}</td>
                      <td>{VENDOR_NAMES[agent.vendor]}</td>
                      <td className="agent-runner">
                        {agent.runnerId ? (
                          <a href={routeHref({ view: 'runners' })}>{agent.runnerId}</a>
                        ) : (
                          <span className="muted">Live chat</span>
                        )}
                      </td>
                      <td className="agent-attempt">
                        {agent.attemptId ? <AttemptLink id={agent.attemptId} /> : <span className="muted">—</span>}
                      </td>
                      <td className="agent-phase">{attempt ? phaseLabel(attempt) : <span className="muted">—</span>}</td>
                      <td>{agent.currentTask ? <TaskLink id={agent.currentTask} /> : <span className="muted">—</span>}</td>
                      <td>
                        <When ts={agent.lastSeenAt} />
                      </td>
                      <td className="cell-action">
                        <span className="row-actions">
                          {actionable ? (
                            <button
                              className="small"
                              aria-expanded={open}
                              onClick={() => setExpanded(open ? null : agent.id)}
                            >
                              Actions
                            </button>
                          ) : null}
                          <a className="button small" href={routeHref({ view: 'messages', to: `agent:${agent.id}` })}>
                            Message
                          </a>
                        </span>
                      </td>
                    </tr>
                    {open ? (
                      <tr className="agent-actions-row">
                        <td colSpan={10}>
                          <RunnerActions agentId={agent.id} attempt={attempt} runner={runner} onDone={reload} />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="hint">Active means seen in the last 10 minutes, idle within 2 hours. Older sessions count as disconnected.</p>
    </div>
  );
}

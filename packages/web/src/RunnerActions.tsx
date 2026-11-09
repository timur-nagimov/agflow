import type { Attempt, Runner } from '@agflow/core';
import { type FormEvent, useState } from 'react';
import { type AgentActionBodies, api } from './api';
import {
  actionOutcomeText,
  RUNNER_ACTIONS,
  type RunnerAction,
  runnerActionBody,
  runnerActionsFor,
  takeoverRefusal,
} from './attempts';
import { useAction } from './hooks';
import { routeHref } from './route';

/**
 * Sends an agent route's request; each route takes its own body, so the route is narrowed before the call. Stop and
 * replace answer with the attempt, whose stop request says what the hub did; interrupt answers none.
 */
function send(agentId: string, action: RunnerAction, reason: string): Promise<Attempt | null> {
  const body = runnerActionBody(action, reason);
  switch (RUNNER_ACTIONS[action].route) {
    case 'interrupt':
      return api.agentAction(agentId, 'interrupt');
    case 'stop':
      return api.agentAction(agentId, 'stop', body as AgentActionBodies['stop']);
    case 'replace':
      return api.agentAction(agentId, 'replace', body as AgentActionBodies['replace']);
    case null:
      throw new Error(`${RUNNER_ACTIONS[action].label} has no agent route`);
  }
}

/**
 * A person's actions on a runner agent (design 11, 6.4, 6.12): interrupt, stop, stop and hold, replace and take over,
 * as runnerActionsFor offers them. Each asks first: a stop or replace for its reason, interrupt and take-over for a
 * second click. A form stays usable only while its action is still offered: the hub checks less than X-34's rule, so
 * a form opened before the agent's state changed must not send. A refused take-over shows why, reloads the page's
 * data, and offers Stop and hold instead when that is still offered; an accepted one opens the attempt's page, which
 * shows the commands once the runner prepared them. What an accepted stop or replace did comes from the hub's answer.
 */
export function RunnerActions({
  agentId,
  attempt,
  runner,
  onDone,
}: {
  agentId: string;
  attempt: Attempt | null;
  runner: Pick<Runner, 'state'> | null;
  onDone: () => void;
}) {
  const offered = runnerActionsFor(attempt, runner);
  const [open, setOpen] = useState<RunnerAction | null>(null);
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState<RunnerAction | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const action = useAction();
  const offeredNow = open !== null && offered.includes(open);
  const spec = open && offeredNow ? RUNNER_ACTIONS[open] : null;
  const ready = open !== null && offeredNow && runnerActionBody(open, reason) !== null;
  const refusal = tried === 'takeover' && action.errorCode ? takeoverRefusal(action.errorCode) : null;

  const choose = (next: RunnerAction | null) => {
    setOpen(next === open ? null : next);
    setReason('');
    setTried(null);
    setDone(null);
    action.clearError();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!open || !ready || !attempt || !offered.includes(open)) return;
    const chosen = open;
    setTried(chosen);
    if (chosen === 'takeover') {
      if (!attempt.taskId) return;
      const taskId = attempt.taskId;
      const outcome = await action.run(() => api.takeOver(taskId));
      if (outcome.ok) {
        window.location.hash = routeHref({ view: 'attempt', id: outcome.value });
        return;
      }
      // A refusal means the page's view of the agent was stale.
      setOpen(null);
      onDone();
      return;
    }
    const outcome = await action.run(() => send(agentId, chosen, reason));
    if (outcome.ok) {
      setOpen(null);
      setDone(actionOutcomeText(chosen, outcome.value));
      onDone();
    }
  };

  return (
    <div className="runner-actions-panel">
      {offered.length > 0 ? (
        <div className="actions">
          {offered.map((name) => (
            <button
              key={name}
              className={RUNNER_ACTIONS[name].danger ? 'danger' : undefined}
              aria-pressed={open === name}
              onClick={() => choose(name)}
            >
              {RUNNER_ACTIONS[name].label}
            </button>
          ))}
        </div>
      ) : (
        <p className="muted">Nothing to do on this agent now.</p>
      )}
      {open && !offeredNow ? <p className="muted">No longer offered: the agent's state changed.</p> : null}
      {spec ? (
        <form className="action-form" onSubmit={submit}>
          {spec.reason ? (
            <label>
              {spec.prompt}
              <textarea rows={3} value={reason} onChange={(event) => setReason(event.target.value)} autoFocus />
            </label>
          ) : (
            <p>{spec.prompt}</p>
          )}
          <div className="row">
            <button className={`confirm-action ${spec.danger ? 'danger solid' : 'primary'}`} disabled={!ready || action.busy}>
              {spec.confirm}
            </button>
            <button type="button" onClick={() => choose(null)}>
              Never mind
            </button>
          </div>
          {action.error ? <p className="error">{action.error}</p> : null}
        </form>
      ) : null}
      {refusal ? (
        <div className="takeover-refused" role="alert">
          <p>
            <b>The hub refused the take-over.</b> {refusal.message}
          </p>
          <p className="muted">{action.error}</p>
          {offered.includes(refusal.offer) ? (
            <button className="danger" onClick={() => choose(refusal.offer)}>
              {RUNNER_ACTIONS[refusal.offer].label}
            </button>
          ) : null}
        </div>
      ) : tried === 'takeover' && action.error ? (
        <p className="error">{action.error}</p>
      ) : null}
      {done ? <p className="runner-actions-done hint">{done}</p> : null}
    </div>
  );
}

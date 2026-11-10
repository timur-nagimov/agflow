import { type Attempt, attemptSuffix, formatFence } from '@agflow/core';
import { api } from '../api';
import {
  AttemptLog,
  CommandBlock,
  ErrorBox,
  Fact,
  Loading,
  RepoRef,
  Section,
  TaskLink,
  When,
} from '../components';
import {
  ATTEMPT_STATUS_LABELS,
  END_REASON_LABELS,
  FAILURE_CLASS_LABELS,
  STOP_CAUSE_LABELS,
  attemptTone,
  factsRows,
  isOpen,
  phaseLabel,
  takeoverState,
  wipText,
} from '../attempts';
import { VENDOR_NAMES, concernsAttempt, concernsTask, who } from '../format';
import { useData } from '../hooks';
import { useHub } from '../hub';
import { routeHref } from '../route';

/**
 * One attempt (design 6.8, 6.12, 6.13), a task's or a lead's: where it ran, where its work is, why it was asked to
 * stop, the take-over commands, the facts of its last heartbeat and its whole log.
 */
export function AttemptView({ id }: { id: string }) {
  const { status } = useHub();
  // Heartbeats carry the facts and send no event, so an open attempt's page also reloads on a timer.
  const detail = useData(() => api.attempt(id), [id], {
    relevant: (event) => concernsAttempt(event, id),
    refreshMs: 30_000,
  });
  if (!detail.data) return detail.error ? <ErrorBox error={detail.error} onRetry={detail.reload} /> : <Loading />;
  const { attempt, log } = detail.data;
  const repo = status.data?.project.repo;
  const open = isOpen(attempt);
  const statusText = open
    ? ATTEMPT_STATUS_LABELS[attempt.status]
    : attempt.endReason
      ? END_REASON_LABELS[attempt.endReason]
      : ATTEMPT_STATUS_LABELS.ended;

  return (
    <div className="page">
      {attempt.taskId ? (
        <a className="back" href={routeHref({ view: 'task', id: attempt.taskId })}>
          ← {attempt.taskId}
        </a>
      ) : (
        <a className="back" href={routeHref({ view: 'agents' })}>
          ← Agents
        </a>
      )}
      <header className="task-head attempt-head">
        <div className="task-head-top">
          <span className="task-id big">{attempt.id}</span>
          <span className={`chip tone-${attemptTone(attempt)}`}>{statusText}</span>
          <a className="events-link" href={routeHref({ view: 'timeline', subject: attempt.id })}>
            Events
          </a>
        </div>
        <h1 className="page-title">
          {attempt.taskId
            ? `Attempt ${attemptSuffix(attempt.id)} of ${attempt.taskId}`
            : `Lead attempt ${attemptSuffix(attempt.id)}`}
        </h1>
        <dl className="facts">
          {attempt.taskId ? (
            <Fact label="Task">
              <TaskLink id={attempt.taskId} />
            </Fact>
          ) : null}
          {open ? <Fact label="Phase">{phaseLabel(attempt)}</Fact> : null}
          {!open ? (
            <Fact label="Class">{attempt.failureClass ? FAILURE_CLASS_LABELS[attempt.failureClass] : 'None'}</Fact>
          ) : null}
          <Fact label="Agent">
            <span className="mono">{attempt.agentId}</span>
            {attempt.role === 'lead' ? ' · lead' : null}
          </Fact>
          <Fact label="Vendor and model">
            {VENDOR_NAMES[attempt.vendor]}
            {attempt.model ? <span className="mono"> · {attempt.model}</span> : null}
          </Fact>
          <Fact label="Runner">
            {attempt.runnerId ? <a href={routeHref({ view: 'runners' })}>{attempt.runnerId}</a> : 'A live chat'}
          </Fact>
          <Fact label="Fence">
            <span className="mono">{formatFence(attempt.fence)}</span>
          </Fact>
          {attempt.role === 'lead' ? <Fact label="Wake-ups">{attempt.wakeups}</Fact> : null}
          <Fact label="Started">
            <When ts={attempt.startedAt} clock />
          </Fact>
          {attempt.endedAt ? (
            <Fact label="Ended">
              <When ts={attempt.endedAt} clock />
            </Fact>
          ) : null}
        </dl>
      </header>
      <div className="grid-2">
        <div className="stack">
          <Positions attempt={attempt} repo={repo} />
          {attempt.stopRequested ? <StopRequest stop={attempt.stopRequested} /> : null}
          {attempt.takeover && attempt.taskId ? <Takeover attempt={attempt} taskId={attempt.taskId} /> : null}
          {attempt.facts ? <Facts attempt={attempt} /> : null}
        </div>
        <Section title="Log">
          <AttemptLog entries={log} />
        </Section>
      </div>
    </div>
  );
}

/** Where the attempt started from, its work in progress, and what it submitted. */
function Positions({ attempt, repo }: { attempt: Attempt; repo: string | undefined }) {
  const wip = wipText(attempt);
  return (
    <Section title="Work">
      <dl className="facts">
        <Fact label="Start">
          {attempt.startRef ? <code>{attempt.startRef}</code> : null}
          {attempt.startRef && attempt.startSha ? ' at ' : null}
          {attempt.startSha ? <RepoRef repo={repo} kind="commit" refName={attempt.startSha} /> : null}
          {!attempt.startRef && !attempt.startSha ? '—' : null}
        </Fact>
        <Fact label="Work in progress">{wip ? <code>{wip}</code> : 'None pushed'}</Fact>
        <Fact label="Submitted">
          {attempt.submittedSha ? <RepoRef repo={repo} kind="commit" refName={attempt.submittedSha} /> : 'Nothing yet'}
        </Fact>
      </dl>
    </Section>
  );
}

function StopRequest({ stop }: { stop: NonNullable<Attempt['stopRequested']> }) {
  return (
    <Section title="Stop request" className="stop-request">
      <dl className="facts">
        <Fact label="Cause">{STOP_CAUSE_LABELS[stop.cause]}</Fact>
        <Fact label="Asked by">
          {who(stop.by)} · <When ts={stop.at} />
        </Fact>
        <Fact label="Handoff">{stop.handoff ? 'Asked to write one first' : 'None asked for'}</Fact>
      </dl>
      <p className="pre stop-reason">{stop.reason}</p>
      {stop.deferred ? (
        <p className="warn-text">
          It waits for the pending submission: if the push fails, the stop applies; if it lands, the stop is dropped and
          the task goes up for review.
        </p>
      ) : null}
    </Section>
  );
}

/**
 * The commands the take-over recorded (6.12): one for the runner's laptop when it built a clone, one for anywhere.
 * They are an invitation only while the task is still taken over by this attempt (takeoverState). The hub keeps them
 * after a hand-back or a cancel, when the runner removes the clone and nobody reads the take-over ref any more, so
 * then only the command for anywhere stays, for the record.
 */
function Takeover({ attempt, taskId }: { attempt: Attempt; taskId: string }) {
  const task = useData(() => api.task(taskId), [taskId], { relevant: (event) => concernsTask(event, taskId) });
  const takeover = attempt.takeover;
  if (!takeover) return null;
  if (!task.data) return task.error ? <ErrorBox error={task.error} onRetry={task.reload} /> : null;
  const { task: current } = task.data;
  const state = takeoverState(current, current.currentAttempt === attempt.id ? attempt : null).kind;
  if (state !== 'ready' && state !== 'handing_back' && state !== 'failed') {
    return (
      <Section title="Take-over" className="takeover">
        <h3>No longer taken over</h3>
        <p className="muted">The task has left this take-over, so its clone and its take-over ref are no longer used.</p>
        <CommandBlock label="The command for anywhere" command={takeover.anywhere} />
      </Section>
    );
  }
  return (
    <Section title="Take-over" className="takeover">
      {takeover.local ? (
        <>
          <h3>On the runner's laptop</h3>
          <CommandBlock label="The command on the runner's laptop" command={takeover.local} />
        </>
      ) : null}
      <h3>Anywhere</h3>
      <CommandBlock label="The command for anywhere" command={takeover.anywhere} />
      <p className="hint">
        Push your work to <code>{takeover.ref}</code>, then hand the task back.
      </p>
      {takeover.handingBack ? (
        <p>
          {who(takeover.handingBack.by)} is handing it back from the clone, since <When ts={takeover.handingBack.at} />.
        </p>
      ) : null}
      {takeover.error ? <p className="warn-text pre">{takeover.error}</p> : null}
    </Section>
  );
}

/** The runner's last heartbeat; ages are as reported, with sleep already taken out. */
function Facts({ attempt }: { attempt: Attempt }) {
  return (
    <Section title="Last heartbeat" className="attempt-facts">
      <dl className="facts">
        {factsRows(attempt.facts).map((row) => (
          <Fact key={row.label} label={row.label}>
            {row.tone ? <span className={`toned tone-${row.tone}`}>{row.value}</span> : row.value}
          </Fact>
        ))}
      </dl>
    </Section>
  );
}

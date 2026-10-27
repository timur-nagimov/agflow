import type { Task, TaskNote } from '@agflow/core';
import { type FormEvent, type ReactNode, useState } from 'react';
import { api } from '../api';
import {
  Composer,
  ErrorBox,
  EventList,
  Linked,
  Loading,
  MessageList,
  RepoRef,
  Section,
  StatusChip,
  TaskLink,
  When,
} from '../components';
import {
  NOTE_LABELS,
  TASK_ACTIONS,
  type TaskAction,
  actionBody,
  actionHint,
  actionsFor,
  duration,
  evidenceText,
  who,
} from '../format';
import { useAction, useData, useNow } from '../hooks';
import { useHub } from '../hub';
import { routeHref } from '../route';

export function TaskView({ id }: { id: string }) {
  const { status } = useHub();
  const detail = useData(() => api.task(id), [id], { relevant: (event) => event.subject === id });
  if (!detail.data) return detail.error ? <ErrorBox error={detail.error} onRetry={detail.reload} /> : <Loading />;
  const { task, notes, events, messages } = detail.data;
  const repo = status.data?.project.repo;
  const goalVersion = status.data?.goalVersion;

  return (
    <div className="page">
      <a className="back" href={routeHref({ view: 'board' })}>
        ← Board
      </a>
      <header className="task-head">
        <div className="task-head-top">
          <span className="task-id big">{task.id}</span>
          <StatusChip status={task.status} blockedKind={task.blockedKind} />
        </div>
        <h1 className="page-title">{task.title}</h1>
        <dl className="facts">
          <Fact label="Agent">{task.assignee ?? '—'}</Fact>
          <Fact label="Priority">P{task.priority}</Fact>
          <Fact label="Kind">{task.kind}</Fact>
          <Fact label="Branch">{task.branch ? <RepoRef repo={repo} kind="branch" refName={task.branch} /> : '—'}</Fact>
          <Fact label="Goal">
            v{task.goalVersion}
            {goalVersion !== undefined && task.goalVersion < goalVersion ? (
              <span className="warn-text"> · goal is now v{goalVersion}</span>
            ) : null}
          </Fact>
          {task.leaseExpiresAt ? (
            <Fact label="Lease">
              <LeaseLeft until={task.leaseExpiresAt} />
            </Fact>
          ) : null}
          <Fact label="Created">
            {who(task.createdBy)} · <When ts={task.createdAt} />
          </Fact>
        </dl>
      </header>
      <Attention task={task} />
      <Actions key={task.status} task={task} onDone={detail.reload} />
      <div className="grid-2">
        <div className="stack">
          <Contract task={task} />
          {task.submission ? <Submission task={task} repo={repo} /> : null}
          <Notes notes={notes} />
        </div>
        <div className="stack">
          <Section title="Thread">
            <MessageList messages={[...messages].reverse()} />
            <Composer
              to={`task:${task.id}`}
              placeholder={
                task.assignee
                  ? `Write to ${task.assignee}, who holds this task…`
                  : 'Nobody holds this task; the next agent to claim it gets your message…'
              }
            />
          </Section>
          <Section title="History">
            <EventList events={[...events].reverse()} />
          </Section>
        </div>
      </div>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function LeaseLeft({ until }: { until: number }) {
  const now = useNow();
  return <>{until > now ? `${duration(until - now)} left` : 'expired'}</>;
}

function Attention({ task }: { task: Task }) {
  if (task.status === 'blocked' && task.blockedReason) {
    const title =
      task.blockedKind === 'deps'
        ? 'Waiting on other tasks'
        : task.blockedKind === 'impossible'
          ? 'The agent says this cannot be done as written'
          : 'Blocked';
    return (
      <div className={`card attention tone-${task.blockedKind === 'deps' ? 'wait' : 'trouble'}`}>
        <h2>{title}</h2>
        <p className="pre">
          <Linked text={task.blockedReason} />
        </p>
      </div>
    );
  }
  if (task.feedback && (task.status === 'claimed' || task.status === 'working' || task.status === 'ready')) {
    return (
      <div className="card attention tone-trouble">
        <h2>Review feedback to address</h2>
        <p className="pre">{task.feedback}</p>
      </div>
    );
  }
  return null;
}

function Actions({ task, onDone }: { task: Task; onDone: () => void }) {
  const available = actionsFor(task);
  const [open, setOpen] = useState<TaskAction | null>(null);
  const [text, setText] = useState('');
  const action = useAction();
  if (available.length === 0) return null;
  const spec = open ? TASK_ACTIONS[open] : null;
  const body = open ? actionBody(open, text) : null;

  const choose = (next: TaskAction) => {
    setOpen(open === next ? null : next);
    setText('');
    action.clearError();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!open || !body) return;
    if (await action.run(() => api.taskAction(task.id, open, body))) {
      setOpen(null);
      onDone();
    }
  };

  return (
    <section className="card actions-card" aria-label="Actions">
      <p className="action-hint">{actionHint(task)}</p>
      <div className="actions">
        {available.map((name) => (
          <button
            key={name}
            className={TASK_ACTIONS[name].danger ? 'danger' : name === 'accept' ? 'primary' : undefined}
            aria-pressed={open === name}
            onClick={() => choose(name)}
          >
            {TASK_ACTIONS[name].label}
          </button>
        ))}
      </div>
      {spec && open ? (
        <form className="action-form" onSubmit={submit}>
          <label>
            {spec.prompt}
            {spec.field === 'sha' ? (
              <input className="mono" value={text} placeholder="3f2a9c1" onChange={(event) => setText(event.target.value)} autoFocus />
            ) : (
              <textarea rows={3} value={text} onChange={(event) => setText(event.target.value)} autoFocus />
            )}
          </label>
          <div className="row">
            <button className={`confirm-action ${spec.danger ? 'danger solid' : 'primary'}`} disabled={!body || action.busy}>
              {spec.confirm}
            </button>
            <button type="button" onClick={() => setOpen(null)}>
              Never mind
            </button>
          </div>
          {action.error ? <p className="error">{action.error}</p> : null}
        </form>
      ) : null}
    </section>
  );
}

function Contract({ task }: { task: Task }) {
  return (
    <Section title="Contract">
      <h3>Objective</h3>
      <p className="pre">
        <Linked text={task.objective} />
      </p>
      {task.why ? (
        <>
          <h3>Why</h3>
          <p className="pre">{task.why}</p>
        </>
      ) : null}
      <h3>Acceptance</h3>
      <ol className="criteria">
        {task.acceptance.map((criterion) => (
          <li key={criterion.id}>
            <span className="criterion-id">{criterion.id}</span>
            <span>
              {criterion.assertion}
              {criterion.evidence ? <span className="evidence"> · {evidenceText(criterion.evidence)}</span> : null}
            </span>
          </li>
        ))}
      </ol>
      {task.nonGoals.length > 0 ? (
        <>
          <h3>Out of scope</h3>
          <ul>
            {task.nonGoals.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </>
      ) : null}
      {task.checks.length > 0 ? (
        <>
          <h3>Checks</h3>
          <ul className="plain">
            {task.checks.map((check) => (
              <li key={check.name}>
                {check.name} <code>{check.cmd}</code>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {task.ownedPaths.length > 0 ? (
        <>
          <h3>Owned paths</h3>
          <ul className="plain">
            {task.ownedPaths.map((path) => (
              <li key={path}>
                <code>{path}</code>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {task.dependsOn.length > 0 ? (
        <>
          <h3>Depends on</h3>
          <p className="links">
            {task.dependsOn.map((dependency) => (
              <TaskLink key={dependency} id={dependency} />
            ))}
          </p>
        </>
      ) : null}
    </Section>
  );
}

function Submission({ task, repo }: { task: Task; repo: string | undefined }) {
  const submission = task.submission;
  if (!submission) return null;
  return (
    <Section title="Submission">
      <p className="meta">
        {submission.by} · <When ts={submission.submittedAt} />
        {submission.branch ? (
          <>
            {' · '}
            <RepoRef repo={repo} kind="branch" refName={submission.branch} />
          </>
        ) : null}
        {submission.headSha ? (
          <>
            {' · '}
            <RepoRef repo={repo} kind="commit" refName={submission.headSha} />
          </>
        ) : null}
      </p>
      <p className="pre">
        <Linked text={submission.summary} />
      </p>
      {submission.evidence.length > 0 ? (
        <>
          <h3>Evidence</h3>
          <ul>
            {submission.evidence.map((item, index) => (
              <li key={index} className="pre">
                {item}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {task.mergedSha ? (
        <p className="meta">
          Merged at <RepoRef repo={repo} kind="commit" refName={task.mergedSha} />
        </p>
      ) : null}
    </Section>
  );
}

function Notes({ notes }: { notes: TaskNote[] }) {
  return (
    <Section title="Notes">
      {notes.length === 0 ? (
        <p className="muted">Agents post progress and handoff notes here.</p>
      ) : (
        <ol className="notes">
          {[...notes].reverse().map((note) => (
            <li key={note.id}>
              <div className="meta">
                <span className={`chip tone-${note.kind === 'progress' ? 'active' : note.kind === 'handoff' ? 'review' : 'closed'}`}>
                  {NOTE_LABELS[note.kind]}
                </span>{' '}
                {who(note.author)} · <When ts={note.createdAt} />
              </div>
              <p className="pre">
                <Linked text={note.body} />
              </p>
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}

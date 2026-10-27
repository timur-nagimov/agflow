import type { Task, TaskKind } from '@agflow/core';
import { type FormEvent, useState } from 'react';
import { api } from '../api';
import { Empty, ErrorBox, Field, Loading, PageHead, StatusChip } from '../components';
import {
  COLUMNS,
  EMPTY_DRAFT,
  PRIORITIES,
  TASK_KINDS,
  type TaskDraft,
  draftReady,
  draftToTask,
  groupTasks,
  toneOf,
} from '../format';
import { useAction } from '../hooks';
import { useHub } from '../hub';
import { routeHref } from '../route';

export function BoardView() {
  const { tasks } = useHub();
  const [showClosed, setShowClosed] = useState(false);
  const [creating, setCreating] = useState(false);
  if (!tasks.data) return tasks.error ? <ErrorBox error={tasks.error} onRetry={tasks.reload} /> : <Loading />;
  const groups = groupTasks(tasks.data);
  const columns = COLUMNS.filter((column) => showClosed || column.key !== 'closed');

  return (
    <div className="page wide">
      <PageHead
        title="Board"
        meta={`${tasks.data.length} task${tasks.data.length === 1 ? '' : 's'} · priority 0 is the most urgent`}
        actions={
          <>
            <label className="check">
              <input type="checkbox" checked={showClosed} onChange={(event) => setShowClosed(event.target.checked)} />
              Show closed ({groups.closed.length})
            </label>
            <button className={creating ? undefined : 'primary'} onClick={() => setCreating(!creating)}>
              {creating ? 'Close the form' : 'New task'}
            </button>
          </>
        }
      />
      {creating ? (
        <NewTaskForm
          onCreated={(task) => {
            setCreating(false);
            window.location.hash = routeHref({ view: 'task', id: task.id });
          }}
        />
      ) : null}
      {tasks.data.length === 0 && !creating ? (
        <Empty title="No tasks yet">The lead creates tasks from the goal. You can also add one with New task.</Empty>
      ) : (
        <div className="board" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(220px, 1fr))` }}>
          {columns.map((column) => (
            <section key={column.key} className={`column tone-${column.tone}`} aria-label={column.label}>
              <header className="column-head">
                <h2>{column.label}</h2>
                <span className="count">{groups[column.key].length}</span>
              </header>
              {groups[column.key].map((task) => (
                <TaskCard key={task.id} task={task} />
              ))}
              {groups[column.key].length === 0 ? <p className="column-empty">{column.hint}</p> : null}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function TaskCard({ task }: { task: Task }) {
  return (
    <a className={`task-card tone-${toneOf(task.status, task.blockedKind)}`} href={routeHref({ view: 'task', id: task.id })}>
      <div className="task-card-top">
        <span className="task-id">{task.id}</span>
        <StatusChip status={task.status} blockedKind={task.blockedKind} />
      </div>
      <p className="task-title">{task.title}</p>
      <div className="task-meta">
        <span className="priority" title="Priority: 0 is the most urgent">
          P{task.priority}
        </span>
        {task.kind !== 'code' ? <span>{task.kind}</span> : null}
        {task.assignee ? <span className="mono">{task.assignee}</span> : null}
      </div>
      {task.status === 'blocked' && task.blockedReason ? <p className="task-note">{task.blockedReason}</p> : null}
    </a>
  );
}

function NewTaskForm({ onCreated }: { onCreated: (task: Task) => void }) {
  const [draft, setDraft] = useState<TaskDraft>(EMPTY_DRAFT);
  const action = useAction();
  const update = <K extends keyof TaskDraft>(key: K, value: TaskDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const created = await action.run(() => api.createTask(draftToTask(draft)));
    if (created.ok) onCreated(created.value);
  };

  return (
    <form className="card form new-task" onSubmit={submit}>
      <h2>New task</h2>
      <div className="form-grid">
        <Field label="Title" className="span-2">
          <input value={draft.title} maxLength={200} onChange={(event) => update('title', event.target.value)} autoFocus />
        </Field>
        <Field label="Kind">
          <select value={draft.kind} onChange={(event) => update('kind', event.target.value as TaskKind)}>
            {TASK_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Priority">
          <select value={draft.priority} onChange={(event) => update('priority', Number(event.target.value))}>
            {PRIORITIES.map((priority) => (
              <option key={priority} value={priority}>
                P{priority}
                {priority === 0 ? ', most urgent' : ''}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Objective">
        <textarea rows={3} value={draft.objective} onChange={(event) => update('objective', event.target.value)} />
      </Field>
      <Field label="Why it matters" note="optional">
        <textarea rows={2} value={draft.why} onChange={(event) => update('why', event.target.value)} />
      </Field>
      <Field label="Acceptance criteria" note="one per line">
        <textarea rows={4} value={draft.acceptance} onChange={(event) => update('acceptance', event.target.value)} />
      </Field>
      <div className="form-grid">
        <Field label="Owned paths" note="one per line, optional">
          <textarea
            rows={3}
            className="mono"
            placeholder="src/auth/**"
            value={draft.ownedPaths}
            onChange={(event) => update('ownedPaths', event.target.value)}
          />
        </Field>
        <Field label="Depends on" note="optional">
          <input
            className="mono"
            placeholder="T-3, T-4"
            value={draft.dependsOn}
            onChange={(event) => update('dependsOn', event.target.value)}
          />
        </Field>
      </div>
      <div className="row">
        <button className="primary" disabled={!draftReady(draft) || action.busy}>
          Create task
        </button>
        {action.error ? <span className="error">{action.error}</span> : null}
      </div>
    </form>
  );
}

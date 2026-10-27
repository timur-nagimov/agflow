import { type GoalNote, type GoalVersion, diffGoal } from '@agflow/core';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import {
  ConfirmButton,
  DiffView,
  Empty,
  Linked,
  ErrorBox,
  Loading,
  MessageList,
  PageHead,
  Section,
  When,
} from '../components';
import { who } from '../format';
import { useAction, useData } from '../hooks';
import { useHub } from '../hub';

export function GoalView() {
  const { status, peopleSeen, markPeopleSeen } = useHub();
  const goal = useData(() => api.goal(), [], { relevant: (event) => event.type.startsWith('goal.') });
  const [editing, setEditing] = useState(false);
  // Messages newer than this were not seen before the page opened; they flash once.
  const [seenAtOpen] = useState(peopleSeen);
  const forPeople = status.data?.humansInbox ?? [];
  const newest = forPeople[0]?.id;
  useEffect(() => {
    if (newest !== undefined) markPeopleSeen(newest);
  }, [newest, markPeopleSeen]);
  if (!goal.data) return goal.error ? <ErrorBox error={goal.error} onRetry={goal.reload} /> : <Loading />;
  const { current, notes } = goal.data;
  const project = status.data?.project;

  return (
    <div className="page">
      <PageHead
        title="Goal"
        meta={
          current ? (
            <>
              Version {current.version} · set by {who(current.author)} · <When ts={current.createdAt} />
            </>
          ) : (
            'Not set yet'
          )
        }
        actions={
          <>
            {project ? (
              project.paused ? (
                <ConfirmButton label="Resume work" confirm="Resume all work" onConfirm={() => api.setPaused(false)} />
              ) : (
                <ConfirmButton label="Pause everything" confirm="Pause all work" danger onConfirm={() => api.setPaused(true)} />
              )
            ) : null}
            {editing ? null : (
              <button className="primary" onClick={() => setEditing(true)}>
                {current ? 'Edit goal' : 'Write the goal'}
              </button>
            )}
          </>
        }
      />
      {editing ? (
        <GoalEditor base={current} latest={current?.version ?? 0} onClose={() => setEditing(false)} />
      ) : current ? (
        <Charter goal={current} notes={notes} />
      ) : (
        <Empty title="No goal yet">
          Describe what the project should achieve. The lead turns the goal into tasks and re-plans whenever it changes.
        </Empty>
      )}
      {forPeople.length > 0 ? (
        <Section title="Messages for people">
          <MessageList messages={forPeople} newAfter={seenAtOpen} />
        </Section>
      ) : null}
      <History />
    </div>
  );
}

function Charter({ goal, notes }: { goal: GoalVersion; notes: GoalNote[] }) {
  return (
    <div className="charter-layout">
      <article className="card charter">
        <p className="charter-text">{goal.text}</p>
      </article>
      <aside className="marginalia" aria-label="How the lead reads the goal">
        <h2>How the lead reads it</h2>
        {notes.length === 0 ? (
          <p className="muted">The lead adds notes here on how it interprets this version.</p>
        ) : (
          notes.map((note) => (
            <figure key={note.id} className="margin-note">
              <blockquote>
                <Linked text={note.text} />
              </blockquote>
              <figcaption>
                {who(note.author)} · <When ts={note.createdAt} />
              </figcaption>
            </figure>
          ))
        )}
      </aside>
    </div>
  );
}

function GoalEditor({ base, latest, onClose }: { base: GoalVersion | null; latest: number; onClose: () => void }) {
  // The version being edited is fixed when editing starts, so a concurrent save is refused, not overwritten.
  const [start] = useState(base);
  const [text, setText] = useState(base?.text ?? '');
  const action = useAction();
  const before = start?.text ?? '';
  const baseVersion = start?.version ?? 0;
  const lines = useMemo(() => diffGoal(before, text), [before, text]);
  const changed = text.trim() !== '' && text !== before;

  const save = async () => {
    if ((await action.run(() => api.saveGoal(text, baseVersion))).ok) onClose();
  };

  return (
    <div className="editor-layout">
      <Section title={`Edit · saves as v${baseVersion + 1}`}>
        <textarea
          className="goal-input"
          rows={18}
          value={text}
          onChange={(event) => setText(event.target.value)}
          aria-label="Goal text"
          autoFocus
        />
        {latest > baseVersion ? (
          <p className="warn-text">
            Someone saved v{latest} while you were editing, so saving will be refused. Copy your text, discard, and edit the
            new version.
          </p>
        ) : null}
        <div className="row">
          <button className="primary" disabled={!changed || action.busy} onClick={save}>
            Save as v{baseVersion + 1}
          </button>
          <button onClick={onClose}>Discard</button>
        </div>
        {action.error ? <p className="error">{action.error}</p> : null}
      </Section>
      <Section title="What changes">
        {changed ? <DiffView lines={lines} /> : <p className="muted">Edit the text to see the changes here.</p>}
        <p className="hint">When you save, the lead receives these changes and re-plans the open tasks.</p>
      </Section>
    </div>
  );
}

function History() {
  const history = useData(() => api.goalHistory(), [], { relevant: (event) => event.type === 'goal.updated' });
  const [open, setOpen] = useState<number | null>(null);
  if (!history.data || history.data.length === 0) return null;
  return (
    <Section title="History">
      <ol className="versions">
        {history.data.map((version) => (
          <li key={version.version}>
            <div className="version-row">
              <button
                className="link version-toggle"
                aria-expanded={open === version.version}
                onClick={() => setOpen(open === version.version ? null : version.version)}
              >
                v{version.version}
              </button>
              <span className="meta">
                {who(version.author)} · <When ts={version.createdAt} />
              </span>
            </div>
            {open === version.version ? <VersionDiff version={version.version} /> : null}
          </li>
        ))}
      </ol>
    </Section>
  );
}

function VersionDiff({ version }: { version: number }) {
  const diff = useData(() => api.goalDiff(version - 1, version), [version]);
  if (!diff.data) return diff.error ? <p className="error">{diff.error.message}</p> : <Loading />;
  return <DiffView lines={diff.data} />;
}

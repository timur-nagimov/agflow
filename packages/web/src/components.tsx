import type {
  AgentStatus,
  AttemptLogEntry,
  BlockedKind,
  DiffLine,
  HubEvent,
  Message,
  MessageView,
  TaskStatus,
} from '@agflow/core';
import { type FormEvent, type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { LOG_KIND_LABELS, LOG_KIND_TONES, attemptLabel } from './attempts';
import {
  actorKind,
  ago,
  deliveryLabel,
  describeEvent,
  eventTone,
  repoLink,
  splitTaskMentions,
  statusLabel,
  targetLabel,
  type Tone,
  toneOf,
  who,
} from './format';
import { useAction, useNow } from './hooks';
import { routeHref } from './route';

export function StatusChip({ status, blockedKind = null }: { status: TaskStatus; blockedKind?: BlockedKind | null }) {
  return <span className={`chip tone-${toneOf(status, blockedKind)}`}>{statusLabel(status, blockedKind)}</span>;
}

const LAMP_TONES: Record<AgentStatus, string> = { active: 'done', idle: 'active', gone: 'closed' };

export function Lamp({ status }: { status: AgentStatus }) {
  return <span className={`lamp tone-${LAMP_TONES[status]}${status === 'active' ? ' pulse' : ''}`} title={status} />;
}

/** A relative time ("5 min ago"), or with `clock` the local time of day, plus the date when not today. */
export function When({ ts, clock = false }: { ts: number; clock?: boolean }) {
  const now = useNow();
  const date = new Date(ts);
  const sameDay = date.toDateString() === new Date(now).toDateString();
  const text = clock
    ? date.toLocaleString(undefined, sameDay ? { hour: '2-digit', minute: '2-digit' } : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : ago(ts, now);
  return (
    <time className="when" dateTime={date.toISOString()} title={clock ? ago(ts, now) : date.toLocaleString()}>
      {text}
    </time>
  );
}

export function TaskLink({ id }: { id: string }) {
  return (
    <a className="task-link" href={routeHref({ view: 'task', id })}>
      {id}
    </a>
  );
}

/** An attempt's short name ('a3', 'lead a5'), linked to its page; the full id is in the title. */
export function AttemptLink({ id }: { id: string }) {
  return (
    <a className="attempt-link" href={routeHref({ view: 'attempt', id })} title={id}>
      {attemptLabel(id)}
    </a>
  );
}

/** Text with task ids turned into links. */
export function Linked({ text }: { text: string }) {
  const parts = splitTaskMentions(text);
  return <>{parts.map((part, index) => (index % 2 === 1 ? <TaskLink key={index} id={part} /> : part))}</>;
}

export function RepoRef({ repo, kind, refName }: { repo: string | undefined; kind: 'branch' | 'commit'; refName: string }) {
  const label = kind === 'commit' ? refName.slice(0, 7) : refName;
  const href = repo ? repoLink(repo, kind, refName) : null;
  return href ? (
    <a className="mono" href={href} target="_blank" rel="noreferrer">
      {label}
    </a>
  ) : (
    <code>{label}</code>
  );
}

/** A labelled form control, with an optional note such as "optional" after the label. */
export function Field({ label, note, className, children }: { label: string; note?: string; className?: string; children: ReactNode }) {
  return (
    <label className={className}>
      <span>
        {label}
        {note ? <span className="field-note"> · {note}</span> : null}
      </span>
      {children}
    </label>
  );
}

export function PageHead({ title, meta, actions }: { title: ReactNode; meta?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <h1 className="page-title">{title}</h1>
        {meta ? <p className="page-meta">{meta}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

/** One labelled fact in a <dl className="facts">. */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * A bar for a fraction 0..1 with a mark at a limit, such as a quota window against its ceiling. An unknown value
 * draws no fill; `text` says it in words, for the eye and for screen readers.
 */
export function Meter({
  label,
  value,
  mark,
  tone,
  text,
}: {
  label: string;
  value: number | null;
  mark: number;
  tone: Tone;
  text: string;
}) {
  const share = (fraction: number) => `${Math.round(Math.min(1, Math.max(0, fraction)) * 1000) / 10}%`;
  return (
    <div className={`meter tone-${tone}`}>
      <div className="meter-head">
        <span className="meter-label">{label}</span>
        <span className="meter-text">{text}</span>
      </div>
      <div
        className="meter-bar"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value === null ? undefined : Math.round(value * 100)}
        aria-valuetext={text}
      >
        {value === null ? null : <span className="meter-fill" style={{ width: share(value) }} />}
        <span className="meter-mark" style={{ left: share(mark) }} />
      </div>
    </div>
  );
}

export function Section({ title, aside, children, className }: { title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card${className ? ` ${className}` : ''}`}>
      <header className="card-head">
        <h2>{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  );
}

export function Loading() {
  return (
    <div className="loading" role="status">
      <span className="lamp tone-active pulse" /> Loading…
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <div className="card error-card" role="alert">
      <p>{error.message}</p>
      {onRetry ? <button onClick={onRetry}>Try again</button> : null}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children ? <p className="empty-text">{children}</p> : null}
    </div>
  );
}

/** Asks for a second click before doing something hard to undo. */
export function ConfirmButton({
  label,
  confirm,
  onConfirm,
  danger = false,
}: {
  label: string;
  confirm: string;
  onConfirm: () => Promise<unknown>;
  danger?: boolean;
}) {
  const [asking, setAsking] = useState(false);
  const action = useAction();
  const ask = (value: boolean) => {
    action.clearError();
    setAsking(value);
  };
  if (!asking) {
    return (
      <button className={danger ? 'danger' : undefined} onClick={() => ask(true)}>
        {label}
      </button>
    );
  }
  return (
    <span className="confirm">
      <button
        className={danger ? 'danger solid' : 'primary'}
        disabled={action.busy}
        onClick={async (event) => {
          // The confirm button appears where the first button was, so a double-click must not confirm.
          if (event.detail > 1) return;
          if ((await action.run(onConfirm)).ok) setAsking(false);
        }}
      >
        {confirm}
      </button>
      <button onClick={() => ask(false)}>Keep</button>
      {action.error ? <span className="error">{action.error}</span> : null}
    </span>
  );
}

export function DiffView({ lines }: { lines: DiffLine[] }) {
  if (!lines.some((line) => line.op !== ' ')) return <p className="muted">No changes.</p>;
  return (
    <pre className="diff">
      {lines.map((line, index) => (
        <span key={index} className={line.op === '+' ? 'diff-add' : line.op === '-' ? 'diff-del' : 'diff-same'}>
          {line.op} {line.text}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}

/** An attempt's log, newest first, as the runner reported it. */
export function AttemptLog({ entries }: { entries: AttemptLogEntry[] }) {
  if (entries.length === 0) return <p className="muted">Nothing logged yet.</p>;
  return (
    <ol className="log attempt-log">
      {[...entries].reverse().map((entry) => (
        <li key={entry.id} className={`log-row tone-${LOG_KIND_TONES[entry.kind]}`}>
          <span className="log-mark" />
          <When ts={entry.ts} clock />
          <span className="log-text">
            <span className="log-kind">{LOG_KIND_LABELS[entry.kind]}</span>
            <Linked text={entry.summary} />
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * A command to run, with a Copy button. Where the clipboard API is missing, as on a hub served over plain http, Copy
 * selects the command instead, for the person to copy themselves.
 */
export function CommandBlock({ command, label }: { command: string; label: string }) {
  const code = useRef<HTMLElement>(null);
  const [done, setDone] = useState<'copied' | 'selected' | null>(null);
  useEffect(() => {
    if (done === null) return;
    const timer = setTimeout(() => setDone(null), 2500);
    return () => clearTimeout(timer);
  }, [done]);

  const select = () => {
    const selection = window.getSelection();
    if (!code.current || !selection) return;
    selection.selectAllChildren(code.current);
    setDone('selected');
  };
  const copy = async () => {
    if (!navigator.clipboard) return select();
    try {
      await navigator.clipboard.writeText(command);
      setDone('copied');
    } catch {
      select();
    }
  };

  return (
    <div className="command-block">
      <pre aria-label={label}>
        <code ref={code}>{command}</code>
      </pre>
      <button className="small" onClick={() => void copy()}>
        {done === 'copied' ? 'Copied' : 'Copy'}
      </button>
      {done === 'selected' ? <span className="hint">Selected: press ⌘C or Ctrl+C to copy it.</span> : null}
    </div>
  );
}

export function EventList({ events }: { events: HubEvent[] }) {
  // Events newer than the first render arrived live; they flash once.
  const seen = useRef<number | null>(null);
  if (seen.current === null) seen.current = events[0]?.id ?? 0;
  const firstSeen = seen.current;
  if (events.length === 0) return <p className="muted">Nothing yet.</p>;
  return (
    <ol className="log">
      {events.map((event) => (
        <li key={event.id} className={`log-row tone-${eventTone(event.type, event.data)}${event.id > firstSeen ? ' fresh' : ''}`}>
          <span className="log-mark" />
          <When ts={event.ts} clock />
          <span className="log-text">
            <Linked text={describeEvent(event)} />
          </span>
        </li>
      ))}
    </ol>
  );
}

export function MessageList({ messages, newAfter }: { messages: (Message | MessageView)[]; newAfter?: number }) {
  if (messages.length === 0) return <p className="muted">No messages yet.</p>;
  return (
    <ol className="messages">
      {messages.map((message) => {
        const delivery = deliveryLabel(message);
        const fresh = newAfter !== undefined && message.id > newAfter;
        return (
          <li key={message.id} className={`message from-${actorKind(message.from)}${fresh ? ' fresh' : ''}`}>
            <div className="message-head">
              <span className="message-from">{who(message.from)}</span>
              <span className="message-arrow">→</span>
              <span>{targetLabel(message.to)}</span>
              {message.taskId && message.to !== `task:${message.taskId}` ? <TaskLink id={message.taskId} /> : null}
              {message.standingRule ? <span className="chip tone-review">Standing rule</span> : null}
              <When ts={message.createdAt} />
            </div>
            <div className="message-body">
              <Linked text={message.body} />
            </div>
            {delivery ? <div className="message-foot">{delivery}</div> : null}
          </li>
        );
      })}
    </ol>
  );
}

export function Composer({
  to,
  taskId,
  allowRule = false,
  placeholder,
}: {
  to: string;
  /** The task the message is about, for a message that is not addressed to the task's own thread. */
  taskId?: string;
  allowRule?: boolean;
  placeholder: string;
}) {
  const [body, setBody] = useState('');
  const [rule, setRule] = useState(false);
  const action = useAction();
  const text = body.trim();

  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!text || action.busy) return;
    const sent = await action.run(() =>
      api.sendMessage({ to, body: text, taskId, standingRule: allowRule && rule ? true : undefined }),
    );
    if (sent.ok) {
      setBody('');
      setRule(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void send();
  };

  return (
    <form className="composer" onSubmit={send}>
      <textarea
        rows={3}
        value={body}
        placeholder={placeholder}
        aria-label={`Message to ${targetLabel(to)}`}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="composer-bar">
        {allowRule ? (
          <label className="check">
            <input type="checkbox" checked={rule} onChange={(event) => setRule(event.target.checked)} />
            Standing rule: add it to every agent's brief until someone removes it
          </label>
        ) : null}
        <span className="hint">Ctrl or ⌘ + Enter</span>
        <button className="primary" disabled={!text || action.busy}>
          Send to {targetLabel(to)}
        </button>
      </div>
      {action.error ? <p className="error">{action.error}</p> : null}
    </form>
  );
}

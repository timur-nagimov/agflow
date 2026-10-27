import type { HubEvent } from '@agflow/core';
import { type FormEvent, useState } from 'react';
import { api } from '../api';
import {
  ConfirmButton,
  Empty,
  ErrorBox,
  Linked,
  Loading,
  MessageList,
  PageHead,
  Section,
  StatusChip,
  TaskLink,
  When,
} from '../components';
import { targetLabel, who } from '../format';
import { useData } from '../hooks';

const rulesChanged = (event: HubEvent) =>
  event.type === 'rule.removed' || (event.type === 'message.sent' && event.data.standingRule === true);

export function KnowledgeView() {
  return (
    <div className="page">
      <PageHead title="Knowledge" meta="Standing rules every agent follows, and search across the project" />
      <Rules />
      <Search />
    </div>
  );
}

function Rules() {
  const rules = useData(() => api.rules(), [], { relevant: rulesChanged });
  return (
    <Section title="Standing rules">
      <p className="hint">Every agent's brief includes these. Add one on the Messages page by ticking “Standing rule”.</p>
      {rules.data ? (
        rules.data.length === 0 ? (
          <Empty title="No standing rules" />
        ) : (
          <ol className="rules">
            {rules.data.map((rule) => (
              <li key={rule.id} className="rule">
                <p className="rule-text">
                  <Linked text={rule.body} />
                </p>
                <div className="rule-foot">
                  <span className="meta">
                    #{rule.id} · {who(rule.from)} to {targetLabel(rule.to)} · <When ts={rule.createdAt} />
                  </span>
                  <ConfirmButton label="Remove" confirm="Remove rule" danger onConfirm={() => api.removeRule(rule.id)} />
                </div>
              </li>
            ))}
          </ol>
        )
      ) : rules.error ? (
        <ErrorBox error={rules.error} onRetry={rules.reload} />
      ) : (
        <Loading />
      )}
    </Section>
  );
}

function Search() {
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const results = useData(() => (query ? api.search(query) : Promise.resolve(null)), [query]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setQuery(input.trim());
  };
  const found = results.data;

  return (
    <Section title="Search">
      <form className="search" onSubmit={submit}>
        <input
          type="search"
          value={input}
          placeholder="Search tasks, messages and the goal"
          aria-label="Search"
          onChange={(event) => setInput(event.target.value)}
        />
        <button>Search</button>
      </form>
      {results.error ? <p className="error">{results.error.message}</p> : null}
      {query && found === undefined && !results.error ? <Loading /> : null}
      {found ? (
        found.tasks.length + found.messages.length === 0 && !found.goal ? (
          <p className="muted">Nothing matches “{query}”.</p>
        ) : (
          <div className="results">
            {found.goal ? (
              <>
                <h3>Goal v{found.goal.version}</h3>
                <p className="pre snippet">…{found.goal.snippet}…</p>
              </>
            ) : null}
            {found.tasks.length > 0 ? (
              <>
                <h3>Tasks</h3>
                <ul className="plain result-tasks">
                  {found.tasks.map((task) => (
                    <li key={task.id}>
                      <TaskLink id={task.id} /> {task.title} <StatusChip status={task.status} blockedKind={task.blockedKind} />
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {found.messages.length > 0 ? (
              <>
                <h3>Messages</h3>
                <MessageList messages={found.messages} />
              </>
            ) : null}
          </div>
        )
      ) : null}
    </Section>
  );
}

import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Composer, Empty, ErrorBox, Loading, MessageList, PageHead } from '../components';
import { inConversation, targetLabel, targetOptions } from '../format';
import { useData } from '../hooks';
import { useHub } from '../hub';

export function MessagesView({ to }: { to?: string }) {
  const { status, tasks } = useHub();
  const messages = useData(() => api.messages({ limit: 300 }), [], {
    relevant: (event) => event.type.startsWith('message.'),
  });
  const agents = useData(() => api.agents(), [], { relevant: (event) => event.type.startsWith('agent.') });
  const [filter, setFilter] = useState(to ?? 'everything');
  const [target, setTarget] = useState(to ?? 'lead');
  const leadId = status.data?.lead?.id ?? null;
  const options = targetOptions(agents.data ?? [], tasks.data ?? [], to);
  const shown = (messages.data ?? []).filter((message) => inConversation(message, filter, leadId)).reverse();
  const chat = useRef<HTMLElement>(null);
  const newestShown = shown.at(-1)?.id;
  useEffect(() => {
    if (chat.current) chat.current.scrollTop = chat.current.scrollHeight;
  }, [newestShown]);

  return (
    <div className="page">
      <PageHead
        title="Messages"
        meta="Steer the lead and the agents. Instructions from people take precedence over the lead's."
        actions={
          <label className="inline">
            Show
            <select value={filter} onChange={(event) => setFilter(event.target.value)}>
              <option value="everything">Everything</option>
              {options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        }
      />
      <section className="card chat" ref={chat}>
        {messages.data ? (
          shown.length > 0 ? (
            <MessageList messages={shown} />
          ) : (
            <Empty title="No messages here yet">
              {filter === 'everything' ? 'Write to the lead below.' : `Nothing exchanged with ${targetLabel(filter)} yet.`}
            </Empty>
          )
        ) : messages.error ? (
          <ErrorBox error={messages.error} onRetry={messages.reload} />
        ) : (
          <Loading />
        )}
      </section>
      <section className="card">
        <label className="inline composer-to">
          To
          <select
            value={target}
            onChange={(event) => {
              setTarget(event.target.value);
              if (filter !== 'everything') setFilter(event.target.value);
            }}
          >
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <Composer to={target} allowRule placeholder="Tell the lead what to change, or give an agent an instruction…" />
      </section>
    </div>
  );
}

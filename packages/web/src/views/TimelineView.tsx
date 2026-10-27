import { useMemo, useState } from 'react';
import { api } from '../api';
import { ErrorBox, EventList, Loading, PageHead } from '../components';
import { EVENT_CATEGORIES, type EventCategory, categoryOf, mergeEvents } from '../format';
import { useData } from '../hooks';
import { useRecentEvents } from '../live';

const PAGE = 200;
const MAX = 1000;

export function TimelineView() {
  const [limit, setLimit] = useState(PAGE);
  const history = useData(() => api.events({ latest: true, limit }), [limit], { keep: true });
  const recent = useRecentEvents();
  const [category, setCategory] = useState<EventCategory | 'all'>('all');
  const events = useMemo(() => mergeEvents(recent, history.data ?? []), [recent, history.data]);
  if (!history.data) return history.error ? <ErrorBox error={history.error} onRetry={history.reload} /> : <Loading />;
  const shown = category === 'all' ? events : events.filter((event) => categoryOf(event.type) === category);

  return (
    <div className="page">
      <PageHead title="Timeline" meta="Everything that happened, newest first" />
      <div className="filters" role="group" aria-label="Filter">
        {[{ key: 'all' as const, label: 'All' }, ...EVENT_CATEGORIES].map((option) => (
          <button
            key={option.key}
            className="filter"
            aria-pressed={category === option.key}
            onClick={() => setCategory(option.key)}
          >
            {option.label}
          </button>
        ))}
      </div>
      <section className="card">
        <EventList events={shown} />
        {history.data.length === limit && limit < MAX ? (
          <div className="row">
            <button onClick={() => setLimit(Math.min(MAX, limit + PAGE))}>Show older</button>
          </div>
        ) : null}
      </section>
    </div>
  );
}

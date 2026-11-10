import { useMemo, useState } from 'react';
import { api } from '../api';
import { ErrorBox, EventList, Loading, PageHead } from '../components';
import { EVENT_CATEGORIES, type EventCategory, categoryOf, mergeEvents } from '../format';
import { useData } from '../hooks';
import { useRecentEvents } from '../live';
import { inTimelineSubject, routeHref, timelineQuery } from '../route';

const PAGE = 200;
const MAX = 1000;

/**
 * Every event, newest first, or one subject's (X-23): a runner's, or an attempt's. A task attempt's events are asked
 * for by its task and kept by data.attemptId, so "Show older" may add fewer than a page of them; the hub has no
 * attempt filter.
 */
export function TimelineView({ subject }: { subject?: string }) {
  const [limit, setLimit] = useState(PAGE);
  const query = subject ? timelineQuery(subject) : null;
  const history = useData(() => api.events({ latest: true, limit, subject: query?.subject }), [limit], { keep: true });
  const recent = useRecentEvents();
  const [category, setCategory] = useState<EventCategory | 'all'>('all');
  const events = useMemo(() => {
    const merged = mergeEvents(recent, history.data ?? []);
    return subject ? merged.filter((event) => inTimelineSubject(event, subject)) : merged;
  }, [recent, history.data, subject]);
  if (!history.data) return history.error ? <ErrorBox error={history.error} onRetry={history.reload} /> : <Loading />;
  const shown = category === 'all' ? events : events.filter((event) => categoryOf(event.type) === category);

  return (
    <div className="page">
      <PageHead
        title="Timeline"
        meta={
          subject ? (
            <>
              The events of <span className="mono timeline-subject">{subject}</span>, newest first ·{' '}
              <a href={routeHref({ view: 'timeline' })}>Show everything</a>
            </>
          ) : (
            'Everything that happened, newest first'
          )
        }
      />
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

import type { Database } from 'bun:sqlite';
import type { HubEvent } from '@agflow/core';

export interface NewEvent {
  type: string;
  actor: string;
  subject?: string | null;
  data?: Record<string, unknown>;
}

export type Emit = (event: NewEvent) => HubEvent;
type Listener = (event: HubEvent) => void;

interface EventRow {
  id: number;
  ts: number;
  type: string;
  actor: string;
  subject: string | null;
  data: string;
}

function rowToEvent(row: EventRow): HubEvent {
  return {
    id: row.id,
    ts: row.ts,
    type: row.type,
    actor: row.actor,
    subject: row.subject,
    data: JSON.parse(row.data) as Record<string, unknown>,
  };
}

export function insertEvent(db: Database, ts: number, event: NewEvent): HubEvent {
  const row = db
    .query('INSERT INTO events (ts, type, actor, subject, data) VALUES ($ts, $type, $actor, $subject, $data) RETURNING *')
    .get({
      ts,
      type: event.type,
      actor: event.actor,
      subject: event.subject ?? null,
      data: JSON.stringify(event.data ?? {}),
    }) as EventRow;
  return rowToEvent(row);
}

export interface EventQuery {
  after?: number | undefined;
  limit?: number | undefined;
  subject?: string | undefined;
  latest?: boolean | undefined;
}

export function listEvents(db: Database, query: EventQuery = {}): HubEvent[] {
  const limit = Math.max(1, Math.min(query.limit ?? 200, 1000));
  const order = query.latest ? 'DESC' : 'ASC';
  const rows = db
    .query(
      `SELECT * FROM events WHERE id > $after AND ($subject IS NULL OR subject = $subject) ORDER BY id ${order} LIMIT $limit`,
    )
    .all({ after: query.after ?? 0, subject: query.subject ?? null, limit }) as EventRow[];
  return rows.map(rowToEvent);
}

export class EventBus {
  private readonly listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(event: HubEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('event listener failed', error);
      }
    }
  }
}

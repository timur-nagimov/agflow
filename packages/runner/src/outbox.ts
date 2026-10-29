// The outbox (design 6.3, "Events"): every event the runner reports is stored here with an AUTOINCREMENT seq before
// it is sent, and replayed after each welcome until the hub acknowledges it. Acknowledgements are cumulative and
// belong to one outbox epoch. M2c's retention prunes it (X-7); the runtime schedules nothing here.
import { parseRunnerEvent, type RunnerEvent } from '@agflow/core';
import type { RunnerDb } from './db';

/** An event as the outbox stores and sends it. */
export type StoredEvent = RunnerEvent;

type WithoutStamp<E> = E extends RunnerEvent ? Omit<E, 'seq' | 'at'> : never;
/** An event before the outbox gives it its seq and time. */
export type NewEvent = WithoutStamp<RunnerEvent>;

/**
 * The largest event the outbox stores, as serialized JSON: 1 MiB, far under the hub's 16 MB message limit, so the
 * link can always send one event alone. Producers clip agent-controlled lists to stay under it.
 */
export const MAX_EVENT_BYTES = 1024 * 1024;

interface Waiter {
  seq: number;
  resolve(acked: boolean): void;
  timer: ReturnType<typeof setTimeout>;
}

export class Outbox {
  private readonly now: () => number;
  private readonly listeners = new Set<(event: StoredEvent) => void>();
  private readonly waiters = new Set<Waiter>();
  /** The highest seq announced to the listeners. */
  private announcedSeq = 0;
  private announcing = false;

  constructor(
    private readonly db: RunnerDb,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  /** The epoch hello reports and acks name. */
  get epoch(): string {
    return this.db.outboxEpoch;
  }

  /**
   * Stores an event and tells the listeners (the link streams it). The hub would only reject an event its schema
   * cannot read, so such an event is refused here, where the bug is; so is one over MAX_EVENT_BYTES, which would
   * block every event after it. An append may share a synchronous transaction with other writes.
   */
  append(event: NewEvent): StoredEvent {
    const at = this.now();
    const parsed = parseRunnerEvent({ seq: Number.MAX_SAFE_INTEGER, at, ...event });
    if (!parsed.ok) throw new Error(`the outbox refused an event: ${parsed.error}`);
    const json = JSON.stringify(event);
    // The stored event adds its seq and at to this; 64 bytes covers both.
    const bytes = Buffer.byteLength(json) + 64;
    if (bytes > MAX_EVENT_BYTES) {
      throw new Error(`the outbox refused a ${event.type} event of ${bytes} bytes: too large (${MAX_EVENT_BYTES} max)`);
    }
    const attemptId = 'attemptId' in event ? event.attemptId : null;
    const { seq } = this.db.sqlite
      .query(`INSERT INTO outbox (at, type, attempt_id, event) VALUES ($at, $type, $attemptId, $event) RETURNING seq`)
      .get({ at, type: event.type, attemptId, event: json }) as { seq: number };
    this.scheduleAnnounce();
    return { seq, at, ...event } as StoredEvent;
  }

  /**
   * Called with each committed event, in seq order, from a microtask after the append: by then a surrounding
   * transaction has committed or rolled back, and a rolled-back event (whose seq SQLite hands out again) is never
   * announced. Returns the unsubscribe.
   */
  onAppend(listener: (event: StoredEvent) => void): () => void {
    // Nothing is announced while nobody listens, so a first listener starts from the events still to come.
    if (this.listeners.size === 0) this.announcedSeq = this.lastAssigned();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The kept events after seq, in seq order. */
  eventsAfter(seq: number, limit = Number.MAX_SAFE_INTEGER): StoredEvent[] {
    const rows = this.db.sqlite
      .query('SELECT seq, at, event FROM outbox WHERE seq > $seq ORDER BY seq LIMIT $limit')
      .all({ seq, limit }) as { seq: number; at: number; event: string }[];
    return rows.map((row) => ({ seq: row.seq, at: row.at, ...JSON.parse(row.event) }) as StoredEvent);
  }

  /** The lowest kept seq, or the next seq when none is kept. */
  firstSeq(): number {
    const row = this.db.sqlite.query('SELECT MIN(seq) AS seq FROM outbox').get() as { seq: number | null };
    return row.seq ?? this.lastAssigned() + 1;
  }

  /** The highest seq held, or firstSeq - 1 when the outbox is empty (X-1). */
  lastSeq(): number {
    const row = this.db.sqlite.query('SELECT MAX(seq) AS seq FROM outbox').get() as { seq: number | null };
    return row.seq ?? this.firstSeq() - 1;
  }

  /** The highest seq the hub has acknowledged in this outbox epoch. */
  ackedSeq(): number {
    return (this.db.sqlite.query('SELECT seq FROM outbox_ack WHERE id = 1').get() as { seq: number }).seq;
  }

  /** A cumulative ack. An ack of another epoch (an older runner.db) is ignored; gives whether it applied. */
  ack(epoch: string, seq: number): boolean {
    if (epoch !== this.epoch) return false;
    this.db.sqlite.query('UPDATE outbox_ack SET seq = MAX(seq, $seq) WHERE id = 1').run({ seq });
    const acked = this.ackedSeq();
    for (const waiter of [...this.waiters]) {
      if (waiter.seq <= acked) this.settle(waiter, true);
    }
    return true;
  }

  /** Resolves true once the hub has acknowledged seq (at once if it has), false after timeoutMs. */
  waitAcked(seq: number, timeoutMs: number): Promise<boolean> {
    if (seq <= this.ackedSeq()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const waiter: Waiter = { seq, resolve, timer: setTimeout(() => this.settle(waiter, false), timeoutMs) };
      this.waiters.add(waiter);
    });
  }

  /** Drops acknowledged events older than olderThanMs, the 48 h retention (design 6.3). Gives how many. */
  pruneAcked(olderThanMs: number): number {
    return this.db.sqlite
      .query('DELETE FROM outbox WHERE seq <= (SELECT seq FROM outbox_ack WHERE id = 1) AND at < $cutoff')
      .run({ cutoff: this.now() - olderThanMs }).changes;
  }

  /** Drops every event older than at, acknowledged or not (M2c's 14-day cutoff). Gives how many. */
  pruneBefore(at: number): number {
    return this.db.sqlite.query('DELETE FROM outbox WHERE at < $at').run({ at }).changes;
  }

  // AUTOINCREMENT never reuses a seq, so after a prune the outbox continues from the last one it assigned.
  private lastAssigned(): number {
    const row = this.db.sqlite.query("SELECT seq FROM sqlite_sequence WHERE name = 'outbox'").get() as {
      seq: number;
    } | null;
    return row?.seq ?? 0;
  }

  private scheduleAnnounce(): void {
    if (this.announcing || this.listeners.size === 0) return;
    this.announcing = true;
    queueMicrotask(() => {
      this.announcing = false;
      if (this.listeners.size === 0) return;
      const events = this.eventsAfter(this.announcedSeq);
      const last = events.at(-1);
      if (!last) return;
      this.announcedSeq = last.seq;
      for (const event of events) {
        for (const listener of [...this.listeners]) listener(event);
      }
    });
  }

  private settle(waiter: Waiter, acked: boolean): void {
    if (!this.waiters.delete(waiter)) return;
    clearTimeout(waiter.timer);
    waiter.resolve(acked);
  }
}

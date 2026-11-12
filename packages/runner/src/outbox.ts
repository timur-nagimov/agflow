// The outbox (design 6.3, "Events"): every event the runner reports is stored here with an AUTOINCREMENT seq before
// it is sent, and replayed after each welcome until the hub acknowledges it. Acknowledgements are cumulative and
// belong to one outbox epoch. M2c's retention prunes it (X-7); the runtime schedules nothing here.
import { parseRunnerEvent, type RunnerEvent, type SettingsAnswer } from '@agflow/core';
import type { RunnerDb, SettingsMark } from './db';

/** An event as the outbox stores and sends it. */
export type StoredEvent = RunnerEvent;

type WithoutStamp<E> = E extends RunnerEvent ? Omit<E, 'seq' | 'at'> : never;
/** An event before the outbox gives it its seq and time. */
export type NewEvent = WithoutStamp<RunnerEvent>;

/** A runner.settings event: local settings edits, which the hub applies and echoes with update_settings (X-12). */
export type SettingsEvent = Extract<StoredEvent, { type: 'runner.settings' }>;

/** The exact edit answered, with explicit refusals for logging. */
export interface SettingsEcho {
  answered: SettingsEvent | null;
  refused: SettingsEvent[];
}

export interface OutboxOptions {
  now?: () => number;
  /**
   * The version of the confirmed settings snapshot the runner holds (X-12). A mark of settingsEchoed counts once the
   * snapshot has reached its version: until then its edit is still in flight. By default the version runner.json was
   * last written with (settingsSaved), so an Outbox built for retention alone, as M2c's is, counts no mark the file
   * has not reached.
   */
  confirmedVersion?: () => number;
}

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
  private readonly confirmedVersion: () => number;
  private readonly listeners = new Set<(event: StoredEvent) => void>();
  private readonly waiters = new Set<Waiter>();
  /** The highest seq announced to the listeners. */
  private announcedSeq = 0;
  private announcing = false;

  constructor(
    private readonly db: RunnerDb,
    options: OutboxOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.confirmedVersion = options.confirmedVersion ?? (() => this.savedVersion());
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

  /**
   * The runner.settings events whose effect the confirmed snapshot does not hold yet, in seq order: every one the
   * outbox keeps, acknowledged or not, but those a mark answers at a version the snapshot has reached
   * (confirmedVersion by default). The hub applies each one whatever its base and answers it with an update_settings
   * that carries its settings verbatim; an acknowledgement says nothing of whether the runner has had that echo yet,
   * as the owner's echoes may come first and wait behind the runner's other commands.
   */
  settingsInFlight(confirmedVersion = this.confirmedVersion()): SettingsEvent[] {
    const answered = new Set(this.marks().flatMap((mark) => (mark.version <= confirmedVersion ? [mark.seq] : [])));
    return this.settingsEvents().filter((event) => !answered.has(event.seq));
  }

  /**
   * runner.json has been written with a snapshot at version: SettingsSync after each write, the runtime at start. An
   * Outbox built without confirmedVersion counts the marks up to it, and pruning counts none above it.
   */
  settingsSaved(version: number): void {
    this.db.setMeta('settingsSavedVersion', version);
  }

  /** Highest contiguous settings answer included in this snapshot; retained after events are pruned. */
  settingsAnsweredSeq(version = this.confirmedVersion()): number {
    const saved = this.db.meta('settingsAnswered');
    let seq = saved && saved.version <= version ? saved.seq : 0;
    const marks = new Map(this.marks().map(mark => [mark.seq, mark]));
    for (const event of this.settingsEvents()) {
      if (event.seq <= seq) continue;
      const mark = marks.get(event.seq);
      if (!mark || mark.version > version) break;
      seq = event.seq;
    }
    return seq;
  }

  /** Exact answers are durable before runner.json changes and count only at their snapshot version. */
  markSettingsEcho(
    answer: SettingsAnswer | undefined,
    version: number,
    arrivedAfter = Number.MAX_SAFE_INTEGER,
  ): SettingsEcho {
    if (!answer || answer.outboxEpoch !== this.epoch || answer.seq > arrivedAfter) {
      return { answered: null, refused: [] };
    }
    const events = this.settingsEvents();
    const answered = events.find(event => event.seq === answer.seq);
    if (!answered) return { answered: null, refused: [] };
    const kept = new Set(events.map(event => event.seq));
    const marks = this.marks().filter(mark => kept.has(mark.seq) && mark.seq !== answer.seq);
    this.db.setMeta('settingsEchoed', [
      ...marks,
      { seq: answer.seq, version, ...(answer.refused ? { refused: true as const } : {}) },
    ]);
    return { answered, refused: answer.refused ? [answered] : [] };
  }

  /**
   * Drops acknowledged events older than olderThanMs, the 48 h retention (design 6.3), but the runner.settings edits
   * still in flight. Gives how many.
   */
  pruneAcked(olderThanMs: number): number {
    return this.prune('seq <= (SELECT seq FROM outbox_ack WHERE id = 1) AND at < $cutoff', {
      cutoff: this.now() - olderThanMs,
    });
  }

  /**
   * Drops every event older than at, acknowledged or not (M2c's 14-day cutoff), but the runner.settings edits still
   * in flight. Gives how many.
   */
  pruneBefore(at: number): number {
    return this.prune('at < $at', { at });
  }

  /**
   * Deletes the events the condition selects, and the marks of those it deleted, but keeps every runner.settings edit
   * in flight (settingsInFlight) for the snapshot runner.json was last written with: with one pruned, the next start
   * could find runner.json ahead of the snapshot and its edits in flight, and send the edit again, though the hub
   * applied it (X-12). The contiguous answer watermark survives pruning.
   */
  private prune(condition: string, params: Record<string, number>): number {
    const confirmed = Math.min(this.confirmedVersion(), this.savedVersion());
    const edits = this.settingsInFlight(confirmed);
    this.db.setMeta('settingsAnswered', { seq: this.settingsAnsweredSeq(confirmed), version: confirmed });
    const keep = JSON.stringify(edits.map((event) => event.seq));
    const { changes } = this.db.sqlite
      .query(`DELETE FROM outbox WHERE ${condition} AND seq NOT IN (SELECT value FROM json_each($keep))`)
      .run({ ...params, keep });
    if (changes > 0) {
      const kept = new Set(this.settingsEvents().map((event) => event.seq));
      const marks = this.marks();
      const live = marks.filter((mark) => kept.has(mark.seq));
      if (live.length !== marks.length) this.db.setMeta('settingsEchoed', live);
    }
    return changes;
  }

  private marks(): SettingsMark[] {
    return this.db.meta('settingsEchoed') ?? [];
  }

  private savedVersion(): number {
    return this.db.meta('settingsSavedVersion') ?? 0;
  }

  private settingsEvents(): SettingsEvent[] {
    const rows = this.db.sqlite
      .query("SELECT seq, at, event FROM outbox WHERE type = 'runner.settings' ORDER BY seq")
      .all() as { seq: number; at: number; event: string }[];
    return rows.map((row) => ({ seq: row.seq, at: row.at, ...JSON.parse(row.event) }) as SettingsEvent);
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

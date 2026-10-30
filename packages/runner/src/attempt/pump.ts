// The event pump (design 6.3, 6.7, 6.10, 7.4): one per live agent, turning its AgentEvents into outbox events and
// phases, and carrying the hub's deliveries and approval answers to it.
// - Activity: tools, turns, text, compactions and vendor errors become attempt.activity with a clipped summary;
//   adapter warnings are notes (X-3). A successor's first assistant text is attempt.first_output.
// - Deliveries: each InjectedMessage is sent with its authority under an id of the runner's, which maps the
//   vendor's delivered and acknowledged events back to hub message ids. Message 0 (hub text) and the one line
//   about deliver.more are never reported (X-4).
// - Approvals (X-9): each vendor request gets a runner-minted UUID, held in memory with the vendor's id, and becomes
//   approval.requested with the fence and the adapter's enriched detail, its texts clipped to fit the outbox; the
//   owner gets one notification keyed by that UUID. A withdrawn request is approval.voided; decide_approval answers at once whether it applied.
//   A request the outbox refuses all the same is declined to the agent with the reason, so it never waits in vain.
// - Descendants: every tool start, and every 5 s while a tool runs, snapshots the agent's descendants and records
//   their groups, so a tool's group can be stopped even after its parent is gone.
import { randomUUID } from 'node:crypto';
import { type Approval, APPROVALS_ROUTE, type AttemptPhase, type AttemptSpec, type InjectedMessage } from '@agflow/core';
import type { AgentEvent, AgentSession, VendorAdapter } from '../adapters/types';
import type { AttemptStore } from '../attempt-store';
import type { Logger } from '../log';
import type { NewEvent } from '../outbox';
import { DescendantTracker, type ProcessIdentity } from '../processes';
import type { Notifier } from '../seams';

/** The longest attempt.activity summary: 500 characters. */
export const ACTIVITY_SUMMARY_MAX = 500;
/** The longest compaction summary and first output: 4,000 characters, as long as the handoff note quotes. */
export const LONG_TEXT_MAX = 4_000;
/** How often descendants are snapshotted while a tool runs (design 7.4). */
export const DESCENDANT_SNAPSHOT_MS = 5_000;
/** The longest approval summary: 4,000 characters. */
export const APPROVAL_SUMMARY_MAX = 4_000;
/**
 * The most bytes one approval detail field takes in the event's JSON: 64 KB, so the six fields stay far below the
 * outbox's 1 MB however the agent's text escapes. A manifest diff after an install easily passes 1 MB.
 */
export const APPROVAL_DETAIL_FIELD_MAX_BYTES = 64 * 1024;
const CLIPPED = '\n[clipped]';
/**
 * The decline reason, and the activity note, of an approval request the outbox refused: nobody can decide it, so the
 * agent hears why instead of waiting for an answer that never comes.
 */
export const APPROVAL_NOT_FORWARDED =
  'agflow declined this approval request: it was too large to forward for a decision. Ask for a smaller step.';

type AttemptEvent = Extract<NewEvent, { attemptId: string }>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** An event of this attempt, before the controller adds its id and fence. */
export type PumpEvent = DistributiveOmit<AttemptEvent, 'attemptId' | 'fence'>;

/** Text cut to max characters, an ellipsis marking the cut. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Text cut so that its JSON takes at most maxBytes, a '[clipped]' line marking the cut. */
export function clipJsonBytes(text: string, maxBytes: number): string {
  let kept = text;
  for (;;) {
    const candidate = kept === text ? text : `${kept}${CLIPPED}`;
    const bytes = Buffer.byteLength(JSON.stringify(candidate));
    if (bytes <= maxBytes || kept === '') return candidate;
    kept = kept.slice(0, Math.floor((kept.length * maxBytes) / bytes) - CLIPPED.length);
  }
}

/** An approval's detail with every text field clipped (APPROVAL_DETAIL_FIELD_MAX_BYTES). */
export function clipApprovalDetail(detail: Approval['detail']): Approval['detail'] {
  const clipped: Approval['detail'] = {};
  for (const [key, value] of Object.entries(detail) as [keyof Approval['detail'], string | undefined][]) {
    if (value !== undefined) clipped[key] = clipJsonBytes(value, APPROVAL_DETAIL_FIELD_MAX_BYTES);
  }
  return clipped;
}

/** The line deliver.more adds (X-4). */
export function moreMessagesLine(more: number): string {
  return `${more} more agflow messages are waiting: call check_inbox`;
}

export interface EventPumpOptions {
  spec: Pick<AttemptSpec, 'attemptId' | 'successor' | 'hubUrl'>;
  session: AgentSession;
  adapter: Pick<VendorAdapter, 'enrichApproval'>;
  store: AttemptStore;
  notifier: Notifier;
  logger: Logger;
  clone: string;
  vault: string;
  startSha: string;
  /** Appends one of this attempt's events with its current fence. */
  report(event: PumpEvent): void;
  setPhase(phase: AttemptPhase): void;
  /** The agent's own recorded group, the root of every descendant snapshot. */
  root(): Promise<ProcessIdentity | null>;
  /** DESCENDANT_SNAPSHOT_MS by default. */
  snapshotEveryMs?: number;
}

export class EventPump {
  private readonly options: EventPumpOptions;
  /** Our send ids to hub message ids; null for lines that are never reported. */
  private readonly sent = new Map<string, number | null>();
  /** Pending approvals: our UUID to the vendor's id, and back. */
  private readonly approvals = new Map<string, string>();
  private readonly approvalIds = new Map<string, string>();
  private readonly tools = new Set<string>();
  private readonly descendants = new DescendantTracker();
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;
  private snapshotting: Promise<void> = Promise.resolve();
  private firstOutputSent = false;
  private wroteHandoff = false;

  constructor(options: EventPumpOptions) {
    this.options = options;
  }

  /** Whether the agent wrote its handoff note (a write_handoff with a normal result). */
  get handoffWritten(): boolean {
    return this.wroteHandoff;
  }

  /** Whether a tool call is in flight. */
  get toolInFlight(): boolean {
    return this.tools.size > 0;
  }

  /** The groups descendant snapshots found, for the stop ladder. */
  groups(): ProcessIdentity[] {
    return this.descendants.groups();
  }

  /** The UUIDs of the approvals still waiting for an answer. */
  pendingApprovals(): string[] {
    return [...this.approvals.keys()];
  }

  async handle(event: AgentEvent): Promise<void> {
    const { setPhase } = this.options;
    switch (event.type) {
      case 'turn_started':
        setPhase('turn');
        return;
      case 'turn_ended':
        this.tools.clear();
        this.stopSnapshots();
        setPhase('idle');
        this.activity(...this.turnSummary(event));
        return;
      case 'tool_started':
        this.tools.add(event.toolId);
        this.activity('tool', `${event.name}: ${event.command ?? event.input}`);
        this.startSnapshots();
        return;
      case 'tool_ended':
        this.tools.delete(event.toolId);
        if (this.tools.size === 0) this.stopSnapshots();
        if (event.terminal === 'handoff') this.wroteHandoff = true;
        return;
      case 'text':
        this.activity('text', event.text);
        if (this.options.spec.successor && !this.firstOutputSent) {
          this.firstOutputSent = true;
          this.options.report({ type: 'attempt.first_output', data: { text: clip(event.text, LONG_TEXT_MAX) } });
        }
        return;
      case 'compacted':
        this.options.report({
          type: 'attempt.activity',
          data: { kind: 'compaction', summary: clip(event.summary ?? 'the context was compacted', LONG_TEXT_MAX) },
        });
        return;
      case 'warning':
        this.activity('note', event.text);
        return;
      case 'delivered':
      case 'acknowledged':
        this.reportMessage(event.type, event.id);
        return;
      case 'approval_request':
        await this.approvalRequested(event);
        return;
      case 'approval_void':
        this.voidApproval(event.approvalId);
        return;
      case 'waiting_approval':
        setPhase(event.waiting ? 'waiting_approval' : 'turn');
        return;
      default:
        return;
    }
  }

  /**
   * Sends the hub's messages in order, then one system line about the `more` that did not fit. Each send's id maps
   * back to its hub id; message 0 and the line are never reported.
   */
  async deliver(messages: readonly InjectedMessage[], more: number): Promise<void> {
    const { session } = this.options;
    for (const message of messages) {
      const id = randomUUID();
      this.sent.set(id, message.messageId > 0 ? message.messageId : null);
      await session.send({ id, text: message.text, authority: message.authority });
    }
    if (more > 0) {
      const id = randomUUID();
      this.sent.set(id, null);
      await session.send({ id, text: moreMessagesLine(more), authority: 'system' });
    }
  }

  /** Answers a pending approval; gives whether the agent took the answer. */
  async answer(approvalId: string, decision: 'approve' | 'decline', reason: string | null): Promise<boolean> {
    const vendorId = this.approvals.get(approvalId);
    if (vendorId === undefined) return false;
    const applied = await this.options.session.answerApproval(vendorId, decision, reason).catch(() => false);
    if (applied) this.forget(approvalId);
    return applied;
  }

  /** Voids every pending approval, as when the process exits. */
  voidAll(): void {
    for (const approvalId of [...this.approvals.keys()]) {
      this.forget(approvalId);
      this.options.report({ type: 'approval.voided', data: { approvalId } });
    }
  }

  /** Stops the descendant snapshots; the agent's events have ended. */
  close(): void {
    this.tools.clear();
    this.stopSnapshots();
  }

  /** Waits for a snapshot under way. */
  settled(): Promise<void> {
    return this.snapshotting;
  }

  private activity(kind: 'tool' | 'turn' | 'text' | 'vendor_error' | 'note', summary: string): void {
    this.options.report({ type: 'attempt.activity', data: { kind, summary: clip(summary, ACTIVITY_SUMMARY_MAX) } });
  }

  private turnSummary(event: Extract<AgentEvent, { type: 'turn_ended' }>): ['turn' | 'vendor_error', string] {
    if (event.outcome === 'completed') {
      return ['turn', `turn completed with ${event.toolCalls} tool call${event.toolCalls === 1 ? '' : 's'}`];
    }
    if (event.outcome === 'interrupted') return ['turn', 'turn interrupted'];
    if (event.errorKind === 'vendor') return ['vendor_error', event.error ?? 'the vendor failed the turn'];
    const kind = event.errorKind === null ? '' : ` (${event.errorKind})`;
    return ['turn', `turn failed${kind}: ${event.error ?? 'no detail'}`];
  }

  private reportMessage(type: 'delivered' | 'acknowledged', id: string): void {
    const messageId = this.sent.get(id);
    // Hub text, the deliver.more line, and ids that are not ours (a first prompt) are never reported.
    if (messageId === undefined || messageId === null) return;
    if (type === 'acknowledged') this.sent.delete(id);
    this.options.report({ type: `attempt.${type}`, data: { messageIds: [messageId] } });
  }

  private async approvalRequested(event: Extract<AgentEvent, { type: 'approval_request' }>): Promise<void> {
    const { adapter, spec, logger } = this.options;
    const approvalId = randomUUID();
    this.approvals.set(approvalId, event.approvalId);
    this.approvalIds.set(event.approvalId, approvalId);
    const request = { kind: event.kind, summary: event.summary, detail: event.detail };
    let detail = event.detail;
    if (adapter.enrichApproval) {
      try {
        detail = await adapter.enrichApproval({
          clone: this.options.clone,
          vault: this.options.vault,
          startSha: this.options.startSha,
          request,
        });
      } catch (error) {
        logger.warn('cannot enrich an approval request', { attemptId: spec.attemptId, error: String(error) });
      }
    }
    // Withdrawn while it was enriched: nothing to relay.
    if (!this.approvals.has(approvalId)) return;
    // The agent and the adapter write these: clipped, so the event always fits the outbox.
    const summary = clip(event.summary, APPROVAL_SUMMARY_MAX);
    try {
      this.options.report({
        type: 'approval.requested',
        data: { approvalId, kind: event.kind, summary, detail: clipApprovalDetail(detail) },
      });
    } catch (error) {
      // The outbox refused it all the same: declined at once, so the agent goes on.
      logger.warn('cannot relay an approval request; it is declined', {
        attemptId: spec.attemptId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.forget(approvalId);
      await this.options.session.answerApproval(event.approvalId, 'decline', APPROVAL_NOT_FORWARDED).catch(() => false);
      this.activity('note', APPROVAL_NOT_FORWARDED);
      return;
    }
    const hub = spec.hubUrl.replace(/\/+$/, '');
    try {
      await this.options.notifier.notify({
        key: approvalId,
        title: `agflow: ${spec.attemptId} asks for your approval`,
        body: `${summary}\n${hub}${APPROVALS_ROUTE}`,
      });
    } catch (error) {
      logger.warn('cannot post the approval notification', { attemptId: spec.attemptId, error: String(error) });
    }
  }

  private voidApproval(vendorId: string): void {
    const approvalId = this.approvalIds.get(vendorId);
    if (approvalId === undefined) return;
    this.forget(approvalId);
    this.options.report({ type: 'approval.voided', data: { approvalId } });
  }

  private forget(approvalId: string): void {
    const vendorId = this.approvals.get(approvalId);
    this.approvals.delete(approvalId);
    if (vendorId !== undefined) this.approvalIds.delete(vendorId);
  }

  /** A snapshot now, and every snapshotEveryMs while a tool runs. */
  private startSnapshots(): void {
    this.snapshot();
    if (this.snapshotTimer !== null) return;
    this.snapshotTimer = setInterval(() => this.snapshot(), this.options.snapshotEveryMs ?? DESCENDANT_SNAPSHOT_MS);
    this.snapshotTimer.unref?.();
  }

  private stopSnapshots(): void {
    if (this.snapshotTimer !== null) clearInterval(this.snapshotTimer);
    this.snapshotTimer = null;
  }

  /** One snapshot at a time; each records the groups found in the attempt's registry. */
  private snapshot(): void {
    this.snapshotting = this.snapshotting.then(async () => {
      try {
        const root = await this.options.root();
        if (root === null) return;
        await this.descendants.snapshot([root]);
        for (const group of this.descendants.groups()) {
          this.options.store.recordProcess({
            attemptId: this.options.spec.attemptId,
            pid: group.pid,
            pgid: group.pgid,
            lstart: group.lstart,
            clone: this.options.clone,
          });
        }
      } catch (error) {
        this.options.logger.warn('a descendant snapshot failed', {
          attemptId: this.options.spec.attemptId,
          error: String(error),
        });
      }
    });
  }
}

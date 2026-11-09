/**
 * A made-up runner for the demo hub and the browser check: no CLI, no clone, no git. M2a's FakeRunner speaks protocol
 * 1 over the hub's real WebSocket with a CLI token (X-25): hello with lastSeq, the outbox, acks, heartbeats and the
 * default command answers. DemoRunner adds the demo's parts: a made-up hello, heartbeat facts per attempt and
 * acceptingUntil, the agent side over HTTP with each attempt's agent token, scripted answers to the commands that
 * change an attempt, and scenario hooks.
 */
import { DEFAULT_WIP_REF_PREFIX, lateWorkRef, takeoverAnywhereCommand, takeoverRef } from '../packages/core/src/naming';
import type {
  AccountQuotaReport,
  AttemptSpec,
  RunnerCommand,
  RunnerEventData,
  RunnerEventType,
  RunnerSettings,
} from '../packages/core/src/runner-protocol';
import type { SubmitError } from '../packages/core/src/submit-errors';
import type {
  AgentRole,
  AttemptFacts,
  Fence,
  ProfileSummary,
  Runner,
  RunnerVendor,
  Vendor,
} from '../packages/core/src/types';
import type { CommandResult } from '../packages/hub/src/commands';
import { type AnswerHooks, FakeRunner, WebSocketTransport } from '../packages/hub/test/fake-runner';

/** One attempt the demo runner was told to start, as its scenario hooks see it. */
export interface DemoAttempt {
  attemptId: string;
  /** Null for a lead. */
  taskId: string | null;
  role: AgentRole;
  vendor: Vendor;
  /** The fence of its latest start or resume. */
  fence: Fence;
  /** The agent token of its latest start or resume, which its agent-side calls use. */
  token: string;
  /** The task branch and the WIP ref; null for a lead. */
  branch: string | null;
  wipRef: string | null;
  /** It follows an earlier attempt, so its first output restates the handoff (design 6.8). */
  successor: boolean;
  /** The made-up commit of its work; every push reports it. */
  head: string;
  /** The process runs. A holding or stopped attempt has none, but may keep its clone. */
  running: boolean;
  clone: boolean;
  /** The person a take-over named. */
  takenOverBy: string | null;
  /** The heartbeat facts that differ from the defaults (factsOf). */
  facts: Partial<Omit<AttemptFacts, 'attemptId' | 'fence'>>;
  /** What the next push_submission answers: null pushes it, a refusal refuses it. */
  submitRefusal: { error: SubmitError; detail: string | null } | null;
  /** Late-work and hand-back refs pushed so far, which numbers the next one. */
  latePushes: number;
}

export interface DemoRunnerOptions {
  /** The hub's origin (startHub's HubServer.url). */
  url: string;
  /** A CLI token of the runner's owner. */
  token: string;
  runnerKey: string;
  machineId: string;
  name: string;
  settings?: Partial<RunnerSettings>;
  vendors: RunnerVendor[];
  quota?: AccountQuotaReport[];
  profile?: ProfileSummary;
  git?: Runner['git'];
  power?: Runner['power'];
  disk?: Runner['disk'];
  /** The handoff note a stop writes when the hub asks for one. */
  handoffNote?: (attempt: DemoAttempt, reason: string) => string;
  /** A successor's restatement, its first output. */
  restatement?: (attempt: DemoAttempt) => string;
}

type AttemptEventType = Extract<RunnerEventType, `attempt.${string}` | `approval.${string}`>;
type Command<K extends RunnerCommand['kind']> = Extract<RunnerCommand, { kind: K }>;
type ApprovalRequest = Pick<RunnerEventData['approval.requested'], 'kind' | 'summary' | 'detail'>;

/** A made-up full sha, the same for the same text. */
export function demoSha(text: string): string {
  return new Bun.CryptoHasher('sha1').update(text).digest('hex');
}

const defaultHandoff = (attempt: DemoAttempt, reason: string) =>
  `Stopped (${reason.split('\n').at(-1)?.trim() || 'on request'}). The work so far is pushed at ${attempt.head}. ` +
  'Next: run the tests, then finish the remaining acceptance items.';

const defaultRestatement = (attempt: DemoAttempt) =>
  `Restating ${attempt.taskId ?? 'the lead seat'}: the previous attempt stopped with its work pushed, and its ` +
  'handoff names the next step. I continue from its last commit.';

/** The time a heartbeat's facts say has passed since the attempt's start; the facts fire no stall rule. */
function factsOf(attempt: DemoAttempt, activeMs: number): AttemptFacts {
  return {
    attemptId: attempt.attemptId,
    fence: attempt.fence,
    phase: attempt.role === 'lead' ? 'idle' : 'turn',
    eventAgeMs: 2_000,
    tool: null,
    fsAgeMs: 20_000,
    commitAgeMs: null,
    turns: 1,
    turnsWithoutProgress: 0,
    repeatedCalls: 0,
    continuations: 0,
    vendorErrorMs: 0,
    activeMs,
    contextUsed: 0.2,
    ...attempt.facts,
  };
}

export class DemoRunner {
  readonly fake: FakeRunner<WebSocketTransport>;
  /** Every attempt it was told to start, by id. */
  readonly attempts = new Map<string, DemoAttempt>();
  /** Agent-side calls the hub refused while the runner followed a command; the demo's self-check reads them. */
  readonly errors: string[] = [];
  private readonly startedAt = new Map<string, number>();
  private readonly startHooks: ((attempt: DemoAttempt) => void | Promise<void>)[] = [];
  private readonly work = new Set<Promise<void>>();
  /** Epoch ms; heartbeats send what is left of it. */
  private acceptingUntil: number | null = null;
  /** The approvals each attempt waits on, by attempt id. */
  private readonly pendingApprovals = new Map<string, Set<string>>();
  /** The hub's prefix for take-over, hand-back and late-work refs, from the last welcome; kept across drops. */
  private prefix = DEFAULT_WIP_REF_PREFIX;
  private closed = false;

  constructor(readonly options: DemoRunnerOptions) {
    const answers: AnswerHooks = {
      start_attempt: (command) => this.started(command),
      resume_attempt: (command) => this.resumed(command),
      stop_attempt: (command) => this.stopping(command),
      hold_attempt: (command) => this.holding(command),
      interrupt: (command) => this.interrupted(command),
      prepare_takeover: (command) => this.takingOver(command),
      hand_back: (command) => this.handingBack(command),
      push_submission: (command) => this.pushing(command),
      deliver: (command) => this.delivering(command),
      decide_approval: (command) => this.decided(command),
    };
    this.fake = new FakeRunner<WebSocketTransport>(
      (endpoint) => new WebSocketTransport(options.url, options.token, endpoint),
      {
        runnerKey: options.runnerKey,
        machineId: options.machineId,
        name: options.name,
        settings: options.settings,
        vendors: options.vendors,
        quota: () => options.quota ?? [],
        profile: options.profile,
        git: () => options.git ?? { ready: true, problem: null, lastPushAt: null },
        power: () => options.power ?? { source: 'ac', batteryPercent: null, lowPowerMode: false },
        disk: () => options.disk ?? { freeBytes: 120e9, agflowBytes: 2e9 },
        heartbeats: 'auto',
        answers,
        attempts: () => this.liveAttempts(),
        facts: () => this.heartbeatFacts(),
        // The protocol's acceptingUntil is ms from now.
        acceptingUntil: () => {
          if (this.acceptingUntil === null) return null;
          const left = this.acceptingUntil - Date.now();
          return left > 0 ? left : null;
        },
      },
    );
  }

  /** Says hello and sends a first heartbeat, so the card shows power and disk at once. */
  async connect(): Promise<void> {
    const welcome = await this.fake.connect();
    if (!welcome) {
      const why = this.fake.closedWith?.reason || 'the link closed';
      throw new Error(`runner ${this.options.name} got no welcome: ${why}`);
    }
    this.prefix = welcome.wipRefPrefix;
    this.fake.heartbeat();
  }

  get runnerId(): string {
    const welcome = this.fake.welcome;
    if (!welcome) throw new Error(`runner ${this.options.name} is not connected`);
    return welcome.runnerId;
  }

  attempt(attemptId: string): DemoAttempt {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) throw new Error(`runner ${this.options.name} has no attempt ${attemptId}`);
    return attempt;
  }

  /** A hook that runs once an attempt's start is reported and acknowledged: the scenario's agent at work. */
  onStart(hook: (attempt: DemoAttempt) => void | Promise<void>): void {
    this.startHooks.push(hook);
  }

  /** Sends an event now; an attempt event goes at the attempt's current fence. */
  emit<K extends AttemptEventType>(type: K, data: RunnerEventData[K], attemptId: string): void;
  emit<K extends Exclude<RunnerEventType, AttemptEventType>>(type: K, data: RunnerEventData[K]): void;
  emit<K extends RunnerEventType>(type: K, data: RunnerEventData[K], attemptId?: string): void {
    const at = attemptId === undefined ? undefined : this.attempt(attemptId);
    this.fake.emit(type, data, at && { attemptId: at.attemptId, fence: at.fence });
  }

  /** Changes what the attempt's heartbeats report (a phase, a tool, its turns) and sends one now. */
  setFacts(attemptId: string, facts: DemoAttempt['facts']): void {
    const attempt = this.attempt(attemptId);
    attempt.facts = { ...attempt.facts, ...facts };
    this.fake.heartbeat();
  }

  /** Raises an approval for the attempt's owner; the attempt waits in waiting_approval. Returns its id. */
  requestApproval(attemptId: string, approval: ApprovalRequest): string {
    const approvalId = crypto.randomUUID();
    this.emit('approval.requested', { approvalId, ...approval }, attemptId);
    const pending = this.pendingApprovals.get(attemptId) ?? new Set<string>();
    pending.add(approvalId);
    this.pendingApprovals.set(attemptId, pending);
    this.setFacts(attemptId, { phase: 'waiting_approval' });
    return approvalId;
  }

  /** Pushes work the attempt made after it ended, as the runner does when it finds some (design 6.8). */
  lateWork(attemptId: string): { ref: string; sha: string } {
    const attempt = this.attempt(attemptId);
    if (attempt.taskId === null) throw new Error('a lead has no late work');
    const pushed = this.latePush(attempt);
    this.emit('attempt.late_work', { taskId: attempt.taskId, ...pushed }, attemptId);
    return pushed;
  }

  /** Takes no new attempt until the time (epoch ms), or again from now with null; a heartbeat tells the hub now. */
  holdPlacement(until: number | null): void {
    this.acceptingUntil = until;
    this.fake.heartbeat();
  }

  /** The attempt's agent reports progress. */
  progress(attemptId: string, note: string): Promise<unknown> {
    const attempt = this.attempt(attemptId);
    return this.agentCall(attempt, `/api/tasks/${attempt.taskId}/progress`, { note });
  }

  /**
   * The attempt's agent submits; the runner pushes when push_submission comes, or refuses it with the refusal given.
   * Answers the pending submission.
   */
  submit(
    attemptId: string,
    input: { summary: string; evidence?: string[] },
    refusal: DemoAttempt['submitRefusal'] = null,
  ): Promise<unknown> {
    const attempt = this.attempt(attemptId);
    attempt.submitRefusal = refusal;
    return this.agentCall(attempt, `/api/tasks/${attempt.taskId}/submit`, {
      summary: input.summary,
      evidence: input.evidence ?? [],
    });
  }

  /** The attempt's agent writes a handoff note: a worker's on its task, the lead's in the lead notes. */
  handoff(attemptId: string, note: string): Promise<unknown> {
    const attempt = this.attempt(attemptId);
    const path = attempt.taskId === null ? '/api/lead/handoff' : `/api/tasks/${attempt.taskId}/handoff`;
    return this.agentCall(attempt, path, { note });
  }

  /** Drops the link, as a laptop that sleeps or leaves the network; the hub marks the runner offline. */
  disconnect(): void {
    this.fake.disconnect();
  }

  /** A new link after a drop: hello with the attempts it still has, and the replay of what the hub has not acked. */
  async reconnect(): Promise<void> {
    if (this.fake.connected) this.fake.disconnect();
    await this.connect();
  }

  /** Waits until the scripted work it started has finished and the hub has acknowledged every event. */
  async settled(timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.work.size > 0 || (this.fake.connected && this.fake.outbox.length > 0)) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`runner ${this.options.name} did not settle within ${timeoutMs} ms`);
      // Work that hangs must not hold the caller past its timeout.
      await Promise.race([Promise.all([...this.work]), Bun.sleep(Math.min(left, 50))]);
      await Bun.sleep(5);
    }
  }

  /** Stops for good: no more scripted work, and the link closes. */
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.work]);
    if (this.fake.connected) this.fake.disconnect();
  }

  // -------------------------------------------------------------------------
  // Scripted answers
  // -------------------------------------------------------------------------

  private started(command: Command<'start_attempt'>): CommandResult {
    const spec: AttemptSpec = command.attempt;
    const attempt: DemoAttempt = {
      attemptId: spec.attemptId,
      taskId: spec.taskId,
      role: spec.role,
      vendor: spec.vendor,
      fence: spec.fence,
      token: spec.agentToken,
      branch: spec.branch,
      wipRef: spec.wipRef,
      successor: spec.successor,
      head: demoSha(`${spec.attemptId}:work`),
      running: true,
      clone: true,
      takenOverBy: null,
      facts: {},
      submitRefusal: null,
      latePushes: 0,
    };
    this.attempts.set(attempt.attemptId, attempt);
    this.startedAt.set(attempt.attemptId, Date.now());
    this.later(async () => {
      const spawned = this.fake.startRunning(attempt.attemptId);
      if (attempt.successor) {
        const text = (this.options.restatement ?? defaultRestatement)(attempt);
        this.emit('attempt.first_output', { text }, attempt.attemptId);
      }
      await this.acknowledged(spawned.seq);
      if (this.closed) return;
      for (const hook of this.startHooks) await hook(attempt);
    });
    return { ok: true };
  }

  private resumed(command: Command<'resume_attempt'>): CommandResult {
    const attempt = this.attempt(command.attemptId);
    attempt.fence = command.fence;
    attempt.token = command.agentToken;
    attempt.running = true;
    this.later(() => {
      this.fake.startRunning(attempt.attemptId);
    });
    return { ok: true };
  }

  /** A stop: the handoff turn when the hub asks for one, then the exit with the final WIP. */
  private stopping(command: Command<'stop_attempt'>): CommandResult {
    const attempt = this.attempt(command.attemptId);
    this.later(async () => {
      const handoffWritten = command.handoff && (await this.writeHandoff(attempt, command.reason));
      this.exited(attempt, { stoppedBy: 'close', handoffWritten, keepClone: command.keepClone });
    });
    return { ok: true };
  }

  /** A held attempt's process ends; its clone stays for the review (design 6.13). */
  private holding(command: Command<'hold_attempt'>): CommandResult {
    const attempt = this.attempt(command.attemptId);
    this.later(() => this.exited(attempt, { stoppedBy: 'close', handoffWritten: false, keepClone: true }));
    return { ok: true };
  }

  private interrupted(command: Command<'interrupt'>): CommandResult {
    this.later(() => {
      this.emit('attempt.activity', { kind: 'turn', summary: 'the turn was interrupted' }, command.attemptId);
      this.setFacts(command.attemptId, { phase: 'idle' });
    });
    return { ok: true };
  }

  /**
   * A take-over (design 6.12): the handoff turn, then the commands for the person, which push to the person's
   * take-over ref. The process ends without attempt.exited, as a take-over reports none; the clone stays for the
   * hand-back.
   */
  private takingOver(command: Command<'prepare_takeover'>): CommandResult {
    const attempt = this.attempt(command.attemptId);
    attempt.takenOverBy = command.person;
    this.later(async () => {
      await this.writeHandoff(attempt, `taken over by ${command.person}`);
      attempt.running = false;
      attempt.clone = true;
      const taskId = attempt.taskId as string;
      const anywhere = takeoverAnywhereCommand({
        ref: attempt.wipRef as string,
        branch: attempt.branch as string,
        takeoverRef: takeoverRef(this.prefix, taskId, command.person),
      });
      const local = `cd ~/.agflow/work/${attempt.attemptId} && ${attempt.vendor} --resume session-${attempt.attemptId}`;
      const takenOver = { commands: { local, anywhere }, wipSha: attempt.head, error: null };
      this.emit('attempt.taken_over', takenOver, attempt.attemptId);
    });
    return { ok: true };
  }

  /** The owner decided: once no approval is left, the agent goes on with its turn. */
  private decided(command: Command<'decide_approval'>): CommandResult {
    const pending = this.pendingApprovals.get(command.attemptId);
    pending?.delete(command.approvalId);
    if (pending?.size === 0) {
      this.pendingApprovals.delete(command.attemptId);
      if (this.attempts.has(command.attemptId)) this.setFacts(command.attemptId, { phase: 'turn' });
    }
    return { ok: true, data: { applied: true } };
  }

  /** A hand-back from the clone: the person's commits go up beside the WIP ref (design 6.12). */
  private handingBack(command: Command<'hand_back'>): CommandResult {
    const attempt = this.attempt(command.attemptId);
    if (command.source.kind === 'clone') {
      this.later(() => {
        attempt.head = demoSha(`${attempt.attemptId}:handed back`);
        attempt.clone = false;
        this.emit('attempt.handed_back', this.latePush(attempt), attempt.attemptId);
      });
    }
    return { ok: true };
  }

  private pushing(command: Command<'push_submission'>): CommandResult {
    const attempt = this.attempt(command.attemptId);
    const refusal = attempt.submitRefusal;
    attempt.submitRefusal = null;
    this.later(() => {
      const outcome = refusal
        ? { ok: false, headSha: null, remoteHead: null, error: refusal.error, detail: refusal.detail }
        : { ok: true, headSha: attempt.head, remoteHead: attempt.head, error: null, detail: null };
      this.emit('attempt.submitted', { submissionId: command.submissionId, ...outcome }, attempt.attemptId);
    });
    return { ok: true };
  }

  /** The agent reads the messages at once: delivered, then acknowledged (design 6.7). */
  private delivering(command: Command<'deliver'>): CommandResult {
    // 0 is hub text with no message row (the lead's situation report); runners never report it.
    const messageIds = command.messages.map((message) => message.messageId).filter((id) => id !== 0);
    this.later(() => {
      this.emit('attempt.delivered', { messageIds }, command.attemptId);
      this.emit('attempt.acknowledged', { messageIds }, command.attemptId);
    });
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Runs scripted work after the command's result went out, as a runner works after it answered; settled() waits
   * for it. A failure is kept in errors.
   */
  private later(work: () => void | Promise<void>): void {
    if (this.closed) return;
    const running = Promise.resolve()
      .then(work)
      .catch((error: unknown) => {
        this.errors.push(error instanceof Error ? error.message : String(error));
      })
      .finally(() => this.work.delete(running));
    this.work.add(running);
  }

  /** Writes the handoff note; false when the hub refused it, which the exit then reports. */
  private async writeHandoff(attempt: DemoAttempt, reason: string): Promise<boolean> {
    try {
      await this.handoff(attempt.attemptId, (this.options.handoffNote ?? defaultHandoff)(attempt, reason));
      return true;
    } catch (error) {
      this.errors.push(error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  /** The process exits, and a worker's final WIP goes up with it. */
  private exited(attempt: DemoAttempt, how: { stoppedBy: 'close'; handoffWritten: boolean; keepClone: boolean }): void {
    attempt.running = false;
    attempt.clone = how.keepClone;
    const finalWip = attempt.wipRef === null ? null : { ref: attempt.wipRef, sha: attempt.head };
    this.emit(
      'attempt.exited',
      {
        code: 0,
        signal: null,
        stoppedBy: how.stoppedBy,
        handoffWritten: how.handoffWritten,
        cause: null,
        finalSha: attempt.wipRef === null ? null : attempt.head,
        finalWip,
        pushError: null,
      },
      attempt.attemptId,
    );
  }

  private latePush(attempt: DemoAttempt): { ref: string; sha: string } {
    attempt.latePushes += 1;
    return { ref: lateWorkRef(this.prefix, attempt.attemptId, attempt.latePushes), sha: attempt.head };
  }

  /** Resolves once the hub has acknowledged the event, so the agent's HTTP calls come after it. */
  private async acknowledged(seq: number): Promise<void> {
    while (this.fake.outbox.some((event) => event.seq <= seq)) {
      // Without a link the event waits for the replay, and the hooks with it would wait for nothing.
      if (this.closed || !this.fake.connected) return;
      await Bun.sleep(5);
    }
  }

  private async agentCall(attempt: DemoAttempt, path: string, body: unknown): Promise<unknown> {
    const response = await fetch(new URL(path, this.options.url), {
      method: 'POST',
      headers: { authorization: `Bearer ${attempt.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const answer = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
    if (!response.ok) {
      const why = answer?.message ?? answer?.error ?? response.statusText;
      throw new Error(`${attempt.attemptId}: POST ${path} answered ${response.status}: ${why}`);
    }
    return answer;
  }

  /** What hello reports after a drop: every attempt with a process or a clone. */
  private liveAttempts() {
    return [...this.attempts.values()]
      .filter((attempt) => attempt.running || attempt.clone)
      .map((attempt) => ({
        attemptId: attempt.attemptId,
        fence: attempt.fence,
        state: attempt.running ? ('running' as const) : ('stopped' as const),
        sessionRef: `session-${attempt.attemptId}`,
        clone: attempt.clone,
      }));
  }

  private heartbeatFacts(): AttemptFacts[] {
    const now = Date.now();
    return [...this.attempts.values()]
      .filter((attempt) => attempt.running)
      .map((attempt) => factsOf(attempt, now - (this.startedAt.get(attempt.attemptId) ?? now)));
  }
}

/** A demo runner linked to the hub at options.url, welcomed, with its first heartbeat sent. */
export async function startDemoRunner(options: DemoRunnerOptions): Promise<DemoRunner> {
  const runner = new DemoRunner(options);
  await runner.connect();
  return runner;
}

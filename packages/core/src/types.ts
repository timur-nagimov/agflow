import type { PlacementRefusal } from './scheduling';

export type Vendor = 'claude' | 'codex';
export type AgentRole = 'lead' | 'worker';
export type AgentOrigin = 'live' | 'runner';
export type AgentStatus = 'active' | 'idle' | 'gone';

export type TaskKind = 'code' | 'research' | 'review' | 'curation';
/** How hard a task is to think through: a strong task runs on the runner's lead model, with more reasoning. */
export type TaskTier = 'standard' | 'strong';
export type TaskStatus =
  | 'draft'
  | 'ready'
  | 'claimed'
  | 'working'
  | 'submitted'
  | 'checking'
  | 'reviewing'
  | 'accepted'
  | 'merging'
  | 'merged'
  | 'rejected'
  | 'stale'
  | 'blocked'
  | 'cancelled'
  | 'failed';
export type BlockedKind =
  | 'deps'
  | 'agent'
  | 'impossible'
  | 'takeover' // a person holds the task
  | 'replan' // ladder step 4
  | 'paused' // a person stopped and held the work
  | 'branch_moved' // the task branch moved outside agflow
  | 'policy'; // the vendor refused the work on policy grounds

export interface Evidence {
  kind: 'command' | 'artifact' | 'review';
  cmd?: string;
  expect?: string;
  path?: string;
  rubric?: string;
}

export interface AcceptanceCriterion {
  id: string;
  assertion: string;
  evidence?: Evidence;
}

export interface TaskCheck {
  name: string;
  cmd: string;
  timeoutS?: number;
}

export interface TaskContract {
  title: string;
  kind: TaskKind;
  objective: string;
  why: string;
  nonGoals: string[];
  acceptance: AcceptanceCriterion[];
  checks: TaskCheck[];
  ownedPaths: string[];
  dependsOn: string[];
  priority: number;
  /** The vendor the scheduler prefers for this task, after the ladder's vendor requirement (design 6.6, step 5). */
  vendorHint?: Vendor | null;
  /** Absent: standard. A strong task's attempts run on the runner's lead model, with a higher reasoning effort. */
  tier?: TaskTier;
}

export interface Submission {
  summary: string;
  evidence: string[];
  branch: string | null;
  headSha: string | null;
  submittedAt: number;
  by: string;
  /** Null for submissions recorded before M2. */
  attemptId: string | null;
  /** The SubmissionRecord of a runner agent's submission; null for a live chat's. */
  submissionId: string | null;
}

export interface Task extends TaskContract {
  id: string;
  status: TaskStatus;
  assignee: string | null;
  branch: string | null;
  goalVersion: number;
  leaseExpiresAt: number | null;
  blockedKind: BlockedKind | null;
  blockedReason: string | null;
  submission: Submission | null;
  feedback: string | null;
  mergedSha: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  /** The task's newest attempt. */
  currentAttempt: string | null;
  /** Every attempt of the task, live ones included. */
  attemptCount: number;
  /** Where the next attempt starts; null: from main. */
  workRef: string | null;
  workSha: string | null;
  /** Infra backoff: no dispatch before this time. */
  nextDispatchAt: number | null;
  /** The lead or a person granted the task internet access: its Claude agents may use fetch_url (design 5). */
  fetchGranted: boolean;
  /**
   * Why the scheduler's last tick did not start this ready task, in one line, as GET /api/tasks gives it; null when
   * that tick said nothing about it. A merging task whose last merge failed says how many failed, and the newest error.
   */
  waitReason?: string | null;
}

/** What POST /api/fetch answers: one public URL the hub downloaded for a runner agent (design 5, Unattended options). */
export interface FetchedUrl {
  /** The HTTP status of the last hop. */
  status: number;
  /** Where the redirects ended. */
  finalUrl: string;
  /** The response's Content-Type header, the only header passed on; null when it sent none. */
  contentType: string | null;
  /** The body's size after decompression. */
  bytes: number;
  /** The body's SHA-256, in hex. */
  sha256: string;
  bodyBase64: string;
}

export interface TaskNote {
  id: number;
  taskId: string;
  kind: 'progress' | 'handoff' | 'release' | 'restatement' | 'late_work';
  body: string;
  author: string;
  createdAt: number;
  /** The attempt a handoff, restatement or late-work note belongs to. */
  attemptId: string | null;
}

export interface GoalVersion {
  version: number;
  text: string;
  author: string;
  createdAt: number;
}

export interface GoalNote {
  id: number;
  goalVersion: number;
  text: string;
  author: string;
  createdAt: number;
}

export interface Project {
  name: string;
  repo: string;
  paused: boolean;
  /** May the scheduler start leads on runners. */
  runnerLeads: boolean;
  /** When the project must be done, in epoch ms, which the lead plans against; null for no deadline. */
  deadlineAt: number | null;
}

export interface Agent {
  id: string;
  user: string;
  vendor: Vendor;
  role: AgentRole;
  origin: AgentOrigin;
  sessionId: string | null;
  label: string | null;
  currentTask: string | null;
  /** For a runner agent, set by its attempt: starting and running are active, quota_wait and holding idle, ended gone. */
  status: AgentStatus;
  lastSeenAt: number;
  createdAt: number;
  runnerId: string | null;
  attemptId: string | null;
}

export interface Message {
  id: number;
  from: string;
  to: string;
  body: string;
  taskId: string | null;
  replyTo: number | null;
  standingRule: boolean;
  ruleActive: boolean;
  createdAt: number;
}

export interface Delivery {
  agentId: string;
  deliveredAt: number;
  ackedAt: number | null;
}

export interface MessageView extends Message {
  deliveries: Delivery[];
}

export interface HubEvent {
  id: number;
  ts: number;
  type: string;
  actor: string;
  subject: string | null;
  data: Record<string, unknown>;
}

export interface TaskDetail {
  task: Task;
  notes: TaskNote[];
  /** The newest 500 events of the task, oldest first. */
  events: HubEvent[];
  /** The newest 100 messages about the task, newest first. */
  messages: MessageView[];
  attempts: Attempt[];
  submissions: SubmissionRecord[];
}

export type StopCheckResult = { action: 'allow' } | { action: 'block'; reason: string };

export interface LiveInbox {
  messages: Message[];
  more: number;
}

export interface SearchResult {
  tasks: Task[];
  messages: Message[];
  goal: { version: number; snippet: string } | null;
}

export interface HubStatus {
  project: Project;
  goalVersion: number;
  /** The seat holder's agent. */
  lead: Agent | null;
  leadSeat: LeadSeat;
  /** The hub epoch, raised by every restore. */
  epoch: number;
  counts: Record<string, number>;
  activeAgents: number;
  humansInbox: MessageView[];
}

export interface LivePeek {
  unread: number;
  first: { from: string } | null;
}

// ---------------------------------------------------------------------------
// Runners and attempts (M2)
// ---------------------------------------------------------------------------

/** Compared numerically, epoch first, then counter (fence.ts). */
export interface Fence {
  epoch: number;
  counter: number;
}

export type AttemptStatus = 'starting' | 'running' | 'quota_wait' | 'holding' | 'ended';
export type AttemptEndReason =
  | 'accepted'
  | 'rejected'
  | 'cancelled'
  | 'released'
  | 'blocked'
  | 'stalled'
  | 'crashed'
  | 'failed_to_start'
  | 'stopped'
  | 'replaced'
  | 'lost'
  | 'taken_over'
  | 'rotated'
  | 'superseded';
export type FailureClass = 'infra' | 'agent' | 'review';
export type AttemptPhase =
  | 'starting'
  | 'preparing'
  | 'turn'
  | 'idle'
  | 'waiting_approval'
  | 'quota_wait'
  | 'vendor_error'
  | 'stopping';

/** Why a stop was requested. ladder.ts maps each cause to its end reason, class and flags. */
export type StopCause =
  | 'stall_silent'
  | 'stall_hung_tool'
  | 'stall_loop'
  | 'stall_no_progress'
  | 'stall_budget'
  | 'stop'
  | 'stop_hold'
  | 'replace'
  | 'quota'
  | 'vendor_error'
  | 'context'
  | 'policy'
  | 'auth'
  | 'cancel'
  | 'blocked'
  | 'impossible'
  | 'released'
  | 'takeover'
  | 'rotation'
  | 'branch_moved';

export interface Attempt {
  /** 'T-42-a3'; from epoch 2 'T-42-e2-a3'; leads 'lead-a5' and 'lead-e2-a5' (naming.ts). */
  id: string;
  /** Null for lead attempts. */
  taskId: string | null;
  /** Per task, or per lead seat. */
  number: number;
  role: AgentRole;
  agentId: string;
  /** Null for live-chat attempts. */
  runnerId: string | null;
  vendor: Vendor;
  /** Set from attempt.spawned. */
  model: string | null;
  /** Claude session id or Codex thread id. */
  sessionRef: string | null;
  fence: Fence;
  status: AttemptStatus;
  endReason: AttemptEndReason | null;
  failureClass: FailureClass | null;
  /** The end reason plus the normalised error, for repeated infra failures. */
  failureSignature: string | null;
  startRef: string | null;
  /** The commit the runner actually started from. */
  startSha: string | null;
  /** 'refs/agflow/T-42/a3' */
  wipRef: string | null;
  wipSha: string | null;
  submittedSha: string | null;
  /** False once its clone or session is known to be gone. */
  resumable: boolean;
  /** Ladder step 1 resumes. */
  reviewRounds: number;
  /** Deliveries to a lead attempt. */
  wakeups: number;
  /** Time in the phases starting and turn; never idle, waits or sleep. */
  activeMs: number;
  phase: AttemptPhase | null;
  facts: AttemptFacts | null;
  stopRequested: { cause: StopCause; reason: string; by: string; handoff: boolean; deferred: boolean; at: number } | null;
  /**
   * The commands shown to the person, and the take-over ref they push to. handingBack: a hand-back from the clone on
   * its way, by whom and since when, until attempt.handed_back, a refused hand_back or handbackTimeoutMs (X-49).
   */
  takeover: {
    local: string | null;
    anywhere: string;
    ref: string;
    error: string | null;
    handingBack: { by: string; at: number } | null;
  } | null;
  leaseExpiresAt: number | null;
  quotaResetsAt: number | null;
  startedAt: number;
  endedAt: number | null;
  lastActivityAt: number;
}

export interface AttemptLogEntry {
  id: number;
  attemptId: string;
  ts: number;
  kind: 'tool' | 'turn' | 'text' | 'delivery' | 'quota' | 'violation' | 'compaction' | 'vendor_error' | 'rejected' | 'note';
  summary: string;
}

/**
 * What a runner's heartbeat reports for each live attempt. Ages, not timestamps, with sleep and freeze
 * gaps already subtracted, so the hub never reads them against its own clock.
 */
export interface AttemptFacts {
  attemptId: string;
  fence: Fence;
  phase: AttemptPhase;
  /** Since the last agent event. */
  eventAgeMs: number;
  tool: { name: string; command: string | null; long: boolean; capMs: number | null; ageMs: number } | null;
  /** Since the last file change in the clone (.agflow/run excluded). */
  fsAgeMs: number | null;
  commitAgeMs: number | null;
  turns: number;
  /** Consecutive completed turns with no tool call and no diff change. */
  turnsWithoutProgress: number;
  /** Identical consecutive tool calls (name and arguments). */
  repeatedCalls: number;
  continuations: number;
  /** Continuous time in vendor_error. */
  vendorErrorMs: number;
  /** Time in the phases starting and turn only. */
  activeMs: number;
  /** 0..1 of the model's window. */
  contextUsed: number | null;
}

/** Derived by the hub; draining is a separate flag. */
export type RunnerState = 'online' | 'offline' | 'needs_login' | 'incompatible' | 'crash_loop' | 'disk_low';

export interface Runner {
  /** 'R-<n>' */
  id: string;
  owner: string;
  name: string;
  state: RunnerState;
  /** One line: why, shown on the card. */
  stateDetail: string | null;
  /** The stateDetail of the last report that was not ok. */
  lastError: string | null;
  capacity: number;
  keepAwake: 'off' | 'ac' | 'always';
  draining: boolean;
  settingsVersion: number;
  protocol: number;
  agflowVersion: string;
  platform: string;
  vendors: RunnerVendor[];
  profile: ProfileSummary;
  git: { ready: boolean; problem: string | null; lastPushAt: number | null };
  power: { source: 'ac' | 'battery' | 'unknown'; batteryPercent: number | null; lowPowerMode: boolean } | null;
  disk: { freeBytes: number; agflowBytes: number } | null;
  /** Epoch ms from the last heartbeat: no placement before it (wake, battery, disk). */
  acceptingUntil: number | null;
  activeAttempts: number;
  lastSeenAt: number;
  createdAt: number;
}

export interface RunnerVendor {
  vendor: Vendor;
  /** The runner's own pinned binary. */
  cliVersion: string | null;
  /** The owner's install, for information. */
  ownerCliVersion: string | null;
  ready: boolean;
  /** 'not logged in', 'login expired', 'test mode', 'binary missing', ... */
  problem: string | null;
  /** sha256 of the account identity (email or organisation), first 16 hex. */
  accountId: string | null;
  /** 'Claude Max', 'ChatGPT Plus' */
  plan: string | null;
  /** The device has managed configuration for this vendor; it says nothing about who answers approvals. */
  managedPolicy: boolean;
  /**
   * The device policy regulates who may answer approvals, or could not be read (design 6.10). Absent from an older
   * runner's report, which the hub reads as reserved: a policy it has not heard of fails closed.
   */
  approvalsReservedToOwner?: boolean;
  models: { lead: string; worker: string };
  /** A copy of the runner's settings, for display; 0..1. */
  ceilings: { fiveHour: number; weekly: number };
  /** A copy of the runner's settings, for display. */
  allowPaidUsage: boolean;
  /** From the hub's vendor holds, never from runner messages. */
  degraded: boolean;
  /** When the runner last ran this vendor's preflight. */
  preflightAt: number | null;
}

export interface VendorQuota {
  state: 'ok' | 'exhausted' | 'unknown';
  /** Epoch ms: the reset of the limiting window (one per account). */
  resetsAt: number | null;
  /** Utilization 0..1. */
  windows: { fiveHour: number | null; weekly: number | null };
  paidUsage: 'disabled' | 'enabled' | 'in_use' | 'unknown';
  updatedAt: number;
}

/** Shared by every runner of one owner on one account. */
export interface AccountQuota {
  owner: string;
  vendor: Vendor;
  accountId: string;
  quota: VendorQuota;
  /** An approval timed out; cleared when the owner acts. */
  ownerAway: boolean;
}

export interface ProfileSummary {
  /** open: the hackathon profile, with network for agents and the greenfield files theirs to change. */
  name: 'standard' | 'auto' | 'open';
  /** Boundaries this laptop cannot enforce. */
  weakened: string[];
  /** The sandbox for dependency preparation works here. */
  dependencyPrep: boolean;
}

export interface Approval {
  /** Minted by the runner (UUID). */
  id: string;
  attemptId: string;
  fence: Fence;
  runnerId: string;
  owner: string;
  taskId: string | null;
  agentId: string;
  kind: 'command' | 'file_change' | 'other';
  summary: string;
  detail: { command?: string; cwd?: string; reason?: string; diff?: string; manifestDiff?: string; grantRoot?: string };
  status: 'pending' | 'approved' | 'declined' | 'expired' | 'void';
  decidedBy: string | null;
  createdAt: number;
  expiresAt: number;
  decidedAt: number | null;
}

/**
 * A pending approval as GET /api/approvals lists it for the agent holding the lead seat (design 6.10, Who may answer).
 * leadMayApprove is false where the hub cannot confirm that the runner leaves this vendor's approvals to an agent: the
 * lead may only decline that one, or leave it to the owner.
 */
export interface LeadApproval extends Approval {
  leadMayApprove: boolean;
}

export interface SubmissionRecord {
  /** 'S-<n>' */
  id: string;
  taskId: string;
  attemptId: string;
  status: 'pending' | 'submitted' | 'failed';
  summary: string;
  evidence: string[];
  headSha: string | null;
  /**
   * Why it failed; null unless failed. A runner's refusal is its SubmitError code, or '<code>: <the runner's detail>'
   * when the runner sent one; the submit timeout is 'remote'; an ending is 'attempt ended: <end reason>'. Read it
   * with splitSubmitError.
   */
  error: string | null;
  requestedAt: number;
  decidedAt: number | null;
  /** The runner's check of the submission; absent when the runner reported none, as for a refusal before the check. */
  check?: SubmissionCheck;
}

/**
 * The runner's own run of the project's check at submission: the "check" command of .agflow/config.json on main, run
 * in the clone once main is merged in. none: no check ran, because main's config names none or the runner cannot run
 * one; the tail then says why.
 */
export interface SubmissionCheck {
  status: 'passed' | 'failed' | 'none';
  /** The command as the config gives it; null when it gives none. */
  command: string | null;
  durationMs: number;
  /** The end of the command's output, at most 4 KB. */
  tail: string;
  /**
   * The check's own files that the branch changes, when the check passed: .agflow/config.json, which names the check,
   * and any file its command names, such as scripts/check.sh. Absent when there are none. AGFLOW_AUTO_ACCEPT leaves
   * such a submission to the lead, since a check the agent changed cannot vouch for its work.
   */
  ownFilesChanged?: string[];
}

export interface LeadSeat {
  kind: 'live' | 'runner' | 'none';
  agentId: string | null;
  attemptId: string | null;
  runnerId: string | null;
  since: number | null;
  wakeups: number;
  /** The project setting: may the scheduler start leads on runners. */
  runnerLeads: boolean;
}

/** A row of lead_notes; GET /api/lead/notes. */
export interface LeadNote {
  id: number;
  attemptId: string | null;
  kind: 'handoff' | 'restatement';
  /** Agent text, always shown quoted. */
  body: string;
  author: string;
  createdAt: number;
}

/** GET /api/prepare/:id; stored as its prepare_dependencies command. */
export interface PrepareRequest {
  /** The command id. */
  id: string;
  attemptId: string;
  status: 'pending' | 'ok' | 'failed';
  error: string | null;
  logTail: string | null;
  requestedAt: number;
  finishedAt: number | null;
}

/** A lead's explicit vault fetch; POST /api/fetch-submission and GET /api/fetch-submission/:id. */
export interface FetchSubmissionRequest {
  /** The refresh_vault command id, or null for a live-chat lead. */
  id: string | null;
  branch: string;
  head_sha: string;
  status: 'pending' | 'ok' | 'failed';
  error: string | null;
  note?: string;
  /** The runner's check of the submission, when it reported one. */
  check?: SubmissionCheck;
}

// ---------------------------------------------------------------------------
// The load (GET /api/load)
// ---------------------------------------------------------------------------

/** One owner's account on one vendor, across the owner's runners logged in to it. */
export interface AccountLoad {
  owner: string;
  vendor: Vendor;
  /** Null when the runners do not know the account. */
  accountId: string | null;
  /** 'Claude Max', 'ChatGPT Plus'; null when no runner reports one. */
  plan: string | null;
  /**
   * The vendor's attempts that take a slot on those runners that are online and not draining: workers starting or
   * running. A lead, and a worker waiting for its quota, take none.
   */
  busy: number;
  /** The slots of the same runners, which the owner's other vendor shares. */
  capacity: number;
  /** Utilization 0..1 as placement counts it; null when unknown. */
  fiveHour: number | null;
  weekly: number | null;
  /** The lowest of those runners' ceilings, 0..1. */
  ceilings: { fiveHour: number; weekly: number };
  /** The reset of the limiting window; null when unknown. */
  resetsAt: number | null;
  /** 'ok' when one of those runners can take an attempt of the vendor now; otherwise placement's refusal. */
  state: 'ok' | PlacementRefusal;
}

/** The project's numbers on the Load page. Ages and time left are as of HubLoad.now. */
export interface ProjectLoad {
  /** Runner workers that take a slot; the lead's target (null for none); AGFLOW_MAX_WORKERS. */
  workers: { running: number; target: number | null; cap: number };
  /**
   * The slots of the runners that can take a worker, now or once a slot frees (online, not draining, git ready, with a
   * usable vendor): all, taken, and free. A lead takes none. The lead's report counts its free worker slots from these.
   */
  slots: { capacity: number; busy: number; idle: number };
  /** Free slot minutes in the last hour, from the scheduler's samples since the hub started. */
  idleSlotMinutes: number;
  tasks: {
    ready: number;
    /**
     * Ready tasks the scheduler may start now (design 6.6, step 3); none while it holds dispatch: the project is
     * paused, the churn guard holds it, or the hub recovers after downtime.
     */
    dispatchable: number;
    blockedOnDependencies: number;
    submitted: { count: number; oldestAgeMs: number | null };
    /** Accepted tasks not in main yet, the ones agflow is merging (AGFLOW_AUTO_MERGE) included. */
    acceptedNotMerged: { count: number; oldestAgeMs: number | null };
    mergedLastHour: number;
  };
  /** project.deadline_at, and the time left until it, below 0 once it has passed. */
  deadline: { at: number | null; leftMs: number | null };
  /** main's check (AGFLOW_AUTO_MERGE); null until one passed or failed. */
  main: MainHealth | null;
}

/**
 * main's check as its newest result that passed or failed left it: passed at a sha, or failing since the first failure
 * after the last pass, with the open task that fixes it, if any. A failure counts only at the sha agflow had merged
 * last when it came.
 */
export type MainHealth =
  | { status: 'passed'; sha: string; at: number }
  | { status: 'failed'; since: string; fixTask: string | null };

/** GET /api/load: how busy the accounts and the project are, for people in the web UI. */
export interface HubLoad {
  /** The hub's clock when it answered. */
  now: number;
  accounts: AccountLoad[];
  project: ProjectLoad;
}

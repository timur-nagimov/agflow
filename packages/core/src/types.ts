export type Vendor = 'claude' | 'codex';
export type AgentRole = 'lead' | 'worker';
export type AgentOrigin = 'live' | 'runner';
export type AgentStatus = 'active' | 'idle' | 'gone';

export type TaskKind = 'code' | 'research' | 'review' | 'curation';
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
export type BlockedKind = 'deps' | 'agent' | 'impossible';

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
}

export interface Submission {
  summary: string;
  evidence: string[];
  branch: string | null;
  headSha: string | null;
  submittedAt: number;
  by: string;
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
}

export interface TaskNote {
  id: number;
  taskId: string;
  kind: 'progress' | 'handoff' | 'release';
  body: string;
  author: string;
  createdAt: number;
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
  status: AgentStatus;
  lastSeenAt: number;
  createdAt: number;
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
  events: HubEvent[];
  messages: MessageView[];
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
  lead: Agent | null;
  counts: Record<string, number>;
  activeAgents: number;
  humansInbox: MessageView[];
}

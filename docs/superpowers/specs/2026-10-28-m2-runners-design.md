# agflow M2 design — runners

- **Date:** 2026-10-28, revision 4 (after the design review, a re-check of revision 2, and the cross-plan questions of the seven plan outlines)
- **Status:** implemented by plans M2a (hub), M2b (runner core and bridge), M2c (runner service and operations), M2d (Claude adapter), M2e (Codex adapter), M2f (web UI) and M2g (end-to-end and documentation); manual live-run results are recorded separately in [the runbook](../../m2-live-run.md).
- **Extends:** [the agflow design spec](2026-10-26-agflow-design.md), sections 6, 9.5, 9.7 and 11–14, and the open items of section 18
- **Evidence:**
  - A live verification of both CLIs, git isolation and process supervision on 2026-10-28 (Claude Code 2.1.285 with Agent SDK 0.3.285, Codex 0.159.2 under this Mac's MDM policy, git 2.50, Bun 1.3.11, macOS 26.6).
  - A push probe against github.com.
  - An adversarial review of revision 1 by six reviewers. Of their 141 findings, independent verifiers upheld 107 in full and 32 in part. Section 18 lists what changed.

Where this document disagrees with the spec, this document wins; section 17 lists the spec changes.

## 1. Goal and exit criteria

M2 adds **runners**: a daemon on each teammate's laptop that starts agents, supervises them, pushes their work and replaces them when they fail, so work continues without anyone driving the chats.

Exit criteria (spec §16), made concrete:

1. **Killed agent.** A worker's process group is killed mid-task. The task is finished by a new attempt on another runner, which starts from the dead attempt's final work-in-progress (WIP) commit and its handoff note. No committed or uncommitted work from before the kill is lost.
2. **Closed laptop.** A runner and its agents are frozen mid-task, as a closed lid does. After the runner lease expires, the task is finished on another runner from the last pushed WIP and an assembled handoff note. When the frozen runner wakes up, it stops its agent and pushes the agent's late work to a separate ref; the hub records it, so nothing is lost.
3. **Lost lead.** The lead runs on a runner that is frozen. A new lead starts on another runner from the lead's handoff, and it reviews a submission that arrives afterwards.

All three run as an automated end-to-end test with real CLIs driven by scripted model servers (section 15), and once with real subscriptions.

## 2. Scope

**In M2:**
- the runner daemon, its macOS service, and owner notifications;
- the Claude Code and Codex adapters;
- per-attempt clones, the runner's vault, and WIP pushes;
- dependency preparation in a sandbox;
- attempts, fencing and runner leases;
- stall detection, continuation, replacement and handoff;
- scheduling with auto-fill, `request_agents` and quota-aware routing per account;
- permission profiles, and an approvals relay to the owner;
- keep-awake and power handling;
- take-over and hand-back;
- the lead on runners, with wake-ups, rotation and failover;
- hub recovery after restarts, clock jumps and restores;
- the churn guard;
- retention on the hub and on laptops;
- the web UI for runners, attempts and approvals.

**Not in M2:**
- checks in verification clones, tamper and scope scans, reviewer agents, PRs and the merge queue (M3);
- area managers, usage dashboards and repo-derived context (M4).

As in M1, the lead accepts or rejects submissions and people mark tasks merged.

## 3. What the verification changed

| Spec or revision 1 said | Verified fact | M2 decision |
|---|---|---|
| Runner keeps one mirror with a linked worktree per task (§6.1) | Linked worktrees share the mirror's config and refs. One agent command (`git config credential.helper '!prog'`, an `include.path`, or `extensions.worktreeConfig` with a planted `config.worktree`) makes the runner's own authenticated fetch or push run the agent's program with the owner's credentials. An agent can also move other tasks' refs. | **One standalone clone per attempt.** The runner never runs git with a git directory an agent can write (section 7.3). |
| Harvest by fetching from the clone (revision 1) | A local fetch runs `git-upload-pack` inside the source repository. Git strips `-c` overrides (`GIT_CONFIG_PARAMETERS`) for it, so the clone's own config applies; `GIT_CONFIG_GLOBAL` still reaches it, and git ignores a repo-level `uploadpack.packObjectsHook`. | The runner copies the clone's objects into a runner-owned **quarantine** and fetches from there into the runner-owned **vault** (section 7.3). |
| Brief through an SDK `SessionStart` callback (§6.2) | SDK `SessionStart` callbacks do not fire on 2.1.285. A `SessionStart` command hook in the flag-settings layer fires on startup, resume, clear and compact. | The brief arrives through a command hook running `agflow hook brief --runner`. |
| `streamInput()` sends messages at any time (§6.2) | `streamInput(finite)` closes stdin and ends the session. | One long-lived async iterable per session carries every message. |
| Deny rules for `git push`, `gh`, `glab` stop pushes (§18 #1) | Prefix rules miss `git -C . push`. An empty `GH_CONFIG_DIR` still returns the owner's token from the keychain. With `HOME` kept, `env -u GIT_CONFIG_GLOBAL git push` defeats the git environment. | The boundary is the **network**: agent commands cannot reach the git host or the hub. The credential-free git environment and the guards are extra layers. |
| Codex: `AGENTS.md` loads only in trusted projects (§6.3) | `AGENTS.md` loads without trust. Trust enables the project's `.codex/` layer, which can add MCP servers. | Trust is given only to a clone whose `.codex/` equals the base commit's (section 9.2). |
| Codex fallback `codex exec --json` (§6.3) | Under MDM, `exec` cannot answer approvals, so no command runs. | No `exec` fallback. |
| Codex: re-send the brief after compaction (§6.3) | `developerInstructions` survive compaction and restarts but cannot change on resume. | Static brief in `developerInstructions`; dynamic updates as messages. |
| A per-agent `CLAUDE_CONFIG_DIR` loses the login (earlier research) | The 2.1.285 binary names the keychain item `Claude Code-credentials-<first 8 hex of sha256(configDir)>` whenever `CLAUDE_CONFIG_DIR` is set. `.claude.json`, transcripts and memory stay inside the directory. | Each runner has its own Claude config directory and its own Codex home, each logged in once by the owner. Agents never load the owner's hooks, skills, MCP servers or global instructions, and the runner's login cannot disturb the owner's. |
| Codex's managed policy shows as a mismatch on `thread/start` (revision 1) | On this Mac, `thread/start` returns the policy that was requested. `configRequirements/read` and `config/read {includeLayers: true}` show the requirements and the MDM layer. | Detection uses those two calls and fails closed. The runner never answers approvals itself anyway (section 6.10). |
| Codex agents are isolated by their own `CODEX_HOME` | The built-in `codex_apps` MCP server exposes the account's ChatGPT apps. Their read-only tools (web search) run without approval. Personal skills load from `$HOME/.agents/skills`. | `--disable apps --disable plugins`. App-server runs with a runner-owned empty `HOME`. Every start checks that the agflow bridge is the only MCP server and that no user skills load. |
| `ZDOTDIR` keeps the owner's shell profile away from Claude agents | The implemented mitigation sets `ZDOTDIR=<claudeHome>/agflow-empty`, drops incoming `CLAUDE_CODE_SHELL`, and sets `CLAUDE_CODE_SHELL=/bin/zsh` unless `SHELL` already names zsh. Only the snapshot sources `~/.zshrc` outside the sandbox, once per Claude process; `~/.zshenv`, `~/.zprofile`, `~/.zlogin` and `~/.bashrc` do not run around agent commands. | The snapshot remains an accepted residual risk (section 5). Its file lives in the runner's Claude home, which sandboxed commands cannot read. |
| A per-attempt `TMPDIR` | Claude's sandbox always lets commands write `/tmp/claude`, and gives them `TMPDIR=/tmp/claude-<uid>`, which every Claude session of the user shares. With `CLAUDE_CODE_TMPDIR=<dir>` they get `<dir>/claude-<uid>`, but only while that path is at most 44 bytes; beyond that the CLI silently falls back to the shared directory. | Each Claude attempt gets a short private directory `/tmp/agf/<id>` as `CLAUDE_CODE_TMPDIR`, and `/tmp/claude` goes into `denyWrite`. |
| Leases renewed by runner-observed activity (§6.7) | Claude is silent for a whole foreground tool call. A polling, hung tool looks busy to CPU and process signals. | **Runner lease** = the laptop is there. **Stall** = a hub decision from fresh facts, with a hard cap on tool time (section 6.8). |
| Kill the agent's process group | Both CLIs put tool processes in their own sessions and groups. Claude ignores stdin EOF in the middle of a turn. SIGINT ends Codex but leaves its command running. | A stop ladder: interrupt, then close, then SIGTERM, then SIGKILL of every recorded group, with identity checks against PID reuse (section 7.4). |
| GitHub accepts custom ref namespaces (open) | Probe against github.com: pushes to `refs/agflow/*` work. `--force-with-lease=<ref>:<sha>` and `--atomic` work on them. A repeated push reports `=`. A commit reachable only from such a ref can be fetched by SHA. Default clones do not download them. | WIP refs live in `refs/agflow/`. The prefix is configurable, with `refs/heads/agflow-wip/` for hosts that refuse custom namespaces (GitLab is unverified). |

## 4. Architecture

```
                         hub (server)
  ┌──────────────────────────────────────────────────────────────┐
  │ REST + SSE (M1) · runner gateway (WebSocket) · scheduler     │
  │ attempts, fences, runner leases · stall and ladder policy     │
  │ handoff assembly · lead seat · approvals · submissions        │
  └───────▲──────────────────────────────────────▲───────────────┘
          │ WebSocket, opened by the laptop        │ HTTPS: the bridge, with a scoped agent token
  ┌───────┴──────────────────────────────────────┴──────────────┐
  │ laptop                                                        │
  │  runner daemon (LaunchAgent dev.agflow.runner)                │
  │   ├─ ~/.agflow/vaults/<project>.git   bare, runner-only;      │
  │   │     the owner's git login is used only here               │
  │   ├─ base checkouts of main (Claude's project config root)    │
  │   ├─ ~/.agflow/work/<project>/T-42-a3/   one clone per attempt│
  │   │     └─ agent: claude (Agent SDK) │ codex app-server       │
  │   │           └─ agflow mcp --runner (bridge) ───────────────►│
  │   ├─ dependency preparation in a sandbox                      │
  │   └─ keep-awake (caffeinate -i -w <runner pid>)               │
  └───────────────────────────────────────────────────────────────┘
```

- The hub decides; runners execute. Only hub code changes task, attempt and lease state, starts or stops agents, and decides that an agent stalled.
- A runner keeps only what the hub cannot rebuild: its outbox of events, its journal of executed commands, its process registry, and the clones.
- The hub never contacts a laptop. Every command travels down the runner's own WebSocket.

## 5. Security model for runner agents

Agents run as the laptop owner's user. Four boundaries contain them, and tests in the plans check each one.

1. **Network.** Agent tool commands reach only package registries or nothing: Claude through its sandbox's network allowlist with `strictAllowlist`, Codex through `workspace-write` with network off. They cannot reach the git host or the hub. The runner removes every channel that would bypass the sandbox:
   - Claude's in-process `WebFetch` and `WebSearch`;
   - claude.ai connectors, and the skills and plugins synced from the account;
   - Codex's built-in `codex_apps` server (the account's ChatGPT apps, whose read-only tools run without approval);
   - Codex plugins and web search.

   Every start checks that the agflow bridge is the only MCP server.
2. **Writes.** Agent tool commands write only inside their clone and their private temporary directory. Claude's in-process `Edit` and `Write` tools are confined to the same places by deny rules and a guard, in both profiles.
3. **Authority.** Agents act on the hub only through their bridge, with a scoped agent token.
   - The hub accepts agent tokens only on an explicit list of routes (section 6.5).
   - Lead authority comes from holding the lead seat, never from an agent's role column.
   - A runner agent cannot be impersonated with the owner's CLI token.
4. **Git.** Agents cannot push: no route to the host, no credentials, and `protocol.allow=never`. Only the runner pushes, from the vault, which agents cannot write.

**Approvals.** Boundaries 1 and 2 hold only until the owner approves an escalation. Codex runs an approved command outside the sandbox, with network and the owner's full write access. Package managers also run lifecycle scripts from manifests the agent can edit. So the runner never answers an approval request itself, on any device: every request goes to the owner, and the Approvals view says what approving means (section 6.10).

**Text from agents.** Text an agent wrote never reaches another agent unquoted or as hub-authored instructions. This covers notes, handoffs, commit messages, transcript tails, restatements and messages.

**Reads.** Claude's sandbox denies reads of credential paths, of the runner's state and homes, and of other attempts' clones (section 7.6). Codex's sandbox restricts reads only in part; it does block the login keychain lookup. So a Codex agent can read most files the owner can. That is no worse than the owner's own interactive Codex sessions, and boundary 1 contains it.

Both sandboxes also let agent commands read the argv and environment of every process of the owner (`KERN_PROCARGS2`; `ps` itself is blocked). Secrets the owner exports in shells or passes on command lines are therefore readable by agents. Boundary 1 limits what they can do with them.

**Attempts on one laptop trust each other.** Agent tokens sit in the vendor processes' environment (and, for Claude, in its argv through the MCP config). Other same-user processes can read them. Fencing, short token life and boundary 1 limit the effect.

**Device policy.** agflow never works around an organisation's policy. On a device whose Codex policy is managed, nothing changes, because the runner already answers no approval.

**Residual risks:**
- **Shell profile.** The mitigation is implemented: the adapter sets `ZDOTDIR=<claudeHome>/agflow-empty`, drops any incoming `CLAUDE_CODE_SHELL`, and sets `CLAUDE_CODE_SHELL=/bin/zsh` unless the basename of `SHELL` is already `zsh`. Only the snapshot sources the owner's `~/.zshrc` outside the sandbox, once per Claude process, with the agent's environment. `~/.zshenv`, `~/.zprofile`, `~/.zlogin` and `~/.bashrc` do not run around agent commands. The snapshot remains an accepted residual risk.
- **Package registries.** They are allowed hosts for Claude, so a determined agent could encode data in registry requests.
- **Base checkout.** Hooks and settings from the base checkout of `main` run outside the sandbox. Agent-config paths on `main` change only through people (section 7.3).
- **The `auto` profile.** Claude's classifier decides Bash commands that would otherwise prompt, within the sandbox. The guard still confines `Edit` and `Write`.
- **The CLI's own writes into `HOME`.** Even with its own config directory, the Claude CLI process (not the agent's tools) writes `~/.claude/bridge-spawn`, `~/Library/Caches/claude-cli-nodejs/<slug>/mcp-logs-agflow/` and `~/.config/anthropic` into the owner's home.
- **Keychain.** Denying reads of `~/Library/Keychains` blocks `security` lookups. This was verified with `sandbox-exec`, and inside Codex's sandbox. A plan test checks it with a throwaway item: the lookup must succeed outside the sandbox and fail inside.

## 6. Hub

### 6.1 Domain additions

```ts
// packages/core/src/types.ts (additions)
export interface Fence { epoch: number; counter: number }   // compared numerically: epoch first, then counter
export type AttemptStatus = 'starting' | 'running' | 'quota_wait' | 'holding' | 'ended';
export type AttemptEndReason =
  | 'accepted' | 'rejected' | 'cancelled' | 'released' | 'blocked' | 'stalled' | 'crashed'
  | 'failed_to_start' | 'stopped' | 'replaced' | 'lost' | 'taken_over' | 'rotated' | 'superseded';
export type FailureClass = 'infra' | 'agent' | 'review';
export type AttemptPhase =
  | 'starting' | 'preparing' | 'turn' | 'idle' | 'waiting_approval' | 'quota_wait' | 'vendor_error' | 'stopping';

// Why a stop was requested. packages/core/src/ladder.ts exports STOP_CAUSES: Record<StopCause, { endReason:
// AttemptEndReason; failureClass: FailureClass | null; handoff: boolean; interruptFirst: boolean }>, the one mapping
// the hub and the runner both use (section 6.4).
export type StopCause =
  | 'stall_silent' | 'stall_hung_tool' | 'stall_loop' | 'stall_no_progress' | 'stall_budget'
  | 'stop' | 'stop_hold' | 'replace' | 'quota' | 'vendor_error' | 'context' | 'policy' | 'auth'
  | 'cancel' | 'blocked' | 'impossible' | 'released' | 'takeover' | 'rotation' | 'branch_moved';

export interface Attempt {
  id: string;                 // 'T-42-a3'; from epoch 2 'T-42-e2-a3'; leads 'lead-a5' / 'lead-e2-a5'
  taskId: string | null;      // null for lead attempts
  number: number;             // per task, or per lead seat
  role: AgentRole;
  agentId: string;
  runnerId: string | null;    // null for live-chat attempts
  vendor: Vendor;
  model: string | null;       // set from attempt.spawned
  sessionRef: string | null;  // Claude session id or Codex thread id
  fence: Fence;
  status: AttemptStatus;
  endReason: AttemptEndReason | null;
  failureClass: FailureClass | null;
  failureSignature: string | null;   // end reason plus normalised error, for repeated infra failures
  startRef: string | null;
  startSha: string | null;    // the commit the runner actually started from
  wipRef: string | null;      // 'refs/agflow/T-42/a3'
  wipSha: string | null;
  submittedSha: string | null;
  resumable: boolean;         // false once its clone or session is known to be gone
  reviewRounds: number;       // ladder step 1 resumes
  wakeups: number;            // deliveries to a lead attempt
  activeMs: number;           // time in the phases starting and turn; never idle, waits or sleep (section 6.8)
  phase: AttemptPhase | null;
  facts: AttemptFacts | null;
  stopRequested: { cause: StopCause; reason: string; by: string; handoff: boolean; deferred: boolean; at: number } | null;
  takeover: { local: string | null; anywhere: string; ref: string; error: string | null; handingBack: { by: string; at: number } | null } | null;
                              // commands shown to the person; ref: the take-over ref they push to (section 6.12)
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

// The hub derives the state (section 6.3); draining is a separate flag.
export type RunnerState = 'online' | 'offline' | 'needs_login' | 'incompatible' | 'crash_loop' | 'disk_low';
export interface Runner {
  id: string;                 // 'R-<n>'
  owner: string;
  name: string;
  state: RunnerState;
  stateDetail: string | null; // one line: why, shown on the card
  lastError: string | null;   // the stateDetail of the last report that was not ok
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
  acceptingUntil: number | null;   // epoch ms, from the last heartbeat: no placement before it (wake, battery, disk)
  activeAttempts: number;
  lastSeenAt: number;
  createdAt: number;
}
export interface RunnerVendor {
  vendor: Vendor;
  cliVersion: string | null;  // the runner's own pinned binary
  ownerCliVersion: string | null;  // the owner's install, for information
  ready: boolean;
  problem: string | null;     // 'not logged in', 'login expired', 'test mode', 'binary missing', ...
  accountId: string | null;   // sha256 of the account identity (email or organisation), first 16 hex
  plan: string | null;        // 'Claude Max', 'ChatGPT Plus'
  managedPolicy: boolean;
  models: { lead: string; worker: string };
  ceilings: { fiveHour: number; weekly: number };   // copy of the runner's settings, for display; 0..1
  allowPaidUsage: boolean;    // copy of the runner's settings, for display
  degraded: boolean;          // from the hub's vendor_holds, never from runner messages
  preflightAt: number | null; // when the runner last ran this vendor's preflight
}
export interface VendorQuota {
  state: 'ok' | 'exhausted' | 'unknown';
  resetsAt: number | null;    // epoch milliseconds; the reset of the limiting window (one per account)
  windows: { fiveHour: number | null; weekly: number | null };   // utilization 0..1
  paidUsage: 'disabled' | 'enabled' | 'in_use' | 'unknown';
  updatedAt: number;
}
export interface AccountQuota {   // shared by every runner of one owner on one account
  owner: string;
  vendor: Vendor;
  accountId: string;
  quota: VendorQuota;
  ownerAway: boolean;         // an approval timed out; cleared when the owner acts
}
export interface ProfileSummary {
  name: 'standard' | 'auto';
  weakened: string[];         // boundaries this laptop cannot enforce
  dependencyPrep: boolean;    // the sandbox for dependency preparation works here
}

export interface Approval {
  id: string;                 // minted by the runner (UUID)
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

export interface SubmissionRecord {
  id: string;                 // 'S-<n>'
  taskId: string;
  attemptId: string;
  status: 'pending' | 'submitted' | 'failed';
  summary: string;
  evidence: string[];
  headSha: string | null;
  error: string | null;
  requestedAt: number;
  decidedAt: number | null;
}

export interface LeadSeat {
  kind: 'live' | 'runner' | 'none';
  agentId: string | null;
  attemptId: string | null;
  runnerId: string | null;
  since: number | null;
  wakeups: number;
  runnerLeads: boolean;       // project setting: may the scheduler start leads on runners
}

export interface LeadNote {   // a row of lead_notes; GET /api/lead/notes
  id: number;
  attemptId: string | null;
  kind: 'handoff' | 'restatement';
  body: string;               // agent text, always shown quoted
  author: string;
  createdAt: number;
}

export interface PrepareRequest {   // GET /api/prepare/:id; stored as its prepare_dependencies command
  id: string;                 // the command id
  attemptId: string;
  status: 'pending' | 'ok' | 'failed';
  error: string | null;
  logTail: string | null;
  requestedAt: number;
  finishedAt: number | null;
}
```

**Changes to existing types:**
- `Agent` gains `runnerId` and `attemptId`. For runner agents, `status` follows the attempt:
  - `starting` and `running` → `active`;
  - `quota_wait` and `holding` → `idle`;
  - `ended` → `gone`.
- `TaskContract` gains optional `vendorHint: 'claude' | 'codex' | null`.
- `Task` gains `currentAttempt`, `attemptCount` (every attempt of the task, live ones included), `workRef`, `workSha` and `nextDispatchAt`.
- `TaskDetail` gains `attempts: Attempt[]` and `submissions: SubmissionRecord[]`.
- `BlockedKind` gains:
  - `'takeover'`: a person holds the task;
  - `'replan'`: ladder step 4;
  - `'paused'`: a person stopped and held the work;
  - `'branch_moved'`: the task branch moved outside agflow;
  - `'policy'`: the vendor refused the work on policy grounds.
- `TaskNote['kind']` gains `'restatement'` and `'late_work'`. `TaskNote` gains `attemptId: string | null`: the attempt a handoff, restatement or late-work note belongs to, so the task page pairs notes with attempts.
- The task's `Submission` gains `attemptId` and `submissionId`.
- `Project` gains `runnerLeads`.
- `HubStatus` gains `leadSeat: LeadSeat` and `epoch: number` (the hub epoch, section 6.14). `HubStatus.lead` stays: the seat holder's agent, or null.
- `Principal.via` gains `'agent'`.

### 6.2 Schema version 2

One migration, appended to `MIGRATIONS` in `packages/hub/src/db.ts`:

```sql
ALTER TABLE project ADD COLUMN epoch INTEGER NOT NULL DEFAULT 1;
ALTER TABLE project ADD COLUMN worker_target INTEGER;            -- request_agents; NULL = the cap
ALTER TABLE project ADD COLUMN vendor_pref TEXT;
ALTER TABLE project ADD COLUMN vendor_pref_until INTEGER;
ALTER TABLE project ADD COLUMN runner_leads INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agents ADD COLUMN runner_id TEXT;
ALTER TABLE agents ADD COLUMN attempt_id TEXT;
ALTER TABLE tasks ADD COLUMN current_attempt TEXT;
ALTER TABLE tasks ADD COLUMN ladder_floor INTEGER NOT NULL DEFAULT 0;  -- highest attempt number at the last re-plan
ALTER TABLE tasks ADD COLUMN work_ref TEXT;                     -- where the next attempt starts
ALTER TABLE tasks ADD COLUMN work_sha TEXT;
ALTER TABLE tasks ADD COLUMN branch_head TEXT;                  -- task branch head the hub last recorded
ALTER TABLE tasks ADD COLUMN next_dispatch_at INTEGER;          -- infra backoff
ALTER TABLE tasks ADD COLUMN dispatch_hold_until INTEGER;       -- waiting for late work or a final push
ALTER TABLE task_notes ADD COLUMN attempt_id TEXT;               -- TaskNote.attemptId
INSERT INTO counters (name, value) VALUES ('runner', 0), ('fence', 0), ('lead_attempt', 0), ('submission', 0);

CREATE TABLE hub_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_alive_at INTEGER NOT NULL,
  recovery_until INTEGER,
  restored_at INTEGER,
  dispatch_paused_until INTEGER,     -- churn guard
  last_lead_review_at INTEGER,
  lead_agent_id TEXT,                -- the lead seat
  lead_kind TEXT,                    -- 'live' | 'runner'
  lead_since INTEGER
);

CREATE TABLE runners (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  runner_key TEXT NOT NULL UNIQUE,
  machine_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'offline',
  state_detail TEXT,
  last_error TEXT,
  capacity INTEGER NOT NULL,
  keep_awake TEXT NOT NULL DEFAULT 'ac',
  draining INTEGER NOT NULL DEFAULT 0,
  settings_version INTEGER NOT NULL DEFAULT 0,
  protocol INTEGER NOT NULL,
  info TEXT NOT NULL,                -- JSON: agflowVersion, platform, vendors, profile, git, power, disk
  vendor_holds TEXT NOT NULL DEFAULT '{}',   -- JSON { [vendor]: { degradedUntil, failedStarts, notReadySince } }, hub-owned
  accepting_until INTEGER,           -- from heartbeats: no placement before this time
  connection_id TEXT,
  session_hash TEXT,                 -- the CLI session its link uses (sliding expiry)
  last_seen_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  retired_at INTEGER
);

CREATE TABLE vendor_accounts (
  owner TEXT NOT NULL,
  vendor TEXT NOT NULL,
  account_id TEXT NOT NULL,
  quota TEXT NOT NULL,               -- JSON VendorQuota
  owner_away INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner, vendor, account_id)
);

CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks (id),
  number INTEGER NOT NULL,
  role TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  runner_id TEXT,
  vendor TEXT NOT NULL,
  model TEXT,
  session_ref TEXT,
  fence_epoch INTEGER NOT NULL,
  fence_counter INTEGER NOT NULL,
  status TEXT NOT NULL,
  end_reason TEXT,
  failure_class TEXT,
  failure_signature TEXT,
  start_ref TEXT,
  start_sha TEXT,
  wip_ref TEXT,
  wip_sha TEXT,
  submitted_sha TEXT,
  resumable INTEGER NOT NULL DEFAULT 1,
  review_rounds INTEGER NOT NULL DEFAULT 0,
  wakeups INTEGER NOT NULL DEFAULT 0,
  active_ms INTEGER NOT NULL DEFAULT 0,
  resume_log TEXT,                   -- JSON list of { at, cause: 'runner_restart' | 'lead_exit' }
  phase TEXT,
  facts TEXT,                        -- JSON AttemptFacts
  facts_at INTEGER,                  -- when the hub received them
  stop_requested TEXT,               -- JSON {cause, reason, by, handoff, deferred, at}
  takeover TEXT,                     -- JSON {local, anywhere, ref, error}
  final_sha TEXT,                    -- the harvested head reported at exit, even when its push failed
  compaction_summary TEXT,
  transcript_tail TEXT,
  lease_expires_at INTEGER,
  quota_resets_at INTEGER,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  last_activity_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX attempts_task_number ON attempts (task_id, number) WHERE task_id IS NOT NULL;
CREATE UNIQUE INDEX attempts_one_open ON attempts (task_id) WHERE task_id IS NOT NULL AND status != 'ended';
CREATE INDEX attempts_status ON attempts (status);
CREATE INDEX attempts_runner ON attempts (runner_id);

CREATE TABLE attempt_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,   -- tool | turn | text | delivery | quota | violation | compaction | vendor_error | rejected | note
  summary TEXT NOT NULL
);
CREATE INDEX attempt_log_attempt ON attempt_log (attempt_id, id);

CREATE TABLE agent_tokens (
  token_hash TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  fence_epoch INTEGER NOT NULL,
  fence_counter INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX agent_tokens_attempt ON agent_tokens (attempt_id);

CREATE TABLE submissions (
  id TEXT PRIMARY KEY,               -- 'S-<n>'
  task_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  status TEXT NOT NULL,              -- pending | submitted | failed
  summary TEXT NOT NULL,
  evidence TEXT NOT NULL,            -- JSON string[]
  head_sha TEXT,
  remote_head TEXT,
  error TEXT,
  requested_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE UNIQUE INDEX submissions_one_pending ON submissions (attempt_id) WHERE status = 'pending';

CREATE TABLE runner_commands (
  id TEXT PRIMARY KEY,
  runner_id TEXT NOT NULL,
  hub_epoch INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  attempt_id TEXT,
  fence_epoch INTEGER,
  fence_counter INTEGER,
  payload TEXT NOT NULL,             -- JSON; agent tokens are never stored
  status TEXT NOT NULL,              -- pending | done | failed | cancelled
  result TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  done_at INTEGER,
  UNIQUE (runner_id, hub_epoch, seq)
);
CREATE INDEX runner_commands_pending ON runner_commands (runner_id, status);

CREATE TABLE pending_deliveries (
  message_id INTEGER NOT NULL,
  attempt_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, attempt_id)
);

CREATE TABLE runner_inbox (
  runner_id TEXT NOT NULL,
  outbox_epoch TEXT NOT NULL,
  acked_seq INTEGER NOT NULL,
  PRIMARY KEY (runner_id, outbox_epoch)
);

CREATE TABLE runner_event_rejects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  runner_id TEXT NOT NULL,
  outbox_epoch TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  error TEXT NOT NULL,
  raw TEXT NOT NULL,
  at INTEGER NOT NULL
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,               -- minted by the runner
  attempt_id TEXT NOT NULL,
  fence_epoch INTEGER NOT NULL,
  fence_counter INTEGER NOT NULL,
  runner_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  task_id TEXT,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT NOT NULL,
  status TEXT NOT NULL,
  decided_by TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  decided_at INTEGER,
  lead_notified_at INTEGER
);
CREATE INDEX approvals_owner_status ON approvals (owner, status);

CREATE TABLE lead_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id TEXT,
  kind TEXT NOT NULL,                -- handoff | restatement
  body TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

The migration also inserts the `hub_state` row with `last_alive_at = now`. If M1's `currentLead()` returns a live lead (seen within 15 minutes), it sets `lead_agent_id` to it, with `lead_kind = 'live'`.

### 6.3 Runner link

A WebSocket at `GET /api/runner/ws`, opened by the runner with `Authorization: Bearer <CLI token>`.
- **Who may open it.** Only `cli` sessions. Before the upgrade, with no socket, browser cookies get 401 and agent tokens get 403 `agent_not_allowed`.
- **Probe.** `GET /api/runner/whoami` answers the same check over HTTP, because a refused WebSocket client sees only "Expected 101".
- **Session expiry.** Each authenticated `hello` slides the session's expiry forward, so a runner in use never loses its login to the 90-day limit.

All messages are JSON objects with a `t` field, validated by zod schemas in `packages/core/src/runner-protocol.ts`, which both sides import. **Protocol version 1.**

```ts
// Runner → hub
export type RunnerMessage =
  | { t: 'hello'; protocol: number; runnerKey: string; machineId: string; name: string;
      agflowVersion: string; platform: string;
      settings: RunnerSettings;        // the last hub-confirmed snapshot, never local edits
      vendors: RunnerVendor[]; quota: AccountQuotaReport[]; profile: ProfileSummary; git: Runner['git'];
      state: 'ok' | 'crash_loop' | 'disk_low'; stateDetail: string | null;
      outboxEpoch: string;           // new whenever runner.db is new
      firstSeq: number;              // lowest event seq the runner still keeps (acknowledged ones are kept 48 h)
      lastSeq: number;               // highest event seq the runner holds; firstSeq − 1 when the outbox is empty
      lastHubEpoch: number | null;
      attempts: LiveAttempt[] }      // every attempt whose start or resume the runner has recorded
  | { t: 'heartbeat'; at: number; attempts: AttemptFacts[]; power: Runner['power']; disk: Runner['disk'];
      acceptingUntil: number | null }   // ms from now during which the runner takes no new attempt (wake, battery, disk)
  | { t: 'events'; outboxEpoch: string; events: RunnerEvent[] }
  | { t: 'result'; commandId: string; ok: boolean; data?: unknown; error?: string };

export interface RunnerSettings {     // runner.json is the source; only the hub assigns versions; see "Settings sync"
  capacity: number;
  keepAwake: 'off' | 'ac' | 'always';
  draining: boolean;
  ceilings: Partial<Record<Vendor, { fiveHour: number; weekly: number }>>;
  allowPaidUsage: Partial<Record<Vendor, boolean>>;
  version: number;
}

export interface LiveAttempt {
  attemptId: string;
  fence: Fence;
  state: 'starting' | 'running' | 'idle' | 'stopped' | 'suspended';
                                     // starting: before attempt.spawned; running: the process is alive (a worker,
                                     // or a lead in a turn); idle: a lead's process waits between wake-ups;
                                     // stopped: no process; suspended: stopped by a suspend
  sessionRef: string | null;
  clone: boolean;                    // the clone still exists
}
export interface AccountQuotaReport { vendor: Vendor; accountId: string; quota: VendorQuota }
                                     // runners omit reports for a vendor whose account id is unknown

// Hub → runner
export type HubMessage =
  | { t: 'welcome'; runnerId: string; hubEpoch: number; hubTime: number; ackedSeq: number;
      wipRefPrefix: string; stop: { attemptId: string; reason: string }[];
      timings: { heartbeatMs: number; deadLinkMs: number; handoffMs: number;   // override runner.json
                 wipGraceMs: number } }   // runnerLeaseMs / 3: WIP pushes during a link outage (section 7.3)
  | { t: 'ack'; outboxEpoch: string; seq: number }       // cumulative
  | { t: 'heartbeat_ack'; at: number; hubTime: number }
  | { t: 'command'; id: string; seq: number; command: RunnerCommand };
```

**Identity.**
- **Unknown key.** A `hello` with an unknown `runnerKey` registers a new runner, owned by the session's user and bound to `machineId`. The owner never changes.
- **Known key.** A `hello` with a known key from another user, or from another machine, is refused with close code 4403: "this runner belongs to <owner> on another machine; run agflow runner setup". A `hello` from a retired runner is refused with 4403 too: "this runner was retired; run agflow runner setup".
- **Second connection.** A second connection with the same key and machine replaces the first, which is closed with 4409.
- **Protocol range.** A `hello` with a protocol outside the hub's supported range is refused with 4426, naming the minimum version. The runner row records it as `incompatible`. Upgrades go hub first, then runners: a hub accepts [`minProtocol`, current], and `minProtocol` rises only in a release after the one that introduced the newer protocol.
- **State.** The hub derives each runner's state:
  - `offline` with no link;
  - `needs_login` when it is offline and the session in `runners.session_hash` no longer verifies (checked at disconnect and by the auth sweep);
  - `incompatible` after a 4426 refusal;
  - `crash_loop` and `disk_low` as reported;
  - otherwise `online`.

  `draining` is a separate flag. `RunnerVendor.degraded` and the hub's not-ready marks come from `runners.vendor_holds` and are never taken from runner messages. A vendor report whose `preflightAt` is later than the mark's `notReadySince` clears it.

**Settings sync.** `runner.json` holds the settings, plus a snapshot of the last settings the hub confirmed, with their version.
- `hello.settings` carries that snapshot, never a local edit.
- On `hello`, the hub compares versions:
  - a runner it does not know (a new runner, or a hub restored from a backup older than the runner): the hub stores the reported values at version 1 and echoes them with `update_settings`;
  - an equal version: nothing;
  - an older version (the owner changed settings in the browser meanwhile): the hub sends all of its settings with `update_settings`;
  - a newer version (a restored hub): the hub adopts the reported values and version, and cancels its pending `update_settings`.
- Local edits (`drain`, `undrain`, a hand edit, the crash-loop self-drain) travel only as `runner.settings`, after `welcome`. The hub applies them in seq order, whatever their base, each at a new version. It echoes each one verbatim with `update_settings`, as it echoes the owner's edits. A local edit that cannot be written to `runner.json`, or whose `runner.settings` cannot be stored, changes nothing, and the error is thrown.
- An edit is in flight until an echo answers it and the snapshot reaches that echo's version. `runner.json` holds the view: the snapshot with the edits in flight laid over it. A local edit counts as a change when it differs from `runner.json`, so an edit back to an earlier value is sent. After each `welcome`, the runner sends every field where `runner.json` differs from the view: a hand edit made while it was down.
- An echo answers the oldest unanswered edit with the same settings among the edits the outbox held when the echo arrived. The runner keeps that answer in `runner.db` with the echo's version, and writes it before `runner.json`.
- The snapshot moves one version at a time. An echo at the snapshot's version + 1 becomes the snapshot. `runner.json` takes the new view, except a field that differed from the view before the echo (an edit made by other means): that field keeps its value and is sent again. An echo at or below the snapshot's version only marks the edit it answers. The hub's whole settings (every field, with each per-vendor record naming every vendor the snapshot's record holds) become the snapshot at any version not below the snapshot's.
- Each `hello` starts a new lineage of commands. An `update_settings` the runner took before its latest `hello` gets no result and does not run. The hub keeps a command with no result pending and sends it again after the next `welcome`, if it still has it.
- These `update_settings` wait: one that would skip a version, one that fails (a `runner.db` error), and one whose journal row cannot be written. A failure is retried after 1 s, then after a wait that doubles up to 60 s. The waiting echoes run in version order, once the ones before them have run or the hub's whole settings cover them. Each gets its result on the same link. The next `hello` leaves the ones still waiting without a result. Any other command whose journal row cannot be written is answered with the failure.
- When `runner.json` cannot be written, the runner logs it and keeps the new settings in memory; the next successful write catches the file up. If the runner restarts before then, it reads the older version, and its `hello` brings the hub's whole settings.
- Refusals: the hub acknowledges an edit it refuses and never echoes it. After an acknowledgement, once the commands received before it have run, an acknowledged edit with no echo gets a probe. A probe is a `runner.settings` with no fields: the hub applies it at a new version and echoes it as `update_settings {}`, which nothing else sends. At the probe's echo, every older unanswered edit was refused. The runner logs a warning, `runner.json` takes the hub's value, and the edit is never sent again.
- A restored hub: a `welcome` whose hub epoch differs from the last one's. The runner records the events it holds, then the new epoch (a death between the two records the events again). Then it says `hello` again at once, before it runs a command or sends an event. The hub reconciled the first `hello` against what its backup knew of the runner, perhaps nothing. The second `hello` finds the runner's snapshot there, at its version or adopted, and what the first one made the hub send is cancelled or gets no result. A write that fails while the runner handles a `welcome` or an `ack` is logged and handling continues. Failed restore bookkeeping is the exception: recording the held events and then the epoch share one guarded block; if either fails, the runner drops the link with normal backoff and returns before commands or replay. The epoch remains unrecorded and the next `welcome` retries the bookkeeping. Successful restore bookkeeping still reconnects immediately.
- Replays: the replays to a restored hub leave out the edits held at its first `welcome` whose answer the snapshot holds, because the restored hub would apply them twice. Every other replay sends every event above `welcome.ackedSeq`, since the hub acknowledges an event in the transaction that applies it. The hub permits omissions within replay up to `hello.lastSeq`, and its cumulative acknowledgement covers them; gaps after `hello.lastSeq` close the link. Restored-hub omissions are bounded by `restoredThrough` and covered by the replacement `hello`. When the newest event held is one the replay leaves out, a probe follows it, so the acknowledgement reaches `hello.lastSeq`.
- An events message the hub cannot apply as a whole receives no acknowledgement and closes the link with 1011. The runner reconnects through normal backoff and replays from the acknowledged position.
- Retention never prunes an edit still in flight for the snapshot `runner.json` was last written with, and keeps no probe.
- So a drain made while offline and a capacity change made in the browser meanwhile both survive.
- Known limits. An echo does not name the edit it answers, and a version does not name the hub that gave it. The exact fix is a protocol change for a later milestone. `update_settings` would name the `runner.settings` it answers, refusals would be answered explicitly, and `hello` would name the edits its snapshot holds. Until then:
  - After a restore, an edit that an equal echo answered before the edit reached the hub can be lost.
  - After a restore, when the owner's edits took the hub past the runner's version before the runner's `hello`, the hub does not adopt the runner's snapshot. The edits the old hub echoed after the backup are then not delivered.
  - When the owner's edits bring a restored hub exactly to the runner's version before its `hello`, the hub finds the versions equal. The two sides then keep different settings at the same versions.
  - A restored hub ahead of the runner with another history (a backup older than an earlier restore) has its pending echoes applied on the runner's snapshot until its whole settings come.
  - A probe's echo settles the oldest open probe. After a probe the hub refused, later refusals are settled one probe late, and new probes wait for the next `welcome`. When retention drops an acknowledged probe before its echo runs, that echo settles a newer probe and marks the edits before it as refused. `runner.json` reverts them until their own echoes come.

**Link behaviour:**
- The runner sends a heartbeat every 15 s. The hub answers each one with `heartbeat_ack`.
- Both sides treat 45 s without any inbound message as a dead link and terminate it (`terminate()`, not `close()`).
- Reconnect uses full-jitter exponential backoff: base 1 s, cap 30 s, reset after the link has been up for 60 s. The handshake times out after 10 s.
- A 1 s wall-clock tick on the runner detects sleep or a freeze: a gap over 5 s reconnects at once and replays the outbox. The gap is subtracted from every age the runner reports.
- **Refused token.** After a refused handshake, the runner calls `whoami`. On 401 it enters `needs_login` (section 7.1); otherwise it backs off.
- **4409 on the current connection** means another process uses this runner's key; the runner logs it and exits 0. A 4409 on a socket that a reconnect already replaced is ignored.
- Transcript tails go over HTTP: `POST /api/runner/attempts/:id/transcript`.

**Events.** Events are durable and are replayed until acknowledged.
- **Shape and order.** Each event is `{ seq, at, type, attemptId?, fence?, data }`. The runner stores them in a bun:sqlite outbox with an `AUTOINCREMENT` seq and sends them in order.
- **Retention.** Acknowledged events are kept for 48 hours, so a restored hub can catch up.
- **Applying.** The hub applies each event in its own savepoint. The cumulative acknowledgement always advances: an event is never refused by withholding the ack, so one bad event cannot block a runner's outbox.
- **Acknowledged position.** On `hello` the hub sets `acked_seq = max(acked_seq, firstSeq − 1)`, creating the row if needed, and returns it as `welcome.ackedSeq`. The runner then sends every event after it that it still has. The replay is complete once `acked_seq` reaches `hello.lastSeq`.
- **Stale events.** An event about an attempt takes effect only if the attempt is not ended and the event's fence equals the attempt's current fence. Otherwise it is logged (`attempt_log` kind `rejected`), with these exceptions:
  - `attempt.wip` and `attempt.late_work` of an ended attempt, or of an attempt the hub does not know, are recorded as late work (section 6.4);
  - `attempt.exited` of an ended attempt records the exit and voids its approvals, and a `finalWip` that differs from the recorded `wip_sha` is recorded as late work;
  - `attempt.submitted` always records the branch head it reports;
  - `attempt.taken_over` of an attempt that ended `taken_over` stores its commands;
  - `attempt.handed_back` completes the hand-back (section 6.12); `hand_back` carries no fence, so none is compared;
  - `attempt.violation` of an ended attempt is still reported to people and the lead.
  - During the replay after a restore (`hello.lastHubEpoch` below the hub's epoch), an event whose fence is newer than the attempt's recorded fence counts as current: it was sent after the backup.
- **Effects on tasks** apply only if `tasks.current_attempt` is this attempt and the task is in the state the effect expects.
- **Invalid, unknown or throwing events** are acknowledged, stored in `runner_event_rejects`, and emitted as `runner.event_rejected`.

| Event type | Data | Hub effect |
|---|---|---|
| `attempt.spawned` | sessionRef, pid, model, cliVersion, permissionMode, startSha (null on a resume) | `starting` → `running`, for a new session and for a resumed one; agent session id set; the unread backlog is delivered (section 6.7) |
| `attempt.failed_to_start` | error, refused (one of `START_REFUSALS`: `draining`, `at_capacity`, `vendor_not_ready`, `disk_low`, `battery_low`, `waking`, `needs_login`) or null | ends `failed_to_start`. Infra, with backoff and a failure signature, unless `refused` is set: then the class is null (no backoff, no signature, not counted toward the two-failed-starts rule), the refusal shows on the runner's card, and nothing more is placed on that runner until its next heartbeat. The task goes back to `ready` under section 6.4's conditional moves. |
| `attempt.activity` | kind (`tool`, `turn`, `text`, `compaction`, `vendor_error`, `note`; adapter warnings are sent as `note`), summary | `attempt_log` (newest 500 kept); `last_activity_at`; a compaction also sets `compaction_summary` |
| `attempt.first_output` | text | quoted `restatement` note on the task (successors) or in `lead_notes` (leads) |
| `attempt.delivered`, `attempt.acknowledged` | messageIds (an id 0 is ignored) | delivery rows (section 6.7) |
| `attempt.quota` | vendor, accountId (null when unknown), quota | quota `exhausted` → `quota_wait`; `ok` → `running` again (section 6.10); the account's quota is updated only with an accountId |
| `attempt.prepared` | requestId (null for a preparation the runner ran before a start or resume), ok, error, log tail | dependency preparation result (section 7.7) |
| `attempt.wip` | ref, sha, stripped, skipped, embedded, logStat (at most 4,000 characters) | `wip_sha`, task `work_ref`/`work_sha`; event `attempt.wip` |
| `attempt.wip_failed` | error, failures (the runner's consecutive failed WIP pushes, over all its attempts) | runner `git.ready` false at 3; a later `attempt.wip`, or a `hello` with `git.ready`, sets it back |
| `attempt.violation` | phase (`start`, `wip`, `submit`, `takeover`; a hand-back from the clone reports `wip`), paths | event; message to people and the lead |
| `attempt.submitted` | submissionId, ok, headSha, remoteHead, error (null, `dirty`, `protected_paths`, `needs_merge`, `branch_moved`, `remote`, `interrupted`), detail | the submission outcome (section 6.13); `dirty`, `protected_paths` and `needs_merge` are fixable by the agent |
| `attempt.taken_over` | commands { local, anywhere }, wipSha, error | take-over completes (section 6.12) |
| `attempt.handed_back` | ref, sha | hand-back completes |
| `attempt.vendor_outcome` | kind (`auth`, `context`, `policy`, `denials`, `session_budget`), detail | the matching row of section 6.4; `denials` and `session_budget` count as the stall rule `budget` |
| `attempt.exited` | code, signal, stoppedBy, handoffWritten, cause (`suspend`, `runner_stop` or null), finalSha (the harvested head, whenever the harvest succeeded), finalWip { ref, sha } or null, pushError | ends or keeps the attempt per the trigger table (section 6.4) |
| `attempt.late_work` | taskId, ref, sha | late work under section 6.4's rule; `late_work` note; message to the current holder naming the ref to merge |
| `runner.vendors` | RunnerVendor[], AccountQuotaReport[] | runner info; account quota |
| `runner.settings` | the changed fields, baseVersion | the hub applies them, sets the version to its own version + 1 and echoes `update_settings` at that version; only the hub assigns versions |
| `runner.state` | state, detail | `crash_loop`, `disk_low`, or back to `ok` |
| `approval.requested` | approvalId, kind, summary, detail | `approvals` row; event; owner notified (section 6.10) |
| `approval.voided` | approvalId | approval `void` |

The code lists in this table are closed and live in `packages/core/src/runner-protocol.ts`: the activity kinds, `START_REFUSALS`, `SUBMIT_ERRORS`, `VIOLATION_PHASES`, `VENDOR_OUTCOME_KINDS`, `EXIT_CAUSES` (`suspend`, `runner_stop`) and `STOPPED_BY` (`interrupt`, `close`, `sigterm`, `sigkill`, `none`). Senders import them instead of writing literals; any other value makes the event a reject.

**Commands.**
- **Delivery.** Commands carry an id, a per-runner seq (unique within the hub epoch), and, for an attempt, its fence. Command ids are `<hubEpoch>-<runnerId>-<seq>`, so they never repeat across restores. The hub stores them in `runner_commands` and sends the pending ones after every `welcome`, in seq order.
- **Journal.** Before it executes a command, the runner records it in its journal in `runner.db` with state `running`. When it finishes, it records the result as `done` and sends `result`.
  - A command that arrives again while `running` is not executed twice; its result follows when the first execution ends.
  - One that arrives again when `done` gets the stored result.
  - After a runner restart, commands left `running` are run again through their idempotent handlers, or answered `{ ok: false, error: 'interrupted' }`.
- **Idempotency keys:**
  - `start_attempt` and `resume_attempt`: attempt and fence;
  - `push_submission`: submissionId;
  - `stop_attempt`, `hold_attempt` and `prepare_takeover`: the fence;
  - `decide_approval`: approvalId.
- **Ordering on the runner.**
  - Each attempt's lifecycle and git work runs on its own serial queue, in seq order: start, resume, stop, hold, push_submission, prepare_takeover, hand_back, cleanup_attempt, prepare_dependencies, the WIP timer, the final WIP and late work.
  - `deliver`, `interrupt` and `decide_approval` act on the live session at once, so an approval raised during a handoff turn does not wait behind `stop_attempt`.
  - Different attempts run concurrently. Updates to one vault's refs are serialized.
- **Cancellation.** In the transaction that ends an attempt or gives it a new fence, the hub cancels every pending command of the old fence. `cleanup_attempt`, `upload_transcript` and `hand_back` are kept. Cancelled commands are never resent. A new fence enqueues its `resume_attempt` and re-targets pending deliveries in the same transaction.
- **Unsupported commands.** Protocol 1 has 17 command kinds, the members of `RunnerCommand` below. `COMMAND_MIN_PROTOCOL` in core names, for each kind, the minimum protocol that understands it (1 for all 17), and a command is never sent to an older runner. An unknown or invalid command is answered `{ ok: false, error: 'unsupported' }`.
- **Tokens.** Agent tokens are never stored in `runner_commands.payload`. A resent `start_attempt` or `resume_attempt` carries a freshly minted token for the same attempt and fence. Earlier tokens of that attempt and fence stay valid. All of them are revoked together when the attempt ends, gets a new fence, or the epoch changes.
- **Resume on a live process.** A `resume_attempt` for an attempt whose process is still alive first stops it, with the stop ladder, the final push and no handoff turn. It then resumes the session with the new token, because a bridge's token cannot change in place. This happens after a restore, and for a step-1 resume whose hold never reached the runner. When the hub re-fences an attempt whose `resume_attempt` is still pending, the new command carries that command's prompt and messages.

```ts
export type RunnerCommand =
  | { kind: 'start_attempt'; attempt: AttemptSpec }
  | { kind: 'resume_attempt'; attemptId: string; fence: Fence; agentToken: string;
      prompt: string;              // the quoted review feedback (ladder step 1), the wake-up delivery (a holding lead),
                                   // or "the runner restarted; continue from your last step" (reconciliation, restore)
      messages: InjectedMessage[];
      taskPack: string | null; restore: AttemptSpec['restore']; acceptanceIds: string[] }   // recomputed by the hub
  | { kind: 'deliver'; attemptId: string; fence: Fence; messages: InjectedMessage[];
      more: number }               // messages that did not fit; the runner adds one line about them (section 6.7)
  | { kind: 'interrupt'; attemptId: string; fence: Fence }      // the Agents view's Interrupt action
  | { kind: 'stop_attempt'; attemptId: string; fence: Fence; cause: StopCause; reason: string;
      handoff: boolean;            // ask for a handoff note first (section 6.8)
      interruptFirst: boolean;     // interrupt the turn before asking (stuck tools, quiet agents, loops)
      keepClone: boolean }         // true for stop-and-hold, so a person can still take the clone over
  | { kind: 'hold_attempt'; attemptId: string; fence: Fence }
  | { kind: 'push_submission'; attemptId: string; fence: Fence; submissionId: string; branch: string;
      expectedBranchSha: string | null; adoptable: string[] }   // shas the hub accepts as the remote head (section 6.13)
  | { kind: 'prepare_takeover'; attemptId: string; fence: Fence; person: string }
  | { kind: 'hand_back'; attemptId: string; source: { kind: 'clone' } | { kind: 'ref'; ref: string; sha: string } }
                                   // protocol-1 hubs send only the clone source; a runner given a ref source
                                   // fetches the ref into its vault and answers ok, with no event
  | { kind: 'cleanup_attempt'; attemptId: string }
  | { kind: 'decide_approval'; attemptId: string; fence: Fence; approvalId: string; decision: 'approve' | 'decline';
      reason: string | null }
  | { kind: 'upload_transcript'; attemptId: string }   // for attempts that ended lost, when their runner says hello
  | { kind: 'prepare_dependencies'; attemptId: string; fence: Fence; requestId: string }
  | { kind: 'refresh_vault'; taskId: string; refs: string[] }   // late work or a lead's submission fetch
  | { kind: 'preflight'; vendor: Vendor }                        // after the hub sets a not-ready mark
  | { kind: 'delete_refs'; refs: { ref: string; expectedSha: string }[] }
  | { kind: 'update_settings'; settings: Partial<Omit<RunnerSettings, 'version'>>; version: number };

export interface InjectedMessage {
  messageId: number;               // 0: hub text with no message row (the lead's situation report);
                                   // runners never report it as delivered or acknowledged
  authority: 'person' | 'agent' | 'system';
  text: string;                    // formatted and quoted by the hub
}

export interface AttemptSpec {
  attemptId: string;
  taskId: string | null;
  role: AgentRole;
  vendor: Vendor;
  model: string | null;            // null: the runner's models[vendor][role]
  fence: Fence;
  agentToken: string;
  hubUrl: string;
  repo: { url: string; mainBranch: string };
  start: { ref: string; sha: string | null };   // the task's work position, or main
  branch: string | null;           // 'agflow/T-42-<slug>'; from epoch 2 'agflow/T-42-e2-<slug>'; null for leads
  wipRef: string | null;
  restore: { paths: string[]; base: string | null };
                                   // paths: protected-class patterns with this task's exemptions applied, matched
                                   // only with core's matchesProtectedPattern; base: 'refs/heads/<mainBranch>',
                                   // which the runner resolves in its vault (section 7.3); null: the start commit
  acceptanceIds: string[];         // for continuation prompts
  toolCaps: {                      // computed by the hub; the runner reports the cap it applied in AttemptFacts.tool.capMs
    defaultMs: number;             // toolCapMs
    longMs: number;                // longToolCapMs, for commands matching longPatterns (packages/core/src/stall.ts)
    checks: { cmd: string; capMs: number }[];   // per task check: max(longToolCapMs, timeoutS × 1000 + 10 min)
  };
  taskPack: string;                // .agflow/run/task.md, composed by the hub; agent text quoted
  brief: string;                   // static brief (Codex developerInstructions, .agflow/run/brief.md)
  firstPrompt: string;
  successor: boolean;              // ask for a restatement first
}
```

**Reconciliation on `hello`.** The hub decides it in the `hello` transaction, for every attempt it believes is not ended on this runner, from the reported state. The first matching row applies. Two rows wait:
- the two "after a restore" rows apply once the replay is complete (`acked_seq` reaches `hello.lastSeq`); if the link drops first, the next `hello` decides again;
- when `hello.state` is not `ok`, the rows that resume a `stopped` or `suspended` attempt wait for `runner.state` `ok`, and the leases keep running meanwhile.

| Reported | Hub status | Action |
|---|---|---|
| any state, after a restore (`hello.lastHubEpoch` < the hub epoch) | open, and its task (or the lead seat) still names it | `resume_attempt` with a new fence (infra), after the hub has applied the events this runner replays; not counted as a runner-restart resume |
| any state, after a restore | open, but its task no longer names it | ends `superseded`; listed in `welcome.stop` |
| `stopped` or `suspended`, with or without a clone | open with `stop_requested` set | the process is gone, so the attempt ends with the requested cause's end reason, and its row in section 6.4 applies (invariant a). A take-over in flight with a clone gets its pending `prepare_takeover` resent; the runner re-runs it from its harvest step. |
| `starting`, `running` or `idle` | any open status | none; pending commands are resent and the journal deduplicates them |
| `stopped` or `suspended`, with a clone | `starting`, `running` or `quota_wait` | `resume_attempt` with a new fence (class `infra`). After the second runner-restart resume within `resumeWindowMs` (an hour), the attempt ends `crashed` instead. |
| `stopped` or `suspended`, with a clone | `holding` | none; it stays `holding` |
| not reported | `starting` with `start_attempt` still pending | none; the command is resent with a fresh token |
| not reported, or reported without a clone | `starting`, `running` or `quota_wait` | ends `crashed` (infra); its pending commands are cancelled |
| not reported, or reported without a clone | `holding` | `resumable` = false; the task keeps its status |
| reported, but ended or unknown to the hub | — | listed in `welcome.stop` |

The runner applies `welcome.stop` before any command, and answers later commands for those attempts with `{ ok: false, error: 'attempt_ended' }`. A `suspended` attempt is also resumed when its runner reports `runner.state` `ok` again; otherwise its lease expiry ends it `lost`.

### 6.4 Attempts, fencing and leases

- **Creating an attempt.** The scheduler, or a replacement, creates the following in one transaction:
  - the agent (origin `runner`, its `last_seen_at` renewed with the runner lease);
  - the attempt (`starting`, a new fence);
  - the agent token;
  - the claim on the task (`claimed`, `assignee`, `current_attempt`);
  - the `start_attempt` command.
- **One open attempt per task**, enforced by the `attempts_one_open` unique index. `tasks.current_attempt` always names the task's newest attempt and changes only when a new attempt is created.
- **Fence.** `{ epoch, counter }`, compared numerically by `compareFence` in core. A fence is issued when an attempt starts and again whenever it resumes. Agent tokens, commands and events carry it.
- **Resume.** Every `resume_attempt` sets the attempt to `starting` in the transaction that issues it. This applies to ladder step 1, a lead's wake-up, reconciliation and restores. A `starting` attempt holds a runner lease, counts toward capacity, and receives no deliveries. The runner reports `attempt.spawned` again when the resumed session is live, which moves the attempt to `running`. A failed resume reports `attempt.failed_to_start` (section 7.4).
- **Runner lease.** Attempts in `starting`, `running` or `quota_wait` hold a runner lease, renewed by every heartbeat that lists them. Default 15 minutes. It measures whether the laptop is there, not whether the agent works (stalls are section 6.8). `holding` and `ended` attempts hold none.
- **Lease expiry.** The attempt ends `lost` (infra) and its token is revoked. If the task is held, it goes `stale` → `ready` with an assembled handoff note.
  - If the runner comes back, `welcome.stop` names the attempt. The runner stops it without a handoff turn, pushes its late work to a late-work ref, reports `attempt.late_work` (and `attempt.exited` with `finalWip` null when a process was still alive), and then gets `upload_transcript`.
  - If such a runner reconnects while the task is still `ready`, dispatch waits `dispatchHoldMs` (2 minutes, `dispatch_hold_until`) for that late work.
- **Work position.** `tasks.work_ref` and `work_sha` say where the next attempt starts, whether it runs on a runner or in a live chat. They are updated by:
  - `attempt.wip` and `attempt.exited.finalWip` of the current attempt;
  - runner submissions and live submits (the task branch);
  - hand-back (section 6.12).
  - **Late work**, but only while the task has no open attempt and its work position is still the late attempt's own (its `wip_sha`, or its `start_sha` if it never pushed). Otherwise the hub records a `late_work` note naming the ref, for the next attempt to merge.

  Without a position, attempts start from `main`.

**Every way an attempt ends.** Every hub path that takes a task from its holder goes through one function in `attempts.ts`. That function, in the same transaction:
- ends the attempt, or records `stop_requested` with its `StopCause`;
- revokes or keeps the token;
- queues the command;
- moves the task as the table says.

`STOP_CAUSES` in core maps every cause to its end reason, class, handoff and interrupt-first flags.

| Cause | Command | The attempt ends | End reason | Class | Task move | Handoff note assembled |
|---|---|---|---|---|---|---|
| submission recorded | `hold_attempt` | no; it is `holding` | — | — | → `submitted` | — |
| accepted (lead or person) | `cleanup_attempt` | at once (it is `holding`) | `accepted` | none | → `accepted` | — |
| rejected, step 1 (section 6.9) | `resume_attempt` with the feedback, new fence | no | — | — | `rejected` → `claimed` | — |
| rejected, no resume | `cleanup_attempt` | at once | `rejected` | review | ladder (section 6.9) | — |
| `declare_blocked`, `declare_impossible` | `stop_attempt` (no handoff) | on exit | `blocked` | none | → `blocked` at once | — |
| `release_task` by the agent | `stop_attempt` (no handoff) | on exit | `released` | agent | → `ready` on exit | if none written |
| cancel (lead, person, goal change) | `stop_attempt` (no handoff) | on exit | `cancelled` | none | → `cancelled` at once | — |
| stop by a person or the lead | `stop_attempt` (handoff) | on exit | `stopped` | none | → `ready` on exit | if none written |
| stop and hold by a person | `stop_attempt` (handoff, keepClone) | on exit | `stopped` | none | → `blocked` (`paused`) at once | if none written |
| replace by a person or the lead | `stop_attempt` (handoff) | on exit | `replaced` | none | → `ready` on exit | if none written |
| stall decision | `stop_attempt` (handoff, interrupt first) | on exit | `stalled` | agent | → `ready` on exit, ladder | if none written |
| quota replacement | `stop_attempt` (no handoff) | on exit | `replaced` | infra | → `ready` on exit | yes |
| vendor errors for `vendorErrorReplaceMs` (section 6.8) | `stop_attempt` (no handoff) | on exit | `replaced` | infra | → `ready` on exit | yes |
| context window exhausted after one compaction (Codex) | `stop_attempt` (handoff) | on exit | `replaced` | infra | → `ready` on exit | if none written |
| vendor policy refusal | `stop_attempt` (no handoff) | on exit | `blocked` | none | → `blocked` (`policy`) at once; people told | — |
| vendor login expired | `stop_attempt` (no handoff) | on exit | `crashed` | infra | → `ready` on exit with backoff; the vendor is not ready | yes |
| submit finds the branch moved (section 6.13) | `stop_attempt` (handoff) | on exit | `stopped` | none | → `blocked` (`branch_moved`) at once | if none written |
| take-over | `prepare_takeover` | on `attempt.taken_over`, or at lease expiry or the stop timeout | `taken_over` | none | → `blocked` (`takeover`) at once | — |
| lead rotation | `stop_attempt` (handoff) | on exit | `rotated` | none | — | lead note |
| stop or replace of a runner lead by a person (hold is refused for leads; the lead's own tools act on workers only) | `stop_attempt` (handoff: a lead handoff) | on exit | `stopped` or `replaced` | none | — (the seat empties) | lead note |
| the runner's own stop (`cause: 'runner_stop'`): `agflow runner stop` and `uninstall` with a handoff turn; the disk and battery guards without one | — | on exit | `stopped` | infra, with no backoff and no failure signature | → `ready` on exit | if none written |
| a runner suspend (SIGTERM: launchd restart, logout, upgrade; `cause: 'suspend'`) | — | no; it keeps its status, and its lease runs without renewal until the runner says `hello` again | — | — | — | — |
| unrequested exit of a worker | — | on exit | `crashed` | infra | → `ready` with backoff | if none written |
| unrequested exit of a lead, idle or during a turn | `resume_attempt` (new fence) on the next delivery if it was idle, at once with its unacknowledged deliveries if it was in a turn | no; it is `holding` until resumed | — | — | — | — |
| third unrequested lead exit within `leadExitWindowMs` (an hour) | — | at the event | `crashed` | infra | — (the seat empties) | lead note assembled |
| a `holding` runner lead that cannot be resumed (section 6.11) | — | at once | `lost` | infra | — (the seat empties) | lead note assembled |
| runner lease expiry | (`welcome.stop` later) | at expiry | `lost` | infra | if held: `stale` → `ready` with backoff | yes |
| failed to start | — | at the event | `failed_to_start` | infra, or none for a refusal | → `ready` with backoff (none for a refusal) | — |
| reconciled away after a restore | (listed in `welcome.stop`) | at once | `superseded` | none | — | — |

**Task moves are conditional.**
- A row's task move applies only while the task is `claimed` or `working` and `tasks.current_attempt` names this attempt. The move to `submitted` applies from `claimed` or `working`, and the moves on acceptance and rejection apply from `submitted`. This holds whether a runner event, a stop request or the tick triggered it.
- The M1 operations of people and the lead (cancel, accept, reject, unblock) keep their M1 preconditions on the task. For example, cancelling a `submitted` task cancels it, and its `holding` attempt ends `cancelled` at once.
- Otherwise the attempt still ends as the row says, and the task keeps its status. An attempt that ends while a take-over is in flight leaves the task `blocked` (`takeover`).
- The ladder and the failure-signature rule run only when a move to `ready` actually happens.

**No process.** A cause whose command is `stop_attempt` or `hold_attempt` may apply to an attempt with no live process: a `holding` attempt, or a lead that exited while idle. Then the attempt ends at once with that cause's end reason and class; the task moves and the note is assembled as the row says.

**A second stop request** on an attempt that already has one:
- a cause that moves the task at request time (cancel, `blocked`, `impossible`, `policy`, `branch_moved`, stop and hold) replaces a recorded stop, replace or stall cause, and makes its move;
- a recorded `takeover` cause is never replaced, and a take-over is refused (409 `not_running`) while any stop is recorded;
- otherwise the first cause stands;
- a newer request replaces a deferred one (section 6.13).

**Invariants:**
- **(a) Exit before end.** An attempt with a live process ends when the runner reports the process gone, or when its lease expires; never at request time. `stop_requested` records the cause.
  - Until then, the agent's token works for `write_handoff` and `report_progress`, even after the task moved to `blocked` or `cancelled` at request time (section 6.5).
  - WIP it pushes is its own, not late work.
  - The one exception is an attempt reconciled away after a restore, which ends at once.
- **(b) Ready only on exit.** Moves of the task to `ready` wait for the exit, so a successor always starts from the final WIP. Moves to `blocked`, `cancelled` or `accepted` happen at request time.
- **(c) Hold and take-over.** `attempt.exited` does not end an attempt that is `holding`, or that has a hold in flight. During a take-over the runner reports no `attempt.exited`; `attempt.taken_over` takes its place.
- **(d) Stop timeout.** A stop not completed within `stopGraceMs` (the handoff timeout plus 5 minutes) ends the attempt with the requested reason and revokes its token. The runner stops the process on its next `hello`, through `welcome.stop`. If the lease expires first, the attempt ends `lost`.
- **(e) Holder fields.** A move at request time keeps `tasks.assignee`, `tasks.current_attempt` and the agent's `current_task`. The transaction that ends the attempt clears `current_task`. It also clears `assignee`, unless the task is `submitted` or `accepted`.

**Cleanup.** The transaction that ends any attempt queues `cleanup_attempt` for it, except for `taken_over` attempts, whose cleanup follows hand-back.
- The runner runs it once the attempt's final WIP is confirmed; for `lost` attempts, that is after the late-work push that `welcome.stop` triggers. Before deleting anything, it pushes pending late work (the exit's harvest), then any newer clone work, each to a new late-work ref. A failed push keeps the clone and records the work for the durable retries in section 7.4; the hub does not resend a failed cleanup.
- If the agent's process is still alive (an accept or reject during `hold_attempt`), `cleanup_attempt` first runs the stop ladder.
- It uploads the transcript tail, then removes the clone, the pins, the private temporary directory and the transcript.

**M1 operations on runner-held tasks:**

| M1 operation | On a runner attempt |
|---|---|
| `forceRelease` (the Release button) | the stop flow |
| `cancelTask` | the cancel row |
| `rejectTask` | section 6.9 |
| `acceptTask` | the accepted row |
| `resumeClaim` | refused: "held by a runner agent; take it over in the browser" |
| `unblockTask` | Refused for kind `takeover`: 409, "hand it back instead". Refused to agents for kinds `paused` (a person's hold) and `branch_moved`. It never rewrites `takeover` or `replan` to `deps`. It sets `ladder_floor` for `replan`. Unblocking `branch_moved` records the remote head shown on the task as `branch_head` and adds it to `adoptable`. While the task's current attempt is still open, the task moves to `ready` but is neither dispatched nor claimable until that attempt ends; a live claim answers 409, "the previous attempt is still stopping". |
| `reportProgress`, `touchAgent`, `claimTask` | never set `tasks.lease_expires_at`, which stays `NULL` for runner attempts |
| M1 `sweepLeases` | skips tasks whose current attempt has a runner; runs inside the tick (section 6.14) |
| M1's "Commit and push anything worth keeping" messages (`forceRelease`, `cancelTask`) | not sent to runner agents; the stop flow replaces them |

**Live-chat attempts** keep M1 behaviour and are not counted on the ladder:

| Live event | Attempt effect |
|---|---|
| claim | a new attempt (runner `null`, fence issued, `running`). It starts from the work position, which the claim answer names. |
| `resume_claim` | the old attempt ends `superseded`; a new one starts |
| submit | → `holding` |
| accept | → `accepted` |
| a rejection returned to its author | `running` again, new fence |
| a rejection M1 does not return to its author (the task goes `rejected` → `ready`) | → `rejected` (ends at once, not counted) |
| release | → `released` |
| `declare_blocked`, `declare_impossible` | → `blocked` (ends at once) |
| `forceRelease` | → `stopped` |
| lease sweep | → `lost` |
| cancel | → `cancelled` |

Live attempts keep `attempts.lease_expires_at` `NULL`; the M1 task lease stays authoritative for them. They do not count toward the worker cap.

### 6.5 Agent tokens and principals

- **Format.** A runner agent's token is `agt_` followed by 32 random bytes in base64url, stored hashed in `agent_tokens` with its agent, attempt and fence. `resolvePrincipal` treats every bearer that starts with `agt_` as an agent token and never as a session token.
- **Valid tokens.** A valid token gives `{ user: runner owner, via: 'agent', agent }`. Valid means: not revoked, the attempt not ended, the fence current, and the epoch current.
- **Invalid tokens.**
  - An `agt_` bearer whose only fault is an older epoch, while its attempt is being re-fenced after a restore, gets **401 `attempt_refenced`**. The bridge then answers: "agflow is restarting your session; stop and wait."
  - So does an unknown `agt_` bearer within `runnerLeaseMs` after a restore (`hub_state.restored_at`): tokens minted after the backup are unknown to the restored hub, and their attempts are about to be re-fenced.
  - Every other invalid `agt_` bearer (unknown, revoked, an ended attempt, an older fence) gets **401 `attempt_ended`**, with the end reason in the body (`{ error: 'attempt_ended', reason }`, reason null when unknown). The answer tells the agent to stop.
- With an agent token, `X-Agflow-Agent` is refused.
- The M1 path (CLI token plus `X-Agflow-Agent`) is refused for agents whose origin is `runner`.
- **Holder.** For an agent token, the holder test is: the token's attempt is `tasks.current_attempt`, the attempt is not ended, and the fence is current, in any task status.
  - `progress` and `handoff` need only this.
  - `submit`, `block`, `impossible` and `release` also need the task `claimed` or `working`, and no `stop_requested`.
- **Route allowlist.** Agent principals are accepted only on the routes the bridge uses. Every other route answers **403 `agent_not_allowed`**, including:
  - `/api/live/*`, `/api/cli-login/*` and `GET /api/agents`;
  - claim and resume-claim;
  - approvals, runners, attempts, take-over and the runner gateway.

  The list lives in one table in `packages/hub/src/http/agent-routes-allowed.ts`. A test enumerates every mounted route and checks that each is on the list or refuses an agent token.

| Allowed for agent tokens | Notes |
|---|---|
| `GET /api/brief` | the runner variant |
| `GET /api/goal`, `/api/status`, `/api/search`, `/api/events` | reads |
| `GET /api/tasks`, `GET /api/tasks/:id` | reads |
| `POST /api/tasks/:id/{progress,handoff,submit,block,impossible,release}` | the holder (above) |
| `GET /api/submissions/:id` | its own submissions |
| `POST /api/prepare`, `GET /api/prepare/:id` | dependency preparation for its own attempt |
| `POST /api/fetch-submission`, `GET /api/fetch-submission/:id` | lead only: the caller must hold the seat; polling is restricted to the lead attempt that requested the fetch (section 6.13) |
| `POST /api/inbox`, `POST /api/inbox/ack`, `POST /api/messages` | |
| lead routes: `POST /api/tasks`, `PATCH /api/tasks/:id`, `POST /api/tasks/:id/{cancel,accept,reject,unblock,merged}`, `POST /api/goal/notes`, `POST /api/staffing`, `POST /api/agents/:id/{stop,replace}`, `POST /api/lead/handoff`, `GET /api/lead/notes` | only while the agent holds the lead seat (section 6.11). Stop and replace apply only to runner agents. |

`leadOrHuman` changes for every agent principal, live or runner: the agent must hold the seat (`hub_state.lead_agent_id`). For `fetch_submission`, a runner lead uses its ordinary agent token; there is no separate lead token. A live lead uses the M1 CLI token plus `X-Agflow-Agent` and gets the branch and head immediately. A person without an agent identity cannot call either fetch route.

### 6.6 Scheduler

A tick runs every `tickMs` (15 s), and also right after events that free a slot or ready a task (debounced to 1 s).

0. **Clock check.** Compare now with `hub_state.last_alive_at`. A gap of more than 3 ticks is downtime (section 6.14), handled like a restart. Then update `last_alive_at`.
1. **Reconcile.** This step always runs, except during the recovery window. It covers:
   - runner leases, and the M1 task leases of live claims (M1 `sweepLeases`, moved into the tick);
   - approval expiry;
   - stall decisions, from fresh facts only (section 6.8);
   - stop timeouts (invariant d) and submission timeouts (section 6.13);
   - `holding` runner leads that cannot be resumed (section 6.11);
   - the lead's periodic review.

   Retention and remote-ref cleanup are not in the tick: they run on a daily timer (section 6.18).
2. **Lead seat** (section 6.11). Skipped while the project is paused.
3. **Ready set**, skipped while paused or while the churn guard holds dispatch. Tasks qualify when they:
   - are in `ready` with their dependencies done;
   - have no open attempt: the attempt named by `tasks.current_attempt`, if any, has ended;
   - own no path a runner agent may not change (`protected-paths.ts`, section 7.3): no agent-config path; no people-only path unless a person created the task; no curator path unless the task's kind is `curation`. Such tasks stay `ready` for live chats, and the board marks them "live chat only";
   - overlap no path holder;
   - have `next_dispatch_at` and `dispatch_hold_until` in the past;
   - have counted attempts below the ladder limit.

   They are ordered by priority, then age.

   **Path holders** are tasks that are `claimed`, `working`, `submitted`, `checking` or `reviewing`, or `blocked` with kind `takeover`, `paused` or `branch_moved`. This set replaces M1's `PATH_HOLDERS` everywhere: live claims, `rejectTask`'s return to the author, and `update_task` use it too.
4. **Slots.** Running worker attempts (`starting`, `running`, `quota_wait`) stay below `target = worker_target ?? maxWorkers` (default 4). Leads and live chats do not count.
5. **Placement** for each ready task, in order.
   - **Candidate runners** must be:
     - in state `online`, not draining, and with `git.ready`;
     - without `acceptingUntil` in their last heartbeat (set for a while after waking from sleep, on low battery and on low disk), and without a refused start since that heartbeat;
     - with capacity left: `capacity` minus their `starting`, `running` and `quota_wait` attempts, with a lead counting.
   - **The vendor on that runner** must be:
     - `ready`, with no not-ready mark and not `degraded` in `vendor_holds`;
     - on an account that is not exhausted, uses no paid usage unless the runner allows it, and is not `ownerAway` (section 6.10);
     - below the candidate runner's own ceilings, compared with the shared account utilization (unknown utilization counts as 0, so a ceiling of 0 keeps the vendor off that runner).

     A vendor that reports no account id is usable when ready, with no account rules. Only tests can produce one; test mode reports a fixed account id (section 15.1).
   - **Vendor preference:**
     1. the ladder's requirement (section 6.9); once the task has been ready for `vendorRequirementMs` (10 min) since its last attempt ended, any vendor;
     2. `vendorHint`;
     3. `project.vendor_pref`, until `vendor_pref_until`;
     4. the lower account utilization.
   - **Runner preference:**
     1. not the runner of the task's last attempt that ended with class agent, review or infra, unless that attempt's final push failed (section 6.8);
     2. on AC power;
     3. most free slots;
     4. lowest id.
6. **Claim and start** atomically (section 6.4).

`request_agents(count, vendor?, reason)` (a lead tool) sets `project.worker_target` to `count`, clamped to [0, cap], and answers with the running count and the target. `vendor` sets `vendor_pref` for `vendorPrefMs` (one hour). Auto-fill is the scheduler itself: with ready tasks and free slots, it starts workers without being asked. A target of 0 stops new dispatches without pausing the project.

**Pause.** Pausing the project skips steps 2–6. Agents that are already running finish what they hold, with every stall, budget and lease rule still active. The brief tells them the project is paused.

Pure placement and ordering functions live in `packages/core/src/scheduling.ts` and are unit-tested without a database.

### 6.7 Message delivery to runner agents

- **Targets.** When a message is inserted, the hub works out who it is for, with M1's `unreadFor` rules. For `lead`, that is the seat holder.
- **Pushing.** For each recipient that is a runner agent in `running` or `quota_wait`, the hub adds a `deliver` command and `pending_deliveries` rows. Messages for `starting` attempts wait for `attempt.spawned`; those for `holding` attempts wait for the resume, which carries them.
- **In flight.** A message with a `pending_deliveries` row is excluded from that agent's `unreadFor` and `check_inbox`, so it is never injected and taken twice. The row goes when `attempt.delivered` arrives, when the command is cancelled, or when the attempt ends.
- **Backlog.** When an attempt enters `running` (spawned, resumed or re-fenced), the hub delivers its whole unread backlog and re-targets pending deliveries to the new fence. Messages carried in `resume_attempt.messages` get `pending_deliveries` rows with the resume command's id, so the backlog excludes them.
- **Authority.** Messages from people are `person`; from the hub (`system`), `system`; from agents, `agent`. The hub formats every message with M1's quoting rules.
- **Batching.** Deliveries to one attempt are batched over 2 s, at most 6000 characters per command. A backlog that does not fit is counted in `deliver.more`, and the runner adds one system line to the batch: "N more agflow messages are waiting: call check_inbox". That line is not a hub message and is never reported back.
- **Hub text.** The situation report that starts each delivery to the lead (section 6.11) is an `InjectedMessage` with `messageId` 0 and authority `system`. It has no message row and is never reported back.
- **Delivered and acknowledged.** The runner reports `attempt.delivered` when the vendor accepts the input: for Claude, the message's command lifecycle reaches `started`; for Codex, the steer or turn request succeeds. It reports `attempt.acknowledged` when the turn that consumed it ends: Claude's `result.user_message_uuids`, or Codex's `turn/completed`.
- **Endings:**
  - When a worker attempt ends, its agent's unacknowledged messages are copied to the task's thread (`task:T-42`), so the successor reads them.
  - When a runner lead attempt ends, for any reason, the delivery rows of its `lead` messages without `acked_at` are deleted, so the next lead receives them.
  - From `stop_requested` on, nothing more is pushed to the attempt.

### 6.8 Stall detection, continuation, replacement and handoff

**Facts.** Every heartbeat carries facts for each live attempt. The runner reports ages, not timestamps, and subtracts sleep and freeze gaps.

```ts
export interface AttemptFacts {
  attemptId: string;
  fence: Fence;
  phase: AttemptPhase;
  eventAgeMs: number;            // since the last agent event
  tool: { name: string; command: string | null; long: boolean; capMs: number | null; ageMs: number } | null;
  fsAgeMs: number | null;        // since the last file change in the clone (.agflow/run excluded)
  commitAgeMs: number | null;
  turns: number;
  turnsWithoutProgress: number;  // consecutive completed turns with no tool call and no diff change
  repeatedCalls: number;         // identical consecutive tool calls (name and arguments)
  continuations: number;
  vendorErrorMs: number;         // continuous time in vendor_error
  activeMs: number;              // time in the phases starting and turn only (idle, waits and sleep excluded)
  contextUsed: number | null;    // 0..1 of the model's window
}
```

**Freshness.** Stall rules use only facts from a heartbeat received on the runner's current connection within the last two heartbeat intervals. Ages are taken as of that heartbeat and never extrapolated on the hub's clock. While a runner is unheard, its attempts are judged only by the runner lease. A stall decision is checked again against the next fresh heartbeat before `stop_attempt` is sent.

**Rules**, in `packages/core/src/stall.ts`, for attempts in `running`. Leads are judged only during a turn.

| Rule | Condition | Default |
|---|---|---|
| silent | no event for the stall window, no tool in flight | 10 min |
| hung tool | one tool call older than its cap (`tool.capMs`), whatever its CPU or file activity | from `AttemptSpec.toolCaps`: 30 min; 90 min for a long command; for a task check, max(90 min, the check's `timeoutS` + 10 min) |
| no progress | consecutive completed turns without a tool call or a diff change | 3 |
| loop | identical consecutive tool calls | 3 |
| budget | continuations sent, or `activeMs` of the attempt, or a vendor outcome `denials` or `session_budget` | `maxContinuations` 25; `activeBudgetMs` 4 h |

Each rule maps to a stop cause: `stall_silent`, `stall_hung_tool`, `stall_no_progress`, `stall_loop`, `stall_budget`. The phases `waiting_approval`, `quota_wait`, `vendor_error`, `preparing` and `stopping` never count as stalls, and `activeMs` counts only the phases `starting` and `turn`. The runner sets `tool.capMs` with core's `capForCommand(spec.toolCaps, command)`: a command matches a task check when its whitespace-normalised text contains the check's whitespace-normalised `cmd`, and gets that check's cap; one whose segments start with a `longPatterns` entry (build and test commands, kept in `packages/core/src/stall.ts`) gets the long cap. The hub's rule uses the reported `capMs`. `fsAgeMs`, `commitAgeMs` and `turns` appear on the attempt page; no rule uses them.

**Vendor errors.** A turn that fails with a vendor, network or API error is not a stall:
- the attempt's phase becomes `vendor_error`;
- the runner retries with backoff, from 30 s doubling to 10 minutes;
- such turns count toward neither no-progress, loop nor the continuation budget.

After `vendorErrorReplaceMs` (60 minutes) of continuous vendor errors, the hub replaces the attempt (class `infra`) and marks the vendor `degraded` on that runner for `degradedMs` (one hour), so placement prefers the other vendor. Section 8.3 and section 9.2 say which errors are quota and which are vendor errors.

**Continuation.** It happens on the runner, without waiting for the hub. A worker gets a continuation prompt listing the task's acceptance ids when all of these hold:
- its turn completed normally;
- it has not completed `submit`, `declare_blocked`, `declare_impossible` or `release_task` successfully (a refused submit does not count; a pending one does);
- no `hold_attempt` or `stop_attempt` has arrived within 5 s of the turn's end.

Further rules:
- No continuation follows a failed or interrupted turn.
- None is sent while the link is down, or after a tool answered "hub unreachable". When the link returns, the runner sends one "the agflow hub is reachable again; retry the tool that failed" to each attempt whose turn ended because of the outage: a tool answered "hub unreachable", or the runner interrupted the turn in `needs_login` (section 7.1). That is the only nudge after an outage.
- Leads get no continuation.

**Replacement.** A stall decision, or a person's or the lead's stop or replace, runs:
1. The hub records `stop_requested` with its cause and sends `stop_attempt`, with the cause's `handoff` and `interruptFirst` flags from `STOP_CAUSES`.
2. The runner prepares the agent:
   - If a tool is in flight, or `interruptFirst` is set (the causes `stall_hung_tool`, `stall_silent` and `stall_loop`), it interrupts first and waits for the turn to end: Claude `interrupt({ cancelQueued: true })`, Codex `turn/interrupt`.
   - It then asks for a handoff note as its own turn and waits up to `handoffMs` (3 minutes) for `write_handoff`.
   - Causes without the `handoff` flag (quota, vendor errors, policy, auth, cancel, blocked, released) skip the handoff turn.
3. The runner stops the agent (section 7.4), harvests and pushes the final WIP, and uploads the transcript tail. Only then does it report `attempt.exited`, carrying `finalSha` and `finalWip`.
4. The hub ends the attempt, sets `wip_sha` and the work position from `finalWip`, moves the task, and assembles a handoff note if the attempt wrote none.

   If the final push failed (`pushError`, with `finalSha` set), dispatch waits `dispatchHoldMs` (2 minutes, `dispatch_hold_until`) for that runner's `attempt.late_work`, which then becomes the work position. After that:
   - a successor placed on the same runner gets `start = { ref: refs/agflow-local/<previous attempt>/head, sha: finalSha }`, which that vault holds (`tasks.work_ref` stays the last pushed ref);
   - a successor elsewhere starts from the last pushed position, and its handoff note names `finalSha` as unpushed work on that runner.
5. The scheduler starts the successor.

**Crashes.** An unrequested exit of a worker follows the same path from step 3. The runner first kills the agent's remaining tool processes and sweeps the clone (section 7.4), then harvests and pushes before reporting the exit, so uncommitted work survives and no orphan writes during the harvest.

**Assembled handoff note** (`packages/hub/src/handoff.ts`), at most 12,000 characters, author `system`. Only the hub's own framing is unquoted. Every agent-produced part is quoted under a header naming its source attempt and agent. It contains:
- the task id, title and objective;
- the previous attempt: agent, vendor and model, runner, duration, end reason;
- the agent's handoff notes and its last 5 progress notes;
- `git log --stat` of the WIP from its merge base with `main`, from `attempt.wip`;
- the last 5 messages about the task;
- the compaction summary;
- the transcript tail: the last 3 assistant turns, about 4,000 characters.

It closes with: "No handoff note was written; the next step is unknown. Read the transcript tail and the commits before continuing."

**Successor.** A successor's first prompt asks it to restate, in a few lines, the current state and its next step, before it works. The runner reports the first assistant text as `attempt.first_output`. The hub stores it quoted as a `restatement` note next to the handoff note.

### 6.9 Retry ladder (the M2 part of spec §9.5)

**Classes:**

| End reason | Class | Counted |
|---|---|---|
| `stalled`, `released` | agent | yes |
| `rejected` (no resume) | review | yes |
| `crashed`, `lost`, `failed_to_start`, a quota, vendor-error or context replacement, a runner's own stop | infra | no |
| `stopped` or `replaced` by a person or the lead, `blocked`, `taken_over`, `rotated`, `superseded`, `cancelled`, `accepted`, a refused start | none | no |

- **Counted attempts** are those with a counted class and `number > ladder_floor`.
- **When it runs.** The ladder runs in the transaction that ends a counted attempt or records a rejection.
- **Initiator.** The hub tells who started an ending from its own `stop_requested` (with its `StopCause`), its hold state, and `attempt.exited.cause` (`runner_stop` or `suspend`).

**Steps:**

| Situation | Step |
|---|---|
| A rejection, the author attempt `holding` and `resumable` on an online runner with a free slot and a ready vendor, `review_rounds < 2`, and no path overlap | **1:** `rejected` → `claimed` (assignee the author, `current_attempt` unchanged). `review_rounds` + 1, a new fence, and `resume_attempt` with the quoted feedback. |
| The first counted failure | **2:** the task goes `ready`; the next attempt must use the same vendor |
| The second counted failure | **3:** `ready`; the next attempt must use the other vendor, when a runner offers it |
| 3 counted attempts, and `ladder_floor` = 0 | **4:** the task becomes `blocked` (kind `replan`), via `rejected` → `blocked` or `ready` → `blocked`. The lead is told to split, clarify, amend or cancel it. Unblocking it, by the lead or a person, sets `ladder_floor` to the highest attempt number. |
| 3 counted attempts, and `ladder_floor` > 0 (a re-plan already happened) | **5:** the task becomes `failed` (from `ready`, `blocked` or `rejected`), and people are told |

**Infra endings** set `next_dispatch_at` with backoff from `infraBackoffMs` (1, 2, 5, 15 and 30 minutes); the backoff index is the number of consecutive infra endings of the task.
- `failure_signature` is the end reason plus the error, with digits, paths, shas and ids replaced by placeholders. `lost`, the runner's own stops and suspends, and refused starts get no signature.
- Two consecutive `failed_to_start` on one runner and vendor (refusals excluded) mark that vendor not ready in `vendor_holds`. The hub sends `preflight`, and the mark clears when a later preflight passes.
- After 3 infra endings with the same `failure_signature`, the task goes to step 4, the notice names the signature, and people are told as well.

### 6.10 Quota and approvals

**Quota belongs to the account.**
- The hub keeps quota per (owner, vendor, accountId) in `vendor_accounts`, shared by all of that owner's runners. An exhaustion reported by one runner applies to all of them until `resetsAt`.
- Each runner reports quota in `runner.vendors` and per attempt in `attempt.quota`. Times are epoch milliseconds and utilization is 0..1:
  - Codex: `max(primary, secondary).usedPercent / 100`;
  - Claude: `rate_limit_info.utilization`, or the largest `unifiedWindows.*.utilization`.
- **Ceilings.** The owner sets ceilings per runner, vendor and window: default 0.85 for both the 5-hour and the weekly window, in `runner.json` and editable on the Runners card (through `update_settings`). A placement compares the candidate runner's own ceilings with the shared account utilization. Above a ceiling, the vendor gets no new attempts there. Running attempts finish but get no successor there. The rest of the allowance stays for the owner's own work.
- **Paid usage.** A vendor counts as exhausted as soon as work would draw on paid usage:
  - Claude: overage in use, `rateLimitType: 'overage'`, or a usage-transition notice;
  - Codex: a window at 100% while credits are consumed.

  `allowPaidUsage` (default false per vendor) changes that, and only the owner can set it. Preflight reports whether extra usage is enabled (Claude: section 8.1; Codex: the credits in `account/rateLimits/read`).

  Paid usage stops running work too. Adapters only report quota facts; the runner's attempt controller applies `allowPaidUsage`, the same way for both vendors. While it is false, the runner treats paid usage in use as a limit hit. It interrupts the turn, sends no continuation, and reports `attempt.quota`; the attempt moves to `quota_wait` until `resetsAt`.
- **Unknown reset times.** When `resetsAt` is unknown, the vendor is retried after `AGFLOW_QUOTA_UNKNOWN_MINUTES` (30) with one cheap probe. For Codex, the hub sends `preflight { vendor: 'codex' }` to one online runner of that owner on that account; preflight calls `account/rateLimits/read`, and the `runner.vendors` answer lifts the exhaustion. For Claude, the probe is the next start.

**`quota_wait`.**
- A running attempt that hits a limit moves to `quota_wait`. Its stall timers and budget freeze; its runner lease keeps running and is renewed like any other.
- At the reset time, the runner resumes the turn and reports `attempt.quota` with state `ok`, which moves the attempt back to `running`. Fresh facts with phase `turn` do the same, in case that event is lost.
- If the reset is more than `quotaWaitMaxMs` (45 minutes) away, or unknown, the hub replaces the attempt (class `infra`, no handoff turn) — but only if a placement with quota exists right now. Otherwise the attempt stays in `quota_wait`, and with an unknown reset the runner retries its turn every `quotaUnknownMs`.

**Approvals.** Only Codex raises approval requests in M2. Claude agents run with `permissionPrompts: 'none'`, so anything that would prompt is denied at once and the turn continues.
- **The runner decides nothing.** Every request is relayed to the agent's owner, on every device.
- **Identity.**
  - The runner mints an approval id (UUID) for each vendor request and maps it, in memory, to (agent process instance, vendor request id).
  - `approval.requested` carries that id and the fence.
  - `decide_approval` carries the approval id and the fence. The runner answers `{ applied: false }` when the fence, the process or the request is no longer current.
- **Voiding.** Every pending approval of an attempt becomes `void` when its process exits (the runner emits `approval.voided` for each), and when the attempt is resumed, re-fenced or ended (the hub voids them in the same transaction). A stop request voids the approvals pending at that moment. Approvals raised later, during the handoff turn, are relayed as usual.
- **What the owner sees.** The Approvals view shows:
  - the full command, cwd and the vendor's reason;
  - a plain warning: "Approving runs this command outside the sandbox, with network access and write access to all your files";
  - for package-manager commands, the diff of `package.json`, lockfiles, `.npmrc`, `.yarnrc*` and `bunfig.toml` against the attempt's start commit.

  `approve` maps only to Codex's `accept`, never to session-wide or policy-amending answers. A file-change request with a non-null `grantRoot` shows that root with the warning "approving may let the agent write anywhere under this root for the rest of the session". Its default action, like expiry, is decline.
- **Expiry.** A request not answered within `AGFLOW_APPROVAL_MINUTES` (15) of the hub receiving it is declined. The agent sees the reason: "the owner did not answer; continue without it or declare_blocked". Time in `waiting_approval` counts toward neither budgets nor stall timers.
- **Owner away.** After a timeout, the owner's account for that vendor becomes `ownerAway` until the owner acts: any approval decision, or a change to one of their runners (`PATCH /api/runners/:id`). While it is set, the scheduler places no new attempts of that vendor on the owner's runners. The lead gets one notice when ready work cannot be placed because of it, not one per request.
- **Notifications.** The runner posts a macOS notification for each relayed request, with the summary and the Approvals address, `<hub>` followed by core's `APPROVALS_ROUTE` (`#/approvals`), in its text: a notification cannot open a link. The attempt controller relays the request and calls the runner's notifier; nothing is posted in test mode.
- **Who may answer.** Only the owner, in a browser session. Every decision is an event.

**Managed devices.** `managedPolicy` is detected at preflight (section 9.1) and shown on the Runners card. Because the runner never answers approvals, it changes no behaviour. It explains why so much needs the owner on such a device.

### 6.11 The lead on runners

**The seat** is one record: `hub_state.lead_agent_id`, `lead_kind` and `lead_since`. Everything that needs to know the lead uses it:
- the scheduler;
- `startLiveSession`;
- `leadOrHuman`;
- `unreadFor` for `lead`;
- the `to: "all"` check of `POST /api/messages`;
- `buildBrief`'s role;
- `HubStatus`.

M1's `currentLead()` is removed, and nothing reads `agents.role` for authority.

**Holding the seat.**
- **A runner lead** holds the seat while its attempt is `starting`, `running`, `quota_wait` or `holding`. Here `holding` means an idle process that exited; it is resumed on the next delivery.
  - A `holding` runner lead keeps the seat only while it can be resumed.
  - When its runner has been offline for `runnerLeaseMs`, when a delivery finds the runner offline, or when it becomes `resumable = false`, the attempt ends `lost` (infra). The seat empties and failover follows.
- **A live lead** holds the seat until it is unseen for `liveLeadGraceMs` (120 minutes). This replaces M1's 15-minute `LEAD_STALE_MS`, after which M1 let another chat take the seat.
- **A live chat asking for the seat while a runner lead holds it** registers as a worker, with `leadSeatTakenBy`. `startLiveSession` never demotes a runner lead, and refuses (409) a session id that belongs to a runner agent.
- **Starting a runner lead.** When the seat is empty and `project.runner_leads` is on, the scheduler starts a lead attempt. It prefers Claude, then runners on AC power, then the most free slots. In the same transaction it takes the seat and demotes any other `lead` row to worker.
- **Runner leads off.** People can turn runner leads off in the UI (`PATCH /api/project`). Turning them off rotates the runner lead out (with a lead handoff), so a person's live lead can take the seat.

**Lifecycle.**
- **Idle between wake-ups.** The lead's process stays alive and idle while its runner is online, and idle is not a stall.
- **Its clone.** A lead attempt gets a clone checked out detached at `main`. It has no task branch, pushes no WIP and is never harvested (section 7.3). To review a submission, it calls `fetch_submission({ task_id })`, waits for success, then runs `git fetch origin <branch>` and reviews `FETCH_HEAD` at the returned `head_sha`. Its `origin` is its runner's vault, so the explicit fetch first brings the submitted branch to that vault (section 6.13).
- **Process exits.** An unrequested exit moves the attempt to `holding` and resumes it: on the next delivery if it was idle, at once (with its unacknowledged deliveries) if it was in a turn. It was in a turn if its last reported phase was `turn`, or a message delivered to it is still unacknowledged. The third unrequested exit within `leadExitWindowMs` (an hour) ends it `crashed`, and the seat empties.
- **Liveness.** A runner lead's agent `last_seen_at` is renewed with its runner lease.

**Wake-ups are deliveries.** Everything that should wake the lead already produces a message to `lead`:
- goal changes;
- submissions;
- blocked and impossible reports;
- stale tasks and cancelled dependencies;
- people's and agents' messages.

M2 adds:
- a periodic review message every `leadReviewMs` (45 minutes) while any task is held or submitted, tracked in `hub_state.last_lead_review_at`;
- ladder step 4 notices;
- the owner-away notice.

Each delivery to the lead starts with the situation report (M1 `situationReport`). `attempts.wakeups` counts deliveries.

**Rotation.** After `leadRotateWakeups` (20) wake-ups, or when `contextUsed` passes 0.7, the hub asks the lead to write a lead handoff (`POST /api/lead/handoff`, stored in `lead_notes`). It then ends the attempt `rotated`, and starts a fresh lead, preferring the same runner. A new lead's brief includes the newest lead handoff, quoted.

**Failover.** When the lead's attempt ends `lost` or `crashed`, the seat is empty. The scheduler starts a lead on another runner, from the newest lead handoff of the ended attempt. If there is none, the hub assembles one from:
- the goal and the situation report;
- the last 20 messages to and from the lead;
- the lead messages sent since the newest lead handoff.

Messages that the ended lead received but never acknowledged become unread again (section 6.7).

### 6.12 Take-over and hand-back

**Take over** (a person, in the browser, `POST /api/tasks/:id/takeover`).
- **When it is allowed.** Only when the task's current attempt is `running` or `quota_wait` on an online runner, with no stop recorded. Otherwise the hub answers 409:
  - `submission_pending` while a submission is pending;
  - `runner_offline`;
  - `not_running`, also while a stop is recorded.

  It then offers "Stop and hold" instead: the task becomes `blocked` (kind `paused`) from its last WIP.
- **Recording.** In one transaction the hub records `stop_requested` (cause `takeover`), moves the task to `blocked` (kind `takeover`, "taken over by <login>"), and answers `202 { attemptId }`. The task counts as a path holder, and the lead cannot unblock it.
- **What the runner does** on `prepare_takeover`:
  1. interrupts the turn and asks for a handoff note;
  2. stops the agent, leaving a single writer of the transcript;
  3. harvests and pushes the WIP;
  4. restores agent-config and people-only paths in the clone;
  5. replaces `<clone>/.git` wholesale with a git directory the runner builds itself: a fresh `clone --shared` of the vault, with `HEAD` and the task branch at the harvested head and the index rebuilt.

     The agent's `.git` moves outside the clone, to `~/.agflow/runner/forensics/<attempt>/` (removed by `cleanup_attempt`), so neither the person's tools nor the hand-back harvest ever see it. If it held program-valued config, hooks, `commondir` or `gitdir` files, or extra alternates, the runner reports `attempt.violation` with phase `takeover`;
  6. reports `attempt.taken_over` with the commands.

  During a take-over the runner reports no `attempt.exited`. If the take-over fails after the agent stopped, the runner still reports `attempt.taken_over`, with `commands.local` null and the error.
- **Completion.** The attempt ends `taken_over` when `attempt.taken_over` arrives, or at lease expiry or the stop timeout. Without the event, the page shows only the "anywhere" command.
- **The commands shown** use the runner's pinned binaries of the attempt's own CLI version, because a resume must use the same CLI version that wrote the session. The runner core builds them (not the adapters):
  - on the runner's laptop: `cd <clone> && CLAUDE_CONFIG_DIR=<runner claude home> ~/.agflow/runner/vendor/claude/<version>/claude --resume <session>`, or `cd <clone> && CODEX_HOME=<runner codex home> ~/.agflow/runner/vendor/codex/<version>/bin/codex resume --no-daemon <thread>`;
  - anywhere: `git fetch origin <work ref> && git switch -c agflow/T-42-<slug> FETCH_HEAD`, and when done, `git push origin HEAD:<wipRefPrefix>T-42/takeover-<login>`. The hub keeps that take-over ref in `Attempt.takeover.ref`, so the page can offer it for a hand-back.

**Hand back** (the same person, or anyone if the runner is gone, which means not `online`; `POST /api/tasks/:id/handback { source }`).
- **Pending clone hand-back.** `Attempt.takeover.handingBack` records `{ by, at }`, with `by=user:<login>` and `at` in epoch milliseconds, while the hub waits for clone work. Another otherwise-authorized hand-back receives `409 handback_pending`, including one from a ref. Completion, refusal or timeout clears it.
- **Clone source** (`'clone'`, the runner's clone). The hub sends `hand_back` to the attempt's runner, which:
  - stops the runner-home Codex daemon (`CODEX_HOME=<runner codex home> <runner codex> app-server daemon stop`, errors ignored);
  - refuses if a process still runs in the clone: the command answers `{ ok: false, error: 'process_running' }`, naming the pids, and the runner logs an `attempt.activity` note. The hub keeps the task `blocked` (`takeover`), shows the error in `Attempt.takeover.error`, and stops the hand-back timer; the person may hand back again;
  - harvests the clone (the person's commits and uncommitted changes), and strips and checks it like a WIP;
  - pushes the result to a new late-work ref, reports `attempt.handed_back`, and then cleans the attempt up.

  The task stays `blocked` until `attempt.handed_back` arrives. Then the hub records the sha as the work position (not late work), moves the task to `ready`, and emits `task.handed_back`. If the runner has no link, or nothing arrives within `handbackTimeoutMs` (10 minutes), the task becomes `ready` from the last recorded position, and a later push is late work. A connected runner reporting `disk_low` or `crash_loop` still gets time to return the clone. This fallback without returned clone work emits `task.ready` with `{ from, attemptId, reason }`, not `task.handed_back`.
- **Ref source** (`{ ref, sha }`, for example the take-over ref; `sha` is a full 40-hex sha, because the next runner may fetch it by SHA). It needs no runner.
  - In the request transaction, the hub records `{ ref, sha }` as the work position (not late work), moves the task to `ready`, emits `task.handed_back`, queues `cleanup_attempt` for the taken-over attempt, and sends nothing else.
  - The next attempt's runner fetches the ref with its `<wipRefPrefix><task>/*` refspec, or by SHA. Before starting, it restores and strips it like a WIP, and reports `attempt.violation` for stripped paths.
- **Unblock.** Unblock on a `takeover` task answers 409, "hand it back instead".

### 6.13 Submissions from runner agents

Runner agents cannot push, so `submit` has two phases.

1. **Request.** The bridge calls `POST /api/tasks/:id/submit` with the agent token and the body `{ summary, evidence }` only; a `branch` or `headSha` from a runner agent is a 400.
   - The hub checks the holder (section 6.5). It refuses while `stop_requested` or a take-over is set.
   - It creates a `submissions` row `S-<n>` (`pending`) and sends `push_submission` with:
     - the task branch from `AttemptSpec.branch`;
     - `expectedBranchSha` = `tasks.branch_head`;
     - `adoptable`: the shas the hub knows as agflow work for this task (M1 submission heads, start shas, WIP and submitted shas).
   - It answers `202 { submission: SubmissionRecord }`.
   - A second submit while one is pending returns the pending submission.
2. **Push.** The runner pushes only to the task's own branch: it must equal `AttemptSpec.branch` and lie in the task's namespace, `agflow/<taskId>-…` (`isTaskBranch`). A `push_submission` naming another branch is refused and reported as `attempt.violation` (phase `submit`).
   - **Checks.** The runner harvests the clone. It refuses with `dirty` (uncommitted changes) or `protected_paths`.
   - **The push itself.** It pushes atomically the task branch, with `--force-with-lease=refs/heads/<branch>:<expected>`, and the attempt's WIP ref, both to the same commit.
   - **Stale lease.** The runner fetches the branch head into the vault, then:
     1. if the submitted commit contains the remote head, or the remote head is in `adoptable`, it retries once with that head as the expected value;
     2. if the remote head descends from a sha in `adoptable` (someone added commits on top of agflow work), it refuses with `needs_merge`, fixable by the agent: `git fetch origin && git merge origin/<branch>`. The vault carries that ref;
     3. otherwise it refuses with `branch_moved`. The hub then blocks the task (kind `branch_moved`) for people, with both shas shown, and stops the attempt (section 6.4).
   - **Remote failures** (network, 5xx, auth, timeout) are retried by the runner with backoff while the submission stays pending: until a stop or hold for the attempt arrives (outcome `interrupted`), or for `submitRetry` (15 minutes; outcome `remote`). Only the fixable refusals (`dirty`, `protected_paths`, `needs_merge`) go back to the agent to fix.
   - **Outcome.** It arrives as the outbox event `attempt.submitted`. The command result repeats it.
3. **Recording.** On success the hub, in one transaction:
   - records the submission (task `submitted`, `branch_head`, work position);
   - moves the attempt to `holding` and sends `hold_attempt`;
   - queues `refresh_vault { taskId, refs: ["refs/heads/<branch>"] }` on the seated runner lead as a best-effort speed-up, then tells the lead to call `fetch_submission`, fetch the branch from `origin` and review `FETCH_HEAD`. Seating a runner lead also queues an early refresh for waiting submissions.

   The early refresh holds no command or message: no delivery barrier or inbox reservation waits for its answer.

   The hub records the branch head from every outcome, even one that arrives after the attempt ended. A late success, for an attempt that is no longer current or has a newer submission, records only the head; the hub tells the lead and the task's current holder that the branch moved.
4. **The agent's answer.** The bridge polls `GET /api/submissions/:id` every `AGFLOW_BRIDGE_POLL_MS` (2 s) for up to `AGFLOW_BRIDGE_POLL_MAX_MS` (3 minutes). It returns "submitted at <sha>", or the refusal with what to fix. On timeout it answers: "submission pending; do not submit again; the result will arrive as a message".
   - The hub sends every failed outcome, and every outcome for a submission that already failed, to the agent as a message, because it cannot know whether the poll returned it. A repeat of what the tool answered is harmless.
   - `remote` and `interrupted` outcomes fail the submission the way the timeout does (below).

**Fetching for review.** `fetch_submission({ task_id })` is a lead-only bridge tool. The hub checks the caller holds the seat and the task has a submission with a branch and head (the waiting or latest submission). For a runner lead it enqueues `refresh_vault { taskId, refs: ["refs/heads/<branch>"] }` on that lead's runner. The command's successful result includes `data: { refs: { "refs/heads/<branch>": "<sha>" } }`, read from the vault after fetching. The hub verifies it matches the submitted head before the tool returns `{ branch, head_sha }`.

The bridge posts `{ task_id }` to `/api/fetch-submission` and polls `/api/fetch-submission/:id` with the same interval and budget as `submit` and `prepare_dependencies`. The request belongs to that lead attempt; an ended or re-fenced attempt cancels it, and a successor cannot poll it. An offline runner, a failed fetch (with its message), an unconfirmed head or a missing submission is an error. If the polling budget expires, the tool reports that the fetch is still running and must be called again before reviewing; another call reports that request without enqueuing a duplicate. A live-chat lead gets the branch and head immediately, with a note that its own git remote has the submission.

After success the lead runs `git fetch origin <branch>` and reviews `FETCH_HEAD` at `head_sha`, then calls `accept_task` or `reject_task`. Other commands and messages, including people's messages to the lead, proceed while the fetch is pending.

**Ordering.**
- **While a submission is pending:**
  - a take-over answers 409 `submission_pending` (section 6.12);
  - a person's or the lead's stop or replace is stored in `stop_requested` with `deferred: true` and answered 202. Its `stop_attempt` is sent only if the submission fails; if the submission succeeds, the deferred stop is dropped and the requester is told;
  - no stall decision is taken.
- **Timeout.** A submission still `pending` after `submitTimeoutMs` (15 minutes) becomes `failed` (error `remote`).
  - The hub cancels its `push_submission` and applies any stop it deferred.
  - It tells the agent its work is safe in its WIP ref, and that it may submit again or call `declare_blocked`.
- **Attempt ends.** When an attempt ends with a submission pending, the submission becomes `failed` ("attempt ended: <reason>") in the same transaction. If the lease expired, the push command is cancelled, and a late outcome's remote head is still recorded.
- **Exit.** After `attempt.exited`, a recorded submission leaves the task `submitted`.

**Hold.** On `hold_attempt` the runner sends no further continuation. It lets the current turn end (`hold`, at most 2 minutes), so the agent sees its submit's result, then stops the process. It keeps the session and the clone until `cleanup_attempt`.

### 6.14 Restarts, clock jumps, restores and backups

- **Downtime.** On start, and on any tick that sees a gap of more than 3 ticks since `last_alive_at` (a hub freeze or a forward clock jump):
  - every runner lease, and every M1 task lease of a live claim, is extended by the gap;
  - `recovery_until` is set to now + `recoveryMs` (`AGFLOW_RECOVERY_SECONDS`, 2 minutes), the time runners need to reconnect and replay.

  Until then the hub expires no leases, judges no stalls and dispatches nothing. Agents' bridge calls work as usual. A backward clock step never shortens a lease.
- **Restore.** `bun packages/hub/src/restore.ts <backup>` runs while the hub is stopped:
  1. It refuses if a hub holds the database (the hub keeps `<db>.pid` and a lock while it runs).
  2. It moves `agflow.db`, `agflow.db-wal` and `agflow.db-shm` aside, keeping them.
  3. It copies the backup in, then runs `integrity_check` and the migrations.
  4. It sets the epoch to max(backup epoch, the replaced database's epoch if readable, the epoch recorded in `<backup dir>/epoch`) + 1, and writes it back to that file.
  5. It advances the task, agent, runner, lead_attempt and submission counters by 1000, then runs `wal_checkpoint(TRUNCATE)`.

  The hub also closes the database cleanly on SIGTERM and SIGINT.
- **After a restore.**
  - Attempt ids, WIP refs and task branches embed the epoch from 2 on (`T-43-e2-a1`, `refs/agflow/T-43/e2-a1`, `agflow/T-43-e2-<slug>`), so nothing collides with what existed before.
  - Runners replay their retained events (section 6.3).
  - The hub detects a restore from `hello.lastHubEpoch` being lower than its epoch. It first applies the events the runner replays (so WIP pushed after the backup still updates work positions). Then every attempt that the runner reports, and that the restored hub knows and has not ended, gets a new fence through `resume_attempt` (class `infra`; section 6.3). If its task no longer names it, it ends `superseded`.
  - Attempts the hub does not know go to `welcome.stop`. Their late work becomes a note on the task if the task exists, and goes to people otherwise.
  - Recorded branch heads are treated as unknown; the first `push_submission` of each task adopts the remote head under section 6.13's rule.
- **Backups.** An `hourly` kind (kept 24 hours) joins `daily` (7) and `start` (3). The first hourly snapshot comes an hour after start, so a start still writes only `start` (and a missing `daily`). The daily backup is written once per UTC day by hourly housekeeping. `VACUUM INTO` runs outside the tick, and its duration is logged.

### 6.15 Guards

- **Churn budget.** `create_tasks`, `update_task` and `cancel_task` calls from agents count toward a churn budget: default 60 per sliding hour (`AGFLOW_MAX_PLAN_CHANGES_PER_HOUR`). Each call counts once, however many tasks it touches, and is recorded as a `guard.plan_change` event. The M1 creation limits stay. Hitting the budget sets `hub_state.dispatch_paused_until` to the time the oldest counted call leaves the hour, which pauses worker dispatch but not the lead seat, and tells people (a message and a `guard.dispatch_paused` event).
- **Attempt limit.** Reaching the attempt limit of one task triggers ladder step 4 for that task; it never pauses the project.

### 6.16 HTTP API additions

All request and response bodies have zod schemas in `packages/core/src/api-schemas.ts`, next to the runner protocol.

| Route | Who | Request → response |
|---|---|---|
| `GET /api/runner/ws` | CLI token | runner link (section 6.3) |
| `GET /api/runner/whoami` | CLI token | → `{ user }` |
| `POST /api/runner/attempts/:id/transcript` | CLI token of the runner's owner | `{ tail }` (≤ 64 KB) → `{ ok }` |
| `GET /api/runners` | signed in | → `{ runners: Runner[], accounts: AccountQuota[] }` |
| `PATCH /api/runners/:id` | owner, browser | `{ capacity?, keepAwake?, draining?, ceilings?, allowPaidUsage? }` → `{ runner }`; capacity is an integer 1..16, ceilings 0..1 (0: no new attempts of that vendor there); core's `RunnerPatchInputSchema` holds the bounds |
| `DELETE /api/runners/:id` | owner, browser | retire: its open attempts end `lost` (held tasks go `stale` → `ready`; `submitted` tasks keep their status); the card goes → `{ ok }` |
| `POST /api/runner/retire` | CLI token of the runner's owner | `{ runnerKey }` → `{ ok }`; the same, for `agflow runner uninstall` |
| `GET /api/attempts` | signed in | `?task=&role=&status=&runner=&limit=` (status takes a comma list; limit 200 by default, at most 1000) → `{ attempts: Attempt[] }`, newest first |
| `GET /api/attempts/:id` | signed in | → `{ attempt, log: AttemptLogEntry[] }` |
| `POST /api/agents/:id/stop` | person (browser), or the lead for runner workers | `{ reason, hold?: boolean }` → `{ attempt }`; 409 for live chats (use Release), and for `hold` on a lead |
| `POST /api/agents/:id/replace` | person (browser), or the lead for runner workers | `{ reason }` → `{ attempt }`; 409 for live chats |
| `POST /api/tasks/:id/takeover` | person (browser) | → `202 { attemptId }`; 409 `runner_offline`, `not_running` or `submission_pending` |
| `POST /api/tasks/:id/handback` | person (browser) | `{ source: 'clone' \| { ref, sha } }` (sha: 40 hex) → `202 { attemptId }` |
| `GET /api/approvals` | signed in | `?status=` (a comma list) → `{ approvals: Approval[] }`, the caller's own |
| `POST /api/approvals/:id` | owner, browser | `{ decision: 'approve' \| 'decline' }` → `{ approval }` |
| `POST /api/staffing` | seat holder or person | `{ count, vendor?, reason }` → `{ running, target }` |
| `POST /api/tasks/:id/submit` | agent token (runner agent) | `{ summary, evidence }` only (a `branch` or `headSha` is a 400) → `202 { submission }` (live chats keep M1's `200 { task }`) |
| `POST /api/agents/:id/interrupt` | person (browser) | → `{ ok }`; sends `interrupt` to a runner agent |
| `GET /api/submissions/:id` | the submitting agent, or people | → `{ submission: SubmissionRecord }` |
| `POST /api/prepare`, `GET /api/prepare/:id` | agent token | → `202 { request: PrepareRequest }` / `{ request: PrepareRequest }` |
| `POST /api/fetch-submission` | seated lead (runner agent token or live agent identity) | `{ task_id }` → `202 { request: FetchSubmissionRequest }` for a pending vault fetch; `200 { request }` for a live lead |
| `GET /api/fetch-submission/:id` | seated runner lead, requesting attempt only | → `{ request: FetchSubmissionRequest }` |
| `POST /api/lead/handoff` | seat holder | `{ note }` → `{ ok }` |
| `GET /api/lead/notes` | seat holder or people | → `{ notes: LeadNote[] }` |
| `PATCH /api/project` (new) | person (browser) | `{ runnerLeads: boolean }` → `Project` |
| `GET /api/status` | as before | adds `leadSeat` and `epoch`; `lead` stays, derived from the seat |
| `GET /api/tasks/:id` | as before | adds `attempts` and `submissions` |

### 6.17 Events

New event types, alongside the spec's §11.3. Core's `HUB_EVENT_TYPES` records each type's subject and data keys.
- **Subjects.** `attempt.*`, `submission.*`, `agent.*`, `approval.*` and `task.*` events of a task attempt use the task id; those of a lead attempt use the attempt id. `runner.*` use the runner id, `account.*` the owner, and `lead.*`, `guard.*` and `system.*` have none.
- **Data** always carries `attemptId`, `runnerId`, `agentId`, `taskId`, `approvalId` and `submissionId` where they apply. A page that follows one task attempt reads the task's events and filters on `data.attemptId` (core's `parseAttemptId` gives the task).

The types:
- **runners:** `runner.online`, `runner.offline`, `runner.updated`, `runner.retired`, `runner.event_rejected`;
- **accounts:** `account.quota_changed`, `account.owner_away`;
- **attempts:** `attempt.started`, `attempt.running`, `attempt.quota_wait`, `attempt.holding`, `attempt.resumed`, `attempt.ended`, `attempt.wip`, `attempt.violation`, `attempt.late_work`, `attempt.prepared`;
- **agents:** `agent.stalled`, `agent.stopped`, `agent.replaced`;
- **approvals:** `approval.requested`, `approval.decided`, `approval.expired`, `approval.voided`;
- **lead:** `lead.seat_changed`, `lead.rotated`;
- **submissions:** `submission.pending`, `submission.recorded`, `submission.failed`;
- **tasks:** `task.taken_over`, `task.handed_back`, `task.refs_deleted`;
- **guards:** `guard.plan_change`, `guard.dispatch_paused`;
- **hub:** `system.recovery_started`, `system.recovery_ended`, `system.restored`.

### 6.18 Hub retention

Each removal runs on a daily timer outside the tick:

| Data | Rule |
|---|---|
| done, failed or cancelled `runner_commands` | lose their payload after 7 days |
| revoked `agent_tokens` | deleted after 30 days |
| decided approvals | deleted after 90 days |
| `runner_event_rejects` | deleted after 30 days |
| `attempt_log` | at most 500 rows per attempt |
| remote refs | 7 days after a task is merged, cancelled or failed, an online runner of the task's last attempt (or any runner) gets `delete_refs` for the refs under `<wipRefPrefix><task>/` whose sha the hub recorded (WIP, late work, hand-back), with fenced deletes. A successful result records `task.refs_deleted`; until then the daily run retries. Refs with no recorded sha (a take-over ref never handed back) stay. |

## 7. Runner

### 7.1 Setup, service and lifecycle

**`agflow runner setup`** is interactive and runs once per laptop.

1. **Sign-in.** It checks `agflow login`.
2. **Configuration.** It writes `~/.agflow/runner/runner.json` (mode 0600, no secrets), containing:
   - a new `runnerKey`, the machine's `IOPlatformUUID` and the laptop name;
   - capacity 2;
   - `keepAwake: 'ac'`;
   - the profile, models, ceilings and `allowPaidUsage: false`;
   - timings (section 12);
   - the owner's login-shell `PATH` and connectivity variables: `HTTP(S)_PROXY`, `NO_PROXY`, `ALL_PROXY`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`/`DIR`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`;
   - the commit identity for agent commits (default: the owner's git `user.name` and `user.email`);
   - one canonical absolute path (a realpath without a trailing slash) per vendor home.
3. **Vendor binaries.** The runner installs its own pinned vendor binaries into `~/.agflow/runner/vendor/<vendor>/<version>/` and checks `--version`. The owner's own installs are never used or changed.
   - **Claude:** the `claude` file of `@anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.285`. Its sha256 must equal the SDK's `manifest.json` `platforms.darwin-arm64.checksum`.
   - **Codex:** there is no separate platform package. The runner downloads `@openai/codex@0.159.2-darwin-arm64` and copies its whole `vendor/aarch64-apple-darwin/` directory to `~/.agflow/runner/vendor/codex/0.159.2/`. The binary needs that layout: its bundled `rg` (`codex-path/`) and the code-mode host (`bin/codex-code-mode-host`).
   - **Pins.** `VENDOR_PINS` in `packages/runner/src/vendor/pins.ts` is the one place for each vendor's version, package and integrity: the tarball's sha512 and, for Claude, the binary's sha256 copied from the SDK's `manifest.json` (a test checks that they still match). `vendorBinary(vendor, version)` gives `vendor/claude/<version>/claude` and `vendor/codex/<version>/bin/codex`. M2 pins darwin-arm64; on other platforms preflight reports "unsupported platform".
   - `setup` and `install` install missing pins, which is also the upgrade path. `start` never downloads: a missing pinned binary makes preflight report "binary missing".
4. **Claude login.** Runs `CLAUDE_CONFIG_DIR=<path> <runner claude> auth login --claudeai` from an empty temporary directory, then requires `auth status --json` to show a subscription.
5. **Codex login.** Runs `CODEX_HOME=<path> HOME=<codex-user home> <runner codex> login` the same way.
6. **Service and checks.** Installs the service (below). Then, inside the running service, over `runner.sock`, it runs and prints every check:
   - hub `whoami`;
   - `git ls-remote origin`;
   - a fenced create-and-delete push of `<wipRefPrefix>_probe/<runner id>`;
   - both vendors' preflights (section 8.1, section 9.1). For Codex, this is the first point where the effect of `--disable apps` can be observed: `mcpServerStatus/list` must contain no `codex_apps`;
   - the dependency-preparation sandbox (section 7.7);
   - the Mac's sleep settings, with a warning when it sleeps within minutes of idle.

**Commands:**

| Command | What it does |
|---|---|
| `agflow runner start` | Runs in the foreground, logging to the terminal and to `logs/runner.log`. |
| `agflow runner install` | Writes `~/Library/LaunchAgents/dev.agflow.runner.plist` and bootstraps it. Refused in test mode. |
| `agflow runner status` | Asks the running runner over `runner.sock`. Without a socket it reports, labelled best effort: whether the plist is installed, `launchctl print-disabled` for the label, the last exit reason the runner wrote, and the last 20 log lines. `--json` prints the report as JSON, including each attempt's pid, pgid and `lstart` (tests use it to find agent processes). |
| `agflow runner drain` / `undrain` | Changes `runner.json` and tells the hub (`runner.settings`; section 6.3's settings sync). When the runner is not running, only `runner.json` changes, and the runner sends the edit after its next `welcome`. `undrain` also clears `crash_loop`. |
| `agflow runner restart` | The suspend path (below), then `launchctl kickstart -k`. |
| `agflow runner stop` | Drains and waits up to 60 s for the hub to acknowledge (with the link down it warns and goes on). Stops every agent with a handoff and a WIP push, reporting `attempt.exited` with `cause: 'runner_stop'`, so the hub ends them `stopped` (infra, no backoff) and dispatches elsewhere, and waits a bounded time for those events to be acknowledged. Then runs `launchctl bootout` and `launchctl disable`, so the runner stays stopped, even across a login, until `install` or `start`. |
| `agflow runner uninstall` | `stop` (when the runner is not running: kill its registered agent groups whose identity still matches), then logs out of both runner homes (`claude auth logout`, `codex logout`), then retires the runner on the hub (`POST /api/runner/retire`), then removes the plist. `--purge` also deletes `~/.agflow/runner`, `~/.agflow/vaults` and `~/.agflow/work`, after checking that no WIP is unpushed. |

**The LaunchAgent** runs in `gui/<uid>` with `LimitLoadToSessionType Aqua`, because the login keychain is unlocked there. It sets:
- absolute `ProgramArguments`: the compiled `agflow` binary, then `runner start --service`;
- `EnvironmentVariables`: the captured `PATH`, the connectivity variables, and `NODE_USE_SYSTEM_CA=1` (the runner, the bridge and the brief hook then trust the system keychain's CAs, as curl does);
- `KeepAlive { SuccessfulExit: false }`, `ExitTimeOut 60`, `ThrottleInterval 30`;
- `HardResourceLimits.NumberOfFiles 65536` (Bun raises its soft limit to the hard limit);
- `ProcessType Interactive`;
- `StandardOutPath` and `StandardErrorPath` under `logs/`.

Install runs `launchctl bootout` (errors ignored), then `enable`, then `bootstrap`. The runner rotates its own logs, because launchd does not. `runner status` warns when macOS has disabled the agent in Login Items.

**Lifecycle rules:**
- **One instance.** Before it touches `runner.db`, the runner takes an exclusive lock on `runner.lock` and binds `runner.sock`.
  - A second `runner start` in the foreground exits with "the runner is already running (pid N); use agflow runner status".
  - Under launchd (`--service`), it waits for the lock instead, so KeepAlive does not loop.
  - On a `machineId` mismatch with `runner.json` (a copied home folder), the runner refuses to start until `setup` creates a new key.
- **Refusals that need a person.** On 4403 (the key belongs elsewhere, or the runner was retired), 4426 (incompatible protocol) or a `machineId` mismatch, the runner records the reason as its last exit and exits 0 under launchd, so `KeepAlive` does not loop and `runner status` says why; in the foreground it exits 1.
- **SIGTERM means suspend** (and so does SIGINT in the foreground):
  - the runner stops taking commands;
  - it interrupts its agents and sends SIGTERM to their groups;
  - it harvests and pushes WIP without a handoff turn, oldest unpushed work first;
  - it emits `attempt.exited` with `cause: 'suspend'` for each agent after its final push;
  - it records the attempts as `suspended` and exits 0 within `suspend` (45 s).

  The hub keeps suspended attempts open (section 6.4). On the next `hello` it resumes them (section 6.3), or their lease expiry ends them `lost`. This covers launchd restarts, logout and upgrades.
- **`needs_login`.** When the hub refuses the CLI token, the runner keeps running in `needs_login` (the hub shows the same state, derived from the expired session; section 6.3):
  - it takes no new work;
  - it interrupts its agents and pushes their WIP, without a handoff turn, when section 7.3's `canPushWip` allows; otherwise the harvest waits in the vault for the next `welcome`;
  - it posts a macOS notification;
  - it re-reads `credentials.json` (parsed with core's `CredentialsSchema`, which the CLI uses too) and probes `whoami` every 60 s, and reconnects by itself after `agflow login`. The interrupted agents get the one reconnect message of section 6.8.

  `runner status` and the log say why.
- **Crash loops.** After 3 unclean exits within 10 minutes, the runner drains itself and reports `crash_loop` with the last error. It stays drained, and reports `crash_loop` on every `hello`, until `agflow runner undrain`, which forgets the earlier unclean exits and reports `runner.state` `ok`.

### 7.2 Layout

```
~/.agflow/                             AGFLOW_HOME (tests set their own)
  runner/                              runner state; agents read only their own Claude project directory (section 7.6)
    runner.json  runner.db  runner.lock  runner.sock  logs/
    homes/claude/                      CLAUDE_CONFIG_DIR for agents (login, transcripts, .claude.json, shell snapshots)
    homes/codex/                       CODEX_HOME for agents (login, threads, config.toml)
    homes/codex-user/                  empty HOME for the codex app-server process
    vendor/claude/<version>/  vendor/codex/<version>/
    git/local.gitconfig  git/excludes  prep/<project>/ (dependency caches and tmp)
    forensics/<attempt>/               an agent's .git moved aside at take-over
  vaults/<project>.git                 bare vault; agents may read it (their clones borrow its objects)
  vaults/<project>.quarantine/<attempt>/    transient
  vaults/<project>.base/<sha12>/       base checkouts of main (Claude's project config root)
  work/<project>/<attempt>/            attempt clones (agent cwd); each agent may read only its own
    .agflow/run/                       runner-owned, untracked, never committed:
      task.md  brief.md  gitconfig  bin/ (gh and glab shims)  home/ (Codex tool HOME)
      cache/ (per-attempt package caches)  tmp/ (Codex TMPDIR)
      config/ (AGFLOW_CONFIG_DIR for the bridge and the brief hook: no credentials, only hook.log)
/tmp/agf/<6-char id>/                  CLAUDE_CODE_TMPDIR for one Claude attempt (0700)
```

- `<project>` is a filesystem-safe id derived from the hub URL and the project name.
- The runner keeps no secrets on disk. Agent tokens live in the vendor processes and in memory; after a runner restart, the hub's resent command or resume carries a new one.
- The owner's CLI token stays where `agflow login` put it, and agents cannot read it (section 7.6).

### 7.3 Git

**Three git environments:**

| Environment | Used for | How |
|---|---|---|
| remote | `fetch`, `push` and `ls-remote` between the vault and `origin` | `git --git-dir=<vault>`, never with a work tree. It uses the owner's normal environment and global and system config: their credential helper and SSH config. It adds `-c core.hooksPath=/dev/null -c core.fsmonitor=false`, `GIT_TERMINAL_PROMPT=0`, `GIT_SSH_COMMAND='ssh -o BatchMode=yes'` (unless the owner configured `core.sshCommand`), and a 2-minute timeout. |
| local | everything else: clones, harvests, snapshots, detection and restore, always with the vault or a quarantine as the git directory | `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=~/.agflow/runner/git/local.gitconfig`, `--no-optional-locks`, and `-c core.excludesFile=~/.agflow/runner/git/excludes` (which lists `.agflow/run/` and `.claude/.cc-writes/`, the Claude CLI's own staging directory). As a second layer (the vault's own config is runner-written), `-c` pins for the program-valued keys: `core.hooksPath=/dev/null`, `core.fsmonitor=false`, `core.pager=cat`, `core.editor=false`, `core.sshCommand=false`, `core.askPass=`, `credential.helper=`, `diff.external=`, `sequence.editor=false`, `gpg.program=false`, `protocol.allow=never`, `protocol.file.allow=always`, `gc.auto=0`. Runner commands that take paths also pass `':(exclude,top).agflow/run'`. |
| agent | the agent's own git | `GIT_CONFIG_GLOBAL=<clone>/.agflow/run/gitconfig` (identity, `credential.helper=`, `protocol.allow=never`, `protocol.file.allow=always`), `GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=/usr/bin/false`, `GIT_SSH_COMMAND=<refusal script>`, `GIT_SSH_VARIANT=ssh`. `GH_CONFIG_DIR` and `GLAB_CONFIG_DIR` point to empty directories, and `GH_TOKEN` and `GITLAB_TOKEN` are set to a dummy. `SSH_AUTH_SOCK`, `SSH_ASKPASS`, `GIT_CONFIG_PARAMETERS` and `GIT_CONFIG_COUNT` are removed. |

Rule: exclusions and pins for runner-side commands live in the vault or the local environment, never in the clone.

**Vault.** One bare repository per project, created by the runner.
- **Fetching.** Before each attempt starts, before each WIP push, and on `refresh_vault`, the runner fetches with the remote environment:
  - `+refs/heads/<main>:refs/heads/<main>`;
  - `+<wipRefPrefix><task>/*:<wipRefPrefix><task>/*`, with `wipRefPrefix` from `welcome`;
  - `+refs/heads/agflow/<task>-*:refs/heads/agflow/<task>-*`.

  If `start.sha` is still missing, it then fetches it by SHA (`git fetch origin <sha>`).
- **Pins.** Every clone pins the objects it borrows through `refs/agflow-local/<attempt>/start` and `refs/agflow-local/<attempt>/head`. Only `cleanup_attempt` deletes them.
- **Garbage collection.** `gc.auto=0`. While any clone exists, the runner consolidates daily with `git repack -a -d --keep-unreachable` and never prunes. It prunes only when no clone exists.

**Attempt clone.** `git clone --shared --no-checkout <vault> <clone>`, run with the local environment into a new directory. The clone borrows the vault's objects read-only. Its `origin` is the vault path, so `git fetch origin main` works for the agent and never leaves the laptop. The runner then:
1. checks out the task branch at the start commit;
2. writes `.agflow/run/`;
3. restores protected paths;
4. runs dependency preparation (section 7.7);
5. hands the clone over.

From then on, the clone, including its `.git`, belongs to the agent and is untrusted.

Lead attempts get a clone checked out detached at `main`, with no task branch, no WIP pushes and no harvest. `resume_attempt` for a lead first fast-forwards it to the vault's `main` when its worktree is clean.

**Harvest** (for WIP, submit, stop, take-over and hand-back). The runner never runs git with the clone's `.git` as its git directory.
1. **Read refs as files.** It reads `<clone>/.git/HEAD` and the task branch (`refs/heads/<branch>`, or its line in `packed-refs`) as plain files, accepting only 40-hex values. If `HEAD` names another branch, that tip is harvested too and reported as a warning.
2. **Copy objects to a quarantine.** It copies the clone's own objects into a runner-owned quarantine repository (bare, borrowing the vault's objects, configured by the runner). Only regular files named like loose objects (`xx/<38 hex>`) or packs (`pack/pack-<hex>.{pack,idx}`) are copied: no symlinks, and at most 200 MB.
3. **Fetch from the quarantine.** `git --git-dir=<vault> fetch --no-tags <quarantine> <sha>:refs/agflow-local/<attempt>/head`, with the local environment and `transfer.fsckObjects=true`. `index-pack` recomputes every hash and the fetch checks connectivity. A malformed object, or one whose content does not match its name, fails the harvest instead of entering the vault. The quarantine is deleted afterwards.
4. **Snapshot uncommitted changes,** still without git inside the clone: `GIT_INDEX_FILE=<runner temp> git --git-dir=<vault> --work-tree=<clone> read-tree <head>`, then `add -A` (`.agflow/run/` is excluded), `write-tree` and `commit-tree -p <head> -m "agflow: uncommitted work at <time>"`.
   - The configuration comes from the vault and the local environment, so no filter driver, `fsmonitor` or hook runs. `.gitattributes` in the clone can only name drivers that are not defined.
   - Symlinks are stored, not followed.
   - Files over 10 MB are skipped and listed.
   - **Embedded repositories** never become gitlinks. For each directory holding its own `.git` (other than `.agflow/run`), the runner captures its working files as ordinary files, without touching the clone: it uses a second temporary index with `--work-tree=<nested dir>`, honouring its ignore rules, grafted in with `read-tree --prefix`. `attempt.wip` lists these directories.
5. **Strip and detect** in the vault (below), then push.

A plan test plants every program-valued key in the clone's config: directly, through `include.path`, and in `config.worktree` with `extensions.worktreeConfig`. It also plants hooks and a `.gitattributes` filter. It then asserts that no runner operation runs any of them: harvest, snapshot, detection, restore, WIP, submit and take-over.

**Names.** `<attempt>` in paths and under `refs/agflow-local/` is the attempt id (`T-42-a3`). Under `<wipRefPrefix><task>/` it is the per-task suffix:
- WIP: `refs/agflow/T-42/a3` (`e2-a3` from epoch 2);
- late work: `refs/agflow/T-42/a3-late-<n>`, with n from 1;
- take-over: `refs/agflow/T-42/takeover-<login>`.

Lead attempts have no WIP refs.

**Pushes** run in the vault with the remote environment, always `--atomic --porcelain --no-verify` with `--force-with-lease=<ref>:<exact sha the hub gave>`. Never a bare `--force-with-lease`, never `--force`, never a `+` refspec. A repeated successful push reports `=` and counts as success.
- **WIP.** Every 10 minutes while the clone changed, and before any stop: the attempt's WIP ref, leased on the attempt's previous WIP sha (empty to create it). A WIP ref is never pushed once the runner knows the attempt is fenced or ended. That includes once the runner has emitted the attempt's `attempt.exited`: from then on a retried final push goes to a late-work ref.
- **`canPushWip`.** One predicate in the runner decides every push to a WIP ref. It holds when all of these do:
  - the runner has had a `welcome` since its last clock gap (so after a sleep or freeze, nothing is pushed until `welcome` confirms the attempt is not in `stop`);
  - the attempt is not known to be fenced, ended or exited;
  - the last `heartbeat_ack` (or `welcome`) arrived less than `welcome.timings.wipGraceMs` ago: `runnerLeaseMs / 3`, 5 minutes by default, well inside the runner lease and the stop timeout, so the hub cannot have ended the attempt meanwhile.

  So pushes go on through a short link outage, such as a hub restart. When the predicate fails, the harvest waits in the vault (`refs/agflow-local/<attempt>/head`) and is pushed after the next `welcome`. A final push it forbids goes to a late-work ref instead, and `attempt.exited` carries `pushError`. Pushes to late-work refs are never gated: they create new refs.
- **Submit.** The task branch and the WIP ref together (section 6.13).
- **Late work.** Once an attempt has ended, its WIP ref is never rewritten. Late work and hand-backs go to new refs, `<wipRefPrefix><task>/<attempt>-late-<n>`, created with an empty lease. The hub records late work under section 6.4's rule, and a hand-back as the work position (section 6.12). A late-work message to the current holder names the ref to merge: `git fetch origin <ref> && git merge FETCH_HEAD`. The hub sends `refresh_vault` to the holder's runner first, so the vault has the ref.
- **Starting point.** A successor starts from the tip of the fetched work-position ref and reports the commit it actually used (`attempt.spawned.startSha`). A tip that differs from the recorded sha is pre-fence work the hub had not heard of. The hub logs it and does not fail the attempt.

**Protected paths.** They are classified in code from `-z` output, case-insensitively, and never with git pathspecs.

| Class | Paths | Rule |
|---|---|---|
| agent config | `.claude/**`, `.codex/**`, `.mcp.json`, `.agents/**`, `.agflow/**` (except the untracked `.agflow/run/`), `.husky/**`, `.pre-commit-config.yaml`, `lefthook.yml`, `.envrc`, `.devcontainer/**`, `.vscode/**`, `.idea/**`, `.npmrc`, `.yarnrc*`, `bunfig.toml`, `.tool-versions` | Never changed by runner agents. Restored before every start, resume, dependency preparation and take-over. Stripped from WIP; a submit is refused. A task whose owned paths include any of them is never dispatched to a runner: people or live chats do it. |
| people only | `.github/workflows/**`, `.gitlab-ci.yml`, `.gitlab/**`, `.env*`, `*.pem`, `*.key`, `.gitmodules`, `.gitattributes` | The same, except in tasks a person created whose owned paths include them. |
| curators only | `AGENTS.md` and `CLAUDE.md` at any depth | The same, except in tasks of kind `curation`. |

- **The restore set** is resolved by the hub for each attempt (`AttemptSpec.restore`): protected-class patterns with the task's exemptions applied, matched only with core's `matchesProtectedPattern`. The hub has no git, so `restore.base` names a ref, `refs/heads/<main>`. The runner's `resolveRestoreBase(vault, spec)` resolves it in the vault after the pre-start fetch and returns `merge-base(that commit, the attempt's start commit)`, which is what the branch should contain. Restore, detection, stripping and the dependency-preparation config all use that one base. When `main` has newer versions of these files, a refusal tells the agent to merge `main` rather than revert.
- **At a start or resume**, protected changes between the base and the start commit (a hand-back ref, say) are restored in the clone, stripped from what is pushed, and reported as `attempt.violation` with phase `start`.
- **Detection** uses `diff --raw -z -M <base>..<head>`, which also catches symlinks, mode changes and renames out of a protected directory, plus the snapshot's tree.
- **Restore.** Checks out the restore set from the base into the clone, with the local environment and `--work-tree`, and removes files that the branch added inside protected directories. The Claude CLI's untracked staging directory `.claude/.cc-writes/` is never a violation; the runner deletes it before each start.
- **Strip.** Builds a new tree with a temporary index (`read-tree`, `update-index --cacheinfo` or `--force-remove`, `write-tree`, `commit-tree`), with no checkout and no hooks, and reports `attempt.violation`.

**Base checkouts** serve as Claude's project configuration root. Each is `git --git-dir=<vault> worktree add --detach <vaults>/<project>.base/<sha12> <main sha>`, created on demand with the local environment and removed when no running attempt uses it. Agents never write there.

### 7.4 Processes

- **Spawning.**
  - Codex: `Bun.spawn` with `detached: true`.
  - Claude: the SDK's `spawnClaudeCodeProcess` hook, implemented with `node:child_process.spawn` (`detached: true`, stdio `['pipe', 'pipe', 'pipe']`), because the SDK needs a Node `ChildProcess`. The SDK alone reads stdout. The runner drains stderr through a bounded writer into the attempt's log, and records the process before returning it.

  Either way each agent leads its own session and process group. The environment is built from an allowlist (section 7.6). Both pipes are always drained, because Bun buffers unread pipes without limit.
- **Registry.** `{ attemptId, pid, pgid, lstart, clone }` per agent, written to `runner.db` before the agent's first output is read.
- **Descendant snapshots.** One `ps -axo pid,ppid,pgid,lstart,command` call (about 17 ms) runs every 5 s while a tool is in flight, and on every tool start. It keeps the attempt's descendants and their groups, so orphans reparented to launchd can still be found.
- **Stop ladder,** recording `stoppedBy` (`interrupt`, `close`, `sigterm`, `sigkill` or `none`):
  1. The protocol interrupt, waiting up to 5 s: Claude `interrupt({ cancelQueued: true })`, so no queued message or continuation starts a turn; Codex `turn/interrupt`.
  2. The vendor's own close. Claude: close the query (stdin EOF), wait 2 s, then SIGTERM to the group. Codex: stdin EOF, which ends app-server and its commands. Never SIGINT first: it ends Codex but leaves its command running.
  3. Wait up to 5 s, then SIGKILL every recorded group.
  4. Sweep for processes whose cwd is inside the clone: `lsof -a -d cwd -u <uid> -Fpn`, whose `p`, `f` and `n` records carry resolved paths, filtered by prefix against `realpath(clone)`.

  Before any group kill, the runner checks that the group leader's pid and `lstart` still match, because macOS PIDs wrap at 99,999.
- **Exit.** The runner uses `await proc.exited` with `exitCode` and `signalCode`. A SIGTERMed claude exits 143, not by signal, and exit code 0 does not mean a clean finish, so `stoppedBy` decides whether an exit was requested. Waiting for the agent's pipes to close is always bounded, because an escaped process that inherited them must not block a stop.
- **Unrequested exits.** When an agent exits without a request (a worker or a lead), the runner first runs ladder steps 3 and 4: SIGKILL every recorded group that passes the identity check, then the clone sweep. Only then does the final work start, so an orphaned tool cannot write during or after the harvest.
- **Final work before `attempt.exited`.** For every exit, requested or not, the runner first finishes the final harvest, strip and push, with retries for up to `finalPush` (60 s). Only then does it emit `attempt.exited`, with `finalSha` and `finalWip`, or `pushError`. After `prepare_takeover`, `attempt.taken_over` takes its place (section 6.12). After reporting a `pushError`, the runner keeps retrying that push with backoff to a late-work ref, and reports `attempt.late_work` when it lands.
- **CLI version.** The runner records the CLI version each attempt started with. Every resume of the attempt runs that version's binary (`AgentLaunch.cliVersion`), and so do its take-over commands; new attempts use the current pin.
- **Durable late work.** When a final push fails or `canPushWip` refuses it, the runner records `AttemptRecord.lateWorkSha` before reporting `attempt.exited`, even when a known-ended attempt reports `pushError: null`. It retries to a late-work ref with backoff until the push lands and `attempt.late_work` is reported. After a restart, retries resume at the first `welcome`. A cleanup pushes pending late work first, even with the clone gone. If either that push or the push of newer clone work fails, the clone is kept, the work stays pending and retries continue. A hand-back's push settles pending late work because the person's work includes the agent's.
- **Resume failures.**
  - A session or thread that never ran a turn cannot be resumed ("No conversation found", "no rollout found"). The adapter then starts a fresh session in the same clone with the attempt's brief and first prompt, and reports the new `sessionRef`.
  - Any other resume failure is harvested and pushed, then reported as `attempt.failed_to_start` (infra).
- **Runner start.** Before saying `hello`:
  1. kill registered groups whose leader identity still matches;
  2. sweep their clones;
  3. report the attempts as `stopped`, or `suspended` after a SIGTERM, in `hello.attempts`.

  The hub reconciles (section 6.3). A `start_attempt` for an attempt whose clone already exists first harvests and pushes that clone's work, then continues in it.

### 7.5 Stall facts

- **File changes.** One recursive `fs.watch` per clone (about 2 file descriptors and 10 ms of latency). `.agflow/run/` is ignored.
- **Commits.** One watch on `<clone>/.git/logs/HEAD`, which the tree watcher misses.
- **Existence.** A periodic check that the clone still exists, because a deleted directory silences the watcher.
- **Tools.** Tracked from adapter events. CPU use and new descendants are reported, but they never extend a tool's hard cap.
- **Diff fingerprint.** Computed after each completed turn, for "turns without progress": vault `--work-tree` status against `HEAD`, about 70 ms at 20,000 files.
- **Ages and `activeMs`** use a clock that excludes the sleep and freeze gaps the 1 s tick measured.
- **The agent's own git is never disturbed.** Every runner command that touches a clone runs through the vault with `--no-optional-locks`.

### 7.6 Agent environment and profile

```ts
export interface PermissionProfile {
  name: 'standard' | 'auto';      // Claude: acceptEdits + sandbox, or auto mode + sandbox
  network: { allowedDomains: string[] };   // Claude sandbox
  webTools: boolean;              // WebFetch/WebSearch (Claude), web search (Codex); default false
}
```

**Default profile** (`standard`).
- **Allowed domains:**
  - `registry.npmjs.org`, `registry.yarnpkg.com`, `bun.sh`;
  - `pypi.org`, `files.pythonhosted.org`;
  - `proxy.golang.org`, `sum.golang.org`;
  - `crates.io`, `static.crates.io`, `index.crates.io`.

  The `auto` profile is opt-in per runner, used only when the account offers auto mode, which is checked from `system/init.permissionMode`. Otherwise the runner falls back to `standard`, and `hello.profile.name` reports `standard`.

**Denied reads.**
- **Claude's sandbox `filesystem.denyRead`** (Bash commands):
  - `~/.ssh`, `~/.netrc`, `~/.git-credentials`, `~/.config/gh`, `~/.config/glab-cli`, `~/.config/agflow`;
  - `~/.agflow/runner`, all of it, with `allowRead` for `<CLAUDE_CONFIG_DIR>/projects/<slug of the clone>/`, because Claude Code saves oversized tool output there and tells the model to read it;
  - `~/.agflow/work/*/*`, with `allowRead` for the attempt's own clone; the work root and project parents stay readable for package-script resolution;
  - `~/.claude`, `~/.claude.json`, `~/.codex`;
  - `~/Library/Keychains`;
  - `~/.aws`, `~/.config/gcloud`, `~/.kube`, `~/.docker/config.json`.
- **`Read(//path)` deny rules** (the Read, Glob and Grep tools). A Read deny rule also blocks Edit and Write on the file, and permission rules have no `allowRead` carve-out. So these rules get the same list, except for two things:
  - `~/.agflow/work` is not named;
  - for `~/.agflow/runner`, only the sensitive parts are named: `runner.*`, `logs/**`, `git/**`, `prep/**`, `forensics/**`, `homes/codex/**`, `homes/codex-user/**`, `homes/claude/.claude.json`, `homes/claude/backups/**`, `homes/claude/shell-snapshots/**`.

**Denied writes.**
- **`Edit(//path)` deny rules**, in both profiles. They cover `Edit`, `Write` and `NotebookEdit`; 2.1.285 never matches path patterns in `Write(…)` rules. Claude Code also copies them into the sandbox's `denyWrite`, so none may cover the clone or its temporary directory. They cover:
  - `~/.agflow/runner/**` and `~/.agflow/vaults/**` (the vault, quarantines and base checkouts);
  - `~/.claude/**`, `~/.claude.json`, `~/.codex/**`, `~/.config/agflow/**`;
  - `~/Library/LaunchAgents/**`;
  - `~/.zshrc`, `~/.zprofile`, `~/.zshenv`, `~/.bashrc`, `~/.bash_profile`, `~/.profile`, `~/.gitconfig`.
- **Sandbox `denyWrite`:** `/tmp/claude`, `/private/tmp/claude` and `~/.npm/_logs`. The sandbox runtime otherwise always lets commands write them.

**Other attempts' clones and transcripts.** No permission rule ever names `~/.agflow/work`. Deny rules cannot be re-allowed, and `Edit` deny rules also become sandbox `denyWrite` paths, so such a rule would deny every Read, Edit and Write, and every sandboxed write, in the attempt's own clone. Instead:
- `~/.agflow/work/*/*` goes only into the sandbox's `denyRead`, with `allowRead: [clone]`; the work root and project parents stay readable for package-script resolution;
- sandboxed writes are already limited to the clone and the temporary directory;
- the guard (section 8.2) refuses:
  - any `Read`, `Glob`, `Grep`, `Edit`, `Write` or `NotebookEdit` whose real path, or search root, is under `~/.agflow/work` but outside the clone;
  - any `Read`, `Glob` or `Grep` under `<CLAUDE_CONFIG_DIR>/projects/` outside the attempt's own project directory;
  - any `Edit`, `Write` or `NotebookEdit` outside the clone and its temporary directory.

**Bash screening.** Claude's command screening can refuse shell shapes before the sandbox runs them. Keep the production permission rules; for a complex legitimate operation, write a script inside the clone with Edit or Write and run it. The script still runs under the sandbox, including sibling-clone read denials. `CLAUDE_BASH_NOTE` explains this fallback and the refused computed Git subcommands.

**Agent environment.** It is built from an allowlist, never by removing variables from the runner's own environment.
- **User and system:** `USER`, `LOGNAME`, `LANG`, `LC_*`, `TERM=dumb`, `SHELL`, and `NODE_USE_SYSTEM_CA=1`.
- **Claude shell:** the adapter sets `ZDOTDIR=<claudeHome>/agflow-empty` (an empty runner-owned directory), drops any incoming `CLAUDE_CODE_SHELL`, and sets `CLAUDE_CODE_SHELL=/bin/zsh` unless the basename of `SHELL` is already `zsh`. Only the snapshot sources `~/.zshrc` outside the sandbox, once per Claude process; `~/.zshenv`, `~/.zprofile`, `~/.zlogin` and `~/.bashrc` do not run around agent commands. The snapshot remains an accepted residual risk (section 5).
- **Connectivity:** the variables captured at setup.
- **Home and temporary directories:**
  - Claude: the owner's `HOME`, because the CLI process needs it for its login. `CLAUDE_CODE_TMPDIR=/tmp/agf/<id>`, a short private directory (mode 0700, removed at cleanup), also in the sandbox's `allowWrite`. The CLI creates `claude-<uid>/` (the commands' `TMPDIR`) and `cc-socks/` inside it. The runner refuses a temporary path whose `<dir>/claude-<uid>` exceeds 44 bytes, because beyond that the CLI silently falls back to the shared `/tmp/claude-<uid>`.
  - Codex: the app-server process gets `HOME=~/.agflow/runner/homes/codex-user`, so the owner's `~/.agents/skills` do not load. Tool commands get `HOME=<clone>/.agflow/run/home` and `TMPDIR=<clone>/.agflow/run/tmp` through `shell_environment_policy`.
- **Package caches,** per attempt inside the clone: `BUN_INSTALL_CACHE_DIR`, `npm_config_cache`, `PIP_CACHE_DIR`, `UV_CACHE_DIR`, `GOMODCACHE`, `CARGO_HOME` under `<clone>/.agflow/run/cache/`.
- **`PATH`:** `<clone>/.agflow/run/bin`, where `gh` and `glab` shims refuse, followed by the captured `PATH`.
- **Vendor homes:** `CLAUDE_CONFIG_DIR` or `CODEX_HOME`, the runner's own canonical paths. Then `DISABLE_AUTOUPDATER=1`, and for Claude also `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`.
- **Git:** the agent git variables (section 7.3).
- **Bridge:** `AGFLOW_AGENT_TOKEN`, `AGFLOW_HUB_URL`, `AGFLOW_ATTEMPT_ID`, `AGFLOW_ROLE`, `AGFLOW_CLONE`, `AGFLOW_BRIDGE_POLL_MS` and `AGFLOW_BRIDGE_POLL_MAX_MS`. Also `AGFLOW_CONFIG_DIR`, `<clone>/.agflow/run/config/`, an empty per-attempt directory, so the bridge never reads the owner's CLI credentials. The bridge's own environment (`AgentLaunch.bridge.env`) holds these plus `NODE_USE_SYSTEM_CA` and the connectivity variables; Codex forwards every one of its names (section 9.2).

Left out: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CLAUDE_CODE_*` and `CODEX_*` from the runner's own environment, and everything else. Test mode adds its own variables after the allowlist (section 15.1).

### 7.7 Dependency preparation

Agents need dependencies, but Codex agents have no network, and Claude's sandbox blocks the shared caches and temporary directories that package managers write to. So the runner prepares dependencies itself.

- **What to run** comes from the people-only project config, `.agflow/config.json` in the repository:

  ```json
  { "dependencies": [ { "run": ["bun", "install", "--frozen-lockfile", "--ignore-scripts"],
                        "when": ["package.json", "bun.lock"] } ] }
  ```

  Without the file, nothing is prepared. The runner reads it from the vault at the restore base (section 7.3), never from the clone's working tree. An entry whose command runs lifecycle scripts says so with `"scripts": true`.
- **When:**
  - before a worker attempt starts or resumes, when a `when` file changed since the last preparation (leads get none);
  - when an agent calls the bridge tool `prepare_dependencies`, which goes through the hub as `prepare_dependencies` and is polled like a submit.
- **How:** inside an OS sandbox, which `agflow runner setup` checks: Anthropic's sandbox runtime (`@anthropic-ai/sandbox-runtime`, pinned to 0.0.81; the library behind Claude Code's sandbox, verified to run `bun install` here with write and domain allowlists).
  - The runner calls `SandboxManager.initialize` once and `wrapWithSandboxArgv` per command, and always spawns asynchronously: the runtime's proxies run on the runner's event loop, so `spawnSync` deadlocks.
  - Each preparation gets a private `TMPDIR` under `~/.agflow/runner/prep/<project>/tmp`, set in the returned environment, and `denyWrite` lists `/tmp/claude`, `/private/tmp/claude` and `~/.npm/_logs`.
  - Writes are allowed only into the clone and a runner-owned cache (`~/.agflow/runner/prep/<project>/`).
  - Network goes only to the profile's registries.
  - Reads of the credential paths are denied.
  - Preparation runs with the agent environment of section 7.6: the allowlist and the agent git environment, with no SSH agent. It never uses the runner's own environment, or the local or remote git environment. Its `HOME` is `<clone>/.agflow/run/home` for both vendors, so the owner's `~/.npmrc` never steers it; private registries are out of M2.
  - Lifecycle scripts are off by default (`npm_config_ignore_scripts=true`), and run later inside the agent's own sandbox. An entry with `"scripts": true` runs with a per-attempt cache under the clone, never the shared cache, because the scripts come from manifests the agent can edit. Go and Cargo always use the per-attempt caches, because agents read them at build time.
  - Packages are materialised into the clone by copy or clonefile, never by hard links. Agents never get write access to the shared cache.
- **Reporting.** The runner reports `attempt.prepared`; a failure is class `infra`. Agent-config paths are restored before every preparation, so the agent's edits to `.npmrc` or `bunfig.toml` never steer it.
  - For an agent's request, `requestId` is the `prepare_dependencies` command id, which the hub also returns as the request's id (`PrepareRequest`, kept with the command).
  - A preparation before a start or resume reports `requestId` null. If it fails, the runner then reports `attempt.failed_to_start` (infra), so repeated failures reach people through the failure-signature rule.
  - Each preparation times out after `prep` (15 minutes).
- **If the sandbox runtime does not work on a laptop,** `ProfileSummary.dependencyPrep` is false. Claude agents then install inside their own sandbox, with their per-attempt caches, and Codex agents need owner-approved escalations.

### 7.8 Retention and disk

| What | Rule |
|---|---|
| Clones | Deleted explicitly on every end path, after the final WIP push is confirmed. `holding` and taken-over attempts keep their clones until `cleanup_attempt` or hand-back. Clones whose push keeps failing are kept and listed in `runner status`. |
| Quarantines | Deleted after each harvest. |
| The vault | Pins and garbage collection as in section 7.3. |
| Transcripts | `cleanup_attempt` uploads the transcript tail, then deletes the attempt's Claude transcript directory or its Codex thread (`thread/delete`). Transcripts of ended attempts go after 14 days. `cleanupPeriodDays` is 30. |
| The journal, the outbox and attempt logs | Older than 14 days (48 hours for acknowledged events) are removed. |
| Vendor binaries | An old binary is kept until no attempt that started with it remains, because a resume must use the same CLI. |

**Disk guard.** Heartbeats carry free space and agflow's own usage.
- Below `minFreeGb` (default 10), the runner takes no new attempts (`acceptingUntil`) and reports `disk_low`.
- Below half of that, it stops its agents as a runner's own stop (`cause: 'runner_stop'`), once per crossing, with WIP pushes and without a handoff turn, so their tasks move to other runners.

### 7.9 Power and keep-awake

- **Modes.** `keepAwake` is `off`, `ac` or `always`, default `ac`. With `ac`, the runner holds one `caffeinate -i -w <runner pid>` only on AC power, and only while an attempt is `starting`, `running` or `quota_wait`. An idle lead holds it only on AC.
- **The assertion.** It is ref-counted and spawned in the runner's own group. After spawning, the runner checks that caffeinate is alive, because a bad pid makes it exit 0 silently, and restarts it if something kills it.
- **Battery.** Heartbeats carry `power`. Below `batteryDrainPercent` (default 20), the runner takes no new attempts (`acceptingUntil`). Below 8, it stops its agents as a runner's own stop (`cause: 'runner_stop'`), once per crossing, with WIP pushes and without a handoff turn.
- **Waking.** After a detected wake gap, the runner sets `acceptingUntil` for `wakeHold` (2 minutes).
- **Lid close** still sleeps the Mac; runner leases handle that.

## 8. Claude Code adapter

### 8.1 Pin and preflight

- **Pin.** `@anthropic-ai/claude-agent-sdk` 0.3.285 is pinned together with Claude Code 2.1.285; the SDK's `claudeCodeVersion` names the matching CLI. The SDK's optional bundled binary is not installed (`bun install --omit optional`). `pathToClaudeCodeExecutable` is the runner's own copy, `~/.agflow/runner/vendor/claude/2.1.285/claude`.
- **Preflight.** Before every start, the runner runs `<bin> --version` on the binary of the attempt's CLI version (section 7.4), which must report that version. Before the first dispatch and every 6 hours, it runs a zero-model handshake: a query whose only input is the local `/clear` command, with the full session options. It must find:
  - `initializationResult().account.subscriptionType` set, and no `apiKeySource`;
  - in `system/init`: `apiKeySource: 'none'`, the expected `claude_code_version` and `permissionMode`, `tools` equal to the requested built-ins plus `mcp__agflow__*`, `mcp_servers` only `agflow`, and `plugins` only built-in entries;
  - in `getSettings().effective` (untyped in `sdk.d.ts`, like `cancelQueued`; the adapter casts it): `sandbox.enabled` true and `sandbox.failIfUnavailable` true.

  Any mismatch marks the vendor not ready, with the reason. `apiKeySource: 'ANTHROPIC_API_KEY'` reads "an API key would replace the subscription".
- **Quota and extra usage.** On the same query, preflight calls the SDK's experimental `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()`, which the pin fixes. Its `rate_limits` give the 5-hour and weekly utilization (percent / 100) and reset times; `extra_usage.is_enabled` gives `paidUsage` `enabled` or `disabled`. If the call fails or its shape differs, `paidUsage` is `unknown` and the quota stays unknown until the first `rate_limit_event`.
- **The account** gives `accountId` (a hash of the account email) and `plan`. `managedPolicy` is always false for Claude.
- **Weakened items.** Preflight's `weakened` list names what cannot be enforced: the `auto` profile, and the shared `/tmp/claude` if the local sandbox checks (section 15) find its `denyWrite` unenforced on the pin. The list is fixed per pin from those checks; nothing is probed at run time.
- **First turn.** The first turn of every session checks `system/init` again, expecting the attempt's CLI version. A new session's mismatch fails the start (`attempt.failed_to_start`, infra); the hub's two-failed-starts rule then marks the vendor not ready. A resumed session's first-turn mismatch is reported as `attempt.exited`, rather than as a new failed start.

### 8.2 Session options

```ts
query({
  prompt: inbox,                          // one long-lived AsyncIterable<SDKUserMessage>
  options: {
    pathToClaudeCodeExecutable, cwd: clone, env,              // allowlisted (section 7.6)
    spawnClaudeCodeProcess: detachedNodeSpawn,                // own process group (section 7.4)
    sessionId: newUuid /* new sessions */, resume: sessionRef /* resumed ones */,
    model,                                                    // AgentLaunch.model: a full id, never an alias
    settingSources: ['project'], projectConfigRoot: baseCheckout,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: CLAUDE_BASH_NOTE },
    strictMcpConfig: true,
    mcpServers: { agflow: { type: 'stdio', command, args: ['mcp', '--vendor', 'claude', '--runner'], env: bridgeEnv } },
    tools: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Task',
            'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate'],  // + WebFetch, WebSearch if profile.webTools
    permissionMode: profile.name === 'auto' ? 'auto' : 'acceptEdits',
    permissionPrompts: 'none',                                // no canUseTool: denials are immediate
    sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false,
               network: { allowedDomains, strictAllowlist: true },
               filesystem: { denyRead, allowRead: [clone], allowWrite: [tmpDir],
                             denyWrite: ['/tmp/claude', '/private/tmp/claude', '~/.npm/_logs'] } },
    settings: {
      permissions: { allow: ['mcp__agflow'],                  // + WebFetch/WebSearch if profile.webTools
                     deny: denyRules },                       // section 7.6 reads and writes, push commands
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '<agflow> hook brief --runner' }] }] },
                                                              // <agflow>: the agflow command the adapter factory gets (section 13)
      autoMemoryEnabled: false, crossSessionInbound: 'refuse', cleanupPeriodDays: 30,
      syncClaudeAiSkills: false, syncClaudeAiPlugins: false,
    },
    hooks: { PreToolUse: [guard], PreCompact: [...], PostCompact: [captureSummary] },
  },
});
```

- **System prompt.** The `claude_code` preset is explicit; otherwise the SDK sends an empty system prompt. The appended `CLAUDE_BASH_NOTE` explains the runner's Bash restrictions.
- **Sandbox placement.** The sandbox is a top-level option, never also inside `settings`, so the SDK passes `failIfUnavailable` and Bash never runs unsandboxed.
- **Bridge tools.** `permissions.allow` lists `mcp__agflow`; without it, every bridge call would be denied under `permissionPrompts: 'none'`. The flag-settings layer honours allow rules.
- **Brief.** The brief arrives through the `SessionStart` command hook. The hook command changes to `<claudeHome>/agflow-empty` before starting agflow (section 10); `agflow hook brief --runner` identifies the attempt from `AGFLOW_AGENT_TOKEN`.
- **The guard,** a `PreToolUse` callback in both profiles, refuses:
  - Bash commands that run `git push` (including `git -C … push`), `git credential`, `git config --global`, `gh`, `glab` or `security`, or that write into `.git/hooks` or `.git/config`;
  - `Edit`, `Write` and `NotebookEdit` whose real path is outside the clone and its temporary directory, or is `<clone>/.git/config` or under `<clone>/.git/hooks/`;
  - `Read`, `Glob` and `Grep` whose real path is in another attempt's clone, or under `<CLAUDE_CONFIG_DIR>/projects/` outside the attempt's own project directory (section 7.6).

  A command the guard cannot parse is refused. This includes computed Git subcommands through substitutions, backticks or variables, and eval/sh wrappers that could hide a push. Production Bash permissions stay restrictive; the script fallback in section 7.6 supports legitimate commands.
- **Tools.** The explicit built-in tools list removes `SendMessage`, `ListAgents`, cron and wake-up tools, `RemoteTrigger`, `Workflow`, `EnterWorktree` and `ToolSearch`.
- **Shell snapshot.** The mitigation is implemented: the adapter sets `ZDOTDIR=<claudeHome>/agflow-empty`, drops any incoming `CLAUDE_CODE_SHELL`, and sets `CLAUDE_CODE_SHELL=/bin/zsh` unless the basename of `SHELL` is already `zsh`. Only the snapshot sources the owner's `~/.zshrc` outside the sandbox, once per Claude process; `~/.zshenv`, `~/.zprofile`, `~/.zlogin` and `~/.bashrc` do not run around agent commands. The snapshot remains an accepted residual risk (section 5). It is written to the runner's Claude home, which sandboxed commands cannot read. The owner's functions therefore do not reach agent commands, and the agent's `PATH` comes from its environment.

### 8.3 Messages, turns and events

- **Sending.** Every message is pushed into the inbox as an `SDKUserMessage` with a uuid. The default priority folds it into the running turn at the next tool boundary.
- **Delivery and acknowledgement.** A message is `delivered` when its command lifecycle reaches `started`, and `acknowledged` when its uuid appears in `result.user_message_uuids`.
- **Interrupt.** The hub's `interrupt` command uses plain `interrupt()`; queued messages survive and run next. A stop uses `interrupt({ cancelQueued: true })`; that parameter is untyped in `sdk.d.ts`, so the adapter casts it. A result that follows the runner's own interrupt (`error_during_execution`, with `terminal_reason` `aborted_tools` or `aborted_streaming`) is an interrupt, not a crash. The runner's pending-interrupt flag decides, not one `terminal_reason` value.
- **Event mapping:**

  | Claude event | Adapter event |
  |---|---|
  | `assistant` tool_use blocks | `tool_started` |
  | their results | `tool_ended` (`non_execution_kind` marks denied calls) |
  | `system/task_started`, `system/task_notification` | tool-in-flight |
  | `result` | `turn_ended`, with outcome `failed` whenever `is_error` is true |
  | `system/init` (sent again for every user message) | session facts |
  | `rate_limit_event` | `quota` |
  | compaction hooks | `compacted`, with the summary |

  A successful `mcp__agflow__write_handoff` result sets `handoffWritten`.
- **Quota.** `rate_limit_event` fires only when something changes, so the adapter keeps the last value per account.
  - **A limit hit** is any of:
    - `rate_limit_event.rate_limit_info.status === 'rejected'`;
    - a result whose text starts with one of the CLI's usage-limit prefixes;
    - `terminal_reason` `blocking_limit` or `rapid_refill_breaker`.

    A limit hit without a reset time is exhausted with `resetsAt: null` (section 6.10).
  - **Paid usage:** overage fields, or `rateLimitType: 'overage'`. While `allowPaidUsage` is false, paid usage in use is a limit hit too (section 6.10).
  - **Vendor errors:** `system/api_retry` counts as activity. With `error_status` 429 it also makes the adapter report the last known quota, but it never by itself moves the attempt to `quota_wait` or marks the account exhausted. A `rate_limit` or `overloaded` error after retries are exhausted is a vendor error, not quota.
  - **Other outcomes:** an expired login, a context overflow and a policy refusal end the turn with `errorKind` `auth`, `context` or `policy`. The runner reports them as `attempt.vendor_outcome`.
- **Context.** `contextUsed` comes from the last turn's input tokens over the model's window.
- **Transcript tail.** `readTranscriptTail` reads the last assistant turns from the session file under the runner's Claude home, without a live session.

### 8.4 Stop, resume and take-over

- **Stop:** the ladder in section 7.4.
- **Resume:** `resume: sessionRef`, from the same clone directory, with the same options. The brief arrives again through the `SessionStart` hook (source `resume`). Resume failures follow section 7.4.
- **Take-over:** close the query and wait until the CLI exits. Then restore the protected paths and replace the clone's `.git` (section 6.12), because an interactive `claude --resume` loads the clone's project settings and the person's git then runs there. The command uses the runner's `CLAUDE_CONFIG_DIR` verbatim, so the person sees a workspace-trust prompt for the clone once.

## 9. Codex adapter

### 9.1 Process and preflight

- **Binary.** The runner's own native binary, `~/.agflow/runner/vendor/codex/0.159.2/bin/codex`, inside the copied package layout (section 7.1), so the bundled `rg` stays on commands' `PATH` and Code Mode finds `codex-code-mode-host`. No `CODEX_MANAGED_*` variables are set; they only feed install diagnostics. This keeps Node out of the agent's process chain.
- **Protocol types** are generated with `codex app-server generate-ts` for the pin and committed under `packages/runner/src/adapters/codex/protocol/`.
- **Flags.** `codex app-server --disable hooks --disable apps --disable plugins --disable remote_plugin -c features.shell_snapshot=false -c allow_login_shell=false`, with `CODEX_HOME` set to the runner's home and `HOME` to `homes/codex-user`.
- **Preflight** (zero-model):
  - `initialize`;
  - `account/read` must return a `chatgpt` account, which gives `accountId` and `plan`;
  - `configRequirements/read` and `config/read { includeLayers: true }`;
  - `mcpServerStatus/list` must be empty (the bridge is added per thread, and `codex_apps` must be absent), and `skills/list` must show no user or plugin skills;
  - `account/rateLimits/read` gives the quota and the credits (a scripted provider answers -32600; the quota is then unknown).

  `managedPolicy` is true when requirements are non-null, or when any config layer is MDM-managed, enterprise-managed or legacy-managed. If either call fails, the vendor counts as managed. The vendor is not ready when `workspace-write` is missing from the allowed sandbox modes, `on-request` from the allowed approval policies, or `user` from the allowed approvals reviewers. A unit test covers the classifier with a managed output recorded on this Mac and a synthesized unmanaged one (`requirements: null`, and no `mdm`, `enterpriseManaged` or `legacyManaged*` layer). An empty home on this Mac is still managed.

### 9.2 Threads and turns

`thread/start` (and `thread/resume`, which receives the same overrides again):

```ts
{
  cwd: realpath(clone), model, sandbox: 'workspace-write', approvalPolicy: 'on-request',
  approvalsReviewer: 'user',                                 // never a model; a different answer fails the start
  developerInstructions: launch.brief,                       // spec.brief plus the working-directory line (section 10)
  config: {
    projects: { [realpath(clone)]: { trust_level: launch.projectConfigVerified ? 'trusted' : 'untrusted' } },
                                                             // always explicit; nested, never dotted
    sandbox_workspace_write: { writable_roots: [`${clone}/.git`], network_access: false,
                               exclude_slash_tmp: true, exclude_tmpdir_env_var: true },
    shell_environment_policy: { inherit: 'all', exclude: ['AGFLOW_*'],
                                set: { HOME: `${clone}/.agflow/run/home`, TMPDIR: `${clone}/.agflow/run/tmp` } },
    mcp_servers: { agflow: { command, args: ['mcp', '--vendor', 'codex', '--runner'],
                             cwd: codexUserHome,                 // never the clone; bridge runs outside the sandbox
                             env_vars: Object.keys(launch.bridge.env),   // every bridge variable of section 7.6:
                                       // the AGFLOW_* ones, the poll settings, NODE_USE_SYSTEM_CA, connectivity
                             default_tools_approval_mode: 'approve', required: true } },
    web_search: profile.webTools ? 'cached' : 'disabled',   // values: disabled | cached | indexed | live; MDM may restrict them
  },
}
```

- **Trust.** Before `thread/start` and `thread/resume`, the runner checks that the clone's `.codex/` equals the restore base's, through the vault, after restoring the agent-config paths. It passes the answer as `AgentLaunch.projectConfigVerified`. The trust entry is always explicit: without one, Codex would trust the clone automatically and write a trust entry, which now lands in the runner's own Codex home. When the check fails, the thread runs `untrusted`: project config, hooks and exec policies are skipped, but it still loads `<clone>/.codex/skills`. The runner's warning says so.
- **Checks after every `thread/start`.**
  - `mcpServerStatus/list` must list only `agflow`. The list omits servers still starting or failed, so any `mcpServer/startupStatus/updated` naming another server also refuses the start. A trusted project's MCP servers can run outside the sandbox before these checks refuse the thread: trusting a verified `.codex/` means trusting its commands.
  - `skills/list` must list no user or plugin skills.
  - A `configWarning` naming an unrecognised or disallowed setting fails the start (`failed_to_start`, infra).
- **Tool discovery.** Code Mode defers MCP tools. `developerInstructions` also name `launch.bridge.tools` and the `tools.mcp__agflow__<name>` calling form, so tool discovery survives compaction; a first-prompt note alone would not.
- **Naming.** The thread is named `agflow T-42-a3` (`thread/name/set`).
- **Turns.** `turn/start` returns the active turn id; use it, because `turn/started` arrives later. `turn/completed` reports `completed`, `interrupted` or `failed`.
- **Child threads.** All threads on the attempt's app-server belong to the attempt, including collaboration sub-agents. Turn tracking, continuation and acknowledgements follow only the main thread id. Approvals from child threads are relayed under the same attempt.
- **Messages:**
  - People and the hub: `turn/steer { expectedTurnId }` during a turn, otherwise `turn/start`. Retry on -32600 (no active turn, or a turn id mismatch). On `activeTurnNotSteerable`, hold the message until `turn/completed`, then use `turn/start`.
  - Agents: always `turn/start { input: [], toolOutput: { name: 'agent_message', namespace: 'agflow', output } }`. It joins an active turn or starts one, and arrives with tool authority, below user instructions. Never `thread/inject_items`.
- **Compaction** arrives as `item/completed` with `item.type: 'contextCompaction'`. The static brief survives it, and the adapter reports `compacted`.
- **Errors.** The adapter acts only on the final error (`willRetry: false`) or on `turn/completed` with status `failed`. `codexErrorInfo` is a string or a one-key object: `activeTurnNotSteerable` arrives as `{ activeTurnNotSteerable: { turnKind: 'review' | 'compact' } }` (on `turn/steer`, it is expected in the JSON-RPC error data, which is unverified).

  | Error | Action |
  |---|---|
  | `usageLimitExceeded`, or `rateLimits.rateLimitReachedType` set | `quota_wait`; the reset time from `account/rateLimits/read` |
  | credits consumed at 100% while `allowPaidUsage` is false | `quota_wait` |
  | `unauthorized`, or an HTTP 401 from the model provider (`httpConnectionFailed` with status 401) | `attempt.vendor_outcome` `auth`: the vendor is not ready ("login expired"), and the attempt ends as in section 6.4 |
  | `contextWindowExceeded` | the adapter itself runs one `thread/compact/start` and a continuation turn, and reports no `turn_ended` for the failed turn; if it happens again, `turn_ended` with `errorKind` `context`, and the runner reports `attempt.vendor_outcome` `context` (replacement with a handoff) |
  | `cyberPolicy`, `misalignmentPolicyViolation` | `attempt.vendor_outcome` `policy`: the task is blocked (kind `policy`) and people are told |
  | `tooManyDenials`, `sessionBudgetExceeded` | `attempt.vendor_outcome` `denials` or `session_budget`: the stall rule `budget` |
  | `rateLimitExceeded`, `serverOverloaded`, `sandboxError`, and anything else (Codex has already retried) | `vendor_error` (section 6.8) |
- **Quota.** `account/rateLimits/updated` gives `usedPercent`, `windowDurationMins` and `resetsAt` (epoch seconds). A window at 100% while the account has credits (`credits.hasCredits` or unlimited) is paid usage in use; the adapter reports it, and the runner's controller applies `allowPaidUsage` (section 6.10).
- **Collaboration tools.** Codex's built-in multi-agent tools cannot be removed; approvals still apply to every nested call.

### 9.3 Approvals

- **Answering.** `item/commandExecution/requestApproval` and `item/fileChange/requestApproval` are relayed (section 6.10) and answered through the approval id's mapping.
  - A file-change request carries no diff; the adapter takes it from the preceding `item/started` file-change item.
  - `approve` maps only to `accept`.
  - `writeStdin` approvals are shown to the owner as stdin input.
  - Codex decisions carry no reason. A decline with a reason (an expiry, say) is followed by one system note with that reason, steered into the thread's active turn.
- **Withdrawn requests.** `serverRequest/resolved` (which also arrives after an interrupt) voids a request that is still unanswered. It also follows the runner's own answers, which it must not void.
- **Waiting.** `thread/status/changed` with `activeFlags` containing `waitingOnApproval` sets the phase to `waiting_approval`.
- **User input.** `item/tool/requestUserInput` is answered at once with empty answers ("no person is available; decide yourself or use declare_blocked") and is not relayed.
- **Everything else.** `item/permissions/requestApproval` is relayed as `other`; approving grants exactly the requested profile, for that turn only. `mcpServer/elicitation/request` is always declined, because the agflow bridge never elicits. Requests that cannot be parsed are declined. Server requests of any other kind get an immediate JSON-RPC error (-32601). Every server request gets an answer.

### 9.4 Stop, resume and take-over

- **Stop:** `turn/interrupt`, then stdin EOF (app-server exits and kills its commands, including background ones that outlived their turn), then SIGTERM and SIGKILL of the recorded groups.
- **Crash recovery** needs no cleanup: after a SIGKILL, a new process resumes the thread at once, even though the writer-lock file stays. Resume failures follow section 7.4.
- **Take-over:** the app-server must exit, because `thread/unsubscribe` keeps the single-writer lock. The person then runs `codex resume --no-daemon <thread>` in the clone with the runner's `CODEX_HOME`. Hand-back stops any daemon in that home first; the runner core does that and builds the commands, so the adapter needs no take-over hooks.

## 10. Bridge and hooks

**Startup isolation.** The bridge and Claude's brief hook run outside the vendor sandbox. They load no `bunfig.toml` or `.env` from their working directory: the compiled binary uses `--no-compile-autoload-bunfig` and `--no-compile-autoload-dotenv`; the source form runs `bun --no-env-file --config=/dev/null <repo>/packages/cli/src/main.ts`. Claude's bridge and brief hook start in `<claudeHome>/agflow-empty`. Codex's bridge MCP config sets its cwd to the runner's Codex user home, because stdio MCP servers otherwise start in the thread's cwd.

**Runner mode** of `agflow mcp`. An explicit flag selects it, `agflow mcp --vendor <v> --runner`; it is never inferred.
- At startup the bridge exits non-zero if `AGFLOW_AGENT_TOKEN`, `AGFLOW_HUB_URL`, `AGFLOW_ATTEMPT_ID`, `AGFLOW_ROLE` or `AGFLOW_CONFIG_DIR` is missing. With Codex's `required: true`, `thread/start` then fails.
- It uses the token as its bearer, sends no `X-Agflow-Agent`, and reads no credentials file. It does not call the hub at startup.
- `hello` answers "already connected".
- **Tools follow `AGFLOW_ROLE`:**
  - **workers:** the shared tools, `report_progress`, `write_handoff`, `declare_blocked`, `declare_impossible`, `release_task`, `submit` (section 6.13) and `prepare_dependencies` (section 7.7). Not `claim_task` or `resume_claim`: the task is assigned.
  - **leads:** the shared tools and the M1 lead tools, plus:
    - `request_agents(count, vendor?, reason)`;
    - `replace_agent(agent_id, reason)` and `stop_agent(agent_id, reason, hold?)`, for runner agents only;
    - `write_handoff` with an optional task id (none: a lead handoff);
    - `get_lead_notes()`;
    - `fetch_submission(task_id)` (section 6.13): wait for the submitted branch in the runner vault, then fetch from `origin` and review `FETCH_HEAD`.

    No claim, resume-claim or submit.
- **Answers:**
  - **401 `attempt_ended`:** every tool answers "Your agflow attempt has ended (<reason>). Stop working; do not commit further."
  - **401 `attempt_refenced`:** "agflow is restarting your session; stop and wait."
  - **Hub unreachable** (in every mode): "The agflow hub is unreachable; keep working on your task and try again in a few minutes."
- **One source for the texts.** They are `BRIDGE_ANSWERS` in core, next to `BRIDGE_HEADER` (`X-Agflow-Bridge`) and `BRIDGE_VERSION` (2). The bridge and both adapters import them; `<reason>` is the `reason` of the hub's 401 body.
- **Error results.** Every refusal (the three answers above, and a refused submit) is an MCP error result. Success and "submission pending" are normal results. Adapters count a terminal tool (`tool_ended.terminal`) only on a normal result, and set `tool_ended.hubUnreachable` when the answer is the hub-unreachable text.
- The staffing and lead-handoff tools are for runner mode only. The live bridge also serves `fetch_submission`: it returns the branch and head with the own-remote note, without asking a runner to fetch.

**Live-chat claims** (M1 mode) now start from the task's work position. The claim answer's task names it (`workRef`, `workSha`), and the bridge fetches it with the person's own credentials (fetch-by-SHA works on GitHub), creates the task branch there, and says so. The hub refuses a live claim on a task whose work position is a WIP ref when the bridge does not declare support (an `X-Agflow-Bridge: 2` header). From epoch 2 on, the bridge names the branch with the hub's epoch (`HubStatus.epoch`), and reuses the task's recorded branch only when it carries the current epoch.

**`agflow hook brief --runner`** is the `SessionStart` command hook for Claude runner agents. It reads the token from its environment, fetches `GET /api/brief`, appends the line "Your working directory: <AGFLOW_CLONE>", and prints `{ "hookSpecificOutput": { "hookEventName": "SessionStart", "additionalContext": <brief> } }`. On any failure it prints a short explanation as the context, logs to `AGFLOW_CONFIG_DIR/hook.log` and exits 0, so the session still starts.

**Runner brief.** `buildBrief` gains a runner variant:
- no hello code;
- the branch, with "commit on this branch; the runner pushes for you; you cannot push". The hub does not know the clone's path, so the runner adds "Your working directory: <clone>": to `AgentLaunch.brief` (Codex's `developerInstructions` and `.agflow/run/brief.md`), and through the brief hook for Claude;
- the task pack at `.agflow/run/task.md`;
- "finish with `submit`, or `declare_blocked` or `declare_impossible`";
- for successors, the newest handoff note (up to 3000 characters), quoted, with a pointer to `get_task`;
- for leads, the newest lead handoff, quoted.

## 11. Web UI

| View | Change |
|---|---|
| **Runners** (new) | One card per runner: owner, state with a one-line "why" for every non-online state, free slots and capacity, power and battery, disk, keep-awake, git readiness and last push, and "takes no new work until <time>" while `acceptingUntil` is set. For each vendor: readiness and its reason, the runner's binary version (and the owner's), plan, managed policy, both quota windows with ceilings, the account's one reset time, paid usage, owner away. The profile with any weakened items. **Owner only:** capacity, keep-awake, draining, ceilings, paid usage, retire. |
| **Agents** | Columns for runner, attempt and phase (starting, preparing, working, waiting for approval, waiting for quota, vendor error, holding). **Actions:** interrupt, stop, "stop and hold", replace, take over. On runner-held tasks, M1's Release becomes Stop. The lead's row shows whether it is a live chat or on a runner, and its wake-ups since rotation. |
| **Task** | An attempts table: number, agent, vendor and model, runner, status, end reason, class, WIP ref and short sha, start and end times. The attempt log. Handoff, restatement and late-work notes side by side. Submissions with their outcome. Take over and hand back (from the runner's clone, or from a pushed ref), with the commands to run. Unblock is not offered for `takeover`, which uses hand back. Tasks that only live chats may do are marked "live chat only". |
| **Approvals** (new, with a badge in the shell) | The signed-in person's pending approvals: agent, task, the full command and cwd, the reason, the "outside the sandbox" warning, the manifest diff when there is one, and time left. Approve and decline. |
| **Goal / status** | The lead seat: live or runner, which runner, and wake-ups. A "runner leads" switch. |
| **Timeline** | The new event types, with filters for runners and attempts. |

## 12. Configuration

Every duration is a named setting in milliseconds. Environment variables are the production overrides, and values below the production minimums are accepted only in test mode.

**Hub test mode and minimums.** `AGFLOW_TEST=1` turns on the hub's test mode. Then `AGFLOW_TEST_CONFIG`, a JSON object of `HubConfig` millisecond fields, overrides any setting, so a real hub process can run with short timings. Outside test mode the minimums are: `tickMs` 5 s, `recoveryMs` 30 s, `runnerLeaseMs` 5 min, `stallMs` 5 min, `approvalMs` 5 min and `submitTimeoutMs` 5 min. Code that builds a `HubConfig` directly (tests, the demo) spreads `HUB_RUNNER_DEFAULTS`.

**Hub** (`HubConfig` fields; environment variables with defaults):

| Setting | Environment variable | Default |
|---|---|---|
| `runnerLeaseMs` | `AGFLOW_RUNNER_LEASE_MINUTES` | 15 min |
| `tickMs` | `AGFLOW_TICK_SECONDS` | 15 s |
| `stallMs` | `AGFLOW_STALL_MINUTES` | 10 min |
| `toolCapMs` | `AGFLOW_TOOL_CAP_MINUTES` | 30 min |
| `longToolCapMs` | `AGFLOW_LONG_TOOL_CAP_MINUTES` | 90 min |
| `recoveryMs` | `AGFLOW_RECOVERY_SECONDS` | 2 min |
| `approvalMs` | `AGFLOW_APPROVAL_MINUTES` | 15 min |
| `leadReviewMs` | `AGFLOW_LEAD_REVIEW_MINUTES` | 45 min |
| `liveLeadGraceMs` | `AGFLOW_LIVE_LEAD_GRACE_MINUTES` | 120 min |
| `quotaWaitMaxMs` | `AGFLOW_QUOTA_WAIT_MINUTES` | 45 min |
| `quotaUnknownMs` | `AGFLOW_QUOTA_UNKNOWN_MINUTES` | 30 min |
| `deliveryBatchMs` | — | 2 s |
| `stopGraceMs` | — | `handoffMs` plus 5 min |
| `heartbeatMs` | — | 15 s (sent to runners in `welcome.timings`) |
| `deadLinkMs` | — | 45 s (sent to runners) |
| `handoffMs` | — | 3 min (sent to runners) |
| `wipGraceMs` | — | `runnerLeaseMs` / 3 (sent to runners; section 7.3) |
| `activeBudgetMs` | `AGFLOW_ACTIVE_BUDGET_MINUTES` | 4 h |
| `maxContinuations` | — | 25 |
| `vendorErrorReplaceMs` | — | 60 min |
| `degradedMs` | — | 60 min |
| `dispatchHoldMs` | — | 2 min |
| `vendorRequirementMs` | — | 10 min |
| `handbackTimeoutMs` | — | 10 min |
| `infraBackoffMs` | — | 1, 2, 5, 15, 30 min |
| `resumeWindowMs` | — | 60 min |
| `leadExitWindowMs` | — | 60 min |
| `vendorPrefMs` | — | 60 min |
| `submitTimeoutMs` | `AGFLOW_SUBMIT_TIMEOUT_MINUTES` | 15 min |
| `maxWorkers` | `AGFLOW_MAX_WORKERS` | 4 |
| `maxAttempts` | `AGFLOW_MAX_ATTEMPTS` | 3 |
| `leadRotateWakeups` | `AGFLOW_LEAD_ROTATE_WAKEUPS` | 20 |
| `maxPlanChangesPerHour` | `AGFLOW_MAX_PLAN_CHANGES_PER_HOUR` | 60 |
| `wipRefPrefix` | `AGFLOW_WIP_REF_PREFIX` | `refs/agflow/` |
| `mainBranch` | `AGFLOW_MAIN_BRANCH` | `main` |
| `minProtocol` | — | 1 |

**Runner** (`runner.json`):
- `capacity` (2), `keepAwake` (`ac`), `profile`;
- `models`:
  - Claude: lead `claude-opus-5-5`, worker `claude-sonnet-5-5`;
  - Codex: both roles `gpt-6.1-sol`;
- `ceilings` (0.85 and 0.85) and `allowPaidUsage` (false), per vendor;
- `minFreeGb` (10), `batteryDrainPercent` (20);
- the vendor homes, the captured `PATH` and connectivity variables, the commit identity (vendor pins live in code, section 7.1);
- the snapshot of the last hub-confirmed settings, with their version (section 6.3);
- `timings`:

  | Timing | Default |
  |---|---|
  | `heartbeat` (overridden by `welcome.timings`) | 15 s |
  | `deadLink` (overridden by `welcome.timings`) | 45 s |
  | `handshake` | 10 s |
  | `backoffBase` | 1 s |
  | `backoffCap` | 30 s |
  | `tickGap` | 5 s |
  | `continuationWait` | 5 s |
  | `hold` | 2 min |
  | `handoff` (overridden by `welcome.timings`) | 3 min |
  | `wip` | 10 min |
  | `finalPush` | 60 s |
  | `bridgePoll` (passed to the bridge as `AGFLOW_BRIDGE_POLL_MS`) | 2 s |
  | `bridgePollMax` (`AGFLOW_BRIDGE_POLL_MAX_MS`) | 3 min |
  | `suspend` | 45 s |
  | `wakeHold` | 2 min |
  | `crashLoopWindow` | 10 min |
  | `loginProbe` | 60 s |
  | `stopInterrupt` / `stopClose` / `stopKill` | 5 s / 2 s / 5 s |
  | `vendorErrorBackoff` | 30 s, doubling to 10 min |
  | `quotaUnknown` (turn retries in `quota_wait` with an unknown reset) | 30 min |
  | `lateRetry` (late-work pushes after a `pushError`) | 30 s, doubling to 10 min |
  | `submitRetry` (remote failures of a submission push) | 15 min |
  | `prep` (one dependency preparation) | 15 min |
  | `preflightEvery` | 6 h |
  | `eventRetention` | 48 h |

  Outside test mode these defaults are also the minimums; with `AGFLOW_TEST=1` and `test.allowShortTimings`, any positive value is accepted.
- `test` (section 15.1).

## 13. Packages and interfaces

```
packages/core/src/runner-protocol.ts   zod schemas and types shared by hub and runner (protocol 1), the closed code
                                       lists, COMMAND_MIN_PROTOCOL, TEST_ACCOUNT_ID
packages/core/src/api-schemas.ts       request and response schemas of the new HTTP routes, HUB_EVENT_TYPES,
                                       BRIDGE_HEADER, BRIDGE_VERSION, BRIDGE_ANSWERS, APPROVALS_ROUTE
packages/core/src/naming.ts            attempt ids; WIP, late-work, take-over and local pin refs; task branch names
packages/core/src/credentials.ts       CredentialsSchema: the CLI's credentials.json (no file access), for CLI and runner
packages/core/src/fence.ts             Fence, compareFence, formatting
packages/core/src/scheduling.ts        placement and ordering (pure)
packages/core/src/stall.ts             stall rules and capForCommand (pure)
packages/core/src/ladder.ts            STOP_CAUSES, classes and steps (pure)
packages/core/src/protected-paths.ts   path classes, restore-set resolution, classification, liveChatOnly (pure)
packages/hub/src/{runners,gateway,commands,events-in,attempts,submissions,delivery,scheduler,supervisor,
                  handoff,lead,takeover,approvals,quota,recovery,retention}.ts
packages/hub/src/server.ts             startHub: the app, the gateway and the scheduler on one port
packages/hub/src/restore.ts            the restore command
packages/runner/                       the runner (section 7) and adapters (sections 8, 9)
packages/runner/src/vendor/pins.ts     VENDOR_PINS and vendorBinary (section 7.1)
packages/runner/src/adapters/types.ts  the adapter interface (below)
packages/runner/src/adapters/index.ts  createAdapters, with one entry file per vendor
packages/testkit/                      git fixtures, the refusing proxy, scripted model servers, recorded-stream fake
                                       CLI, fake adapter, multi-runner harness
packages/cli/src/runner-command.ts     agflow runner …
```

- **Package direction.** `packages/cli` depends on `packages/runner`, never the reverse: the CLI passes the runner the agflow command (`{ command, args }`, as M1's `selfCommand` gives it) and starts it. `packages/testkit` imports runner types only, except its multi-runner harness, which has its own entry point.
- **`startHub(ctx, { port, hostname, scheduler: 'auto' | 'manual' | false, dbLock, timers })`** returns `{ url, gateway, scheduler, stop }`. `main.ts` uses it with the lock and the automatic scheduler. Tests and the demo pass their own context (a fake clock, `:memory:`), take no lock, and start or tick the scheduler themselves. The runner's tests share one in-process hub fixture built on it.

**Adapter interface.** The Claude and Codex adapters implement it, and so does the fake adapter used in runner tests.

```ts
export interface VendorAdapter {
  readonly vendor: Vendor;
  preflight(): Promise<PreflightResult>;
  start(launch: AgentLaunch): Promise<AgentSession>;
  readTranscriptTail(input: { sessionRef: string; clone: string; maxChars: number }): Promise<string | null>;
  deleteTranscript(input: { sessionRef: string; clone: string }): Promise<void>;   // cleanup_attempt and retention
  enrichApproval?(input: { clone: string; vault: string; startSha: string;        // the default changes nothing;
                           request: { kind: Approval['kind']; summary: string; detail: Approval['detail'] } })
    : Promise<Approval['detail']>;                                                 // Codex adds manifest diffs
}

export interface PreflightResult {
  facts: Pick<RunnerVendor, 'vendor' | 'cliVersion' | 'ownerCliVersion' | 'ready' | 'problem' | 'accountId' | 'plan'
                          | 'managedPolicy'>;   // the runner adds models, ceilings, allowPaidUsage and preflightAt
  quota: VendorQuota | null;
  weakened: string[];            // merged with the runner's own items into hello.profile.weakened
}

// One per vendor, in packages/runner/src/adapters/<vendor>/entry.ts; null until that vendor's plan fills it.
export type AdapterFactory = (input: { config: RunnerConfig; paths: RunnerPaths;
                                       agflow: { command: string; args: string[] } }) => VendorAdapter | null;

export interface AgentLaunch {
  attemptId: string;
  role: AgentRole;
  model: string;                 // resolved by the runner
  cliVersion: string;            // the pin at start; the attempt's recorded version on every resume (section 7.4)
  clone: string;                 // real path; tool commands run here; Codex app-server starts in codexUserHome
  baseCheckout: string | null;   // Claude's project config root; null for Codex
  projectConfigVerified: boolean;  // the clone's .codex/ equals the restore base's (section 9.2)
  tmpDir: string;                // CLAUDE_CODE_TMPDIR or the Codex TMPDIR
  env: Record<string, string>;   // the agent environment (section 7.6)
  bridge: { command: string; args: string[]; env: Record<string, string>; tools: readonly string[] };
                                 // unprefixed agflow tools for AGFLOW_ROLE; BRIDGE_TOOL_NAMES in packages/runner,
                                 // checked against the CLI tool lists
  profile: PermissionProfile;
  brief: string;                 // spec.brief plus "Your working directory: <clone>" (section 10)
  firstPrompt: string;
  resume: { sessionRef: string } | null;
  logFile: string;
  registerProcess(pid: number): void;   // the runner records pid, pgid and lstart
}

export interface AgentSession {
  readonly sessionRef: string;
  readonly pid: number;
  readonly events: AsyncIterable<AgentEvent>;
  send(message: { id: string; text: string; authority: 'person' | 'agent' | 'system' }): Promise<void>;
  interrupt(options?: { cancelQueued?: boolean }): Promise<void>;
  answerApproval(approvalId: string, decision: 'approve' | 'decline', reason: string | null): Promise<boolean>;
  close(): Promise<void>;        // the vendor's own graceful end
  readonly exited: Promise<ExitInfo>;
}

export type AgentEvent =
  | { type: 'started'; sessionRef: string; model: string; cliVersion: string; permissionMode: string | null }
  | { type: 'turn_started' }
  | { type: 'turn_ended'; outcome: 'completed' | 'interrupted' | 'failed'; toolCalls: number; error: string | null;
      errorKind: 'quota' | 'vendor' | 'auth' | 'context' | 'policy' | 'denials' | 'session_budget' | null }
  | { type: 'tool_started'; toolId: string; name: string; input: string; command: string | null }
  | { type: 'tool_ended'; toolId: string; ok: boolean; denied: boolean; terminal: 'submit' | 'blocked' | 'impossible' | 'released' | 'handoff' | null;
      hubUnreachable: boolean }  // the bridge answered the hub-unreachable text (section 10)
  | { type: 'text'; text: string }
  | { type: 'delivered'; id: string }
  | { type: 'acknowledged'; id: string }
  | { type: 'quota'; accountId: string | null; quota: VendorQuota }
  | { type: 'approval_request'; approvalId: string; kind: Approval['kind']; summary: string; detail: Approval['detail'] }
  | { type: 'approval_void'; approvalId: string }
  | { type: 'waiting_approval'; waiting: boolean }
  | { type: 'compacted'; summary: string | null }
  | { type: 'context'; used: number }
  | { type: 'warning'; text: string };   // reported as an attempt.activity note

export interface ExitInfo { code: number | null; signal: string | null }
```

The runner's `AttemptController` owns everything that is not vendor-specific: git, dependency preparation, the stop ladder, continuation, facts, deliveries, the approvals relay and its owner notifications, paid-usage handling, WIP timers, the final push, the take-over commands and the hand-back daemon stop, and reporting. The stop ladder calls `interrupt`, then `close`, then signals the recorded groups. Usage accounting in tokens or money is out of M2; quota windows are reported.

**Registry.** `createAdapters(config, paths, { agflow })` in `packages/runner/src/adapters/index.ts` returns every adapter whose entry file returns one. The runner core creates both entry files returning null; the Claude and Codex plans each fill their own. `agflow runner start` calls it; tests inject adapters instead.

## 14. Plans

| Plan | Contents | Depends on |
|---|---|---|
| **M2a — hub** | Sections 6 and 13 (hub and core). The shared contracts come first: core types, fence, runner protocol and API schemas. Then: schema v2, gateway, commands and events, attempts and the trigger table, agent tokens and the route allowlist, M1 operation mapping, work positions, submissions, delivery, scheduler, quota and accounts, stall and ladder policy, handoff assembly, lead seat, take-over, approvals, recovery and restore, backups and retention, churn guard, HTTP API, events, the hub's refusal of older bridges | M1 |
| **M2b — runner core and bridge** | Sections 7.2–7.6 and 13: runner config, test mode and timings; `runner.db` (journal, outbox, registry); the link client; git (vault, clones, harvest, snapshot, protected paths, pushes, late refs); processes; facts; the adapter interface and fake adapter; `AttemptController` and the command executor; the agent environment; the bridge's runner mode; `agflow hook brief --runner`; live-chat claims from the work position (`task-git.ts`, `X-Agflow-Bridge: 2`) | M2a contracts; its in-process-hub, bridge and live-claim tasks also need M2a's hub |
| **M2c — runner service and operations** | Sections 7.1, 7.7, 7.8 and 7.9: `agflow runner setup/start/install/status/drain/restart/stop/uninstall`, vendor binaries, logins, service checks, the LaunchAgent, single instance, suspend, `needs_login`, crash loops, notifications, dependency preparation, retention and the disk guard, power and keep-awake | M2b |
| **M2d — Claude adapter** | Section 8, the scripted Anthropic Messages API server and the recorded-stream fake CLI in testkit, and the Claude smoke suite | M2b |
| **M2e — Codex adapter** | Section 9 and the runner side of approvals, generated protocol types, the scripted Responses API provider in testkit, and the Codex smoke suite | M2b |
| **M2f — web UI** | Section 11 | M2a |
| **M2g — end-to-end** | The multi-runner harness, the three exit scenarios with fault injection plus runner restart, hub restart, hub restore, mid-turn delivery and take-over with hand-back, the live run with real subscriptions, and README and spec updates | all |

**Execution order.** The contracts (the first tasks of M2a) are what all plans share, so they come first and then freeze: a later change needs a recorded decision and updates every importer in the same change. After that the plans overlap, with gates:
1. **Contracts:** M2a's core tasks: types, names, the runner protocol, API schemas and events, protected paths, stall rules, the ladder, and the placement helpers.
2. **In parallel:** the rest of M2a; M2b's runner core (everything before its in-process-hub tasks); M2f's DOM-free models.
3. **Once the runner core is done, in parallel:** M2c's tasks that need no hub (machine facts, pins, logins, the lock, logs); M2d and M2e up to their real-CLI suites. M2b's in-process-hub, bridge and live-claim tasks start once M2a has the gateway, scheduler, submissions, preparation, lead routes and live claims.
4. **Once M2b is done, in parallel:** the rest of M2c; M2d's and M2e's real-CLI suites. Once M2a is done: M2f's demo and views. M2g's harness pieces start as their providers land.
5. **Last:** M2g's scenarios once M2c, M2d and M2e are done; its live run and docs once M2f is done too.

Parallel plans avoid editing the same files: the runner core pre-declares the shared dependencies, the root scripts of M2c, M2d and M2e, and every runner timing; each vendor plan fills only its own registry entry; the README is M2g's alone.

## 15. Testing

- **Unit (CI).**
  - Core policies: scheduling, stall, ladder, protected paths, fences.
  - Hub modules, through the existing test context with a fake clock.
  - Runner modules, with a temporary `AGFLOW_HOME`, local bare origins and the fake adapter.
  - The link, with an in-process hub.
- **Security tests (CI):**
  - planted git config keys (section 7.3);
  - credential-free agent git;
  - fenced pushes, leases and late refs against a local bare origin;
  - protected-path detection with case tricks, renames, symlinks, mode changes and embedded repositories;
  - the agent-token route allowlist, enumerated over every mounted route;
  - the refused CLI-token path;
  - lead authority only from the seat;
  - approval identity and voiding;
  - a gateway batch with a stale-fence event and a throwing event in the middle: the whole batch is acknowledged, and the later events take effect;
  - every task move the trigger table can make, replayed against the state machine from every status.
- **Adapter tests** (local: they run with `AGFLOW_SMOKE=1`, and are skipped without it or without the pinned CLIs), with zero quota use:
  - **Claude:** the real `claude` against a scripted Anthropic Messages API server (section 15.1). Subscription quota signals cannot come from an API-key server, so they are tested with a recorded-stream fake CLI fed the stream of a real limit hit; the real CLI covers the 429 path with retries off.
  - **Codex:** the real `codex app-server` against a scripted Responses API model provider in a scratch `CODEX_HOME`.
  - **Both cover:** start, deliver, interrupt, resume (including a session that never ran a turn), stop, quota and vendor errors, approvals (Codex), the bridge, and the only-agflow checks.
  - The scripted Responses provider cannot exercise web search; `web_search: 'disabled'` is checked only through the absence of a `configWarning`.
- **Sandbox checks** (local, with `AGFLOW_SANDBOX_CHECKS=1`, because they use the network and a throwaway keychain item, which they always remove):
  - sandboxed commands cannot reach the hub URL or the git host, cannot read a throwaway keychain item (which succeeds outside), and cannot write outside the clone and its temporary directory, nor into another attempt's temporary directory or `/tmp/claude`;
  - an allowed registry is reachable;
  - the commands' `TMPDIR` is under `/tmp/agf/<id>/`, and writes to `/tmp/claude` and `~/.npm/_logs` are refused;
  - `Edit` and `Write` to the base checkout and to `~/.zshrc` are refused in both profiles;
  - a bridge call succeeds without a permission denial;
  - a Codex attempt lists no `codex_apps` tools;
  - the keychain lookup inside the sandbox uses the real HOME, so the check exercises the sandbox rather than HOME isolation;
  - Bun package scripts succeed, script-based sibling-clone reads are refused, and expansion-based Git pushes remain refused;
  - a fixture `bun install` and `pip install` succeed from an empty cache through dependency preparation;
  - in both profiles, these succeed: Read, Edit and Write of a clone file; a Bash write and a git commit in the clone; a Read of a persisted oversized Bash output. If the last fails under the `~/.agflow/runner` read deny, the runner's files are denied one by one instead, and the runner's Claude home is left to the sandbox's `denyRead`;
  - With either zsh or bash as the owner's `SHELL`, the snapshot sources `~/.zshrc` once per Claude process outside the sandbox; the other startup files (`~/.zshenv`, `~/.zprofile`, `~/.zlogin` and `~/.bashrc`) do not run, and their functions and PATH changes do not reach agent commands.
- **End-to-end (local).** M2g's harness: one hub, three runners with separate `AGFLOW_HOME`s, a local bare origin, scripted model servers, and short timings in test mode. It runs the three exit scenarios plus a runner restart, a hub restart, a hub restore, a delivery to a mid-turn agent, and a take-over with hand-back. It runs with `AGFLOW_E2E=1`, and then fails, instead of skipping, when a prerequisite is missing.
- **Pinned binaries in tests.** `findClaudeBinary` (testkit) and `findCodexBinary` (`packages/runner`) look at `AGFLOW_CLAUDE_BIN` and `AGFLOW_CODEX_BIN`, then at the runner's vendor directory under `~/.agflow`; `bun run vendor:install` puts the pins there without a full setup. A test runner home links the located version directory into its own `vendor/`. A test runner without one vendor just lacks its binary, and preflight reports "binary missing".
- **Live run (manual).** The exit scenarios with real subscriptions on a toy repository, like M1's, plus a TTY check of both take-over commands on the runner's laptop.

### 15.1 Test mode

Owned by M2b.
- `runner.json` gains `test: { claudeEnv, codexConfig, skipAuthChecks, allowShortTimings }`. It is honoured only with `AGFLOW_TEST=1`, and `agflow runner install` refuses it.
- `claudeEnv` is added after the allowlist: `ANTHROPIC_BASE_URL`, a test key, `CLAUDE_CODE_MAX_RETRIES=0`, and the switches that stop non-essential traffic.
- With `skipAuthChecks`, preflight reports the vendor ready, with the problem "test mode", `plan` "test mode", and `accountId` core's `TEST_ACCOUNT_ID`: `337c8a0a2e66c1e6`, the first 16 hex of sha256("agflow-test"). The fake adapter and both real adapters do this, so per-account quota and owner away work in tests.
- Codex tests pass `test.codexConfig` as `-c` flags; no `config.toml` is written.
- The adapter tests use the same switches through their constructors.
- Test mode posts no macOS notifications.

**Scripted servers:**
- They answer from request content (the session or thread id, the last tool_use id, markers from the brief), never from request order.
- They accept `system` entries in the message list (Claude folds mid-turn messages in that way) and extra user messages after tool results.
- Both expose one shape, `{ url, requests, setHandler(fn) }`, with parsed requests and reply builders: `startScriptedAnthropic` and `claudeTestEnv` (M2d), `startResponsesServer` and `codexTestConfig` (M2e). Auxiliary requests (token counts, titles, summaries) get a harmless default answer.
- Codex tests use the pinned model slug and record its tool surface. That slug runs Code Mode, so Codex tool replies are `exec` calls built by M2e's builders.
- Both CLIs run behind a refusing `HTTPS_PROXY` (testkit's `startRefusingProxy`, which M2b creates with the testkit), and the tests assert that no external connection succeeded.

## 16. Out of scope and deferred

- **M3:** checks, tamper and scope scans, reviewers, PRs, the merge queue and the acceptance attestation.
- **M3 hardening:** storing the CLI token in the macOS keychain with an ACL that admits only the agflow binary.
- **M4:** usage accounting in tokens or money (usage dashboards) and repository-derived context.
- **M3, with reviewers:** `rebut_review` (spec §18 #5).
- **Later:**
  - "approve for this attempt" (Codex `acceptForSession`);
  - handing a taken-over task back "to me", bound to the person's live chat;
  - a mid-turn approval relay for Claude (`canUseTool` through people);
  - Linux service files (systemd);
  - editing profiles in the UI. M2 shows profiles; owners edit `runner.json`.

## 17. Spec changes

| Section | Change |
|---|---|
| §5.3 / core `TASK_TRANSITIONS` | Adds `rejected → blocked`, `ready → failed` and `blocked → failed`. |
| §5.4 | Runner files in a clone live in `.agflow/run/` (`task.md`, `brief.md`). |
| §6.1 | Per-attempt clones and the vault replace the mirror with linked worktrees. WIP goes to per-attempt refs. Dependency preparation. Checks move to M3. |
| §6.2 | Section 8 replaces the drive, session, context and permissions bullets. |
| §6.3 | Section 9 replaces it. No `exec` fallback. |
| §6.4 | Continuation is runner-side, per role (section 6.8). |
| §6.6 | Section 6.7. |
| §6.7 | Runner lease versus stall decisions, the trigger table (section 6.4) and section 6.8. |
| §6.8 | Section 6.6, with quota per account. |
| §6.9 | Section 7.6 profiles. Claude defaults to `acceptEdits` with the sandbox, and auto mode is opt-in. The runner answers no approval itself. |
| §6.10 | Section 6.10. |
| §7.1, §7.6 | The lead seat record. Leads on runners. |
| §11.1 | The agent-token route allowlist. |
| §11.2 | Section 6.3. |
| §12 | Section 5 and section 6.5. |
| §13 | Recovery window, clock jumps, epochs, late work. |
| §14 | Section 15. |
| §15 | `packages/runner`, `packages/testkit`. |
| §16 | M2 scope as in section 2. |
| §17 | Question 3 answered: the `projects.<path>.trust_level` override as a nested object. |
| §18 | #1–#4, #5 except `rebut_review` (moved to M3 with reviewers), #6, #7, #11, #12 and #14–#16 resolved by this document. #2 adds dependency preparation in a sandbox. |

## 18. What the design review changed

Revision 2 applies the review's upheld findings. The main changes:

**Security:**
- The runner never auto-approves an escalation, because an approved command runs outside the sandbox.
- Managed policy is detected with `configRequirements/read` and fails closed.
- Agent tokens work only on an allowlist of routes, and lead authority comes from the seat.
- Claude bridge tools are allowed explicitly, the sandbox is a top-level option, and `Edit` and `Write` are confined.
- Codex apps, plugins and personal skills are removed, and only-agflow checks run on every start.
- Take-over replaces the agent's `.git`.
- Approval ids are minted by the runner and fenced.
- Runner keys are bound to their owner and machine.
- Agent text is always quoted.
- The deny lists cover the runner's state and other clones, with a per-attempt temporary directory.

**Correctness:**
- Commands are cancelled with their attempt, a journal makes execution once, and lifecycle work runs on per-attempt queues.
- Events are applied in savepoints and always acknowledged, and a restored hub catches up through retained events.
- There is one table of attempt endings, with exit-before-end invariants, and two-phase submit is ordered against stops and leases.
- `heartbeat_ack`.
- Facts must be fresh before a stall is judged.
- Quota waits keep their lease.
- Final WIP comes before `attempt.exited`, and late work goes to its own refs.
- Restores move WAL files aside and advance epochs and counters.
- Clock jumps are treated as downtime.
- Every M1 operation and live-chat attempt is mapped.

**Operations:**
- Quota is tracked per account, with ceilings and paid-usage protection.
- Vendor errors are separate from quota and stalls, and continuation follows only completed turns.
- The runner owns its vendor binaries.
- launchd suspend semantics, a single-instance lock, `needs_login` and a crash-loop guard.
- Service-environment checks run inside the service.
- Keep-awake on AC power, and battery handling.
- Owner-away handling and notifications.
- Retention and a disk guard on laptops and on the hub.
- Protocol versioning.
- Take-over from elsewhere.
- Dependency preparation in a sandbox.
- Test mode, with every duration configurable.

**Plans** grow from six to seven: the runner work splits into core (M2b) and operations (M2c).

**Revision 3** applies a re-check of revision 2, which looked at three things: coverage of every upheld finding, internal consistency, and the feasibility of new claims. It made these changes:
- **Task moves.** Trigger-table moves are conditional on the task's state. Take-over has one commit point. Runner stops and suspends are separate causes.
- **Shared vocabulary.** One `StopCause` vocabulary is shared by the hub and the runner. Submission outcome codes, timeouts and deferred stops are defined.
- **Resumes.** Resume semantics are defined: the attempt goes back to `starting`, and a live process is stopped before it is resumed.
- **Deny rules** no longer cover the agent's own clone.
- **No lost work.** Late work respects the work-position lineage, and a failed final push no longer loses work.
- **Settings.** Every duration is configurable, and the hub sends the timings that both sides must share.

**Revision 4** settles the cross-plan questions of the seven plan outlines. These are its contract clarifications:
- **Runner link.** `hello.lastSeq`; restore reconciliation waits for the replay, and replayed events with a newer fence count as current. `welcome.timings.wipGraceMs`. Settings sync: `hello` carries the hub-confirmed snapshot, and local edits travel only as `runner.settings`. A retired runner gets 4403. The `LiveAttempt` states are defined.
- **Commands and events.** 17 command kinds, each in `COMMAND_MIN_PROTOCOL`. Closed code lists in core, including `START_REFUSALS`; a refusal stops placement on that runner until its next heartbeat. `attempt.prepared.requestId` and `attempt.quota.accountId` may be null. `messageId` 0 marks hub text, and the runner writes the "more messages" line. `attempt.quota` with state `ok` ends `quota_wait`. `attempt.wip_failed.failures` counts over the whole runner.
- **Types and API.** `Attempt.takeover.ref`, `TaskNote.attemptId`, `Runner.acceptingUntil`, `LeadNote`, `PrepareRequest`, and `HubStatus.epoch` (with `HubStatus.lead` kept). Response keys, limits and the runner PATCH bounds. Event subjects and data, plus `task.refs_deleted` and the `guard.*` events. `APPROVALS_ROUTE`, `CredentialsSchema` and `TEST_ACCOUNT_ID` in core.
- **Runner.** `canPushWip` with its grace period. `resolveRestoreBase`: the hub sends a ref. The orphan kill and sweep on an unrequested exit. Resumes use the attempt's CLI version. One reconnect nudge. The `hand_back` error `process_running`. Submission retries capped by `submitRetry`. New runner timings and minimums. `agflow runner status --json`. The exit policy for refusals that need a person, and how `crash_loop` clears.
- **Adapters.** `PreflightResult` (with `weakened`), `deleteTranscript`, the optional `enrichApproval`, `AgentLaunch.cliVersion` and `projectConfigVerified`, `tool_ended.hubUnreachable`, the agflow command passed to adapter factories, and `createAdapters` with one entry file per vendor. The runner core builds the take-over commands. Claude's preflight reads the experimental usage call. Codex sends `approvalsReviewer: 'user'` and runs an unverified clone `untrusted`.
- **Hub.** Unknown agent tokens after a restore get `attempt_refenced`, and the 401 body names the end reason. M1 operations keep their M1 preconditions. A rule for a second stop request, and a row for stopping a runner lead. `startHub` options. Hub test mode (`AGFLOW_TEST_CONFIG`) and minimums. Retention runs outside the tick, and the first hourly backup an hour after start.
- **Plans.** A staged, parallel execution order (section 14).
- **Test mode and the web bundle.** Codex tests pass `test.codexConfig` as `-c` flags and write no `config.toml` (15.1). `packages/web` imports values only from zod-free core modules and checks the zod modules' values in its tests, so zod stays out of the browser bundle.

**Accepted plan-review clarification (2026-11-11): settings sync.** Section 6.3 records the runner-only rule retained for M2: content-matched echoes, versioned answers, refusal probes, command lineages and restore replay filtering. Its Known limits include settings lost or diverging after a restore; a person may need to redo a local setting. The exact fix belongs to a later milestone: `update_settings` carries `answers {seq, refused?}`, refusals are explicit, `hello` names the highest answered `runner.settings` seq, and a restored hub adopting the snapshot skips those edits. That requires coordinated core and hub changes; it is not an M2 protocol promise.

**Other accepted plan-review clarifications (2026-11-11).**
- **X-49 (§6.1, §6.12).** A refused start sets `Runner.stateDetail` to `refused a start: <code>` until the next heartbeat. `Attempt.stopRequested.by` is `user:<login>`, `agent:<id>`, or `system`. A pending clone hand-back records `handingBack` with `by=user:<login>` and `at` in epoch milliseconds; another otherwise-authorized hand-back receives `409 handback_pending`. Completion, refusal or timeout clears it. A fallback without returned clone work emits `task.ready` with `{ from, attemptId, reason }`, not `task.handed_back`. Core exports `reportHolds` and `utilization` for the runner card.
- **Recovery and late work (§6.4, §6.14, §7.4).** Daily backups run once per UTC day. Pending late work is durable before the exit event, retried after restart and pushed before cleanup, even without a clone. A failed cleanup retains its work for retries. A push of the submitted head after the attempt ended creates no late-work note or merge message; on a non-WIP ref it still emits `attempt.late_work` for retention. **Known limit:** the timeline labels this submitted-head event as late work even though there is nothing new; a distinguishing event flag is deferred.
- **Bridge and Codex (§9.2, §10, §13).** The bridge and brief hook cannot autoload Bun config or dotenv from a clone. MCP cwd is explicit. `AgentLaunch.bridge.tools` supplies persistent Code Mode tool discovery. Untrusted Codex skips project config, hooks and exec policies but still loads project skills. MCP startup notifications cover servers omitted from the status list; verified project config remains trusted code running outside the sandbox.
- **Claude (§3, §5, §7.6, §8.1–§8.2, §15).** The system-prompt preset is explicit, with `CLAUDE_BASH_NOTE`. A resumed first-turn mismatch is an exit. Read denials target individual clones so package scripts can resolve their parents; computed Git subcommands fail closed, and legitimate complex shell operations use the sandboxed script fallback. The shell-profile mitigation is implemented: the adapter sets `ZDOTDIR=<claudeHome>/agflow-empty`, drops any incoming `CLAUDE_CODE_SHELL`, and sets `CLAUDE_CODE_SHELL=/bin/zsh` unless the basename of `SHELL` is already `zsh`. Only the snapshot sources `~/.zshrc` outside the sandbox, once per Claude process; `~/.zshenv`, `~/.zprofile`, `~/.zlogin` and `~/.bashrc` do not run around agent commands. The snapshot remains an accepted residual risk. Carrying a resume's first message in `AgentLaunch` is future work.
- **Deferred cleanup.** The web's fixable-submit flags keep their parity test; moving the core re-export to avoid bundling zod is a later-milestone change, with no M2 contract change.

Later contract changes are recorded here the same way.

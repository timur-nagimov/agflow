# agflow — design spec

- **Date:** 2026-10-26
- **Status:** draft for review
- **Covers:** v1, milestones M1–M4

## 1. Summary

agflow connects many Claude Code and Codex agents into one project with one goal. Some agents are started by agflow itself; others are teammates' own live chats. A lead manager agent, optionally helped by area managers, turns the goal into tasks. Agents on teammates' laptops do the work. agflow decides from evidence when a task is done and merges it. People watch everything in a web UI, edit the goal, and steer with messages at any time; otherwise the system runs on its own.

agflow is a thin "project brain". It builds only what the CLIs do not provide — shared project state, scheduling, context, validation and the UI — and drives Claude Code and Codex through their official interfaces.

## 2. Goals and non-goals

**Goals**

- One project, one goal, many agents from both vendors, coordinated by manager agents.
- Any agent can be replaced at any moment without losing work.
- agflow starts agents on demand, assigns tasks and validates results without human approval.
- A new agent becomes productive quickly from a small, fresh, task-specific context.
- A small team sees and controls everything through a web UI.

**Non-goals for v1**

- A hosted or multi-tenant service. Each team runs its own hub.
- API keys or pay-per-token usage. The hub runs no models.
- Agents on servers, VMs or containers. Laptops only.
- Arcadia/arc. Git only (GitHub or GitLab).
- Replacing the CLIs' own multi-agent features. Agents may still use them internally.
- Embedding-based semantic search. v1 uses structured retrieval and text search.

## 3. Requirements

| # | Decision |
|---|---|
| R1 | Users: one person plus a small team, sharing one hub. |
| R2 | Autonomy: full. People steer at any time with messages and goal edits. |
| R3 | One project is one git repository on GitHub or GitLab. It holds code and research results. |
| R4 | Agents run only on teammates' laptops, through the official `claude` and `codex` CLIs, using each person's own subscription login. No API keys. |
| R5 | Workers are agents started by runners and teammates' live interactive chats. |
| R6 | A web UI shows live agents, tasks and progress, and lets people edit the global goal. |
| R7 | The hub runs on a small shared server and runs no models. |
| R8 | One lead manager plus optional area managers, at most two levels. |
| R9 | "Workflows" means two things. First, the plan itself — the task graph — which people edit by changing the goal and sending steering messages. Second, any agent may carry out its task with its CLI's own multi-step features (Claude Code dynamic workflows, Codex goals). Reusable process templates ("research → decide → build → cross-review") can be added in M4 if needed. |

## 4. Architecture

```
            Web UI: goal · board · agents · runners · timeline · steering chat
                                     │ HTTPS (SSE for live updates)
                      ┌──────────────▼───────────────┐
                      │     agflow hub (server)      │
                      │ state + event log (SQLite)   │
                      │ scheduler · context compiler │
                      │ validation records · REST    │
                      └──▲───────────▲───────────▲───┘
          runner link (WSS,│           │           │ MCP (via local bridge)
          outbound only)   │           │           │
              ┌────────────┴──┐  ┌─────┴─────────┐ ┌┴──────────────────┐
              │ runner        │  │ runner        │ │ teammate's live   │
              │ (laptop A)    │  │ (laptop B)    │ │ chat (agflow join)│
              │ claude, codex │  │ claude, codex │ └───────────────────┘
              │ worktrees     │  │ worktrees     │
              └───────┬───────┘  └───────┬───────┘
                      └───── git push / PR / merge ─────► GitHub or GitLab (+ CI)
```

| Component | Runs on | Responsibility |
|---|---|---|
| Hub | Small shared server | Source of truth for project state and the event log. Scheduler, leases, budgets, context compiler, validation records, REST API with live events, web UI, runner gateway. Holds no AI keys and no git credentials. Agents get MCP tools from the local bridge (`agflow mcp`), which calls this API. |
| Runner | Each teammate's laptop | Starts, drives and stops agents. Manages worktrees. Pushes, opens PRs and merges with its owner's existing git login. Runs checks. Streams events to the hub. |
| Agent | Laptops | A Claude Code or Codex session with one role: lead, area manager, worker, reviewer or curator. |
| Live chat | Laptops | A teammate's interactive Claude Code or Codex session connected with `agflow join`. |
| Git host | GitHub or GitLab | The repo, one PR per task, CI. |

Two principles shape everything below:

1. **Code owns invariants; agents own judgment.** Only the hub changes task state, leases and budgets, and only the merge queue merges. Agents propose plans, results and verdicts; the hub checks proposals before applying them.
2. **Agents are disposable; state is durable.** Anything that matters is stored in the hub or the repo. Knowledge that exists only in a chat transcript is treated as lost when the agent is replaced.

## 5. Domain model

### 5.1 Entities

| Entity | Meaning | Key fields |
|---|---|---|
| Project | One git repo | Repo URL, main branch, caps, permission defaults, protected paths |
| Goal | The global goal, versioned | Text (objective, success criteria, constraints), version, author, diff from previous version |
| Milestone | A checkpoint toward the goal | Exit criteria, status |
| Area | A workstream with its own manager (M4) | Name, scope (paths and topics), manager, share of agent slots, status |
| Task | A unit of work in a dependency graph | The task contract (§5.2), status, area, milestone, attempts |
| Attempt | One agent's try at a task | Task, number, agent, vendor and model, runner, session or thread ID, fencing token, outcome, failure class, usage |
| Agent | A worker identity, not a process | Role, vendor and model, origin (runner or live chat), current attempt, status, usage |
| Runner | A laptop that hosts agents | Owner, logged-in vendors and CLI versions, capacity, permission profile, online state, quota state per vendor |
| Message | Steering, questions, answers, feedback | From, to (lead, area manager, agent, task thread or everyone), body, standing-rule flag, delivered and acknowledged times |
| Decision | A recorded design decision | ID, title, status, scope (area or cross-area), file path in `docs/decisions/` |
| Learning | A proposed lesson | Claim, evidence, path scope, source attempt, curation status |
| Event | Append-only record of every change | Type, actor, subject, payload, time; feeds the UI, audit and replay |

### 5.2 Task contract

Written by a manager. Frozen at dispatch: agents cannot change it, and only a manager can amend it, which creates a new revision.

```json
{
  "id": "T-042",
  "kind": "code | research | review | curation",
  "area": "backend",
  "milestone": "M2",
  "title": "Add token refresh to the auth client",
  "objective": "Refresh expired access tokens transparently in the auth client",
  "why": "Users are logged out every hour (goal success criterion 3)",
  "non_goals": ["Changing the token format"],
  "acceptance": [
    { "id": "A1", "assertion": "Expired tokens are refreshed once and the request is retried",
      "evidence": { "kind": "command", "cmd": "bun test src/auth", "expect": "exit 0" } },
    { "id": "A2", "assertion": "Refresh failures surface a typed error",
      "evidence": { "kind": "review", "rubric": "The error type is exported and documented, and callers can tell a refresh failure from a network failure" } }
  ],
  "checks": [ { "name": "unit", "cmd": "bun test", "timeout_s": 900 } ],
  "owned_paths": ["src/auth/**", "tests/auth/**"],
  "protected_paths": ["tests/auth/contract/**"],
  "depends_on": ["T-040"],
  "priority": 2,
  "budget": { "wall_min": 120, "max_turns": 250, "max_attempts": 3 },
  "vendor_hint": "any | claude | codex",
  "base_commit": "<sha>",
  "goal_version": 7
}
```

Evidence kinds are `command` (exit code and optional output match), `artifact` (a file that must exist and pass a check) and `review` (judged by the reviewer against a rubric).

### 5.3 Task lifecycle

```
draft → ready → claimed → working → submitted → checking → reviewing → accepted → merging → merged
                  ▲                                  │            │
                  └───────── rejected (feedback) ◄───┴────────────┘
any active state → stale (lease expired) → handoff → ready
any state → blocked (waiting on a person or another task) → ready
any state → cancelled (goal changed or a manager decided)
retry ladder exhausted → failed (people are notified)
```

- `draft`: proposed by a manager; plan checks (§9.2) have not passed yet.
- `ready`: plan checks passed, dependencies merged, and no running task owns an overlapping path.
- Only the hub moves a task between states.

M2 adds `rejected → blocked`, `ready → failed` and `blocked → failed` for re-planning and exhausted retries. The [M2 retry ladder](2026-10-28-m2-runners-design.md#69-retry-ladder-the-m2-part-of-spec-95) defines when these transitions apply; runner-attempt endings follow the [M2 trigger table](2026-10-28-m2-runners-design.md#64-attempts-fencing-and-leases).

### 5.4 Where state lives

| Store | Contents |
|---|---|
| Hub database (SQLite) | Tasks, attempts, leases, agents, runners, messages, budgets and the append-only event log. Backed up daily; exportable. |
| Repository | Durable shared knowledge: `AGENTS.md`, `CLAUDE.md` (a single line, `@AGENTS.md`), `docs/goal.md` (mirror of the current goal), `docs/decisions/`, `docs/research/`, `docs/architecture.md`, skills. |
| Each attempt clone (untracked) | Runner files live in `.agflow/run/`, including `task.md` and `brief.md`; never committed. See the [M2 runner layout](2026-10-28-m2-runners-design.md#72-layout). |

From M3, the merge queue (§9.6) commits `docs/goal.md` whenever the goal version changes. Until then the goal lives only in the hub.

## 6. Runners and agents

### 6.1 Runner

The runner supervises agents in standalone per-attempt clones, backed by a runner-owned vault. WIP goes to per-attempt refs; only the runner pushes. See [M2 git isolation and WIP](2026-10-28-m2-runners-design.md#73-git) and [sandboxed dependency preparation](2026-10-28-m2-runners-design.md#77-dependency-preparation).

Foreground operation and the macOS service follow the [M2 runner lifecycle](2026-10-28-m2-runners-design.md#71-setup-service-and-lifecycle). Verification checks, PRs and merging move to M3; see [M2 scope](2026-10-28-m2-runners-design.md#2-scope).

### 6.2 Claude Code adapter

The Claude Agent SDK drives a long-lived session with a persistent message inbox, the runner's subscription home and a command hook for the brief. Drive, session, context, permissions and recovery follow the [M2 Claude Code adapter](2026-10-28-m2-runners-design.md#8-claude-code-adapter).

### 6.3 Codex adapter

Each attempt uses a private `codex app-server` process. There is no exec fallback. Thread setup, project trust, context, messages, quota, approvals and recovery follow the [M2 Codex adapter](2026-10-28-m2-runners-design.md#9-codex-adapter).

### 6.4 Continuation without hooks

The runner continues workers after eligible completed turns; leads receive no continuation. The hub decides stalls from the runner's facts. Eligibility, outage handling and budgets follow [M2 continuation and stall detection](2026-10-28-m2-runners-design.md#68-stall-detection-continuation-replacement-and-handoff).

### 6.5 Live chats (`agflow join`)

`agflow join`, run in a teammate's own checkout:

- adds the agflow MCP bridge (`agflow mcp`) to Claude Code (`.claude/settings.local.json`, untracked) and/or Codex (user config);
- installs hooks:
  - `SessionStart`: injects the brief;
  - `UserPromptSubmit`: adds unread messages as context;
  - `Stop`: if messages are waiting, continues the turn with them; if the chat holds a task that is neither submitted nor declared blocked, reminds it;
- asks the person to trust the hooks once in Codex (`/hooks`), as Codex requires.

A live chat can list, claim and submit tasks and goes through exactly the same validation as other agents.

Identity is keyed on the CLI session:
1. The `SessionStart` hook registers the session (vendor plus session id) with the hub. It receives a brief that contains a short hello code.
2. The model calls the MCP tool `hello(code)`. This binds that session's bridge to the agent, and from then on the bridge names the agent on every call.
3. Hooks look the agent up by session id.

Process ancestry and environment variables are not used: the shared Codex daemon runs every session's hooks and MCP servers under one process and one environment. After a restart, the same person can re-attach a claim from an old session with `resume_claim`.

When a live chat claims a task, the bridge creates the task branch `agflow/T-<id>-<slug>` in a separate worktree. It then pushes the branch on `submit`, which carries the branch and head commit. agflow only delivers messages addressed to that chat, and it never answers a live chat's permission or approval prompts.

### 6.6 Message delivery

| Target | Path |
|---|---|
| Agent started by a runner | Pushed through the runner with delivery and acknowledgement tracking; see [M2 message delivery](2026-10-28-m2-runners-design.md#67-message-delivery-to-runner-agents) for batching, backlog and authority rules. |
| Live Claude chat | `Stop` and `UserPromptSubmit` hooks. Best-effort immediate delivery to an idle chat through its session inbox socket (works, but the message format is undocumented). |
| Live Codex chat | Hooks. Best-effort immediate delivery through the shared Codex daemon (not yet verified live). |

- Messages from other agents are wrapped as quoted information. For Codex they are sent with tool-level authority, below user instructions.
- Every message records when it was delivered and acknowledged. The UI shows both.

### 6.7 Leases, liveness and replacement

A runner lease measures laptop presence and is renewed by heartbeats. Stall decisions belong to the hub and use fresh attempt facts. Attempt endings, fencing and task moves follow the [M2 trigger table and lease rules](2026-10-28-m2-runners-design.md#64-attempts-fencing-and-leases); replacement, crashes, handoffs and successor context follow [M2 stall detection and handoff](2026-10-28-m2-runners-design.md#68-stall-detection-continuation-replacement-and-handoff).

Live chats retain their M1 task leases, as distinguished in the same lease rules.

### 6.8 Scheduling and requesting agents

The hub reconciles attempts and auto-fills ready work within the worker target and runner capacity. Placement uses quota per account, shared across that owner's runners. Ordering, eligibility, vendor preferences and `request_agents` follow the [M2 scheduler](2026-10-28-m2-runners-design.md#66-scheduler).

### 6.9 Permission profiles

Claude defaults to `acceptEdits` with the sandbox; `auto` mode is opt-in. Codex uses `workspace-write`. The runner never decides an approval itself. Profiles, filesystem and network limits, and the agent environment follow [M2 profiles](2026-10-28-m2-runners-design.md#76-agent-environment-and-profile); requests that need an owner follow the [M2 approvals relay](2026-10-28-m2-runners-design.md#610-quota-and-approvals).

### 6.10 Accounts and usage limits

Runners use their owner's subscription logins in runner-specific vendor homes; credentials stay on the laptop. Quota is shared per owner, vendor and account, with per-runner ceilings and paid usage disabled by default. Quota waits, reset handling and owner-only approval decisions follow [M2 quota and approvals](2026-10-28-m2-runners-design.md#610-quota-and-approvals).

## 7. Managers, steering and the goal

### 7.1 Roles

| | Lead manager (exactly one, holding the lead seat) | Area manager (zero or more, one per area; M4) |
|---|---|---|
| Plans | How the goal is read, milestones, which areas exist and their scopes | Tasks inside its area |
| Staffing | Splits agent slots between areas and rebalances them | Requests agents within its share; asks the lead for more |
| Decisions | Interfaces between areas; conflicts between areas | Decisions local to its area |
| Escalates to | People | The lead |

- At most two levels.
- Until areas exist, the lead plans tasks directly.
- Work that crosses areas is a task created by the lead.

The **lead seat** is an explicit hub record (`lead_agent_id`, `lead_kind`, `lead_since`); holding it grants lead authority, never the agent's role column. Both live and runner leads use it. Runner leads idle between wake-ups, rotate with a handoff and fail over on another runner; see [M2 §6.11](2026-10-28-m2-runners-design.md#611-the-lead-on-runners) for seat ownership and lifecycle.

### 7.2 Wake-ups

Managers run on events, not in a loop. The hub wakes a manager when:

- the goal changed;
- a person messaged it;
- an agent asked it a question;
- a task in its scope was rejected repeatedly, failed or became blocked;
- a milestone completed;
- a budget threshold was crossed;
- the periodic review is due (every 45 minutes while work is active).

Each wake-up starts with a situation report of at most 8,000 characters:

- the current goal and goal version;
- milestone status;
- a board summary for the manager's scope;
- events since its last turn;
- quota and budget status;
- open questions.

### 7.3 Manager tools and decision rights

Managers get the worker tools (§11.1) plus:

| Group | Tools |
|---|---|
| Planning | `create_tasks` (batch), `update_task`, `cancel_task`, `reprioritize`, `create_milestone` (lead), `create_area` and `update_area` (lead) |
| Staffing | `request_agents`, `release_agents`, `replace_agent` |
| Communication | `send_message`, `answer`, `broadcast`, `notify_humans` |
| Judgment | `accept_task` and `reject_task(feedback)` (manual acceptance in M1–M2; from M3 the hub accepts automatically), `accept_decision`, `resolve_review_dispute`, `add_hidden_check` (M4) |
| Status | `get_board`, `get_events(since)`, `get_usage` |

Enforced by hub code, not by prompts:

- No manager can exceed caps or budgets.
- No manager can accept work whose required checks failed, or merge directly.
- No manager can edit the goal. Managers may attach interpretation notes, which the UI shows next to the goal.
- An area manager cannot create tasks outside its area's scope.

### 7.4 Editing the goal

1. A person edits the goal in the UI, which shows a diff preview, and saves it as version n+1.
2. The hub wakes the lead with the diff and the list of open tasks planned against older versions.
3. The lead adjusts milestones and areas and decides, for each affected task, whether to keep, amend or cancel it. Affected area managers then re-plan their own tasks (M4).
4. Agents on cancelled tasks are told to stop and push their work. Agents on unaffected tasks continue without interruption.
5. The UI timeline shows the plan diff together with the lead's note on what changed and why.

### 7.5 Steering

- The steering chat in the UI targets the lead (default), an area manager, one agent or a task thread.
- A message to an agent is also visible to that agent's manager, so the plan stays consistent.
- A message marked as a **standing rule** ("always use pnpm", "don't touch billing/") is added to every later brief and listed in the UI, where people can remove it.
- Every agent is told that instructions from people take precedence over instructions from managers.

### 7.6 Guards

At most one lead holds the [lead seat](2026-10-28-m2-runners-design.md#611-the-lead-on-runners). The M1 creation limits remain; M2 adds a churn budget for mutating planning calls. Exhausting one task's attempt limit triggers that task's re-plan, rather than a project-wide pause. The counted calls, limits and dispatch pause are defined in [M2 §6.15](2026-10-28-m2-runners-design.md#615-guards).

People can pause the project; area controls arrive with area managers in M4.

## 8. Context system

### 8.1 What every agent receives

| Layer | Delivered how | Content |
|---|---|---|
| `AGENTS.md` | Committed; read natively by Codex and through `CLAUDE.md` by Claude Code | About 100 lines: one-line goal, build and test commands, directory map, rules of engagement, pointers to deeper docs |
| Task pack | `.agflow/task.md` in the worktree, plus `get_task` | Objective and why; acceptance criteria and check commands; scope and non-goals; owned paths; relevant decisions; up to 20 relevant files with a one-line reason each; known pitfalls for those paths; previous attempts and handoff notes; budget; base commit |
| Brief | Produced by `agflow brief`, at most 8,000 characters | Role, area, task status, current goal version, standing rules, decisions made since the task was planned, unread messages, other agents' reserved paths |

The brief's limit stays under both CLIs' context-injection limits: Claude Code caps hook context at 10,000 characters, and Codex spills hook context to a file above about 2,500 tokens.

### 8.2 On demand

MCP tools give access to: the full goal; architecture notes; decision search; glossary; a generated repo map with a size budget; the research index; pitfalls for a path; other tasks' status; and predecessors' handoff notes and transcript excerpts.

### 8.3 Role-specific views

- **Managers** receive the situation report (§7.2) instead of a task pack.
- **Reviewers** receive only the contract, the diff against the base commit and the check evidence. They never see the author's reasoning.

### 8.4 How knowledge spreads

- **Decisions.** The hub allocates the next number (`allocate_decision_id`). The agent writes `docs/decisions/NNNN-<slug>.md` in its task branch, and the record merges with the task. Cross-area decisions need the lead's acceptance before the task can be accepted. Agents whose tasks are affected get a one-line notice.
- **Learnings.** `propose_learning(claim, evidence, scope)` puts an entry in the inbox. The lead or a periodic curator task verifies it and moves it to the right home: a nested `AGENTS.md` for pitfalls, a skill for procedures, a decision record for decisions. Unverified claims never reach shared context.
- **Research results.** These go to `docs/research/<topic>.md` with a standard header — question, answer, evidence, date, confidence — and are indexed for search.

### 8.5 Freshness

- **Context linter.** Runs in the merge queue (M4) and checks that:
  - `AGENTS.md` stays within its size budget;
  - every path and command mentioned in `AGENTS.md` and in skills exists;
  - the decision index is complete;
  - the repo map has been regenerated.
- **Curator task.** Runs periodically, compares docs with code and files small fix-up tasks.

### 8.6 Kept out of shared context

- Secrets.
- Facts that can be read from the code; a pointer goes in instead.
- Values that change often, outside the brief.
- Raw logs, which are saved as files and referenced by path.
- Unverified claims from other agents.

Messages from agents are information, never instructions that override people and never approval.

## 9. Validation and merging

### 9.1 Rule

An agent never decides that its own work is done. From M3, the hub computes "done" from evidence it collects itself. In M1 and M2, the lead accepts or rejects submissions with `accept_task` and `reject_task`.

### 9.2 Plan checks before dispatch

**Structural checks**, run by code:

- the dependency graph has no cycles;
- tasks whose owned paths overlap are flagged, and the scheduler never runs them at the same time;
- every acceptance criterion has evidence;
- check commands exist;
- budgets are within caps;
- each task stays inside its area's scope.

**Plan critic.** Large re-plans — a new milestone, or more than 10 tasks at once — also get a fresh critic from the other vendor (M4).

### 9.3 Submission pipeline

| Step | What happens | Who runs it |
|---|---|---|
| 1. Checks | Build, tests, lint and the task's `checks` on a clean checkout of the branch. Your CI on the task's PR also counts if it exists. | Runner (verification worktree) and CI |
| 2. Tamper scan | Protected paths and existing tests restored from or compared with `base_commit`. Flags deleted or skipped tests, fewer assertions, special-casing, and edits to CI or CLI config. | Hub (on a diff the runner provides) |
| 3. Scope check | The diff stays inside `owned_paths`, plus any decision records allocated to this task. | Hub |
| 4. Hidden checks (M4) | Extra acceptance tests the worker never saw, stored in the hub. | Runner |
| 5. Review | A fresh reviewer from the other vendor gets the contract, the diff and the evidence. It returns a verdict, findings, and a state for each acceptance ID: proven, contradicted or unverified. A blocking finding needs a reproduction: a failing test or command. Findings without one are advisory. The author may make one evidence-based rebuttal. | Agent on a laptop |
| 5r. Research review | For `kind: research`: the question is answered; every claim cites a source; conclusions follow from the evidence; the reviewer re-runs a sample of the queries and checks a sample of the citations. | Agent on a laptop |

If no runner offers the other vendor, the review uses the same vendor with a different model and a fresh context, and the evidence log records this.

### 9.4 Done

A task is `accepted` when all of the following hold:

- every check passes on the branch rebased onto current main;
- the tamper scan is clean;
- every acceptance ID is proven with an evidence reference (log hash, artifact path or reviewer statement);
- the reviewer approved, or all confirmed findings were fixed;
- the budget was not exceeded.

The evidence log is shown on the task's page.

**Escape hatch.** An agent may call `declare_impossible(evidence)` when the task cannot be done as specified or the spec contradicts itself. The task becomes `blocked` and its manager decides.

### 9.5 Retry ladder

Each failure is classified as infrastructure, check failure (with check and test name), stall, review rejection, budget, or impossible claim.

1. The same session gets the failure output and fixes it, up to 2 rounds.
2. A fresh agent of the same vendor continues from the handoff note.
3. A fresh agent of the other vendor continues from the handoff note.
4. The manager re-plans: it splits, clarifies or cancels the task.
5. People are notified and the task becomes `failed`.

Infrastructure failures retry with backoff and do not use up attempts. After 3 identical failure signatures, the ladder jumps to step 4.

### 9.6 Merge queue

- **One PR per task** on GitHub or GitLab. This gives an audit trail and runs CI.
- **One queue, one merge at a time.** For each accepted task it:
  1. rebases onto current main;
  2. re-runs the checks on the result;
  3. merges through the git host's API;
  4. updates `docs/goal.md` if the goal version changed.
- **Where it runs.** On an online runner, using that runner owner's git login. If no runner is online, merges wait.
- **Rebase conflict.** The task returns to `rejected` with the conflict as feedback, on the same branch.
- **Early conflict detection.** While a task is in progress, a periodic `git merge-tree` probe against main warns about conflicts.
- **Milestone check.** At each milestone, integration tests run on main and the lead reviews the interfaces between areas.

### 9.7 Protected paths

| Path class | Who may change it | Default paths |
|---|---|---|
| People only | Tasks created by a person | `.github/workflows/**`, `.gitlab-ci.yml`, `.gitlab/**`, `.claude/**`, `.codex/**`, `.mcp.json`, `.agflow/config*`, `.env*`, `*.pem`, `*.key` |
| Curators only | Tasks of kind `curation` | `AGENTS.md`, nested `AGENTS.md`, `CLAUDE.md`, `.agents/skills/**`, `.claude/skills/**` |

`docs/goal.md` is written only by the merge queue.

People-only protection matters because headless `claude -p` runs a repository's own hooks and MCP servers without a trust prompt, so editing them is equivalent to running code on teammates' laptops.

The project's branch protection must allow teammates' accounts to merge after the hub has proven the task done.

## 10. Web UI

| View | Shows | Actions |
|---|---|---|
| Goal | Current goal, history with diffs, lead's interpretation notes, milestone progress, alerts | Edit goal, pause or resume everything |
| Board | Tasks by status, grouped by area and milestone | Open a task: contract, evidence log, attempts, handoff notes, PR link, message thread |
| Agents | Live list: role, vendor and model, runner, current task, status, last activity, usage | Message, pause, stop, replace, take over (shows the resume command) |
| Runners | Online state, free slots, logins, quota state, keep-awake | Owner only: change capacity, profile and keep-awake |
| Timeline | Goal edits, plan diffs, decisions, merges, failures, escalations | Filter |
| Steering chat | Conversations with the lead, area managers, agents and task threads | Send; mark as standing rule |
| Knowledge | Decisions, learnings inbox, research index, standing rules | Remove a standing rule |

Live updates arrive over SSE from the hub's event log. Every person on the team has the same rights in v1.

## 11. Interfaces

### 11.1 MCP tools

All agents reach the hub through a local stdio bridge, `agflow mcp`. For agents started by a runner, the bridge uses the agent's scoped credential, which the runner passes in the agent's environment. For live chats, it uses the person's CLI login, and the hub treats a call as an agent's only after `hello`. No tokens are written into CLI config files.

Human authority is never inferred from a CLI login, because agents on the same laptop can reach it. The following are accepted only from a browser session:
- goal edits,
- standing rules,
- pausing the project,
- forced releases,
- approving CLI logins.

| Role | Tools |
|---|---|
| Worker | `get_task`, `get_brief`, `report_progress`, `ask`, `check_inbox`, `reserve_paths`, `release_paths`, `submit(summary, evidence[])`, `declare_blocked`, `declare_impossible`, `write_handoff`, `allocate_decision_id`, `record_decision`, `propose_learning`, `search_context`, `get_decisions`, `get_repo_map(path, budget)`, `list_tasks`, `claim_task` and `resume_claim` (live chats only) |
| Reviewer | `get_review_packet`, `submit_review(verdict, findings[], criteria[])` |
| Manager | Worker tools plus the tools in §7.3 |

Runner-agent credentials are accepted only on the explicit [agent-token route allowlist in M2 §6.5](2026-10-28-m2-runners-design.md#65-agent-tokens-and-principals); every other route returns 403 `agent_not_allowed`. Holder, fence and lead-seat checks apply in addition to the allowlist. A runner agent cannot use the owner's CLI token to impersonate its identity. The table above spans milestones; it does not grant access to unimplemented tools or routes.

### 11.2 Hub–runner link

The runner opens the authenticated protocol-1 WebSocket at `/api/runner/ws`. Durable sequenced events, cumulative acknowledgements, journalled commands, reconnect replay and settings sync follow [M2 §6.3](2026-10-28-m2-runners-design.md#63-runner-link), the source of truth for message shapes and reconciliation. Settings sync retains the M2 runner-side rule and its documented Known limits after a restore; the exact-echo protocol change is deferred.

### 11.3 Event types

`goal.updated`, `plan.changed`, `milestone.*`, `area.*`, `task.created|updated|ready|claimed|working|submitted|checked|reviewed|accepted|rejected|merging|merged|stale|blocked|cancelled|failed`, `attempt.started|ended`, `agent.started|stalled|stopped|replaced`, `runner.online|offline|quota_changed`, `message.sent|delivered|acknowledged`, `decision.recorded|accepted`, `learning.proposed|promoted|rejected`, `budget.threshold`, `system.paused|resumed`.

## 12. Security

People sign in through GitHub or GitLab OAuth; the hub checks an allowlist of usernames. Browser sessions authorize people's controls. The hub stores its own state and OAuth application settings, never AI or git credentials.

Runner agents are contained by network, write, authority and git boundaries. Only the runner pushes, from its agent-inaccessible vault. Every approval goes to the owner; agflow never grants one itself or bypasses device policy. Agent-authored text stays quoted. The boundaries, owner-approved escalation and residual risks (including same-user reads and shell profiles) are defined in [M2 §5](2026-10-28-m2-runners-design.md#5-security-model-for-runner-agents).

The runner authenticates using `agflow login`'s CLI credential; keychain storage for that token is deferred to M3. Each runner agent uses an attempt- and fence-scoped token. Its route allowlist, revocation, epoch checks and lead-seat authority are defined in [M2 §6.5](2026-10-28-m2-runners-design.md#65-agent-tokens-and-principals). Live chats keep their M1 identity path and approvals remain with the person.

## 13. Failure handling

The hub remains the authority for attempts and work positions. Runner outages and crashes follow the [attempt trigger table](2026-10-28-m2-runners-design.md#64-attempts-fencing-and-leases) and [replacement and handoff rules](2026-10-28-m2-runners-design.md#68-stall-detection-continuation-replacement-and-handoff); quota waits follow [M2 §6.10](2026-10-28-m2-runners-design.md#610-quota-and-approvals). Lead loss follows the [lead-seat failover rules](2026-10-28-m2-runners-design.md#611-the-lead-on-runners).

After hub downtime or a forward clock jump, a recovery window lets runners reconnect and replay before lease expiry, stall decisions or dispatch resume. Backward clock steps never shorten leases. Backup restores advance the epoch, replay retained work, then re-fence surviving attempts; unknown attempts stop. Hourly, daily and start backups and the offline restore procedure are defined in [M2 §6.14](2026-10-28-m2-runners-design.md#614-restarts-clock-jumps-restores-and-backups).

During an outage runners buffer events, and failed bridge calls receive a retry nudge after reconnection. Reconciliation uses the [runner link protocol](2026-10-28-m2-runners-design.md#63-runner-link). WIP pushes have a bounded grace period; fenced or otherwise ineligible work is preserved as late work on separate refs, with durable retries, rather than overwriting a successor. See [M2 §7.3](2026-10-28-m2-runners-design.md#73-git) and [§7.4](2026-10-28-m2-runners-design.md#74-processes).

## 14. Testing

M2 combines deterministic core and hub tests, runner tests with a fake adapter and local bare origins, security contract tests, and real pinned CLIs driven by scripted model servers with scratch homes and zero subscription use. The local suites cover sandbox boundaries and multi-runner recovery (killed agent, closed laptop, lost lead, restarts, restore, delivery and take-over with hand-back). Gates, fixtures and the separately invoked manual live run are defined in [M2 §15](2026-10-28-m2-runners-design.md#15-testing).

Validation and tamper-detection scenarios belong to M3, alongside checks, reviewers and the merge queue. From M2 on, agflow can dogfood on its own repository.

## 15. Stack and layout

- TypeScript on Bun 1.3+. The `agflow` CLI and runner compile to a single binary; the hub is a separate entry point in the same codebase. The machine's Node 16 is too old for current SDKs and is not used.
- SQLite (`bun:sqlite`): state tables plus an append-only `events` table.
- MCP: the official TypeScript SDK.
- Web UI: React with Vite, served by the hub.
- Claude: `@anthropic-ai/claude-agent-sdk`, pinned. Codex: protocol types generated from the pinned CLI version.

```
packages/core      domain model, state machine, scheduler, policies (pure; unit-tested)
packages/hub       HTTP API, SSE, runner gateway, auth, storage
packages/runner    daemon and service, per-attempt clones and vault, dependency preparation, vendor adapters
packages/cli       agflow login | runner | join | mcp | brief | hook entry points
packages/web       React UI
packages/testkit   git fixtures, refusing proxy, scripted model servers, recorded-stream fake CLI, end-to-end harness
```

Package dependencies and the shared runner/adapter interfaces are defined in [M2 §13](2026-10-28-m2-runners-design.md#13-packages-and-interfaces). Checks and verification clones arrive in M3.

## 16. Milestones

| Milestone | Scope | Exit criteria |
|---|---|---|
| **M1: Project brain** | Hub (login, state, events, API, SSE); the task contract with structural checks (unknown or batch-local dependencies, cycles, owned-path overlap at claim time); guards (open-task and hourly creation limits); pause and resume; standing rules; daily backups with an integrity check; MCP bridge with worker and lead tools; web UI (goal editor, board with people's task actions, agents, timeline, steering chat, knowledge); `agflow join` for both CLIs, with a task branch per claim; the lead runs as a live chat started by a person, so it wakes when its turn ends or its person prompts it (immediate wake-ups arrive with runners in M2); tasks are accepted by the lead and marked merged by people. | On a toy repo, a person starts a Claude lead and two workers (one Claude, one Codex) with `agflow join`. The lead plans from the goal, workers claim and submit, a goal edit produces a visible re-plan, and a steering message reaches a worker through its `Stop` hook. |
| **M2: Runners** | Runner execution, isolation, recovery and operations as defined in [M2 design §2](2026-10-28-m2-runners-design.md#2-scope), including sandboxed dependency preparation, lead failover and the runner/attempt/approval UI. The lead accepts or rejects submissions; people mark tasks merged. | Killing an agent and closing a laptop mid-task both end with the task finished on another runner from the handoff note; the lead survives losing its laptop. |
| **M3: Validation and merge** | Task contracts and plan checks; checks in verification worktrees; tamper and scope checks; cross-vendor review; research review; evidence log; retry ladder; PR per task; merge queue; protected paths. | A planted test-weakening agent is caught. A 10-task toy project goes from goal to merged main with no human action, and main stays green throughout. |
| **M4: Scale and knowledge** | Area managers; learnings curation and curator tasks; context linter; hidden checks; plan critic; usage dashboards. | A two-area project runs with a lead and two area managers. A proposed learning reaches `AGENTS.md` through a curation task. |

## 17. Risks and open questions

| Risk | Mitigation |
|---|---|
| Vendor interfaces are unstable: the Codex app-server is experimental; Claude's session inbox socket is undocumented; `claude --bg` is a research preview | Thin adapters, pinned CLI versions, regenerated protocol types, the smoke suite on every version change, and documented fallbacks (`codex exec --json`, hook-based delivery). |
| Subscription limits and fair-use terms | Per-person usage in the UI, quota-aware routing, conservative default caps. Review plan terms before heavy use. |
| Progress only while laptops are online | Keep-awake option, leases and WIP pushes; work resumes when laptops return. |
| Poor plans from the lead | Plan checks, guards, the plan critic (M4) and human steering. |
| Wrong validation verdicts | Evidence-based done, reproduction required for blocking findings, one rebuttal, the retry ladder. |
| Prompt injection through repo content or messages | Quoted data, no authority for agent messages, protected paths, sandboxed permission profiles. |
| Merge and design conflicts between parallel agents | Owned-path admission, single writer per interface, merge-tree probes, milestone integration checks. |

Open questions to settle during implementation:

1. Will Anthropic document the session inbox socket's message format (anthropics/claude-code issue #103048)?
2. Can an external client steer threads in the shared Codex daemon in practice (not verified live)?
3. What is the exact config override that marks a Codex clone as trusted? **Answered in M2:** `projects.<path>.trust_level` is a nested object in the thread config, never a dotted key: `config: { projects: { [realpath(clone)]: { trust_level: projectConfigVerified ? 'trusted' : 'untrusted' } } }`. The runner verifies `.codex/` against the restore base before start and resume; see [M2 §9.2](2026-10-28-m2-runners-design.md#92-threads-and-turns).
4. How much quota does a typical task consume per vendor and plan? Measure during M2 and adjust the default caps.

## 18. Review findings to resolve before the M2 and M3 plans

A four-reviewer adversarial review of this spec (2026-10-26) found the issues below. M1 absorbed the ones that affect it. The status column follows [M2 §17](2026-10-28-m2-runners-design.md#17-spec-changes). Resolved rows link to the current contract; open rows retain their required direction for M3 or M4. Resolution here covers M2 scope: reviewers and validation remain M3, and area managers remain M4.

| # | Area | Problem | Required direction | Status |
|---|---|---|---|---|
| 1 | Git credentials | Agents run as the laptop owner and can reach the owner's git login, so they could push to `main` and bypass the merge queue, fencing and the tamper scan. | Network and credential isolation; only the runner pushes from its vault. [M2 contract](2026-10-28-m2-runners-design.md#5-security-model-for-runner-agents). | Resolved in M2 |
| 2 | Sandboxing | Allow rules decide which commands start, not what they do. Checks run agent-written code outside any sandbox. | Sandboxed agent tools and dependency preparation are in M2; verification checks arrive in M3. [M2 contract](2026-10-28-m2-runners-design.md#77-dependency-preparation). | Resolved in M2 with sandboxed dependency preparation; checks in M3 |
| 3 | Repo-controlled config | Both CLIs load hooks, MCP servers and settings from the task branch at every start, so a tampered branch runs code on the next laptop before any scan. | Restore and strip protected paths, and isolate runner git from agent-writable config. [M2 contract](2026-10-28-m2-runners-design.md#73-git). | Resolved in M2 |
| 4 | Fencing on pushes | The git host knows nothing about fencing tokens, so a cut-off runner can keep pushing to a branch its successor uses. | Per-attempt WIP refs; fenced submission moves the task branch conditionally. [M2 contract](2026-10-28-m2-runners-design.md#613-submissions-from-runner-agents). | Resolved in M2 |
| 5 | Leases after submit | An author waiting for checks and review looks stalled. | Submitted workers enter a hold, retaining the session for fixes; `rebut_review` waits for M3 reviewers. [M2 contract](2026-10-28-m2-runners-design.md#64-attempts-fencing-and-leases). | Resolved in M2 except `rebut_review` (M3) |
| 6 | Hub restarts | After an outage longer than the lease, every lease looks expired. | Recovery windows extend leases and allow replay before reconciliation. [M2 contract](2026-10-28-m2-runners-design.md#614-restarts-clock-jumps-restores-and-backups). | Resolved in M2 |
| 7 | Quota and long builds | Usage limits and long builds look like stalls and burn attempts. | Quota waits suspend stall and budget decisions; long tools have command-specific caps, while the runner lease still detects a lost laptop. [M2 contract](2026-10-28-m2-runners-design.md#68-stall-detection-continuation-replacement-and-handoff). | Resolved in M2 |
| 8 | Merge queue | Merge jobs have no lease or fencing, and the git host cannot enforce the hub's verdict. | A short-lived merge permit bound to (task, head SHA, main SHA). Merges are conditional on the expected head SHA. A hub-signed acceptance attestation is checked by a required CI status. | Open for M3 |
| 9 | Validation inputs | Diffs use the frozen `base_commit` although branches are rebased. | Compute every diff as `merge-base(origin/main, HEAD)..HEAD`, and restore protected paths from the rebase target. | Open for M3 |
| 10 | Review blind spots | Some defects (data exfiltration, new dependencies, leaked secrets) cannot be shown by a failing test, so they would merge automatically. | Security-class findings block without a reproduction and go to a person. Add deterministic tamper rules for new outbound hosts and new dependencies. | Open for M3 |
| 11 | Per-role lifecycles | Continuation and stall rules assume workers, so managers would loop. | Runner leads idle between wake-ups and hold the lead seat. Reviewers and area managers remain deferred. [M2 contract](2026-10-28-m2-runners-design.md#611-the-lead-on-runners). | Resolved in M2 |
| 12 | Guards | "Re-plan" is undefined, create-and-cancel loops evade the limits, and one hard task should not pause everything. | Count mutating planning calls with a churn budget; one task reaching its attempt limit triggers its own re-plan. [M2 contract](2026-10-28-m2-runners-design.md#615-guards). | Resolved in M2 |
| 13 | Vendor rules | §6.8 and §9.3 disagree about same-vendor review. | A reviewer uses the other vendor when it is available, otherwise the §9.3 fallback after a stated wait. | Open for M3 |
| 14 | Claude adapter | The SDK bundles a different Claude version than the installed CLI, auto mode may be unavailable, and API-key variables silently override the subscription. | Pin and verify the binary, use a minimal environment and subscription preflight; standard is acceptEdits plus sandbox, auto is opt-in. [M2 contract](2026-10-28-m2-runners-design.md#8-claude-code-adapter). | Resolved in M2 |
| 15 | Codex adapter | Codex forwards only allowlisted environment variables to stdio MCP servers, and `turn/steer` carries user authority. | Explicit bridge environment forwarding and tool-authority agent messages. [M2 contract](2026-10-28-m2-runners-design.md#9-codex-adapter). | Resolved in M2 |
| 16 | Restore | Restoring a daily backup rolls back counters and fencing tokens. | Hourly snapshots, a restore epoch and replay before re-fencing. [M2 contract](2026-10-28-m2-runners-design.md#614-restarts-clock-jumps-restores-and-backups). | Resolved in M2 |
| 17 | Repo-derived context | The hub cannot read the repository, so it cannot build repo maps, pitfalls or the research index. | Runners and bridges build that context from the worktree and upload a derived index keyed by commit. | Open for M4 |

## 19. References

- Claude Code docs: [headless and Agent SDK](https://code.claude.com/docs/en/headless), [hooks](https://code.claude.com/docs/en/hooks), [memory and AGENTS.md](https://code.claude.com/docs/en/memory), [cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging), [agent teams](https://code.claude.com/docs/en/agent-teams)
- Codex docs: [AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md), [hooks](https://learn.chatgpt.com/docs/hooks), [subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents); app-server protocol generated locally with `codex app-server generate-json-schema`
- Anthropic: [multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system), [effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents), [effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents), [building a C compiler with parallel Claudes](https://www.anthropic.com/engineering/building-c-compiler)
- OpenAI: [harness engineering](https://openai.com/index/harness-engineering/), [Symphony spec](https://github.com/openai/symphony/blob/main/SPEC.md)
- Cognition: [Don't build multi-agents](https://cognition.com/blog/dont-build-multi-agents), [Multi-agents: what's actually working](https://cognition.com/blog/multi-agents-working)
- Validation research: [ImpossibleBench](https://arxiv.org/abs/2510.20270), [MAST: why multi-agent systems fail](https://arxiv.org/abs/2503.13657), [cross-model code review, Claude vs Codex](https://arxiv.org/abs/2607.21656)
- Related tools: [Agent Orchestrator](https://github.com/OrchestratorInc/agent-orchestrator), [Gas City](https://github.com/gastownhall/gascity), [Beads](https://github.com/gastownhall/beads), [MCP Agent Mail](https://github.com/Dicklesworthstone/mcp_agent_mail_rust)

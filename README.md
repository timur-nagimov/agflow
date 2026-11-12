# agflow

agflow connects many Claude Code and Codex agents, including teammates' own live chats, into one project with one goal. A lead manager agent turns the goal into tasks, agents on teammates' laptops do the work, and a web UI shows everything and lets people edit the goal and steer.

See the [project design](docs/superpowers/specs/2026-10-26-agflow-design.md) and the [M2 runner design](docs/superpowers/specs/2026-10-28-m2-runners-design.md), which takes precedence for runners.

## Status

M1's hub, web UI and live-chat bridge are built. M2 adds runners that start and supervise Claude Code and Codex agents on teammates' laptops: scheduling, WIP recovery, lead failover, approvals, dependency preparation and take-over. Automated tests use scripted model servers; the [live exit run](docs/m2-live-run.md) with real Claude and Codex subscriptions passed on 2026-11-12 (116 of 116 checks).

M2 runners support **macOS on Apple silicon (`darwin-arm64`) only**. The hub and ordinary unit tests also run on Linux. The lead still accepts or rejects submissions, and people mark tasks merged. Verification clones, reviewers, PRs and the merge queue belong to M3; usage dashboards and repository-derived context belong to M4.

## Run the hub locally

Requires [Bun](https://bun.sh) 1.3.11 or newer.

```bash
bun install
AGFLOW_AUTH=dev \
AGFLOW_ALLOWED_USERS=your-github-login \
AGFLOW_PROJECT_NAME=demo \
AGFLOW_PROJECT_REPO=https://github.com/you/demo \
bun run hub
```

Then sign in at `http://localhost:8787/auth/dev?user=your-github-login`. Dev sign-in skips GitHub and is for local use only, so with `AGFLOW_AUTH=dev` the hub listens on loopback (`127.0.0.1`) and other machines cannot reach it. It also answers only requests addressed to `localhost`, `127.0.0.1`, `[::1]` or the host in `AGFLOW_PUBLIC_URL`, so a web page cannot reach it through your browser by pointing a domain of its own at `127.0.0.1`. Do not point `AGFLOW_HOST` at a network address in dev mode: anyone who can reach the hub could sign in as any allowed user.

## Web UI

The hub serves the web UI when `AGFLOW_WEB_DIST` points at the build:

```bash
bun run build:web
AGFLOW_WEB_DIST=packages/web/dist AGFLOW_AUTH=dev AGFLOW_ALLOWED_USERS=your-github-login \
AGFLOW_PROJECT_NAME=demo AGFLOW_PROJECT_REPO=https://github.com/you/demo bun run hub
```

Open `http://localhost:8787` and sign in. Its pages:

- **Board.** Tasks by status, and a form for new tasks.
- **Task page.** Contract, submissions and their outcomes, notes, thread and history; accept, reject, mark merged, unblock and cancel. Runner tasks add attempts (vendor/model, runner, status, end reason, WIP ref/SHA and times), attempt logs, handoff/restatement/late-work notes, and Take over / Hand back with commands. Protected tasks are marked "live chat only".
- **Goal.** Edit the goal, read lead notes and messages, pause or resume work, and toggle **Runner leads**. The lead seat shows whether a live chat or a runner holds it, with wake-ups since rotation.
- **Agents.** Runner, attempt and phase, with Interrupt, Stop, Stop and hold, Replace and Take over where applicable. Stop replaces Release for runner work. A runner lead offers Interrupt, Stop and Replace; it has no Hold or Take over action.
- **Runners.** Owner, state and why, capacity/free slots, power, disk, keep-awake, git readiness and last push. Vendor details show readiness, binary versions, plan, managed policy, quota windows, ceilings, paid usage and owner-away state; profiles show weakened items. Only the owner can edit capacity, keep-awake, drain, ceilings and paid usage, or retire a runner.
- **Approvals** (`#/approvals`). Your pending requests, with a badge in the navigation, full command, working directory, reason, any manifest diff and time left. Read the escalation warning before approving or declining.
- **Messages.** Steer the lead and the agents; mark a message as a standing rule.
- **Timeline.** Everything that happened, live, including runner and attempt events and filters.
- **Knowledge.** Standing rules, and search across tasks, messages and the goal.

To try the UI without agents, run the demo hub. It keeps a made-up project in memory, and one of its agents reports progress every few seconds:

```bash
bun run build:web && bun run demo   # http://localhost:8790, sign in as "demo"
```

## Connect your Claude Code and Codex chats

Build the `agflow` command once, and put it on your PATH:

```bash
bun run build:cli
cp dist/agflow ~/.local/bin/agflow
```

Sign this computer in to your team's hub. A browser page opens; approve it after checking that it shows the same code as your terminal:

```bash
agflow login --hub https://agflow.example.com
```

In the project's repository, connect your chats (the lead uses `--role lead`):

```bash
agflow join --role worker --vendor both
```

- **Claude Code.** Start a new chat in the repository. It receives an agflow brief and the agflow tools.
- **Codex.** Trust the project if Codex asks, then run `/hooks` once and trust the three agflow hooks.

`join` also lets these chats call agflow's own tools without asking each time: it adds the rule `mcp__agflow` to Claude Code's local permissions and sets `default_tools_approval_mode = "approve"` for the agflow server in Codex. Other tools still ask as usual.

Each chat calls `hello` with the code from its brief, then works with `list_tasks`, `claim_task` and `submit`. A claimed task gets its own branch in `.worktrees/agflow/<task>`. `agflow leave` undoes `join`, and `agflow status` shows the hub, your account and the joined repositories.

## Set up and run a runner

Build and install the CLI as above, then sign in to the hub and set up the laptop:

```bash
agflow login --hub https://agflow.example.com
agflow runner setup
agflow runner status
```

Setup records the machine identity, login-shell PATH, proxy/certificate settings and git commit identity in `~/.agflow/runner/runner.json` (mode 0600). Defaults include capacity 2, keep-awake on AC and paid usage off. It installs pinned vendor binaries into its own vendor directory, logs in to separate runner vendor homes, and installs the macOS LaunchAgent. It leaves your own vendor installations alone. `--relogin` repeats vendor logins; `--no-service` omits service installation; `--yes` accepts setup defaults.

Checks run **inside the service**: hub identity, repository access (`git ls-remote`), a fenced create/delete push to a probe ref, both vendor preflights (including the expected MCP surface), the dependency sandbox, and sleep settings. The runner needs your git credentials for vault fetches and pushes. It captures connectivity settings because a LaunchAgent does not inherit an interactive shell. A missing pinned binary at start is a preflight failure; start never downloads one.

| Command | Effect |
|---|---|
| `agflow runner setup` | Interactive setup and checks; rerun after moving to another machine or retiring the runner. |
| `agflow runner start` | Run in the foreground, with terminal and file logs; Ctrl-C suspends attempts and saves WIP. Only one instance runs. |
| `agflow runner install` | Install/enable/start `~/Library/LaunchAgents/dev.agflow.runner.plist` in the logged-in macOS desktop session; also installs missing pins. |
| `agflow runner status` | Query the running runner; without its socket, report best-effort service state, last exit and log tail. `--json` includes attempts and process identities. |
| `agflow runner drain` | Take no new attempts; current work continues. Offline changes are sent at reconnect. |
| `agflow runner undrain` | Accept work again and clear the crash-loop guard. |
| `agflow runner restart` | Suspend attempts, save WIP and restart under launchd. |
| `agflow runner stop` | Drain, hand off and stop agents, push WIP, then stop and disable the service until install/start. |
| `agflow runner uninstall` | Stop, log out of runner vendor homes, retire on the hub and remove the service. `--purge` also removes runner data, vaults and work only after checking for unpushed WIP. |

`AGFLOW_HOME` relocates runner storage (default `~/.agflow`). Logs are under `runner/logs/`. If status says `needs_login`, run `agflow login` again; the runner reconnects itself. Three unclean exits in ten minutes cause a self-drain until `undrain`. Keep-awake on AC prevents idle sleep, not a closed lid; after a lost runner's lease expires, another attempt can continue from pushed WIP, and later recovered work is recorded separately.

## Runner permissions and risks

Agents run as the laptop owner's user. Four boundaries apply to their tools:

1. **Network:** Claude commands reach only allowlisted package registries; Codex commands have no network. Web search, account apps/connectors and extra MCP servers are disabled or refused at startup. Tools cannot reach the hub or git host directly.
2. **Writes:** tools write only inside the attempt clone and its private temporary directory. Claude's Edit/Write tools also have guards.
3. **Authority:** only the agflow bridge carries a scoped agent token to allowed hub routes. Lead authority requires the lead seat; an owner's CLI token cannot impersonate a runner agent.
4. **Git:** agents have no push credentials or route to the host. The runner alone fetches and pushes through its protected vault, with fenced updates, and never trusts the clone's git configuration during harvest.

The runner never auto-approves an escalation: requests go to the owner. Approving a Codex escalation runs that command **outside the sandbox**, with network and the owner's full write access. M2 has no mid-turn Claude approval relay; a refused operation needs human intervention. Managed device policies remain in force: agflow does not bypass MDM or weaken the vendor's policy. The `auto` Claude profile can classify Bash commands within its sandbox; that is not permission to escape it.

These boundaries do not provide complete read isolation. Codex can read most owner-readable files; both sandboxes allow same-user process arguments/environment to be read, so attempts on one laptop trust each other. Claude denies credential paths and other runner data, and sandbox checks cover keychain access. Registry requests remain an exfiltration risk. Trusted base/project hooks and configuration can execute outside the sandbox; review agent configuration on main. Claude's shell snapshot can source the owner's profile outside the sandbox, and its CLI makes some cache/config writes into the owner's HOME despite a separate config directory. Lifecycle scripts can execute code from manifests agents edit. See [the security model](docs/superpowers/specs/2026-10-28-m2-runners-design.md#5-security-model-for-runner-agents) for the full boundaries and residual risks.

## Take over and hand back

On a task page, **Take over** is available for a running or quota-waiting attempt on an online runner, with no pending submission or stop. Otherwise use **Stop and hold** to pause work at its last WIP. Take-over blocks the task and keeps its path ownership; the lead cannot unblock it.

The runner asks for a handoff, stops the agent, saves WIP, restores protected paths and replaces the clone's `.git` with a fresh runner-built one. Wait for success before entering the clone: a failed take-over shows its error and no local command. The page supplies a local resume command using the attempt's pinned CLI version and runner vendor home, or an anywhere fetch/branch command and a ref to push your work to.

When finished, exit the resumed chat and every terminal/editor process in the clone, then choose **Hand back**. The clone option harvests your commits and uncommitted work; `process_running` names processes to close before retrying. The pushed-ref option needs the ref and its full 40-hex commit SHA and does not need the runner. The task becomes ready for a new attempt. If a clone hand-back loses the runner or times out, work resumes from the last recorded position and a later push becomes late work. Use Hand back, not Unblock, for a taken-over task.

## Dependencies and protected paths

People configure preparation in a committed `.agflow/config.json`:

```json
{
  "dependencies": [
    {
      "run": ["bun", "install", "--frozen-lockfile", "--ignore-scripts"],
      "when": ["package.json", "bun.lock"]
    }
  ]
}
```

Without the file, nothing is prepared. The runner reads it from the vault at the protected restore base, never from agent-edited working files. Worker starts/resumes prepare when the listed files change; workers can also request `prepare_dependencies`. Leads get no preparation. Commands run in a sandbox with registry-only network, no owner credentials and writes confined to the clone and preparation cache, with a 15-minute timeout. Private registries are outside M2. Lifecycle scripts are disabled by default; an entry that needs them declares `"scripts": true` and uses a per-attempt cache (remove `--ignore-scripts` from that command). Go and Cargo always use per-attempt caches. If the sandbox check fails, preparation is unavailable on that runner.

Protected paths are matched case-insensitively. The runner restores them before starts, resumes, preparation and take-over, strips unauthorized changes from WIP, and refuses a submission containing them:

| Class | Paths | Exception |
|---|---|---|
| Agent configuration | `.claude/**`, `.codex/**`, `.mcp.json`, `.agents/**`, `.agflow/**` (except untracked `.agflow/run/`), `.husky/**`, `.pre-commit-config.yaml`, `lefthook.yml`, `.envrc`, `.devcontainer/**`, `.vscode/**`, `.idea/**`, `.npmrc`, `.yarnrc*`, `bunfig.toml`, `.tool-versions` | None for runner agents; tasks owning these paths are for people/live chats. |
| People only | `.github/workflows/**`, `.gitlab-ci.yml`, `.gitlab/**`, `.env*`, `*.pem`, `*.key`, `.gitmodules`, `.gitattributes` | A person created the task and its owned paths explicitly include them. |
| Curators only | `AGENTS.md`, `CLAUDE.md` at any depth | A task of kind `curation`. |

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `AGFLOW_AUTH` | `github` | `github` for GitHub sign-in, `dev` for local testing |
| `AGFLOW_ALLOWED_USERS` | (required) | Comma-separated GitHub logins allowed to sign in |
| `AGFLOW_PROJECT_NAME` | (required) | Project name shown to people and agents |
| `AGFLOW_PROJECT_REPO` | (required) | URL of the project's git repository |
| `AGFLOW_PUBLIC_URL` | `http://localhost:<port>` | Address people and laptops use to reach the hub, an `http://` or `https://` URL; `https://` makes session cookies secure |
| `AGFLOW_HOST` | `127.0.0.1` with `AGFLOW_AUTH=dev`, otherwise `0.0.0.0` | Listening address; `::` accepts IPv6 as well as IPv4 |
| `AGFLOW_PORT` | `8787` | Listening port, 1 to 65535 |
| `AGFLOW_DB` | `data/agflow.db` | SQLite database file |
| `AGFLOW_BACKUP_DIR` | `data/backups` | Hourly snapshots (24 hours), daily snapshots (newest 7) and start snapshots (newest 3) |
| `AGFLOW_WEB_DIST` | (unset) | Folder with the built web UI |
| `AGFLOW_LEASE_MINUTES` | `120` | How long a claim survives without agent activity |
| `AGFLOW_REMINDER_MINUTES` | `30` | Minimum time between "you hold a task" reminders |
| `AGFLOW_MAX_OPEN_TASKS` | `200` | Guard: refuse new tasks beyond this many open tasks |
| `AGFLOW_MAX_TASKS_PER_HOUR` | `60` | Guard: refuse new tasks beyond this hourly rate |
| `AGFLOW_RUNNER_LEASE_MINUTES` | `15` | Runner silence before an attempt is lost |
| `AGFLOW_TICK_SECONDS` | `15` | Hub scheduling/reconciliation interval |
| `AGFLOW_STALL_MINUTES` | `10` | Stall detection window |
| `AGFLOW_TOOL_CAP_MINUTES` | `30` | Ordinary tool runtime cap |
| `AGFLOW_LONG_TOOL_CAP_MINUTES` | `90` | Long-running tool cap |
| `AGFLOW_RECOVERY_SECONDS` | `120` | Reconnect/replay window after hub downtime |
| `AGFLOW_APPROVAL_MINUTES` | `15` | Time to answer an approval |
| `AGFLOW_LEAD_REVIEW_MINUTES` | `45` | Lead review deadline |
| `AGFLOW_LIVE_LEAD_GRACE_MINUTES` | `120` | Live lead absence grace |
| `AGFLOW_QUOTA_WAIT_MINUTES` | `45` | Maximum quota wait before replacement |
| `AGFLOW_QUOTA_UNKNOWN_MINUTES` | `30` | Wait when the quota reset time is unknown |
| `AGFLOW_ACTIVE_BUDGET_MINUTES` | `240` | Active-time budget per attempt |
| `AGFLOW_SUBMIT_TIMEOUT_MINUTES` | `15` | Runner submission timeout |
| `AGFLOW_MAX_WORKERS` | `4` | Project worker limit |
| `AGFLOW_MAX_ATTEMPTS` | `3` | Attempt limit for the retry ladder |
| `AGFLOW_LEAD_ROTATE_WAKEUPS` | `20` | Wake-ups before rotating a runner lead |
| `AGFLOW_MAX_PLAN_CHANGES_PER_HOUR` | `60` | Churn guard: pause dispatch above this rate |
| `AGFLOW_WIP_REF_PREFIX` | `refs/agflow/` | Work-ref namespace under `refs/`, ending in `/` |
| `AGFLOW_MAIN_BRANCH` | `main` | Project main branch |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | (unset) | OAuth app credentials, required when `AGFLOW_AUTH=github` |

Behind a proxy, set `AGFLOW_PUBLIC_URL` to the address people open in the browser, with `https://` if the proxy terminates TLS. A signed-in browser can change things only from the hub's own pages, which the hub recognises by this address or by the request's Host header.

Durations use the units in their variable names. Production minimums are tick 5 seconds, recovery 30 seconds, and runner lease, stall, approval and submit timeout 5 minutes each. Runner profiles/models and local settings live in `runner.json`; M2 shows profiles in the UI but does not edit them there.

### GitHub sign-in

Create an OAuth app under GitHub → Settings → Developer settings → OAuth Apps. Set the callback URL to `<AGFLOW_PUBLIC_URL>/auth/github/callback`, then set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. The hub asks GitHub for no scopes, reads only the person's GitHub login and keeps no GitHub token. Open the hub at `AGFLOW_PUBLIC_URL` to sign in: a short-lived cookie for that address ties each sign-in to the browser that started it.

### Backups, restore and Known limits

The first hourly backup is one hour after start; hourly housekeeping also writes a daily backup once per UTC day. Stop the hub before restoring, and use its database path:

```bash
AGFLOW_DB=data/agflow.db bun run restore data/backups/<backup-file>
```

The restore command validates the backup, keeps the replaced database aside and advances the hub epoch/counters. Restart the hub with its normal configuration; runners reconnect and replay retained events. The recovery window pauses dispatch, lease expiry and stall judgments while they reconcile.

**Settings sync after a restore.** Protocol 2 names each answered edit and each refusal exactly. A runner replays all retained edits; the hub skips answered edits only when it adopted the snapshot that includes them. Equal owner echoes cannot settle local edits early, and a restored hub ahead of the snapshot still receives post-backup edits. Upgrade the hub first; it supports protocol-1 runners during the transition. **Known limits:** settings versions still do not identify their history, so equal versions from different restores can diverge and pending echoes from an older history can temporarily apply until the full snapshot arrives. Pruned events and protocol-1 history cannot be reconstructed. Check intended settings after those cases.

## Development

```bash
bun test                       # ordinary unit/integration suite (also bun run test)
bun run typecheck              # TypeScript for packages and web
bun run hub                    # hub; set the required configuration above
bun run restore <backup>       # restore while the hub is stopped
bun run build:cli              # compiled CLI in dist/agflow
bun run build:web              # web UI in packages/web/dist
bun run smoke:hub              # local hub, sign-in and goal persistence
bun run smoke:cli              # hub + CLI login/join/hooks/bridge/claim/submit
bun run demo                   # made-up project on port 8790
bun run check:ui               # headless Chromium UI checks
bun run vendor:install         # install the pinned runner CLIs without setup
bun run verify:prep            # macOS: real registry installs in the prep sandbox
bun run verify:service         # macOS desktop: temporary LaunchAgent lifecycle check
bun run record:claude          # regenerate recordings with scripted model replies
bun run smoke:claude           # AGFLOW_SMOKE=1; pinned Claude adapter checks
bun run check:claude-sandbox   # AGFLOW_SMOKE=1 + AGFLOW_SANDBOX_CHECKS=1
bun run gen:codex-protocol     # regenerate protocol types from the pinned Codex
bun run smoke:codex            # AGFLOW_SMOKE=1; pinned Codex adapter checks
bun run check:codex-sandbox    # AGFLOW_SMOKE=1 + AGFLOW_SANDBOX_CHECKS=1
bun run e2e                    # AGFLOW_E2E=1; scripted models, both vendors, kept awake
```

`bun test` and `bun run typecheck` are the baseline CI gate; UI changes also need `bun run check:ui`. Adapter smoke tests use `AGFLOW_SMOKE=1`; sandbox checks additionally use `AGFLOW_SANDBOX_CHECKS=1`. Run both vendors' smoke and sandbox checks on a supported Mac. Platform-specific tests skip on Linux because **the runner supports darwin-arm64 only; design 7.1**. The E2E gate (`AGFLOW_E2E=1 bun run e2e`) uses a local hub, three scratch runner homes, a bare origin and scripted servers on loopback; once enabled, missing prerequisites fail instead of silently skipping. It covers killed agents, closed laptops, lost leads, runner/hub restarts, hub restore, mid-turn delivery and take-over/hand-back. These scripted checks spend no model quota; vendor processes use isolated homes and a refusing external proxy.

`AGFLOW_TEST=1` enables hub test mode. `AGFLOW_TEST_CONFIG` is a JSON object of recognized `HubConfig` millisecond fields (including `infraBackoffMs`, an array), for example `'{"runnerLeaseMs":30000,"tickMs":100}'`. Unknown fields and non-positive values are refused; setting it without test mode is an error. Runner test mode can redirect vendors to scripted servers, skip auth checks and allow short timings through the `test` block in `runner.json`. It posts no notifications and refuses service installation.

The following commands are **manual real-model runs**, outside the zero-model test gates. They use vendor logins and subscription quota. `record:claude --live` also uses real quota; its default above is scripted.

```bash
bun run verify:real-clis                  # M1 live-chat bridge check with real vendor logins
bun run live-run                          # caffeinate -i bun scripts/live-run.ts
bun run live-run --takeover claude,codex  # M2 exit run, including both TTY resume checks
```

Follow the [M2 live-run runbook](docs/m2-live-run.md) for prerequisites, the throwaway repository, options and the Results table. The live exit gate remains pending until those results are recorded.

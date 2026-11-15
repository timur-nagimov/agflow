# agflow

agflow connects many Claude Code and Codex agents, including teammates' own live chats, into one project with one goal. A lead manager agent turns the goal into tasks, agents on teammates' laptops do the work, and a web UI shows everything and lets people edit the goal and steer.

See the [project design](docs/superpowers/specs/2026-10-26-agflow-design.md) and the [M2 runner design](docs/superpowers/specs/2026-10-28-m2-runners-design.md), which takes precedence for runners.

## Status

M1's hub, web UI and live-chat bridge are built. M2 adds runners that start and supervise Claude Code and Codex agents on teammates' laptops: scheduling, WIP recovery, lead failover, approvals, dependency preparation and take-over. Automated tests use scripted model servers; the [live exit run](docs/m2-live-run.md) with real Claude and Codex subscriptions passed on 2026-11-12 (116 of 116 checks).

M2 runners run on **macOS on Apple silicon (`darwin-arm64`)**, and on Linux (`linux-x64`, `linux-arm64`) as a [cloud runner](docs/linux-runner.md) that keeps working while the laptops sleep. The hub and ordinary unit tests also run on Linux. With `AGFLOW_AUTO_ACCEPT=1` and `AGFLOW_AUTO_MERGE=1` the hub accepts submissions whose check passed (except demo checks and branches that change the check's own files), and runners merge accepted work into `main` with their owners' git credentials; without them the lead accepts or rejects submissions, and people mark tasks merged. Verification clones, reviewers, a PR per task and merging through the git host belong to M3; usage dashboards and repository-derived context belong to M4.

For a shared Linux hub with HTTPS, GitHub sign-in, backups and two Mac runners, follow the [hub deployment runbook](docs/deploy-hub.md).

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

- **Board.** Tasks by status, and a form for new tasks. A ready task that did not start says why in one line, as the scheduler's last tick found it: no free worker slot, no runner that can take it, its dependencies, another task holding its paths, a paused project, the churn guard, and so on.
- **Task page.** Contract, submissions and their outcomes, notes, thread and history; accept, reject, mark merged, unblock and cancel. Runner tasks add attempts (vendor/model, runner, status, end reason, WIP ref/SHA and times), attempt logs, handoff/restatement/late-work notes, and Take over / Hand back with commands. Protected tasks are marked "live chat only".
- **Goal.** Edit the goal, read lead notes and messages, pause or resume work, and toggle **Runner leads**. The lead seat shows whether a live chat or a runner holds it, with wake-ups since rotation.
- **Agents.** Runner, attempt and phase, with Interrupt, Stop, Stop and hold, Replace and Take over where applicable. Stop replaces Release for runner work. A runner lead offers Interrupt, Stop and Replace; it has no Hold or Take over action.
- **Runners.** Owner, state and why, capacity/free slots, power, disk, keep-awake, git readiness and last push. Vendor details show readiness, binary versions, plan, managed policy, quota windows, ceilings, paid usage and owner-away state; profiles show weakened items. Only the owner can edit capacity, keep-awake, drain, ceilings and paid usage, or retire a runner.
- **Approvals** (`#/approvals`). Your pending requests, with a badge in the navigation, full command, working directory, reason, any manifest diff and time left. Read the escalation warning before approving or declining.
- **Load.** One row per account (owner and vendor): plan, slots taken on the owner's runners, 5-hour and weekly use against the ceilings, reset time and state. Below it the project's numbers: workers running against the target and the cap, ready and startable tasks, tasks waiting on dependencies, submitted and accepted-not-merged tasks with the oldest age, merges in the last hour, the deadline and the free slot minutes of the last hour. The top strip shows workers running against the cap, ready tasks and free slots on every page.
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

Or download the binary for your machine from the latest release: `agflow-darwin-arm64` for a Mac with Apple silicon, `agflow-linux-x64` or `agflow-linux-arm64` for Linux.

```bash
mkdir -p ~/.local/bin
curl -fsSL -o ~/.local/bin/agflow https://github.com/timur-nagimov/agflow/releases/latest/download/agflow-darwin-arm64
chmod +x ~/.local/bin/agflow
```

A tag `v*` publishes a release; `.github/workflows/release.yml` builds the three binaries and attaches them.

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

Setup records the machine identity, login-shell PATH, proxy/certificate settings and git commit identity in `~/.agflow/runner/runner.json` (mode 0600). Defaults include capacity 2, keep-awake on AC and paid usage off. It installs pinned vendor binaries into its own vendor directory, logs in to separate runner vendor homes, and installs the service: the macOS LaunchAgent, or a systemd user unit on Linux, where Codex signs in with a device code and Claude with a `claude setup-token` token ([Linux runner](docs/linux-runner.md)). It leaves your own vendor installations alone. `--relogin` repeats vendor logins; `--no-service` omits service installation; `--yes` accepts setup defaults.

Flags answer setup's questions and set the rest of `runner.json`: `--name <name>`, `--capacity <1-16>`, `--ceiling <0.5-1>` (both quota windows of both vendors), `--keep-awake always|ac|off` and `--profile standard|auto|open`. `--preset hackathon` means capacity 6, ceilings 1, keep-awake always and the open profile; a flag given beside it wins. Rerunning setup with flags changes a kept `runner.json` as local edits, which the hub hears at the runner's next connection. A rerun also records the login-shell PATH again, so tools installed since setup reach agents and dependency preparation. While the runner runs, setup refuses flags that would change `runner.json` and keeps its PATH: stop it first with `agflow runner stop`.

```bash
agflow runner setup --preset hackathon --name hack-mac
```

Checks run **inside the service**: hub identity, repository access (`git ls-remote`), a fenced create/delete push to a probe ref, both vendor preflights (including the expected MCP surface), the dependency sandbox, and sleep settings. The runner needs your git credentials for vault fetches and pushes. It captures connectivity settings because a LaunchAgent does not inherit an interactive shell. A missing pinned binary at start is a preflight failure; start never downloads one.

| Command | Effect |
|---|---|
| `agflow runner setup` | Interactive setup and checks; rerun after moving to another machine or retiring the runner. |
| `agflow runner start` | Run in the foreground, with terminal and file logs; Ctrl-C suspends attempts and saves WIP. Only one instance runs. |
| `agflow runner install` | Install/enable/start `~/Library/LaunchAgents/dev.agflow.runner.plist` in the logged-in macOS desktop session, or on Linux `~/.config/systemd/user/agflow-runner.service` with lingering; also installs missing pins. |
| `agflow runner status` | Query the running runner; without its socket, report best-effort service state, last exit and log tail. `--json` includes attempts and process identities. |
| `agflow runner check-sandbox` | Run the dependency preparation sandbox's self-check for the profile in `runner.json` (standard without one), with no hub or vendor sign-in: a write, and on Linux a unix socket the sandbox must keep commands from. Exits 1 with the reason when the sandbox does not work. |
| `agflow runner drain` | Take no new attempts; current work continues. Offline changes are sent at reconnect. |
| `agflow runner undrain` | Accept work again and clear the crash-loop guard. |
| `agflow runner restart` | Suspend attempts, save WIP and restart the service (launchd, or systemd on Linux). |
| `agflow runner stop` | Drain, hand off and stop agents, push WIP, then stop and disable the service until install/start. |
| `agflow runner uninstall` | Stop, log out of runner vendor homes, retire on the hub and remove the service. `--purge` also removes runner data, vaults and work only after checking for unpushed WIP. |

`AGFLOW_HOME` relocates runner storage (default `~/.agflow`). Logs are under `runner/logs/`. If status says `needs_login`, run `agflow login` again; the runner reconnects itself. Three unclean exits in ten minutes cause a self-drain until `undrain`. Keep-awake on AC prevents idle sleep, not a closed lid; after a lost runner's lease expires, another attempt can continue from pushed WIP, and later recovered work is recorded separately.

## Start a project

`agflow start` turns a written spec into the hub's project in a few minutes: it seeds the repository, and the hub and
its runners move to it by themselves.

```bash
agflow operator-token set < operator-token.txt    # once: the hub's AGFLOW_OPERATOR_TOKEN, kept in the Keychain
agflow start --spec brief.pdf --spec https://example.com/rules.html --repo acme/afisha --create \
  --collaborator bob --stack python --deadline +36h
```

- **The spec.** Each `--spec` is a file or a URL, which curl downloads. Markdown and text are taken as they are, a PDF
  goes through `pdftotext -layout` when it is installed, and Word, RTF, OpenDocument and HTML files through macOS
  `textutil`. SPEC.md holds their text, and the originals go to `docs/spec/`. A file with no text, such as an image or
  a scanned PDF, gets a section in SPEC.md that asks the first task to transcribe it.
- **The seed commit.** SPEC.md, `docs/spec/`, AGENTS.md (the stack, where things go, the commands and the definition
  of done), a CLAUDE.md that includes it, `.agflow/config.json` (dependency preparation runs `scripts/install.sh`, and
  the check is `bash scripts/check.sh`), `scripts/install.sh`, `scripts/check.sh`, `scripts/demo.sh` and a
  `.gitignore`. The scripts do nothing in an empty project and run the stack's tools once its manifest exists:
  `--stack python` runs uv, pytest and ruff; `--stack typescript` runs Bun or npm, the tests and tsc; any other text
  gets scripts that say what to fill in. The seed goes on the hub's main branch (`AGFLOW_MAIN_BRANCH`, `main` by
  default), the one its attempts start from: the first commit of an empty repository, or a new commit on top of that
  branch, which starts from the default branch where the repository has none. Nothing is force-pushed.
- **The stack's tools.** Dependency preparation and the check run the scripts with the PATH that `agflow runner setup`
  recorded from the runner's login shell, so every runner of the project needs the `--stack` tools there: uv for
  python; Bun for typescript, and npm too once the project has a `package-lock.json`. On a runner set up before they
  were installed, stop the runner and rerun `agflow runner setup`, which records the PATH again. The Linux VM gets uv
  and Bun from its cloud-init ([A Linux runner](docs/linux-runner.md#create-the-vm)).
- **`--create`** makes the repository with `gh repo create --private`, and each `--collaborator <login>` is invited
  with write access. Both need `--repo owner/name`. A colleague accepts the invitation at
  `https://github.com/<owner>/<name>/invitations`; until then their runner cannot fetch the repository.
- **The hub.** The project is named `--name`, or after the repository. The hub writes an archive of its database to
  its backup folder, empties the old project (tasks, attempts, messages, events, the goal, approvals), keeps sign-ins,
  runners and vendor accounts, and sets the goal: implement SPEC.md, then keep improving the product until the
  deadline. A standing rule names the stack. `--deadline` is an ISO 8601 date and time with a zone, such as
  `2026-11-16T18:00:00+03:00`, or a span such as `+36h`. The hub is the one `agflow login` signed in to, or
  `--hub <url>`.

The operator token is read from `AGFLOW_OPERATOR_TOKEN`, then from the Keychain item `agflow-operator`, then from
`~/.agflow/operator-token` (mode 600). Whoever holds it can replace the hub's project, so prefer the Keychain. A
runner of an older agflow, which does not hear the project from the hub, keeps the old repository until it restarts.

## Runner permissions and risks

Agents run as the laptop owner's user. Four boundaries apply to their tools:

1. **Network:** Claude commands reach only allowlisted package registries; Codex commands have no network. Web search, account apps/connectors and extra MCP servers are disabled or refused at startup. Tools cannot reach the hub or git host directly.
2. **Writes:** tools write only inside the attempt clone, its private temporary directory and the runner's shared pip and uv caches (`~/.agflow/cache`). Claude's Edit/Write tools also have guards.
3. **Authority:** only the agflow bridge carries a scoped agent token to allowed hub routes. Lead authority requires the lead seat; an owner's CLI token cannot impersonate a runner agent.
4. **Git:** agents have no push credentials or route to the host. The runner alone fetches and pushes through its protected vault, with fenced updates, and never trusts the clone's git configuration during harvest.

**The open profile** (`"profile": "open"` in `runner.json`, or `--preset hackathon`) is for a hackathon on a laptop that runs only your own project. Claude's sandboxed commands reach any host: the registries without asking, and any other host the CLI asks about, which the runner allows. On a Mac they may also bind and reach local ports and use every unix socket, Docker's included. Claude keeps WebFetch and WebSearch, Codex commands get the network, and dependency preparation reaches any host, and on a Mac local ports. Agents may change the greenfield files listed below. Boundaries 1 and 4 no longer hold: commands reach the hub and the git host directly, and on a Mac the unix sockets Claude's commands may use include the owner's ssh-agent, so an agent can push with the owner's SSH keys. An agent misled by what it reads can send whatever its sandbox lets it read to any host.

On a Linux runner, under every profile, Claude's commands, dependency preparation and the submission check run under the sandbox's seccomp filter, which refuses them unix sockets: the user's systemd manager listens on one and would start any command outside the sandbox. The user's runtime directory (`/run/user/<uid>`), where it listens, is hidden from them too. Preparation and the check refuse to run without the filter, and the runner's dependency preparation check fails. Local ports work there within one command only: a server that one command starts is out of the next one's reach. A Codex command under the open profile may still reach the systemd manager's socket and get out of its sandbox ([A Linux runner](docs/linux-runner.md#what-differs-from-a-mac)).

The runner never auto-approves an escalation: requests go to the owner. Approving a Codex escalation runs that command **outside the sandbox**, with network and the owner's full write access. M2 has no mid-turn Claude approval relay; a refused operation needs human intervention. Managed device policies remain in force: agflow does not bypass MDM or weaken the vendor's policy. The `auto` Claude profile can classify Bash commands within its sandbox; that is not permission to escape it.

These boundaries do not provide complete read isolation. Codex can read most owner-readable files; both sandboxes allow same-user process arguments/environment to be read, so attempts on one laptop trust each other. Claude denies credential paths and other runner data, and sandbox checks cover keychain access. Registry requests remain an exfiltration risk. Trusted base/project hooks and configuration can execute outside the sandbox; review agent configuration on main. Claude's shell snapshot can source the owner's profile outside the sandbox, and its CLI makes some cache/config writes into the owner's HOME despite a separate config directory. Lifecycle scripts can execute code from manifests agents edit. See [the security model](docs/superpowers/specs/2026-10-28-m2-runners-design.md#5-security-model-for-runner-agents) for the full boundaries and residual risks.

## Take over and hand back

On a task page, **Take over** is available for a running or quota-waiting attempt on an online runner, with no pending submission or stop. Otherwise use **Stop and hold** to pause work at its last WIP. Take-over blocks the task and keeps its path ownership; the lead cannot unblock it.

The runner asks for a handoff, stops the agent, saves WIP, restores protected paths and replaces the clone's `.git` with a fresh runner-built one. Wait for success before entering the clone: a failed take-over shows its error and no local command. The page supplies a local resume command using the attempt's pinned CLI version and runner vendor home, or an anywhere fetch/branch command and a ref to push your work to.

When finished, exit the resumed chat and every terminal/editor process in the clone, then choose **Hand back**. The clone option harvests your commits and uncommitted work; `process_running` names processes to close before retrying. The pushed-ref option needs the ref and its full 40-hex commit SHA and does not need the runner. The task becomes ready for a new attempt. If a clone hand-back loses the runner or times out, work resumes from the last recorded position and a later push becomes late work. Use Hand back, not Unblock, for a taken-over task.

## Dependencies and protected paths

People configure preparation, and the check every submission must pass, in a committed `.agflow/config.json`:

```json
{
  "dependencies": [
    {
      "run": ["bun", "install", "--frozen-lockfile", "--ignore-scripts"],
      "when": ["package.json", "bun.lock"]
    }
  ],
  "check": "bun test"
}
```

Without the file, nothing is prepared. The runner reads it from the vault at the protected restore base, never from agent-edited working files. Worker starts/resumes prepare when the listed files change; workers can also request `prepare_dependencies`. Leads get no preparation. A failed preparation fails the start or resume, but on a runner with the open profile the agent starts anyway and installs what it needs itself. Commands run in a sandbox with registry-only network, no owner credentials and writes confined to the clone and preparation cache, with a 15-minute timeout. Private registries are outside M2. Lifecycle scripts are disabled by default; an entry that needs them declares `"scripts": true` and uses a per-attempt cache (remove `--ignore-scripts` from that command). Go and Cargo always use per-attempt caches. pip and uv use the runner's shared caches in `~/.agflow/cache/`, which agents and every preparation on that runner write. If the sandbox check fails, preparation is unavailable on that runner.

`check` is one shell command. At each submission the runner reads it from `main`, merges `main` into the agent's branch in its clone (a conflict refuses the submission and names the files), prepares the dependencies again when the merge changed their listed files, then runs the check there with `/bin/sh -c`, in the preparation sandbox and environment, with scripts allowed. It may run for `checkMinutes` of `runner.json`, 10 by default. A check that fails, or a preparation before it that fails, refuses the submission with the last 60 lines of its output, and the agent fixes it. On a runner with the open profile a failed preparation refuses nothing: the check runs anyway, and its output ends with a note of the failure. The result (passed, failed or none, with the end of the output) goes with the submission to the lead and to `fetch_submission`, and with `AGFLOW_AUTO_ACCEPT=1` a passed check accepts the submission. Without a check, or on a runner that cannot run one, submissions go to the lead as before. So does a submission whose branch changes the check's own files: `.agflow/config.json`, or a file the check command names, such as `scripts/check.sh`. So does one whose check ran no tests: the check `agflow start` seeds prints the line `agflow-check: no tests ran` whenever it ran none, and the lead then reviews the work itself, so the skeleton task adds a first test. Nothing else is caught: a branch that changes the `package.json` scripts the check runs, test configuration such as `tsconfig.json` or `pyproject.toml`, or the tests themselves is still accepted by the hub alone. The periodic demo check, which the lead reviews, is the backstop.

With `AGFLOW_AUTO_MERGE=1`, after each merge one runner checks `main` as agflow merged it: in a fresh clone at that commit, with the dependencies prepared, as at a submission, and apart from the merges, which never wait for it. A failure creates one task at the top priority, "Fix main: the check fails after T-42", and tells people and the lead; while `main` fails, an agent whose own check fails hears which task fixes `main`, so it keeps its change focused. A pass afterwards tells people and cancels that task if nobody has started it. The Load page shows where the check of `main` passed, or since when it fails. Only runners of this release (runner protocol 4) check `main`: upgrade the hub first, then the runners.

Protected paths are matched case-insensitively. The runner restores them before starts, resumes, preparation and take-over, strips unauthorized changes from WIP, and refuses a submission containing them:

| Class | Paths | Exception |
|---|---|---|
| Agent configuration | `.claude/**`, `.codex/**`, `.mcp.json`, `.agents/**`, `.agflow/**` (except untracked `.agflow/run/`), `.husky/**`, `.pre-commit-config.yaml`, `lefthook.yml`, `.envrc`, `.devcontainer/**`, `.vscode/**`, `.idea/**`, `.npmrc`, `.yarnrc*`, `bunfig.toml`, `.tool-versions` | None for runner agents; tasks owning these paths are for people/live chats. |
| People only | `.github/workflows/**`, `.gitlab-ci.yml`, `.gitlab/**`, `.env*`, `*.pem`, `*.key`, `.gitmodules`, `.gitattributes` | A person created the task and its owned paths explicitly include them. |
| Curators only | `AGENTS.md`, `CLAUDE.md` at any depth | A task of kind `curation`. |

**Greenfield files.** On a runner with the open profile, agents may change `.env*` files, `.gitattributes`, `.github/workflows/**`, `bunfig.toml`, `.npmrc`, `.tool-versions`, `.agflow/config.json`, `AGENTS.md` and `CLAUDE.md` in any task. The rest of `.agflow/` stays protected. A task whose owned paths include these files goes only to such a runner, instead of to live chats.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `AGFLOW_AUTH` | `github` | `github` for GitHub sign-in, `dev` for local testing |
| `AGFLOW_ALLOWED_USERS` | (required) | Comma-separated GitHub logins allowed to sign in |
| `AGFLOW_PROJECT_NAME` | (required) | Project name shown to people and agents, for a new database; a project reset (`agflow start`) replaces it |
| `AGFLOW_PROJECT_REPO` | (required) | URL of the project's git repository, for a new database; a project reset replaces it |
| `AGFLOW_PUBLIC_URL` | `http://localhost:<port>` | Address people and laptops use to reach the hub, an `http://` or `https://` URL; `https://` makes session cookies secure |
| `AGFLOW_HOST` | `127.0.0.1` with `AGFLOW_AUTH=dev`, otherwise `0.0.0.0` | Listening address; `::` accepts IPv6 as well as IPv4 |
| `AGFLOW_PORT` | `8787` | Listening port, 1 to 65535 |
| `AGFLOW_DB` | `data/agflow.db` | SQLite database file |
| `AGFLOW_BACKUP_DIR` | `data/backups` | Hourly snapshots (24 hours), daily snapshots (newest 7) and start snapshots (newest 3), and the archive of each project a reset replaced (never pruned) |
| `AGFLOW_WEB_DIST` | (unset) | Folder with the built web UI |
| `AGFLOW_OPERATOR_TOKEN`, `AGFLOW_OPERATOR_USER` | (unset) | Token for the operator routes (goal, deadline, mark merged, unblock, message, project reset) and the allowed login they act as; `agflow start` reads it on the owner's laptop. See [docs/deploy-hub.md](docs/deploy-hub.md#operator-access) |
| `AGFLOW_DEPENDENCIES_NEED_MERGE` | `0` | `1`: a dependency is done only once it is merged, not when it is accepted, so dependents start from a main branch that holds it |
| `AGFLOW_AGENT_FETCH` | `0` | `1`: the hub downloads public web pages for Claude runner agents, for the lead and for the tasks the lead grants internet access; an agent that reads hostile text can then leak what its sandbox lets it read through the addresses it asks for. See [docs/deploy-hub.md](docs/deploy-hub.md#unattended-operation) |
| `AGFLOW_LEAD_APPROVALS` | `0` | `1`: the agent holding the lead seat may answer the approval requests of other agents' Codex attempts: decline any of them with a reason, and approve them on a runner whose device policy does not reserve approvals to its owner, so a command the lead approves runs outside the sandbox on its owner's laptop without a person looking at it. |
| `AGFLOW_AUTO_APPROVALS` | `0` | `1`: the hub approves every approval request itself the moment it arrives, on any runner whose device policy does not reserve approvals to its owner: every command an agent asks to run outside the sandbox runs there, and no one reads it first. |
| `AGFLOW_AUTO_MERGE` | `0` | `1`: agflow merges accepted work into main itself. A runner merges one accepted task at a time and pushes main with its owner's git credentials, so main must accept direct pushes; a conflict sends the task back to its author. Dependencies then wait for the merge, and accepted work keeps its owned paths until it is merged. See [docs/deploy-hub.md](docs/deploy-hub.md#unattended-operation) |
| `AGFLOW_AUTO_ACCEPT` | `0` | `1`: the hub accepts a runner submission whose check passed (`check` in `.agflow/config.json`) the moment it is recorded, without waking the lead; the lead's next situation report lists these tasks. A submission with no check goes to the lead as before, and so do a demo check, a check that ran no tests and a branch that changes the check's own files; agflow's own fix of `main` is accepted like any other task, and a branch that changes `package.json` scripts, test configuration or the tests is still accepted ([details](#dependencies-and-protected-paths)). |
| `AGFLOW_DEMO_CHECK_EVERY` | `5` | After every this many tasks merged (or accepted, without `AGFLOW_AUTO_MERGE` and while nothing marks tasks merged) the hub creates a demo-check task: an agent runs the product from `main`, walks the flows in `SPEC.md`, saves screenshots under `docs/qa/` and records each requirement in `docs/STATUS.md`. `0` turns it off. See [docs/deploy-hub.md](docs/deploy-hub.md#unattended-operation) |
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
| `AGFLOW_LEAD_REVIEW_MINUTES` | `45` | Interval of the periodic review message to the lead, which lists the held and submitted tasks, while any work is held or submitted |
| `AGFLOW_IDLE_NUDGE_SECONDS` | `60` | How long free worker slots must outnumber the ready tasks that can start before the runner lead is told to plan more; see [docs/deploy-hub.md](docs/deploy-hub.md#unattended-operation) |
| `AGFLOW_IDLE_NUDGE_MINUTES` | `5` | Least time between two of those messages to the lead; `0` turns them off |
| `AGFLOW_LIVE_LEAD_GRACE_MINUTES` | `120` | Live lead absence grace |
| `AGFLOW_QUOTA_WAIT_MINUTES` | `45` | Maximum quota wait before a worker is replaced on another account; a lead is replaced at once |
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

For a hackathon run unattended, [Hackathon settings](docs/deploy-hub.md#hackathon-settings) lists the values to set and why.

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

`bun test` and `bun run typecheck` are the baseline CI gate; UI changes also need `bun run check:ui`. Adapter smoke tests use `AGFLOW_SMOKE=1`; sandbox checks additionally use `AGFLOW_SANDBOX_CHECKS=1`. Run both vendors' smoke and sandbox checks on a supported Mac. Platform-specific tests skip on Linux because they check macOS behaviour (design 7.1); the Linux runner's branches are tested on every platform, with the platform passed in. The E2E gate (`AGFLOW_E2E=1 bun run e2e`) uses a local hub, three scratch runner homes, a bare origin and scripted servers on loopback; once enabled, missing prerequisites fail instead of silently skipping. It covers killed agents, closed laptops, lost leads, runner/hub restarts, hub restore, mid-turn delivery and take-over/hand-back. These scripted checks spend no model quota; vendor processes use isolated homes and a refusing external proxy.

`AGFLOW_TEST=1` enables hub test mode. `AGFLOW_TEST_CONFIG` is a JSON object of recognized `HubConfig` millisecond fields (including `infraBackoffMs`, an array), for example `'{"runnerLeaseMs":30000,"tickMs":100}'`. Unknown fields and non-positive values are refused; setting it without test mode is an error. Runner test mode can redirect vendors to scripted servers, skip auth checks and allow short timings through the `test` block in `runner.json`. It posts no notifications and refuses service installation.

The following commands are **manual real-model runs**, outside the zero-model test gates. They use vendor logins and subscription quota. `record:claude --live` also uses real quota; its default above is scripted.

```bash
bun run verify:real-clis                  # M1 live-chat bridge check with real vendor logins
bun run live-run                          # caffeinate -i bun scripts/live-run.ts
bun run live-run --takeover claude,codex  # M2 exit run, including both TTY resume checks
```

Follow the [M2 live-run runbook](docs/m2-live-run.md) for prerequisites, the throwaway repository, options and the Results table. The live exit gate remains pending until those results are recorded.

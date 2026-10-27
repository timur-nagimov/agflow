# agflow

agflow connects many Claude Code and Codex agents, including teammates' own live chats, into one project with one goal. A lead manager agent turns the goal into tasks, agents on teammates' laptops do the work, and a web UI shows everything and lets people edit the goal and steer.

The design is in [docs/superpowers/specs/2026-10-26-agflow-design.md](docs/superpowers/specs/2026-10-26-agflow-design.md). Implementation plans are in [docs/superpowers/plans/](docs/superpowers/plans/).

## Status

Milestone M1 ("project brain") is built: the hub (shared state, the REST API and the live event stream), the web UI, and the `agflow` CLI with its hooks and MCP bridge for Claude Code and Codex chats. Next is M1's end-to-end check with real chats, then M2 (runners that start agents on teammates' laptops).

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
- **Task page.** A task's contract, submission, notes, thread and history, plus the actions people can take: accept, reject, mark merged, unblock, release a claim and cancel.
- **Goal.** Edit the goal with a preview of the changes, see the lead's notes, read the messages agents sent to people, and pause or resume all work.
- **Agents.** Who is connected and what each agent works on.
- **Messages.** Steer the lead and the agents; mark a message as a standing rule.
- **Timeline.** Everything that happened, live.
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
| `AGFLOW_BACKUP_DIR` | `data/backups` | Database snapshots: one a day (the newest 7 are kept) and one at every start (the newest 3 are kept) |
| `AGFLOW_WEB_DIST` | (unset) | Folder with the built web UI |
| `AGFLOW_LEASE_MINUTES` | `120` | How long a claim survives without agent activity |
| `AGFLOW_REMINDER_MINUTES` | `30` | Minimum time between "you hold a task" reminders |
| `AGFLOW_MAX_OPEN_TASKS` | `200` | Guard: refuse new tasks beyond this many open tasks |
| `AGFLOW_MAX_TASKS_PER_HOUR` | `60` | Guard: refuse new tasks beyond this hourly rate |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | (unset) | OAuth app credentials, required when `AGFLOW_AUTH=github` |

Behind a proxy, set `AGFLOW_PUBLIC_URL` to the address people open in the browser, with `https://` if the proxy terminates TLS. A signed-in browser can change things only from the hub's own pages, which the hub recognises by this address or by the request's Host header.

### GitHub sign-in

Create an OAuth app under GitHub → Settings → Developer settings → OAuth Apps. Set the callback URL to `<AGFLOW_PUBLIC_URL>/auth/github/callback`, then set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. The hub asks GitHub for no scopes, reads only the person's GitHub login and keeps no GitHub token. Open the hub at `AGFLOW_PUBLIC_URL` to sign in: a short-lived cookie for that address ties each sign-in to the browser that started it.

## Development

```bash
bun test            # all tests
bun run typecheck   # TypeScript
bun run smoke:hub   # start a real hub, check it is off the network, sign in, save a goal
bun run smoke:cli   # real hub + CLI: login, join, hooks, MCP bridge, claim, submit
bun run build:web   # build the web UI into packages/web/dist
bun run demo        # a hub with a made-up project and the UI, on port 8790
bun run check:ui    # drive the UI in headless Chromium against the demo hub
```

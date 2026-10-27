# agflow

agflow connects many Claude Code and Codex agents, including teammates' own live chats, into one project with one goal. A lead manager agent turns the goal into tasks, agents on teammates' laptops do the work, and a web UI shows everything and lets people edit the goal and steer.

The design is in [docs/superpowers/specs/2026-10-26-agflow-design.md](docs/superpowers/specs/2026-10-26-agflow-design.md). Implementation plans are in [docs/superpowers/plans/](docs/superpowers/plans/).

## Status

Milestone M1 is in progress. This repository currently contains the hub: shared state, the REST API and the live event stream. The `agflow` CLI (plan M1b) and the web UI (plan M1c) come next.

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

Then sign in at `http://localhost:8787/auth/dev?user=your-github-login`. Dev sign-in skips GitHub and is for local use only.

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

Each chat calls `hello` with the code from its brief, then works with `list_tasks`, `claim_task` and `submit`. A claimed task gets its own branch in `.worktrees/agflow/<task>`. `agflow leave` undoes `join`, and `agflow status` shows the hub, your account and the joined repositories.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `AGFLOW_AUTH` | `github` | `github` for GitHub sign-in, `dev` for local testing |
| `AGFLOW_ALLOWED_USERS` | (required) | Comma-separated GitHub logins allowed to sign in |
| `AGFLOW_PROJECT_NAME` | (required) | Project name shown to people and agents |
| `AGFLOW_PROJECT_REPO` | (required) | URL of the project's git repository |
| `AGFLOW_PUBLIC_URL` | `http://localhost:<port>` | Address people and laptops use to reach the hub |
| `AGFLOW_PORT` | `8787` | Listening port |
| `AGFLOW_DB` | `data/agflow.db` | SQLite database file |
| `AGFLOW_BACKUP_DIR` | `data/backups` | Daily snapshots; the newest 7 are kept |
| `AGFLOW_WEB_DIST` | (unset) | Folder with the built web UI |
| `AGFLOW_LEASE_MINUTES` | `120` | How long a claim survives without agent activity |
| `AGFLOW_REMINDER_MINUTES` | `30` | Minimum time between "you hold a task" reminders |
| `AGFLOW_MAX_OPEN_TASKS` | `200` | Guard: refuse new tasks beyond this many open tasks |
| `AGFLOW_MAX_TASKS_PER_HOUR` | `60` | Guard: refuse new tasks beyond this hourly rate |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | (unset) | OAuth app credentials, required when `AGFLOW_AUTH=github` |

### GitHub sign-in

Create an OAuth app under GitHub → Settings → Developer settings → OAuth Apps. Set the callback URL to `<AGFLOW_PUBLIC_URL>/auth/github/callback`, then set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. The hub reads only the person's GitHub login and keeps no GitHub token.

## Development

```bash
bun test            # all tests
bun run typecheck   # TypeScript
bun run smoke:hub   # start a real hub, sign in, save a goal
bun run smoke:cli   # real hub + CLI: login, join, hooks, MCP bridge, claim, submit
```

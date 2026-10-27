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
| `AGFLOW_BACKUP_DIR` | `data/backups` | Database snapshots: one a day (the newest 7 are kept) and one at every start (the newest 3 are kept) |
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
```

# Run a shared hub on Yandex Cloud

This runbook uses Ubuntu 24.04 x86_64, 2 vCPU, 4 GB RAM and a 10 GB network SSD. Bun is pinned to 1.3.11 at `/usr/local/bin/bun`; Ubuntu's Caddy 2.6 terminates HTTPS and proxies to `127.0.0.1:8787`. The hub runs as `agflow`, administration over SSH as `agflow-admin`. Both people run agents on their own Apple silicon Macs; the server runs no vendor CLI and holds no repository or model credentials.

The existing VM is already provisioned: start at **Choose the public URL**. The creation recipe below is for a replacement or a new installation. Commands in this document are operator actions; the deployment tests never execute them against a host.

## Create a VM (new installations only)

Install/authenticate the Yandex Cloud CLI on the administrator's computer, plus `jq` and Python 3. Select an existing VPC and subnet in the chosen zone. The administrator needs permission to create VMs, disks, static addresses, security groups and snapshot schedules in the folder.

```bash
export FOLDER_ID=b1g_REPLACE
export NETWORK_ID=enp_REPLACE
export SUBNET_ID=e9b_REPLACE
export ZONE=ru-central1-a
export ADMIN_CIDR=203.0.113.10/32   # replace with your SSH source IP/CIDR
export SSH_PUBLIC_KEY_FILE="$HOME/.ssh/id_ed25519.pub"
bash deploy/hub/yc-create.sh --execute
```

[yc-create.sh](../deploy/hub/yc-create.sh) creates a security group allowing SSH only from `ADMIN_CIDR`, public TCP 80/443, and outbound traffic; **8787 is never public**. It reserves an IPv4 address, creates the VM and attaches its boot disk to a daily 03:00 UTC snapshot schedule retaining seven snapshots. Boot-disk auto-delete is disabled. It prints resource IDs and an `sslip.io` hostname. It is a creation recipe, not an idempotent reconciler: after a partial failure inspect resources by name before retrying. Resources and reserved addresses continue to incur costs until removed.

[cloud-init.yaml](../deploy/hub/cloud-init.yaml) provisions both users, directories, Caddy and Bun. It downloads `bun-linux-x64.zip` and `SHASUMS256.txt` from the pinned GitHub release, checks the archive with `sha256sum`, and only then installs it. It does not use `bun.sh` or depend on `HOME` during cloud-init. Metadata contains only the administrator's public SSH key, never OAuth secrets. The journal is capped at 200 MB to fit the small disk.

Connect once interactively, verifying the SSH host fingerprint through your trusted cloud console before accepting it. Deployment uses `StrictHostKeyChecking=yes` and fails on unknown or changed keys.

```bash
ssh agflow-admin@VM_IP
sudo cloud-init status --wait
sudo cloud-init status --long
/usr/local/bin/bun --version       # must print 1.3.11
caddy version                    # Ubuntu 2.6.x
```

Check the first completed disk snapshot in the cloud console; a schedule's existence alone is not proof that backups work. Keep the two administrators' SSH source addresses in the security group if both need server administration. The colleague only needs HTTPS for normal use.

The commands follow Yandex's [security-group documentation](https://yandex.cloud/en/docs/vpc/operations/security-group-create), [VM CLI reference](https://yandex.cloud/en/docs/cli/cli-ref/compute/cli-ref/instance/create) and [snapshot-schedule documentation](https://yandex.cloud/en/docs/compute/operations/snapshot-control/create-schedule).

## Choose the public URL and create the GitHub OAuth app

Point a DNS A record at the reserved IPv4, or use `https://<ip-with-dashes>.sslip.io`, for example `https://203-0-113-10.sslip.io` (replace this documentation IP). Confirm that the name resolves publicly to this VM. Use the origin without a path, port or trailing slash throughout. Keep ports 80 and 443 open so Caddy can obtain and renew a publicly trusted certificate.

On GitHub, open **Settings → Developer settings → OAuth Apps → New OAuth App** and enter:

| Field | Value |
| --- | --- |
| Application name | `agflow — <project>` |
| Homepage URL | `https://YOUR_PUBLIC_HOST` |
| Application description | `Shared agflow hub for <project>` (optional) |
| Authorization callback URL | `https://YOUR_PUBLIC_HOST/auth/github/callback` |
| Enable Device Flow | Leave unchecked; agflow uses its own browser-approved CLI login |

Register the app and generate a client secret. Record its **Client ID** and **Client secret** in `/etc/agflow/hub.env` below. These are OAuth app credentials, not a personal access token. The hub requests no GitHub scopes, reads the user's GitHub login and discards the GitHub access token. Repository permissions belong to each Mac's separate git login.

If the hostname changes, update the OAuth app's homepage/callback, `AGFLOW_PUBLIC_URL`, and the deploy URL together. Existing Mac credentials still point at the old URL; sign in again to the new one.

## Configure the host

Copy the example to the host without secrets, then edit it on the host. This is the only manual configuration file; deployments deliberately preserve it.

```bash
scp deploy/hub/hub.env.example agflow-admin@VM_IP:/tmp/agflow-hub.env.example
ssh agflow-admin@VM_IP
sudo install -d -o root -g root -m 0700 /etc/agflow
sudo install -o root -g root -m 0600 /tmp/agflow-hub.env.example /etc/agflow/hub.env
rm /tmp/agflow-hub.env.example
sudoedit /etc/agflow/hub.env
```

Replace every `REPLACE_*` field. Set both GitHub logins in `AGFLOW_ALLOWED_USERS`, project name/repo, and the public HTTPS URL. Use a repository URL that both Macs can fetch and push with their own git credentials. Keep the supplied host, port, database, backup and web-dist paths. The deployment validates these paths and refuses dev/test auth settings. Do not put secrets in the checkout, a release, cloud-init, shell arguments or Git. The file uses systemd EnvironmentFile syntax: `KEY=value`, quote spaces, one value per line, no `export` or inline comments. Do not shell-source it.

All production environment variables read by `loadConfig` are documented in [hub.env.example](../deploy/hub/hub.env.example). `AGFLOW_WEB_DIST` is essential: without it the API runs but the UI is not served. Hub worker capacity defaults to four across the two Macs; this is separate from each runner's capacity (normally two). Only workers take a runner's slots: a runner lead takes none, nor does a worker waiting for its quota, so a Mac runs its capacity of workers beside the lead, and its other vendor starts while one waits.

On an already provisioned host, confirm `/opt/agflow/releases` exists, is root-owned/readable, and `/var/lib/agflow/{data,backups}` belong to `agflow`. The [unit](../deploy/hub/agflow-hub.service) uses a read-only filesystem except `/var/lib/agflow` and its private temporary directory. SQLite DB/WAL/SHM, PID lock, backup snapshots and restore side files stay under that state directory. Releases and `/etc` remain read-only to the hub. Bun's JIT requires executable memory, so `MemoryDenyWriteExecute` is deliberately absent. SIGTERM runs the hub's shutdown handler and WAL checkpoint with a 90-second stop allowance.

## Deploy and upgrade

From a clean, committed checkout on the administrator's computer:

```bash
bash scripts/deploy-hub.sh --dry-run agflow-admin@VM_IP https://YOUR_PUBLIC_HOST
bash scripts/deploy-hub.sh agflow-admin@VM_IP https://YOUR_PUBLIC_HOST
```

The dry run checks the worktree (including untracked files) and prints the plan without SSH, uploads, downloads or credential reads. A real deployment archives exactly HEAD, transfers it over SSH, and runs the committed activation script under `sudo -n`. The server needs no Git credentials. The operator account needs passwordless sudo as provisioned above; SSH uses your usual agent/key, without agent forwarding.

Activation holds a deployment lock and builds a staged release using `bun install --frozen-lockfile` and `bun run build:web` as `agflow-admin` with a temporary build home/cache. It makes the completed release root-owned and readable by `agflow`, validates Caddy and systemd configuration, atomically replaces `/opt/agflow/current`, refreshes changed configurations and restarts the hub. An existing release SHA is reused. Upgrades use the same command; deploy the hub before upgrading Mac runners.

Readiness requires the running service plus `https://YOUR_PUBLIC_HOST/api/auth-config` returning GitHub auth through Caddy with a trusted certificate. The server resolves this check to its own loopback so it does not depend on public-IP NAT hairpin support. The wait permits roughly five minutes for initial certificate issuance. The local script also checks the public URL from your computer after activation; failure of this final check means inspect external DNS/firewall/routing, since the server already passed its TLS health check. It does not undo an otherwise healthy release for an external connectivity failure.

If activation or server readiness fails, the script restores the previous symlink, systemd unit and Caddyfile and restarts the previous release. On first-install failure it stops the hub and removes the new current link. Build/configuration validation failures leave the old service running. Successful deployments retain the current release, the previous release and the newest other release, deleting older SHA directories. Interrupted builds or failed releases can remain after a power loss: inspect `.staging.*`/failed SHA directories when reclaiming disk space; never remove `current` or the previous working release.

**Code rollback does not undo database migrations.** Before an upgrade that changes schema, preserve a known-good backup and check backward compatibility. If old code cannot open the upgraded database, leave the service stopped and use the offline restore procedure below. Do not repeatedly restart incompatible code. `hub.env` is never rolled back; correct any configuration change yourself.

After deployment open the UI, sign in as each allowed user, check live Timeline updates, and connect one Mac runner. Check the Caddy certificate and runner reconnect after a hub restart. These are deployment acceptance checks, separate from the local regression suite.

### Upgrading to schema version 4

This release moves the database from schema version 3 to 4. Version 4 adds two columns: the project's deadline
(`project.deadline_at`) and the runner's check result of a submission (`submissions.check_result`). The hub migrates
the database in place the first time it starts. The previous release cannot open a version 4 database: it stops at
start with "database schema version 4 is newer than this hub supports (3)".

The way back to the previous release keeps everything except the deadline and the check results. Stop the hub and
take out what version 4 added:

```bash
sudo systemctl stop agflow-hub
sudo -u agflow sqlite3 /var/lib/agflow/data/agflow.db <<'SQL'
BEGIN;
ALTER TABLE submissions DROP COLUMN check_result;
ALTER TABLE project DROP COLUMN deadline_at;
DELETE FROM schema_migrations WHERE version = 4;
COMMIT;
SQL
```

Then start the previous release. Deploying this release again later migrates the database to version 4 again.

### Upgrading to schema version 3

This release moves the database from schema version 2 to 3. Version 3 adds two tables: the internet grants
(`task_fetch_grants`) and the record of what agents fetched (`agent_fetches`). Both stay empty unless
`AGFLOW_AGENT_FETCH=1`. The hub migrates the database in place the first time it starts.

The previous release cannot open a version 3 database: it stops at start with "database schema version 3 is newer
than this hub supports (2)", and it cannot restore a backup written after the upgrade either. So a deployment that
fails after the migration and rolls back leaves the previous hub unable to start.

Before deploying, copy the newest backup aside, under a name the backup rotation does not remove:

```bash
sudo -u agflow sh -c 'cp -p "$(ls -t /var/lib/agflow/backups/agflow-*.db | head -n 1)" /var/lib/agflow/backups/before-schema-3.db'
sudo ls -l /var/lib/agflow/backups/before-schema-3.db
```

The way back to the previous release does not need that backup, and keeps everything done since the upgrade except
the grants and the record of fetches. Stop the hub and take out what version 3 added:

```bash
sudo systemctl stop agflow-hub
sudo systemctl is-active agflow-hub    # should report inactive
sudo apt-get install -y sqlite3        # once: the host template does not install it
sudo -u agflow sqlite3 /var/lib/agflow/data/agflow.db <<'SQL'
BEGIN;
DROP TABLE agent_fetches;
DROP TABLE task_fetch_grants;
DELETE FROM schema_migrations WHERE version = 3;
COMMIT;
SQL
```

Then start the previous release. After a deployment that rolled back by itself it is already in place:
`sudo systemctl start agflow-hub`. Otherwise deploy it with the usual command. It ignores `AGFLOW_AGENT_FETCH` and
`AGFLOW_LEAD_APPROVALS` in `hub.env`. To keep the record of fetches, save it before the statements above:
`sudo -u agflow sqlite3 /var/lib/agflow/data/agflow.db ".dump agent_fetches" > agent_fetches.sql`. Deploying this
release again later migrates the database to version 3 again, with both tables empty. Restore
`before-schema-3.db` only if the database itself is damaged: it brings back the state of that backup and loses
what happened since.

## Add or remove a person

Grant the colleague read/write access to the project repository on GitHub and add their GitHub login (not display name/email) to the comma-separated `AGFLOW_ALLOWED_USERS`. Then:

```bash
sudoedit /etc/agflow/hub.env
sudo systemctl restart agflow-hub
```

The allowlist is checked whenever a session verifies; removing a login invalidates its web/CLI use. Restart closes existing runner and SSE connections, so the removed user cannot retain an old stream. The colleague signs in via GitHub in the browser and via `agflow login` on their Mac. They do not need the OAuth app secret, a cloud account or SSH access. Allowlisting does not grant repository access, and repository access alone does not grant hub access.

## Operator access

M2 leaves merging to people: the lead accepts a task and a person merges its branch and marks it merged. With
`AGFLOW_AUTO_MERGE=1` agflow merges accepted work itself ([Unattended operation](#unattended-operation)), and no
script needs to. To run a project unattended without it, an operator script can do the bookkeeping. Set `AGFLOW_OPERATOR_TOKEN` (at least 32 characters,
for example `openssl rand -hex 32`) and `AGFLOW_OPERATOR_USER` (an allowed login the script acts as) in
`/etc/agflow/hub.env` and restart. Seven routes then accept the header `X-Agflow-Operator: <token>`:

| Route | Does |
|---|---|
| `PUT /api/operator/goal` `{ "text": string, "baseVersion": number }` | sets the project goal (the usual version check applies) |
| `PUT /api/operator/deadline` `{ "deadline": string \| null }` | sets when the project must be done, as an ISO 8601 date and time with `Z` or an offset (`2026-11-16T18:00:00+03:00`); `null` takes it away |
| `POST /api/operator/tasks/:id/merged` `{ "sha"?: string }` | marks an accepted task merged |
| `POST /api/operator/tasks/:id/unblock` `{ "note"?: string }` | unblocks a task |
| `POST /api/operator/messages` (same body as `POST /api/messages`) | sends a message as the operator's person |
| `GET /api/operator/project` | answers the project, its number of tasks, and the hub's main branch (`AGFLOW_MAIN_BRANCH`), where `agflow start` puts the seed |
| `POST /api/operator/project/reset` `{ "name", "repo", "deadline": ISO 8601 or null, "goal", "rules": string[] }` | replaces the project with a new one ([Start a new project](#start-a-new-project)) |

Call them on the server (`curl http://127.0.0.1:8787/...`), so the token never leaves it; `agflow start` is the one
caller meant for a laptop. Without the token the routes do not exist. A person's CLI token, which runners hold, still
cannot use people's controls. The events record the operator's person as the actor. A person signed in to the web UI
can set the deadline too, with the same body on `PUT /api/project/deadline`. The reset takes its deadline by the same
rule. The lead sees the deadline and the time left in every situation report, and plans only fixes in the last hour.

With an operator that merges, also set `AGFLOW_DEPENDENCIES_NEED_MERGE=1`: a dependency then counts as done only once
it is marked merged, so the hub releases dependent tasks after their dependencies are in `main`, not at acceptance.

## Start a new project

`agflow start` on the owner's Mac seeds a repository with a spec and calls `POST /api/operator/project/reset`, so a new
project needs no ssh; the README's [Start a project](../README.md#start-a-project) shows the command. Store the operator
token on that Mac once, with `agflow operator-token set < token-file` (the Keychain item `agflow-operator`). The token
then lives on a laptop where agents run: whoever reads it can replace the project. Prefer the Keychain to
`~/.agflow/operator-token`, which any process of the owner's can read. When the hub's project has tasks,
`agflow start` asks before it seeds or resets anything, and without a terminal it refuses unless given `--yes`.

The reset, in one go:

1. writes a copy of the whole database to `agflow-archive-<old project>-<time>.db` in the backup folder, which
   retention never prunes;
2. empties the old project: tasks, attempts, submissions, messages, events, goal versions and notes, lead and task
   notes, approvals, deliveries, the runner commands about its work, internet grants and the record of agent fetches,
   runner agents and their tokens, attempt logs, rejected runner events and the lead seat;
3. keeps sessions, CLI sign-ins, people's live agents, runners and vendor accounts with their quota limits, but
   clears every owner-away mark (left by an approval that expired) and the runners' counts of failed starts;
4. sets the name, repository and deadline, unpauses, clears the worker target and the vendor preference, and raises
   the epoch and the id counters as a restore does, so no new attempt, branch or ref collides with an old one; the
   epoch also goes to the backup folder's `epoch` file, so a later restore of an older backup lands above it;
5. sets goal v1 and posts the rules as standing rules, as the operator's person (event `project.reset`, and
   `project.deadline_set` when there is a deadline);
6. closes every runner link. Each runner says hello again, and the hub, which no longer knows the attempts it
   reports, lists them in the welcome's stop list, as after a restore.

Runners of this release hear the new project in the welcome and open its vault without a restart; the old project's
last work goes to its own repository. A runner of an older release keeps the old repository until it restarts.
`AGFLOW_PROJECT_NAME` and `AGFLOW_PROJECT_REPO` only name a new database's first project: after a reset, the
database's project is the hub's.

This replaces the manual procedure: drain the runners, stop the hub, move the database aside, start it, copy the
sessions back, raise the epoch with the restore tool, set the goal and undrain. To go back to an archived project,
restore its archive as a backup ([Backups and restore](#backups-and-restore)).

## Unattended operation

By default a person merges accepted work, brings outside data into the repository and answers every approval request,
and the lead reviews every submission. Eight opt-in settings in `/etc/agflow/hub.env` take these out of people's hands. All are off unless set; restart the hub
after a change. The details are in the
[M2 design, Unattended options](superpowers/specs/2026-10-28-m2-runners-design.md#unattended-options).

- **Operator token and routes** ([Operator access](#operator-access)). Removes: setting the goal and the deadline,
  marking tasks merged, unblocking, messaging the lead and starting a new project by hand. Risk: whoever reads the
  token acts as the operator's person on those routes, the project reset included, so keep it on the server, or in the
  owner's Keychain for `agflow start`.
- **`AGFLOW_DEPENDENCIES_NEED_MERGE=1`.** Removes: checking that a dependency reached `main` before dependent work
  starts. Risk: if nothing marks accepted tasks merged, dependent tasks wait forever. Set it only together with an
  operator that merges. `AGFLOW_AUTO_MERGE=1` works this way by itself.
- **`AGFLOW_AGENT_FETCH=1`.** Removes: fetching outside data for agents. The hub downloads one public URL at a time
  for a Claude agent, for the lead and for the tasks the lead granted internet access, and the agent's bridge saves
  the file inside its clone. Agents still have no network of their own. Risk: an agent that reads hostile text can
  leak whatever its sandbox lets it read, through the addresses it asks for; downloaded pages are untrusted input to
  the agent; the requests come from this server's address. The hub refuses non-public addresses, caps time, size and
  rate, and records every request ([What agents fetched](#what-agents-fetched)). The service unit adds a second
  layer: `IPAddressDeny` keeps the hub process from link-local addresses, where a cloud's metadata service answers.
  Grants belong on tasks that need outside data. A grant ends when the lead or a person takes it back, when its
  task is accepted, merged, cancelled or failed, and when the hub starts with the setting off: turning the setting
  off and restarting ends every grant, and the hub's journal names the tasks. An agent that was asked to stop
  fetches nothing more.
- **`AGFLOW_LEAD_APPROVALS=1`.** Removes: the runner owner answering each Codex approval request in a browser. The
  agent holding the lead seat may decline other agents' requests, with a reason, and approve them unless the device's
  Codex policy reserves approvals to its owner. A request nobody answered in time is
  then declined without marking the owner away. The owner can still answer first. Risk: an approved command runs
  outside the sandbox, with network access and write access to all the owner's files, on the lead's judgement instead
  of the owner's, and a lead can be misled by the text of a request.

  A managed device policy no longer blocks this by itself. agflow reads what the policy regulates: one that restricts
  who may answer approvals (`allowed_approvals_reviewers`, `allowed_approval_policies`), or one the runner could not
  read, reserves approvals to the owner; one that restricts sandbox modes, remote control, computer use or an external
  browser restricts those and says nothing about approvals. The Runners card shows both facts.
- **`AGFLOW_AUTO_APPROVALS=1`.** Removes: anyone, person or agent, reading each request before it is answered. The hub
  approves every approval request the moment it arrives, recorded as `hub:auto-approvals` in the attempt's log and the
  event. Only a request from a runner whose device policy reserves approvals to its owner waits for the owner, and a
  runner notifies its owner only of a request still unanswered 10 seconds after relaying it. The lead, told of such a
  request, is asked to decline it at once with what to do instead, since nobody may be at that machine. Risk:
  every command an agent asks to run outside the sandbox runs there, with network access and write access to all the
  owner's files, and nobody reads it first. Turn it on for projects you would run unattended anyway; turn it off by
  removing the line and restarting the hub.
- **`AGFLOW_AUTO_MERGE=1`.** Removes: merging accepted work by hand, and the operator script that did it. Accepting a
  task moves it to `merging`, and the hub sends one merge at a time to a runner, the author's when it is online. The
  runner merges the accepted head into `main` in its vault as a commit "Merge T-42: title" and pushes `main` leased on
  the `main` it merged; when `main` moved meanwhile it fetches and tries again, up to 5 times. It pushes with its
  owner's git credentials, the same ones that push the task branches, so **`main` must accept direct pushes from both
  owners**: no branch protection, required reviews or required status checks on `main`. A conflict sends the task
  back to its author through `rejected`, with the conflicting files as feedback. A merge that fails otherwise leaves
  the task in `merging`, tells people at the first and fifth failure, and is tried again after 15 seconds, then twice
  as long after each failure up to 10 minutes, on another runner when one can take it; a person who merges it by hand
  marks it merged. A dependency then counts as done only once merged, and accepted and merging tasks keep their owned
  paths. Risk: work reaches `main` with no person looking at the merge, and the repository's own CI runs after it
  landed.

  After each merge, one runner checks `main` as agflow merged it: a fresh clone at that commit, the dependencies
  prepared and the project's check run there, as at a submission, apart from the merges, which never wait for it.
  Two changes that each pass alone can still break `main`, and then every later submission fails its check. So a
  failure creates one task at the top priority, "Fix main: the check fails after T-42", created by `system`, and tells
  people and the lead (when the task limits refuse it, agflow creates it once they allow). While `main` fails, an
  agent whose check fails hears which task fixes `main`, and when the failure is not from its change it calls
  `declare_blocked`: agflow then parks the task instead of blocking it. The attempt is replaced, which counts no
  failure, asks for a handoff note and tells nobody, and the task waits, ready, with the board saying why, until
  `main`'s check passes, or 45 minutes at most. The lead's situation report names the parked tasks, and the idle
  nudge counts them as dispatchable. An agent that stalls while its last submission failed this way is parked the
  same way. A pass afterwards tells people and the lead, and cancels the fix task if nobody has started it.
  The Load page shows where the check of `main` passed, or since when it fails. Only runners of this release
  (runner protocol 4) that can prepare dependencies, as `agflow runner status` shows, check `main`, so deploy the hub
  first, then update the runners: a hub older than its runners refuses them.
- **`AGFLOW_AUTO_ACCEPT=1`.** Removes: the lead reviewing each submission. A runner submission whose check passed is
  accepted the moment it is recorded, as `hub:auto-accept`, with the same events as a lead's accept. The lead is not
  woken for it; its next situation report lists the tasks accepted this way, with the `gap:` lines their authors wrote
  for what someone else must still do or check. The check is the `check` command of
  `.agflow/config.json` on `main`, such as `"check": "bun test"`; a submission without one goes to the lead as before.
  So does a submission whose branch changes the check's own files, `.agflow/config.json` or a file the check command
  names such as `scripts/check.sh`, and a demo check, whose defects the lead turns into tasks. So does one whose check
  ran no tests: the check `agflow start` seeds prints `agflow-check: no tests ran` whenever it ran none, before the
  project has a manifest or a test, and the lead reviews that work itself. agflow's own fix of `main` is accepted like
  any other task. Nothing else is caught:
  a branch that changes the `package.json` scripts the check runs, test configuration such as `tsconfig.json` or
  `pyproject.toml`, or the tests themselves is still accepted by the hub alone. The periodic demo check, which the
  lead reviews, is the backstop. A runner gives a check `checkMinutes` (10 by default, in `runner.json`) out of the 15
  minutes it gives a whole submission, push included, so keep `AGFLOW_SUBMIT_TIMEOUT_MINUTES` (15) at least that long.
  Risk: the check is the only review, so whatever it does not test is accepted unseen, and so is a check an agent
  weakened in those ways.
- **`AGFLOW_REVIEW=1`**, with `AGFLOW_AUTO_ACCEPT=1`. Removes: work whose check passed reaching `main` unread. The
  first submission of each task whose check passed is not accepted at once: the hub creates a review task, "Review of
  T-12 (S-34): title", created by `system`, at priority 1, preferably for the vendor other than the author's while a
  runner offers it. Its agent starts at the submitted head, reads the change against `SPEC.md` and the task's
  contract, runs commands of its own and changes nothing. The first line of its submit summary is its verdict, which
  the hub applies as `hub:review`, with no push: accept, accept with follow-ups, which go to the lead, or reject,
  which sends the findings back to the author's session. The task's later submissions, agflow's own tasks and live
  chats go on as before (live chats' submissions and demo checks go to the lead). The lead's report names the tasks
  under review apart from those awaiting its own, and the periodic review leaves them to their reviewers. Risks:
  - The review runs at the strong tier, on the lead's model, so each one draws on the quota the lead uses.
  - A review that does not start within 5 minutes, or gives no verdict within 20, lets the hub accept the task as
    before, unread. It waits while the project is paused or the hub is down, and both times start again after the
    resume or the hub's recovery window.

Two more settings are on by default:

- **The idle nudge, `AGFLOW_IDLE_NUDGE_SECONDS` (60) and `AGFLOW_IDLE_NUDGE_MINUTES` (5).** Removes: a person noticing
  that workers sit idle and telling the lead to plan more. While a runner lead holds the seat and the dispatchable
  ready tasks (those the scheduler may start once a worker slot is free; a task parked for a failing `main` counts as
  one) are fewer than the worker slots, busy or free, for `AGFLOW_IDLE_NUDGE_SECONDS` without a break, the hub sends
  the lead one message: the worker slots, the ready, parked, blocked, submitted and accepted tasks, each account's
  quota, the time left to the deadline, and what to plan next (the spec until it is covered, then the requirements
  `docs/STATUS.md` does not show working, the demo check's defects and the gaps agents named, missing tests, demo
  polish and new features, and only fixes in the last hour). So a lead whose every slot is busy hears too, before the
  work runs out; its situation report says why ready tasks wait (a path overlap, quota, a full runner, no free slot)
  and names the parked ones. No other follows for `AGFLOW_IDLE_NUDGE_MINUTES`; the event `lead.idle_nudged` records
  each one. None goes out before the goal is set, while worker dispatch is held (a paused project, the churn guard),
  or once the deadline has passed, and `AGFLOW_IDLE_NUDGE_MINUTES=0` turns it off. Risk: the lead keeps adding work
  until the deadline, so the subscriptions stay in use; pause the project, or set a lower worker target, to stop it.
- **The demo check, `AGFLOW_DEMO_CHECK_EVERY` (5).** Removes: a person trying the product by hand from time to time.
  After every N tasks merged, the hub creates one demo-check task, created by `system`, unless one is still open.
  Without `AGFLOW_AUTO_MERGE=1`, accepted tasks count until something marks a task merged. Its agent starts the
  product from a clean checkout of `main` the way `AGENTS.md` says (`scripts/demo.sh` when present), walks every flow
  in `SPEC.md` with inputs of its own too (other values, empty and wrong input), reads what merged since the last demo
  check for features that break or duplicate each other, saves a screenshot of every screen under `docs/qa/<time>/`,
  and records each requirement in `docs/STATUS.md` as working, broken or missing. Its submission lists each defect no
  open task covers on a line of its own that starts `DEFECT:`, most severe first, with steps to reproduce, or the single
  line `DEFECTS: none`. It may change only those files and `scripts/demo.sh`, which no runner profile protects. It
  runs at priority 1 and tier strong, preferably on the vendor that implemented fewer of the last N tasks. In the last
  hour before the deadline one task merged is enough, so the `main` of the end gets checked. The lead reviews it, even
  with `AGFLOW_AUTO_ACCEPT=1`: its message quotes the whole summary, counts the `DEFECT:` lines, and says to turn each
  into a fix task, then accept the check. `0` turns it off. Risk: it runs on the stronger model, the lead's, so it
  draws on the lead's quota once every N tasks, and more in the last hour.

### At the deadline

When the project's deadline passes (`agflow start --deadline`, or the operator's deadline route), the hub presses
Pause, once for that deadline, and records `project.deadline_reached`. It is the usual pause: no worker or lead
starts, the idle nudge stops, and the agents already running finish or hand off what they hold. On top of it, while
the project stays paused past its deadline, no merge goes into `main`: accepted work waits in `merging`, a merge
already sent to a runner still lands, and the check of `main` still runs. People and the lead get one message: the
deadline passed and merges are held; `main` as agflow last merged it, with what its check gave (passed, failed or not
run yet); and the last `main` whose check passed, the one to show if the newest fails. **Resume** in the web UI goes
on: workers start again and accepted work merges. A deadline moved later lifts the merge hold at once, and pauses
the project again when it passes; with no deadline nothing changes. Risk: a mistyped deadline (`+36m` for `+36h`)
pauses an unattended run at that time; `agflow start` prints the deadline it set, and the Load page shows the time
left.

### Hackathon settings

For a hackathon, where two Macs and a Linux VM work through a spec unattended until the deadline, put these lines in
`/etc/agflow/hub.env` and restart the hub. [hub.env.example](../deploy/hub/hub.env.example) ends with the same block,
commented out.

```
AGFLOW_MAX_WORKERS=20
AGFLOW_QUOTA_WAIT_MINUTES=5
AGFLOW_LEAD_ROTATE_WAKEUPS=100
AGFLOW_MAX_PLAN_CHANGES_PER_HOUR=600
AGFLOW_MAX_TASKS_PER_HOUR=300
AGFLOW_LEAD_REVIEW_MINUTES=10
AGFLOW_AUTO_ACCEPT=1
AGFLOW_REVIEW=1
AGFLOW_AUTO_MERGE=1
AGFLOW_IDLE_NUDGE_MINUTES=5
AGFLOW_DEMO_CHECK_EVERY=5
AGFLOW_AGENT_FETCH=1
AGFLOW_LEAD_APPROVALS=1
AGFLOW_AUTO_APPROVALS=1
AGFLOW_APPROVAL_MINUTES=5
```

- `AGFLOW_MAX_WORKERS=20`: room for every runner slot, 6 on each Mac with `--preset hackathon` and 8 on the VM
  ([linux-runner.md](linux-runner.md)).
- `AGFLOW_QUOTA_WAIT_MINUTES=5`: a worker whose account ran out waits for its reset only when it comes within 5
  minutes, not 45; otherwise another account takes over its task.
- `AGFLOW_LEAD_ROTATE_WAKEUPS=100`: twenty workers wake the lead often, and at 20 wake-ups it would keep starting over
  from a handoff. It still rotates once 70% of its context is used.
- `AGFLOW_MAX_PLAN_CHANGES_PER_HOUR=600`: the lead's task creations, edits and cancellations for twenty workers would
  pass 60 an hour, and the churn guard would hold dispatch.
- `AGFLOW_MAX_TASKS_PER_HOUR=300`: the lead plans small tasks for twenty workers, a ready task ahead for every worker
  slot, which can pass 60 new tasks an hour. agflow's own tasks, the reviews among them, do not count.
- `AGFLOW_LEAD_REVIEW_MINUTES=10`: the lead hears of work submitted to it for more than 10 minutes, not 45, and of work
  in an attempt for more than 30 minutes, at most every 10 minutes.
- `AGFLOW_AUTO_ACCEPT=1`: a submission whose check passed does not wait for the lead.
- `AGFLOW_REVIEW=1`: an agent of the other vendor reads each task's first green submission before it merges, and
  sends defects back to the author; a review that does not finish within 20 minutes lets the hub accept as before.
- `AGFLOW_AUTO_MERGE=1`: accepted work reaches `main` without a person, and dependent tasks wait for the merge, as
  `AGFLOW_DEPENDENCIES_NEED_MERGE=1` would make them; leave that one out. A runner checks `main` after each merge, and
  a failure gets a fix task at once.
- `AGFLOW_IDLE_NUDGE_MINUTES=5` and `AGFLOW_DEMO_CHECK_EVERY=5`: the defaults, written out so that the idle nudge and
  the demo check, the backstop of auto accept, stay on.
- `AGFLOW_AGENT_FETCH=1`, `AGFLOW_LEAD_APPROVALS=1` and `AGFLOW_AUTO_APPROVALS=1`: nobody has to fetch outside data or
  answer approval requests during the run. Read their risks above first.
- `AGFLOW_APPROVAL_MINUTES=5`: a request that a runner's device policy reserves to its owner, which nobody answers
  during an unattended run, holds its agent 5 minutes before it is declined, not 15. `hub.env.example` sets the key
  already: change that line.

Before the run, check four things:

- `main` accepts direct pushes from every runner's owner: no branch protection, required reviews or required status
  checks, or auto merge cannot push it.
- Every runner's git credentials may push changes to `.github/workflows/**`, which agents may make under the open
  profile: a fine-grained token needs Contents and Workflows read and write, a classic token or an OAuth login the
  `workflow` scope. Without it GitHub refuses such pushes, a merge into `main` included.
- `hub.env` keeps one line per key: the deployment (`activate.sh`) refuses a file that sets a key twice, so change the
  line that is there, such as `AGFLOW_MAX_WORKERS=4`, rather than add another.
- The hub and every runner run this release, the hub upgraded first: only runners of runner protocol 4 check `main`
  after a merge, and only those whose `agflow runner status` shows the dependencies available. A runner of this
  release keeps prompting an agent to continue when its slow submission fails, so a `timings.bridgePollMax` raised in
  `runner.json` to cover that is no longer needed.

### What agents fetched

With `AGFLOW_AGENT_FETCH=1` the hub records every request it made for an agent, or refused by its URL and address
rules, in the `agent_fetches` table of its database: the time, the attempt, task and agent, the whole URL the agent
sent, where the redirects ended, the HTTP status or the error, and the size. The row is written before the request
leaves the server. An attempt's log in the UI shows the same requests, but only among the attempt's newest 500
entries. The table keeps 90 days and at most 250,000 rows, and no page shows it yet. Read it on the server:

```bash
sudo apt-get install -y sqlite3     # once: the host template does not install it
sudo -u agflow sqlite3 -readonly -header -column /var/lib/agflow/data/agflow.db \
  "SELECT datetime(at / 1000, 'unixepoch') AS utc, attempt_id, coalesce(status, error, 'no outcome') AS outcome,
          bytes, url, final_url, detail
   FROM agent_fetches ORDER BY id DESC LIMIT 50"
```

Narrow it with `WHERE task_id = 'T-12'` or `WHERE agent_id = 'A-7'`. `WHERE error = 'fetch_address_refused'` finds
requests for names that resolve inside your network; `detail` then holds the address, which the agent was not told.
A row with no outcome is a request that was under way when the hub stopped. Requests made after a backup was taken
are on record only in the database a restore puts aside (`agflow.db.replaced-*`): run the same query on that file.

What still needs a person:

- **Approvals on a managed device.** Where the device's administrator manages the Codex policy, the lead can only
  decline. Approving stays with the owner, in the browser.
- **Internet for Codex agents.** They never fetch, with or without a grant. Give outside-data tasks to Claude agents,
  or commit the data. On a runner with the open profile (`agflow runner setup --preset hackathon`) Codex commands
  reach the network themselves ([README](../README.md#runner-permissions-and-risks)).
- **Runner sign-in.** A person runs `agflow login` on each Mac and completes the Claude and Codex logins that
  `agflow runner setup` opens ([Joining from a Mac](#joining-from-a-mac)).
- **Secrets.** API keys and other secrets are never handed out by the hub or by the lead. A person provides them.

### When the hub writes to people

Work that stops on its own reaches people as a message from agflow on the Messages page:

- **No lead.** While the project runs and the lead seat has been empty for 2 minutes, one message says that no lead
  is running and why: each runner and vendor that cannot take the seat, in the board's words
  (`R-1 offline; R-2 claude quota used up, codex not ready`), or that runner leads are off and no live chat holds
  the seat. It also says what to do: get a runner able to take the seat, and agflow starts a lead there by itself,
  or lead from a chat with `agflow join --role lead`. The next such message comes only after a lead has held the
  seat again. A live chat's seat counts as empty once the chat has gone unseen for
  `AGFLOW_LIVE_LEAD_GRACE_MINUTES` (120).
- **A merge that keeps failing** (`AGFLOW_AUTO_MERGE=1`). Its next try waits 15 seconds, then twice as long after
  each failure, up to 10 minutes, and the other merges go on meanwhile. People hear of the first failure and again
  of the fifth, with the likely cause when the error names one: a `main` that is protected or requires checks, or a
  runner's git credentials that cannot push `.github/workflows` changes ([Hackathon settings](#hackathon-settings)
  lists both checks). Until it is merged, the board shows the task under Needs attention with the number of failed
  merges and the last error; a person who merges it by hand marks it merged.
- **A failing `main`** (`AGFLOW_AUTO_MERGE=1`). When the check of `main` fails after a merge and no task is open to
  fix it, people and the lead hear which task agflow created at the top priority to fix it, or why it could not create
  one; both hear again once `main` passes. Parking a task meanwhile tells nobody
  ([Unattended operation](#unattended-operation)).
- **A failed task.** When a task's attempts fail again after its re-plan, agflow will not try it again: people and
  the lead hear of it, and the lead's message lists the open tasks that depend on it, whose blocked reason now asks
  to amend or cancel them, as after a cancel.
- **A refusal under a vendor's usage policy.** The task is blocked at once, and people hear of it. For a worker's
  task the lead does too, with the vendor and what to do: reword the task or set its `vendorHint` to the other vendor
  with `update_task`, then unblock it, or cancel it.
- **The deadline.** People and the lead hear that the project is paused and merges are held, with where `main`
  stands ([At the deadline](#at-the-deadline)).
- **Runners failing the same way.** When three attempts at a task end the same way on runners, it is blocked for a
  re-plan, and people and the lead hear of it: the runners or the setup are the likelier cause.
- **A protected path.** When a runner finds that an attempt changed a path no runner agent may change, or refuses a
  submission for it, people and the lead hear which paths.
- **A branch moved outside agflow.** When a submission's push finds its branch at a commit agflow did not make, the
  task is blocked for people, who hear of it; unblocking it adopts that commit.
- **A safety limit.** When the open-task or hourly task limit refuses new tasks, people hear of it, at most once an
  hour. When agents change the plan `AGFLOW_MAX_PLAN_CHANGES_PER_HOUR` times within an hour, the churn guard pauses
  worker dispatch, and people hear of it when the pause starts.
- **Late work and dropped stops.** A runner's late push for a task this hub does not have reaches people with its
  ref. A stop asked for while a submission was pending is dropped once the submission is recorded, and whoever asked,
  a person or the lead, hears of it.

Besides the messages above that name it, the lead hears of: each submission up for its review (a runner's with its
check, its `gap:` and evidence lines, and for a demo check the count of its `DEFECT:` lines); a reviewer's
follow-ups (`AGFLOW_REVIEW=1`); a task its agent declared blocked or impossible, or one blocked for a re-plan after
its attempts failed; a stale task; the open tasks that depend on a cancelled one; each new demo check; a goal set or
changed; a branch pushed after agflow stopped counting on its submission; an owner whose expired approval holds
their runners back; the approval requests it may answer (`AGFLOW_LEAD_APPROVALS=1`); the idle nudge; and the
periodic review. A task parked while `main` fails tells nobody, and a task the hub accepts itself, after its check
or its review, comes up in the lead's next situation report instead.

## Joining from a Mac

Requires Apple silicon macOS (`darwin-arm64`), Bun 1.3.11, git and working access to the project repo. Each person needs their own supported Claude/Codex subscription/login; authenticate git separately so fetches and pushes work. Vendor policy (including managed Codex policy) must permit the runner; agflow does not bypass it. These setup commands intentionally install a real per-user LaunchAgent and prompt for vendor login: the human runs them on their own Mac.

A runner on a Linux VM keeps working while the Macs sleep; [linux-runner.md](linux-runner.md) creates and sets one up.

Build from the same release as the hub (a source archive works; no server secrets are needed):

```bash
bun install --frozen-lockfile
bun run build:cli
mkdir -p ~/.local/bin
cp dist/agflow ~/.local/bin/agflow
export PATH="$HOME/.local/bin:$PATH"  # persist in your shell configuration
agflow login --hub https://YOUR_PUBLIC_HOST
agflow runner setup
agflow runner status
```

Compare the terminal verification code with the browser page before approving CLI sign-in. The credentials preserve the HTTPS hub URL; the runner opens `wss://YOUR_PUBLIC_HOST/api/runner/ws`. No port forwarding is needed.

`setup` records machine identity, git identity, login-shell PATH/proxy/CA settings and capacity (default two). It installs pinned binaries in separate runner vendor homes, opens Claude subscription and Codex logins, and installs/starts the LaunchAgent. Checks run inside the service, including hub identity, repository fetch/push probe, vendor preflight and sandbox support. Setup never requires vendor credentials on the Linux host. `agflow runner setup --relogin` repeats vendor login; `agflow login --hub ...` renews an expired hub token, which the running runner will detect.

Instead of building, you can download `agflow-darwin-arm64` from the repository's latest release into `~/.local/bin/agflow` and make it executable. For a hackathon, `agflow runner setup --preset hackathon --name <name>` asks no questions and sets capacity 6, ceilings 1, keep-awake always and the open profile, which gives agents the network and the greenfield files ([README](../README.md#runner-permissions-and-risks)).

For explicit service installation after setup, run `agflow runner install` (also enables/starts it). For a foreground runner use `agflow runner setup --no-service`, then `agflow runner start`; do not start a second copy alongside the service. `agflow runner stop` drains, hands off and disables the service; `install` brings it back. `agflow runner restart` saves WIP and restarts an installed service. The owner can change capacity/drain/keep-awake in the web Runners page; keep the laptop awake and on AC for sustained work. Both laptops' capacity is also capped by the hub's `AGFLOW_MAX_WORKERS`.

For live chats in a checkout, use `agflow join --role worker --vendor both`; see the [README](../README.md#connect-your-claude-code-and-codex-chats). Runner setup and live-chat joining are separate features. Updating the CLI: stop the runner, replace the binary at the same absolute path, then `agflow runner install` and check status.

## Backups and restore

The hub writes consistent SQLite snapshots with `VACUUM INTO`: three start backups, 24 hourly backups and seven daily backups. The first hourly backup is an hour after start; a missing daily backup is written on startup. They live in `/var/lib/agflow/backups`, independent of releases. Check backup timestamps and the journal for failures; a full disk can leave the hub running without a new backup. Preserve the `epoch` file alongside backups after a restore or a project reset.

Daily cloud disk snapshots protect against VM/disk loss, including the database, backups, configuration and Caddy certificates. Treat snapshots as sensitive (they contain session tokens and the OAuth secret). They are crash-consistent, not a replacement for application snapshots or a restore drill. Retain an additional known-good backup before schema changes. On a 10 GB disk, monitor `df -h /`, DB/WAL and backup sizes; 34 full SQLite copies plus three dependency trees can outgrow it. Expand the disk or move retained copies before it fills; do not delete live WAL/SHM files to free space.

To restore a hub backup on the host, pause dispatch in the UI and notify both users, then stop the hub. Choose a completed `.db` snapshot (not `.tmp`). Run as `agflow` with an explicit database path; no OAuth environment is needed:

```bash
sudo systemctl stop agflow-hub
sudo systemctl is-active agflow-hub    # should report inactive
cd /opt/agflow/current
sudo -u agflow env AGFLOW_DB=/var/lib/agflow/data/agflow.db \
  /usr/local/bin/bun packages/hub/src/restore.ts \
  /var/lib/agflow/backups/REPLACE_BACKUP_FILE.db
sudo systemctl start agflow-hub
sudo journalctl -u agflow-hub -n 100 --no-pager
```

Restore refuses while the DB lock names a live process, validates/migrates the backup, keeps the replaced DB/WAL/SHM as `agflow.db.replaced-*`, advances epoch/counters and checkpoints the restored database. Keep those replaced files until recovery is verified. Never copy a backup over a running database or delete the lock to force a restore. After restart the recovery window (default 120 seconds) pauses dispatch/lease expiry/stall decisions while runners reconnect and replay retained work. Check task positions, the lead, both runners, capacity/drain settings, approvals and internet grants before resuming. The README's [settings-sync restore limits](../README.md#backups-restore-and-known-limits) still apply.

A restore brings back the internet grants as the backup had them, so a grant that was taken back after the backup is in force again. List them before starting the hub:

```bash
sudo -u agflow sqlite3 -readonly -header -column /var/lib/agflow/data/agflow.db \
  "SELECT task_id, granted_by, datetime(granted_at / 1000, 'unixepoch') AS utc FROM task_fetch_grants ORDER BY granted_at"
```

To end them all, start the hub once with `AGFLOW_AGENT_FETCH` unset: it ends every grant and names the tasks in its journal. Then set it again and restart; the lead grants anew where a task still needs outside data. To end single grants, tell the lead which tasks should lose theirs. The requests the hub made after the backup are on record only in the replaced database ([What agents fetched](#what-agents-fetched)).

For VM loss, stop/fence the old VM before bringing up any replacement (never run two hubs against one project's runners). In the cloud console create a boot disk from the selected snapshot and a replacement VM in the same subnet/security group, then move the reserved public IP. Alternatively use `yc compute disk create --source-snapshot-id SNAPSHOT_ID --name RESTORED_DISK --zone ZONE`, followed by `yc compute instance create ... --use-boot-disk disk-id=RESTORED_DISK,auto-delete=false` with the same CPU/memory/network settings as the recipe. Disable automatic hub startup on the recovery VM while verifying files; keep public 80/443 closed until ready. Use serial console or an isolated recovery VM to do this before attaching the public IP.

A whole-disk snapshot also rewinds the database's epoch history. Before allowing runners back, run the hub restore command against a retained application backup so it advances the restored epoch. If there have been restores since the disk snapshot, first recover the highest known `backups/epoch` (and preferably the newest consistent application backup) from the old disk/off-host copy into the backup folder. Do not guess an epoch or reconnect runners when newer restore history is missing; preserve the old disk and investigate. Restore with the matching code release, verify DB integrity and both runners, then reopen traffic. Recheck SSH fingerprints, DNS/certificates and that the replacement disk is attached to the snapshot schedule.

## Logs and checks

```bash
sudo systemctl status agflow-hub caddy
sudo journalctl -u agflow-hub -f
sudo journalctl -u caddy -n 100 --no-pager
sudo systemd-analyze security agflow-hub.service
sudo ss -ltnp                     # hub only 127.0.0.1:8787; Caddy on 80/443
df -h /
sudo du -sh /var/lib/agflow/data /var/lib/agflow/backups /opt/agflow/releases
curl --fail https://YOUR_PUBLIC_HOST/api/auth-config
```

Caddy access logging is not enabled by this template, to avoid retaining OAuth codes and CLI login codes from query strings. Service/error logs go to the journal. On a Mac, `agflow runner status` and `~/.agflow/runner/logs/runner.log` explain preflight, credentials, policy and connectivity failures. If Caddy returns 502, inspect the hub journal and env paths; if TLS fails, check DNS, ports 80/443 and the Caddy journal. If browser writes get 403, check that the browser origin exactly matches `AGFLOW_PUBLIC_URL`; do not enable forwarded-header trust or dev auth to fix it.

## Proxy/authentication audit

The deployment regression tests use GitHub auth, an HTTPS public URL and HTTP requests arriving on loopback with forged `Forwarded`, `X-Forwarded-*` and `X-Real-IP`. No production auth changes were needed:

| Surface | Checked behavior |
| --- | --- |
| Web session/OAuth | Public HTTPS URL controls Secure, HttpOnly, SameSite=Lax cookies and callback. OAuth state is browser-bound, expiring and single-use; allowlist required. Dev login is absent. |
| CLI login | The public login page redirects to GitHub; approval requires a web human. Polling uses an unguessable code and does not confer authority from IP. CLI preserves HTTPS for auth-config, browser URL and poll. |
| Runner WebSocket | CLI session token required before upgrade; browser web sessions and agent tokens are rejected. HTTPS hub URLs become WSS. |
| Agent tokens/live chats | Attempt/fence-scoped tokens pass a central route allowlist. Live-chat routes require a session and bind agent identity/ownership. Forwarded headers grant no authority. |
| Approvals and browser writes | Approvals require the owner in a web session. Global cookie-write middleware rejects cross-origin Origin/Fetch-Metadata; JSON-only body parsing blocks simple form writes. Bearer clients use explicit credentials. |
| SSE | Authenticated route sends initial `ready` bytes and 15-second pings. Reconnect cursors replay missed events. No proxy response buffer or stream timeout. |

The existing CSRF policy accepts the configured public origin or the request Host origin, and tolerates scripts with neither Origin nor Fetch-Metadata. Caddy preserves Host and only routes the configured site. No loopback/client-IP or forwarded-header auth exemption exists. Do not add arbitrary hostname aliases to this deployment.

[Caddy's reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy) handles WebSocket upgrades automatically. The [2.6.2 implementation](https://github.com/caddyserver/caddy/blob/v2.6.2/modules/caddyhttp/reverseproxy/reverseproxy.go) flushes streaming responses immediately; this template retains default disconnect cancellation instead of setting `flush_interval -1`. A local Caddy 2.6.2 probe with a temporary, explicitly trusted test certificate verified TLS, HSTS, unauthenticated rejection, immediate SSE bytes and an authenticated WSS hello/welcome. It installed no service or system trust. Real Ubuntu/systemd startup and public certificate issuance must still be checked on the deployment host; the local tests do not claim to provision a VM.

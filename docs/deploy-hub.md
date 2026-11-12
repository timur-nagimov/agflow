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

All production environment variables read by `loadConfig` are documented in [hub.env.example](../deploy/hub/hub.env.example). `AGFLOW_WEB_DIST` is essential: without it the API runs but the UI is not served. Hub worker capacity defaults to four across the two Macs; this is separate from each runner's capacity (normally two).

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

## Add or remove a person

Grant the colleague read/write access to the project repository on GitHub and add their GitHub login (not display name/email) to the comma-separated `AGFLOW_ALLOWED_USERS`. Then:

```bash
sudoedit /etc/agflow/hub.env
sudo systemctl restart agflow-hub
```

The allowlist is checked whenever a session verifies; removing a login invalidates its web/CLI use. Restart closes existing runner and SSE connections, so the removed user cannot retain an old stream. The colleague signs in via GitHub in the browser and via `agflow login` on their Mac. They do not need the OAuth app secret, a cloud account or SSH access. Allowlisting does not grant repository access, and repository access alone does not grant hub access.

## Joining from a Mac

Requires Apple silicon macOS (`darwin-arm64`), Bun 1.3.11, git and working access to the project repo. Each person needs their own supported Claude/Codex subscription/login; authenticate git separately so fetches and pushes work. Vendor policy (including managed Codex policy) must permit the runner; agflow does not bypass it. These setup commands intentionally install a real per-user LaunchAgent and prompt for vendor login: the human runs them on their own Mac.

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

For explicit service installation after setup, run `agflow runner install` (also enables/starts it). For a foreground runner use `agflow runner setup --no-service`, then `agflow runner start`; do not start a second copy alongside the service. `agflow runner stop` drains, hands off and disables the service; `install` brings it back. `agflow runner restart` saves WIP and restarts an installed service. The owner can change capacity/drain/keep-awake in the web Runners page; keep the laptop awake and on AC for sustained work. Both laptops' capacity is also capped by the hub's `AGFLOW_MAX_WORKERS`.

For live chats in a checkout, use `agflow join --role worker --vendor both`; see the [README](../README.md#connect-your-claude-code-and-codex-chats). Runner setup and live-chat joining are separate features. Updating the CLI: stop the runner, replace the binary at the same absolute path, then `agflow runner install` and check status.

## Backups and restore

The hub writes consistent SQLite snapshots with `VACUUM INTO`: three start backups, 24 hourly backups and seven daily backups. The first hourly backup is an hour after start; a missing daily backup is written on startup. They live in `/var/lib/agflow/backups`, independent of releases. Check backup timestamps and the journal for failures; a full disk can leave the hub running without a new backup. Preserve the `epoch` file alongside backups after a restore.

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

Restore refuses while the DB lock names a live process, validates/migrates the backup, keeps the replaced DB/WAL/SHM as `agflow.db.replaced-*`, advances epoch/counters and checkpoints the restored database. Keep those replaced files until recovery is verified. Never copy a backup over a running database or delete the lock to force a restore. After restart the recovery window (default 120 seconds) pauses dispatch/lease expiry/stall decisions while runners reconnect and replay retained work. Check task positions, the lead, both runners, capacity/drain settings and approvals before resuming. The README's [settings-sync restore limits](../README.md#backups-restore-and-known-limits) still apply.

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

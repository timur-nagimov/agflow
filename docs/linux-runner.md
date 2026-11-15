# A Linux runner in the cloud

A runner on a Linux cloud machine keeps the agents working while the laptops sleep or travel. It joins the same hub
and project as the Macs and uses the same Claude and Codex subscriptions. The hub places work on it like on any other
runner, and prefers it over a laptop on battery: it always reports AC power.

The machine is Ubuntu 24.04 on Yandex Cloud with 16 vCPU, 32 GB of RAM and a 200 GB SSD. Any Ubuntu 24.04 machine,
x64 or arm64, works the same way; only the first step changes.

## Create the VM

On your Mac, with the [Yandex Cloud CLI](https://yandex.cloud/en/docs/cli/quickstart) signed in and `jq` installed:

```bash
scripts/provision-runner-vm.sh
```

It takes the folder and the zone from `yc config` and the zone's first subnet of the folder. Flags override each of
them: `--folder-id`, `--zone`, `--subnet-id`, plus `--name` (the VM and the runner's default name, `agflow-runner`),
`--ssh-key` (your public key, `~/.ssh/id_ed25519.pub`) and `--user` (the user that runs the runner, `agflow`).

The VM costs money until you delete it. Its cloud-init:

- creates the user with your SSH key and passwordless sudo, for upkeep;
- installs git, bubblewrap, socat, ripgrep, lsof and curl;
- sets `kernel.apparmor_restrict_unprivileged_userns = 0` in `/etc/sysctl.d`, because Ubuntu 24.04 otherwise keeps
  bubblewrap, and so the Claude and Codex sandboxes, from starting;
- downloads the released agflow binary to `/usr/local/bin/agflow`;
- turns on lingering for the user, so the runner runs with nobody logged in and starts at boot.

The script prints the VM's address and the steps below.

## Sign in and set up

Sign in as the runner's user (`ssh agflow@VM_IP`) and wait for cloud-init:

```bash
cloud-init status --wait
```

Agents commit as the git identity setup finds, and the runner fetches and pushes with your own git login, as on a Mac.
Set both before setup:

```bash
git config --global user.name 'Your Name'
git config --global user.email you@example.com
```

The service has no SSH agent and nobody to type a password. For an `https://` project URL, store a fine-grained token
that can push to the repository with `git config --global credential.helper store`; for a `git@` URL, make an SSH key
without a passphrase on the VM and add it to your GitHub account. Check it with `git ls-remote` on the project's URL.

Then sign in to the hub and set the runner up:

```bash
agflow login --hub https://YOUR-HUB
agflow runner setup
```

For a hackathon, run `agflow runner setup --preset hackathon --capacity 8` instead: the open profile and 8 worker
slots, which suit the VM's 16 vCPU and 32 GB. Leave out `--yes`, or setup cannot ask for the Claude token.

`agflow login` shows a link and a code: open the link in a browser on your Mac. Setup asks for the runner's name and
capacity, downloads the pinned Claude Code and Codex for Linux, and does the two vendor logins. The VM has no browser,
so:

- **Codex** signs in with a device code. Setup runs `codex login --device-auth` in the runner's own Codex home: open
  the link it shows on your Mac and enter the code.
- **Claude** signs in with a token made on your Mac. Run `claude setup-token` there and copy the token it prints.
  Setup asks for it on the VM: paste it, then press Enter on an empty line. The screen shows none of it. A terminal
  may break the long token over two lines, and a copy keeps the break, so setup joins the lines. It checks that the
  token starts as such a token does, `sk-ant-oat`, and saves it as `CLAUDE_CODE_OAUTH_TOKEN` in
  `~/.agflow/runner/runner.env`, readable by you alone. `--yes` asks for nothing, so with it setup stops here.

Setup then installs and starts the service and runs the checks inside it. See how the runner is doing with:

```bash
agflow runner status
```

## Run, stop and upgrade

The service is a systemd user unit, `~/.config/systemd/user/agflow-runner.service`. The agflow commands drive it with
`systemctl --user`:

| Command | Effect |
|---|---|
| `agflow runner install` | Write the unit, turn on lingering, then enable and start it. |
| `agflow runner stop` | Drain, hand off and stop the agents, push their work, then stop and disable the unit. |
| `agflow runner restart` | Suspend the agents, save their work and restart the unit. |
| `agflow runner uninstall` | Stop, log out, retire the runner on the hub and remove the unit. |

The unit restarts the runner 30 seconds after a crash. A clean exit, a stop or a refusal that needs a person, does not
restart it: the same rule as the LaunchAgent on a Mac. When memory runs out and the kernel kills a process, an agent's
build say, the runner and the other agents go on. `systemctl --user status agflow-runner` shows its state. The
runner's own log is `~/.agflow/runner/logs/runner.log`; what it prints before that log opens goes to `launchd.out.log`
and `launchd.err.log` beside it, the same files as on a Mac.

To upgrade, download the new binary beside the old one, move it over the old one and install again. The running
service holds the old file, so a download straight into it fails with "Text file busy":

```bash
sudo curl --fail --location --output /usr/local/bin/agflow.new \
  https://github.com/timur-nagimov/agflow/releases/latest/download/agflow-linux-x64
sudo chmod 755 /usr/local/bin/agflow.new
sudo mv /usr/local/bin/agflow.new /usr/local/bin/agflow
agflow runner install
```

## What differs from a Mac

- **Binaries.** The runner pins the linux-x64 and linux-arm64 builds (glibc) of the same Claude Code and Codex
  versions as the Macs, with their own checksums.
- **Power and sleep.** A cloud machine is always on AC and never sleeps. The runner reports AC power, keeps nothing
  awake, has no battery guard, and setup's sleep check passes. There are no desktop notifications: the hub's web UI
  shows what needs you.
- **Claude's shell.** Claude runs its commands with `/bin/bash`, not zsh, which the VM does not have. Bash reads
  `~/.bashrc` in each of them; Ubuntu's stock `~/.bashrc` returns at once there, so keep it that way.
- **Sandbox.** Both sandboxes use bubblewrap instead of macOS's seatbelt. Claude's needs `bwrap`, `socat` and `rg` on
  the PATH, and Ubuntu's restriction on user namespaces off. Claude's preflight checks both and names the fix:
  `sudo apt-get install bubblewrap socat ripgrep`, or the sysctl above.
- **Logins.** Nothing reads a Keychain. Codex keeps its login in the runner's Codex home, Claude's is the token in
  `runner.env`. The token names no plan, so the hub shows the Claude plan as unknown. Neither does it name the account,
  so the runner reports a hash of the token as the account: the hub counts this runner's Claude quota apart from the
  Macs', though the subscription is the same. A token lasts a year. Once the API refuses it, the runner's Claude stays
  not ready, and the hub's Runners card says why, until `runner.env` holds another token: make a new one and paste it
  into `agflow runner setup --relogin`, which signs Codex in again too and restarts the service.
- **Service.** A systemd user unit with lingering instead of a LaunchAgent; there are no Login Items to allow.
- **Machine id.** The runner is bound to `/etc/machine-id` instead of the Mac's hardware id. A copy of `~/.agflow` on
  another machine is refused, as on a Mac.
- **Uninstall.** `agflow runner uninstall` removes the unit. The Claude token stays in `runner.env` until
  `agflow runner uninstall --purge` removes the runner's data.

The user has passwordless sudo, and an approved Codex escalation runs as that user outside the sandbox. Keep nothing on
the VM that the project does not need.

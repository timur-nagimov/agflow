#!/usr/bin/env bash
# Creates a Yandex Cloud VM for a Linux agflow runner (docs/linux-runner.md): Ubuntu 24.04, 16 vCPU, 32 GB RAM and a
# 200 GB SSD. cloud-init installs git, bubblewrap, socat, ripgrep, lsof and curl, lets bubblewrap build its sandboxes
# and puts the released agflow binary in /usr/local/bin. It prints the steps that need a person.
# Needs an authenticated yc CLI and jq. It creates a billable VM; it is not idempotent.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/provision-runner-vm.sh [--name NAME] [--folder-id ID] [--zone ZONE] [--subnet-id ID]
                                      [--ssh-key FILE] [--user NAME]
Creates a Yandex Cloud VM for an agflow runner: Ubuntu 24.04, 16 vCPU, 32 GB RAM, 200 GB SSD.
  --name       the VM, and the runner's default name (agflow-runner)
  --folder-id  the folder (yc config get folder-id)
  --zone       the zone (yc config get compute-default-zone, else ru-central1-a)
  --subnet-id  the subnet (the folder's first subnet in the zone)
  --ssh-key    the public key you sign in with (~/.ssh/id_ed25519.pub)
  --user       the user that runs the runner (agflow)
EOF
}

die() {
  echo "provision-runner-vm: $*" >&2
  exit 1
}

name=agflow-runner
folder=
zone=
subnet=
ssh_key="$HOME/.ssh/id_ed25519.pub"
user=agflow
while (($#)); do
  [[ $1 == -h || $1 == --help ]] && { usage; exit 0; }
  (($# >= 2)) || { usage >&2; exit 2; }
  case $1 in
    --name) name=$2 ;;
    --folder-id) folder=$2 ;;
    --zone) zone=$2 ;;
    --subnet-id) subnet=$2 ;;
    --ssh-key) ssh_key=$2 ;;
    --user) user=$2 ;;
    *) usage >&2; exit 2 ;;
  esac
  shift 2
done

for tool in yc jq; do
  command -v "$tool" >/dev/null || die "$tool is not installed"
done
[[ $name =~ ^[a-z]([a-z0-9-]*[a-z0-9])?$ ]] || die "not a VM name: $name"
[[ $user =~ ^[a-z_][a-z0-9_-]*$ ]] || die "not a user name: $user"
[[ -n $folder ]] || folder=$(yc config get folder-id 2>/dev/null || true)
[[ -n $folder ]] || die 'no folder: pass --folder-id or run yc config set folder-id <id>'
[[ -n $zone ]] || zone=$(yc config get compute-default-zone 2>/dev/null || true)
[[ -n $zone ]] || zone=ru-central1-a
if [[ -z $subnet ]]; then
  subnet=$(yc vpc subnet list --folder-id "$folder" --format json |
    jq -r --arg zone "$zone" '[.[] | select(.zone_id == $zone)][0].id // empty')
fi
[[ -n $subnet ]] || die "no subnet in $zone: pass --subnet-id"
[[ -r $ssh_key ]] || die "cannot read $ssh_key: pass --ssh-key with your public key"
key=$(<"$ssh_key")
key_types='^(ssh-ed25519|ssh-rsa|ecdsa-sha2-[a-z0-9-]+) '
[[ $key != *$'\n'* && $key =~ $key_types ]] || die "$ssh_key must hold one public SSH key, never a private key"
# A single-quoted YAML string, where a quote is doubled.
yaml_key=${key//"'"/"''"}

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
# The user has passwordless sudo for upkeep, as Yandex's own images give their user.
cat >"$scratch/cloud-init.yaml" <<EOF
#cloud-config
package_update: true
packages:
  - git
  - bubblewrap
  - socat
  - ripgrep
  - lsof
  - curl
users:
  - name: $user
    shell: /bin/bash
    lock_passwd: true
    sudo: ['ALL=(ALL) NOPASSWD:ALL']
    ssh_authorized_keys:
      - '$yaml_key'
ssh_pwauth: false
disable_root: true
write_files:
  # Ubuntu 24.04 strips unprivileged user namespaces of the rights bubblewrap needs, so no sandbox would start.
  - path: /etc/sysctl.d/60-agflow-userns.conf
    permissions: '0644'
    content: |
      kernel.apparmor_restrict_unprivileged_userns = 0
runcmd:
  - [sysctl, --system]
  - [curl, --fail, --location, --retry, '3', --output, /usr/local/bin/agflow, 'https://github.com/timur-nagimov/agflow/releases/latest/download/agflow-linux-x64']
  - [chmod, '0755', /usr/local/bin/agflow]
  # The runner's systemd user unit then runs with nobody logged in, and starts at boot.
  - [loginctl, enable-linger, $user]
EOF

yc compute instance create --folder-id "$folder" --name "$name" --hostname "$name" --zone "$zone" \
  --platform standard-v3 --cores 16 --memory 32 --core-fraction 100 \
  --create-boot-disk "name=$name-boot,type=network-ssd,size=200,image-family=ubuntu-2404-lts,image-folder-id=standard-images" \
  --network-interface "subnet-id=$subnet,nat-ip-version=ipv4" \
  --metadata-from-file "user-data=$scratch/cloud-init.yaml" \
  --format json >"$scratch/vm.json"
ip=$(jq -r '.network_interfaces[0].primary_v4_address.one_to_one_nat.address // empty' "$scratch/vm.json")
[[ -n $ip ]] || die "created $name, but it has no public address; see yc compute instance get $name"

cat <<EOF
Created $name at $ip in $zone. cloud-init needs a few minutes to install the tools and agflow.
Next, on the VM (ssh $user@$ip), following docs/linux-runner.md:
  cloud-init status --wait
  git config --global user.name 'Your Name' && git config --global user.email you@example.com
  give git access to the project's repository (an SSH key or a token; see docs/linux-runner.md)
  agflow login --hub https://YOUR-HUB
  agflow runner setup
    Codex: setup shows a link and a code; open the link in a browser on your Mac and enter the code.
    Claude: on your Mac run claude setup-token, then run here the command setup prints and paste the token.
  agflow runner setup      (again, once the token is saved: it installs and starts the systemd unit)
  agflow runner status
EOF

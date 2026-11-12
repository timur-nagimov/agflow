#!/usr/bin/env bash
# Run from any directory in this checkout. No server-side Git credentials are used.
set -euo pipefail

die() { echo "deploy-hub: $*" >&2; exit 1; }
dry_run=false
if [[ ${1:-} == --dry-run ]]; then dry_run=true; shift; fi
[[ $# == 2 ]] || die 'usage: scripts/deploy-hub.sh [--dry-run] agflow-admin@HOST https://PUBLIC_HOST'
target=$1
public_url=${2%/}
ssh_options=(-o BatchMode=yes -o StrictHostKeyChecking=yes -o ForwardAgent=no)
[[ $target =~ ^agflow-admin@[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || die 'SSH target must be agflow-admin@HOST (DNS name or IPv4)'
[[ $public_url =~ ^https://[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]$ ]] || die 'public URL must be an HTTPS origin without a port, path, credentials, query or fragment'
domain=${public_url#https://}
cd "$(dirname "$0")/.."
export GIT_OPTIONAL_LOCKS=0
[[ -z $(git status --porcelain --untracked-files=normal) ]] || die 'dirty worktree; commit all changes before deploying (including untracked files)'
sha=$(git rev-parse --verify HEAD)
[[ $sha =~ ^[0-9a-f]{40}$ ]] || die 'expected a full commit SHA'

cat <<EOF
Deploy $sha to $target ($public_url)
1. git archive $sha; upload over SSH (no Git credentials on the server).
2. Lock deployment; prepare /opt/agflow/releases/$sha.
3. As agflow-admin in a scratch build home: bun install --frozen-lockfile; bun run build:web.
4. Make release root-owned and readable by agflow; validate unit, production env and Caddy configuration.
5. Switch /opt/agflow/current with an atomic rename; refresh changed unit and Caddyfile; restart hub.
6. Wait for $public_url/api/auth-config through Caddy with a valid certificate and github auth.
7. On failure: rollback current symlink, unit and Caddyfile, then restart the previous release.
8. On success: keep the last 3 releases, including the current and previous releases.
EOF
$dry_run && exit 0

scratch=$(mktemp -d "${TMPDIR:-/tmp}/agflow-deploy.XXXXXXXX")
trap 'rm -rf "$scratch"' EXIT
git archive --format=tar "$sha" > "$scratch/release.tar"
git show "$sha:deploy/hub/activate.sh" > "$scratch/activate.sh"
# mktemp on the host prevents overlapping deployments from sharing an upload.
remote_archive=$(ssh "${ssh_options[@]}" "$target" 'umask 077; mktemp /tmp/agflow-upload.XXXXXXXX.tar')
[[ $remote_archive =~ ^/tmp/agflow-upload\.[a-zA-Z0-9]+\.tar$ ]] || die 'unexpected remote upload path'
cleanup() {
  ssh "${ssh_options[@]}" "$target" "rm -f '$remote_archive'" || true
  rm -rf "$scratch"
}
trap cleanup EXIT
ssh "${ssh_options[@]}" "$target" "cat > '$remote_archive'" < "$scratch/release.tar"
ssh "${ssh_options[@]}" "$target" \
  "sudo -n bash -s -- '$sha' '$domain' '$remote_archive'" < "$scratch/activate.sh"
# Activation checks locally through Caddy; this additional check catches external DNS/firewall problems.
curl --fail --silent --show-error --connect-timeout 5 --max-time 15 "$public_url/api/auth-config"
echo
echo "Deployed $sha. If the external check fails, inspect DNS/security-group rules; the server already passed its local TLS check."

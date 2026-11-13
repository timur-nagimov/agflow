#!/usr/bin/env bash
# Remote half of scripts/deploy-hub.sh. Run as root on the Ubuntu host, never locally.
set -euo pipefail
[[ $# == 3 && $EUID == 0 ]] || { echo 'activate: expected root, SHA, domain and upload path' >&2; exit 1; }
sha=$1 domain=$2 archive=$3
[[ $sha =~ ^[0-9a-f]{40}$ && $domain =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]$ && $archive =~ ^/tmp/agflow-upload\.[a-zA-Z0-9]+\.tar$ ]]
exec 9>/opt/agflow/.deploy.lock
flock -n 9 || { echo 'another deployment is in progress' >&2; exit 1; }
[[ $(/usr/local/bin/bun --version) == 1.3.11 ]] || { echo 'Bun 1.3.11 is required' >&2; exit 1; }
[[ -f /etc/agflow/hub.env && ! -L /etc/agflow/hub.env ]]
[[ $(stat -c '%U:%a' /etc/agflow/hub.env) == root:600 ]] || { echo 'hub.env must be root-owned, mode 0600' >&2; exit 1; }
# Require these literal settings exactly once, without displaying the environment or secrets.
# systemd EnvironmentFile is not a shell script; never source it.
python3 - "$domain" <<'PY'
import sys, shlex
values = {}
for line in open('/etc/agflow/hub.env'):
    line = line.strip()
    if not line or line.startswith(('#', ';')):
        continue
    key, sep, raw = line.partition('=')
    if not sep or key in values:
        sys.exit('hub.env: invalid or duplicate variable')
    words = shlex.split(raw)
    if len(words) != 1:
        sys.exit('hub.env: use one value per line; quote spaces')
    values[key] = words[0]
required = {
    'AGFLOW_AUTH': 'github', 'AGFLOW_PUBLIC_URL': 'https://' + sys.argv[1],
    'AGFLOW_HOST': '127.0.0.1', 'AGFLOW_PORT': '8787',
    'AGFLOW_DB': '/var/lib/agflow/data/agflow.db', 'AGFLOW_BACKUP_DIR': '/var/lib/agflow/backups',
    'AGFLOW_WEB_DIST': '/opt/agflow/current/packages/web/dist',
}
for key, value in required.items():
    if values.get(key) != value:
        sys.exit('hub.env: incorrect or missing ' + key)
for key in ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'AGFLOW_ALLOWED_USERS', 'AGFLOW_PROJECT_NAME', 'AGFLOW_PROJECT_REPO']:
    if not values.get(key) or 'REPLACE_' in values[key]:
        sys.exit('hub.env: fill ' + key)
if 'AGFLOW_TEST' in values or 'AGFLOW_TEST_CONFIG' in values:
    sys.exit('hub.env: test mode is forbidden in production')
PY

release=/opt/agflow/releases/$sha
stage=$(mktemp -d /opt/agflow/releases/.staging.XXXXXXXX)
state=$(mktemp -d /opt/agflow/.deploy-state.XXXXXXXX)
previous=$(readlink -f /opt/agflow/current || true)
[[ ! -e /opt/agflow/current || -L /opt/agflow/current ]] || { echo 'current must be a symlink' >&2; exit 1; }
if [[ -n $previous && -e $previous ]]; then
  [[ $previous =~ ^/opt/agflow/releases/[0-9a-f]{40}$ ]] || { echo 'unexpected previous release' >&2; exit 1; }
else
  previous=''
fi
unit=/etc/systemd/system/agflow-hub.service
caddy=/etc/caddy/Caddyfile
[[ ! -f $unit ]] || cp -p "$unit" "$state/unit"
[[ ! -f $caddy ]] || cp -p "$caddy" "$state/caddy"
activated=false
committed=false
switch_to() {
  ln -s "$1" /opt/agflow/.current-next
  mv -Tf /opt/agflow/.current-next /opt/agflow/current
}
cleanup() {
  result=$?
  trap - EXIT
  set +e
  if $activated && ! $committed; then
    echo 'Deployment failed; rolling back symlink, unit and Caddyfile.' >&2
    systemctl stop agflow-hub.service
    rm -f /opt/agflow/.current-next
    if [[ -n $previous ]]; then switch_to "$previous"; else rm -f /opt/agflow/current; fi
    if [[ -f $state/unit ]]; then
      cp -p "$state/unit" "$unit"
    else
      systemctl disable agflow-hub.service
      rm -f "$unit"
    fi
    if [[ -f $state/caddy ]]; then cp -p "$state/caddy" "$caddy"; else rm -f "$caddy"; fi
    systemctl daemon-reload
    if [[ -n $previous ]]; then
      systemctl reset-failed agflow-hub.service
      systemctl restart agflow-hub.service || echo 'Rollback hub restart failed; inspect journalctl -u agflow-hub' >&2
    fi
    if [[ -f $caddy ]]; then systemctl reload-or-restart caddy || echo 'Rollback Caddy reload failed' >&2; fi
  fi
  rm -rf "$stage" "$state"
  rm -f "$archive" /opt/agflow/.current-next
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ ! -d $release ]]; then
  tar --extract --file "$archive" --directory "$stage" --no-same-owner
  chown -R agflow-admin:agflow-admin "$stage"
  # Dependency installation/build never run as root or with the hub's OAuth credentials.
  sudo -u agflow-admin env HOME="$stage/.build-home" BUN_INSTALL_CACHE_DIR="$stage/.bun-cache" \
    PATH=/usr/local/bin:/usr/bin:/bin bash -c '
      set -euo pipefail
      cd "$1"
      mkdir -p "$HOME"
      bun install --frozen-lockfile
      bun run build:web
    ' bash "$stage"
  rm -rf "$stage/.build-home" "$stage/.bun-cache"
  [[ -s $stage/packages/web/dist/index.html ]]
  chown -R root:root "$stage"
  chmod -R a+rX,go-w "$stage"
  mv "$stage" "$release"
fi
sed "s/__AGFLOW_DOMAIN__/$domain/g" "$release/deploy/hub/Caddyfile" > "$state/Caddyfile"
caddy validate --config "$state/Caddyfile" --adapter caddyfile
systemd-analyze verify "$release/deploy/hub/agflow-hub.service"

activated=true
rm -f /opt/agflow/.current-next
switch_to "$release"
if ! cmp -s "$unit" "$release/deploy/hub/agflow-hub.service"; then
  install -o root -g root -m 0644 "$release/deploy/hub/agflow-hub.service" "$unit"
  systemctl daemon-reload
fi
if ! cmp -s "$caddy" "$state/Caddyfile"; then
  install -o root -g root -m 0644 "$state/Caddyfile" "$caddy"
  systemctl reload-or-restart caddy
fi
systemctl enable caddy agflow-hub.service
systemctl start caddy
systemctl reset-failed agflow-hub.service
systemctl restart agflow-hub.service

# Use the public hostname and certificate through Caddy, resolving to this VM to avoid NAT hairpin dependency.
# No --insecure, redirects, credentials, or authentication exemption on the hub.
healthy=false
for ((attempt=0; attempt<60; attempt++)); do
  if systemctl is-active --quiet agflow-hub.service && \
    curl --fail --silent --connect-timeout 2 --max-time 3 --noproxy '*' \
      --resolve "$domain:443:127.0.0.1" "https://$domain/api/auth-config" > "$state/health.json" && \
    python3 -c 'import json,sys; sys.exit(json.load(open(sys.argv[1])).get("mode") != "github")' "$state/health.json"; then
    healthy=true
    break
  fi
  sleep 2
done
$healthy || { echo 'Hub did not become healthy through Caddy' >&2; exit 1; }
committed=true
touch "$release"
# Only SHA-named release directories are eligible. Keep current and rollback target even after redeploying an old SHA.
kept=1
[[ -z $previous || $previous == "$release" ]] || kept=2
while read -r _ candidate; do
  [[ $candidate =~ ^/opt/agflow/releases/[0-9a-f]{40}$ ]] || continue
  [[ $candidate != "$release" && $candidate != "$previous" ]] || continue
  if (( kept < 3 )); then kept=$((kept + 1)); else rm -rf -- "$candidate"; fi
done < <(find /opt/agflow/releases -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -nr)
echo "Healthy release: $sha"

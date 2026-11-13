#!/usr/bin/env bash
# Operator recipe for a NEW VM. Never run against an already provisioned host.
# Needs authenticated yc, jq and python3 locally. No cloud/server credentials enter the archive.
set -euo pipefail
[[ ${1:-} == --execute && $# == 1 ]] || {
  echo 'Usage: set FOLDER_ID NETWORK_ID SUBNET_ID ADMIN_CIDR SSH_PUBLIC_KEY_FILE, then bash deploy/hub/yc-create.sh --execute'
  echo 'Optional: ZONE (ru-central1-a), NAME (agflow-hub), SNAPSHOT_CRON (0 3 * * *), SNAPSHOT_COUNT (7).'
  echo 'Creates billable resources: security group, reserved IPv4, Ubuntu VM with 10 GB SSD, daily disk snapshots.'
  exit 2
}
: "${FOLDER_ID:?}" "${NETWORK_ID:?}" "${SUBNET_ID:?}" "${ADMIN_CIDR:?Use your administrator public IPv4/32}" "${SSH_PUBLIC_KEY_FILE:?Public key file}"
ZONE=${ZONE:-ru-central1-a}
NAME=${NAME:-agflow-hub}
SNAPSHOT_CRON=${SNAPSHOT_CRON:-'0 3 * * *'}
SNAPSHOT_COUNT=${SNAPSHOT_COUNT:-7}
root=$(cd "$(dirname "$0")/../.." && pwd)
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
python3 - "$root/deploy/hub/cloud-init.yaml" "$SSH_PUBLIC_KEY_FILE" "$scratch/cloud-init.yaml" <<'PY'
import json, pathlib, sys
key = pathlib.Path(sys.argv[2]).read_text().strip()
if '\n' in key or not key.startswith(('ssh-ed25519 ', 'ssh-rsa ', 'ecdsa-sha2-')):
    sys.exit('Expected one OpenSSH public key, never a private key')
pathlib.Path(sys.argv[3]).write_text(pathlib.Path(sys.argv[1]).read_text().replace('__AGFLOW_ADMIN_SSH_KEY_JSON__', json.dumps(key)))
PY
yc_args=(--folder-id "$FOLDER_ID")
sg=$(yc "${yc_args[@]}" vpc security-group create --name "$NAME" --network-id "$NETWORK_ID" \
  --rule "direction=ingress,port=22,protocol=tcp,v4-cidrs=[$ADMIN_CIDR]" \
  --rule 'direction=ingress,port=80,protocol=tcp,v4-cidrs=[0.0.0.0/0]' \
  --rule 'direction=ingress,port=443,protocol=tcp,v4-cidrs=[0.0.0.0/0]' \
  --rule 'direction=egress,protocol=any,v4-cidrs=[0.0.0.0/0]' --format json | jq -er .id)
ip=$(yc "${yc_args[@]}" vpc address create --name "$NAME-ip" \
  --external-ipv4 "zone=$ZONE" --format json | jq -er .external_ipv4_address.address)
yc "${yc_args[@]}" compute instance create --name "$NAME" --zone "$ZONE" \
  --platform standard-v3 --cores 2 --memory 4 --core-fraction 100 \
  --create-boot-disk "name=$NAME-boot,type=network-ssd,size=10,image-family=ubuntu-2404-lts,image-folder-id=standard-images,auto-delete=false" \
  --network-interface "subnet-id=$SUBNET_ID,nat-ip-version=ipv4,nat-address=$ip,security-group-ids=$sg" \
  --metadata-from-file "user-data=$scratch/cloud-init.yaml" --format json > "$scratch/vm.json"
disk=$(jq -er .boot_disk.disk_id "$scratch/vm.json")
schedule=$(yc "${yc_args[@]}" compute snapshot-schedule create --name "$NAME-daily" \
  --expression "$SNAPSHOT_CRON" --snapshot-count "$SNAPSHOT_COUNT" --format json | jq -er .id)
yc "${yc_args[@]}" compute snapshot-schedule add-disks "$schedule" --disk-id "$disk"
echo "VM IP: $ip; public URL without a domain: https://${ip//./-}.sslip.io"
echo "Boot disk: $disk; snapshot schedule: $schedule (UTC). Verify its first completed snapshot in the console."
echo 'Wait for cloud-init status --wait on the host; do not deploy until provisioning succeeds.'
echo 'If any command failed, inspect resources by name before retrying; this creation recipe is not idempotent.'

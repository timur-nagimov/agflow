#!/bin/sh
# A network probe of the sandbox checks (design 5, boundary 1). Each probe is five words,
#   <label> http <url> env|socks|direct <host>:<port>:<address>|-
#   <label> ssh <host> env|direct -
# and prints `PROBE <label>: reached|blocked <detail>`. A plain HTTP url that got a response prints `answered`
# instead: a refusing proxy answers those itself, so only the target can tell whether it was reached.
# "env" goes the way the environment's proxies send it, with NO_PROXY cleared so loopback goes there too (inside the
# sandbox: Claude's sandbox proxy); "socks" goes through the SOCKS side of the proxy ALL_PROXY names, with its
# credentials; "direct" bypasses every proxy. The sandbox has no DNS, so a direct probe names the address (curl's
# --resolve, or the address as the host). The SSH probe uses no configuration, key or agent: it only checks that a key
# exchange with the host happened.

result() {
  printf 'PROBE %s: %s %s\n' "$1" "$2" "$(printf '%s' "$3" | tr '\r\n' '  ' | cut -c1-240)"
}

http_probe() {
  label=$1 url=$2 via=$3 resolve=$4
  set -- -sS -o /dev/null -m 10 -w '%{http_code}'
  if [ "$resolve" != - ]; then set -- "$@" --resolve "$resolve"; fi
  if [ "$via" = direct ]; then
    out=$(curl --noproxy '*' "$@" "$url" 2>&1)
  elif [ "$via" = socks ]; then
    out=$(curl -x "$(socks_proxy)" "$@" "$url" 2>&1)
  else
    out=$(NO_PROXY= no_proxy= curl "$@" "$url" 2>&1)
  fi
  status=$?
  if [ $status -ne 0 ]; then
    result "$label" blocked "$out"
  elif [ "${url#https://}" != "$url" ]; then
    result "$label" reached "HTTP $out"
  else
    result "$label" answered "HTTP $out"
  fi
}

# The SOCKS URL of the proxy ALL_PROXY names, with its credentials: the sandbox's proxy speaks SOCKS on the same port
# and lets only clients that authenticate reach its allow list.
socks_proxy() {
  proxy=${ALL_PROXY#*://}
  printf 'socks5h://%s' "${proxy%/}"
}

ssh_probe() {
  label=$1 host=$2 via=$3
  if [ "$via" = env ] && [ -n "${ALL_PROXY:-}" ]; then
    socks_ssh_probe "$label" "$host"
    return
  fi
  out=$(ssh -v -F /dev/null -o BatchMode=yes -o ConnectTimeout=10 -o IdentityAgent=none -o IdentitiesOnly=yes \
    -o PubkeyAuthentication=no -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 22 "git@$host" true 2>&1 </dev/null)
  case $out in
    *'Server host key:'*) result "$label" reached "$(printf '%s\n' "$out" | grep 'Server host key:')" ;;
    *) result "$label" blocked "$(printf '%s\n' "$out" | grep -v '^debug' | tail -n 2)" ;;
  esac
}

# Port 22 through the sandbox's SOCKS proxy, authenticated as an agent could with ALL_PROXY's credentials. The
# sandbox's own GIT_SSH_COMMAND (nc -X 5) offers no authentication, and an unauthenticated client gets an SSH banner
# of `policy_refusal` whatever the allow list says, so that banner never counts as blocked.
socks_ssh_probe() {
  label=$1 host=$2
  out=$(curl -v -sS -m 10 -x "$(socks_proxy)" "telnet://$host:22" 2>&1 </dev/null)
  case $out in
    *'SSH-2.0-policy_refusal'*) result "$label" unauthenticated "the proxy took the probe as unauthenticated" ;;
    *"Can't complete SOCKS5 connection to $host. (2)"*) result "$label" blocked "SOCKS5 refused by the ruleset" ;;
    *'SSH-2.0-'* | *'SOCKS5 request granted'*)
      result "$label" reached "$(printf '%s\n' "$out" | grep -E 'SSH-2.0-|SOCKS5 request granted' | head -n 1)" ;;
    *) result "$label" unknown "$(printf '%s\n' "$out" | tail -n 2)" ;;
  esac
}

while [ $# -ge 5 ]; do
  case $2 in
    http) http_probe "$1" "$3" "$4" "$5" ;;
    ssh) ssh_probe "$1" "$3" "$4" ;;
    *) result "$1" unknown "no probe kind $2" ;;
  esac
  shift 5
done

#!/bin/sh
# A keychain probe of the sandbox checks (design 5, keychain): looks a generic-password item up in a keychain file
# and prints `PROBE <label>: read <secret>` or `PROBE <label>: refused <error>`.
# Usage: keychain.sh <label> <keychain> <service> <account>

out=$(security find-generic-password -s "$3" -a "$4" -w "$2" 2>&1)
if [ $? -eq 0 ]; then
  printf 'PROBE %s: read %s\n' "$1" "$out"
else
  printf 'PROBE %s: refused %s\n' "$1" "$(printf '%s' "$out" | tr '\r\n' '  ' | cut -c1-240)"
fi

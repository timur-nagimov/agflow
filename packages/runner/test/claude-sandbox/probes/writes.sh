#!/bin/sh
# A write probe of the sandbox checks (design 5, boundary 2). It prints the commands' temporary directory as
# `PROBE TMPDIR: is <value>` and makes a file there with mktemp (named after TMPDIR: macOS's bare mktemp uses the
# per-user /var/folders directory, which the sandbox refuses). Then, for each label and directory, it makes the
# directory if it is missing and a file in it. Each write prints `PROBE <label>: written <file>` or
# `PROBE <label>: refused <error>`.
# Usage: writes.sh [<label> <directory> ...]

refused() {
  printf 'PROBE %s: refused %s\n' "$1" "$(printf '%s' "$2" | tr '\r\n' '  ' | cut -c1-240)"
}

printf 'PROBE TMPDIR: is %s\n' "${TMPDIR:-unset}"
if out=$(mktemp "${TMPDIR:-/tmp}/agflow-probe.XXXXXX" 2>&1); then
  printf 'PROBE mktemp: written %s\n' "$out"
else
  refused mktemp "$out"
fi
while [ $# -ge 2 ]; do
  file="$2/agflow-write-probe-$$"
  if out=$( { mkdir -p "$2" && printf 'agflow write probe\n' >"$file"; } 2>&1 ); then
    printf 'PROBE %s: written %s\n' "$1" "$file"
  else
    refused "$1" "$out"
  fi
  shift 2
done

#!/usr/bin/env bash
# Technical log retention (DSGVO-06, 08 §7.1): container logs are kept at most LOG_RETENTION_DAYS (default 90).
# Docker's json-file driver rotates by size only (compose: max-size/max-file on every service, linted), so this
# Dokploy server schedule (daily 03:45, installed at /opt/rechnungen/log-retention.sh) also enforces the age limit:
#   - rotated files (<log>.1 … <log>.N) whose newest line is older than the cutoff are deleted;
#   - the active file is rewritten in place without the lines older than the cutoff (Docker appends with O_APPEND,
#     so truncating in place is safe).
# The GoBD audit log lives in Convex, not here, and is kept per GOBD-20.
#
# Usage: log-retention.sh                 # all containers of compose project $COMPOSE_APPNAME (Dokploy schedule)
#        log-retention.sh FILE…           # explicit json-file logs (tests, manual runs)
# Env:   LOG_RETENTION_DAYS (90), LOG_RETENTION_NOW (ISO timestamp, tests only)
set -euo pipefail

DAYS="${LOG_RETENTION_DAYS:-90}"
if (( DAYS > 90 )); then
  echo "LOG_RETENTION_DAYS=$DAYS exceeds the 90-day limit (DSGVO-06)" >&2
  exit 2
fi
now_s="$(date -u -d "${LOG_RETENTION_NOW:-now}" +%s)"
CUTOFF="$(date -u -d "@$((now_s - DAYS * 86400))" +%Y-%m-%dT%H:%M:%S)"

# Prints the timestamp of line N ("first"/"last") of a json-file log; empty if none.
line_time() {
  local file="$1" which="$2" line
  if [[ "$which" == first ]]; then line="$(head -n1 "$file")"; else line="$(tail -n1 "$file")"; fi
  sed -n 's/.*"time":"\([0-9T:.-]*\)Z\{0,1\}".*/\1/p' <<<"$line" | cut -c1-19
}

prune_active() {
  local file="$1" first tmp
  first="$(line_time "$file" first)"
  [[ -z "$first" || "$first" > "$CUTOFF" || "$first" == "$CUTOFF" ]] && return 0
  tmp="$(mktemp)"
  awk -v cutoff="$CUTOFF" '
    { t = "" }
    match($0, /"time":"[0-9T:.-]+/) { t = substr($0, RSTART + 8, 19) }
    t == "" || t >= cutoff { print }
  ' "$file" >"$tmp"
  cat "$tmp" >"$file"
  rm -f "$tmp"
  echo "pruned $file (lines before $CUTOFF)"
}

prune_rotated() {
  local file="$1" last
  last="$(line_time "$file" last)"
  if [[ -z "$last" || "$last" < "$CUTOFF" ]]; then
    rm -f "$file"
    echo "deleted $file"
  fi
}

process() {
  local file="$1" rotated
  [[ -f "$file" ]] || return 0
  prune_active "$file"
  shopt -s nullglob
  for rotated in "$file".[0-9]*; do
    if [[ "$rotated" == *.gz ]]; then
      find "$rotated" -mtime +"$DAYS" -delete
    else
      prune_rotated "$rotated"
    fi
  done
  shopt -u nullglob
}

if (( $# > 0 )); then
  for f in "$@"; do process "$f"; done
  exit 0
fi

: "${COMPOSE_APPNAME:?set COMPOSE_APPNAME (Dokploy compose app name)}"
docker ps -aq --filter "label=com.docker.compose.project=$COMPOSE_APPNAME" |
  xargs -r docker inspect --format '{{.LogPath}}' |
  while read -r path; do [[ -n "$path" ]] && process "$path"; done

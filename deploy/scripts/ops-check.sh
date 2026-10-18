#!/usr/bin/env bash
# Operations check for the DEPLOYED STACK ONLY (DSGVO-05, DSGVO-06, SEC-05; 08 §7.1). Run on the server as root
# (Dokploy server schedule "ops-check", weekly, or by hand after changes); not part of CI — CI tests the individual
# checks below with fixtures (deploy/scripts/ops-scripts.test.ts). Prints one line per check:
#   OK|WARN|FAIL <check> <detail>      exit 1 if any FAIL.
#
# Subcommands (each also usable alone):
#   log-age FILE…            oldest line of each json-file log ≤ LOG_RETENTION_DAYS (90) days old      (DSGVO-06)
#   caddy-log FILE           access log: client IPs truncated (IPv4 /24, IPv6 /48), no Cookie/Authorization
#                            headers                                                                 (DSGVO-05/06)
#   r2-endpoint URL…         R2 S3 endpoint is the EU-jurisdiction endpoint (*.eu.r2.cloudflarestorage.com) (SEC-05)
#   disk-types               reads `lsblk -s -no TYPE <root device>` from stdin: a `crypt` layer → encrypted (DSGVO-05)
#   all                      everything above for compose project $COMPOSE_APPNAME and /opt/rechnungen/backup.env;
#                            disk: LUKS (crypt) or ZFS native encryption, else DISK_ENCRYPTION_CONFIRMED=<YYYY-MM-DD>
#                            (encryption confirmed on the Proxmox host, which a VM cannot see) → WARN without it.
set -uo pipefail

DAYS="${LOG_RETENTION_DAYS:-90}"
FAILED=0
report() { # status check detail
  echo "$1 $2 $3"
  [[ "$1" == FAIL ]] && FAILED=1
  return 0
}

now_s() { date -u -d "${OPS_CHECK_NOW:-now}" +%s; }

check_log_age() {
  local file first first_s age
  for file in "$@"; do
    first="$(head -n1 "$file" 2>/dev/null | sed -n 's/.*"time":"\([0-9T:.-]*\)Z\{0,1\}".*/\1/p' | cut -c1-19)"
    if [[ -z "$first" ]]; then
      report OK log-age "$file leer"
      continue
    fi
    first_s="$(date -u -d "${first}Z" +%s)"
    age=$(( ($(now_s) - first_s) / 86400 ))
    if (( age > DAYS )); then
      report FAIL log-age "$file: ältester Eintrag $age Tage (> $DAYS) — log-retention.sh läuft nicht"
    else
      report OK log-age "$file: ältester Eintrag $age Tage"
    fi
  done
}

check_caddy_log() {
  local file="$1" sample bad_ip headers
  # Docker's json-file wraps each Caddy JSON line in a string ({"log":"{\"remote_ip\":…}"}): unescape first.
  sample="$(tail -n 2000 "$file" 2>/dev/null | sed 's/\\"/"/g')"
  if [[ -z "$sample" ]]; then
    report WARN caddy-log "$file: keine Einträge"
    return
  fi
  # IPv4 must end in .0 (/24); IPv6 must end in :: (/48 → the rest is zero).
  bad_ip="$(grep -oE '"(remote_ip|client_ip)":"[^"]*"' <<<"$sample" | cut -d'"' -f4 |
    grep -vE '^([0-9]+\.){3}0$|::$|^$' | head -n1)"
  headers="$(grep -oE '"(Cookie|Authorization|Set-Cookie)":' <<<"$sample" | sort -u | tr -d '":' | paste -sd, -)"
  if [[ -n "$bad_ip" ]]; then
    report FAIL caddy-log "ungekürzte IP-Adresse im Zugriffsprotokoll ($bad_ip)"
  elif [[ -n "$headers" ]]; then
    report FAIL caddy-log "Header im Zugriffsprotokoll: $headers"
  else
    report OK caddy-log "IP-Adressen gekürzt, keine Cookies/Authorization"
  fi
}

check_r2_endpoint() {
  local url
  for url in "$@"; do
    if [[ "$url" =~ ^https://[0-9a-f]{32}\.eu\.r2\.cloudflarestorage\.com/?$ ]]; then
      report OK r2-endpoint "$url (EU-Jurisdiktion)"
    else
      report FAIL r2-endpoint "$url ist nicht der EU-Endpunkt (<account>.eu.r2.cloudflarestorage.com)"
    fi
  done
}

check_disk_types() {
  if grep -qx 'crypt' <(tr -s ' ' '\n'); then
    report OK disk-encryption "LUKS (dm-crypt) unter dem Wurzeldateisystem"
    return 0
  fi
  return 1
}

check_disk_all() {
  local src fstype enc
  src="$(findmnt -no SOURCE /)"
  fstype="$(findmnt -no FSTYPE /)"
  if [[ "$fstype" == zfs ]]; then
    enc="$(zfs get -H -o value encryption "$src" 2>/dev/null)"
    if [[ -n "$enc" && "$enc" != off ]]; then
      report OK disk-encryption "ZFS-Verschlüsselung $enc"
      return
    fi
  elif lsblk -s -no TYPE "$src" 2>/dev/null | check_disk_types; then
    return
  fi
  if [[ "${DISK_ENCRYPTION_CONFIRMED:-}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
    report OK disk-encryption "Verschlüsselung auf dem Proxmox-Host bestätigt am $DISK_ENCRYPTION_CONFIRMED"
  else
    report WARN disk-encryption "keine Verschlüsselung sichtbar; auf dem Host prüfen und DISK_ENCRYPTION_CONFIRMED setzen"
  fi
}

run_all() {
  : "${COMPOSE_APPNAME:?set COMPOSE_APPNAME}"
  local env_file="${BACKUP_ENV_FILE:-/opt/rechnungen/backup.env}" ids caddy_log
  # shellcheck disable=SC1090  # server-side env file, path only known at runtime
  [[ -f "$env_file" ]] && { set -a; source "$env_file"; set +a; }
  ids="$(docker ps -aq --filter "label=com.docker.compose.project=$COMPOSE_APPNAME")"
  # shellcheck disable=SC2086
  mapfile -t logs < <(docker inspect --format '{{.LogPath}}' $ids 2>/dev/null)
  ((${#logs[@]})) && check_log_age "${logs[@]}"
  caddy_log="$(docker ps -q --filter "label=com.docker.compose.project=$COMPOSE_APPNAME" \
    --filter "label=com.docker.compose.service=caddy" | head -n1 | xargs -r docker inspect --format '{{.LogPath}}')"
  [[ -n "$caddy_log" ]] && check_caddy_log "$caddy_log"
  if [[ -n "${R2_ACCOUNT_ENDPOINT:-}" ]]; then check_r2_endpoint "$R2_ACCOUNT_ENDPOINT"; else
    report WARN r2-endpoint "R2_ACCOUNT_ENDPOINT nicht gesetzt ($env_file)"
  fi
  check_disk_all
}

cmd="${1:-all}"
shift || true
case "$cmd" in
  log-age) check_log_age "$@" ;;
  caddy-log) check_caddy_log "$1" ;;
  r2-endpoint) check_r2_endpoint "$@" ;;
  disk-types) check_disk_types || report WARN disk-encryption "keine crypt-Schicht" ;;
  all) run_all ;;
  *) echo "unknown subcommand $cmd" >&2; exit 2 ;;
esac
exit "$FAILED"

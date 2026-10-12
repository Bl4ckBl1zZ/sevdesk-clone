#!/usr/bin/env bash
# Monthly retention copy (08 §7, SEC-05/GOBD-09): copies the newest object(s) of each backup prefix to
# `monthly/<prefix>/<YYYY-MM>/` in the same R2 bucket (10-year retention prefix; daily prefixes rotate via
# keepLatestCount / lifecycle rules). Runs ON the server as a Dokploy server schedule (1st of the month, 05:00),
# installed at /opt/rechnungen/r2-monthly-copy.sh, env from /opt/rechnungen/backup.env (see convex-export.sh).
set -euo pipefail

ENV_FILE="${BACKUP_ENV_FILE:-/opt/rechnungen/backup.env}"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi
: "${R2_ACCOUNT_ENDPOINT:?}" "${R2_BACKUP_BUCKET:?}" "${R2_BACKUP_WRITER_ACCESS_KEY_ID:?}" "${R2_BACKUP_WRITER_SECRET_ACCESS_KEY:?}"
read -r -a PREFIXES <<<"${R2_MONTHLY_PREFIXES:-postgres convex-export convex-volume}"
MONTH="$(date -u +%Y-%m)"

export RCLONE_CONFIG_R2_TYPE=s3 RCLONE_CONFIG_R2_PROVIDER=Cloudflare RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true \
  RCLONE_CONFIG_R2_ENDPOINT="$R2_ACCOUNT_ENDPOINT" \
  RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_BACKUP_WRITER_ACCESS_KEY_ID" \
  RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_BACKUP_WRITER_SECRET_ACCESS_KEY"

for prefix in "${PREFIXES[@]}"; do
  # newest object by modification time ("<time>;<path>" sorts chronologically)
  latest="$(rclone lsf -R --files-only --format "tp" --separator ";" "r2:$R2_BACKUP_BUCKET/$prefix/" | sort | tail -n1 | cut -d';' -f2-)"
  if [[ -z "$latest" ]]; then
    echo "⚠ no objects under $prefix/" >&2
    continue
  fi
  dir="$(dirname "$latest")"
  if [[ "$prefix" == "convex-export" && "$dir" != "." ]]; then
    # one export = a timestamped folder (zip + sha256 + env names) → copy the whole folder
    rclone copy "r2:$R2_BACKUP_BUCKET/$prefix/$dir/" "r2:$R2_BACKUP_BUCKET/monthly/$prefix/$MONTH/" --s3-no-check-bucket
  else
    rclone copyto "r2:$R2_BACKUP_BUCKET/$prefix/$latest" "r2:$R2_BACKUP_BUCKET/monthly/$prefix/$MONTH/$(basename "$latest")" --s3-no-check-bucket
  fi
  echo "✔ $prefix/$latest → monthly/$prefix/$MONTH/"
done

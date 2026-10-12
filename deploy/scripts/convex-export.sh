#!/usr/bin/env bash
# Daily logical Convex export (tables + file storage) → R2 `convex-export/` (08 §7). Runs ON the server
# "Proxmox PVE" as a Dokploy server schedule (deploy/bootstrap.sh step `backups`), installed at
# /opt/rechnungen/convex-export.sh, secrets in /opt/rechnungen/backup.env (0600, root):
#   CONVEX_SELF_HOSTED_ADMIN_KEY, R2_ACCOUNT_ENDPOINT, R2_BACKUP_BUCKET,
#   R2_BACKUP_WRITER_ACCESS_KEY_ID, R2_BACKUP_WRITER_SECRET_ACCESS_KEY
# COMPOSE_APPNAME (Dokploy appName of compose "rechnungen") is passed by the schedule command.
#
# A throwaway node container joins the compose network and talks to http://backend:3210 (no tailnet hairpin).
# Only the NAMES of the Convex env variables are stored (values are secrets). Upload via rclone (installed on every
# Dokploy server). Retention: R2 lifecycle rule on convex-export/ (90 days) + monthly copies (r2-monthly-copy.sh).
set -euo pipefail

ENV_FILE="${BACKUP_ENV_FILE:-/opt/rechnungen/backup.env}"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi
: "${COMPOSE_APPNAME:?COMPOSE_APPNAME required (Dokploy appName)}"
: "${CONVEX_SELF_HOSTED_ADMIN_KEY:?}" "${R2_ACCOUNT_ENDPOINT:?}" "${R2_BACKUP_BUCKET:?}"
: "${R2_BACKUP_WRITER_ACCESS_KEY_ID:?}" "${R2_BACKUP_WRITER_SECRET_ACCESS_KEY:?}"
CONVEX_CLI_VERSION="${CONVEX_CLI_VERSION:-1.46.0}"
NODE_IMAGE="${NODE_IMAGE:-node:24.21.0-slim}"

STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
WORK="$(mktemp -d /tmp/convex-export.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
chmod 0700 "$WORK"

docker run --rm \
  --network "${COMPOSE_APPNAME}_default" \
  -v "$WORK:/out" \
  -e CONVEX_SELF_HOSTED_URL=http://backend:3210 \
  -e CONVEX_SELF_HOSTED_ADMIN_KEY \
  -e CONVEX_CLI_VERSION="$CONVEX_CLI_VERSION" \
  "$NODE_IMAGE" sh -euc '
    mkdir -p /work && cd /work
    echo "{\"name\":\"convex-export\",\"private\":true}" > package.json
    npm install --silent --no-audit --no-fund "convex@$CONVEX_CLI_VERSION"
    npx convex export --include-file-storage --path /out/convex-export.zip
    npx convex env list | cut -d= -f1 > /out/convex-env-names.txt
    chown -R '"$(id -u):$(id -g)"' /out
  '

sha256sum "$WORK/convex-export.zip" > "$WORK/convex-export.zip.sha256"

export RCLONE_CONFIG_R2_TYPE=s3 RCLONE_CONFIG_R2_PROVIDER=Cloudflare RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true \
  RCLONE_CONFIG_R2_ENDPOINT="$R2_ACCOUNT_ENDPOINT" \
  RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_BACKUP_WRITER_ACCESS_KEY_ID" \
  RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_BACKUP_WRITER_SECRET_ACCESS_KEY"
rclone copy "$WORK" "r2:$R2_BACKUP_BUCKET/convex-export/$STAMP/" --s3-no-check-bucket
echo "convex export $STAMP: $(du -h "$WORK/convex-export.zip" | cut -f1) → r2:$R2_BACKUP_BUCKET/convex-export/$STAMP/"

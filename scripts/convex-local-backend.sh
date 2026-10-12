#!/usr/bin/env bash
# Runs the official precompiled self-hosted Convex backend WITHOUT Docker (dev/CI helper).
# The production/local Docker stack stays deploy/compose.dev.yml (08 §10); this script exists for
# machines without Docker so `pnpm convex dev|codegen|deploy` and integration tests have a backend.
#
#   scripts/convex-local-backend.sh            # start on :3210 (API) / :3211 (HTTP actions), foreground
#   scripts/convex-local-backend.sh env        # print CONVEX_SELF_HOSTED_URL / _ADMIN_KEY for .env.local
#   scripts/convex-local-backend.sh reset      # delete the local data directory
#
# State lives in .convex/local/ (gitignored). The binary is cached outside the repo.
set -euo pipefail

VERSION="${CONVEX_BACKEND_VERSION:-precompiled-2026-10-10-72ce13c}"   # keep in sync with CONVEX_SHA (02 §2)
PORT="${CONVEX_PORT:-3210}"
SITE_PORT="${CONVEX_SITE_PORT:-3211}"
INSTANCE_NAME="${CONVEX_INSTANCE_NAME:-rechnungen-dev}"
INTERFACE="${CONVEX_INTERFACE:-127.0.0.1}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="$ROOT/.convex/local"
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/rechnungen/convex-backend/$VERSION"
BIN="$CACHE_DIR/convex-local-backend"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) ASSET="convex-local-backend-x86_64-unknown-linux-gnu.zip" ;;
  Linux-aarch64) ASSET="convex-local-backend-aarch64-unknown-linux-gnu.zip" ;;
  Darwin-arm64) ASSET="convex-local-backend-aarch64-apple-darwin.zip" ;;
  Darwin-x86_64) ASSET="convex-local-backend-x86_64-apple-darwin.zip" ;;
  *) echo "unsupported platform $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

ensure_binary() {
  if [[ ! -x "$BIN" ]]; then
    mkdir -p "$CACHE_DIR"
    echo "Downloading Convex backend $VERSION …" >&2
    curl -fsSL -o "$CACHE_DIR/backend.zip" \
      "https://github.com/get-convex/convex-backend/releases/download/$VERSION/$ASSET"
    unzip -o -q "$CACHE_DIR/backend.zip" -d "$CACHE_DIR"
    rm -f "$CACHE_DIR/backend.zip"
    chmod +x "$BIN"
  fi
}

ensure_secret() {
  mkdir -p "$DATA_DIR"
  if [[ ! -s "$DATA_DIR/instance_secret" ]]; then
    openssl rand -hex 32 > "$DATA_DIR/instance_secret"
  fi
  INSTANCE_SECRET="$(cat "$DATA_DIR/instance_secret")"
}

admin_key() {
  "$BIN" keygen admin-key --instance-name "$INSTANCE_NAME" --instance-secret "$INSTANCE_SECRET" | tail -n1
}

ensure_binary
ensure_secret

case "${1:-start}" in
  env)
    echo "CONVEX_SELF_HOSTED_URL=http://127.0.0.1:$PORT"
    echo "CONVEX_SELF_HOSTED_ADMIN_KEY='$(admin_key)'"
    ;;
  reset)
    rm -rf "$DATA_DIR"
    echo "removed $DATA_DIR"
    ;;
  start)
    echo "Convex backend $VERSION on http://127.0.0.1:$PORT (site :$SITE_PORT), data in $DATA_DIR" >&2
    exec "$BIN" \
      --interface "$INTERFACE" \
      --port "$PORT" \
      --site-proxy-port "$SITE_PORT" \
      --instance-name "$INSTANCE_NAME" \
      --instance-secret "$INSTANCE_SECRET" \
      --local-storage "$DATA_DIR/storage" \
      --disable-beacon \
      "$DATA_DIR/convex_local_backend.sqlite3"
    ;;
  *) echo "usage: $0 [start|env|reset]" >&2; exit 2 ;;
esac

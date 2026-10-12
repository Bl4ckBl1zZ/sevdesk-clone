#!/usr/bin/env bash
# Builds and installs a Dokploy CLI that matches OUR Dokploy server (fork Bl4ckBl1zZ/dokploy,
# which has extra procedures such as tailscale.* and cloudflare.* that the npm @dokploy/cli lacks).
#
# - Takes the upstream CLI source (github.com/Dokploy/cli) and its generator.
# - Downloads the OpenAPI document from the live server (settings.getOpenApiDocument), so the
#   commands match the server version exactly.
# - Fixes the upstream bug where tRPC GET queries send input without the {"json": …} wrapper
#   (every `one`/`by-*` command fails with HTTP 400 on Dokploy >= 0.41).
# - Installs it globally as `dokploy` and keeps the existing auth config.
#
# Usage: DOKPLOY_URL=https://dokploy.example.org DOKPLOY_AUTH_TOKEN=… deploy/scripts/build-dokploy-cli.sh
#        (or with no env vars once `dokploy auth` has been run: the existing config is reused)
# Re-run after every Dokploy server upgrade.
set -euo pipefail

CLI_REPO="${CLI_REPO:-https://github.com/Dokploy/cli.git}"
CLI_REF="${CLI_REF:-main}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

GLOBAL_ROOT="$(npm root -g)"
OLD_CFG="$GLOBAL_ROOT/@dokploy/cli/config.json"
URL="${DOKPLOY_URL:-}"
TOKEN="${DOKPLOY_AUTH_TOKEN:-${DOKPLOY_API_KEY:-}}"
if [[ -z "$URL" || -z "$TOKEN" ]]; then
  [[ -f "$OLD_CFG" ]] || { echo "set DOKPLOY_URL and DOKPLOY_AUTH_TOKEN (no existing CLI config)" >&2; exit 1; }
  URL="$(jq -r .url "$OLD_CFG")"
  TOKEN="$(jq -r .token "$OLD_CFG")"
fi

echo "→ cloning upstream CLI ($CLI_REF)"
git clone --quiet --depth 1 --branch "$CLI_REF" "$CLI_REPO" "$WORK/cli"
cd "$WORK/cli"

echo "→ downloading OpenAPI document from $URL"
curl -fsS -H "x-api-key: $TOKEN" "$URL/api/trpc/settings.getOpenApiDocument" \
  | jq '.result.data.json' > openapi.json
SERVER_VERSION="$(curl -fsS -H "x-api-key: $TOKEN" "$URL/api/trpc/settings.getDokployVersion" | jq -r '.result.data.json')"
echo "  server $SERVER_VERSION, $(jq '.paths | length' openapi.json) procedures"

echo "→ patching tRPC GET input wrapper"
sed -i 's/encodeURIComponent(JSON.stringify(params))/encodeURIComponent(JSON.stringify({ json: params }))/' src/client.ts
grep -q 'JSON.stringify({ json: params })' src/client.ts || { echo "patch did not apply; upstream client.ts changed" >&2; exit 1; }

BASE_VERSION="$(jq -r .version package.json)"
jq --arg v "$BASE_VERSION-server.$SERVER_VERSION" '.version = $v' package.json > package.tmp && mv package.tmp package.json

echo "→ building"
pnpm install --frozen-lockfile --ignore-scripts --silent  # esbuild postinstall not needed (platform binary is an optional dep)
pnpm run build >/dev/null
TARBALL="$(npm pack --silent)"

echo "→ installing globally"
npm install -g --silent "./$TARBALL"

echo "→ restoring auth"
dokploy auth -u "$URL" -t "$TOKEN" >/dev/null
chmod 600 "$(npm root -g)/@dokploy/cli/config.json"
echo "✓ dokploy $(dokploy --version) installed ($(dokploy --help | grep -c '^  [a-z]') command groups)"

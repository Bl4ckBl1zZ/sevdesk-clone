#!/usr/bin/env bash
# Continuous deployment step (08 §6, steps 4–6), run by .github/workflows/deploy.yml on a runner that has joined the
# tailnet (tag:ci). Talks to the Dokploy tRPC API directly with curl (same endpoints as the generated CLI:
# compose.one, compose.saveEnvironment, compose.deploy) so CI needs no custom CLI build.
#
#  1. read the compose env from Dokploy (secrets stay in Dokploy; nothing is printed)
#  2. replace only the image tag lines (WEB_TAG, CADDY_TAG, EIT_TAG [, IMAGE_REGISTRY])
#  3. save + deploy, wait for the deployment to finish
#  4. smoke over the tailnet: https://app.<BASE_DOMAIN>/api/health, https://api.<BASE_DOMAIN>/api/health (+ SMOKE_EXTRA)
#  5. on failure: restore the previous env, redeploy, exit 1
#
# Env: DOKPLOY_URL, DOKPLOY_API_KEY, DOKPLOY_COMPOSE_ID, BASE_DOMAIN, WEB_TAG/CADDY_TAG/EIT_TAG (any subset),
#      optional IMAGE_REGISTRY, DEPLOY_TITLE, SMOKE_EXTRA (space-separated URLs), DRY_RUN=1 (print the plan only).
set -euo pipefail

: "${DOKPLOY_URL:?}" "${DOKPLOY_API_KEY:?}" "${DOKPLOY_COMPOSE_ID:?}" "${BASE_DOMAIN:?}"
TITLE="${DEPLOY_TITLE:-ci $(date -u +%Y-%m-%dT%H:%M:%SZ)}"
API="${DOKPLOY_URL%/}/api/trpc"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
chmod 0700 "$WORK"

trpc_get() { # procedure json-input
  curl -fsS --max-time 30 -H "x-api-key: $DOKPLOY_API_KEY" -G "$API/$1" \
    --data-urlencode "input=$(jq -nc --argjson j "$2" '{json: $j}')" | jq '.result.data.json'
}
trpc_post() { # procedure json-input
  curl -fsS --max-time 60 -H "x-api-key: $DOKPLOY_API_KEY" -H "Content-Type: application/json" \
    -X POST "$API/$1" --data "$(jq -nc --argjson j "$2" '{json: $j}')" | jq '.result.data.json'
}

compose_one() { trpc_get compose.one "$(jq -nc --arg id "$DOKPLOY_COMPOSE_ID" '{composeId: $id}')"; }

set_line() { # file name value — replace NAME=… or append
  local file="$1" name="$2" value="$3"
  [[ "$value" =~ ^[A-Za-z0-9._/:@-]+$ ]] || { echo "refusing suspicious value for $name" >&2; exit 1; }
  if grep -q "^$name=" "$file"; then
    sed -i "s|^$name=.*|$name=$value|" "$file"
  else
    printf '%s=%s\n' "$name" "$value" >>"$file"
  fi
}

save_env() { # file
  trpc_post compose.saveEnvironment "$(jq -nc --arg id "$DOKPLOY_COMPOSE_ID" --rawfile env "$1" '{composeId: $id, env: $env}')" >/dev/null
}

deploy_and_wait() { # title
  local title="$1" status="" i
  trpc_post compose.deploy "$(jq -nc --arg id "$DOKPLOY_COMPOSE_ID" --arg t "$title" \
    '{composeId: $id, title: $t, description: "deploy/scripts/cd-deploy.sh"}')" >/dev/null
  echo "deploy \"$title\" triggered"
  for i in $(seq 1 90); do
    sleep 10
    status="$(compose_one | jq -r --arg t "$title" '[.deployments[] | select(.title==$t)] | sort_by(.createdAt) | last | .status // "queued"')"
    case "$status" in
      done) echo "deployment done"; return 0 ;;
      error) echo "deployment failed (see Dokploy → compose → Deployments)" >&2; return 1 ;;
      *) [[ $((i % 6)) -eq 0 ]] && echo "  … $status" ;;
    esac
  done
  echo "deployment did not finish within 15 min (last status: $status)" >&2
  return 1
}

smoke() {
  local urls=("https://app.$BASE_DOMAIN/api/health" "https://api.$BASE_DOMAIN/api/health") u i ok
  # shellcheck disable=SC2206
  urls+=(${SMOKE_EXTRA:-})
  for u in "${urls[@]}"; do
    ok=0
    for i in $(seq 1 18); do
      if curl -fsS --max-time 10 "$u" >/dev/null; then ok=1; break; fi
      sleep 10
    done
    if [[ $ok -eq 1 ]]; then echo "✔ $u"; else echo "✖ $u" >&2; return 1; fi
  done
}

compose_one | jq -r '.env // ""' >"$WORK/previous.env"
[[ -s "$WORK/previous.env" ]] || { echo "compose env is empty — run deploy/bootstrap.sh first" >&2; exit 1; }
cp "$WORK/previous.env" "$WORK/next.env"
changed=()
for name in IMAGE_REGISTRY WEB_TAG CADDY_TAG EIT_TAG; do
  if [[ -n "${!name:-}" ]]; then
    set_line "$WORK/next.env" "$name" "${!name}"
    changed+=("$name=${!name}")
  fi
done
[[ ${#changed[@]} -gt 0 ]] || { echo "no tags given (WEB_TAG/CADDY_TAG/EIT_TAG)" >&2; exit 1; }
echo "compose $DOKPLOY_COMPOSE_ID: ${changed[*]}"
echo "previous: $(grep -E '^(WEB|CADDY|EIT)_TAG=' "$WORK/previous.env" | tr '\n' ' ')"

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  echo "(DRY_RUN=1) not saving/deploying"
  exit 0
fi

save_env "$WORK/next.env"
if deploy_and_wait "$TITLE" && smoke; then
  echo "✔ deployed"
  exit 0
fi

echo "✖ deploy or smoke failed → rolling back to the previous tags" >&2
save_env "$WORK/previous.env"
if deploy_and_wait "rollback: $TITLE" && smoke; then
  echo "rolled back successfully" >&2
else
  echo "ROLLBACK FAILED — manual intervention needed (Dokploy UI)" >&2
fi
exit 1

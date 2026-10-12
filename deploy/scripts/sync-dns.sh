#!/usr/bin/env bash
# Upserts the Cloudflare DNS records of all app hosts → TailVIP of the caddy Tailscale Service (08 §3.3).
# "DNS only" (never proxied): the addresses are tailnet-internal (100.x / fd7a:), off-tailnet clients just time out.
#
# Usage: CLOUDFLARE_DNS_API_TOKEN=… deploy/scripts/sync-dns.sh [--dry-run|--apply] <BASE_DOMAIN> <IPv4> [<IPv6>]
#        TailVIP lookup: dig +short <caddy-service-fqdn> @100.100.100.100 (from a tailnet machine)
# Dry-run (default) only reads; --apply creates/updates records. Runbook: dns-tailvip-changed (re-run this).
set -euo pipefail

APPLY=0
case "${1:-}" in
  --apply) APPLY=1; shift ;;
  --dry-run) shift ;;
esac
BASE_DOMAIN="${1:?usage: sync-dns.sh [--dry-run|--apply] BASE_DOMAIN IPV4 [IPV6]}"
IPV4="${2:?IPv4 TailVIP required}"
IPV6="${3:-}"
: "${CLOUDFLARE_DNS_API_TOKEN:?CLOUDFLARE_DNS_API_TOKEN required (Zone → DNS → Edit)}"
HOSTS=(app api convex convex-site convex-dash)
API="https://api.cloudflare.com/client/v4"

cf() { # method path [json]
  local method="$1" path="$2" body="${3:-}"
  local args=(-fsS -X "$method" -H "Authorization: Bearer $CLOUDFLARE_DNS_API_TOKEN" -H "Content-Type: application/json")
  [[ -n "$body" ]] && args+=(--data "$body")
  curl "${args[@]}" "$API$path"
}

if [[ "$IPV4" == "<"* ]]; then
  echo "  (dry-run) TailVIP not known yet → would upsert ${HOSTS[*]} .$BASE_DOMAIN A/AAAA → caddy Service TailVIP"
  exit 0
fi
[[ "$IPV4" =~ ^100\.([0-9]{1,3}\.){2}[0-9]{1,3}$ ]] || { echo "IPv4 $IPV4 is not a tailnet (100.x) address" >&2; exit 1; }
[[ -z "$IPV6" || "$IPV6" == fd7a:* ]] || { echo "IPv6 $IPV6 is not a tailnet (fd7a:) address" >&2; exit 1; }

# Zone = longest suffix of BASE_DOMAIN that is a Cloudflare zone visible to the token.
ZONE_ID=""
candidate="$BASE_DOMAIN"
while [[ "$candidate" == *.* ]]; do
  ZONE_ID="$(cf GET "/zones?name=$candidate" | jq -r '.result[0].id // empty')"
  [[ -n "$ZONE_ID" ]] && break
  candidate="${candidate#*.}"
done
[[ -n "$ZONE_ID" ]] || { echo "no Cloudflare zone found for $BASE_DOMAIN (token scope?)" >&2; exit 1; }
echo "  zone $candidate ($ZONE_ID)"

upsert() { # type name content
  local type="$1" name="$2" content="$3" existing id current body
  existing="$(cf GET "/zones/$ZONE_ID/dns_records?type=$type&name=$name")"
  id="$(jq -r '.result[0].id // empty' <<<"$existing")"
  current="$(jq -r '.result[0].content // empty' <<<"$existing")"
  body="$(jq -nc --arg t "$type" --arg n "$name" --arg c "$content" \
    '{type: $t, name: $n, content: $c, ttl: 300, proxied: false, comment: "rechnungen caddy Tailscale Service (deploy/scripts/sync-dns.sh)"}')"
  if [[ -n "$id" && "$current" == "$content" ]]; then
    echo "  ✔ $type $name = $content"
  elif [[ $APPLY -eq 0 ]]; then
    echo "  (dry-run) would $([[ -n "$id" ]] && echo "update $current →" || echo create) $type $name = $content"
  elif [[ -n "$id" ]]; then
    cf PUT "/zones/$ZONE_ID/dns_records/$id" "$body" >/dev/null && echo "  ↻ $type $name: $current → $content"
  else
    cf POST "/zones/$ZONE_ID/dns_records" "$body" >/dev/null && echo "  + $type $name = $content"
  fi
}

for h in "${HOSTS[@]}"; do
  upsert A "$h.$BASE_DOMAIN" "$IPV4"
  if [[ -n "$IPV6" ]]; then upsert AAAA "$h.$BASE_DOMAIN" "$IPV6"; fi
done

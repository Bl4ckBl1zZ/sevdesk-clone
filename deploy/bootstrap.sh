#!/usr/bin/env bash
# Idempotent Dokploy bootstrap for the rechnungen stack (08 §5) using OUR generated Dokploy CLI
# (deploy/scripts/build-dokploy-cli.sh). Every command and flag below was checked against
# `dokploy <group> <command> --help` of the CLI generated from the live server (v0.41.1) — see
# docs/adr/0003-dokploy-bootstrap.md for the table.
#
# DRY-RUN BY DEFAULT: read-only lookups run, every mutating command is only PRINTED (secrets redacted).
# Pass --apply to execute. Nothing here confirms the Tailscale retag — that is deploy/scripts/tailscale-retag.sh.
#
# Usage:
#   deploy/bootstrap.sh [--apply] [--env-file .env.production] [--instance-name rechnungen-pilot]
#                       [--only steps] [--skip steps] [--install-server-scripts]
# Edge mode (env file EDGE_MODE): `tailnet` (default, 08 §1) = Tailscale Service + Caddy TLS; `public` (08 §12, owner
# decision 2026-10-18) = Dokploy domains on the server's Cloudflare tunnel → Traefik → caddy:80.
# Steps (default: all, in this order):
#   preflight  CLI + fork procedures present, server found; tailnet: Tailscale gateway adopted/ready (abort otherwise);
#              public: Cloudflare tunnel of the server healthy, zone id of CLOUDFLARE_ZONE_NAME
#   project    project "rechnungen" + environment "production"
#   compose    compose "rechnungen" on "Proxmox PVE", raw source = deploy/compose/docker-compose.yml
#              (public: deploy/compose/docker-compose.public.yml)
#   domains    public only: one Dokploy domain per host (app./api./convex./convex-site./convex-dash.) → caddy:80,
#              https off (Cloudflare terminates TLS), --cloudflareZoneId → DNS record on the tunnel
#   registry   registry credentials on the server (docker login for private images)
#   env        compose environment (08 §5.2) from the env file
#   deploy     compose deploy; tailnet: wait for the caddy Tailscale Service, resolve its TailVIP
#   dns        tailnet: deploy/scripts/sync-dns.sh → A/AAAA records → TailVIP; both: wait for https://app.<BASE_DOMAIN>/api/health
#   convex     npx convex deploy + Convex function env (needs CONVEX_SELF_HOSTED_ADMIN_KEY)
#   backups    Dokploy compose backup (postgres) + volume backup (convex-data) + server schedules → R2 destination
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT/deploy/compose/docker-compose.yml"
ALL_STEPS=(preflight project compose domains registry env deploy dns convex backups)

APPLY=0
ENV_FILE="$ROOT/.env.production"
ONLY=""
SKIP=""
INSTANCE_OVERRIDE=""
INSTALL_SERVER_SCRIPTS=0

usage() { sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --dry-run) APPLY=0 ;;
    --env-file) ENV_FILE="$2"; shift ;;
    --instance-name) INSTANCE_OVERRIDE="$2"; shift ;;
    --pilot) INSTANCE_OVERRIDE="rechnungen-pilot" ;;
    --only) ONLY="$2"; shift ;;
    --skip) SKIP="$2"; shift ;;
    --install-server-scripts) INSTALL_SERVER_SCRIPTS=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

# ── output helpers ────────────────────────────────────────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then B=$'\e[1m'; Y=$'\e[33m'; R=$'\e[31m'; G=$'\e[32m'; N=$'\e[0m'; else B=""; Y=""; R=""; G=""; N=""; fi
step() { echo; echo "${B}━━ $* ${N}"; }
info() { echo "  $*"; }
warn() { echo "  ${Y}⚠ $*${N}" >&2; }
die() { echo "  ${R}✖ $*${N}" >&2; exit 1; }
ok() { echo "  ${G}✔ $*${N}"; }

# Flags whose values are secret or bulky; printed redacted.
REDACT_FLAGS=" --password --env --composeFile --oauthClientSecret "

print_cmd() {
  local out="" redact_next=0 a
  for a in "$@"; do
    if [[ $redact_next -eq 1 ]]; then
      out+=" '<redacted ${#a} chars>'"
      redact_next=0
    else
      out+=" $(printf '%q' "$a")"
      [[ "$REDACT_FLAGS" == *" $a "* ]] && redact_next=1
    fi
  done
  echo "  ${B}\$${N}${out}" >&2   # stderr: stdout of mutate() is the command's JSON
}

# mutate <cmd…>: print; execute only with --apply. Prints stdout of the command (JSON with --json).
mutate() {
  print_cmd "$@"
  if [[ $APPLY -eq 1 ]]; then "$@"; else echo "    (dry-run: not executed)" >&2; return 0; fi
}

# query <cmd…>: read-only, always executed.
query() { "$@"; }

want() {
  local s="$1"
  if [[ -n "$ONLY" && ",$ONLY," != *",$s,"* ]]; then return 1; fi
  if [[ -n "$SKIP" && ",$SKIP," == *",$s,"* ]]; then return 1; fi
  return 0
}

need() { command -v "$1" >/dev/null 2>&1 || die "missing tool: $1"; }

# ── inputs ────────────────────────────────────────────────────────────────────────────────────────────────────────
load_env() {
  [[ -f "$ENV_FILE" ]] || die "env file $ENV_FILE not found — cp deploy/env/production.example .env.production"
  if [[ "$(stat -c %a "$ENV_FILE" 2>/dev/null || stat -f %Lp "$ENV_FILE")" != "600" ]]; then
    warn "$ENV_FILE should be chmod 600"
  fi
  if git -C "$ROOT" ls-files --error-unmatch "$ENV_FILE" >/dev/null 2>&1; then
    die "$ENV_FILE is tracked by git — remove it from the repository first"
  fi
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  : "${DOKPLOY_PROJECT:=rechnungen}" "${DOKPLOY_ENVIRONMENT:=production}" "${DOKPLOY_SERVER_NAME:=Proxmox PVE}"
  : "${COMPOSE_NAME:=rechnungen}" "${R2_DESTINATION_NAME:=Cloudflare R2 (dokploy)}" "${LOG_LEVEL:=info}"
  : "${CONVEX_SHA:=72ce13c379fe6dbdfc305bc8ad699c5663c68c2a}"
  : "${EDGE_MODE:=tailnet}" "${CLOUDFLARE_ZONE_NAME:=${BASE_DOMAIN:-}}"
  [[ "$EDGE_MODE" == "tailnet" || "$EDGE_MODE" == "public" ]] || die "EDGE_MODE must be tailnet or public (got $EDGE_MODE)"
  if [[ "$EDGE_MODE" == "public" ]]; then
    COMPOSE_FILE="$ROOT/deploy/compose/docker-compose.public.yml"
    # The public Caddy has no ACME / DNS-01 (Cloudflare terminates TLS, 08 §12).
    COMPOSE_ENV_VARS=("${COMPOSE_ENV_VARS[@]/ACME_EMAIL/}")
    COMPOSE_ENV_VARS=("${COMPOSE_ENV_VARS[@]/CLOUDFLARE_DNS_API_TOKEN/}")
    local v kept=()
    for v in "${COMPOSE_ENV_VARS[@]}"; do [[ -n "$v" ]] && kept+=("$v"); done
    COMPOSE_ENV_VARS=("${kept[@]}")
  fi
  if [[ -n "$INSTANCE_OVERRIDE" ]]; then INSTANCE_NAME="$INSTANCE_OVERRIDE"; fi
  : "${INSTANCE_NAME:=rechnungen-pilot}"
  PG_DATABASE="${INSTANCE_NAME//-/_}"
}

require_vars() {
  local missing=() v
  for v in "$@"; do [[ -n "${!v:-}" ]] || missing+=("$v"); done
  [[ ${#missing[@]} -eq 0 ]] || die "missing in $ENV_FILE: ${missing[*]}"
}

# Dokploy writes the env verbatim to .env next to the compose file; compose interpolates `$` in unquoted and
# double-quoted values, so values containing `$` are single-quoted and PEMs become "\n"-escaped one-liners.
env_line() {
  local name="$1" value="${!1:-}"
  if [[ "$value" == *$'\n'* ]]; then
    value="${value//$'\n'/\\n}"
    printf '%s="%s"\n' "$name" "$value"
  elif [[ "$value" == *'$'* || "$value" == *' '* || "$value" == *'#'* ]]; then
    [[ "$value" != *"'"* ]] || die "$name contains both \$ and a single quote; not representable"
    printf "%s='%s'\n" "$name" "$value"
  else
    printf '%s=%s\n' "$name" "$value"
  fi
}

COMPOSE_ENV_VARS=(IMAGE_REGISTRY BASE_DOMAIN ACME_EMAIL CLOUDFLARE_DNS_API_TOKEN CONVEX_DASH_BASIC_AUTH CADDY_TAG WEB_TAG
  EIT_TAG CONVEX_SHA INSTANCE_NAME INSTANCE_SECRET PG_PASSWORD JWT_PRIVATE_KEY_PEM APP_ENCRYPTION_KEY LOG_LEVEL)

compose_env() {
  local v
  echo "# managed by deploy/bootstrap.sh — CI updates only the *_TAG lines (deploy/scripts/cd-deploy.sh)"
  for v in "${COMPOSE_ENV_VARS[@]}"; do env_line "$v"; done
}

# ── lookups (read-only) ───────────────────────────────────────────────────────────────────────────────────────────
SERVER_ID=""; SERVER_IP=""; PROJECT_ID=""; ENV_ID=""; CMP_ID=""; CMP_APPNAME=""; DEST_ID=""; ZONE_ID=""
CADDY_FQDN=""; CADDY_TAILVIP4=""; CADDY_TAILVIP6=""

lookup_server() {
  local json
  json="$(query dokploy server all --json)"
  SERVER_ID="$(jq -r --arg n "$DOKPLOY_SERVER_NAME" '.[] | select(.name==$n) | .serverId' <<<"$json")"
  SERVER_IP="$(jq -r --arg n "$DOKPLOY_SERVER_NAME" '.[] | select(.name==$n) | .ipAddress' <<<"$json")"
  [[ -n "$SERVER_ID" ]] || die "Dokploy server \"$DOKPLOY_SERVER_NAME\" not found"
}

lookup_project() {
  local json
  json="$(query dokploy project all --json)"
  PROJECT_ID="$(jq -r --arg p "$DOKPLOY_PROJECT" '.[] | select(.name==$p) | .projectId' <<<"$json")"
  ENV_ID="$(jq -r --arg p "$DOKPLOY_PROJECT" --arg e "$DOKPLOY_ENVIRONMENT" \
    '.[] | select(.name==$p) | .environments[] | select(.name==$e) | .environmentId' <<<"$json")"
  CMP_ID="$(jq -r --arg p "$DOKPLOY_PROJECT" --arg e "$DOKPLOY_ENVIRONMENT" --arg c "$COMPOSE_NAME" \
    '.[] | select(.name==$p) | .environments[] | select(.name==$e) | .compose[] | select(.name==$c) | .composeId' <<<"$json")"
  if [[ -n "$CMP_ID" ]]; then
    CMP_APPNAME="$(query dokploy compose one --composeId "$CMP_ID" --json | jq -r '.appName')"
  fi
}

lookup_destination() {
  DEST_ID="$(query dokploy destination all --json \
    | jq -r --arg n "$R2_DESTINATION_NAME" '.[] | select(.name==$n) | .destinationId')"
  [[ -n "$DEST_ID" ]] || die "Dokploy destination \"$R2_DESTINATION_NAME\" not found (dokploy destination all)"
}

lookup_zone() {
  # Only the zone list is read; the config's token fields are never printed (jq selects zone ids only).
  ZONE_ID="$(query dokploy cloudflare get-config --json \
    | jq -r --arg z "$CLOUDFLARE_ZONE_NAME" '[.zones[]? | select(.zoneName==$z) | .cloudflareZoneId][0] // empty')"
  [[ -n "$ZONE_ID" ]] || die "Cloudflare zone \"$CLOUDFLARE_ZONE_NAME\" not found in the Dokploy Cloudflare config (dokploy cloudflare get-config)"
}

# Hosts behind the edge (02 §4.1); public mode creates one Dokploy domain each.
EDGE_HOSTS=(app api convex convex-site convex-dash)

# ── steps ─────────────────────────────────────────────────────────────────────────────────────────────────────────
do_preflight() {
  step "preflight"
  need dokploy; need jq; need curl; need openssl
  if [[ "$EDGE_MODE" == "public" ]]; then
    dokploy cloudflare --help >/dev/null 2>&1 || die "this dokploy CLI lacks the fork procedures (cloudflare.*) — run deploy/scripts/build-dokploy-cli.sh"
  else
    dokploy tailscale --help >/dev/null 2>&1 || die "this dokploy CLI lacks the fork procedures (tailscale.*) — run deploy/scripts/build-dokploy-cli.sh"
  fi
  local version
  version="$(query dokploy settings get-dokploy-version --json | jq -r '.')"
  info "Dokploy server $version, CLI $(dokploy --version)"
  [[ "$version" == "0.41.1" ]] || warn "bootstrap was verified against Dokploy fork v0.41.1 — re-check flags (ADR 0003)"
  lookup_server
  info "server \"$DOKPLOY_SERVER_NAME\" = $SERVER_ID ($SERVER_IP) · edge mode $EDGE_MODE"
  if [[ "$EDGE_MODE" == "public" ]]; then
    preflight_public
  else
    preflight_tailnet
  fi
  lookup_destination
  info "R2 destination \"$R2_DESTINATION_NAME\" = $DEST_ID"
  [[ "$INSTANCE_NAME" == "rechnungen" ]] || warn "INSTANCE_NAME=$INSTANCE_NAME (pilot, 08 §8.1); go-live: deploy/runbooks/go-live.md"
}

preflight_public() {
  local tunnel
  tunnel="$(query dokploy server one --serverId "$SERVER_ID" --json | jq -r '.tunnelStatus // "none"')"
  if [[ "$tunnel" != "healthy" ]]; then
    local msg="Cloudflare tunnel of \"$DOKPLOY_SERVER_NAME\" is not healthy (tunnelStatus=$tunnel) — the Dokploy domains would not be reachable (08 §12)"
    if [[ $APPLY -eq 1 ]]; then die "$msg"; else warn "$msg (dry-run continues)"; fi
  else
    ok "Cloudflare tunnel of \"$DOKPLOY_SERVER_NAME\" healthy"
  fi
  lookup_zone
  info "cloudflare zone $CLOUDFLARE_ZONE_NAME = $ZONE_ID"
  # Cloudflare Universal SSL covers <zone> and *.<zone> only; app.<BASE_DOMAIN> must be one level below the zone.
  [[ "$BASE_DOMAIN" == "$CLOUDFLARE_ZONE_NAME" ]] ||
    warn "BASE_DOMAIN=$BASE_DOMAIN is below the zone $CLOUDFLARE_ZONE_NAME — app.$BASE_DOMAIN needs an Advanced Certificate (Universal SSL covers *.$CLOUDFLARE_ZONE_NAME only)"
}

preflight_tailnet() {
  local gw ownership status
  gw="$(query dokploy tailscale list --json | jq -c --arg s "$SERVER_ID" \
    '[.gateways[] | select(.serverId==$s) | {id: .tailscaleGatewayId, ownership, status, lastError}][0] // empty')"
  [[ -n "$gw" ]] || die "no Tailscale gateway for $DOKPLOY_SERVER_NAME (dokploy tailscale list)"
  ownership="$(jq -r .ownership <<<"$gw")"; status="$(jq -r .status <<<"$gw")"
  info "tailscale gateway $(jq -r .id <<<"$gw"): ownership=$ownership status=$status"
  if [[ "$ownership" == "pending_retag" || ! "$ownership" =~ ^(adopted|managed)$ || "$status" != "ready" ]]; then
    local msg="gateway is not adopted/managed+ready — Tailscale Services cannot be published yet. Follow 08 §2.1: deploy/scripts/tailscale-retag.sh"
    if [[ $APPLY -eq 1 ]]; then die "$msg"; else warn "$msg (dry-run continues)"; fi
  else
    ok "gateway ready"
  fi
}

do_project() {
  step "project + environment"
  lookup_project
  if [[ -z "$PROJECT_ID" ]]; then
    local out
    out="$(mutate dokploy project create --name "$DOKPLOY_PROJECT" --description "Rechnungen & Buchhaltung" --json)"
    if [[ $APPLY -eq 1 ]]; then
      PROJECT_ID="$(jq -r '.project.projectId // .projectId' <<<"$out")"
      lookup_project
    else
      PROJECT_ID="<PROJECT_ID>"
    fi
  else
    ok "project $DOKPLOY_PROJECT exists ($PROJECT_ID)"
  fi
  if [[ -z "$ENV_ID" ]]; then
    mutate dokploy environment create --name "$DOKPLOY_ENVIRONMENT" --projectId "$PROJECT_ID" --json >/dev/null
    if [[ $APPLY -eq 1 ]]; then lookup_project; else ENV_ID="<ENVIRONMENT_ID>"; fi
  else
    ok "environment $DOKPLOY_ENVIRONMENT exists ($ENV_ID)"
  fi
}

do_compose() {
  step "compose $COMPOSE_NAME (raw source)"
  [[ -n "$ENV_ID" ]] || lookup_project
  [[ -n "$SERVER_ID" ]] || lookup_server
  info "compose file ${COMPOSE_FILE#"$ROOT/"}"
  (cd "$ROOT" && pnpm -s lint:deploy) || die "${COMPOSE_FILE#"$ROOT/"} fails lint:deploy"
  if [[ -z "$CMP_ID" ]]; then
    local out
    # `compose create` has no --sourceType in this CLI; the raw source is set by `compose update` below.
    out="$(mutate dokploy compose create --name "$COMPOSE_NAME" --environmentId "$ENV_ID" --serverId "$SERVER_ID" \
      --composeType docker-compose --appName "$COMPOSE_NAME" \
      --description "App stack: caddy, web, backend, dashboard, postgres, einvoice-tools (08 §3.1)" --json)"
    if [[ $APPLY -eq 1 ]]; then
      CMP_ID="$(jq -r '.composeId' <<<"$out")"
      CMP_APPNAME="$(jq -r '.appName' <<<"$out")"
    else
      CMP_ID="<COMPOSE_ID>"; CMP_APPNAME="<APP_NAME>"
    fi
  else
    ok "compose exists ($CMP_ID, appName $CMP_APPNAME)"
  fi
  mutate dokploy compose update --composeId "$CMP_ID" --sourceType raw --composeType docker-compose \
    --composeFile "$(cat "$COMPOSE_FILE")" --json >/dev/null
}

do_domains() {
  [[ "$EDGE_MODE" == "public" ]] || return 0
  step "Dokploy domains → caddy:80 (public edge, 08 §12)"
  [[ -n "$CMP_ID" ]] || lookup_project
  [[ -n "$ZONE_ID" ]] || lookup_zone
  local existing="" host
  if [[ -n "$CMP_ID" && "$CMP_ID" != "<"* ]]; then
    existing="$(query dokploy compose one --composeId "$CMP_ID" --json | jq -r '(.domains // [])[].host')"
  fi
  [[ -n "$CMP_ID" ]] || CMP_ID="<COMPOSE_ID>"
  for host in "${EDGE_HOSTS[@]}"; do
    host="$host.$BASE_DOMAIN"
    if grep -qxF "$host" <<<"$existing"; then
      ok "domain $host exists"
      continue
    fi
    # https off + certificateType none: Cloudflare terminates TLS; the zone id makes the fork create the DNS record.
    mutate dokploy domain create --host "$host" --path / --port 80 --serviceName caddy --domainType compose \
      --composeId "$CMP_ID" --certificateType none --cloudflareZoneId "$ZONE_ID" --json >/dev/null
  done
}

do_registry() {
  step "registry credentials on the server"
  require_vars IMAGE_REGISTRY
  local host="${IMAGE_REGISTRY%%/*}" prefix="${IMAGE_REGISTRY#*/}"
  [[ "$prefix" != "$IMAGE_REGISTRY" ]] || prefix=""
  if [[ -z "${REGISTRY_USERNAME:-}" ]]; then
    info "REGISTRY_USERNAME empty → assuming public images on $host; skipping"
    return
  fi
  [[ -n "$SERVER_ID" ]] || lookup_server
  local existing
  existing="$(query dokploy registry all --json | jq -r --arg u "$host" --arg s "$SERVER_ID" \
    '.[] | select(.registryUrl==$u and (.serverId==$s or .serverId==null)) | .registryId' | head -n1)"
  if [[ -n "$existing" ]]; then
    ok "registry $host already configured ($existing)"
    return
  fi
  # Dokploy runs `docker login` on the server for registries (needed to pull the private images). UNSURE whether
  # compose pulls use it in every case — if a deploy fails with "unauthorized", docker login on the server manually.
  mutate dokploy registry create --registryName "rechnungen-$host" --username "$REGISTRY_USERNAME" \
    --password "${REGISTRY_PASSWORD:?REGISTRY_PASSWORD missing}" --registryUrl "$host" --registryType cloud \
    --imagePrefix "$prefix" --serverId "$SERVER_ID" --json >/dev/null
}

do_env() {
  step "compose environment (08 §5.2)"
  require_vars "${COMPOSE_ENV_VARS[@]}"
  [[ "$INSTANCE_SECRET" =~ ^[0-9a-f]{64}$ ]] || die "INSTANCE_SECRET must be 64 hex chars (openssl rand -hex 32)"
  # shellcheck disable=SC2016  # literal "$2" prefix of bcrypt hashes
  [[ "$CONVEX_DASH_BASIC_AUTH" == '$2'* ]] || die "CONVEX_DASH_BASIC_AUTH must be a bcrypt hash (caddy hash-password)"
  [[ "$JWT_PRIVATE_KEY_PEM" == *"PRIVATE KEY"* ]] || die "JWT_PRIVATE_KEY_PEM is not a PEM private key"
  [[ -n "$CMP_ID" ]] || lookup_project
  [[ -n "$CMP_ID" ]] || CMP_ID="<COMPOSE_ID>"
  info "variables: ${COMPOSE_ENV_VARS[*]}"
  mutate dokploy compose save-environment --composeId "$CMP_ID" --env "$(compose_env)" --json >/dev/null
}

wait_for_caddy_service() {
  local json
  for _ in $(seq 1 60); do
    json="$(query dokploy tailscale list --json | jq -c --arg k "compose:$CMP_ID:caddy" \
      '[.endpoints[] | select(.ownerKey==$k) | {serviceName, fqdn, status, warning, lastError}][0] // empty')"
    if [[ -n "$json" ]]; then
      info "caddy endpoint: $(jq -r '"\(.serviceName) \(.status) \(.warning // "") \(.lastError // "")"' <<<"$json")"
      if [[ "$(jq -r .status <<<"$json")" == "ready" ]]; then
        CADDY_FQDN="$(jq -r .fqdn <<<"$json")"
        return 0
      fi
    fi
    sleep 10
  done
  die "caddy Tailscale Service not ready after 10 min (dokploy tailscale list)"
}

resolve_tailvip() {
  # The generated CLI exposes the Service FQDN but not its TailVIP (spike 2, ADR 0003) → ask MagicDNS.
  local fqdn="$1"
  if command -v dig >/dev/null 2>&1; then
    CADDY_TAILVIP4="$(dig +short A "$fqdn" @100.100.100.100 | head -n1)"
    CADDY_TAILVIP6="$(dig +short AAAA "$fqdn" @100.100.100.100 | head -n1)"
  else
    CADDY_TAILVIP4="$(getent ahostsv4 "$fqdn" | awk 'NR==1{print $1}')"
    CADDY_TAILVIP6="$(getent ahostsv6 "$fqdn" | awk 'NR==1{print $1}')"
  fi
  [[ -n "$CADDY_TAILVIP4" ]] || die "could not resolve $fqdn via MagicDNS — is this machine on the tailnet (Linux ≤1.93: --accept-routes)?"
}

do_deploy() {
  step "deploy"
  [[ -n "$CMP_ID" ]] || lookup_project
  [[ -n "$CMP_ID" ]] || CMP_ID="<COMPOSE_ID>"
  mutate dokploy compose deploy --composeId "$CMP_ID" --title "bootstrap" \
    --description "deploy/bootstrap.sh $(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo)" --json >/dev/null
  if [[ "$EDGE_MODE" == "public" ]]; then
    info "public edge: Traefik routes the Dokploy domains to caddy:80; no Tailscale Service to wait for"
    return
  fi
  if [[ $APPLY -eq 0 ]]; then
    info "(dry-run) would wait for endpoint ownerKey=compose:$CMP_ID:caddy to become ready and resolve its TailVIP"
    return
  fi
  wait_for_caddy_service
  resolve_tailvip "$CADDY_FQDN"
  ok "caddy Service $CADDY_FQDN → $CADDY_TAILVIP4 ${CADDY_TAILVIP6}"
  info "next: add the <CADDY_SVC> grants to the tailnet policy (deploy/tailnet-policy.hujson)"
}

wait_for_health() {
  for _ in $(seq 1 60); do
    if curl -fsS --max-time 10 "https://app.$BASE_DOMAIN/api/health" >/dev/null 2>&1; then
      ok "https://app.$BASE_DOMAIN/api/health"
      return
    fi
    sleep 10
  done
  die "https://app.$BASE_DOMAIN/api/health not reachable ($1)"
}

do_dns() {
  if [[ "$EDGE_MODE" == "public" ]]; then
    step "DNS (public edge: records come from the Dokploy domains)"
    if [[ $APPLY -eq 1 ]]; then
      wait_for_health "Dokploy domain sync status? Traefik labels? docker logs caddy"
    else
      info "(dry-run) would wait for https://app.$BASE_DOMAIN/api/health"
    fi
    return
  fi
  step "DNS → TailVIP"
  require_vars BASE_DOMAIN CLOUDFLARE_DNS_API_TOKEN
  if [[ -z "$CADDY_TAILVIP4" ]]; then
    if [[ $APPLY -eq 1 ]]; then
      [[ -n "$CMP_ID" ]] || lookup_project
      wait_for_caddy_service
      resolve_tailvip "$CADDY_FQDN"
    else
      CADDY_TAILVIP4="<TAILVIP4>"; CADDY_TAILVIP6="<TAILVIP6>"
    fi
  fi
  local flag="--dry-run"
  [[ $APPLY -eq 1 ]] && flag="--apply"
  CLOUDFLARE_DNS_API_TOKEN="$CLOUDFLARE_DNS_API_TOKEN" \
    "$ROOT/deploy/scripts/sync-dns.sh" "$flag" "$BASE_DOMAIN" "$CADDY_TAILVIP4" "${CADDY_TAILVIP6:-}"
  if [[ $APPLY -eq 1 ]]; then wait_for_health "certificate issuance? grants? docker logs caddy"; fi
}

server_jwks() {
  # Public JWK of JWT_PRIVATE_KEY_PEM as a JWKS JSON document for the Convex customJwt provider (02 §4.4);
  # convex/auth.config.ts turns it into the data: URI itself. kid = RFC 7638 thumbprint (same as
  # scripts/generate-jwks.ts es256KeyPair → the web server JWT signer).
  JWT_PRIVATE_KEY_PEM="$JWT_PRIVATE_KEY_PEM" node --input-type=module -e '
    import { createPrivateKey, createPublicKey, createHash } from "node:crypto";
    const jwk = createPublicKey(createPrivateKey(process.env.JWT_PRIVATE_KEY_PEM)).export({ format: "jwk" });
    const kid = createHash("sha256").update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest("base64url");
    process.stdout.write(JSON.stringify({ keys: [{ ...jwk, kid, alg: "ES256", use: "sig" }] }));
  '
}

convex_env_set() { # name value
  local name="$1" value="$2"
  echo "  ${B}\$${N} npx convex env set $name <redacted ${#value} chars>" >&2
  # `pnpm exec` (not the `convex` script: pnpm would echo the command line incl. the value); `--` because PEM values
  # start with "-----" and would be parsed as an option. Output is dropped so values never reach the terminal.
  if [[ $APPLY -eq 1 ]]; then
    (cd "$ROOT" && pnpm exec convex env set -- "$name" "$value" >/dev/null 2>&1) || die "convex env set $name failed"
  fi
}

do_convex() {
  step "Convex functions + env (08 §5 step 5)"
  require_vars BASE_DOMAIN OWNER_EMAIL
  if [[ -z "${CONVEX_SELF_HOSTED_ADMIN_KEY:-}" ]]; then
    warn "CONVEX_SELF_HOSTED_ADMIN_KEY is empty. Generate it once in the backend container (Dokploy → compose"
    warn "rechnungen → backend → Terminal: ./generate_admin_key.sh), store it in $ENV_FILE and in the CI secret"
    warn "CONVEX_SELF_HOSTED_ADMIN_KEY, then re-run: deploy/bootstrap.sh --apply --only convex"
    return
  fi
  unset CONVEX_DEPLOYMENT   # never mixed with CONVEX_SELF_HOSTED_* (08 §10)
  export CONVEX_SELF_HOSTED_URL="https://convex.$BASE_DOMAIN" CONVEX_SELF_HOSTED_ADMIN_KEY
  # Env first: auth.config.ts reads SERVER_JWKS at push time, so `convex deploy` fails without it.
  convex_env_set SITE_URL "https://app.$BASE_DOMAIN"
  convex_env_set BASE_DOMAIN "$BASE_DOMAIN"
  convex_env_set PASSKEY_RP_ID "$BASE_DOMAIN"
  convex_env_set OWNER_EMAIL "$OWNER_EMAIL"
  convex_env_set EINVOICE_TOOLS_URL "http://einvoice-tools:8080"
  [[ -z "${JWT_PRIVATE_KEY_PEM:-}" ]] || convex_env_set SERVER_JWKS "$(server_jwks)"
  # Audit-chain genesis name (AUD-004): only for data migrated from another installation, whose chain starts at
  # SHA-256("genesis:<its INSTANCE_NAME>"); it must never change afterwards. Unset → the Convex default "rechnungen".
  [[ -z "${AUDIT_CHAIN_INSTANCE:-}" ]] || convex_env_set INSTANCE_NAME "$AUDIT_CHAIN_INSTANCE"
  local v
  for v in BETTER_AUTH_SECRET APP_ENCRYPTION_KEY CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_EMAIL_API_TOKEN AUTH_MAIL_FROM \
    R2_ACCOUNT_ENDPOINT R2_CHECKPOINT_BUCKET R2_CHECKPOINT_ACCESS_KEY_ID R2_CHECKPOINT_SECRET_ACCESS_KEY \
    R2_BACKUP_BUCKET R2_BACKUP_READONLY_ACCESS_KEY_ID R2_BACKUP_READONLY_SECRET_ACCESS_KEY CHECKPOINT_SIGNING_KEY_PEM \
    R2_INBOX_BUCKET R2_INBOX_ACCESS_KEY_ID R2_INBOX_SECRET_ACCESS_KEY ENABLE_BANKING_APP_ID ENABLE_BANKING_PRIVATE_KEY_PEM; do
    if [[ -n "${!v:-}" ]]; then convex_env_set "$v" "${!v}"; else info "skip $v (empty)"; fi
  done

  # JWKS (Better Auth, RS256): static key set encrypted with BETTER_AUTH_SECRET (scripts/generate-jwks.ts), set once
  # before the first push — auth.config.ts needs it at push time. Rotating BETTER_AUTH_SECRET needs a new JWKS.
  local jwks_set=0
  if [[ $APPLY -eq 1 ]] && (cd "$ROOT" && pnpm exec convex env get JWKS 2>/dev/null | grep -q .); then jwks_set=1; fi
  if [[ $jwks_set -eq 1 ]]; then
    ok "JWKS already set (rotation: deploy/runbooks/rotate-secrets.md)"
  else
    require_vars BETTER_AUTH_SECRET
    print_cmd BETTER_AUTH_SECRET="<redacted>" pnpm exec tsx scripts/generate-jwks.ts better-auth --set-convex
    if [[ $APPLY -eq 1 ]]; then
      (cd "$ROOT" && BETTER_AUTH_SECRET="$BETTER_AUTH_SECRET" pnpm exec tsx scripts/generate-jwks.ts better-auth --set-convex) \
        || die "JWKS generation failed"
    fi
  fi

  print_cmd npx convex deploy --yes
  if [[ $APPLY -eq 1 ]]; then (cd "$ROOT" && pnpm exec convex deploy --yes); fi

  # BETTER_AUTH_SECRET is only set when given: rotating it signs everyone out (02 §4.5).
}

do_backups() {
  step "backups → R2 destination (08 §7)"
  [[ -n "$DEST_ID" ]] || lookup_destination
  [[ -n "$SERVER_ID" ]] || lookup_server
  [[ -n "$CMP_ID" ]] || lookup_project
  local cmp_json="{}"
  if [[ -n "$CMP_ID" && "$CMP_ID" != "<"* ]]; then cmp_json="$(query dokploy compose one --composeId "$CMP_ID" --json)"; fi
  [[ -n "$CMP_ID" ]] || { CMP_ID="<COMPOSE_ID>"; CMP_APPNAME="<APP_NAME>"; }

  # 1. Postgres (Convex data): compose backup of service `postgres`, database = INSTANCE_NAME with _ (spike 1: the
  #    generated CLI has --backupType compose + --serviceName; --enabled is a switch).
  if jq -e --arg db "$PG_DATABASE" '(.backups // [])[] | select(.serviceName=="postgres" and .database==$db)' \
    <<<"$cmp_json" >/dev/null; then
    ok "postgres backup for database $PG_DATABASE exists"
  else
    mutate dokploy backup create --backupType compose --composeId "$CMP_ID" --serviceName postgres \
      --databaseType postgres --database "$PG_DATABASE" --destinationId "$DEST_ID" --schedule "0 3 * * *" \
      --prefix "postgres/" --keepLatestCount 30 --metadata '{"postgres":{"databaseUser":"convex"}}' --enabled \
      --json >/dev/null   # without metadata.postgres.databaseUser Dokploy's pg_dump call fails
  fi

  # 2. Convex file storage volume, weekly. Volume name = <appName>_convex-data (Dokploy project name prefix).
  local vb="[]"
  if [[ "$CMP_ID" != "<"* ]]; then
    vb="$(query dokploy volume-backups list --id "$CMP_ID" --volumeBackupType compose --json 2>/dev/null || echo '[]')"
  fi
  if jq -e '.[]? | select(.name=="convex-data")' <<<"$vb" >/dev/null; then
    ok "volume backup convex-data exists"
  else
    mutate dokploy volume-backups create --name convex-data --volumeName "${CMP_APPNAME}_convex-data" \
      --composeId "$CMP_ID" --serviceName backend --serviceType compose --prefix "convex-volume/" \
      --cronExpression "30 3 * * 0" --destinationId "$DEST_ID" --keepLatestCount 8 --enabled --json >/dev/null
  fi

  # 3. Server schedules (scripts live in /opt/rechnungen on the server, env in /opt/rechnungen/backup.env).
  local sched
  sched="$(query dokploy schedule list --id "$SERVER_ID" --scheduleType server --json 2>/dev/null || echo '[]')"
  local name cron script
  # log-retention (DSGVO-06: technical logs ≤ 90 days) and ops-check (DSGVO-05/06, SEC-05: deployed-stack checks).
  for spec in "convex-logical-export|0 4 * * *|convex-export.sh" "r2-monthly-copy|0 5 1 * *|r2-monthly-copy.sh" \
    "log-retention|45 3 * * *|log-retention.sh" "ops-check|0 6 * * 1|ops-check.sh all"; do
    IFS='|' read -r name cron script <<<"$spec"
    if jq -e --arg n "$name" '.[]? | select(.name==$n)' <<<"$sched" >/dev/null; then
      ok "schedule $name exists"
    else
      mutate dokploy schedule create --name "$name" --scheduleType server --serverId "$SERVER_ID" \
        --cronExpression "$cron" --timezone "Europe/Berlin" --shellType bash \
        --command "COMPOSE_APPNAME=$CMP_APPNAME /opt/rechnungen/$script" --enabled --json >/dev/null
    fi
  done

  local target="root@$SERVER_IP"
  info "server scripts: deploy/scripts/{convex-export,r2-monthly-copy,log-retention,ops-check}.sh → $target:/opt/rechnungen/ (+ backup.env, 0600)"
  if [[ $INSTALL_SERVER_SCRIPTS -eq 1 ]]; then
    mutate ssh "$target" "install -d -m 0700 /opt/rechnungen"
    mutate scp "$ROOT/deploy/scripts/convex-export.sh" "$ROOT/deploy/scripts/r2-monthly-copy.sh" \
      "$ROOT/deploy/scripts/log-retention.sh" "$ROOT/deploy/scripts/ops-check.sh" "$target:/opt/rechnungen/"
    mutate ssh "$target" "chmod 0700 /opt/rechnungen/*.sh"
    info "create /opt/rechnungen/backup.env by hand (CONVEX_SELF_HOSTED_ADMIN_KEY, R2_* writer keys) — never via this script's output"
  else
    info "(pass --install-server-scripts to copy them via ssh/scp)"
  fi
}

# ── main ──────────────────────────────────────────────────────────────────────────────────────────────────────────
echo "${B}rechnungen bootstrap${N} — mode: $([[ $APPLY -eq 1 ]] && echo "${R}APPLY${N}" || echo "${G}dry-run${N} (pass --apply to execute)")"
load_env
info "env file $ENV_FILE · project $DOKPLOY_PROJECT/$DOKPLOY_ENVIRONMENT · instance $INSTANCE_NAME (db $PG_DATABASE)"

for s in "${ALL_STEPS[@]}"; do
  if want "$s"; then "do_$s"; fi
done

echo
ok "done ($([[ $APPLY -eq 1 ]] && echo applied || echo dry-run))"

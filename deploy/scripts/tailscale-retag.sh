#!/usr/bin/env bash
# Owner action 08 §2.1: confirm the Tailscale retag of the deploy server's gateway (one-time, HIGH RISK).
#
# `tailscale.confirmRetag` replaces the server's Tailscale USER identity with tag ownership (tag:dokploy). Risks:
# Tailscale SSH lockout (incl. Dokploy's own SSH if it uses the tailnet IP), ACLs that targeted your user no longer
# match the server, key expiry may persist, undo needs a console re-login. Runbook: deploy/runbooks/retag.md.
#
# By default this script ONLY prints the checklist, the current gateway state and the exact command.
# It executes the retag only with BOTH flags:  --apply --i-have-updated-the-policy
#
# Usage: deploy/scripts/tailscale-retag.sh [--server "Proxmox PVE"] [--apply --i-have-updated-the-policy]
set -euo pipefail

SERVER_NAME="Proxmox PVE"
APPLY=0
POLICY_DONE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --server) SERVER_NAME="$2"; shift ;;
    --apply) APPLY=1 ;;
    --i-have-updated-the-policy) POLICY_DONE=1 ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

command -v dokploy >/dev/null || { echo "dokploy CLI missing (deploy/scripts/build-dokploy-cli.sh)" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq missing" >&2; exit 1; }
dokploy tailscale confirm-retag --help >/dev/null 2>&1 || { echo "CLI lacks tailscale.confirmRetag — rebuild it" >&2; exit 1; }

SERVER_JSON="$(dokploy server all --json | jq -c --arg n "$SERVER_NAME" '[.[] | select(.name==$n)][0] // empty')"
[[ -n "$SERVER_JSON" ]] || { echo "server \"$SERVER_NAME\" not found" >&2; exit 1; }
SERVER_ID="$(jq -r .serverId <<<"$SERVER_JSON")"
SERVER_IP="$(jq -r .ipAddress <<<"$SERVER_JSON")"
GW="$(dokploy tailscale list --json | jq -c --arg s "$SERVER_ID" \
  '[.gateways[] | select(.serverId==$s) | {id: .tailscaleGatewayId, ownership, status, deviceName, version, tags, lastError}][0] // empty')"
[[ -n "$GW" ]] || { echo "no Tailscale gateway for $SERVER_NAME" >&2; exit 1; }
GW_ID="$(jq -r .id <<<"$GW")"
OWNERSHIP="$(jq -r .ownership <<<"$GW")"

cat <<EOF

Server:   $SERVER_NAME ($SERVER_ID), Dokploy connects via SSH to $SERVER_IP
Gateway:  $(jq -r '"\(.id)  device \(.deviceName)  tailscale \(.version)  ownership=\(.ownership)  status=\(.status)  tags=\(.tags|join(","))"' <<<"$GW")
          $(jq -r '.lastError // ""' <<<"$GW")

CHECKLIST (08 §2.1 — do it in this order, one server at a time)
  [ ] 1. Tailnet policy updated and SAVED with deploy/tailnet-policy.hujson (tagOwners tag:dokploy/tag:website/tag:ci,
         SSH rules admin→tag:dokploy AND tag:dokploy→tag:dokploy, grants for tag:dokploy). The fork's API credential
         may apply tag:dokploy.
  [ ] 2. Out-of-band access verified: Proxmox console of the host works and/or plain OpenSSH on the LAN address.
         $SERVER_IP is a TAILNET address → Dokploy's own SSH depends on the second SSH rule (tag:dokploy → tag:dokploy).
  [ ] 3. Run the command below (or the button in the Dokploy UI).
  [ ] 4. Immediately check: gateway ownership=adopted, status=ready (dokploy tailscale list); Dokploy still reaches the
         server (Dokploy UI → Servers); Tailscale SSH still works; the device IP is unchanged.
  [ ] 5. Admin console → Machines → the server → Disable key expiry.
  [ ] 6. Only then: deploy/bootstrap.sh --apply.
  Rollback: Proxmox console → tailscale up --force-reauth (re-login as your user).

COMMAND
  dokploy tailscale confirm-retag --tailscaleGatewayId $GW_ID --json

EOF

if [[ "$OWNERSHIP" != "pending_retag" ]]; then
  echo "Gateway ownership is \"$OWNERSHIP\", not pending_retag — nothing to confirm."
  exit 0
fi
if [[ $APPLY -ne 1 || $POLICY_DONE -ne 1 ]]; then
  echo "Not executed. Re-run with --apply --i-have-updated-the-policy after completing steps 1–2."
  exit 0
fi

read -r -p "Type the server name (\"$SERVER_NAME\") to confirm the retag: " answer
[[ "$answer" == "$SERVER_NAME" ]] || { echo "aborted"; exit 1; }
dokploy tailscale confirm-retag --tailscaleGatewayId "$GW_ID" --json
echo
echo "Gateway state now:"
dokploy tailscale list --json | jq -c --arg s "$SERVER_ID" '.gateways[] | select(.serverId==$s) | {ownership, status, tags, lastError}'
echo "Continue with checklist steps 4 and 5."

# Runbook: confirm the Tailscale retag of the deploy server (one-time, high risk)

Source: 08 §2.1, research 14 §4.1.3 · script: `deploy/scripts/tailscale-retag.sh` (prints only, unless
`--apply --i-have-updated-the-policy`)

State on 2026-10-12: gateway `QOCIaKhBD0OZds5aRUg1t` of "Proxmox PVE" (`proxmox-pve.tailb289f5.ts.net`, Tailscale
1.102.2) is `pending_retag`. Dokploy reaches the server over SSH on its **tailnet** IP `100.121.46.16`.

1. **Policy first.** Merge `deploy/tailnet-policy.hujson` (tagOwners, both SSH rules, `tag:dokploy` grants) into the
   tailnet policy, save, check there are no errors. The second SSH rule (`tag:dokploy → tag:dokploy`, root) is required
   because the Dokploy connection uses the tailnet IP.
2. **Out-of-band access.** Open the Proxmox console of the host and/or `ssh root@<LAN-IP>` with plain OpenSSH. Do not
   continue without it.
3. **Retag:** `deploy/scripts/tailscale-retag.sh` (read the printout), then
   `deploy/scripts/tailscale-retag.sh --apply --i-have-updated-the-policy` (asks you to type the server name).
4. **Check immediately:** `dokploy tailscale list --json | jq '.gateways[] | select(.serverId=="FfJuegLwLS55hTUWZf_Zt")'`
   → `ownership: "adopted"`, `status: "ready"`, tags `["tag:dokploy"]`; Dokploy UI → Servers → "Proxmox PVE" still
   connected; Tailscale SSH still works; IP unchanged.
5. Admin console → Machines → proxmox-pve → **Disable key expiry**.
6. Continue with [go-live.md](go-live.md) B.4.

**Rollback:** Proxmox console → `tailscale up --force-reauth` (log in as your user again); the gateway goes back to
`pending_retag`.

# 08 — Deployment & Operations (Dokploy fork + Tailscale Services + self-hosted Convex)

> **Status:** v1.1 · 2026-10-12 (platform update: tailnet only via the owner's Dokploy fork, Caddy TLS edge, Better Auth, Cloudflare auth mail, R2 backups, e-mail-in Worker + R2 inbox §3.4) · Research: [`../research/14-auth-email-tailscale.md`](../research/14-auth-email-tailscale.md) (authoritative for network, auth and mail), [`../research/04-dokploy.md`](../research/04-dokploy.md), [`../research/03-convex-self-hosted.md`](../research/03-convex-self-hosted.md)
> All infrastructure is created **reproducibly** by `deploy/bootstrap.sh` using **our own Dokploy CLI build** (`deploy/scripts/build-dokploy-cli.sh`): the upstream `@dokploy/cli` lacks the fork's procedures (`tailscale.*`, `cloudflare.*`), so the script builds the CLI from the **live server's OpenAPI document**, patches the tRPC GET input wrapper and installs it as `dokploy`. Re-run it after every Dokploy server upgrade. `bootstrap.sh` is idempotent (looks resources up by name before creating them); its flags are verified against `dokploy <group> <action> --help` of the generated CLI in P0.

## 1. Target topology

See [02-architecture.md §1](02-architecture.md#1-system-overview). **No public host.** Dokploy server: the owner's fork **`Bl4ckBl1zZ/dokploy` v0.41.1**; target: the Dokploy **remote server "Proxmox PVE"** (home, Germany → AO-06 satisfied). Dokploy project **`rechnungen`**, environment **`production`** (+ optional `staging` later for restore drills):

| Dokploy resource | Type | Name | Tailnet exposure |
|---|---|---|---|
| App stack | **Compose** (raw, from `deploy/compose/docker-compose.yml`) with services `caddy`, `web`, `backend`, `dashboard`, `postgres`, `einvoice-tools` | `rechnungen` | **Only `caddy`** (`expose: ["443", "8443"]`) → one Tailscale Service `svc:dokploy-rechnungen-production-rechnungen-caddy-<8>` (FQDN `…-caddy-<8>.tailb289f5.ts.net`, plain TCP via the fork's socat proxy, stable across redeploys) |
| R2 backup destination | Dokploy destination (exists already) | `$R2_DESTINATION_NAME` | — |
| Schedules / backups | Dokploy backups + schedules | see §7 | — |

How the fork publishes (research 14 §4.1, code-verified):
- One endpoint per compose service that declares **`ports:` or `expose:`** (target ports; UDP skipped). Services with no ports are **not** published. Therefore **only `caddy` declares `expose:`** (never `ports:`, which would also bind host ports); every other service stays on the compose network and is reached by service name.
- The data path is plain L4 TCP on the original port numbers (no TLS, no Traefik). TLS therefore terminates in Caddy.
- **No Dokploy domains** on this compose: domains would add published ports, and Traefik is not in the path anyway.
- A **Dokploy-managed database** would be auto-published as a tailnet endpoint (fixed port 5432), which is why Postgres runs **inside the compose** without ports.
- The app sees the socat proxy's address, never the client IP (02 §4.1).

Hostnames (all under the owner input `BASE_DOMAIN`, e.g. `buero.example.de`): `app.` (UI), `api.` (REST + MCP; port 8443 = REST only for the website), `convex.` (backend 3210), `convex-site.` (HTTP actions 3211; Better Auth; Next proxies `/api/auth/*` here), `convex-dash.` (dashboard).

## 2. Prerequisites (owner checklist)

- [ ] **Dokploy fork v0.41.1** running; remote server **"Proxmox PVE"** registered; org-level Tailscale config present (tailnet `bl4ckbl1zz.github`, DNS suffix `tailb289f5.ts.net`, device tag `tag:dokploy`). Server sizing: ≥ 4 vCPU, 8 GB RAM, 80 GB disk for Convex + Postgres + Next + the Java sidecar; UPS recommended (home server).
- [ ] **Retag confirmed** for the deploy server's Tailscale gateway (it shows `pending_retag`; Tailscale Services can only be hosted by tag-identity devices) — **follow §2.1 exactly**.
- [ ] **Domain on Cloudflare DNS** and a chosen **`BASE_DOMAIN`** (subdomain such as `buero.example.de`; do not use the registrable domain if a public website lives there — passkey RP ID, 02 §4.2).
- [ ] **Cloudflare API token for DNS-01** (`CLOUDFLARE_DNS_API_TOKEN`): Zone → DNS → Edit, limited to that one zone.
- [ ] **Cloudflare Email Service** onboarded for the sender domain (Compute → Email Service → Email Sending → Onboard Domain; adds SPF/DKIM/DMARC, merge an existing DMARC record); `CLOUDFLARE_ACCOUNT_ID`; API token with the Email Sending permission (`CLOUDFLARE_EMAIL_API_TOKEN`; exact label UNSURE); probably **Workers Paid ($5/month)** — test in P0 whether verified destination addresses suffice.
- [ ] **Cloudflare R2:** the existing Dokploy backup destination (bucket for `postgres/`, `convex-export/`, `convex-volume/`), plus a **dedicated checkpoint bucket** (recommended: EU jurisdiction and an **R2 bucket-lock retention rule** of 10 years — optional), plus (P2) a receipt-inbox bucket with the Email Worker (§3.4). R2 API tokens: checkpoint (read/write, that bucket only), backup listing (read-only), backup writer for the export script, inbox (P2, Object Read & Write on that bucket only); a Workers deploy token (P2).
- [ ] **`OWNER_EMAIL`**: the only address allowed to sign up while no user exists (02 §4.3).
- [ ] **Enable Banking** application (P2): app ID + RS256 private key; whitelist the redirect URL `https://app.<BASE_DOMAIN>/einstellungen/bank/callback` (HTTPS, need not be public). Ask Enable Banking in writing to confirm the restricted-mode use (research 13 §6).
- [ ] Dokploy API token (expiring) for the CLI; **GitHub repository** with Actions + GHCR; a Tailscale auth key/OAuth client for CI with `tag:ci`.
- [ ] Optional: website server joined to the tailnet with `tag:website` (05 §6.1).

### 2.1 Owner action: confirm the retag (one-time, high risk — do it in this order)

`tailscale.confirmRetag` calls the Tailscale API `POST /device/{id}/tags {"tags":["tag:dokploy"]}`, which **replaces the device's user identity with tag ownership**, marks the gateway `adopted` and re-provisions it so Services get published (research 14 §4.1.3). Risks: **Tailscale SSH lockout** (tagged devices are not covered by the default `autogroup:self` SSH rule; this includes Dokploy's own SSH to the server if it is registered with the tailnet IP), ACLs/grants that target the owner's user no longer match the server, key expiry may persist, and undoing it needs a re-login on the server.

1. **Update the tailnet policy first** (admin console → Access controls), then save and verify:
   ```json
   {
     "tagOwners": { "tag:dokploy": ["autogroup:admin"], "tag:website": ["autogroup:admin"], "tag:ci": ["autogroup:admin"] },
     "ssh": [
       { "action": "accept", "src": ["autogroup:admin"], "dst": ["tag:dokploy"], "users": ["root", "autogroup:nonroot"] },
       { "action": "accept", "src": ["tag:dokploy"],     "dst": ["tag:dokploy"], "users": ["root"] }
     ],
     "grants": [
       { "src": ["autogroup:admin"], "dst": ["tag:dokploy"], "ip": ["*"] },
       { "src": ["tag:dokploy"],     "dst": ["tag:dokploy"], "ip": ["*"] }
       // + the Caddy Service grants of 05 §6.1 once the Service exists
     ]
   }
   ```
   The fork's API credential must be allowed to apply `tag:dokploy`. With the default allow-all policy nothing breaks; with a custom policy these entries are mandatory.
2. **Verify out-of-band access** before touching anything: the Proxmox console of the VM/LXC works, and/or plain OpenSSH on the LAN address works. Check whether Dokploy's remote-server connection uses the LAN or the tailnet address; if tailnet, the second SSH rule above is required.
3. **Confirm the retag for one server at a time:** `dokploy tailscale confirm-retag --tailscaleGatewayId "$GW_ID"` (flag verified in P0, ADR 0003; wrapper: `deploy/scripts/tailscale-retag.sh`) (procedure `tailscale.confirmRetag`, permission `tailscale:update`; gateway IDs from the generated `dokploy tailscale` group, see `--help`) or the button in the Dokploy UI.
4. **Check immediately:** gateway status `adopted`; Dokploy can still reach the server; Tailscale SSH (if used) still works; the device IP is unchanged.
5. **Disable key expiry** for the now-tagged device on the Machines page (whether the old expiry persists after an API retag is UNSURE).
6. Only then deploy the compose (§5). **Rollback:** from the Proxmox console, `tailscale up --force-reauth` (re-login as the user).

Alternative that avoids the risk: the fork's `parallel` mode (separate tagged tailscaled in its own netns). It is chosen automatically only when the host client is on a different tailnet; a `forceIsolated` flag exists in code but is not exposed (UNSURE) — not used.

## 3. Repository `deploy/` folder

```
deploy/
├─ bootstrap.sh                 # idempotent Dokploy setup via the custom CLI (project, compose, env, backups, schedules, DNS)
├─ scripts/
│  ├─ build-dokploy-cli.sh      # builds/installs the CLI from the live server's OpenAPI (exists)
│  ├─ sync-dns.sh               # upserts the Cloudflare A/AAAA records → Caddy Service TailVIP (Cloudflare API)
│  ├─ convex-export.sh          # logical Convex export (+ file storage) → R2 convex-export/ (run by a Dokploy schedule)
│  └─ r2-monthly-copy.sh        # copies the latest daily objects to monthly/ (10-year retention prefix)
├─ env/production.example       # documented variables (no secrets); real values only in Dokploy / CI secrets
├─ compose/docker-compose.yml   # the app stack (caddy, web, backend, dashboard, postgres, einvoice-tools)
├─ caddy/Dockerfile             # xcaddy build with caddy-dns/cloudflare
├─ caddy/Caddyfile              # TLS + host routing (§3.2)
├─ einvoice-tools/              # (symlink to services/einvoice-tools) Dockerfile
├─ cloudflare/receipts-inbox/   # Email Worker for the e-mail-in receipt inbox (§3.4, P2): src/index.ts, wrangler.toml, test
├─ compose.dev.yml              # local stack: backend, postgres, einvoice-tools, caddy with an internal CA (§10)
└─ runbooks/                    # retag.md, upgrade-convex.md, upgrade-kosit.md, restore.md, rotate-secrets.md, dns-tailvip-changed.md, go-live.md, incident.md
```

### 3.1 `deploy/compose/docker-compose.yml`

```yaml
services:
  caddy:
    image: ghcr.io/<owner>/rechnungen-caddy:${CADDY_TAG}       # caddy 2 + caddy-dns/cloudflare, built in CI
    expose: ["443", "8443"]                                     # ← the ONLY published service (fork → Tailscale Service)
    environment:
      - BASE_DOMAIN=${BASE_DOMAIN}
      - ACME_EMAIL=${ACME_EMAIL}
      - CLOUDFLARE_DNS_API_TOKEN=${CLOUDFLARE_DNS_API_TOKEN}
      - CONVEX_DASH_BASIC_AUTH=${CONVEX_DASH_BASIC_AUTH}        # bcrypt hash (caddy hash-password)
    volumes: [caddy-data:/data, caddy-config:/config]
    depends_on: [web, backend, dashboard]
  web:
    image: ghcr.io/<owner>/rechnungen-web:${WEB_TAG}            # NEXT_PUBLIC_* baked in at build time (§5.1)
    environment:
      - NODE_ENV=production
      - APP_ORIGIN=https://app.${BASE_DOMAIN}
      - API_ORIGIN=https://api.${BASE_DOMAIN}
      - CONVEX_URL_INTERNAL=http://backend:3210
      - CONVEX_SITE_URL_INTERNAL=http://backend:3211
      - JWT_PRIVATE_KEY_PEM=${JWT_PRIVATE_KEY_PEM}
      - APP_ENCRYPTION_KEY=${APP_ENCRYPTION_KEY}
      - EINVOICE_TOOLS_URL=http://einvoice-tools:8080
    healthcheck: { test: "curl -f http://localhost:3000/api/health", interval: 10s, start_period: 20s }
  backend:
    image: ghcr.io/get-convex/convex-backend:${CONVEX_SHA}      # pinned SHA, e.g. 72ce13c379fe6dbdfc305bc8ad699c5663c68c2a
    stop_grace_period: 10s
    stop_signal: SIGINT
    volumes: [convex-data:/convex/data]
    environment:
      - INSTANCE_NAME=${INSTANCE_NAME}                          # "rechnungen" → Postgres DB name "rechnungen"
      - INSTANCE_SECRET=${INSTANCE_SECRET}                      # openssl rand -hex 32 (set explicitly!)
      - CONVEX_CLOUD_ORIGIN=https://convex.${BASE_DOMAIN}
      - CONVEX_SITE_ORIGIN=https://convex-site.${BASE_DOMAIN}  # = JWT issuer of Better Auth tokens
      - POSTGRES_URL=postgresql://convex:${PG_PASSWORD}@postgres:5432   # no db name!
      - DO_NOT_REQUIRE_SSL=1                                    # compose network only
      - REDACT_LOGS_TO_CLIENT=1
      - DISABLE_BEACON=1
      - RUST_LOG=info
      - DOCUMENT_RETENTION_DELAY=172800
    healthcheck: { test: "curl -f http://localhost:3210/version", interval: 5s, start_period: 15s }
    depends_on: { postgres: { condition: service_healthy } }
  dashboard:
    image: ghcr.io/get-convex/convex-dashboard:${CONVEX_SHA}   # SAME SHA as backend
    environment:
      - NEXT_PUBLIC_DEPLOYMENT_URL=https://convex.${BASE_DOMAIN}
    depends_on: { backend: { condition: service_healthy } }
  postgres:
    image: postgres:17
    environment:
      - POSTGRES_USER=convex
      - POSTGRES_PASSWORD=${PG_PASSWORD}
      - POSTGRES_DB=postgres                                    # instance DB is created by the one-shot `pg-init` service
    volumes: [pg-data:/var/lib/postgresql/data]
    healthcheck: { test: "pg_isready -U convex", interval: 5s }
  einvoice-tools:
    image: ghcr.io/<owner>/rechnungen-einvoice-tools:${EIT_TAG}
volumes:
  caddy-data:
  caddy-config:
  convex-data:
  pg-data:
```

Notes:
- **No service other than `caddy` may get `expose:`/`ports:`** — a CI check (`deploy/compose` lint in `pnpm lint`) fails otherwise, because the fork would publish it to the tailnet.
- The flags `DO_NOT_REQUIRE_SSL`, `REDACT_LOGS_TO_CLIENT` and `DISABLE_BEACON` are switched on by **any non-empty value**. Never set them to `false`; remove the line instead.
- The Postgres database named after `INSTANCE_NAME` (dashes → underscores) is created before the backend starts by a one-shot `pg-init` service (idempotent `createdb`), not by `POSTGRES_DB`, which only applies on the first init and would break the pilot → go-live switch (§8.1, ADR 0003). The block above is abridged; the authoritative file is `deploy/compose/docker-compose.yml` (adds `pg-init`, internal networks `db`/`tools`, healthchecks, log rotation).
- File storage stays on the `convex-data` volume (backed up by volume backups + `convex export --include-file-storage`). Moving to R2 storage later = export → new backend with the S3 bucket variables pointed at R2 → import.
- The backend container needs **egress** to `api.cloudflare.com` (auth mail), `*.r2.cloudflarestorage.com` (checkpoints, inbox), `api.enablebanking.com` (P2), the eVatR/VIES endpoints and the Claude API. "Tailnet only" restricts inbound traffic only.

### 3.2 `deploy/caddy/Caddyfile`

```caddyfile
{
	email {$ACME_EMAIL}
	acme_dns cloudflare {$CLOUDFLARE_DNS_API_TOKEN}     # DNS-01: Let's Encrypt never needs to reach the server
}

*.{$BASE_DOMAIN}:443 {                                  # one wildcard certificate for all hosts
	header Strict-Transport-Security "max-age=31536000"
	@app  host app.{$BASE_DOMAIN}
	@api  host api.{$BASE_DOMAIN}
	@cvx  host convex.{$BASE_DOMAIN}
	@site host convex-site.{$BASE_DOMAIN}
	@dash host convex-dash.{$BASE_DOMAIN}
	handle @app  { reverse_proxy web:3000 }
	handle @api  { reverse_proxy web:3000 }             # proxy.ts enforces the api. path allowlist (02 §4.1)
	handle @cvx  { reverse_proxy backend:3210 }         # WebSocket included
	handle @site { reverse_proxy backend:3211 }
	handle @dash {
		basic_auth { owner {$CONVEX_DASH_BASIC_AUTH} }
		reverse_proxy dashboard:6791
	}
	handle { respond 421 }
}

*.{$BASE_DOMAIN}:8443 {                                 # website listener: tag:website is granted ONLY this port
	@v1 {
		host api.{$BASE_DOMAIN}
		path /api/v1/*
	}
	handle @v1 { reverse_proxy web:3000 }
	handle { respond 404 }
}
```

### 3.3 DNS (Cloudflare, "DNS only", not proxied)

| Record | Type | Target |
|---|---|---|
| `app`, `api`, `convex`, `convex-site`, `convex-dash` `.<BASE_DOMAIN>` | A (+ AAAA) | **TailVIP** (IPv4/IPv6) of the Caddy Tailscale Service (admin console → Services, or the fork's endpoint data) |

- `deploy/scripts/sync-dns.sh` (Cloudflare API, `CLOUDFLARE_DNS_API_TOKEN`) upserts the records; `bootstrap.sh` calls it after the Service exists. A single wildcard record `*.<BASE_DOMAIN>` is an acceptable alternative.
- Public DNS reveals a 100.x / fd7a: address — harmless; off-tailnet clients just time out.
- **The TailVIP changes only if the Service is deleted/recreated** (e.g. the compose resource is recreated). Runbook `dns-tailvip-changed.md`: re-run `sync-dns.sh`. The security page (F12 AUD-020) warns when `app.<BASE_DOMAIN>` no longer resolves to the current Service address.
- Linux clients ≤ Tailscale v1.93 need `tailscale set --accept-routes` to reach Service VIPs; v1.94+, mobile and desktop apps don't.

### 3.4 E-mail-in: Cloudflare Email Worker + R2 inbox bucket (P2)

Receipts e-mailed to the business land in the receipt inbox without any inbound connection to the server (F06 INB-048…052, 02 §7 `inbox.pollR2`). Mail is received by Cloudflare; the app polls R2 from inside the tailnet.

```
supplier ──SMTP──▶ Cloudflare Email Routing (MX of in.<domain>) ──▶ Worker receipts-inbox ──put──▶ R2 rechnungen-inbox/inbox/*.eml
                                                                                                   ▲
                                      backend (cron inbox.pollR2, every 5 min, ≤ 50 objects) ──list/get/delete (S3 API)
```

**One-time setup** (scripted where the API allows it; `deploy/cloudflare/receipts-inbox/README` lists the steps):
1. **R2 bucket**: `wrangler r2 bucket create rechnungen-inbox --jurisdiction eu`. **No lifecycle rule** (an unimported mail must never expire) and no public access.
2. **Worker**: `deploy/cloudflare/receipts-inbox/wrangler.toml`:
   ```toml
   name = "receipts-inbox"
   main = "src/index.ts"
   compatibility_date = "2026-10-01"
   [[r2_buckets]]
   binding = "INBOX"
   bucket_name = "rechnungen-inbox"
   jurisdiction = "eu"
   ```
   `src/index.ts` (the Worker is dumb: no parsing, no filtering, never deletes):
   ```ts
   export default {
     async email(message: ForwardableEmailMessage, env: { INBOX: R2Bucket }) {
       if (message.rawSize > 25 * 1024 * 1024) {
         message.setReject("Nachricht zu groß (max. 25 MB) – bitte Rechnung in mehreren E-Mails oder als Link senden");
         return;
       }
       const raw = await new Response(message.raw).arrayBuffer();   // R2 needs a known length
       await env.INBOX.put(`inbox/${Date.now()}-${crypto.randomUUID()}.eml`, raw, {
         customMetadata: {
           from: message.from, to: message.to,
           subject: message.headers.get("subject") ?? "", messageId: message.headers.get("message-id") ?? "",
           rawSize: String(message.rawSize),
         },
       });
     }
   };
   ```
   Deploy with `wrangler deploy` (by hand or a CI job `deploy-worker` on changes under `deploy/cloudflare/**`) using `CLOUDFLARE_WORKERS_API_TOKEN` (Workers Scripts Edit + Workers R2 Storage Edit, this account only). A unit test (Miniflare/`@cloudflare/vitest-pool-workers`) checks the object key format, metadata and the 25 MiB rejection. A failed `put` throws; whether Email Routing then answers the sending MTA with a temporary failure (retry) is UNSURE — **P2 spike** (send while the binding is misconfigured; expected: a retry or a bounce, never a silent drop).
3. **Email Routing** on the zone of the receiving domain: add the receiving subdomain (e.g. `in.example.de`; Cloudflare creates its MX/SPF records on the subdomain only, so the main domain's mail is untouched) and a routing rule `belege@in.example.de` → **Send to a Worker** → `receipts-inbox` (optionally a catch-all for the subdomain). The receiving domain need not be `BASE_DOMAIN`; its public MX points at Cloudflare, not at our server, so the tailnet-only rule holds.
4. **App polling credentials**: an R2 API token **Object Read & Write, scoped to `rechnungen-inbox` only** (R2 has no delete-only level; the app only lists, reads and deletes). Set `R2_INBOX_BUCKET`, `R2_INBOX_ACCESS_KEY_ID`, `R2_INBOX_SECRET_ACCESS_KEY` in the Convex env (§5.2; `R2_ACCOUNT_ENDPOINT` must be the `.eu.` endpoint for an EU bucket). Then Einstellungen › Posteingang › „Verbindung testen" (F01 SET-110, F06 INB-052) and the Cloudflare AVV confirmation.
5. **Smoke test**: send a mail with a PDF to the address; within 5 min it appears in the Posteingang with the `.eml` as original and the object is gone from the bucket.

Backups: the bucket is a transient drop box; the archive is the app's file storage (in the Convex backups, §7). The Worker source is in git; recreating it is `wrangler deploy`.

## 4. Tailnet policy (grants)

The policy of §2.1 plus, once the Caddy Service exists (name from the fork, e.g. `svc:dokploy-rechnungen-production-rechnungen-caddy-<id>`):

| Source | Destination | Ports | Purpose |
|---|---|---|---|
| `autogroup:admin` (owner devices) | Caddy Service | `tcp:443`, `tcp:8443` | UI, API, MCP, Convex, dashboard |
| invited members' users/devices (bookkeeper, viewer, remote auditor) | Caddy Service | `tcp:443` | UI only; remove the grant/device when the member expires (02 §4.3) |
| `tag:website` | Caddy Service | `tcp:8443` | REST `/api/v1/**` only (05 §6.1) |
| `tag:ci` | Caddy Service | `tcp:443` | `npx convex deploy`, smoke tests |

Tailscale Funnel is **not** used (no public exposure). Exact grant syntax for Services follows the Tailscale Services docs (research 14 §4.6).

## 5. Bootstrap procedure (`deploy/bootstrap.sh`)

The script reads its inputs from a local, never-committed `.env.production` (template `deploy/env/production.example`), runs in **dry-run mode by default** (read-only lookups run, mutating commands are only printed with secrets redacted) and executes only with `--apply`. Commands are shown in CLI syntax of the **generated** CLI; the script wraps each one with a lookup (`dokploy project all --json | jq …`) to stay idempotent. **P0 verification (ADR 0003):** `compose create` has no `--sourceType` (the raw source is set with `compose update --sourceType raw --composeFile …`), `save-environment` has no `--createEnvFile`, `--enabled`/`--turnOff` are value-less switches (`--turnOff false` would enable it), and the retag flag is `--tailscaleGatewayId`; the block below is the original sketch, `deploy/bootstrap.sh` has the verified commands.

```bash
# 0. CLI matching OUR server (fork procedures incl. tailscale.*)
DOKPLOY_URL=… DOKPLOY_AUTH_TOKEN=… deploy/scripts/build-dokploy-cli.sh
dokploy tailscale --help >/dev/null                      # fails fast if the fork procedures are missing

# 1. Preconditions: retag confirmed (§2.1) — abort if the deploy server's gateway is still pending_retag
dokploy server all --json | jq -e '.[] | select(.name=="Proxmox PVE")' >/dev/null
#    (gateway ownership/status read via the generated `dokploy tailscale` commands; must be adopted|managed and ready)

# 2. Project + environment
dokploy project create --name rechnungen --description "Rechnungen & Buchhaltung"
ENV_ID=$(dokploy project all --json | jq -r '.[] | select(.name=="rechnungen") | .environments[] | select(.name=="production") | .environmentId')
SERVER_ID=$(dokploy server all --json | jq -r '.[] | select(.name=="Proxmox PVE") | .serverId')

# 3. App stack compose (on the remote server)
dokploy compose create --name rechnungen --environmentId "$ENV_ID" --serverId "$SERVER_ID" \
  --composeType docker-compose --sourceType raw --composeFile "$(cat deploy/compose/docker-compose.yml)"
dokploy compose save-environment --composeId "$CMP_ID" --env "$(cat <<EOF
BASE_DOMAIN=$BASE_DOMAIN
ACME_EMAIL=$ACME_EMAIL
CLOUDFLARE_DNS_API_TOKEN=$CLOUDFLARE_DNS_API_TOKEN
CONVEX_DASH_BASIC_AUTH=$CONVEX_DASH_BASIC_AUTH
CADDY_TAG=$CADDY_TAG
WEB_TAG=$WEB_TAG
EIT_TAG=$EIT_TAG
CONVEX_SHA=$CONVEX_SHA
INSTANCE_NAME=rechnungen
INSTANCE_SECRET=$INSTANCE_SECRET
PG_PASSWORD=$PG_PASSWORD
JWT_PRIVATE_KEY_PEM=$JWT_PRIVATE_KEY_PEM
APP_ENCRYPTION_KEY=$APP_ENCRYPTION_KEY
EOF
)"
#    (registry credentials for ghcr.io via `dokploy registry create`, referenced by the compose)
dokploy compose deploy --composeId "$CMP_ID"
#    → the fork publishes the caddy Service; wait until its endpoint is ready, read the TailVIP

# 4. DNS → TailVIP, then wait for Caddy's wildcard certificate
deploy/scripts/sync-dns.sh "$BASE_DOMAIN" "$CADDY_TAILVIP4" "$CADDY_TAILVIP6"
curl -fsS "https://app.$BASE_DOMAIN/api/health"          # from this (tailnet) machine

# 5. Convex admin key + Convex env (once)
#    generate the admin key in the backend container (Dokploy terminal or docker exec): ./generate_admin_key.sh
#    → CI secret CONVEX_SELF_HOSTED_ADMIN_KEY (never in the repo, never in the runtime image)
export CONVEX_SELF_HOSTED_URL="https://convex.$BASE_DOMAIN" CONVEX_SELF_HOSTED_ADMIN_KEY=…
npx convex deploy                                        # pushes functions, incl. the Better Auth component
npx convex run auth:rotateKeys | npx convex env set JWKS # static Better Auth JWKS (02 §4.2)
npx convex env set BETTER_AUTH_SECRET "$(openssl rand -base64 32)"
npx convex env set SITE_URL "https://app.$BASE_DOMAIN"
npx convex env set PASSKEY_RP_ID "$BASE_DOMAIN"
npx convex env set OWNER_EMAIL "$OWNER_EMAIL"
#    … and every other variable of §5.2 (SERVER_JWKS, Cloudflare, R2, CHECKPOINT_SIGNING_KEY_PEM, ENABLE_BANKING_* in P2)

# 6. Backups to the existing R2 destination (§7)
DEST_ID=$(dokploy destination all --json | jq -r --arg n "$R2_DESTINATION_NAME" '.[] | select(.name==$n) | .destinationId')
dokploy backup create --backupType compose --composeId "$CMP_ID" --serviceName postgres --databaseType postgres \
  --database rechnungen --destinationId "$DEST_ID" --schedule "0 3 * * *" --prefix postgres/ --keepLatestCount 30 --enabled true
dokploy volume-backups create --name convex-data --volumeName "${CMP_APPNAME}_convex-data" --composeId "$CMP_ID" \
  --serviceName backend --serviceType compose --prefix convex-volume/ --cronExpression "30 3 * * 0" \
  --destinationId "$DEST_ID" --keepLatestCount 8 --turnOff false
dokploy schedule create --name convex-logical-export --scheduleType server --serverId "$SERVER_ID" \
  --cronExpression "0 4 * * *" --command "/opt/rechnungen/convex-export.sh"
dokploy schedule create --name r2-monthly-copy --scheduleType server --serverId "$SERVER_ID" \
  --cronExpression "0 5 1 * *" --command "/opt/rechnungen/r2-monthly-copy.sh"
```

> **P0 spikes:** (1) ~~confirm the compose-backup flags~~ **confirmed** (2026-10-12): `backup create` has `--backupType compose --composeId --serviceName`; fallback not needed. (2) ~~gateway status and TailVIP~~ **answered**: `dokploy tailscale list --json` returns gateways (`ownership`, `status`) and endpoints (`serviceName`, `fqdn`, `ownerKey`, `status`) but **no TailVIP** → `bootstrap.sh` resolves the Service FQDN via MagicDNS (`dig @100.100.100.100`). (3) Better Auth through Caddy: sign-in, passkey enrolment and `/api/auth/convex/token` against the self-hosted backend (Convex Cloud's proxy bug #422 should not apply; verify).

### 5.1 Build-time variables (`web` image, CI)

| Variable | Example | Purpose |
|---|---|---|
| `NEXT_PUBLIC_CONVEX_URL` | `https://convex.buero.example.de` | Browser Convex client (inlined at build time → Docker build arg) |
| `NEXT_PUBLIC_SITE_URL` | `https://app.buero.example.de` | Better Auth client `baseURL` |
| `GIT_SHA` / `BUILD_DATE` | commit SHA / `2026-10-12` | Shown on /einstellungen/system (F01 SET-130) |

### 5.2 Environment variables

**Compose environment (Dokploy, §5 step 3):**

| Variable | Service | Example / format | Purpose |
|---|---|---|---|
| `BASE_DOMAIN` | caddy (and derived URLs in web/backend/dashboard) | `buero.example.de` | All hostnames, passkey RP ID |
| `ACME_EMAIL` | caddy | `owner@example.de` | Let's Encrypt account |
| `CLOUDFLARE_DNS_API_TOKEN` | caddy | token | DNS-01 for `*.<BASE_DOMAIN>` |
| `CONVEX_DASH_BASIC_AUTH` | caddy | bcrypt hash | Dashboard protection (+ admin key) |
| `APP_ORIGIN` / `API_ORIGIN` | web | `https://app.…` / `https://api.…` | Host routing in `proxy.ts`, links |
| `CONVEX_URL_INTERNAL` / `CONVEX_SITE_URL_INTERNAL` | web | `http://backend:3210` / `http://backend:3211` | Server-side Convex calls and the `/api/auth/*` proxy (no tailnet hairpin) |
| `JWT_PRIVATE_KEY_PEM` | web | ES256 PEM | Server JWT for `api-key:`/`mcp:` actors |
| `APP_ENCRYPTION_KEY` | web (+ Convex env) | 32 bytes base64 | AES-GCM for secrets stored in Convex |
| `EINVOICE_TOOLS_URL` | web | `http://einvoice-tools:8080` | Validators |
| `INSTANCE_NAME`, `INSTANCE_SECRET`, `PG_PASSWORD`, `CONVEX_SHA` | backend/postgres/dashboard (`CONVEX_SHA` also web) | | Convex instance; web shows and checks the pinned image SHA (SET-130, AUD-020) |
| `CADDY_TAG`, `WEB_TAG`, `EIT_TAG` | — | git SHA | Image tags (CI updates them) |
| `LOG_LEVEL` | web | `info` | |

**Convex function env (`npx convex env set`, run by bootstrap/CI from CI secrets):**

| Variable | Example | Purpose |
|---|---|---|
| `SITE_URL` | `https://app.buero.example.de` | Better Auth `baseURL`, trusted origin, links in auth mails |
| `BETTER_AUTH_SECRET` | 32 bytes base64 | Better Auth secret |
| `JWKS` | JSON (from `auth:rotateKeys`) | Static Better Auth key set; no self-fetch (02 §4.2) |
| `PASSKEY_RP_ID` | `buero.example.de` | = `BASE_DOMAIN`. Changing it invalidates every passkey |
| `OWNER_EMAIL` | `inhaber@example.de` | Bootstrap sign-up gate (02 §4.3) |
| `SERVER_JWKS` | `data:` URI JWKS | Public key of `JWT_PRIVATE_KEY_PEM` for the second auth provider |
| `CLOUDFLARE_ACCOUNT_ID` | hex | Email Sending REST path |
| `CLOUDFLARE_EMAIL_API_TOKEN` | token | Email Sending (auth mail, owner notifications) |
| `AUTH_MAIL_FROM` | `Buchhaltung <noreply@mail.example.de>` | Sender on the onboarded domain |
| `R2_ACCOUNT_ENDPOINT` | `https://<account>.r2.cloudflarestorage.com` (or `.eu.` jurisdiction endpoint) | S3 API endpoint |
| `R2_CHECKPOINT_BUCKET` / `R2_CHECKPOINT_ACCESS_KEY_ID` / `R2_CHECKPOINT_SECRET_ACCESS_KEY` | `rechnungen-checkpoints` | Signed daily checkpoints (02 §4.6) |
| `R2_BACKUP_BUCKET` / `R2_BACKUP_READONLY_ACCESS_KEY_ID` / `R2_BACKUP_READONLY_SECRET_ACCESS_KEY` | bucket of the Dokploy destination | `backups.verify` listing (read-only) |
| `R2_INBOX_BUCKET` / `R2_INBOX_ACCESS_KEY_ID` / `R2_INBOX_SECRET_ACCESS_KEY` | `rechnungen-inbox` (P2) | Receipt inbox polling (F06) |
| `CHECKPOINT_SIGNING_KEY_PEM` | ES256 PEM | Signs the daily audit checkpoints (02 §4.5/§4.6, SEC-04). Separate from all other keys; generated once by `bootstrap.sh` (`openssl ecparam -name prime256v1 -genkey`), backed up offline; rotation per `deploy/runbooks/rotate-secrets.md` (new `kid`, old public keys kept) |
| `ENABLE_BANKING_APP_ID` / `ENABLE_BANKING_PRIVATE_KEY_PEM` | UUID / RSA PEM | Enable Banking bank sync (P2, F07) |
| `APP_ENCRYPTION_KEY` | 32 bytes base64 | Same key as in `web` |
| `EINVOICE_TOOLS_URL` | `http://einvoice-tools:8080` | Internal URL reachable from the backend container |
| `SECRETS_ROTATED_ON` | `2026-10-12` | Date of the last secret rotation; the security page warns after 365 days (AUD-020) |
| `IS_TEST` | `1` | **Never in production** |

**Server-side script env** (`/opt/rechnungen/*.env`, root-only, on "Proxmox PVE"): `CONVEX_SELF_HOSTED_ADMIN_KEY`, `R2_BACKUP_WRITER_ACCESS_KEY_ID/SECRET` for `convex-export.sh` and `r2-monthly-copy.sh`.

## 6. Continuous deployment

```
push to main → CI green (07-testing §7) →
  1. docker build web (build args NEXT_PUBLIC_CONVEX_URL, NEXT_PUBLIC_SITE_URL) + einvoice-tools + caddy
     → push ghcr.io/<owner>/rechnungen-*:<git-sha>
  2. join the tailnet: tailscale/github-action (OAuth client, tag:ci; grant tcp:443 on the Caddy Service)
  3. npx convex deploy          (CONVEX_SELF_HOSTED_URL=https://convex.<BASE_DOMAIN>, admin key from CI secrets)
     then, for each new entry of MIGRATIONS (convex/model/migrations.ts): npx convex run migrations:run '{"name":"…"}'
     (F12 AUD-028: RI-01/04/14 and protected content checked before/after, E-AUD-17 rolls back, `system.migration` audit entry)
  4. dokploy compose save-environment (new *_TAG values) + dokploy compose deploy  (custom CLI, §0 of bootstrap)
  5. Smoke (over the tailnet): GET https://app.<BASE_DOMAIN>/api/health == ok; GET https://api.<BASE_DOMAIN>/api/health;
     GET https://app.<BASE_DOMAIN>/api/auth/ok (Better Auth reachable through the proxy)
  6. On smoke failure: redeploy with the previous tags + notify
```

- Convex functions must stay **backward compatible for one deploy** (expand → migrate → contract), because steps 3 and 4 are not atomic. Schema changes use Convex's migration pattern (`@convex-dev/migrations` or our own `migrations` table with idempotent internal mutations).
- Renovate: `better-auth`, `@better-auth/*` pinned to 1.6.x (block `>=1.7` until `@convex-dev/better-auth` supports it, issue #433); `@convex-dev/better-auth` exact.
- Separate job `deploy-worker` (P2, only on changes under `deploy/cloudflare/**`): `wrangler deploy` of the receipt-inbox Email Worker with the CI secret `CLOUDFLARE_WORKERS_API_TOKEN` (§3.4); it does not need the tailnet.
- A redeploy keeps the Tailscale Service name (persisted per owner key) and therefore the TailVIP; recreating the compose resource does not.

## 7. Backups and restore (SEC-05, GOBD-09)

All backups go to **Cloudflare R2** through the owner's existing Dokploy backup destination; checkpoints go to their own bucket.

| What | How | Frequency | Retention |
|---|---|---|---|
| Postgres (Convex data) | Dokploy compose backup of service `postgres` → R2 `postgres/` | daily 03:00 | 30 daily (Dokploy `keepLatestCount`) + monthly copies in `monthly/postgres/` 10 years (`r2-monthly-copy.sh`) |
| Convex logical export (tables + files) | `convex-export.sh` (Dokploy server schedule): a throwaway `node:24-slim` container on the compose network runs `npx convex@1.46 export --include-file-storage` against `http://backend:3210` + `npx convex env list` (values of secrets redacted) → R2 `convex-export/` | daily 04:00 | 90 days (R2 lifecycle rule on the prefix) + monthly 10 years |
| Convex volume (file storage) | Dokploy volume backup → R2 `convex-volume/` | weekly | 8 weeks |
| Integrity checkpoints | App cron `integrity.checkpoint` (JWS signed with `CHECKPOINT_SIGNING_KEY_PEM`) → **dedicated R2 checkpoint bucket** `checkpoints/YYYY/MM/DD.jws` | daily | 10 years — **recommended:** R2 bucket-lock retention rule (10 years) on that bucket; optional |
| Dokploy itself | Web Server backup → R2 destination | weekly | 8 weeks |

- R2 buckets should use the **EU jurisdiction** where possible (AO-06/DSGVO-04 documentation; the external-services page records the region).
- The checkpoint bucket's token is scoped to that bucket; the backup-listing token is read-only. A bucket-lock rule on the checkpoint bucket makes deletion impossible even with the token; without it, the off-host copy still detects any later rewrite of the chain (F12 AUD-013).
- **Restore drill** (monthly reminder in the app; runbook `deploy/runbooks/restore.md`): spin up the `staging` environment (own compose, own Tailscale Service, own `BASE_DOMAIN` e.g. `staging.buero.example.de`) → restore the latest Postgres dump → start Convex with the same `INSTANCE_NAME`/`INSTANCE_SECRET` → `integrity.verify` → compare the chain head with the production checkpoint from R2 → record the drill result in the app (Einstellungen › System › Backups). Restores are audit-logged. Better Auth sessions from production are invalid in staging if `BETTER_AUTH_SECRET`/`JWKS` differ (intended); sign in with e-mail OTP.
- Long-term readability (GOBD-23): the yearly full export (JSON + PDFs/XML + GDPdU) is stored separately; it stays readable without the app.

## 8. Upgrades (runbooks)

| Component | Procedure |
|---|---|
| **Convex images** | Read the release notes → `npx convex export` → bump `CONVEX_SHA` (backend **and** dashboard) in the compose env → redeploy → watch the logs for `MigrationComplete` → run integrity verify → smoke test |
| **Better Auth** | Only within 1.6.x until the component supports 1.7 (#433). After an upgrade: re-run `npx auth generate` for the Local Install schema, review the schema diff, E2E sign-in suite (passkey, OTP, TOTP) |
| **KoSIT config / Mustang** | PR bumps the versions in `services/einvoice-tools` → CI golden validation must stay green (or the golden files are updated with justification) → deploy. Check KoSIT releases in Feb/Aug (the `rules.freshness` cron reminds) |
| **Tax rule tables** | Code change in `src/domain/rules/**` with `validFrom` + tests → normal deploy. Urgent values (Basiszinssatz) can be added as a `ruleOverride` in the UI and replaced by the release later |
| **Next.js / deps** | Renovate weekly; security patches immediately (e.g. the Next.js 16.4 patch announced for 2026-10-14) |
| **Dokploy fork** | Web Server backup → upgrade the fork → **re-run `deploy/scripts/build-dokploy-cli.sh`** (the CLI is generated from the server's OpenAPI) → check that the Caddy Service and gateway are still `ready` |
| **Caddy** | Rebuild the image (xcaddy + `caddy-dns/cloudflare`) on Caddy releases; certificates persist in `caddy-data` |

### 8.1 Pilot instance and the go-live switch (runbook `go-live.md`)

P1 runs as a pilot on the production stack (09 P1): the same compose, hosts, Caddy, R2 backups and login, but the Convex instance is **`INSTANCE_NAME=rechnungen-pilot`** with its own Postgres database (`PG` database name derived from the instance name), number-range prefix `TEST-` and training data. Go-live (end of P2, at the start of a VAT period, 09 go-live checklist):
1. Full Convex export of the pilot (`npx convex export --include-file-storage`) → R2 `pilot-archive/` (kept with the release notes; it contains no real Belege).
2. Set `INSTANCE_NAME=rechnungen` and a new `INSTANCE_SECRET` in the compose env, new admin key, re-run the Convex env step of `bootstrap.sh` (new `BETTER_AUTH_SECRET` + `JWKS`), `npx convex deploy`.
3. The owner signs up again with `OWNER_EMAIL` (passkeys of the pilot are gone; the RP ID `BASE_DOMAIN` stays), runs the setup wizard and commits the final sevdesk import; members are re-invited.
4. Backups and checkpoints restart for the new instance (the checkpoint key stays; the first checkpoint of the new chain notes `prevCheckpointHash = null` and the instance name); one restore drill before the first real invoice.

## 9. Monitoring and alerting

- Dokploy notifications (e-mail/ntfy): deploy failed, container restarted, backup failed.
- App notifications: integrity check failed, the einvoice-tools sidecar is unreachable (finalisation blocked), Cloudflare auth-mail failures (`10004/10105/10203`), Enable Banking re-consent required / consent expiring (P2), backup drill overdue, rule tables stale, **wildcard certificate expiry < 14 days** and **DNS no longer pointing at the Caddy Service** (security page, F12 AUD-020).
- `/api/health` (minimal, no key) and `/api/health/deep` (owner session: Convex latency, sidecar versions, Cloudflare Email reachability, disk usage of the Convex volume, last backup timestamps from the R2 listing).

## 10. Local development

```bash
pnpm i
docker compose -f deploy/compose.dev.yml up -d        # backend(:3210/:3211), postgres, einvoice-tools(:8080), caddy(:443, internal CA)
docker compose -f deploy/compose.dev.yml exec backend ./generate_admin_key.sh
caddy trust                                            # once: trust Caddy's local CA so passkeys get a secure context
cp .env.example .env.local                             # CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210, admin key,
                                                       # NEXT_PUBLIC_CONVEX_URL=https://convex.localtest.me, NEXT_PUBLIC_SITE_URL=https://app.localtest.me
pnpm convex dev                                        # pushes functions + codegen, watches
pnpm convex env set SITE_URL https://app.localtest.me && pnpm convex env set PASSKEY_RP_ID localtest.me   # + JWKS, OWNER_EMAIL …
pnpm dev                                               # next dev (Turbopack) behind caddy: https://app.localtest.me
pnpm test                                              # vitest (all projects)
pnpm e2e                                               # playwright (desktop, iphone, pixel) with a virtual WebAuthn authenticator
```

- `localtest.me` resolves to 127.0.0.1; Caddy uses `tls internal` for `*.localtest.me` in dev, so `BASE_DOMAIN=localtest.me` mirrors production host routing (app/api/convex/convex-site/convex-dash).
- **Auth mail in dev/test:** `AUTH_MAIL_SENDER=console` prints OTP codes to the Convex log; tests use the in-memory sender and read the code from it. The Cloudflare sender is only used in production (and a manual P0 test).
- `CONVEX_DEPLOYMENT` must **not** be set together with `CONVEX_SELF_HOSTED_*` (the CLI refuses mixed configs).

## 11. What I need from you to execute this (owner inputs)

| Input | Why |
|---|---|
| Dokploy URL + API token (expiring) of the fork | Custom CLI build and automation |
| **Retag confirmation done** per §2.1 (policy updated, console access checked, key expiry disabled) | Tailscale Services can only be hosted by tagged gateways |
| `BASE_DOMAIN` (e.g. `buero.example.de`) on Cloudflare DNS + `CLOUDFLARE_DNS_API_TOKEN` (Zone → DNS → Edit) | Hostnames, wildcard certificate, DNS records |
| `OWNER_EMAIL` | First (owner) sign-up |
| Cloudflare account ID, Email Sending token, sender address on an onboarded domain; Workers Paid decision | Sign-in codes and invites |
| Name of the existing **R2 Dokploy destination**; a dedicated **R2 checkpoint bucket** (bucket lock recommended) + tokens | Backups, checkpoints |
| (P2) Receiving address for receipts (e.g. `belege@in.example.de`) on a Cloudflare zone, Email Routing enabled, a Workers deploy token; inbox bucket created per §3.4 | E-mail-in receipt inbox |
| Enable Banking app ID + private key (P2) and the redirect URL whitelisted | Bank sync |
| Server confirmation: Dokploy remote server "Proxmox PVE", Germany | AO-06 |
| GitHub repo (public/private) + GHCR; Tailscale OAuth client for CI (`tag:ci`) | CI/CD over the tailnet |
| Optional: website server with a `tag:website` auth key | Website → REST API (05 §6.1) |

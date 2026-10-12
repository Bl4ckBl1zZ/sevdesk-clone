# Runbook: first deployment (pilot) and the go-live switch

Source: 08 §2, §5, §6, §8.1 · scripts: `deploy/bootstrap.sh`, `deploy/scripts/tailscale-retag.sh`

## A. Inputs the owner provides (once)

| Input | Where it goes |
|---|---|
| Dokploy URL + **expiring** API token of the fork | local CLI (`deploy/scripts/build-dokploy-cli.sh`), CI secrets `DOKPLOY_URL` (tailnet URL of the panel, e.g. `http://<panel-tailnet-ip>:3000`) and `DOKPLOY_API_KEY` |
| Retag done per [retag.md](retag.md) | gateway of "Proxmox PVE" `adopted` + `ready` |
| `BASE_DOMAIN` (e.g. `buero.example.de`) on Cloudflare DNS | `.env.production`, CI variable `BASE_DOMAIN` |
| `CLOUDFLARE_DNS_API_TOKEN` (Zone → DNS → Edit, that zone only) | `.env.production` (Caddy DNS-01 + `sync-dns.sh`) |
| `ACME_EMAIL`, `OWNER_EMAIL` | `.env.production` |
| Dashboard password → `caddy hash-password` | `.env.production` `CONVEX_DASH_BASIC_AUTH='…'` (single quotes!) |
| Image registry + pull credentials | `.env.production` `IMAGE_REGISTRY`, `REGISTRY_USERNAME`/`REGISTRY_PASSWORD`; CI secrets `REGISTRY`, `REGISTRY_USER`, `REGISTRY_PASSWORD` (empty → GHCR of the repo owner) |
| Cloudflare account ID, Email Sending token, `AUTH_MAIL_FROM` | `.env.production` (Convex env step) |
| R2: name of the Dokploy destination (`Cloudflare R2 (dokploy)`), checkpoint bucket + tokens, read-only backup token, backup **writer** token | `.env.production`; writer token only in `/opt/rechnungen/backup.env` on the server |
| Tailscale OAuth client (scope `auth_keys`, tag `tag:ci`) | CI secrets `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET` |
| GitHub environment `production` (optional required reviewers) | repository settings |

### CI/CD inputs (GitHub → Settings → Secrets and variables → Actions; environment `production`)

| Kind | Name | Value |
|---|---|---|
| variable | `IMAGES_ENABLED` | `true` → `build-image` pushes images on `main`/`v*` |
| variable | `DEPLOY_ENABLED` | `true` → `deploy` job runs after all CI jobs (implies image builds) |
| variable | `BASE_DOMAIN` | e.g. `buero.example.de` (also baked into the web image, 08 §5.1) |
| variable | `DOKPLOY_COMPOSE_ID` | printed by `deploy/bootstrap.sh` (`dokploy project all --json`) |
| variable | `SMOKE_EXTRA` | optional extra smoke URLs, e.g. `https://app.<BASE_DOMAIN>/api/auth/ok` |
| secret | `REGISTRY`, `REGISTRY_USER`, `REGISTRY_PASSWORD` | optional; default GHCR `ghcr.io/<owner>` with the workflow token |
| secret | `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET` | Tailscale OAuth client, scope `auth_keys`, tag `tag:ci` |
| secret | `CONVEX_SELF_HOSTED_ADMIN_KEY` | from `./generate_admin_key.sh` (B.6) |
| secret | `DOKPLOY_URL`, `DOKPLOY_API_KEY` | panel URL reachable over the tailnet + expiring API token |
| variable / secret | `WORKER_DEPLOY_ENABLED`, `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_WORKERS_API_TOKEN` | P2 Email Worker ([email-in.md](email-in.md)) |

Generated locally (commands in `deploy/env/production.example`): `INSTANCE_SECRET`, `PG_PASSWORD`, `APP_ENCRYPTION_KEY`,
`JWT_PRIVATE_KEY_PEM`, `CHECKPOINT_SIGNING_KEY_PEM` (back it up offline), `BETTER_AUTH_SECRET`.

## B. First deployment (pilot instance `rechnungen-pilot`)

1. `deploy/scripts/build-dokploy-cli.sh` → `dokploy tailscale --help` works.
2. Retag per [retag.md](retag.md) (policy first, console access, one server, disable key expiry).
3. `cp deploy/env/production.example .env.production && chmod 600 .env.production`, fill it in. First image tags:
   set the CI variables `IMAGES_ENABLED=true` + `BASE_DOMAIN` (and the registry secrets), push to `main` → the
   `build-image` job pushes `rechnungen-{web,caddy,einvoice-tools}:<commit SHA>`; put that SHA into
   `CADDY_TAG`/`WEB_TAG`/`EIT_TAG`.
4. Dry run, read the output: `deploy/bootstrap.sh` (default `--dry-run`; lookups only).
5. `deploy/bootstrap.sh --apply --skip convex` → project, compose, registry, env, deploy, DNS, backups.
   The caddy Service name is printed; **add the `<CADDY_SVC>` grants** from `deploy/tailnet-policy.hujson` now.
6. Admin key: Dokploy → compose `rechnungen` → `backend` → Terminal → `./generate_admin_key.sh` → `.env.production`
   `CONVEX_SELF_HOSTED_ADMIN_KEY` + CI secret `CONVEX_SELF_HOSTED_ADMIN_KEY`.
7. `deploy/bootstrap.sh --apply --only convex` → functions + Convex env (JWKS once Better Auth is in the code base).
8. Server scripts: `deploy/bootstrap.sh --apply --only backups --install-server-scripts`, then create
   `/opt/rechnungen/backup.env` (0600) by hand; trigger each schedule once in the Dokploy UI and check R2.
9. CI: variables `DEPLOY_ENABLED=true`, `BASE_DOMAIN`, `DOKPLOY_COMPOSE_ID` (printed by bootstrap), optional
   `SMOKE_EXTRA="https://app.<BASE_DOMAIN>/api/auth/ok"` once auth exists. Push to `main` → watch the `deploy` job.
10. Smoke by hand from a tailnet device: `https://app.<BASE_DOMAIN>/api/health`, `https://api.<BASE_DOMAIN>/api/health`,
    `https://convex-dash.<BASE_DOMAIN>` (basic auth), wildcard certificate issuer = Let's Encrypt.
11. Restore drill once ([restore.md](restore.md)).

## C. Go-live switch (end of P2, at the start of a VAT period — 08 §8.1, 09 checklist)

1. Full pilot export: `npx convex export --include-file-storage --path pilot-$(date +%F).zip` (with the pilot admin key)
   → upload to R2 `pilot-archive/`; keep it with the release notes (contains no real Belege).
2. `.env.production`: `INSTANCE_NAME=rechnungen`, **new** `INSTANCE_SECRET` (`openssl rand -hex 32`), new
   `BETTER_AUTH_SECRET`. Then `deploy/bootstrap.sh --apply --only env,deploy`. The `pg-init` service creates the
   database `rechnungen` automatically; the pilot database `rechnungen_pilot` stays untouched until you drop it.
3. New admin key (`./generate_admin_key.sh` in the backend container) → `.env.production` + CI secret.
4. The new instance starts with an empty Convex env → `deploy/bootstrap.sh --apply --only convex` deploys the
   functions, generates a new `JWKS` and sets every variable again.
5. Backups: `deploy/bootstrap.sh --apply --only backups` creates the postgres backup for database `rechnungen`;
   disable/remove the old `rechnungen_pilot` backup in the Dokploy UI (Backups tab of the compose).
6. The owner signs up again with `OWNER_EMAIL` (pilot passkeys are gone; the RP ID `BASE_DOMAIN` stays), runs the
   setup wizard, commits the final sevdesk import, re-invites members.
7. Checkpoints restart for the new instance (same `CHECKPOINT_SIGNING_KEY_PEM`; first checkpoint has
   `prevCheckpointHash = null` + instance name). **One restore drill before the first real invoice.**

## D. Rollback

- App deploy: the CI `deploy` job restores the previous `*_TAG` values automatically when the smoke test fails; by
  hand: Dokploy → compose → Environment → previous tags → Deploy.
- Go-live switch: set `INSTANCE_NAME=rechnungen-pilot` + the pilot `INSTANCE_SECRET` back and redeploy (the pilot DB
  is still there) — only before real documents exist.

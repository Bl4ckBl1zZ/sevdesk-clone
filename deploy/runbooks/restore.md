# Runbook: restore drill (monthly) and real restore

Source: 08 §7 (SEC-05, GOBD-09) · backups: Dokploy compose backup `postgres/` (daily 03:00, 30 kept),
`convex-export/` (daily 04:00, `convex-export.sh`), volume backup `convex-volume/` (weekly), `monthly/…` (10 years),
signed checkpoints in the checkpoint bucket.

## Drill (staging, never touches production)

1. **Staging environment:** Dokploy project `rechnungen` → environment `staging` with its own compose (same
   `deploy/compose/docker-compose.yml`), own `BASE_DOMAIN` (e.g. `staging.buero.example.de`) → own caddy Tailscale
   Service + DNS (`sync-dns.sh`). Run `deploy/bootstrap.sh --apply --env-file .env.staging --skip backups` with
   `DOKPLOY_ENVIRONMENT=staging` and **the production `INSTANCE_NAME` + `INSTANCE_SECRET`** (needed to read the data).
2. **Stop the staging backend** (Dokploy → compose → backend → Stop) so nothing writes during the restore.
3. **Restore Postgres:** Dokploy → staging compose → Backups → *Restore* → pick the latest `postgres/` file of the
   production destination → target service `postgres`, database `<INSTANCE_NAME with _>`.
   Without the UI: `rclone copy r2:dokploy/postgres/<file>.sql.gz .` → `gunzip -c <file> | docker exec -i <staging
   postgres container> psql -U convex -d <db>`.
4. **Restore file storage:** Volume Backups → Restore Volume `convex-volume/<latest>` into `<staging appName>_convex-data`
   (target volume must not be in use), or import the logical export instead of 3+4:
   `npx convex import --replace-all convex-export.zip` against `https://convex.staging.<domain>` (staging admin key).
5. Start the backend; `docker logs` must show a clean start (no migration errors).
6. **Integrity:** run `integrity.verify` (app: Einstellungen › System › Integrität, or `npx convex run
   integrity:verify`) → chain OK; compare the chain head (`lastSeq`, `lastHash`) with the production checkpoint of the
   same day in the checkpoint bucket (`checkpoints/YYYY/MM/DD.jws`).
7. Sign in with e-mail OTP (staging `BETTER_AUTH_SECRET`/`JWKS` differ → production sessions are invalid, intended).
   Open three archived documents, check PDF + XML hashes.
8. **Record the drill** in production: Einstellungen › System › Backups → "Restore-Test protokollieren" (date, backup
   file, result, chain head). Restores are audit-logged.
9. Stop the staging compose (keep it for the next drill) or delete it; remove its DNS records.

## Real restore (production lost)

1. Recreate the server/compose with `deploy/bootstrap.sh --apply` (same `.env.production`; a recreated compose gets a
   **new Tailscale Service + TailVIP** → `sync-dns.sh`, update the `<CADDY_SVC>` grants).
2. Before the first deploy finishes, stop `backend`, restore Postgres + volume as in steps 3–4, start `backend`.
3. Integrity verify + checkpoint comparison (step 6). Any gap between the last backup and the loss is documented in
   the Verfahrensdokumentation (incident) — finalised numbers must stay gap-free: check the number ranges.
4. Re-run `deploy/bootstrap.sh --apply --only backups` (new compose ID → new backup jobs).

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
   **Preflight (EXP-024, E-EXP-38):** before stopping it, `npx convex run restore:preflight` against the target must
   return `{ ok: true }` — a restore goes only into an **empty** instance („Wiederherstellung ist nur in eine leere
   Instanz möglich.").
3. **Restore Postgres:** Dokploy → staging compose → Backups → *Restore* → pick the latest `postgres/` file of the
   production destination → target service `postgres`, database `<INSTANCE_NAME with _>`.
   Without the UI: `rclone copy r2:dokploy/postgres/<file>.sql.gz .` → `gunzip -c <file> | docker exec -i <staging
   postgres container> psql -U convex -d <db>`.
4. **Restore file storage:** Volume Backups → Restore Volume `convex-volume/<latest>` into `<staging appName>_convex-data`
   (target volume must not be in use), or import the logical export instead of 3+4:
   `npx convex import --replace-all convex-export.zip` against `https://convex.staging.<domain>` (staging admin key).
5. Start the backend; `docker logs` must show a clean start (no migration errors).
6. **Integrity and restore record (EXP-024):** `npx convex run restore:complete '{"source":"<backup file>",
   "expected":{"seq":<seq>,"hash":"<hash>"}}'`. `expected` is the audit head of the backup: `auditHead` in
   `manifest.json` of a Vollexport taken at the same time, or `lastSeq`/`lastHash` of the production checkpoint of
   the backup day (`checkpoints/YYYY/MM/DD.jws`); omit it if neither matches the backup moment. The function
   verifies the whole chain, refuses a different head (E-EXP-40: „Prüfkette nach Wiederherstellung weicht ab …",
   integrity alert raised — do not continue), warns when the checkpoint bucket holds a newer checkpoint (E-EXP-41:
   the data after the backup must be re-entered) and writes `system.restore` as the first audit entry after the
   restored head, followed by the integrity run. A Vollexport (Export › Vollexport) is the readable copy with
   `SHA256SUMS.txt` (`sha256sum -c SHA256SUMS.txt`; a failing line = E-EXP-39 „Die Exportdatei ist beschädigt oder
   verändert") — it contains no `convex-snapshot.zip`, so the import itself always uses `convex-export/` or the
   Postgres/volume backup.
7. Sign in with e-mail OTP (staging `BETTER_AUTH_SECRET`/`JWKS` differ → production sessions are invalid, intended).
   Open three archived documents, check PDF + XML hashes.
8. **Record the drill** in production: Einstellungen › System › Backups → "Restore-Test protokollieren" (date, backup
   file, result, chain head). Restores are audit-logged.
9. Stop the staging compose (keep it for the next drill) or delete it; remove its DNS records.

## Real restore (production lost)

1. Recreate the server/compose with `deploy/bootstrap.sh --apply` (same `.env.production`; a recreated compose gets a
   **new Tailscale Service + TailVIP** → `sync-dns.sh`, update the `<CADDY_SVC>` grants).
2. Before the first deploy finishes, stop `backend`, restore Postgres + volume as in steps 3–4, start `backend`.
3. `restore:preflight` before step 2, `restore:complete` after it (step 6). Any gap between the last backup and the loss is documented in
   the Verfahrensdokumentation (incident) — finalised numbers must stay gap-free: check the number ranges.
4. Re-run `deploy/bootstrap.sh --apply --only backups` (new compose ID → new backup jobs).

# Runbook: upgrade the self-hosted Convex backend + dashboard

Source: 08 §8 · pinned: `CONVEX_SHA` in the Dokploy compose env (backend **and** dashboard use the same tag, linted by
`pnpm lint:deploy`), the dev/CI binary `precompiled-<date>-<sha7>` in `scripts/convex-local-backend.sh` and
`.github/workflows/ci.yml`, the npm package `convex` in `package.json`.

1. **Read the release notes** (github.com/get-convex/convex-backend releases, "self-hosted" changelog): breaking env
   changes, Postgres migrations, minimum `convex` npm version.
2. **Verify both images exist** for the new SHA (anonymous):
   ```bash
   SHA=<40-hex>
   for r in convex-backend convex-dashboard; do
     t=$(curl -fsS "https://ghcr.io/token?scope=repository:get-convex/$r:pull" | jq -r .token)
     curl -fsS -o /dev/null -w "$r %{http_code}\n" -H "Authorization: Bearer $t" \
       -H "Accept: application/vnd.oci.image.index.v1+json" "https://ghcr.io/v2/get-convex/$r/manifests/$SHA"
   done
   ```
3. **PR first:** bump `CONVEX_BACKEND_VERSION` (CI + `scripts/convex-local-backend.sh`) and, if required, `convex` in
   `package.json`; the `integration` job must stay green against the new backend binary.
4. **Backup now:** Dokploy → compose → Backups → postgres → *Run manually*; and a logical export
   (`npx convex export --include-file-storage --path pre-upgrade-$(date +%F).zip` with `CONVEX_SELF_HOSTED_URL` +
   admin key from a tailnet device). Keep the zip until the next restore drill.
5. **Bump** `CONVEX_SHA` in the Dokploy compose env (Dokploy UI → Environment, or `.env.production` +
   `deploy/bootstrap.sh --apply --only env`) → *Deploy*.
6. **Watch** `docker logs` of `backend`: wait for the migration to finish (`MigrationComplete` / "Ready"), no panics;
   dashboard loads at `https://convex-dash.<BASE_DOMAIN>`.
7. **Verify:** `integrity.verify` → chain OK; `https://app.<BASE_DOMAIN>/api/health`; sign-in (passkey + OTP);
   open a finalised document.
8. **Rollback:** a backend that has migrated its Postgres schema cannot always run an older SHA. Roll back by restoring
   the pre-upgrade Postgres backup into a stopped backend with the old `CONVEX_SHA` ([restore.md](restore.md) steps
   3–5) — never just downgrade the tag on migrated data.

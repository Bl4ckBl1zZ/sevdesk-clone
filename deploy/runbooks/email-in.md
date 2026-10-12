# Runbook: e-mail-in receipt inbox (Cloudflare Email Routing → Worker → R2) — P2

Source: 08 §3.4, F06 INB-048…052 · code: `deploy/cloudflare/receipts-inbox/` (Worker `receipts-inbox`, unit tests
T06-152 in `src/index.test.ts`) · CI: `.github/workflows/deploy-worker.yml`

The Worker stores the unaltered raw message as `inbox/<epochMs>-<uuid>.eml` (+ metadata `from`, `to`, `subject`,
`messageId`, `rawSize`) in the EU bucket `rechnungen-inbox`; it never parses, filters or deletes. Messages > 25 MiB
are rejected with „Nachricht zu groß (max. 25 MB) – bitte Rechnung in mehreren E-Mails oder als Link senden"
(EC-INB-25). The app polls the bucket every 5 min from inside the tailnet (`inbox.pollR2`).

## One-time setup

1. **Bucket** (EU, private, **no lifecycle rule** — an unimported mail must never expire):
   `pnpm dlx wrangler@4.149.0 r2 bucket create rechnungen-inbox --jurisdiction eu`
2. **Worker deploy token:** Cloudflare → API tokens → custom: *Workers Scripts: Edit* + *Workers R2 Storage: Edit*,
   this account only → GitHub secret `CLOUDFLARE_WORKERS_API_TOKEN`; variables `CLOUDFLARE_ACCOUNT_ID`,
   `WORKER_DEPLOY_ENABLED=true`.
3. **Deploy:** run the workflow *Deploy Email Worker* (or by hand:
   `CLOUDFLARE_API_TOKEN=… pnpm dlx wrangler@4.149.0 deploy --config deploy/cloudflare/receipts-inbox/wrangler.toml`).
   Dry run without credentials: `… deploy --dry-run --outdir /tmp/worker`.
4. **Email Routing** on the zone of the receiving domain: Email → Email Routing → enable for the subdomain (e.g.
   `in.example.de`; Cloudflare adds MX/SPF on the subdomain only, the main domain's mail is untouched) → Routing rules →
   custom address `belege@in.example.de` → action **Send to a Worker** → `receipts-inbox` (optional: catch-all of the
   subdomain → same Worker).
5. **App credentials:** R2 API token *Object Read & Write*, **scoped to `rechnungen-inbox` only** →
   `deploy/bootstrap.sh --apply --only convex` with `R2_INBOX_BUCKET`, `R2_INBOX_ACCESS_KEY_ID`,
   `R2_INBOX_SECRET_ACCESS_KEY` in `.env.production` (`R2_ACCOUNT_ENDPOINT` = the `.eu.` endpoint for an EU bucket).
6. Einstellungen › Posteingang → „Verbindung testen" + Cloudflare AVV confirmation (F01 SET-110, F06 INB-052).

## Smoke test

Send a mail with a PDF to `belege@in.example.de`. Within 5 min it appears in the Posteingang with the `.eml` as
original, and the object is gone from the bucket (`pnpm dlx wrangler@4.149.0 r2 object list rechnungen-inbox
--jurisdiction eu` or the dashboard). Worker logs: Cloudflare → Workers → receipts-inbox → Logs (observability on).

## P2 spike (open)

A failed `put` throws. Whether Email Routing then answers the sending MTA with a temporary failure (retry) or a
bounce is UNSURE (08 §3.4): send a test mail while the R2 binding points at a non-existent bucket; expected: retry or
bounce, never a silent drop. Record the result in 08 §3.4.

## Operations

- Objects older than 60 min or 3 failed polls → app notification (EC-INB-28); 401/403 → polling paused (EC-INB-29).
- Rotating the app token: new R2 token → Convex env → delete the old token.
- The Worker source is in git; recreating it is a redeploy. The bucket is a transient drop box (no backup needed).

# receipts-inbox Email Worker

Cloudflare Email Routing → this Worker → R2 `rechnungen-inbox/inbox/<epochMs>-<uuid>.eml` (08 §3.4, F06 INB-048).

- `src/index.ts` — the Worker (no parsing, no filtering, never deletes; > 25 MiB → `setReject`)
- `src/index.test.ts` — unit tests (T06-152, EC-INB-25), run with `pnpm test -p deploy`
- `wrangler.toml` — binding `INBOX` → bucket `rechnungen-inbox` (EU jurisdiction)

Setup, deployment and smoke test: [`deploy/runbooks/email-in.md`](../../runbooks/email-in.md).

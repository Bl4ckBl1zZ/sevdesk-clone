# 05 — REST API (tailnet-only), API Keys, Webhooks

> **Status:** v1.3 · 2026-10-23 (outbound webhooks built: §5 outbox, Standard Webhooks delivery, `/webhook-endpoints`, Einstellungen › Webhooks, API-028…API-031) · v1.2 · 2026-10-13 (P1 REST slice: requirement table §8, lower-case problem codes, `idempotency_in_progress`, PATCH version rule, webhooks not yet phased) · v1.1 · 2026-10-12 (platform update: tailnet-only `api.` host, website access via `tag:website` on port 8443, no inbound webhooks, rate limits per key, no IP allowlists, no e-mail sending; endpoints aligned with F04–F09 v1.1: export/mark-sent, cash payments and transfers, voucher payment methods, `/imports` lifecycle, ELSTER guides and submission records, dunning never sends) · Research: [`../research/14-auth-email-tailscale.md`](../research/14-auth-email-tailscale.md) §4.6, [`../research/05-nextjs-mcp-api.md`](../research/05-nextjs-mcp-api.md) §C
> **Goal:** integrate the business website and other tools (n8n, scripts) with everything the UI can do, under the same compliance rules. sevdesk only offers its API in the top plan and has no webhooks (research 02); we offer both.

## 1. Principles

1. **One domain layer.** REST handlers are thin: parse with zod → check scope → call the same Convex function the UI uses (with an `api-key:<keyId>` actor JWT) → map to the response. No business logic in route handlers.
2. **Same rules as the UI.** Drafts are free. Finalising, marking as sent, cancelling and correcting need dedicated scopes and are audited with the key name. Finalised data is never deleted (409).
3. **Predictable.** JSON only, `snake_case` fields, ISO dates (`YYYY-MM-DD`), RFC 3339 instants, integer minor units for money (`amount_cents`) plus a `currency` field.
4. **Safe retries.** Every `POST` accepts `Idempotency-Key`. Webhooks follow the Standard Webhooks spec.
5. **Self-describing.** OpenAPI 3.1 at `GET /api/openapi.json`, interactive docs (Scalar) at `/api/docs`. Generated from the same zod schemas (`zod-openapi`), so the docs cannot drift. CI fails if the generated spec differs from the committed `openapi.json` without a version note.

## 2. API keys and scopes

### 2.1 Key lifecycle (Einstellungen › API)

- Create (**owner only**, fresh session, 02 §4.3): name, channel (`api` / `mcp` / `both`), scopes (checkboxes grouped by area, plus presets), optional expiry, optional rate limit. There is **no IP allowlist**: behind the tailnet edge every request arrives from the fork's proxy address (02 §4.1); network restriction is done with tailnet grants instead (§6.1).
- The key is shown **once**: `sk_live_<43 chars base64url>`. The list shows `prefix…last4`, scopes, created, last used, expiry.
- Storage: `sha256(key)` hex with an index; the plaintext is never stored (SEC-02).
- Revoke takes effect immediately: every request re-checks the stored key in Convex, nothing is cached (EC-186). Revoking needs **no** fresh session, so a leaked key can be revoked at once; creating one does.
- Rotation: create the new key, switch the client, revoke the old one. Two keys may be active at the same time.
- Every request updates `lastUsedAt` (debounced: at most once a minute).

### 2.2 Scopes

| Scope | Grants |
|---|---|
| `contacts:read` / `contacts:write` | Contacts, addresses, channels, VAT-ID checks |
| `products:read` / `products:write` | Products, categories, customer prices |
| `documents:read` | Quotes, order confirmations, delivery notes, invoices, corrections, reminders, artifacts (PDF/XML download) |
| `documents:write` | Create/update/delete **drafts**, convert, duplicate, preview |
| `invoices:finalize` | Finalise documents (assign number; irreversible) |
| `invoices:send` | **The scope for marking as sent** (name kept for compatibility): `POST /{type}/{id}/mark-sent`, its retraction and bulk mark (F04 SND-07/18/20). Exporting files needs only `documents:read`. The app itself never transmits documents (02 §9) |
| `invoices:cancel` | Storno (`POST /invoices/{id}/cancel`, `/corrections/{id}/cancel`, self-billing objection); finalising a Rechnungskorrektur additionally needs `invoices:finalize` (F04 §7.1) |
| `payments:read` / `payments:write` | Record or reverse payments; open items |
| `dunning:write` | Create reminders, run dunning (drafts or finalise; never sends), withdraw reminders, pause/dispute dunning |
| `dunning:manage` | Create/update **dunning policies** (levels, deadlines, fees, interest, automation incl. auto-finalise of reminders — never sending, F05 DUN-001). Separate from `dunning:write` because a policy change alters what the daily `dunning.run` does without further confirmation. Reading policies needs `payments:read` |
| `vouchers:read` / `vouchers:write` | Purchase vouchers, inbox uploads |
| `banking:read` / `banking:write` | Bank accounts, transactions, imports, matching |
| `accounting:read` / `accounting:write` | Journal, accounts, assets, period locks, **recording tax submissions** (Transferticket; locks the period, F08 TAX-021/022) |
| `reports:read` | Reports (UStVA/ZM/EÜR/USt-Jahr sheets and Mein ELSTER guides, open items, revenue) |
| `exports:run` | DATEV, GDPdU and full exports |
| `imports:run` | Data migration from file exports (`/imports` lifecycle: sevdesk export files, lexoffice/generic CSV; F09 B4) |
| `settings:read` / `settings:write` | Company profile, number ranges, templates (write excludes secrets). Also covers the owner's **notifications** (`GET /notifications` = read, `POST /notifications/{id}/read` = write; F12) — deliberately no separate scope |
| `webhooks:manage` | Webhook endpoints |
| `audit:read` | Audit log |
| `projects:read` / `projects:write`, `time:write` | P4 |
| `portal:manage` | **Reserved** — portal links return with F10 (deferred while tailnet-only). Never offered in the key dialog until then |
| `company:public` | Read-only public company data (`GET /settings/company/public`: name, address, legal footer data, logo) for website footers/imprints; safe for keys used by a website backend (F01 SET-021) |

**Presets:**
- **Website** = `contacts:read contacts:write products:read documents:read documents:write payments:read`
- **Claude (MCP), safe** = all `:read` + `contacts:write products:write documents:write vouchers:write`
- **Claude (MCP), full** = Safe + `invoices:finalize invoices:send invoices:cancel payments:write dunning:write` (not `dunning:manage`; policies are changed in the UI or with an explicitly created key)
- **Read-only** = all `:read`

**Never grantable via API:** members, roles and invites, sign-in settings (passkeys, TOTP, sessions), API keys themselves, encryption secrets and integration credentials, purging data, restoring backups.

## 3. Conventions

| Topic | Rule |
|---|---|
| Base URL | `https://api.<BASE_DOMAIN>/api/v1` — **tailnet only**. Owner devices and tools use port 443; the website's server (`tag:website`) uses `https://api.<BASE_DOMAIN>:8443/api/v1`, a Caddy listener that serves only `/api/v1/**` (§6.1, 02 §4.1) |
| Auth | `Authorization: Bearer sk_live_…` (alternatively `X-API-Key`). Keys in query strings are rejected (400) |
| Content type | `application/json; charset=utf-8`. Uploads: `multipart/form-data` or a JSON body with `content_base64` (≤ 10 MB) |
| IDs | Prefixed opaque strings: `con_`, `adr_`, `chn_`, `act_`, `vck_`, `prd_`, `cpr_`, `pcat_`, `stm_`, `quo_`, `ord_`, `dln_`, `inv_` (all invoice types incl. **proforma**), `cor_`, `rem_`, `sbc_` (self-billing Gutschrift, P3), `rlt_` (archived receivables letter, F05), `rec_`, `rvo_` (recurring voucher template, F06), `pay_`, `opi_` (opening-balance open item, ACC-013), `vou_`, `inb_`, `bac_`, `btx_`, `csh_`, `jrn_`, `ast_`, `prj_`, `tim_`, `whe_`, `evt_`, `job_`, `dvx_` (DATEV export history, F09 EXP-009), `gdx_` (GDPdU package), settings objects `nrg_`, `lay_`, `lyv_`, `tpl_`, `pmt_`, `tag_`, `cfd_`, `cc_` (F01 §7.1). Encoded from Convex IDs; stable |
| Pagination | Cursor: `?limit=1..100 (default 25)&cursor=…`. Response: `{ "data": [...], "next_cursor": "…" \| null }` |
| Filtering | Explicit query params per resource (e.g. `status`, `contact_id`, `date_from`, `date_to`, `updated_since`, `q`). `updated_since` is supported everywhere for sync |
| Sorting | `?sort=field` / `-field`, from a whitelist per resource |
| Expansion | `?expand=contact,lines` (whitelisted) |
| Money | `{ "amount_cents": 119000, "currency": "EUR" }`, or `*_cents` fields next to a document-level `currency` |
| Unit prices | `unit_price` as a decimal **string** with ≤ 4 decimals (`"12.3450"`) to avoid float issues; quantities as a decimal string with ≤ 3 decimals |
| Dates | `YYYY-MM-DD`; instants RFC 3339 UTC |
| Idempotency | `Idempotency-Key: <uuid>` on POST (1–255 visible ASCII characters). Stored 24 h per key and API key. Same key + same method/path/query/body → same response replayed (`Idempotent-Replayed: true`). Same key + different request → 422 `idempotency_key_reused`. Same key while the first request still runs → 409 `idempotency_in_progress`. 5xx answers are not stored (the key is released for a retry) |
| Concurrency | Drafts and master data carry `version`. `PATCH` requires `If-Match: <version>` (or a `version` field); missing → 422 with `errors[].field = "version"`; mismatch → 409 `version_conflict` |
| Rate limits | **Per API key only** (client IPs are not visible behind the tailnet edge): default 120 requests/min per key (token bucket, burst 30), configurable per key. Headers `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`; 429 with `Retry-After` |
| Request ID | `X-Request-Id` echoed or generated. Written to the audit log |
| Versioning | URL major version (`/v1`). Additive changes only within v1. Deprecations are announced with a `Deprecation` and `Sunset` header ≥ 6 months ahead |
| CORS | Off by default. Per-key allowed origins can be configured for browser use of **publishable** endpoints only (see §6) |

### 3.1 Errors (RFC 9457 problem+json)

```json
{
  "type": "https://api.<BASE_DOMAIN>/problems/validation_failed",
  "title": "Die Rechnung kann nicht fertiggestellt werden.",
  "status": 422,
  "code": "validation_failed",
  "request_id": "req_01J…",
  "errors": [
    { "code": "supply_date_missing", "field": "supply_date", "rule": "UST-08",
      "message": "Leistungsdatum oder Leistungszeitraum fehlt." },
    { "code": "company_representative_missing", "field": "company.representatives", "rule": "MAIL-03",
      "message": "Geschäftsführer fehlt im Firmenprofil (Pflichtangabe nach § 35a GmbHG)." }
  ],
  "warnings": [ { "code": "generic_description", "field": "lines[2].name", "rule": "UST-07", "message": "…" } ]
}
```

| HTTP | `code` examples |
|---|---|
| 400 | `bad_request`, `key_in_query_not_allowed`, `invalid_expand` |
| 401 | `unauthorized` (missing/invalid/expired/revoked key; `WWW-Authenticate: Bearer`) |
| 403 | `insufficient_scope` (includes `required_scope`), `owner_only` |
| 404 | `not_found` (also for an ID with another resource's prefix) |
| 405 | `method_not_allowed` (with `Allow`) |
| 409 | `document_not_draft`, `version_conflict`, `period_locked`, `number_conflict`, `number_collision`, `immutable_record`, `upsert_ambiguous`, `contact_in_use`, `contact_merged`, `product_in_use`, `setup_incomplete`, `idempotency_in_progress` |
| 415 | `unsupported_media_type` (body not JSON) |
| 422 | `validation_failed` (payments: `errors[0].code` = the rule reason, e.g. `excess`, `cash_reason_required`, `warnings_unacknowledged`), `idempotency_key_reused`, `einvoice_validation_failed` (includes the KoSIT report summary), `cash_negative` (F07 CSH-026, AO-05) |
| 429 | `rate_limited` (with `Retry-After`) |
| 501 | `not_implemented` (catalog entry of a feature that has not shipped yet; MCP stubs) |
| 503 | `dependency_unavailable` (e.g. einvoice-tools down; finalisation is not attempted) |

`code` values are always lower-case `snake_case`. Upper-case names used elsewhere in the specs (`UPSERT_AMBIGUOUS`, `CONTACT_IN_USE`, `PRODUCT_IN_USE`, `OWNER_ONLY`, `FIELD_MANAGED_BY_BANK`, …) denote the same codes in lower case (`upsert_ambiguous`, …). `title` is German by default and English with `Accept-Language: en`; `errors[].field` uses the wire names (`payment_terms.due_days`, `channels[0].value`).

Every rule violation carries the compliance requirement ID (`rule`), so integrators can see *why*.

## 4. Resources and endpoints

> All list endpoints support `limit`, `cursor`, `updated_since`, plus the listed filters. The full request/response schemas live in OpenAPI. Feature behaviour is specified in the feature files (F01–F12).

### 4.1 Contacts (F02)

| Method | Path | Scope | Notes |
|---|---|---|---|
| GET | `/contacts` | contacts:read | Filters `q`, `role`, `status`, `vat_id`, `email`, `number`, `tag` |
| POST | `/contacts` | contacts:write | Upsert option: `?match=email\|vat_id\|number` (several keys in order allowed, e.g. `?match=vat_id,email`) updates/returns the existing contact instead of creating a duplicate (website sign-ups); ambiguous → 409 `UPSERT_AMBIGUOUS` |
| GET | `/contacts/{id}` | contacts:read | `expand=addresses,channels,persons,stats,vat_status` |
| PATCH | `/contacts/{id}` | contacts:write | |
| POST | `/contacts/{id}/archive` | contacts:write | No hard delete if documents exist; delete allowed only for contacts without any documents |
| GET/POST | `/contacts/{id}/addresses` | read/write | |
| PATCH/DELETE | `/contacts/{id}/addresses/{adr}` | contacts:write | Address snapshots on issued documents are unaffected (UST-03) |
| GET/POST | `/contacts/{id}/channels` | read/write | |
| POST | `/contacts/{id}/vat-id-checks` | contacts:write | Runs eVatR (qualified) or VIES; returns the stored evidence (MISC-04) |
| GET | `/contacts/{id}/open-items` | payments:read | |
| GET | `/contacts/{id}/activities` / POST | read/write | Notes, calls, tasks |

### 4.2 Products (F03)

| Method | Path | Scope |
|---|---|---|
| GET | `/products` (`q`, `active`, `category_id`, `type`) | products:read |
| POST | `/products` | products:write |
| GET/PATCH | `/products/{id}` | read/write |
| POST | `/products/{id}/archive` | products:write |
| GET/PUT | `/products/{id}/customer-prices` | read/write |
| GET | `/product-categories` / POST | read/write |

### 4.3 Sales documents (F04)

Each of `/quotes`, `/order-confirmations`, `/delivery-notes`, `/invoices` (incl. proforma), `/corrections`, `/reminders` and (P3) `/self-billing` shares this shape:

| Method | Path | Scope | Notes |
|---|---|---|---|
| GET | `/{type}` | documents:read | Filters `status` (stored lifecycle), `payment_status` (stored: `open\|partially_paid\|paid\|credited\|written_off`), `display_status` (derived, incl. `overdue` — overdue is never stored, 02 §6), `contact_id`, `date_from/to`, `due_from/to`, `number`, `q`, `invoice_type` (invoices: `standard\|advance\|partial\|final\|cancellation\|proforma`) |
| POST | `/{type}` | documents:write | Creates a **draft**. Body: contact (ID or inline upsert), lines, dates, texts, terms. Returns the draft with computed totals and the validation result |
| GET | `/{type}/{id}` | documents:read | `expand=lines,contact,payments,artifacts,chain` |
| PATCH | `/{type}/{id}` | documents:write | Drafts only; `If-Match` |
| DELETE | `/{type}/{id}` | documents:write | Drafts only (the deletion is audited with the content); otherwise 409 |
| POST | `/{type}/preview` | documents:read | **Dry run:** same body as create. Returns totals, validation errors/warnings, tax case, ER-03 decision, PDF preview URL (short-lived). Saves nothing |
| POST | `/{type}/{id}/preview-pdf` | documents:read | Rendered PDF of the draft (watermark "ENTWURF") |
| POST | `/{type}/{id}/finalize` | invoices:finalize (quotes, order confirmations, delivery notes, proforma: + documents:write; corrections: + invoices:cancel) | Body `{ version, document_date?, backdate_reason?, fx_rate?, overrides? }` (F04 §7.1). Runs the full pipeline (02-architecture §6). Returns number, artifacts status |
| POST | `/{type}/{id}/export` | documents:read | Files for sending (F04 SND-16/24): `{ files?, original?, reason? }` → 5-minute links reachable only inside the tailnet; original while unmarked, „Kopie" afterwards; audited `document.export`. Changes no status |
| POST | `/{type}/{id}/mark-sent` | invoices:send | „Als versendet markieren" (F04 SND-07/17): `{ sent_on, channel: "email_manual" \| "post" \| "hand" \| "upload_portal" \| "other", note?, artifacts[], einvoice_handed_over_electronically? }` → `sendLog` row; ER-03 enforced. **No endpoint transmits a document** (`/send` withdrawn) |
| POST | `/{type}/{id}/mark-sent/{sendLogId}/retract` | invoices:send | `{ reason }` (F04 SND-18) |
| GET | `/{type}/{id}/send-log` | documents:read | Marks, retractions and exports |
| GET | `/{type}/{id}/artifacts` | documents:read | Lists PDF/XML/validation reports with sha256 |
| GET | `/{type}/{id}/artifacts/{kind}` | documents:read | Download; later downloads of the PDF are stamped "Kopie" (UST-34); `?original=true` returns the archived original bytes |
| POST | `/{type}/{id}/duplicate` | documents:write | New draft |
| POST | `/{type}/{id}/convert` | documents:write | `{ to: "order_confirmation"\|"delivery_note"\|"invoice"\|"advance_invoice"\|"partial_invoice"\|"final_invoice", mode?, value? }` → new draft |
| POST | `/invoices/{id}/cancel` | invoices:cancel (+ invoices:finalize) | Creates and finalises the Stornorechnung (UST-30). Body `{ reason?, document_date?, dry_run? }`; `dry_run: true` returns the mirror preview; otherwise `Idempotency-Key` is required (400 `idempotency_key_required`) |
| POST | `/invoices/{id}/correct` | documents:write | Creates a correction **draft** (Rechnungskorrektur `kind: credit` with optional `changes`, or Rechnungsberichtigung `kind: rectification`) prefilled from the original (F04 §7.1) |
| POST | `/quotes/{id}/mark-accepted` / `mark-rejected` | documents:write | Manual status (portal acceptance returns with F10, deferred). `mark-accepted { date, accepted_by, channel: "email"\|"phone"\|"manual", note?, late? }`, `mark-rejected { date, reason? }` |
| POST | `/quotes/{id}/reopen` / `revise` | documents:write | `reopen { reason }` of a rejected quote; `revise { reason? }` → 201 with the new version's draft (QUO-06, number `<base>-V{n}` at finalisation) |
| POST | `/{type}/{id}/withdraw` | documents:write | Quotes, order confirmations, delivery notes, proforma: `{ reason }` → status `cancelled`, number stays used; 409 while finalised invoices exist in the chain (QUO-15) |
| POST | `/delivery-notes/{id}/mark-received` | documents:write | `{ date, received_by }` („Erhalten“, QUO-09) |
| GET | `/{type}/{id}/chain` | documents:read | The chain with invoicing progress (DOC-34); `expand=chain` on GET embeds it |
| GET/POST/PATCH | `/recurring-invoices[/{id}]` | documents:write | Templates; `POST /recurring-invoices/{id}/run-now` |

**Proforma** (F04 §4.2.4, §9.7): lives under `/invoices` with `invoice_type=proforma` (prefix `inv_`); finalising needs `documents:write` **and** `invoices:finalize`; it gets its own number range, no E-Rechnung XML, no journal entry, and is excluded from revenue reports, open items and dunning. Converting it to an invoice uses `POST /invoices/{id}/convert` with `to: "invoice"`.

**P1 implementation (2026-10-13, API-021):** `/quotes` (`quo_`), `/order-confirmations` (`ord_`), `/delivery-notes` (`dln_`) and `/invoices` (`inv_`; `invoice_type` `standard` or `proforma` in this slice — the list without `invoice_type` returns standard invoices) serve list (`status`, `contact_id`, `q`), create, get (`expand=chain`), patch (`lines` replaces all lines), delete, `finalize` (`Idempotency-Key` required), `convert` (`to`, `mode`, `lines [{source_line_id, quantity}]`, `optional_line_ids`, `accept_source`; on a delivery note `delivery_note_ids` builds the collective invoice, QUO-11), `withdraw`, plus the quote and delivery-note actions above. Line IDs are `lin_…`; quantities and unit prices are decimal strings (≤ 3 / ≤ 4 decimals); a free-text item line defaults to unit `C62`, `vat_rate_key: standard` and `product_type: service`; `product_id` copies name, price, unit and tax key from the product (DOC-05/06). Finalisation findings and guard reasons (`quote_not_accepted`, `quantity_exceeds_source`, `withdraw_has_invoices`, …) are listed in `errors[]` with `code`, `rule` and wire `field`. Not yet implemented: inline contact upsert, `POST /{type}/preview` (unsaved body), `preview-pdf`, `duplicate`, `artifacts`/`send-log` routes, the filters `payment_status`/`display_status`/dates, and the advance/partial/final invoice types (their slices).

**P1 implementation (2026-10-18, F04 preview/dispatch slice, API-022):** every document resource above plus `/corrections` (`cor_`) serves `POST /{type}/{id}/preview` (dry run of a saved draft with optional `document_date`/`backdate_reason`/`overrides`: `allowed`, `errors`/`warnings` with rule IDs, `totals`, `tax_case {value, reasons}`, `einvoice {decision, reason, format}`, `pdf_preview_url: null`, `confirm_token: null` — the token exists only for MCP), `POST /{type}/{id}/export` (`{ entry?, original?, reason? }`; `entry` = an SND-16 menu entry `default | zugferd_pdf | xml | xrechnung_with_reading | pdf | zip` instead of the `files[]` list of F04 §7.1 — the menu entries are what the export pipeline archives and audits; response `{ files: [{ artifact_id, name, url, sha256, mime }], zip_name }`), `POST /{type}/{id}/mark-sent` (`{ sent_on, channel, note?, artifacts: ["art_…"], einvoice_handed_over_electronically? }` — artifact ids as strings like the reminder route; the hashes are always copied from the archive, SND-22; `?dry_run=true` returns the §5.1.8 check) and `POST /{type}/{id}/mark-sent/{sendLogId}/retract` (`{ reason ≥ 10 }`). `Idempotency-Key` is required on mark-sent and retract (F04 §7.1 conventions); the older `/reminders/{id}/mark-sent` routes keep it optional. `/corrections/{id}/finalize` (invoices:finalize **and** invoices:cancel) finalises a Rechnungskorrektur. Mark-sent, original re-export and retraction rule violations are 422 `validation_failed` with the rule code in `errors[0].code`. Storno documents (`inv_`, type cancellation) are exported and marked through `/invoices/{id}/…`.

**Self-billing Gutschrift** (P3, F04 §4.2.8, §4.9, INV-16, §9.6): own resource `/self-billing` with prefix `sbc_`, the same shape as the other sales documents (draft CRUD, `preview`, `finalize` with `invoices:finalize`, `send`, artifacts). Finalisation requires a stored self-billing agreement with the supplier contact (`self_billing_agreement_missing` otherwise); TypeCode 389, title always „Gutschrift" (UST-11/33). The supplier's objection (Widerspruch) is `POST /self-billing/{id}/cancel` (`invoices:cancel`, body `{ reason, objection_date }`), which creates the mirror document.

**P3 implementation (2026-10-23, API-025):** `/self-billing` serves list, create, get, patch, delete, `preview`, `finalize` (`invoices:finalize` only — a Gutschrift is an invoice replacement, no `documents:write`), `export`, `mark-sent` (+ `…/retract`) and `POST /self-billing/{id}/cancel` (`invoices:cancel` + `invoices:finalize`, `Idempotency-Key` required; body `{ reason, objection_date }`; returns `{ cancellation_id, number, self_billing }`). No `convert`, `withdraw` or `chain` routes (a Gutschrift has no conversions; its only Storno is the objection). There is no `send` route (B2: export + mark-sent like every document).

### 4.4 Payments, dunning (F05)

F05 §7.1 is normative; summary:

| Method | Path | Scope |
|---|---|---|
| GET | `/payments`, `/payments/{id}` (filters `target_id`, `contact_id`, `source_kind`, `date_from/to`, `reversed`) | payments:read |
| POST | `/invoices/{id}/payments` | payments:write: `{ date, amount_cents, eur_amount_cents?, source, backdate_reason?, note?, differences?, excess?, acknowledge_warnings? }`; `source` = `{ kind: "bank", transaction_id } \| { kind: "clearing", account_id } \| { kind: "cash" }` (cash: date ≤ today, warning > 1 day back, `backdate_reason` mandatory > 10 days back, cash balance never negative; F05 PAY-061/062) |
| POST | `/payments` | payments:write: combined payment `{ source, date, allocations: [{ target: { kind, id }, amount_cents, differences? }] }` |
| POST | `/payments/preview` | payments:read: dry run of either body (validation, VAT corrections, journal lines, cash balance after); writes nothing |
| POST | `/payments/{id}/reverse` | payments:write (`{ reason }`) |
| GET | `/payments/{id}/receipt` | payments:read: Quittung PDF of a cash payment (archived on first call, „Kopie" afterwards; PAY-063). JSON `{ file_name, copy, content_type, content_base64 }` like the other file downloads of the JSON pipeline |
| POST | `/contacts/{id}/credit/apply` \| `/refund` | payments:write |
| POST | `/corrections/{id}/refund` (Erstattung einer Rechnungskorrektur, F05 PAY-033 b) | payments:write |
| GET | `/open-items` (`contact_id`, `overdue_only`, `as_of`, `bucket`), `/contacts/{id}/open-items` | payments:read |
| GET | `/dunning/preview` (`?date=`; planned actions + `confirm_token`) | payments:read |
| POST | `/dunning/run` | dunning:write (`{ dry_run, invoice_ids?, mode: "drafts" \| "finalize", confirm_token }`; `finalize` additionally needs invoices:finalize). Creates drafts or finalises reminders; **never sends** — finalised reminders are exported and marked sent like any document |
| POST | `/invoices/{id}/reminders` | dunning:write (draft; `finalize: true` + invoices:finalize) |
| GET | `/reminders`, `/reminders/{id}` | documents:read (sales-document shape §4.3, prefix `rem_`) |
| POST | `/reminders/{id}/finalize` | invoices:finalize |
| POST | `/reminders/{id}/export` | documents:read (archived artifacts, §4.3 export) |
| POST | `/reminders/{id}/mark-sent`, `/reminders/{id}/mark-sent/{sendLogId}/retract` | invoices:send (§4.3 mark-sent body; the reminder's Zugang starts from the mark) |
| POST | `/reminders/{id}/withdraw` | dunning:write (`{ reason, void_notice }`; with `void_notice` the archived notice is exported and marked via `mark-sent` with purpose `reminder_void_notice`) |
| POST | `/invoices/{id}/dunning` | dunning:write (`{ action: "pause" \| "resume" \| "dispute" \| "block" \| "unblock" \| "hand_over", reason?, until?, partner? }`) |
| POST | `/invoices/{id}/zugang`, `/reminders/{id}/zugang` | dunning:write (manual Zugang override `{ date, reason }`, PAY-052) |
| GET | `/dunning/interest`; POST `/dunning/collections-export` | payments:read; dunning:write |
| GET | `/dunning-policies` | payments:read |
| POST/PATCH | `/dunning-policies[/{id}]` | dunning:manage |
| POST | `/receivable-letters/preview` | payments:read: content of a Kontoauszug (PAY-005), Zahlungsbestätigung (PAY-048), Zinsforderung (DUN-028) or Mahnbescheid-Datenblatt (DUN-044); body `{ kind, contact_id+from+to \| payment_id \| invoice_id, … }`; writes nothing |
| POST | `/receivable-letters` | payments:read (like the Quittung, PAY-063): renders and archives the PDF (SHA-256, immutable) and returns `{ id: rlt_…, file_name, sha256, content_type, content_base64, data }` (`data` = DUN-044 JSON) |
| GET | `/receivable-letters?contact_id=\|invoice_id=` | payments:read (one filter required) |
| POST | `/receivable-letters/{id}/mark-sent` | dunning:write (`{ sent_on, channel, note? }`, once; `Idempotency-Key` required; never via MCP) |

**P1 implementation (2026-10-16, F05 dunning slice):** all rows above except `POST /dunning/collections-export` (DUN-042, SHOULD — not built yet). `/reminders` returns a dedicated reminder shape (`rem_…`, `status`, `level`, `invoice_id`, the claim `open_amount_cents`/`fee_cents`/`interest_cents`/`flat_fee_40_cents`/`total_cents`, `new_due_date`, `default_start_date`, `sent_on`, `zugang`, `version`) instead of the full §4.3 document shape; list filters `status`, `invoice_id`, `contact_id`; no `expand`, `preview`, `duplicate`, `send-log` or `artifacts` routes yet. The `confirm_token` of `GET /dunning/preview` is the plan digest (null when `date` is not today, because the run always evaluates today); `POST /dunning/run` requires it unless `dry_run`, and a changed plan answers `409 preview_outdated`. `POST /reminders/{id}/finalize` requires `Idempotency-Key` like the document finalisation. Export/mark-sent use the §4.3 bodies with `art_…` artifact ids and return `snd_…` send-log ids. `void_notice` on withdraw is accepted but no notice letter is generated yet (DUN-009 notice is SHOULD). `GET /dunning-policies` lists the §4.6 defaults with `id: null, seeded: true` until the first `POST` stores them.

### 4.5 Purchases, inbox (F06)

F06 §7.1 is normative; summary:

| Method | Path | Scope |
|---|---|---|
| POST | `/inbox-items` (multipart file(s) or JSON base64, optional `note`) | vouchers:write: the main "upload a receipt" endpoint |
| GET | `/inbox-items` / `{id}` | vouchers:read |
| POST | `/inbox-items/{id}/split` (`{ groups: [[0],[1,2]] }`) → 201 the new items; `/inbox-items/merge` (`{ ids: [inb_…, …] }`) → 201 the merged item (INB-009) | vouchers:write |
| GET | `/inbox-items/{id}/correction-request` (letter text, archived letter, marks; INB-046) | vouchers:read |
| POST | `/inbox-items/{id}/correction-request` (archive the letter PDF once → `{ text, artifact_id, sha256, url }`), `…/correction-request/mark-sent` (`{ sent_on, channel, note? }` → `{ send_log_id }`), `…/correction-request/mark-sent/{sendLogId}/retract` (`{ reason }`); mark-sent and retract need `Idempotency-Key` | vouchers:write |
| GET/POST | `/vouchers`, GET/PATCH/DELETE `/vouchers/{id}` (PATCH/DELETE on drafts; a finalised unlocked voucher only with `correction_reason`) | vouchers:read/write |
| POST | `/vouchers/{id}/finalize` | vouchers:write: `{ acknowledge_warnings?, payment?: { method: "bank" \| "card_pending" \| "cash" \| "private", date?, amount_cents?, backdate_reason?, note? } }` (F06 VOU-136…138; default `bank` = paid later via bank matching). `cash`/`private` write voucher, journal and payment in one transaction; a failed cash check books nothing. For corporations `private` posts to `shareholder.clearing` |
| POST | `/vouchers/{id}/payments` | vouchers:write + payments:write: later „Bar/Privat bezahlt" on an open voucher (same body as `payment`) |
| GET | `/vouchers/{id}/files`, `/vouchers/{id}/files/{n}` | vouchers:read (original bytes) |

### 4.6 Banking and cash (F07)

F07 §7 is normative; summary:

| Method | Path | Scope |
|---|---|---|
| GET | `/bank-accounts`, `/bank-accounts/{id}` (balances, data source, last poll) | banking:read |
| POST | `/bank-accounts/{id}/imports` (`format: camt053 \| mt940 \| revolut_csv \| csv`; the fallback when Enable Banking is not connected or a consent lapsed) | banking:write |
| GET | `/bank-connection` (Enable Banking consent status, `valid_until`, reminders, backoff; no secrets). Connecting, re-consent and „Jetzt abrufen" are **owner-only in the UI** (they need the owner's bank login or presence, F07 BNK-107); there is no sync endpoint (`POST /bank-accounts/{id}/sync` → `409 owner_presence_required`) | banking:read |
| GET | `/bank-transactions` (`account_id`, `status`, `source`, `date_from/to`, `q`) | banking:read |
| GET | `/bank-transactions/{id}/suggestions` (candidate targets use the same kinds as `match`; an outgoing debit's refund of a credit correction is `{ kind: "correction", id: "cor_…" }`, F07 BNK-041, 2026-10-18) | banking:read |
| POST | `/bank-transactions/{id}/match` (`{ targets: [{ kind: invoice \| opening_item \| credit \| payment \| correction, id, amount_cents, differences? }], remainder?: credit \| unallocated, acknowledge_warnings? }`; `correction` = refund of a Rechnungskorrektur from an outgoing debit, F05 PAY-033 b) | banking:write |
| POST | `/bank-transactions/{id}/unmatch` (`{ reason }`; F05 reversal of the transaction's payments, BNK-047) | payments:write |
| POST | `/bank-transactions/{id}/mark` (`private\|transfer\|cash_withdrawal\|ignored\|loan`) | banking:write |
| GET/POST/PATCH | `/matching-rules`, `/matching-rules/{id}` (prefix `mrl_`; always stored as `suggest`, BNK-054; action field `apply`) | GET banking:read, POST/PATCH banking:write (2026-10-19, F07 §11) |
| GET | `/cash` (balance + movements with running balance), `/cash/report` (PDF/CSV) | banking:read |
| POST | `/cash/transfers` (`{ kind: "deposit_to_bank" \| "private_withdrawal", date, amount_cents, bank_account_id?, note?, backdate_reason? }`; never-negative check, F07 CSH-024/026; ATM withdrawals into the till come from marking the bank debit, CSH-025), `/cash/transfers/{id}/reverse` (`{ reason }`) | banking:write |

Cash **receipts** are invoice payments with `source.kind = "cash"` (§4.4), cash-paid vouchers use the voucher `payment` (§4.5); there is no free cash entry (no POS, F07 CSH-029).

### 4.7 Accounting, tax, reports, exports, imports (F08, F09)

F08 §7 and F09 §7 are normative; summary:

| Method | Path | Scope |
|---|---|---|
| GET | `/journal-entries`, `/journal-entries/{id}`, `/ledger-accounts` | accounting:read |
| POST | `/journal-entries` (manual, P2), `/journal-entries/{id}/reverse` | accounting:write |
| GET/PUT | `/ledger-accounts/roles` (incl. `shareholder.clearing` for corporations) | accounting:read/write |
| GET | `/periods`; POST `/periods/{YYYY-MM}/lock` | accounting:read; accounting:write |
| GET/POST | `/assets` | accounting:read/write |
| GET | `/reports/ustva?period=2026-09\|2026-Q3` (Kennzahlen, drill-down, status) | reports:read |
| GET | `/reports/ustva/{period}/elster-guide` (Mein ELSTER steps: path, form year, fields with copy strings, checklist, `sheet_hash`, blockers; F08 TAX-020) | reports:read |
| POST | `/reports/ustva/{period}/submissions` (record the manual submission `{ submitted_on, transfer_ticket, protocol_base64?, cross_check_cents, sheet_hash, values_differ_reason? }` → locks the period; 409 `sheet_changed` / `cross_check_mismatch` / `transfer_ticket_required`), `/reports/ustva/{period}/corrections` | accounting:write |
| GET | `/reports/zm?period=`, `/reports/zm/{period}/elster-guide`; POST `/reports/zm/{period}/submissions` | reports:read; accounting:write |
| GET | `/reports/sondervorauszahlung?year=`; POST `/reports/sondervorauszahlung/{year}/submissions` (no lock) | reports:read; accounting:write |
| GET | `/reports/euer?year=`, `/reports/euer/{year}/elster-guide`; POST `/reports/euer/{year}/submissions` (locks the year; 409 `fiscal_year_not_ended` / `ustva_missing`) | reports:read; accounting:write |
| GET | `/reports/ust-annual?year=` (USt-Jahreserklärung worksheet + reconciliation + guide; no submission record, TAX-023) | reports:read |
| GET | `/reports/{ustva\|zm\|euer}/{period}/sheet.pdf\|.csv` | reports:read |
| GET | `/reports/bwa`, `/reports/susa`, `/reports/ledger`, `/reports/open-items`, `/reports/revenue?group_by=customer\|product\|month`, `/reports/anlagenspiegel`, `/reports/thresholds`, `/reports/tax-reserve`, `/reports/cashflow-forecast` | reports:read |
| POST | `/exports/gdpdu` (`{ year }`), `/exports/full` → job | exports:run |
| POST | `/exports/datev` (`{ from, to, include, mode, lock_period }`), `/exports/datev/validate` → job (P3, low priority: for a future advisor) | exports:run |
| GET | `/jobs/{id}` (status, progress, download URL) | any scope of the job's kind |
| POST | `/imports` (`{ source: "sevdesk_export" \| "lexoffice_csv" \| "generic_csv" }` → import project) | imports:run |
| POST/PATCH/DELETE | `/imports/{id}/files[/{fileId}]` (upload CSV/ZIP/PDF/XML, correct the detected kind, remove before commit) | imports:run |
| PUT | `/imports/{id}/mapping`, `/imports/{id}/resolutions`; GET `/imports/mapping-presets` | imports:run |
| POST | `/imports/{id}/preview` (counts, errors, warnings, duplicates, file matches, **proposed number ranges** `next = max + 1`, open items; returns `previewHash`) | imports:run |
| POST | `/imports/{id}/commit` (`{ previewHash, number_ranges: [{ type, format, next }], buchungsbeginn?, acknowledge }`; 409 `preview_stale`; `Idempotency-Key` required), `/imports/{id}/discard` | imports:run |
| GET | `/imports/{id}`, `/imports/{id}/report.pdf` (import protocol, IMP-024) | imports:run |
| POST | `/imports/csv` (shortcut for generic/lexoffice CSV with the same lifecycle) | imports:run |

There is **no sevdesk API import** (`POST /imports/sevdesk` withdrawn, F09 B4) and **no ELSTER transmission** endpoint (ERiC is a P4 option); the owner submits in Mein ELSTER and records the Transferticket.

**P3 implementation (2026-10-23, reports/exports slice, API-023/API-024):** `GET /reports/euer?year=` (Anlage EÜR lines with Kz, sums, AVEÜR, notices, blockers, filing status; drill-down rows as `seq`/`date`/`cents`/`text`; Bilanz companies 409), `/reports/bwa?month=&variant=accrual|cash&cost_center_id=`, `/reports/susa?from=&to=&account_class=&include_personal=`, `/reports/ledger?account=&from=&to=` and `/reports/open-items?side=debtors|creditors&as_of=` (items `inv_`/`cor_`/`opi_` or `vou_`, aging buckets, reconciliation with the account balance) return the F08 values with `meta` (parameters, `generated_at`, rule versions, locked months, `provisional`). `GET /reports/{ustva|zm|euer}/{period}/sheet.pdf|.csv` returns `{ file_name, content_type, sha256, content_base64 }` (JSON pipeline like the payment receipt; audited `export.kennzahlen`). Exports: `POST /exports/datev/validate` (report only), `POST /exports/datev` (`{ from, to, include?, mode = "new", lock_period = false, festschreibung?, confirm_replace? }`: validates first — a blocking report answers 422 `validation_failed` with `report`, an export already running for an overlapping range 409 `conflict` (E-EXP-20) — then 202 `{ job_id, status: "queued" }`; `lock_period` locks the months first, EXP-011), `GET /exports/datev` (history, `dvx_…`), `GET /exports/datev/{id}/file?test_confirmed=true` (link to the stored ZIP; without the advisor acceptance and without `test_confirmed` 422 `datev_test_confirmation_required`, EXP-016), `POST /exports/gdpdu` (`{ year, include_files = true, encoding = "utf8" }`) and `POST /exports/full` (`encrypt_to_age_recipient` → 501 until the age encryption ships) → 202 job; `GET /jobs/{id}` returns status, progress and the 30-day result link of the key's own job (another key's job is 404); any read scope or `exports:run` grants the route. Not yet implemented: `/reports/revenue`, `/reports/anlagenspiegel`, `/reports/thresholds`, `/reports/cashflow-forecast`, `/reports/ustva|zm` JSON and guides, `GET /exports/{kind}/csv`. Export jobs emit `export.completed` / `job.failed` (§5.3).

### 4.8 Settings and meta

| Method | Path | Scope |
|---|---|---|
| GET | `/settings/company` | settings:read |
| GET | `/settings/number-ranges`, `/settings/text-templates`, `/settings/layouts`, `/settings/units`, `/settings/payment-methods`, `/settings/tax-rates?date=` | settings:read |
| PATCH | `/settings/company` (no secrets) | settings:write |
| GET | `/me` | any: key name, scopes, rate limit, server time, app version |
| GET | `/health` | none (no key needed): `{ status, version }` only |

### 4.9 Audit

| Method | Path | Scope |
|---|---|---|
| GET | `/audit-log` (`actor`, `entity_type`, `entity_id`, `from`, `to`, `action`) | audit:read |

### 4.10 Further endpoints defined in the feature specs

The feature files are normative for these endpoints (request/response details there and in OpenAPI). They follow all conventions of §3.

| Area | Endpoints | Scope |
|---|---|---|
| Contacts (F02 §7) | `DELETE /contacts/{id}` (unreferenced only), `POST /contacts/{id}/unarchive`, `GET /contacts/{id}/persons`, `POST /vat-id-checks` (ad hoc, without contact), `GET /contacts/{id}/vat-id-checks`, `PUT /contacts/{id}/reverse-charge-certificate`, `POST /contacts/{id}/pdf-consent[/revoke]`, `GET /contacts/{id}/stats`, `GET /contacts/duplicates`, `POST /contacts/{id}/merge[/undo]`, `POST /contacts/import`, `POST /exports/contacts`, `GET /contacts/next-number` | contacts:read / contacts:write |
| Products (F03 §7) | `DELETE /products/{id}` (unreferenced only), `POST /products/{id}/unarchive`, `GET /products/{id}/price`, `POST /products/{id}/scheduled-price`, `GET /settings/vat-rate-keys`, `POST /products/import`, `POST /exports/products`, stock endpoints (P4) | products:read / products:write |
| Sales documents (F04 §7.1) | `POST /{type}/{id}/preview`, `GET /{type}/{id}/chain`, `POST /corrections/{id}/cancel` (invoices:cancel), `POST /quotes/{id}/revise\|withdraw`, `POST /delivery-notes/{id}/mark-received`, `POST /invoices/{id}/retry-artifacts` (invoices:finalize), `POST /recurring-invoices/{id}/pause\|resume`, `GET /recurring-invoices/{id}/occurrences`, `POST /documents/bulk/export` (documents:read), `POST /documents/bulk/mark-sent` (invoices:send), `POST /documents/bulk/zip` (documents:read) | as listed, else documents:read / documents:write |
| Payments, dunning (F05 §7) | all listed in §4.4 (incl. reminder export/mark-sent; there is no `/reminders/{id}/send`) | §4.4 |
| Purchases (F06 §7) | `POST /vouchers/{id}/files` (add/replace with reason), `POST /inbox-items/{id}/correction-request` + `/correction-request/mark-sent[/{sendLogId}/retract]` (supplier correction letter, exported and marked like a document), `POST /vouchers/{id}/cancel`, `POST /vouchers/{id}/bewirtung/approve`, `POST /vouchers/{id}/eigenbeleg/approve`, `POST /vouchers/{id}/duplicate-resolution`, `GET /vouchers/missing-receipts`, `POST /inbox-items/{id}/reject\|split`, `POST /inbox-items/merge`, `GET/POST/PATCH /recurring-vouchers[/{id}]` | vouchers:read / vouchers:write |
| Banking, cash (F07 §7) | `GET /bank-transactions/{id}`, `POST /bank-transactions/{id}/unmatch`, `POST /bank-transactions/{id}/voucher`, `POST /bank-transactions/{id}/reversal-link`, `POST /bank-transactions/duplicates/{id}/resolve`, `POST /bank-accounts/{id}/imports/{importId}/rollback`, `GET /bank-accounts/{id}/statements` (monthly signed PDF + CAMT.053, EC-156), `POST /matching-rules/preview`, `GET /cash/report` | banking:read / banking:write |
| Accounting, tax (F08 §7) | `GET/POST /journal-entries/{id}[/reverse]`, `GET/PUT /ledger-accounts/roles`, `POST /opening-balances`, `GET /periods`, `POST /assets/{id}/dispose`, `POST /assets/depreciation-runs`, tax reports and submission records as in §4.7 | accounting:read / accounting:write / reports:read |
| Exports, imports (F09 §7) | `GET /exports/datev[/{id}/file]` (P3), `GET /exports/{kind}/csv` (read scope of the list), the `/imports` lifecycle in §4.7 | exports:run / imports:run |
| Portal, online payments (F10) | **Deferred** (needs public exposure; F10 status). None of its endpoints, nor the provider webhooks `/api/webhooks/*`, exist while the deployment is tailnet-only | — |
| Projects, time (F11 §7, P4) | `/projects[/{id}]`, `/projects/{id}/archive`, `/projects/{id}/profitability`, `/time-entries[/{id}]`, `/timer/start\|stop`, `GET /timer`, `POST /invoices/from-time-entries` (documents:write) | projects:read / projects:write / time:write |
| Settings (F01 §7.1) | `/settings/company/{public,versions,compliance}`, `GET /settings/tax` (writes owner-only → 403 `OWNER_ONLY`), `GET /settings/setup`, `/bank-accounts` (invoice accounts; the Enable Banking connection is owner-only in the UI), `/settings/number-ranges[/{id}][/preview\|/deactivate]`, `/settings/number-register[/gaps]`, `/settings/layouts…`, `/settings/text-templates…`, `/settings/placeholders`, `/settings/units…`, `/settings/payment-methods…`, `/settings/tags…`, `/settings/custom-fields…`, `/settings/cost-centers…`, `/settings/integrations…` (read-only status; credentials live in the Convex env), `/settings/external-services`, `/settings/rules`, `/settings/rule-overrides` (writes owner-only), `/settings/system[/integrity-check]` | settings:read / settings:write (`/settings/company/public`: also `company:public`) |
| Members (02 §4.3) | none — members, roles and invites are UI-only (owner) | — |
| Audit, integrity, privacy (F12 §7) | `GET /audit-log/verify`, `GET /integrity/runs`, `GET /integrity/checkpoints` (audit:read); `GET /notifications`, `POST /notifications/{id}/read` (settings:read / settings:write); `GET /dsgvo-requests` (settings:read, read-only: erasure and purge are never executable via the API) | as listed |

> **SEPA direct debit (pain.008)** belongs to F10 and is deferred with it.

## 5. Webhooks

> **Phase:** built 2026-10-23 (the owner asked to finish all phases; API-028…API-031). Outbox `webhookEvents` + `webhookDeliveries` written by `emitEvent()` in `convex/model/webhooks.ts` in the same transaction as the state change; delivery by the scheduled action `webhooksNode.deliver` (job `webhooks.deliver`) plus the sweep cron `webhooks.sweep` (every 5 min: overdue retries, expired claims, 30-day log purge); endpoints in `webhookEndpoints`. `webhooks:manage` grants `/webhook-endpoints` (owner keys only). Portal events (F10) stay reserved and are never emitted.

### 5.1 Endpoints (Einstellungen › Webhooks or `/webhook-endpoints`)

- Webhooks are **outbound only** (the server calls the receiver over the internet or the tailnet; nothing calls in). There are no inbound webhook routes (no bank or payment-provider webhooks).
- Fields: URL (HTTPS required in production), description, subscribed event types (or `*`), enabled.
- The secret `whsec_…` is shown once. "Roll secret" keeps the old secret valid for 24 h, and both signatures are sent.
- Delivery log per endpoint: last 30 days, request/response snippets, "Erneut senden" (replay).
- An endpoint returning **410 Gone** is disabled automatically. After 3 days of consecutive failures it is disabled and the owner is notified.
- **Implementation (2026-10-23).** UI: Einstellungen › Webhooks (owner; list, „Endpunkt hinzufügen“ with an event picker grouped by area or „Alle Ereignisse“, edit, „Test senden“ → `test.ping`, „Secret erneuern“, „Zustellprotokoll“ with „Erneut senden“, delete). REST: `GET|POST /webhook-endpoints`, `GET|PATCH|DELETE /webhook-endpoints/{id}` (`whe_…`), `POST /webhook-endpoints/{id}/roll-secret`, `POST /webhook-endpoints/{id}/test` (202), `GET /webhook-endpoints/{id}/deliveries` (`whd_…`), `POST /webhook-endpoints/{id}/deliveries/{delivery_id}/replay` (202) — scope `webhooks:manage`; these manage where the server *sends* events and receive nothing (BNK-108 test pins the paths to that scope). At most 20 endpoints. The secret is `whsec_` + Base64 of 24 random bytes, stored AES-256-GCM encrypted with `APP_ENCRYPTION_KEY` like the other secrets; lists show only `whsec_…` + last 4. Re-enabling a disabled endpoint resets its failure clock; disabling or deleting cancels its pending deliveries. Every change is audited (`webhook.endpoint.*`, `webhook.delivery.replay`); the automatic disable raises the ALARM notification `webhook.disabled` (F12 §4.8).
- **Target policy / SSRF guard (decision 2026-10-23, API-031).** §5.1 allows receivers "over the internet or the tailnet", so in production (`SITE_URL` not a local development host) a URL must be `https://`, carry no user info and not name a local host (`localhost`, `*.localhost`, `*.local`, `*.internal`, `*.home.arpa`, `*.localdomain`, IP literals that are not public/tailnet). Before **every** attempt the host is resolved and **every** resolved address must be public or tailnet (`100.64.0.0/10`, Tailscale ULA `fd7a:115c:a1e0::/48`); loopback, RFC 1918, other ULAs, link-local (incl. the metadata service `169.254.169.254`), reserved, multicast and IPv4-mapped/NAT64/6to4 forms of refused IPv4 addresses are refused and the attempt fails with „Adresse nicht erlaubt (internes Netz)“. Redirects are never followed (`redirect: "manual"`, 3xx = failed attempt). Residual risk: DNS rebinding between the check and the connect (Node `fetch` resolves again); acceptable because the receiver set is chosen by the owner and internal services need their own auth anyway. Development (local `SITE_URL`) allows `http://` and local receivers.

### 5.2 Delivery (Standard Webhooks)

- Headers: `webhook-id` (stable per event, the receiver's idempotency key), `webhook-timestamp` (Unix seconds), `webhook-signature: v1,<base64(HMAC-SHA256(secret, id.timestamp.body))>`.
- Body: `{ "type": "invoice.paid", "id": "evt_…", "created_at": "…", "data": { "object": { …resource as in GET… }, "previous": { …changed fields… } } }`.
- Success = any 2xx within 15 s. No redirects are followed.
- Retries with jitter: immediately, 5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 14 h, 20 h, 24 h. `Retry-After` is honoured.
- Outbox pattern: the event is written in the **same Convex transaction** as the state change, and a scheduled action delivers it. A crash between the commit and the delivery cannot lose events.
- Ordering is not guaranteed. Receivers should use `data.object.updated_at` or fetch the resource.
- **Payload (decision 2026-10-23).** `data.object` is a *reference object*, not the full GET resource: `id` (wire prefix, e.g. `inv_…`), `object`, statuses, numbers, dates and amounts of business documents (`documentObject`: `status`, `number`, `payment_status`, `artifact_status`, `total_gross_cents`, `open_amount_cents`, `order_reference`, `buyer_reference`, `contact_id`, `updated_at`, …) and IDs of related records — never names, addresses, e-mails, IBANs, file names or free text (F02 §7, DSGVO-05). Updates carry `data.previous.changed_fields` (field **names**) or the previous status. Receivers fetch details with their API key. `id` = `evt_…` = `webhook-id`, identical on replays.
- **Retry details.** 10 attempts on the schedule above with ±10 % jitter; then the delivery is `gave_up`. `Retry-After` (seconds or HTTP date) can only postpone the next attempt (capped at 24 h). Attempts are claimed with a 60 s lease so the cron and the scheduler never deliver twice concurrently. "3 days of consecutive failures" counts from the endpoint's first failure after its last success (`failingSince`). `test.ping` is attempted once and never retried; it also reaches disabled endpoints. Request/response snippets (1 KB) are kept with each delivery for 30 days. No outbox row is written when no enabled endpoint subscribes to the event.

### 5.3 Event catalog

| Event | When |
|---|---|
| `contact.created`, `contact.updated`, `contact.archived`, `contact.unarchived`, `contact.merged`, `contact.deleted`, `contact.vat_id_checked` | F02 §7; payloads carry IDs and changed field names, no personal values |
| `contact.credit_changed` | Customer credit balance changed (F05 PAY-060) |
| `product.created`, `product.updated`, `product.archived`, `product.deleted`, `product.price_scheduled`, `product.stock_low` (P4) | F03 §7 |
| `quote.created`, `quote.finalized`, `quote.sent`, `quote.sent_retracted`, `quote.accepted`, `quote.rejected`, `quote.expired` | |
| `order_confirmation.finalized`, `delivery_note.finalized` | |
| `invoice.created` (draft), `invoice.finalized`, `invoice.sent` (first effective sent mark), `invoice.sent_retracted`, `invoice.paid`, `invoice.partially_paid`, `invoice.overdue` (emitted once per document by `receivables.refreshOverdue`; overdue itself is derived, not stored), `invoice.cancelled`, `invoice.corrected` | |
| `invoice.artifacts_ready`, `invoice.artifacts_blocked` | After the PDF/XML pipeline |
| `reminder.finalized`, `reminder.sent`, `reminder.sent_retracted` | `*.sent` = first effective „Als versendet markieren" (F04 SND-15); the app transmits nothing |
| `dunning_case.paused`, `dunning_case.handed_over` | F05 PAY-060 |
| `payment.recorded`, `payment.reversed` | |
| `voucher.created`, `voucher.finalized`, `inbox_item.received`, `inbox_item.needs_review` | F06 |
| `bank_transaction.imported`, `bank_transaction.matched`, `bank_transaction.reversal_linked`, `bank_consent.expiring` (T−14/−3/0), `bank_consent.expired`, `bank_statement.reconciled`, `cash_movement.recorded` | F07 BNK-080 (P2) |
| `period.locked`, `tax_filing.submitted` (a submission record was entered: UStVA, ZM, Sondervorauszahlung, EÜR), `tax_filing.correction_required`, `threshold.warning` | F08 §7 |
| `settings.company.updated`, `settings.tax.updated`, `settings.number_range.updated` | F01 §7.1 |
| `quote.viewed`, `invoice.viewed`, `quote.change_requested`, `contract.withdrawn`, `payment.pending`, `payment.failed`, `payment.disputed`, `sepa.returned` | Reserved for the portal and online payments (F10, deferred) — never emitted while deferred |
| `time_entry.created`, `project.budget_threshold` | F11 (P4) |
| `export.completed`, `import.previewed`, `import.completed`, `job.failed` | F09 §7 (clients may also poll `GET /jobs/{id}` / `GET /imports/{id}`) |
| `integrity.check_failed` | Security-relevant; always sent to every endpoint subscribed to `*` |
| `api_key.revoked`, `member.invited`, `member.removed`, `dsgvo.request_overdue`, `backup.stale` | F12 §7 (EC-186); `api_key.revoked` is security-relevant like `integrity.check_failed` |
| `test.ping` | "Test senden" button |

**Emission notes (2026-10-23).** `*.sent` only on the first effective mark, `*.sent_retracted` when the document returns to finalised; `invoice.corrected` accompanies `invoice.finalized` of a Rechnungskorrektur. `payment.recorded` also covers refunds (negative amount) and is followed by `contact.credit_changed` when the customer credit moves; a reversal emits `payment.reversed` and the recomputed `invoice.partially_paid`/`invoice.paid`. `product.updated` is also emitted for restore and for an applied scheduled price. `threshold.warning` is emitted when a Kleinunternehmer threshold crossing is confirmed (other threshold states are derived on read). `tax_filing.correction_required` is emitted when a submission record is entered as „abweichend übermittelt“ (submitted values differ from the computed ones). `backup.stale` is emitted by each daily backup check while the newest backup is stale; `integrity.check_failed` by each failing chain verification (with `first_broken_seq`). `member.removed` covers disable and expiry. `bank_consent.expiring` carries `days_before` (14, 3, 0).

### 5.4 Verifying (example for the website, Node)

```ts
import { Webhook } from "standardwebhooks";
const wh = new Webhook(process.env.RECHNUNG_WEBHOOK_SECRET!); // "whsec_…"
export async function POST(req: Request) {
  const body = await req.text();                                  // raw body, do not re-serialise
  const event = wh.verify(body, Object.fromEntries(req.headers)) as { type: string; data: any };
  if (event.type === "invoice.paid") await markOrderPaid(event.data.object.order_reference);
  return new Response(null, { status: 204 });
}
```

## 6. Website integration recipes

1. **Contact form → contact + quote draft:** `POST /contacts?match=email`, then `POST /quotes` with the requested products (key preset "Website"). The owner reviews and sends the quote from the app. A webhook `quote.accepted` (when the owner marks the quote accepted) can trigger an onboarding flow.
2. **Shop checkout → invoice:** after payment succeeds on the website, `POST /invoices` with `Idempotency-Key = order id`, then `POST /invoices/{id}/finalize` (key with `invoices:finalize invoices:send`), fetch the files with `POST /invoices/{id}/export` (links valid 5 min, reachable from the tailnet-joined website server), e-mail them **from the website's own mailer**, and record that with `POST /invoices/{id}/mark-sent` (`channel: "email_manual"`) — the app itself sends nothing. Record the payment with `POST /invoices/{id}/payments` (`source.kind = "clearing"`, the clearing account for the payment provider). Consumer rules apply automatically (gross prices, B2C notes, OSS block if EU B2C is over the threshold).
3. **Product catalogue on the website:** `GET /products?active=true&updated_since=…` from the website **server** (never expose the key in the browser). Cache with ISR.
4. **Customer area:** the website shows invoice data it fetched server-side (`GET /invoices?contact_id=…`, documents read scope) and serves the archived PDFs itself; portal links return only with F10 (deferred).

> **Never put an API key in browser JavaScript.** All calls go server-to-server (the API is not reachable from the internet anyway). CORS is off.

### 6.1 Network access for the website (tailnet)

The API has no public host. The website's **server** joins the owner's tailnet (research 14 §4.6):
1. Create a **tagged, pre-authorised, non-ephemeral** auth key with `tag:website` (for containers: the `tailscale/tailscale` sidecar or `tsnet`/userspace mode). Serverless hosting (Vercel, Workers) cannot easily join a tailnet; the website needs a small always-on server (UNSURE for 2026 offerings).
2. Tailnet policy (grants), with the Caddy Tailscale Service name from the fork (`svc:dokploy-<project>-<env>-<resource>-caddy-<8>`):
   ```json
   { "grants": [
     { "src": ["autogroup:admin"], "dst": ["svc:dokploy-rechnungen-production-rechnungen-caddy-<id>"], "ip": ["tcp:443", "tcp:8443"] },
     { "src": ["tag:website"],     "dst": ["svc:dokploy-rechnungen-production-rechnungen-caddy-<id>"], "ip": ["tcp:8443"] },
     { "src": ["tag:ci"],          "dst": ["svc:dokploy-rechnungen-production-rechnungen-caddy-<id>"], "ip": ["tcp:443"] } ] }
   ```
3. The website calls `https://api.<BASE_DOMAIN>:8443/api/v1/…` with an API key from the **Website** preset. Port 8443 serves only `api.` + `/api/v1/**`; the UI, MCP, Convex and the dashboard are unreachable from `tag:website`. A separate port is required because grants apply per Service and port, not per hostname.
4. **Tailscale Funnel is not recommended** (public, `*.ts.net` names only, contradicts "no public host").
5. Rate limiting is per API key (§3); the website's key should have its own `rateLimitPerMinute`.

## 7. Implementation notes

- One catch-all route `src/app/api/v1/[...path]/route.ts` dispatches to an **endpoint registry** (`src/server/api/resources/*`, `defineResource` + `defineEndpoint({ method, path, scope, params, query, body, response, handler })`). The pipeline (`src/server/api/dispatch.ts`) handles: request id, key extraction (header only), server-JWT minting (`api-key:<keyId>` with the key hash, 02 §4.4), `apiKeys.authorize` (verifies hash/channel/expiry/revocation, takes a token from the key's bucket, stamps last use), `RateLimit-*` headers and 429, the fail-fast scope check, zod parsing, `Idempotency-Key`, the error mapping to problem+json, `X-Request-Id`, and the access log `apiRequestLog` (no bodies; no client IP is available behind the tailnet edge).
- Wire schemas live in `src/domain/schemas/api/*` and map 1:1 onto the form schemas the UI uses; Convex adapters (`convex/contactsApi.ts`, `productsApi.ts`, `settingsApi.ts`) call the same model functions. Handlers contain no business rules.
- The OpenAPI document is built in `src/server/openapi.ts` from the registry and the zod schemas with `.meta({ id, description, example })` and served at `/api/openapi.json` (Scalar at `/api/docs`). `pnpm openapi:check` compares it with the committed `src/server/openapi.snapshot.json`.
- **Contract tests** (Vitest, `test/server/**`, server project) call the real pipeline with the Convex calls running in convex-test under the identity the server JWT would carry.
- **E2E** (Playwright `request` fixture) covers the 4 website recipes against a real Convex backend.

## 8. Requirements

| ID | Requirement | Priority | Phase |
|---|---|---|---|
| API-001 | Keys are `sk_live_` + 43 base64url characters from 32 random bytes; only the SHA-256 is stored; the public id `key_<8>` is the actor id; the key is shown once | MUST | P1 |
| API-002 | Scopes (§2.2) and presets (Website, Claude safe, Claude full, Read-only); creation only by the owner with a fresh session; reserved and never-grantable scopes are refused | MUST | P1 |
| API-003 | Expiry and revocation take effect on the key's next request; revocation needs no fresh session and is audited (EC-186) | MUST | P1 |
| API-004 | The key is read from `Authorization: Bearer` or `X-API-Key`; a credential in the query string is refused with 400 `key_in_query_not_allowed` | MUST | P1 |
| API-005 | Scope check in Next (fail fast, 403 `insufficient_scope` with `required_scope`) and in Convex (authoritative, intersected with the stored key) | MUST | P1 |
| API-006 | `web` exchanges the key for a 60 s server JWT (`api-key:<id>` / `mcp:<id>`) carrying the key hash; Convex refuses tokens whose hash differs from the stored key | MUST | P1 |
| API-007 | Rate limit per key only (token bucket, default 120/min, burst = rate/4, configurable); `RateLimit-*` headers on every response, 429 with `Retry-After` | MUST | P1 |
| API-008 | Every REST and MCP request is written to the access log (method, target, status, duration, request id, code; no bodies, no IP); `lastUsedAt` debounced to once a minute | MUST | P1 |
| API-009 | Errors are RFC 9457 problem+json with lower-case codes, German/English titles, `request_id` and wire-named `errors[].field` | MUST | P1 |
| API-010 | `Idempotency-Key` on POST: stored 24 h per API key, replay with `Idempotent-Replayed`, 422 on reuse with another request, 409 while in progress | MUST | P1 |
| API-011 | Wire conventions: snake_case, prefixed opaque IDs, ISO dates, RFC 3339 instants, unit prices/factors as decimal strings, integer minor units | MUST | P1 |
| API-012 | Cursor pagination (`limit` 1–100, `next_cursor`), per-resource filters and `updated_since` for sync | MUST | P1 |
| API-013 | `expand` is whitelisted per resource; unknown values → 400 `invalid_expand` | MUST | P1 |
| API-014 | OpenAPI 3.1 generated from the zod schemas at `/api/openapi.json`, Scalar docs at `/api/docs`, snapshot-checked in CI | MUST | P1 |
| API-015 | Concurrency and conflicts: PATCH needs `version`/`If-Match` (409 `version_conflict`); state conflicts map to 409 codes | MUST | P1 |
| API-016 | `GET /health` without a key (`{ status, version }` only); `GET /me` with any key (name, scopes, rate limit, server time, version) | MUST | P1 |
| API-017 | Contacts: list/get/create/update/archive, `?match=` upsert by e-mail/VAT ID/number (409 `upsert_ambiguous`), `vat-id-checks`; restricted contacts are invisible | MUST | P1 |
| API-018 | Products: list/get/create/update/archive, price resolution (PRD-032) and categories, with today's price block on every product | MUST | P1 |
| API-019 | Settings reads: company, public company subset (`company:public` or `settings:read`), number ranges, text templates, layouts, units, payment methods, tax rates on a date | MUST | P1 |
| API-020 | Host separation: `api.` serves only the allowlisted paths, port 8443 only `/api/v1/**`, `app.` never serves API paths (02 §4.1) | MUST | P1 |
| API-022 | Finalise preview, export, mark-sent (`?dry_run`) and retraction for every sales document incl. corrections and Storno; `/corrections/{id}/finalize`; nothing transmits a document | MUST | P1 |
| API-021 | Sales documents (§4.3): quotes, order confirmations, delivery notes and invoices incl. proforma — draft CRUD, finalisation with required `Idempotency-Key` (letters additionally need `documents:write`), acceptance/rejection/reopen/revise, „Erhalten“, withdrawal, conversions incl. the collective invoice, and the chain | MUST | P1 |
| API-023 | Read-only reports over REST (§4.7): EÜR, BWA, SuSa, Kontenblatt and OPOS with the F08 values and `meta`; Kennzahlen sheets (UStVA/ZM/EÜR) as PDF/CSV, audited | MUST | P3 |
| API-025 | Self-billing Gutschrift over REST (§4.3, P3): `/self-billing` (`sbc_`) draft CRUD, preview, finalisation (`invoices:finalize`, `Idempotency-Key`, agreement required), export, mark-sent/retract and the objection `POST /self-billing/{id}/cancel` (`invoices:cancel` + `invoices:finalize`); no conversions or withdrawal | SHOULD | P3 |
| API-026 | Receivables letters over REST (§4.4, F05 PAY-005/PAY-048/DUN-028/DUN-044): preview, generate + archive (PDF with SHA-256, DUN-044 JSON), list per contact or invoice, one-time mark-sent (`dunning:write`, `Idempotency-Key`); nothing is sent | SHOULD | P2 |
| API-027 | Inbox split/merge (INB-009) and the supplier correction request (INB-046) over REST (§4.5): text, archived letter PDF, mark-sent and retraction with `Idempotency-Key`; nothing is sent | SHOULD | P2 |
| API-024 | Exports over REST (§4.7): DATEV dry run, export job (blocking report → 422, overlap → 409, `lock_period`), history and stored ZIP with the „Testexport“ confirmation; GDPdU and full export jobs; `GET /jobs/{id}` for the key's own jobs | MUST | P3 |
| API-028 | Webhook endpoints (§5.1): owner-only (`webhooks.read/manage`, key scope `webhooks:manage`), URL + description + events or `*` + enabled; reserved F10 events refused; `whsec_` secret shown once and stored encrypted; roll with 24 h overlap and both signatures; „Test senden“ (`test.ping`); manual disable/delete cancel pending deliveries; UI Einstellungen › Webhooks and REST `/webhook-endpoints` | SHOULD | P4 |
| API-029 | Webhook delivery (§5.2): Standard Webhooks headers and HMAC-SHA256 signature, 15 s timeout, no redirects, any 2xx = success; retry schedule with jitter and `Retry-After`; 410 → disabled; 3 days of failures → disabled + ALARM `webhook.disabled`; 30-day delivery log with snippets and replay (same `webhook-id`) | SHOULD | P4 |
| API-030 | Webhook outbox (§5.2/§5.3): every catalogued event that exists today is written by `emitEvent()` in the same transaction as the state change, only for subscribed enabled endpoints; payloads are reference objects without personal values; portal events are never emitted | SHOULD | P4 |
| API-031 | Webhook target policy (§5.1): in production HTTPS only, no user info, no local names; every resolved address must be public or tailnet, checked before every attempt (loopback, private, link-local/metadata, reserved and embedded-IPv4 forms refused) | MUST | P4 |

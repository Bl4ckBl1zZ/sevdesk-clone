# 06 — MCP Server (manage everything with Claude)

> **Status:** v1.2 · 2026-10-13 (P1 MCP slice: requirement table §8, auth via the shared REST key check, safe preset and ⚠ master-data tools clarified) · v1.1 · 2026-10-12 (platform update: tailnet-only endpoint; supported clients are Claude Code and Claude Desktop via `mcp-remote` on a tailnet device; claude.ai web/mobile/custom connectors are not supported; tools aligned with F04–F09 v1.1: export + mark-sent instead of send, cash payments and transfers, voucher payment methods, ELSTER guide, dunning never sends) · Research: [`../research/05-nextjs-mcp-api.md`](../research/05-nextjs-mcp-api.md) §B, [`../research/14-auth-email-tailscale.md`](../research/14-auth-email-tailscale.md) §4.5
> **Goal:** Claude (Claude Code and Claude Desktop on a device inside the owner's tailnet, §6) can fully manage customers, products, quotes, invoices, payments, receipts, banking and reports. It must never be able to break GoBD rules or send something legally binding without the owner's explicit approval.

## 1. Transport and protocol

| Item | Choice |
|---|---|
| Endpoint | `https://api.<BASE_DOMAIN>/api/mcp` — **tailnet only** (port 443 of the Caddy edge; not on the website's port 8443, 05 §6.1) |
| Library | `mcp-handler` 2.x on `@modelcontextprotocol/server` 2.x |
| Spec | MCP **2026-07-28** (stateless; no sessions). The handler falls back for 2025-era Streamable HTTP clients |
| Auth | `Authorization: Bearer sk_live_…` API key with channel `mcp` or `both` (same key store and scopes as REST, [05-api.md §2](05-api.md#2-api-keys-and-scopes)). Verified by the shared REST key check (`src/server/api/auth.ts`: hash-bound server JWT, `apiKeys.authorize`, per-key rate limit) in front of mcp-handler, which then receives `req.auth`; `withMcpAuth` is not used because it would turn a 429 into a 401. 401 carries `WWW-Authenticate: Bearer` (no RFC 9728 resource metadata: there is no OAuth) |
| OAuth | **None.** All supported clients send the API key as a header. OAuth would only matter for claude.ai connectors, which cannot reach a tailnet anyway (§6); Better Auth's OAuth-provider plugin also breaks the Convex component today (#395) |
| Host/Origin validation | Enabled (DNS-rebinding protection) |
| Rate limit | Per API key (shares the key's REST limit; default 120/min). Never per IP (02 §4.1) |
| Output | `structuredContent` (matches `outputSchema`) **plus** a JSON text block for older clients. Lists default to 20 items, with `response_format: "concise" \| "detailed"` |
| Size | Responses ≤ 20k tokens. Larger results are paginated or summarised (Claude Code truncates at 25k) |
| Server instructions | ≤ 2,048 chars: domain primer (German invoicing terms, draft → finalise → export → owner sends → mark as sent workflow (the app never sends documents), never invent tax IDs, ask before finalising) |

## 2. Safety model

1. **Drafts are free; legal acts need approval.** Every legally relevant (⚠) tool — `document_finalize`, `document_mark_sent`, `invoice_cancel`, `dunning_run`, `payment_record`, `payment_reverse`, `bank_match_confirm`, `bank_transaction_mark`, `bank_statement_import` (commit), `cash_transfer_record`, `voucher_finalize`, `contact_merge`, `export_datev` (it can lock a period) and any future purge/erasure tool — needs **all four**: the matching scope, `destructiveHint: true`, `_meta["anthropic/requiresUserInteraction"]: true` (Claude Code asks every time) and a valid `confirm_token` (item 3). Purges and DSGVO erasure are currently **not exposed via MCP at all** (F12); if such a tool is ever added it falls under this rule. The tool list is filtered by scope: with the "Claude (MCP), safe" preset the legal-act tools (finalise, mark sent, cancel, payments, dunning, bank, DATEV) are not listed because it lacks their scopes. ⚠ tools on master data whose scope the safe preset holds (`contact_merge`, `voucher_finalize`) stay listed but still need the confirm token and the client's approval prompt (clarified 2026-10-13; the earlier wording contradicted the scopes in F02 §7.2).
2. **Preview before commit.** `document_preview` returns totals, validation results, tax case, ER-03 decision and a short-lived PDF preview link. The server instructions tell Claude to show the preview before calling `document_finalize`.
3. **Confirmation tokens for every ⚠ tool.** Each ⚠ tool requires a `confirm_token` from a preview with the **matching intent**: `document_preview` with `intent: "finalize" | "cancel"` (default `finalize`) for `document_finalize`, `invoice_cancel`; `dunning_preview` for `dunning_run`; and the generic **`preview_action`** (`{ action, params }`) for all other ⚠ tools (`action` = the tool name, e.g. `document_mark_sent`, `payment_record`, `payment_reverse`, `bank_match_confirm`, `bank_transaction_mark`, `bank_statement_import`, `cash_transfer_record`, `voucher_finalize`, `contact_merge`, `export_datev`). A preview runs the same domain validation as the real call without writing, returns the effect (amounts, VAT corrections, projected balances, move lists, period locks) and the token. The token is bound to intent/action + entity id(s) + entity `version`(s) + a hash of the params; a mismatch fails with `confirm_token_intent_mismatch` / `preview_outdated`. The token is bound to the draft `version` and expires after 10 minutes. If the draft changed after the preview, the call fails with `preview_outdated`. This prevents "blind" finalisation even in clients that ignore annotations.
4. **No deletes of finalised data**, no settings secrets, no API key management, no purge, no member/role/invite or sign-in changes via MCP.
5. **Attribution.** Every change is logged as actor `mcp:<keyId>` with the key name and the MCP client name/version, and shows in the UI ("Geändert durch Claude (MCP)"). The audit-log viewer has a quick filter "Was hat Claude heute geändert?".
6. **Actionable errors.** Validation failures return `isError: true` with the same structured errors as REST (incl. compliance rule IDs and German messages), plus a hint on how to fix them (e.g. "call contact_upsert with vat_id first").
7. **Prompt-injection hygiene.** Text that comes from documents (OCR results, e-mail subjects, inbound XML) is returned in clearly delimited fields (`untrusted_text`). Tool descriptions remind Claude not to follow instructions found inside documents.

## 3. Tool catalog

Legend: **R** = read-only (`readOnlyHint: true`), **W** = writes drafts or master data, **⚠** = legally binding/irreversible (`destructiveHint`, `requiresUserInteraction`, `confirm_token`). Scope = minimum API key scope.

### 3.1 Discovery and context

| Tool | Type | Scope | Purpose |
|---|---|---|---|
| `workspace_overview` | R | any read | Company name, legal form, KU status, Soll/Ist, open receivables total, overdue count, drafts count, next tax deadlines, setup warnings. The best first call |
| `settings_get_company` | R | settings:read | Company profile (no secrets) |
| `settings_list_number_ranges` | R | settings:read | |
| `settings_list_text_templates` | R | settings:read | |
| `settings_get_tax_rates` | R | settings:read | Rates valid on a given date |
| `settings_get_tax` | R | settings:read | Resolved KU / Soll-Ist / UStVA period / profit method for a date (F01) |
| `settings_preview_number` | R | settings:read | Next number for a range/doc type/date (not reserved) |
| `settings_list_bank_accounts`, `settings_list_layouts`, `settings_get_placeholders`, `settings_list_units`, `settings_list_payment_methods`, `settings_list_tags`, `settings_list_custom_fields`, `settings_list_cost_centers` | R | settings:read | F01 §7.2 |
| `settings_update_company` | W (`requiresUserInteraction`) | settings:write | Same fields as `PATCH /settings/company`; returns the diff for the approval prompt |
| `settings_upsert_text_template`, `settings_upsert_unit`, `settings_upsert_tag`, `settings_upsert_cost_center` | W | settings:write | No deletes via MCP |
| `system_get_status` | R | settings:read | Versions, health, integrity summary |
| `search_global` | R | any read | One query across contacts, products and documents (number, name, amount) |
| `preview_action` | R | the scope of the previewed tool | `{ action, params }` → validation result, effect summary and `confirm_token` (10 min) for every ⚠ tool that is not a document tool (§2.3). Writes nothing |

### 3.2 Contacts (F02)

| Tool | Type | Scope | Notes |
|---|---|---|---|
| `contact_search` | R | contacts:read | `query`, `role`, `status`, `limit`, `cursor` |
| `contact_get` | R | contacts:read | Incl. addresses, channels, VAT-ID status, stats (revenue, open, avg days-to-pay) |
| `contact_upsert` | W | contacts:write | Create or update. Dedupe by e-mail / VAT ID / number; returns `matched_existing` |
| `contact_add_address` | W | contacts:write | |
| `contact_check_vat_id` | W | contacts:write | Runs BZSt eVatR / VIES and stores the evidence |
| `contact_add_note` | W | contacts:write | Activity timeline entry (note/call/task) |
| `contact_open_items` | R | payments:read | |
| `contact_add_channel` | W | contacts:write | |
| `contact_list_activities` | R | contacts:read | Timeline incl. derived events |
| `contact_get_stats` | R | contacts:read | F02 §5.9 |
| `contact_find_duplicates` | R | contacts:read | |
| `contact_merge` | ⚠ | contacts:write | Token from `preview_action{action:"contact_merge"}`, which returns the move list shown in the approval prompt (F02) |
| `contact_archive` | W | contacts:write | Reversible; no delete tool |
| `contact_set_pdf_consent` | W (`requiresUserInteraction`) | contacts:write | Consent is a legal record (MAIL-01); the owner confirms date and source |

### 3.3 Products (F03)

| Tool | Type | Scope |
|---|---|---|
| `product_search` | R | products:read |
| `product_get` | R | products:read |
| `product_upsert` | W | products:write |
| `product_set_customer_price` | W | products:write |
| `product_resolve_price` | R | products:read |
| `product_list_categories` | R | products:read |
| `product_archive` | W | products:write |
| `product_adjust_stock` (P4) | W | products:write |

### 3.4 Sales documents (F04)

| Tool | Type | Scope | Notes |
|---|---|---|---|
| `document_search` | R | documents:read | `type`, `status`, `payment_status`, `contact`, `date range`, `q` |
| `document_get` | R | documents:read | Lines, totals, chain, payments, send log, artifact status |
| `quote_create_draft` | W | documents:write | Contact by ID **or** inline (`contact: { name, email, … }` → upsert). Lines by product ID or free text |
| `invoice_create_draft` | W | documents:write | `invoice_type: standard\|advance\|partial\|final`, `supply_date` (date/period/month) required |
| `document_update_draft` | W | documents:write | Patch fields; requires `version` |
| `document_add_lines` / `document_remove_lines` | W | documents:write | |
| `document_convert` | W | documents:write | Quote → order confirmation / delivery note / invoice / advance / partial / final (→ new draft) |
| `document_duplicate` | W | documents:write | |
| `document_preview` | R | documents:read | `intent: "finalize" \| "cancel"` (default `finalize`). Totals, validation (errors/warnings with rule IDs), tax case + explanation, ER-03 decision, PDF preview URL (5 min), **`confirm_token`** bound to id + version + intent. With `intent: "cancel"` on a finalised invoice it returns the **Storno mirror preview** (lines, totals, number range, document date, INV-10 guard results) and the token for `invoice_cancel` (F04 §7.2) |
| `document_finalize` | ⚠ | invoices:finalize | Requires `confirm_token`. Returns the number and artifact status |
| `document_export` | W (writes only the `document.export` audit entry; not ⚠, transmits nothing) | documents:read | 5-minute links (tailnet only) to the files for sending, for the owner to download (F04 SND-16/24) |
| `document_mark_sent` | ⚠ | invoices:send | „Als versendet markieren" after the owner confirms how and when they sent it (channel `email_manual`/`post`/`hand`/`upload_portal`/`other`, F04 SND-07/17). Requires `confirm_token` from `preview_action { action: "document_mark_sent", params }`. The app never sends documents; there is **no send tool** (`document_send` withdrawn, EC-189) |
| `document_get_pdf_link` | R | documents:read | Short-lived signed download link (the archived original or a "Kopie") |
| `invoice_cancel` | ⚠ | invoices:cancel (+ invoices:finalize) | Storno with reason. Requires a `confirm_token` from `document_preview` with `intent: "cancel"` |
| `invoice_create_correction` | W | documents:write | Correction draft (finalising it goes through `document_finalize`) |
| `quote_mark_accepted` / `quote_mark_rejected` | W | documents:write | |
| `recurring_invoice_upsert` | W | documents:write | Create/update a template (auto-finalising needs `invoices:finalize` on the **key that created it** + a UI confirmation on first activation; templates never send, F04 REC-16) |
| `recurring_invoice_list` | R | documents:read | |

**P1 implementation (2026-10-13, MCP-011):** `document_search` (one `type` per call: quote, order_confirmation, delivery_note, invoice, proforma; `status`, `contact_id`, `q`), `document_get` (incl. the chain with invoicing progress), `quote_create_draft` (contact by ID; inline upsert via `contact_upsert` first), `invoice_create_draft` (`invoice_type: standard | proforma` in this slice), `document_update_draft`, `document_convert` (incl. `delivery_note_ids` for the collective invoice) and `quote_mark_accepted` / `quote_mark_rejected` share the REST wire schemas and handlers (05 §4.3, API-021). `document_finalize` and the `finalize` intent of `document_preview` follow with the preview slice; until then drafts created via MCP are finalised in the UI or via REST.

### 3.5 Receivables, payments, dunning (F05)

| Tool | Type | Scope |
|---|---|---|
| `receivables_open_items` | R | payments:read |
| `payment_list` | R | payments:read |
| `payment_record` | ⚠ | payments:write. Same body as REST `POST /payments` (05 §4.4); source `bank`, `clearing` or **`cash`** — cash follows F05 PAY-061: date ≤ today, the daily-recording warning (> 1 day back) is returned verbatim, `backdate_reason` (≥ 5 characters) is required > 10 days back, the cash balance must stay ≥ 0 at every date, never in a locked period. Token from `preview_action { action: "payment_record" }` (= `POST /payments/preview`: allocation, differences, VAT corrections, cash balance after); the token binds source, date and amounts. Never invent payments: record only what the owner stated |
| `payment_reverse` | ⚠ | payments:write; token from `preview_action` |
| `dunning_preview` | R | payments:read (returns `confirm_token`) |
| `dunning_run` | ⚠ | dunning:write (+ invoices:finalize for `mode: "finalize"`). `{ confirm_token, invoice_ids?, mode: "drafts" \| "finalize" }`: creates reminder drafts or finalises reminders as planned by `dunning_preview`; **never sends** — finalised reminders are exported with `document_export` and marked with `document_mark_sent` after the owner sent them (F05 §7.2) |
| `reminder_create` | W | dunning:write (draft) |

### 3.6 Purchases and inbox (F06)

| Tool | Type | Scope | Notes |
|---|---|---|---|
| `inbox_list` | R | vouchers:read | |
| `voucher_create_from_file` | W | vouchers:write | `file_base64` + `filename` (≤ 10 MB) or `inbox_item_id`. Runs classification (XML → ZUGFeRD → OCR) and returns the extracted draft |
| `voucher_search` / `voucher_get` | R | vouchers:read | |
| `voucher_update_draft` | W | vouchers:write | |
| `voucher_finalize` | ⚠ | vouchers:write | Books the voucher and assigns the Belegnummer; optional `payment { method: bank \| card_pending \| cash \| private, date?, amount_cents?, backdate_reason? }` (F06 VOU-136…138). Token from `preview_action`; the preview shows the payment and the resulting cash balance, and the token binds method, date and amount |

### 3.7 Banking and cash (F07)

| Tool | Type | Scope |
|---|---|---|
| `bank_accounts_list` | R | banking:read (incl. Enable Banking consent status and last poll; **no fetch/sync tool** — a fetch needs the signed-in owner, F07 BNK-107) |
| `bank_transactions_search` | R | banking:read |
| `bank_match_suggestions` | R | banking:read |
| `bank_match_confirm` | ⚠ | banking:write; token from `preview_action` |
| `bank_transaction_mark` (`private`/`transfer`/`ignored`) | ⚠ | banking:write; token from `preview_action` |
| `matching_rule_upsert` | W | banking:write |
| `bank_statement_import` | W (dry run by default); commit ⚠ | banking:write. Statement file (CAMT.053/MT940/CSV + optional signed PDF) → dry run with counts, duplicates, continuity and reconciliation; the commit needs a token from `preview_action { action: "bank_statement_import" }` bound to the file hash (F07 §7). The fallback when Enable Banking is not connected |
| `cash_transfer_record` | ⚠ | banking:write. `{ kind: deposit_to_bank \| private_withdrawal, date, amount_cents, note?, backdate_reason?, confirm_token }`; token from `preview_action` (projected cash balance, never negative, dating rules of F07 CSH-021/024/026). Cash receipts are `payment_record` with source `cash`; there is no free cash entry (no POS) |

### 3.8 Accounting, tax, reports (F08)

| Tool | Type | Scope |
|---|---|---|
| `report_ustva_values` | R | reports:read: Kennzahlen for a period + drill-down summary |
| `report_zm` | R | reports:read |
| `report_euer` | R | reports:read |
| `report_elster_guide` | R | reports:read: `{ form: ustva \| ustva_correction \| zm \| sondervorauszahlung \| euer \| ust_annual, period }` → the Mein ELSTER steps (path, form year, fields with copy strings, checklist, blockers; F08 TAX-020) so Claude can walk the owner through the submission. **Never records a submission** — the Transferticket is entered by the owner in the UI (or REST) |
| `report_ust_annual` | R | reports:read: `{ year }` → USt-Jahreserklärung worksheet + reconciliation with the submitted UStVAs (F08 TAX-023) |
| `report_open_items` | R | reports:read |
| `report_revenue` | R | reports:read (`group_by: customer\|product\|month`) |
| `tax_reserve_estimate` | R | reports:read (clearly labelled estimate) |
| `cashflow_forecast` | R | reports:read |
| `journal_search` | R | accounting:read |
| `kleinunternehmer_status` | R | reports:read |

Not exposed via MCP (owner-only legal acts in the UI; F08 §7): recording tax submissions (UStVA, ZM, Sondervorauszahlung, EÜR), period locks, manual journal entries, opening balances, role mapping, asset disposal; no ERiC transmission (P4). Imports (F09) have no MCP tools either.

### 3.9 Exports, audit, projects

| Tool | Type | Scope |
|---|---|---|
| `export_datev` | ⚠ | exports:run (it can lock the period; token from `preview_action`, which runs the DATEV validation; the job result is a download link) |
| `audit_log_search` | R | audit:read |
| `project_upsert` (P4) | W | projects:write |
| `time_entry_log` (P4) | W | time:write: "2h on project X: workshop" |
| `time_unbilled_list` (P4) | R | projects:read |
| `invoice_from_time_entries` (P4) | W | documents:write (draft) |

## 4. Resources and prompts

**Resources** (read-only, for clients that support them):
- `rechnung://company`: company profile summary
- `rechnung://documents/{id}`: the document as JSON
- `rechnung://documents/{id}/pdf`: a PDF blob (≤ 5 MB)
- `rechnung://rules/legal-notes`: the current legal note texts per tax case (to explain to the user why a note appears)

**Prompts** (slash commands in clients):

| Prompt | Does |
|---|---|
| `/angebot` | Guided quote creation: customer → items → preview → (optional) finalise, export and mark as sent after the owner sent it |
| `/rechnung-aus-angebot` | Convert an accepted quote into an invoice (asks: full / advance % / partial) |
| `/monatsabschluss` | Month-end checklist: unbooked receipts, unmatched transactions, overdue invoices, drafts, UStVA values → shows the list and suggests the actions |
| `/mahnlauf` | Dunning preview → confirm |
| `/belege-verarbeiten` | Work through the inbox: extract → suggest the account → confirm |

## 5. Example conversation flow

```
User: "Schreib Müller GmbH eine Rechnung über 3 Workshop-Tage à 1.200 € netto, Leistung war letzte Woche."
Claude → contact_search {query:"Müller GmbH"}                      → con_8f…
Claude → product_search {query:"Workshop"}                          → prd_2a… (Tagessatz, HUR? DAY)
Claude → invoice_create_draft {contact_id, supply_date:{kind:"period",from:"2026-10-05",to:"2026-10-09"},
                               lines:[{product_id:"prd_2a…", quantity:"3", unit_price:"1200.0000"}]}
Claude → document_preview {id}  → totals 3.600,00 + 684,00 USt = 4.284,00 €, no errors,
                                   ER-03: "PDF erlaubt (Zustimmung liegt vor) – E-Rechnung empfohlen", confirm_token
Claude: shows the summary + preview link and asks "Fertigstellen?"
User: "Ja"
Claude → document_finalize {id, confirm_token}   [client asks for approval: requiresUserInteraction]
Claude → document_export {id}   → 5-min tailnet link to the ZUGFeRD PDF (original)
Claude: "RE-2026-01043 ist fertiggestellt. Datei: <Link>. Bitte an buchhaltung@mueller.de senden und kurz Bescheid geben."
User: "Ist raus, heute per E-Mail."
Claude → preview_action {action:"document_mark_sent", params:{id, sent_on:"2026-10-12", channel:"email_manual", artifacts:[…]}} → effect + confirm_token
Claude → document_mark_sent {id, sent_on:"2026-10-12", channel:"email_manual", artifacts:[…], confirm_token}   [approval prompt]
Claude: "Als versendet markiert (12.10.2026, E-Mail)."
```

## 6. Connecting clients

The MCP endpoint is reachable **only from devices inside the owner's tailnet** (02 §4). What works (research 14 §4.5):

| Client | Supported? | How |
|---|---|---|
| **Claude Code** on a tailnet device | **Yes (recommended)** | Connects directly from the local machine (below) |
| **Claude Desktop** with a local MCP config (`claude_desktop_config.json`) | **Yes, via a bridge** | A local stdio server `mcp-remote` forwards to the endpoint over the device's own network (below) |
| Claude Desktop / Cowork **custom connectors** (Settings → Connectors) | **No** | Remote connectors are brokered through the Claude account; the connection originates from Anthropic's servers, which cannot reach the tailnet |
| **claude.ai web / mobile** | **No** | Same reason. Making them work would need a public `/api/mcp` with OAuth, which contradicts "no public host" — out of scope |

**Claude Code:**
```bash
claude mcp add --transport http rechnungen https://api.<BASE_DOMAIN>/api/mcp \
  --header "Authorization: Bearer $RECHNUNG_MCP_KEY" --scope user
```
or the project `.mcp.json`:
```json
{ "mcpServers": { "rechnungen": { "type": "http", "url": "https://api.<BASE_DOMAIN>/api/mcp",
  "headers": { "Authorization": "Bearer ${RECHNUNG_MCP_KEY}" } } } }
```

**Claude Desktop (local bridge):**
```json
{ "mcpServers": { "rechnungen": { "command": "npx",
  "args": ["-y", "mcp-remote", "https://api.<BASE_DOMAIN>/api/mcp", "--header", "Authorization:${AUTH_HEADER}"],
  "env": { "AUTH_HEADER": "Bearer sk_live_…" } } } }
```

Prerequisites on the device: Tailscale connected to the owner's tailnet, a grant to the Caddy service on tcp:443 (05 §6.1), and on Linux clients ≤ v1.93 `tailscale set --accept-routes` (Tailscale Services VIPs). The hostname resolves through public Cloudflare DNS to the Caddy service's tailnet address, so off-tailnet devices simply time out.

The settings page **Einstellungen › MCP** (owner only) shows these snippets with the URL filled in, creates a key with the chosen preset, states clearly that claude.ai connectors are not supported, and has a "Verbindung testen" button that calls `workspace_overview` through the real endpoint.

## 7. Testing

- **Unit:** every tool's input/output zod schemas, plus the scope filtering of `tools/list` per preset.
- **Contract:** an in-process MCP client (`@modelcontextprotocol/client`) against the route handler with a convex-test backend. For each tool: happy path, validation error (structured), insufficient scope, and `confirm_token` missing/expired/outdated for ⚠ tools.
- **E2E:** the scripted conversation flow above via the MCP client against the real stack (Docker Convex), asserting the DB state, the audit-log actor `mcp:<keyId>`, the send-log entry and the archived artifacts.
- **Eval (manual, P1 exit):** 20 realistic German prompts run in Claude Code against a seeded instance. Each must reach the right result without manual corrections, with zero unapproved legal acts.

## 8. Requirements

| ID | Requirement | Priority | Phase |
|---|---|---|---|
| MCP-001 | Stateless Streamable HTTP endpoint `/api/mcp` (2026-07-28 with 2025 fallback) on the `api.` host port 443 only; bearer API key with channel `mcp`/`both` → actor `mcp:<keyId>`; Origin validation; per-key rate limit and access log shared with REST | MUST | P1 |
| MCP-002 | Tool annotations are derived from the tool kind by the registration helper (read → `readOnlyHint`; write → not destructive; ⚠ → `destructiveHint`) | MUST | P1 |
| MCP-003 | `tools/list` contains only tools whose scope the key holds; Convex re-checks every call | MUST | P1 |
| MCP-004 | Confirm tokens: issued by the matching preview, bound to key, intent, canonical params hash and entity versions, single use, 10 min; enforced in the Convex mutation wrapper for `mcp` actors (EC-003, EC-188) | MUST | P1 |
| MCP-005 | Every ⚠ tool declares its confirm intent, a required `confirm_token`, `destructiveHint` and `_meta["anthropic/requiresUserInteraction"]`; registration fails otherwise | MUST | P1 |
| MCP-006 | Previews: `preview_action { action, params }` for ⚠ tools outside documents (P1: `contact_merge`); `document_preview` and `dunning_preview` answer `not_implemented` until F04/F05 | MUST | P1 |
| MCP-007 | Discovery, contact, product and settings tools of §3.1–§3.3 for this slice (incl. `workspace_overview`, `contact_upsert` dedupe, `contact_merge` ⚠) and the resource `rechnung://company` | MUST | P1 |
| MCP-008 | Prompts `/angebot` and `/monatsabschluss` (guidance stubs until documents ship) | SHOULD | P1 |
| MCP-009 | Eval harness: German scenarios with reference tool calls replayed in CI and against a live test instance (`pnpm mcp:eval`); ⚠ steps only after a preview and approval | SHOULD | P1 |
| MCP-010 | Results carry `structuredContent` plus a JSON text block; errors are `isError` with the REST code, message, field errors and a German hint; server instructions ≤ 2,048 characters | MUST | P1 |
| MCP-011 | Document W/R tools of §3.4 for quotes, order confirmations, delivery notes and invoices incl. proforma (search, get with chain, quote/invoice drafts, update, convert, quote accepted/rejected) on the shared REST wire schemas; nothing is finalised without `document_finalize` (⚠) | MUST | P1 |

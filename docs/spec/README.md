# Specification index

> **Status:** v1.1 · 2026-10-12 · Start here (CLAUDE.md). The spec is the source of truth; research backing it is in [`../research/`](../research/). v1.1 applies the owner decisions of 2026-10-12: login + tailnet only; bank data via statement import and Enable Banking (no Revolut Business API); no customer e-mailing (export + manual sent mark); simple cash; sevdesk import from file exports; no Steuerberater; R2 e-mail-in inbox; production go-live (sevdesk off) at the end of P2, P1 runs as a pilot on the production stack.

This folder specifies a self-hosted, German-law-compliant invoicing and bookkeeping app for **one small business**, built as a 1:1 sevdesk replacement with better compliance, a full REST API and an MCP server so Claude can operate it. Stack: Next.js 16.4 (App Router, `proxy.ts`) + self-hosted Convex 1.46 on Dokploy, shadcn/ui + Tailwind 4, Vitest 4.1 + Playwright. Users sign in with Better Auth (passkey + e-mail OTP) and the app is reachable **only inside the owner's tailnet**. The bank is Revolut Business; its data arrives by **statement import** (CAMT.053/CSV/MT940 + signed PDF) and, from P2, the **Enable Banking** PSD2 feed. The app never e-mails customers: documents are exported and the owner sends them. The owner files UStVA/ZM/EÜR personally in Mein ELSTER with the app's step-by-step sheets. Every legal rule has a stable ID ([01](01-compliance.md), [10](10-edge-cases.md)) and every test is named after the IDs it covers.

## Reading order

1. [00-overview](00-overview.md): what and why, sevdesk parity.
2. [01-compliance](01-compliance.md): the legal requirement IDs everything else refers to, and the legal open items with their decided defaults.
3. [02-architecture](02-architecture.md) → [03-data-model](03-data-model.md): how it is built and stored (login, tailnet, actors, status model, crons, immutability).
4. [10-edge-cases](10-edge-cases.md): the regulatory safety net (EC-/RI-).
5. [07-testing](07-testing.md) and [09-roadmap](09-roadmap.md): how we prove it and in which order we build it.
6. Feature specs F01–F12 for the area you work on, then [04-ui-ux](04-ui-ux.md), [05-api](05-api.md), [06-mcp](06-mcp.md) as needed.
7. [08-deployment](08-deployment.md) when touching infrastructure.

## Documents

Counts are table rows whose first cell is an ID, counted by script from the files (2026-10-12, v1.1): **Req.** = requirement IDs (01: UST-/KU-/ER-/GOBD-/AO-/UVA-/MAHN-/DSGVO-/DATEV-/MAIL-/SEC-/MISC-; features: SET-, CON-, PRD-, DOC-/QUO-/INV-/REC-/SND-, PAY-/DUN-, INB-/VOU-, BNK-/CSH-, ACC-/AST-/TAX-/RPT-, EXP-/IMP-, POR-, PRJ-, AUD-/PRV-/NTF-), **Tests** = test IDs (T-…, T05-…, TST-…, incl. golden and table-driven suites), **Edge cases** = local edge-case IDs (…-E…, EC-…, E-…) and, in 10, global EC-/RI-. The numbers count **active** IDs; withdrawn IDs (kept as rows so references stay traceable, never renumbered) are shown as "+n w". User stories, data-model deltas and open questions are not counted. `pnpm trace` is the authoritative coverage report once code exists.

| Doc | Purpose | Req. | Tests | Edge cases |
|---|---|---|---|---|
| [00-overview](00-overview.md) | Vision, users, sevdesk parity matrix (what we copy, improve, add, simplify or drop) | — | — | — |
| [01-compliance](01-compliance.md) | Normative German-law requirement catalogue (UStG, E-Rechnung, GoBD/AO, UStVA, BGB dunning, DSGVO, DATEV, dispatch record, security) + legal open items with decided defaults | 109 | — | — |
| [02-architecture](02-architecture.md) | System overview, stack, repo layout, security model (login + tailnet, actors, secrets), status model, finalisation pipeline, crons, e-mail (auth only), ADRs | — | — | — |
| [03-data-model](03-data-model.md) | Convex schema (pseudo-TS), canonical enums and actor IDs, immutability matrix, consolidation log | — | — | — |
| [04-ui-ux](04-ui-ux.md) | UI principles, shells, route map, page patterns, status badges, accessibility, performance budgets | — | — | — |
| [05-api](05-api.md) | REST API (tailnet only): keys and scopes, conventions, endpoints, outbound events, website recipes | — | — | — |
| [06-mcp](06-mcp.md) | MCP server: safety model (scopes, hints, confirm tokens), tool catalogue, prompts, client setup | — | — | — |
| [07-testing](07-testing.md) | TDD rules, test layers, golden files, fixtures (Enable Banking MSW mocks, statement samples), invariants after every test, traceability, phase gates | — | — | — |
| [08-deployment](08-deployment.md) | Dokploy topology on the tailnet (Tailscale Services, Caddy TLS edge), bootstrap script, env vars, CI/CD, R2 backups, upgrades, monitoring | — | — | — |
| [09-roadmap](09-roadmap.md) | Phases P0–P4 + deferred (P1 pilot, **go-live at the end of P2** with the go-live checklist), order of work and exit gates; long-lead owner actions | — | — | — |
| [10-edge-cases](10-edge-cases.md) | Cross-cutting regulatory edge cases (EC-) and continuously checked invariants (RI-) | — | — | 141 EC (+7 w) + 29 RI |
| [F01-setup-company-settings](features/F01-setup-company-settings.md) | Setup wizard (owner account, tailnet access concept), company profile, tax settings, KU history, number ranges, layouts, templates, integrations, rule overrides | 120 | 111 | 29 |
| [F02-contacts](features/F02-contacts.md) | Contacts, addresses, VAT-ID checks, Leitweg-ID, PDF consent, merge, DSGVO restriction | 95 | 73 | 36 |
| [F03-products](features/F03-products.md) | Products, price modes, VAT rate keys, place-of-supply and §13b types, customer prices, stock (P4) | 62 | 55 | 34 |
| [F04-sales-documents](features/F04-sales-documents.md) | Quotes, orders, delivery notes, proforma, invoices, advances/partials/finals, Storno, corrections, recurring, **export and manual sent mark**, EN 16931 mapping | 143 (+7 w) | 268 (+4 w) | 114 (+2 w) |
| [F05-receivables-payments-dunning](features/F05-receivables-payments-dunning.md) | Open items, payments incl. cash („Bar bezahlt“, Quittung), differences (Skonto, fees, write-offs), credit balances, dunning (drafted/finalised, sent manually) and interest | 88 (+4 w) | 123 (+4 w) | 93 (+3 w) |
| [F06-purchases-inbox-einvoice](features/F06-purchases-inbox-einvoice.md) | Receipt inbox (upload, mobile camera, e-mail-in via Cloudflare Email Routing → R2), E-Rechnung receive, OCR, vouchers (bank/„bar“/„privat bezahlt“), Bewirtung, recurring vouchers | 93 (+2 w) | 121 (+4 w) | 87 (+2 w) |
| [F07-banking-cash](features/F07-banking-cash.md) | Statement import (CAMT.053/CSV/MT940 + PDF), Enable Banking PSD2 feed, dedupe, matching, rules, marking, simple cash | 71 (+27 w) | 103 (+23 w) | 82 (+19 w) |
| [F08-bookkeeping-tax-reports](features/F08-bookkeeping-tax-reports.md) | Journal and posting matrix, chart of accounts (SKR03 default), assets/AfA, period lock, UStVA/ZM/EÜR with Mein ELSTER instructions, reports | 80 | 98 | 105 (+1 w) |
| [F09-exports-imports](features/F09-exports-imports.md) | DATEV EXTF (P3, low priority), GDPdU Z3, full export, sevdesk import from file exports, CSV imports | 49 (+3 w) | 51 (+2 w) | 65 (+4 w) |
| [F10-portal-online-payments](features/F10-portal-online-payments.md) | Customer portal, quote acceptance, online payments, SEPA mandates, subscriptions — **deferred** (needs a public endpoint) | 32 | 29 | 34 |
| [F11-projects-time](features/F11-projects-time.md) | Projects, time tracking, invoicing from time (P4) | 21 | 23 | 32 |
| [F12-audit-integrity-privacy](features/F12-audit-integrity-privacy.md) | Audit log, integrity checks and checkpoints, auditor role, retention and purges, DSGVO tools, notifications | 51 | 48 | 64 |
| **Total** | | **1014** (+43 w) | **1103** (+37 w) | **945** (+38 w) (incl. 170 in 10) |

## Key decisions

- **Login + tailnet only**: Better Auth inside Convex with **passkey** (primary) and **e-mail OTP** (fallback), invite-only users with roles (`owner`, `bookkeeper`, `viewer`, `auditor`); the app is reachable only inside the owner's Tailscale tailnet behind a Caddy TLS edge — no public host, no inbound webhooks, no customer portal ([02 §4](02-architecture.md#4-security-model-login--tailnet)).
- **Every write is attributed** to a canonical actor `"<kind>:<id>"` with kinds `user`, `api-key`, `mcp`, `system` (`system:cron.<job>` for crons) and lands in a hash-chained audit log with a signed daily checkpoint in Cloudflare R2 (separate `CHECKPOINT_SIGNING_KEY_PEM`; bucket lock optional, checkpoints only). The Betriebsprüfer gets a time-limited user with role `auditor`.
- **E-mail only for login**: Cloudflare Email Sending sends OTP/invite mails; **the app never e-mails customers**. Backups and checkpoints go to Cloudflare R2.
- **Documents are exported and sent manually** (B2): „Exportieren“ serves the archived original artifacts (PDF, ZUGFeRD PDF/A-3, XRechnung XML); „Als versendet markieren“ records date, channel (`email_manual`, `post`, `hand`, `upload_portal`, `other`), note and artifact hashes (append-only dispatch record). For `MUST_E` invoices the structured e-invoice must be handed over electronically (any means the owner chooses). Zugang, Verzug and dunning escalation derive from the manual mark; nothing is ever sent automatically.
- **Bank data without the Revolut Business API** (B1): CAMT.053 (primary), Revolut CSV and MT940 statement import with the archived signed PDF is the P1 pilot path and always available as the fallback; from P2 the **Enable Banking** PSD2 feed (restricted mode, 0 €; written OK or a price requested from Enable Banking) with 180-day consent and reminders, polling every 6 h within the 4-per-day limit, owner-present „Jetzt abrufen“, dedupe by `entry_reference`, cross-source dedupe, pending items never booked. Read-only; no payments out of the app. The Revolut Business API is only a future option (Grow plan).
- **Simple cash, no cash book** (B3): „Bar bezahlt“ on invoices (daily-recording warning per §146 Abs. 1 S. 2 AO, reason when > 10 days back), „Bargeld eingezahlt / entnommen“, ATM withdrawals into the till, optional Quittung; one `cash` account (SKR03 1000) that is **never negative at any date**. No POS (§146a).
- **Go-live at the end of P2** (owner decision 2026-10-12): P1 (sales core) runs as a **pilot on the production stack** with a pilot database, `TEST-` number ranges, training data and a real-data sevdesk import dry run; real invoices still come from sevdesk. P2 adds purchases (vouchers incl. „bar"/„privat bezahlt"), the Enable Banking feed and the **guided UStVA/ZM sheets with the Mein ELSTER guide** (moved from P3), then the switch from sevdesk **at the start of a VAT period** (month or quarter) per the 09 go-live checklist; sevdesk stays read-only until the first UStVA from the app is submitted.
- **One implementation**: pure `src/domain` rules with date-effective rule tables, shared zod schemas for UI, Convex, REST and MCP; integer money (cents, micros, milli, basis points), EN 16931 half-up rounding.
- **Immutability (GoBD)**: finalised documents, payments, journal entries, cash transfers, booked bank transactions, dispatch records, artifacts and audit entries are never changed or deleted; only `convex/model/**` writes.
- **Single double-entry journal with account roles** (SKR03 default, SKR04 selectable; mapping versioned); sales, payment (incl. cash) and bank-to-invoice postings from P1, purchases and all bank transactions in P2.
- **No Steuerberater** (B5): the owner files UStVA/ZM/EÜR in **Mein ELSTER** from the app's Kennzahlen/Anlage-EÜR sheets with step-by-step instructions, records the Transferticket, and the period locks; ERiC direct submission is a P4 option; DATEV export stays for a future advisor (P3, low priority). Every uncertain legal item has a **decided conservative default**; a one-off Steuerberater check before go-live is recommended (non-blocking).
- **sevdesk migration from file exports** (B4): contact/product/invoice/voucher list CSVs, DATEV export, ZIP and PDFs; historical documents are read-only archive records with their original PDF; number ranges continue; open items become open receivables; preview with validation before commit. No sevdesk API.
- **Status model**: `status` draft/finalized/sent/cancelled (`sent` only by the manual mark), `paymentStatus` open/partially_paid/paid/credited/written_off, `artifactStatus` for a blocked pipeline; **overdue is derived, never stored**.
- **Invoice numbers at finalisation, voucher numbers (Belegnummer) at booking**, so deleted drafts leave no gaps.
- **Storno only for unpaid invoices**; paid ones get a Rechnungskorrektur (+ refund/offset); formal defects a Rechnungsberichtigung. **Corrections never increase** an invoice (Σ original + corrections ≥ 0, RI-07); more money means a new invoice.
- **Advances must be fully settled before the final invoice**: unpaid → Storno, partially paid → Rechnungskorrektur down to the amount received; the final invoice deducts exactly the amounts received (no §14c double claim).
- **Gross mode: "largest net that fits"**: VAT is always round(net × rate); an unreachable gross ends 1 cent lower with a warning (6,29 € → 6,28 €).
- **Late Skonto** is never booked as Skonto: accepted → price reduction with VAT correction (§17), not accepted → stays receivable.
- **E-invoice defaults**: ZUGFeRD 2.5 / Factur-X EN 16931 hybrid PDF/A-3 for B2B, XRechnung 3.0.2 UBL for public authorities (portal upload), every XML KoSIT-validated before export; ER-03 transition keyed on the supply date (§27 Abs. 38 UStG), advance invoices evaluated with the stricter of document date and expected supply date.
- **Receipt inbox** (B6, P2): upload (desktop + mobile camera) and an e-mail-in address via Cloudflare Email Routing → Worker → R2, polled by the app; no IMAP.
- **Crypto-shredding** of personal data in audit diffs (per-contact keys) to reconcile DSGVO erasure with an immutable hash chain.
- **Purges are always manual**: retention scans only fill a purge worklist; DSGVO erasure restricts data until retention ends.
- **Confirm tokens for legal acts**: every ⚠ MCP tool (finalise, mark as sent, cancel, payments, dunning, bank matches/marks, cash transfers, …) needs scope + `destructiveHint` + `requiresUserInteraction` + a `confirm_token` from a preview with the matching intent (`document_preview`, `dunning_preview`, `preview_action`). There is no send tool.
- **Deferred**: customer portal, online payments, SEPA direct debit and subscriptions with auto-charge (F10) — they need a public endpoint.

## Open questions

Deduplicated from 01 "Legal open items" and every feature spec §9. Items already resolved are omitted. ⚖ = marked LEGAL-OPEN in code (`// LEGAL-OPEN: <item>`), configurable/date-effective, with a test for the current default.

### (a) Legal open items — decided defaults

The owner works without a Steuerberater. Each item is implemented with the **legally safest default** (stricter validation, block rather than warn when unsure, the earlier tax point, keep records longer). **A one-off check of this list by a Steuerberater (lawyer / data-protection advisor where noted) before go-live is recommended; it is not blocking.**

| # | Question | Decided default | Source |
|---|---|---|---|
| A1 | Wording and XML location of the 2028 Ist-Versteuerer note; KU invoices? ⚖ | „Versteuerung nach vereinnahmten Entgelten“ on every invoice of an Ist-taxing company from invoice date 2028-01-01 incl. Kleinbetrag; XML BT-22 subject `REG`; not on KU invoices (no VAT shown) | 01 item 1, F04 9.10 |
| A2 | KU edge cases when crossing 100k; VATEX/category for KU in XRechnung; KU services to EU businesses ⚖ | Crossing evaluated on the supply date (also when payments lag), that supply and all later ones taxed normally; XML category E, rate 0, BT-120 KU note; EU B2B services only with own VAT ID (`eu_b2b_service` + ZM), else blocked | 01 item 2, F01 Q3, F04 9.2, 9.11 |
| A3 | Neugründer monthly UStVA from 2027 ⚖ | Monthly in the founding year and the following year (the stricter option); the period notified by the Finanzamt wins | 01 item 3, F01 Q4, F08 Q10 |
| A4 | JStG 2026 outcome: GWG 1,200 € / Sammelposten; e-vehicle AfA window; Kassenpflicht bill ⚖ | Current law until enacted (GWG 800 €); new rows prepared but disabled; no cash register exists, so a Kassenpflicht cannot be triggered | 01 item 4, F08 Q6 |
| A5 | DATEV Formatversion, columns, encoding, BU keys, Herkunft, Belegfeld 2, Beleglink, master data, ⚠ accounts | EXTF version 13, Windows-1252, BU keys from the versioned table, Herkunft `RE`, Belegfeld 2 = due date; P3, low priority; a real test import before the first handover to an advisor (not a go-live gate); UNSURE role accounts ship unmapped and block their postings until mapped | 01 item 5, F08 Q1, F09 Q1–Q2 |
| A6 | UStVA Kennzahlen 2026/2027 (incl. §13b/igE), base rounding, Kz 50 vs negative Kz 81 for write-offs; ZM; Anlage-EÜR line numbers ⚖ | From the official forms of the year (versioned); new-year data blocked until verified against the form; bases truncated to whole euros, tax in cents; write-offs under Soll in Kz 50; ZM entered in Mein ELSTER; Anlage EÜR/AVEÜR lines blocked until verified | 01 item 6, F08 Q3–Q4, Q7, Q12–Q13 |
| A7 | ERiC licence | Only if the P4 ERiC option is built | 01 item 7 |
| A8 | Allowed XRechnung TypeCodes for Abschlags-/Teilrechnungen and Storno (BR-DE-17) | 326 / 380 / 381, verified in the P0 KoSIT spike; fallback 380 with title „Abschlagsrechnung“ and BT-22 note | 01 item 8, F04 9.1 |
| A9 | AEAO zu §146a wording on invoicing software | No POS and no cash sales without an invoice → §146a does not apply; stated in the Verfahrensdokumentation | 01 item 9 |
| A10 | BMF 15.10.2025 Randziffern for continuing contracts, corrections, self-billing | One E-Rechnung per period (ER-04); corrections reference the original (UST-30); self-billing only with a stored agreement (UST-33) | 01 item 10 |
| A11 | ER-03 reference date for advance invoices issued before the supply ⚖ | Evaluate with both the document date and the expected supply date; the **stricter** result applies; without an expected supply date the document date | 01 item 11, F04 9.5 |
| A12 | Is an amount-based partial invoice always an Anzahlung or can it be a Teilleistung? | Always an Anzahlung (Mindest-Ist, the earlier tax point); Teilleistungen are billed quantity-based as normal invoices | F04 9.3 |
| A13 | FX conversion source | BMF monthly average (§16 Abs. 6 UStG) for VAT on sales and purchases; ECB daily only as logged fallback while the BMF month is unpublished; no daily-rate approval requested | F04 9.9, F06 VOU-028 |
| A14 | Profit method history (EÜR↔Bilanz) date-effective? ⚖ | Modelled date-effective (switch only at a fiscal-year start); Bilanz itself out of scope (external tool or advisor, AO-07) | F01 Q2 |
| A15 | eGbR register data: should §707b BGB letter items block? Letterhead self-confirmation acceptable? | Block finalisation while eGbR register items are missing (stricter than the current warning); letterhead footer: print the footer unless the owner confirms per layout version that the letterhead contains every mandatory item (audited) | F01 Q1, Q7 |
| A16 | Good-faith protection (§6a Abs. 4) evidence after a failed qualified VAT-ID check; retention of consent records and §13b certificates | K/AE blocked until a new valid check or an audited override with reason; earlier evidence linked; consent records and certificates kept as long as any linked invoice (≥ 10 years) | F02 Q3, Q5 |
| A17 | `restaurant_food` modelling and further category keys; rate change inside a continuous service period; VATEX mapping of §4 exemptions | Keys as shipped (date-effective); a line crossing a rate change is blocked and must be split; VATEX from the current CEF list, unknown → blocked | F03 Q2–Q4 |
| A18 | Interest start day (§286 Abs. 3), Basiszinssatz H1 2026, actual/365 in leap years; Verzug via a reminder with a printed deadline ⚖ | Interest from day 31 after max(due date, Zugang); Basiszinssatz verified against the Bundesbank before release; actual/365; reminder route: Verzug from the day after the printed deadline (never earlier than Zugang + 1) | F05 Q-01–Q-03, 01 item 12 |
| A19 | EÜR treatment of customer overpayments and refunds | Debtor credit in the journal; income on receipt and expense on refund in the EÜR | F05 Q-04 |
| A20 | Geschäftsregelfehler in received E-Rechnungen; Bewirtung electronic approval; voucher corrections ⚖ | Booking allowed but a warning must be acknowledged, input VAT marked at risk and a correction request offered; approval = signed-in user + timestamp + archived Eigenbeleg hash; Generalumkehr + re-post with reason, after lock only cancel + new | F06 Q-02, Q-07, Q-09 |
| A21 | FX accounting for foreign Revolut pockets in EÜR; bank fees ⚖ | Moving-average EUR cost per pocket, realised FX on outflow; all bank fees VAT-exempt (§4 Nr. 8 UStG), no input VAT, no §13b unless an invoice shows VAT; fee split per source verified by balance continuity or confirmed once by the owner | F07 Q-07, F08 Q2 |
| A22 | Tax point for igL and EU services under Ist | igL: invoice date, at the latest end of the month after the supply; EU services: end of the month of supply, also under Ist | F08 Q5 |
| A23 | DATEV for EÜR + Ist; foreign currency; GDPdU encoding | Full journal incl. invoices and payments (OPOS variant); Umsatz in EUR with original currency for information; GDPdU UTF-8 (ANSI selectable) | F08 Q8, F09 Q3–Q5 |
| A24 | ~~Art. 11a CRD button wording; VAT on payment-provider fees~~ | Deferred with F10 (no portal, no online payments) | F10 Q1, Q3 |
| A25 | Audit log as 10-year document; non-Beleg delivery notes; staged purge 2033/2035; 10-year backups containing purged data (data-protection advisor) | Audit log 10 years; delivery notes 6 years; staged purge (documents 2033, contact anonymisation 2035); purge replay after restore, documented in the Verfahrensdokumentation | F12 Q2–Q5 |
| A26 | Stock valuation for Bilanz companies | Out of scope (AO-07); external tool or advisor | F03 Q6 |
| A27 | B2G direct orders ≤ 1,000 €: keep Leitweg-ID mandatory? | Keep it mandatory for all public customers (stricter) | F02 Q1 |
| A28 | Cash records without a Kassenbuch ⚖ | Allowed for this business (no cash register, cash only on invoices): never-negative cash account, daily-recording warning, reason after 10 days, cash report from the journal | 01 item 13, F07 Q-09 |
| A29 | Retention of rejected non-business inbox items ⚖ | Purge-eligible after 90 days, manual purge only; anything that is or might be an invoice → 6 years | F06 Q-04 |
| A30 | Cloudflare e-mail-in (Email Routing, Worker, R2) as processor for incoming invoices ⚖ | Only after the Cloudflare AVV is confirmed; EU jurisdiction bucket; objects deleted right after import; upload works without it | F06 Q-11 |
| A31 | Corporation private postings (Verrechnungskonto Gesellschafter) | `private.*` blocked for corporations; owner-created shareholder clearing account per shareholder; postings blocked while unmapped | F08 Q14 |
| A32 | Deadline for annual returns without an advisor | 31 July of the following year (§149 Abs. 2 AO) from the date-effective table | F08 Q16 |
| A33 | Ist taxation: when does the VAT reduction of a credit Rechnungskorrektur take effect — at the correction or when the money is refunded? ⚖ | When refunded (P11-ist): the correction's VAT is parked on `vat.output.notdue.*` like the invoice's (S13-ist) and released pro rata with each refund; the part the corrected invoice absorbed follows the invoice's payments (`// LEGAL-OPEN: F08 §4.2.2 P11-ist`) | F08 §4.2.2 P11, F05 PAY-033 |

### (b) For the owner

| # | Question | Source |
|---|---|---|
| B1 | **Ask Enable Banking in writing** whether restricted mode is acceptable for one company's own accounts, or for a price; record the answer (until then the feed runs in "evaluation" mode; P1 does not depend on it) | F07 Q-01, BNK-116, 09 |
| B2 | **Export one Revolut month in all formats** (CSV, CAMT.053, MT940, signed PDF) per currency account for fixtures | F07 Q-03, 09 |
| B3 | **Export sample sevdesk files** (contact, product, invoice and voucher list CSVs, DATEV export, ZIP, a few PDFs); later the full export before cancelling | F09 Q9, 09 |
| B4 | *Resolved (2026-10-12)*: the guided UStVA (and ZM) sheets move to P2 and the go-live is at the end of P2 | 09 |
| B5 | *Resolved (2026-10-12)*: P1 is a pilot, so vouchers paid „bar"/„privat" (P2) are available from the first real day | F08 Q11 |
| B6 | Gross mode: keep the 1-cent deviation (current) or add a BT-114 rounding amount? | F04 9.12, 10 EC-053 |
| B7 | Translated product texts for EN documents | F04 9.13 |
| B8 | Claude EU endpoint presets for OCR | F01 Q5 |
| B9 | Serial letters („Brief schreiben“) later or never | F02 Q4 |
| B10 | Product variants / tiered prices for the shop; per-currency price lists | F03 Q1, Q5 |
| B11 | Sammelmahnung (one letter for several invoices) in P3? | F05 Q-08 |
| B12 | Payment allocation: principal first (default) vs §367 BGB | F05 Q-10 |
| B13 | Auto-apply of bank matches on by default | F07 Q-08 |
| B14 | Non-billable time on fixed-price projects counts against the budget? Timesheet embedded in the XML? | F11 Q1–Q2 |

### (c) Technical spikes

| # | Question | Source |
|---|---|---|
| C1 | Better Auth (`@convex-dev/better-auth` 0.12.5, `better-auth` 1.6.33) on self-hosted Convex with a static JWKS + our server JWT provider for REST/MCP | 02 §4, 09 P0 spike 1 |
| C2 | Dokploy network name for `CONVEX_INTERNAL_URL`; CLI flags for `bootstrap.sh` | 08 §5, 09 P0 spikes 2, 7 |
| C3 | `@convex-dev/rate-limiter` and `convex-helpers` triggers on self-hosted | 02 §2, 09 P0 spike 3 |
| C4 | react-pdf PDF/A-3b + `embedFacturX` valid in Mustang/veraPDF; `@e-invoice-eu/core` output KoSIT-valid | 09 P0 spikes 4–5 |
| C5 | Tailscale Services on the Dokploy fork (retag procedure) + Caddy TLS edge with a DNS-01 wildcard certificate | 08 §2, 09 P0 spike 6 |
| C6 | KoSIT accepts a 380 final invoice with negative BT-115 (rate-change refund) | F04 9.4 |
| C7 | Enable Banking accepts the tailnet-only HTTPS redirect URL; DE-IBAN accounts under the Revolut (LT) ASPSP; remittance/payer IBAN for incoming transfers; tailnet IP as `Psu-Ip-Address` | F07 BNK-115, Q-02, Q-04–Q-06 |
| C8 | eVatR status codes for "invalid" vs "unavailable" | F02 Q2 |
| C9 | sevdesk export layouts (headers, status labels, PDF naming, ZIP structure); lexoffice CSV headers | F09 Q7, Q9 |
| C10 | Remote auditor access: Tailscale device/user sharing with Tailscale Services | F12 Q1 |
| C11 | Cloudflare Email Worker: behaviour when the R2 `put` fails (retry/bounce, never a silent drop) | 08 §3.4, F06 INB-048 |

## Glossary

| Term | Meaning |
|---|---|
| **Abschlagsrechnung / Anzahlungsrechnung** | Advance invoice for a supply not yet completed (amount-based). VAT is due on receipt of payment (Mindest-Ist); deducted in the Schlussrechnung |
| **Teilrechnung** | Invoice for a completed, separately accepted part of the supply (Teilleistung), billed by quantity; a normal invoice |
| **Schlussrechnung** | Final invoice for the whole supply, deducting the advances received |
| **Storno / Stornorechnung** | Full mirror of an unpaid invoice that cancels it (own number, references the original) |
| **Rechnungskorrektur** | Commercial credit note reducing an invoice (never called "Gutschrift") |
| **Rechnungsberichtigung** | Correction of formal invoice data (e.g. address) without changing amounts |
| **Gutschrift** | Self-billing invoice issued by the customer on behalf of the supplier (§14 Abs. 2 S. 2 UStG), needs an agreement |
| **Proforma** | Non-binding invoice preview (customs, prepayment), no revenue |
| **Kleinunternehmer (KU, §19 UStG)** | Small business exempt from charging VAT (prior year ≤ 25,000 €, current ≤ 100,000 €) |
| **§13b (Reverse Charge)** | The customer owes the VAT (e.g. construction services, EU B2B services) |
| **Leistungsdatum / -zeitraum** | Date or period of supply; drives the VAT rate and the E-Rechnung transition |
| **Soll-/Ist-Versteuerung** | VAT due on invoicing (Soll) or on receipt of payment (Ist) |
| **Mindest-Ist** | VAT on advance payments is due when received, even for Soll-taxing businesses |
| **UStVA** | Umsatzsteuer-Voranmeldung: monthly/quarterly VAT return (Kennzahlen = form fields) |
| **ZM** | Zusammenfassende Meldung: EC sales list for EU B2B supplies/services |
| **EÜR** | Einnahmenüberschussrechnung: cash-basis profit calculation (Anlage EÜR) |
| **GoBD** | Rules for proper electronic bookkeeping and record retention (immutability, traceability, Verfahrensdokumentation) |
| **Verfahrensdokumentation** | Mandatory description of the bookkeeping procedures and system |
| **Festschreibung** | Period lock; postings in the period become final |
| **Betriebsprüfer / Datenzugriff Z1–Z3** | Tax auditor; read access (Z1), evaluations (Z2), data export in GDPdU format (Z3) |
| **E-Rechnung (XRechnung, ZUGFeRD)** | Structured electronic invoice per EN 16931; XRechnung is pure XML, ZUGFeRD/Factur-X a PDF/A-3 with embedded XML |
| **Leitweg-ID** | Routing ID of a public-sector buyer, mandatory in BT-10 of B2G invoices |
| **USt-IdNr / Steuernummer** | EU VAT ID / national tax number |
| **Mahnung / Zahlungserinnerung** | Dunning letter / payment reminder; Verzugszinsen = default interest, Basiszinssatz = Bundesbank base rate |
| **Skonto** | Early-payment discount; reduces the tax base when actually granted (§17 UStG) |
| **Beleg / Belegnummer / Eigenbeleg** | Voucher / its internal number / self-made voucher when no original exists |
| **Kassenbuch** | Cash book with registers and daily close — **not built** (B3); the app keeps one cash account that must never show a negative balance |
| **Quittung** | Receipt confirming a cash payment; references the invoice, is not itself a tax invoice |
| **AfA / GWG** | Depreciation / low-value assets written off immediately |
| **SKR03 / SKR04** | Standard DATEV charts of accounts |
| **DATEV EXTF** | Export format for a Steuerberater's DATEV system (P3, low priority) |
| **Mein ELSTER** | The tax authority's web portal where the owner enters UStVA, ZM and EÜR manually, guided by the app |
| **Transferticket** | Receipt ID that ELSTER shows after a submission; recorded with the filing |
| **PSD2 / AIS / AISP** | EU payment-services directive; account-information service and its licensed provider (here Enable Banking) |
| **Consent (PSD2)** | The owner's authorisation for read access to bank accounts; valid 180 days, then renewed |
| **CAMT.053 / MT940** | Standard bank statement formats (ISO 20022 XML / SWIFT text) |
| **Zugang** | Receipt of a document by the customer; derived from the owner's manual sent mark and channel |
| **AVV** | Data-processing agreement with an external service (Art. 28 DSGVO) |

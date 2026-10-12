# 09 — Roadmap & Milestones

> **Status:** v1.1 · 2026-10-12 (owner decisions applied: login + tailnet deployment; documents exported and sent manually; cash payments and CAMT/CSV statement import move into P1; Enable Banking feed in P2; **production go-live (sevdesk off) = end of P2**, P1 is a pilot on the production stack; the guided UStVA/ZM sheets move from P3 to P2; sevdesk import from file exports; no Steuerberater — UStVA/ZM/EÜR via Mein ELSTER instructions, DATEV P3 low priority; portal and online payments deferred). Every phase ends with the quality gate from [07-testing.md §9](07-testing.md#9-phase-exit-criteria-quality-gates). Phases are cumulative; nothing ships without its tests.

## Timeline at a glance

| Phase | Theme | Outcome |
|---|---|---|
| **P0** | Foundation | Deployed skeleton on Dokploy inside the tailnet with login (Better Auth), Convex, CI/CD, audit chain, design shell, setup wizard |
| **P1** | Sales core — **pilot** on the production stack | Contacts/products, sales documents with PDF/XML export and the manual sent mark, payments incl. cash, CAMT/CSV statement import with matching, journal postings; API + MCP; sevdesk import from file exports (dry run with real data). Runs on the production stack with a pilot database, test number ranges and training data; real invoices still come from sevdesk |
| **P2** | Purchases, bank feed, UStVA — **production go-live** | Enable Banking feed, receipt inbox (upload + e-mail-in via R2), E-Rechnung receipt, OCR, vouchers (incl. „bar“/„privat bezahlt“), matching rules, journal extended to purchases and all bank transactions, manual entries, assets, period lock, **guided UStVA/ZM Kennzahlen sheets + Mein ELSTER guide + Transferticket record**. Ends with the switch from sevdesk at the start of a VAT period |
| **P3** | Yearly tax & reporting | EÜR sheet with Mein ELSTER instructions, USt-Jahreserklärung worksheet, reports, dashboards, GDPdU, auditor role, retention, DSGVO tools; DATEV export (low priority) |
| **P4** | Growth | ERiC direct ELSTER submission (option), time & projects, stock, OSS, Peppol |
| **Deferred** | Needs a public endpoint | Customer portal, quote e-signature, online payments, SEPA direct debit, subscriptions with auto-charge (F10) |

**Deadline driver:** if the business's 2026 turnover exceeds 800,000 €, issuing E-Rechnungen becomes mandatory for **supplies executed from 2027-01-01** (ER-03; the §27 Abs. 38 UStG transition keys on the supply date, not the invoice date). The production go-live (end of P2) must be before then either way — if P2 cannot finish in time, the fallback is issuing E-Rechnungen from sevdesk until the switch (the P1 pilot already proves the XRechnung/ZUGFeRD output); for everyone, E-Rechnung issuing is mandatory for supplies from 2028-01-01.

## P0 — Foundation

**Spikes (time-boxed, results recorded as ADR updates):**
1. Better Auth (`@convex-dev/better-auth` 0.12.5, `better-auth` pinned **1.6.33**; watch issues #433/#422) on self-hosted Convex with a static JWKS; passkey + e-mail OTP; our second `customJwt` provider for REST/MCP actors (02 §4).
2. The Dokploy network name for compose ↔ application traffic (`CONVEX_INTERNAL_URL`).
3. `@convex-dev/rate-limiter` and `convex-helpers` triggers on self-hosted.
4. react-pdf `conformance="PDF/A-3b"` → `@cantoo/pdf-lib` `embedFacturX` → Mustang/veraPDF valid? (ADR-006) Fallback: Gotenberg Factur-X route.
5. `@e-invoice-eu/core` produces KoSIT-acceptable XRechnung UBL/CII + ZUGFeRD EN16931 from our model, incl. TypeCodes 326/380/381 (F04 9.1) and a 380 final invoice with negative BT-115 (F04 9.4). (ADR-007)
6. Tailscale Services on the owner's Dokploy fork incl. the **retag procedure** (08 §2.1, fix the tailnet policy first so SSH is not cut off); Caddy TLS edge with a wildcard certificate via Cloudflare DNS-01; DNS records pointing at the Service TailVIP (08).
7. The Dokploy CLI flags for every command in `bootstrap.sh` (`--help` check).

**Deliverables:**
- Repo scaffold (pnpm, Next 16.4, Tailwind 4, shadcn v4, Biome, Vitest 4.1 projects, Playwright, convex-test), `CLAUDE.md`, ADRs.
- `deploy/` + `bootstrap.sh` (Tailscale retag, Caddy + wildcard cert, DNS records); production + local stack (`compose.dev.yml`, `*.localtest.me`); CI/CD to Dokploy; R2 backups + the first restore drill.
- `proxy.ts` host routing + session check; Better Auth login (passkey, e-mail OTP via Cloudflare Email Sending, invite-only); actor minting; Convex `functions.ts` wrappers; triggers (audit + immutability); `auditLog` hash chain; `integrity.verify` + checkpoints to R2.
- The `src/domain/rules` engine skeleton (tax rates, Basiszinssatz, note texts) with date-effective lookup.
- App shell (sidebar/bottom nav, command palette stub, theme, i18n) + setup wizard (SKR03 default) + company settings (F01 P0 items).
- einvoice-tools sidecar image with `/validate/xml`, `/validate/pdf`, `/health`.

**Exit:** the P0 gate (07-testing §9).

## P1 — Sales core (pilot on the production stack)

**Pilot mode.** P1 is built and run on the real production stack (server „Proxmox PVE", Dokploy compose, tailnet, Caddy, R2 backups, login) so that operations are proven before go-live, but with a **pilot database**: a separate Convex instance (own `INSTANCE_NAME`/Postgres database) whose number ranges carry the prefix `TEST-` and whose company data is training data. Nothing in it is a real Beleg (no pilot document is handed to a customer). The real sevdesk export is imported as a **dry run** (preview, and commit inside the pilot instance) to prove the mapping and number continuation. At go-live the pilot instance is archived (export kept with the release notes) and the production instance is created fresh (setup wizard, real import commit) — 08 §8 runbook `go-live.md`. Real invoices keep coming from sevdesk during P1.

Order of work (each a vertical slice: domain → Convex → API/MCP → UI → E2E):

1. **Money, tax and totals domain**: rounding, tax-case derivation, totals, ER-03 decision, validators (golden suite skeleton).
2. **Contacts** (F02) incl. VAT-ID checks, Leitweg-ID, consent.
3. **Products** (F03).
4. **Invoices**: draft editor → finalise pipeline → PDF/A-3 + ZUGFeRD/XRechnung → validation → artifacts (F04). Then **export and the manual sent mark** („Exportieren“, „Als versendet markieren“ with date/channel/note/artifact hashes, MUST_E electronic-channel rule, to-dos for exported-but-unmarked documents).
5. **Payments** (manual, clearing, bank) incl. **cash** („Bar bezahlt“ with the daily-recording warning, never-negative cash account, „Bargeld eingezahlt / entnommen“, ATM withdrawals into the till, optional Quittung), open items, payment status (F05 PAY, F07 CSH-020…030).
6. **Bank statement import** (F07): CAMT.053 (primary), Revolut CSV, MT940 + signed PDF archive, monthly import to-do, dedupe and cross-source dedupe, balance continuity, reconciliation; **matching engine** (invoice number first) with review UI; private/Geldtransit marking; bank reversals.
7. **Journal** (F08): the single double-entry journal with gapless `seq`; sales postings in the finalisation transaction, payment postings (bank, clearing, cash) at allocation/reversal, cash transfers; chart of accounts seed SKR03 (default)/SKR04 + role mapping; opening balances for cash, bank and imported open receivables.
8. **Quotes, order confirmations, delivery notes, proforma**, conversions (F04).
9. **Abschlag/Teil/Schluss, Storno, Rechnungskorrektur** (F04) incl. their journal postings.
10. **Dunning** policies, reminder drafts/finalisation (never sent by the app), escalation from the manual sent mark, interest and fees (F05).
11. **Recurring invoices** (F04; automation finalises, the owner exports and sends).
12. **REST API + keys** (05) for the website inside the tailnet. **MCP server** (06) with all P1 tools.
13. **sevdesk import from file exports** (F09): contacts, products, open items as open receivables, historical invoices as read-only archive records with their PDFs, number ranges continued; preview with validation before commit.
14. **Dashboard v1** (open items, revenue, to-dos incl. statement import and „exportiert, nicht markiert“), the **Verfahrensdokumentation v1** generator (F12), the audit-log viewer.
15. Pilot checklist: login and passkeys for all users, tailnet access tested from desktop and phone, sevdesk export import dry run (preview + pilot commit) without blocking errors, training invoices exported and marked sent, one real Revolut month imported and reconciled in the pilot, backup + restore drill on the production stack.

**Exit:** the P1 gate. **Milestone "Pilot": the sales side works end to end on the production stack with training data.** sevdesk stays the system of record.

## P2 — Purchases, bank feed, UStVA → production go-live

1. **Enable Banking feed** (F07 BNK-100…117): redirect-URL spike in the tailnet first (BNK-115); restricted-mode application, 180-day consent with reminders, backfill inside the callback, account re-mapping, polling every 6 h within the PSD2 budget, owner-present „Jetzt abrufen“, pending rows provisional, cross-source dedupe with the statement import.
2. Receipt inbox: upload, drag&drop, PWA camera/share target, **e-mail-in address via Cloudflare Email Routing → Worker → R2, polled** (F06).
3. E-Rechnung receive: parse, validate, render, archive (ER-02).
4. Vouchers editor + SKR suggestions + supplier learning + duplicates; „Bezahlt mit“ bank/„bar“/„privat bezahlt“; Bewirtung; Eigenbeleg; recurring vouchers.
5. Claude OCR (opt-in) with a review queue.
6. Matching rules, vouchers from bank transactions, loans, tax payments, PayPal CSV clearing (F07).
7. Journal extended to purchase vouchers and all remaining bank transactions (fees, FX, transit); chart-of-accounts UI and custom accounts, manual entries, period lock (F08).
8. Assets/AfA + Anlagenspiegel (F08).
9. **Guided UStVA** (moved from P3, F08 TAX-001…008, TAX-011, TAX-018…021): Kennzahlen sheet from the journal with drill-down, Dauerfristverlängerung/Sondervorauszahlung, correction filing, step-by-step Mein ELSTER instructions, Transferticket record + period lock, tax payment vouchers, deadline calendar. **ZM** (TAX-009/010) with the same guide, because EU B2B supplies need it from the first period.
10. **Go-live** (checklist below).

**Go-live checklist (production switch from sevdesk):**
- [ ] **Switch at the start of a VAT period** (the first day of a month, or of a quarter for quarterly filers), so that every UStVA/ZM period is computed entirely by one system: the last period before the switch is filed from sevdesk, the first period after it from the app. Mid-period switches are not supported (the Kennzahlen would be split across two systems).
- [ ] Buchungsbeginn = that first day; opening balances (bank, cash counted on the day, open receivables and payables from the import) entered as of the day before (F08).
- [ ] Fresh production instance (pilot archived); setup wizard completed (company, tax settings, SKR03, bank accounts, number ranges continuing the sevdesk sequences per the import preview, F09 IMP-005).
- [ ] Final sevdesk file export downloaded and **committed** in production; import protocol archived (F09 IMP-024); spot check of 10 historical documents against their PDFs.
- [ ] Enable Banking connected (consent valid ≥ 150 days) or the statement-import routine in place; first sync/import reconciled.
- [ ] Receipt inbox address switched to the Cloudflare Worker (08 §3.4); suppliers informed of the new address.
- [ ] Login and passkeys for all users; tailnet access from desktop and phone; backups verified and one restore drill on production.
- [ ] Verfahrensdokumentation released (incl. Bankdaten and Datenmigration sections, F12 §4.6).
- [ ] First real invoice exported and marked sent; first real voucher booked (incl. one paid „bar").
- [ ] ELSTER certificate for Mein ELSTER available; the first UStVA after the switch rehearsed with the guide (values cross-checked).
- [ ] sevdesk kept **read-only** (not cancelled) until the first UStVA from the app is submitted without a cross-check mismatch; then cancel — after downloading every sevdesk file export (sevdesk deletes the data after cancellation).

**Exit:** the P2 gate. **Milestone "Go-live": the app is the system of record; sevdesk is switched off.**

## P3 — Tax & reporting

EÜR with Anlage EÜR line values, Mein ELSTER instructions and the submission record (locks the year); USt-Jahreserklärung worksheet; BWA-light; SuSa; Kontenblatt; full dashboards; tax reserve; cash-flow forecast; GDPdU Z3 export; auditor role (Z1); retention engine + purge; DSGVO tools; self-billing Gutschrift; **DATEV export (low priority, for a future Steuerberater)**.

**UStVA timing** — *resolved (2026-10-12)*: the guided UStVA/ZM sheets are part of P2 and the go-live is at the end of P2, so every period after the switch is filed from the app; there is no period that needs a mix of app and sevdesk figures.

**Exit:** the P3 gate (EÜR golden dataset green; the first yearly EÜR rehearsed with the guide; GDPdU export validated).

## P4 — Growth (prioritise with the owner)

Optional ERiC/ELSTER direct submission → time tracking & projects → stock → OSS → Peppol → travel expenses → CRM pipeline.

## Deferred (needs a public endpoint; revisit if the network decision changes)

Customer portal + quote e-signature + online payments (Stripe/Mollie) → SEPA mandates + pain.008 → subscriptions with auto-charge (F10). Revolut Business API (only if the owner buys the Grow plan).

## Long-lead items to start now (owner actions)

| Item | Lead time | Needed for |
|---|---|---|
| **Ask Enable Banking for written OK** to use restricted mode for one company's own Revolut Business accounts (read-only, ≤ 4 accounts), **or a price** (`info@enablebanking.com` / `support.api@enablebanking.com`); store the answer for the Verfahrensdokumentation (F07 BNK-116) | 1–4 weeks | P2 bank feed / go-live (P1 does not depend on it) |
| **Export one Revolut month in all formats** (CSV, CAMT.053, MT940, signed PDF) per currency account, anonymised, for test fixtures and to settle the UNSURE columns (F07 Q-03) | 1 hour | P1 statement import |
| **Export sample sevdesk files**: contact CSV, product/article CSV, invoice and voucher list CSV, DATEV export, the GoBD/„Datenexport“ ZIP (if available), a few invoice PDFs — then the full export before downgrading/cancelling (F09) | 1 day | P1 import dry run; the full export right before the go-live |
| Domain on Cloudflare DNS, Cloudflare Email Sending (login mails), R2 buckets in the EU jurisdiction (backups; checkpoints — bucket lock optional, checkpoints only; e-mail-in) | 1 day | P0 |
| Tailscale tailnet + Dokploy fork with Tailscale Services; passkey-capable devices for every user | 1 day | P0 |
| ELSTER certificate for Mein ELSTER (the owner files UStVA/ZM/EÜR manually) | 1–2 weeks (letter with activation code) | P2 go-live (first UStVA from the app) |
| Optional: one-off check of the decided legal defaults by a Steuerberater (README "Open questions" (a)) | 1–2 weeks | before go-live, non-blocking |
| Anthropic API key + AVV (only if OCR is wanted) | 1 day | P2 |
| ELSTER developer registration (only if ERiC is wanted later) | weeks | P4 |

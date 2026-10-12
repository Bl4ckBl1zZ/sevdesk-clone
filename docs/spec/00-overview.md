# 00 — Product Overview & sevdesk Parity

> **Status:** v1.1 · 2026-10-12 (owner decisions: login + tailnet only; banking via Enable Banking PSD2 + statement import; documents exported and sent manually; simple cash; sevdesk import from file exports; no Steuerberater — the owner files via Mein ELSTER; portal deferred; go-live (sevdesk off) at the end of P2, P1 is a pilot) · Research: [`../research/00-sevdesk-feature-inventory.md`](../research/00-sevdesk-feature-inventory.md), [`02`](../research/02-competitor-gap-features.md), [`07`](../research/07-sevdesk-bookkeeping-banking.md), [`08`](../research/08-sevdesk-invoicing.md), [`09`](../research/09-sevdesk-contacts-products-reports.md)

## 1. Vision

A self-hosted invoicing and bookkeeping app for **one German small business**. It is functionally a 1:1 replacement for sevdesk ("Buchhaltung Pro" tier plus the add-ons), and it adds what sevdesk lacks. Three things set it apart:

1. **Compliance by construction.** German invoicing law, E-Rechnung, GoBD and retention rules are encoded as tested, date-effective rules ([01-compliance.md](01-compliance.md)). An illegal document cannot be produced through the UI, the API or MCP.
2. **AI-native operation.** Everything can be done through Claude via MCP ([06-mcp.md](06-mcp.md)), with safe drafts, previews and explicit approval for legal acts.
3. **Integration-first.** A complete REST API for the business website, reachable inside the tailnet ([05-api.md](05-api.md)).

**Non-goals:** multi-tenant SaaS, payroll, a cash register/POS (§146a) or cash book, balance sheet/E-Bilanz (needs an external tool or advisor; DATEV export in P3), direct ELSTER transmission in v1 (ERiC is a P4 option), sending e-mails to customers, a public internet endpoint.

## 2. Users

| Persona | Needs |
|---|---|
| **Owner** (German-speaking, desktop + phone, signs in with a passkey) | Write quotes and invoices fast, export and send them, never worry about legal details, see who owes what, file UStVA/ZM/EÜR in Mein ELSTER with step-by-step guidance (no Steuerberater) |
| **Claude** (via MCP) | A structured, well-described tool surface; clear errors; previews; no way to break the law |
| **Website** (via REST, server inside the tailnet) | Create customers and invoices from checkout or contact forms; read products; poll for payment status |
| **Steuerberater** (none today; optional later) | One-off check of the decided legal defaults (recommended, non-blocking); DATEV export (P3) if one is engaged later |
| **Betriebsprüfer** (tax auditor) | Z1/Z2/Z3 data access via a time-limited user with role `auditor`, Verfahrensdokumentation |
| **Customers** of the business | Receive exported invoices from the owner by the channel the owner chooses; portal deferred (F10) |

## 3. sevdesk parity matrix

Legend: ✅ parity · ➕ better than sevdesk · 🆕 sevdesk lacks it · ⛔ intentionally out of scope (⛔→ x = replaced by a simpler or manual variant x). The phase is the delivery phase ([09-roadmap.md](09-roadmap.md)).

### 3.1 Sales

| sevdesk feature | Our implementation | Status | Phase | Spec |
|---|---|---|---|---|
| Rechnung (RE), statuses Entwurf/Offen/Fällig/Teilbezahlt/Bezahlt/Storno | Same lifecycle + "überfällig" derived + artifact status | ✅ | P1 | F04 |
| Abschlags-, Teil-, Schlussrechnung | Same; Schlussrechnung deducts advances with the correct VAT incl. a rate change | ➕ | P1 | F04 |
| Stornorechnung (only open invoices) | Storno for unpaid; Rechnungskorrektur for paid ones | ✅ | P1 | F04 |
| Gutschrift (Minderleistung, Provision, Honorar) | **Rechnungskorrektur** (commercial) separated from **Gutschrift** (self-billing, P3), correct terminology (UST-33) | ➕ | P1/P3 | F04 |
| No negative invoices | Same (total ≥ 0; corrections carry negative amounts by type) | ✅ | P1 | F04 |
| Wiederkehrende Rechnungen (intervals 7 days–5 years, auto-send) | Same intervals + end after N, catch-up, preview; automation finalises, the owner exports and sends (to-do) | ✅/➕ | P1 | F04 |
| Angebote (optional positions, online acceptance) | Same; manual acceptance; online acceptance deferred with the portal | ✅ | P1 | F04, F10 |
| Auftragsbestätigung, Lieferschein, Pro-forma (workaround) | Dedicated types incl. **proforma** | ➕ | P1 | F04 |
| Conversion chain + "Verknüpfte Dokumente" | Same + chain view | ✅ | P1 | F04 |
| Nummernkreise (one per type, fixed variables) | Several ranges per type, tokens `{YYYY}{MM}{#####}`, yearly reset, gap report, number register | ➕ | P0/P1 | F01 |
| Kopf-/Fußtexte, Textvorlagen, Platzhalter | Same + a documented placeholder dictionary | ✅ | P1 | F01 |
| Layouts (11, premium), Briefpapier, HTML templates | 3 built-in layouts (versioned) + letterhead PDF; own templates later (react-pdf components) | ✅ | P1 | F01, F04 |
| Druckoptionen (fold marks, page numbers, EPC-QR, …) | Same | ✅ | P1 | F01 |
| Gesamtrabatt/Aufschlag, Positionsrabatt | Same | ✅ | P1 | F04 |
| Headings via 0-quantity lines | Real line kinds: heading, text, **subtotal**, optional | ➕ | P1 | F04 |
| Mehrwährung, DE/EN documents | Same + EUR VAT amounts (MISC-08) | ✅ | P1 | F04 |
| Umsatzsteuerregeln (taxRule 1–21, OSS) | Tax-case derivation with explicit cases; OSS blocked until P4 | ✅ | P1/P4 | F04 |
| Kleinunternehmer §19 | + 25k/100k monitor with a blocking dialog (KU-01) | ➕ | P1 | F01, F08 |
| E-Rechnung ZUGFeRD + XRechnung, EN 16931 check | ZUGFeRD 2.5 EN16931 / XRechnung 3.0.2 UBL+CII, **KoSIT + Mustang validation archived**; export for e-mail or portal upload (ZRE/OZG-RE) | ➕ | P1 | F04 |
| Versand E-Mail (own SMTP), Download, Druck | **Manual sending**: „Exportieren“ (archived originals) + „Als versendet markieren“ with date, channel and artifact hashes; no e-mail sending from the app | ⛔→ manual | P1 | F04 |
| Versand per Post (emailbrief.de) | Out of scope (print, then mark as sent with channel `post`) | ⛔ | — | F04 |
| PayPal link, EPC-QR | EPC-QR ✅; payment links/online payments deferred with the portal | ✅/⛔ | P1 / deferred | F04, F10 |
| Mahnungen (unlimited levels, manual, no fees via API) | **Dunning policies** with fees, §288 interest, 40 € flat fee, pause rules; reminders are drafted/finalised automatically, exported and marked sent by the owner | 🆕 | P1 | F05 |

### 3.2 Contacts and products

| sevdesk | Ours | Status | Phase | Spec |
|---|---|---|---|---|
| Organisation/Person, categories, addresses, communication ways, custom fields, tags, history, tasks, merge, CSV import | Same | ✅ | P1 | F02 |
| No VAT-ID check | **BZSt eVatR (qualified) + VIES**, evidence stored | 🆕 | P1 | F02 |
| Debitor/Kreditor numbers | Same (DATEV ranges) | ✅ | P1 | F02 |
| Leitweg-ID, Behörde | + checksum validation | ➕ | P1 | F02 |
| Products: units, extra units, net/gross, purchase price, stock (add-on), customer prices | Same; 4-decimal prices; stock in P4 | ✅ | P1/P4 | F03 |
| — | §35a labour share, customer statistics, e-invoice/PDF consent per customer | 🆕 | P1 | F02, F03 |

### 3.3 Purchases, banking, cash

| sevdesk | Ours | Status | Phase | Spec |
|---|---|---|---|---|
| Belegerfassung (upload, drag&drop, app, Autobox e-mail), AI OCR, category learning | Same; XML first, Claude OCR with confidence + review queue; e-mail-in address via Cloudflare Email Routing → R2 (polled) | ✅/➕ | P2 | F06 |
| E-Rechnung empfangen (Mustang validation, readable view) | KoSIT + Mustang, original byte-identical with hash, MINIMUM/BASIC-WL flagged | ➕ | P2 | F06 |
| Image-reuse warning only | Content-based duplicate detection | 🆕 | P2 | F06 |
| Bewirtung (70/30, no participants field) | Structured Eigenbeleg with participants and occasion (MISC-05) | ➕ | P2 | F06 |
| Wiederkehrende Belege, Eigenbeleg, durchlaufende Posten | Same | ✅ | P2 | F06 |
| finAPI bank connection (PSD2, re-authorisation every 180 days) | **Same PSD2 approach via Enable Banking** (restricted mode, 0 €; sevdesk uses finAPI): 180-day consent with reminders, polling every 6 h; plus **CAMT.053/CSV/MT940 statement import with the signed PDF** (P1 pilot path; afterwards the fallback and the monthly signed-PDF archive) | ✅/➕ | P1 (import) / P2 (feed) | F07 |
| CSV import without duplicate check | Dedupe keys, cross-source dedupe (feed ↔ statements), balance continuity check | ➕ | P1 | F07 |
| Auto-Zuordnung (priority of criteria) | Scoring engine (invoice number first) + **user-defined matching rules** (P2) | 🆕 | P1/P2 | F07 |
| Private/Geldtransit/Darlehen marking | Same | ✅ | P1/P2 | F07 |
| Sammelüberweisung via finAPI | Out: bank access is **read-only** (account information only); payments are made in the Revolut app | ⛔ | — | F07 |
| Kassenbuch (immutable, counter-entries) | **Simple cash instead**: „Bar bezahlt“ on invoices, cash deposit/withdrawal, never-negative check incl. backdating, daily-recording warning, Quittung; no cash book | ⛔→ simplified | P1 | F07 |

### 3.4 Accounting, tax, reports, exports

| sevdesk | Ours | Status | Phase | Spec |
|---|---|---|---|---|
| SKR03/SKR04, EÜR/GuV, Soll/Ist | Same | ✅ | P2/P3 | F08 |
| No manual journal entries / opening balances | **Manual entries + opening balances** | 🆕 | P2 | F08 |
| Anlagen/AfA (linear, GWG; no pool, no Anlagenspiegel) | Linear, degressive, GWG, **Sammelposten**, e-vehicle, disposal, **Anlagenspiegel** | ➕ | P2 | F08 |
| Festschreibung | Period lock + auto-lock on UStVA confirmation + DATEV export option | ✅ | P2 | F08 |
| UStVA via ELSTER | Kennzahlen sheet + drill-down with **step-by-step Mein ELSTER instructions**, manual entry, Transferticket + lock (ERiC P4) | ⛔→ guided | P2 | F08 |
| No ZM, no OSS return | ZM sheet with Mein ELSTER instructions; OSS P4 | 🆕 | P2/P4 | F08 |
| EÜR (Anlage EÜR lines), GuV, BWA (Pro), SuSa (beta) | EÜR with Anlage EÜR line values + Mein ELSTER instructions, BWA-light, SuSa, Kontenblatt, open items, revenue reports | ✅/➕ | P3 | F08 |
| Dashboard KPIs, Buchhaltungsscore | Same + liquidity forecast, tax reserve, KU monitor | ➕ | P3 | F08, 04 |
| DATEV export (CSV/XML, Belegbilder), DATEV Unternehmen online | EXTF Buchungsstapel + master data + document ZIP for a future Steuerberater (low priority) | ✅ | P3 | F09 |
| No GDPdU/Z3 export, no Verfahrensdokumentation | **GDPdU Z3 export + generated Verfahrensdokumentation** | 🆕 | P1/P3 | F09, F12 |
| Kostenstellen (Pro, one per document) | Per document **and per line** | ➕ | P2 | F08 |

### 3.5 Platform

| sevdesk | Ours | Status | Phase | Spec |
|---|---|---|---|---|
| REST API (Pro only), one token per admin, no webhooks | Scoped keys, OpenAPI, idempotency; tailnet-only (website server joins the tailnet) | ➕ | P1 | 05 |
| — | **MCP server** (Claude Code / Desktop inside the tailnet) | 🆕 | P1 | 06 |
| Users and rights, MFA | **Login with passkey + e-mail OTP** (Better Auth), invite-only users with roles (owner, bookkeeper, viewer, auditor), tailnet-only network | ✅ | P0 | 02 |
| Steuerberater portal | Time-limited user with role `auditor` (read-only) + exports | ✅ | P3 | F12 |
| Mobile app (iOS/Android) | Responsive web + PWA (camera capture, share target) | ✅ | P1/P2 | 04 |
| Zeiterfassung add-on (no timer, no projects) | Time tracking with a timer + projects with budgets | ➕ | P4 | F11 |
| Aufgaben, Dokumente file manager | Tasks in the contact timeline; files attached to records | ✅ | P1 | F02 |
| Integrations marketplace | REST + n8n compatibility inside the tailnet; sevdesk importer from file exports | ✅ | P1 | F09 |
| Not multi-company | Single company (same) | ✅ | — | — |
| Lohn | Out of scope | ⛔ | — | — |

## 4. Success criteria

1. **Legal:** zero KoSIT/Mustang errors on generated invoices; UStVA values entered in Mein ELSTER for 2 consecutive real quarters without a cross-check mismatch (Kz 83) and without later corrections; the decided legal defaults were reviewed once by a Steuerberater (recommended, non-blocking).
2. **Productivity:** creating, exporting and marking a standard invoice as sent takes ≤ 60 s on desktop and ≤ 2 min on a phone; importing a monthly bank statement and confirming its matches takes ≤ 5 min; finishing a receipt from the inbox takes ≤ 15 s on average.
3. **AI:** the 20-prompt MCP eval passes 20/20 with no unapproved legal act.
4. **Reliability:** no lost data (restore drill monthly); integrity check green every day.
5. **Migration:** all sevdesk contacts, products, open items and historical invoices (with PDFs) are imported from sevdesk's file exports at the production go-live (end of P2, at the start of a VAT period, 09); sevdesk is cancelled only after the first UStVA from the app was submitted without a cross-check mismatch.
6. **Pilot:** P1 runs on the production stack with training data and a real-data import dry run; no real Beleg is issued from the app before the go-live.

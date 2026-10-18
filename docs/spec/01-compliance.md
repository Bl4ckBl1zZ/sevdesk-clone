# 01 — Compliance Requirements (normative)

> **Status:** v1.1 · 2026-10-12 (owner decisions applied: login + tailnet, no customer e-mailing — export + manual sent mark (MAIL-02/04), simple cash (AO-05), bank data via statement import and Enable Banking, no Steuerberater — the owner files via Mein ELSTER, DATEV P3; open items now carry decided defaults) · Source research: [`../research/01-german-compliance.md`](../research/01-german-compliance.md) (full legal basis, citations, edge cases).
>
> Every requirement here has a stable ID. Tests MUST reference the ID in their name (e.g. `test("UST-06 numbers are unique under concurrency", …)`), so the CI traceability report (see [07-testing.md](07-testing.md#traceability)) can prove that each requirement is covered.
>
> **Disclaimer:** This catalog is a careful technical translation of German/EU law as of October 2026. It is **not legal or tax advice**. The owner works without a Steuerberater; every uncertain item has a **decided conservative default** in [§ Legal open items — decided defaults](#legal-open-items--decided-defaults). A one-off check of those items by a Steuerberater before go-live is recommended (non-blocking). The Verfahrensdokumentation (GOBD-10) remains the business owner's responsibility.

## How to read this

| Column | Meaning |
|---|---|
| **ID** | Stable requirement ID (also used in tests and code comments) |
| **Rule** | Short version. Full text, legal basis and examples are in the research doc under the same ID |
| **Enforced in** | `domain` = pure TS rule module (`src/domain/**`), `convex` = mutation guard, `ui` = form/UX, `xml` = E-Rechnung generator, `pdf` = PDF renderer, `ops` = deployment/runbook, `docs` = Verfahrensdokumentation |
| **Test** | `U` unit (Vitest), `C` Convex function test (convex-test), `G` golden file (PDF/XML/CSV snapshot + validator), `E` Playwright E2E, `V` external validator (KoSIT / Mustang / veraPDF), `M` manual review |
| **Phase** | Delivery phase (see [09-roadmap.md](09-roadmap.md)) |

### Design rules derived from the law (apply everywhere)

1. **Date-effective rules engine.** Every tax rate, threshold, form mapping (UStVA Kennzahlen, Anlage EÜR lines), Basiszinssatz, AfA rule and invoice-note requirement is a **versioned row with `validFrom`/`validTo`**. The rule is chosen by the **date of supply** (Leistungsdatum), or by the invoice date where the law says so. When the law changes, we add data, not code. See [`src/domain/rules/`](02-architecture.md#3-repository-layout).
2. **Immutability after finalisation.** Drafts are free to edit or delete. Finalised documents, bookings, vouchers and audit entries are **never** updated or deleted; they are only corrected by new documents (Storno, Rechnungskorrektur, Generalumkehr).
3. **One data model, two renderings.** PDF and E-Rechnung XML are rendered from the **same frozen invoice snapshot** (EN 16931 semantic model, BT-keyed), so they cannot disagree.
4. **Everything is attributable.** Every mutation records an actor in the canonical form `"<kind>:<id>"` (`user:<id>` for signed-in users incl. the owner, `api-key:<keyId>`, `mcp:<keyId>`, `system:cron.<job>` / `system:<job>`; the auditor is a read-only user role, not an actor kind; see [02-architecture §4.3](02-architecture.md)) plus the key name where applicable, a channel (`ui`, `api`, `mcp`, `cron`, `import`), a timestamp and a reason when required.
5. **Money is integer cents.** Quantities and unit prices use fixed-scale integers. Rounding follows EN 16931 (half-up, at line and VAT-category level). Floating-point math on money is forbidden (lint rule).

---

## A. Umsatzsteuer — invoice content (§14, §14a UStG; §§31–34a UStDV)

| ID | Rule | Enforced in | Test | Phase |
|---|---|---|---|---|
| UST-01 | Invoice is mandatory within 6 months for B2B, legal persons, and property-related B2C. Warn at day 150 and escalate at day 180 for supplies without an invoice (delivery notes and time entries that have not been billed) | domain, ui | C,U | P2 |
| UST-02 | §14a deadline: invoice by the 15th of the following month for EU B2B services and intra-Community supplies. Show the due date and warn before it | domain, ui | U | P1 |
| UST-03 | Full name and address of supplier and recipient are required. The address is a **snapshot** on the document; later customer edits never change issued documents | domain, convex | C,G | P1 |
| UST-04 | Supplier Steuernummer **or** USt-IdNr on every invoice (§14a cases: **both parties' USt-IdNr**). Validate formats (DE USt-IdNr MOD 11,10 check digit; Steuernummer 10/11/13-digit) | domain | U | P1 |
| UST-05 | Invoice date is set at finalisation and is ≤ today. Backdating more than N days (default 10) requires a reason, which goes into the audit log | domain, convex | C | P1 |
| UST-06 | Unique invoice number assigned **atomically at finalisation**, never on drafts, never reused (also not after Storno). Multiple configurable ranges. Uniqueness enforced across ranges. ≤ 36 chars from `[A-Za-z0-9$%&*+\-/]` (DATEV Belegfeld 1). Number register with status | convex | C (1,000 parallel finalisations) | P1 |
| UST-07 | Every line has quantity, unit (UN/ECE Rec 20 code) and a specific description. Warn on generic descriptions ("Diverses", "Leistung", "Pauschale") | domain, ui | U | P1 |
| UST-08 | Supply date or service period (date, range or month) is mandatory and always printed, also when it equals the invoice date. XML BT-72 or BG-14 | domain, xml, pdf | U,G | P1 |
| UST-09 | Net amounts broken down per tax rate or exemption. Agreed reductions (Skonto) printed. XRechnung BT-20 Skonto syntax `#SKONTO#TAGE=14#PROZENT=2.00#` | domain, xml, pdf | G,V | P1 |
| UST-10 | VAT category per line (S/Z/E/AE/K/G/O + Kleinunternehmer). VAT computed per category on the sum of line nets, rounded half-up (BR-CO-17). Non-standard categories auto-print the legal note | domain, xml, pdf | U,G,V | P1 |
| UST-11 | Self-billing documents always carry the word "Gutschrift" (TypeCode 389) | domain, pdf, xml | G | P3 |
| UST-12 | Property-related B2C invoices print the 2-year retention note (§14b Abs. 1 S. 5) | domain, pdf | G | P1 |
| UST-13 | **From invoice date ≥ 2028-01-01:** Ist-taxing companies print "Versteuerung nach vereinnahmten Entgelten" on all invoices (also Kleinbetrag). Implement now as a date-effective rule | domain, pdf, xml | U,G | P1 |
| UST-14 | Kleinbetragsrechnung mode only if gross ≤ 250.00 € and the category is not K/AE/§3c. We still assign a number and keep full data | domain | U | P1 |
| UST-15 | Rates 19 / 7 / 0 (PV) chosen by **supply date** from the rate table. Restaurant food 7 % from 2026-01-01 (drinks 19 %). PV 0 % = category Z, not exempt | domain | U | P1 |
| KU-01 | Kleinunternehmer monitor: prior year ≤ 25,000 €, current year ≤ 100,000 € (founding year: 25,000 € hard cap). Warnings at 80 % and 95 %. The invoice that crosses 100k and every later one are taxed normally (blocking dialog) | domain, ui | U,C,E | P1 |
| KU-02 | Kleinunternehmer invoice: no VAT shown, mandatory §19 note (configurable text, default "Steuerfreie Leistung gemäß § 19 Abs. 1 UStG (Kleinunternehmerregelung)"). Numbers and supply dates are still assigned | domain, pdf, xml | G | P1 |
| KU-03 | In KU mode a VAT rate cannot be selected (API/MCP rejects it). Override needs confirmation plus an audit entry (§14c risk) | convex | C | P1 |
| KU-04 | Waiver of KU status is binding for 5 years. Settings store effective dates; switching back is blocked or warned | domain, ui | U | P1 |
| KU-05 | KU mode disables UStVA unless there are §13b liabilities. Optional §19a EU-KU fields | domain | U | P3 |
| UST-20 | EU B2B service: text "Steuerschuldnerschaft des Leistungsempfängers", both USt-IdNrs, validated foreign customer USt-IdNr, XML AE / VATEX-EU-AE, ZM + Kz 21 | domain, xml, pdf | G,V | P1 |
| UST-21 | Intra-Community supply: §4 Nr. 1b/§6a text, both USt-IdNrs, VATEX-EU-IC. Proof of transport (Gelangensbestätigung) attachment, warn if missing. ZM + Kz 41 | domain, xml | G,V | P1 |
| UST-22 | Domestic §13b: text, no VAT, XML AE. Customer USt 1 TG certificate with expiry; warn when it is missing or expired. Kz 60 | domain | G | P1 |
| UST-23 | Export (G, §4 Nr. 1a/§6) and not taxable in Germany (O, §3a Abs. 2) with auto-texts. Kz 43/45 | domain, xml | G,V | P1 |
| UST-24 | §25/§25a margin schemes: **out of scope v1 and explicitly blocked** (clear error message) | domain | U | P1 |
| UST-30 | Issued documents are read-only (API returns 409). Corrections only via Rechnungsberichtigung (references original number and date) or Storno (full mirror, own number, BT-25/26 reference, sums to 0) plus a new invoice | convex, xml | C,G | P1 |
| UST-31 | UI explains Berichtigung (keeps original date, retroactive) vs Storno and recommends Berichtigung for formal defects | ui | M | P1 |
| UST-32 | Skonto and other price reductions are recorded as payment-level adjustments with a VAT correction; no new invoice document (BMF 15.10.2025) | domain | C | P1 |
| UST-33 | Separate types: "Rechnungskorrektur" (commercial credit note, never labelled "Gutschrift") vs "Gutschrift" (self-billing, requires a stored self-billing agreement) | domain, pdf | G | P1/P3 |
| UST-34 | Prevent VAT on E/K/AE/G/O/KU categories. Re-downloads are marked "Kopie" (the original artifact stays byte-identical). §14c amounts reported separately (Kz 69) | domain, pdf | C,G | P1 |
| UST-40 | Two different document kinds, both linked to an order or project: **(a) Teilrechnung** for a completed, separately accepted **Teilleistung** — billed by quantity (selected order lines), a normal invoice with its own supply date; VAT arises with that Teilleistung under the normal rules and it is **not** deducted in the final invoice (F04 INV-05). **(b) Abschlags-/Anzahlungsrechnung** — amount-based (percent/net/gross of the order) before the supply is complete (F04 `advance_invoice` and amount-based `partial_invoice`); output VAT is due on **receipt of payment** (Mindest-Ist, §13 Abs. 1 Nr. 1 Buchst. a S. 4 UStG), also for Soll-taxing companies, and the payments received are deducted in the Schlussrechnung (UST-41) | domain | C | P1 |
| UST-41 | Schlussrechnung shows the total supply, deducts each advance (net + VAT at the advance's rate) and shows the remainder. Handles a rate change between advance and supply. Golden tests from research §2.6 | domain, pdf, xml | U,G,V | P1 |
| UST-50 | Invoice retention 8 years (§14b). See GOBD-20 | domain | U | P1 |

## B. E-Rechnung (Wachstumschancengesetz; BMF 15.10.2025)

| ID | Rule | Enforced in | Test | Phase |
|---|---|---|---|---|
| ER-01 | Generate **XRechnung 3.0.2** (UBL **and** CII) and **ZUGFeRD 2.5.x / Factur-X 1.09** hybrid (profile EN 16931 by default, XRECHNUNG optional). Never MINIMUM/BASIC-WL for invoices. PDF and XML come from the same snapshot | xml, pdf | G,V | P1 |
| ER-02 | **Receive** E-Rechnungen: XRechnung UBL/CII + ZUGFeRD/Factur-X (extract embedded XML, detect profile). Readable rendering. Store the original byte-identical with SHA-256. Store the validation report. Prefill a purchase voucher. Flag MINIMUM/BASIC-WL as "keine E-Rechnung i.S.d. §14 UStG" | xml, convex | G,V (KoSIT test suite + FeRD samples) | P2 |
| ER-03 | Decision function `requiresERechnung(issuer, recipient, supply, invoiceDate)` → `MUST_E` / `MAY_PAPER_OR_PDF` / `PDF_NEEDS_CONSENT` / `NOT_REQUIRED`. Covers the 2025–2027 transition rules of **§27 Abs. 38 UStG**, which are keyed on the **date of supply** (Leistungsdatum, end of the service period), **not** the invoice date: supplies executed in 2025–2026 may still be invoiced on paper (other electronic formats such as PDF only with the recipient's consent); supplies executed in 2027 likewise if the issuer's prior-year Gesamtumsatz ≤ 800,000 € (EDI until end of 2027); supplies executed from 2028-01-01 require an E-Rechnung (F04 App. D, golden ER03-02: supply 2026-12-31 invoiced 2027-01-10 → transition applies). Also covers Kleinbetrag, Fahrausweis, KU, B2C, foreign recipients, §9 option. Enforced at finalisation, in the export dialog and in the mark-sent dialog (MAIL-04) | domain | U (table-driven, research §3.1 cases) | P1 |
| ER-04 | Recurring invoices produce a valid E-Rechnung per period (BG-14 period, BT-12 contract reference) | domain, xml | G,V | P1 |
| ER-10 | XRechnung rules: BT-10 Buyer reference (Leitweg-ID for B2G; customer reference or placeholder for B2B), seller contact BT-41/42/43, electronic addresses BT-34/BT-49, payment instructions BG-16..19 | domain, xml | V | P1 |
| ER-11 | ZUGFeRD container: PDF/A-3 with embedded `factur-x.xml` (or `xrechnung.xml`), AFRelationship, Factur-X XMP extension schema, ICC output intent, embedded fonts | pdf | V (veraPDF + Mustang) | P1 |
| ER-12 | Validate every outbound XML with the KoSIT validator (current XRechnung config bundle) and the ZUGFeRD Schematron. **Errors block finalisation, export and the sent mark.** Archive the validation report (8 years) with the validator version. Track bundle updates (Feb/Aug) | xml, ops | V,C | P1 |
| ER-13 | Archive the XML (mandatory) and PDF unaltered and hashed. Booking notes are stored as metadata, never written into the file | convex | C | P1 |
| ER-20 | B2G: customer type "öffentlicher Auftraggeber" makes the Leitweg-ID mandatory (format + ISO 7064 Mod 97-10 check; valid examples `04011000-1234512345-06`, `991-01234-38`). XRechnung export for manual portal upload (ZRE/OZG-RE; mark channel `upload_portal`). Peppol later via an Access Point | domain | U | P1 / Peppol P4 |
| ER-30 | Format-agnostic EN 16931 semantic model plus a pluggable transmission layer (ViDA 2030, XRechnung 4.0 in 2027) | domain | M | P1 |

## C. GoBD / AO / HGB

| ID | Rule | Enforced in | Test | Phase |
|---|---|---|---|---|
| GOBD-01 | Traceability: every booking links to its voucher; every report figure drills down to bookings and back | convex, ui | E | P2/P3 |
| GOBD-02 | Completeness: nothing is removable. Number-range gap report. Bank import balance-continuity check | convex | C | P1/P2 |
| GOBD-03 | Correctness: server-side validation on every path (UI, API, MCP, import). Property-based tests on totals | domain | U (fast-check) | P1 |
| GOBD-04 | `recordedAt` timestamp separate from the voucher date. "Unbooked > 10 days" list. Cash: daily recording of cash receipts and payments (§146 Abs. 1 S. 2 AO) — warning when a cash payment is recorded more than 1 day late, reason when more than 10 days (F07 CSH-021) | convex, ui | C | P1/P2 |
| GOBD-05 | Order: chronological journal, unique voucher IDs, gapless internal journal sequence | convex | C | P2 |
| GOBD-06 | **Immutability + logging.** Lifecycle `draft → finalized → (cancelled via Storno)`. Period lock (Festschreibung). No hard deletes of finalised data. Append-only hash-chained audit log (`hash = SHA-256(prevHash ‖ canonicalJSON(entry))`). SHA-256 of each issued artifact. Versioned master data, template version per document | convex | C (tamper tests, mutation-inventory test) | P0/P1 |
| GOBD-07 | Every booking needs a voucher. Originals unaltered with hash. Eigenbeleg template | convex, ui | C | P2 |
| GOBD-08 | Ersetzendes Scannen: hash and capture metadata at upload, image unaltered, OCR text separate, versioned replacement. Ship a scanning procedure template | convex, docs | C | P2 |
| GOBD-09 | Internal control: login with passkey/e-mail OTP and tailnet-only access (SEC-01), roles, backups, restore drills, integrity checks | ops | M,E | P0 |
| GOBD-10 | Ship a pre-filled, versioned **Verfahrensdokumentation** generated from settings and software version (10-year retention) | docs | M | P1 (v1), P3 (complete) |
| GOBD-11 | Datenzugriff: Z1 read-only access for the auditor (time-limited user with role `auditor`, SEC-03); Z2 report builder + CSV; Z3 **GDPdU export** (CSV + `index.xml` per Beschreibungsstandard). Data stays readable after upgrades. DSFinV-BV ready (pluggable exporters) | convex, ui | C,G | P3 |
| GOBD-20 | Retention classes: books, journal, Verfahrensdokumentation, audit log = 10 y; Buchungsbelege incl. invoices = 8 y; business letters (quotes, order confirmations, reminders) = 6 y. `retentionUntil` = end of year + N | domain | U | P1 |
| GOBD-21 | No deletion before `retentionUntil`. Afterwards a manual, logged purge with an "Ablaufhemmung" (no open audit or appeal) confirmation. Anonymise and keep a tombstone | convex, ui | C | P3 |
| GOBD-22 | Store all instants as UTC, display Europe/Berlin. Business dates (`YYYY-MM-DD`) are separate from system timestamps. DST-safe | domain | U | P0 |
| GOBD-23 | Migrations keep originals and stay queryable. Artifact hashes still verify after upgrades | convex, ops | C | P0+ |
| AO-01 | Company profile: legal form + method (EÜR/Bilanz). Block EÜR for GmbH/UG/OHG/KG. 800k/80k threshold monitor. Bilanz companies use the tool as invoicing + subledger with DATEV handover | domain, ui | U | P1 |
| AO-02 | EÜR by payment date (§11 EStG) incl. the 10-day rule for recurring payments around year end; versioned Anlage EÜR mapping per tax year; the yearly Anlage EÜR line values are shown with step-by-step instructions for manual entry in Mein ELSTER (F08) | domain | U,G | P3 |
| AO-03 | Asset register: linear AfA (monthly pro rata), degressive 30 % (acquired 2025-07-01..2027-12-31), e-vehicle 75 %, GWG ≤ 800 € (list > 250 €), Sammelposten 250.01–1,000 € pool. Date-effective (JStG 2026 may change GWG to 1,200 €) | domain | U | P2 |
| AO-04 | **No POS/"Kasse" mode** (would trigger §146a TSE). "Bar bezahlt" is a payment on an issued invoice; there is no cash sale without an invoice. UI and docs state this clearly | domain, docs | M | P0 |
| AO-05 | Cash (no cash book): one cash ledger account whose balance is **never negative at any point in time** (also for backdated entries); cash payments and cash transfers are append-only and corrected only by reversal; every cash movement references an invoice, a voucher or an auto Eigenbeleg (F07 CSH-020…030) | convex | C | P1 |
| AO-06 | German primary language. Books in Germany or EU: the setup records the server location; warn on non-EU backup/telemetry/LLM endpoints (§146 Abs. 2b) | ops, ui | M | P0 |
| AO-07 | Bilanz/E-Bilanz out of scope: a Bilanz company needs an external tool or advisor; the DATEV export (P3) is the handover (stated in the docs) | docs | M | — |

## D. UStVA / ZM / OSS / Soll-Ist

| ID | Rule | Enforced in | Test | Phase |
|---|---|---|---|---|
| UVA-01 | Filing period monthly/quarterly (> 9,000 € → monthly; ≤ 2,000 € waiver possible), Neugründer logic per year, deadline calendar incl. Dauerfristverlängerung and §108 Abs. 3 AO weekend/holiday shift | domain | U | P3 |
| UVA-02 | Dauerfristverlängerung: Sondervorauszahlung 1/11 (Kz 38), offset in December (Kz 39) | domain | U | P3 |
| UVA-03 | Kennzahlen mapping, **versioned per year** (81, 86, 87, 41, 43, 48, 21, 45, 60, 66, 61, 62, 67, 69, 39, 83 …), taken from the official form of the year. Rounding per form rules | domain | G | P3 |
| UVA-04 | **No direct ELSTER transmission in v1.** The app shows the Kennzahlen sheet with **step-by-step instructions for manual entry in Mein ELSTER** (form, field by field, copy buttons); the owner records the submission date and Transferticket (optional protocol PDF), which locks the period. Direct submission via an ERiC sidecar is a P4 option (requires ELSTER developer registration) | domain, ui | G | P3 |
| UVA-05 | Zusammenfassende Meldung per period (USt-IdNr, sum by type), due on the 25th; sheet with instructions for manual entry in Mein ELSTER (CSV optional) | domain | G | P3 |
| UVA-06 | Soll vs Ist (date-effective). Ist splits partial payments pro rata across rates | domain | U | P1 (setting), P3 (reports) |
| UVA-07 | OSS: 10,000 € EU B2C threshold tracking. **v1: block B2C EU sales over the threshold with a clear message**; full OSS (destination rates, OSS report) in P4 | domain | U | P1 block / P4 |

## E. Dunning and late payment (BGB)

| ID | Rule | Enforced in | Test | Phase |
|---|---|---|---|---|
| MAHN-01 | Due date from payment terms. B2C invoices print the §286 Abs. 3 BGB 30-day default note. Receipt (Zugang) derived from the owner's manual sent mark: `email_manual`/`upload_portal`/`hand` = mark date, `post`/`other` = mark date + N days (default 3); a document never marked sent has no Zugang (no automatic Verzug, no dunning) | domain, pdf | U,G | P1 |
| MAHN-02 | Default interest = Basiszinssatz + 5 pts (B2C) / + 9 pts (B2B). Basiszinssatz table with history (1.52 % since 2026-07-01), actual/365, split at rate changes, no compound interest. Golden: 10,000 € from 2026-06-01 to 2026-07-31 → 173.76 € | domain | U | P1 |
| MAHN-03 | 40 € flat fee once per claim, B2B only | domain | U | P1 |
| MAHN-04 | Warn on terms > 60 days (B2B) or > 30 days (public customer) | domain, ui | U | P1 |
| MAHN-05 | Dunning documents immutable once finalised (6-year retention); escalation counts from the previous reminder's Zugang (manual sent mark), never from an automatic timestamp. Limitation warning (3 years from year end) | domain, convex | C | P1 |
| MAHN-06 | Payment-term rules configurable (pending EU Late Payment Regulation) | domain | — | P1 |

## F. DSGVO

| ID | Rule | Enforced in | Test | Phase |
|---|---|---|---|---|
| DSGVO-01 | Art. 30 record of processing template in the docs | docs | M | P1 |
| DSGVO-02 | Deletion (erasure) request: delete non-retained data now, **restrict** the rest (hidden, excluded from processing), and record the purge due date (`scheduledPurgeAt` = max `retentionUntil`). When it is reached the record appears on the **manual purge worklist** (`retention.scan`); the owner executes the logged purge (GOBD-21). Purges are **never automatic** | convex, ui | C | P3 |
| DSGVO-03 | Per-person export (JSON + document list + audit entries) | convex | C | P3 |
| DSGVO-04 | External services list with AVV checkbox (Cloudflare e-mail sending for login mails, Cloudflare R2 backups/checkpoints/e-mail-in, Enable Banking, LLM/OCR). Warn for non-EU endpoints | ui | E | P1 |
| DSGVO-05 | TLS everywhere, encryption at rest (disk/S3 SSE), no PII in debug logs, breach-response doc | ops | M | P0 |
| DSGVO-06 | Technical logs rotated ≤ 90 days with truncated IPs; the GoBD audit log is kept per GOBD-20 | ops | M | P0 |

## G. DATEV

| ID | Rule | Enforced in | Test | Phase |
|---|---|---|---|---|
| DATEV-01 | EXTF Buchungsstapel: header 700 / 21 / version 13, all columns in order, `;` separator, decimal comma, Windows-1252 encoding, `EXTF_Buchungsstapel_<from>_<to>.csv`, one file per fiscal year. Low priority: only for handing data to a future Steuerberater | domain | G | P3 |
| DATEV-02 | Account mapping SKR03 (default) / SKR04 (configurable, defaults from research), BU-Schlüssel table versioned, debtor/creditor personal accounts, master data export (Debitoren/Kreditoren) | domain | G | P1 (mapping) / P3 (export) |
| DATEV-03 | ZIP of PDFs/XMLs named by Belegfeld 1, plus a Beleglink column | domain | G | P3 |
| DATEV-04 | Number format compatible with DATEV OPOS (see UST-06) | domain | U | P1 |

## H. Dispatch, Geschäftsbrief, Security, Misc

| ID | Rule | Enforced in | Test | Phase |
|---|---|---|---|---|
| MAIL-01 | Customer consent to PDF ("sonstige") invoices stored with date and source. The export and mark-sent dialogs use ER-03 to offer only allowed formats/channels (PDF-only on an electronic channel needs consent) | domain, ui | U,E | P1 |
| MAIL-02 | **Dispatch record (no sending by the app).** Documents are exported (archived original bytes) and sent by the owner. „Als versendet markieren“ records date (≤ today, ≥ finalisation), channel (`email_manual`, `post`, `hand`, `upload_portal`, `other`), optional note and the sha256 of the handed-over archived artifacts, append-only; retractions are new rows with a reason. Every export is audited with the artifact hashes | convex | C | P1 |
| MAIL-03 | Geschäftsbrief footer: legal form drives mandatory fields (§37a/§125a/§177a HGB, §35a GmbHG, §80 AktG, §7 PartGG). Finalisation is blocked if missing. The same footer is used on quotes, order confirmations and reminders | domain, pdf | U,G | P1 |
| MAIL-04 | **E-invoice transmission in an electronic format** (§14 Abs. 1 UStG): when ER-03 = `MUST_E`, the effective sent mark requires that the structured e-invoice (ZUGFeRD PDF/A-3 or XRechnung XML) was handed over on an electronic channel; any electronic means the owner chooses is fine (e-mail from the owner's mail client, upload portal, data carrier sent electronically, …); post/hand alone are blocked | domain, ui | U,C | P1 |
| SEC-01 | **Login and network:** Better Auth with passkey (primary) and e-mail OTP; invite-only users with roles; the app is reachable only inside the tailnet (no public host) — or, by owner decision 2026-10-18, through the public edge mode of 08 §12 (Cloudflare → tunnel → Traefik → Caddy; network boundary dropped, login and role checks unchanged). Every route and Server Action checks the session server-side and fails closed. See [02-architecture §4](02-architecture.md) | ops, proxy | E | P0 |
| SEC-02 | Attribution: user/API key/MCP key + role + channel + user agent + session on every audit entry (no client-IP logging; the tailnet edge hides client IPs). Named, revocable API keys; rate limits per API key | convex | C | P0 |
| SEC-03 | Time-limited read-only auditor access: a user with role `auditor` and mandatory expiry (no public token route). Every write route returns 403 for that role (automated route-table test) | proxy, convex | E,C | P3 |
| SEC-04 | Tamper evidence: hash chain, nightly integrity check, signed daily checkpoint exported off-host (Cloudflare R2 checkpoint bucket; a bucket lock on that bucket is recommended but optional), alert on failure | convex, ops | C | P1 |
| SEC-05 | Encrypted, versioned, EU, off-site backups (Cloudflare R2, EU jurisdiction); monthly restore drill; restores are logged (bucket lock optional and only on the checkpoint bucket, SEC-04) | ops | M | P0 |
| SEC-06 | TLS 1.2+, secrets encrypted at rest (AES-GCM with `APP_ENCRYPTION_KEY`), CSRF protection, Host-header validation (DNS rebinding), strict CORS, CSP | proxy | E | P0 |
| SEC-07 | Verfahrensdokumentation "Zugriffskonzept" section | docs | M | P1 |
| MISC-01 | EPC/GiroCode QR (BCD/002/1/SCT, ≤ 331 bytes, ECC M) with the open amount and invoice number. Name equals the account holder (Verification of Payee) | domain, pdf | U,G | P1 |
| MISC-02 | Bank statements: camt.053 import (primary), MT940 and CSV (P1); SEPA direct-debit mandates and pain.008 export are not needed while tailnet-only (deferred with F10) | domain | G | P1 / deferred |
| MISC-03 | B2C documents display gross prices (PAngV) | domain, pdf | G | P1 |
| MISC-04 | USt-IdNr validation: qualified BZSt eVatR (REST) for foreign IDs, VIES for simple checks. Store evidence (10 y). Block K/AE until checked (override is audited) | domain, convex | C (MSW mocks) | P1 |
| MISC-05 | Bewirtung: structured Eigenbeleg (participants, specific occasion), immutable once approved, 70/30 split, 100 % input VAT | domain | C | P2 |
| MISC-06 | Travel expenses: date-effective per-diem table (14 €/28 €, 0.30 €/km) | domain | U | P4 |
| MISC-07 | §35a EStG: labour vs material line type; labour subtotal on B2C invoices | domain, pdf | G | P1 |
| MISC-08 | Foreign currency: VAT also in EUR (BT-6 = EUR, BT-111), rate source logged | domain, xml | G,V | P1 |
| MISC-09 | "Stichtag simulation" harness: inject a hypothetical rate change and verify all document types on both sides of the date | domain | U | P1 |
| MISC-10 | WCAG 2.1 AA goal for UI. Tagged PDF goal | ui, pdf | E (axe) | P1 |

---

## Legal open items — decided defaults

The owner works without a Steuerberater. Each item below is implemented as the **legally safest option** (stricter validation, block rather than warn when unsure, the earlier tax point, keep records longer), as a configurable/date-effective rule with a test for the current assumption and a `// LEGAL-OPEN: 01 item <n>` comment where marked ⚖. **A one-off check of this list by a Steuerberater before go-live is recommended (non-blocking).** The full, deduplicated list across all specs is in [README "Open questions" (a)](README.md#a-legal-open-items--decided-defaults).

| # | Item | Decided default | Refs |
|---|---|---|---|
| 1 | ⚖ Wording and XML location of the 2028 Ist-Versteuerer note | Text „Versteuerung nach vereinnahmten Entgelten“ on every invoice of an Ist-taxing company with invoice date ≥ 2028-01-01, incl. Kleinbetrag; XML BT-22 note subject `REG`; not printed on KU invoices (no VAT shown); rule dated 2028-01-01 | UST-13, F04 9.10 |
| 2 | ⚖ Kleinunternehmer edge cases (crossing 100k, XRechnung category) | The crossing supply and all later ones are taxed normally (blocking dialog, KU-01); the crossing is evaluated on the supply date even when payments lag; XML category E, rate 0, BT-120 = KU note; KU services to EU businesses only with own VAT ID, otherwise blocked | KU-01/02, F04 9.2, 9.11 |
| 3 | ⚖ Neugründer monthly UStVA from 2027 | Monthly filing in the founding year and the following year (the stricter option) | UVA-01 |
| 4 | ⚖ JStG 2026 outcome (GWG 1,200 €, Sammelposten, Kassenpflicht) | Current law (GWG 800 €) until enacted; the new values are prepared as date-effective rows; no cash register exists, so a Kassenpflicht cannot be triggered (AO-04) | AO-03, AO-04 |
| 5 | DATEV format details (version, encoding, BU keys) | EXTF version 13, Windows-1252, BU keys from the versioned table; low priority (P3); a real test import is required before the first handover to an advisor, not before go-live | DATEV-01/02 |
| 6 | ⚖ UStVA Kennzahlen 2026/2027, rounding, ZM layout, Anlage EÜR lines | Taken from the official forms of the year (versioned tables); bases rounded down to whole euros, tax to cents as the form requires; §17 write-offs under Soll in Kz 50; the owner enters values manually in Mein ELSTER using the app's instructions | UVA-03/05, AO-02 |
| 7 | ERiC licence | Only if the P4 ERiC option is built | UVA-04 |
| 8 | XRechnung TypeCodes for Abschlags-/Teilrechnungen and Storno (BR-DE-17) | 326 (advance/partial), 380, 381 (Storno/correction) verified in the P0 KoSIT spike; fallback 380 with the title „Abschlagsrechnung“ and a BT-22 note | UST-40, F04 9.1 |
| 9 | AEAO zu §146a wording on invoicing software | No POS and no cash sales without an invoice, so §146a does not apply; stated in the Verfahrensdokumentation | AO-04 |
| 10 | BMF 15.10.2025 Randziffern (continuing contracts, corrections, self-billing) | One E-Rechnung per period for recurring invoices (ER-04); corrections reference the original (UST-30); self-billing only with a stored agreement (UST-33) | ER-04, UST-30 |
| 11 | ⚖ ER-03 reference date for advance invoices issued before the supply | ER-03 is evaluated with both the document date and the expected supply date (when set); the **stricter** result applies (an E-Rechnung is always allowed); without an expected supply date the document date is used | ER-03, UST-40, F04 9.5 |
| 12 | ⚖ Verzug via a reminder with a printed deadline | Default starts the day after the printed deadline (never earlier than Zugang + 1); `zugang_plus_1` selectable | MAHN-01/02, F05 Q-01 |
| 13 | ⚖ Cash records without a Kassenbuch | Allowed for this business (no cash register, cash only on invoices); enforced: never-negative balance, daily-recording warning, reason for > 10 days, cash report from the journal | AO-05, GOBD-04, F07 Q-09 |
| 14 | Retention of migration evidence and bank statements | Bank statements as Buchungsbelege (8 years); sevdesk source files and the import protocol 10 years (longer is the safer choice) | GOBD-20, F09 IMP-024 |

## What software cannot guarantee

Even a perfect implementation does not make a business "compliant" on its own. The owner must also:

- complete and maintain the **Verfahrensdokumentation** (the generated template covers the software part),
- keep the **login, tailnet access**, backups and restore drills working (SEC-01/05),
- book on time, enter UStVA/ZM/EÜR in Mein ELSTER on time, actually hand the exported invoices to the customers and mark them as sent, renew the bank consent every 180 days, and keep the server in the EU,
- ideally have a Steuerberater review the decided defaults above and the account mapping once (recommended, non-blocking),
- check the release notes when tax rules change (we ship rule-table updates, which must be deployed).

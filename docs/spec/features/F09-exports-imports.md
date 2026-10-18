# F09 — Exports and Imports
> **Status:** v1.1 · 2026-10-12 (owner decisions B4/B5/B7 applied: sevdesk migration from file exports instead of the API, with upload → preview → commit; DATEV export moved to P3 low priority and the Steuerberater test import is no longer a go-live gate; actor/webhook/cash/bank wording aligned) · **Phases:** P1 (sevdesk export import of contacts, products, open items and historical invoices/credit notes with their original PDFs, number range continuation; CSV list exports; PDF-ZIP of documents; full export), P2 (sevdesk vouchers and DATEV history from the sevdesk export, generic/lexoffice CSV imports), P3 (DATEV EXTF incl. master data and document ZIP — **low priority**, GDPdU Z3, Kennzahlen sheets) · **sevdesk parity:** research 00 §16.2, §19, §20 (migration); research 07 §7; research 09 §8 · **Edge cases:** [10-edge-cases.md](../10-edge-cases.md) EC-014, EC-174, EC-183, EC-184, EC-190, EC-201; RI-02, RI-14, RI-20 · **Compliance:** DATEV-01..04, GOBD-01, GOBD-02, GOBD-05, GOBD-06, GOBD-11, GOBD-20, GOBD-23, UST-06, UST-30, SEC-05, AO-06, DSGVO-04

## 1. Scope (in / out, and what we do better than sevdesk)

**In scope**
- **DATEV EXTF Buchungsstapel** (format category 21) from the journal (F08), one file per fiscal year, with validation before export, a Festschreibung flag, export history and safe re-export; **DATEV master data** (category 16 Debitoren/Kreditoren); **document ZIP** with Beleglink. **P3, low priority (B5):** the owner files taxes themselves; the DATEV export exists for a future Steuerberater. Default chart SKR03 (SKR04 selectable, F08).
- **GDPdU / GoBD Z3 export** (CSV + `index.xml` per Beschreibungsstandard, DTD-validated) per fiscal year.
- **Kennzahlen sheets** (UStVA, ZM, EÜR) as PDF/CSV for manual entry in Mein ELSTER (values and step-by-step instructions in F08).
- **CSV export of every list** in the UI (and via API).
- **Full data export** (Convex-native snapshot for restore + human-readable JSON/CSV + all files), restorable into an empty instance with an unchanged audit chain head.
- **sevdesk migration from sevdesk's file exports** (B4; no sevdesk API, no paid API plan): contact CSV, product/article CSV, invoice and voucher list CSVs, the DATEV export produced by sevdesk, the GoBD/„Datenexport" ZIP and the invoice PDFs. Upload → file detection → header-name column mapping (saved mappings) → **preview with validation** → commit or discard. Historical invoices/credit notes become read-only archive records with their original PDF, number ranges continue, open items become open receivables, re-runs are idempotent. **Every sevdesk column name and file layout in this spec is UNSURE until the owner provides sample files** (§4.3).
- **CSV imports**: contacts and products (generic mapping), lexoffice contact/product CSV presets.
- Backup/restore overview (operations live in [08-deployment.md §7](../08-deployment.md#7-backups-and-restore-sec-05-gobd-09)).

**Out of scope**
- DATEV Unternehmen online / DATEV APIs (Buchungsdatenservice, Belegbilderservice, Rechnungsdatenservice) — require DATEV Marketplace partnership (DATEV-03 "later").
- ADDISON, BMD, RZL, Agenda native formats (the generic journal CSV covers them).
- DATEV import (re-importing a DATEV Stapel into our journal) — the internal DATEV parser is used only as a round-trip test parser and to read reference data (debtor numbers, tax keys) from sevdesk's DATEV export (IMP-026); historical bookings never enter our journal.
- sevdesk REST API import (withdrawn, B4) and import of sevdesk bank accounts/transactions (bank history comes from the bank's own statements via F07).
- sevdesk drafts, recurring invoice templates, quotes/order confirmations/delivery notes (no number-bearing legal relevance after cutover; recreated manually; cutover checklist IMP-015).
- DSFinV-BV (§147b AO, draft) — exporters are pluggable so it can be added (GOBD-11).
- Imports from bank formats (F07) and E-Rechnung inbound (F06).

**Better than sevdesk**
- Validation report **before** a DATEV file is written (balanced, accounts, lengths, characters, BU usage, VAT recomputation) — sevdesk users report faulty exports (research 02).
- Export history with delta re-export, duplicate protection and per-file SHA-256.
- GDPdU/Z3 export (sevdesk: none; research 00 §16.3).
- Full, restorable export independent of the subscription (sevdesk deletes data after cancellation).
- sevdesk importer that works from the plain file exports (no API plan needed), keeps original numbers and PDFs, continues number ranges and shows a full validation preview before anything is written (sevdesk offers no own export-to-competitor path; SyncFast only imports into sevdesk).

## 2. User stories

| # | As … | I want … | so that … |
|---|---|---|---|
| US-01 | owner | to export a month/quarter/year for a (future) Steuerberater as DATEV EXTF with the PDFs | he imports it without manual fixes |
| US-02 | owner | the export to tell me before writing the file what is wrong | I don't send broken data |
| US-03 | owner | to export again later without creating duplicates in DATEV | corrections after the first handover are safe |
| US-04 | Steuerberater | Belegfeld 1 = invoice number, the PDF linked per booking, debtor/creditor master data | OPOS and Belegbilder work in DATEV |
| US-05 | Betriebsprüfer | a Z3 data carrier with `index.xml` | I can load it into IDEA |
| US-06 | owner | to export any list as CSV with the current filters | I can analyse in a spreadsheet |
| US-07 | owner | a complete export I can restore or read without the app | I am never locked in, and I meet the 10-year readability duty |
| US-08 | owner | to import sevdesk's file exports (CSV lists, DATEV, PDFs) with original numbers and PDFs | I can cancel sevdesk without losing history and without buying an API plan |
| US-09 | owner | to run the import again with a newer export before cutover without duplicates | I can rehearse and then do a final delta |
| US-12 | owner | to see a preview with counts, errors, duplicates and the continued number ranges before anything is written, and to discard it | a wrong mapping never pollutes my books |
| US-10 | owner | to import contacts/products from a CSV (e.g. lexoffice) | switching from other tools is easy |
| US-11 | Claude (MCP) | to start a DATEV export after the owner approves | month-end can be done in chat |

## 3. Functional requirements

### 3.1 Exports (EXP)

DATEV rows EXP-001…016 are **P3, low priority** (B5): the owner files UStVA/ZM/EÜR personally via Mein ELSTER (F08); the DATEV export is built for a future Steuerberater and is not part of the go-live. Where this section once said "confirm with the Steuerberater", it now states a decided default; a one-off check by a Steuerberater before the first real handover is recommended but never blocks.

| ID | Requirement | Priority | Phase | Compliance refs |
|---|---|---|---|---|
| EXP-001 | DATEV EXTF Buchungsstapel writer (`src/domain/datev/extf.ts`, pure): header line (§4.1.1), column header line (§4.1.2), data lines with **all** columns of the configured format version in order, `;` separator, CRLF line endings, text fields in `"` with `"` doubled, decimal comma without thousands separator, encoding **Windows-1252** | MUST | P3 (low) | DATEV-01 |
| EXP-002 | Header values from settings: Beraternummer (1001–9999999), Mandantennummer (1–99999), WJ-Beginn (from `fiscalYearStartMonth`), Sachkontenlänge (`datev.accountLength`, 4–9), Datum vom/bis, Bezeichnung (≤ 30, e.g. „Rechnungen 10/2026"), Diktatkürzel (2 chars, optional), Buchungstyp 1, Rechnungslegungszweck 0, Festschreibung 0/1, WKZ EUR, Sachkontenrahmen „03"/„04". Missing Berater-/Mandantennummer blocks export | MUST | P3 (low) | DATEV-01 |
| EXP-003 | File naming `EXTF_Buchungsstapel_<YYYYMMDD from>_<YYYYMMDD to>.csv` (plus `_<n>` suffix for re-exports); a range crossing a fiscal year is split into one file per fiscal year inside the ZIP | MUST | P3 (low) | DATEV-01 |
| EXP-004 | Format version configurable (decided default **13**; 12 selectable for an older DATEV installation ⚠ — one-off Steuerberater check before the first handover recommended, non-blocking): the column list is versioned data (`columns.v12.ts`, `columns.v13.ts`); a unit test pins the column count and names per version | MUST | P3 (low) | DATEV-01 |
| EXP-005 | Line mapping from journal entries (F08 §4.2): one DATEV line per (entry, account pair, tax key); gross amount on automatic accounts without BU; BU key on non-automatic accounts; Soll/Haben-Kennzeichen from the perspective of "Konto"; amounts always positive; Belegdatum `TTMM` = journal `date`; Belegfeld 1 = document number (sales: invoice number; vouchers: internal voucher number; decided default: supplier's number in Zusatzinformation „Lieferanten-Rechnungsnr." ⚠); Belegfeld 2 = due date `TTMMJJ` for OPOS (sales; decided default ⚠, one-off Steuerberater check recommended, non-blocking); Buchungstext ≤ 60; KOST1 = cost centre; EU-Land u. UStID for igL/§13b/EU services; Leistungsdatum `TTMMJJJJ` from the supply date / `originalDate`; Datum Zuord. Steuerperiode from `taxPeriod` when it differs from Belegdatum (late postings, F08 ACC-006); Generalumkehr = 1 for reversal entries; Beleglink; Buchungs GUID = journal line UUID; Festschreibung column per export setting | MUST | P3 (low) | DATEV-01, DATEV-02, GOBD-01 |
| EXP-006 | Personal accounts: receivable/payable lines use the contact's debtor/creditor number (length Sachkontenlänge + 1); contacts without a number get one assigned at export (from the configured range) and the assignment is audited; option "Sammelkonten" for Steuerberater who don't want personal accounts | MUST | P3 (low) | DATEV-02 |
| EXP-007 | **Pre-export validation** (blocking errors vs warnings, shown as a report with links): balanced entries; every account exists in the chosen chart and has the right length; personal account numbers in range; Belegfeld 1 ≤ 36 chars from `[A-Za-z0-9$%&*+\-/]` (UST-06/DATEV-04); Buchungstext truncated to 60 (warning); amount ≤ 9,999,999,999.99; BU key not used on automatic accounts; BU key exists in the versioned table; all Belegdatum within header range and fiscal year; characters not representable in Windows-1252 transliterated (warning listing them); every Beleglink target present in the ZIP; DATEV VAT recomputation per line equals our VAT (§4.1.4) | MUST | P3 (low) | DATEV-01, DATEV-02, DATEV-04, GOBD-03 |
| EXP-008 | Scope selection: date range (by journal `date`), include `revenue` (sales documents + their payments), `vouchers`, `payments` (bank and cash payments, cash transfers), `assets` (AfA/disposals), `manual` (manual + opening entries), `master_data`, `documents`; default = all available in the phase | MUST | P3 (low) | DATEV-01 |
| EXP-009 | **Export history** (`datevExports`): range, scope, format version, Festschreibung flag, the exact list of journal line IDs exported, row count, Σ Umsatz, file SHA-256, actor, time; every export is audited; downloads re-serve the stored bytes (never regenerated) | MUST | P3 (low) | GOBD-01, GOBD-06 |
| EXP-010 | **Re-export rules** (EC-174): exporting the same period twice is allowed and the second export is marked as a repeat in the history and in the header Bezeichnung („Wiederholung"); default mode **„Nur neue Buchungen"** exports only journal lines in the range not yet contained in a previous export (late postings and reversals included); mode **„Vollständig neu"** regenerates the range: for a range exported with Festschreibung = 1 the content is identical to the first export (locked periods cannot change; differences would be an integrity error) and the file is marked „nicht erneut importieren"; for unlocked ranges the differences to the previous export are reported and the confirmation „Der Steuerberater muss den vorherigen Stapel {datei} vor dem Import löschen" is required | MUST | P3 (low) | GOBD-06, DATEV-01 |
| EXP-011 | Festschreibung flag: default 1 if every month in the range is locked (F08 ACC-015); option "Zeitraum beim Export festschreiben" locks the months first (reason `datev_export`); exporting unlocked months forces flag 0 and shows a warning | MUST | P3 (low) | GOBD-06, DATEV-01 |
| EXP-012 | Export variant for EÜR + Ist clients: **„OPOS"** (default: invoices on debtor accounts + payments) or **„Nur Zahlungen"** (the writer synthesises cash postings `bank an Erlöse` with BU from payment allocations; no debtor lines) — decided default **„OPOS"**; „Nur Zahlungen" selectable in settings if a future Steuerberater prefers it | SHOULD | P3 (low) | DATEV-02, AO-02 |
| EXP-013 | **DATEV master data** export (category 16 „Debitoren/Kreditoren", version 5 ⚠): one row per contact with debtor/creditor number; key columns per §4.1.5; all columns of the version in order, empty when unknown; same encoding/format rules; included in the ZIP when `master_data` is selected | MUST | P3 (low) | DATEV-02 |
| EXP-014 | **Document ZIP**: one file per exported voucher/document named `<Belegfeld 1>.<ext>` (characters outside the DATEV set replaced by `_`, uniqueness by suffix `_2`); sales: the archived original ZUGFeRD/PDF and the XRechnung XML (`<Belegfeld 1>.xml`); vouchers: the original file(s) byte-identical (multi-file vouchers: `<nr>_1.pdf`, `<nr>_2.jpg`); a `document.xml` index for DATEV „XML-Schnittstelle online" ⚠ mapping each file GUID to the Beleglink; `manifest.csv` with file name, Belegfeld 1, SHA-256 | MUST | P3 (low) | DATEV-03, GOBD-07 |
| EXP-015 | Beleglink column: `BEDI "<GUID>"` (⚠ format) referencing the document GUID in `document.xml`; every Belegfeld 1 in the CSV has exactly one matching file entry (DATEV-03 test) | MUST | P3 (low) | DATEV-03 |
| EXP-016 | **Advisor test import procedure** — **not a go-live gate** (B5); a pre-condition only for the first productive handover of DATEV data to an advisor: generate the "Testpaket" (one month of real data + golden cases: 19/7 %, Skonto, Storno, igL, §13b, payment) → the advisor imports it into a DATEV test client → result recorded in the app (date, Formatversion accepted, BU keys confirmed, advisor name, remarks) as `datevAcceptance` (record type kept, append-only); until recorded, the export page shows the banner „DATEV-Import noch nicht von einem Steuerberater bestätigt" and every DATEV export download requires the confirmation „Testexport – mir ist bekannt, dass der DATEV-Import noch nicht geprüft wurde" (audited). Nothing else in the app depends on it | MUST | P3 (low) | DATEV-01, DATEV-02 |
| EXP-017 | **GDPdU/Z3 export** per fiscal year (job): tables per §4.2.1 as CSV, `index.xml` per Beschreibungsstandard (DTD `gdpdu-01-09-2004.dtd` bundled and referenced), optional `belege/` folder with the original files referenced from the document index table, `README.txt` (German) describing contents and the software version; validated against the DTD (`xmllint --dtdvalid` equivalent in the domain layer via a DTD validator) before the ZIP is offered | MUST | P3 | GOBD-11 |
| EXP-018 | GDPdU encoding/format: UTF-8 (`<UTF8/>`) default, ANSI option (⚠ which the auditor prefers); `;` delimiter, `"` encapsulator, CRLF; decimal symbol `,`, grouping `.` declared; dates `DD.MM.YYYY`; amounts as decimals with `<Accuracy>2</Accuracy>`; primary and foreign keys declared; row counts per table in `README.txt` equal DB counts | MUST | P3 | GOBD-11 |
| EXP-019 | GDPdU export uses a **versioned export schema** (`gdpdu-v1`): each table's columns are defined independently of the internal Convex schema; schema migrations must keep every historical column derivable (GOBD-23); records written under older internal schemas are exported through migration adapters; a test asserts byte-identical output for unchanged data before/after a migration | MUST | P3 | GOBD-11, GOBD-23 |
| EXP-020 | Kennzahlen sheets: UStVA (ELSTER order, with "laut Formular" and "laut Buchhaltung"), ZM (BZSt CSV ⚠ layout + PDF), EÜR (Anlage-EÜR lines with official line numbers of the year) as PDF/A and CSV, used for manual entry in Mein ELSTER (instructions and submission record in F08); footer with generation time, rule versions, period lock status, filing status | MUST | P3 | UVA-04, UVA-05, AO-02 |
| EXP-021 | **CSV export of every list** (documents, contacts, products, vouchers, bank transactions, cash movements (F07 CSH-030), journal, accounts, assets, payments, open items, audit log, time entries, reports): "Export ▾" → „CSV (Excel)" = UTF-8 with BOM, `;`, decimal comma, `DD.MM.YYYY`, amounts in euros; „CSV (technisch)" = UTF-8 without BOM, `,`, ISO dates, `*_cents` integers, IDs included; uses the current filters; > 5,000 rows run as a job | MUST | P1 | GOBD-11 |
| EXP-022 | CSV exports neutralise formula injection (cells starting with `=`, `+`, `-`, `@`, tab, CR are prefixed with `'` in the Excel variant) | MUST | P1 | SEC-06 |
| EXP-023 | **Full data export** (job, `full_export`): ZIP with (a) `convex-snapshot.zip` from the Convex export API incl. file storage (restorable), (b) `tables/<table>.ndjson` (all tables, readable), (c) `files/<sha256>.<ext>` + `files/index.csv`, (d) `gdpdu/` for each fiscal year (if P3 available), (e) `manifest.json` (app version, schema version, instance name, export time, audit head `seq`/`hash`, last checkpoint, per-file SHA-256), (f) `README.txt` (German, how to read and restore). Optional encryption with an `age` recipient key. Contains secrets only as ciphertext | MUST | P1 | GOBD-11, GOBD-23, SEC-05 |
| EXP-024 | Restore from a full export only into an **empty** instance (setup wizard option „Aus Vollexport wiederherstellen" or the ops runbook): verify manifest hashes → `convex import --replace` of the snapshot → `integrity.verify` → the audit head must equal `manifest.json`; the restore itself is the first audit entry after the imported head (action `system.restore`) | MUST | P1 | SEC-05, GOBD-09, SEC-04 |
| EXP-025 | Yearly archive export: on 31.01. a notification suggests a full export + GDPdU for the closed year (stored off-host by the owner; 08-deployment §7 "long-term readability") | SHOULD | P3 | GOBD-23 |
| EXP-026 | All export jobs: progress, cancellable while running, results stored in Convex file storage for 30 days (download link), the export event and file hash audited; jobs by API/MCP actor are attributed | MUST | P1 | GOBD-06, SEC-02 |

### 3.2 Imports (IMP)

All sevdesk column names, status labels, file names and archive layouts referenced below are **UNSURE until the owner provides sample files** (B4). The importer therefore never depends on column positions: it maps by header name through editable, saved mappings (IMP-017); the shipped `sevdesk-*` presets are best guesses and are replaced by mappings verified against the owner's real exports.

| ID | Requirement | Priority | Phase | Compliance refs |
|---|---|---|---|---|
| IMP-001 | **Withdrawn (v1.1)** — B4: no sevdesk REST API importer (no API token, no Pro plan dependency, no rate limits). Replaced by IMP-016, IMP-017, IMP-018 | — | — | — |
| IMP-002 | **Withdrawn (v1.1)** — B4: import order and model mapping from sevdesk API objects no longer apply. Replaced by IMP-018, IMP-020, IMP-021 (§4.3.1) | — | — | — |
| IMP-003 | **Historical documents are archived read-only records**: original number, type, dates, totals per VAT rate, status and contact snapshot reconstructed from the export (IMP-020); `imported: true`; `origin = { source: "sevdesk_export", externalId, importId }`; `lockedAt` = commit time; the archived artifact is the **original PDF from the export** (and an XML e-invoice file if one is supplied), stored byte-identical with SHA-256 as `documentArtifacts.kind = "pdf"` (`"xml"`) with `tool = { name: "sevdesk-import", version }`. **Never re-rendered**: no `documentSnapshots` render, no new PDF/ZUGFeRD, no KoSIT/Mustang re-validation, no new number, no journal posting before Buchungsbeginn. Our validators are not applied retroactively; deviations from current rules (e.g. missing supply date, missing VAT ID) are listed per document in the import report (EC-190) | MUST | P1 | GOBD-06, GOBD-07, UST-30 |
| IMP-004 | Imported numbers are written to the `numberRegister` (status `issued`/`cancelled_by_storno`, `imported: true`) so uniqueness (UST-06) also covers history; collisions with existing numbers block the record with a conflict in the preview | MUST | P1 | UST-06, GOBD-02 |
| IMP-005 | **Number range continuation** (EC-014, F01 SET-065): per document type the preview detects the number patterns of the imported numbers (prefix, year token, counter width, §4.3.6), proposes a range format (`RE-{#####}` / `RE-{YYYY}-{####}`) and `next = max + 1` of the chosen pattern for the current period; the owner confirms at commit; the gap report (GOBD-02) treats the imported max as the start | MUST | P1 | UST-06, GOBD-02 |
| IMP-006 | **Idempotent re-runs** via `importedRecords (externalType, externalId)` with stable keys derived from the export (§4.3.1: contact = customer number, product = article number, document = type + original number, voucher = list row key, file = SHA-256): already imported records are skipped; contacts/products are updated only if unchanged locally since the last import (version check), else listed as conflicts; archived documents are never updated; the run log lists created/skipped/conflicts/errors per kind | MUST | P1 | GOBD-06 |
| IMP-007 | **Open items as open receivables**: invoices open or partially paid at Buchungsbeginn are imported with `openAmountCents` (precedence: explicit open-amount column → gross − paid-amount column → DATEV OPOS (P2, IMP-026) → status "paid" = 0; otherwise blocked, E-IMP-30) and the VAT split of the open amount per rate (pro rata by gross); at commit the matching opening-balance open item is created per invoice through F08's opening-balance service (F08 ACC-013, account details owned by F08), so later payments (F05) and bank matches (F07) clear them and Ist VAT is declared in the payment period. Implementation (2026-10-18): one receivables opening posting for the Buchungsbeginn's fiscal year, `openingItems.documentId` links each item to its archived invoice; a payment recorded on the invoice is redirected to the opening item and the invoice mirrors `openAmountCents`/`paymentStatus` (dunning keeps working); OPOS and bank matching list only the opening item (EC-201). Preconditions are blocking preview errors E-IMP-34/35/36 | MUST | P1 | UVA-06, GOBD-01 |
| IMP-008 | Retention: imported records get `retentionClass`/`retentionUntil` from their original dates (GOBD-20); imported audit entries record source and importer version | MUST | P1 | GOBD-20 |
| IMP-009 | **Import preview** (status `previewed`): computed from the uploaded files and the current mapping without touching business tables; shows counts per kind (contacts, products, invoices, credit notes, cancellations, open items, vouchers), blocking errors, warnings, duplicates (within the files and against existing data), PDF matching result (matched / missing / orphan / ambiguous), detected number patterns with the proposed continuation, open-item total vs. the export's open total, EC-190 deviations, and 10 sample records per kind; downloadable as CSV; stored as `imports.preview` with a `previewHash` over files + mapping + relevant local state | MUST | P1 | GOBD-03 |
| IMP-010 | **Tax information → tax case mapping** (§4.3.2) from whatever the export contains: per-rate amounts/rates in the list CSV, a tax-rule text column if present (UNSURE), and — when the sevdesk DATEV export is supplied (P2, IMP-026) — BU key and revenue account per Belegfeld 1. Conservative rule: anything that is not unambiguously mappable, OSS rules, and 0 % VAT without an explicit reason import as archived with `taxCase = "unknown_imported"` and a warning (never guessed; no UStVA impact before Buchungsbeginn) | MUST | P1 | — |
| IMP-011 | **Withdrawn (v1.1)** — B4: the sevdesk CSV/PDF "fallback" is now the only sevdesk import path. Replaced by IMP-016…IMP-019 | — | — | — |
| IMP-012 | **Generic CSV import** (`imports.source = "generic_csv"`, job `import_csv`) for contacts and products: upload → encoding detection (UTF-8/Windows-1252) → delimiter detection → column mapping UI with saved presets → row validation (same zod schemas as the API) → preview with an error CSV → commit or discard (same `imports` lifecycle as IMP-023); dedupe by number/e-mail/USt-IdNr; idempotency key = SHA-256 of (preset, key column value) in `importedRecords` | MUST | P2 | GOBD-03 |
| IMP-013 | **lexoffice CSV presets** for contacts and products (⚠ header names to verify against a real export) | SHOULD | P2 | — |
| IMP-014 | Every import is audited (upload, preview, commit start/end, discard, counts, actor) and each created record carries `channel = "import"`; the import log is kept with the `imports` row; the committing actor is the user (`user:<id>`) or API key (`api-key:<id>`) who started the commit; the P1 commit runs its batches synchronously inside that actor's action, so they are attributed to the same actor on channel `import` (2026-10-18: `system:import` is reserved for batches scheduled in the background, which P1 does not do — attributing to the human is the more traceable choice); imported audit entries carry the reason `sevdesk-Export, <importer version>, Import <id>` (IMP-008) | MUST | P1 | GOBD-06, SEC-02 |
| IMP-015 | Cutover assistant: checklist „sevdesk einfrieren (keine neuen Belege) → alle Exporte herunterladen (Kontakte-CSV, Artikel-CSV, Rechnungs- und Belegliste als CSV, Rechnungs-PDFs, DATEV-Export, GoBD-/Datenexport-ZIP) → Import-Vorschau prüfen → Import übernehmen → Buchungsbeginn setzen → Nummernkreise bestätigen → offene Posten abgleichen → wiederkehrende Rechnungen neu anlegen → Testrechnung → sevdesk-Exporte extern ablegen (EU-Speicherort)" | SHOULD | P1 | GOBD-20, AO-06 |
| IMP-016 | **sevdesk export import project** (`imports.source = "sevdesk_export"`, job `import_sevdesk_export`): the owner uploads any number of files (CSV, ZIP, PDF, XML; per file ≤ 50 MB, total ≤ 2 GB); ZIPs are unpacked safely on upload (E-IMP-29/39/40; implemented 2026-10-18 in the Node action `importsNode.unpackZip`, reader `src/domain/archive/zip.ts`, rules `src/domain/import/sevdesk/archive.ts`): every contained file becomes an import file of its own (own storage, SHA-256, its path inside the archive as name — nested archives as `inner.zip/file.pdf` —, `container` = the ZIP's file id), is classified like a single upload and deduplicated by SHA-256 (§4.3.5 step 4); the ZIP itself stays in `imports.files` (kind `zip`, `unpacked` = number of files + skipped OS metadata) as archived source file (IMP-024) but is not parsed; directories and OS metadata (`__MACOSX/`, `._*`, `.DS_Store`, `Thumbs.db`, `desktop.ini`) are skipped and reported; removing the ZIP removes its files; a rejected ZIP is deleted and reported while the other files of the same upload are added; the archive and its unpacked files both count towards the 2 GB; every file is classified by content and header (§4.3.1: contacts CSV, products CSV, invoice list CSV, voucher list CSV, DATEV EXTF Buchungsstapel/Stammdaten, document PDF/XML, unknown); the owner can correct the classification; encoding (UTF-8 with/without BOM, Windows-1252), delimiter, decimal and date formats are detected per file and never guessed silently when ambiguous (E-IMP-26); files are stored under the `imports` row (`imports.files`) | MUST | P1 | GOBD-03 |
| IMP-017 | **Header-name column mapping with saved mappings**: each CSV file kind has target fields (required ones highlighted) mapped to source headers by normalised header name (case, umlauts, punctuation, whitespace); shipped best-guess presets `sevdesk-contacts`, `sevdesk-products`, `sevdesk-invoices`, `sevdesk-vouchers` (all UNSURE); the mapping grid shows sample rows; the owner saves corrected mappings as named presets reused by later imports; unknown extra columns are ignored and listed; a missing required column blocks that file (E-IMP-21) | MUST | P1 | GOBD-03 |
| IMP-018 | **Supported sevdesk export files and phases**: P1 — contacts CSV, products/articles CSV, invoice list CSV (invoices, credit notes/Gutschriften, cancellations; drafts ignored), invoice PDFs (single files or ZIP) and XML e-invoice files; the GoBD/„Datenexport" ZIP is accepted and its contained CSV/PDF files are classified like single uploads (layout UNSURE; generic unpacking per IMP-016, so no layout-specific code is needed). P2 — voucher list CSV + voucher files (IMP-025) and the sevdesk DATEV export as reference data (IMP-026). Commit order: contacts → products → sales documents with artifacts → open items → number ranges → (P2) vouchers | MUST | P1/P2 | — |
| IMP-019 | **PDF matching**: document files are matched to list rows by the original document number found in the file name after normalisation (case, separators, leading words such as „Rechnung"/„Gutschrift", extension); fallback (proposal only, owner confirms): the number found in the PDF's first-page text layer; each list row gets at most one PDF (plus optional XML), each file belongs to at most one row; ambiguous matches block the row until resolved (E-IMP-22), orphan files are listed (E-IMP-23), rows without a file need an explicit confirmation (E-IMP-07) | MUST | P1 | GOBD-07 |
| IMP-020 | **Document reconstruction from list rows**: header-level data per document (type, number, document date, supply date/period if present, due date, contact, currency, net/VAT/gross per VAT rate if present, status, paid/open amount, reference to the cancelled/corrected invoice if present). If no positions export exists (expected; UNSURE), `documentLines` hold one summary line per VAT rate („Positionen siehe Original-PDF", `fromSummary: true`); the export's totals are authoritative and stored as-is (E-IMP-08); the original PDF is the legally relevant record | MUST | P1 | GOBD-07, EC-190 |
| IMP-021 | **Contact linking**: imported documents link to imported or existing contacts by customer number; fallback: exact normalised name (+ postcode if present) proposed in the preview for confirmation; rows without a resolvable contact create a minimal contact from the row data flagged „aus Import – unvollständig" (E-IMP-25); the document's contact snapshot is built from the row data (address as printed is in the original PDF) | MUST | P1 | — |
| IMP-022 | **Open-item reconciliation**: the preview compares Σ imported open amounts with the export's open total (list CSV footer/filter or, in P2, debtor balances derived from the sevdesk DATEV export) and with the owner-entered total from sevdesk's open-items view; a difference is a warning that must be acknowledged before commit | SHOULD | P1 | GOBD-01 |
| IMP-023 | **Commit and discard**: commit is allowed only from `previewed` and only with the current `previewHash` (stale preview → E-IMP-27); it runs in resumable batches (`running` → `done`/`failed`); discard is allowed in `uploaded`/`previewed` and removes the uploaded files and preview (status `discarded`, audited; no business data exists yet); once commit has started there is no rollback of archived documents (corrections only per GoBD via new documents; contacts/products remain editable) | MUST | P1 | GOBD-06 |
| IMP-024 | **Migration evidence**: the uploaded source files of a committed import are kept as archived files with SHA-256 (retention = longest retention of the records they produced, at least 10 years) and an import protocol PDF (files + hashes, mapping, counts, deviations, number-range decisions, actor, times) is generated and archived. **Implemented 2026-10-18:** at the end of the commit the Node action `importsNode.renderProtocol` renders „Importprotokoll sevdesk-Export“ (`src/domain/import/sevdesk/protocol.ts` → `src/pdf/import-protocol.tsx`, A4 PDF/A-3b with the embedded fonts) from the frozen `done` row and the commit's audit entries only — import id, importer version, project creation, commit start/end (Europe/Berlin), committing actor with role, retention; every source file with kind, bytes, full SHA-256 and its ZIP (`container`) plus skipped ZIP entries; the mapping per CSV file; all counts (`stats`) and the open-item total; the decisions (number ranges, missing-PDF reason, excluded rows, manual PDF assignments, entered open amounts); the stored findings (EC-190 deviations, E-IMP-32 gaps, …; the preview keeps ≤ 500 and the protocol says so); open points (orphan PDFs, rows without PDF, ignored and not-yet-imported files); the run log. Same row → same bytes (creation date = commit end), so the SHA-256 is stable. The PDF is stored as `imports.protocolFile` (FileRef with SHA-256, set once — the only field the immutability matrix allows on a frozen import; audit `import.protocol`), its retention is the row's `retentionUntil` (longest retention of the produced records, ≥ 10 years). A render failure does not undo the commit: the import page offers „Protokoll erzeugen“ (owner, `imports.generateProtocol`); owner and bookkeeper download it from the import page (`imports.read`); both are referenced from the Verfahrensdokumentation (data migration section, F12) | MUST | P1 | GOBD-20, GOBD-23 |
| IMP-025 | **Historical vouchers** from the voucher list CSV + voucher files: archived `vouchers` with `imported: true`, original files byte-identical with SHA-256, matched by file name/voucher number like IMP-019; tax/account information mapped conservatively (unknown → archived without journal impact); no journal posting before Buchungsbeginn | SHOULD | P2 | GOBD-07, GOBD-20 |
| IMP-026 | **sevdesk DATEV export as reference data** (EXTF Buchungsstapel + Stammdaten, parsed with the internal DATEV parser): debtor/creditor numbers → `contacts.debtorAccount/creditorAccount` (keeps personal accounts stable for a future DATEV export); BU keys and revenue accounts per Belegfeld 1 refine IMP-010 and IMP-022; the file itself is archived as migration evidence (IMP-024); its bookings are **never** imported into our journal | SHOULD | P2 | DATEV-02 |

## 4. Workflows and state machines

### 4.1 DATEV EXTF

#### 4.1.1 Header line (format category 21, header version 700)

Field order per research 01 DATEV-01; fields 23–31 are reserved or rarely used (⚠ verify against developer.datev.de; the writer emits them empty unless stated).

| # | Field | Value | Notes |
|---|---|---|---|
| 1 | Kennzeichen | `"EXTF"` | |
| 2 | Versionsnummer | `700` | |
| 3 | Formatkategorie | `21` | |
| 4 | Formatname | `"Buchungsstapel"` | |
| 5 | Formatversion | `13` (or `12`) | EXP-004 |
| 6 | Erzeugt am | `YYYYMMDDHHMMSSFFF` (Europe/Berlin) | |
| 7 | Importiert | empty | |
| 8 | Herkunft | `"RE"` ⚠ (2 chars) | |
| 9 | Exportiert von | `"<company short name>"` | |
| 10 | Importiert von | empty | |
| 11 | Berater | Beraternummer | 1001–9999999 |
| 12 | Mandant | Mandantennummer | 1–99999 |
| 13 | WJ-Beginn | `YYYYMMDD` | |
| 14 | Sachkontenlänge | 4–9 | |
| 15 | Datum vom | `YYYYMMDD` | |
| 16 | Datum bis | `YYYYMMDD` | |
| 17 | Bezeichnung | ≤ 30 chars | |
| 18 | Diktatkürzel | 2 chars or empty | |
| 19 | Buchungstyp | `1` (Finanzbuchführung) | |
| 20 | Rechnungslegungszweck | `0` | |
| 21 | Festschreibung | `0`/`1` | EXP-011 |
| 22 | WKZ | `"EUR"` | |
| 23 | reserviert | empty | ⚠ |
| 24 | Derivatskennzeichen | empty | ⚠ |
| 25 | reserviert | empty | ⚠ |
| 26 | reserviert | empty | ⚠ |
| 27 | Sachkontenrahmen | `"03"` / `"04"` | |
| 28 | ID der Branchenlösung | empty | ⚠ |
| 29 | reserviert | empty | ⚠ |
| 30 | reserviert | empty | ⚠ |
| 31 | Anwendungsinformation | empty | ⚠ |

#### 4.1.2 Columns (format version 13, ⚠ 125 columns expected; the official column list from developer.datev.de is the test oracle — one-off check against a real DATEV import before the first handover recommended, non-blocking)

1 Umsatz (ohne Soll/Haben-Kz) · 2 Soll/Haben-Kennzeichen · 3 WKZ Umsatz · 4 Kurs · 5 Basis-Umsatz · 6 WKZ Basis-Umsatz · 7 Konto · 8 Gegenkonto (ohne BU-Schlüssel) · 9 BU-Schlüssel · 10 Belegdatum · 11 Belegfeld 1 · 12 Belegfeld 2 · 13 Skonto · 14 Buchungstext · 15 Postensperre · 16 Diverse Adressnummer · 17 Geschäftspartnerbank · 18 Sachverhalt · 19 Zinssperre · 20 Beleglink · 21–36 Beleginfo – Art 1 … Inhalt 8 · 37 KOST1 – Kostenstelle · 38 KOST2 – Kostenstelle · 39 Kost-Menge · 40 EU-Land u. UStID (Bestimmung) · 41 EU-Steuersatz (Bestimmung) · 42 Abw. Versteuerungsart · 43 Sachverhalt L+L · 44 Funktionsergänzung L+L · 45 BU 49 Hauptfunktionstyp · 46 BU 49 Hauptfunktionsnummer · 47 BU 49 Funktionsergänzung · 48–87 Zusatzinformation – Art 1 … Inhalt 20 · 88 Stück · 89 Gewicht · 90 Zahlweise · 91 Forderungsart · 92 Veranlagungsjahr · 93 Zugeordnete Fälligkeit · 94 Skontotyp · 95 Auftragsnummer · 96 Buchungstyp · 97 USt-Schlüssel (Anzahlungen) · 98 EU-Mitgliedstaat (Anzahlungen) · 99 Sachverhalt L+L (Anzahlungen) · 100 EU-Steuersatz (Anzahlungen) · 101 Erlöskonto (Anzahlungen) · 102 Herkunft-Kz · 103 Buchungs GUID · 104 KOST-Datum · 105 SEPA-Mandatsreferenz · 106 Skontosperre · 107 Gesellschaftername · 108 Beteiligtennummer · 109 Identifikationsnummer · 110 Zeichnernummer · 111 Postensperre bis · 112 Bezeichnung SoBil-Sachverhalt · 113 Kennzeichen SoBil-Buchung · 114 Festschreibung · 115 Leistungsdatum · 116 Datum Zuord. Steuerperiode · 117 Fälligkeit · 118 Generalumkehr (GU) · 119 Steuersatz · 120 Land · 121 Abrechnungsreferenz · 122 BVV-Position · 123 EU-Land u. UStID (Ursprung) · 124 EU-Steuersatz (Ursprung) · 125 Abw. Skontokonto

Formats: Umsatz `1234,56`; Kurs `1,234567` (6 decimals); Belegdatum `TTMM`; Leistungsdatum/Fälligkeit/Datum Zuord. `TTMMJJJJ`; Belegfeld 2 ≤ 12 chars; Buchungstext ≤ 60; Beleginfo/Zusatzinformation Art ≤ 20, Inhalt ≤ 210 ⚠. We fill: 1, 2, 3 (`EUR`), 4–6 only for foreign currency (MISC-08), 7, 8, 9, 10, 11, 12, 13 (Skonto amount on payment lines when taken, ⚠ else separate Skonto line — default separate line), 14, 20, 21–22 (Beleginfo „Beleg-ID"/internal ID), 37, 40/41 (EU cases), 103, 105 (SEPA), 114, 115, 116, 117, 118, 119 (rate for transparency ⚠).

#### 4.1.3 Export flow

```
[Export-Dialog] range + scope + mode (neu | vollständig) + Festschreibung option
   │
   ├─ load settings (Berater/Mandant/WJ/Sachkontenlänge/SKR); missing → blocking error
   ├─ select journal lines: date ∈ range ∩ scope; mode "neu" excludes line IDs in previous exports
   ├─ map lines → DATEV rows (pure)           ├─ collect documents for the ZIP
   ├─ validate (EXP-007) → report             │
   │      blocking errors → stop, show report │
   ├─ optional: lock months (F08 ACC-015)  ── must succeed before writing with Festschreibung = 1
   ├─ write CSV(s) per fiscal year (Windows-1252), master data, document.xml, manifest.csv, ZIP
   ├─ store ZIP + SHA-256, insert datevExports row (line IDs), audit "export.datev"
   └─ notification „DATEV-Export bereit" + download link (30 days; history keeps the hash forever)
```

#### 4.1.4 VAT recomputation alignment

DATEV recomputes VAT from the gross amount per line on automatic accounts/BU keys. For each journal entry the writer groups lines by (account, tax key); if one VAT group of a document is split across several revenue accounts, the writer distributes the group's gross across the accounts so that Σ of DATEV's per-line recomputed VAT equals our booked VAT exactly (adjusting by whole cents, largest share first). If no distribution exists (pathological cent cases), the export emits a separate correction line on the VAT account with BU 40 ⚠ and lists it as a warning. Property test with fast-check.

#### 4.1.5 Master data (category 16, ⚠ ~240 columns; key columns we fill)

Konto · Name (Adressatentyp Unternehmen) · Name (Adressatentyp natürl. Person) · Vorname · Adressatentyp (1 = natürliche Person, 2 = Unternehmen) · Kurzbezeichnung · EU-Land · EU-USt-IdNr. · Anrede · Titel/Akad. Grad · Adressart (`STR`) · Straße · Postfach · Postleitzahl · Ort · Land (ISO) · Telefon · E-Mail · Internet · IBAN 1 · SWIFT-Code 1 · Kontoinhaber 1 · Kundennummer · Steuernummer · Zahlungsbedingung ⚠ · Leitweg-ID ⚠ · Sprache (1 = Deutsch) · Mahnung/Sperre flags empty.

### 4.2 GDPdU / Z3

#### 4.2.1 Tables (`gdpdu-v1`)

| File | Table name | Content | Primary key | Foreign keys |
|---|---|---|---|---|
| `firma.csv` | Firma | Company profile versions (valid from/to), legal form, tax number, VAT ID, chart, method | version | |
| `konten.csv` | Konten | Chart of accounts incl. custom, type, EÜR key | kontonummer | |
| `kontakte.csv` | Kontakte | Debtors/creditors (number, name, address, VAT ID, debtor/creditor account) — restricted contacts included (statutory) | kontakt_id | |
| `buchungen.csv` | Buchungen | Journal entries (seq, date, original date, period, text, source kind/ID, reversal of, recorded at, locked at, actor) | seq | |
| `buchungszeilen.csv` | Buchungszeilen | Lines (seq, line no, account, debit, credit, tax key, tax period, cost centre, contact) | seq + zeile | seq → Buchungen, konto → Konten |
| `rechnungen.csv` | Ausgangsbelege | Sales documents (type, number, dates, supply date/period, contact snapshot name, tax case, net/VAT/gross, status, cancelled by, corrects, artifact SHA-256) | beleg_id | kontakt_id |
| `rechnungspositionen.csv` | Ausgangsbelegpositionen | Lines (pos, name, qty, unit, unit price, net, VAT category, rate) | beleg_id + pos | beleg_id |
| `eingangsbelege.csv` | Eingangsbelege | Vouchers (internal no, supplier no, dates, tax rule, totals, file SHA-256) | voucher_id | |
| `eingangsbelegpositionen.csv` | Eingangsbelegpositionen | Voucher lines (account, net, rate, VAT, non-deductible share) | voucher_id + pos | |
| `zahlungen.csv` | Zahlungen | Payments (target, date, amount, source, difference reason, reversed by) | zahlung_id | |
| `bankumsaetze.csv` | Bankumsaetze | Booked bank transactions (account/IBAN, booking date, value date, amount, currency, counterparty, purpose, status, source: statement import or bank feed) | umsatz_id | |
| `kassenbewegungen.csv` | Kassenbewegungen | Movements on the `cash` account derived from the journal (date, seq, text, source payment/cash transfer, amount, running balance; F07 CSH-020/CSH-030 — no cash book, B3) | seq + zeile | seq → Buchungen |
| `anlagen.csv` / `afa.csv` | Anlagen / AfA | Asset register / depreciation postings | anlage_id / anlage_id + periode | |
| `ustva.csv` | UStVA | Filings (period, Kz, value, status, ticket, submitted at) | periode + kz + version | |
| `nummernregister.csv` | Nummernregister | Number register incl. status | nummer | |
| `dokumente.csv` | Dokumentenindex | Every archived file (entity, kind, file name in `belege/`, SHA-256, bytes, MIME, created) | datei_id | |
| `protokoll.csv` | Protokoll | Audit log (seq, time UTC and Berlin, actor, channel, action, entity, reason, hash, prevHash; diffs as JSON text) | seq | |

#### 4.2.2 `index.xml` skeleton

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE DataSet SYSTEM "gdpdu-01-09-2004.dtd">
<DataSet>
  <Version>1.0</Version>
  <DataSupplier><Name>{Firma}</Name><Location>{Ort}</Location><Comment>{App} {Version}, Export-Schema gdpdu-v1</Comment></DataSupplier>
  <Media>
    <Name>Datenträger 1</Name>
    <Table>
      <URL>buchungen.csv</URL><Name>Buchungen</Name><Description>Buchungsjournal</Description>
      <Validity><Range><From>01.01.2026</From><To>31.12.2026</To></Range></Validity>
      <UTF8/><DecimalSymbol>,</DecimalSymbol><DigitGroupingSymbol>.</DigitGroupingSymbol>
      <VariableLength>
        <ColumnDelimiter>;</ColumnDelimiter><RecordDelimiter>&#13;&#10;</RecordDelimiter><TextEncapsulator>"</TextEncapsulator>
        <VariablePrimaryKey><Name>seq</Name><Numeric/></VariablePrimaryKey>
        <VariableColumn><Name>datum</Name><Date><Format>DD.MM.YYYY</Format></Date></VariableColumn>
        <VariableColumn><Name>text</Name><AlphaNumeric/></VariableColumn>
        …
      </VariableLength>
    </Table>
    …
  </Media>
</DataSet>
```

Element names and order follow the DTD exactly; the DTD file is shipped in the ZIP root. Validation failure blocks the export (E-EXP-10).

### 4.3 sevdesk import (from sevdesk's file exports, B4)

**Verified 2026-10-18 against the owner's real exports** (Kleinunternehmer account; „Exportieren › CSV (Excel)“ on Rechnungen, Kontakte, Produkte, Ausgaben and „ZIP Archiv“ on Rechnungen — open item 9 resolved). The verified headers are the first candidate of each preset; the other candidates are unverified alternates for hand-edited files and keep the mapping UI useful (IMP-017). Fixtures: `test/fixtures/sevdesk-export-verified/` (verified layout, synthetic content) and `test/fixtures/sevdesk-export/` (alternate columns such as type, status, tax rule). Still unverified (`// SEVDESK-LAYOUT-UNSURE`): whether „Verkaufspreis“ is net (assumed) — the sample had 0 % VAT —, credit-note (Gutschrift/Rechnungskorrektur) rows and subjects, foreign-currency rows, and the DATEV ZIP.

Verified layout facts:
- **Contacts** (`contacts.csv`): two UTF-8 BOMs, `;`, every cell quoted, trailing `;`. Headers „Kunden-Nr.“, „Anrede“, „Titel“, „Nachname“, „Vorname“, „Organisation“, „Namenszusatz“, „Position “ (trailing space), „Kategorie“, „IBAN“, „BIC“, „UmSt.-ID“, „Strasse“, „PLZ“, „Ort“, „Land“ (German country name), „Adresse-Kategorie“, „Telefon“, „Telefon-Kategorie“, „Mobil“, „Fax“, „E-Mail“, „E-Mail-Kategorie“, „Webseite“, „Webseite-Kategorie“, „Beschreibung“, „Geburtstag“, „Tags“, „Debitoren-Nr.“, „Kreditoren-Nr.“, „Leitweg-ID / Leitwegsnummer“, „Steuernummer“, „Skonto Tage“, „Skonto Prozent“, „Zahlungsziel Tage“, „Kundenrabatt“, „Ist Kundenrabatt prozentual“.
- **Products** (`<dd-mm-yyyy>_part.csv`): one BOM, mixed quoting. „Artikelnummer“, „Name“, „Einheit“, „Bestand“, „Bestand aktiviert“, „Umsatzsteuer“ (rate, `0,00` under §19), „Einkaufspreis“, „Verkaufspreis“, „Kategorie“, „Beschreibung“.
- **Invoice list** (`invoices.csv`): one BOM, quoted header, unquoted rows. „Rechnungs-Nr.“, „Rechnungs-Datum“, „Fällig am“, „Bezahlt am“, „Betreff“, „Gesamtbetrag-Netto“, „Gesamtbetrag-Brutto“, „offener Betrag“, „Empfänger-KdNr“, „Empfänger-Adresse“ (name and address in one cell), „Empfänger-Land“, „Empfänger-IBAN“, „Empfänger-BIC“ and an unnamed last column (the customer's „Referenz“ printed on the PDF — not a Storno reference; left unmapped). **No** type, status, tax rate, tax rule, VAT amount, currency, supply date or sent date. Stornos are rows of their own in the invoice number range with negative amounts and the subject „Stornorechnung Nr. {storno} zur Rechnung Nr. {original}“; drafts were not exported in the sample. Totals can deviate from the document (EC-203).
- **Invoice ZIP** (`Rechnungen_<dd.mm.yy>.zip`): flat, one PDF per document named `YYYY-MM-DD_<Rechnung|Stornorechnung>_<number>_<32 hex>.pdf`; no XML in the sample. Uploaded as is: the ZIP is unpacked on upload (IMP-016, 2026-10-18) and the PDFs match by their base name (§4.3.5).
- **Voucher list** (`voucher.csv`, P2): „Belegnummer“, „Status“ (lower case, e.g. „bezahlt“), „Position “, „Lieferant / Kunde“, „Kategorie“, „Beschreibung“, „Datum“, „Fällig am“, „Bezahlt am“, „offener Betrag“, „Betrag“, „Kostenstelle“, „Umsatzsteuersatz“ — a header row per voucher followed by its position rows (same „Belegnummer“, „Position“ 1…n, category and rate per position).

#### 4.3.1 File kinds and field mapping

| File kind (detection) | Our table(s) | Target fields ← header candidates (all UNSURE) | Key (`importedRecords.externalType` / `externalId`) | Phase |
|---|---|---|---|---|
| Contacts CSV (header contains a customer-number column and a name column) | `contacts`, `contactAddresses`, `contactChannels` | `number` ← „Kundennummer"/„Kunden-Nr."; organisation name ← „Name"/„Firma"/„Organisation"; person ← „Vorname"/„Nachname"; address ← „Straße", „PLZ", „Ort", „Land"; `vatId` ← „UmSt.-ID" (verified)/„USt-IdNr."/„Umsatzsteuer-ID"; `buyerReference` ← „Leitweg-ID / Leitwegsnummer"; `taxNumber` ← „Steuernummer"; e-mail/phone/web ← „E-Mail", „Telefon", „Webseite"; `iban`/`bic` ← „IBAN", „BIC"; `debtorAccount`/`creditorAccount` ← „Debitoren-Nr."/„Kreditoren-Nr." (if present); role ← „Kategorie" (Kunde/Lieferant) | `sevdesk.contact` / customer number (fallback: SHA-256 of normalised name + postcode) | P1 |
| Products/articles CSV (article number + price column) | `products` | `number` ← „Artikelnummer"; `name` ← „Name"/„Bezeichnung"; `description` ← „Beschreibung"/„Text"; unit ← „Einheit" (unit map, unknown → `C62` + warning); net price ← „Verkaufspreis" (verified header, net assumed)/„Preis (netto)"/„Nettopreis"; gross price ← „Preis (brutto)"; VAT rate ← „Steuersatz"/„USt."; purchase price ← „Einkaufspreis" | `sevdesk.product` / article number | P1 |
| Invoice list CSV (document number + date + gross columns; verified: „Rechnungs-Nr.“ + „Rechnungs-Datum“ + „Gesamtbetrag-Brutto“) | `salesDocuments` (invoice, advance/partial/final invoice, credit note → `correction`, Storno → `cancellation`; drafts skipped) + summary `documentLines` (IMP-020) | type ← „Typ"/„Rechnungstyp"/„Belegart"; number ← „Rechnungsnummer"/„Nummer"; date ← „Rechnungsdatum"/„Datum"; supply date ← „Lieferdatum"/„Leistungsdatum"; due date ← „Fällig am"/„Fälligkeit"; contact ← „Kundennummer" + „Kunde"/„Name"; net/VAT/gross ← „Netto", „Steuer"/„USt.", „Brutto" (per rate if the export splits them); rate ← „Steuersatz"; tax rule ← „Steuerregel"/„Umsatzsteuerart" (if present); status ← „Status"; paid ← „Bezahlt"/„Bezahlter Betrag"/„Bezahlt am"; open ← „Offen"/„Offener Betrag"; currency ← „Währung"; cancelled/corrected invoice ← „Bezug"/„Ursprungsrechnung" (if present) | `sevdesk.document` / `<type>:<number>` | P1 |
| Document PDFs / XML (single files, ZIP folders) | `documentArtifacts` (`pdf` / `xml`, tool `sevdesk-import`) | matched per IMP-019 / §4.3.5 | `sevdesk.file` / SHA-256 | P1 |
| GoBD/„Datenexport" ZIP (and any other ZIP, e.g. the invoice ZIP; magic bytes `PK\x03\x04`) | — (container; kept in `imports.files` as source file, not parsed) | unpacked on upload (IMP-016); each contained file classified like a single upload, referencing the ZIP (`container`); nested ZIPs unpacked up to 3 levels (E-IMP-29); unrecognised files listed (E-IMP-20) | `sevdesk.file` / SHA-256 per contained file | P1 (container), contents per kind |
| Voucher list CSV + voucher files | `vouchers` + `voucherLines` (`imported: true`) | number ← „Belegnummer"; date ← „Belegdatum"; supplier ← „Lieferant"/„Name"; net/VAT/gross, rate; category/account ← „Kategorie"/„Buchungskonto" (mapped via F08 account roles, unknown → no journal impact) | `sevdesk.voucher` / number or row hash | P2 (IMP-025) |
| DATEV export from sevdesk (EXTF header line, category 21 / 16) | reference data only (IMP-026) | Stammdaten: Konto → `debtorAccount`/`creditorAccount` by customer number/name; Buchungsstapel: Belegfeld 1 → BU key, revenue account, Fälligkeit | `sevdesk.datev` / SHA-256 | P2 |

Header matching normalises case, umlauts (ä→ae etc. both ways), punctuation and whitespace. A header that matches several targets, or a target matched by several headers, is shown as a conflict in the mapping grid and must be resolved by the owner.

#### 4.3.2 Tax information mapping (export data → our `taxCase`/category)

Inputs in priority order: (1) a tax-rule text column in the invoice list (labels as shown in sevdesk, UNSURE — sevdesk's own list has none), (2) BU key / revenue account from the sevdesk DATEV export (P2), (3) per-rate VAT amounts, (4) for a file without any tax column: the company's Kleinunternehmer history (EC-202). The table is versioned data in `src/domain/rules/import/sevdesk-tax-labels.ts`.

| Export information | Ours |
|---|---|
| Label „Umsatzsteuerpflichtige Umsätze" or (no label and VAT > 0 at a German standard/reduced rate valid on the document date per the date-effective rate table in `src/domain/rules`, with VAT = net × rate within 1 ct per rate) | `domestic` (S) |
| Label „Ausfuhren" | `export` (G) |
| Label „Innergemeinschaftliche Lieferungen" | `intra_community_supply` (K) |
| Label „Steuerfreie Umsätze §4" | `exempt_4` (E) |
| Label „Reverse Charge gem. §13b UStG" | `reverse_charge_13b` (AE) |
| Label „Kleinunternehmer (keine USt)" / §19 | `kleinunternehmer` (KU) |
| **No** VAT/rate/tax-rule/per-rate column mapped, all amounts with 0 VAT, and the company is Kleinunternehmer on the document date (F01 SET-033 history; EC-202) | `kleinunternehmer` (KU) + one info E-IMP-38 |
| Label „Nicht im Inland steuerbare Leistung" | `not_taxable_domestic` (O) |
| Label „Reverse Charge gem. §18b UStG" | `eu_b2b_service` (AE) |
| OSS labels, any unknown label, 0 % VAT without a label, VAT not matching any rate valid on the document date | `unknown_imported` + warning (archived only, no tax evaluation) |
| DATEV BU key / revenue account (P2) | via F08's versioned account-role table (reverse lookup); a conflict with the label → label wins, warning |

#### 4.3.3 Status mapping (invoices)

Payment state is derived from amounts, not from the status text: the open amount (IMP-007 precedence) is authoritative; a status text that contradicts it is a warning. sevdesk's own list has neither a type nor a status column (verified): the type is derived from the subject first — „Stornorechnung Nr. X zur Rechnung Nr. Y" → `cancellation` referencing Y, which marks Y `cancelled` (its open amount 0,00 must not make it `paid`) — and only then is the payment state derived from „offener Betrag" for the remaining invoices. Supply and due dates missing from the list are not reported as document deviations (EC-190) unless their column is mapped and empty; the PDF carries them.

| Export (status text UNSURE) | Ours (`status` / `paymentStatus`) |
|---|---|
| Entwurf | not imported (no number; recreate manually if needed) |
| Offen / Fällig / Überfällig (open amount = gross) | `sent` / `open` (overdue derived from the due date, never stored) → open item at Buchungsbeginn (IMP-007) |
| Teilbezahlt (0 < open < gross) | `sent` / `partially_paid` with `openAmountCents` from the export |
| Bezahlt (open = 0) | `sent` / `paid` |
| Storniert / cancellation document with reference | original `cancelled`; the cancellation row → `cancellation` with `correctsId`; without a resolvable reference → standalone archived `cancellation` + warning (E-IMP-31) |
| Gutschrift / Rechnungskorrektur | `correction` with `correctsId` if the reference resolves, else standalone + warning |

Dispatch facts of imported documents: no `sendLog` row is created (the export does not prove the dispatch). `sentOn` = the export's sent date if a column exists (UNSURE), else the document date (import assumption, flagged). For open items the receipt assumption is the conservative `zugang = { date: sentOn + 3 days, basis: "manual" }` (contract B2 rule for unproven channels); the owner may correct it once before the first reminder (audited); dunning (F05) uses it.

#### 4.3.4 Import run state machine

```
imports: uploaded ─preview─▶ previewed ─commit(previewHash)─▶ running ─▶ done | failed ─resume─▶ running
            │  ▲               │   │                                   (batches of 100, resumable from the last batch)
            │  └─ files/mapping changed (preview invalidated) ┘   │
            └──────────── discard ──────────────▶ discarded ◀────┘   (only before commit; files + preview removed)
re-run with a newer export = new imports row, same importedRecords keys (already imported records skipped)
```

Upload and file classification happen in actions (unzip in the `"use node"` action `importsNode.unpackZip`, entry by entry so memory stays at archive + one entry; encoding detection; PDF text layer for match proposals later); the Node actions (`system:imports.files`, `system:imports.protocol`) write file storage only, never the database — the calling user's action records their result through its mutations (IMP-014 attribution); the preview is computed in actions with read-only queries and stored on the `imports` row; each commit batch is a Convex mutation that writes records + `importedRecords` + artifacts + audit entries atomically; a failed batch is retried 3× then the run is marked `failed` with its error and can be resumed. No network access to sevdesk is ever made.

#### 4.3.5 PDF matching

1. Normalise every list row number and every file name (for files unpacked from a ZIP: the base name after the last `/`, so folder and archive names never match; 2026-10-18): lower case, strip extension, strip leading words („rechnung", „gutschrift", „storno", „korrektur", „invoice"), collapse `[\s_\-./]` to a single separator. sevdesk's ZIP names (`2026-06-10_Rechnung_RE-1000_<32 hex>.pdf`, `…_Stornorechnung_RE-1003_…`) match by step 2's whole-token containment (verified).
2. Exact normalised match number ↔ file name (also number contained as a whole token in the file name) → matched.
3. No match: search the number as a whole token in the first-page text layer → proposal shown in the preview, owner confirms.
4. One file for several rows or several files for one row → ambiguous, row blocked (E-IMP-22). Identical bytes (same SHA-256) under several names count as one file.
5. XML files (XRechnung/ZUGFeRD XML) match the same way; a ZUGFeRD PDF is archived as `pdf` as-is (embedded XML untouched, not re-validated).

#### 4.3.6 Number range continuation

Per document type: group imported numbers by pattern (regex skeleton: literal prefix, optional `YYYY`/`YY` token, counter of width n, suffix); the dominant pattern of the most recent fiscal year is proposed (E-IMP-11 if several are plausible); `next = max(counter of the chosen pattern in the current period) + 1`; gaps inside the imported sequence are listed as information only (history is sevdesk's responsibility; E-IMP-32); imported numbers enter `numberRegister` (IMP-004); the owner confirms per type at commit; F01 SET-065 raises the range's next value accordingly (audit reason "Import").

### 4.4 Generic CSV import

```
upload → detect encoding/delimiter/header → choose entity + preset → map columns (required fields highlighted)
→ validate all rows (zod) → preview (ok / warnings / errors / duplicates with row numbers, downloadable as CSV)
→ commit (job, batches of 200; same imports lifecycle as §4.3.4) or discard → summary + link to the created records
```

## 5. Validation rules and edge cases (exhaustive; exact German error/warning messages)

### 5.1 DATEV

| # | Case | Behaviour | Message (DE) |
|---|---|---|---|
| E-EXP-01 | Beraternummer or Mandantennummer missing | Blocked | „Für den DATEV-Export fehlen Berater- und/oder Mandantennummer (Einstellungen › Unternehmen › DATEV)." |
| E-EXP-02 | Range crosses fiscal year | Split into files per fiscal year | Info „Der Zeitraum umfasst zwei Wirtschaftsjahre – es werden zwei Dateien erzeugt." |
| E-EXP-03 | Same range exported again (mode „Nur neue Buchungen") with nothing new | No file; info | „Seit dem letzten Export ({datum}) gibt es keine neuen Buchungen in diesem Zeitraum." |
| E-EXP-04 | Full re-export of a range that was exported with Festschreibung = 1 | Allowed; content must be identical to the first export (else integrity ERROR, export aborted); file and history marked „Wiederholung – nicht erneut importieren" (EC-174) | „Dieser Zeitraum wurde am {datum} festgeschrieben an DATEV übergeben. Die Datei ist identisch mit dem damaligen Export und darf nicht erneut importiert werden." |
| E-EXP-05 | Full re-export of an unlocked range exported before with Festschreibung = 0 | Allowed after confirmation | „Der Steuerberater muss den vorherigen Stapel {datei} vor dem Import löschen. Fortfahren?" |
| E-EXP-06 | Export after the period was locked (first time) | Allowed, Festschreibung default 1 | — |
| E-EXP-07 | Export with Festschreibung requested but months unlocked and option „festschreiben" off | Flag forced to 0 | „Nicht festgeschriebene Monate ({liste}) werden ohne Festschreibung exportiert." |
| E-EXP-08 | Late postings (F08 ACC-006) into a later period after an earlier export | Included in the next delta export; Leistungsdatum + Datum Zuord. Steuerperiode filled | Info „{n} nachträgliche Buchungen zu bereits exportierten Zeiträumen enthalten." |
| E-EXP-09 | Reversal of an already-exported entry | Exported in the delta with GU = 1 | — |
| E-EXP-10 | Belegfeld 1 contains invalid characters (imported legacy numbers) | Blocking error listing documents; legacy numbers can be mapped to a DATEV-safe alias stored with the document (audited) | „Belegnummer {nr} enthält Zeichen, die DATEV nicht akzeptiert. Bitte DATEV-Belegnummer festlegen." |
| E-EXP-11 | Buchungstext > 60 | Truncated, warning | „Buchungstext für {beleg} auf 60 Zeichen gekürzt." |
| E-EXP-12 | Account length mismatch (e.g. 5-digit custom account with Sachkontenlänge 4) | Blocked | „Konto {nr} passt nicht zur Sachkontenlänge {n}." |
| E-EXP-13 | Contact without debtor/creditor number | Number assigned from the range and audited | Info „{n} Kontakten wurden Debitoren-/Kreditorennummern zugewiesen." |
| E-EXP-14 | BU key on an automatic account | Blocked (mapping error) | „Konto {nr} ist ein Automatikkonto – BU-Schlüssel {bu} nicht zulässig." |
| E-EXP-15 | Character not in Windows-1252 (e.g. „ő" is fine, „€" fine, emoji/„ł" ⚠) | Transliterated, warning with list | „{n} Zeichen wurden für DATEV umgeschrieben (z. B. „{a}" → „{b}")." |
| E-EXP-16 | Document file missing for a booking (e.g. voucher without file, imported record without PDF) | Warning; Beleglink empty | „Für {n} Buchungen fehlt die Belegdatei." |
| E-EXP-17 | VAT recomputation mismatch not resolvable | Correction line + warning | „Rundungsausgleich für {beleg} als separate Steuerzeile exportiert." |
| E-EXP-18 | Advisor acceptance (`datevAcceptance`) not recorded | Not a go-live gate (B5): banner on the export page; each DATEV download requires the „Testexport" confirmation (audited) | „DATEV-Import noch nicht von einem Steuerberater bestätigt. Die Datei ist als Testexport gekennzeichnet." |
| E-EXP-19 | Export started via MCP | Requires approval (requiresUserInteraction) + confirm token if `lock_period` = true | — |
| E-EXP-20 | Two exports started concurrently for overlapping ranges | Second waits/fails | „Für diesen Zeitraum läuft bereits ein Export." |
| E-EXP-21 | Foreign-currency postings | Decided default: Umsatz in EUR exactly as booked (WKZ Umsatz `EUR`), so DATEV's VAT recomputation matches our journal; the original currency, foreign amount and Kurs are filled in WKZ Basis-Umsatz / Basis-Umsatz / Kurs for information ⚠ (one-off Steuerberater check before the first handover recommended, non-blocking) | — |
| E-EXP-22 | Negative journal amounts (should not exist) | Blocked as integrity error | „Ungültige Buchung {seq}: negativer Betrag." |

### 5.2 GDPdU, CSV, full export

| # | Case | Behaviour | Message (DE) |
|---|---|---|---|
| E-EXP-30 | GDPdU for a year spanning a schema migration (records from internal schema v3 and v4) | Both exported through the `gdpdu-v1` adapters; identical columns; README lists the internal schema versions | — |
| E-EXP-31 | `index.xml` fails DTD validation | Blocked; error report; CI bug | „Die GDPdU-Beschreibungsdatei ist ungültig ({fehler}). Export abgebrochen." |
| E-EXP-32 | Row count mismatch (DB vs CSV) | Blocked | „Zeilenanzahl {tabelle} stimmt nicht ({a} statt {b})." |
| E-EXP-33 | GDPdU includes restricted (DSGVO) contacts | Included (statutory access, Art. 17 Abs. 3 lit. b); README notes it | — |
| E-EXP-34 | GDPdU for a year with purged records (after retention) | Tombstones exported in `protokoll.csv`; purged rows absent; README states the purge batch | — |
| E-EXP-35 | CSV cell starts with `=`/`+`/`-`/`@` | Prefixed with `'` (Excel variant) | — |
| E-EXP-36 | CSV export of > 5,000 rows | Job with notification | „Der Export läuft im Hintergrund. Sie werden benachrichtigt." |
| E-EXP-37 | Full export while writes happen | Convex snapshot is point-in-time; manifest records the audit head of the snapshot | — |
| E-EXP-38 | Restore into a non-empty instance | Blocked | „Wiederherstellung ist nur in eine leere Instanz möglich." |
| E-EXP-39 | Restore: manifest hash mismatch | Blocked | „Die Exportdatei ist beschädigt oder verändert ({datei})." |
| E-EXP-40 | Restore: chain head after import ≠ manifest | Blocked; instance marked „Integrität ungeklärt" | „Prüfkette nach Wiederherstellung weicht ab (seq {a}). Bitte nicht weiterarbeiten." |
| E-EXP-41 | Restore older than the latest off-host checkpoint | Warning: data after the backup is missing; chain continues from the restored head with `system.restore` entry referencing the newer checkpoint | „Die Sicherung ist älter als der letzte Prüfpunkt ({datum}). Daten nach {zeit} fehlen und müssen nacherfasst werden." |
| E-EXP-42 | Full export to non-EU storage chosen by the owner | Warning AO-06 | „Die Bücher müssen in der EU aufbewahrt werden (§ 146 Abs. 2 AO)." |

### 5.3 Imports

| # | Case | Behaviour | Message (DE) |
|---|---|---|---|
| E-IMP-01 | **Withdrawn (v1.1)** — B4: no sevdesk API token any more. Replaced by — | — | — |
| E-IMP-02 | **Withdrawn (v1.1)** — B4: no sevdesk API plan check; the file export import is the only path. Replaced by — | — | — |
| E-IMP-03 | **Withdrawn (v1.1)** — B4: no sevdesk bookkeeping-system version check via API. Replaced by E-IMP-20, E-IMP-21 | — | — |
| E-IMP-04 | Re-run: record already imported | Skipped (counted) | — |
| E-IMP-05 | Re-run: contact changed locally since last import | Conflict, not overwritten | „Kontakt {nr} wurde lokal geändert – Änderung aus dem sevdesk-Export nicht übernommen." |
| E-IMP-06 | Document number already exists locally (not from an earlier sevdesk import) | Row blocked in the preview; commit possible only after the row is excluded | „Rechnungsnummer {nr} existiert bereits. Bitte Nummernkreise prüfen." |
| E-IMP-07 | List row without a matching original PDF | Warning in the preview; commit of that row needs the explicit confirmation „ohne Original-PDF übernehmen" (per row or for all listed rows, with reason, audited); record flagged „Original-PDF fehlt"; the PDF can be attached later once (same SHA-256 rules) | „Für {nr} wurde kein Original-PDF gefunden." |
| E-IMP-08 | Imported net + VAT ≠ gross, or Σ per-rate amounts ≠ totals (sevdesk rounding) | Imported as-is (archived values are authoritative), warning | „Summen von {nr} weichen um {diff} € ab (übernommen wie im sevdesk-Export)." |
| E-IMP-09 | OSS or unmappable tax information | Archived with `unknown_imported` | „{nr}: Steuerangabe nicht eindeutig zuordenbar – nur archiviert, nicht steuerlich ausgewertet." |
| E-IMP-10 | Document dated on/after Buchungsbeginn | Asks: import as archived (no posting) or as posted (journal entries created from the per-rate totals, period must be open; still never re-rendered) | „{n} Belege liegen nach dem Buchungsbeginn. Sollen sie gebucht werden?" — **P1 (2026-10-18):** posting at import is not offered yet; such rows are blocked per row („{nr} liegt am oder nach dem Buchungsbeginn ({datum}). Buchen beim Import ist noch nicht möglich – bitte Buchungsbeginn prüfen oder Zeile ausschließen.") — conservative: no booked-period invoice is archived without its journal entry |
| E-IMP-11 | Number pattern ambiguous (several formats) | Owner chooses; next = max of chosen pattern + 1 | „Mehrere Nummernformate erkannt ({liste}). Bitte Format für neue Rechnungen wählen." |
| E-IMP-12 | Proposed next number ≤ an existing number | Blocked | „Die nächste Nummer {nr} wäre nicht eindeutig." |
| E-IMP-13 | **Withdrawn (v1.1)** — B4: no sevdesk API rate limits (no network access to sevdesk). Replaced by — | — | — |
| E-IMP-14 | Partial failure during commit | Resumable; finished batches stay | „Import unterbrochen bei {art} (Charge {n}). Fortsetzen?" |
| E-IMP-15 | CSV with wrong encoding (mojibake detected) | Re-detect, ask | „Zeichenkodierung unklar – bitte Windows-1252 oder UTF-8 wählen." |
| E-IMP-16 | CSV row invalid (e.g. invalid USt-IdNr format) | Row skipped, listed | „Zeile {n}: {fehler}." |
| E-IMP-17 | CSV duplicate by e-mail/number/VAT ID | Update or skip per option | „Zeile {n}: Kontakt existiert bereits ({nr})." |
| E-IMP-18 | Import of personal data from another system | Reminder to note the source (DSGVO Art. 14 information) in the processing record | Info |
| E-IMP-19 | Open invoice imported, then paid in sevdesk before cutover (re-run with a newer export) | Discrepancy list (export paid vs. local open); the owner records the payment locally | „{nr} ist laut neuem sevdesk-Export bezahlt, hier noch offen." |
| E-IMP-20 | Uploaded file not recognised | Listed as „unbekannt", ignored unless the owner assigns a kind | „Datei {name} wurde nicht erkannt. Bitte Dateiart wählen oder ignorieren." |
| E-IMP-21 | Required target field not mapped (header missing or renamed) | That file is blocked in the preview until mapped | „In {datei} fehlt die Spalte für {feld}. Bitte Spaltenzuordnung ergänzen." |
| E-IMP-22 | Ambiguous PDF match (one file ↔ several rows or several files ↔ one row) | Row blocked until the owner assigns the file | „Für {nr} passen mehrere Dateien ({liste}). Bitte die richtige Datei wählen." |
| E-IMP-23 | PDF/XML without matching list row | Listed; can be assigned manually or ignored (not imported) | „{n} Dateien ohne passenden Beleg in der Liste." |
| E-IMP-24 | Same document key twice in the uploaded files (e.g. overlapping exports) | Identical content → deduplicated silently (counted); different content → both rows blocked | „{nr} ist mehrfach mit unterschiedlichen Werten enthalten ({dateien})." |
| E-IMP-25 | Document references a customer not in the contacts export | Proposed name match for confirmation; else minimal contact created and flagged | „{n} Belege verweisen auf unbekannte Kunden – Kontakte werden unvollständig angelegt." |
| E-IMP-26 | Ambiguous number/date format (e.g. „1.234" or „03/04/2025") | Detected from all rows; if still ambiguous the owner chooses; never guessed silently | „Zahlen-/Datumsformat in {datei} ist nicht eindeutig. Bitte Format wählen." |
| E-IMP-27 | Commit with a stale preview (files, mapping or relevant local data such as number register changed since the preview) | Blocked; new preview required | „Die Vorschau ist veraltet. Bitte Vorschau neu erstellen." |
| E-IMP-28 | Discard requested after commit started | Blocked (archived records are immutable; corrections via new documents) | „Der Import wurde bereits übernommen und kann nicht verworfen werden." |
| E-IMP-29 | Unsafe or oversized ZIP (path traversal, absolute paths, symlinks, nesting > 3, expanded size > 2 GB or ratio > 100:1) | File rejected — the whole archive, never partly (a partially imported export would silently miss records); the central directory is checked before the first entry is extracted. Decided 2026-10-18: the ratio applies per entry of ≥ 1 MB (small repetitive CSVs compress better than 100:1 legitimately); inflating stops at the declared size (lying headers), CRC and size must match; the 2 GB is the import's remaining budget (archive + unpacked files); only „stored“ and „deflate“ are supported, multi-disk archives are refused; outer archive = level 1 | „Die ZIP-Datei {name} ist ungültig oder zu groß: {grund}" — reasons e.g. „„{pfad}“ zeigt aus dem Archiv heraus.", „„{pfad}“ ist ein absoluter Pfad.", „„{pfad}“ ist eine symbolische Verknüpfung.", „Archive sind tiefer als 3 Ebenen verschachtelt.", „„{pfad}“ ist ungewöhnlich stark komprimiert (über 100:1).", „Entpackt wären die Dateien größer als 2 GB je Import.", „Das Inhaltsverzeichnis des Archivs fehlt oder ist beschädigt.", „„{pfad}“ verwendet ein nicht unterstütztes Komprimierungsverfahren ({n}). Bitte das Archiv mit „Deflate“ (Standard-ZIP) erstellen." |
| E-IMP-39 | ZIP with an encrypted entry (2026-10-18) | Whole archive rejected (no password prompt; the export must be re-created without password) | „Die ZIP-Datei {name} enthält verschlüsselte Dateien ({pfad}). Bitte das Archiv ohne Passwort erstellen und erneut hochladen." |
| E-IMP-40 | ZIP with more than 10.000 files or a file above the 50 MB per-file limit (IMP-016) (2026-10-18) | Whole archive rejected | „Die ZIP-Datei {name} enthält mehr als 10.000 Dateien. Bitte auf mehrere Archive aufteilen." / „{pfad} in {name} ist entpackt größer als 50 MB. Bitte die Datei einzeln hochladen." |
| E-IMP-30 | Open invoice without determinable open amount (no open/paid column, no DATEV OPOS, status not „Bezahlt") | Open item not created; row blocked until the owner enters the open amount (audited) or excludes the row | „Offener Betrag für {nr} nicht ermittelbar. Bitte eintragen." |
| E-IMP-31 | Cancellation/correction row whose referenced invoice cannot be resolved | Imported as standalone archived document, warning; the original's status is not changed automatically | „{nr}: Bezug zur ursprünglichen Rechnung nicht gefunden – als eigenständiger Beleg archiviert." |
| E-IMP-32 | Gaps inside an imported number sequence | Information only (listed in the report and the import protocol); no block | Info „Lücken in den importierten Nummern: {liste}." |
| E-IMP-33 | Foreign-currency document in the list | Archived with currency and amounts as exported; EUR values required for open items (else E-IMP-30). **P1 (2026-10-18):** an *open* foreign-currency invoice is blocked (error) — F08 opening items are EUR-only and compare the open amount with the gross; the owner excludes the row and enters the receivable in EUR in the opening balance | „{nr} ist in {währung} – bitte EUR-Betrag des offenen Postens prüfen." |
| E-IMP-34 | Open invoice in the list while no Buchungsbeginn is set (2026-10-18, IMP-007) | Row blocked: the open item can only become an F08 opening receivable at the Buchungsbeginn | „{nr} ist offen. Offene Posten werden in die Eröffnungsbilanz übernommen – bitte zuerst den Buchungsbeginn festlegen." |
| E-IMP-35 | Open invoice while the Buchungsbeginn's fiscal year already has a receivables opening posting (posted once per year, F08 ACC-013) (2026-10-18) | Row blocked — never a second receivable for the same invoice; the owner reverses the manual opening posting or excludes the row | „{nr} ist offen, aber für {jahr} sind bereits offene Forderungen in der Eröffnungsbilanz erfasst. Bitte dort stornieren oder die Zeile ausschließen." |
| E-IMP-36 | Open invoice with `taxCase = unknown_imported` and VAT ≠ 0 under Ist-Versteuerung (e.g. OSS) (2026-10-18) | Row blocked (LEGAL-OPEN): carrying the VAT as not-due German VAT would declare it in the UStVA on payment, dropping it could under-declare. Under Soll the opening item carries no VAT and nothing blocks | „{nr}: Steuerfall unbekannt (z. B. OSS) – der offene Posten kann bei Ist-Versteuerung nicht mit Umsatzsteuer übernommen werden. Bitte klären oder Zeile ausschließen." |
| E-IMP-34 | Open item (Ist taxation) whose VAT split per rate cannot be derived (several rates, only gross given) | Open item blocked until the owner enters the split | „Steueraufteilung für den offenen Posten {nr} fehlt (Ist-Versteuerung)." |
| E-IMP-37 | Invoice list without any tax column (sevdesk's own export; EC-203) | Warning per file before the commit: totals cannot be cross-checked against positions or VAT; compare with the PDFs and correct the CSV first, an imported document is immutable (2026-10-18) | „{datei} enthält keine Steuer- und Positionsangaben. Bitte die Gesamtbeträge vor der Übernahme mit den PDFs vergleichen – sevdesk exportiert in Einzelfällen abweichende Beträge (z. B. nach Teilzahlungen). Ein übernommener Beleg kann danach nicht mehr geändert werden." |
| E-IMP-38 | Tax data taken from the company's Kleinunternehmer history (EC-202): invoices of a list without tax columns, products with 0 % | Info (one for the invoices, one per product file); without KU on the date the invoice stays `unknown_imported` (E-IMP-09) and the 0 % article stays ambiguous (E-IMP-16) (2026-10-18) | „{n} Rechnungen ohne Steuerangabe werden als Kleinunternehmer-Rechnungen (§ 19 UStG) übernommen, weil Ihr Unternehmen am Rechnungsdatum Kleinunternehmer war (Einstellungen › Steuern)." / „{datei}: {n} Artikel mit 0 % Umsatzsteuer erhalten den Steuersatz „Standard". Er wird angewendet, sobald Sie die Kleinunternehmerregelung verlassen – bitte dann prüfen." |

## 6. UI

| Route | Content |
|---|---|
| `/export` | Cards: **Vollexport** (button, encryption key field, last export date), **Kennzahlen** (links to UStVA/ZM/EÜR sheets, P3), **GDPdU/Z3** (year picker, include files toggle, encoding; P3), **DATEV** (P3, low priority; shown once DATEV settings exist: range presets Monat/Quartal/Jahr, scope checkboxes, mode, Festschreibung toggle, „Prüfen" → validation report drawer → „Export erstellen"), **Export-Historie** (table: Zeitraum, Umfang, Modus, Festschreibung, Zeilen, Σ Umsatz, SHA-256 short, Datum, Akteur, Download), **Steuerberater-Abnahme** (record the advisor test import result, EXP-016; optional) |
| `/einstellungen/import` | Import projects list (source, status, counts, created/committed by, date); „sevdesk-Exporte importieren" wizard: (1) instructions where to download each export in sevdesk (menu paths UNSURE, links to research) → (2) „Dateien hochladen" (drag & drop, multiple files/ZIPs, classification per file, correct kind) → (3) „Spaltenzuordnung" per CSV (mapping grid with sample rows, presets, „Zuordnung speichern") → (4) „Vorschau" (counts per kind, Fehler/Warnungen/Duplikate tabs, PDF-Zuordnung with manual assignment, offene Posten with total and reconciliation, Nummernkreis-Fortsetzung per type, EC-190 deviations, CSV download) → (5) „Import übernehmen" (confirmations: rows without PDF, open-item difference, number ranges, Buchungsbeginn) or „Verwerfen" → live progress per kind → summary with conflict/discrepancy lists and the import protocol PDF; „CSV importieren" wizard (upload, mapping grid with sample rows, presets incl. lexoffice, preview, commit/discard) |
| Every list page | „Export ▾" → CSV (Excel) / CSV (technisch) / PDF-ZIP (documents) |
| Imported documents | Badge „Importiert aus sevdesk-Export · archiviert" (+ „Original-PDF fehlt" / „Positionen siehe Original-PDF" where applicable) + original PDF viewer; actions limited to download/export of the original, open item handling (payments) and Storno/Korrektur via new documents |

Mobile: export pages work as stacked cards; the DATEV export can be started and downloaded on mobile; the import wizard is desktop-recommended (banner).

## 7. API and MCP exposure

### REST

| Method | Path | Scope | Notes |
|---|---|---|---|
| POST | `/exports/datev` | exports:run | `{ from, to, include[], mode: "new"\|"full", lock_period, festschreibung? }` → `job_…`; validation errors as 422 with the report (P3, low priority) |
| POST | `/exports/datev/validate` | exports:run | Dry run: validation report only (P3, low priority) |
| GET | `/exports/datev` | exports:run | Export history (P3, low priority) |
| GET | `/exports/datev/{id}/file` | exports:run | Stored ZIP (original bytes) (P3, low priority) |
| POST | `/exports/gdpdu` | exports:run | `{ year, include_files, encoding }` → job |
| POST | `/exports/full` | exports:run | `{ encrypt_to_age_recipient? }` → job |
| GET | `/exports/{kind}/csv?list=…&filters…` | read scope of the list | Streams or returns a job for > 5,000 rows |
| GET | `/reports/ustva/{period}/sheet.pdf` / `.csv` (same for zm, euer) | reports:read | |
| POST | `/imports` | imports:run | `{ source: "sevdesk_export" \| "lexoffice_csv" \| "generic_csv" }` → import project `{ id, status: "uploaded" }` (replaces the withdrawn `POST /imports/sevdesk`, B4) |
| POST | `/imports/{id}/files` | imports:run | multipart, one or more files (CSV, ZIP, PDF, XML); returns the file list with detected kind, encoding, delimiter, headers; invalidates an existing preview |
| PATCH | `/imports/{id}/files/{fileId}` | imports:run | Correct the detected kind / encoding / formats, or `ignored: true` |
| DELETE | `/imports/{id}/files/{fileId}` | imports:run | Only before commit |
| PUT | `/imports/{id}/mapping` | imports:run | Per CSV file: `{ fileId, presetId?, columns: { <targetField>: <sourceHeader> }, options }`; `save_as_preset?` |
| GET | `/imports/mapping-presets` | imports:run | Saved and shipped presets (`sevdesk-*` marked UNSURE) |
| POST | `/imports/{id}/preview` | imports:run | Computes the preview (job for large uploads) → `{ previewHash, counts, errors[], warnings[], duplicates[], fileMatches, numberRanges[], openItems }` |
| PUT | `/imports/{id}/resolutions` | imports:run | Manual PDF assignments, contact matches, excluded rows, entered open amounts/VAT splits, "ohne Original-PDF" confirmations (with reason); invalidates the preview |
| POST | `/imports/{id}/commit` | imports:run | `{ previewHash, number_ranges: [{ type, format, next }], buchungsbeginn?, acknowledge: { missingPdfs?, openItemDifference? } }` → job; 409 `preview_stale` (E-IMP-27); `Idempotency-Key` required |
| POST | `/imports/{id}/discard` | imports:run | Only in `uploaded`/`previewed`; 409 after commit started (E-IMP-28) |
| GET | `/imports/{id}` | imports:run | Status, preview, stats, log, conflicts |
| GET | `/imports/{id}/report.pdf` | imports:run | Import protocol (IMP-024) |
| POST | `/imports/csv` | imports:run | Shortcut for generic/lexoffice CSV: multipart `file`, `entity`, `preset`, `mapping?`, `commit: false` (preview) / `true` (with `previewHash`) → creates/uses an `imports` row with the same lifecycle |
| GET | `/jobs/{id}` | job's scope | Progress, download URL |

### MCP

| Tool | Hints | Scope | Notes |
|---|---|---|---|
| `export_datev` (P3, low priority) | `destructiveHint: true`, `_meta["anthropic/requiresUserInteraction"]: true` | exports:run | `{ from, to, include?, mode?, lock_period? }`; the token comes from `preview_action{action:"export_datev"}` (06 §2.3), which runs the validation and returns the report; the call with the token starts the job; returns a short-lived download link |
| — | | | No MCP tools for imports, GDPdU or full export (owner actions in the UI; API possible with `exports:run`/`imports:run`) |

Events `export.completed`, `import.previewed`, `import.completed`, `job.failed` are recorded as notifications/events (05-api §5.3); nothing in F09 depends on outbound webhooks — API clients poll `GET /jobs/{id}` / `GET /imports/{id}`.

## 8. Acceptance tests

| Test ID | Given / When / Then | Type | Covers req IDs |
|---|---|---|---|
| TST-EXP-01 | Golden journal (all F08 §4.2 sales events, SKR03 and SKR04) / when exported / then CSV equals `expected.datev.csv` byte-for-byte (Windows-1252, CRLF) | G | EXP-001, EXP-005, DATEV-01, DATEV-02 |
| TST-EXP-02 | Header line / then 31 fields in order with values from settings; v13 column header has the pinned count and names | U | EXP-002, EXP-004, DATEV-01 |
| TST-EXP-03 | Range 2026-12-01..2027-01-31 with calendar FY / then two files with correct names | U | EXP-003 |
| TST-EXP-04 | Invoice with 19 % and 7 % / then 2 lines (one per account/rate) whose totals match the invoice | U, G | EXP-005, DATEV-02 |
| TST-EXP-05 | Each EXP-007 violation injected / then the matching blocking error or warning with link | U | EXP-007, DATEV-04 |
| TST-EXP-06 | Our CSV → internal DATEV parser → same bookings (round trip) | U | EXP-001 |
| TST-EXP-07 | One VAT group split across 3 revenue accounts (fast-check random nets) / then Σ DATEV-recomputed VAT = booked VAT | U | §4.1.4, EXP-007 |
| TST-EXP-08 | Export Oct (Festschreibung 0), add a late posting and a reversal, export again „neu" / then the second file contains exactly those 2 entries (GU = 1 for the reversal, Datum Zuord. Steuerperiode set) | C | EXP-009, EXP-010, E-EXP-08, E-EXP-09, GOBD-06, EC-174, EC-170 |
| TST-EXP-09 | Oct exported with Festschreibung = 1 / when „vollständig neu" / then the regenerated CSV rows are identical to the first export, marked „Wiederholung"; for an unlocked range with new bookings the difference report lists them | C | EXP-010, GOBD-06, EC-174 |
| TST-EXP-10 | Export with „Zeitraum festschreiben" / then months locked before writing and flag = 1; with unlocked months and option off → flag 0 + warning | C | EXP-011, GOBD-06 |
| TST-EXP-11 | Same range exported twice „neu" without changes / then no file, E-EXP-03 | C | EXP-010, EC-174 |
| TST-EXP-12 | Document ZIP / then every Belegfeld 1 in the CSV has exactly one file; file SHA-256 equals the archived artifact; `document.xml` GUIDs equal the Beleglinks | G | EXP-014, EXP-015, DATEV-03 |
| TST-EXP-13 | Master data export for 3 contacts (person, company, EU company) / then category 16 header, all columns in order, VAT ID and country filled | G | EXP-013, DATEV-02 |
| TST-EXP-14 | Advisor acceptance not recorded / then banner on the export page and the DATEV download requires the „Testexport" confirmation (audited); no other feature or go-live check depends on it; recorded → banner and confirmation gone, acceptance audited | E | EXP-016, E-EXP-18 |
| TST-EXP-15 | MCP `export_datev` without confirm token / then returns validation + token, no job; with token → job; client approval required | C (MCP contract) | E-EXP-19 |
| TST-EXP-16 | GDPdU 2026 / then `index.xml` validates against the bundled DTD; row counts equal DB counts; amounts with decimal comma | G, C | EXP-017, EXP-018, GOBD-11 |
| TST-EXP-17 | Dataset created under internal schema v1, migration to v2 / when GDPdU exported before and after / then identical bytes for unchanged tables and valid DTD | C (integration) | EXP-019, GOBD-23, E-EXP-30, EC-184 |
| TST-EXP-18 | GDPdU year containing a purge batch / then purged rows absent, tombstones present in `protokoll.csv`, README lists the batch | C | E-EXP-34, GOBD-21, RI-20 |
| TST-EXP-19 | CSV (Excel) export of contacts with a name `=HYPERLINK(...)` / then cell prefixed with `'` | U | EXP-022 |
| TST-EXP-20 | Every list page / „Export ▾" produces CSV with current filters (desktop + mobile) | E | EXP-021 |
| TST-EXP-21 | Full export → restore into empty staging / then `integrity.verify` green and chain head = manifest; first new audit entry `system.restore` | C (integration), E | EXP-023, EXP-024, SEC-05, RI-14 |
| TST-EXP-22 | Restore with a tampered file / then E-EXP-39; into non-empty instance → E-EXP-38 | C | EXP-024 |
| TST-EXP-23 | Restore of a backup older than the latest checkpoint / then E-EXP-41 warning and checkpoint comparison shows the missing range | C (integration) | EXP-024, SEC-04, EC-183 |
| TST-EXP-24 | UStVA/ZM/EÜR sheets / then PDF text and CSV equal the F08 report values; footer shows rule versions and lock status | G | EXP-020 |
| TST-IMP-01 | **Withdrawn (v1.1)** — B4: recorded sevdesk API fixtures no longer exist. Replaced by TST-IMP-16 | — | — |
| TST-IMP-02 | Imported invoice (`imported: true`, `origin.source = "sevdesk_export"`) / when any mutation tries to change it / then `immutable_record`; Storno via a new document works and references the original | C | IMP-003, UST-30, GOBD-06, EC-190 |
| TST-IMP-03 | Same export files imported twice (second import project) / then zero new records, run log shows all skipped | C | IMP-006 |
| TST-IMP-04 | Contact edited locally between runs / then conflict E-IMP-05, local value kept | C | IMP-006 |
| TST-IMP-05 | Imported max RE-1042 / then proposed range `RE-{####}` next 1043; first new invoice gets RE-1043; gap report starts after 1042 | C, E | IMP-005, UST-06, GOBD-02, EC-014 |
| TST-IMP-06 | Local invoice RE-1043 already exists / when the importer brings RE-1043 / then E-IMP-06 | C | IMP-004, UST-06, EC-014, RI-02 |
| TST-IMP-07 | Invoice list with two open invoices (Ist, 19 %; one partially paid, open-amount column present) at Buchungsbeginn / then imported with `openAmountCents` from the export and opening open items (F08 ACC-013) with the pro-rata VAT split; a later payment clears them and declares the VAT in the payment period | C | IMP-007, UVA-06 |
| TST-IMP-08 | Imported 2019 invoice / then `retentionUntil` = 2027-12-31 (8 y) and purge refused before | U, C | IMP-008, GOBD-20, RI-20 |
| TST-IMP-09 | Preview / then business tables unchanged (table counts equal before/after), `imports.preview` holds counts, errors, warnings, duplicates, PDF matches, number-range proposals and open-item total; `previewHash` stable for unchanged input | C | IMP-009 |
| TST-IMP-10 | List rows with an OSS tax label, an unknown label and 0 % VAT without label / then each archived with `unknown_imported` and warning E-IMP-09; a 19 % row without label maps to `domestic` | U, C | IMP-010 |
| TST-IMP-11 | Commit interrupted (simulated failure mid-batch) / then resume continues without duplicates | C (integration) | IMP-006, IMP-023, E-IMP-14, EC-142 |
| TST-IMP-12 | Generic CSV contacts (Windows-1252, `;`) with 1 invalid row / then preview lists the row; commit creates the rest; re-import skips | C | IMP-012 |
| TST-IMP-13 | lexoffice preset sample file / then mapped fields correct | U | IMP-013 |
| TST-IMP-14 | Every imported record / then `channel = "import"` and audit entries exist with importer version | C | IMP-014, SEC-02 |
| TST-IMP-15 | **Withdrawn (v1.1)** — B4: no sevdesk API plan check (403) any more. Replaced by TST-IMP-16 | — | — |
| TST-IMP-16 | Synthetic sevdesk export set (`test/fixtures/sevdesk-export/`: contacts CSV, products CSV, invoice list CSV, PDF ZIP; replaced by anonymised owner samples once available) / when uploaded, mapped with the shipped presets, previewed and committed / then files classified correctly; contacts, products, invoices, credit notes and cancellations created with original numbers, `imported: true`, `origin.source = "sevdesk_export"`, summary lines per VAT rate, status per §4.3.3, artifacts byte-identical with the uploaded PDFs (SHA-256) | C | IMP-003, IMP-016, IMP-017, IMP-018, IMP-020, EC-190 |
| TST-IMP-17 | Invoice list with renamed and reordered headers / then the shipped preset leaves a required field unmapped (E-IMP-21); after manual mapping and „Zuordnung speichern" a second import project reuses the saved preset without manual steps; an ambiguous header is shown as a conflict | U, C | IMP-017 |
| TST-IMP-18 | PDFs named `RE-1001.pdf`, `Rechnung_RE-1002.pdf`, `re 1003.PDF`, one PDF matching two rows, one orphan PDF, one row without PDF / then three matched, E-IMP-22 blocks the ambiguous row, E-IMP-23 lists the orphan, the row without PDF needs the confirmation (E-IMP-07) and is flagged „Original-PDF fehlt" | U, C | IMP-019 |
| TST-IMP-19 | Imported invoice missing a supply date and VAT ID / then no `documentSnapshots` render, no PDF generation and no KoSIT/Mustang call happen (spies), the archived artifact hash equals the uploaded file hash, and the import report lists both deviations | C | IMP-003, EC-190 |
| TST-IMP-20 | Upload + preview, then discard / then status `discarded`, uploaded files removed, business tables and `importedRecords` unchanged, audit entry written; discard after commit started → E-IMP-28 | C | IMP-023, E-IMP-28 |
| TST-IMP-21 | Preview, then a mapping change (or a new local invoice consuming a proposed number) / when commit is called with the old `previewHash` / then 409 `preview_stale` (E-IMP-27), nothing written | C | IMP-023, E-IMP-27 |
| TST-IMP-22 | Committed import / then every uploaded source file is archived with SHA-256 and retention ≥ 10 years, and the import protocol PDF lists files, hashes, mapping, counts, deviations and number-range decisions | C | IMP-024, GOBD-20 |
| TST-IMP-23 | ZIPs with path traversal, a symlink, nesting depth 4 and a 1000:1 compression ratio (plus an encrypted entry → E-IMP-39, too many/too large entries → E-IMP-40) / then each rejected with E-IMP-29, nothing extracted outside the temp area (2026-10-18: entries go to file storage only, never to disk; a rejected archive leaves no stored entry and the other files of the upload are still added) | U | IMP-016, E-IMP-29, E-IMP-39, E-IMP-40 |
| TST-IMP-24 | CSV with German number/date formats, one with an ambiguous date column / then amounts parsed to integer cents correctly and the ambiguous column requires a format choice (E-IMP-26) | U | IMP-016, E-IMP-26 |
| TST-IMP-25 | Open invoice without open/paid amount column / then E-IMP-30 blocks the open item until an amount is entered; multi-rate open item under Ist without split → E-IMP-34; open-item total differing from the entered sevdesk total needs acknowledgement | C | IMP-007, IMP-022, E-IMP-30, E-IMP-34 |
| TST-IMP-26 | Voucher list CSV + files (P2) / then archived vouchers with `imported: true`, files byte-identical, no journal entries before Buchungsbeginn | C | IMP-025 |
| TST-IMP-27 | sevdesk DATEV export (EXTF Stammdaten + Buchungsstapel, P2) / then debtor numbers set on matched contacts, tax-case refinement applied with label precedence, no journal entries created, file archived | U, C | IMP-026 |
| TST-IMP-28 | Invoice rows whose customer number is missing from the contacts CSV / then name match proposed; unmatched rows create a minimal flagged contact (E-IMP-25); the document links to it | C | IMP-021, E-IMP-25 |
| TST-IMP-29 | Imported open invoice without a sent-date column / then `sentOn` = document date (flagged), no `sendLog` row, `zugang` = `sentOn` + 3 days with basis `manual`; owner correction once before the first reminder is audited | C | IMP-003, §4.3.3 |

## 9. Open questions

Decided defaults are binding until changed; ⚠ items stay marked in code with `// LEGAL-OPEN` (legal) or `// SEVDESK-LAYOUT-UNSURE` (file layout).

1. DATEV format details (P3, low priority): decided defaults — Formatversion 13 (12 selectable), Herkunft `RE`, Belegfeld 2 = due date for sales OPOS, supplier invoice number in Zusatzinformation, Beleglink `BEDI "<GUID>"`, `document.xml` per the current XML-Schnittstelle online version from developer.datev.de; exact v13 column list pinned from developer.datev.de. One-off check by a Steuerberater (EXP-016 Testpaket) before the first real handover recommended, non-blocking for go-live ⚠ (01-compliance open item 5).
2. Master data category 16: decided default version 5 with the column list from developer.datev.de at build time ⚠.
3. EÜR + Ist DATEV variant (EXP-012): decided default „OPOS"; „Nur Zahlungen" selectable.
4. Foreign currency in DATEV: decided default Umsatz in EUR as booked (WKZ EUR), original currency/amount/Kurs for information (E-EXP-21) ⚠, one-off Steuerberater check recommended, non-blocking.
5. GDPdU encoding: decided default UTF-8 (`<UTF8/>`), ANSI selectable per export.
6. ~~sevdesk API limits and endpoints~~ — **withdrawn (v1.1, B4)**: no API importer. Replaced by 9 and 10.
7. lexoffice CSV header names (need a real export file).
8. Data model additions (report to lead): `datevExports`, `datevAcceptance` (kept; no longer a go-live gate), `salesDocuments.origin` (`source: "sevdesk_export" | "lexoffice_csv" | "generic_csv"`), `salesDocuments.imported` / `vouchers.imported`, `documentLines.fromSummary`, `salesDocuments.datevBelegnummer` (alias for legacy numbers), `numberRegister.imported`, `taxCase` value `unknown_imported`, `imports` (source/files/status/preview/previewHash/mapping/resolutions/protocol), `importMappingPresets`, `jobs.kind` += `import_sevdesk_export` (replaces `import_sevdesk`), `csv_export`, `import_csv`, `zm_export`.
9. **sevdesk export layouts — resolved 2026-10-18** for contacts, products, invoice list, invoice PDF ZIP and voucher list (see §4.3 „Verified layout facts"); still open: whether „Verkaufspreis" is net, credit-note rows, foreign-currency rows, DATEV ZIP. Original note: exact headers, delimiter/encoding and status labels of the contacts, products/articles, invoice list and voucher list CSVs; whether the invoice list contains positions, per-rate amounts, paid/open amounts, a sent date, a tax-rule column and the reference of credit notes/cancellations; PDF file naming in sevdesk's PDF ZIP; whether a GoBD/„Datenexport" ZIP exists and its structure (research found no dedicated GoBD/Z3 export in sevdesk); menu paths for the wizard instructions. Decided default: header-name mapping with best-guess presets and a mapping UI (IMP-017), summary lines per VAT rate when positions are missing (IMP-020), conservative blocking where data needed for open items is missing (E-IMP-30/34). The owner should download all exports **before** downgrading/cancelling sevdesk (sevdesk deletes data after cancellation).
10. Whether sevdesk exports e-invoice XML files separately: decided default — XML files are archived next to the PDF when supplied (IMP-019), ZUGFeRD PDFs as-is; never re-validated.

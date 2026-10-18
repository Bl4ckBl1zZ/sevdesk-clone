# F04 — Sales Documents (Angebote, Aufträge, Lieferscheine, Rechnungen)
> **Status:** v1.1 · 2026-10-12 (owner decisions B2/B5/B7 applied: no customer e-mailing — documents are exported and marked as sent manually; recurring automation finalises only; customer portal deferred; Steuerberater questions replaced by decided conservative defaults; actors per 02 §4.3 v1.1) · **Phases:** P1 (everything below unless marked, incl. PDF/XML export and the manual sent mark), P2 (UST-01 uninvoiced-supply monitor), P3 (self-billing Gutschrift), P4 (stock movements, time entries → F11, quote follow-ups, Peppol) · **Deferred:** portal acceptance + online payment (F10) · **sevdesk parity:** [08 §1–9](../../research/08-sevdesk-invoicing.md), [00 §2.3, §4.1–4.10, §5.1–5.5, §6](../../research/00-sevdesk-feature-inventory.md#4-invoicing-rechnungsprogramm), [02 #1, #2, #4, #5, #19, #24, #25](../../research/02-competitor-gap-features.md) · **Compliance:** UST-01…15, UST-20…24, UST-30…34, UST-40, UST-41, UST-50, KU-01…03, ER-01, ER-03, ER-04, ER-10…13, ER-20, ER-30, GOBD-02, GOBD-03, GOBD-06, GOBD-20, GOBD-22, MAIL-01…03, MAHN-01, MAHN-04, MISC-01, MISC-03, MISC-04, MISC-07, MISC-08, MISC-09, MISC-10, UVA-06, UVA-07, SEC-02, DATEV-04

Normative inputs: [01-compliance](../01-compliance.md) (rule IDs), [02-architecture §5/§6](../02-architecture.md#5-data-conventions) (rounding, pipeline), [03-data-model §4](../03-data-model.md#4-sales-documents), [04-ui-ux §4.3/§4.4](../04-ui-ux.md#43-document-editor-angebot-auftrag-lieferschein-rechnung), [05-api §4.3](../05-api.md#43-sales-documents-f04), [06-mcp §3.4](../06-mcp.md#34-sales-documents-f04), [10-edge-cases](../10-edge-cases.md) (EC-/RI- IDs), [F01](F01-setup-company-settings.md) (number ranges, placeholders, layouts, KU history, Geschäftsbrief matrix). Payments, open items, Zugang (receipt) derivation, refunds/offsets and dunning are [F05](F05-receivables-payments-dunning.md); the customer portal ([F10](F10-portal-online-payments.md)) is deferred. The app never e-mails customers (decision B2): every outgoing document is exported and sent by the owner outside the app, then recorded with „Als versendet markieren“ (§3.5, §4.10).

## 1. Scope (in / out, and what we do better than sevdesk)

**In scope**
- Document types `quote`, `order_confirmation`, `delivery_note`, `proforma`, `invoice`, `advance_invoice`, `partial_invoice`, `final_invoice`, `cancellation`, `correction` (two kinds: `credit` = Rechnungskorrektur, `rectification` = Rechnungsberichtigung), `self_billing` (P3). `reminder` exists in the same table but is specified in F05.
- Their state machines, the conversion chain, and the invoicing progress of orders (`partially_invoiced` / `invoiced`).
- The document editor: line kinds, product picking, customer prices, line and document discounts/surcharges, net and gross price mode, tax-case derivation and override, mixed rates, foreign currency, DE/EN, text templates, attachments, live totals, compliance panel.
- The finalisation pipeline (02 §6), numbering (F01 mechanism), snapshots, artifacts (PDF/A-3b, ZUGFeRD, XRechnung), validation, "Kopie" re-downloads.
- The ER-03 decision function, the e-invoice format choice and the EN 16931 mapping.
- PDF content: mandatory items, legal note texts per tax case in DE and EN, payment block with EPC QR.
- Export and dispatch record: „Exportieren“ (archived original PDF, ZUGFeRD PDF/A-3, XRechnung XML, PDF „Lesefassung“, attachments, ZIP), „Als versendet markieren“ (date, channel, note, handed-over artifacts), repeated marks and retraction, bulk export and bulk mark, the to-do for exported-but-unmarked documents; the append-only `sendLog` (dispatch record). The owner sends the files outside the app.
- Recurring invoices.
- Duplicating, bulk PDF/ZIP, list views, the per-document view of the number register.
- REST and MCP exposure, including dry-run previews.

**Out of scope (v1)**
- **Any transmission by the app** (decision B2): no SMTP, no e-mail to customers, no `.eml`, no Message-ID, no tracking, no mail identities, no recipient logic, no bulk e-mail. The owner sends the exported files with their own mail client, an upload portal (ZRE/OZG-RE for XRechnung) or on paper.
- Postal sending (sevdesk uses emailbrief.de). The owner prints and uses "Als versendet markieren" with channel `post`.
- OSS destination-country taxation: EU B2C sales above 10,000 € are blocked (UVA-07); full OSS is P4.
- Margin schemes §25/§25a: blocked with a message (UST-24).
- Order-X / XML for quotes and orders; Peppol transmission (P4); online payment and portal acceptance (deferred, F10); subscriptions with proration (P4); stock movements from delivery notes (P4); time entries into invoices (P4, F11); several Skonto tiers per document (COULD); translated product names (open question); reminders/dunning (F05).

**Better than sevdesk**
1. Real line kinds `heading`, `text`, `subtotal` (sevdesk uses 0-quantity positions) and 3/4 decimals for quantities/prices.
2. Quotes with validity date, automatic expiry, and versioned revisions. The accepted version is frozen by hash (EC-079).
3. **Collective invoice** (Sammelrechnung) from several delivery notes, and quantity-based partial billing of orders.
4. Final invoices that are legally exact: per-rate deduction of the **received** advance payments, the rate-change case, a negative remainder (refund), and the XML BT-113/BG-3 mapping.
5. Clear correction paths: Storno only for unpaid invoices; Rechnungskorrektur with refund/offset handling for paid ones; Rechnungsberichtigung for formal defects (UST-31). The word "Gutschrift" is reserved for self-billing (UST-33).
6. Foreign currency in every invoice type, including advance/final chains (sevdesk forbids it), with EUR VAT (MISC-08).
7. Recurring invoices with "end after N", catch-up after downtime, a preview of the next runs, and one E-Rechnung per period (ER-04).
8. The ER-03 decision is visible in the editor, the finalise dialog, the export dialog and the mark-sent dialog; the mark-sent dialog enforces the e-invoice obligation (structured e-invoice handed over electronically for `MUST_E`). KoSIT validation runs **before** a number is consumed.
9. Full API and MCP with dry-run previews, idempotency and confirm tokens; previews return totals, validation and the ER-03 decision without saving.
10. Every edge case that could break a rule has a blocking validator and a test (§5.2).
11. A verifiable dispatch record instead of "fire and forget" e-mail: every export and every sent mark records the exact archived artifact hashes that left the system, the channel and the date; the Zugang (receipt) for Verzug and dunning is derived from it (F05), and nothing is ever dunned that was never marked as sent.

## 2. User stories

| ID | As … | I want … | so that … |
|---|---|---|---|
| US-01 | owner | to write a quote from products with optional positions and a validity date | the customer can choose, and stale quotes expire by themselves |
| US-02 | owner | to issue a new version of a rejected or changed quote | the history stays traceable and the accepted version is unambiguous |
| US-03 | owner | to turn an accepted quote into an order confirmation, delivery note or invoice with one click | I never retype positions |
| US-04 | owner | to bill 30 % of an order as an Abschlagsrechnung and later a Schlussrechnung that deducts what was paid | VAT is correct even if the rate changed in between |
| US-05 | owner | to bill several delivery notes in one invoice | I invoice monthly for many deliveries |
| US-06 | owner | the tax case (Inland, EU, Drittland, §13b, KU) to be derived for me, with the legal note printed automatically | I cannot forget a mandatory text |
| US-07 | owner | to enter gross prices for consumers and still get a valid E-Rechnung | PAngV and EN 16931 are both satisfied |
| US-08 | owner | a compliance panel that tells me exactly what is missing, in German, with a link to fix it | I can never issue a defective invoice |
| US-09 | owner | to cancel an unpaid invoice with a Stornorechnung, and to correct a paid one with a Rechnungskorrektur and a refund | the books stay correct and GoBD-compliant |
| US-10 | owner | to fix a formal defect (wrong address, missing VAT ID) without changing amounts | my customer keeps the input VAT deduction retroactively (UST-31) |
| US-11 | owner | recurring monthly invoices that finalise themselves, each with its billing period, and a to-do „Exportieren und versenden“ | retainers need only one export and one click per month |
| US-12 | owner | the export and mark-sent dialogs to offer only formats and channels that are legal for this customer and date | I never hand over a PDF or paper where an E-Rechnung is mandatory |
| US-13 | owner | to download all invoices of a quarter as a ZIP with hashes | I can hand them to the Finanzamt (Außenprüfung) or a future Steuerberater |
| US-14 | owner (mobile) | to create, finalise and share (export) a simple invoice on my phone in under 2 minutes and mark it as sent | I can bill on site |
| US-15 | Claude (MCP) | to create drafts freely and get a preview with totals, validation and ER-03 | I can prepare documents and ask the owner before finalising |
| US-16 | website (REST, inside the tailnet) | to create and finalise an invoice idempotently after checkout | a retry never produces a second invoice; the owner exports and sends it (to-do) |
| US-17 | owner | an English invoice for a foreign customer with the legal notes in both languages | the customer understands it and the Finanzamt accepts it |
| US-18 | owner (P3) | to issue a self-billing Gutschrift to a commission agent under a stored agreement | the document is a valid invoice replacement |
| US-19 | owner | to see the whole chain (quote → order → delivery notes → invoices → corrections) | I know what is billed and what is open |
| US-20 | owner | the EPC QR and payment reference to carry exactly the invoice number | incoming bank payments (statement import or bank feed) are matched automatically (F07) |
| US-21 | owner | to export the legally correct files for a document in one click and then record how and when I sent them | I keep full control of my mailbox and still have a GoBD-proof dispatch record that drives Zugang and dunning |
| US-22 | owner | a to-do for every document I exported but did not mark as sent | no invoice silently stays without Zugang (no Verzug, no dunning) |

## 3. Functional requirements

### 3.1 Cross-type (DOC)

| ID | Requirement | Priority | Phase | Compliance refs |
|---|---|---|---|---|
| DOC-01 | Support the document types of §4.1 in one `salesDocuments` table. `self_billing` is P3; `reminder` is specified in F05 | MUST | P1 | UST-11, UST-33 |
| DOC-02 | Each type has a state machine in `src/domain/documents/lifecycle.ts` (§4.2). Every status change goes through a model function that checks the allowed transition; illegal transitions throw `illegal_transition` (409) | MUST | P1 | GOBD-06 |
| DOC-03 | Drafts are freely editable and deletable through UI, API and MCP. Deleting a draft writes the full draft content to the audit log. Drafts never carry a number (EC-013) | MUST | P1 | GOBD-02, GOBD-06, UST-06 |
| DOC-04 | Line kinds: `item`, `heading`, `text`, `subtotal`. `item` lines may be flagged `optional` (quotes only) and `isLaborCost` (MISC-07). Headings/text/subtotals have no amounts and no VAT. A subtotal shows the sum of the net (or gross in gross mode) item amounts since the previous subtotal or heading | MUST | P1 | UST-07 |
| DOC-05 | Picking a product copies name, description, unit, unit price (§DOC-06), `vatRateKey`, exemption reason, `placeOfSupplyRule`, item number (BT-155), revenue account and labour share. Later product changes never alter documents; drafts show "Produkt geändert – übernehmen?" | MUST | P1 | UST-15, GOBD-06 |
| DOC-06 | Price resolution for a product line: customer price (`customerPrices`, latest `validFrom` ≤ supply date, else latest without date) → product price; then the contact's `defaultDiscountBp` as line discount. A price stored in the other price mode is converted with the rules of App. E.3 | MUST | P1 | — |
| DOC-07 | Line discount as percent (bp) or amount; document-level discount **or** surcharge as percent or amount with a reason text. Order of computation and allocation per VAT group exactly as App. E | MUST | P1 | UST-09, UST-10 |
| DOC-08 | Price mode `net` / `gross` per document. Default: `gross` if the contact `isConsumer`, else the company default. Switching mode on a draft converts unit prices (App. E.3) after a confirm dialog | MUST | P1 | MISC-03 |
| DOC-09 | Totals computed once in `src/domain/documents/totals.ts` with BigInt intermediates, half-away-from-zero rounding, per App. E. The same module runs in the editor (live) and on the server (authoritative). The server never trusts client totals | MUST | P1 | UST-09, UST-10, GOBD-03 |
| DOC-10 | Gross mode is converted to the net EN 16931 model with the deterministic algorithm of App. E.3. A residual of ±1 cent per VAT group versus the entered gross is shown as warning `gross_rounding_deviation` | MUST | P1 | UST-10, MISC-03 |
| DOC-11 | Tax case derived by `deriveTaxCase()` (App. C) from company (KU status at supply date), contact (country of establishment, consumer flag, VAT ID + check status, public authority, default tax case, §13b certificate), delivery country and line products (`type`, `placeOfSupplyRule`, `reverseCharge13b`). Re-derived on every relevant draft change; a changed result shows a notice | MUST | P1 | UST-20…23, KU-02 |
| DOC-12 | Tax-case override per document with a mandatory reason (≥ 10 characters), audited (`taxCaseOverridden.reason`). Line category override only within the categories allowed for the tax case (App. C.3) | MUST | P1 | UST-10, UST-34 |
| DOC-13 | VAT rates resolved from the rule table by the **supply date** of the line (line period end, else document supply date) and the line's `vatRateKey` (UST-15). Changing the supply date of a draft re-resolves and shows "Steuersatz geändert: 19 % → 7 % (Leistungsdatum)". The rule row IDs are stored in the snapshot | MUST | P1 | UST-15, MISC-09 |
| DOC-14 | Mixed-rate documents produce one VAT group per (category, rate). Domestic documents may mix S (19/7), Z, E and line-specific §13b (AE) lines (EC-048/049) | MUST | P1 | UST-09, UST-10 |
| DOC-15 | Foreign currency (any ISO 4217 code with a defined minor unit of 2) on all invoice types. An EUR exchange rate with source and date is mandatory at finalisation; VAT is also shown in EUR (App. E.6) | MUST | P1 | MISC-08 |
| DOC-16 | Document language `de` / `en` (default from the contact). Labels, units, dates and number formats follow the language. Legal notes on EN documents are printed bilingually (App. B) | MUST | P1 | UST-10 |
| DOC-17 | Head text, foot text and subject from text templates (F01 SET-080…087) with placeholders; resolved and frozen at finalisation (SET-084). Default subject: `{{document.typeLabel}} {{document.number}}` | MUST | P1 | GOBD-06 |
| DOC-18 | Attachments per document (≤ 10 files, ≤ 10 MB each, PDF/PNG/JPEG/XLSX/CSV/TXT): stored with sha256, frozen at finalisation, included in the export bundle by default (`includeInExport`, SND-16), optionally embedded in XRechnung as BG-24 (`embedInXml`) | MUST | P1 | MAIL-02, GOBD-06 |
| DOC-19 | Live totals in the editor within 50 ms per keystroke (04 §9) using the shared module; the preview pane re-renders after 600 ms | MUST | P1 | — |
| DOC-20 | Compliance panel: runs `validateDocument()` (the same validators as finalisation) on every change and lists blocking errors and warnings from §5.1 with a link to the field or setting. "Fertigstellen" is disabled while errors exist | MUST | P1 | GOBD-03 |
| DOC-21 | Supply date as `date`, `period` or `month`, plus the draft option "Leistungsdatum = Rechnungsdatum" (resolved to `date` at finalisation). Line periods (BG-26) are allowed and required when one document covers sub-periods with different rates (EC-024) | MUST | P1 | UST-08, UST-15 |
| DOC-22 | Drafts reference the live contact and address. At finalisation the buyer block (name, address, department, VAT ID, tax number, buyer reference, electronic address, consumer/public flags) and the seller block are frozen into the snapshot. Storno/corrections copy the seller block of the original (F01 SET-022) | MUST | P1 | UST-03, MAIL-03 |
| DOC-23 | Delivery address (BG-13/BG-15): defaults to the contact's default delivery address; mandatory for intra-Community supplies and exports (the destination country drives the tax case, EC-042) | MUST | P1 | UST-21, UST-23 |
| DOC-24 | Finalisation pipeline exactly as 02 §6 with the per-type differences of §4.6: domain validation → preview snapshot → preview XML validation (KoSIT/Mustang) → single commit transaction (version check, re-validation, number, snapshot, status, journal hook, audit) → artifact rendering | MUST | P1 | UST-06, ER-12, GOBD-06 |
| DOC-25 | Numbers come from the range resolved for the document type (F01 SET-055, §4.3) inside the commit transaction. The period key uses the document date in Europe/Berlin (EC-010) | MUST | P1 | UST-06, GOBD-22 |
| DOC-26 | Document date: set at finalisation to the Europe/Berlin calendar date of the commit instant (EC-020), or a chosen earlier date. Never in the future. Backdating > `backdateWindowDays` (default 10) needs a reason; > 6 months adds a warning; into a locked period or a period with a submitted UStVA is blocked (EC-022) | MUST | P1 | UST-05, GOBD-06, GOBD-22 |
| DOC-27 | Snapshot: canonical JSON of the full EN 16931 + render model (incl. resolved texts, legal notes, deduction table, FX data), `snapshotHash`, `ruleVersions`, `layoutVersionId`. Immutable | MUST | P1 | GOBD-06, ER-30 |
| DOC-28 | Artifacts rendered from the snapshot only: PDF/A-3b (all types), embedded ZUGFeRD XML or a separate XRechnung XML (invoice types), KoSIT/Mustang reports. `artifactStatus` `pending → ready` or `blocked`; retries with backoff; never a rollback to draft or a renumbering (EC-005/006) | MUST | P1 | ER-01, ER-11, ER-12, ER-13 |
| DOC-29 | Finalised documents are read-only; only the fields whitelisted in 03 §11 change, through model functions. Any other write returns 409 `document_not_draft` / `immutable_record` | MUST | P1 | UST-30, GOBD-06 |
| DOC-30 | PDF content per App. F: every mandatory item at its defined position; legal notes per App. B | MUST | P1 | UST-03…13, KU-02, MAHN-01 |
| DOC-31 | The Geschäftsbrief footer (F01 §5.2 matrix) is printed on every page of every type (quotes, orders, delivery notes, proforma, invoices, corrections). Missing mandatory items block finalisation | MUST | P1 | MAIL-03 |
| DOC-32 | Once the document is marked as sent (SND-05), re-exports and downloads are rendered from the snapshot with a "Kopie" stamp (DE "Kopie", EN "Copy / Kopie"); the Kopie is archived as artifact variant `copy` on first generation so its sha256 can be recorded. The archived original stays byte-identical. `?original=true` / „Original erneut exportieren“ returns the original, needs a reason and is audited (EC-099) | MUST | P1 | UST-34 |
| DOC-33 | Conversions per the matrix of §4.3 create a new draft and link `originId`/`chainRootId`. Copy rules per §4.3.2; rates and tax case are re-derived for the target (EC-040, EC-080) | MUST | P1 | UST-15 |
| DOC-34 | Chain view ("Verknüpft" tab and `expand=chain`): all documents sharing `chainRootId`, with status, amounts and invoicing progress | MUST | P1 | GOBD-01 |
| DOC-35 | "Duplizieren" on any document except `cancellation`: a new draft of the same type (corrections and self-billing excluded; advance/partial/final become `invoice` drafts) without number, dates, chain links, payments or acceptance; contact data, rates and tax case are re-resolved | MUST | P1 | — |
| DOC-36 | "Letztes Dokument übernehmen": when a contact is chosen on a new empty draft, offer to copy the lines and texts of that contact's last document of the same type | SHOULD | P1 | — |
| DOC-37 | List pages per type with status tabs, search, filters, column chooser, totals row and cursor pagination (§6.1) | MUST | P1 | — |
| DOC-38 | Bulk actions as background jobs: export for sending (job `bulk_export`, SND-20), archive PDF/ZIP download (originals with a `SHA256SUMS.txt` manifest, or "Kopie" copies), CSV export, tag, mark as sent (SND-20) | MUST | P1 | GOBD-11 |
| DOC-39 | Per-document number history ("Nummernkreis-Eintrag") and the link to the F01 register/gap report (SET-063) | MUST | P1 | GOBD-02 |
| DOC-40 | `retentionClass` per type (§4.1); `retentionUntil` = 31.12. of (document year + N) set at finalisation | MUST | P1 | GOBD-20, UST-50 |
| DOC-41 | Every mutation writes an audit entry with actor, channel, request ID and diff (SEC-02); MCP/API changes appear live in the UI with the actor toast (04 §1) | MUST | P1 | GOBD-06, SEC-02 |
| DOC-42 | Dry-run preview (`/preview`, `document_preview`): totals, validation, tax case with explanation, ER-03 decision, e-invoice format, number preview, PDF preview link, optional XML validation; saves nothing | MUST | P1 | GOBD-03, ER-03 |
| DOC-43 | Duplicate-issue guard: warning `possible_duplicate` when a finalised invoice for the same contact, gross amount and supply date exists within 30 days (two originals for one supply → §14c) | MUST | P1 | UST-34 |
| DOC-44 | Kleinbetragsrechnung flag: allowed only if gross ≤ 250.00 € (in EUR) and no K/AE/§3c lines; then the buyer address may be omitted (generic contact "Barverkauf"). Number, supply date and full data are still recorded | SHOULD | P1 | UST-14 |
| DOC-45 | Margin schemes (§25/§25a) and travel agencies are blocked with a message; EU B2C distance sales above the OSS threshold are blocked (EC-056/057) | MUST | P1 | UST-24, UVA-07 |
| DOC-46 | Flag `propertyRelated` (auto-set when any line product has `placeOfSupplyRule = property`); for consumers it prints the §14b note | MUST | P1 | UST-12 |
| DOC-47 | §35a: lines flagged `isLaborCost` or with a product labour share; B2C invoices print the labour subtotal (net, VAT, gross) | MUST | P1 | MISC-07 |
| DOC-48 | Consumer documents (quotes, orders, invoices) show gross unit prices and gross totals (net may be shown additionally) | MUST | P1 | MISC-03 |
| DOC-49 | Every item line needs a Rec 20/21 unit code and a specific description; generic descriptions produce `generic_description` | MUST | P1 | UST-07 |
| DOC-50 | Payment terms: due days (0 = sofort), optional Skonto (percent + days < due days), text; due date = document date + due days; Skonto text and BT-20 syntax per App. A.4 and B | MUST | P1 | UST-09, MAHN-01, MAHN-04 |
| DOC-51 | EPC QR (GiroCode) on EUR invoice types with a positive payable amount and payment method `transfer`: v002, holder name = account holder, IBAN, amount = payable, unstructured remittance = **exactly the invoice number** (optional prefix "RE " via setting `paymentReferencePrefix`; no RF reference, no other text). The printed "Verwendungszweck" and the XML BT-83 carry the identical string. Incoming transfers (statement import or bank feed, F07) may lack the payer IBAN/name, so F07 matching relies primarily on this reference | MUST | P1 | MISC-01 |
| DOC-52 | Optimistic concurrency: drafts carry `version`; writes require the current version (`If-Match`), mismatch → 409 `version_conflict` | MUST | P1 | GOBD-03 |
| DOC-53 | Tags, custom fields (printable if `printOnDocuments`), cost centre per document and per line, project (P4) | MUST | P1 | DATEV-02 |
| DOC-54 | Layout per document (default per type, F01 SET-074); the layout version is stored in the snapshot | MUST | P1 | GOBD-06 |
| DOC-55 | Display status derivation (§4.2.9) is a pure function shared by lists, API (`display_status`) and MCP | MUST | P1 | — |
| DOC-56 | All amounts, VAT and the ER-03 inputs are evaluated in EUR for thresholds (250 € Kleinbetrag, 10,000 € OSS, KU) using the document FX rate | MUST | P1 | UST-14, KU-01, MISC-08 |
| DOC-57 | Stichtag simulation coverage: every type computes correctly on both sides of an injected rate change (MISC-09) | MUST | P1 | MISC-09 |
| DOC-58 | Control characters are stripped from all text inputs; texts are XML-escaped; glyphs missing from the embedded fonts render as "□" with warning `unsupported_glyph` before finalising (10 EC-096) | MUST | P1 | ER-11 |
| DOC-59 | Clock-skew guard: finalisation is refused when the server clock deviates > 60 s from NTP (EC-027) | MUST | P1 | GOBD-22, UST-05 |
| DOC-60 | When an `RI-*` ERROR invariant is unacknowledged, finalisation of new documents is blocked (10 §2) | MUST | P1 | GOBD-06 |

### 3.2 Quotes, order confirmations, delivery notes, proforma (QUO)

| ID | Requirement | Priority | Phase | Compliance refs |
|---|---|---|---|---|
| QUO-01 | Quote fields as invoice plus `validUntil` (default document date + `quoteValidityDays`, ≥ document date), delivery terms text, optional positions. Supply date is optional on quotes ("voraussichtlich") | MUST | P1 | — |
| QUO-02 | Optional positions are excluded from all totals and VAT; printed with "Optional" and their amount in parentheses; on conversion the owner selects which become regular items | MUST | P1 | — |
| QUO-03 | Quote state machine §4.2.1 incl. `superseded`; transitions audited | MUST | P1 | GOBD-06 |
| QUO-04 | Daily job (in `deadlines.notify`, 08:00) sets `expired` when `validUntil` < today for `finalized`/`sent` quotes and notifies 3 days before expiry | MUST | P1 | — |
| QUO-05 | Manual "Angenommen" (date, by whom, channel, note) and "Abgelehnt" (date, reason). Acceptance stores `acceptance.snapshotHash` of the accepted version. Portal acceptance with e-signature is deferred (F10); acceptance is always recorded manually | MUST | P1 | GOBD-06 |
| QUO-06 | Revisions: "Neue Version" on a finalised quote creates a draft with `revision = n+1`, `originId` = previous version. Finalising it sets the previous version to `superseded`. Number = base number + `-V{n}` (setting `quoteRevisionNumbering: suffix \| new_number`, default suffix) | MUST | P1 | UST-06, GOBD-06 |
| QUO-07 | An accepted quote cannot be revised or edited; changes need a new quote or a change order (new revision is blocked with `quote_accepted_frozen`, EC-079) | MUST | P1 | GOBD-06 |
| QUO-08 | Order confirmation (AB): created from a quote or standalone; state machine §4.2.2; carries delivery terms and the customer order reference (BT-13) | MUST | P1 | — |
| QUO-09 | Delivery note (Lieferschein): delivery date (supply `date`) mandatory; delivery address; `showPrices` flag (default off) hides prices and totals in the PDF while lines keep prices internally; "Erhalten" with date and recipient name; no VAT block when prices are hidden | MUST | P1 | UST-08 |
| QUO-10 | Partial deliveries: delivery notes created from an order track delivered quantities per order line; the conversion dialog proposes the remaining quantities | MUST | P1 | — |
| QUO-11 | Collective invoice: select several finalised, uninvoiced delivery notes of one contact (same currency, tax case, price mode) → one invoice draft with a heading per delivery note ("Lieferschein LS-2026-0012 vom 03.10.2026") and line periods/dates per note; the invoice supply date is the period from the earliest to the latest delivery date | MUST | P1 | UST-08 |
| QUO-12 | Proforma: own range (F01 `PF-`), title "Proforma-Rechnung", note "Keine Rechnung im Sinne des § 14 UStG", no XML, no journal entries, no receivable, not counted in revenue or open items; convertible to an invoice | MUST | P1 | UST-34 |
| QUO-13 | Invoicing progress of quotes and orders per §4.3.3 (`partially_invoiced` / `invoiced`), recomputed when a derived invoice is finalised, cancelled or corrected | MUST | P1 | — |
| QUO-14 | Uninvoiced delivery notes: warning at day 150 and escalation at day 180 after the delivery date for B2B/legal-person customers and property-related supplies (dashboard to-do + delivery note badge) | MUST | P2 | UST-01 |
| QUO-15 | Withdrawal (`cancelled`) of quotes, orders, delivery notes and proforma with a reason, only while no finalised invoice derives from them | MUST | P1 | GOBD-06 |
| QUO-16 | Quote follow-up reminders (+5/+12 days without reaction) reusing the dunning rule engine | COULD | P4 | — |
| QUO-17 | Delivery notes reduce stock (`stockMovements`) when finalised; cancelling reverses | COULD | P4 | — |

### 3.3 Invoices (INV)

| ID | Requirement | Priority | Phase | Compliance refs |
|---|---|---|---|---|
| INV-01 | Standard invoice (`invoice`): supply date mandatory; full validation set §5.1 | MUST | P1 | UST-03…10 |
| INV-02 | Invoice-family state machine §4.2.5 with `paymentStatus` (`open`, `partially_paid`, `paid`, `written_off`; "überfällig" is derived, never stored). There is no reset to draft | MUST | P1 | UST-30, GOBD-06 |
| INV-03 | Advance invoice (`advance_invoice`, Abschlagsrechnung): standalone or from a quote/order; amount as percent of the order, fixed net or fixed gross; one line per VAT group of the order (App. E.5). PDF states "Abschlagsrechnung Nr. {n} zu {Auftrag}" and "Die Leistung ist noch nicht (vollständig) erbracht". Flagged for Mindest-Ist VAT on receipt (UST-40) for the accounting hook | MUST | P1 | UST-40 |
| INV-04 | Partial invoice (`partial_invoice`, Teilrechnung): from a quote/order only, percent/net/gross like INV-03; treated as an advance for VAT (UST-40 normative: Mindest-Ist, deducted in the final invoice). Σ of advance + partial invoices of an order ≤ the order net total per VAT group (EC-078) | MUST | P1 | UST-40 |
| INV-05 | Quantity-based billing of a completed Teilleistung: a normal `invoice` from an order with selected line quantities (remaining quantities proposed). Not deducted in a final invoice; the order becomes `partially_invoiced` | MUST | P1 | UST-08 |
| INV-06 | Final invoice (`final_invoice`): repeats the full supply (all order lines + additional lines), taxes it at the rates of **its** supply date, and deducts each advance/partial invoice of the chain with the **received** net and VAT per (category, rate) of that advance (App. E.4). Shows the remainder ("Zahlbetrag") which may be 0 or negative (refund) | MUST | P1 | UST-41, UST-34 |
| INV-07 | Final-invoice preconditions: at most one non-cancelled final invoice per chain; document date ≥ every deducted advance's date; same currency and tax case as the advances. Only **received** amounts are deducted (RI-08); `deductions[]` (03) lists only deducted advances. **A final invoice cannot be finalised while any referenced advance has an open amount** (10 EC-070/071, `advance_not_settled`). The wizard resolves this in the same step: **unpaid** → Storno of the advance (it is then not deducted); **partially paid** → a Rechnungskorrektur (`correction`, `correctionKind: credit`) that reduces the advance to the amount actually received (per group `allocate(open, gross_ag)`), finalised together with the final-invoice preparation; the advance is then settled (`paymentStatus` `paid`) and deducted with exactly the received amount (`partiallyPaid: true` marks a corrected advance, 03). Both corrective documents need `invoices:cancel` (Storno) or `invoices:finalize` + `invoices:cancel` (correction). *Withdrawn:* the former options "nicht abziehen" (leave an unpaid advance undeducted and open) and "Restbetrag offen lassen" (warning `advance_remainder_open`) — both allowed the same supply to be billed twice with VAT shown twice (§14c UStG) | MUST | P1 | UST-41, UST-34 |
| INV-08 | Rate change between advance and final: total at the new rate, advances at their original rate, negative VAT remainder possible; per-group tax effect stored in the snapshot for UStVA (EC-073, golden G-14) | MUST | P1 | UST-41, MISC-09 |
| INV-09 | Final-invoice XML: BG-3 per deducted advance (BT-25/BT-26), BT-113 = Σ deducted gross, BT-115 = payable, BT-22 note with the per-rate deduction table (App. A.6) | MUST | P1 | UST-41, ER-01 |
| INV-10 | Storno (`cancellation`): allowed only for finalised invoice-family documents with no allocated payments (net of reversed payments), not already cancelled, not deducted in a non-cancelled final invoice. Creates and finalises in one action a full mirror (all lines with negated quantities, same rates, same supply date, seller block of the original), own number from the range of `cancellation` (default: the invoice range), document date today, BT-25/26 reference; sets the original `cancelled`, closes its receivable and dunning case, marks the register row `cancelled_by_storno` | MUST | P1 | UST-30, UST-06, RI-06 |
| INV-11 | Storno is blocked for paid/partially paid invoices with `storno_paid_invoice` and the guidance to (a) reverse a wrong payment allocation first (F05), or (b) create a Rechnungskorrektur plus refund. Storno of a Storno is impossible (EC-074/075) | MUST | P1 | UST-30 |
| INV-12 | Rechnungskorrektur (`correction`, kind `credit`): draft prefilled with the original's lines; the owner reduces quantities/prices or removes lines; stored as a negative delta. Σ(original + all credits) ≥ 0 per VAT group (RI-07). Effect: reduces the original's open amount; any excess becomes a refund liability on the correction ("Erstattung offen") cleared by a refund payment or an offset against another invoice (F05). Title never contains "Gutschrift" | MUST | P1 | UST-30, UST-33 |
| INV-13 | Rechnungsberichtigung (`correction`, kind `rectification`): repeats the complete corrected invoice with **identical** amounts per VAT group, references original number and date, lists the corrected items ("Berichtigt: Anschrift des Leistungsempfängers"). No journal entries, no payment change; register status of the original → `corrected`. UI explains Berichtigung vs Storno (UST-31) | MUST | P1 | UST-30, UST-31 |
| INV-14 | Additional charge after an issued invoice (Nachberechnung) = a new `invoice` with optional reference (BT-25/26) to the original; corrections never increase amounts | MUST | P1 | UST-30 |
| INV-15 | A correction always targets an original invoice-family document; earlier corrections of the same original are referenced as additional BG-3 entries. Storno of a correction is allowed while no refund/offset is allocated to it | MUST | P1 | UST-30, RI-07 |
| INV-16 | Self-billing (`self_billing`, Gutschrift): only for a supplier contact with a stored self-billing agreement (date, scope, valid period); title always "Gutschrift"; TypeCode 389; seller = the supplier, buyer = our company; own range `GS-`; recorded as a purchase (F06 voucher link); objection (Widerspruch) cancels its effect and is recorded with date | MUST | P3 | UST-11, UST-33 |
| INV-17 | E-invoice format choice per §4.6.3: contact preference + ER-03 + type. `MUST_E` with format `none` blocks (`einvoice_required`) | MUST | P1 | ER-01, ER-03 |
| INV-18 | ER-03 decision function per App. D; evaluated in preview, at finalisation (stored in `einvoice.decision`) and in the export and mark-sent dialogs (SND-03, SND-17) | MUST | P1 | ER-03, MAIL-01 |
| INV-19 | EN 16931 mapping per App. A for CII and UBL; profiles: ZUGFeRD 2.5 EN 16931 (default), ZUGFeRD XRECHNUNG, XRechnung 3.0.2 CII, XRechnung 3.0.2 UBL | MUST | P1 | ER-01, ER-10 |
| INV-20 | XML validated in the preview (placeholder number) and again after commit; reports archived with validator/config version; errors in the preview abort before numbering. Validator unavailable → finalisation refused (503) unless ER-03 is `NOT_REQUIRED`/`MAY_PAPER_OR_PDF` **and** format `none` (EC-007) | MUST | P1 | ER-12 |
| INV-21 | ZUGFeRD container: PDF/A-3b with `factur-x.xml` (EN 16931) or `xrechnung.xml` (XRECHNUNG profile), AFRelationship `Alternative`, Factur-X XMP, ICC intent; extracted XML byte-equal to the archived XML | MUST | P1 | ER-11 |
| INV-22 | BT-10 rules and B2G: Leitweg-ID mandatory and validated for public authorities; B2B fallback chain (App. A.3) | MUST | P1 | ER-10, ER-20 |
| INV-23 | Legal notes generated from the tax case, line categories and flags using versioned `noteText` rule rows (App. B); not editable in the document; placeholders not allowed in them (SET-083) | MUST | P1 | UST-10, UST-20…23, KU-02 |
| INV-24 | Kleinunternehmer: no VAT columns, KU note, category KU only; any VAT rate via UI/API/MCP rejected (`ku_vat_not_allowed`); KU-01 threshold check in the commit transaction with the blocking dialog and SET-035 history entry | MUST | P1 | KU-01, KU-02, KU-03 |
| INV-25 | UST-13 note "Versteuerung nach vereinnahmten Entgelten" for invoices dated ≥ 2028-01-01 of Ist-taxing companies (method valid at the document date); also in XML BT-22 | MUST | P1 | UST-13 |
| INV-26 | §286 Abs. 3 BGB note on B2C invoice-family documents with a positive payable amount | MUST | P1 | MAHN-01 |
| INV-27 | §14a deadline: for EU B2B services and intra-Community supplies the editor shows "Rechnung bis {15. des Folgemonats} ausstellen"; warning 3 days before and after | MUST | P1 | UST-02 |
| INV-28 | K/AE (EU) lines require a valid VAT-ID check of the customer dated ≤ finalisation (qualified eVatR for K); unavailable check service → audited override with reason + follow-up task (EC-044/045) | MUST | P1 | MISC-04, UST-20, UST-21, RI-16 |
| INV-29 | §13b: warning if the customer's USt 1 TG certificate is missing/expired (EC-047); the XML needs BT-48 or BT-47 of the buyer (BR-AE-02) | MUST | P1 | UST-22 |
| INV-30 | Proof attachments: intra-Community supplies warn until a Gelangensbestätigung/CMR is attached after finalisation; exports warn until an Ausfuhrnachweis is attached (attachments to finalised documents are allowed as "Nachweise", they are not part of the snapshot) | MUST | P1 | UST-21, UST-23 |
| INV-31 | Accounting hook: commit calls `accounting.postSalesDocument(snapshot)`; Storno posts the reversal in the Storno's period (EC-076); rectifications post nothing; proforma/quotes/orders/delivery notes post nothing | MUST | P1 | GOBD-01 |
| INV-32 | Finalising an invoice derived from an order updates the order's invoicing progress in the same transaction | MUST | P1 | — |
| INV-33 | Payable ≤ 0: no EPC QR, no §286 note, payment block says "Der Betrag wird erstattet" / "Kein Zahlbetrag", BT-81 per App. A.5 | MUST | P1 | MISC-01 |

### 3.4 Recurring invoices (REC)

| ID | Requirement | Priority | Phase | Compliance refs |
|---|---|---|---|---|
| REC-01 | Template = draft content (contact, lines with `vatRateKey`, texts, terms, references incl. BT-12 contract reference) + schedule + automation; list, detail, create, edit, pause, resume, delete (only if nothing generated, else archive) | MUST | P1 | ER-04 |
| REC-02 | Intervals: 7 Tage, 14 Tage, monatlich, 2 Monate, vierteljährlich, halbjährlich, jährlich, 2/3/4/5 Jahre (`P7D…P5Y`). Monthly-based intervals keep the anchor day of `firstDate` (clamped to the month length) | MUST | P1 | — |
| REC-03 | End by date (last occurrence ≤ `endDate`) and/or after N invoices (`maxCount`); the template is then "Beendet" | MUST | P1 | — |
| REC-04 | Billing `in_advance` (period = [occurrence, next occurrence − 1 day]) or `in_arrears` (period = [previous occurrence, occurrence − 1 day]); the period is the supply date (BG-14); optional period text placeholder `{{recurring.periodText}}` in the head text | MUST | P1 | UST-08, ER-04 |
| REC-05 | Job `recurring.generate` (daily 06:00 Europe/Berlin) creates one invoice per due occurrence, idempotent by (templateId, occurrenceDate) | MUST | P1 | ER-04 |
| REC-06 | Catch-up: missed occurrences are generated oldest first, each with its own period; the document date is the generation date (never backdated). More than `catchUpAutoMax` (default 3) missed occurrences → all become drafts without automation, plus a notification | MUST | P1 | UST-05 |
| REC-07 | Auto-finalise: runs the full pipeline as actor `system:cron.recurring.generate`; any blocking error, KU crossing, rate-change split need or validator outage leaves a draft and notifies the owner | MUST | P1 | ER-12, KU-01 |
| REC-08 | **Withdrawn (v1.1)** — B2: the app never sends documents, so recurring invoices cannot be sent automatically. Replaced by REC-16. | — | — | MAIL-01, MAIL-02 |
| REC-09 | Every generated invoice is a complete E-Rechnung for its period (BG-14, BT-12 = template contract reference or template name) | MUST | P1 | ER-04 |
| REC-10 | Pause/resume; on resume with past due occurrences the owner chooses "nachberechnen" (catch-up) or "überspringen" (next date moves to the first future occurrence; skipped periods are audited) | MUST | P1 | — |
| REC-11 | Editing a template affects only future generations; already generated drafts and invoices are unchanged (notice in the editor) | MUST | P1 | GOBD-06 |
| REC-12 | "Jetzt erzeugen": generates the next occurrence immediately (same rules), advancing the schedule | MUST | P1 | — |
| REC-13 | Preview of the next 12 occurrences with dates, periods, expected rates and ER-03 decision | MUST | P1 | ER-03 |
| REC-14 | Activating automation (finalise) requires a UI confirmation on first activation and, for API/MCP, the scope `invoices:finalize` on the creating key (06 §3.4). Automation never includes sending, so `invoices:send` is never needed for templates | MUST | P1 | SEC-02 |
| REC-15 | A period that crosses a rate-change or KU boundary is generated as a draft with line periods split at the boundary (pro rata by days, rounded per App. E) and a notification; never auto-finalised | MUST | P1 | UST-15, KU-01 |
| REC-16 | Automation is `{ finalize: boolean }` only: it may finalise, never export or send. Every auto-finalised invoice creates a dashboard to-do „Exportieren und versenden: {number} ({contact})“ linking to the export dialog (SND-16); the to-do closes with the first sent mark (SND-07) or the invoice's Storno. Generated drafts create the to-do „Entwurf prüfen und fertigstellen“. The exported-but-unmarked rule (SND-21) applies afterwards | MUST | P1 | MAIL-02, ER-04 |

### 3.5 Export and dispatch record (SND)

Decision B2: the app never transmits documents to customers. The owner exports the archived files, sends them outside the app and records the dispatch with „Als versendet markieren“. The ID prefix `SND` is kept.

| ID | Requirement | Priority | Phase | Compliance refs |
|---|---|---|---|---|
| SND-01 | **Withdrawn (v1.1)** — B2: no e-mail send dialog (recipients, CC/BCC, identity, mail templates). Replaced by SND-16, SND-07, SND-19. | — | — | MAIL-02 |
| SND-02 | Export bundle contents by format: table §4.10.2; document attachments with `includeInExport` (DOC-18) and standard attachments (F01 SET-088). Every file is an archived artifact or a frozen attachment with sha256; file names per §4.10.2 | MUST | P1 | ER-01, MAIL-02 |
| SND-03 | Allowed formats and channels per ER-03 decision and consent (App. D.3): shown as a hint in the export dialog and enforced in the mark-sent dialog. For `PDF_NEEDS_CONSENT` a PDF-only hand-over on an electronic channel (`email_manual`, `upload_portal`, `other`) without recorded consent is blocked (`pdf_consent_required`); paper via `post`/`hand` is always allowed; consent (date, source) can be recorded inline (MAIL-01) | MUST | P1 | MAIL-01, ER-03 |
| SND-04 | **Withdrawn (v1.1)** — B2: no SMTP, no `.eml` artifact, no Message-ID or SMTP response. Replaced by SND-22. | — | — | MAIL-02 |
| SND-05 | The first effective sent mark (SND-07) sets status `sent`, `sentAt` (instant of recording) and `sentOn` (entered date); later marks never change them (SND-18). „Exportieren“ serves the **archived original artifact bytes** (hash = archived hash) while the document is not marked as sent; once it is marked as sent, re-exports default to the "Kopie" variant (DOC-32) and „Original erneut exportieren“ needs a reason (`resend_original_reason`, audited) | MUST | P1 | UST-34, MAIL-02 |
| SND-06 | Exporting never changes status, `sentAt`, `sentOn` or the Zugang; only „Als versendet markieren“ does. The detail page distinguishes „Ansehen“ (on-screen preview, no audit) from „Exportieren“ (files leave the system, audited per SND-22). „Nur XML“ is an export option, not a channel | MUST | P1 | UST-34, MAIL-02 |
| SND-07 | „Als versendet markieren“ dialog: `sentOn` (default today; ≤ today and ≥ the Europe/Berlin date of finalisation, EC-195; more than `backdateWindowDays` (default 10) before the recording date → note mandatory), `channel` ∈ `email_manual` „E-Mail (selbst versendet)“ · `post` „Post“ · `hand` „Persönlich übergeben“ · `upload_portal` „Upload-Portal (z. B. ZRE, OZG-RE)“ · `other` „Sonstiges“ (note mandatory), optional `note`, and the handed-over files (checkbox list of the document's archived artifacts and frozen attachments, preselected from the latest unmarked export; ≥ 1 required; each stored as artifact ID + archived sha256). Writes one `sendLog` row (`purpose: "document"`, `kind: "mark_sent"`) | MUST | P1 | ER-03, MAIL-02, GOBD-06 |
| SND-08 | **Withdrawn (v1.1)** — B2: no bulk e-mail sending. Replaced by SND-20. | — | — | MAIL-02 |
| SND-09 | Postal sending via a letter service is out of scope in v1 (the export dialog shows „Per Post: bitte ausdrucken und anschließend als versendet markieren (Kanal Post)“) | MUST | P1 | — |
| SND-10 | Export and sent mark are impossible while `artifactStatus ≠ ready` (`artifacts_not_ready` / `artifacts_blocked`) | MUST | P1 | ER-12 |
| SND-11 | Quotes, orders, delivery notes, proforma, cancellations and corrections are exported and marked as sent with the same dialogs (no XML for non-invoice types; ER-03 rules only where ER-03 is evaluated, §4.1). Reminders use the same mechanism (F05) | MUST | P1 | MAIL-03 |
| SND-12 | **Withdrawn (v1.1)** — B2: no SMTP outcome handling (10 EC-097/EC-098 withdrawn). Replaced by —. | — | — | MAIL-02 |
| SND-13 | **Withdrawn (v1.1)** — B2: there are no recipients and no send tool, so no recipient restriction is needed. Replaced by SND-24. | — | — | SEC-02 |
| SND-14 | **Withdrawn (v1.1)** — B2/B7: no e-mail, and the portal and online payments are deferred (F10). Replaced by —. | — | — | — |
| SND-15 | Outbound webhooks (05 §5.3, where enabled): `*.sent` on the first effective sent mark, `*.sent_retracted` when a retraction returns the document to `finalized`, `invoice.artifacts_ready/blocked`. No event per export | MUST | P1 | — |
| SND-16 | Export menu „Exportieren ▾“ (detail page, list row, success step of the finalise dialog): „E-Rechnung (ZUGFeRD-PDF)“, „XRechnung (XML)“, „XRechnung + Lesefassung (PDF)“, „PDF“ (format `none` and non-invoice types), „Nur XML“, „Alles als ZIP“ (all files of §4.10.2 incl. attachments with `includeInExport` and a `SHA256SUMS.txt`). The default entry follows the format (§4.10.2); the ER-03 badge names the legally required files. Mobile: „Teilen“ via the Web Share API with files where supported, else download. Every entry serves archived bytes (SND-05) | MUST | P1 | ER-01, ER-03, UST-34 |
| SND-17 | E-invoice obligation at the mark (ER-03): for `MUST_E` the first effective mark requires (a) that the handed-over files include the structured e-invoice (ZUGFeRD PDF or XRechnung XML; a Lesefassung or plain PDF alone does not count, `pdf_not_allowed_must_e`) and (b) an electronic channel: `email_manual`, `upload_portal`, or `other` with the confirmation „elektronisch übermittelt“ (`must_e_electronic_confirmation_missing`). `post`/`hand` are blocked (`must_e_channel_not_electronic`, EC-197). Any electronic means the owner chooses is fine. Stored as `einvoiceHandedOverElectronically: true`. Later marks (SND-18) may use any channel | MUST | P1 | ER-03, ER-01, MAIL-01 |
| SND-18 | Repeated marks and retraction: a further mark appends another `mark_sent` row (warning `already_marked_sent`); status, `sentAt`, `sentOn` and Zugang stay from the first effective mark (= earliest non-retracted `mark_sent` row). „Versandmarkierung zurücknehmen“ appends a `retraction` row (`retractsId`, mandatory reason ≥ 10 characters, audited); no row is ever changed or deleted. Retracting a non-effective mark changes nothing else. Retracting the effective mark re-derives `sentOn`/Zugang from the next non-retracted mark, or — if none remains — returns status to `finalized` and unsets `sentAt`/`sentOn`/`zugang`. Retracting the effective mark is blocked (`retraction_blocked_dependent`) when a later act depends on it: a non-draft reminder or a dunning-run action references the invoice, a finalised reminder used that Zugang for interest or deadlines, or the status has moved past `sent` (quotes: accepted/rejected/expired/superseded/invoiced; delivery notes: received/invoiced) (EC-198) | MUST | P1 | GOBD-06, MAHN-01, MAIL-02 |
| SND-19 | „E-Mail-Text kopieren“ in the export dialog: subject and body from the text templates of kind `message_text` (subject + body with placeholders, per document type and language; F01 SET-080…087, 03) with placeholders resolved from the snapshot, plus the contact's invoice e-mail address(es), each with a copy button; optional `mailto:` link with subject/body only (no attachments). Nothing is sent or logged | SHOULD | P1 | — |
| SND-20 | Bulk: (a) „Sammel-Export“ (job `bulk_export`): ZIP with one folder per document holding the files of its default export (originals while unmarked, else the Kopie variant), `index.csv` and `SHA256SUMS.txt`; pre-check per document (artifacts ready); skipped documents listed with the reason; one `document.export` audit entry per document. (b) „Sammel-Markierung“: one `sentOn`, channel and optional note for the selection, each document validated individually (SND-03/07/17 with the files of its default export); failures skipped and listed (e.g. `MUST_E` with channel `post`); one `sendLog` row per document. Max 2,000 documents per job | MUST | P1 | MAIL-02, ER-03, GOBD-11 |
| SND-21 | To-do „Exportiert, aber nicht als versendet markiert: {number}“ when a document was exported for sending (an entry of the export menu or `bulk_export`; the archive ZIP `pdf_zip` and „Ansehen“ do not count) and has no effective mark 2 calendar days (Europe/Berlin) after the first such export; created by `deadlines.notify`; closed by the mark, a Storno or a withdrawal. List filter „exportiert, nicht markiert“. Such an invoice has no Zugang (SND-23, EC-196) | MUST | P1 | MAHN-01, MAIL-02 |
| SND-22 | Dispatch record: every export writes the audit entry `document.export` (artifact IDs + sha256 + variant, reason for an original re-export, actor, channel ui/api/mcp); every mark and retraction writes an append-only `sendLog` row per 03 (`purpose`, `kind`, `retractsId?`, `sentOn`, `channel`, `note?`, `artifacts[{artifactId, sha256}]`, `einvoiceHandedOverElectronically?`, `at`, `actor`) plus the audit entry `document.mark_sent` / `document.mark_sent_retracted`. The sha256 values are copied from the archived artifacts, never taken from client input (`mark_sent_artifact_unknown`) | MUST | P1 | MAIL-02, GOBD-06, SEC-02 |
| SND-23 | Zugang (receipt) is derived from the first effective mark and stored in `salesDocuments.zugang` (F05 PAY-052): `email_manual`, `upload_portal`, `hand` → `sentOn`; `post` → `sentOn` + N days (setting, default 3); `other` → `sentOn` + 3 days. A document never marked as sent has no Zugang: no automatic Verzug under § 286 Abs. 3 BGB, no dunning, no interest (F05, EC-196) | MUST | P1 | MAHN-01, MAIL-02 |
| SND-24 | API and MCP: export returns short-lived links (5 min, reachable only inside the tailnet) to the calling key's owner, never to a third party; no tool or endpoint transmits a document to anyone (EC-189). Marking as sent needs scope `invoices:send` (now: export / mark as sent, 05 §2); via MCP `document_mark_sent` is a ⚠ tool with `destructiveHint`, `requiresUserInteraction` and a `confirm_token` from `preview_action` (06 §2). Retraction is UI/REST only | MUST | P1 | SEC-02 |

## 4. Workflows and state machines

### 4.1 Document type catalogue

| `type` | Label DE / EN (PDF title) | Default range (F01) | XML / TypeCode (BT-3) | Journal | Retention | ER-03 evaluated | REST resource · ID |
|---|---|---|---|---|---|---|---|
| `quote` | Angebot / Quotation | `AN-{YYYY}-{####}` | none | no | `letters6` | no (`NOT_REQUIRED`) | `/quotes` · `quo_` |
| `order_confirmation` | Auftragsbestätigung / Order confirmation | `AB-…` | none | no | `letters6` | no | `/order-confirmations` · `ord_` |
| `delivery_note` | Lieferschein / Delivery note | `LS-…` | none | no | `letters6` | no | `/delivery-notes` · `dln_` |
| `proforma` | Proforma-Rechnung / Pro forma invoice | `PF-…` | none | no | `letters6` | no | `/invoices?invoice_type=proforma` · `inv_` |
| `invoice` | Rechnung / Invoice | `RE-…` | 380 | yes | `vouchers8` | yes | `/invoices` (`standard`) · `inv_` |
| `advance_invoice` | {n}. Abschlagsrechnung / Advance invoice no. {n} | `RE-…` | 326 (875 if "Bauleistung") | yes (Mindest-Ist) | `vouchers8` | yes | `/invoices` (`advance`) |
| `partial_invoice` | {n}. Teilrechnung / Partial invoice no. {n} | `RE-…` | 326 (875) | yes (Mindest-Ist) | `vouchers8` | yes | `/invoices` (`partial`) |
| `final_invoice` | Schlussrechnung / Final invoice | `RE-…` | 380 (877 if "Bauleistung") | yes | `vouchers8` | yes | `/invoices` (`final`) |
| `cancellation` | Stornorechnung / Cancellation invoice | `RE-…` | 381 | yes (reversal) | `vouchers8` | inherits (App. D) | `/invoices` (`cancellation`) |
| `correction` · `credit` | Rechnungskorrektur / Invoice correction (credit note) | `RK-…` | 381 | yes | `vouchers8` | inherits | `/corrections` · `cor_` |
| `correction` · `rectification` | Rechnungsberichtigung / Corrected invoice | `RK-…` | 384 | no | `vouchers8` | inherits | `/corrections` · `cor_` |
| `self_billing` (P3) | Gutschrift / Self-billing invoice (Gutschrift) | `GS-…` | 389 | yes (purchase) | `vouchers8` | yes (roles swapped) | `/self-billing` · `sbc_` (proposed, open question 9.6) |

Notes:
- `retentionClass` for delivery notes: `letters6` is conservative; since BEG IV delivery notes that are not Buchungsbelege may be discarded once the invoice exists. We keep 6 years (no purge logic difference needed).
- The "Bauleistung" switch (document flag `constructionWork`) selects 875/877 for VOB chains; see open question 9.1 (BR-DE-17).

### 4.2 State machines

Transitions not listed are illegal (`illegal_transition`). "Sys" = system actor. Every transition writes an audit entry.

#### 4.2.1 Quote

| From | Event | To | Guard | Side effects |
|---|---|---|---|---|
| — | create / convert / duplicate | `draft` | | |
| `draft` | delete | (removed) | | audit with full content |
| `draft` | finalize | `finalized` | §5.1 quote rules; `validUntil` ≥ document date | number, snapshot, PDF |
| `finalized` | mark_sent (first effective mark) | `sent` | artifacts ready; SND-07 | `sendLog` row, `sentAt`, `sentOn` |
| `sent` | retract_mark (effective mark, no other mark left) | `finalized` | SND-18 (no dependent act) | `sendLog` retraction row |
| `finalized`, `sent` | accept | `accepted` | | `acceptance{at, byName, channel, note, snapshotHash}` |
| `expired` | accept (late) | `accepted` | confirm "Angebot ist abgelaufen – trotzdem annehmen?" | as above |
| `finalized`, `sent`, `expired` | reject | `rejected` | | reason stored |
| `rejected` | reopen | `sent` | reason | |
| `finalized`, `sent` | expire (Sys, `validUntil` < today) | `expired` | | notification |
| `finalized`, `sent`, `rejected`, `expired` | finalize of the revision draft | `superseded` | revision finalised | |
| `finalized`, `sent`, `accepted` | withdraw | `cancelled` | no finalised derived invoice | reason |
| `accepted` | derived invoice-type document finalised, coverage < 100 % | `partially_invoiced` | | |
| `accepted`, `partially_invoiced` | coverage = 100 % | `invoiced` | | |
| `partially_invoiced`, `invoiced` | derived invoice cancelled/credited | recomputed | | |

Converting a `finalized`/`sent`/`expired` quote to an order or invoice first performs `accept` (dialog "Angebot als angenommen markieren?", default yes; API: `accept_source: true`).

#### 4.2.2 Order confirmation

`draft → finalized → sent → partially_invoiced → invoiced` (`→ sent` only by mark_sent; `sent → finalized` by retract_mark, SND-18); `finalized|sent → cancelled` (withdraw, reason, no finalised derived invoice). Recompute as for quotes.

#### 4.2.3 Delivery note

| From | Event | To | Guard |
|---|---|---|---|
| `draft` | finalize | `finalized` | delivery date set, delivery address set |
| `finalized` | mark_sent | `sent` | artifacts ready |
| `sent` | retract_mark | `finalized` | SND-18 |
| `finalized`, `sent` | mark_received (date, name) | `accepted` (UI "Erhalten") | |
| `finalized`, `sent`, `accepted` | invoice containing it finalised | `invoiced` | |
| `invoiced` | that invoice cancelled | previous status | |
| `finalized`, `sent`, `accepted` | withdraw | `cancelled` | not invoiced |

#### 4.2.4 Proforma

`draft → finalized → sent → invoiced` (when an invoice converted from it is finalised); `finalized|sent → cancelled`.

#### 4.2.5 Invoice family (`invoice`, `advance_invoice`, `partial_invoice`, `final_invoice`)

| From | Event | To | Guard | Side effects |
|---|---|---|---|---|
| `draft` | finalize | `finalized` | §5.1 | `paymentStatus = open` (or `paid` if payable = 0), `openAmountCents = payable`, journal, chain progress |
| `finalized` | mark_sent (first effective mark; export alone never transitions) | `sent` | artifacts ready; SND-07, SND-17 | `sendLog` row, `sentAt`, `sentOn`, `zugang` (SND-23); closes the to-dos of REC-16/SND-21 |
| `sent` | retract_mark (effective mark, no other mark left) | `finalized` | SND-18: no reminder/dunning action depends on it | `sendLog` retraction row; `sentAt`, `sentOn`, `zugang` unset |
| `finalized`, `sent` | cancel | `cancelled` | INV-10 guards | creates a finalised `cancellation`; register `cancelled_by_storno`; dunning case closed (EC-077) |

`paymentStatus` (independent axis, changed by F05 payments and by corrections/offsets):

| From | Event | To |
|---|---|---|
| `open` | partial allocation | `partially_paid` |
| `open`, `partially_paid` | allocations + credits ≥ payable | `paid` |
| `paid`, `partially_paid` | payment reversed (EC-129) | `open` / `partially_paid` |
| `open`, `partially_paid` | write-off (F05, §17) | `written_off` |
| `open`, `partially_paid` | Rechnungskorrektur/offset brings open to 0 without cash allocation | `credited` (03 §4) |

A finalised `correction` (credit) reduces `openAmountCents` of the original by min(credit, open); the excess becomes the correction's own negative open amount.

#### 4.2.6 Cancellation (Storno)

Created directly as `finalized` (the user confirms a preview first). `finalized → sent` by mark_sent (optional; recommended whenever the original was marked as sent **or exported**, EC-DOC-116; SND-17 applies if the Storno is `MUST_E`). No further transitions: a Storno cannot be cancelled, corrected or duplicated. `paymentStatus` unset; `openAmountCents = 0`; the original's `openAmountCents = 0`.

#### 4.2.7 Correction

| From | Event | To | Guard |
|---|---|---|---|
| `draft` | finalize | `finalized` | §5.1 correction rules |
| `finalized` | mark_sent | `sent` | artifacts ready; SND-17 if the correction is `MUST_E` |
| `sent` | retract_mark | `finalized` | SND-18 |
| `finalized`, `sent` | cancel | `cancelled` | no refund/offset allocated (creates a mirror `cancellation` referencing the correction) |

`credit`: `paymentStatus` `open` while a refund is owed (negative `openAmountCents`), `paid` when refunded/offset, unset if it was fully absorbed by the original's open amount. `rectification`: no `paymentStatus`.

#### 4.2.8 Self-billing (P3)

`draft → finalized → sent`; `finalized|sent → cancelled` via objection (Widerspruch: date, text; creates a mirror `cancellation` with TypeCode 381 and marks the agreement check for review).

#### 4.2.9 Display status (`display_status`, pure function)

| Condition (first match) | DE label | Token |
|---|---|---|
| `status = draft` | Entwurf | `draft` |
| type `cancellation` | Storno | `cancellation` |
| `status = cancelled` | Storniert | `cancelled` |
| `artifactStatus = blocked` | Gesperrt (E-Rechnung) | `blocked` |
| quotes: `accepted`/`rejected`/`expired`/`superseded`/`partially_invoiced`/`invoiced` | Angenommen / Abgelehnt / Abgelaufen / Ersetzt / Teilberechnet / Berechnet | same |
| `paymentStatus = paid` | Bezahlt (correction: Erstattet) | `paid` |
| `paymentStatus = written_off` | Abgeschrieben | `written_off` |
| `openAmountCents < 0` | Erstattung offen | `refund_open` |
| `paymentStatus ∈ {open, partially_paid}` and `dueDate < today` (Europe/Berlin) | Überfällig (+ Teilbezahlt) | `overdue` |
| `paymentStatus = partially_paid` | Teilbezahlt | `partially_paid` |
| `status = sent` | Offen | `open` |
| `status = finalized` | Nicht versendet (UI adds the badge „exportiert“ when an export exists, SND-21) | `unsent` |

#### 4.2.10 Recurring template

`active ⇄ paused` (UI "Pausiert", stored `inactive`); `active → ended` (derived: `endDate` passed or `generatedCount = maxCount`); `ended → active` only by raising `endDate`/`maxCount`.

### 4.3 Conversions

#### 4.3.1 Matrix (source must be finalised unless noted)

| Source ↓ / Target → | quote | order_conf. | delivery_note | proforma | invoice | advance | partial | final |
|---|---|---|---|---|---|---|---|---|
| quote | revision (QUO-06) | ✓ | ✓ | ✓ | ✓ (full or quantities) | ✓ | ✓ | ✓ if the chain has ≥ 1 advance/partial |
| order_confirmation | — | — | ✓ (remaining qty) | ✓ | ✓ (full or quantities) | ✓ | ✓ | ✓ (as above) |
| delivery_note | — | — | — | — | ✓ (one or many → QUO-11) | — | — | — |
| proforma | — | — | — | — | ✓ | — | — | — |
| invoice | — | — | ✓ | — | — | — | — | — |
| advance / partial | — | — | — | — | — | — | — | via the chain root (order/quote) |
| recurring template | — | — | — | — | ✓ (generation) | — | — | — |

Storno and corrections are not conversions; they use `/cancel` and `/correct`. Drafts cannot be converted (`source_not_finalized`), except that "Duplizieren" works on drafts.

#### 4.3.2 Copy rules

| Field | Copied? | Notes |
|---|---|---|
| contact, billing address, delivery address | yes | live references; frozen at the target's finalisation |
| lines (item/heading/text/subtotal) | yes | optional lines only if selected; `optional` flag removed; quantities per the dialog |
| unit prices, discounts, document discount/surcharge | yes | |
| `vatRateKey`, category | key yes, **rate re-resolved** by the target supply date (EC-040) | notice on change |
| tax case | re-derived from current contact flags (EC-080); if different from the source: notice "Steuerfall geändert: {alt} → {neu} (Kundendaten geändert)" | |
| price mode, currency, language, layout, payment terms, payment method, bank account | yes | FX rate is **not** copied (set at finalisation) |
| order/buyer/contract reference, project, cost centres, tags, custom fields, internal note | yes | |
| subject, head/foot text | target type's default templates; source texts only if they were not template defaults | |
| attachments | optional checkbox (default on for quote → order) | |
| supply date | delivery note → invoice: delivery date(s); order → invoice: copied if set; else empty | |
| number, document date, status, acceptance, payments, artifacts | never | |

#### 4.3.3 Invoicing progress

For each quote/order line the system tracks `invoicedQtyMilli` (from quantity-based invoices and collective invoices of its delivery notes) and the order's `prepaidNetByGroup` (advances/partials). Coverage is 100 % when (a) a non-cancelled final invoice exists, or (b) a non-cancelled full `invoice` was converted from it, or (c) every item line's `invoicedQtyMilli` ≥ its quantity. Otherwise any non-cancelled finalised invoice-family document → `partially_invoiced`. Progress propagates to the chain ancestors (order → quote). Recomputed in the same transaction as the finalisation, cancellation or correction of a derived invoice (QUO-13). Delivery notes track `deliveredQtyMilli` per order line the same way (QUO-10).

### 4.4 Editor behaviour

1. **Contact.** Choosing a contact sets language, currency, price mode (consumer → gross), payment terms, default discount, e-invoice preference, buyer reference and the derived tax case. The VAT-ID badge shows "✓ geprüft am {date} (qualifiziert)" / "⚠ nicht geprüft" / "✗ ungültig". Changing the contact on a draft re-runs everything and lists the changes in a toast.
2. **Lines.** "+ Position" (free text item), "+ Produkt" (search by number/name), "+ Überschrift", "+ Text", "+ Zwischensumme", "+ Optional" (quotes), "+ Lieferscheine übernehmen" (invoice from a contact with uninvoiced delivery notes), "+ Zeiten übernehmen" (P4), "+ Gesamtrabatt/Aufschlag". Drag to reorder; `position` is renumbered on save. Line fields: name (≤ 250 chars), description (rich text ≤ 5,000 chars), quantity (3 decimals, ≠ 0; negative item lines are allowed on invoices with warning `negative_line` as long as the document gross stays ≥ 0), unit, unit price (4 decimals; net or gross per mode), discount, category/rate (dropdown restricted per App. C.3), line period (optional), labour flag, cost centre, revenue account override.
3. **Header.** Type (for invoice drafts: Rechnung/Abschlag/Teil/Schluss/Proforma — switching type re-validates), supply date kind, subject, order reference (BT-13), buyer reference/Leitweg-ID (public customers: mandatory field with live checksum), contract reference, delivery address, property flag, Kleinbetrag flag, construction flag.
4. **Taxes & payment.** Tax case (derived, with "Warum?" explanation text from App. C, override with reason), payment terms, Skonto, payment method, bank account, EPC QR toggle (default per layout), e-invoice format (default per §4.6.3 with the ER-03 badge), currency + FX rate (shown with source once known).
5. **Totals card** (sticky): net per group, VAT per group ("zzgl. 19 % USt auf 1.000,00 €"), gross, EUR VAT (foreign currency), deductions (final invoice), payable, labour subtotal (B2C).
6. **Compliance panel** (§5.1): grouped "Pflichtangaben", "Steuern", "E-Rechnung", "Hinweise".
7. **Preview pane**: HTML render of the PDF layout with the watermark "ENTWURF – keine gültige Rechnung"; "PDF-Vorschau" renders the real PDF (`preview-pdf`).
8. **Save**: autosave every 2 s after the last change (debounced) with `version` check; conflicts (MCP edited meanwhile) show a merge dialog "Dieser Entwurf wurde von Claude (MCP) geändert – neu laden / meine Änderungen behalten".

### 4.5 Tax case derivation

Implemented by `deriveTaxCase(input) → { taxCase, categoriesAllowed, defaultCategoryPerLine, reasons[] }` (App. C). The editor shows `reasons` as the "Warum?" text (e.g. "Kunde in Österreich mit geprüfter USt-IdNr ATU12345678, Dienstleistung → Steuerschuldnerschaft des Leistungsempfängers"). The override stores the derived value and the chosen one in the audit diff.

### 4.6 Finalisation pipeline

#### 4.6.1 Steps (02 §6, made concrete)

| Step | What | Failure → |
|---|---|---|
| 0 | Gate checks: setup complete (F01 SET-005), no unacknowledged RI ERROR (DOC-60), clock skew ≤ 60 s (DOC-59), idempotency (§4.6.4) | 409 `setup_incomplete` / 409 `integrity_alert_open` / 503 `clock_skew` |
| 1a | Load draft at version v; resolve FX rate, document date (Berlin today or chosen), due date; run `validateDocument(draft, context)` | 422 `validation_failed` with all errors |
| 1b | Build preview snapshot with number `PREVIEW-0000` (no XML business rule depends on the number value) | — |
| 1c | Render XML (if format ≠ `none`) → KoSIT (XRechnung, plain EN 16931) and/or Mustang XML check (ZUGFeRD); errors abort | 422 `einvoice_validation_failed` (report summary), 503 `dependency_unavailable` (EC-007) |
| 2a | Commit transaction: version still v (else 409 `version_conflict`); re-run validators against current company/contact data (EC-004) | 409 `revalidation_failed` with the new errors |
| 2b | KU-01 cumulative check for KU companies | 409 `ku_threshold_crossed` (dialog, SET-035) |
| 2c | Number from range/period (F01 §4.3); collision → abort | 409 `number_conflict` |
| 2d | Freeze snapshot + hash, set status/document date/due date/`einvoice.decision`, `artifactStatus = pending`, `retentionUntil`, chain progress, journal hook, audit entry, outbox webhook `*.finalized` | transaction aborts, nothing persisted |
| 3 | Scheduled action `renderArtifacts`: PDF/A-3b, final XML, embed (ZUGFeRD) or separate XML, validate KoSIT + Mustang/veraPDF, store with sha256 → `ready` | retry 5× (10 s, 1 min, 5 min, 30 min, 2 h) → `blocked` + alert (EC-005/006) |

#### 4.6.2 Differences per type

| Type | Step 1c | 2b | Journal (2d) | Artifacts |
|---|---|---|---|---|
| quote, order, delivery note, proforma | skipped | skipped | none | PDF/A-3b |
| invoice family, self-billing | per format | yes (KU) | revenue/receivable (advance: Mindest-Ist logic in F08) | PDF/A-3b (+ZUGFeRD) and/or XRechnung XML, reports |
| cancellation | per format of the original | skipped (KU status of the original applies) | reversal | as original format |
| correction | per format (MUST_E if the original had XML) | skipped | credit: reversal of the delta; rectification: none | as above |

#### 4.6.3 E-invoice format selection

`selectFormat(contact.einvoice.preferredFormat, decision, type, isPublicAuthority, isKU)`:

| Situation | Default `einvoice.format` | Allowed alternatives |
|---|---|---|
| non-invoice types | `none` | — |
| B2G (public authority) | `xrechnung_ubl` | `xrechnung_cii`, `zugferd_xrechnung` |
| preference `xrechnung_cii` / `xrechnung_ubl` | as preferred | all E formats |
| preference `zugferd` or `auto` | `zugferd_en16931` | all E formats; `none` only if decision ≠ `MUST_E` |
| preference `pdf` | `none` if decision ≠ `MUST_E`, else `zugferd_en16931` with notice "E-Rechnung ist Pflicht – PDF-Wunsch des Kunden kann nicht erfüllt werden" (EC-090) | |
| KU company, no preference | `none` (E-Rechnung not required, KU VATEX open, open question 9.2) | `zugferd_en16931` |
| cancellation / correction | the original's format family (XML if the original had XML) | — |

#### 4.6.4 Idempotency and concurrency

- Finalise is idempotent per (document ID, version): a repeated call on a document already finalised from version v returns 200 with the same number and `idempotent_replay: true`, whatever the `Idempotency-Key` (EC-002). A call with an older version on a finalised document returns 409 `document_not_draft`.
- The REST `Idempotency-Key` additionally replays the exact earlier response (05 §3).
- MCP: `confirm_token` bound to (document ID, version, preview hash), 10 min; an outdated token → `preview_outdated` (EC-003).
- 1,000 parallel finalisations of different drafts on one counter yield 1,000 unique consecutive numbers (EC-001, Convex OCC retries).

#### 4.6.5 Blocked artifacts

`blocked` means: the document is finalised and numbered, but no valid artifact exists. Export and the sent mark are disabled (SND-10); the detail page shows the validator report and two actions: "Erneut erzeugen" (after a sidecar/config fix; re-renders from the unchanged snapshot) and "Stornieren und neu erstellen" (Storno + duplicate). The Storno of a blocked invoice is rendered in the same format; if that also fails it falls back to format `none` with the audit note "E-Rechnung nicht erzeugbar" (the original could never be exported, so no E-Rechnung obligation was fulfilled or violated towards the customer).

### 4.7 Advance, partial and final invoices

```
Quote/AB (accepted, net 10.000,00 €)
  ├─ "Abschlag erstellen" ─▶ advance_invoice draft (30 % → 3.000,00 net per group)  ─▶ finalize ─▶ paid (F05)
  ├─ "Teilrechnung erstellen" ─▶ partial_invoice draft (net/gross/percent)          ─▶ finalize ─▶ paid
  └─ "Schlussrechnung erstellen" ─▶ wizard
        1. lists all advances/partials of the chain with invoiced, received, open
        2. per open advance (mandatory, same step): unpaid → Storno; partially paid → Rechnungskorrektur down to the received amount, INV-07
        3. final_invoice draft: all order lines (editable, + extra lines), supply date = completion
        4. deduction table computed from received amounts per (category, rate) (App. E.4)
        5. finalize → advances flagged deductedIn = final; order → invoiced
```
- Amount dialog for advances/partials: mode `percent` (bp of the order net per group), `net` (amount allocated over groups pro rata to the order net), `gross` (allocated pro rata to the order gross, then converted per group, App. E.3/E.5). It shows the already prepaid share and the remaining share; exceeding 100 % per group is blocked (EC-078).
- Advance supply date: label "Voraussichtlicher Leistungszeitpunkt/-zeitraum"; rate key resolution date for advances = the advance's document date (warning `advance_rate_differs` if the expected supply date resolves to a different rate; the final invoice corrects it).
- A final invoice may be created without prior advances only via "Rechnung" (a final invoice without deductions is rejected: `final_without_advances`).

### 4.8 Storno, Rechnungskorrektur, Rechnungsberichtigung

"Korrigieren…" on an invoice opens the **Korrektur-Assistent**:

| Question | Answer → path |
|---|---|
| Stimmen die Beträge, aber Angaben sind falsch/fehlen (Anschrift, USt-IdNr, Leistungsdatum, Steuernummer)? | **Rechnungsberichtigung** (INV-13). Recommended for formal defects (UST-31: retroactive effect) |
| Soll die Rechnung vollständig aufgehoben werden und ist sie unbezahlt? | **Storno** (INV-10), optionally "danach neue Rechnung als Kopie anlegen" |
| Ist sie (teil)bezahlt und soll der Betrag gemindert werden (Minderleistung, Rückgabe, Preisnachlass mit Leistungsänderung)? | **Rechnungskorrektur** (INV-12) + refund or offset (F05) |
| Ist sie (teil)bezahlt, aber die Zahlung wurde falsch zugeordnet? | "Zahlungszuordnung lösen" (F05), then Storno |
| Falscher Steuersatz / falscher Steuerfall, unbezahlt? | Storno + new invoice |
| Falscher Steuersatz, bezahlt? | Rechnungskorrektur über den vollen Betrag + neue Rechnung + Verrechnung of the credit with the new invoice (F05 offset) |
| Nur Skonto/Preisnachlass ohne Leistungsänderung? | No document: payment difference with VAT correction (UST-32, F05) |

Storno details: one click → preview dialog (mirror totals, number preview, ER-03/format inherited, text "Die Rechnung {nr} vom {datum} wird hiermit vollständig storniert.", optional reason printed) → confirm → create + finalise atomically (one pipeline run; validation errors → nothing created). If the original was never marked as sent and never exported, the dialog notes "Die Rechnung wurde nicht versendet; die Stornorechnung muss nicht versendet werden." If it was exported but not marked as sent, it notes "Die Rechnung wurde exportiert, aber nicht als versendet markiert. Falls sie dem Kunden vorliegt, bitte auch die Stornorechnung versenden." (EC-DOC-116).

### 4.9 Self-billing (P3)

1. Supplier contact → "Gutschriftsvereinbarung" (agreed on, scope text, valid from/to, document upload) is required (`self_billing_agreement_missing`).
2. Draft with our company as buyer and the supplier as seller (seller block from the supplier contact incl. their tax number/VAT ID; KU suppliers produce a KU Gutschrift with their §19 note).
3. Finalise: own range `GS-`, TypeCode 389, title "Gutschrift", note "Gutschrift (Abrechnung durch den Leistungsempfänger, § 14 Abs. 2 Satz 2 UStG)"; ER-03 with roles swapped (supplier = issuer for the 800k test: unknown → `MUST_E`).
4. Creates a linked purchase voucher (F06) for input VAT and the payable.
5. Objection: "Widerspruch erfasst" (date, text) → mirror cancellation; the voucher is reversed.

### 4.10 Export and sent mark

#### 4.10.1 Flow

```
detail page "Exportieren ▾" ─▶ export dialog: ER-03 badge + required files, format entries, „E-Mail-Text kopieren“ (SND-19)
   ─▶ pre-check: artifactStatus = ready (SND-10); copy rule: unmarked → original, marked → "Kopie" (or original with reason)
   ─▶ serve archived bytes (download / ZIP / Web Share) ─▶ audit document.export {artifactIds, sha256, variant, reason?}
   ─▶ owner sends the files outside the app (own mail client, upload portal, print + post, hand-over)
"Als versendet markieren" ─▶ mark dialog: sentOn, channel, note, handed-over files (preselected from the last unmarked export)
   ─▶ validate (§5.1.8: dates EC-195, MUST_E EC-197, consent MAIL-01, artifacts archived)
   ─▶ append sendLog{purpose: document, kind: mark_sent, sentOn, channel, note, artifacts[artifactId, sha256], einvoiceHandedOverElectronically}
   ─▶ first effective mark: status sent, sentAt, sentOn, zugang (SND-23) ─▶ close to-dos ─▶ outbound webhook *.sent
   ─▶ later marks: append only (SND-18); retraction: append kind retraction (+ status rollback only if nothing depends on it)
no mark 2 days after the first export ─▶ to-do „Exportiert, aber nicht als versendet markiert“ (SND-21); no Zugang, no dunning
```

#### 4.10.2 Export bundle by format

| `einvoice.format` | Default export | Optional | Counts as structured e-invoice (SND-17) |
|---|---|---|---|
| `zugferd_en16931` / `zugferd_xrechnung` | hybrid PDF (`{number}.pdf`) | separate XML (`{number}.xml`, identical to the embedded one) | hybrid PDF ✓, XML ✓ |
| `xrechnung_cii` / `xrechnung_ubl` | XML (`{number}.xml`) | PDF "Lesefassung" (`{number}_Lesefassung.pdf`, stamped "Lesefassung – maßgeblich ist die XRechnung") | XML ✓, Lesefassung ✗ |
| `none` | PDF/A-3b (`{number}.pdf`) | — | ✗ |
| any | document attachments with `includeInExport` (DOC-18), standard attachments (F01 SET-088) | | ✗ |

File names use the number with `/` replaced by `-`; „Alles als ZIP“ is named `{number}.zip` and contains `SHA256SUMS.txt`. The PDF Lesefassung is rendered from the same snapshot and archived as artifact kind `pdf` with `variant: "reading"`; Kopie exports are archived as `variant: "copy"` on first generation (DOC-32), so every exported file has an archived hash.

### 4.11 Recurring invoices

```
daily 06:00 recurring.generate
 for each template with status active and nextDate ≤ today (Berlin):
   due = occurrences in [nextDate, today]
   if |due| > catchUpAutoMax: create drafts for all (no automation), notify, advance schedule
   else for each occurrence (oldest first):
      key = (templateId, occurrenceDate) — skip if a document with this key exists
      period = in_advance ? [occ, next(occ) − 1d] : [prev(occ), occ − 1d]
      draft = template.draft + supplyDate=period + recurringOccurrence=key, head text period line
      if period crosses a rate/KU boundary: split lines, keep draft, notify (REC-15)
      else if automation.finalize: finalize as system:cron.recurring.generate (document date = today)
           on failure: keep draft, notify with the error list
      if finalized: to-do „Exportieren und versenden“ (REC-16); never exported or sent automatically
      else: to-do „Entwurf prüfen und fertigstellen“
   nextDate = next occurrence after the last processed; generatedCount += n; end check
```
- Anchor rule: `next(d)` for monthly-based intervals = same day-of-month as `firstDate`, clamped to the month's last day (31.01. → 28.02. → 31.03.).
- `prev(occ)` for the first in-arrears occurrence = `occ − interval` (anchor-aware).
- Generated invoices show "Erzeugt aus Vorlage {name} (Periode {from}–{to})" in the chain view.

**P1 implementation (2026-10-16, decisions where this section was silent):** one Convex transaction per template run plans the due occurrences, checks `by_recurringOccurrence`, creates the drafts with their to-do „Entwurf prüfen und fertigstellen“ and advances `nextDate`/`generatedCount`; the calling action then finalises the automated drafts through the same pipeline as „Fertigstellen“ (`convex/lib/finalizePipeline.ts`), so a crash between the two leaves a correct draft + to-do and a doubled run is a no-op (REC-05). Every finalised recurring invoice — automatic or finalised by the owner from the review draft — gets „Exportieren und versenden“. Further rules: (1) once an invoice was generated or a period skipped, `firstDate`, `interval` and `billing` are fixed (changing the anchor would shift or overlap billed periods; a new template changes the rhythm); (2) a template whose customer is archived or missing generates nothing, notifies the owner (`recurring_blocked`) and does not advance — the missed periods are caught up under REC-06 once fixed; (3) REC-10 „überspringen“ skips the occurrences **before** today, an occurrence on today stays due; (4) REC-12 „Jetzt erzeugen“ finalises (with effective automation) as the calling member/key when it may finalise (`invoices.finalize` role or `invoices:finalize` scope), otherwise it leaves a draft; (5) REC-14 via REST/MCP: `automation.finalize = true` needs `invoices:finalize` on the calling key and stays inactive until confirmed in the app (`automationConfirmedAt`); (6) the list column „Betrag“ is a cached preview of the next occurrence, refreshed on save and on every run.

### 4.12 Duplicate, bulk download, bulk export, register

- Duplicate: §DOC-35; the new draft opens in the editor with the toast "Kopie von {nr} – Daten wurden aktualisiert: {changes}".
- Bulk ZIP (job `pdf_zip`): options "Archivoriginale (unverändert, mit SHA256SUMS.txt)" (default) or "Kopien mit Stempel"; include XML; file names `{number}.pdf`/`.xml`; a `index.csv` (number, type, date, contact, net, VAT, gross, currency, status, sha256). Max 2,000 documents per job.
- Bulk export for sending (job `bulk_export`, SND-20) is separate from the archive ZIP: it applies the copy rule per document and writes one `document.export` audit entry per document; the archive ZIP (`pdf_zip`) is for archiving/hand-over to the Finanzamt and also audits `document.export` but never counts as an export for sending (no SND-21 to-do).
- Register: the document detail shows its register row (number, range, assignedAt, status); the full register and gap report live in F01 (SET-063).

## 5. Validation rules and edge cases

Validators live in `src/domain/documents/validate/*.ts` and return `{ code, severity, field, rule, message, params }`. **E** = blocking at finalisation (drafts can always be saved), **W** = warning (shown, never blocks), **I** = info. Codes are the API `errors[].code` values (05 §3.1). Messages are the exact German UI texts; `{…}` are parameters. Every code has a unit test named with its code and rule ID.

### 5.1 Error and warning catalogue

#### 5.1.1 Parties and mandatory items

| Code | Sev | Applies to | Condition | Message (de) | Rule |
|---|---|---|---|---|---|
| `contact_missing` | E | all | no contact | Kein Kunde ausgewählt. | UST-03 |
| `buyer_name_missing` | E | all | snapshot buyer name empty | Name des Kunden fehlt. | UST-03 |
| `buyer_address_incomplete` | E | all except Kleinbetrag | street/PO box, postal code, city or country missing | Anschrift des Kunden unvollständig: {fields} fehlt. | UST-03 |
| `seller_address_incomplete` | E | all | company address incomplete | Firmenanschrift unvollständig → Einstellungen › Unternehmen. | UST-03 |
| `seller_tax_id_missing` | E | invoice types | neither tax number nor VAT ID | Steuernummer oder USt-IdNr. des Unternehmens fehlt → Einstellungen › Steuern. | UST-04 |
| `seller_vat_id_required` | E | K/AE (EU) lines | company VAT ID missing | Für innergemeinschaftliche Umsätze ist die eigene USt-IdNr. Pflicht (§ 14a UStG) → Einstellungen › Steuern. | UST-20, UST-21 |
| `geschaeftsbrief_incomplete` | E | all | F01 §5.2 block items missing | Pflichtangabe für Geschäftsbriefe fehlt: {item} (Rechtsform {legalForm}) → Einstellungen › Unternehmen. | MAIL-03 |
| `setup_incomplete` | E | all | setup wizard not completed | Die Einrichtung ist noch nicht abgeschlossen → Einrichtung fortsetzen. | MAIL-03 |
| `kleinbetrag_not_allowed` | E | Kleinbetrag flag | gross > 250,00 € (EUR) or K/AE/§3c line | Kleinbetragsrechnung nur bis 250,00 € brutto und nicht für innergemeinschaftliche Lieferungen, Fernverkäufe oder § 13b UStG. | UST-14 |

#### 5.1.2 Dates

| Code | Sev | Applies to | Condition | Message (de) | Rule |
|---|---|---|---|---|---|
| `supply_date_missing` | E | invoice types, delivery notes | no supply date | Leistungsdatum oder Leistungszeitraum fehlt. | UST-08 |
| `supply_period_invalid` | E | all | period end < start, or line period outside document period | Leistungszeitraum ungültig: Ende liegt vor Beginn. | UST-08 |
| `supply_date_in_future` | E | invoice, final_invoice, correction | supply start > document date | Das Leistungsdatum ({date}) liegt nach dem Rechnungsdatum. Für Vorauszahlungen bitte eine Abschlagsrechnung erstellen. | UST-08, UST-40 |
| `supply_period_ends_after_date` | I | invoice | period end > document date, start ≤ document date | Der Leistungszeitraum endet nach dem Rechnungsdatum (Vorausberechnung). Die Umsatzsteuer entsteht ggf. bereits mit Zahlungseingang. | UST-40 |
| `supply_period_crosses_rate_change` | E | all priced types | a line's effective period contains a rate change of its rate key | Position {n}: Der Leistungszeitraum überschreitet die Steuersatzänderung am {date}. Bitte die Position in Teilzeiträume aufteilen. | UST-15 |
| `supply_period_crosses_ku_change` | E | invoice types | period contains a KU status change | Leistungszeitraum überschreitet den Wechsel der Kleinunternehmerregelung am {date} — bitte Rechnung aufteilen. | KU-01, UST-08 |
| `supply_older_than_6_months` | W | invoice types | supply end < document date − 6 months | Die Leistung liegt mehr als 6 Monate zurück. Die Frist zur Rechnungsstellung (§ 14 Abs. 2 UStG) ist überschritten – bitte trotzdem jetzt ausstellen. | UST-01 |
| `document_date_future` | E | all | document date > today (Berlin) | Das Dokumentdatum darf nicht in der Zukunft liegen. | UST-05 |
| `backdate_reason_required` | E | all | today − date > backdate window and no reason | Rückdatierung um {days} Tage: bitte eine Begründung angeben (wird protokolliert). | UST-05 |
| `backdate_over_6_months` | W | all | today − date > 6 months | Das Datum liegt mehr als 6 Monate zurück. Bitte prüfen, ob das wirklich gewollt ist. | UST-05 |
| `backdate_period_locked` | E | all with journal | document date in a locked period or a period with a submitted UStVA | Der Zeitraum {period} ist festgeschrieben bzw. die Umsatzsteuer-Voranmeldung wurde abgegeben. Bitte das aktuelle Datum verwenden. | GOBD-06, UST-05 |
| `date_before_original` | E | cancellation, correction | document date < original's date | Das Datum darf nicht vor dem Datum der Originalrechnung ({date}) liegen. | UST-30 |
| `final_date_before_advance` | E | final_invoice | date < a deducted advance's date | Das Datum der Schlussrechnung darf nicht vor dem Datum der Abschlagsrechnung {number} ({date}) liegen. | UST-41 |
| `valid_until_before_date` | E | quote | validUntil < document date | „Gültig bis“ darf nicht vor dem Angebotsdatum liegen. | — |
| `deadline_14a` | W | eu_b2b_service, intra_community_supply | today ≥ deadline − 3 days | Diese Rechnung muss bis {date} ausgestellt werden (§ 14a UStG). | UST-02 |
| `deadline_14a_missed` | W | same | today > deadline | Die Frist nach § 14a UStG ({date}) ist überschritten – bitte umgehend ausstellen. | UST-02 |
| `clock_skew` | E | all | server clock skew > 60 s | Die Serverzeit weicht um {seconds} s ab. Fertigstellen ist gesperrt, damit kein falsches Datum vergeben wird. | GOBD-22 |

#### 5.1.3 Lines and amounts

| Code | Sev | Applies to | Condition | Message (de) | Rule |
|---|---|---|---|---|---|
| `no_items` | E | all | no item line (optional lines do not count) | Das Dokument enthält keine Positionen. | UST-07 |
| `line_name_missing` | E | all | item without name | Position {n}: Bezeichnung fehlt. | UST-07 |
| `line_quantity_invalid` | E | all | quantity missing or 0 | Position {n}: Menge fehlt oder ist 0. | UST-07 |
| `line_unit_missing` | E | all | no unit | Position {n}: Einheit fehlt. | UST-07 |
| `line_unit_invalid` | E | all | not a Rec 20/21 code | Position {n}: „{code}“ ist kein gültiger Einheitencode nach UN/ECE Rec 20/21. | UST-07 |
| `line_price_missing` | E | priced types (delivery notes: if `showPrices`) | no unit price | Position {n}: Einzelpreis fehlt. | UST-09 |
| `generic_description` | W | all | name+description only matches the generic list (Leistung, Leistungen, Diverses, Sonstiges, Pauschale, Beratung, Waren, Material, Arbeit, Dienstleistung, Service) | Position {n}: „{text}“ ist sehr allgemein. Bitte Art und Umfang konkret beschreiben, sonst gefährdet das den Vorsteuerabzug Ihres Kunden. | UST-07 |
| `negative_line` | W | invoice types | item line net < 0 | Position {n} ist negativ. Für Minderungen bereits ausgestellter Rechnungen bitte eine Rechnungskorrektur verwenden. | UST-30 |
| `line_discount_exceeds` | E | all | discount > line amount | Position {n}: Der Rabatt ist höher als der Positionsbetrag. | UST-09 |
| `document_discount_exceeds` | E | all | document discount > Σ item nets of a group | Der Gesamtrabatt ist höher als die Zwischensumme. | UST-09 |
| `total_negative` | E | invoice family, proforma, self_billing | gross (BT-112) < 0 | Der Rechnungsbetrag darf nicht negativ sein. Für Minderungen bitte eine Rechnungskorrektur erstellen. | UST-30 |
| `total_zero` | W | invoice, partial, advance | gross = 0 | Der Rechnungsbetrag beträgt 0,00 €. | — |
| `amount_too_large` | E | all | any line or total > 99.999.999.999,99 | Der Betrag ist zu groß (maximal 99.999.999.999,99). | GOBD-03 |
| `gross_rounding_deviation` | W | gross mode | entered gross ≠ computed gross for a group | Durch die Umrechnung in Nettobeträge (E-Rechnung) beträgt die Summe {rate} % {computed} statt {entered}. Tipp: Bruttopreis um 0,01 € anpassen. | UST-10 |
| `consumer_net_prices` | W | consumer contact, net mode | | Privatkunde: Preise sollten brutto ausgewiesen werden (PAngV). Auf Bruttopreise umstellen? | MISC-03 |
| `placeholder_unknown` | E | texts | unknown `{{…}}` | Unbekannter Platzhalter {{name}}. | — |
| `placeholder_empty` | W | texts | placeholder resolves empty | Platzhalter {{name}} ist leer. | — |
| `unsupported_glyph` | W | texts | glyph not in embedded fonts (incl. fallback font) | Das Zeichen „{char}“ in {field} kann im PDF nicht dargestellt werden und erscheint als „□“ (in der E-Rechnung bleibt es erhalten). Bitte ersetzen. | ER-11 |
| `text_too_long` | E | texts | over §5.3 limits | {field} ist zu lang ({length} von max. {max} Zeichen). | ER-01 |
| `too_many_lines` | E | all | > 2,000 lines | Ein Dokument darf höchstens 2.000 Positionen enthalten. | ER-01 |
| `possible_duplicate` | W | invoice types | same contact, gross and supply date within 30 days | Es gibt bereits {number} vom {date} an {contact} über {amount}. Doppelte Rechnungen für dieselbe Leistung führen zur Steuerschuld nach § 14c UStG. | UST-34 |
| `payment_terms_long_b2b` | W | B2B | due days > 60 | Zahlungsziel von {days} Tagen: Über 60 Tage ist nur bei ausdrücklicher Vereinbarung wirksam (§ 271a BGB). | MAHN-04 |
| `payment_terms_long_public` | W | public authority | due days > 30 | Zahlungsziel von {days} Tagen: Gegenüber öffentlichen Auftraggebern sind höchstens 30 Tage üblich (§ 271a BGB). | MAHN-04 |
| `skonto_invalid` | E | all | Skonto days ≥ due days, or percent ≤ 0 or > 10 % | Skontofrist muss kürzer als das Zahlungsziel sein und der Skontosatz zwischen 0,01 % und 10 % liegen. | UST-09 |
| `bank_account_missing` | E | invoice types, payable > 0, method transfer | no bank account on the document | Bankverbindung fehlt (Zahlungsart Überweisung). | ER-10 |
| `iban_invalid` | E | same | IBAN check fails | Die IBAN {iban} ist ungültig. | ER-10 |

#### 5.1.4 Tax

| Code | Sev | Applies to | Condition | Message (de) | Rule |
|---|---|---|---|---|---|
| `category_not_allowed` | E | priced types | category outside App. C.3 for the tax case | Position {n}: USt-Kategorie „{category}“ ist im Steuerfall „{taxCase}“ nicht zulässig. | UST-10 |
| `vat_on_exempt_category` | E | all | rate > 0 with E/K/AE/G/O/KU | Position {n}: Bei „{category}“ darf keine Umsatzsteuer ausgewiesen werden. | UST-34 |
| `ku_vat_not_allowed` | E | KU company | any S/Z line or rate | Als Kleinunternehmer dürfen Sie keine Umsatzsteuer ausweisen (§ 19 UStG; sonst Steuerschuld nach § 14c UStG). | KU-03 |
| `ku_threshold_crossed` | E (dialog) | KU company | cumulative current-year turnover incl. this document > 100.000 € (founding year 25.000 €) | Mit dieser Rechnung wird die Umsatzgrenze von {limit} überschritten. Diese und alle folgenden Rechnungen müssen mit Umsatzsteuer ausgestellt werden. Steuerstatus jetzt umstellen? | KU-01 |
| `ku_status_outdated` | E | KU company | prior-year turnover > 25.000 € | Der Vorjahresumsatz liegt über 25.000 € — die Kleinunternehmerregelung gilt ab 01.01.{year} nicht mehr. Bitte Steuerstatus aktualisieren. | KU-01 |
| `ku_threshold_80` / `ku_threshold_95` | W | KU company | 80 % / 95 % of a limit | Kleinunternehmergrenze zu {percent} % erreicht ({amount} von {limit}). | KU-01 |
| `rate_not_valid_for_date` | E | priced types | stored rate ≠ rule rate for key and date (and no audited override) | Position {n}: Der Steuersatz {rate} % gilt nicht für das Leistungsdatum {date} (richtig: {expected} %). | UST-15 |
| `rate_changed_notice` | I | drafts | rate re-resolved | Steuersatz geändert: {old} % → {new} % (Leistungsdatum {date}). | UST-15 |
| `exemption_reason_missing` | E | E lines | no VATEX/§4 reason | Position {n}: Befreiungsgrund (§ 4 UStG) fehlt. | UST-10 |
| `tax_case_override_reason` | E | override | reason < 10 chars | Bitte begründen, warum vom ermittelten Steuerfall abgewichen wird (mind. 10 Zeichen). | UST-10 |
| `buyer_vat_id_missing` | E | eu_b2b_service, intra_community_supply | no customer VAT ID | Die USt-IdNr. des Kunden fehlt (Pflicht bei {taxCaseLabel}). | UST-20, UST-21 |
| `buyer_vat_id_invalid_format` | E | same | format/check digit invalid | Die USt-IdNr. {vatId} hat ein ungültiges Format. | UST-20, UST-21 |
| `buyer_vat_id_domestic` | E | same | VAT ID starts with DE | Für innergemeinschaftliche Umsätze muss die USt-IdNr. aus einem anderen EU-Mitgliedstaat stammen. | UST-20, UST-21 |
| `buyer_vat_id_not_verified` | E (override) | same | no valid check ≤ today (K: qualified) | USt-IdNr. {vatId} ist nicht bestätigt. Bitte jetzt prüfen oder mit Begründung freigeben (die Prüfung wird nachgeholt). | MISC-04 |
| `buyer_vat_id_qualified_mismatch` | E (override) | K | qualified result ≠ A for name/city | Die qualifizierte Bestätigung weicht ab ({fields}: {codes}). Der Vertrauensschutz für die steuerfreie Lieferung ist gefährdet. Freigabe nur mit Begründung. | MISC-04, UST-21 |
| `buyer_vat_id_check_old` | W | K/AE | last check > 3 months | Letzte USt-IdNr.-Prüfung am {date}. Bitte erneut prüfen. | MISC-04 |
| `no_vat_id_foreign_business` | W | EU business contact without VAT ID | | Keine USt-IdNr. hinterlegt – die Leistung wird mit deutscher Umsatzsteuer abgerechnet. USt-IdNr. jetzt prüfen? | UST-20 |
| `igl_delivery_country_invalid` | E | intra_community_supply | delivery country = DE or non-EU | Innergemeinschaftliche Lieferung: Die Lieferadresse muss in einem anderen EU-Mitgliedstaat liegen. | UST-21 |
| `export_delivery_country_invalid` | E | export | delivery country in the EU | Ausfuhrlieferung: Die Lieferadresse muss außerhalb der EU liegen. | UST-23 |
| `igl_services_ancillary` | I | intra_community_supply | service lines present | Dienstleistungspositionen werden als Nebenleistung zur Lieferung behandelt (steuerfrei). | UST-21 |
| `rc13b_consumer` | E | AE (§13b) | contact is a consumer | § 13b UStG setzt einen Unternehmer als Leistungsempfänger voraus. | UST-22 |
| `rc13b_certificate_missing` | W | AE §13b construction/cleaning | USt 1 TG missing or expired | Für {contact} liegt keine gültige Bescheinigung USt 1 TG vor (abgelaufen am {date}). Bitte bestätigen, dass der Kunde selbst Bauleistungen erbringt, oder mit Umsatzsteuer abrechnen. | UST-22 |
| `rc_buyer_id_missing_xml` | E | AE lines with XML | buyer has neither VAT ID nor register number | Für die E-Rechnung mit Steuerschuldnerschaft des Leistungsempfängers ist die USt-IdNr. oder die Handelsregisternummer des Kunden erforderlich. | UST-22, ER-01 |
| `category_o_mixed` | E | O lines | O mixed with any other category | „Nicht im Inland steuerbar“ kann nicht mit anderen Steuerkategorien in einem Dokument kombiniert werden. | UST-23 |
| `proof_missing_igl` | W | finalised K invoice | no Gelangensbestätigung/CMR attached | Gelangensnachweis fehlt (Gelangensbestätigung oder CMR). Ohne Nachweis ist die Steuerbefreiung gefährdet. | UST-21 |
| `proof_missing_export` | W | finalised G invoice | no Ausfuhrnachweis | Ausfuhrnachweis fehlt (z. B. ATLAS-Ausgangsvermerk). | UST-23 |
| `margin_scheme_blocked` | E | any | tax case/notes for §25/§25a requested | Differenzbesteuerung und Reiseleistungen (§§ 25, 25a UStG) werden in dieser Version nicht unterstützt. Bitte mit einem Steuerberater abstimmen. | UST-24 |
| `oss_threshold_exceeded` | E | EU B2C | EU distance sales (current or prior year) > 10.000 € | Ihre EU-Fernverkäufe an Privatkunden überschreiten 10.000 €. Das OSS-Verfahren wird erst in einer späteren Version unterstützt; diese Rechnung kann nicht mit deutscher Umsatzsteuer ausgestellt werden. | UVA-07 |
| `place_of_supply_ambiguous` | E | any | non-DE customer, service product without `placeOfSupplyRule` decision | Für „{product}“ ist der Leistungsort nicht eindeutig (z. B. Grundstück, Veranstaltung). Bitte Leistungsort-Regel wählen. | UST-23 |
| `advance_rate_differs` | W | advance/partial | expected supply date resolves to another rate | Für den voraussichtlichen Leistungszeitpunkt gilt {rate} %. Die Differenz wird in der Schlussrechnung ausgeglichen. | UST-41 |
| `tax_case_changed_notice` | I | drafts, conversions | derivation result changed | Steuerfall geändert: {old} → {new} ({reason}). | UST-20…23 |

#### 5.1.5 Currency

| Code | Sev | Applies to | Condition | Message (de) | Rule |
|---|---|---|---|---|---|
| `fx_rate_missing` | E | currency ≠ EUR | no rate at finalisation | Umrechnungskurs nach EUR fehlt (Pflicht bei Fremdwährung, § 16 Abs. 6 UStG). | MISC-08 |
| `fx_rate_source_daily` | W | rate source `ecb_daily`/`manual` | | Tageskurs statt BMF-Monatskurs: nur mit Gestattung des Finanzamts zulässig. | MISC-08 |
| `fx_bmf_rate_not_published` | I | `bmf_monthly`, month not yet published | | Der BMF-Umrechnungskurs für {month} ist noch nicht veröffentlicht; es wird der EZB-Referenzkurs vom {date} verwendet. | MISC-08 |
| `currency_unsupported` | E | any | ISO currency with ≠ 2 minor units, or unknown | Die Währung {currency} wird nicht unterstützt. | MISC-08 |
| `chain_currency_mismatch` | E | chain documents | currency ≠ chain currency | Alle Dokumente einer Abschlags-/Schlussrechnungskette müssen dieselbe Währung haben ({currency}). | UST-41 |
| `epc_qr_not_eur` | I | currency ≠ EUR | QR requested | Der GiroCode ist nur für Euro-Zahlungen möglich und wird weggelassen. | MISC-01 |

#### 5.1.6 Chains, corrections, conversions

| Code | Sev | Applies to | Condition | Message (de) | Rule |
|---|---|---|---|---|---|
| `advance_not_settled` | E | final_invoice | an advance of the chain has open amount > 0 (unpaid or partially paid) | Abschlagsrechnung {number} ist nicht vollständig bezahlt (offen: {amount}). Vor der Schlussrechnung muss sie storniert (keine Zahlung) oder per Rechnungskorrektur auf den erhaltenen Betrag ({received}) reduziert werden. Abgezogen werden nur tatsächlich erhaltene Zahlungen. | UST-41, UST-34 |
| `advance_not_deducted_confirm` | — | — | **Withdrawn** (the "nicht abziehen" option was removed, 10 EC-070); code reserved, never emitted | — | — |
| `advance_remainder_open` | — | — | **Withdrawn** (a partially paid advance must now be corrected to the received amount before the final invoice, `advance_not_settled`, 10 EC-071); code reserved, never emitted | — | — |
| `advance_already_deducted` | E | final_invoice | advance deducted in another non-cancelled final | Abschlagsrechnung {number} wurde bereits in Schlussrechnung {final} abgezogen. | UST-41 |
| `final_exists` | E | final_invoice | chain already has a non-cancelled final | Für diesen Auftrag gibt es bereits die Schlussrechnung {number}. | UST-41 |
| `final_without_advances` | E | final_invoice | no advance/partial in the chain | Eine Schlussrechnung setzt mindestens eine Abschlags- oder Teilrechnung voraus. Bitte eine normale Rechnung erstellen. | UST-41 |
| `chain_tax_case_mismatch` | E | final_invoice | tax case ≠ advances' | Der Steuerfall der Schlussrechnung ({a}) weicht von Abschlagsrechnung {number} ({b}) ab. | UST-41 |
| `partial_exceeds_order` | E | advance/partial | Σ prepaid > order net in a VAT group | Die Abschlags-/Teilrechnungen übersteigen den Auftragswert ({group}: {sum} von {order}). | UST-40 |
| `storno_paid_invoice` | E | cancel | payments allocated | Rechnung {number} ist (teil)bezahlt. Stornieren ist nur bei unbezahlten Rechnungen möglich. Erstellen Sie eine Rechnungskorrektur und erfassen Sie die Erstattung – oder lösen Sie zuerst die Zahlungszuordnung, falls sie falsch ist. | UST-30 |
| `already_cancelled` | E | cancel, correct | original cancelled | Rechnung {number} wurde bereits durch {storno} storniert. | UST-30 |
| `storno_of_storno` | E | cancel | target is a cancellation | Eine Stornorechnung kann nicht storniert werden. | UST-30 |
| `storno_advance_deducted` | E | cancel advance | deducted in a non-cancelled final | Abschlagsrechnung {number} ist in Schlussrechnung {final} verrechnet. Bitte zuerst die Schlussrechnung stornieren oder korrigieren. | UST-41 |
| `correction_target_invalid` | E | correct | target is a correction, cancellation, draft, proforma or non-invoice type | Korrekturen sind nur zu fertiggestellten Rechnungen möglich (nicht zu Korrekturen oder Stornorechnungen). | UST-30 |
| `correction_not_reducing` | E | credit | Σ delta ≥ 0 | Eine Rechnungskorrektur muss den Rechnungsbetrag mindern. Für Nachberechnungen bitte eine neue Rechnung erstellen. | UST-30 |
| `correction_exceeds_original` | E | credit | Σ(original + credits) < 0 in a VAT group | Die Korrekturen übersteigen den Rechnungsbetrag ({group}: noch {remaining} korrigierbar). | UST-30, RI-07 |
| `rectification_amount_changed` | E | rectification | any group net/VAT differs | Eine Rechnungsberichtigung darf die Beträge nicht ändern. Für Betragsänderungen bitte Rechnungskorrektur oder Storno verwenden. | UST-30, UST-31 |
| `rectification_no_change` | E | rectification | no field differs from the original | Die Berichtigung enthält keine Änderung gegenüber der Originalrechnung. | UST-30 |
| `correction_refund_allocated` | E | cancel correction | refund/offset allocated | Diese Rechnungskorrektur ist bereits erstattet oder verrechnet und kann nicht storniert werden. | UST-30 |
| `source_not_finalized` | E | convert | source is a draft | Nur fertiggestellte Dokumente können umgewandelt werden. | — |
| `conversion_not_allowed` | E | convert | target not in §4.3.1 | Aus {sourceType} kann kein(e) {targetType} erstellt werden. | — |
| `quote_accepted_frozen` | E | revise/withdraw accepted quote | | Das Angebot wurde angenommen und ist eingefroren. Für Änderungen bitte ein neues Angebot oder einen Nachtrag erstellen. | GOBD-06 |
| `quote_expired_notice` | W | convert expired quote | | Das Angebot ist am {date} abgelaufen. Trotzdem annehmen und umwandeln? | — |
| `delivery_note_already_invoiced` | E | invoice from delivery note | already in a non-cancelled invoice | Lieferschein {number} ist bereits in Rechnung {invoice} enthalten. | UST-34 |
| `collective_mismatch` | E | collective invoice | contacts/currency/tax case/price mode differ | Die gewählten Lieferscheine passen nicht zusammen ({field}). | — |
| `self_billing_agreement_missing` | E | self_billing | no valid agreement at document date | Mit {supplier} ist keine gültige Gutschriftsvereinbarung hinterlegt (§ 14 Abs. 2 UStG). | UST-33 |
| `withdraw_has_invoices` | E | withdraw | finalised derived invoice exists | {number} kann nicht zurückgezogen werden, weil bereits Rechnungen daraus erstellt wurden. | — |

#### 5.1.7 E-Rechnung and finalisation infrastructure

| Code | Sev | Applies to | Condition | Message (de) | Rule |
|---|---|---|---|---|---|
| `einvoice_required` | E | invoice types | ER-03 `MUST_E`, format `none` | Für diese Rechnung ist eine E-Rechnung Pflicht ({reason}). Bitte ZUGFeRD oder XRechnung wählen. | ER-03 |
| `leitweg_id_missing` | E | public authority | BT-10 empty | Öffentlicher Auftraggeber: Die Leitweg-ID fehlt. | ER-20 |
| `leitweg_id_invalid` | E | public authority | format fails (Grobadressierung 2–12 digits, optional Feinadressierung ≤ 30 alphanumeric, 2-digit check, ≤ 46 chars) | Die Leitweg-ID {id} hat ein ungültiges Format. | ER-20 |
| `leitweg_id_checksum` | E | public authority | ISO 7064 Mod 97-10 check digits wrong | Die Prüfziffer der Leitweg-ID {id} ist falsch. | ER-20 |
| `leitweg_id_non_public` | W | non-public contact with a Leitweg-ID-shaped BT-10 | | Der Kunde ist nicht als öffentlicher Auftraggeber markiert, die Käuferreferenz sieht aber wie eine Leitweg-ID aus. | ER-20 |
| `buyer_reference_placeholder` | I | XRechnung formats, B2B | fallback used | Keine Käuferreferenz (BT-10) hinterlegt – es wird „{value}“ verwendet. | ER-10 |
| `seller_contact_missing` | E | E formats | BT-41/42/43 missing | Für E-Rechnungen fehlen Kontaktangaben des Unternehmens (Name, Telefon, E-Mail) → Einstellungen › Unternehmen. | ER-10 |
| `seller_electronic_address_missing` | E | XRechnung formats | BT-34 missing | Die elektronische Adresse des Unternehmens (BT-34) fehlt → Einstellungen › Unternehmen. | ER-10 |
| `buyer_electronic_address_missing` | E | XRechnung formats | no BT-49 and no invoice e-mail | Für die XRechnung fehlt eine elektronische Adresse des Kunden (E-Mail oder Leitweg-ID). | ER-10 |
| `einvoice_validation_failed` | E | E formats | KoSIT/Mustang errors in the preview | Die E-Rechnung ist ungültig ({count} Fehler). Erster Fehler: {ruleId} – {text}. | ER-12 |
| `dependency_unavailable` | E | E formats (EC-007) | sidecar unreachable/timeout 20 s | Die E-Rechnungs-Prüfung ist gerade nicht erreichbar. Fertigstellen ist erst nach erfolgreicher Prüfung möglich – bitte später erneut versuchen. | ER-12 |
| `number_range_missing` | E | numbered types | no active default range | Kein aktiver Nummernkreis für {docType} → Einstellungen › Nummernkreise. | UST-06 |
| `number_conflict` | E | commit | rendered number exists in the register | Die Nummer {number} ist bereits vergeben. Bitte den Nummernkreis prüfen (z. B. nach einem Import). | UST-06 |
| `version_conflict` | E | commit, PATCH | draft version changed | Der Entwurf wurde zwischenzeitlich geändert. Bitte Vorschau aktualisieren. | GOBD-06 |
| `revalidation_failed` | E | commit | new errors after re-reading company/contact data | Firmen- oder Kundendaten wurden während der Fertigstellung geändert. Bitte die Vorschau erneut prüfen. | UST-03, MAIL-03 |
| `integrity_alert_open` | E | all | unacknowledged RI ERROR | Die Integritätsprüfung hat einen Fehler gemeldet. Bitte zuerst unter Einstellungen › System prüfen und bestätigen. | GOBD-06 |
| `artifacts_not_ready` / `artifacts_blocked` | E | export, mark_sent | `pending` / `blocked` | PDF/E-Rechnung wird noch erzeugt. · Die E-Rechnung konnte nicht erzeugt werden – Export und Versand gesperrt. | ER-12 |

#### 5.1.8 Export and sent mark

Withdrawn codes stay reserved and are never emitted.

| Code | Sev | Condition | Message (de) | Rule |
|---|---|---|---|---|
| `recipient_missing` | — | **Withdrawn (v1.1)** — B2: no e-mail recipients; code reserved, never emitted | — | — |
| `recipient_not_on_contact` | — | **Withdrawn (v1.1)** — B2: no recipients, no send tool (SND-13 withdrawn); code reserved, never emitted | — | — |
| `pdf_consent_required` | E | `PDF_NEEDS_CONSENT`, mark on an electronic channel (`email_manual`, `upload_portal`, `other`), handed-over files contain no structured e-invoice, no consent recorded | Für die elektronische Übermittlung als reines PDF ist während der Übergangszeit die Zustimmung des Kunden erforderlich. Bitte die E-Rechnung übergeben, auf Papier versenden oder die Zustimmung erfassen. | MAIL-01, ER-03 |
| `pdf_not_allowed_must_e` | E | `MUST_E`, first effective mark, handed-over files contain neither the ZUGFeRD PDF nor the XRechnung XML | Für diese Rechnung ist eine E-Rechnung Pflicht. Bitte die ZUGFeRD-PDF oder die XRechnung-Datei übergeben – ein reines PDF, eine Lesefassung oder Papier genügt nicht. | ER-03 |
| `must_e_channel_not_electronic` | E | `MUST_E`, first effective mark, channel `post` or `hand` | Eine E-Rechnung muss elektronisch übermittelt werden. „Post“ oder „Persönlich übergeben“ genügt nicht – bitte „E-Mail (selbst versendet)“, „Upload-Portal“ oder „Sonstiges (elektronisch übermittelt)“ wählen. | ER-03 |
| `must_e_electronic_confirmation_missing` | E | `MUST_E`, first effective mark, channel `other` without the confirmation | Bitte bestätigen, dass die E-Rechnung elektronisch übermittelt wurde. | ER-03 |
| `pdf_consent_tacit` | W | `NOT_REQUIRED`/`MAY_PAPER_OR_PDF`, PDF-only on an electronic channel, no consent | Keine Zustimmung zu PDF-Rechnungen erfasst. Eine stillschweigende Zustimmung genügt in der Regel. | MAIL-01 |
| `smtp_not_configured` | — | **Withdrawn (v1.1)** — B2: no SMTP; code reserved, never emitted | — | — |
| `smtp_failed` | — | **Withdrawn (v1.1)** — B2: no SMTP (10 EC-097 withdrawn); code reserved, never emitted | — | — |
| `smtp_unknown_outcome` | — | **Withdrawn (v1.1)** — B2: no SMTP (10 EC-098 withdrawn); code reserved, never emitted | — | — |
| `resend_original_reason` | E | „Original erneut exportieren“ (or `?original=true`) on a document marked as sent, without reason | Bitte begründen, warum das Original erneut exportiert wird (wird protokolliert). | UST-34 |
| `mark_sent_date_future` | E | `sentOn` > today (Europe/Berlin) | Das Versanddatum darf nicht in der Zukunft liegen. | MAIL-02, MAHN-01 |
| `mark_sent_date_before_finalization` | E | `sentOn` < Europe/Berlin date of the finalisation | Das Versanddatum darf nicht vor der Fertigstellung ({date}) liegen. | MAIL-02, GOBD-06 |
| `mark_sent_backdate_note_required` | E | `sentOn` more than `backdateWindowDays` before the recording date and no note | Das Versanddatum liegt {days} Tage zurück. Bitte im Hinweis angeben, warum erst jetzt markiert wird (wird protokolliert). | MAIL-02, GOBD-06 |
| `mark_sent_note_required` | E | channel `other` without note | Bitte beschreiben, wie das Dokument übermittelt wurde. | MAIL-02 |
| `mark_sent_artifacts_missing` | E | no file selected | Bitte angeben, welche Dateien übergeben wurden. | MAIL-02 |
| `mark_sent_artifact_unknown` | E | an artifact ID is not an archived artifact or frozen attachment of this document, or a supplied sha256 differs from the archived hash (API/MCP) | Die Datei {name} gehört nicht zu diesem Dokument oder wurde verändert. | MAIL-02, GOBD-06 |
| `already_marked_sent` | W | document already has an effective mark | Bereits am {date} als versendet markiert ({channel}). Die erneute Markierung wird zusätzlich protokolliert; Status und Zugang bleiben unverändert. | MAIL-02 |
| `retraction_reason_required` | E | retraction without reason or reason < 10 characters | Bitte begründen, warum die Versandmarkierung zurückgenommen wird (mind. 10 Zeichen). | GOBD-06 |
| `retraction_blocked_dependent` | E | retracting the effective mark while a later act depends on it (SND-18) | Die Versandmarkierung kann nicht zurückgenommen werden, weil {dependent} darauf aufbaut (z. B. Mahnung {number}). | GOBD-06, MAHN-01 |
| `retraction_target_invalid` | E | `retractsId` is not a non-retracted `mark_sent` row of this document | Diese Versandmarkierung existiert nicht oder wurde bereits zurückgenommen. | GOBD-06 |

### 5.2 Regulatory edge cases (exhaustive)

Principle: an edge case either has a legal path that the software enforces, or it is blocked with a message that names the legal path. Nothing is "fixed in the DB". Every row has an acceptance test in §8.4 (`T-EC-xxx`, named with the compliance ID and the 10-edge-cases ID).

| ID | Situation | Required behaviour | Compliance | 10 ref | Test |
|---|---|---|---|---|---|
| EC-DOC-01 | Company data changed (e.g. managing director removed) between preview and commit | Commit re-reads company data inside the transaction and re-validates; new errors → 409 `revalidation_failed`, nothing committed; the snapshot always holds the data read in the commit transaction | MAIL-03, UST-03 | EC-004 | T-EC-001 |
| EC-DOC-02 | Contact edited concurrently (address, consumer flag, VAT ID) while finalising | Same as above for the contact; if the derived tax case or price display changes → `revalidation_failed`; never a snapshot mixing old and new data | UST-03, UST-20 | EC-004 | T-EC-002 |
| EC-DOC-03 | Same draft finalised twice (double click, API retry, MCP retry) | Second call returns the first result (`idempotent_replay`), one number only | UST-06 | EC-002 | T-EC-003 |
| EC-DOC-04 | Draft edited in the UI after an MCP preview | `document_finalize` with the old token → `preview_outdated`; nothing committed | GOBD-06 | EC-003 | T-EC-004 |
| EC-DOC-05 | 1,000 parallel finalisations on one counter | 1,000 unique, consecutive numbers | UST-06 | EC-001 | T-EC-005 |
| EC-DOC-06 | Counter outgrows its padding (`{####}` → 10000) | Number gets longer (`RE-2026-10000`), uniqueness kept; warning at 90 % (F01) | UST-06 | EC-011 | T-EC-006 |
| EC-DOC-07 | Range format changed mid-year after numbers were issued | Only future finalisations use the new format; drafts show the new preview; collision simulation at save (F01 SET-060) | UST-06, GOBD-02 | EC-008 | T-EC-007 |
| EC-DOC-08 | No active default range for the type at commit (deactivated meanwhile) | 409 `number_range_missing`, nothing committed | UST-06 | — | T-EC-008 |
| EC-DOC-09 | Year rollover with yearly reset: draft from 2026-12-31 finalised 2027-01-02 | Number from the 2027 counter; if backdated to 2026-12-30 (within window, period open) the 2026 counter continues | UST-05, UST-06 | EC-010 | T-EC-009 |
| EC-DOC-10 | Rendered number collides with an imported sevdesk number | 409 `number_conflict`, nothing committed, counter unchanged; owner raises the counter (F01) | UST-06 | EC-014 | T-EC-010 |
| EC-DOC-11 | Commit at 23:59:59.900 Europe/Berlin, incl. DST days (2026-03-29, 2026-10-25) | Document date = Berlin calendar date of the commit instant; due date computed on Berlin dates | UST-05, GOBD-22 | EC-020 | T-EC-011 |
| EC-DOC-12 | Server clock skew > 60 s | Finalisation refused (`clock_skew`) | GOBD-22 | EC-027 | T-EC-012 |
| EC-DOC-13 | Backdating beyond the window, beyond 6 months, into the previous year, into a locked period | Reason required; > 6 months extra warning; previous year allowed if the period is open (old-year counter); locked period or submitted UStVA → `backdate_period_locked` | UST-05, GOBD-06 | EC-022 | T-EC-013 |
| EC-DOC-14 | Document date in the future (UI, API, MCP) | `document_date_future` | UST-05 | EC-021 | T-EC-014 |
| EC-DOC-15 | Supply date after the invoice date | Blocked for `invoice`/`final_invoice`/`correction` (`supply_date_in_future`); allowed for advance/partial/quote/proforma/order; period starting ≤ date and ending later → info only | UST-08, UST-40 | EC-023 | T-EC-015 |
| EC-DOC-16 | One line's period spans a rate change (catering 2025-12-15…2026-01-15) | Blocked until the line is split into line periods; each part gets its own rate | UST-15 | EC-024 | T-EC-016 |
| EC-DOC-17 | Supply period spans a KU status change | Blocked (`supply_period_crosses_ku_change`) | KU-01 | EC-025 | T-EC-017 |
| EC-DOC-18 | Supply older than 6 months, invoice issued now | Allowed with warning; audit entry notes the delay | UST-01 | EC-026 | T-EC-018 |
| EC-DOC-19 | Rate change between quote (2025, 19 %) and invoice (2026, 7 % food) | Conversion re-resolves by the new supply date with a notice; the quote PDF stays unchanged | UST-15 | EC-040 | T-EC-019 |
| EC-DOC-20 | Rate change between advance (19 %) and final (7 %) | Final at 7 % on the total, advance deducted at 19 %, VAT remainder −120,00 € (golden G-14) | UST-41, MISC-09 | EC-073 | T-EC-020 |
| EC-DOC-21 | Product rate key changed after a draft used it | Draft re-resolves on next open with a notice; finalised documents untouched | UST-15 | EC-041 | T-EC-021 |
| EC-DOC-22 | KU threshold (100.000 €) crossed by this document | 409 `ku_threshold_crossed`; dialog "Steuerstatus jetzt umstellen" appends the regular-taxation entry from this supply date (SET-035); the **whole** document is then re-derived with VAT and must be previewed again; never a document that is half KU | KU-01 | EC-060 | T-EC-022 |
| EC-DOC-23 | Founding-year KU company crosses 25.000 € | As EC-DOC-22 with the 25.000 € limit | KU-01 | EC-066 | T-EC-023 |
| EC-DOC-24 | KU company: VAT rate via API/MCP or UI override | Rejected `ku_vat_not_allowed` (no override path in v1 — the audited override of KU-03 exists only for the period after a confirmed status change) | KU-03 | EC-063 | T-EC-024 |
| EC-DOC-25 | Prior-year turnover > 25.000 € but history still KU | `ku_status_outdated` blocks KU invoices | KU-01 | EC-061 | T-EC-025 |
| EC-DOC-26 | Contact switched consumer ↔ business between quote and invoice | Conversion and drafts re-derive from current flags; notices for tax case and price display; §286 note/§35a/§14b follow the new flag | MISC-03, MAHN-01 | EC-080 | T-EC-026 |
| EC-DOC-27 | EU business customer without VAT ID buys a service | Domestic German VAT + `no_vat_id_foreign_business` warning; manual override to `eu_b2b_service` blocked by `buyer_vat_id_missing` | UST-20 | EC-043 | T-EC-027 |
| EC-DOC-28 | VAT ID present but invalid (format, check digit, VIES invalid) | `buyer_vat_id_invalid_format` / `buyer_vat_id_not_verified` blocks K/AE | UST-20, UST-21, MISC-04 | EC-043 | T-EC-028 |
| EC-DOC-29 | VIES/eVatR unavailable at finalisation | K/AE blocked unless override with reason; follow-up task "USt-IdNr nachprüfen"; RI-16 tracks it | MISC-04 | EC-044 | T-EC-029 |
| EC-DOC-30 | Qualified check returns B for the name (K) | Override with reason required | MISC-04, UST-21 | EC-045 | T-EC-030 |
| EC-DOC-31 | German VAT ID used for an EU case | `buyer_vat_id_domestic` | UST-20, UST-21 | — | T-EC-031 |
| EC-DOC-32 | EU VAT ID but goods delivered within Germany | Domestic 19 % (destination rules); intra-Community supply impossible (`igl_delivery_country_invalid` on override) | UST-21 | EC-042 | T-EC-032 |
| EC-DOC-33 | Northern Ireland: goods vs services (XI/GB) | Goods to an `XI` VAT ID → EU rules (K); services to GB/XI businesses → third country (O) | UST-21, UST-23 | — | T-EC-033 |
| EC-DOC-34 | Swiss customer, service with German place of supply (property, event admission) | `placeOfSupplyRule` → domestic with German VAT; unknown rule → `place_of_supply_ambiguous` | UST-23 | EC-046 | T-EC-034 |
| EC-DOC-35 | §13b construction service, USt 1 TG expired | Warning; owner confirms (audited) or switches to VAT | UST-22 | EC-047 | T-EC-035 |
| EC-DOC-36 | §13b to a consumer | Blocked `rc13b_consumer` | UST-22 | — | T-EC-036 |
| EC-DOC-37 | §13b E-Rechnung but buyer has neither VAT ID nor register number | `rc_buyer_id_missing_xml` (BR-AE-02) | UST-22, ER-01 | — | T-EC-037 |
| EC-DOC-38 | Domestic document mixing §13b metal lines and taxable lines | Allowed; two groups (S 19 %, AE); both texts; XML valid | UST-22, UST-10 | EC-049 | T-EC-038 |
| EC-DOC-39 | Taxable plus exempt (§4 Nr. 14) lines | Allowed; exemption text for the E group | UST-10 | EC-048 | T-EC-039 |
| EC-DOC-40 | O lines combined with other categories | Blocked `category_o_mixed` (BR-O-11ff.) | UST-23 | — | T-EC-040 |
| EC-DOC-41 | Margin scheme or travel-agency text requested | Blocked `margin_scheme_blocked` | UST-24 | EC-056 | T-EC-041 |
| EC-DOC-42 | EU B2C sales above 10.000 € | Blocked `oss_threshold_exceeded` (threshold counts current + prior year in EUR) | UVA-07 | EC-057 | T-EC-042 |
| EC-DOC-43 | Kleinbetrag at 250,00 / 250,01 € and with §13b | 250,00 allowed; 250,01 or any K/AE line blocked; ER-03 Kleinbetrag exception never for §13b | UST-14, ER-03 | — | T-EC-043 |
| EC-DOC-44 | Free item (0,00 € line) | Allowed; category still required; appears in XML with BT-131 = 0.00 | UST-10 | EC-050 | T-EC-044 |
| EC-DOC-45 | 0-€ final invoice (fully covered by advances) | Allowed; payable 0; no EPC QR; `paymentStatus = paid` at finalisation; XML BT-115 = 0.00 | UST-41 | EC-051 | T-EC-045 |
| EC-DOC-46 | 0-€ standard invoice | Allowed with `total_zero`; `paid` at finalisation | — | EC-051 | T-EC-046 |
| EC-DOC-47 | Negative totals | Invoice-family/proforma gross < 0 blocked; final invoice gross ≥ 0 but payable may be < 0 (refund); only `cancellation`/`correction` carry negative totals | UST-30, UST-41 | EC-052 | T-EC-047 |
| EC-DOC-48 | Single negative line on an invoice (deposit return) | Allowed with `negative_line`; gross must stay ≥ 0 | UST-30 | — | T-EC-048 |
| EC-DOC-49 | Gross-mode group gross not reachable with exact VAT rounding (e.g. 6,29 € at 19 %) | N* algorithm (App. E.3): gross 6,28 €, warning with the 0,01 € tip; never VAT ≠ round(net × rate) | UST-10, MISC-03 | EC-053 | T-EC-049 |
| EC-DOC-50 | Line discount + document discount + Skonto | Order per App. E; Skonto only in terms/BT-20 | UST-09 | EC-054 | T-EC-050 |
| EC-DOC-51 | Document discount over several rates | Per group pro rata, residue to the largest group (golden G-04) | UST-10 | EC-055 | T-EC-051 |
| EC-DOC-52 | Foreign-currency rounding | VAT in EUR per group = round(VAT_fc ÷ rate), summed; thresholds in EUR; rate stored as decimal string with ≤ 6 decimals | MISC-08 | — | T-EC-052 |
| EC-DOC-53 | FX rate missing; BMF monthly rate not yet published | `fx_rate_missing` blocks; unpublished month → ECB fallback with info and source stored | MISC-08 | — | T-EC-053 |
| EC-DOC-54 | Currency with 0 or 3 minor units (JPY, KWD) | `currency_unsupported` | MISC-08 | — | T-EC-054 |
| EC-DOC-55 | Final invoice while an advance is unpaid | Blocked until resolved (`advance_not_settled`): the advance must be cancelled (Storno, one click in the wizard) and is then not deducted. Leaving it undeducted and open is not possible ("nicht abziehen" withdrawn, 10 EC-070) | UST-41, UST-34 | EC-070 | T-EC-055 |
| EC-DOC-56 | Final invoice while an advance is partially paid | Blocked (`advance_not_settled`) until the advance is reduced to the received amount by a Rechnungskorrektur, offered in the same wizard step; then the received amount is deducted, split per rate in the advance's proportions (App. E.4, RI-08). No remainder can stay open (10 EC-071) | UST-41, UST-34 | EC-071 | T-EC-056 |
| EC-DOC-57 | Advance cancelled before the final invoice | Not deducted; listed as "storniert – nicht abgezogen" | UST-41 | — | T-EC-057 |
| EC-DOC-58 | Storno of an advance after it was deducted | `storno_advance_deducted` | UST-41 | EC-072 | T-EC-058 |
| EC-DOC-59 | Advance paid with Skonto | Deduction = invoiced minus the Skonto payment difference per rate (golden G-15) | UST-41, UST-32 | — | T-EC-059 |
| EC-DOC-60 | Second final invoice for the same chain; final after a cancelled final | Blocked `final_exists`; after Storno of the final a new final is allowed and the advances become deductible again | UST-41 | — | T-EC-060 |
| EC-DOC-61 | Advances/partials exceeding 100 % of the order | `partial_exceeds_order` | UST-40 | EC-078 | T-EC-061 |
| EC-DOC-62 | Storno of a paid or partially paid invoice | `storno_paid_invoice` with the two legal paths | UST-30 | EC-074 | T-EC-062 |
| EC-DOC-63 | Storno of a Storno | Impossible (`storno_of_storno`; no UI action) | UST-30 | EC-075 | T-EC-063 |
| EC-DOC-64 | Correcting a correction | A correction is never the *target* (`correction_target_invalid`); a further credit always targets the original (BT-25 = original) and references the earlier corrections as additional BG-3 entries, allowed while Σ(original + all corrections) ≥ 0 per group (10 EC-075, RI-07); a correction may be cancelled while not refunded | UST-30, RI-07 | EC-075 | T-EC-064 |
| EC-DOC-65 | Credit larger than the remaining original amount | `correction_exceeds_original` | UST-30 | — | T-EC-065 |
| EC-DOC-66 | Correction of a cancelled invoice | `already_cancelled` | UST-30 | — | T-EC-066 |
| EC-DOC-67 | Rectification that changes amounts | `rectification_amount_changed` | UST-30, UST-31 | EC-081 | T-EC-067 |
| EC-DOC-68 | Storno of an invoice dated in a locked period | Allowed; Storno dated today; journal in the current period | GOBD-06 | EC-076 | T-EC-068 |
| EC-DOC-69 | Storno after dunning started | Dunning case closed; reminders stay archived | UST-30 | EC-077 | T-EC-069 |
| EC-DOC-70 | Storno/correction after the company was renamed or moved | Seller block from the original snapshot (F01 SET-022) | UST-03, UST-30 | — | T-EC-070 |
| EC-DOC-71 | Accepted quote edited | Impossible; revision blocked (`quote_accepted_frozen`); invoices reference the accepted snapshot hash | GOBD-06 | EC-079 | T-EC-071 |
| EC-DOC-72 | Delivery note billed twice | `delivery_note_already_invoiced` | UST-34 | — | T-EC-072 |
| EC-DOC-73 | Possible duplicate invoice for the same supply | `possible_duplicate` warning | UST-34 | — | T-EC-073 |
| EC-DOC-74 | ER-03 `MUST_E` but the customer prefers PDF | XML always produced; the export dialog offers no PDF-only entry and the mark without the structured e-invoice is blocked (`pdf_not_allowed_must_e`) | ER-03 | EC-090 | T-EC-074 |
| EC-DOC-75 | `PDF_NEEDS_CONSENT` without stored consent | In the mark-sent dialog a PDF-only hand-over on an electronic channel is blocked (`pdf_consent_required`); E-Rechnung or paper (`post`/`hand`) offered; inline consent capture with source | MAIL-01 | EC-091 | T-EC-075 |
| EC-DOC-76 | B2G without Leitweg-ID / bad format / wrong check digit | `leitweg_id_missing` / `leitweg_id_invalid` / `leitweg_id_checksum` | ER-20 | EC-092 | T-EC-076 |
| EC-DOC-77 | B2B XRechnung without buyer reference | Fallback chain (App. A.3), info only | ER-10 | EC-093 | T-EC-077 |
| EC-DOC-78 | Seller phone/e-mail/electronic address missing | Blocking for E formats | ER-10 | EC-094 | T-EC-078 |
| EC-DOC-79 | Very long texts, 2,000 lines | Limits §5.3; XML carries the full text; PDF paginates with repeated table header; finalise ≤ 30 s for 1,000 lines | ER-01 | EC-095 | T-EC-079 |
| EC-DOC-80 | Emoji/RTL/control characters | Control chars stripped on input; XML-escaped; glyphs missing from the embedded fonts (incl. Noto fallback) render as a visible "□" with warning `unsupported_glyph` before finalising; the XML keeps the character | ER-11 | EC-096 | T-EC-080 |
| EC-DOC-81 | E-invoice validator unavailable | Refused before commit (503) unless no XML is needed (EC-007 exception) | ER-12 | EC-007 | T-EC-081 |
| EC-DOC-82 | Artifact rendering fails after commit; final validation fails | `pending` with retries → `blocked`, sending disabled, alert; never renumbered | UST-06, ER-12 | EC-005, EC-006 | T-EC-082 |
| EC-DOC-83 | KoSIT bundle update makes an old invoice invalid | Archived artifacts and reports stay; no regeneration | ER-12, GOBD-23 | EC-100 | T-EC-083 |
| EC-DOC-84 | **Withdrawn (v1.1)** — B2: no SMTP, so no send failure or unknown outcome (10 EC-097/EC-098 withdrawn). Replaced by EC-DOC-111…114. | — | — | EC-097, EC-098 (withdrawn) | T-EC-084 |
| EC-DOC-85 | PDF re-downloaded months later | "Kopie" stamp; original byte-identical; `original=true` audited | UST-34 | EC-099 | T-EC-085 |
| EC-DOC-86 | 2027 invoice while the 2026 turnover is not final | ER-03 uses the confirmed 2026 figure, else the running computed total with warning `turnover_provisional`; > 800k → `MUST_E` | ER-03 | EC-029 | T-EC-086 |
| EC-DOC-87 | Supply 2027-12-31 invoiced 2028-01-05 (≤ 800k); supply 2028-01-01 | Transition applies by supply date (`PDF_NEEDS_CONSENT`); 2028 supply → `MUST_E` | ER-03 | — | T-EC-087 |
| EC-DOC-88 | Correction/Storno of an E-Rechnung | Must itself be an E-Rechnung (App. D rule R1) | ER-04, ER-03 | — | T-EC-088 |
| EC-DOC-89 | Storno in 2028 of a PDF invoice for a 2026 supply | Decision from the original's reference date (`PDF_NEEDS_CONSENT`), not from the Storno date | ER-03 | — | T-EC-089 |
| EC-DOC-90 | Ist company, invoice dated 2027-12-31 vs 2028-01-01 | UST-13 note only from 2028-01-01 (by document date, method at that date) | UST-13 | EC-028 | T-EC-090 |
| EC-DOC-91 | MCP client ignores `requiresUserInteraction`; prompt injection asks to send invoices to another address | No send tool exists: MCP can only export to the owner (short-lived tailnet links, SND-24) and cannot transmit anything; `document_mark_sent` still requires the scope and a `confirm_token` from `preview_action`; `document_finalize` a token from `document_preview` | SEC-02 | EC-188, EC-189 | T-EC-091 |
| EC-DOC-92 | Recurring job missed days (server down) | Catch-up oldest first; ≤ 3 → automation; > 3 → drafts + notification; document date = generation date | ER-04, UST-05 | — | T-EC-092 |
| EC-DOC-93 | Recurring job runs twice the same day | Idempotent by (template, occurrence) | ER-04 | EC-142 (pattern) | T-EC-093 |
| EC-DOC-94 | Recurring period crosses a rate change or KU switch | Split draft, no automation, notification | UST-15, KU-01 | EC-024 | T-EC-094 |
| EC-DOC-95 | **Withdrawn (v1.1)** — B2: recurring automation never sends (REC-08 withdrawn), so a lost e-mail address or consent cannot affect it; the mark-sent rules apply when the owner sends. Replaced by REC-16. | — | — | — | T-EC-095 |
| EC-DOC-96 | Recurring anchor on the 31st | 31.01 → 28.02 → 31.03; periods contiguous, no gap or overlap | ER-04 | — | T-EC-096 |
| EC-DOC-97 | Bank account changed/closed after issue | Issued documents and their copies keep the original IBAN; drafts switch to the new default | MISC-01, UST-34 | EC-114 | T-EC-097 |
| EC-DOC-98 | Layout/logo changed after issue | Copies re-render with the original layout version and logo file | GOBD-06 | EC-110 | T-EC-098 |
| EC-DOC-99 | Unknown placeholder typed into a draft text | Blocked at finalisation (`placeholder_unknown`) | — | — | T-EC-099 |
| EC-DOC-100 | Unacknowledged integrity alert | All finalisations blocked (`integrity_alert_open`) | GOBD-06 | EC-182 | T-EC-100 |
| EC-DOC-101 | Payment terms > 60 days B2B / > 30 days public | Warnings | MAHN-04 | — | T-EC-101 |
| EC-DOC-102 | Proforma converted twice | Second conversion blocked (`invoiced`) | UST-34 | — | T-EC-102 |
| EC-DOC-103 | Self-billing without (valid) agreement (P3) | Blocked `self_billing_agreement_missing` | UST-33 | — | T-EC-103 |
| EC-DOC-104 | Line amount overflow (10^6 units × 10^7 € unit price) | BigInt math, `amount_too_large` above the limit; never a float | GOBD-03 | — | T-EC-104 |
| EC-DOC-105 | Month supply (`2026-01`) with a rate change on the 15th | Treated like a period: blocked until split | UST-15 | EC-024 | T-EC-105 |
| EC-DOC-106 | Contact archived while drafts exist | Drafts can still be finalised (warning "Kontakt ist archiviert"); the snapshot is complete | UST-03 | EC-112 | T-EC-106 |
| EC-DOC-107 | Advance invoice of a KU company | Allowed, no VAT; final invoice deducts the gross | KU-02, UST-41 | — | T-EC-107 |
| EC-DOC-108 | EU business customer with a German establishment (contact country DE, foreign VAT ID) | Domestic rules by contact country; warning that the establishment determines the case | UST-20 | — | T-EC-108 |
| EC-DOC-109 | E-Rechnung to a foreign recipient or consumer | Allowed (hybrid PDF readable); decision `NOT_REQUIRED` | ER-03 | — | T-EC-109 |
| EC-DOC-110 | Blocked artifacts on an unsent invoice | "Stornieren und neu erstellen"; Storno falls back to `none` if its XML fails too (audited) | ER-12, UST-30 | EC-006 | T-EC-110 |
| EC-DOC-111 | Sent mark dated before the finalisation, or in the future (UI, API, MCP) | Blocked (`mark_sent_date_before_finalization` / `mark_sent_date_future`); a date more than 10 days back needs a note | MAIL-02, MAHN-01 | EC-195 | T-EC-111 |
| EC-DOC-112 | Invoice exported but never marked as sent | Status stays `finalized` („Nicht versendet“, badge „exportiert“); no Zugang, no automatic Verzug (§ 286 Abs. 3 BGB), no dunning or interest (F05); to-do after 2 days (SND-21) | MAHN-01, MAIL-02 | EC-196 | T-EC-112 |
| EC-DOC-113 | `MUST_E` invoice marked as sent via `post`/`hand` only, or with only the PDF Lesefassung / plain PDF | Blocked (`must_e_channel_not_electronic` / `pdf_not_allowed_must_e`); allowed with the ZUGFeRD PDF or XML via `email_manual`, `upload_portal` or confirmed `other`; a later additional postal mark is allowed | ER-03 | EC-197 | T-EC-113 |
| EC-DOC-114 | Document marked as sent twice; retraction of the first mark; retraction after a reminder exists | Second mark appended with warning, status/`sentOn`/Zugang unchanged; retraction of the effective mark re-derives from the remaining mark or returns to `finalized`; blocked (`retraction_blocked_dependent`) once a non-draft reminder or dunning action references the invoice; rows never changed or deleted | GOBD-06, MAHN-01 | EC-198 | T-EC-114 |
| EC-DOC-115 | API/MCP mark with an artifact ID of another document or a sha256 that differs from the archive | Rejected (`mark_sent_artifact_unknown`); nothing written | MAIL-02, GOBD-06 | — | T-EC-115 |
| EC-DOC-116 | Storno of an invoice that was exported but never marked as sent | Storno dialog warns that the customer may hold the invoice and recommends sending the Storno too (§ 14c UStG risk if a received invoice is not cancelled towards the customer); the success step of the Storno dialog offers „Exportieren“ directly | UST-30, UST-34 | — | T-EC-116 |

### 5.3 Limits

| Item | Limit | XML handling |
|---|---|---|
| Lines per document | 2,000 (`too_many_lines`) | all lines |
| Line name | 250 chars | BT-153 full |
| Line description | 5,000 chars (rich text) | BT-154 as plain text, full |
| Subject | 250 chars | BT-22 note (subject code `AAI`) |
| Head/foot text | 20,000 chars each (F01 SET-081) | BT-22 notes, full, plain text |
| Legal notes | generated | BT-22 (`REG`) and BT-120 per group |
| Number | 36 chars (UST-06) | BT-1 |
| References (BT-10/12/13) | 100 chars each | full |
| Attachments | 10 × 10 MB | BG-24 only if `embedInXml` (base64); XRechnung total ≤ 15 MB |
| Quantity | 3 decimals, ±999,999,999.999 | BT-129 with up to 4 decimals |
| Unit price | 4 decimals | BT-146 per App. E.3 |
| Amount | 99,999,999,999.99 | |
| E-mail recipients | **Withdrawn (v1.1)** — B2: no e-mail sending | — |
| Bulk export / bulk mark | 2,000 documents per job (SND-20) | — |

## 6. UI

All texts German (EN locale via `next-intl`); legal terms stay German in both locales (04 §1).

### 6.1 Lists

| Route | Tabs (with counts) | Default columns | Row actions |
|---|---|---|---|
| `/angebote` | Alle · Entwurf · Offen · Angenommen · Abgelehnt · Abgelaufen · Berechnet | Nr., Kunde, Datum, Gültig bis, Netto, Brutto, Status | Öffnen, Duplizieren, Neue Version, In Auftrag/Rechnung umwandeln, Exportieren, Als versendet markieren |
| `/auftraege` | Alle · Entwurf · Offen · Teilberechnet · Berechnet | Nr., Kunde, Datum, Bestellnr., Netto, berechnet %, Status | Umwandeln (Lieferschein, Rechnung, Abschlag, Teil, Schluss) |
| `/lieferscheine` | Alle · Entwurf · Offen · Erhalten · Berechnet | Nr., Kunde, Lieferdatum, Positionen, Status, Tage unberechnet (P2) | Rechnung erstellen, Als erhalten markieren |
| `/rechnungen` | Alle · Entwurf · Nicht versendet · Offen · Überfällig · Teilbezahlt · Bezahlt · Storniert · Korrekturen · Proforma | Nr., Typ-Badge (AR/TR/SR/RK/PF), Kunde, Datum, Fällig, Brutto, Offen, Status, E-Rechnung-Icon | Zahlung buchen (F05), Exportieren, Als versendet markieren, Korrigieren…, Stornieren, Mahnen (F05), Duplizieren, Ansehen |
| `/rechnungen/wiederkehrend` | Aktiv · Pausiert · Beendet | Name, Kunde, Intervall, Nächste Rechnung, Betrag, Automatik (Symbole), erzeugt | Jetzt erzeugen, Pausieren/Fortsetzen, Bearbeiten |

Filters (URL-persisted): Zeitraum (Dokumentdatum; presets), Kunde, Typ, Status, Zahlungsstatus, Betrag von/bis, Tag, Kostenstelle, Währung, E-Rechnung (validiert/gesperrt/ohne), Versand (versendet / nicht versendet / exportiert, nicht markiert; SND-21), Erstellt über (UI/API/MCP/Automatik), Fällig von/bis. Search: number, contact name/number, subject, amount (`1.190` matches 1.190,00), order reference. Totals row: Netto, USt, Brutto, Offen in EUR (foreign currency converted with the document rate, marked "≈"). Mobile: cards with number, status, contact, due date, amount; chips instead of tabs; long-press for bulk (Sammel-Export, Sammel-Markierung, SND-20).

### 6.2 Editor (extends 04 §4.3)

- **Header bar**: type selector (only within the invoice family for invoice drafts), "Entwurf" badge, autosave state ("Gespeichert vor 3 s"), primary action "Fertigstellen" (disabled with tooltip listing the first blocking error), secondary "Vorschau", "⋯" (Löschen, Duplizieren, Layout wählen).
- **Sections** as 04 §4.3 plus: "Abschläge" card on final-invoice drafts (table: Nr., Datum, berechnet netto/USt/brutto, erhalten, abgezogen netto/USt per rate, Entscheidung); "Lieferscheine" card on collective invoices; "Nachweise" (only after finalisation, K/G).
- **Line row (desktop)**: `⋮⋮ | Pos | Bezeichnung + Beschreibung (expand) | Menge | Einheit | Einzelpreis (netto|brutto) | USt | Rabatt | Betrag | ⋯` — the `⋯` menu: Optional (quotes), Arbeitskosten, Leistungszeitraum, Kostenstelle, Erlöskonto, Löschen. Keyboard: `Enter` new line, `Tab` next cell, `⌘↑/⌘↓` move line, `⌘⌫` delete line.
- **Line row (mobile)**: card "3 × Workshop-Tag · 1.200,00 € · 19 %" → tap opens the bottom drawer with all fields.
- **Tax case block**: chip with the case label + "Warum?" popover (App. C reason text) + "Ändern" (dialog with radio list of cases, reason textarea, warning text "Ein falscher Steuerfall kann zu Steuernachzahlungen führen (§ 14c UStG).").
- **E-Rechnung block**: badge with the ER-03 result ("E-Rechnung Pflicht (B2B Inland ab 2028)", "PDF nur mit Zustimmung (Übergangsregel bis 2026)", "PDF erlaubt (Kleinbetragsrechnung)", "Keine E-Rechnungspflicht (Privatkunde)") + format select + "Zustimmung erfassen" link.
- **Compliance panel**: groups, each item with ✓/⚠/✗, message, link ("→ Einstellungen › Unternehmen"). Items update live; on mobile it is a sheet opened from the totals bar ("2 Fehler").

### 6.3 Dialogs

| Dialog | Content | Confirm button |
|---|---|---|
| Fertigstellen | number preview, date (picker; > window → reason field), supply date, total, ER-03 badge + format, attachments, immutability notice "Nach dem Fertigstellen kann das Dokument nicht mehr geändert oder gelöscht werden (GoBD). Korrekturen sind nur per Stornorechnung oder Rechnungskorrektur möglich." | „Verbindlich fertigstellen“ |
| Stornieren | original summary, mirror totals, number preview, optional reason (printed), note if unsent, link "Lieber berichtigen?" (UST-31 explanation) | „Stornorechnung erstellen“ |
| Korrektur-Assistent | questions of §4.8 as a stepper | leads to the matching draft or dialog |
| Umwandeln | target type, optional lines checklist, quantities (remaining proposed), "Angebot als angenommen markieren", attachments, notices (rates/tax case changed) | „Entwurf erstellen“ |
| Abschlag / Teilrechnung | mode (Prozent / Netto / Brutto), value, per-group preview, already prepaid %, remaining % | „Entwurf erstellen“ |
| Schlussrechnung | advances table with decision per open advance (Pflicht vor dem Fertigstellen — unbezahlt: Stornieren · teilbezahlt: auf erhaltenen Betrag korrigieren) | „Entwurf erstellen“ |
| Neue Version | reason (optional), notice that the previous version becomes "Ersetzt" on finalisation | „Version anlegen“ |
| Angenommen / Abgelehnt | date, name/channel or reason | „Speichern“ |
| Exportieren | ER-03 badge with the legally required files ("E-Rechnung Pflicht: ZUGFeRD-PDF oder XRechnung elektronisch übergeben"), format entries of SND-16 with file names and sizes, variant note ("Original" or "Kopie – Dokument wurde am {date} versendet" + „Original erneut exportieren“ with reason field), post hint (SND-09), „E-Mail-Text kopieren“ section (SND-19), after the download the prompt "Wenn Sie das Dokument versendet haben: Als versendet markieren" | „Herunterladen“ / „Teilen“ (mobile) |
| Als versendet markieren | Versanddatum (default today; min = finalisation date, max = today), Kanal (E-Mail (selbst versendet) / Post / Persönlich übergeben / Upload-Portal (z. B. ZRE, OZG-RE) / Sonstiges), Hinweis (mandatory for Sonstiges and for dates > 10 days back), „Übergebene Dateien“ checklist with sha256 short hash (preselected from the last export), for `MUST_E` with `other` the checkbox „E-Rechnung elektronisch übermittelt“, inline „Zustimmung erfassen“ (MAIL-01); live validation per §5.1.8; notice when already marked (`already_marked_sent`) | „Als versendet speichern“ |
| Versandmarkierung zurücknehmen | list of marks (date, channel, files), choice of the mark, reason (≥ 10 characters), effect preview ("Status wird auf „Nicht versendet“ zurückgesetzt" / "Zugang wird neu berechnet") or the blocking reason (`retraction_blocked_dependent`) | „Markierung zurücknehmen“ |
| Sammel-Export / Sammel-Markierung | selection summary, per-document pre-check result (ready / skipped with reason), for the mark: one date, channel, note | „Export starten“ / „Alle markieren“ |
| Steuerfall ändern | see §6.2 | „Übernehmen“ |
| KU-Grenze überschritten | KU-01 explanation, amounts, effect ("ab {date} Regelbesteuerung"), next step "Rechnung mit Umsatzsteuer neu prüfen" | „Steuerstatus umstellen“ |

Every irreversible confirm button requires the dialog to be open ≥ 1 s (no accidental double-tap) and is never the default `Enter` target on mobile.

### 6.4 Detail page (extends 04 §4.2)

- Header: number · contact · display status (with due info) · type badge · E-Rechnung badge (✓ validiert KoSIT {config}, ⚠ gesperrt).
- Primary action by status: Entwurf → "Bearbeiten"; Nicht versendet → "Exportieren" (after an export: "Als versendet markieren"); Offen/Überfällig → "Zahlung buchen"; Angebot offen → "Angenommen"/"Umwandeln".
- Tabs: Übersicht (PDF preview of the **original** without stamp, key facts, payment block, legal notes list), Zahlungen (F05), Verlauf (audit timeline with actor badges), Dateien (artifacts with sha256, size, tool version, variant; attachments; Nachweise), Versand (dispatch record: exports with file hashes, marks with date/channel/note/files, retractions with reason; „Versandmarkierung zurücknehmen“), Verknüpft (chain tree with amounts and progress bars).
- "Ansehen" (on-screen) vs "Exportieren" (SND-16; Kopie once marked as sent, "Original erneut exportieren" requires a reason, DOC-32).

### 6.5 Recurring template editor

Same editor as invoices plus a "Zeitplan" section: Erste Rechnung (date), Intervall (select), Abrechnung (im Voraus / nachträglich), Ende (nie / am Datum / nach N Rechnungen), "Zeitraumtext im Kopftext" (switch) and an "Automatik" section: Fertigstellen (switch) with the note „Versendet wird nie automatisch – fertiggestellte Rechnungen erscheinen als Aufgabe „Exportieren und versenden““ (REC-16). Right pane: "Nächste Termine" (12 rows: Datum, Zeitraum, Betrag, Steuersatz-Hinweis, ER-03). Detail page lists generated documents.

### 6.6 Accessibility and performance

Axe-clean on all pages (MISC-10); totals update < 50 ms; editor with 500 lines stays interactive (virtualised rows above 200 lines); PDF preview < 1.5 s for ≤ 50 lines.

## 7. API and MCP exposure

### 7.1 REST (`/api/v1`, 05 §4.3)

| Method | Path | Scope | Behaviour |
|---|---|---|---|
| GET | `/quotes`, `/order-confirmations`, `/delivery-notes`, `/invoices`, `/corrections` | documents:read | Filters 05 §4.3 + `display_status`, `currency`, `einvoice_status`, `recurring_template_id`, `chain_root_id`; `invoice_type` ∈ `standard \| advance \| partial \| final \| cancellation \| proforma` |
| POST | `/{type}` | documents:write | Create draft; body accepts `contact_id` or inline contact (upsert by e-mail/VAT ID), `lines[]` (`kind`, `product_id`, `name`, `description`, `quantity` (string), `unit_code`, `unit_price` (string, 4 dp), `discount`, `vat_category`, `vat_rate_key`, `line_period`, `optional`, `is_labor_cost`), `supply_date` (`{kind,…}` or `"same_as_document_date"`), `price_mode`, `currency`, texts, terms, references, `tax_case_override {tax_case, reason}`. Response: draft + `totals` + `validation {errors, warnings}` + `tax_case {value, reasons}` + `einvoice {decision, format}` |
| PATCH | `/{type}/{id}` | documents:write | Drafts only; `If-Match`; `lines` replaced as a whole or patched via `lines_add` / `lines_remove` / `lines_update` |
| DELETE | `/{type}/{id}` | documents:write | Drafts only (audited with content) |
| POST | `/{type}/preview` | documents:read | Dry run of an unsaved body (DOC-42). `?validate_xml=true` also runs KoSIT on the preview XML (slower, ≤ 10/min per key) |
| POST | `/{type}/{id}/preview` | documents:read | Dry run of a saved draft with an optional patch body; returns `confirm_token` for MCP parity (ignored by REST finalize) |
| POST | `/{type}/{id}/preview-pdf` | documents:read | PDF with "ENTWURF" watermark, short-lived URL |
| POST | `/{type}/{id}/finalize` | quotes/orders/delivery notes/proforma: documents:write **and** invoices:finalize; invoice family: invoices:finalize; corrections: invoices:finalize **and** invoices:cancel | Body `{ version, document_date?, backdate_reason?, fx_rate? {rate, source, date}, overrides? {vat_id_unverified_reason, rc13b_confirmation} }`. Final invoices reference their advances only via `deductions[]` (03), which the server computes from the chain; there is no advance decision in the request (open advances → 422 `advance_not_settled`). 200 with number + `artifact_status`; idempotent per §4.6.4; 422/409/503 per §5.1 |
| POST | `/{type}/{id}/send` | — | **Withdrawn (v1.1)** — B2: no sending endpoint. Replaced by `/export` and `/mark-sent` |
| POST | `/{type}/{id}/export` | documents:read | `{ files?: ["zugferd_pdf" \| "xrechnung_xml" \| "pdf" \| "reading_pdf" \| "attachments" \| "zip"], original?: true, reason? }` → `{ files: [{ artifact_id, name, variant, sha256, url }] }` with 5-min tailnet URLs; default files per §4.10.2; copy rule SND-05 (`original: true` after the mark needs `reason`, else 422 `resend_original_reason`); writes `document.export`; 409 `artifacts_not_ready` / `artifacts_blocked` |
| POST | `/{type}/{id}/mark-sent` | `invoices:send` (export / mark as sent, 05 §2) | `{ sent_on, channel: "email_manual" \| "post" \| "hand" \| "upload_portal" \| "other", note?, artifacts: [{ artifact_id, sha256 }], einvoice_handed_over_electronically? }` → the `sendLog` row + document; 422 per §5.1.8; `?dry_run=true` validates only |
| POST | `/{type}/{id}/mark-sent/{sendLogId}/retract` | `invoices:send` (export / mark as sent, 05 §2) | `{ reason }` → retraction row; 409 `retraction_blocked_dependent` (SND-18) |
| GET | `/{type}/{id}/send-log` | documents:read | Dispatch record: marks, retractions, exports (from the audit log) |
| GET | `/{type}/{id}/artifacts[/{kind}]` | documents:read | `?original=true` audited; default PDF is the "Kopie" once the document is marked as sent; viewing only — does not count as an export for SND-21 |
| POST | `/{type}/{id}/duplicate` | documents:write | New draft (DOC-35) |
| POST | `/{type}/{id}/convert` | documents:write | `{ to, mode?: "full" \| "quantities" \| "percent" \| "net" \| "gross", value?, lines?: [{source_line_id, quantity}], optional_line_ids?, accept_source?: true, delivery_note_ids? }` → new draft |
| POST | `/invoices/{id}/cancel` | invoices:cancel (+ invoices:finalize) | `{ reason?, document_date?, dry_run? }`; `dry_run: true` returns the mirror preview incl. the KoSIT result of the mirror XML (`einvoice_validation`) and the guard (`allowed`, `blocked`); otherwise creates + finalises atomically (INV-10) and answers 201 `{ id, number, original_id, artifact_status }`. Without `dry_run` an `Idempotency-Key` is **required** (400 `idempotency_key_required`). 409 `storno_paid_invoice` / `already_cancelled` / `storno_of_storno` / `storno_advance_deducted` / `storno_has_corrections` |
| POST | `/invoices/{id}/correct` | documents:write | `{ kind: "credit" \| "rectification", changes?: [{ position, quantity?, unit_price? }] }` → correction draft prefilled (INV-12/13): `credit` with `changes` = negative difference per changed line, without = the full amount; `rectification` = full copy with the same amounts. Response: draft id (`cor_`), version, totals, validation |
| POST | `/corrections/{id}/cancel` | invoices:cancel (+ invoices:finalize) | Storno of an unrefunded correction (409 `correction_refund_allocated`); same body/idempotency rules as `/invoices/{id}/cancel` |
| POST | `/quotes/{id}/mark-accepted` / `mark-rejected` / `revise` / `withdraw` | documents:write | QUO-05/06/15 |
| POST | `/delivery-notes/{id}/mark-received` | documents:write | `{ date, received_by }` |
| POST | `/invoices/{id}/retry-artifacts` | invoices:finalize | Re-render a `blocked` document from its snapshot |
| GET | `/{type}/{id}/chain` | documents:read | Chain tree incl. invoicing progress. P1 implements `/invoices/{id}/chain` for advance/partial/final invoices: advances with invoiced/received/credited/open amount and the EC-071 `resolution` (`settled` \| `storno` \| `reduce` \| `cancelled` \| `deducted`), finals, `can_create_final` |
| GET/POST/PATCH | `/recurring-invoices[/{id}]` | documents:write (+ invoices:finalize when automation is enabled, REC-14) | Template CRUD; `automation: { finalize: boolean }` only (REC-16) |
| POST | `/recurring-invoices/{id}/run-now` · `/pause` · `/resume` (`{ catch_up: true \| false }`) | documents:write (+ automation scopes) | REC-10/12 |
| GET | `/recurring-invoices/{id}/occurrences?count=12` | documents:read | REC-13 |
| POST | `/documents/bulk/send` | — | **Withdrawn (v1.1)** — B2. Replaced by `/documents/bulk/export` and `/documents/bulk/mark-sent` |
| POST | `/documents/bulk/export` · `/documents/bulk/mark-sent` · `/documents/bulk/zip` | documents:read · `invoices:send` · documents:read | Jobs (`bulk_export`, bulk mark, `pdf_zip`) → `GET /jobs/{id}` with per-document results and skip reasons (SND-20) |

Conventions: snake_case, money `*_cents`, unit prices and quantities as decimal strings, dates `YYYY-MM-DD` (05 §3). Every write accepts `Idempotency-Key`; for `finalize`, `cancel`, `mark-sent`, `retract` and `bulk/*` the key is **required** (400 `idempotency_key_required` otherwise). Errors carry `rule` (compliance ID). Webhooks per 05 §5.3. Proforma lives under `/invoices` with `invoice_type=proforma` but is excluded from revenue reports and open items.

**Response fields** of a document (abridged): `id`, `type`, `invoice_type`, `correction_kind`, `status`, `payment_status`, `display_status`, `number`, `revision`, `contact` (live) and `buyer_snapshot` (finalised), `document_date`, `supply_date`, `due_date`, `valid_until`, `currency`, `fx_rate`, `price_mode`, `tax_case`, `tax_case_override`, `lines[]`, `totals {net_cents, vat_cents, gross_cents, advances_deducted_gross_cents, payable_cents, by_group[], vat_eur_cents?}`, `open_amount_cents`, `einvoice {format, decision, validated_with}`, `artifact_status`, `origin_id`, `chain_root_id`, `corrects_id`, `deducted_ids`, `sent_at`, `sent_on`, `zugang {date, basis}`, `exported` (boolean), `version`, `created_by {actor, name}` (`actor` = canonical `"<kind>:<id>"`, 02 §4.3), `updated_at`.

### 7.2 MCP tools (06 §3.4)

| Tool | Hints | Scope | F04 behaviour |
|---|---|---|---|
| `document_search` | readOnly | documents:read | Filters as REST; concise output: number, type, contact, date, gross, display status |
| `document_get` | readOnly | documents:read | Lines, totals, chain, payments summary, dispatch record (send log), artifact status, validation of drafts, ER-03 decision with the legally required files and allowed channels |
| `quote_create_draft` | — | documents:write | Contact by ID or inline; lines by product or free text; returns totals + validation |
| `invoice_create_draft` | — | documents:write | `invoice_type: standard \| advance \| partial \| final \| proforma`; `supply_date` required for invoice types |
| `document_update_draft` | — | documents:write | Requires `version` |
| `document_add_lines` / `document_remove_lines` | — | documents:write | |
| `document_convert` | — | documents:write | As REST convert |
| `document_duplicate` | — | documents:write | |
| `document_preview` | readOnly | documents:read | Totals, errors/warnings (code, rule, German message, fix hint), tax case + reasons, ER-03 decision + reason, format, number preview, 5-min PDF link, `confirm_token` (bound to id + version + preview hash, 10 min) |
| `document_finalize` | destructive, `requiresUserInteraction` | invoices:finalize (+ invoices:cancel for corrections) | Requires `confirm_token`; overrides (e.g. unverified VAT ID reason) must have been shown in the preview and are echoed back |
| `document_send` | — | — | **Withdrawn (v1.1)** — B2: no send tool exists (EC-189). Replaced by `document_export` + `document_mark_sent` |
| `document_export` | — (not readOnly: writes the `document.export` audit entry; not ⚠: it transmits nothing) | documents:read | Returns 5-min links (tailnet only) to the files of SND-16 for the owner to download; original while unmarked, Kopie afterwards (original re-export after the mark only in the UI); never sends anything to a third party (SND-24) |
| `document_mark_sent` | ⚠ destructive, `requiresUserInteraction` | `invoices:send` (export / mark as sent, 05 §2) | Requires `confirm_token` from `preview_action { action: "document_mark_sent", params }`, which runs the §5.1.8 validation and returns the effect (status change, Zugang); params as REST `mark-sent`. Retraction is not exposed via MCP |
| `invoice_cancel` | destructive, `requiresUserInteraction` | invoices:cancel (+ invoices:finalize) | Requires `confirm_token` from `document_preview` with `intent: "cancel"` (returns the mirror preview; the token binds id + version + `reason` + `document_date`, a changed reason fails with `preview_outdated`). A blocked preview (e.g. `storno_paid_invoice`) issues no token |
| `invoice_create_correction` | — | documents:write | `kind: credit \| rectification`, optional `changes` as REST `/correct` → draft; finalised via `document_finalize` |
| `quote_mark_accepted` / `quote_mark_rejected` | — | documents:write | |
| `document_get_pdf_link` | readOnly | documents:read | Signed 5-min link to a view copy (the "Kopie" once marked as sent); not an export for sending (use `document_export`) |
| `recurring_invoice_upsert` | — | documents:write (+ invoices:finalize for automation, REC-14) | Automation (`finalize` only) stays inactive until confirmed once in the UI |
| `recurring_invoice_list` | readOnly | documents:read | Incl. next occurrences |

Tool descriptions are in English with German domain terms and tell Claude: the app never sends documents — export them for the owner and call `document_mark_sent` only after the owner confirms how and when they sent them; never invent VAT IDs or Leitweg-IDs; always call `document_preview` and show totals, tax case and ER-03 to the user before `document_finalize`; prefer Rechnungsberichtigung for formal defects; Storno only for unpaid invoices. Errors return `isError: true` with the §5.1 structure.

**P1 status (2026-10-13):** the quote/order/delivery-note/proforma part of §7.1/§7.2 is implemented as described in 05 §4.3 „P1 implementation“ (API-021) and 06 §3.4 (MCP-011); the acceptance and rejection bodies carry the business `date` next to the recording instant (03 §12). Open in this slice: inline contact upsert, duplicate. **2026-10-18:** the finalise preview, export, mark-sent and retraction routes and the MCP tools `document_preview` (finalize), `document_finalize`, `document_export`, `document_mark_sent` are implemented (05 §4.3 API-022, 06 §3.4 MCP-012); deviations: export takes one menu `entry`, mark-sent `artifacts` are `art_…` strings, `pdf_preview_url` is null.

## 8. Acceptance tests

Naming: test titles start with the compliance ID(s) and the 10-edge-cases ID(s), then the test ID, e.g. `test("UST-30 EC-074 T-EC-062 storno of a paid invoice is blocked", …)`. Types: **U** unit (Vitest, domain), **C** Convex function test (convex-test), **G** golden file (07 §4: snapshot + CII/UBL + PDF text + DATEV + UStVA), **E** Playwright E2E (desktop + mobile), **V** external validator (KoSIT 1.6.3 / Mustang 2.26 / veraPDF). Every C/E test runs `assertInvariants()` (RI-01…RI-28) in `afterEach` (07 §5a). The covers column lists F04 requirement IDs · compliance IDs · EC/RI IDs.

### 8.1 Requirement tests

| Test ID | Given / When / Then | Type | Covers req IDs |
|---|---|---|---|
| T-DOC-001 | Given each type / When the lifecycle table §4.2 is exercised with every (state, event) pair / Then allowed pairs succeed and all others throw `illegal_transition` | U | DOC-02 · GOBD-06 |
| T-DOC-002 | Given a draft / When deleted via UI, API and MCP / Then it is gone, no number consumed, audit entry contains the full content | C | DOC-03 · GOBD-02 · EC-013 · RI-02 |
| T-DOC-003 | Given heading, text, subtotal and optional lines / When totals are computed / Then only non-optional items count and the subtotal shows the running sum | U | DOC-04, QUO-02 |
| T-DOC-004 | Given a product with a customer price valid from 2026-09-01 and a default discount 5 % / When added to a draft with supply date 2026-10-01 / Then the customer price and a 5 % line discount are used; with supply date 2026-08-31 the product price | U | DOC-05, DOC-06 |
| T-DOC-005 | Given random documents (fast-check) / When totals are computed / Then Σ line nets = net, VAT per group = round_half_up(base × rate), gross = net + VAT, mirror(doc) totals = −totals(doc) | U | DOC-09 · UST-10 · GOBD-03 · RI-05, RI-06 |
| T-DOC-006 | Given a consumer contact / When a draft is created / Then price mode is gross and the PDF shows gross unit prices | U,G | DOC-08, DOC-48 · MISC-03 |
| T-DOC-007 | Given contact AT business with verified VAT ID and a service product / When derived / Then `eu_b2b_service`, categories {AE}, reason text names country, VAT ID and service | U | DOC-11 · UST-20 |
| T-DOC-008 | Given a derived domestic case / When overridden to `export` without reason / Then `tax_case_override_reason`; with reason / Then saved and the audit diff holds derived + chosen value | C | DOC-12 · UST-10 · SEC-02 |
| T-DOC-009 | Given a draft with catering food (rate key reduced-restaurant) / When the supply date moves 2025-12-31 → 2026-01-01 / Then the rate changes 19 → 7 with notice `rate_changed_notice`; drinks stay 19 | U | DOC-13 · UST-15 |
| T-DOC-010 | Given a USD invoice / When finalised without FX rate / Then `fx_rate_missing`; with rate 1.0831 (BMF) / Then the snapshot has BT-6 EUR and BT-111 | C,G | DOC-15 · MISC-08 |
| T-DOC-011 | Given an EN document with tax case `intra_community_supply` / When rendered / Then labels are English and the legal note is printed bilingually (App. B) | G | DOC-16 · UST-21 |
| T-DOC-012 | Given a head text with `{{contact.letterSalutation}}` / When finalised and the contact name changes afterwards / Then the snapshot text keeps the old resolved salutation | C | DOC-17 · GOBD-06 |
| T-DOC-013 | Given an attachment on a draft / When finalised / Then its sha256 is in the snapshot and „Alles als ZIP“ contains it with the same hash; with `embedInXml` the XRechnung has BG-24 with the base64 content | C,V | DOC-18 · MAIL-02 |
| T-DOC-014 | Given the editor with 200 lines / When typing a quantity / Then totals update in < 50 ms (performance trace) | E | DOC-19 |
| T-DOC-015 | Given a draft missing the supply date and a GmbH without managing director / When the compliance panel renders / Then both errors are listed with links and "Fertigstellen" is disabled | E | DOC-20 · UST-08, MAIL-03 |
| T-DOC-016 | Given "Leistungsdatum = Rechnungsdatum" / When finalised on 2026-10-12 / Then the snapshot has supply `date 2026-10-12` and the PDF prints it | C,G | DOC-21 · UST-08 |
| T-DOC-017 | Given a finalised invoice / When the contact address changes / Then the invoice snapshot, PDF hash and XML are unchanged | C | DOC-22 · UST-03 · EC-111 · RI-01 |
| T-DOC-018 | Given the finalise pipeline with KoSIT returning an error in the preview / When finalising / Then 422 `einvoice_validation_failed` and the counter is unchanged | C | DOC-24 · ER-12 · RI-02 |
| T-DOC-019 | Given a finalised invoice / When any non-whitelisted field is patched (API, MCP, internal mutation inventory) / Then 409 `immutable_record` | C | DOC-29 · UST-30 · GOBD-06 |
| T-DOC-020 | Given a GmbH / When any document type is rendered / Then the footer on every page contains Firma, Sitz, Registergericht, HRB, all Geschäftsführer | G | DOC-31 · MAIL-03 · RI-26 |
| T-DOC-021 | Given an invoice marked as sent / When the PDF is exported again / Then it carries "Kopie", the original artifact hash is unchanged, `?original=true` writes an audit entry | C | DOC-32 · UST-34 · EC-099 |
| T-DOC-022 | Given the conversion matrix / When every (source, target) pair is attempted / Then allowed pairs produce drafts with copy rules §4.3.2 and others fail `conversion_not_allowed` | U,C | DOC-33 |
| T-DOC-023 | Given a quote → order → 2 delivery notes → collective invoice → correction / When the chain is fetched / Then all six documents with progress are returned | C | DOC-34, QUO-11 · GOBD-01 |
| T-DOC-024 | Given a cancelled advance invoice / When duplicated / Then a standard `invoice` draft without chain links, dates or number is created with rates re-resolved | C | DOC-35 |
| T-DOC-025 | Given 3 finalised invoices / When bulk ZIP (originals) runs / Then the ZIP holds `{number}.pdf/.xml`, `index.csv` and `SHA256SUMS.txt` whose hashes equal the artifacts | C | DOC-38 · GOBD-11 |
| T-DOC-026 | Given invoice dated 2026-03-15 / When finalised / Then `retentionClass = vouchers8`, `retentionUntil = 2034-12-31`; a quote → `letters6`, `2032-12-31` | U | DOC-40 · GOBD-20, UST-50 |
| T-DOC-027 | Given an MCP key / When it updates a draft / Then the audit entry has actor `mcp:<id>` and channel `mcp`, and the UI shows the actor toast | C,E | DOC-41 · SEC-02 |
| T-DOC-028 | Given an unsaved body / When `POST /invoices/preview` / Then totals, errors, tax case, ER-03 decision and PDF link are returned and no row is written | C | DOC-42 · ER-03 |
| T-DOC-029 | Given a Kleinbetrag invoice of 249,99 € without buyer address / When finalised / Then it succeeds, has a number and supply date | C,G | DOC-44 · UST-14 |
| T-DOC-030 | Given a property-related product sold to a consumer / When rendered / Then the §14b note is present; for a business it is absent | G | DOC-46 · UST-12 |
| T-DOC-031 | Given a B2C invoice with labour and material lines / When rendered / Then the §35a labour subtotal (net, VAT, gross) is printed | G | DOC-47 · MISC-07 |
| T-DOC-032 | Given a line "Diverses" / When validated / Then warning `generic_description` | U | DOC-49 · UST-07 |
| T-DOC-033 | Given terms 30 days, 2 % Skonto 14 days, gross 1.190,00 € / When rendered / Then the PDF text matches App. B Skonto text and BT-20 = `#SKONTO#TAGE=14#PROZENT=2.00#BASISBETRAG=1190.00#` | G,V | DOC-50 · UST-09 |
| T-DOC-034 | Given an EUR invoice payable 1.190,00 € / When the QR is decoded / Then BCD/002/1/SCT, name = account holder, IBAN, `EUR1190.00`, remittance exactly `RE-2026-0042`, ≤ 331 bytes, ECC M; the printed Verwendungszweck and BT-83 are identical | U,G | DOC-51 · MISC-01 |
| T-DOC-035 | Given draft version 4 / When PATCH with `If-Match: 3` / Then 409 `version_conflict` | C | DOC-52 · GOBD-03 |
| T-DOC-036 | MISC-09 Stichtag: Given an injected rate change 19 → 20 % on 2027-07-01 / When every type is computed with supply dates 2027-06-30 and 2027-07-01 / Then rates follow the supply date, finals deduct at the old rate | U | DOC-57 · MISC-09 |
| T-DOC-037 | Given each display-status condition / When `displayStatus()` runs / Then the label of §4.2.9 results (incl. Überfällig on the Berlin date) | U | DOC-55 |
| T-DOC-038 | Given a website checkout API call creating a 47,11 € gross B2C invoice / When previewed / Then `gross_rounding_deviation` is absent (reachable) and payable equals 47,11 | C | DOC-10 · MISC-03 |
| T-DOC-039 | Given every `type` of §4.1 (self_billing behind the P3 flag) / When created via UI, API and MCP / Then each is stored in `salesDocuments` with its own lifecycle, range and retention class | C | DOC-01 · UST-11, UST-33 |
| T-DOC-040 | Given a finalised invoice / When the snapshot is re-serialised canonically / Then the hash equals `snapshotHash`, `ruleVersions` lists the tax-rate and note rows used and `layoutVersionId` is set | C | DOC-27 · GOBD-06 · RI-01, RI-04 |
| T-DOC-041 | Given a contact with a previous invoice / When a new empty invoice draft selects that contact / Then "Letztes Dokument übernehmen" copies its lines and texts | E | DOC-36 |
| T-DOC-042 | Given 5,000 invoices / When the list is filtered by `display_status=overdue`, period and customer / Then results are correct, the totals row sums in EUR and filtering takes < 150 ms | E | DOC-37 |
| T-DOC-043 | Given a finalised invoice / When its detail page opens / Then the register row (number, range, assignedAt, status) is shown and links to the F01 register | E | DOC-39 · GOBD-02 |
| T-DOC-044 | Given a line cost centre and a printable custom field / When finalised / Then the cost centre is in the snapshot (DATEV KOST1) and the custom field is printed | C,G | DOC-53 · DATEV-02 |
| T-QUO-001 | Given company default validity 30 days / When a quote is finalised on 2026-10-12 / Then `validUntil = 2026-11-11` and the PDF prints "Gültig bis 11.11.2026" | C,G | QUO-01 |
| T-QUO-002 | Given a sent quote with `validUntil` yesterday / When `deadlines.notify` runs / Then status `expired` and a notification was created 3 days before | C | QUO-04 |
| T-QUO-003 | Given a sent quote / When marked accepted / Then `acceptance.snapshotHash` equals the snapshot hash | C | QUO-05 · GOBD-06 |
| T-QUO-004 | Given AN-2026-0007 rejected / When "Neue Version" is finalised / Then number `AN-2026-0007-V2`, revision 2, the old one `superseded`, both in the register | C | QUO-06 · UST-06 |
| T-QUO-005 | Given an order with 10 units / When a delivery note with 4 is finalised / Then the next conversion proposes 6 | C | QUO-10 |
| T-QUO-006 | Given 3 delivery notes (03.10., 10.10., 17.10.) / When a collective invoice is created / Then 3 headings, supply period 03.10.–17.10., all notes `invoiced` after finalisation | C,G | QUO-11 · UST-08 |
| T-QUO-007 | Given a proforma / When finalised / Then title "Proforma-Rechnung", the note "Keine Rechnung im Sinne des § 14 UStG", no XML, no journal entry, not in open items | C,G | QUO-12 |
| T-QUO-008 | Given an order 10.000 € net / When an invoice for half the quantities is finalised, then cancelled / Then the order goes `partially_invoiced` → `accepted` | C | QUO-13, INV-32 |
| T-QUO-009 | UST-01: Given a B2B delivery note dated T−151 days, not invoiced / When `deadlines.notify` runs / Then warning to-do; at T−181 escalation | C | QUO-14 · UST-01 |
| T-QUO-010 | Given a delivery note with `showPrices = false` / When rendered / Then no prices, totals or VAT appear; converting to an invoice keeps the prices | G | QUO-09 |
| T-QUO-011 | Given an order with a finalised invoice / When withdrawn / Then `withdraw_has_invoices` | C | QUO-15 |
| T-QUO-012 | Given a quote / When every quote transition of §4.2.1 is exercised / Then `superseded`, late accept and reopen behave as specified, each with an audit entry | U,C | QUO-03 · GOBD-06 |
| T-INV-001 | Golden `de-19-standard` passes all checks (see 8.2) | G,V | INV-01 · UST-03…10 |
| T-INV-002 | Given an invoice paid fully / When payments are recorded (F05) / Then `paymentStatus` open → partially_paid → paid; reverse → partially_paid | C | INV-02 |
| T-INV-003 | Given an order 19 % 5.000 € / 7 % 1.000 € / When a 30 % advance is created / Then lines 1.500,00 @19 and 300,00 @7, TypeCode 326, PDF says "1. Abschlagsrechnung" and "Leistung noch nicht erbracht" | U,G,V | INV-03 · UST-40 |
| T-INV-004 | Given the same order / When a partial invoice of 2.000,00 € gross is created / Then group gross 1.695,16 / 304,84 and nets 1.424,50 / 284,90 (App. E.5) | U | INV-04 · UST-40 |
| T-INV-005 | UST-40: Given a Soll company, advance issued in March, paid in April / When the accounting hook runs / Then the advance's VAT is assigned to April (F08 report) | C | INV-03, INV-31 · UST-40 · EC-173 |
| T-INV-006 | Golden `advance-and-final` (G-13) | G,V | INV-06, INV-09 · UST-41 · RI-08 |
| T-INV-007 | Golden `advance-rate-change` (G-14) | G,V | INV-08 · UST-41 · EC-073 |
| T-INV-008 | Given a paid advance and a final invoice dated before it / When finalising / Then `final_date_before_advance` | U | INV-07 · UST-41 |
| T-INV-009 | Golden `storno-full` (G-17): mirror totals, own number from the RE range, BT-25/26, original `cancelled`, register `cancelled_by_storno`, Σ per group = 0 | G,V,C | INV-10 · UST-30 · RI-06 |
| T-INV-010 | Golden `correction-partial` (G-18): PDF has no "Gutschrift", TypeCode 381, refund open −238,00 € | G,V | INV-12 · UST-33 · RI-07 |
| T-INV-011 | Golden `rectification-address` (G-19): identical amounts, TypeCode 384 with BG-3, no journal entries, register `corrected` | G,V,C | INV-13 · UST-30, UST-31 |
| T-INV-012 | Given an issued invoice / When a Nachberechnung invoice is created with reference / Then it is a 380 invoice with BT-25 = original | C,V | INV-14 · UST-30 |
| T-INV-013 | UST-33/UST-11 (P3): Given a supplier with agreement / When a self-billing is finalised / Then title "Gutschrift", TypeCode 389, seller = supplier; without agreement → blocked | C,G,V | INV-16 · UST-11, UST-33 |
| T-INV-014 | Given preference `pdf` and decision `MUST_E` / When the format is selected / Then `zugferd_en16931` with the notice; preference `pdf` + `NOT_REQUIRED` → `none` | U | INV-17 · ER-03 · EC-090 |
| T-INV-015 | ER-03 table (App. D.4, all ER03-xx cases) | U | INV-18 · ER-03 |
| T-INV-016 | Given each golden with E format / When extracted from the hybrid PDF / Then the XML is byte-equal to the archived XML and Mustang + veraPDF report valid | V | INV-19, INV-21 · ER-01, ER-11 |
| T-INV-017 | Given a finalised invoice / When artifacts are ready / Then the KoSIT report is archived with validator + config version and sha256 | C | INV-20 · ER-12, ER-13 |
| T-INV-018 | Given a public authority without Leitweg-ID / When validated / Then `leitweg_id_missing`; `991-01234-44` → `leitweg_id_checksum`; `991-01234-38` and `04011000-1234512345-06` accepted; `99-AB` → `leitweg_id_invalid` | U | INV-22 · ER-20 · EC-092 · RI-25 |
| T-INV-019 | Given each tax case / When legal notes are generated / Then the exact App. B text (DE; EN bilingual) appears and placeholders inside notes are impossible | U,G | INV-23 · UST-10, UST-20…23, KU-02 |
| T-INV-020 | KU-03: Given a KU company / When an API call creates a line with 19 % / Then 422 `ku_vat_not_allowed` | C | INV-24 · KU-03 · EC-063 · RI-17 |
| T-INV-021 | Golden `ist-2028-note` vs `ist-2027` (G-25) | G | INV-25 · UST-13 · EC-028 |
| T-INV-022 | Given a B2C invoice with payable > 0 / When rendered / Then the §286 note is present; B2B absent; payable 0 absent | G | INV-26 · MAHN-01 |
| T-INV-023 | UST-02: Given an EU B2B service supplied 2026-03-31 / When the editor opens / Then the deadline "15.04.2026" is shown and warnings appear from 12.04. | U | INV-27 · UST-02 |
| T-INV-024 | Given a K invoice without proof attachment / When finalised / Then the detail page shows `proof_missing_igl` until a Gelangensbestätigung is attached | C | INV-30 · UST-21 |
| T-INV-025 | Given finalisation of an invoice, a Storno and a rectification / When the journal is inspected / Then revenue entries, a reversal in the Storno period, and nothing for the rectification | C | INV-31 · GOBD-01 · EC-076 |
| T-INV-026 | Given a final invoice with payable −120,00 € / When rendered / Then no EPC QR, no §286 note, "Der Betrag wird erstattet", BT-81 = 58 with the buyer IBAN or 97 | G,V | INV-33 · MISC-01 |
| T-INV-027 | Given an order with 10 units / When an invoice for 4 units is finalised (Teilleistung, supply date 2026-10-05) / Then it is a 380 invoice, the order is `partially_invoiced`, the next conversion proposes 6, and a later final invoice does not deduct it | C | INV-05 · UST-08 |
| T-REC-001 | Given monthly in advance from 2026-11-01 / When the job runs on 2026-11-01 / Then one invoice with period 01.11.–30.11.2026, BT-12 set, head text period line | C,G | REC-01, REC-04, REC-09 · ER-04 |
| T-REC-002 | Given every interval code / When `next()` is applied 24 times from 2026-01-31 / Then the anchor rule holds (28.02., 31.03., …) | U | REC-02 · EC-096 |
| T-REC-003 | Given `maxCount = 3` / When the 3rd invoice is generated / Then the template is "Beendet"; with `endDate` the last occurrence ≤ endDate | C | REC-03 |
| T-REC-004 | Given in-arrears monthly on 2026-12-01 / When generated / Then period 01.11.–30.11.2026 | U | REC-04 |
| T-REC-005 | Given auto-finalise and a missing company phone (E format) / When the job runs / Then a draft remains and a notification lists `seller_contact_missing` | C | REC-07 · ER-10 |
| T-REC-006 | **Withdrawn (v1.1)** — B2: no auto-send (REC-08 withdrawn). Replaced by T-REC-012. | — | — |
| T-REC-007 | Given a paused template with 2 past occurrences / When resumed with `catch_up: false` / Then nextDate is the first future occurrence and the skip is audited | C | REC-10 |
| T-REC-008 | Given a template edited after 2 generated invoices / When inspected / Then the generated invoices are unchanged | C | REC-11 · GOBD-06 |
| T-REC-009 | Given a template / When "Jetzt erzeugen" / Then the next occurrence is generated and nextDate advances | C | REC-12 |
| T-REC-010 | Given a template / When occurrences are requested / Then 12 dates with periods, rates and ER-03 are returned | U | REC-13 · ER-03 |
| T-REC-011 | Given an MCP key without `invoices:finalize` / When `recurring_invoice_upsert` enables finalise automation / Then 403 `insufficient_scope`; with the scope automation stays inactive until confirmed in the UI; a body with a `send` automation field is rejected 422 (unknown field) | C | REC-14 · SEC-02 |
| T-REC-012 | Given a template with `automation.finalize = true` / When `recurring.generate` runs / Then the invoice is finalised as `system:cron.recurring.generate`, status stays `finalized`, no `sendLog` row and no export exist, and a to-do „Exportieren und versenden“ is created; marking it as sent closes the to-do; with `finalize = false` a draft and the to-do „Entwurf prüfen und fertigstellen“ | C | REC-16, REC-07 · MAIL-02 |
| T-SND-001 | **Withdrawn (v1.1)** — B2: no e-mail, Message-ID, SMTP response or `.eml`. Replaced by T-SND-010, T-SND-011. | — | — |
| T-SND-002 | Given an XRechnung UBL invoice / When „XRechnung + Lesefassung (PDF)“ is exported / Then the XML and the stamped Lesefassung (variant `reading`) are served with their archived hashes | C | SND-02, SND-16 · ER-01 |
| T-SND-003 | Given an invoice marked as sent / When exported again / Then the "Kopie" variant is served (archived as `copy`); „Original erneut exportieren“ without reason → `resend_original_reason`; with reason → original bytes + audit entry with the reason | C | SND-05, DOC-32 · UST-34 |
| T-SND-004 | Given an unmarked invoice / When every export entry (UI, REST, MCP) is used / Then status stays `finalized`, `sentAt`/`sentOn`/`zugang` stay unset, the served bytes hash to the archived original, and „Ansehen“ writes no `document.export` entry | C | SND-05, SND-06 · UST-34 |
| T-SND-005 | Given decision `MUST_E` / When marked as sent with channel `post` (with the ZUGFeRD PDF) / Then `must_e_channel_not_electronic`; with `email_manual` and only the Lesefassung → `pdf_not_allowed_must_e`; with `other` without confirmation → `must_e_electronic_confirmation_missing`; with `upload_portal` and the XML → `sent`, `einvoiceHandedOverElectronically = true` | C | SND-17 · ER-03 · EC-197 |
| T-SND-006 | Given 10 selected invoices of which 2 have blocked artifacts / When „Sammel-Export“ runs / Then the ZIP holds 8 folders with `index.csv` and `SHA256SUMS.txt` matching the archive, 2 are skipped with reasons, 8 `document.export` audit entries exist and no status changed | C | SND-20, SND-10 · GOBD-11 |
| T-SND-007 | Given the export dialog / When "Per Post" is looked for / Then only the print hint is shown | E | SND-09 |
| T-SND-008 | Given a quote / When exported / Then no XML entry is offered, the PDF footer is complete and the mark dialog offers all channels without ER-03 checks | C | SND-11 · MAIL-03 |
| T-SND-009 | Given a webhook endpoint subscribed to `invoice.sent`, `invoice.sent_retracted` and `invoice.artifacts_blocked` / When an invoice is marked as sent, the mark is retracted, and another invoice is blocked / Then the three events are delivered via the outbox with the 05 §5.2 signature; an export emits no event | C | SND-15 |
| T-SND-010 | Given a ZUGFeRD invoice / When the export menu opens / Then the default entry is „E-Rechnung (ZUGFeRD-PDF)“, the ER-03 badge names the required files, „Alles als ZIP“ contains the PDF, the XML, attachments with `includeInExport` and a correct `SHA256SUMS.txt`; on the iPhone/Pixel projects „Teilen“ is offered | C,E | SND-16, SND-02 · ER-01 |
| T-SND-011 | Given an exported invoice / When marked as sent (UI, REST, MCP) with date, channel `email_manual`, note and the exported files / Then one `sendLog` row (`purpose: document`, `kind: mark_sent`) with sha256 equal to the archived artifacts, status `sent`, `sentAt`, `sentOn`, audit entries `document.export` and `document.mark_sent` with the canonical actor | C | SND-07, SND-22, SND-05 · MAIL-02, GOBD-06 · RI-19 |
| T-SND-012 | Given the mark dialog / When the date is tomorrow, the day before finalisation, 12 days back without note, channel `other` without note, or no file selected / Then `mark_sent_date_future`, `mark_sent_date_before_finalization`, `mark_sent_backdate_note_required`, `mark_sent_note_required`, `mark_sent_artifacts_missing`; nothing written | U,C | SND-07 · MAIL-02 · EC-195 |
| T-SND-013 | Given a sent invoice / When marked again by post / Then a second row, warning `already_marked_sent`, `sentOn`/Zugang unchanged; retracting the first mark → `sentOn`/Zugang re-derived from the second; retracting both → `finalized`, fields unset; after a reminder was finalised the retraction of the effective mark → `retraction_blocked_dependent`; no row was ever modified (mutation inventory) | C | SND-18 · GOBD-06, MAHN-01 · EC-198 |
| T-SND-014 | Given an invoice and a `message_text` template with subject „Rechnung {{document.number}}“ / When „E-Mail-Text kopieren“ is used / Then subject and body are resolved from the snapshot in the document language, the contact's invoice address is offered, the clipboard receives the text, and no `sendLog` or status change happens | E | SND-19 |
| T-SND-015 | Given 5 selected invoices (one `MUST_E`) / When „Sammel-Markierung“ with channel `post` runs / Then 4 are `sent` with one row each, the `MUST_E` one is skipped with `must_e_channel_not_electronic` | C | SND-20, SND-17 · ER-03 |
| T-SND-016 | Given an invoice exported on 2026-10-12 and not marked / When `deadlines.notify` runs on 2026-10-13 and 2026-10-14 / Then no to-do, then the to-do „Exportiert, aber nicht als versendet markiert“; marking closes it; an archive ZIP (`pdf_zip`) or „Ansehen“ alone creates none | C | SND-21 · MAHN-01 · EC-196 |
| T-SND-017 | Given first marks with each channel on 2026-10-12 (post days = 3) / When the Zugang is derived / Then `email_manual`/`upload_portal`/`hand` → 2026-10-12, `post` → 2026-10-15, `other` → 2026-10-15; an unmarked invoice has no Zugang and is excluded from dunning proposals (F05) | U,C | SND-23 · MAHN-01 · EC-196 |
| T-SND-018 | Given an MCP key / When `document_export` is called / Then only short-lived tailnet links are returned and no outbound transmission happens; `document_mark_sent` without token → `confirm_token_required`, with a token from `document_preview` → `confirm_token_intent_mismatch`, with a token from `preview_action{action:"document_mark_sent"}` → marked; without `invoices:send` → 403; no MCP tool can retract a mark | C | SND-24 · SEC-02 · EC-188, EC-189 |

### 8.2 Golden files (`test/golden/cases/<case-id>`, 07 §4)

Each case: snapshot JSON, CII (ZUGFeRD EN16931), UBL (XRechnung) where applicable, PDF text, DATEV lines, UStVA contribution; KoSIT "acceptable", Mustang valid, veraPDF PDF/A-3b valid; PDF amounts equal XML amounts (for 381 documents compared as absolute values with the type check).

| Test ID | Case | Content (numbers in €) | Type | Covers req IDs |
|---|---|---|---|---|
| T-GLD-01 | `de-19-standard` | 10 h × 100,00 @19 → 1.000,00 / 190,00 / 1.190,00, Skonto, EPC QR | G,V | INV-01, DOC-51 · UST-03…10, MISC-01 |
| T-GLD-02 | `de-7-and-19-mixed` | 1.000,00 @19 + 500,00 @7 → VAT 190,00 + 35,00 | G,V | DOC-14 · UST-09, UST-10 |
| T-GLD-03 | `de-rounding-10005` | 3 × 10,005 → 10,01 each, base 30,03, VAT 5,71, gross 35,74 (App. E.2) | G,V | DOC-09 · UST-10 |
| T-GLD-04 | `de-document-discount` | 1.000,00 @19 + 500,00 @7, 100,00 discount → bases 933,33 / 466,67, VAT 177,33 / 32,67, gross 1.610,00 | G,V | DOC-07 · UST-09 · EC-055 |
| T-GLD-05 | `de-gross-mode-b2c` | App. E.3 example → net 111,57, VAT 18,80, gross 130,37 (+ §286 note) | G,V | DOC-10 · MISC-03, MAHN-01 · EC-053 |
| T-GLD-06 | `de-gross-unreachable` | 6,29 € gross @19 → 5,28 / 1,00 / 6,28 + warning | U,G | DOC-10 · UST-10 · EC-053 |
| T-GLD-07 | `de-pv-zero-rate` | PV system 8.000,00 Z 0 % + note § 12 Abs. 3 | G,V | UST-15 |
| T-GLD-08 | `de-restaurant-2025-vs-2026` | catering supplied 2025-12-31 @19 vs 2026-01-01 food @7 + drinks @19 | G,V | DOC-13 · UST-15 |
| T-GLD-09 | `de-exempt-4-14` | therapy 300,00 E VATEX-EU-132 + note "§ 4 Nr. 14" | G,V | UST-10 · EC-048 |
| T-GLD-10 | `ku-invoice` | KU B2C 2 × 500,00, no VAT, KU note; XML (opt-in) category E + BT-120 | G,V | INV-24 · KU-02 |
| T-GLD-11 | `eu-b2b-service-at` | consulting 2.000,00 AE, both VAT IDs, VATEX-EU-AE, bilingual note | G,V | UST-20 |
| T-GLD-12 | `intra-community-supply-fr` | goods 5.000,00 K, delivery FR, BT-80, BT-72, VATEX-EU-IC | G,V | UST-21 |
| T-GLD-13 | `advance-and-final` | App. E.4 case A → BT-113 3.570,00, BT-115 8.330,00 | G,V | INV-06, INV-09 · UST-40, UST-41 |
| T-GLD-14 | `advance-rate-change` | App. E.4 case B → BT-112 1.070,00, BT-113 1.190,00, BT-115 −120,00 | G,V | INV-08 · UST-41 · EC-073 |
| T-GLD-15 | `advance-skonto-final` | App. E.4 case D → payable 8.401,40 | G | INV-06 · UST-41, UST-32 |
| T-GLD-16 | `reverse-charge-13b-construction` | 10.000,00 AE, "§ 13b" note, buyer HRB as BT-47 | G,V | UST-22 |
| T-GLD-17 | `storno-full` | mirror of T-GLD-01, TypeCode 381, BT-25/26 | G,V | INV-10 · UST-30 |
| T-GLD-18 | `correction-partial` | −2 h → −200,00 / −38,00 / −238,00, TypeCode 381 positive amounts | G,V | INV-12 · UST-30, UST-33 |
| T-GLD-19 | `rectification-address` | AE invoice without customer VAT ID corrected, 384 + BG-3 | G,V | INV-13 · UST-31 |
| T-GLD-20 | `export-ch` | goods 3.000,00 G, delivery CH, VATEX-EU-G | G,V | UST-23 |
| T-GLD-21 | `not-taxable-us-service` | IT service 4.000,00 O to US business, no BT-31/BT-48, BT-32 present | G,V | UST-23 |
| T-GLD-22 | `kleinbetrag-250` / `kleinbetrag-250.01-rejected` | 250,00 accepted; 250,01 `kleinbetrag_not_allowed` | G,U | DOC-44 · UST-14 |
| T-GLD-23 | `b2g-leitweg-xrechnung-ubl` | XRechnung UBL, BT-10 `04011000-1234512345-06`, BT-49 scheme 0204 | G,V | INV-22 · ER-10, ER-20 |
| T-GLD-24 | `foreign-currency-usd` | 1.000,00 USD @19, rate 1.0831 → BT-111 175,42 EUR | G,V | DOC-15 · MISC-08 |
| T-GLD-25 | `ist-2028-note` (2028-01-02) vs `ist-2027` (2027-12-31) | note present only in 2028 (PDF + BT-22) | G,V | INV-25 · UST-13 |
| T-GLD-26 | `labor-cost-35a` | B2C 800,00 labour + 400,00 material @19 → labour subtotal 800,00 + 152,00 = 952,00 | G | DOC-47 · MISC-07 |
| T-GLD-27 | `property-b2c-14b-note` | B2C property service with §14b note | G | DOC-46 · UST-12 |
| T-GLD-28 | `gmbh-footer` / `ek-footer` | footers per F01 §5.2 | G | DOC-31 · MAIL-03 |
| T-GLD-29 | `recurring-monthly-period` | BG-14 01.11.–30.11.2026, BT-12 | G,V | REC-09 · ER-04 |
| T-GLD-30 | `skonto-2-14` | BT-20 syntax line + PDF text | G,V | DOC-50 · UST-09 |
| T-GLD-31 | `quote-optional-positions` | quote with optional lines excluded from totals, validity | G | QUO-01, QUO-02 |
| T-GLD-32 | `order-confirmation` / `delivery-note-unpriced` / `proforma` | non-invoice types: no XML, PDF/A-3b valid, footer | G,V | QUO-08, QUO-09, QUO-12 · MAIL-03 |
| T-GLD-33 | `partial-invoice-gross` | App. E.5 gross example, TypeCode 326 | G,V | INV-04 · UST-40 |
| T-GLD-34 | `self-billing-commission` (P3) | 5.000,00 + 950,00, TypeCode 389, "Gutschrift" | G,V | INV-16 · UST-11 |
| T-GLD-35 | `copy-stamp` | re-render of T-GLD-01 with "Kopie"; original hash unchanged | G | DOC-32 · UST-34 |
| T-GLD-36 | `en-eu-service` | EN layout of T-GLD-11 with bilingual notes | G,V | DOC-16 · UST-20 |
| T-GLD-37 | `ku-threshold-crossing` | crossing invoice issued with VAT after the dialog | G,C | INV-24 · KU-01 · EC-060 |

### 8.3 Table-driven suites

| Test ID | Suite | Type | Covers |
|---|---|---|---|
| T-TAB-01 | Tax-case derivation: every row of App. C.2 (≥ 40 cases incl. XI/GB, CH property, EU without VAT ID, KU) | U | DOC-11 · UST-20…23, KU-02 · EC-042, EC-043, EC-046 |
| T-TAB-02 | Allowed categories per tax case App. C.3 × all categories | U | DOC-12 · UST-10, UST-34 |
| T-TAB-03 | ER-03 App. D.4 cases ER03-01…ER03-33 | U | INV-18 · ER-03 · EC-029 |
| T-TAB-04 | Mark-sent matrix App. D.3: decision × channel × handed-over files (structured e-invoice yes/no) × consent states | U | SND-03, SND-17 · MAIL-01, ER-03 |
| T-TAB-05 | TypeCode per type and construction flag (App. A.2) | U | INV-19 · ER-01 |
| T-TAB-06 | Every §5.1 code: one positive and one negative fixture | U | DOC-20 · GOBD-03 |

### 8.4 Edge-case tests (one per §5.2 row)

| Test ID | Given / When / Then | Type | Covers req IDs |
|---|---|---|---|
| T-EC-001 | Given a previewed draft / When a managing director is removed before commit / Then 409 `revalidation_failed`, counter unchanged | C | DOC-24 · MAIL-03 · EC-004 · RI-02 |
| T-EC-002 | Given a previewed draft / When the contact becomes a consumer before commit / Then 409 `revalidation_failed`; after re-preview gross display and §286 note | C | DOC-22 · UST-03 · EC-004 |
| T-EC-003 | Given a draft / When finalize is called twice concurrently and once more later (same and different Idempotency-Key) / Then one number; replays return it | C | DOC-24 · UST-06 · EC-002 · RI-02 |
| T-EC-004 | Given an MCP preview token / When the draft is edited in the UI and `document_finalize` is called / Then `preview_outdated` | C | DOC-24 · GOBD-06 · EC-003 |
| T-EC-005 | Given 1,000 drafts / When finalised in parallel / Then 1,000 unique consecutive numbers | C | DOC-25 · UST-06 · EC-001 · RI-02, RI-03 |
| T-EC-006 | Given counter 9999 with `{####}` / When finalised twice / Then `RE-2026-9999`, `RE-2026-10000` | U,C | DOC-25 · UST-06 · EC-011 |
| T-EC-007 | Given issued `RE-0001…0005` / When the format changes to `RE-{YYYY}-{####}` / Then the next number uses the new format and no renumbering happens | C | DOC-25 · UST-06 · EC-008 |
| T-EC-008 | Given the only invoice range deactivated during a pending finalise / When commit runs / Then 409 `number_range_missing` | C | DOC-25 · UST-06 |
| T-EC-009 | Given yearly reset / When a draft is finalised on 2027-01-02, and another backdated to 2026-12-30 / Then `RE-2027-0001` and the next 2026 number | C | DOC-25, DOC-26 · UST-05, UST-06 · EC-010 |
| T-EC-010 | Given an imported `RE-2026-0042` / When the counter renders it / Then 409 `number_conflict`, counter not advanced | C | DOC-25 · UST-06 · EC-014 |
| T-EC-011 | Given commits at 2026-10-24T21:59:59.900Z and 2026-10-24T22:00:00.100Z, and around 2026-03-29 01:59/03:00 Berlin / When finalised / Then document dates 2026-10-24, 2026-10-25 and the Berlin dates around the DST switch | U,C | DOC-26 · UST-05, GOBD-22 · EC-020 |
| T-EC-012 | Given a mocked clock skew of 90 s / When finalising / Then 503 `clock_skew` | C | DOC-59 · GOBD-22 · EC-027 |
| T-EC-013 | Given window 10 days / When dates −11 (no reason), −11 (reason), −200 days, 2026-12-30 on 2027-01-05, and a locked month are used / Then reason error, success + audit, warning, old-year counter, `backdate_period_locked` | C | DOC-26 · UST-05, GOBD-06 · EC-022 · RI-13 |
| T-EC-014 | Given tomorrow's date via UI, API and MCP / When finalising / Then `document_date_future` | U,C | DOC-26 · UST-05 · EC-021 |
| T-EC-015 | Given an invoice with supply 2026-11-01 on 2026-10-12 / When validated / Then `supply_date_in_future`; as advance invoice → OK; period 2026-10-01…2026-12-31 → info only | U | INV-01, INV-03 · UST-08, UST-40 · EC-023 |
| T-EC-016 | Given one catering line 2025-12-15…2026-01-15 / When validated / Then `supply_period_crosses_rate_change`; split into two line periods → 19 % and 7 % | U | DOC-13, DOC-21 · UST-15 · EC-024 · RI-22 |
| T-EC-017 | Given KU until 2026-08-14 and a period 2026-08-01…31 / When validated / Then `supply_period_crosses_ku_change` | U | INV-24 · KU-01 · EC-025 |
| T-EC-018 | Given a supply 7 months ago / When finalised / Then warning and audit note "verspätet" | C | INV-01 · UST-01 · EC-026 |
| T-EC-019 | Given a 2025 quote at 19 % food / When converted with supply 2026-02-01 / Then 7 % and `rate_changed_notice`; quote PDF hash unchanged | C | DOC-33 · UST-15 · EC-040 |
| T-EC-020 | Golden T-GLD-14 plus the UStVA contribution (7 %: +1.000/+70; 19 %: −1.000/−190) | G | INV-08 · UST-41 · EC-073 · RI-05, RI-08 |
| T-EC-021 | Given a draft using a product whose rate key changes / When reopened / Then re-resolved with notice; a finalised doc unchanged | C | DOC-13 · UST-15 · EC-041 · RI-22 |
| T-EC-022 | Given KU cumulative 99.500 € / When a 1.000 € invoice is finalised / Then 409 `ku_threshold_crossed`; after confirming, the history has a regular entry from the supply date and the re-previewed invoice carries 19 % VAT | C,E | INV-24 · KU-01 · EC-060 · RI-17 |
| T-EC-023 | Given a founding-year KU company at 24.900 € / When a 200 € invoice is finalised / Then the dialog appears (25.000 € cap) | C | INV-24 · KU-01 · EC-066 |
| T-EC-024 | Given a KU company / When the UI override, API and MCP try a 19 % line / Then `ku_vat_not_allowed` everywhere | C | INV-24 · KU-03 · EC-063 |
| T-EC-025 | Given prior-year turnover 25.000,01 € and KU history / When a KU invoice is finalised / Then `ku_status_outdated` | C | INV-24 · KU-01 · EC-061 |
| T-EC-026 | Given a quote to a business / When the contact becomes a consumer and the quote is converted / Then gross mode suggested, §286 note on the invoice, tax-case notice | C | DOC-33 · MISC-03, MAHN-01 · EC-080 |
| T-EC-027 | Given an AT business without VAT ID buying a service / When derived / Then domestic + `no_vat_id_foreign_business`; override to EU case → `buyer_vat_id_missing` | U | DOC-11 · UST-20 · EC-043 |
| T-EC-028 | Given VAT ID `ATU1234567` (bad format) and a VIES-invalid ID / When finalising AE/K / Then `buyer_vat_id_invalid_format` / `buyer_vat_id_not_verified` | U,C | INV-28 · UST-20, MISC-04 · EC-043 · RI-16 |
| T-EC-029 | Given VIES `MS_UNAVAILABLE` (MSW) / When finalising AE without override / Then blocked; with reason → finalised, follow-up task created, audit entry | C | INV-28 · MISC-04 · EC-044 · RI-16 |
| T-EC-030 | Given a qualified check with name = B / When finalising K / Then override reason required | C | INV-28 · MISC-04, UST-21 · EC-045 |
| T-EC-031 | Given VAT ID `DE…` on an EU case override / When validated / Then `buyer_vat_id_domestic` | U | INV-28 · UST-20 |
| T-EC-032 | Given an FR VAT ID and delivery to Munich / When derived / Then domestic 19 %; override to igL → `igl_delivery_country_invalid` | U | DOC-11, DOC-23 · UST-21 · EC-042 |
| T-EC-033 | Given an `XI` VAT ID with goods → K; a GB business with a service → O | U | DOC-11 · UST-21, UST-23 |
| T-EC-034 | Given a CH business and an event-admission product in Berlin / When derived / Then domestic 19 %; a service without rule → `place_of_supply_ambiguous` | U | DOC-11 · UST-23 · EC-046 |
| T-EC-035 | Given §13b with an expired USt 1 TG / When finalising / Then warning; finalisation requires the audited confirmation | C | INV-29 · UST-22 · EC-047 |
| T-EC-036 | Given §13b and a consumer / When validated / Then `rc13b_consumer` | U | INV-29 · UST-22 |
| T-EC-037 | Given §13b ZUGFeRD and a buyer without VAT ID/HRB / When validated / Then `rc_buyer_id_missing_xml`; with HRB → KoSIT acceptable | U,V | INV-29 · UST-22 |
| T-EC-038 | Given metal scrap (§13b product) + other goods / When finalised / Then groups S 19 and AE, both notes, KoSIT acceptable | G,V | DOC-14 · UST-22 · EC-049 |
| T-EC-039 | Given taxable + §4 Nr. 14 lines / When finalised / Then two groups and the exemption note | G,V | DOC-14 · UST-10 · EC-048 |
| T-EC-040 | Given an O line plus an S line / When validated / Then `category_o_mixed` | U | DOC-12 · UST-23 |
| T-EC-041 | Given a §25a request via API / When creating / Then `margin_scheme_blocked` | U | DOC-45 · UST-24 · EC-056 |
| T-EC-042 | Given EU B2C sales 9.950 € this year / When a 100 € EU B2C invoice is finalised / Then `oss_threshold_exceeded` | C | DOC-45 · UVA-07 · EC-057 |
| T-EC-043 | Given Kleinbetrag 250,00 / 250,01 / 200,00 §13b / When validated / Then OK / blocked / blocked; ER-03 for §13b 200 € in 2028 = `MUST_E` | U | DOC-44 · UST-14, ER-03 |
| T-EC-044 | Given a free line 0,00 € / When finalised / Then BT-131 0.00 and category present | G,V | DOC-09 · UST-10 · EC-050 |
| T-EC-045 | Given advances covering the total / When the final is finalised / Then payable 0, `paid`, no QR, BT-115 0.00, KoSIT acceptable | G,V | INV-06 · UST-41 · EC-051 |
| T-EC-046 | Given a 0,00 € invoice / When finalised / Then `total_zero` warning and status paid | C | INV-01 · EC-051 |
| T-EC-047 | Given an invoice with gross −10,00 / When validated / Then `total_negative`; a final with payable −120 → OK | U | DOC-09 · UST-30, UST-41 · EC-052 |
| T-EC-048 | Given a −5,00 deposit line on a 100,00 invoice / When finalised / Then warning only; XML line −5.00 | G,V | DOC-04 · UST-30 |
| T-EC-049 | T-GLD-06 plus property test: for all gross G (0…100.000 cents) and rates 7/19, VAT = round(N × r) and \|G − gross\| ≤ 1 | U | DOC-10 · UST-10 · EC-053 · RI-05 |
| T-EC-050 | Given line discount 10 %, document discount 5 %, Skonto 2 % / When finalised / Then App. E order; BT-20 Skonto only | G,V | DOC-07, DOC-50 · UST-09 · EC-054 |
| T-EC-051 | T-GLD-04 | G,V | DOC-07 · UST-10 · EC-055 |
| T-EC-052 | Given USD invoice with groups 19/7 / When EUR VAT computed / Then per-group rounding then sum; Kleinbetrag test in EUR | U | DOC-15, DOC-56 · MISC-08 |
| T-EC-053 | Given no FX rate → `fx_rate_missing`; BMF month unpublished → ECB fallback with info and stored source | C | DOC-15 · MISC-08 |
| T-EC-054 | Given currency JPY / When creating / Then `currency_unsupported` | U | DOC-15 · MISC-08 |
| T-EC-055 | Given an unpaid advance / When the final wizard runs without decision → `advance_not_settled`; with "Stornieren" → advance cancelled, not deducted; an API/MCP request that tries to finalise with the unpaid advance left open (the withdrawn "nicht abziehen") → 422 `advance_not_settled` | C,E | INV-07 · UST-41, UST-34 · EC-070 · RI-08 |
| T-EC-056 | Given an advance 3.570,00 paid 1.785,00 / When the final is finalised without correction → 422 `advance_not_settled` (UI, API, MCP); when the wizard creates the Rechnungskorrektur (−1.500,00 / −285,00 / −1.785,00) → the advance is `paid` with open 0, the final deducts 1.500,00 / 285,00 / 1.785,00 and finalises; Σ (advance + correction) = deduction per group, RI-07/RI-08 green | G,C | INV-07 · UST-41, UST-34 · EC-071 · RI-08 |
| T-EC-057 | Given a cancelled advance / When the final is built / Then it is listed "storniert – nicht abgezogen" and not deducted | C | INV-06 · UST-41 |
| T-EC-058 | Given an advance deducted in a final / When cancelled / Then `storno_advance_deducted` | C | INV-11 · UST-41 · EC-072 |
| T-EC-059 | T-GLD-15 | G | INV-06 · UST-41, UST-32 · RI-08 |
| T-EC-060 | Given a final exists → second final `final_exists`; after Storno of the final a new final deducts the advances again | C | INV-07 · UST-41 · RI-08 |
| T-EC-061 | Given advances of 60 % and 50 % / When the second is created / Then `partial_exceeds_order` | U | INV-04 · UST-40 · EC-078 |
| T-EC-062 | Given a partially paid invoice / When cancelled via UI, API, MCP / Then `storno_paid_invoice` with both paths | C | INV-11 · UST-30 · EC-074 |
| T-EC-063 | Given a Storno / When cancel is attempted (API) / Then `storno_of_storno`; UI has no action | C | INV-11 · UST-30 · EC-075 · RI-06 |
| T-EC-064 | Given a correction / When `correct` targets it → `correction_target_invalid`; a second credit on the original lists the first as BG-3 and is accepted while Σ ≥ 0 | C,V | INV-15 · UST-30 · EC-075 · RI-07 |
| T-EC-065 | Given remaining 238,00 / When a credit of 300,00 / Then `correction_exceeds_original` | U | INV-12 · UST-30 · RI-07 |
| T-EC-066 | Given a cancelled invoice / When `correct` / Then `already_cancelled` | C | INV-12 · UST-30 |
| T-EC-067 | Given a rectification with a changed price / When validated / Then `rectification_amount_changed` | U | INV-13 · UST-30, UST-31 · EC-081 |
| T-EC-068 | Given an invoice in locked September / When cancelled on 2026-10-12 / Then Storno dated 2026-10-12, journal in October | C | INV-10 · GOBD-06 · EC-076 · RI-13 |
| T-EC-069 | Given a dunning case at level 2 / When the invoice is cancelled / Then the case is closed, reminders remain archived | C | INV-10 · UST-30 · EC-077 |
| T-EC-070 | Given the company renamed after the invoice / When a Storno is created / Then its seller block equals the original snapshot | C,G | INV-10 · UST-03, UST-30 |
| T-EC-071 | Given an accepted quote / When revise or PATCH / Then `quote_accepted_frozen` / 409 | C | QUO-07 · GOBD-06 · EC-079 |
| T-EC-072 | Given a delivery note in a finalised invoice / When selected again / Then `delivery_note_already_invoiced` | C | QUO-11 · UST-34 |
| T-EC-073 | Given an identical invoice 5 days ago / When validated / Then `possible_duplicate` | U | DOC-43 · UST-34 |
| T-EC-074 | Given `MUST_E` and preference `pdf` / When the export dialog opens / Then no PDF-only entry is offered, the XML exists, and a mark with only a plain PDF is blocked | E | INV-17, SND-03, SND-17 · ER-03 · EC-090 · RI-18 |
| T-EC-075 | Given 2026 B2B without consent and format `none` / When marked as sent via `email_manual` with the PDF / Then `pdf_consent_required`; via `post` → `sent`; after recording consent (source e-mail) the `email_manual` mark succeeds | C,E | SND-03 · MAIL-01 · EC-091 |
| T-EC-076 | Given a public customer with `991-01234-44` (research example, wrong check digits) / When finalising / Then `leitweg_id_checksum` and nothing is committed; with `991-01234-38` → finalised with BT-10 = `991-01234-38` | U | INV-22 · ER-20 · EC-092 · RI-25 |
| T-EC-077 | Given B2B XRechnung without references / When rendered / Then BT-10 = contact number fallback and KoSIT acceptable | V | INV-22 · ER-10 · EC-093 |
| T-EC-078 | Given no company phone / When finalising with an E format / Then `seller_contact_missing`; with format `none` (allowed by ER-03) → OK | U | INV-19 · ER-10 · EC-094 |
| T-EC-079 | Given 2,000 lines with 5,000-char descriptions / When finalised / Then full texts in XML, PDF paginated, ≤ 60 s; 2,001 lines → `too_many_lines`; 1,000 lines ≤ 30 s | C,perf | DOC-30 · ER-01 · EC-095 |
| T-EC-080 | Given a name with a control char and an emoji / When saved and finalised / Then the control char is stripped, the emoji renders "□" with warning, XML keeps it, veraPDF valid | U,V | DOC-58 · ER-11 · EC-096 |
| T-EC-081 | Given the sidecar down / When finalising an E-format invoice → 503 before commit; a quote or a `NOT_REQUIRED` invoice with format `none` → finalised | C | INV-20 · ER-12 · EC-007 |
| T-EC-082 | Given rendering fails 5 times after commit / When retries end / Then `blocked`, alert, number kept, sending disabled | C | DOC-28 · UST-06, ER-12 · EC-005, EC-006 · RI-01, RI-18 |
| T-EC-083 | Given an archived invoice / When a newer KoSIT config is deployed / Then nothing is regenerated and old reports remain | C | INV-20 · ER-12 · EC-100 |
| T-EC-084 | **Withdrawn (v1.1)** — B2: no SMTP (EC-DOC-84 withdrawn). Replaced by T-EC-111…114. | — | — |
| T-EC-085 | = T-DOC-021 | C | DOC-32 · UST-34 · EC-099 |
| T-EC-086 | Given 2027 B2B and no confirmed 2026 figure, running total 750k / When previewed / Then `PDF_NEEDS_CONSENT` + `turnover_provisional`; running total 810k → `MUST_E` | U | INV-18 · ER-03 · EC-029 |
| T-EC-087 | ER03-08 / ER03-09 rows | U | INV-18 · ER-03 |
| T-EC-088 | Given a ZUGFeRD invoice from 2026 / When corrected / Then the correction decision is `MUST_E` and the format is XML | U,C | INV-18 · ER-04, ER-03 |
| T-EC-089 | Given a 2026 PDF invoice / When cancelled in 2028 / Then decision `PDF_NEEDS_CONSENT` (original reference date) | U | INV-18 · ER-03 |
| T-EC-090 | = T-GLD-25 | G | INV-25 · UST-13 · EC-028 |
| T-EC-091 | Given an MCP client without confirmation UI and a prompt asking to send all invoices to another address / When the tool list is inspected and `document_mark_sent` is called without token / Then no send tool exists, `document_export` only yields owner links, and the mark is refused (`confirm_token_required`) | C | SND-24 · SEC-02 · EC-188, EC-189 |
| T-EC-092 | Given a weekly template and a 20-day outage → 3 occurrences auto-finalised with today's date and their own periods; a 30-day outage → 4 drafts + notification | C | REC-06 · ER-04, UST-05 |
| T-EC-093 | Given the job executed twice / When inspected / Then one invoice per occurrence | C | REC-05 · ER-04 |
| T-EC-094 | Given a period crossing a rate change / When generated / Then split draft, no automation, notification | C | REC-15 · UST-15, KU-01 · EC-024 |
| T-EC-095 | **Withdrawn (v1.1)** — B2: no recurring auto-send (EC-DOC-95 withdrawn). Replaced by T-REC-012. | — | — |
| T-EC-096 | = T-REC-002 (+ contiguous period assertion) | U | REC-02 · ER-04 |
| T-EC-097 | Given the IBAN changed after issue / When a copy is downloaded / Then the old IBAN and QR appear; a new draft uses the new account | C,G | DOC-32 · MISC-01, UST-34 · EC-114 |
| T-EC-098 | Given a new layout version and logo / When a copy of an old invoice is rendered / Then the original layout version and logo are used | C,G | DOC-54 · GOBD-06 · EC-110 |
| T-EC-099 | Given `{{contact.foo}}` in a head text / When finalising / Then `placeholder_unknown` | U | DOC-17 |
| T-EC-100 | Given an unacknowledged RI ERROR / When finalising any type / Then 409 `integrity_alert_open` | C | DOC-60 · GOBD-06 · EC-182 |
| T-EC-101 | Given 61 days B2B / 31 days public / When validated / Then the two warnings | U | DOC-50 · MAHN-04 |
| T-EC-102 | Given a proforma converted and invoiced / When converted again / Then blocked | C | QUO-12 · UST-34 |
| T-EC-103 | (P3) Given a supplier without agreement / When finalising a self-billing / Then `self_billing_agreement_missing` | C | INV-16 · UST-33 |
| T-EC-104 | Given quantity 999.999,999 × 9.999.999,9999 € / When computed / Then BigInt result and `amount_too_large` | U | DOC-09 · GOBD-03 |
| T-EC-105 | Given supply month 2026-01 and an injected rate change on 2026-01-15 / When validated / Then the split error | U | DOC-21 · UST-15 · EC-024 |
| T-EC-106 | Given an archived contact with a draft / When finalised / Then OK with warning and complete snapshot | C | DOC-22 · UST-03 · EC-112 |
| T-EC-107 | Given a KU advance 1.000,00 paid / When the final 3.000,00 / Then deduction 1.000,00 gross, no VAT anywhere | G | INV-06 · KU-02, UST-41 · RI-17 |
| T-EC-108 | Given a contact with country DE and a foreign VAT ID / When derived / Then domestic with the establishment warning | U | DOC-11 · UST-20 |
| T-EC-109 | Given a B2C or US recipient with ZUGFeRD / When decided / Then `NOT_REQUIRED` and sending ZUGFeRD is allowed | U | INV-18 · ER-03 |
| T-EC-110 | Given an unsent blocked invoice / When "Stornieren und neu erstellen" and the Storno XML also fails / Then Storno with format `none` and audit note; new draft created | C | INV-10 · ER-12, UST-30 · EC-006 |
| T-EC-111 | Given an invoice finalised on 2026-10-12 / When marked with `sentOn` 2026-10-11 or 2026-10-13 (today 2026-10-12) via UI, API and MCP preview / Then `mark_sent_date_before_finalization` / `mark_sent_date_future`; a document backdated to 2026-10-05 but finalised 2026-10-12 still cannot be marked before 2026-10-12 | U,C | SND-07 · MAIL-02 · EC-195 |
| T-EC-112 | Given an invoice exported but never marked, due date passed / When the dunning proposal and the Verzug computation run (F05) / Then no Zugang, no Verzug, not proposed for dunning; status „Nicht versendet“ with badge „exportiert“; to-do after 2 days | C | SND-21, SND-23 · MAHN-01 · EC-196 |
| T-EC-113 | Given a `MUST_E` XRechnung invoice / When marked via `hand` with the XML, via `email_manual` with only the Lesefassung, then via `upload_portal` with the XML, then additionally via `post` / Then blocked, blocked, `sent`, appended | C | SND-17 · ER-03 · EC-197 |
| T-EC-114 | = T-SND-013 (+ a quote that was accepted after the mark: retraction of the effective mark → `retraction_blocked_dependent`) | C | SND-18 · GOBD-06 · EC-198 |
| T-EC-115 | Given two invoices / When REST `mark-sent` on A lists an artifact of B, or A's artifact with a wrong sha256 / Then 422 `mark_sent_artifact_unknown`, no row written | C | SND-22 · MAIL-02, GOBD-06 |
| T-EC-116 | Given an invoice exported but not marked / When the Storno dialog opens / Then the "exportiert, aber nicht als versendet markiert" warning is shown and the success step offers „Exportieren“; for a never-exported invoice the "muss nicht versendet werden" note | E | INV-10 · UST-30, UST-34 |

## 9. Open questions

| # | Question | Decided default (B5: conservative; the owner files without a Steuerberater) | Owner |
|---|---|---|---|
| 9.1 | BR-DE-17 code list (01 open item 8): are 326 (partial/advance) and 875/876/877 (construction) accepted; is 386 (prepayment) allowed; Storno as 381 vs 384? | 326 / 380 / 381 as in §4.1; verified technically with the KoSIT bundle in the P0 spike (golden T-GLD-13/17/33); if 326 is rejected, fall back to 380 with the „Abschlagsrechnung“ title and BT-22 note | Lead (P0 spike) |
| 9.2 | VAT category/VATEX for Kleinunternehmer XML (01 open item 2) | **Decided:** category E, rate 0, BT-120 = KU note, no BT-121; KU default format `none`; ⚖ LEGAL-OPEN 01 open item 2 (`// LEGAL-OPEN: 01 open item 2`) stays until a KoSIT/BMF statement exists (one-off check by a Steuerberater before go-live recommended, non-blocking) | Decided (B5) |
| 9.3 | Is an amount-based `partial_invoice` always an Anzahlung (Mindest-Ist, deducted in the final), as UST-40 states, or can it be a Teilleistung? | **Decided:** Anzahlung (VAT at receipt under Mindest-Ist — the earlier, safer tax point); Teilleistungen are billed quantity-based as normal invoices (INV-05) (one-off check by a Steuerberater before go-live recommended, non-blocking) | Decided (B5) |
| 9.4 | Does KoSIT accept a 380 final invoice with negative BT-115 (rate-change refund)? | Assumed yes (no EN 16931 rule forbids it); if rejected, the remainder is issued as a separate Rechnungskorrektur referencing the final invoice | P0 spike |
| 9.5 | ER-03 reference date for advance invoices: document date (VAT event = payment) or expected supply date? | **Decided:** evaluate ER-03 with both the document date and the expected supply date (when set) and apply the **stricter** decision (an E-Rechnung is always allowed, so this can never produce a defective invoice); without an expected supply date the document date is used (App. D.1). ⚖ **LEGAL-OPEN**, tracked as 01 open item 11 (code comment `// LEGAL-OPEN: 01 open item 11`) (one-off check by a Steuerberater before go-live recommended, non-blocking) | Decided (B5) |
| 9.6 | REST resource and ID prefix for self-billing (`/self-billing`, `sbc_`) | **Resolved:** added to 05 §3/§4.3 | Lead |
| 9.7 | Proforma under `/invoices?invoice_type=proforma` (prefix `inv_`) vs its own resource | **Resolved:** under `/invoices` (05 §4.3), excluded from revenue/open items | Lead |
| 9.8 | Artifact kinds for "Kopie" and "Lesefassung" PDFs (needed for MAIL-02 hashes) | **Resolved:** stored as `pdf` with `variant: "copy" \| "reading"`; Kopie exports are archived on first generation so their hash enters the dispatch record (DOC-32, SND-22; data-model delta G) | Lead |
| 9.9 | FX source: BMF monthly average (§16 Abs. 6 UStG) as default, ECB daily only with Finanzamt approval? | **Decided:** BMF monthly rate is the default; `ecb_daily`/`manual` keep the warning `fx_rate_source_daily` and require the source text; ECB fallback (with info, source stored) only while the BMF month is unpublished (one-off check by a Steuerberater before go-live recommended, non-blocking) | Decided (B5) |
| 9.10 | UST-13 note on KU invoices and its XML location (01 open item 1) | **Decided:** not printed for KU (KU invoices show no VAT, so the Ist note has no object); for non-KU Ist companies XML BT-22 subject `REG`; ⚖ LEGAL-OPEN 01 open item 1 stays (one-off check by a Steuerberater before go-live recommended, non-blocking) | Decided (B5) |
| 9.11 | KU company providing services to EU businesses: `eu_b2b_service` (with own VAT ID) or `not_taxable_domestic`; ZM duty? | **Decided:** `eu_b2b_service` if the company has a VAT ID (ZM duty applies, F08), else blocked with guidance „Für Leistungen an Unternehmer im EU-Ausland benötigen Sie eine USt-IdNr.“ (block rather than guess) (one-off check by a Steuerberater before go-live recommended, non-blocking) | Decided (B5) |
| 9.12 | Gross mode, unreachable group gross: keep the 1-cent deviation (current) or use BT-114 rounding amount so the payable equals the entered gross exactly (10 EC-053 wording)? | Deviation + warning (keeps RI-05 strict and accounting simple) | Owner |
| 9.13 | Translated product names/descriptions for EN documents | Not in v1; the owner edits line texts | Owner |
| 9.14 | 10 EC-070 "nicht abziehen" option for unpaid advances | **Resolved:** option removed (double claim / §14c risk). Unpaid advances must be cancelled before the final invoice (INV-07, EC-DOC-55, 03 `deductions[]`); warning code `advance_not_deducted_confirm` withdrawn | Lead |

---

## Appendix A. EN 16931 mapping

### A.1 Field mapping (our model → BT/BG; CII and UBL via the serializer, ADR-007)

| Our field | BT / BG | Rule / notes |
|---|---|---|
| `number` | BT-1 | mandatory |
| `documentDate` | BT-2 | mandatory |
| type → TypeCode | BT-3 | A.2; BR-DE-17 |
| `currency` | BT-5 | mandatory |
| `"EUR"` if currency ≠ EUR | BT-6 | MISC-08 |
| `dueDate` (if payable > 0) | BT-9 | BR-CO-25: BT-9 or BT-20 required when BT-115 > 0 |
| buyer reference | BT-10 | A.3; BR-DE-15 (XRechnung only) |
| project number (P4) | BT-11 | optional |
| `contractReference` / recurring template reference | BT-12 | ER-04 |
| `orderReference` | BT-13 | customer PO |
| our order confirmation number in the chain | BT-14 | |
| delivery note number (single) | BT-16 | several notes → BT-22 note |
| payment terms text + Skonto lines | BT-20 | A.4; BR-DE-18 |
| subject, head/foot text, legal notes, deduction table, UST-13 note | BG-1 (BT-21 subject code, BT-22 text) | codes: `AAI` general, `REG` legal/tax notes, `SUR` seller remarks |
| — | BT-23 | XRechnung UBL: `urn:fdc:peppol.eu:2017:poacc:billing:01:1.0` |
| profile | BT-24 | ZUGFeRD EN16931: `urn:cen.eu:en16931:2017`; XRechnung / ZUGFeRD XRECHNUNG: `urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0` |
| original number/date (cancellation, correction, Nachberechnung), deducted advances, earlier corrections | BG-3 (BT-25, BT-26) | one BG-3 per reference; BR-DE-26 for 384 |
| seller legal name / trade name | BT-27 / BT-28 | seller block from the snapshot |
| register number ("HRB 123456 B") | BT-30 | |
| company VAT ID | BT-31 | omitted on O-only documents (BR-O-02) |
| company tax number | BT-32 (scheme `FC`) | BR-DE-16: BT-31 or BT-32 for S/Z/E/AE/K/G |
| Geschäftsbrief items (court, managing directors, share capital) | BT-33 | MAIL-03 data in the XML |
| `electronicAddress` (scheme EM/0204/9930) | BT-34 | mandatory in XRechnung (PEPPOL-EN16931-R020) |
| seller address | BG-5 (BT-35…BT-40) | BT-37 city, BT-38 post code (BR-DE-3/4), BT-40 country |
| seller contact name/phone/e-mail | BG-6 (BT-41/42/43) | BR-DE-2/5/6/7 |
| buyer name / trade name | BT-44 / BT-45 | |
| contact number | BT-46 | |
| buyer register number | BT-47 | §13b fallback for BR-AE-02 |
| buyer VAT ID | BT-48 | K/AE mandatory; omitted on O-only |
| buyer electronic address | BT-49 | A.3 |
| buyer address | BG-8 (BT-50…BT-55) | BT-52/53 (BR-DE-8/9), BT-55 country |
| contact person | BG-9 (BT-56…58) | optional |
| delivery address | BG-13/BG-15 (BT-70, BT-75…BT-80) | BT-80 mandatory for K (BR-IC-12) and G |
| supply date `date` | BT-72 | UST-08 |
| supply `period` / `month` | BG-14 (BT-73/74) | month → first/last day |
| payment means code / text | BG-16 (BT-81/82) | A.5; BR-DE-1 |
| remittance information = payment reference | BT-83 | exactly the invoice number (DOC-51) |
| IBAN / account holder / BIC | BG-17 (BT-84/85/86) | BR-DE-19 IBAN check |
| SEPA mandate (P4) | BG-19 (BT-89/90/91) | |
| document discount / surcharge per VAT group | BG-20 / BG-21 (BT-92…105) | reason code 95 (discount) / `ZZZ` + text; one per group |
| totals | BG-22 (BT-106…BT-115) | A.6 for finals; BT-114 always 0.00 in v1 |
| EUR VAT | BT-111 | MISC-08 |
| VAT groups | BG-23 (BT-116…BT-121) | A.9 |
| attachments with `embedInXml` | BG-24 (BT-122…125) | |
| lines | BG-25: BT-126 position, BT-127 note, BT-129 quantity, BT-130 unit, BT-131 line net | headings/text/subtotals are not exported as lines; their text goes into the next line's BT-127 |
| line period | BG-26 (BT-134/135) | |
| line discount | BG-27 (BT-136 amount, BT-137 base, BT-138 percent, BT-139 reason) | net mode only (A.10) |
| unit price | BG-29 (BT-146 net price, BT-149 base quantity) | App. E.3 for gross mode |
| line category / rate | BG-30 (BT-151/152) | |
| item name / description / seller item no. | BG-31 (BT-153/154/155) | |

### A.2 TypeCodes

| Type | BT-3 | Construction flag | XML root (UBL) |
|---|---|---|---|
| invoice | 380 | 380 | Invoice |
| advance_invoice, partial_invoice | 326 | 875 | Invoice |
| final_invoice | 380 | 877 | Invoice |
| cancellation | 381 | 381 | CreditNote |
| correction credit | 381 | 381 | CreditNote |
| correction rectification | 384 | 384 | Invoice |
| self_billing (P3) | 389 | 389 | Invoice |
| quote, order, delivery note, proforma | no XML | | |

876 (partial final construction invoice) is not used. See open question 9.1.

### A.3 BT-10 and electronic addresses

- **B2G** (`isPublicAuthority`): BT-10 = Leitweg-ID (mandatory, Mod 97-10 checked, ER-20). BT-49 = contact `electronicAddress` if set, else scheme `0204` with the Leitweg-ID.
- **B2B, XRechnung formats** (`xrechnung_*`, `zugferd_xrechnung`): BT-10 = first non-empty of document `buyerReference` → contact `buyerReference` → `orderReference` → contact number → literal "nicht angegeben" (the last two steps configurable, 10 EC-093). BT-49 = contact `electronicAddress` → the invoice e-mail (scheme `EM`) → else `buyer_electronic_address_missing`.
- **ZUGFeRD EN16931**: BT-10 only if a real reference exists (document/contact buyer reference); BT-49 if known.
- BT-34 = company `electronicAddress` (default scheme `EM`, the invoice sender address).

### A.4 Payment terms (BT-20)

```
Zahlbar innerhalb von 30 Tagen ohne Abzug bis 11.11.2026.
#SKONTO#TAGE=14#PROZENT=2.00#BASISBETRAG=1190.00#
```
- One Skonto line per tier (v1: one tier), each starting at the beginning of a line and ending with `#` plus a line break; percent with exactly 2 decimals and a dot; `BASISBETRAG` = the payable amount (always written, because finals and partial deductions make the base differ from BT-112).
- No Skonto line if payable ≤ 0.

### A.5 Payment means (BT-81)

| Situation | BT-81 | BG-17/19 |
|---|---|---|
| transfer, SEPA IBAN, payable > 0 | 58 | BT-84 = company IBAN, BT-85 = account holder, BT-86 BIC |
| transfer, non-SEPA account or non-EUR | 30 | BT-84 = account number/IBAN |
| SEPA direct debit (P4) | 59 | BG-19 |
| cash | 10 | — |
| card | 48 | — |
| PayPal | 68 | — |
| other | ZZZ | — |
| payable < 0 (refund owed) | 58 with BT-84 = buyer IBAN if known, else 97 ("clearing between partners") | |
| cancellation / payable = 0 | 97 | — |

### A.6 Final invoice

- Lines: the full supply; BG-23 per group of the full supply at the final supply date; BT-112 = full gross.
- BT-113 (paid amount) = Σ deducted gross of all advances; BT-115 = BT-112 − BT-113 (may be ≤ 0).
- BG-3 for each deducted advance (number, date).
- BT-22 (subject `AAI`) per advance: "Abzüglich Abschlagsrechnung {nr} vom {date}: netto {net} EUR, USt {rate} % {vat} EUR, brutto {gross} EUR (erhalten am {paidDate})" — one line per (advance, rate); cancelled advances are not listed as deductions (optionally an info line "Abschlagsrechnung {nr} wurde storniert").

### A.7 Profiles

| Case | Output | Embedded file name |
|---|---|---|
| Default B2B/B2C/foreign | ZUGFeRD 2.5.x / Factur-X 1.09 hybrid, profile EN 16931 (CII) | `factur-x.xml` |
| Customer wants XRechnung in a PDF | ZUGFeRD XRECHNUNG profile (CII) | `xrechnung.xml` |
| Customer wants pure XRechnung | XRechnung 3.0.2 CII (default) or UBL | separate `{number}.xml` |
| B2G | XRechnung 3.0.2 UBL (default) | separate `{number}.xml` |
| Never | MINIMUM, BASIC-WL (ER-01); BASIC and EXTENDED are not produced in v1 | |

### A.8 Signs

Our model stores cancellation and credit-correction lines with negative quantities and negative totals. The serializer writes TypeCode 381 documents with **positive** quantities and amounts (credit-note semantics) and asserts `|amount|` equality with the snapshot. Negative lines inside a 380/384/326 document stay negative.

### A.9 VAT categories

| Category | BT-118 | BT-119 | BT-120 / BT-121 |
|---|---|---|---|
| S | S | 19.00 / 7.00 | — |
| Z (PV) | Z | 0.00 | — |
| E | E | 0.00 | text from App. B; VATEX-EU-132 (§4 Nr. 11–29 generic) or the code stored on the product |
| AE | AE | 0.00 | "Steuerschuldnerschaft des Leistungsempfängers" / VATEX-EU-AE |
| K | K | 0.00 | App. B text / VATEX-EU-IC |
| G | G | 0.00 | App. B text / VATEX-EU-G |
| O | O | — (no rate) | App. B text / VATEX-EU-O; no BT-31/BT-48 |
| KU (internal) | E | 0.00 | KU note text, no code (open question 9.2) |

### A.10 Discounts in XML

Net mode: line discount → BG-27 with BT-137 = round(qty × price), BT-136 = BT-137 − line net, BT-138 = percent (if percent). Gross mode: the discount is contained in the derived line net; BT-127 documents it ("inkl. 10 % Rabatt"). Document allowance/charge → BG-20/21 per group with the amounts of App. E.

---

## Appendix B. Legal note texts

Stored as versioned `noteText` rule rows (ID in brackets; owner overrides per F01 SET-121). EN documents print the English text followed by the German text in a second line ("/ …").

| Trigger | DE | EN |
|---|---|---|
| KU [`ku_note_19`] | Steuerfreie Leistung gemäß § 19 Abs. 1 UStG (Kleinunternehmerregelung). | VAT-exempt supply under Section 19 (1) German VAT Act (small business scheme). |
| `eu_b2b_service` [`rc_eu`] | Steuerschuldnerschaft des Leistungsempfängers (Reverse Charge). USt-IdNr. Leistender: {sellerVatId} · USt-IdNr. Leistungsempfänger: {buyerVatId} | Reverse charge: the recipient is liable for VAT (Art. 196 Council Directive 2006/112/EC). |
| `intra_community_supply` [`igl`] | Steuerfreie innergemeinschaftliche Lieferung (§ 4 Nr. 1 Buchst. b, § 6a UStG). USt-IdNr. Lieferer: {sellerVatId} · USt-IdNr. Abnehmer: {buyerVatId} | VAT-exempt intra-Community supply of goods (Art. 138 Council Directive 2006/112/EC). |
| `export` [`export`] | Steuerfreie Ausfuhrlieferung (§ 4 Nr. 1 Buchst. a, § 6 UStG). | VAT-exempt export delivery (Section 4 No. 1a, Section 6 German VAT Act). |
| `not_taxable_domestic` B2B [`o_3a2`] | Nicht im Inland steuerbare Leistung (§ 3a Abs. 2 UStG). | Service not taxable in Germany (Section 3a (2) German VAT Act); place of supply is the recipient's country. |
| `not_taxable_domestic` B2C catalogue [`o_3a4`] | Nicht im Inland steuerbare Leistung (§ 3a Abs. 4 UStG). | Service not taxable in Germany (Section 3a (4) German VAT Act). |
| AE §13b [`rc_13b`] | Steuerschuldnerschaft des Leistungsempfängers (§ 13b Abs. 2 Nr. {nr}, Abs. 5 UStG). | Reverse charge: the recipient is liable for VAT (Section 13b German VAT Act). |
| E line [`exempt_4_{nr}`] | Steuerfreie Leistung nach § 4 Nr. {nr} UStG. | VAT-exempt supply under Section 4 No. {nr} German VAT Act. |
| Z PV [`zero_pv`] | Nullsteuersatz nach § 12 Abs. 3 UStG (Photovoltaikanlage). | Zero VAT rate under Section 12 (3) German VAT Act (photovoltaic system). |
| §14b, consumer + property [`p14b`] | Sie sind gesetzlich verpflichtet, diese Rechnung zwei Jahre lang aufzubewahren (§ 14b Abs. 1 Satz 5 UStG). | You are legally required to keep this invoice for two years (Section 14b (1) sentence 5 German VAT Act). |
| Ist, document date ≥ 2028-01-01 [`ist_2028`] | Versteuerung nach vereinnahmten Entgelten. | VAT accounted for on a cash basis (Versteuerung nach vereinnahmten Entgelten). |
| §286, consumer, payable > 0 [`b2c_286`] | Sie kommen spätestens 30 Tage nach Fälligkeit und Zugang dieser Rechnung in Verzug, ohne dass es einer Mahnung bedarf (§ 286 Abs. 3 BGB). | You will be in default no later than 30 days after the due date and receipt of this invoice without a further reminder (Section 286 (3) German Civil Code). |
| Supply date = document date [`supply_same`] | Leistungsdatum: {date} (entspricht dem Rechnungsdatum) | Date of supply: {date} (same as invoice date) |
| Advance [`advance_info`] | {n}. Abschlagsrechnung zu {orderType} {orderNumber} vom {orderDate}. Die Leistung ist noch nicht (vollständig) erbracht; die Abrechnung erfolgt mit der Schlussrechnung. | Advance invoice no. {n} for {orderNumber}. The supply has not yet been (fully) rendered; it will be settled in the final invoice. |
| Final [`final_info`] | Schlussrechnung zu {orderType} {orderNumber}. Bereits geleistete Abschlagszahlungen und die darauf entfallende Umsatzsteuer werden abgezogen. | Final invoice for {orderNumber}. Advance payments received and the VAT thereon are deducted. |
| Storno [`storno_info`] | Stornorechnung zur Rechnung {nr} vom {date}. Die Rechnung {nr} wird hiermit vollständig storniert. | Cancellation of invoice {nr} dated {date}. Invoice {nr} is hereby cancelled in full. |
| Credit [`credit_info`] | Rechnungskorrektur zur Rechnung {nr} vom {date}. Die folgenden Positionen werden gemindert: | Correction of invoice {nr} dated {date}. The following items are reduced: |
| Rectification [`rect_info`] | Berichtigung der Rechnung {nr} vom {date}. Berichtigte Angaben: {fields}. Alle übrigen Angaben und Beträge bleiben unverändert. | Correction of invoice {nr} dated {date}. Corrected details: {fields}. All other details and amounts remain unchanged. |
| Proforma [`proforma_info`] | Proforma-Rechnung – keine Rechnung im Sinne des § 14 UStG. | Pro forma invoice – not a VAT invoice. |
| Self-billing (P3) [`sb_info`] | Gutschrift (Abrechnung durch den Leistungsempfänger, § 14 Abs. 2 Satz 2 UStG). | Self-billing invoice (Gutschrift) issued by the recipient (Section 14 (2) German VAT Act). |
| Payment terms [`terms`] | Zahlbar ohne Abzug bis zum {dueDate}. · (0 Tage) Zahlbar sofort ohne Abzug. | Payable without deduction by {dueDate}. · Payable immediately. |
| Skonto [`skonto`] | Bei Zahlung bis zum {skontoDate} gewähren wir {percent} % Skonto ({skontoAmount}; Zahlbetrag {skontoPayable}). Ohne Abzug zahlbar bis zum {dueDate}. | {percent} % early payment discount ({skontoAmount}; amount payable {skontoPayable}) if paid by {skontoDate}. Otherwise payable without deduction by {dueDate}. |
| Payment reference [`pay_ref`] | Bitte geben Sie als Verwendungszweck ausschließlich an: {paymentReference} | Please use only this payment reference: {paymentReference} |
| §35a, consumer [`p35a`] | Im Rechnungsbetrag enthaltene Arbeitskosten (§ 35a EStG): {net} netto zzgl. {vat} USt = {gross}. | Labour costs included (Section 35a German Income Tax Act): {net} net plus {vat} VAT = {gross}. |
| FX [`fx`] | Umsatzsteuer in EUR: {vatEur} (Kurs 1 EUR = {rate} {currency}, Quelle: {source} vom {date}). | VAT in EUR: {vatEur} (rate 1 EUR = {rate} {currency}, source: {source}, {date}). |
| Kopie stamp | Kopie | Copy / Kopie |

---

## Appendix C. Tax-case derivation

### C.1 Inputs

Company: KU status at supply date (F01 SET-032), own VAT ID. Contact: `countryCode` of establishment, `isConsumer`, `isPublicAuthority`, `vatId` + latest check, `defaultTaxCase`. Document: delivery country (BG-15, goods), supply date. Lines: product `type` (good/service), `placeOfSupplyRule` (`general`, `property`, `event_admission`, `restaurant`, `passenger_transport`, `short_term_vehicle_rental`, `catalogue_3a4`, `electronic`), `reverseCharge13b` (e.g. `construction`, `cleaning`, `metals`, `scrap`, `electronics`), `vatRateKey`.

### C.2 Decision table (first matching row wins; evaluated per document, AE §13b also per line)

| # | Condition | Tax case | Default category |
|---|---|---|---|
| 1 | contact `defaultTaxCase` or document override set | that case (validated) | per case |
| 2 | margin/travel scheme requested | blocked (UST-24) | — |
| 3 | company KU at supply date and customer DE or consumer anywhere | `kleinunternehmer` | KU |
| 4 | company KU, foreign business customer with service under `general` rule | EU: `eu_b2b_service` if own VAT ID (else blocked, 9.11); non-EU: `not_taxable_domestic` | AE / O |
| 5 | company KU, other | `kleinunternehmer` | KU |
| 6 | any service line with `property` (property in DE), `event_admission`/`restaurant`/`short_term_vehicle_rental` performed in DE | `domestic` for those lines (document stays domestic) | S |
| 7 | customer DE, business, all lines exempt (§4 rate key) | `exempt_4` | E |
| 8 | customer DE, business, every line `reverseCharge13b` | `reverse_charge_13b` | AE |
| 9 | customer DE (business or consumer) | `domestic` (§13b lines → AE line-wise if business) | S/Z/E |
| 10 | customer EU (incl. `XI` for goods), business, valid VAT ID, any good line, delivery country = customer EU state ≠ DE | `intra_community_supply` (services ancillary → K) | K |
| 11 | customer EU, business, valid VAT ID, goods delivered within DE | `domestic` (EC-042) | S |
| 12 | customer EU, business, valid VAT ID, services only | `eu_b2b_service` | AE |
| 13 | customer EU, business without (valid) VAT ID | `domestic` + warning | S |
| 14 | customer EU consumer | `domestic` + OSS threshold check (UVA-07) | S |
| 15 | customer non-EU (incl. GB, `XI` services), any good line with delivery outside the EU | `export` | G |
| 16 | customer non-EU, business, services | `not_taxable_domestic` (§3a Abs. 2) | O |
| 17 | customer non-EU consumer, `catalogue_3a4` services only | `not_taxable_domestic` (§3a Abs. 4) | O |
| 18 | customer non-EU consumer, other services | `domestic` | S |
| 19 | public authority | as for a DE business | |

### C.3 Allowed categories per tax case

| Tax case | Allowed | Notes |
|---|---|---|
| `domestic` | S (19/7), Z, E, AE (§13b product lines, business customer only) | |
| `kleinunternehmer` | KU | |
| `eu_b2b_service` | AE | |
| `intra_community_supply` | K | |
| `export` | G | |
| `not_taxable_domestic` | O | no mixing (BR-O) |
| `reverse_charge_13b` | AE | |
| `exempt_4` | E | |

### C.4 Reason texts (examples)

"Kunde in Österreich mit geprüfter USt-IdNr ATU12345678 (qualifiziert, 03.10.2026), sonstige Leistung → Steuerschuldnerschaft des Leistungsempfängers." · "Lieferadresse in Deutschland – keine innergemeinschaftliche Lieferung, deutsche Umsatzsteuer." · "Kunde in der Schweiz, Unternehmer, Beratung → nicht im Inland steuerbar (§ 3a Abs. 2 UStG)." · "Sie sind Kleinunternehmer (§ 19 UStG) für Leistungen bis {date}."

---

## Appendix D. ER-03 decision function

### D.1 Signature

`requiresERechnung({ docType, taxCase, issuer: { isKleinunternehmer, turnover2026: { cents, final: boolean } | null, foundedOn }, recipient: { countryCode, isConsumer, isPublicAuthority }, refDate, grossEurCents, allExempt4Nr8to29, original?: { hadXml, refDate } }) → { decision, ruleId, reason, warnings[] }`

`refDate`: invoice/final/correction/cancellation → supply end date (`date`; `period.to`; last day of `month`); advance/partial → document date (preview: today), and if an expected supply date is set the function is evaluated a second time with its end date and the stricter decision wins (`MUST_E` > `PDF_NEEDS_CONSENT` > `MAY_PAPER_OR_PDF` > `NOT_REQUIRED`; open question 9.5, `// LEGAL-OPEN: 01 open item 11`); cancellation/correction → the original's `refDate`.

### D.2 Rules (first match wins)

| Rule | Condition | Decision |
|---|---|---|
| R0 | docType ∈ quote, order_confirmation, delivery_note, proforma | `NOT_REQUIRED` (kein Rechnungsdokument) |
| R1 | docType ∈ cancellation, correction and the original had XML | `MUST_E` (Korrektur einer E-Rechnung, ER-04) |
| R2 | recipient public authority (DE) | `MUST_E` (B2G, XRechnung) |
| R3 | recipient consumer | `NOT_REQUIRED` |
| R4 | recipient country ≠ DE | `NOT_REQUIRED` |
| R5 | issuer KU | `MAY_PAPER_OR_PDF` (§34a UStDV) |
| R6 | grossEur ≤ 250,00 € and taxCase ≠ `reverse_charge_13b` and no AE line | `MAY_PAPER_OR_PDF` (Kleinbetrag §33 UStDV) |
| R7 | allExempt4Nr8to29 (no option §9) | `MAY_PAPER_OR_PDF` |
| R8 | refDate ≤ 2026-12-31 | `PDF_NEEDS_CONSENT` (§27 Abs. 38 Nr. 1 UStG) |
| R9 | refDate in 2027 and turnover2026 ≤ 800.000,00 € (founded ≥ 2027-01-01 → 0) | `PDF_NEEDS_CONSENT` (§27 Abs. 38 Nr. 2); `turnover_provisional` warning if not final |
| R10 | refDate in 2027 and turnover2026 > 800.000,00 € | `MUST_E` |
| R10u | refDate in 2027, no figure at all | `MUST_E` + warning "Gesamtumsatz 2026 fehlt" |
| R11 | refDate ≥ 2028-01-01 | `MUST_E` |

Turnover 2026: the confirmed `priorYearTotalTurnoverCents` (F01 SET-043); if not confirmed, the computed running total from our own data (10 EC-029).

### D.3 Consequences (finalisation, export dialog and mark-sent dialog)

"Electronic channel" = `email_manual`, `upload_portal`, or `other` with the confirmation „elektronisch übermittelt“. The mark columns apply to the first effective mark (SND-17); later marks may use any channel.

| Decision | Finalise with format `none` | Mark: structured e-invoice (ZUGFeRD PDF / XRechnung XML) on an electronic channel | Mark: paper via `post` / `hand` | Mark: PDF-only on an electronic channel, consent recorded | Mark: PDF-only on an electronic channel, no consent |
|---|---|---|---|---|---|
| `MUST_E` | ✗ `einvoice_required` | ✓ required | ✗ `must_e_channel_not_electronic` | ✗ `pdf_not_allowed_must_e` | ✗ `pdf_not_allowed_must_e` |
| `PDF_NEEDS_CONSENT` | ✓ | ✓ default (no consent needed) | ✓ | ✓ | ✗ `pdf_consent_required` |
| `MAY_PAPER_OR_PDF` | ✓ | ✓ (no consent needed) | ✓ | ✓ | ⚠ `pdf_consent_tacit` |
| `NOT_REQUIRED` | ✓ | ✓ | ✓ | ✓ | ⚠ `pdf_consent_tacit` |

### D.4 Test cases (T-TAB-03)

| ID | Input | Expected |
|---|---|---|
| ER03-01 | supply 2025-06-15, B2B DE, 300 € | PDF_NEEDS_CONSENT (R8) |
| ER03-02 | supply 2026-12-31, invoiced 2027-01-10, turnover 900k | PDF_NEEDS_CONSENT (R8, supply date governs) |
| ER03-03 | supply 2027-01-01, turnover 900k | MUST_E (R10) |
| ER03-04 | supply 2027-06-30, turnover 800.000,00 | PDF_NEEDS_CONSENT (R9) |
| ER03-05 | supply 2027-06-30, turnover 800.000,01 | MUST_E (R10) |
| ER03-06 | supply 2027-03-01, no turnover figure | MUST_E + warning (R10u) |
| ER03-07 | supply 2027-03-01, founded 2027-02-01 | PDF_NEEDS_CONSENT (R9, prior year 0) |
| ER03-08 | supply 2027-12-31, invoiced 2028-01-05, turnover 500k | PDF_NEEDS_CONSENT (R9) |
| ER03-09 | supply 2028-01-01, B2B DE | MUST_E (R11) |
| ER03-10 | 2028, B2B, gross 250,00 | MAY_PAPER_OR_PDF (R6) |
| ER03-11 | 2028, B2B, gross 250,01 | MUST_E |
| ER03-12 | 2028, §13b, gross 200,00 | MUST_E (R6 excluded) |
| ER03-13 | 2028, KU issuer, B2B | MAY_PAPER_OR_PDF (R5) |
| ER03-14 | 2028, B2C DE | NOT_REQUIRED (R3) |
| ER03-15 | 2028, B2B Austria | NOT_REQUIRED (R4) |
| ER03-16 | 2028, B2B Switzerland export | NOT_REQUIRED (R4) |
| ER03-17 | 2028, rental with §9 option (domestic S) | MUST_E |
| ER03-18 | 2028, rental §4 Nr. 12 without option | MAY_PAPER_OR_PDF (R7) |
| ER03-19 | 2026, B2G | MUST_E (R2) |
| ER03-20 | 2028, KU issuer, B2G | MUST_E (R2 before R5) |
| ER03-21 | 2028 Storno of a 2026 PDF invoice (supply 2026) | PDF_NEEDS_CONSENT (original refDate) |
| ER03-22 | 2028 correction of a ZUGFeRD invoice | MUST_E (R1) |
| ER03-23 | 2026 correction of a ZUGFeRD invoice | MUST_E (R1) |
| ER03-24 | quote / proforma | NOT_REQUIRED (R0) |
| ER03-25 | advance dated 2027-11-15, expected supply 2028-03, turnover 500k | MUST_E (stricter of document date → PDF_NEEDS_CONSENT and expected supply → MUST_E; 9.5) |
| ER03-33 | advance dated 2027-11-15, no expected supply date, turnover 500k | PDF_NEEDS_CONSENT (document date only) |
| ER03-26 | final invoice, supply 2028-03-10 | MUST_E |
| ER03-27 | period 2027-12-01…2028-01-31 | MUST_E (refDate 2028-01-31) |
| ER03-28 | month 2027-12, turnover 500k | PDF_NEEDS_CONSENT (refDate 2027-12-31) |
| ER03-29 | 2028, USD 240,00 ≈ 221,59 EUR, B2B DE | MAY_PAPER_OR_PDF (R6 in EUR) |
| ER03-30 | 2025, KU issuer, B2B | MAY_PAPER_OR_PDF (R5) |
| ER03-31 | 2027, running 2026 total 810k (not final) | MUST_E + `turnover_provisional` |
| ER03-32 | 2028, recipient country AT with a delivery address in DE | NOT_REQUIRED (establishment governs) |

---

## Appendix E. Totals and rounding algorithms

### E.1 Primitives

- `roundHalfAway(x: BigInt rational) → BigInt` (kaufmännisch: .5 away from zero; symmetric, so mirrors are exact).
- Line base in 10⁻⁷ currency units: `qtyMilli × unitPriceMicros`; cents = `roundHalfAway(base / 10⁵)`.
- Percent: `x × bp / 10⁴`. All intermediate values BigInt; the final cents fit in `number` (≤ 10¹³).
- Pro-rata allocation `allocate(total, weights)`: `floor(total × w_i / Σw)` for |total| (sign applied afterwards), residual cents to the **largest weight** (ties → lowest position) — the rule of 10 EC-053/EC-055.

### E.2 Net mode

1. `lineNet = roundHalfAway((qty × price − discountExact) / 10⁵)`, `discountExact` = percent of the exact base or the amount in exact units.
2. Groups by (category, rate): `lineSum_g = Σ lineNet`.
3. Document discount/surcharge: percent → `allow_g = roundHalfAway(lineSum_g × bp)`; amount → `allocate(amount, lineSum_g)`. `base_g = lineSum_g − allow_g (+ charge_g)`.
4. `vat_g = roundHalfAway(base_g × rateBp / 10⁴)`.
5. `net = Σ base_g`, `vat = Σ vat_g`, `gross = net + vat`; `payable = gross − deductedGross` (finals).

Golden (UST-10): 3 × (1 × 10,005) → 10,01 each; base 30,03; VAT round(5,7057) = 5,71; gross 35,74.
Golden (document discount): 1.000,00 @19 + 500,00 @7, discount 100,00 → allocations 66,67 / 33,33 → bases 933,33 / 466,67 → VAT 177,33 / 32,67 → gross 1.610,00. With 5 %: 50,00 / 25,00 → 950,00 / 475,00 → 180,50 / 33,25 → 1.638,75.

### E.3 Gross mode (conversion to the net EN 16931 model)

1. `lineGross = roundHalfAway((qty × grossPrice − discountExact) / 10⁵)`.
2. `G_lines_g = Σ lineGross`; document discount in gross: percent per group / amount via `allocate`; `G_g = G_lines_g − allowGross_g`.
3. Group net: `N(G) = max { n : n + roundHalfAway(n × r) ≤ G }` (computed from `n0 = floor(G × 10⁴ / (10⁴ + rateBp)) + 1`, stepping down; negative G: `−N(−G)`). `vat_g = roundHalfAway(N × r)`. If `N + vat_g < G` (unreachable gross), the deviation (exactly 1 cent) raises `gross_rounding_deviation`.
4. Line nets: `allocate(N(G_lines_g), lineGross_i)`; allowance net `= N(G_lines_g) − N(G_g)`.
5. XML unit price: `BT-146 = roundHalfAway(lineNet × 10³ / qtyMilli, 4 dp)`; if `round(qty × BT-146)` ≠ lineNet, write `BT-149 = qty` and `BT-146 = lineNet` (exact by construction).
6. Converting a stored price between modes for display/defaults (DOC-06/08): `net = roundHalfAway(gross × 10⁴ / (10⁴ + rateBp))` at 4 decimals and vice versa; the document totals always follow steps 1–5.

Golden (T-GLD-05): L1 3 × 19,99 @19 = 59,97; L2 1 × 49,00 @19; L3 2 × 10,70 @7 = 21,40. Group 19 %: G = 108,97 → N = 91,57 (91,57 + 17,40 = 108,97 ✓). Group 7 %: G = 21,40 → N = 20,00, VAT 1,40. Line nets 19 %: floor 50,39 / 41,17, residual 0,01 → largest line L1 → 50,40 / 41,17; L1 BT-146 = 16,80. Totals: net 111,57, VAT 18,80, gross 130,37 = entered.
Golden (T-GLD-06, unreachable): G = 6,29 @19: n = 5,28 → 5,28 + 1,00 = 6,28; n = 5,29 → 6,30 > 6,29 → N = 5,28, VAT 1,00, gross 6,28, deviation −0,01.

### E.4 Final invoice deductions

For each deductible advance `a` and each of its groups `g`: `received_a` = Σ allocated payments − Skonto/other price-reduction differences with VAT correction (F05 PAY-021). Fully paid: deducted net/VAT = invoiced net/VAT minus the differences' net/VAT corrections. Partially paid (only possible after the mandatory remainder correction `c`, INV-07): the correction per group is `correctionGross_ag = allocate(open_a, gross_ag)` with VAT/net per E.2, and the deduction per group = advance group − correction group (net, VAT, gross), so the deduction equals the received amount and mirrors the two issued documents exactly. Payable = gross(final) − Σ deductedGross. Per-group tax effect (for UStVA/journal) = final group − Σ deductions of that group, stored in the snapshot.

| Case | Advances | Final supply | Deduction | Remainder (net / VAT / payable) |
|---|---|---|---|---|
| A (UST-41 golden) | AR 3.000,00 + 570,00 = 3.570,00 paid | 10.000,00 / 1.900,00 / 11.900,00 @19 | 3.000,00 / 570,00 / 3.570,00 | 7.000,00 / 1.330,00 / **8.330,00**; BT-113 3.570,00, BT-115 8.330,00 |
| B (rate change) | AR 2025-11-20: 1.000,00 + 190,00 @19 paid | supply 2026-01-15 food: 1.000,00 / 70,00 / 1.070,00 @7 | 1.000,00 / 190,00 @19 | 0,00 / −120,00 / **−120,00** (refund); effect 7 %: +1.000/+70, 19 %: −1.000/−190 |
| C (two advances) | 2 × (6.000,00 + 1.140,00) paid | 20.000,00 / 3.800,00 / 23.800,00 | 12.000,00 / 2.280,00 / 14.280,00 | 8.000,00 / 1.520,00 / 9.520,00 |
| D (Skonto on advance) | AR 3.570,00 paid 3.498,60 with 2 % Skonto (60,00 / 11,40) | 10.000,00 / 1.900,00 / 11.900,00 | 2.940,00 / 558,60 / 3.498,60 | 7.060,00 / 1.341,40 / 8.401,40 |
| E (partially paid, corrected) | AR 3.570,00, received 1.785,00, Rechnungskorrektur −1.785,00 (−1.500,00 / −285,00) | 10.000,00 / 1.900,00 / 11.900,00 | 1.500,00 / 285,00 / 1.785,00 | 8.500,00 / 1.615,00 / 10.115,00 |

### E.5 Advance and partial amounts from an order

- `percent`: `net_g = roundHalfAway(orderNet_g × bp / 10⁴)`, VAT per E.2.
- `net` amount A: `net_g = allocate(A, orderNet_g)`.
- `gross` amount A: `gross_g = allocate(A, orderGross_g)`, then `N(gross_g)` per E.3.
- Golden: order 5.000,00 @19 / 1.000,00 @7. 30 % → 1.500,00 / 300,00. Gross 2.000,00 → allocation 1.695,15 + 0,01 (largest group) = 1.695,16 and 304,84 → nets 1.424,50 (VAT 270,66) and 284,90 (VAT 19,94) → total 2.000,00.

### E.6 Foreign currency

Rate stored as decimal string "1 EUR = x FC" (≤ 6 decimals), source (`bmf_monthly` default, `ecb_daily`, `manual`) and date (supply month for BMF; document date for ECB). `vatEur_g = roundHalfAway(vat_g / x)`, `BT-111 = Σ vatEur_g`; EUR net per group the same way (UStVA, F08). Golden: 1.000,00 USD @19 → VAT 190,00 USD; x = 1.0831 → 175,42 EUR.

### E.7 §35a labour subtotal

Labour lines (`isLaborCost`, F03 PRD-041 split for B2C) → `laborNet = Σ lineNet`, `laborVat = Σ_g roundHalfAway(laborNet_g × r)`, gross = sum. Golden: 800,00 labour @19 → 152,00 → 952,00.

---

## Appendix F. PDF layout and mandatory items

Zones (DIN 5008 form B, A4): **H** header (logo, company name) · **S** sender line above the window · **W** address window · **I** info block right of the window · **T** title + subject + head text · **P** positions table · **∑** totals block · **L** legal/payment block · **F** foot text · **Z** footer on every page (Geschäftsbrief items, page x/y).

| Item | Source | Zone | Types | Rule |
|---|---|---|---|---|
| Seller name incl. legal form, address | snapshot seller | H, S, Z | all | UST-03, MAIL-03 |
| Buyer name, department, address (country if ≠ DE) | snapshot buyer | W | all (Kleinbetrag optional) | UST-03 |
| Document title + number | type, number | T, I | all | UST-06 |
| Document date ("Rechnungsdatum", "Angebotsdatum" …) | documentDate | I | all | UST-05 |
| Supply date / period ("Leistungsdatum", "Leistungszeitraum", "Lieferdatum", "Voraussichtlicher Leistungszeitraum") | supplyDate | I | invoice types, delivery notes, quotes (if set) | UST-08 |
| Customer number, order reference, buyer reference/Leitweg-ID, contract reference, delivery note numbers, original invoice number + date | references | I | as applicable | ER-10, UST-30 |
| Seller contact (Ansprechpartner, Telefon, E-Mail) | company contact | I | all | ER-10 |
| Our Steuernummer or USt-IdNr | company | Z (+ I for EU cases) | invoice types | UST-04 |
| Customer USt-IdNr | buyer | I and legal note | K, AE (EU) | UST-20, UST-21 |
| Valid until | validUntil | I | quotes | — |
| Positions: Pos., description, quantity, unit, unit price (net/gross), VAT % (if mixed or print option), discount, amount | lines | P (header repeated per page) | all (delivery note prices optional) | UST-07, MISC-03 |
| Optional positions marked "Optional" with amount in parentheses | lines | P | quotes | — |
| Net per group, "zzgl. {rate} % USt auf {base}: {vat}", gross | totals | ∑ | priced types | UST-09, UST-10 |
| Deduction table per advance and rate, payable | snapshot | ∑ | final_invoice | UST-41 |
| EUR VAT line | FX | ∑ | currency ≠ EUR | MISC-08 |
| §35a labour subtotal | lines | ∑ | B2C invoices | MISC-07 |
| Legal notes (tax case, exemption, KU, §14b, Ist 2028) | App. B | L | per trigger | UST-10…13, UST-20…23, KU-02 |
| Payment terms, Skonto, payment method text, Verwendungszweck = payment reference | terms | L | invoice types, proforma | UST-09, MAHN-01 |
| §286 note | App. B | L | B2C, payable > 0 | MAHN-01 |
| Bank details (holder, IBAN, BIC, bank) + EPC QR (right) | bank account | L (+ Z) | EUR, payable > 0, transfer | MISC-01 |
| "Gutschrift" | title | T | self_billing | UST-11 |
| Storno / correction reference sentence | App. B | T | cancellation, correction | UST-30 |
| "Proforma-Rechnung – keine Rechnung …" | App. B | T | proforma | — |
| E-Rechnung hint ("Diese Rechnung enthält eine E-Rechnung nach EN 16931 (ZUGFeRD 2.5).") | format | Z (small) | ZUGFeRD | ER-01 |
| Geschäftsbrief items per legal form (F01 §5.2) | company | Z | all | MAIL-03 |
| "Kopie" stamp (header right + light diagonal watermark) | render flag | H | copies | UST-34 |
| "ENTWURF – keine gültige Rechnung" watermark | render flag | all pages | draft previews | UST-34 |
| "Lesefassung – maßgeblich ist die XRechnung" | render flag | H | XRechnung reading copies | ER-01 |
| Page x of y | — | Z | all | — |

---

## Appendix G. Data-model deltas required (03 is not modified by this file)

| Table / type | Change | Reason |
|---|---|---|
| `salesDocuments` | add `revision: number`, status `superseded` | QUO-06 (do not reuse `version`, which is the OCC counter) |
| `salesDocuments` | add `correctionKind: "credit" \| "rectification"`, `rectifiedFields?: string[]` | INV-12/13 |
| `salesDocuments` | add `showPrices` (delivery notes), `deliveryTerms`, `propertyRelated`, `kleinbetrag`, `constructionWork`, `supplyDateMode: "explicit" \| "document_date"` | QUO-09, DOC-44/46, A.2, DOC-21 |
| `salesDocuments` | add `attachments: { storageId, name, mime, sha256, bytes, embedInXml, includeInExport }[]` (v1.1: `sendByEmail` renamed, B2) and `evidence[]` (post-finalisation proofs) | DOC-18, INV-30, SND-02 |
| `salesDocuments` | add `rejection?: { at, reason }` | QUO-05 |
| `salesDocuments` | add `recurringOccurrence?: { templateId, date }` with a unique index | REC-05 idempotency |
| `salesDocuments` | add `deductions?: { advanceId, advanceNumber, advanceDate, byGroup[], deductedGrossCents, partiallyPaid }[]` (replaces `advanceIds`; lists only deducted advances, **no `decision` field**, no "not deducted" option — 03 §4), `deductedInId?` on advances | INV-06/07, RI-08 |
| `salesDocuments.fxRateToEur` | `source` as enum `bmf_monthly \| ecb_daily \| manual` + `sourceText` | MISC-08 |
| `salesDocuments.paymentStatus` | `overdue` is never stored (derived, §4.2.9) | DOC-55 |
| `documentLines` | add `linePeriod?: { from, to }`, `placeOfSupplyRule?`, `reverseCharge13b?`, `sourceLineId?`, `invoicedQtyMilli?`, `deliveredQtyMilli?` | DOC-21, App. C, §4.3.3 |
| `products` (F03) | add `placeOfSupplyRule` and `reverseCharge13b` | App. C, 10 EC-046 |
| `contacts` (F02) | add `selfBillingAgreement?: { agreedOn, scope, validFrom, validTo?, storageId? }` | INV-16 (P3) |
| `documentArtifacts` | add `variant?: "original" \| "copy" \| "reading"` on kind `pdf` (resolved in 03; no extra kinds); the `copy` variant is archived on first generation (deterministic render, reused). v1.1: kind `"eml"` removed (B2) | DOC-32, SND-02, SND-22, MAIL-02 |
| `sendLog` 🔒 | v1.1 (B2), append-only dispatch record per 03: `{ documentId? \| voucherId? \| inboxItemId? (exactly one; `inboxItemId` for F06 correction requests); purpose: "document" \| "reminder_void_notice" \| "supplier_correction_request"; kind: "mark_sent" \| "retraction"; retractsId?; sentOn; channel: "email_manual" \| "post" \| "hand" \| "upload_portal" \| "other"; note?; artifacts: { artifactId, sha256 }[]; einvoiceHandedOverElectronically?; at; actor }`. The former `outcome`, `messageId`, `smtpResponse`, recipients, `resendOfOriginal`, `einvoiceTransmittedOtherwise` are dropped; the reason of an original re-export lives in the `document.export` audit entry. Retraction reason → `note` (mandatory for `kind: "retraction"`) | SND-07, SND-17, SND-18, SND-22 |
| `salesDocuments` | v1.1: `sentAt?: number` (instant of the first effective mark), `sentOn?: string`, `zugang?: { date, basis: "email_manual" \| "post" \| "hand" \| "upload_portal" \| "other" \| "manual" }` (whitelisted in 03 §11 together with `sentAt`; all three are set by the first effective mark and re-derived/unset only by a retraction, SND-18); `firstExportedAt?: number` (derived cache for SND-21, whitelisted) | SND-05, SND-18, SND-21, SND-23 |
| `salesDocuments` lifecycle | v1.1: allowed transition `sent → finalized` (event `retract_mark`, SND-18) for all types with a `sent` state; `download_for_send` event removed | SND-06, SND-18 |
| `mailIdentities` | v1.1: table removed (B2); no SMTP settings anywhere | SND-04 (withdrawn) |
| `jobs.kind` | v1.1: `bulk_export` replaces `bulk_send`; bulk mark runs as job kind `bulk_mark_sent` | SND-20 |
| `todos` / notifications | v1.1: kinds `export_and_send` (REC-16), `exported_not_marked` (SND-21), `review_recurring_draft` (REC-16) | REC-16, SND-21 |
| audit actions | v1.1: `document.export` (artifact IDs + sha256 + variant + reason?), `document.mark_sent`, `document.mark_sent_retracted` | SND-22 |
| `companyProfile.defaults` | add `quoteRevisionNumbering`, `catchUpAutoMax`, `paymentReferencePrefix`, `fxRateSource` | QUO-06, REC-06, DOC-51, DOC-15 |
| `textTemplates` | v1.1: kind `message_text` (subject + body with placeholders, per document type and language) replaces the e-mail subject/body/signature kinds (B2; 03 owned by the platform agent) | SND-19 |
| `recurringTemplates` | `status: "active" \| "inactive"` (UI "Pausiert"); "Beendet" derived; add `contractReference`, `skippedOccurrences[]`; v1.1: `automation: { finalize: boolean }` only (`send`, `mailTemplateId`, `mailIdentityId` removed, B2) | REC-03, REC-09, REC-10, REC-16 |

# F08 — Bookkeeping, Assets, Tax Filings and Reports
> **Status:** v1.1 · 2026-10-12 (owner decisions B1/B3/B5/B7 applied: bank postings provider-neutral (statement import P1, Enable Banking feed P2), simple cash postings in P1 without a cash book, no Steuerberater — Kennzahlen sheets with step-by-step Mein ELSTER instructions and submission records incl. the yearly EÜR, decided conservative defaults instead of "confirm with Steuerberater", SKR03 default, DATEV export P3 low priority, ERiC P4) · **Phases:** P1 (KU/800k monitors, chart seed (SKR03 default), Buchungsbeginn, opening balances for cash/bank/open receivables, journal postings for sales documents, payments incl. cash, cash transfers and bank-to-invoice matches from the statement import), P2 (purchases/vouchers, remaining bank transactions incl. the Enable Banking feed, foreign-currency accounts, manual entries, full opening balances, period lock, assets, **UStVA/ZM Kennzahlen sheets with the Mein ELSTER guide, Sondervorauszahlung, submission records and tax payments — needed at go-live = end of P2, 09**), P3 (EÜR sheet + guide + submission record, USt-Jahreserklärung worksheet, reports, tax reserve, cash-flow forecast, DATEV export — low priority), P4 (ERiC direct ELSTER transmission, OSS) · **sevdesk parity:** research 00 §3, §13–15, §16.3; research 07 §2, §5–7; research 09 §8; research 13 · **Compliance:** GOBD-01..06, GOBD-22, AO-01, AO-02, AO-03, AO-04, AO-05, AO-07, UVA-01..07, UST-01, UST-15, UST-32, UST-40, UST-41, KU-01, KU-05, ER-03, DATEV-02, MISC-05, MISC-08, MISC-09

> **Edge cases and invariants:** normative cross-cutting rules in [10-edge-cases.md](../10-edge-cases.md) apply (EC-115, EC-116, EC-120–EC-124, EC-140–EC-147, EC-149, EC-151, EC-155, EC-156, EC-162, EC-164, EC-170–EC-177; RI-09, RI-10, RI-11, RI-12, RI-13, RI-23, RI-27, RI-28; numbering and wording of the bank/cash entries as revised by the lead for B1/B3). This file's §5 refines them for bookkeeping.
>
> **Disclaimer.** Every account number, BU key, Kennzahl, Anlage-EÜR line and Mein-ELSTER navigation step in this file is a **configurable default** shipped as versioned rule data (`src/domain/rules/accounting/**`, `src/domain/rules/ustva/**`, `src/domain/rules/euer/**`, `src/domain/rules/elster/**`). There is **no Steuerberater** (owner decision B5): the owner files UStVA, ZM and EÜR personally in Mein ELSTER. Wherever the research is uncertain, this file states a **decided conservative default** (stricter validation, block rather than warn when unsure, keep records longer) followed by "(one-off Steuerberater check before go-live recommended, non-blocking)"; rows marked ⚠ are uncertain in the research and keep their ⚠ / `LEGAL-OPEN` markers (01-compliance § Open items). The tax reserve and cash-flow forecast are **estimates**, never tax advice. Bilanz/E-Bilanz (GmbH, UG, …) is out of scope (AO-07) and needs an external tool or advisor.

## 1. Scope (in / out, and what we do better than sevdesk)

**In scope**
- One double-entry **journal** generated automatically from business events (invoice finalisation, payments incl. cash, vouchers, booked bank transactions, cash transfers, depreciation, tax payments) using a versioned **posting matrix** (§4.2) for SKR03 and SKR04.
- Chart of accounts seed (SKR03/SKR04 subset; **SKR03 is the default**, SKR04 selectable in setup), account roles, custom accounts.
- **Manual journal entries** and **opening balances** (sevdesk has neither), reversal (Generalumkehr) as the only correction.
- **Period lock / Festschreibung** per month (GOBD-06), incl. auto-lock on the UStVA, ZM and EÜR submission records and optional lock on DATEV export (P3).
- **Asset register** (AO-03): linear, degressive 30 %, e-vehicle 75 %, GWG, Sammelposten, disposal, Anlagenspiegel, GWG list.
- **EÜR** with Anlage-EÜR mapping versioned per tax year incl. the 10-day rule (AO-02), the Anlage-EÜR line sheet with step-by-step Mein ELSTER instructions and a yearly submission record (`taxFilings.kind = "euer"`).
- **UStVA** computation (UVA-01..04): Kennzahlen, rounding, drill-down, Dauerfristverlängerung/Sondervorauszahlung, a Kennzahlen sheet with **step-by-step instructions for manual entry in Mein ELSTER** (owner files personally; no Steuerberater), submission record (date, Transferticket, protocol PDF) with lock, correction filings.
- **ZM** (UVA-05) with the same Mein ELSTER instruction approach, **OSS** block and threshold tracking (UVA-07; full OSS report P4).
- **USt-Jahreserklärung worksheet** (year totals per line, reconciled with the submitted UStVAs, with Mein ELSTER instructions; no filing record).
- Monitors: **Kleinunternehmer** (KU-01), **800k/80k bookkeeping duty** (AO-01), **800k E-Rechnung threshold** (ER-03), **800k Ist-Versteuerung limit** (UVA-06).
- Reports: dashboard KPIs, BWA-light, Summen- und Saldenliste (SuSa), Kontenblatt, open items (OPOS), revenue by customer/product/month, journal, Anlagenspiegel, USt-Zahllast.
- **Tax reserve estimator** (USt + ESt §32a + Soli + KiSt + GewSt with §35 credit; KSt for corporations) and **90-day cash-flow forecast**.
- Provider-neutral posting rules for **bank transactions** from any source (statement import CAMT.053/Revolut CSV/MT940 in P1, Enable Banking PSD2 feed in P2; research 13): fees (separate fee transaction or the `source.feeCents` field), foreign-currency accounts (e.g. Revolut currency pockets) as Fremdwährungskonten with moving-average EUR cost, exchanges between own accounts arriving as two separate transactions paired via Geldtransit, foreign-currency card payments, bank reversals as separate counter-entries.
- **Simple cash postings** (owner decision B3; F07 CSH-020…030): one cash account (role `cash`), invoice cash receipts, cash deposits to the bank and private withdrawals via Geldtransit/private accounts, ATM withdrawals into the till — **P1**; vouchers paid in cash or privately with the voucher feature (P2, open question 11); no cash book, no daily close, no Kassendifferenz postings.

**Out of scope**
- Balance sheet / E-Bilanz / annual accounts (AO-07): Bilanz companies (GmbH, UG, AG, OHG, KG, GmbH & Co. KG) need an **external tool or advisor** for the Jahresabschluss and the E-Bilanz; the app provides journal, SuSa, BWA-light and the DATEV export (P3, low priority) as the handover.
- Direct ELSTER transmission in P1–P3 (UVA-04 decision v1: manual entry in Mein ELSTER with in-app instructions; ERiC transmission is a **P4 option**, TAX-024).
- Payroll postings beyond manual entries (net method templates only).
- Full OSS return (P4), §25/§25a margin schemes (UST-24, blocked), Investitionsabzugsbetrag §7g (manual entry only; COULD later).
- Filing records for the annual VAT return (USt-Erklärung) and ESt/GewSt/KSt returns — the app provides the USt-Jahreserklärung worksheet (TAX-023) and the EÜR result; ESt/GewSt forms themselves are filled by the owner in Mein ELSTER without app support.
- Cash book (Kassenbuch), daily cash close, Kassensturz, Kassendifferenz postings, POS (owner decision B3; AO-04).

**Better than sevdesk**
- Manual entries + opening balances + Saldenvorträge (sevdesk: none; research 07 §2).
- Sammelposten, degressive and e-vehicle AfA natively, automatic disposal, Anlagenspiegel (sevdesk: workarounds, no report; research 00 §13).
- ZM report, OSS threshold tracking (sevdesk: none; research 00 §15.2).
- Every report figure drills down to journal lines and vouchers and back (GOBD-01).
- UStVA correction filings as first-class objects; Dauerfristverlängerung + Sondervorauszahlung computed (sevdesk: manual outside the tool).
- Tax reserve and 90-day liquidity forecast (sevdesk: none, points to Agicap).
- Every posting rule is data with a version and a "why" text, visible in the UI ("Warum dieses Konto?").

## 2. User stories

| # | As … | I want … | so that … |
|---|---|---|---|
| US-01 | owner | every invoice, payment, voucher and bank line to create correct bookings automatically | I never type a Buchungssatz for normal business |
| US-02 | owner | to see why a booking went to an account and which rule version produced it | I can explain it to the Finanzamt and the Betriebsprüfer |
| US-03 | owner | to enter manual bookings (e.g. loan, Umbuchung) and opening balances | I can start mid-life and fix special cases without workarounds |
| US-04 | owner | to lock a month after the UStVA | nobody (not even Claude) can change submitted figures |
| US-05 | owner | to register assets from vouchers and get monthly AfA automatically | depreciation, GWG and Sammelposten are right without spreadsheets |
| US-06 | owner | an Anlagenspiegel and GWG list per year | I can fill in the Anlage AVEÜR and keep the required Anlagenverzeichnis |
| US-07 | owner | the UStVA Kennzahlen for a period with step-by-step Mein ELSTER instructions, copy buttons and drill-down to each document | I can file the UStVA myself without a Steuerberater and prove every euro |
| US-08 | owner | to record that I submitted the UStVA (ticket/protocol) and have the period locked | the books match what the Finanzamt has |
| US-09 | owner | to file a corrected UStVA when a late document belongs to a submitted period | I stay compliant without rewriting history |
| US-10 | owner | the ZM values per customer USt-IdNr and a CSV | I can file the ZM by the 25th |
| US-11 | owner (EÜR) | the Anlage-EÜR values by line for the tax year, incl. the 10-day rule, with Mein ELSTER instructions and a submission record | I can file the EÜR myself and the year is locked afterwards |
| US-12 | owner (KU) | warnings before I cross 25k/100k | I don't lose the Kleinunternehmer status by surprise |
| US-13 | owner | a monthly tax reserve suggestion | I am never surprised by tax demands or Vorauszahlungen |
| US-14 | owner | a 90-day liquidity forecast that knows how late each customer pays | I see gaps before they happen |
| US-15 | Claude (MCP) | to read UStVA values, EÜR, open items, revenue, tax reserve and forecast | I can answer "Wie viel USt muss ich im Oktober zahlen?" |
| US-16 | Betriebsprüfer / future Steuerberater | SuSa, Kontenblatt and journal with stable sequence numbers (DATEV export P3, low priority) | I can reconcile and import the books |
| US-17 | owner | currency exchanges between my bank accounts/pockets and bank fees booked correctly, whatever the bank data source | multi-currency accounts don't break the books |
| US-18 | owner | cash receipts, cash deposits, private withdrawals and ATM withdrawals booked automatically from day one (P1), and cash expenses and vouchers I paid privately once vouchers exist (P2) | my cash account is right without a cash book |

## 3. Functional requirements

### 3.1 Journal, accounts, manual entries, period lock (ACC)

| ID | Requirement | Priority | Phase | Compliance refs |
|---|---|---|---|---|
| ACC-001 | The journal is a single double-entry ledger (`journalEntries`). Every entry has Σdebit = Σcredit > 0 (asserted in the model layer and the domain), ≥ 2 lines, a business date (`date`, period-determining), a gapless `seq` assigned in the posting transaction, `recordedAt`, actor, `source` link, `text` ≤ 60 chars for DATEV plus an optional long text | MUST | P1/P2 | GOBD-03, GOBD-04, GOBD-05 |
| ACC-002 | Journal entries are generated **only** by the posting engine `src/domain/accounting/post.ts` (pure: event + settings + rule version → lines). Convex `model/journal.ts` persists them. No other code path writes journal entries | MUST | P1/P2 | GOBD-03, GOBD-06 |
| ACC-003 | Every posting stores `ruleVersion` (posting-matrix version) and `roleMappingVersion` and a human-readable `explanation` key, so a booking can be reproduced and explained ("Warum dieses Konto?") | MUST | P1/P2 | GOBD-01, GOBD-06 |
| ACC-004 | Journal entries are immutable from creation (no draft state). Corrections only by a reversal entry (`reversalOfId`, mirrored lines, same accounts, date = posting date of the correction in an open period) plus, if needed, a new correct entry | MUST | P1/P2 | GOBD-06 |
| ACC-005 | Every entry links to its voucher (`source`): sales document, voucher, payment (incl. cash payments with their optional Quittung), bank transaction, cash transfer (`cashTransfers` with its Eigenbeleg, F07 CSH-024/025), asset run, tax filing/payment, manual entry with an attached Eigenbeleg or document. A manual entry without an attachment is rejected unless it is an opening balance or a reversal | MUST | P1/P2 | GOBD-01, GOBD-07 |
| ACC-006 | Posting into a **locked period is impossible** for every path (UI, API, MCP, import, cron) (EC-170, RI-13). Two cases: (a) **user-chosen business dates** (manual payments, cash payments and cash transfers, manual journal entries, backdated documents) inside a locked period are rejected with 409 `period_locked` (consistent with F05 PAY-045, F07 CSH-021…024, EC-022); (b) **externally given dates** (booked bank transactions from the statement import or the Enable Banking feed, incl. ATM withdrawals marked for the till (CSH-025), late-received vouchers, AfA catch-up, Storno/reversal of locked-period records) are posted into the **first open period** with `date` = first day of that period (or today if today is in it), keeping `originalDate` and flagging `latePosting: true` with the reason (F06 EC-VOU-09, F07 EC-BNK-51, EC-162); DATEV export fills „Leistungsdatum" and „Datum Zuord. Steuerperiode" accordingly (F09) | MUST | P2 | GOBD-06, UVA-04 |
| ACC-007 | Chart of accounts seed for SKR03 and SKR04 (§4.1.3) with type, EÜR mapping key, allowed tax rules, `isSystem`, DATEV automatic-account flag. The chart is chosen in setup (**default SKR03**, SKR04 selectable); after the first journal entry of a fiscal year it can only be switched **effective at the next fiscal year start** with a reviewed account mapping table (EC-116; SHOULD, P3) | MUST | P1/P2 | DATEV-02 |
| ACC-008 | **Account roles** (`receivable`, `revenue.domestic.19`, `vat.output.19`, `bank.<accountId>` …) decouple the posting matrix from account numbers. Role → account mapping is versioned per chart with `validFrom`; the owner can override any role (audited, with source text). The shipped mapping uses decided conservative defaults (§4.1.1); an optional, **non-blocking** „Einmalige Prüfung durch Steuerberater“ date can be recorded (`confirmedByAdvisorOn`) — it never gates any function (one-off Steuerberater check before go-live recommended, non-blocking) | MUST | P1/P2 | DATEV-02, GOBD-06 |
| ACC-009 | Custom accounts can be added (number within the chart's range for the type, name, type, EÜR key, tax rule). System accounts cannot be deleted; any account with postings can only be archived | MUST | P2 | GOBD-02 |
| ACC-010 | Personal accounts: each contact with role customer gets a debtor number (10000–69999), supplier a creditor number (70000–99999), length per `datev.accountLength`+1. Journal lines on receivables/payables carry `contactId` (from P1, needed for OPOS); the DATEV export maps them to personal accounts (DATEV-02; export P3, low priority). Without personal accounts mode, the collective accounts are used | MUST | P1 (contactId) / P3 (DATEV mapping) | DATEV-02 |
| ACC-011 | **Manual journal entry** editor (UI/API/MCP-read only): multiple lines, accounts with autocomplete, debit/credit, tax key (computes the VAT line automatically for VAT-relevant accounts), cost centre, contact, text, attachment(s). Preview with balance check. Templates for frequent cases: Darlehen Auszahlung/Tilgung/Zinsen, Umbuchung, Lohn (Nettomethode), Privatentnahme Sachwert, Kfz-Privatnutzung (1 %-Regelung as Eigenbeleg) | MUST | P2 | GOBD-07 |
| ACC-012 | Manual entries are **not** available via MCP write tools (read only via `journal_search`); REST `POST /journal-entries` requires `accounting:write` and an attachment or `source` reference | MUST | P2 | GOBD-07 |
| ACC-013 | **Opening balances** (Eröffnungsbilanz / Saldenvorträge) per fiscal year start: Sachkonten against 9000, open receivables per invoice against 9008, open payables per voucher against 9009. Open items carry the original document reference (number, date, gross, open amount, VAT split for Ist) so later payments clear them. **P1 subset** (needed at go-live): cash account opening balance (CSH-020, CSH-026), bank account opening balances (statement import), open receivables per imported invoice (F09 sevdesk export import) against 9000/9008; all other Sachkonten and open payables in P2 | MUST | P1 (cash, bank, receivables) / P2 (rest) | GOBD-01 |
| ACC-014 | "Buchungsbeginn" (bookkeeping start date) setting: events dated before it produce no journal entries (books were kept elsewhere); events on/after it post normally. The import (F09) sets it. Changing it after the first posting is blocked | MUST | P1 | GOBD-02 |
| ACC-015 | **Period lock (Festschreibung)** per month `YYYY-MM`: sets `periods.status = locked` and `lockedAt` on every journal entry, payment (incl. cash), voucher, sales document, bank transaction and cash transfer of that period in one job; afterwards the immutability triggers reject changes (409 `period_locked`). Locks are irreversible | MUST | P2 | GOBD-06 |
| ACC-016 | Lock reasons: `ustva_submitted` (automatic after the owner records the UStVA submission, all months of the filing period), `zm_submitted` (automatic after the ZM submission record, all months of the ZM period), `euer_submitted` (automatic after the EÜR submission record, all months of the fiscal year, TAX-022), `datev_export` (option in the export dialog, P3), `year_close`, `manual`. Locking month M requires all months < M (within the fiscal year) to be locked or locked in the same action ("Festschreibung erfolgt lückenlos") | MUST | P2 | GOBD-06 |
| ACC-017 | Pre-lock checklist (warnings, not blockers except the first three): (1) drafts dated in the period that would become finalised later → blocker "Entwürfe im Zeitraum"; (2) unbalanced or unposted events (artifact `pending`) → blocker; (2a) from P2: a bank ledger account whose balance at month end differs from the bank-reported balance (statement closing balance or `balanceAfterCents`, RI-27) → blocker (conservative: locking is irreversible, a difference means missing or duplicate transactions; E-ACC-33); (3) unbooked vouchers, unmatched or unbooked booked bank transactions, missing monthly bank statements (EC-156), vouchers without attachment, open Geldtransit balance ≠ 0 (incl. cash deposits not yet matched to a bank credit), cash payments/transfers backdated by more than 10 days in the period (list for review). For the automatic locks after a submission record (`ustva_submitted`, `zm_submitted`, `euer_submitted`) blockers (1), (2) and (2a) block the submission record itself (E-UVA-03) | MUST | P2 | GOBD-04, GOBD-07, AO-05 |
| ACC-018 | Default suggestion: lock month M by the end of month M+1 (sevdesk advice) or right after the UStVA; a `deadlines.notify` reminder is shown if a month older than 2 months is unlocked | SHOULD | P2 | GOBD-06 |
| ACC-019 | Cost centres per document **and per line**; journal lines carry `costCenterId`; DATEV KOST1 | SHOULD | P2 | DATEV-02 |
| ACC-020 | Journal integrity is part of `integrity.verify` (F12): gapless `seq`, balanced entries, no entry in a locked period recorded after the lock (`recordedAt > lockedAt` of the period ⇒ finding) | MUST | P2 | GOBD-05, SEC-04 |
| ACC-021 | Soll/Ist and EÜR/Bilanz never change the journal shape except for the Ist "USt nicht fällig" interim accounts (§4.2). Reports (EÜR, UStVA Ist) derive cash-basis views from **payment allocations** (§4.4), so one journal serves every method | MUST | P2 | UVA-06, AO-02 |
| ACC-022 | Switching Soll ↔ Ist or KU ↔ Regelbesteuerung is only possible **effective at a period start** (Ist/Soll: 1 January, or another date only with a recorded Finanzamt approval (date, reference) — EC-115; KU: per KU-01/KU-04 rules) and stored date-effective in `companyProfile`. The engine applies the method valid at the event's tax point; transitional items follow §5.3 | MUST | P1 | UVA-06, KU-04 |
| ACC-023 | Foreign-currency postings are in EUR; lines keep `currency`, `amountFx` and `fxRate` (source logged); realised FX differences are posted to the FX gain/loss roles (MISC-08) | MUST | P2 | MISC-08 |
| ACC-024 | **Bank transactions from any source** (§4.2.7; statement import CAMT.053/Revolut CSV/MT940 in P1, Enable Banking feed in P2; F07 BNK-030…036, BNK-100…117): only **booked** transactions are journalised, never pending ones (F07 BNK-111, RI-10); the journal `date` is the booking date in Europe/Berlin (F07 BNK-112, EC-155); each bank account and each foreign-currency account/pocket is a `bankAccounts` row with its own ledger account; exchanges between own accounts arrive as two separate transactions and are paired via Geldtransit with realised FX differences to the Kursdifferenzen roles; a fee (separate fee transaction or the `source.feeCents` field) is always a separate line on `expense.bank_fees`; bank fees are booked **VAT-exempt (§4 Nr. 8 UStG), without input VAT and without §13b** as the decided conservative default (one-off Steuerberater check before go-live recommended, non-blocking); a bank reversal is a separate booked counter-transaction posted as a counter-entry, never an edit. **P1** journalises bank-to-invoice matches (§4.2.2 P1/P6/P11), cash transfers (T5, T9) and the transactions the owner **marks** „Privat“ or „Geldtransit“ (T1/T2/T4, event `bank_transaction_marked`, F07 BNK-060/061 — EUR accounts only until the EUR valuation of BNK-028); all other booked bank transactions are journalised from P2 (ACC-027). *Amended 2026-10-13 (F07 P1 slice): BNK-060/061 and T07-090 are P1 and require the posting at marking time; leaving marked rows unposted until P2 would make the mark a silent state without a journal entry.* | MUST | P1 (matches, cash transfers) / P2 (rest) | GOBD-01, GOBD-03, GOBD-07, MISC-08 |
| ACC-025 | Journal search & list: filters (period, account, contact, source kind, text, amount range, late postings, reversals, actor), sorting by `seq`, export CSV; each line links to its source and to the Kontenblatt | MUST | P2 | GOBD-01, GOBD-05 |
| ACC-026 | **Cash postings (P1, owner decision B3)**: the posting engine handles the cash events of F07 CSH-021…025 and CSH-027 with one ledger account per company on role `cash` (SKR03 1000 / SKR04 1600): invoice cash receipt (§4.2.2 P3), cash deposit to the bank via Geldtransit (T5), private withdrawal from cash (T8), ATM withdrawal into the till (T9), reversals (T10) — all P1; voucher paid „bar“ (T6) and voucher paid „privat“ (T7) follow the voucher feature (P2, open question 11). The `cash` account balance in (date, `seq`) order is the only cash balance (CSH-020) and is checked ≥ 0 at every date inside the posting mutation (CSH-026, RI-11). No cash book, no daily close, no Kassendifferenz postings | MUST | P1 (T6/T7: P2) | AO-04, AO-05, GOBD-01, GOBD-03 |
| ACC-027 | **P1 → P2 bank catch-up**: in P1 the bank ledger accounts are incomplete by design (only invoice matches and cash transfers are journalised). From P2 every booked bank transaction not yet journalised is posted with its own booking date (no period is locked before P2, so no late-posting applies); RI-27 balance reconciliation per bank account against the statement closing balance becomes a pre-lock blocker (ACC-017 (2a)) only from P2. Dashboards label bank ledger balances „unvollständig (P1)“ while unbooked transactions exist | MUST | P1/P2 | GOBD-02, GOBD-04 |
| ACC-028 | **Private postings by legal form**: for sole proprietors and partnerships, private withdrawals/deposits post to `private.withdrawal` / `private.deposit`; for corporations (GmbH, UG, AG, GmbH & Co. KG) these roles are **blocked** and the engine uses `shareholder.clearing` (Verrechnungskonto Gesellschafter) with a mandatory shareholder selection and note (conservative default; possible vGA/loan consequences are the owner's responsibility — one-off Steuerberater check before go-live recommended, non-blocking) | MUST | P1 | AO-01, GOBD-01 |

#### 3.1a P1 implementation notes (journal slice, 2026-10-13)

- **Internal API (ACC-002).** Business slices never write journal tables. Inside their own mutation they call `postJournalEntry(ctx, event, options?)` from `convex/model/journal.ts` with a `BusinessEvent` from `src/domain/accounting/events.ts` (`invoice_finalised`, `invoice_cancelled`, `invoice_corrected`, `payment_received`, `advance_payment_received`, `payment_reversed`, `customer_refund`, `writeoff_recovered`, `cash_transfer`, `cash_transfer_reversed`, `bank_transaction_marked`, `bank_transaction_mark_reversed`, `opening_balance`). The call resolves Buchungsbeginn (ACC-014), the period lock (ACC-006: `options.dating = "user"` → 409 `period_locked`; `"external"` → first open period with `originalDate` + `latePosting`), roles → accounts, the gapless `seq`, the audit entry and the cash check (CSH-026), in the caller's transaction. One entry per (source, matrix row); a second posting of the same source is `already_posted` unless the earlier one was reversed; reversal events mirror every un-reversed entry of the original source (`already_reversed` on repeat). Payments against opening receivables call `settleOpeningItem(ctx, openingItemId, cents)` (`convex/model/accounting.ts`) in the same mutation.
- **ACC-006 posting side from P1.** The Festschreibung itself (ACC-015) is P2, but posting already honours `periods` rows with `status ≠ open`, so P2 needs no change to the posting path.
- **ACC-007 seed shape.** The SKR03/SKR04 seed is date-effective rule data (`src/domain/rules/accounting`, tables `chart-skr03`, `chart-skr04`, `account-roles`) with number, name, type, EÜR key, BWA group, DATEV automatic flag, `passThrough` and `verified` (false = number not yet checked against the official DATEV chart, LEGAL-OPEN F08-Q1, shown as „⚠ ungeprüft“). `isSystem` and allowed tax rules arrive with custom accounts (ACC-009, P2). The chart (and the fiscal-year start month) is frozen once the fiscal year has a journal entry (E-ACC-09).
- **ACC-008.** Only owner overrides are stored (`accountRoleMappings`); the shipped mapping `roles-2026.2` is rule data. Overrides may only point at seeded accounts until ACC-009. Entries record `roleMappingVersion = "roles-2026.2"` or `"roles-2026.2+override-<n>"`. The „Einmalige Prüfung durch Steuerberater am“ field (`confirmedByAdvisorOn`) exists in the schema; its UI follows with P2.
- **TST-ACC-02.** The golden posting matrix (`test/golden/posting-matrix`) covers the journal side for SKR03 and SKR04; `expected.datev.csv` is added with the DATEV export (P3).

### 3.2 Assets and depreciation (AST)

| ID | Requirement | Priority | Phase | Compliance refs |
|---|---|---|---|---|
| AST-001 | Asset register (`assets`): inventory number (own number range), name, asset account, acquisition date, cost (net if input VAT deductible, else gross), voucher line link, method, useful life (BMF AfA-Tabelle lookup + custom), cost centre, `ruleVersion`; immutable after the first depreciation posting except disposal and notes | MUST | P2 | AO-03, GOBD-06 |
| AST-002 | Asset creation from a voucher line on an asset account (or with net ≥ 250.01 € on an expense account → suggestion dialog "Als Anlage erfassen?"). The voucher's expense/asset posting and the asset record are created in one transaction | MUST | P2 | AO-03, GOBD-01 |
| AST-003 | The rule engine offers only methods valid for the acquisition date (date-effective table `afaRules`): linear always; degressive 30 % (max 3× linear) for movable assets acquired 2025-07-01..2027-12-31; e-vehicle 75 % first-year special AfA for qualifying purchases 2025-07-01..2027-12-31 (⚠ exact window per §7 Abs. 2a EStG); GWG ≤ 800 € net; Sammelposten 250.01–1,000 € net. JStG-2026 placeholders (GWG 1,200 €, Sammelposten abolished for acquisitions after 2026-12-31) ship as a **disabled** row, activated by a data release once enacted | MUST | P2 | AO-03, MISC-09 |
| AST-004 | Linear AfA monthly pro rata from the acquisition month (month of acquisition counts fully), rounded to cents per month with the last month absorbing the remainder so Σ AfA = cost − (1 € Erinnerungswert, configurable on/off, default off for EÜR) | MUST | P2 | AO-03 |
| AST-005 | Degressive AfA: yearly amount = book value × min(30 %, 3 × linear rate), pro rata temporis in the acquisition year; automatic switch to linear (remaining book value / remaining life) in the first year where linear ≥ degressive (§7 Abs. 3 EStG) | MUST | P2 | AO-03 |
| AST-006 | E-vehicle (`ev_special`): 75 % in the acquisition year, then 10 %, 5 %, 5 %, 3 %, 2 % of cost in years 2–6 (⚠ verify the schedule in §7 Abs. 2a EStG); no pro rata in year 1 (⚠ verify) | MUST | P2 | AO-03 |
| AST-007 | GWG: full write-off in the acquisition month; GWG list (> 250 € net) per year with inventory number, date, cost, voucher. Items ≤ 250 € net are expensed directly without an asset record (option to register anyway) | MUST | P2 | AO-03 |
| AST-008 | Sammelposten: one pool per acquisition year; 20 % per year for 5 years regardless of disposal; disposal of a pool item has no AfA or RBW effect (proceeds are revenue); the GWG/Sammelposten choice is **per fiscal year and uniform** for all items 250.01–1,000 € (§6 Abs. 2a S. 5 EStG) — the engine enforces the yearly choice | MUST | P2 | AO-03 |
| AST-009 | Monthly depreciation run (`assets.depreciate`, cron 1st of month 05:00 for the previous month; manual "AfA jetzt buchen"): one journal entry per asset per month (or per year for annual mode), recorded in `depreciationRuns`; idempotent per (asset, period); skipped for locked periods with a finding | MUST | P2 | AO-03, GOBD-06 |
| AST-010 | Disposal (sale, scrap, withdrawal) mid-year: AfA up to and including the disposal month, then RBW posting; sale requires a linked outgoing invoice (or creates a draft invoice with the asset account mapping for proceeds); withdrawal posts unentgeltliche Wertabgabe at Teilwert (+ VAT if input VAT was deducted) | MUST | P2 | AO-03, GOBD-01 |
| AST-011 | Impairment/außerplanmäßige AfA and change of useful life only as manual entries with reason (no automatic recomputation of past periods) | SHOULD | P2 | GOBD-06 |
| AST-012 | Anlagenspiegel per year: per asset and per account group: Anschaffungskosten 01.01., Zugänge, Abgänge, AfA des Jahres, kumulierte AfA, Buchwert 01.01./31.12.; PDF/CSV export; drill-down to journal | MUST | P2 | AO-03, GOBD-01 |
| AST-013 | Asset depreciation table per asset (planned vs posted), forecast of future AfA for the tax reserve | SHOULD | P2 | AO-03 |

### 3.3 Tax filings and monitors (TAX)

| ID | Requirement | Priority | Phase | Compliance refs |
|---|---|---|---|---|
| TAX-001 | Filing period setting per year (`ustvaPeriod`): suggestion from prior-year tax (> 9,000.00 € → monthly; ≤ 9,000.00 € quarterly; ≤ 2,000 € waiver possible on application), Neugründer rule per year from the date-effective table (⚠ 2027+), deadline calendar incl. Dauerfristverlängerung (+1 month) and §108 Abs. 3 AO weekend/holiday shift (federal + the company's Land holidays) | MUST | P2 | UVA-01 |
| TAX-002 | Dauerfristverlängerung: compute the Sondervorauszahlung = 1/11 of the prior year's advance payments (sum of the prior year's Kz 83 of monthly returns, positive values only ⚠ per §47 UStDV), produce the application sheet (Kz 38), record it as a `taxFilings` row (`sondervorauszahlung`), post the payment, and offset it in the December return (Kz 39). Quarterly filers: no Sondervorauszahlung | MUST | P2 | UVA-02 |
| TAX-003 | UStVA computation from the journal via the **versioned Kennzahlen mapping** (§4.5) for the filing period: Soll by tax point (supply date; advances by receipt), Ist by payment allocations; input VAT by voucher tax point (invoice receipt + supply; 2028+ Ist-supplier rule) | MUST | P2 | UVA-03, UVA-06 |
| TAX-004 | Rounding per form rules (rule data): bases in whole euros (default: cents truncated ⚠), tax amounts in cents; for Kz 81/86/87 the form computes the tax from the base — we show **"laut Formular"** (base × rate) and **"laut Buchhaltung"** (booked VAT) with the difference; Kz 83 = sum of all tax amounts − Kz 39 per form arithmetic | MUST | P2 | UVA-03 |
| TAX-005 | Drill-down: every Kennzahl → contributing journal lines → documents/vouchers; and back (document detail shows "UStVA 2026-09 Kz 81"). `taxFilings.drillDown` stores the frozen contributor list at submission | MUST | P2 | GOBD-01, UVA-03 |
| TAX-006 | **UStVA manual submission flow** (no ERiC in P1–P3): the Kennzahlen sheet with step-by-step Mein ELSTER instructions (TAX-020) → the owner enters and sends the UStVA in Mein ELSTER personally → the owner records the submission (TAX-021: „Übermittelt am“, ELSTER Transferticket, optional protocol PDF, Kz-83 cross-check) → `taxFilings.status = submitted_manually`, `submittedVia = "mein_elster_manual"`, values and drill-down frozen, all months of the filing period locked (`ustva_submitted`). The sheet incl. the instructions is also exportable as PDF/CSV (F09) | MUST | P2 | UVA-04, GOBD-06 |
| TAX-007 | **Correction filing** (berichtigte Anmeldung, Kz 10 = 1): when postings with a tax point in a submitted period appear (late documents, Storno of a supply in that period under special rules, manual reclassification), the period shows "Korrektur erforderlich" with the delta per Kennzahl; the owner creates a `ustva_correction` filing with the **complete** corrected values; on confirmation the previous filing becomes `superseded`. Corrections never unlock the period | MUST | P2 | UVA-03, UVA-04, GOBD-06 |
| TAX-008 | Tax point assignment: each VAT-relevant journal line carries `taxPointDate` and `taxPeriod` (computed by the domain from method, supply date, payment date, advance flag, receipt date). The UStVA reads `taxPeriod`, not `date` | MUST | P2 | UVA-06, UST-40 |
| TAX-009 | **ZM** per period (monthly or quarterly per §18a, monitor of the 50,000 € quarterly goods threshold): per customer USt-IdNr (country prefix + number) and type (L = igL, S = §3a Abs. 2 service, D = Dreiecksgeschäft), amounts in whole euros, negative values allowed for corrections; due on the 25th. Filing: **manual entry in Mein ELSTER** („Zusammenfassende Meldung“) with the TAX-020 instructions (default); alternative: CSV upload in the BZSt-Online-Portal (CSV in the BZSt layout ⚠ layout; one-off Steuerberater check before go-live recommended, non-blocking); submission record per TAX-021 (cross-check: Σ amounts) → `zm_submitted` lock of the ZM months; corrections per original period | MUST | P2 | UVA-05 |
| TAX-010 | ZM ↔ UStVA reconciliation: Σ ZM L = Kz 41, Σ ZM S = Kz 21 for the same months; differences block the "ZM übermittelt" confirmation with a warning that can be overridden with a reason | SHOULD | P2 | UVA-05, GOBD-03 |
| TAX-011 | KU mode: UStVA disabled unless §13b/igE liabilities exist (then only those Kennzahlen); ZM disabled | MUST | P2 | KU-05 |
| TAX-012 | **Kleinunternehmer monitor** (KU-01): rolling Gesamtumsatz (net, per §19 Abs. 2 definition; excluding asset sales ⚠) for the prior and current year; warnings at 80 % and 95 % of 25,000 € (prior year) / 100,000 € (current year); founding year 25,000 € hard cap; the invoice that would cross 100,000 € opens a blocking dialog and is taxed normally, as are all later ones; dashboard progress bars | MUST | P1 | KU-01 |
| TAX-013 | **800k monitors**: (a) §141 AO / §241a HGB: turnover 800,000 € or profit 80,000 € (EÜR) → info that bookkeeping duty starts only after notification by the Finanzamt; (b) ER-03: prior-year Gesamtumsatz > 800,000 € (2026 for 2027) → E-Rechnung issuing mandatory; (c) §20 UStG Ist limit: prior-year Gesamtumsatz > 800,000 € → warning that Ist-Versteuerung must end next year. Values feed `priorYearTotalTurnoverCents` | MUST | P1 | AO-01, ER-03, UVA-06 |
| TAX-014 | EÜR blocked for legal forms with mandatory bookkeeping (GmbH, UG, AG, OHG, KG, GmbH & Co. KG); Bilanz companies get the journal, SuSa, BWA-light and the DATEV export (P3, low priority), no EÜR and no EÜR filing. The tax pages show the notice „Jahresabschluss und E-Bilanz sind nicht Teil dieser Software (AO-07). Dafür benötigen Sie ein externes Programm oder einen Steuerberater.“ UStVA/ZM sheets and submission records work for every legal form | MUST | P1 | AO-01, AO-07 |
| TAX-015 | **EÜR report** for a tax year (calendar year): income and expenses by payment date from payment allocations (§4.4; cash receipts and cash expenses included like bank payments), AfA from depreciation runs, Anlage-EÜR line mapping versioned per year via semantic keys (§4.6), USt received/paid and Finanzamt payments/refunds lines, private withdrawals/deposits incl. those via the cash account and vouchers paid privately (information), non-deductible expenses (Bewirtung 30 %, GewSt) shown and added back per form; filing per TAX-022 | MUST | P3 | AO-02 |
| TAX-016 | **10-day rule** (§11 EStG, BFH X R 44/16) for recurring payments around year end: payments made 22.12.–10.01. **and** due in the same window are allocated to the year they economically belong to. Applied automatically to UStVA payments (due date from the filing calendar incl. Dauerfristverlängerung), configurable for other recurring items (rent, insurance) via a "regelmäßig wiederkehrend" flag on vouchers/recurring vouchers | MUST | P3 | AO-02 |
| TAX-017 | **OSS block** (P1): for B2C supplies to other EU states, track the EU-wide 10,000 € threshold (current + prior year); finalising an invoice that would exceed it (or any once exceeded) is blocked with the message in §5; P4: destination rates, OSS report per country/rate, 10-year retention class | MUST (block) / COULD (P4 report) | P1 / P4 | UVA-07 |
| TAX-018 | Tax payments: "Steuerzahlung" voucher kind (`tax_payment`) with subtypes USt-Vorauszahlung (period), Sondervorauszahlung, USt Jahreszahlung, Gewerbesteuer, ESt/KiSt/Soli (private), KSt; linked to the filing; posting per §4.2.9; bank matching rule suggests the subtype from the Finanzamt reference | MUST | P2 | GOBD-07 |
| TAX-019 | Deadline calendar and notifications: UStVA, ZM (25th), Sondervorauszahlung application (10 Feb), ESt/GewSt Vorauszahlungen (user-entered amounts; dates 10.03/10.06/10.09/10.12 and 15.02/15.05/15.08/15.11), §14a 15th-of-month (UST-02 from F04), and — because the owner files without a Steuerberater — the annual returns (EÜR with ESt/Feststellung, USt-Jahreserklärung, GewSt) at the **deadline for self-filers** from the date-effective table (default 31 July of the following year, §149 Abs. 2 AO; transitional extensions only as rule data ⚠), with a reminder 6 weeks and 1 week before — all via `deadlines.notify` | MUST | P2 | UVA-01, AO-02 |
| TAX-020 | **Mein ELSTER instructions (Ausfüllhilfe)** for UStVA, Sondervorauszahlung (USt 1 H), UStVA correction, ZM, Anlage EÜR (+ AVEÜR) and the USt-Jahreserklärung worksheet, as **versioned rule data per form and year** (`src/domain/rules/elster/<form>-<year>.ts`, e.g. `elster-ustva-2026`): (1) one-time prerequisites (ELSTER-Unternehmenskonto/certificate, Steuernummer in the company profile); (2) the **navigation path** in Mein ELSTER (e.g. „Formulare & Leistungen → Alle Formulare → Umsatzsteuer → Umsatzsteuer-Voranmeldung“ ⚠ labels verified per data release) and the **form year** to select (the year of the period, never „the current year“; a warning when a December/Q4 period is filed in January); (3) ordered steps in form order (page/section), each field with Kz or Zeile, the official label, the value **formatted as the form expects** (TAX-004 rounding: bases in whole euros, tax amounts in euro and cent; decimal comma, no thousands separator, no € sign, leading minus for negative values) and a „Kopieren“ button copying exactly that string; zero fields are marked „leer lassen“ (Kz 83 is always shown); a per-field „eingetragen“ tick (UI state only); (4) for corrections the explicit step „Berichtigte Anmeldung: Ja (Kz 10 = 1)“ with **complete** values; (5) a **final checklist** before „Absenden“ in ELSTER: Steuernummer and period correct, form year correct, all values entered, ELSTER's „Prüfen“ without errors, the ELSTER preview shows the same Kz 83 / total as the app, then send and save the Übermittlungsprotokoll (PDF) and the Transferticket. Conservative gates: the copy buttons stay disabled while blockers exist (drafts or pending artifacts with tax point in the period, ACC-017 (2a), mapping or guide data for the year missing or marked unverified — E-UVA-07/E-UVA-20); the guide computes a `sheetHash` (sha256 over form, period, rule versions and values shown) | MUST | P2 (UStVA, correction, USt 1 H, ZM) / P3 (EÜR, USt-Jahr) | UVA-03, UVA-04, UVA-05, AO-02, GOBD-01 |
| TAX-021 | **Submission record** (UStVA, UStVA correction, ZM, ZM correction, Sondervorauszahlung, EÜR): „Übermittelt am“ (date, ≤ today, after the period end; EÜR: after the fiscal year end), **Transferticket mandatory** (conservative default; E-UVA-01), optional Übermittlungsprotokoll PDF (archived with sha256, retention 10 years as a tax filing record), the cross-check value read from the ELSTER protocol/preview (UStVA: Kz 83; ZM: Σ amounts; Sondervorauszahlung: Kz 38; EÜR: Gewinn/Verlust) and the `sheetHash` the owner worked from. The app recomputes the values: if they differ from the `sheetHash` the record is blocked (E-UVA-18); if the cross-check value differs from the app's value the record is blocked unless the owner chooses „abweichend übermittelt“ with a mandatory reason — then the filing is stored with the app's values plus `elsterReportedTotalCents` and `submittedValuesDiffer: true`, and the correction worklist (TAX-007) opens immediately (E-UVA-19). On success: `status = submitted_manually`, `submittedVia = "mein_elster_manual"`, values and drill-down frozen, lock per ACC-016, audit `tax_filing.submit` with actor `user:<id>` | MUST | P2 (UStVA, ZM, Sondervorauszahlung + corrections) / P3 (EÜR) | UVA-04, GOBD-06, GOBD-07, GOBD-20 |
| TAX-022 | **EÜR filing (yearly)**: for EÜR companies the Anlage-EÜR line sheet of TAX-015 (and, if assets exist, the Anlage AVEÜR values from the Anlagenspiegel AST-012) with TAX-020 instructions (path differs by legal form: sole proprietors within the Einkommensteuererklärung; partnerships within the Feststellungserklärung ⚠ path labels per data release); preconditions (blocking): the fiscal year has ended, all UStVA filings of the year are submitted, the Anlage-EÜR mapping for the year is verified (E-UVA-20), ACC-017 blockers clear for all months. Submission record per TAX-021 → `taxFilings.kind = "euer"`, `period = "YYYY"`, `submittedVia = "mein_elster_manual"`, lock `euer_submitted` for all months of the year. Later postings with an original date in that year follow ACC-006 and are listed under „Nach Abgabe der EÜR {Jahr} erfasst“ with the hint to check a berichtigte Erklärung in ELSTER (no EÜR correction filing kind in v1.1) | MUST | P3 | AO-02, GOBD-06 |
| TAX-023 | **USt-Jahreserklärung worksheet**: year totals per line of the annual return (versioned mapping `ust-annual-<year>`, ⚠ lines verified per data release) computed from the journal by `taxPeriod`, reconciled with the latest submitted UStVA per period (difference = expected Abschlusszahlung/Erstattung, listed per cause); Mein ELSTER instructions per TAX-020; PDF/CSV export; no submission record and no lock (months are already locked by the UStVA records) | SHOULD | P3 | UVA-03, GOBD-01 |
| TAX-024 | **ERiC direct transmission (P4 option)**: UStVA, ZM (later EÜR) sent from the app through an ERiC sidecar using the owner's ELSTER organisation certificate (stored encrypted under `APP_ENCRYPTION_KEY`); requires ELSTER developer registration and the ERiC licence (01-compliance open item 7); always preceded by the same sheet and an explicit owner confirmation in the UI; Transferticket and protocol stored automatically; `submittedVia = "eric"`; same lock as TAX-021; never exposed via MCP or API keys; tested against the ELSTER test environment | COULD | P4 | UVA-04 |

### 3.4 Reports, tax reserve, forecast (RPT)

| ID | Requirement | Priority | Phase | Compliance refs |
|---|---|---|---|---|
| RPT-001 | Every report figure drills down to journal lines → source documents and back; every report shows its parameters, the generation time (Europe/Berlin), the rule versions used, and the lock status of the covered periods ("vorläufig" if unlocked) | MUST | P3 | GOBD-01, GOBD-22 |
| RPT-002 | **Dashboard KPIs** (period selector month/quarter/year/custom): revenue (net), expenses (net), result, open receivables/overdue/due in 7 days, open payables, bank balances per bank account/currency pocket (EUR equivalent; bank-reported balance next to the ledger balance, ACC-027), cash balance (`cash` account), USt-Zahllast of the current filing period, AfA YTD, tax reserve, KU/800k progress, to-dos (§4.7 of 04-ui-ux) | MUST | P3 | — |
| RPT-003 | **BWA-light** (modelled on DATEV BWA Form 01, simplified): Umsatzerlöse, Bestandsveränderungen (n/a), Gesamtleistung, Material/Wareneinkauf, Rohertrag, Personalkosten, Raumkosten, Steuern/Versicherungen/Beiträge, Kfz, Werbe-/Reisekosten, Abschreibungen, Reparaturen, sonstige Kosten, Betriebsergebnis, neutraler Aufwand/Ertrag, vorläufiges Ergebnis; columns month, YTD, prior-year same period, % of Gesamtleistung; variants accrual (journal) and cash (EÜR basis); cost-centre filter | MUST | P3 | GOBD-01 |
| RPT-004 | **Summen- und Saldenliste**: per account: opening balance (EB-Wert), debit/credit of period, debit/credit YTD, balance; filters month/quarter/year, account class, include personal accounts; totals per class; Σ debit = Σ credit check shown | MUST | P3 | GOBD-05 |
| RPT-005 | **Kontenblatt** (account ledger): per account and range: opening balance, chronological lines (date, seq, Belegfeld 1, text, contra account, debit, credit, running balance), closing balance; printable/PDF/CSV | MUST | P3 | GOBD-01, GOBD-05 |
| RPT-006 | **Open items (OPOS)** for debtors and creditors as of a date (`as_of` reconstructs history from payments/write-offs ≤ date): per document gross, paid, open, due date, days overdue, dunning level; aging buckets (nicht fällig, 1–30, 31–60, 61–90, > 90); reconciles to the receivable/payable account balance (difference shown) | MUST | P3 | GOBD-01 |
| RPT-007 | **Revenue reports**: by customer, by product, by month, by cost centre/project; net and gross; based on finalised documents (accrual, by document date or supply date — selectable) or on payments (cash); Storno/corrections netted; top-N charts | MUST | P3 | — |
| RPT-008 | **Journal report** (Buchungsjournal) by `seq` and date with filters; PDF/CSV; shows reversals and late postings | MUST | P2 | GOBD-05 |
| RPT-009 | **USt-Verprobung** (reconciliation): booked output/input VAT per rate vs. revenue/expense bases × rate; differences listed per document | SHOULD | P3 | GOBD-03 |
| RPT-010 | **Tax reserve estimator** (`tax_reserve_estimate`): (a) USt: open liability of the current and not-yet-paid periods; (b) income tax for Einzelunternehmer/Freiberufler/partners (per-partner share): projected annual profit (YTD EÜR/accrual result annualised or user override) − user-entered deductions → zvE → §32a tariff of the year (single or Splitting) → ESt; Soli with Freigrenze and Milderungszone; KiSt 8 % / 9 % (Land) or none; (c) GewSt for Gewerbetreibende: (Gewinn + 0 Hinzurechnungen (estimate) − Freibetrag 24,500 € for natural persons/partnerships, rounded down to 100 €) × 3.5 % × Hebesatz; §35 credit = min(4.0 × Messbetrag, GewSt paid, ESt attributable); (d) corporations: KSt 15 % + Soli 5.5 % + GewSt without Freibetrag; minus Vorauszahlungen already paid; result: amount to reserve now and monthly suggestion. Formulas are versioned per year; missing year → last known year + banner "Tarif {Jahr} noch nicht hinterlegt" | MUST | P3 | — |
| RPT-011 | Tax reserve UI and API always label the result "Schätzung – keine Steuerberatung", list all assumptions and inputs, and never present it as a filing value | MUST | P3 | — |
| RPT-012 | **Cash-flow forecast** (90 days, daily points, weekly aggregation in the chart): opening = current bank-reported balances of all bank accounts/currency pockets (EUR equivalent; latest statement import or feed) + the `cash` account balance; inflows = open receivables at expected payment date (due date + customer's payment delay, §4.8), recurring invoices (next runs), planned manual items; outflows = open payables by due date, recurring vouchers, tax payments (UStVA estimates at deadlines, Sondervorauszahlung, ESt/GewSt Vorauszahlungen), subscription fees; scenarios "erwartet" (median delay) and "vorsichtig" (P80 delay, inflows −10 %); warning threshold (user-set minimum balance) | MUST | P3 | — |
| RPT-013 | Forecast items list with source, expected date, amount, confidence; manual planned items (one-off or recurring) can be added/edited (not bookkeeping data; stored in `plannedCashItems`) | SHOULD | P3 | — |
| RPT-014 | All reports exportable as CSV (UTF-8 with BOM, `;`, decimal comma) and PDF; CSV columns are documented and stable (Z2 evaluations, GOBD-11) | MUST | P3 | GOBD-11 |
| RPT-015 | Reports are computed by pure domain functions over a read model; heavy reports (SuSa year, EÜR) are cached per (report, params, journal head `seq`) and invalidated when `seq` advances | SHOULD | P3 | — |

## 4. Workflows and state machines

### 4.1 Chart of accounts and roles

#### 4.1.1 Account roles and defaults (decided conservative defaults)

The posting matrix speaks only in **roles**; this table maps roles to accounts. Version `roles-2026.2` (v1.1: `cash.<book>` → `cash`, `bank.<pocket>` → `bank.<accountId>`, new `shareholder.clearing`). "Auto" = DATEV automatic account (VAT derived by DATEV; no BU key in the export). **Decided defaults:** rows with a number are used as shipped; rows marked ⚠ are used as shipped and show a ⚠ badge in „Rollen & Standardkonten“; rows marked **UNSURE** ship **unmapped** — every posting that needs such a role is **blocked** with „Für „{Rolle}“ ist noch kein Konto zugeordnet. Bitte unter Buchhaltung → Konten → Rollen ein Konto anlegen oder zuordnen.“ (block rather than guess), and the setup checklist lists unmapped roles that the company's settings make reachable (legal form, PV supplies, supplier advances). (One-off Steuerberater check of the whole mapping before go-live recommended, non-blocking.)

| Role | Meaning | SKR03 | SKR04 | Auto | Note |
|---|---|---|---|---|---|
| `bank.<accountId>` | Bank account in EUR (any bank; e.g. the Revolut EUR account) | 1200 | 1800 | | One ledger account per `bankAccounts` row; additional accounts 1210, 1220 … / 1810, 1820 … |
| `bank.<accountId>.fx` | Foreign-currency bank account (e.g. a Revolut USD/GBP pocket) = Fremdwährungskonto | 1210+ | 1810+ | | Valued in EUR (moving average, §4.2.7); §256a HGB year-end revaluation Bilanz-only (out of scope, AO-07) |
| `cash` | Kasse (the single cash account, F07 CSH-020) | 1000 | 1600 | | P1; never negative (CSH-026); no cash book |
| `transit` | Geldtransit | 1360 | 1460 | | Transfers between own accounts, FX exchanges, cash deposits to the bank, ATM withdrawals into the till |
| `clearing.<provider>` | Payment provider clearing (online payments — deferred) | 1361 ⚠ | 1461 ⚠ | | Custom account to create; only with the deferred online-payment feature |
| `receivable` | Forderungen aLuL (collective) | 1400 | 1200 | | Debtors 10000–69999 in DATEV |
| `payable` | Verbindlichkeiten aLuL (collective) | 1600 | 3300 | | Creditors 70000–99999 |
| `advance.received.19` / `.7` | Erhaltene Anzahlungen 19 % / 7 % USt | 1718 ⚠ / 1711 ⚠ | 3272 ⚠ / 3271 ⚠ | | Abschlagsrechnungen (UST-40) |
| `vat.output.19` / `.7` | Umsatzsteuer 19 % / 7 % | 1776 / 1771 | 3806 / 3801 | | |
| `vat.output.notdue.19` / `.7` | Umsatzsteuer nicht fällig (Ist) | 1766 ⚠ / 1761 ⚠ | 3816 ⚠ / 3811 ⚠ | | Ist-Versteuerung interim |
| `vat.input.19` / `.7` | Abziehbare Vorsteuer 19 % / 7 % | 1576 / 1571 | 1406 / 1401 | | |
| `vat.input.notyet` | Vorsteuer noch nicht abziehbar | UNSURE | UNSURE | | Ships unmapped (blocked until mapped); advance payments to suppliers (V11), 2028+ Ist suppliers (V12) |
| `vat.input.ige.19` / `.7` | Vorsteuer aus igE | 1574 / 1572 | 1404 / 1402 | | |
| `vat.output.ige.19` / `.7` | Umsatzsteuer aus igE | 1774 / 1772 | 3804 / 3802 | | |
| `vat.input.13b.19` | Vorsteuer nach §13b 19 % | 1577 | 1407 | | |
| `vat.output.13b.19` | Umsatzsteuer nach §13b 19 % | 1787 | 3837 | | |
| `vat.import` | Entstandene Einfuhrumsatzsteuer | 1588 | 1433 | | Kz 62 |
| `vat.prepayment` | Umsatzsteuer-Vorauszahlungen | 1780 | 3820 | | |
| `vat.special_prepayment` | Umsatzsteuer-Vorauszahlung 1/11 | 1781 | 3830 | | |
| `vat.prior_year` | Umsatzsteuer Vorjahr | 1790 ⚠ | 3841 ⚠ | | |
| `private.withdrawal` | Privatentnahmen allgemein | 1800 | 2100 | | Sole proprietors/partnerships only; blocked for corporations (ACC-028) |
| `private.deposit` | Privateinlagen | 1890 | 2180 | | Vouchers paid privately (CSH-023); blocked for corporations (ACC-028) |
| `shareholder.clearing` | Verrechnungskonto Gesellschafter (corporations) | UNSURE | UNSURE | | Ships unmapped; the setup for a corporation asks to create a custom account „Verrechnungskonto Gesellschafter {Name}“ in the liability/receivable range the owner chooses; used instead of `private.*` (ACC-028, CSH-023/024) |
| `private.taxes` | Privatsteuern | 1810 | 2150 | | ESt/KiSt/Soli paid from business |
| `revenue.domestic.19` / `.7` | Erlöse 19 % / 7 % USt | 8400 / 8300 | 4400 / 4300 | Auto | |
| `revenue.zero_pv` | Erlöse 0 % (§12 Abs. 3) | UNSURE | UNSURE | | Ships unmapped: finalising an invoice with category Z is blocked until the owner maps it (Kz 87) |
| `revenue.icsupply` | Steuerfreie igL §4 Nr. 1b | 8125 | 4125 | Auto | Kz 41, ZM L |
| `revenue.export` | Steuerfreie Umsätze §4 Nr. 1a | 8120 | 4120 | Auto | Kz 43 |
| `revenue.eu_service_rc` | Erlöse EU-Leistungen, Empfänger schuldet USt | 8336 | 4336 | Auto | Kz 21, ZM S |
| `revenue.13b_domestic` | Erlöse aus Leistungen nach §13b | 8337 | 4337 | Auto | Kz 60 |
| `revenue.not_taxable` | Im Inland nicht steuerbare Umsätze (Drittland) | 8338 | 4338 | Auto | Kz 45 |
| `revenue.exempt_4` | Steuerfreie Umsätze §4 Nr. 8 ff. | 8100 | 4100 | Auto | Kz 48 |
| `revenue.ku` | Erlöse Kleinunternehmer §19 | 8195 | 4185 | | No UStVA |
| `revenue.withdrawal.19` / `.7` | Unentgeltliche Wertabgaben (Waren) | 8910 / 8915 | 4620 / 4610 | Auto | Kz 81/86 |
| `skonto.granted.19` / `.7` | Gewährte Skonti | 8736 / 8731 | 4736 / 4731 | Auto | |
| `skonto.received.19` / `.7` | Erhaltene Skonti | 3736 / 3731 | 5736 / 5731 | Auto | |
| `writeoff.19` / `.7` / `.0` | Forderungsverluste | 2406 / 2401 / 2400 | 6936 / 6931 / 6930 | Auto (19/7) | |
| `writeoff.recovery` | Erträge aus abgeschriebenen Forderungen | 2732 ⚠ | 4925 ⚠ | | §17 Abs. 2 Nr. 1 S. 2 |
| `income.interest_default` | Verzugszinsen / sonstige Zinserträge | 2650 | 7100 | | No VAT |
| `income.other_nontaxable` | Sonstige Erträge (Mahngebühren, 40-€-Pauschale) | 2700 ⚠ | 4830 ⚠ | | Schadensersatz, no VAT |
| `expense.bank_fees` | Nebenkosten des Geldverkehrs | 4970 | 6855 | | Bank fees (separate fee transactions, `source.feeCents`, account/plan, exchange, card FX fees), VAT-exempt default (§4 Nr. 8 UStG), no §13b |
| `expense.goods.19` / `.7` | Wareneingang 19 % / 7 % | 3400 / 3300 | 5400 / 5300 | Auto | |
| `expense.services` | Fremdleistungen | 3100 | 5900 | | |
| `expense.ige.19` / `.7` | Innergemeinschaftlicher Erwerb 19 % / 7 % VSt und USt | 3425 / 3420 | 5425 / 5420 | Auto | Kz 89/93, 61 |
| `expense.13b_eu.19` | Sonstige Leistungen EU-Unternehmer 19 % VSt und USt | 3123 ⚠ | 5923 ⚠ | Auto | Kz 46/47, 67 |
| `expense.13b_foreign.19` | Leistungen ausländischer Unternehmer 19 % VSt und USt | 3125 ⚠ | 5925 ⚠ | Auto | Kz 84/85, 67 |
| `expense.13b_domestic.19` | Bauleistungen inländischer Unternehmer 19 % VSt und USt | 3120 ⚠ | 5920 ⚠ | Auto | Kz 84/85, 67 |
| `expense.entertainment` | Bewirtungskosten (abziehbar, 70 %) | 4650 | 6640 | | MISC-05 |
| `expense.entertainment.nd` | Nicht abzugsfähige Bewirtungskosten (30 %) | 4654 | 6644 | | |
| `expense.staff_events` | Freiwillige soziale Aufwendungen (Mitarbeiterbewirtung) | 4140 ⚠ | 6130 ⚠ | | |
| `expense.fx_loss` / `income.fx_gain` | Aufwendungen / Erträge aus Kursdifferenzen | 2150 / 2660 | 6880 / 4840 | | MISC-08 |
| `expense.trade_tax` | Gewerbesteuer | 4320 | 7610 | | Not deductible (§4 Abs. 5b EStG) |
| `expense.corp_tax` | Körperschaftsteuer | 2200 | 7600 | | Corporations |
| `asset.office` / `asset.vehicle` / `asset.software` | Büroeinrichtung / Pkw / Software | 0420 / 0320 / 0027 | 0650 / 0520 / 0135 | | |
| `asset.gwg` / `asset.pool` | GWG / Sammelposten | 0480 / 0485 | 0670 / 0675 | | |
| `afa.tangible` / `afa.vehicle` / `afa.intangible` | AfA Sachanlagen / Kfz / immaterielle WG | 4830 / 4832 / 4822 | 6220 / 6222 / 6200 | | |
| `afa.gwg` / `afa.pool` / `afa.extraordinary` | Sofortabschreibung GWG / AfA Sammelposten / außerplanmäßige AfA | 4855 / 4862 / 4840 ⚠ | 6260 / 6264 / 6230 ⚠ | | |
| `disposal.rbw.loss` / `.gain` | Anlagenabgänge Restbuchwert bei Buchverlust / Buchgewinn | 2310 / 2315 | 6895 / 4855 | | |
| `disposal.proceeds.loss.19` / `.gain.19` | Erlöse Anlagenverkäufe 19 % bei Buchverlust / Buchgewinn | 8801 / 8820 | 6885 / 4845 | Auto | |
| `opening.gl` / `.debtors` / `.creditors` | Saldenvorträge Sachkonten / Debitoren / Kreditoren | 9000 / 9008 / 9009 | 9000 / 9008 / 9009 | | |

#### 4.1.2 DATEV BU keys (versioned table `datevBuKeys-2026.1`; DATEV export P3, low priority)

The DATEV export (F09) is kept for a **future Steuerberater** and is P3, low priority. Internal journal entries never depend on BU keys (they carry explicit VAT lines and `taxKey`). Used only when the target account is **not** an automatic account. The export field allows up to 4 characters in format version 13 (⚠). Decided default: the export writes the keys below; ⚠ keys are written as listed and the export dialog shows „Vor dem ersten Import beim Steuerberater/DATEV testen“ (one-off check with a real test import before the first handover recommended, non-blocking for the app; 01-compliance open item 5).

| BU | Meaning | Certainty |
|---|---|---|
| 2 | Umsatzsteuer 7 % | from research (DATEV-02) |
| 3 | Umsatzsteuer 19 % | from research |
| 8 | Vorsteuer 7 % | from research |
| 9 | Vorsteuer 19 % | from research |
| 40 | Aufhebung der Automatik | from research |
| 1 | Umsatzsteuerfrei (mit Vorsteuerabzug) | ⚠ |
| 18 / 19 | Innergemeinschaftlicher Erwerb 7 % / 19 % (VSt und USt) | ⚠ |
| 46 | §13b Abs. 1 sonstige Leistungen EU-Unternehmer 19 % | ⚠ |
| 91 / 94 | §13b Abs. 2 Leistungsempfänger schuldet Steuer 7 % / 19 % | ⚠ |

Reversal entries are exported with "Generalumkehr (GU)" = 1 (column 118) instead of legacy BU prefixes (⚠; decided default, verified with the first real test import).

#### 4.1.3 Chart seed

The seed (`src/domain/rules/accounting/skr03.ts`, `skr04.ts`) contains every account referenced in §4.1.1 plus ~120 common expense/income accounts per chart (Miete, Strom, Telefon, Internet, Porto, Bürobedarf, Zeitschriften, Fortbildung, Beiträge, Versicherungen, Kfz-Kosten (laufend, Versicherung, Steuer, Reparatur, Leasing), Reisekosten Unternehmer (Fahrt, Übernachtung, Verpflegung), Werbekosten, Geschenke (abziehbar/nicht abziehbar), Rechts- und Beratungskosten, Buchführungskosten, Abschluss- und Prüfungskosten, EDV-Kosten/Software-Miete, Lizenzen, Reparaturen, Fremdleistungen, Löhne/Gehälter/gesetzliche Sozialaufwendungen (Nettomethode), Zinsaufwand, Darlehen, Kapitalkonten) with: number, name (DATEV wording), type, `automaticVatAccount`, allowed tax rules, EÜR key (§4.6), BWA group (§4.9). A unit test asserts that every role except the ones marked UNSURE (unmapped by design, §4.1.1) resolves to a seeded account in both charts, that every UNSURE role blocks its postings until mapped, and that every seeded account has an EÜR key and a BWA group. SKR03 is the setup default.

### 4.2 Posting matrix (version `posting-2026.1`)

Notation: **S** = debit (Soll), **H** = credit (Haben); amounts: N = net, V = VAT, G = gross. Internal journal entries always carry **explicit VAT lines** with `taxKey` on the base line; the DATEV writer (F09) collapses base + VAT into one gross line for automatic accounts or adds the BU key. "Ist" = Ist-Versteuerung, "Soll" = Soll-Versteuerung. EÜR effects are derived from payment allocations (§4.4), not from this matrix.

#### 4.2.1 Sales

| # | Event | Soll-Versteuerung | Ist-Versteuerung | UStVA / ZM | Notes |
|---|---|---|---|---|---|
| S1 | Invoice finalised, domestic 19 % (per VAT group) | S `receivable` G · H `revenue.domestic.19` N · H `vat.output.19` V | S `receivable` G · H `revenue.domestic.19` N · H `vat.output.notdue.19` V | Soll: Kz 81 at tax point (supply); Ist: at payment | Date = invoice date; tax point per TAX-008 |
| S2 | Invoice with mixed rates | One entry, one revenue + VAT pair per (category, rate, revenue account) group | same with `notdue` | 81 + 86 | Group VAT exactly as on the invoice (UST-10) |
| S3 | KU invoice | S `receivable` G · H `revenue.ku` G | same | none | KU-02 |
| S4 | EU B2B service (AE) | S `receivable` N · H `revenue.eu_service_rc` N | same | Kz 21 + ZM "S" at tax point (always end of the supply month, also for Ist ⚠ §13b Abs. 1) | UST-20 |
| S5 | Intra-Community supply (K) | S `receivable` N · H `revenue.icsupply` N | same | Kz 41 + ZM "L" (tax point: issue of invoice, at the latest end of month after supply, §13 Abs. 1 Nr. 6) | UST-21 |
| S6 | Domestic §13b supply (AE) | S `receivable` N · H `revenue.13b_domestic` N | same | Kz 60 | UST-22 |
| S7 | Export (G) / not taxable (O) / exempt (E) | H `revenue.export` / `revenue.not_taxable` / `revenue.exempt_4` | same | Kz 43 / 45 / 48 | UST-23 |
| S8 | PV zero rate (Z) | H `revenue.zero_pv` | same | Kz 87 | UST-15 |
| S9 | Abschlagsrechnung (and amount-based Teilrechnung, treated as an Anzahlung, F04 §4.2.5) finalised | **No journal entry** (memo open item in the subledger; shows in OPOS as "Anzahlungsanforderung") | same | none until payment | UST-40 |
| S10 | Payment on Abschlagsrechnung | S `bank` G · H `advance.received.19` N · H `vat.output.19` V | same (Mindest-Ist applies to both) | Kz 81 in the payment's period | UST-40 |
| S11 | Schlussrechnung finalised | S `receivable` G(total) · H revenue N(total) · H `vat.output.*` V(total) (Ist: `notdue` only for the not-prepaid part); then clearing: S `advance.received.*` N(adv) · S `vat.output.*` V(adv) · H `receivable` G(adv) — per advance at the advance's rate (rate change handled per UST-41) | as left, but VAT for the remainder goes to `notdue` | Kz 81 for the remainder only (advance VAT already declared) | UST-41 |
| S12 | Stornorechnung | Reversal of the original entry (mirrored lines) dated on the Storno date, `reversalOfId` = original entry, GU flag in DATEV | same incl. `notdue` lines | Negative Kz values in the Storno's tax period (§17) | UST-30 |
| S13 | Rechnungskorrektur (partial credit) | S revenue N · S `vat.output.*` V · H `receivable` G. A credit of an Abschlags-/Teilrechnung posts nothing (S9: nothing was booked; e.g. the EC-071 reduction to the received amount); a Rechnungsberichtigung (384) posts nothing (same amounts) | `notdue` instead | Negative values in the correction's period | UST-33 |
| S14 | Unentgeltliche Wertabgabe (goods withdrawal) | S `private.withdrawal` G · H `revenue.withdrawal.19` N · H `vat.output.19` V | same (no payment) | Kz 81 | Eigenbeleg required |

#### 4.2.2 Payments and differences (sales side)

| # | Event | Soll | Ist | UStVA | Notes |
|---|---|---|---|---|---|
| P1 | Customer payment (bank; bank-to-invoice match from the statement import in P1, Enable Banking feed from P2) | S `bank` · H `receivable` | same **plus** S `vat.output.notdue.r` · H `vat.output.r` for the VAT share of the payment per rate (pro rata to the invoice's VAT groups, cent remainder to the largest group) | Ist: Kz 81/86 base share in the payment's period | UVA-06 |
| P2 | Partial payments across periods | P1 per payment | P1 per payment; the last payment absorbs rounding so Σ VAT shares = invoice VAT | each period gets its share | Test TST-ACC-14 |
| P3 | Invoice paid in cash („Bar bezahlt“, F07 CSH-021) — **P1** | S `cash` · H `receivable` | + Ist transfer as P1 | Ist: in the cash payment's period | Dating rules, backdate reason and never-negative check per CSH-021/CSH-026; excess → credit balance (P6 with `cash`); optional Quittung CSH-028 |
| P4 | Skonto granted (UST-32) | S `skonto.granted.r` N · S `vat.output.r` V · H `receivable` G (per rate pro rata) | S `skonto.granted.r` N · S `vat.output.notdue.r` V · H `receivable` G | Soll: negative base in the payment period; Ist: none (never due) | Payment-level adjustment, no new document |
| P5 | Bank fee deducted by payer | S `expense.bank_fees` · H `receivable` | same | none | difference reason `bank_fees` |
| P6 | Overpayment | S `bank` (or `cash`) · H `receivable` (credit balance on the debtor) | same | none | Refund or offset later; OPOS shows a credit |
| P7 | Payment of dunning fees / interest | S `bank` · H `income.other_nontaxable` (fees, 40 €) / H `income.interest_default` (interest) | same | none | Allocation order §367 BGB: costs → interest → principal unless the payer specifies (reference text) |
| P8 | Write-off (uneinbringlich) | S `writeoff.r` N · S `vat.output.r` V · H `receivable` G | S `writeoff.r` N · S `vat.output.notdue.r` V · H `receivable` G | Soll: Kz 50 (Minderung der Bemessungsgrundlage, negative) in the write-off period ⚠; Ist: none | §17 Abs. 2 Nr. 1; reason + evidence (Insolvenz, fruitless enforcement) required |
| P9 | Recovery after write-off | S `bank` G · H `writeoff.recovery` N · H `vat.output.r` V | same (VAT due on receipt) | Soll: positive correction in the receipt period (Kz 50 positive ⚠ or Kz 81); Ist: Kz 81 | §17 Abs. 2 Nr. 1 S. 2 |
| P10 | Payment reversal (bank return, wrong match) | Reversal entry of the payment entry (incl. Ist VAT transfer) | same | reverses the Ist share | `payments.reversedById` |
| P11 | Refund to customer (credit balance, or a credit correction's open refund, F05 PAY-033) | S `receivable` · H `bank` (or `cash`, subject to CSH-026) | same; for a correction refund **plus** S `vat.output.r` · H `vat.output.notdue.r` for the refund's share of the correction's parked (negative) VAT, pro rata as P1 („P11-ist“) | Ist (correction refund): the VAT reduction falls into the refund's period | ⚖ P11-ist is an amendment 2026-10-18: under Ist the correction's VAT reduction is parked on `notdue` like the invoice's VAT (S13-ist), so it must be released when the money flows back; the earliest-tax-point alternative (reduction at the correction date) would reduce VAT before the refund is paid. `// LEGAL-OPEN: F08 §4.2.2 P11-ist` |

#### 4.2.3 Purchases (vouchers)

| # | Event | Posting (Soll and Ist identical for input VAT until 2027-12-31) | UStVA | Notes |
|---|---|---|---|---|
| V1 | Voucher, input VAT deductible | S expense N · S `vat.input.r` V · H `payable` G | Kz 66 at voucher tax point (supply + invoice) | Date = voucher date, or late-posting rule ACC-006 |
| V2 | Voucher paid (bank) | S `payable` · H `bank` | none | Paid in cash → T6; paid privately → T7 |
| V3 | Skonto received | S `payable` G · H `skonto.received.r` N · H `vat.input.r` V | Kz 66 negative | |
| V4 | No input VAT (KU supplier, private share, non-deductible) | S expense G · H `payable` G | none | taxRule `no_input_vat`, `kleinunternehmer_supplier` |
| V5 | Bewirtung (business partners, MISC-05) | S `expense.entertainment` 70 % N · S `expense.entertainment.nd` 30 % N · S `vat.input.7` V(food) · S `vat.input.19` V(drinks) · H `payable` G; tip (no VAT) split 70/30 | Kz 66 = 100 % of V | Requires approved Eigenbeleg; occasion "Mitarbeiter" → `expense.staff_events` 100 % |
| V6 | Reverse charge EU service (§13b Abs. 1) | S `expense.13b_eu.19` N (or chosen expense account + BU 46 ⚠) · S `vat.input.13b.19` V · H `vat.output.13b.19` V · H `payable` N | Kz 46/47, Kz 67 | SaaS from EU (not bank fees, which are booked VAT-exempt by default, §4.2.7 R5) |
| V7 | Reverse charge non-EU service (§13b Abs. 2 Nr. 1) | S `expense.13b_foreign.19` N · S `vat.input.13b.19` V · H `vat.output.13b.19` V · H `payable` N | Kz 84/85, Kz 67 | |
| V8 | Domestic §13b received (Bauleistung etc.) | S `expense.13b_domestic.19` N · S/H as V6 | Kz 84/85, Kz 67 | |
| V9 | Intra-Community acquisition | S `expense.ige.r` N · S `vat.input.ige.r` V · H `vat.output.ige.r` V · H `payable` N | Kz 89/93 (base), Kz 61 | Supplier USt-IdNr required |
| V10 | Import VAT paid (customs notice) | S `vat.import` · H `bank` | Kz 62 | Eigenbeleg = Zollbescheid |
| V11 | Advance payment to supplier (Anzahlung) | S advance-paid account ⚠ N · S `vat.input.notyet` / `vat.input.r` V (deductible when paid **and** an invoice exists, §15 Abs. 1 Nr. 1 S. 3) · H `bank` | Kz 66 in the payment period if the advance invoice exists | |
| V12 | 2028+: invoice from an Ist-taxing supplier (UST-13 note detected or flagged) | S expense N · S `vat.input.notyet` V · H `payable` G; on payment: S `vat.input.r` · H `vat.input.notyet` pro rata | Kz 66 in the payment period | Date-effective rule `inputVatOnPaymentFromIstSupplier` validFrom 2028-01-01 |
| V13 | Asset purchase | S `asset.*` N · S `vat.input.r` V · H `payable` G (+ asset record, AST-002) | Kz 66 | GWG ≤ 250 € net: expense directly |
| V14 | Durchlaufende Posten | S 1590 / H 1590 (SKR04 1370) without VAT | none | ⚠ |

#### 4.2.4 Private, transfers, cash (simple cash, owner decision B3)

Cash rules (dating, backdate reason, Eigenbeleg/Quittung, never-negative) are owned by F07 CSH-020…030; this table only defines the postings. There is one cash account (role `cash`); there are **no** cash-book rows, no daily close and no Kassendifferenz postings. Cash rows P3 (§4.2.2), T5, T8, T9 and T10 are **P1**; T6/T7 follow the voucher feature (P2, see open question 11). For corporations every `private.*` role below is replaced by `shareholder.clearing` (ACC-028).

| # | Event | Posting | Notes |
|---|---|---|---|
| T1 | Privatentnahme (bank) | S `private.withdrawal` · H `bank` | Bank transaction marked "privat" (event `bank_transaction_marked`, dated the Berlin booking date, externally dated); the bank statement plus the auto Eigenbeleg is the voucher; a fee in the row → R5; corporations → `shareholder.clearing` with shareholder + note (T1-corp). P1 (F07 BNK-060); „Markierung aufheben“ = Generalumkehr (`bank_transaction_mark_reversed`) |
| T2 | Privateinlage (bank) | S `bank` · H `private.deposit` | Corporations → `shareholder.clearing` (T2-corp). P1 (F07 BNK-060) |
| T3 | Private expense paid from the business account | S `private.withdrawal` G · H `bank` | no VAT (P2) |
| T4 | Transfer between own accounts (incl. two own accounts/pockets in the same currency) | leg out: S `transit` · H `bank.A`; leg in: S `bank.B` · H `transit` | Two separate bank transactions, paired (F07 BNK-061); each leg posts on its own booking date; open transit is a pre-lock warning (P2) |
| T5 | Cash deposit to the bank („Bargeld eingezahlt“, `cashTransfers.kind = deposit_to_bank`, CSH-024) | cash leg on the deposit date: S `transit` · H `cash`; bank leg when the bank credit is matched to the transfer: S `bank` · H `transit` (bank booking date) | P1. Never-negative check on the cash leg (CSH-026); pairing requires the exact amount (E-ACC-31); open transit → pre-lock warning (E-ACC-18) |
| T6 | Voucher paid „bar“ (CSH-022) | with a creditor: S `payable` · H `cash` (voucher posted per V1/V4/V5 …); direct cash voucher: S expense N · S `vat.input.r` V · H `cash` G | Dating rules and never-negative check per CSH-022/026. Phase: follows the voucher — vouchers are P2 (B7), so T6 is available with the first voucher feature; if a minimal voucher capture is brought forward to P1 (open question 11), T6 applies unchanged. Until then a P1 cash outflow for an expense cannot be recorded (the pre-go-live checklist says so) |
| T7 | Voucher paid privately („privat bezahlt“, Privateinlage, CSH-023) | with a creditor: S `payable` · H `private.deposit`; direct: S expense N · S `vat.input.r` V · H `private.deposit` G; corporations: H `shareholder.clearing` instead | No cash or bank movement; Beleg = the voucher; input VAT deductible as for any voucher. Phase as T6 |
| T8 | Private withdrawal from the till („Bargeld entnommen“, `cashTransfers.kind = private_withdrawal`, CSH-024) | S `private.withdrawal` · H `cash` | P1. Corporations: Privatentnahme blocked (E-ACC-30); offered as S `shareholder.clearing` · H `cash` with shareholder and note; auto Eigenbeleg PDF; never-negative check |
| T9 | ATM withdrawal into the till („Bargeldabhebung in die Kasse“, `cashTransfers.kind = bank_withdrawal_to_cash`, CSH-025) | S `transit` · H `bank`; S `cash` · H `transit` — both on the bank booking date (Europe/Berlin); with an ATM fee in the row: S `transit` (cash) + S `expense.bank_fees` (fee) · H `bank` (debit), event field `feeCents` | P1. One cash transfer linked to the booked bank debit; transit nets to 0 immediately; an ATM fee (`source.feeCents` or separate fee transaction) → R5 |
| T10 | Reversal of a cash payment or cash transfer (CSH-027) | Reversal entry mirroring the original lines (`reversalOfId`), dated on the reversal date in an open period | P1. Subject to the never-negative check (CSH-026): a reversal that would make the cash balance negative at any date is blocked |

#### 4.2.5 Depreciation and disposal

| # | Event | Posting |
|---|---|---|
| D1 | Monthly linear/degressive AfA | S `afa.tangible` (or `afa.vehicle`/`afa.intangible` by asset account) · H asset account |
| D2 | GWG write-off (acquisition month) | S `afa.gwg` · H `asset.gwg` |
| D3 | Sammelposten yearly 20 % (posted in December, or monthly 1/60 if "monatlich" is set ⚠) | S `afa.pool` · H `asset.pool` |
| D4 | Sale with gain (proceeds > RBW) | invoice: S `receivable` G · H `disposal.proceeds.gain.19` N · H `vat.output.19` V; asset: S `disposal.rbw.gain` RBW · H asset account RBW |
| D5 | Sale with loss | as D4 with `disposal.proceeds.loss.19` and `disposal.rbw.loss` |
| D6 | Scrap | S `disposal.rbw.loss` RBW · H asset account RBW |
| D7 | Withdrawal (Entnahme) | S `private.withdrawal` G · H `revenue.withdrawal.19` N(Teilwert) · H `vat.output.19` V (only if input VAT was deducted) · plus S `disposal.rbw.loss` RBW · H asset RBW (⚠ account choice) |
| D8 | Sammelposten item sold | Proceeds only (S `receivable` / H `disposal.proceeds.*` / H VAT); pool unchanged |

#### 4.2.6 Taxes

| # | Event | Posting | EÜR |
|---|---|---|---|
| X1 | UStVA payment | S `vat.prepayment` · H `bank` | Betriebsausgabe "an das Finanzamt gezahlte USt" in the year per 10-day rule |
| X2 | UStVA refund | S `bank` · H `vat.prepayment` | Betriebseinnahme "vom Finanzamt erstattete USt" |
| X3 | Sondervorauszahlung | S `vat.special_prepayment` · H `bank` | Betriebsausgabe (paid year) ⚠ |
| X4 | USt Jahreszahlung / -erstattung for a prior year | S/H `vat.prior_year` · `bank` | as X1/X2 |
| X5 | Gewerbesteuer | S `expense.trade_tax` · H `bank` | Shown, then added back (non-deductible) |
| X6 | ESt/KiSt/Soli from the business account | S `private.taxes` · H `bank` | No EÜR effect |
| X7 | KSt (corporations) | S `expense.corp_tax` · H `bank` | n/a (Bilanz) |

No automatic monthly reclassification of USt accounts to `vat.prepayment`: the UStVA, EÜR and USt-Jahreserklärung read the VAT lines by `taxPeriod`/allocation, so no year-end closing entries are needed for EÜR companies (Bilanz closing is out of scope, AO-07); an optional "USt-Umbuchung nach UStVA" (COULD) can post it.

#### 4.2.7 Bank transactions (any source; research 13)

Sources: **statement import** (CAMT.053 primary, Revolut CSV, MT940, with the archived signed PDF statement; P1, always available) and the **Enable Banking** PSD2 feed (P2); F07 BNK-030…036, BNK-100…117. (open-banking.io was rejected; the Revolut Business API is only a future option if the owner ever buys the Grow plan — not specified.) The posting rules below are defined by **economic case**, never by provider-specific transaction types or states, so every source yields the same journal (CLAUDE.md rule 5).

General rules: only **booked** transactions are journalised; pending transactions live in `bankPendingTransactions`, are never booked and never auto-matched (F07 BNK-111, RI-10). The journal `date` is the booking date converted to Europe/Berlin (F07 BNK-112, EC-155). Each `bankAccounts` row (an IBAN account or a currency pocket — Revolut delivers every currency pocket as a separate account) has its own ledger account (`bank.<accountId>` / `bank.<accountId>.fx`). Whenever a transaction carries a fee — as its own fee transaction or in the `source.feeCents` field (CAMT `Chrgs`, CSV `Fee`) — the fee is a **separate journal line** on `expense.bank_fees`, **without VAT and without §13b** (§4 Nr. 8 UStG; decided conservative default, one-off Steuerberater check before go-live recommended, non-blocking). Whether a source's amount already includes the fee is fixed per source mapper against the balance continuity (`balanceAfterCents` / statement balances; EC-145) — never guessed: a source whose fee semantics are not verified books the fee only after the owner confirms the split (E-ACC-32). A bank reversal is a **separate booked counter-transaction**, never an edit or delete (EC-141). The voucher of every bank entry is the transaction (raw payload revision, F07 BNK-113) plus the monthly official statement (EC-156). Phases: R3 (customer payment into a foreign-currency account) and the invoice-related part of R13 are **P1**; all other rows are P2 (ACC-024, ACC-027).

| # | Economic case | Posting | Notes |
|---|---|---|---|
| R1 | Exchange between own accounts, EUR → foreign currency (e.g. EUR pocket → USD pocket); arrives as **two separate booked transactions in two accounts** (EUR debit, USD credit) and is paired as Geldtransit (F07 BNK-061) | EUR account: S `transit` E · H `bank.EUR` E; USD account: S `bank.USD.fx` E (memo: USD amount) · H `transit` E, where E = EUR amount of the outgoing transaction; a fee on either side is a separate line S `expense.bank_fees` · H the debited bank account (EUR at the transaction's rate) | Each side posts on its own booking date; `transit` nets to 0 once both are paired; the effective rate becomes the USD account's cost rate (EC-144). Unpaired side → E-ACC-23 |
| R2 | Exchange foreign currency → EUR (USD pocket → EUR pocket), two separate transactions as R1 | USD account: S `transit` E_in · H `bank.USD.fx` C (EUR book value of the USD sold, moving average); EUR account: S `bank.EUR` E_in · H `transit` E_in; difference E_in − C → H `income.fx_gain` or S `expense.fx_loss` | Realised FX result (MISC-08) on the USD side's booking date; moving-average method is the decided default (one-off Steuerberater check before go-live recommended, non-blocking) |
| R3 | Customer payment received in a foreign-currency account for an invoice — **P1** | S `bank.USD.fx` (EUR at the transaction's rate, else the ECB reference rate of the booking date, source logged) · H `receivable` (EUR booked for the cleared part); difference → FX gain/loss | VAT stays at the invoice's EUR VAT (MISC-08); the inflow adds to the account's moving-average cost |
| R4 | Card payment in a foreign currency, debited from an EUR (or other) account; the source shows the original amount/currency and possibly a fee | Voucher payment at the EUR amount actually debited excluding the fee (S `payable` · H `bank.*`, difference to the voucher's EUR value → FX gain/loss, MISC-08); **separate fee line** S `expense.bank_fees` · H `bank.*`, **no VAT** | Card FX charges are either in the fee field or priced into the rate; the posting follows what the source delivers (verified per mapper, EC-145) |
| R5 | Bank fee transaction (account/plan fee, transfer fees, exchange fees, card fees as a separate transaction) | S `expense.bank_fees` · H `bank.*`, **no VAT, no §13b** | VAT-exempt financial service (§4 Nr. 8 UStG) as the decided conservative default (one-off Steuerberater check before go-live recommended, non-blocking). Beleg = the bank statement of that month (EC-156); until it is archived the entry carries an auto Eigenbeleg flagged „Kontoauszug fehlt“ (E-ACC-25) |
| R6 | **Withdrawn (v1.1)** — B1: the Revolut Expenses add-on and its receipt fetch are removed (no Business API); a VAT invoice from any supplier is a normal voucher (V1/V6). Replaced by — | — | — |
| R7 | Transfer between two own accounts in the same currency, or to/from an own account at another bank | T4 via `transit` | Two separate transactions paired by amount, date window and own IBAN (F07 BNK-061) |
| R8 | Refund from a merchant/supplier (incoming card refund or transfer referencing a paid voucher) | Mirror of the original voucher payment (S `bank.*` · H `payable`) or a credit-note voucher; a refunded fee → H `expense.bank_fees` | |
| R9 | Card chargeback we raised (disputed card payment credited back) | S `bank.*` · H `payable`/expense per the disputed voucher; voucher flagged „Rückbuchung“ | |
| R10 | **Withdrawn (v1.1)** — B1: Revolut-specific transaction types (`topup`, `topup_return`) no longer exist; incoming/outgoing transfers without an invoice reference are handled by matching (P1/V2), T2 or T4. Replaced by T2, T4, R13 | — | — |
| R11 | Withholding tax on bank interest (Kapitalertragsteuer, Soli, KiSt), if the bank deducts it | S `private.taxes` (sole proprietors/partnerships) / tax expense role for corporations · H `bank.*` | ⚠ |
| R12 | Interest credited (savings pocket, account interest) | S `bank.*` · H `income.interest_default` | |
| R13 | Bank reversal (Rücküberweisung, Rücklastschrift, returned payment) arriving as a **separate booked counter-transaction** | When the owner confirms it as the reversal of a matched payment (F05 payment reversal; F07): reversal of the payment entry (P10, incl. the Ist VAT transfer) dated on the counter-transaction's booking date (late-posting rule if needed); bank-side fees on the return → R5; otherwise the counter-transaction is matched like any other transaction | Never edits the original transaction or entry; the invoice re-opens (EC-141). P1 for reversals of invoice payments, P2 otherwise |
| R14 | Outgoing payment from a foreign-currency account (voucher paid in USD, card payment from the USD pocket) | S `payable` (EUR booked for the cleared part of the voucher) · H `bank.USD.fx` C (moving-average EUR cost of the USD spent); difference → FX gain/loss | Realised FX on outflow (MISC-08); fee per the general rule |

**Foreign-currency accounts** are Fremdwährungskonten: transactions are converted at the booking date (the exchange rate implicit in the transaction or delivered as `source.exchangeRate`, else the ECB reference rate of the booking date, source logged); each account keeps a **moving-average EUR cost** used to value outflows (R2, R14). **Year-end revaluation under §256a HGB applies to Bilanz companies only** and is out of scope (AO-07; external tool or advisor; the SuSa shows „Bewertung zum Stichtag offen“); EÜR companies realise FX results only on outflow. (Decided default; one-off Steuerberater check before go-live recommended, non-blocking.)

### 4.3 Tax point and period assignment (TAX-008)

```
taxPoint(line):
  KU                              → none (not reported) unless §13b/igE received
  sales, Soll, advance invoice    → payment date (Mindest-Ist)
  sales, Soll, normal             → end of supply: supplyDate.date | supplyDate.to | last day of supplyDate.month
                                     (§13 Abs. 1 Nr. 1a: tax arises at the end of the period of supply)
  sales, Ist                      → payment date (per allocation)
  sales, AE EU service (§3a/§13b) → end of the month of supply (also for Ist) ⚠
  sales, K igL                    → invoice date, at the latest the end of the month following the supply ⚠ (§13 Abs. 1 Nr. 6)
  corrections (Storno/Korrektur/Skonto/write-off) → date of the correction event (§17)
  purchases, input VAT            → max(supply date, invoice receipt date); advance → payment date (+ invoice exists);
                                     2028+ Ist supplier → payment date
  igE                             → invoice date, at the latest end of the month after acquisition
taxPeriod = filing period (month or quarter) containing taxPoint, from ustvaPeriod[year]
If taxPeriod is already submitted → line is "nachzumelden": appears in the correction worklist of that period (TAX-007).
```

### 4.4 Payment allocation (cash-basis views)

Every payment, Skonto, write-off and reversal produces `allocations`: for the cleared amount, the share per (revenue/expense account, VAT rate) of the target document, pro rata by gross, cents by largest remainder; advances and the Schlussrechnung follow their own groups. EÜR income/expense lines and Ist-UStVA values are sums over allocations by payment date (EÜR) / tax period (UStVA). Opening-balance open items (ACC-013) carry their original VAT split so allocations work for imported invoices. Property test: Σ allocations over all payments of a fully paid document = document net per account and VAT per rate.

### 4.5 UStVA Kennzahlen mapping (version `ustva-2026.2`, versioned per year; conservative defaults; 2027 table added when published)

Each yearly table carries `verifiedAgainstForm: { formName, formYear, verifiedOn }`. A table without this verification (e.g. a newly published year before the data release checks it against the official Vordruck and the Mein ELSTER form) shows the values with a banner, but the Mein ELSTER instructions and the submission record are **blocked** (E-UVA-07/E-UVA-20; block rather than guess). Rows marked ⚠ are used as listed (decided defaults; one-off Steuerberater check before go-live recommended, non-blocking; LEGAL-OPEN 01-compliance open item 6). The order of the rows in the Mein ELSTER instructions follows the form (`elster-ustva-<year>` guide data), not this table.

| Kz | Content | Source |
|---|---|---|
| 81 | Steuerpflichtige Umsätze 19 % (Bemessungsgrundlage) | revenue roles with tax key USt19 incl. withdrawals, advances received, Storno/corrections (negative) |
| 86 | Steuerpflichtige Umsätze 7 % | as above, 7 % |
| 87 | Umsätze 0 % (PV, §12 Abs. 3) | `revenue.zero_pv` |
| 35 / 36 | Umsätze zu anderen Steuersätzen (base / tax) | historical rates (e.g. 16 %/5 % corrections) |
| 41 | Innergemeinschaftliche Lieferungen an Abnehmer mit USt-IdNr | `revenue.icsupply` |
| 43 | Weitere steuerfreie Umsätze mit Vorsteuerabzug | `revenue.export` |
| 48 | Steuerfreie Umsätze ohne Vorsteuerabzug | `revenue.exempt_4` |
| 89 / 93 / 95+98 | Steuerpflichtige igE 19 % / 7 % / andere Sätze (base; 98 = tax) | `expense.ige.*` |
| 46 / 47 | §13b Abs. 1: sonstige Leistungen EU-Unternehmer (base / tax) | V6 |
| 73 / 74 | §13b Abs. 2 Nr. 2 und 3 (sicherungsübereignete Gegenstände, GrESt) ⚠ | manual tax rule only |
| 84 / 85 | Andere Leistungen §13b Abs. 2 Nr. 1, 2, 4–12 (base / tax) | V7, V8 |
| 60 | Steuerpflichtige Umsätze, für die der Leistungsempfänger die Steuer schuldet (§13b) | S6 |
| 21 | Nicht steuerbare sonstige Leistungen (EU, §18b S. 1 Nr. 2) | S4 |
| 45 | Übrige nicht steuerbare Umsätze | S7 (O) |
| 66 | Vorsteuer aus Rechnungen anderer Unternehmer | `vat.input.7/19` (incl. Bewirtung 100 %) |
| 61 | Vorsteuer aus igE | `vat.input.ige.*` |
| 62 | Entstandene Einfuhrumsatzsteuer | `vat.import` |
| 67 | Vorsteuer aus Leistungen nach §13b | `vat.input.13b.*` |
| 64 | Berichtigung des Vorsteuerabzugs (§15a) | manual entry only |
| 50 | Minderung der Bemessungsgrundlage bei Uneinbringlichkeit (§17 Abs. 2 Nr. 1) ⚠ | P8/P9 (Soll); decided default: write-offs and recoveries use Kz 50 (negative/positive), never Kz 81 |
| 37 | Minderung der abziehbaren Vorsteuer bei Uneinbringlichkeit ⚠ | own unpaid payables written off (manual) |
| 69 | §14c Steuerbeträge (unrichtig/unberechtigt ausgewiesen) | UST-34 cases (F04) |
| 39 | Abzug der festgesetzten Sondervorauszahlung | December (monthly) or Q4 return if Dauerfrist + Sondervorauszahlung |
| 83 | Verbleibende Umsatzsteuer-Vorauszahlung / Überschuss | computed |
| 10 | Berichtigte Anmeldung (1 = ja) | correction filings |

Not supported (blocked with message): new vehicles (44/49/94/96), Dreiecksgeschäft first buyer (42) except ZM "D" entry, §24 agriculture, Durchschnittssätze.

**Form rounding and input format** (rule data per year, TAX-004/TAX-020): Bemessungsgrundlagen in whole euros (decided default: cents truncated, as the form instructions allow rounding in the taxpayer's favour ⚠ LEGAL-OPEN open item 6), tax amounts (Kz 36, 47, 85, 98, 66, 61, 62, 67, 64, 69, 39, 83 …) in euro and cent; copied strings use a decimal comma, no thousands separator, no currency sign, leading minus. For Kz 81/86/87 the form computes the tax itself: the guide shows the form's value („laut Formular“) and the booked VAT („laut Buchhaltung“) with the difference (TAX-004). Kz 83 is the cross-check value of the submission record (TAX-021).

### 4.6 EÜR mapping

Accounts map to **semantic keys** (stable): e.g. `BE.KU`, `BE.STPFL`, `BE.STFREI`, `BE.UST_VEREINNAHMT`, `BE.UST_ERSTATTET`, `BE.ANLAGEN_VERAEUSSERUNG`, `BE.ENTNAHMEN`, `BA.WAREN`, `BA.FREMDLEISTUNGEN`, `BA.PERSONAL`, `BA.AFA_BEWEGLICH`, `BA.AFA_IMMATERIELL`, `BA.GWG`, `BA.SAMMELPOSTEN_AUFLOESUNG`, `BA.RESTBUCHWERT`, `BA.RAUMKOSTEN`, `BA.KFZ`, `BA.REISE`, `BA.BEWIRTUNG_ABZIEHBAR`, `BA.BEWIRTUNG_NICHT_ABZIEHBAR`, `BA.GESCHENKE`, `BA.GEWERBESTEUER`, `BA.VORSTEUER`, `BA.UST_GEZAHLT`, `BA.SONSTIGE`, `PRIVAT.ENTNAHME`, `PRIVAT.EINLAGE`, `NONE`. A per-year table `euer-<year>` maps each key to the official line (Zeile) and Kennzahl of the Anlage EÜR. Each yearly table carries `verifiedAgainstForm` like §4.5; until a data release has verified the line numbers against the official Anlage EÜR of that year (line numbers change yearly; research gives none verified) the report shows the values with the banner „Zeilen gegen amtlichen Vordruck prüfen“ and the Mein ELSTER instructions and the EÜR submission record are **blocked** (E-UVA-20). Decided default for amounts: euro and cent as on the form (⚠ per data release). `ledgerAccounts.euerLineByYear` is only a per-account override. A parallel table `aveuer-<year>` maps the Anlagenspiegel columns (AST-012) to the Anlage AVEÜR (only shown when assets exist). *Status 2026-10-23:* `euer-2025.1` (BMF 29.08.2025) and `euer-2026.1` (BMF 01.09.2026, GZ IV C 6 - S 2142/00024/010/001; new Zeile 27 shifts every Betriebsausgaben line from „Waren“ on, Kennzahlen unchanged, AVEÜR unchanged) are verified against the official Vordrucke; later years ship unverified until a data release checks them.

Cash basis: income/expense keys are recognised by allocation date; AfA/GWG/Sammelposten/RBW by depreciation/disposal date; VAT received/paid lines from the VAT share of allocations; Finanzamt payments via the 10-day rule (TAX-016). Forderungsverluste map to `NONE` for EÜR (income never received). Cash receipts and cash expenses (P3, T6) are allocations like bank payments; cash deposits/ATM withdrawals (T5, T9) and transfers are `NONE`; private withdrawals from the till (T8) and vouchers paid privately (T7) appear in the private section (`PRIVAT.ENTNAHME` / `PRIVAT.EINLAGE`), the expense of T7 in its expense line.

### 4.7 Period lock state machine

```
period: open ──lock(reason, checklist ok)──▶ locked   (irreversible)
          │                                        │
          └─ events dated in it post normally      └─ events dated in it → late-posting rule (ACC-006)
taxFiling (kind ustva | ustva_correction | zm | zm_correction | sondervorauszahlung | euer):
  draft ──recordSubmission(date, ticket, protocol?, crossCheck, sheetHash; submittedVia = mein_elster_manual | eric (P4))──▶ submitted_manually ──(correction recorded)──▶ superseded
     │        └─ crossCheck ≠ app value → blocked, or „abweichend übermittelt“ (reason) → submitted_manually + submittedValuesDiffer → correction worklist opens
     └─discard──▶ (deleted; drafts are recomputed on demand)
correction: created from a submitted filing ──recordSubmission──▶ submitted_manually (Kz 10 = 1)
lock on recordSubmission: ustva* → ustva_submitted (months of the filing period); zm* → zm_submitted; euer → euer_submitted (all months of the year); sondervorauszahlung → no lock
```

### 4.7a Mein ELSTER instructions flow (TAX-020/021)

```
/steuern/{ustva|zm|euer|ust-jahr}/{period}
 1 Werte prüfen     — Kennzahlen/lines, drill-down, Δ to previous filing, blockers (drafts, pending artifacts, bank balance, mapping/guide unverified)
 2 Einmalig         — prerequisites (ELSTER-Unternehmenskonto, Steuernummer) — collapsible after the first filing
 3 In ELSTER öffnen — navigation path, form year, Steuernummer/period selection (guide data elster-<form>-<year>)
 4 Eintragen        — one step per form page/section; per field: Kz/Zeile · label · value · „Kopieren“ · „eingetragen“ tick; „leer lassen“ for zero
 5 Abschluss-Check  — ELSTER „Prüfen“ ok · ELSTER preview total = app total · send · save protocol PDF + Transferticket
 6 Übermittlung erfassen — date, Transferticket, protocol PDF (optional), cross-check value → record + lock
```
The guide data are pure rule data (no I/O) and golden-tested per form and year (TST-TAX-26).

### 4.8 Customer payment behaviour (forecast)

Per customer: delays (payment date − due date, days) of the last 10 fully paid invoices within 24 months; expected delay = median, cautious = P80; < 3 data points → company-wide median; no history → 0. Partial payments use the date the invoice became fully paid. Overdue invoices: expected date = max(today + 7, due + expected delay). Invoices in dunning level ≥ 2: probability 50 % in the cautious scenario.

### 4.9 BWA groups

Each account has a BWA group key (`UMSATZ`, `WAREN`, `PERSONAL`, `RAUM`, `STEUERN_VERS`, `KFZ`, `WERBE_REISE`, `AFA`, `REPARATUR`, `SONSTIGE`, `NEUTRAL_AUFWAND`, `NEUTRAL_ERTRAG`, `ZINS`, `NONE`), defined in the seed and overridable for custom accounts.

## 5. Validation rules and edge cases (exhaustive; exact German error/warning messages)

### 5.1 Journal and accounts

| # | Case | Rule / behaviour | Message (DE) |
|---|---|---|---|
| E-ACC-01 | Unbalanced manual entry | Blocked | „Soll und Haben sind nicht ausgeglichen (Differenz: {diff} €)." |
| E-ACC-02 | Manual entry without voucher | Blocked unless opening balance/reversal | „Jede Buchung braucht einen Beleg. Bitte Beleg anhängen oder Eigenbeleg erstellen (GoBD)." |
| E-ACC-03 | Externally dated event (booked bank transaction, late voucher, AfA) in a locked period | Late-posting rule ACC-006 (b): posted into the first open period, `originalDate` kept | Info: „Der Zeitraum {MM/JJJJ} ist festgeschrieben. Die Buchung wurde in den {MM/JJJJ} übernommen (Belegdatum {TT.MM.JJJJ} bleibt erhalten)." |
| E-ACC-04 | User-chosen date in a locked period (manual entry, manual payment, cash payment, cash transfer) | Blocked, ACC-006 (a) | „Der Zeitraum {MM/JJJJ} ist festgeschrieben. Korrekturen sind nur als Gegenbuchung in einem offenen Zeitraum möglich." |
| E-ACC-05 | Reversal of a reversal / double reversal | Blocked | „Diese Buchung wurde bereits storniert." |
| E-ACC-06 | Account archived | Blocked for new postings | „Konto {nr} ist archiviert und kann nicht bebucht werden." |
| E-ACC-07 | Account not in chart range for type | Blocked | „Kontonummer {nr} liegt nicht im zulässigen Bereich für {Typ} ({SKR})." |
| E-ACC-08 | Personal account range collision | Blocked | „Debitoren-/Kreditorennummer {nr} ist bereits vergeben." |
| E-ACC-09 | Chart switch after postings in the current fiscal year | Blocked; offered effective next fiscal year with mapping (EC-116) | „Der Kontenrahmen kann erst zum Beginn des nächsten Wirtschaftsjahres gewechselt werden." |
| E-ACC-10 | Direct posting to automatic VAT accounts in a manual entry | Warning, needs confirmation | „Direktbuchung auf ein Umsatzsteuerkonto ohne Bemessungsgrundlage – die UStVA-Kennzahl wird nicht befüllt. Trotzdem buchen?" |
| E-ACC-11 | Tax key on an account that does not allow it | Blocked | „Steuerschlüssel {key} ist für Konto {nr} nicht zulässig." |
| E-ACC-12 | Opening balance not balanced (Σ 9000/9008/9009) | Blocked | „Die Eröffnungsbilanz ist nicht ausgeglichen (Differenz {diff} €)." |
| E-ACC-13 | Opening balances entered twice for a fiscal year | Blocked; corrections via reversal | „Für {Jahr} sind bereits Saldenvorträge erfasst." |
| E-ACC-14 | Buchungsbeginn change after postings | Blocked | „Der Buchungsbeginn kann nach der ersten Buchung nicht mehr geändert werden." |
| E-ACC-15 | Lock with gaps (earlier month open) | Offer to lock all earlier months | „Festschreibung muss lückenlos erfolgen. {MM/JJJJ} bis {MM/JJJJ} werden mit festgeschrieben." |
| E-ACC-16 | Lock with drafts dated in period | Blocked | „Im Zeitraum gibt es {n} Entwürfe. Bitte fertigstellen oder löschen." |
| E-ACC-17 | Lock while artifact pipeline pending | Blocked | „{n} Dokumente werden noch verarbeitet. Bitte warten." |
| E-ACC-18 | Lock with open Geldtransit balance | Warning | „Geldtransit ist nicht ausgeglichen ({betrag} €). Fehlt die Gegenbuchung?" |
| E-ACC-19 | **Withdrawn (v1.1)** — B3: no cash book and no daily cash close, so there are no „unclosed cash days“. Replaced by ACC-017 (3) (backdated cash postings list) and E-ACC-18 (open Geldtransit) | — | — |
| E-ACC-20 | Event concurrently posted while lock job runs | The lock job runs in one mutation per table batch, holding `periods.status=locking`; postings with `date` in a `locking` period wait/retry and then follow ACC-006 | — |
| E-ACC-21 | Event dated in a future period | Allowed (open); warning if > 30 days ahead | „Das Buchungsdatum liegt mehr als 30 Tage in der Zukunft." |
| E-ACC-22 | Event before Buchungsbeginn | No posting; document flagged „vor Buchungsbeginn" | Info |
| E-ACC-23 | Exchange or own-account transfer where only one side has arrived (other account not imported yet, statement of the other pocket missing, or the two sides booked on different days, e.g. 31.12./01.01.) | The arrived side posts to `transit` on its own booking date; pairing happens when the other side arrives (F07 BNK-061); missing side → open transit warning after 3 days and pre-lock warning (E-ACC-18) | „Devisentausch/Umbuchung vom {datum}: Gegenbuchung im Konto {konto} ({währung}) fehlt.“ |
| E-ACC-24 | Transaction still pending; or a booked payment is later returned by the bank (separate counter-transaction) | Pending: never booked, never auto-matched (separate store, F07 BNK-111); booked twin arrives → booked normally. Return: the counter-transaction is a new booked transaction; when the owner confirms it as reversal, the payment entry is reversed dated on the counter-transaction's booking date (late-posting rule if that period is locked) and the payment allocation reversed (R13, EC-140, EC-141) | Info „Zahlung vom {datum} wurde von der Bank zurückgebucht – Zahlung storniert, Rechnung {nr} wieder offen.“ |
| E-ACC-25 | Bank fee transaction (R5) while the monthly bank statement of that account is not yet archived | Booked without VAT; Eigenbeleg auto-generated from the transaction data, flagged „Kontoauszug fehlt“ until the statement (signed PDF + CAMT.053) for that month and account is archived (EC-156) | „Kontoauszug {Monat} für {Konto} fehlt – Eigenbeleg für die Gebühr erstellt.“ |
| E-ACC-28 | Owner selects §13b or input VAT for a bank fee | Blocked unless a supplier invoice with VAT or a reverse-charge note is attached as voucher and a reason is given (decided conservative default: bank fees are VAT-exempt financial services, §4 Nr. 8 UStG) | „Bankgebühren sind in der Regel steuerfreie Finanzdienstleistungen (§ 4 Nr. 8 UStG). Vorsteuer oder Reverse Charge nur mit Rechnung, die Umsatzsteuer bzw. Reverse Charge ausweist. Bitte Rechnung anhängen und Grund angeben.“ |
| E-ACC-29 | Source timestamp 2026-09-30T22:30:00Z (= 01.10. 00:30 Berlin), or a statement in UTC with the booking date 30.09. | The booking date is derived in Europe/Berlin identically for statement import and feed (F07 BNK-112): booked on 2026-10-01 (October/Q4); a source that only delivers a date (CAMT `BookgDt` without time) keeps that date | — |
| E-ACC-26 | Foreign-currency account outflow greater than its EUR cost basis (rounding) | Last lot absorbs; FX result ≤ 1 ct rounding goes to FX gain/loss | — |
| E-ACC-27 | Clock skew > 2 s detected (F12) | Postings continue; journal `recordedAt` stays server time; integrity finding (GOBD-22) | Banner „Serverzeit weicht ab" |
| E-ACC-30 | Corporation records a private withdrawal from the till or a voucher „privat bezahlt“ | `private.*` roles blocked (ACC-028); offered as posting to `shareholder.clearing` with shareholder and note; blocked entirely while `shareholder.clearing` is unmapped | „Bei einer {Rechtsform} gibt es keine Privatentnahmen. Die Buchung erfolgt über das Verrechnungskonto Gesellschafter.“ |
| E-ACC-31 | Bank credit proposed as the bank side of a cash deposit (T5) with a different amount or more than 10 days after the deposit date | Not paired automatically; pairing only with the exact amount; otherwise the owner corrects the cash transfer by reversal (T10) and a new one, transit stays open meanwhile (E-ACC-18) | „Der Betrag der Gutschrift ({a} €) entspricht nicht der Bareinzahlung vom {datum} ({b} €).“ |
| E-ACC-32 | Source mapper whose fee semantics (is the fee included in the amount?) are not yet verified against the balance continuity (EC-145) | The transaction is imported but not journalised automatically; the owner confirms the split (principal, fee) once per source/type, which is stored as the mapper constant (audited) | „Für {Quelle} ist noch nicht bestätigt, ob die Gebühr im Betrag enthalten ist. Bitte Aufteilung prüfen.“ |
| E-ACC-33 | From P2: bank ledger balance at month end ≠ bank-reported balance (statement closing balance / `balanceAfterCents`, RI-27) | Lock blocked (ACC-017 (2a)); difference list (unbooked, duplicates suspected, missing statement days) | „Kontosaldo {konto} zum {datum} weicht vom Kontoauszug ab ({diff} €). Festschreibung nicht möglich.“ |

### 5.2 Sales/purchase tax timing

| # | Case | Behaviour | Message (DE) |
|---|---|---|---|
| E-TAX-01 | Soll: invoice for a September supply finalised in October, September UStVA already submitted | Tax point September → correction worklist for September; owner chooses „Berichtigte UStVA für 09/2026 erstellen" (default) | „{n} Buchungen gehören steuerlich in den bereits gemeldeten Zeitraum {Periode}. Eine berichtigte Voranmeldung ist erforderlich." |
| E-TAX-02 | Ist: invoice 1,190 € (one rate) March, paid 595 € April, 595 € May | VAT 95 € in April, 95 € in May (UVA-06 golden) | — |
| E-TAX-03 | Ist: partial payments across quarters with mixed rates (19 % + 7 % on one invoice) | Each payment split pro rata by gross per rate; rounding remainder to the largest group; the last payment absorbs so Σ = invoice VAT per rate | — |
| E-TAX-04 | Ist: overpayment | Excess is not VAT-relevant until allocated; credit balance shown | „Überzahlung von {betrag} € – bitte erstatten oder verrechnen." |
| E-TAX-05 | Soll company receives an advance (Abschlag) before supply | VAT due in the payment period (Mindest-Ist); Schlussrechnung declares only the remainder | — |
| E-TAX-06 | Advance paid in a period at 19 %, supply after a rate change | Schlussrechnung recomputes total at the new rate and corrects the advance VAT difference in its period (UST-41) | — |
| E-TAX-07 | Soll → Ist switch at 1 January | Invoices issued under Soll and paid after the switch: VAT already declared → no second declaration (allocation flags `alreadyTaxed`) | Info „Rechnung bereits nach Soll versteuert." |
| E-TAX-08 | Ist → Soll switch at 1 January | Open receivables from the Ist years: VAT becomes due **in the first Soll period** (catch-up of all `notdue` balances, one transfer entry dated 01.01.) | „Beim Wechsel zur Soll-Versteuerung werden {betrag} € noch nicht fällige Umsatzsteuer fällig." |
| E-TAX-09 | Switch mid-year requested | Blocked unless a Finanzamt approval (date + Aktenzeichen/reference + upload) is recorded; then effective at the approved date with the same transition handling as E-TAX-07/08 (EC-115) | „Ein Wechsel der Versteuerungsart ist nur zum Jahresbeginn möglich – oder mit Genehmigung des Finanzamts (bitte Bescheid hinterlegen)." |
| E-TAX-10 | KU → Regelbesteuerung because 100k crossed mid-year | The crossing invoice and all later invoices taxed; earlier ones stay KU; no correction of earlier invoices; UStVA starts with the period of the crossing invoice | Blocking dialog: „Mit dieser Rechnung überschreiten Sie 100.000 €. Diese und alle folgenden Rechnungen werden mit Umsatzsteuer ausgestellt (§ 19 Abs. 1 UStG)." |
| E-TAX-11 | Write-off then later recovery | P8 then P9; VAT reduced in the write-off period (Soll) and re-increased in the recovery period; both reference the original invoice; partial recovery pro rata | — |
| E-TAX-12 | Write-off of an Ist invoice | No UStVA effect; `notdue` cleared | — |
| E-TAX-13 | Write-off without reason/evidence | Blocked | „Bitte Grund und Nachweis für die Uneinbringlichkeit angeben (§ 17 Abs. 2 Nr. 1 UStG)." |
| E-TAX-14 | Skonto taken after the Skonto deadline (or above the agreed rate) | Never applied automatically and never recorded with reason `skonto`. The owner decides: **not accepted** (default) → partial payment, the shortfall stays an open receivable (dunnable), no VAT change; **accepted** → the shortfall is a price reduction actually granted (difference reason `other`, „Kulanz-Preisminderung (Skonto nach Fristablauf)“, reason mandatory) with a pro-rata VAT correction per rate in the payment period — §17 Abs. 1 UStG reduces the tax base by exactly what was actually conceded. A write-off for uncollectibility (§17 Abs. 2) is a different case (E-TAX-11). Same text as 10 EC-122 and F05 PAY-022 | „Skontofrist am {datum} abgelaufen – Abzug als Preisminderung akzeptieren (mit USt-Korrektur) oder Restbetrag offen lassen?“ |
| E-TAX-15 | Storno of an invoice whose supply period is submitted | Storno is a §17 correction in the Storno's own period, no correction filing needed | — |
| E-TAX-16 | Voucher with supply date in a submitted period, received later | Input VAT tax point = receipt (max rule) → current period; no correction needed | — |
| E-TAX-17 | igE voucher without supplier USt-IdNr | Blocked | „Für einen innergemeinschaftlichen Erwerb ist die USt-IdNr des Lieferanten erforderlich." |
| E-TAX-18 | Reverse-charge voucher with VAT shown by supplier | Blocked; advise correction request | „Die Rechnung weist Umsatzsteuer aus, obwohl die Steuerschuld auf Sie übergeht. Bitte Rechnungskorrektur beim Lieferanten anfordern." |
| E-TAX-19 | 2028+ voucher from Ist supplier booked before payment | Input VAT parked in `vat.input.notyet`; released on payment | Info „Vorsteuer erst bei Zahlung abziehbar (Ist-versteuernder Lieferant)." |
| E-TAX-20 | OSS: B2C EU invoice that would exceed 10,000 € | Blocked (P1) | „Ihre EU-weiten Fernverkäufe an Privatkunden würden 10.000 € überschreiten. Ab dann gilt die Umsatzsteuer des Bestimmungslands (OSS, Registrierung beim BZSt erforderlich). Diese Funktion ist noch nicht verfügbar.“ |
| E-TAX-21 | Bilanz legal form selects EÜR | Blocked | „Für {Rechtsform} ist die Einnahmen-Überschuss-Rechnung nicht zulässig (Buchführungspflicht nach HGB)." |
| E-TAX-22 | Payment of dunning fees + principal without payer instruction | §367 BGB allocation: costs → interest → principal | Info „Zahlung nach § 367 BGB verrechnet: zuerst Kosten, dann Zinsen, dann Hauptforderung." |
| E-TAX-23 | Foreign currency invoice paid at a different rate | FX difference to FX gain/loss; VAT stays at the invoice's EUR VAT (MISC-08) | — |

### 5.3 UStVA / ZM filings

| # | Case | Behaviour | Message (DE) |
|---|---|---|---|
| E-UVA-01 | Record a submission without Transferticket | **Blocked** (decided conservative default: the ticket is the proof of transmission and is always shown in the ELSTER protocol) | „Bitte das Transferticket aus dem ELSTER-Übermittlungsprotokoll eintragen. Es steht auch in Mein ELSTER bei den übermittelten Formularen.“ |
| E-UVA-02 | Record a submission before the period ended | Blocked | „Der Zeitraum {Periode} ist noch nicht abgeschlossen." |
| E-UVA-03 | Submission recorded (or instructions opened) while drafts or pending artifacts with tax point in the period exist, or ACC-017 (2a) fails | Blocked (TAX-020/021) | „Es gibt {n} Entwürfe mit Leistungsdatum im Zeitraum. Bitte fertigstellen oder löschen." |
| E-UVA-04 | Second "submitted" for the same period | Only as correction (Kz 10 = 1) | „Für {Periode} wurde bereits eine Voranmeldung übermittelt. Bitte eine berichtigte Voranmeldung erstellen." |
| E-UVA-05 | Correction with no delta | Blocked | „Die berichtigten Werte entsprechen der letzten Meldung – keine Berichtigung nötig." |
| E-UVA-06 | Correction for a period of a prior year after the annual return was filed | Warning: corrections go into the annual return | „Für {Jahr} ist die Jahreserklärung bereits abgegeben? Dann bitte keine berichtigte Voranmeldung, sondern eine berichtigte Umsatzsteuer-Jahreserklärung in Mein ELSTER übermitteln (Arbeitsblatt USt-Jahreserklärung).“ |
| E-UVA-07 | Mapping table for the year missing | Blocked for the instructions and the submission record; values shown with banner | „Die Kennzahlen-Zuordnung für {Jahr} ist noch nicht hinterlegt. Bitte Update einspielen.“ |
| E-UVA-08 | Kz 39 in a non-December/Q4 period | Not applied | — |
| E-UVA-09 | Dauerfristverlängerung for monthly filer without Sondervorauszahlung recorded | Warning in December | „Sondervorauszahlung nicht erfasst – Kz 39 bleibt leer." |
| E-UVA-10 | Deadline on Saturday/Sunday/holiday | Shifted to next working day (§108 Abs. 3 AO), table-driven with Land holidays | — |
| E-UVA-11 | Quarterly filer exceeds 9,000 € prior-year tax | Suggestion for next year: monthly | „Ihre Zahllast {Jahr} lag über 9.000 € – ab {Jahr+1} monatliche Voranmeldung." |
| E-UVA-12 | ZM with customer lacking a valid USt-IdNr check | Warning; K/AE invoices are blocked earlier (MISC-04) | „USt-IdNr {id} nicht qualifiziert bestätigt." |
| E-UVA-13 | ZM vs Kz 41/21 mismatch | Warning with override reason | „ZM-Summe ({a} €) weicht von UStVA Kz {kz} ({b} €) ab." |
| E-UVA-14 | ZM correction for an already-reported customer/period | Correction line with the corrected total for that customer in the original period | — |
| E-UVA-15 | UStVA for a KU company with §13b/igE purchases | Only those Kennzahlen enabled | Info „Als Kleinunternehmer melden Sie nur Steuer nach § 13b/igE." |
| E-UVA-16 | Base rounding produces 0 but tax > 0 (tiny amounts) | Show both; Kz 83 per form arithmetic | — |
| E-UVA-17 | Negative Kz 81 (more credits than sales) | Allowed (form permits negative values) | — |
| E-UVA-18 | Values changed between opening the instructions and recording the submission (a posting with a tax point in the period arrived; `sheetHash` differs) | Record blocked; the Δ per Kennzahl is shown; if the owner already sent the old values: record with the shown old sheet via „abweichend übermittelt“ (E-UVA-19), then a correction | „Die Werte haben sich seit dem Öffnen der Ausfüllhilfe geändert ({n} Kennzahlen). Bitte prüfen, welche Werte an ELSTER übermittelt wurden.“ |
| E-UVA-19 | Cross-check value from the ELSTER protocol (Kz 83 / ZM sum / EÜR Gewinn / Kz 38) ≠ app value | Blocked, unless „abweichend übermittelt“ with mandatory reason → filing stored with `submittedValuesDiffer`, `elsterReportedTotalCents`; correction worklist opens immediately (UStVA/ZM: berichtigte Meldung; EÜR: hint to a berichtigte Erklärung) | „ELSTER weist {a} € aus, die Buchhaltung {b} €. Bitte Eingaben vergleichen. Wurde bereits so übermittelt, ist eine Berichtigung erforderlich.“ |
| E-UVA-20 | Mein ELSTER guide data or the EÜR/UStVA mapping for the form year not yet verified (`verifiedAgainstForm` missing) | Values shown with banner; copy buttons and submission record blocked | „Die Ausfüllhilfe für {Formular} {Jahr} ist noch nicht gegen das amtliche Formular geprüft. Bitte Update einspielen.“ |
| E-UVA-21 | EÜR submission record before the fiscal year ended, or while a UStVA of the year is not submitted | Blocked (TAX-022) | „Die EÜR {Jahr} kann erst erfasst werden, wenn das Jahr abgeschlossen und alle Voranmeldungen {Jahr} übermittelt sind.“ |
| E-UVA-22 | December/Q4 period filed in January: owner may pick the current year's form in ELSTER | Guide shows the form year prominently and the checklist asks for it | „Achtung: Formular {Jahr} wählen, nicht {Jahr+1}.“ |

### 5.4 Assets

| # | Case | Behaviour | Message (DE) |
|---|---|---|---|
| E-AST-01 | Degressive method for acquisition outside 2025-07-01..2027-12-31 | Method not offered; API 422 | „Degressive AfA ist für Anschaffungen am {datum} nicht zulässig." |
| E-AST-02 | Degressive for an immovable/intangible asset | Blocked | „Degressive AfA gilt nur für bewegliche Wirtschaftsgüter." |
| E-AST-03 | GWG chosen for net cost > threshold valid at acquisition date | Blocked; threshold looked up by **acquisition date** (800 € until the JStG-2026 row activates; acquisitions after its `validFrom` use the new value) | „GWG-Grenze am {datum}: {grenze} € netto. Dieses Wirtschaftsgut muss aktiviert werden." |
| E-AST-04 | Mixed GWG/Sammelposten choice within one fiscal year for 250.01–1,000 € items | Blocked | „Für {Jahr} wurde bereits {Wahl} gewählt. Die Wahl gilt einheitlich für alle Wirtschaftsgüter von 250,01 € bis 1.000 €." |
| E-AST-05 | Sammelposten for acquisitions after abolition date (if JStG row active) | Not offered | „Sammelposten ist für Anschaffungen ab {datum} nicht mehr zulässig." |
| E-AST-06 | Disposal mid-year (linear) | AfA through the disposal month, then RBW | — |
| E-AST-07 | Disposal of a pool item | No AfA/RBW change; info | „Der Sammelposten wird unverändert fortgeführt (§ 6 Abs. 2a EStG)." |
| E-AST-08 | Disposal date before last posted AfA period | Blocked | „Abgangsdatum liegt vor der letzten gebuchten AfA ({MM/JJJJ})." |
| E-AST-09 | Disposal in a locked period | Late-posting rule ACC-006 for the RBW entry; the asset keeps the real disposal date | Info as E-ACC-03 |
| E-AST-10 | Change of cost after first AfA | Blocked; use manual correction entry + new asset | „Anschaffungskosten können nach der ersten AfA nicht mehr geändert werden." |
| E-AST-11 | Useful life missing for linear | Blocked; AfA-Tabelle search offered | „Bitte Nutzungsdauer angeben (AfA-Tabelle)." |
| E-AST-12 | Input VAT not deductible (KU, private share) | Cost = gross | Info |
| E-AST-13 | Depreciation run for an already-posted (asset, month) | Idempotent no-op | — |
| E-AST-14 | AfA run hits a locked month | Skipped with finding; catch-up posts in the first open month with the late-posting flag | „AfA {MM/JJJJ} konnte wegen Festschreibung nicht gebucht werden und wurde im {MM/JJJJ} nachgeholt." |
| E-AST-15 | E-vehicle special AfA for a non-qualifying vehicle | Checkbox „rein elektrisch, Neufahrzeug, betrieblich" required | „Die Sonder-AfA gilt nur für neue, rein elektrische Fahrzeuge." |
| E-AST-16 | Asset ≤ 250 € net registered | Allowed (optional register), expensed immediately | — |

### 5.5 Reports, monitors, estimates

| # | Case | Behaviour | Message (DE) |
|---|---|---|---|
| E-RPT-01 | Report covers unlocked periods | Label „vorläufig" | „Vorläufig – Zeitraum nicht festgeschrieben." |
| E-RPT-02 | EÜR for a Bilanz company | Hidden; API 409 | „Ihre Gewinnermittlung ist Bilanzierung – EÜR nicht verfügbar." |
| E-RPT-03 | 10-day rule: December UStVA paid 08.01., due 10.01. (no Dauerfrist) | Expense in the previous year | — |
| E-RPT-04 | 10-day rule with Dauerfristverlängerung (due 10.02.) | Expense in the payment year | — |
| E-RPT-05 | Payment 09.01. of a UStVA due 10.01. but paid late on 12.01. | Outside window → payment year | — |
| E-RPT-06 | OPOS doesn't match the receivable account | Difference row with cause list (manual entries on 1400/1200) | „Offene Posten weichen vom Kontosaldo um {diff} € ab." |
| E-RPT-07 | Tax reserve year tariff missing | Last known year used | „Tarif {Jahr} noch nicht hinterlegt – Berechnung mit Tarif {Vorjahr}." |
| E-RPT-08 | Tax reserve with negative profit | ESt 0; info | — |
| E-RPT-09 | Forecast with no customer history | Due date used | Info „Keine Zahlungshistorie – Fälligkeit angenommen." |
| E-RPT-10 | KU 80 % / 95 % thresholds | Notifications | „Kleinunternehmergrenze zu {80/95} % erreicht ({betrag} € von 100.000 €)." |
| E-RPT-11 | Founding year KU > 25,000 € | Blocking dialog like E-TAX-10 | „Im Gründungsjahr gilt die Grenze von 25.000 €." |
| E-RPT-12 | Turnover > 800,000 € (prior year) | Info AO-01 + ER-03 + §20 | „Umsatz {Jahr} über 800.000 €: E-Rechnungspflicht ab {Jahr+1}; Ist-Versteuerung endet; Buchführungspflicht nach Mitteilung des Finanzamts möglich." |

## 6. UI

Routes per 04-ui-ux §3.4.

| Route | Content |
|---|---|
| `/buchhaltung/journal` | Journal table (seq, Datum, Beleg, Text, Konto, Gegenkonto, Soll, Haben, Steuerschlüssel, Kostenstelle, 🔒); filters; row → side sheet with lines, source link, rule version and "Warum dieses Konto?" explanation; actions „Gegenbuchung" (manual entries only), „Manuelle Buchung" (primary) |
| `/buchhaltung/journal/neu` | Manual entry editor: date, text, line grid (Konto ⌘-autocomplete with name and type, Soll, Haben, Steuer, Kostenstelle, Kontakt), templates dropdown, attachment drop zone (mandatory), live balance bar („Differenz 0,00 €" green), preview of DATEV lines |
| `/buchhaltung/konten` | Chart of accounts (filter by class/type, used/unused), account detail = Kontenblatt with running balance, role mapping tab („Rollen & Standardkonten“: each row with ⚠ badge where the research is uncertain, a red „nicht zugeordnet“ badge for UNSURE roles that block postings, and an optional, non-blocking field „Einmalige Prüfung durch Steuerberater am“ with the hint „Empfohlen vor dem Echtbetrieb, nicht erforderlich“) |
| `/buchhaltung/eroeffnung` | Opening balances wizard: fiscal year → Kasse (Anfangsbestand) and bank accounts (from the first statement's opening balance) → open receivables (from the sevdesk export import or manual) → *(P2)* other Sachkonten grid → open payables → check balance → post |
| `/buchhaltung/anlagen` | Asset list (Inventarnr., Bezeichnung, Konto, Anschaffung, AK, Methode, Buchwert, AfA lfd. Jahr, Status); detail with depreciation plan table and chart; actions „Abgang erfassen", „AfA jetzt buchen"; tabs „Anlagenspiegel {Jahr}", „GWG-Verzeichnis", „Sammelposten" |
| `/buchhaltung/festschreibung` | Month grid per fiscal year (open / locked 🔒 with reason, date, actor); select through month → checklist dialog → irreversible confirm („Festschreiben kann nicht rückgängig gemacht werden. Korrekturen sind danach nur per Gegenbuchung möglich.") |
| `/steuern/ustva` | Period picker (with deadline and status chips); **step-by-step page per §4.7a**: (1) „Werte prüfen“ — Kennzahlen table (Kz, Bezeichnung, Bemessungsgrundlage, Steuer laut Formular, „laut Buchhaltung“), Δ-banner for corrections, drill-down drawer per Kz (documents list, sums, link to journal), blocker list; (2) „Einmalig einrichten“; (3) „In Mein ELSTER öffnen“ (navigation path, Formularjahr in large type); (4) „Eintragen“ — fields in ELSTER order with „Kopieren“ buttons (copied string as ELSTER expects; toast „Kopiert: 1234“) and „eingetragen“ ticks, „leer lassen“ hints; (5) „Abschluss-Check“ checklist; (6) „Übermittlung erfassen“ (dialog: Übermittelt am, Transferticket (Pflicht), Protokoll-PDF, „Kz 83 laut ELSTER“; explains the irreversible lock). Actions „Als PDF/CSV“ (incl. instructions), „Berichtigte Voranmeldung erstellen“ (same steps with „Berichtigte Anmeldung: Ja“); Dauerfristverlängerung card with Sondervorauszahlung (same steps for USt 1 H) |
| `/steuern/zm` | Period picker, rows per USt-IdNr (Land, Nr., Art L/S/D, Betrag in vollen Euro), reconciliation with Kz 41/21, the same step-by-step Mein ELSTER page („Zusammenfassende Meldung“) with copy buttons per row, CSV export for the BZSt-Online-Portal as alternative, „Übermittlung erfassen“ (Σ cross-check) |
| `/steuern/euer` | Year picker, Anlage-EÜR lines with official line numbers for the year, drill-down, „Zeilen gegen amtlichen Vordruck prüfen“ banner while unverified, private section, non-deductible add-backs, Anlage AVEÜR tab (if assets exist), the step-by-step Mein ELSTER page (path per legal form: Einkommensteuererklärung → Anlage EÜR, or Feststellungserklärung), PDF/CSV, „Übermittlung erfassen“ (Gewinn/Verlust cross-check; locks all months of the year) |
| `/steuern/ust-jahr` | USt-Jahreserklärung worksheet (TAX-023): lines with year totals, reconciliation with the submitted UStVAs (expected Abschlusszahlung/Erstattung), Mein ELSTER instructions, PDF/CSV; no submission record |
| Bilanz companies | `/steuern/euer` hidden; tax pages show the AO-07 notice of TAX-014 („… externes Programm oder Steuerberater“) |
| `/steuern/ruecklage` | Tax reserve: inputs card (Gewinnprognose: automatisch/manuell, Veranlagung: Einzel/Zusammen, Kirchensteuer: keine/8 %/9 %, Hebesatz, bereits gezahlte Vorauszahlungen, sonstige Einkünfte/Abzüge), result card with breakdown (USt, ESt, Soli, KiSt, GewSt, §35-Anrechnung, Summe, monatliche Rücklage), always-visible disclaimer |
| `/auswertungen` | Tiles: BWA, SuSa, Kontenblatt, Offene Posten, Umsatz nach Kunde/Produkt/Monat, Journal, Anlagenspiegel, USt-Verprobung, Liquiditätsvorschau; each report page has parameters in the URL, export buttons, „vorläufig" badge |
| `/auswertungen/liquiditaet` | 90-day line chart (expected vs cautious band, threshold line), list of items (filter by source), „Geplante Position hinzufügen" |
| Dashboard widgets | Umsatz, Offene Forderungen, Liquidität (forecast sparkline), Kasse (balance of the `cash` account), Steuer-Rücklage, KU/800k bars, USt-Zahllast with the next ELSTER deadline and a „Jetzt ausfüllen“ link (per 04-ui-ux §4.7) |

Mobile: reports render as stacked cards with key figures; tables scroll horizontally with a sticky first column; the manual entry editor is desktop-first (on mobile: read-only notice „Manuelle Buchungen bitte am Desktop erfassen", but viewing works). Charts follow the dataviz palette rules (04-ui-ux §2). The Mein ELSTER step pages work on every viewport (copy buttons, ticks); on desktop they recommend a side-by-side window with Mein ELSTER; on phones the steps render as a vertical list with sticky „Kopieren“ buttons.

## 7. API and MCP exposure

### REST (`/api/v1`, scopes per 05-api §2)

| Method | Path | Scope | Notes |
|---|---|---|---|
| GET | `/journal-entries` | accounting:read | Filters `period`, `account`, `contact_id`, `source_kind`, `late`, `q`, `date_from/to`; `seq` order |
| GET | `/journal-entries/{id}` | accounting:read | Lines, source, rule version, explanation |
| POST | `/journal-entries` | accounting:write | Manual entry; requires `attachments[]` or `source`; `Idempotency-Key` |
| POST | `/journal-entries/{id}/reverse` | accounting:write | Body `{ date, reason }` |
| GET | `/ledger-accounts` / POST / PATCH `/{id}` | accounting:read/write | Custom accounts; system accounts read-only |
| GET/PUT | `/ledger-accounts/roles` | accounting:read/write | Role mapping (audited) |
| POST | `/opening-balances` | accounting:write | `{ fiscal_year, gl[], receivables[], payables[] }` |
| GET | `/periods` | accounting:read | Status per month |
| POST | `/periods/{YYYY-MM}/lock` | accounting:write | Body `{ reason, include_previous: true }`; returns checklist failures as 409 `period_lock_blocked` |
| GET/POST | `/assets`, GET/PATCH `/assets/{id}` | accounting:read/write | |
| POST | `/assets/{id}/dispose` | accounting:write | `{ date, kind, proceeds_cents?, invoice_id? }` |
| POST | `/assets/depreciation-runs` | accounting:write | `{ period }` idempotent |
| GET | `/reports/ustva?period=2026-09\|2026-Q3` | reports:read | Kennzahlen, both tax columns, drill-down links, status |
| GET | `/reports/ustva/{period}/elster-guide` | reports:read | Mein ELSTER instructions (TAX-020): prerequisites, navigation path, form year, ordered fields with formatted copy strings, checklist, `sheet_hash`, blockers |
| POST | `/reports/ustva/{period}/submissions` | accounting:write | Record the manual submission (TAX-021) `{ submitted_on, transfer_ticket, protocol_base64?, cross_check_cents, sheet_hash, values_differ_reason? }` → `submitted_via = mein_elster_manual`, locks; 409 `sheet_changed` / `cross_check_mismatch` / `transfer_ticket_required`; actor `user:<id>` or `api-key:<id>` |
| POST | `/reports/ustva/{period}/corrections` | accounting:write | Create correction draft |
| GET | `/reports/zm?period=` / `/reports/zm/{period}/elster-guide` / POST `/reports/zm/{period}/submissions` | reports:read / accounting:write | Same body and errors as UStVA submissions; `zm_submitted` lock |
| GET | `/reports/sondervorauszahlung?year=` / POST `/reports/sondervorauszahlung/{year}/submissions` | reports:read / accounting:write | USt 1 H sheet + guide; record without lock |
| GET | `/reports/euer?year=` / `/reports/euer/{year}/elster-guide` | reports:read | Lines by semantic key + official line numbers, AVEÜR, verification status |
| POST | `/reports/euer/{year}/submissions` | accounting:write | Record the EÜR submission (TAX-022) — same body as UStVA; creates `taxFilings.kind = "euer"`; locks all months of the year (`euer_submitted`); 409 `fiscal_year_not_ended` / `ustva_missing` |
| GET | `/reports/ust-annual?year=` | reports:read | USt-Jahreserklärung worksheet + guide (TAX-023) |
| GET | `/reports/bwa?from=&to=&variant=accrual\|cash` | reports:read | |
| GET | `/reports/susa?from=&to=` / `/reports/ledger?account=&from=&to=` | reports:read | |
| GET | `/reports/open-items?side=debtors\|creditors&as_of=` | reports:read | |
| GET | `/reports/revenue?group_by=customer\|product\|month&basis=accrual\|cash` | reports:read | |
| GET | `/reports/anlagenspiegel?year=` | reports:read | |
| GET | `/reports/tax-reserve` | reports:read | Query overrides for assumptions; response has `estimate: true`, `assumptions[]` |
| GET | `/reports/cashflow-forecast?days=90&scenario=expected\|cautious` | reports:read | |
| GET | `/reports/thresholds` | reports:read | KU/800k/OSS monitors |

### MCP tools (06-mcp §3.8)

| Tool | Hints | Scope | Notes |
|---|---|---|---|
| `report_ustva_values` | readOnlyHint | reports:read | `{ period }` → Kennzahlen, Zahllast, status, deadline, top contributors per Kz (concise) |
| `report_zm` | readOnlyHint | reports:read | |
| `report_euer` | readOnlyHint | reports:read | `{ year }` → lines by semantic key + official line numbers, verification and submission status |
| `report_elster_guide` | readOnlyHint | reports:read | `{ form: ustva \| ustva_correction \| zm \| sondervorauszahlung \| euer \| ust_annual, period }` → the TAX-020 steps (path, form year, fields with copy strings, checklist, blockers) so Claude can walk the owner through Mein ELSTER; never records a submission |
| `report_ust_annual` | readOnlyHint | reports:read | `{ year }` → worksheet lines + reconciliation (TAX-023) |
| `report_open_items` | readOnlyHint | reports:read | `{ side, as_of?, overdue_only? }` |
| `report_revenue` | readOnlyHint | reports:read | `{ group_by, from, to, basis }` |
| `tax_reserve_estimate` | readOnlyHint | reports:read | Output always contains `disclaimer: "Schätzung – keine Steuerberatung"` |
| `cashflow_forecast` | readOnlyHint | reports:read | `{ days ≤ 90, scenario }` → weekly summary + lowest point |
| `journal_search` | readOnlyHint | accounting:read | `{ q?, account?, period?, source_kind? }` |
| `kleinunternehmer_status` | readOnlyHint | reports:read | KU + 800k + OSS monitors |

Not exposed via MCP: manual journal entries, opening balances, period lock, submission records (UStVA, ZM, Sondervorauszahlung, EÜR), ERiC transmission (P4), role mapping changes, asset disposal (owner-only legal acts; cash transfers are the ⚠ tool `cash_transfer_record` of F07/06 §3.7; MCP may explain, show the ELSTER guide and link to the UI page).

Outbound events (additions to 05-api §5.3, proposed; subject to 05's decision on outbound webhooks in the tailnet-only setup — there are no inbound webhooks): `period.locked`, `tax_filing.submitted`, `tax_filing.correction_required`, `threshold.warning`.

## 8. Acceptance tests

| Test ID | Given / When / Then | Type | Covers req IDs |
|---|---|---|---|
| TST-ACC-01 | Given any generated entry (fast-check over random events) / when posted / then Σdebit = Σcredit, ≥ 2 lines, `seq` gapless | U, C | ACC-001, GOBD-03, GOBD-05, RI-12 |
| TST-ACC-02 | Given each event in §4.2 for SKR03 and SKR04 × Soll/Ist / when posted / then lines equal the golden `expected.journal.json` and `expected.datev.csv` | G | ACC-002, ACC-008, DATEV-02 |
| TST-ACC-03 | Given a journal entry / when any public mutation tries to patch or delete it / then `immutable_record` (part of the mutation inventory test) | C | ACC-004, GOBD-06 |
| TST-ACC-04 | Given September locked / when a voucher dated 2026-09-20 is finalised on 2026-10-05 / then the entry is dated 2026-10-01 with `originalDate` 2026-09-20, `latePosting` and the info message | C | ACC-006, GOBD-06, EC-170, EC-162, RI-13 |
| TST-ACC-05 | Given September locked / when `POST /journal-entries` with date 2026-09-30 / then 409 `period_locked` with E-ACC-04 text | C | ACC-006, ACC-012, EC-170 |
| TST-ACC-06 | Given a manual entry without attachment / when saved / then blocked with E-ACC-02 | C | ACC-005, GOBD-07 |
| TST-ACC-07 | Given the MCP tool list for a "full" key / then no tool writes journal entries, locks periods or confirms filings | C | ACC-012 |
| TST-ACC-08 | Given every role in both charts / then it resolves to a seeded account with EÜR key and BWA group | U | ACC-007, ACC-008 |
| TST-ACC-09 | Given opening balances with 2 open invoices (one Ist with VAT 19 %) / when both are paid / then receivables clear and Ist VAT becomes due in the payment period | C | ACC-013, UVA-06 |
| TST-ACC-10 | Given months 07–08 open / when locking 09 / then 07–09 are locked in one job; all records in them get `lockedAt` | C | ACC-015, ACC-016, GOBD-06, RI-13 |
| TST-ACC-11 | Given a draft dated in 09 / when locking 09 / then blocked (E-ACC-16) | C | ACC-017 |
| TST-ACC-12 | Given a posting arriving while 09 is `locking` / then it lands in 10 via the late-posting rule, never in 09 | C (integration) | ACC-006, E-ACC-20, EC-170, RI-13 |
| TST-ACC-13 | Given Ist, invoice 1,190 € in March paid 595 € April and 595 € May / then UStVA April Kz 81 = 500, May = 500 (VAT 95 + 95) | U, G | ACC-021, UVA-06, EC-172 |
| TST-ACC-14 | Given Ist, invoice 19 % 1,000 € + 7 % 500 € net paid in three instalments across Q1/Q2/Q3 / then each quarter's Kz 81/86 shares are pro rata and Σ VAT = 190 + 35 exactly (fast-check over random splits) | U | ACC-021, UVA-06, EC-172 |
| TST-ACC-15 | Given Soll → Ist on 2027-01-01 and a 2026 invoice paid in Feb 2027 / then no VAT in 2027 UStVA for it | U, C | ACC-022, UVA-06, EC-115 |
| TST-ACC-16 | Given Ist → Soll on 2027-01-01 with `notdue` balances 380 € / then a transfer entry dated 2027-01-01 and Kz 81 in Jan/Q1 2027 include the bases | U, C | ACC-022, UVA-06, EC-115 |
| TST-ACC-17 | Given a mid-year switch request / then E-TAX-09 | U | ACC-022, EC-115 |
| TST-ACC-18 | Given an EUR→USD exchange delivered as two separate booked transactions (EUR account −1,000 €, USD account +1,085 USD; CAMT.053 and Enable Banking fixtures) / then they are paired, two entries via `transit` net to 0 and the USD account cost = 1,000 € | U, C | ACC-024, R1, MISC-08, EC-144 |
| TST-ACC-19 | Given a USD account avg cost 0.92 €/USD / when 500 USD are exchanged to 470 € (two transactions) / then FX gain 10 € posted on the USD side's booking date | U | ACC-024, ACC-023, R2, EC-144 |
| TST-ACC-20 | Given a card payment in USD debited from the EUR account with a fee of 0.66 € (fee field `source.feeCents` from the Revolut CSV `Fee` column and from CAMT `Chrgs`) / then voucher payment at the debited EUR amount excluding the fee and a separate fee line on `expense.bank_fees` without VAT; mapper fee semantics verified by balance continuity (EC-145) | U, C | ACC-024, R4, EC-145 |
| TST-ACC-21 | Given a bank fee transaction 35 € (account fee) / then S `expense.bank_fees` / H `bank.EUR` 35 €, no VAT lines, no UStVA Kennzahl; selecting §13b or input VAT without an attached invoice → blocked (E-ACC-28) | U, G | ACC-024, R5, EC-164 |
| TST-ACC-25 | Given a pending transaction (feed), then its booked twin with a different amount, then a separate booked return transaction confirmed as reversal / then no entry while pending, one entry for the booked transaction (booked amount), one reversal entry dated on the return's booking date; payment re-opened (EC-140, EC-141, RI-10) | C | ACC-024, R13, EC-140, EC-141 |
| TST-ACC-26 | Given a transaction timestamp 2026-09-30T22:30:00Z (feed) and the same transaction in a UTC CSV export / then booking date 2026-10-01 for both and UStVA period Q4 (Stichtag, DST) | U | ACC-024, EC-155, GOBD-22 |
| TST-ACC-27 | Given random event sequences (fast-check `fc.commands`: finalise/pay/cash pay/cash transfer/storno/voucher/lock/bank events from statement import and feed) / then RI-11, RI-12 and RI-13 hold after every step | C | ACC-001, ACC-006, RI-12, RI-13 |
| TST-ACC-22 | Given an exchange with one side missing for 3 days (other pocket's statement not yet imported) / then E-ACC-23 warning and pre-lock warning; after importing the other side the pair closes and transit = 0 | C | ACC-017, ACC-024 |
| TST-ACC-23 | Given an entry recorded after its period's lock (direct DB write in integration test) / then `integrity.verify` reports it | C (integration) | ACC-020, SEC-04, RI-13, EC-182 |
| TST-ACC-24 | Given a customer payment with fees + interest + principal and no instruction / then allocation order costs → interest → principal | U | E-TAX-22 |
| TST-AST-01 | Machine 10,000 € acquired 2025-08-15, 10 years, degressive / then year-1 AfA = 1,250.00 € | U | AST-005, AO-03 |
| TST-AST-02 | Degressive asset / then switch to linear in the first year linear ≥ degressive | U | AST-005 |
| TST-AST-03 | Laptop 799 € net on 2026-03-01 / then GWG offered, written off in 03/2026, appears in GWG list | U, C | AST-007 |
| TST-AST-04 | Item 900 € net acquired on the JStG-2026 `validFrom` date with the row activated / then GWG allowed; acquired one day earlier → must be capitalised (E-AST-03) | U | AST-003, AO-03, MISC-09, EC-175 |
| TST-AST-05 | Year choice Sammelposten 2026, then a GWG choice for a 600 € item in 2026 / then E-AST-04 | U | AST-008 |
| TST-AST-06 | Pool 2026 with 3 items 3,000 € / then 600 € per year 2026–2030; disposal of one item in 2027 changes nothing | U | AST-008, D8 |
| TST-AST-07 | Linear asset 3,600 €, 36 months from 2026-01-10, sold 2026-06-15 for 3,000 € net / then AfA Jan–Jun 600 €, RBW 3,000 €, no gain/loss, proceeds on `disposal.proceeds.*` with 19 % VAT | U, C | AST-010, EC-176 |
| TST-AST-08 | Disposal in a locked month / then RBW entry late-posted, asset disposal date unchanged | C | AST-010, ACC-006, EC-176, EC-170 |
| TST-AST-09 | Depreciation run executed twice for 2026-10 / then no duplicate entries | C | AST-009 |
| TST-AST-10 | E-vehicle 50,000 € acquired 2026-02-01 / then 37,500 € in 2026 (schedule per rule table) | U | AST-006 |
| TST-AST-11 | Anlagenspiegel 2026 / then columns reconcile (AK 01.01. + Zugänge − Abgänge; Buchwert 31.12. = journal balance of asset accounts) | U, G | AST-012 |
| TST-AST-12 | Acquisition on 2025-06-30 / then degressive not offered (E-AST-01) | U | AST-003 |
| TST-TAX-01 | Prior-year tax 9,000.00 → quarterly; 9,000.01 → monthly; Q1 due 2027-04-10 is Saturday → 2027-04-12 | U | TAX-001, UVA-01 |
| TST-TAX-02 | Prior-year advance payments 22,000 € / then Sondervorauszahlung 2,000 €; December Kz 39 = 2,000 | U | TAX-002, UVA-02 |
| TST-TAX-03 | Golden dataset 2026 (all §4.2 sales/purchase events) / then expected Kennzahlen; swapping the 2027 mapping changes only mapping-driven values | G | TAX-003, UVA-03 |
| TST-TAX-04 | Bases 1,234.56 € (19 %) / then Kz 81 = 1,234 €, tax "laut Formular" 234.46 €, "laut Buchhaltung" shown with difference | U | TAX-004 |
| TST-TAX-05 | From Kz 81 drill down to a document and back from the document to Kz 81 | E | TAX-005, GOBD-01 |
| TST-TAX-06 | Record a UStVA submission with date, Transferticket, protocol PDF, matching Kz 83 and the current `sheetHash` / then filing `submitted_manually`, `submittedVia = mein_elster_manual`, values frozen, protocol archived with sha256, months locked `ustva_submitted`, audit actor `user:<id>` | C, E | TAX-006, TAX-021, UVA-04 |
| TST-TAX-07 | Soll: Sept submitted; an invoice with supply 2026-09-28 finalised 2026-10-03 / then Sept shows "Korrektur erforderlich" with Δ Kz 81; correction filing has Kz 10 = 1 and complete values; previous filing `superseded`; Sept stays locked | C, E | TAX-007, TAX-008, UVA-03, GOBD-06, EC-171, RI-23 |
| TST-TAX-08 | Correction with no delta / then E-UVA-05 | U | TAX-007 |
| TST-TAX-09 | Advance invoice (Soll) finalised in Sept, paid in Oct / then no Sept VAT; Oct Kz 81 includes the advance; Schlussrechnung in Nov declares only the remainder | U, G | TAX-008, UST-40, UST-41, EC-173 |
| TST-TAX-10 | Write-off of 1,190 € (Soll) in Q2 then 595 € recovered in Q4 / then Q2 Kz 50 −1,000 ⚠, Q4 positive 500 base and VAT 95 | U, G | P8, P9, E-TAX-11, EC-124 |
| TST-TAX-11 | Two EU customers (L and S) in Q3 / then ZM rows aggregated per USt-IdNr and type; Σ L = Kz 41, Σ S = Kz 21; due 25.10. | U, G | TAX-009, TAX-010, UVA-05 |
| TST-TAX-12 | KU company with an EU SaaS reverse-charge voucher / then UStVA shows only Kz 46/47 and 67 | U | TAX-011, KU-05 |
| TST-TAX-13 | KU: current-year turnover 79,999 → no warning; 80,000 → 80 % warning; invoice crossing 100,000 → blocking dialog and taxed | U, C, E | TAX-012, KU-01, EC-060 |
| TST-TAX-14 | Founding year with 25,000.01 € / then blocking dialog | U | TAX-012, KU-01, EC-066 |
| TST-TAX-15 | Prior-year Gesamtumsatz 800,000.01 € / then ER-03 MUST_E for 2027 invoices and Ist warning | U | TAX-013, ER-03, UVA-06, EC-029 |
| TST-TAX-16 | Legal form GmbH + EÜR / then blocked; tax pages show the AO-07 notice (external tool or advisor for Jahresabschluss/E-Bilanz); UStVA sheet still available | U, E | TAX-014, AO-01, AO-07 |
| TST-TAX-17 | December UStVA paid 2027-01-08, due 2027-01-10 (no Dauerfrist) / then EÜR 2026 expense; with Dauerfrist (due 2027-02-10) → EÜR 2027 | U | TAX-016, AO-02, EC-177 |
| TST-TAX-18 | EÜR 2026 for a golden year / then lines per semantic key match the expected file; Bewirtung 30 % and GewSt added back | G | TAX-015, AO-02, MISC-05, RI-28 |
| TST-TAX-19 | B2C EU invoices totalling 9,900 € then a 200 € B2C invoice to FR / then blocked with E-TAX-20 | U, C | TAX-017, UVA-07, EC-057 |
| TST-TAX-20 | Late input VAT voucher with supply in a submitted period / then counted in the receipt period, no correction needed | U | E-TAX-16, EC-162 |
| TST-TAX-21 | 2028-02-01 voucher from an Ist supplier / then VAT parked until payment; Kz 66 in the payment period (Stichtag simulation 2027-12-31/2028-01-01) | U | V12, MISC-09 |
| TST-TAX-22 | Storno in Oct of an invoice with supply in submitted Sept / then negative values in Oct, no correction worklist | U | E-TAX-15 |
| TST-TAX-23 | Rate change simulation (fake 19 → 20 % on 2027-07-01) / then UStVA maps both rates (Kz 81 vs 35/36 per mapping) | U | MISC-09, UVA-03 |
| TST-TAX-24 | Given a submitted UStVA for 2026-09 and an unchanged journal / then RI-23 recomputation equals stored values; after a late Sept-tax-point document RI-23 raises WARN and the correction worklist appears | C | TAX-006, TAX-007, RI-23, EC-171 |
| TST-TAX-25 | Boundary values: KU 25,000.00/25,000.01 and 100,000.00/100,000.01; 800,000.00/800,000.01; OSS 10,000.00/10,000.01 / then thresholds trigger exactly above the limit | U | TAX-012, TAX-013, TAX-017, EC-060, EC-066, EC-057 |
| TST-ACC-28 | Given the bank-reported balance (statement closing balance / `balanceAfterCents`) / then Σ booked transactions since the opening balance equals it (RI-27); a missing transaction raises WARN and from P2 blocks the lock (E-ACC-33) | C | ACC-024, ACC-017, RI-27, EC-147 |
| TST-RPT-01 | SuSa for 2026 / then Σ debit = Σ credit; balances equal Kontenblatt closings | U, C | RPT-004, RPT-005 |
| TST-RPT-02 | OPOS as of 2026-06-30 after a payment on 2026-07-05 / then the invoice is open in the as-of view | C | RPT-006 |
| TST-RPT-03 | BWA golden year / then groups and % match the expected file | G | RPT-003 |
| TST-RPT-04 | Revenue by customer with a Storno / then netted to 0 for the cancelled invoice | C | RPT-007 |
| TST-RPT-05 | Tax reserve 2026, single, profit 60,000 €, no KiSt, Gewerbe with Hebesatz 400 % / then ESt per §32a 2026 table, GewSt (60,000 − 24,500 → 35,500 × 3.5 % × 400 % = 4,970 €), §35 credit min(4 × 1,242.50, 4,970, ESt) — exact golden values from the rule table | U | RPT-010 |
| TST-RPT-06 | Tax reserve response (REST and MCP) / then contains `estimate: true`, assumptions and the disclaimer text | C | RPT-011 |
| TST-RPT-07 | Forecast with a customer whose last 5 delays are 2, 4, 10, 12, 30 days / then expected delay 10, cautious P80 delay; invoice due in 5 days appears on day 15 | U | RPT-012, §4.8 |
| TST-RPT-08 | Every report endpoint / then shows „vorläufig" if the range includes an unlocked month | C | RPT-001 |
| TST-RPT-09 | Report CSV exports / then stable header golden files, `;`, decimal comma, UTF-8 BOM | G | RPT-014, GOBD-11 |
| TST-RPT-10 | Report UI pages on desktop and iPhone / then no axe violations, visual baselines | E, V | RPT-002 |
| TST-ACC-29 | Given Ist and Soll / when an invoice of 119 € is paid „bar“ on today's date (P1) / then S `cash` 119 · H `receivable` 119 (+ Ist VAT transfer 19 €); cash balance +119 | U, C | ACC-026, P3, CSH-021 |
| TST-ACC-30 | Given a booked voucher 59.50 € (19 %) / when paid „bar“ / then S `payable` · H `cash`; a direct cash voucher posts S expense 50 · S `vat.input.19` 9.50 · H `cash` 59.50; a cash balance of 40 € → blocked (CSH-026) | U, C | ACC-026, T6, CSH-022, CSH-026 |
| TST-ACC-31 | Given a voucher „privat bezahlt“ / when the company is an Einzelunternehmen / then H `private.deposit`; when a GmbH / then H `shareholder.clearing`; when a GmbH with `shareholder.clearing` unmapped / then blocked (E-ACC-30) | U, C | ACC-028, T7, CSH-023 |
| TST-ACC-32 | Given a cash deposit of 500 € on 2026-03-02 and a bank credit of 500 € on 2026-03-03 (statement import) / then cash leg S `transit` · H `cash` on 03-02, bank leg S `bank` · H `transit` on 03-03, transit 0; a credit of 499 € is not paired (E-ACC-31) | U, C | ACC-026, T5, CSH-024 |
| TST-ACC-33 | Given a private withdrawal of 100 € from the till / then S `private.withdrawal` · H `cash` (SKR03 1800/1000, SKR04 2100/1600); for a UG → offered as `shareholder.clearing` (E-ACC-30) | U | ACC-026, ACC-028, T8, CSH-024 |
| TST-ACC-34 | Given a booked ATM debit of 200 € marked „Bargeldabhebung in die Kasse“ / then S `transit` · H `bank` and S `cash` · H `transit` both on the Europe/Berlin booking date; transit 0; cash +200 | U, C | ACC-026, T9, CSH-025 |
| TST-ACC-35 | Given a cash payment reversal that would make the cash balance negative on a later date / then blocked; a reversal that keeps it ≥ 0 mirrors the lines with `reversalOfId` | C | ACC-026, T10, CSH-026, CSH-027, RI-11 |
| TST-ACC-36 | Given a USD voucher paid from the USD account (moving-average cost 0.92 €/USD, voucher booked at 0.93) / then H `bank.USD.fx` at 0.92 and the difference on FX gain/loss | U | ACC-023, ACC-024, R14, MISC-08 |
| TST-ACC-37 | Given P1 (statement import, matching) with 10 booked transactions of which 3 match invoices and 1 is an ATM withdrawal into the till / then exactly 4 bank-side journal entries exist; after enabling P2 catch-up the other 6 post with their own booking dates and RI-27 holds | C | ACC-024, ACC-027 |
| TST-ACC-38 | Given a source whose fee semantics are unverified / then the transaction is imported but not journalised until the owner confirms the split once (E-ACC-32); later transactions of that source/type post automatically | C | ACC-024, E-ACC-32, EC-145 |
| TST-ACC-39 | Given every role marked UNSURE (`vat.input.notyet`, `revenue.zero_pv`, `shareholder.clearing`) unmapped / then each posting needing it is blocked with the „noch kein Konto zugeordnet“ message; after mapping it posts; `confirmedByAdvisorOn` empty never blocks anything | U, C | ACC-007, ACC-008 |
| TST-TAX-26 | Given the guide data `elster-ustva-2026`, `elster-zm-2026`, `elster-euer-2026` / then golden snapshots of path, form year, field order, labels and copy strings for the golden dataset; every Kennzahl of §4.5 with a non-zero value appears exactly once in the guide | G | TAX-020, UVA-03 |
| TST-TAX-27 | Copy strings: base 1,234.56 € → „1234“; tax 234.46 € → „234,46“; −12.30 € → „-12,30“; zero field → „leer lassen“ (Kz 83 always shown) | U | TAX-004, TAX-020 |
| TST-TAX-28 | Record without Transferticket → blocked (E-UVA-01); with a `sheetHash` that no longer matches after a late posting → 409 `sheet_changed` (E-UVA-18) | C | TAX-021, E-UVA-01, E-UVA-18 |
| TST-TAX-29 | Kz 83 from ELSTER 1,000.00 € vs app 1,019.00 € / then blocked; with „abweichend übermittelt“ + reason → filing stored with `submittedValuesDiffer`, `elsterReportedTotalCents` = 100000 and the correction worklist shows Δ Kz 83 = 19.00 € | C | TAX-021, TAX-007, E-UVA-19 |
| TST-TAX-30 | Guide data or mapping for 2027 without `verifiedAgainstForm` / then values visible with banner, copy buttons and submission record blocked (E-UVA-20) | U, C | TAX-020, E-UVA-07, E-UVA-20 |
| TST-TAX-31 | ZM Q3 recorded via the guide (Σ cross-check equal) / then `zm_submitted` lock on Jul–Sep; ZM correction for one customer shows complete corrected values for that customer and period | C | TAX-009, TAX-021, ACC-016 |
| TST-TAX-32 | EÜR 2026 record before 2027-01-01 or with Q4 UStVA not submitted / then blocked (E-UVA-21); after both → `taxFilings.kind = euer`, `period = 2026`, all 12 months locked `euer_submitted`; a later bank posting with original date 2026-11-20 lands in the first open period and is listed under „Nach Abgabe der EÜR 2026 erfasst“ | C | TAX-022, ACC-006, ACC-016 |
| TST-TAX-33 | EÜR guide for a company with assets / then the AVEÜR tab values reconcile with the Anlagenspiegel 2026 (AST-012); without assets no AVEÜR step | U, G | TAX-022, AST-012 |
| TST-TAX-34 | Correction filing guide / then contains the step „Berichtigte Anmeldung: Ja (Kz 10 = 1)“ and complete values (not deltas) | U | TAX-007, TAX-020 |
| TST-TAX-35 | USt-Jahreserklärung worksheet 2026 / then year totals equal Σ latest submitted UStVA values plus listed differences; difference causes link to journal lines | U, G | TAX-023 |
| TST-TAX-36 | Deadline calendar 2026 without Steuerberater / then annual returns due 2027-07-31 (self-filer default), reminders 6 weeks and 1 week before; §108 Abs. 3 AO shift applied | U | TAX-019 |
| TST-TAX-37 | MCP `report_elster_guide` for 2026-09 / then read-only, returns the same steps as the REST guide; no MCP tool records submissions or transmits via ERiC (P4 tool list check) | C | TAX-020, TAX-024, ACC-012 |

## 9. Open questions (all with decided defaults; v1.1)

There is no Steuerberater (B5). Every item below is implemented with the stated **decided conservative default**, configurable/date-effective where the law may change, with a test for the current assumption and a `// LEGAL-OPEN: F08-Qn` comment. A one-off Steuerberater check before go-live is recommended for items 1–7 and 12–14 (non-blocking).

1. **⚠ accounts and BU keys** (USt nicht fällig, erhaltene Anzahlungen, §13b expense accounts, recovery account, other non-taxable income, BU keys 1/18/19/46/91/94, 4-character BU field, Generalumkehr column; 01-compliance open item 5). **Default:** ⚠ accounts used as listed in §4.1.1 with a ⚠ badge; UNSURE roles (`vat.input.notyet`, `revenue.zero_pv`, `shareholder.clearing`) ship unmapped and **block** the postings that need them until the owner maps them; BU keys as in §4.1.2, verified with a real DATEV test import only when the DATEV export (P3, low priority) is first used.
2. **Bank fees and foreign currency.** **Default:** all bank fees (separate fee transactions and fee fields) are VAT-exempt financial services (§4 Nr. 8 UStG), no input VAT, no §13b; input VAT/§13b only with an invoice showing it (E-ACC-28). The bank statement is the Beleg. Fee semantics per source (fee included in the amount?) are never guessed: verified by balance continuity per mapper, otherwise the owner confirms the split once (E-ACC-32). Foreign-currency accounts: moving-average EUR cost, realised FX on outflow; §256a revaluation is Bilanz-only and out of scope (AO-07).
3. **UStVA Vordruck 2026/2027** (Kz 50/37, 73/74, 78/79; base rounding; open item 6). **Default:** mapping `ustva-2026.2` as in §4.5; bases truncated to whole euros; tax amounts in cents; a new year's table and guide data are **blocked** until verified against the official form (E-UVA-20).
4. **Kz 50 vs. negative Kz 81** for write-offs/recoveries under Soll. **Default:** Kz 50 (negative for the write-off, positive for the recovery).
5. **Tax point for igL (§13 Abs. 1 Nr. 6) and EU services under Ist.** **Default:** as in §4.3 (igL: invoice date, at the latest end of the month after the supply; EU services: end of the month of supply also under Ist).
6. **E-vehicle special AfA schedule/window; JStG 2026** (GWG 1,200 €/Sammelposten; open item 4). **Default:** schedule as in AST-006 from the rule table; JStG-2026 rows ship **disabled** until enacted.
7. **Anlage-EÜR, AVEÜR and USt-Jahreserklärung line numbers** per year. **Default:** the tables ship unverified with the banner; instructions and the EÜR submission record are **blocked** until a data release verifies them against the official forms (must be done before the P3 sign-off). *Status 2026-10-23:* `ust-annual-2026.1` is verified against the Vordruck USt 2 A 2026 (BMF 29.12.2025, III C 3 - S 7344/00040/008/034); rows the app cannot split exactly (Kz 48 → Zeilen 51–54, Kz 50 → Zeile 84 „nachrichtlich“) are shown with „Bitte prüfen“ and never offered as copy strings; the KU turnover of Zeile 53 is not computed.
8. **DATEV export for EÜR + Ist clients** (F09 EXP-012). **Default:** full journal incl. invoices and payments (more complete records); export is P3, low priority, for a future Steuerberater.
9. **Data model additions needed in 03** (see the report to the lead): `journalEntries.lines[].taxPointDate/taxPeriod/currency/amountFx/fxRate`, `journalEntries.originalDate/latePosting/ruleVersion/explanation`, `source.kind` += `bankTransaction`, `cashTransfer`, `fx`, `period_close`; `periods.status` += `locking`; `periods.reason` += `zm_submitted`, `euer_submitted`; `taxFilings.kind` += `euer` (plus existing `zm_correction`, `sondervorauszahlung`); `taxFilings.submittedVia?: "mein_elster_manual" | "eric"`, `taxFilings.submittedOn`, `taxFilings.sheetHash`, `taxFilings.elsterReportedTotalCents?`, `taxFilings.submittedValuesDiffer?`, `taxFilings.valuesDifferReason?`; `transmissionTicket` required at submission; `plannedCashItems`; `allocations`; `bankAccounts` per account/currency pocket with `currency` and `avgCostRate`; role `cash` (no `cash.<book>`), role `shareholder.clearing`.
10. **Neugründer monthly filing from 2027** (open item 3). **Default:** the filing period is what the Finanzamt notified (entered by the owner); the suggestion follows the date-effective rule table (monthly in the founding year and the following year from 2027 ⚠).
11. **Cash expenses in P1** — *resolved (2026-10-12)*: production go-live (sevdesk off) is the **end of P2** (09); P1 is a pilot on the production stack with training data. Vouchers incl. „bar"/„privat bezahlt" (CSH-022/023, T6/T7) are therefore available from the first real day; no P1 workaround is needed.
12. **Mein ELSTER navigation labels and form names** change between releases. **Default:** stored as guide data per form and year with `verifiedAgainstForm`; unverified data block the instructions (E-UVA-20); each data release re-verifies.
13. **ZM filing channel.** **Default:** manual entry in Mein ELSTER („Zusammenfassende Meldung“); CSV upload in the BZSt-Online-Portal as an alternative (CSV layout ⚠).
14. **Corporation private postings** (`shareholder.clearing` number range; vGA/loan consequences). **Default:** `private.*` blocked for corporations; postings go to an owner-created „Verrechnungskonto Gesellschafter“ per shareholder (blocked while unmapped).
15. **Transferticket.** **Default:** mandatory for every submission record (E-UVA-01).
16. **Deadline for annual returns without an advisor.** **Default:** 31 July of the following year (§149 Abs. 2 AO) from the date-effective table; transitional extensions only via rule data.

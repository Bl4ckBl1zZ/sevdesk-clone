# F05 — Receivables, Payments and Dunning (Offene Posten, Zahlungen, Mahnwesen)
> **Status:** v1.1 · 2026-10-12 (owner decisions B1/B2/B3/B5/B7 applied: reminders are exported and marked sent manually — no auto-send, no pre-due e-mail; Zugang, Verzug, interest, fees and escalation are driven by the manual sent mark; cash payments „Bar bezahlt“ in P1 without a cash book (F07 CSH-020…030); bank-sourced payments and reconciliation in P1 via statement import + matching, Enable Banking feed P2; bank reversals as confirmed counter-entries; Steuerberater confirmations replaced by decided defaults; portal/online payments deferred) · **Phases:** P1 (manual, cash and statement-import-sourced payments, reconciliation of manual payments, OPOS, difference reasons, reversals, dunning incl. automation that creates/finalises but never sends, export + manual sent mark, Inkasso export), P2 (payments from the Enable Banking feed, feed-freshness safety skip), P3 (Mahnbescheid data sheet, payment-behaviour stats, payment confirmation letter), deferred (payment-provider/online payments with F10) · **sevdesk parity:** research 00 §4.9, §7, §11.4; research 07 §3 (Differenzgründe); research 08 §2 (Zahlungseingang buchen); research 09 §1 (Mahnwesen); research 02 #3, #33 · **Compliance:** UST-32, UST-40, UST-30, UVA-06, MAHN-01, MAHN-02, MAHN-03, MAHN-04, MAHN-05, MAHN-06, GOBD-02, GOBD-05, GOBD-06, GOBD-07, GOBD-20, MAIL-02, MAIL-03, AO-04, AO-05, MISC-08, SEC-02

Related: [01-compliance](../01-compliance.md) · [03-data-model §4–5](../03-data-model.md) · [04-ui-ux §4.2, §4.7](../04-ui-ux.md) · [05-api §4.4](../05-api.md) · [06-mcp §3.5](../06-mcp.md) · F04 (sales documents, finalisation pipeline, EPC-QR) · F07 (statement import BNK-030…036, matching BNK-040…049, Enable Banking feed BNK-100…117, bank reversals BNK-121, cash CSH-020…030) · F08 (journal posting, account mapping, period lock).

---

## 1. Scope (in / out, and what we do better than sevdesk)

### In scope
- **Open items (OPOS)**: global and per customer, with aging buckets and an as-of date (Stichtag) view, a customer account statement (Kontoauszug), credit balances.
- **Recording payments** on invoice-like sales documents (`invoice`, `advance_invoice`, `partial_invoice`, `final_invoice`) and on `correction` documents (refunds): full, partial, combined (Sammelzahlung), from a booked bank transaction (P1 via statement import, P2 also via the Enable Banking feed; F07), an account without a transaction (P1 manual), cash („Bar bezahlt“, P1, F07 CSH-021, no cash book) or a payment provider (deferred with F10).
- **Difference reasons** (Differenzgründe): Skonto with a VAT correction (UST-32), bank fees, dunning fees, default interest, write-off / Forderungsausfall with a §17 UStG VAT correction, other. Overpayments, credit balances (Guthaben), applying credit, refunds.
- **Reversal** of payments (never edit), including reversal of write-offs on recovery.
- **Payment-status derivation** and `openAmountCents` maintenance.
- **Due date and default (Verzug) date computation** (MAHN-01), receipt (Zugang) derived from the document's manual sent mark (contract B2).
- **Dunning**: policies with unlimited levels, a „Bald fällig“ list (no document, nothing sent), fees, the §288 BGB interest calculator with a Basiszinssatz table (MAHN-02), the 40 € flat fee once per claim (MAHN-03), B2C/B2B rules, pause rules, a daily automated run with preview that creates drafts or finalises reminders but **never sends**, dunning documents as sales documents of type `reminder` with their own number range and immutability (MAHN-05) that the owner exports and marks sent like every document (F04 §3.5), escalation timed from the previous reminder's recorded Zugang, limitation warnings.
- **Collections hand-off**: Inkasso CSV + ZIP export, Mahnbescheid data sheet.
- **Letter text templates** for each dunning level and the „gegenstandslos“ notice; no e-mail templates (B2) — only the optional F04 „E-Mail-Text kopieren“ helper.

### Out of scope
- Bank statement import, the bank feed, matching scores and the cash-account rules (F07 BNK-030…049, BNK-100…117, CSH-020…030). F05 defines what a payment *does*; F07 defines where bank and cash data come from.
- Journal posting rules in detail and Soll/Ist reporting (F08, P3). F05 specifies which postings each payment event triggers (account roles), not the report logic.
- EPC-QR on invoices (F04, MISC-01). Payment links and online payment (deferred with F10).
- SEPA direct-debit collection (pain.008) (P4, MISC-02). A Rücklastschrift or any other bank reversal arrives as a separate booked counter-entry (statement import P1, feed P2); the owner confirms it as reversal (F07 BNK-121), which runs the F05 reversal of the original payment, plus a bank-fee voucher if fees were charged (see EC-PAY-24).
- Sending anything to customers (B2): the app never e-mails invoices, reminders, notices or confirmations; the owner exports and sends them and records the dispatch („Als versendet markieren“, F04 §3.5).
- Court proceedings and electronic Mahnantrag submission (we only produce the data).
- Payments on purchase vouchers: the same `payments` mechanics apply (PAY-010…PAY-045 are written target-agnostic), but voucher-specific UI and statuses live in F06.

### Better than sevdesk
| sevdesk (research 00 §7, 09 §1) | We |
|---|---|
| Dunning is manual ("Nächste Mahnung erstellen"); no scheduled run | Daily automated run with preview that prepares reminders (draft or finalised) with a to-do „Mahnung exportieren und als versendet markieren“, escalation timed from the recorded Zugang, and safety skips (unprocessed bank data, unconfirmed matches, disputes, unmarked documents) |
| No reminder fees via API, no interest calculation, no 40 € flat fee | Configurable fees, exact §288 interest with Basiszinssatz history and split segments, 40 € once per claim (B2B only), legal prerequisites checked (default must exist) |
| Mahnung and invoice share status loosely | Each reminder is a numbered, immutable GoBD document (letters6 retention) linked in a dunning case with its own history |
| Differenzgründe without visible booking | Booking preview for every payment; VAT correction per rate computed and stored (UST-32) |
| No credit balances, refunds are workarounds | First-class credit balances (Guthaben), refunds, payment re-allocation wizard after Storno |
| No limitation tracking | Limitation date per claim, warnings from 1 Oct of the limitation year, Mahnbescheid data sheet |
| No collections hand-off | Inkasso CSV + document ZIP; case marked "übergeben" stops automation |

---

## 2. User stories

| # | As the owner I want to… | so that… |
|---|---|---|
| US-01 | see all open and overdue invoices with totals and aging buckets | I know my outstanding money at a glance |
| US-02 | open a customer and see their open items, payments, credit balance and an account statement | I can answer "what do I still owe/what do you owe" calls |
| US-03 | record a payment on an invoice in two clicks, including partial payments | the invoice status is right without bookkeeping knowledge |
| US-04 | split one transfer across several invoices of a customer | combined payments (Sammelzahlung) are booked correctly |
| US-05 | accept a Skonto deduction and have the VAT corrected automatically | my UStVA is correct without manual journal entries |
| US-06 | write off an uncollectible claim (insolvency) with the VAT correction | I don't pay VAT on money I never receive |
| US-07 | keep an overpayment as a credit balance and later refund or apply it | customer money is tracked |
| US-08 | undo a wrongly recorded payment without deleting anything | the audit trail stays complete |
| US-09 | have reminders and Mahnungen prepared automatically on a schedule (draft or finalised) with a to-do to export and send them myself | I never forget to chase money and nothing leaves the house without me |
| US-10 | preview tomorrow's dunning run before anything is created or finalised | automation never embarrasses me |
| US-11 | have interest and the 40 € flat fee calculated correctly and only when legally allowed | my claims are enforceable |
| US-12 | pause dunning for a customer who disputes an invoice or paid partially | I don't annoy customers wrongly |
| US-13 | be warned before a claim becomes time-barred and hand it to collections with all documents | I don't lose money to Verjährung |
| US-14 (Claude) | ask "Welche Rechnungen sind überfällig?" and "Buche 500 € von Müller auf RE-1042" | I can manage receivables by voice/chat with confirmation |
| US-15 (website) | receive `invoice.paid` webhooks | my website can unlock services when paid |
| US-16 | record that a customer paid an invoice in cash and optionally print a Quittung | cash receipts are booked promptly without a cash book |

---

## 3. Functional requirements

### 3.1 Open items and aging

| ID | Requirement | Priority | Phase | Compliance refs |
|---|---|---|---|---|
| PAY-001 | **Global OPOS list** at `/auswertungen/offene-posten` and in `/rechnungen?status=open`: every invoice-like document and correction with `openAmountCents ≠ 0`, plus credit balances per contact. Columns: Nr., Kunde, Rechnungsdatum, Fällig, Tage überfällig, Betrag, Bezahlt, Offen, Mahnstufe, Status. Totals row (offen gesamt, davon überfällig). Filters: contact, overdue only, aging bucket, amount range, tag, dunning level, disputed | MUST | P1 | GOBD-01 |
| PAY-002 | **Aging buckets** by days past `dueDate` on the as-of date: `nicht fällig`, `1–30`, `31–60`, `61–90`, `> 90` (bucket edges configurable in Einstellungen › Mahnwesen). Shown as a stacked bar and table, globally and per contact | MUST | P1 | — |
| PAY-003 | **As-of date (Stichtag)**: the OPOS list and aging can be computed for any past date using only documents with `documentDate ≤ asOf`, payments with `date ≤ asOf` and not reversed by a reversal dated `≤ asOf` | MUST | P1 | GOBD-01 |
| PAY-004 | **Per-customer view** (Kontakt › Tab "Offene Posten"): open items, payment history, credit balance, dunning cases, average days to pay | MUST | P1 | — |
| PAY-005 | **Customer account statement** (Kontoauszug / Saldenbestätigung) as PDF for a period: opening balance, chronological invoices, corrections, payments, differences, credits, closing balance. Uses the Geschäftsbrief footer | SHOULD | P1 | MAIL-03 |
| PAY-006 | OPOS export as CSV (`;`, decimal comma, UTF-8 with BOM) and PDF, as of a date | SHOULD | P1 | GOBD-11 |
| PAY-007 | Dashboard widget "Offene Forderungen" (04 §4.7): total open, overdue, due within 7 days, credit balances | MUST | P1 | — |
| PAY-008 | Payment behaviour per customer: average days to pay (payment date − document date, weighted by amount), share of late payments, last 12 months; used by F08 cash-flow forecast | COULD | P3 | — |

### 3.2 Recording payments

| ID | Requirement | Priority | Phase | Compliance refs |
|---|---|---|---|---|
| PAY-010 | **Record a payment** ("Zahlung buchen") from the invoice detail, the OPOS list (bulk "Als bezahlt markieren"), the command palette, REST and MCP. Inputs: date, amount, source, optional difference. Default amount = open amount; default date = today (bank source: the transaction's booking date, fixed; cash: dating rules of PAY-061) | MUST | P1 | GOBD-03 |
| PAY-011 | **Sources**: (a) `bank` — a booked bank transaction from the statement import (P1, F07 BNK-030…036) or the Enable Banking feed (P2, F07 BNK-100 ff.); (b) `clearing` — a bank or clearing account **without** a transaction (P1 manual entry, e.g. before the statement is imported; reconciled later per PAY-047); (c) `cash` — „Bar bezahlt“ (P1, PAY-061, F07 CSH-021): posts against the single `cash` account, no cash-book entry; (d) `private` — purchase voucher paid privately (F07 CSH-023, F06), never allowed on sales documents (EC-PAY-49); (e) `provider` (deferred with F10) | MUST | P1 | AO-04, AO-05 |
| PAY-012 | **Partial payment**: amount < open amount without a difference reason leaves the remainder open; status becomes `partially_paid` | MUST | P1 | UVA-06 |
| PAY-013 | **Combined payment (Sammelzahlung)**: one source (bank transaction, cash amount or clearing amount) is allocated to several targets in one transaction. The dialog proposes an allocation (documents whose numbers appear in the purpose first, then oldest due date first) and allows manual amounts per target. Σ allocations ≤ source amount; any remainder follows PAY-030 | MUST | P1 | GOBD-02 |
| PAY-014 | **Payment before invoice date** (Vorkasse) is allowed with a warning (EC-PAY-07). Payments on **draft** documents are rejected | MUST | P1 | UST-06 |
| PAY-015 | **Booking preview** in the dialog: the journal lines (account roles resolved to SKR numbers, debit/credit, tax key) that the payment will create, recomputed live | SHOULD | P1 | GOBD-01 |
| PAY-016 | Every payment creates its journal entries **in the same Convex transaction** as the payment row, the target's `openAmountCents`/`paymentStatus` update, the dunning-case update, the audit entry and the webhook outbox event | MUST | P1 | GOBD-05, GOBD-06 |
| PAY-017 | **Advance invoices** (UST-40): payments on `advance_invoice` are recorded like any payment; the journal posting marks the output VAT as due on receipt (Mindest-Ist), also for Soll-taxing companies (posting rule in F08). The final invoice's payable amount = gross − advances deducted (F04/UST-41) and its open amount derives from that | MUST | P1 | UST-40, UST-41 |
| PAY-018 | **Foreign-currency invoices** (MISC-08): a payment records `amountCents` in the document currency **and** the EUR amount actually received (`eurAmountCents`). The difference between the EUR value at invoice (snapshot `fxRateToEur`) and the EUR received is posted as a realised exchange difference (roles `fxGain`/`fxLoss`), never as Skonto | SHOULD | P1 | MISC-08 |
| PAY-019 | **Idempotency**: REST POSTs honour `Idempotency-Key`; MCP `payment_record` requires a `confirm_token` (06-mcp §2) | MUST | P1 | SEC-02 |

### 3.3 Difference reasons

| ID | Requirement | Priority | Phase | Compliance refs |
|---|---|---|---|---|
| PAY-020 | **Difference model**: a payment allocation may carry **one or more** differences (`differences[]`, see data-model delta D-01), each with `reason`, `amountCents` (positive = settles more than the cash, i.e. underpayment accepted; negative = cash exceeds the claim) and, where applicable, `vatCorrection[]` per rate. Invariant per allocation: `amountCents + Σ differences.amountCents` = the reduction of the target's open amount. RI-09 ("allocations ≤ payable") is evaluated on this net settlement value; cash above the claim that is not fees/interest is never allocated to the document but becomes a credit balance (EC-120) | MUST | P1 | UST-32, GOBD-03 |
| PAY-021 | **Skonto** (`skonto`): offered automatically when payment date ≤ `documentDate + paymentTerms.skontoDays` and the shortfall ≤ the agreed Skonto amount + 1 cent tolerance. The Skonto amount is split across the invoice's VAT groups **pro rata to their gross share** (largest-remainder to the cent); per group `vat = round_half_up(gross × rate / (10000 + rate))`, `net = gross − vat`. The VAT correction is stored on the payment and posted to the Skonto accounts per rate with the output-VAT reduction in the **payment period**. No new document and no new invoice number are created | MUST | P1 | UST-32, UST-09 |
| PAY-022 | Skonto **outside** the period or **above** the agreed rate is **never booked as Skonto** (10-edge-cases EC-122). The shortfall is either left open (partial payment, default) or — after an explicit choice with reason — booked as `other` "Kulanz-Preisminderung" (with VAT correction, PAY-027); warning EC-PAY-09 | MUST | P1 | UST-32 |
| PAY-023 | **Bank fees** (`bank_fees`): shortfall caused by fees charged to us (e.g. SHA/OUR transfers). Posted to `bankFees` at 0 % VAT, no VAT correction. Maximum 25.00 € per allocation without a warning (EC-PAY-10) | MUST | P1 | — |
| PAY-024 | **Dunning fees and default interest received** (`dunning_fees`, `default_interest` — delta D-02): the overpayment up to the amounts claimed in the latest finalised reminder is offered as fees/interest. Posted to `dunningFeeIncome` / `interestIncome`, not taxable (damages), no VAT. 40 € flat fee received is posted as `dunningFeeIncome` | MUST | P1 | MAHN-02, MAHN-03 |
| PAY-025 | **Write-off / Forderungsausfall** (`write_off`) with sub-reason `insolvency` \| `uncollectible` \| `statute_barred` \| `waiver`. Allowed on the full remainder or a part (e.g. insolvency quota received). VAT correction per rate pro rata to the remaining gross per group. Posting depends on the taxation method valid on the write-off date (UVA-06): **Soll** → bad-debt account per rate + output-VAT reduction in the write-off period (§17 Abs. 2 Nr. 1 UStG); **Ist** → only the receivable is cleared (no VAT was recognised), the VAT correction is stored as information. A write-off can be recorded without cash (`source.kind = "adjustment"`, delta D-03) | MUST | P1 | UST-32, UVA-06 |
| PAY-026 | **Recovery after write-off**: a later payment on a `written_off` document runs the wizard "Zahlungseingang auf abgeschriebene Forderung": (1) reverse the write-off, dated today (VAT re-raised in the current period, §17 Abs. 2 Nr. 1 S. 2 UStG); (2) record the payment; (3) optionally write off the remaining amount again, dated today | MUST | P1 | UST-32, GOBD-06 |
| PAY-027 | **Other** (`other`): requires a free-text reason (≥ 5 characters), a ledger account and the choice "Preisminderung (mit USt-Korrektur)" or "ohne USt-Korrektur". A price reduction behaves like Skonto for VAT purposes (pro rata) | MUST | P1 | UST-32 |
| PAY-028 | The data-model reasons `partial` and `collective` are **not** user-selectable differences: a partial payment is the absence of a difference (PAY-012) and a combined payment is several allocations from one source (PAY-013). They remain readable for imported sevdesk data only (import maps sevdesk `N` → no difference, "Teil einer Sammelbuchung" → allocation group) | MUST | P1 | — |

### 3.4 Overpayment, credit balances, refunds

| ID | Requirement | Priority | Phase | Compliance refs |
|---|---|---|---|---|
| PAY-030 | **Overpayment**: if cash allocated to a target exceeds its open amount (+ claimed fees/interest), the excess must be resolved in the same dialog by exactly one of: (a) allocate to further open items of the same contact (becomes PAY-013), (b) book as dunning fees/interest (PAY-024, up to the claimed amount), (c) **credit balance** (Guthaben) for the contact, (d) leave the excess unallocated on the bank transaction (status `partially_matched`, only for bank sources). Silent overpayment of a single document is impossible (EC-PAY-01) | MUST | P1 | GOBD-02, GOBD-03 |
| PAY-031 | **Credit balance** = a payment with target `{ kind: "contactCredit", id: contactId }` (delta D-04). Posted to the contact's debtor account (credit side, role `customerCredit`). The contact header and OPOS show "Guthaben 45,00 €" | MUST | P1 | GOBD-02 |
| PAY-032 | **Apply credit** to an open invoice of the same contact: creates a pair in one transaction — a negative allocation on the credit target and a positive allocation on the invoice, both with `source.kind = "credit"` (delta D-03). Credit cannot go negative | MUST | P1 | GOBD-03 |
| PAY-033 | **Refunds**: an outgoing payment (bank transaction with negative amount, cash refund „Bar erstattet“ (PAY-062), or clearing) allocated to (a) a credit balance (reduces it) or (b) a `correction` document with a negative total (Rechnungskorrektur → we owe money). The correction's open amount is negative until refunded; status shows "Erstattung offen" | MUST | P1 | UST-30 |
| PAY-034 | **Payments and Storno**: a cancelled invoice cannot receive new payments (EC-121). **Storno of an invoice with non-reversed payments is blocked** (10-edge-cases EC-074): if the payments were allocated by mistake, the user reverses them first (PAY-040); if the invoice was really paid, the correct path is a Rechnungskorrektur (F04) plus refund or credit balance (PAY-031/033). The block message links to both paths | MUST | P1 | UST-30, GOBD-06 |

### 3.5 Reversal and status

| ID | Requirement | Priority | Phase | Compliance refs |
|---|---|---|---|---|
| PAY-040 | **Payments are never edited or deleted.** "Zahlung stornieren" creates a reversal payment (same target and source, `amountCents` and all differences negated, `reversalOfId` set — delta D-05), sets `reversedById` on the original, and posts reversal journal entries (Generalumkehr). Reason mandatory (≥ 5 characters) | MUST | P1 | GOBD-06 |
| PAY-041 | **Reversal date**: the original payment date if its period is open; otherwise **today**, with the original date kept as reference (`reversalOfId`). The dialog shows which date will be used and why | MUST | P1 | GOBD-06 |
| PAY-042 | Reversing a bank-sourced payment releases the allocation on the bank transaction (`allocatedCents` −, status recomputed). Reversing a cash payment posts the Generalumkehr against `cash` (F07 CSH-027) and is subject to the never-negative check (PAY-062, CSH-026, EC-PAY-28) | MUST | P1 | AO-05, GOBD-06 |
| PAY-043 | **Payment status derivation** (`derivePaymentStatus` in `src/domain/documents/payment-status.ts`, pure, called in every payment mutation): see §4.3. Stored values are `open \| partially_paid \| paid \| credited \| written_off` (03 §4); **`overdue` is never stored** — it is derived at read time (`dueDate < today`, Europe/Berlin) by `displayStatus()` (F04 §4.2.9, 02 §6). `openAmountCents` = `payableCents − Σ(non-reversed allocations incl. differences)` | MUST | P1 | GOBD-03 |
| PAY-044 | **Overdue notification**: a daily job `receivables.refreshOverdue` (00:15 Europe/Berlin; delta D-12) finds open/partially paid documents whose `dueDate < today` (derived overdue) and emits `invoice.overdue` once per document and records `salesDocuments.overdueNotifiedAt`. It **does not write `paymentStatus`**; lists, filters (`display_status=overdue`) and the API compute overdue at read time | MUST | P1 | — |
| PAY-045 | **Period lock**: no payment, difference or reversal may be dated in a locked period (`periods.status = "locked"`); the API returns 409 `period_locked`. A payment row whose period gets locked receives `lockedAt` | MUST | P1 | GOBD-06 |
| PAY-046 | **Withdrawn (v1.1)** — B3: cash payments no longer need a cash book and are available in P1. Replaced by PAY-061, PAY-062, PAY-063. | — | — | AO-04, AO-05 |
| PAY-047 | **Reconciliation of manual payments**: when a booked bank transaction is later imported (statement import P1, Enable Banking feed P2) that corresponds to a `clearing`-sourced payment on a bank account, F07 proposes "Bereits erfasste Zahlung" instead of a new allocation (BNK-041). Confirming sets `reconciledTransactionId` on the payment once (whitelisted field, delta D-06) and allocates the transaction; if dates differ by > 3 days, the user must choose "Datum beibehalten" or "stornieren und mit Bankdatum neu buchen" | MUST | P1 | GOBD-02 |
| PAY-048 | Optional payment confirmation („Zahlungseingang bestätigt“) as a PDF letter from a text template, exported and marked sent like any document (B2: never e-mailed by the app); for cash payments see the Quittung (PAY-063) | COULD | P3 | MAIL-03 |
| PAY-061 | **Cash payment „Bar bezahlt“** (P1, F07 CSH-021) in the "Zahlung buchen" dialog (payment account „Kasse“), REST and MCP: source `{ kind: "cash" }`; date ≤ today (EC-PAY-06); warning ⚑ if more than 1 day in the past (daily recording duty for cash receipts, §146 Abs. 1 S. 2 AO, EC-PAY-46); a reason (≥ 5 characters, stored in `backdateReason`, audited) is mandatory if more than 10 days in the past (EC-PAY-47); never in a locked period (PAY-045, EC-PAY-08); optional `note`. Excess over the open amount follows PAY-030 (typically credit balance); option (d) "unallocated" does not exist for cash (EC-PAY-50). Posts `cash` S / `receivable` H in the same transaction (PAY-016). No cash book, no register, no daily close; cash only on issued documents (AO-04, EC-PAY-43) | MUST | P1 | AO-04, AO-05, GOBD-03 |
| PAY-062 | **Cash outflows on receivables** — a refund paid in cash („Bar erstattet“, PAY-033) and the reversal of a cash payment (PAY-042): same dating rules as PAY-061; the `cash` account balance in (date, seq) order must stay ≥ 0 at every date incl. backdated entries, checked inside the serialisable mutation (F07 CSH-026, RI-11, EC-149, EC-151); otherwise rejected (EC-PAY-28, EC-PAY-48) | MUST | P1 | AO-05, GOBD-06 |
| PAY-063 | **Quittung** (optional, F07 CSH-028): "Quittung drucken" on a cash payment row generates a receipt PDF (payer, invoice number, amount, payment date, our Geschäftsbrief data); archived with sha256 on first generation (`payments.receiptFile`, set once); every reprint is marked „Kopie“ (EC-PAY-51); handed over by the owner (B2) | SHOULD | P1 | GOBD-20, MAIL-03 |

### 3.6 Due date and default (Verzug)

| ID | Requirement | Priority | Phase | Compliance refs |
|---|---|---|---|---|
| PAY-050 | **Due date** = `documentDate + paymentTerms.dueDays` (calendar days); `dueDays = 0` → due on the document date ("sofort fällig"). Computed at finalisation and frozen | MUST | P1 | MAHN-01 |
| PAY-051 | **§193 BGB shift**: if the computed due date falls on a Saturday, Sunday or a public holiday (national + the company's Bundesland, from `src/domain/rules/holidays`), the printed and stored due date moves to the next business day | SHOULD | P1 | MAHN-01 |
| PAY-052 | **Receipt (Zugang)** per document (invoice and reminder), derived from its **first** non-retracted sent mark in `sendLog` (F04 §3.5, contract B2) and stored as `salesDocuments.zugang { date, basis }`: `email_manual`, `upload_portal`, `hand` → `sentOn`; `post` → `sentOn` + N days (setting „Zugangsfiktion Post“, default 3); `other` → `sentOn` + 3 days (conservative, fixed; EC-DUE-08). Repeated marks never change it. Manual override (`basis: "manual"`): the owner may record a known actual receipt date (e.g. Rückschein, customer confirmation) with a reason (audited); date ≥ `sentOn` and ≤ today (EC-DUE-09); only while no later reminder depends on the document. Never derived from finalisation, export or any automatic timestamp; no mark → no Zugang (PAY-064) | MUST | P1 | MAHN-01, MAIL-02 |
| PAY-053 | **Default start** (`defaultStartDate`, first interest day) = earliest applicable of: (a) contact flag "Zahlungstermin kalendermäßig vereinbart" → `dueDate + 1` (§286 Abs. 2 Nr. 1; needs no Zugang); (b) the first reminder after the due date that has a Zugang (PAY-052) → Zugang + 1 day (§286 Abs. 1); a finalised but unmarked reminder never starts default; (c) `max(dueDate, Zugang invoice) + 31 days` (§286 Abs. 3) — only if the invoice has a Zugang (PAY-064) and, for **B2C**, only if the invoice snapshot contains the §286 Abs. 3 note (MAHN-01). Route (b) follows the setting `defaultStartViaReminder`: `after_printed_deadline` (**default**, legally safest per B5: day after the reminder's printed deadline, at the earliest Zugang + 1) \| `zugang_plus_1` (alternative: Zugang + 1 day) — ⚖ `// LEGAL-OPEN: Q-01`. Stored on the dunning case and shown with its legal route ("Verzug seit 16.07.2026 – 30-Tage-Regel"); recomputed whenever a mark, retraction or Zugang override changes an input | MUST | P1 | MAHN-01, MAHN-02 |
| PAY-054 | **MAHN-04 warnings** when payment terms > 60 days (B2B) or > 30 days (public customer) are entered on a contact or in a policy (the invoice editor check is F04) | SHOULD | P1 | MAHN-04, MAHN-06 |
| PAY-064 | **No sent mark → no Zugang** (EC-196): an invoice that was finalised (and possibly exported) but never marked sent has no Zugang: neither the §286 Abs. 3 route (PAY-053 c) nor the reminder route starts, the daily run skips it (`not_marked_sent`) and no reminder can be finalised for it (manual drafts allowed, EC-DUN-31). The to-do „Exportiert, aber nicht als versendet markiert“ appears 2 days after the first export (F04 §3.5); the dunning cockpit lists such invoices. Once marked, Zugang is computed from the mark and evaluation resumes. A retracted invoice mark (F04) removes the Zugang and unsets a `defaultStartDate` that depended on it (EC-DUE-10); retraction is blocked while a reminder references the invoice | MUST | P1 | MAHN-01, MAIL-02 |

### 3.7 Dunning policies and documents

| ID | Requirement | Priority | Phase | Compliance refs |
|---|---|---|---|---|
| DUN-001 | **Policies** (Einstellungen › Mahnwesen): name, `appliesTo` (B2C/B2B), any number of steps (`level`, `daysAfter` — level 1: days after the due date, later levels: days after the previous reminder's Zugang (DUN-054) —, `title`, `feeCents`, `addInterest`, `addFlatFee40`, `newDueDays`, `textTemplateId`, `autoFinalize`), `dueSoonDays` (DUN-053), `minOpenAmountCents` (default 5,00 €), `pauseOnPartialPaymentDays` (default 14), `stopAfterLastLevel`. No e-mail template and no send switch (B2). Seeded defaults: "Standard B2B" and "Standard B2C" (§4.6) | MUST | P1 | MAHN-06 |
| DUN-002 | **Policy resolution** per invoice: invoice override → contact setting (`contacts.dunning.policyId`, delta D-07) → default policy for B2C/B2B (by `contact.isConsumer`). Contact flag "Nicht mahnen" (with reason) and invoice flag "Nicht mahnen" exclude from automation and manual creation shows a warning | MUST | P1 | — |
| DUN-003 | **Withdrawn (v1.1)** — B2: no pre-due e-mail (the app sends nothing to customers). Replaced by DUN-053. | — | — | MAIL-02 |
| DUN-004 | **Reminder document**: sales document `type = "reminder"`, created as a draft with `reminder = { invoiceId, level, feeCents, interestCents, newDueDate }`, finalised through the F04 pipeline (number from a `reminder` number range, default format `MA-{YYYY}-{####}` (F01), PDF/A, `snapshotHash`, `artifactStatus`), **no E-Rechnung XML**. Immutable from finalisation (stricter than MAHN-05 "once sent"). Exported and marked sent by the owner with the same mechanism as invoices (F04 §3.5, DUN-058); automation never sends. `retentionClass = "letters6"` | MUST | P1 | MAHN-05, GOBD-06, GOBD-20, UST-06 |
| DUN-005 | **Reminder content**: Geschäftsbrief footer (MAIL-03), customer address snapshot, level title, reference to invoice number/date/original amount, payments received, open principal, fees, interest with a calculation table (Zeitraum, Tage, Zinssatz, Betrag), 40 € Pauschale line (if applicable), total claim, new deadline, bank details, optional EPC-QR (F04 builder) with the total claim, text templates per level | MUST | P1 | MAIL-03, MAHN-02 |
| DUN-006 | **No journal entries** at reminder finalisation (claims for fees/interest are uncertain). Fees, interest and the 40 € are recognised only when received (PAY-024) | MUST | P1 | GOBD-07 |
| DUN-007 | **Next level** from an invoice or the latest reminder ("Nächste Mahnstufe"); level = case.currentLevel + 1; unlimited levels (policy steps beyond the last are allowed manually with a warning) | MUST | P1 | — |
| DUN-008 | **Manual reminder** (`reminder_create`, `POST /invoices/{id}/reminders`): any time for an invoice with open amount > 0 and status not cancelled; prefilled from the policy step; texts, fee and new deadline editable; computed interest may be lowered but raising it above the computed value requires a reason (audit) | MUST | P1 | MAHN-02 |
| DUN-009 | **Reminder withdrawal** ("Mahnung gegenstandslos"): sets the reminder status `cancelled` with a reason; the archived document is kept; the dunning case level is not decremented. If the reminder had been marked sent, an optional „gegenstandslos“ notice (letter PDF from the template in §4.9, archived with sha256 as an artifact of the reminder) is generated and **exported and marked sent like any document** (`sendLog.purpose = "reminder_void_notice"`, same channels and rules as DUN-058); a reminder that was never marked sent needs no notice (its open to-do is closed). Withdrawing the reminder that first claimed the 40 € before it was ever marked sent resets `flatFeeCharged` (DUN-024) | SHOULD | P1 | GOBD-06, MAIL-02 |
| DUN-010 | **Chain view**: the invoice detail tab "Mahnungen" lists the case, all reminders with level/date/total/dispatch status (exportiert · versendet am … per … · Zugang …), and the next planned action incl. its earliest date (DUN-054) | MUST | P1 | GOBD-01 |
| DUN-053 | **„Bald fällig“** (replaces the pre-due e-mail): the cockpit tab and the dashboard widget list open invoices whose due date is within `dueSoonDays` (policy, default 3); optionally (policy toggle `dueSoonTodo`, default off) the job `receivables.refreshOverdue` creates one to-do per invoice „Bald fällig: {Nr.} am {Datum} – ggf. Kunden erinnern“. No document, no number, no `sendLog` row, nothing sent; no dunning case is created | SHOULD | P1 | — |

### 3.8 Interest, fees, flat fee

| ID | Requirement | Priority | Phase | Compliance refs |
|---|---|---|---|---|
| DUN-020 | **§288 interest calculator** (`src/domain/dunning/interest.ts`, pure): input `{ principalSegments, from, to, margin: "b2c" \| "b2b" \| customBp, table }`; days counted **inclusive of both ends**, actual/365 (also in leap years; open question Q-03), rate = Basiszinssatz + 500 bp (B2C) / + 900 bp (B2B); segments split at every Basiszinssatz change **and** every principal change (partial payment dated D reduces the principal from D on); exact rational sum over segments, **rounded once** half-up to cents; no compound interest (fees and earlier interest are never part of the base) | MUST | P1 | MAHN-02 |
| DUN-021 | **Basiszinssatz table** (`src/domain/rules/basiszinssatz.ts`, versioned rows `validFrom`/`validTo`/`rateBp`, may be negative) with owner additions via `ruleOverrides`; `rules.freshness` warns from 2 Jan / 2 Jul if no row for the current half-year exists. Shipped rows in §4.7 | MUST | P1 | MAHN-02 |
| DUN-022 | **Standalone calculator** "Verzugszinsrechner" in `/mahnungen` (amount, from, to, B2C/B2B/custom, optional partial payments) showing segments; printable | SHOULD | P1 | MAHN-02 |
| DUN-023 | **Interest on reminders**: if `step.addInterest` and the debtor is in default on the reminder date, interest is computed from `defaultStartDate` to the reminder's document date on the open principal history, printed with segments, stored in `reminder.interestCents` | MUST | P1 | MAHN-02 |
| DUN-024 | **40 € flat fee** (`addFlatFee40`): only if the contact is not a consumer, the debtor is in default, and `dunningCases.flatFeeCharged = false`; set to `true` at finalisation of the reminder that first includes it (reset, audited, only if that reminder is withdrawn before it was ever marked sent, DUN-009). Never offered for B2C (UI hides, API rejects). Later reminders show it as "bereits geltend gemacht" in the claim total but never add it again | MUST | P1 | MAHN-03 |
| DUN-025 | **Dunning fees**: per step `feeCents`. B2C: warning above 5,00 € per reminder ("nur tatsächliche Kosten"); B2B with the 40 € flat fee already claimed: warning that own dunning costs are offset against it (§288 Abs. 5 S. 3 BGB) | MUST | P1 | MAHN-03, MAHN-05 |
| DUN-026 | **Default prerequisite**: fees, interest and the 40 € are only added when `defaultStartDate ≤ reminder date`. Otherwise automation sets them to 0 and the manual editor shows warning EC-DUN-05 | MUST | P1 | MAHN-01, MAHN-02 |
| DUN-027 | Optional allocation order §367 BGB (costs → interest → principal) for partial payments on dunned invoices; default is principal first (setting) | COULD | P3 | — |
| DUN-028 | "Zinsforderung stellen": after a late full payment of the principal, create a reminder-type letter claiming only accrued interest/fees | COULD | P3 | MAHN-02 |

### 3.9 Automation

| ID | Requirement | Priority | Phase | Compliance refs |
|---|---|---|---|---|
| DUN-030 | **Daily run** `dunning.run` (07:00 Europe/Berlin, 02 §7) evaluates all eligible invoices (§4.5) and performs per invoice at most **one** action: create a reminder draft, finalise a reminder (DUN-057), or log the to-do `todo_mark_sent` for a reminder still unmarked 2 days after finalisation (DUN-055); invoices without a sent mark are skipped (`not_marked_sent`, PAY-064). It **never sends**. Idempotent per `(invoiceId, level)` (to-dos per `(reminderId, kind)`); a second run on the same day does nothing new | MUST | P1 | — |
| DUN-031 | **Preview** (`GET /dunning/preview?date=`, `dunning_preview`, UI "Vorschau nächster Lauf"): the same evaluation in dry-run mode for a date (default: the next scheduled run), listing action, level, fee, interest, flat fee, new deadline, total, and skip reasons. Returns a `confirm_token` bound to the result hash (06-mcp §2.3) | MUST | P1 | — |
| DUN-032 | **Withdrawn (v1.1)** — B2: no auto-send switch, no `step.autoSend`, no reminder e-mails. Replaced by DUN-057, DUN-055. | — | — | MAIL-02 |
| DUN-033 | **Safety skips** (no action, reason shown in preview and cockpit): open amount < `minOpenAmountCents`; case paused/handed over/closed; invoice or contact "Nicht mahnen"; disputed; invoice not marked sent (PAY-064, EC-DUN-31); latest reminder not marked sent (DUN-055, EC-DUN-32); an unconfirmed match suggestion, or an unallocated incoming bank transaction (P2: incl. provisional pending feed rows, F07 BNK-111) within the last 5 days whose reference contains the invoice number or whose counterparty name/description is similar to the contact name (payer name/IBAN may be missing, EC-152); bank data not current — P1: the latest imported statement ends more than `bankDataMaxAgeDays` (default 7) before today while a bank account exists; P2: the last successful Enable Banking fetch is older than 24 h while a feed is active — (finalisation downgraded to draft, EC-DUN-19); limitation date passed (draft only, warning); next-level protection of DUN-054 not yet passed | MUST | P1/P2 | MAHN-05 |
| DUN-034 | **Pause rules**: partial payment → case paused for `pauseOnPartialPaymentDays` (auto-resume date, delta D-08); dispute ("Bestritten", reason) → paused until manually resumed; manual pause with optional resume date. Resuming recomputes the next action with the new open amount | MUST | P1 | — |
| DUN-035 | **Case lifecycle**: a dunning case is created on the first reminder; closed automatically when the invoice becomes `paid`, `written_off` or `cancelled`; reopened when a reversal makes the invoice open again (e.g. a bank reversal or Rücklastschrift confirmed as reversal, EC-PAY-24); automation resumes only after a grace period of 7 days (setting) so the customer can re-pay (10-edge-cases EC-129) | MUST | P1 | — |
| DUN-036 | **Bulk dunning** from the OPOS list ("Mahnen" for selected invoices) runs as a `bulk_remind` job with progress; shows the same preview first; creates drafts or finalises only. Handing over is done with the F04 bulk ZIP export and bulk „Als versendet markieren“ (same date/channel) | MUST | P1 | — |
| DUN-037 | Every automated action is attributed `system:cron.dunning.run` (03 §0.1) with the run ID; the cockpit shows a run log (date, evaluated, drafts, finalised, to-dos, skipped by reason) — delta D-09 `dunningRuns` | MUST | P1 | SEC-02, GOBD-06 |
| DUN-054 | **Escalation timing from the manual mark** (contract B2): level 1 is eligible when `today ≥ dueDate + s.daysAfter` and the invoice has a Zugang (PAY-064); a level n > 1 only when the previous reminder has a Zugang (PAY-052) **and** `today ≥ prev.zugang + s.daysAfter` **and** `today > max(prev.printedDeadline, prev.zugang + prev.newDueDays)` (printed deadline = the reminder's `newDueDate` = documentDate + newDueDays, §193-shifted). Finalisation date, export time and run time never start a period. Manual "Nächste Mahnstufe" earlier than this only with warning EC-DUN-17 | MUST | P1 | MAHN-01, MAHN-05 |
| DUN-055 | **Unmarked reminder blocks escalation**: while the latest reminder is finalised but not marked sent, no further level is evaluated (skip `previous_reminder_not_marked_sent`) and a manual next level is blocked (EC-DUN-32). Every finalised reminder (automatic or manual) creates the to-do „Mahnung {Nr.} exportieren und als versendet markieren“; if it is still unmarked 2 days after finalisation, the run logs `todo_mark_sent` once and the to-do becomes a dashboard warning. Drafts created by a run produce one to-do „{n} Mahnvorschläge prüfen“ | MUST | P1 | MAHN-05, MAIL-02 |
| DUN-056 | **Late sent mark**: when a reminder is marked sent more than 3 days after its document date, warning ⚑ „Die im Schreiben genannte Frist ist ggf. zu kurz – Mahnung neu erstellen?“ (EC-DUN-33) with the choices "Trotzdem als versendet markieren" or "Gegenstandslos setzen und neu erstellen" (DUN-009, no notice needed). Either way the next level never starts before `max(printed deadline, Zugang + newDueDays)` has passed (DUN-054), and the reminder's interest stays calculated up to its document date (DUN-023) | MUST | P1 | MAHN-01, MAHN-02 |
| DUN-057 | **Auto-finalise** (replaces auto-send): global switch „Mahnungen automatisch fertigstellen“ (default **off**) AND `step.autoFinalize` (default off). If either is off, the run creates drafts. Auto-finalised reminders go through the F04 finalisation pipeline (number, PDF/A, hash) with the run date as document date and get the DUN-055 to-do; the app never sends them | MUST | P1 | MAHN-05 |

### 3.10 Limitation and collections

| ID | Requirement | Priority | Phase | Compliance refs |
|---|---|---|---|---|
| DUN-040 | **Limitation date** per claim = 31.12. of (year of `dueDate` + 3) (§§195, 199 BGB), stored on the case; shown on the invoice and in OPOS | MUST | P1 | MAHN-05 |
| DUN-041 | **Limitation warnings**: from 01.10. of the limitation year in `deadlines.notify`, dashboard to-do and OPOS badge "verjährt am 31.12.2026"; after the date: badge "verjährt", automation stops, manual reminders need a confirmation. Info text: reminders do not suspend limitation; a Mahnbescheid does (§204 BGB) | MUST | P1 | MAHN-05 |
| DUN-042 | **Inkasso export** (per case or bulk): CSV (columns §4.8) + ZIP with invoice PDF (original), all reminder PDFs, send-log extracts and the account statement. Case status becomes `handed_over` (delta D-10) with partner name and date; automation stops; payments can still be recorded | SHOULD | P1 | GOBD-11 |
| DUN-043 | Inkasso hand-off of a **disputed** claim requires a confirmation with warning EC-DUN-14 | SHOULD | P1 | — |
| DUN-044 | **Mahnbescheid data sheet** (PDF + JSON) with the data needed for online-mahnantrag.de: Antragsteller, Antragsgegner (incl. legal form/representative), Anspruch description ("Rechnung Nr. … vom …"), Hauptforderung, interest wording ("9 Prozentpunkte über dem jeweiligen Basiszinssatz seit …"), Nebenforderungen (Mahnkosten, 40 € Pauschale) | COULD | P3 | MAHN-05 |

### 3.11 Templates

| ID | Requirement | Priority | Phase | Compliance refs |
|---|---|---|---|---|
| DUN-050 | **Templates**: `textTemplates` of kind `document_head`/`document_foot` (docTypes `reminder`) per level and the „gegenstandslos“ letter text (DUN-009), in `de` and `en`; placeholder dictionary shared with F01 (§4.9). Defaults shipped (§4.9). No reminder e-mail templates and no pre-due template (B2); the optional F04 „E-Mail-Text kopieren“ helper uses one generic cover text for docType `reminder` | MUST | P1 | MAIL-03 |
| DUN-051 | **Withdrawn (v1.1)** — B2: no app-sent e-mail, no Message-ID, no `.eml`. Replaced by DUN-058. | — | — | MAIL-02 |
| DUN-052 | **Postal reminders**: the owner prints the exported PDF and marks it sent with channel `post` and `sentOn`; Zugang = `sentOn` + N days (setting, default 3, PAY-052) | MUST | P1 | MAHN-01 |
| DUN-058 | **„Als versendet markieren“ for reminders** (F04 §3.5 mechanism): records `sentOn` (≤ today, ≥ finalisation date, EC-DUN-34), `channel` (`email_manual` \| `post` \| `hand` \| `upload_portal` \| `other` + mandatory note) and the handed-over artifacts (artifact IDs + sha256 of the archived reminder PDF, optionally the invoice „Kopie“) as an append-only `sendLog` row (`purpose: "document"`); the first mark sets status `sent`, `sentAt`, `sentOn`, computes the reminder's Zugang (PAY-052) and re-evaluates the case (PAY-053, DUN-054). No e-invoice obligation for reminders (no XML). A retraction (F04) is blocked once a later reminder references this reminder or the case was handed over (EC-DUN-35); otherwise the Zugang is removed and `defaultStartDate` recomputed | MUST | P1 | MAHN-01, MAIL-02, GOBD-06 |

### 3.12 Events

| ID | Requirement | Priority | Phase | Compliance refs |
|---|---|---|---|---|
| PAY-060 | Webhooks (05 §5.3): `payment.recorded`, `payment.reversed`, `invoice.paid`, `invoice.partially_paid`, `invoice.overdue`, `reminder.finalized`, `reminder.sent` (emitted on the first sent mark, B2); proposed additions `dunning_case.paused`, `dunning_case.handed_over`, `contact.credit_changed` (delta D-11) | MUST | P1 | — |

---

## 4. Workflows and state machines

### 4.1 Record payment (domain + Convex)

```
UI/REST/MCP ──▶ convex payments.record(args)                         (single serializable mutation)
  1. load targets (+version), source (bank tx / cash account / clearing account), company settings, periods
  2. domain validatePayment(args, targets, source, today)   → errors[] / warnings[] (EC-PAY-*)
     - targets finalised, not cancelled, same currency (or FX path), not locked
     - Σ allocations ≤ source available amount; per target: amount + Σ differences ≤ open (+claimed fees)
     - difference rules (Skonto eligibility, VAT split, write-off sub-reason, other → reason+account)
  3. domain computeVatCorrections(target snapshot byGroup, differences)   (pure, cents, largest remainder)
  4. domain buildJournal(payment, mapping(SKR03|SKR04), taxationMethod(date))  (F08 rules)
  5. model.payments.insert(...) per allocation (+ contactCredit / credit pairs)
  6. model.salesDocuments.applyPayment → openAmountCents, paymentStatus (derivePaymentStatus)
  7. source side: bankTransactions.allocatedCents/status (F07) | cash: dating rules (CSH-021) + never-negative check of the `cash` account for outflows/reversals (CSH-026)
  8. dunningCases: pause on partial / close on paid
  9. auditLog + webhook outbox (payment.recorded, invoice.paid|partially_paid)
```

### 4.2 Payment lifecycle

```
            record                         reverse (reason)
 (none) ───────────────▶ active ──────────────────────────▶ reversed  (reversedById set; reversal row
                           │                                            with reversalOfId, negated amounts)
                           │ period lock
                           ▼
                        active+locked ──reverse──▶ reversal dated today (original stays)
```
No other transitions. Fields after insert: only `reversedById`, `lockedAt`, `reconciledTransactionId` (once).

### 4.3 Payment status derivation (invoice-like documents)

```
payable    = totals.payableCents                 (final invoice: gross − advances deducted)
settled    = Σ over non-reversed allocations (amountCents + Σ differences.amountCents)
             − Σ reversal rows (already negative, so simply Σ all rows incl. reversals)
open       = payable − settled
writeOff   = Σ non-reversed write_off differences

paymentStatus (stored) =
         cancelled document          → unset (shown "Storniert")
       | open == 0 && writeOff > 0 && writeOff == last settling amount → "written_off"
       | open == 0 && no cash allocated && corrections/offsets cover payable → "credited"
       | open == 0                   → "paid"
       | open > 0 && settled > 0     → "partially_paid"
       | open == payable             → "open"
       | open < 0                    → impossible (guard; overpayments are routed per PAY-030)

overdue (derived, never stored) = paymentStatus ∈ {open, partially_paid} && dueDate < today (Europe/Berlin)
```
Stored precedence `written_off > credited > paid > partially_paid > open`. The display status adds `overdue` on top (F04 §4.2.9: „Überfällig (+ Teilbezahlt)"); the API returns `payment_status` (stored), `display_status` (incl. `overdue`), `is_overdue`, `is_partially_paid` and `settled_cents`. Corrections (negative totals) use the mirrored logic with labels "Erstattung offen" / "erstattet".

Reminders have no own `paymentStatus`; their list shows the referenced invoice's status.

### 4.4 Dunning case state machine (delta D-10 adds `status`)

```
              first reminder (draft created)
   (none) ─────────────────────────────────▶ active ──partial payment──▶ paused(until D) ──D reached──▶ active
                                              │  ▲                         │
                         dispute / manual ────┘  └──── resume ─────────────┘
                                              │
              invoice paid / written_off / cancelled ──▶ closed ──reversal reopens invoice──▶ active
                                              │
                         Inkasso export ──────▶ handed_over ──paid──▶ closed
```

### 4.5 Daily dunning run (pure evaluation `evaluateDunning(today, state) → Action[]`)

For each document with type ∈ {invoice, advance_invoice, partial_invoice, final_invoice}, status finalized/sent, `openAmountCents > 0`:

1. Resolve policy (DUN-002). None → skip `no_policy`.
2. Invoice without Zugang (never marked sent, PAY-064) → skip `not_marked_sent` (the to-do comes from F04 after 2 days). The „Bald fällig“ list (DUN-053) is computed separately and never produces an action here.
3. Latest reminder finalised but not marked sent → no new level; if finalised ≥ 2 days ago and not yet logged → action `todo_mark_sent` (DUN-055); else skip `previous_reminder_not_marked_sent`.
4. Next step `s` = first step with `level > case.currentLevel`. None → skip `last_level_reached`.
5. Eligible per DUN-054: level 1 `today ≥ dueDate + s.daysAfter`; level n > 1 `today ≥ prev.zugang + s.daysAfter` **and** `today > max(prev.newDueDate, prev.zugang + prev.newDueDays)`.
6. Apply safety skips (DUN-033) in this order: excluded → disputed → paused/handed over → below minimum → pending payment signals → limitation passed → next-level protection.
7. Compute `defaultStartDate` (PAY-053, from the recorded Zugang values only); fee = `s.feeCents` if in default else 0; interest (DUN-023) up to the reminder's document date (= run date) if `s.addInterest` and in default; flat fee (DUN-024); printed deadline `newDueDate = shiftToBusinessDay(today + s.newDueDays)`. A draft finalised later recomputes fee, interest and deadline with its finalisation date as document date.
8. Action `finalize` if global auto-finalise ∧ `s.autoFinalize` ∧ bank data current ∧ no warnings (DUN-057); else `create_draft`.
9. Execute in one mutation per invoice (draft creation) followed, for `finalize`, by the F04 finalisation pipeline (scheduled, retried) and the to-do „Mahnung {Nr.} exportieren und als versendet markieren“. A failure leaves a draft and a notification. **Nothing is sent**; the reminder's Zugang (and with it default, the next level and later fees/interest) exists only after the owner's sent mark (DUN-058).

### 4.6 Seeded default policies

`Days after` = level 1: days after the due date; levels ≥ 2: days after the previous reminder's Zugang (DUN-054). The values reproduce the v1.0 schedule (7/21/35 resp. 7/24/45 days after due) when every reminder is marked sent on its document date by e-mail; later marks shift the schedule accordingly.

| Policy | Step | Level | Days after | Title | Fee | Interest | 40 € | New deadline | Auto-finalise |
|---|---|---|---|---|---|---|---|---|---|
| Standard B2B | Bald fällig (DUN-053) | — | list 3 days before due; to-do off | — | — | — | — | — | — |
| | 1 | 1 | 7 (after due) | Zahlungserinnerung | 0,00 € | no | no | 7 days | no |
| | 2 | 2 | 14 (after Zugang L1) | 1. Mahnung | 0,00 € | yes | yes | 7 days | no |
| | 3 | 3 | 14 (after Zugang L2) | Letzte Mahnung | 0,00 € | yes | (already charged) | 7 days | no |
| Standard B2C | Bald fällig (DUN-053) | — | list 3 days before due; to-do off | — | — | — | — | — | — |
| | 1 | 1 | 7 (after due) | Zahlungserinnerung | 0,00 € | no | — | 10 days | no |
| | 2 | 2 | 17 (after Zugang L1) | 1. Mahnung | 0,00 € | yes | — | 10 days | no |
| | 3 | 3 | 21 (after Zugang L2) | Letzte Mahnung | 2,50 € | yes | — | 10 days | no |

### 4.7 Basiszinssatz table (shipped data; source Deutsche Bundesbank; verify on each release)

| validFrom | validTo | Basiszinssatz | B2C (+5) | B2B (+9) |
|---|---|---|---|---|
| 2016-07-01 | 2022-12-31 | −0,88 % | 4,12 % | 8,12 % |
| 2023-01-01 | 2023-06-30 | 1,62 % | 6,62 % | 10,62 % |
| 2023-07-01 | 2023-12-31 | 3,12 % | 8,12 % | 12,12 % |
| 2024-01-01 | 2024-06-30 | 3,62 % | 8,62 % | 12,62 % |
| 2024-07-01 | 2024-12-31 | 3,37 % | 8,37 % | 12,37 % |
| 2025-01-01 | 2025-06-30 | 2,27 % | 7,27 % | 11,27 % |
| 2025-07-01 | 2026-06-30 | 1,27 % | 6,27 % | 10,27 % |
| 2026-07-01 | (open) | 1,52 % | 6,52 % | 10,52 % |

Rows before 2016-07-01 are added from the Bundesbank series in P1 (needed only for claims older than the limitation period, i.e. rarely). The 2025-07-01 → 2026-06-30 row is consistent with MAHN-02's golden example (10.27 % in June 2026); the 2026-01-01 value must be confirmed against the Bundesbank publication before release (Q-02).

**Golden examples (unit tests, MAHN-02):**

| # | Input | Segments | Result |
|---|---|---|---|
| G1 | B2B, 10.000,00 €, 2026-06-01 … 2026-07-31 | 30 d × 10,27 % = 84,4110 €; 31 d × 10,52 % = 89,3479 € | **173,76 €** |
| G2 | as G1, partial payment 4.000,00 € on 2026-07-10 | 30 d × 10.000 × 10,27 %; 9 d × 10.000 × 10,52 %; 22 d × 6.000 × 10,52 % = 84,4110 + 25,9397 + 38,0449 | **148,40 €** |
| G3 | B2C, 1.000,00 €, 2026-08-01 … 2026-08-31 | 31 d × 6,52 % | **5,54 €** |
| G4 | B2C, 1.000,00 €, 2021-01-01 … 2021-12-31 (negative base rate) | 365 d × 4,12 % | **41,20 €** |
| G5 | B2B, 0,01 €, 1 day | 0,01 × 10,52 % / 365 = 0,0000029 € | **0,00 €** (no interest line printed) |

### 4.8 Inkasso CSV columns (`;`, decimal comma, UTF-8 BOM, one row per claim)

`fallnummer_intern; rechnungsnummer; rechnungsdatum; leistungsdatum; faelligkeitsdatum; verzugsbeginn; verzugsgrund; hauptforderung_brutto; bereits_gezahlt; offene_hauptforderung; mahngebuehren; zinsen_bis_stichtag; zinssatz_beschreibung; pauschale_40; stichtag; schuldner_typ (B2B/B2C); schuldner_name; rechtsform; vertreter; strasse; plz; ort; land; email; telefon; ust_idnr; kundennummer; anzahl_mahnungen; letzte_mahnung_datum; letzte_mahnung_versendet_am; letzte_mahnung_zugang; bestritten (ja/nein); bestritten_grund; verjaehrung_am; dokumente (Dateinamen im ZIP)`

### 4.9 Default templates (letter texts of the reminder documents and the „gegenstandslos“ notice; de; en equivalents shipped)

Placeholders: `{{kunde.anrede}}`, `{{kunde.name}}`, `{{rechnung.nummer}}`, `{{rechnung.datum}}`, `{{rechnung.faellig}}`, `{{rechnung.betrag}}`, `{{betrag.offen}}`, `{{mahnung.stufe}}`, `{{mahnung.titel}}`, `{{mahnung.frist}}`, `{{mahnung.gebuehr}}`, `{{mahnung.zinsen}}`, `{{mahnung.pauschale}}`, `{{mahnung.gesamt}}`, `{{mahnung.nummer}}`, `{{mahnung.datum}}`, `{{verzug.beginn}}`, `{{firma.name}}`, `{{firma.iban}}`, `{{firma.bic}}`; `{{zahlungslink}}` is deferred with F10 (not rendered).

| Template | Betreff (letter subject; reused by the optional „E-Mail-Text kopieren“ helper) | Body (abridged; full text in `src/domain/dunning/templates.de.ts`) |
|---|---|---|
| Pre-due | **Withdrawn (v1.1)** — B2: no pre-due e-mail; replaced by the „Bald fällig“ list (DUN-053) | — |
| Level 1 | `Zahlungserinnerung zur Rechnung {{rechnung.nummer}}` | "… sicherlich ist es Ihrer Aufmerksamkeit entgangen, dass die Rechnung … noch offen ist. Bitte überweisen Sie den offenen Betrag von {{betrag.offen}} bis zum {{mahnung.frist}} …" |
| Level 2 | `1. Mahnung zur Rechnung {{rechnung.nummer}}` | "… trotz unserer Zahlungserinnerung konnten wir bis heute keinen Zahlungseingang feststellen. Sie befinden sich seit dem {{verzug.beginn}} in Verzug. Bitte überweisen Sie den Gesamtbetrag von {{mahnung.gesamt}} (inkl. Verzugszinsen und Pauschale) bis zum {{mahnung.frist}} …" |
| Level 3 | `Letzte Mahnung zur Rechnung {{rechnung.nummer}}` | "… Sollte der Betrag von {{mahnung.gesamt}} nicht bis zum {{mahnung.frist}} eingehen, werden wir die Forderung ohne weitere Ankündigung an ein Inkassounternehmen übergeben bzw. gerichtlich geltend machen." |
| Withdrawal notice (letter, DUN-009) | `Unsere Mahnung {{mahnung.nummer}} ist gegenstandslos` | "… bitte betrachten Sie unsere Mahnung vom … als gegenstandslos. Wir bitten das Versehen zu entschuldigen." |

Templates must not contain threats beyond legally possible consequences; the B2C level-3 default does not mention the 40 € flat fee.

### 4.10 Account roles used by payment postings (decided defaults from the F08 account mapping; default chart SKR03, SKR04 selectable; one-off check by a Steuerberater before go-live recommended, non-blocking)

| Role | SKR03 | SKR04 | VAT |
|---|---|---|---|
| receivable (collective; personal debtor accounts when DATEV personal accounts are enabled) | 1400 | 1200 | — |
| bank | from `bankAccounts.ledgerAccount` (default 1200) | (default 1800) | — |
| cash (single cash account, F07 CSH-020; „Bar bezahlt“ PAY-061) | 1000 | 1600 | — |
| skontoGranted 19 % / 7 % | 8736 / 8731 | 4736 / 4731 | output VAT reduction |
| bankFees | 4970 | 6855 | none |
| dunningFeeIncome (`income.other_nontaxable`: Mahngebühren, 40-€-Pauschale) | 2700 ⚠ | 4830 ⚠ | none (Schadensersatz) |
| interestIncome (`income.interest_default`: Verzugszinsen) | 2650 | 7100 | none |
| badDebt 19 % / 7 % / 0 % (`writeoff.*`, Forderungsverluste) | 2406 / 2401 / 2400 | 6936 / 6931 / 6930 | output VAT reduction (Soll) |
| customerCredit | debtor account (credit balance) | | none |
| fxGain / fxLoss (Erträge/Aufwendungen aus Kursdifferenzen) | 2660 / 2150 | 4840 / 6880 | none |
| outputVat 19 % / 7 % | 1776 / 1771 | 3806 / 3801 | — |

### 4.11 Golden examples for differences (unit tests, UST-32)

| # | Case | Expected |
|---|---|---|
| S1 | Invoice: 100,00 net @19 % + 100,00 net @7 % = 226,00 gross; terms 2 % Skonto / 10 days; paid 221,48 on day 8 | Skonto 4,52 → 19 %: gross 2,38 = net 2,00 + VAT 0,38; 7 %: gross 2,14 = net 2,00 + VAT 0,14. Status `paid` |
| S2 | Invoice 100,00 gross @19 %; Skonto 2 % → 2,00 | VAT `round_half_up(200 × 1900 / 11900)` = 0,32; net 1,68 |
| S3 | Invoice 1.190,00 gross @19 %, paid 595,00, remainder written off (insolvency), Soll | write-off 595,00 → net 500,00, VAT 95,00, posted bad-debt + output-VAT reduction in write-off period |
| S4 | As S3 but Ist-taxation | write-off clears receivable only; `vatCorrection` stored [{1900, 50000, 9500}] but **no** VAT journal line |
| S5 | S3, then 200,00 received 4 months later | wizard: reverse write-off today (VAT +95,00), record 200,00, write off 395,00 again (net 331,93, VAT 63,07) |
| S6 | Invoice 3 groups 19 %/7 %/0 % with gross 119,00 / 53,50 / 10,00 = 182,50, Skonto 3 % = 5,48 (rounded from 5,475 half-up) | pro rata gross 3,57 / 1,61 / 0,30 → sums 5,48 (largest remainder assigns the extra cent to the group with the largest fractional part) |

### 4.12 Data-model deltas (proposed; to be merged into 03 by the lead)

| # | Table / field | Change | Why |
|---|---|---|---|
| D-01 | `payments.difference` | → `differences: { reason; subReason?; amountCents; account?; text?; vatCorrection? }[]` | Skonto + bank fee on the same transfer is common |
| D-02 | `payments.difference.reason` | add `default_interest`; keep `partial`/`collective` only for imports | Separate interest income account |
| D-03 | `payments.source` | add `{ kind: "credit" }` (applying a credit balance) and `{ kind: "adjustment" }` (write-off without cash); v1.1 (B3): `{ kind: "cash" }` **without** entry ID (no cash book) and `{ kind: "private" }` (purchase vouchers paid privately, F07 CSH-023; rejected for sales documents) | No cash source exists in the credit/adjustment cases; PAY-061 |
| D-04 | `payments.target.kind` | add `"contactCredit"` (id = contactId) | Credit balances / overpayments |
| D-05 | `payments` | add `reversalOfId?: Id<"payments">`, `reason?: string`, `eurAmountCents?: number`, `allocationGroupId?: string` | Symmetric reversal link, FX payments, Sammelzahlung grouping |
| D-06 | `payments` | add `reconciledTransactionId?` (whitelisted, set once) | PAY-047 (P1 since v1.1) |
| D-07 | `contacts` | add `dunning?: { policyId?; blocked?: boolean; blockedReason?; calendarDueDateAgreed?: boolean }` | DUN-002, PAY-053 |
| D-08 | `dunningCases` | add `pausedUntil?: string`, `defaultStartDate?: string`, `defaultRoute?: "calendar" \| "reminder" \| "30_days"`, `disputed?: { at; reason }` | DUN-034, PAY-053 |
| D-09 | new `dunningRuns` | `{ date; mode: "auto" \| "manual"; evaluated; actions: { invoiceId; action: "create_draft" \| "finalize" \| "skip" \| "todo_mark_sent"; skipReason?; reminderId?; error? }[]; startedAt; finishedAt; actor }` — v1.1: `pre_due_email` and `finalize_and_send` removed | DUN-037, DUN-030, DUN-055 |
| D-10 | `dunningCases` | add `status: "active" \| "paused" \| "closed" \| "handed_over"`, `handedOver?: { at; partner }` | §4.4 |
| D-11 | 05 §5.3 | add events `dunning_case.paused`, `dunning_case.handed_over`, `contact.credit_changed` — done in 05 §5.3 | PAY-060 |
| D-12 | 02 §7 | add cron `receivables.refreshOverdue` daily 00:15 (event emission only; `overdue` not stored) — done in 02 §7 | PAY-044 |
| D-13 | `dunningPolicies` | add `minOpenAmountCents`, `pauseOnPartialPaymentDays`, `stopAfterLastLevel`; v1.1 (B2): steps lose `autoSend` and `emailTemplateId`, gain `autoFinalize: boolean`; rename `steps[].daysAfterDue` → `steps[].daysAfter` (level 1 from the due date, later levels from the previous reminder's Zugang); `preDueReminderDays` → `dueSoonDays?: number` + `dueSoonTodo: boolean` | DUN-001, DUN-053, DUN-054, DUN-057 |
| D-14 | `salesDocuments` | add `dunningBlocked?: { reason }`, `disputed?: { at; reason }` | DUN-002, DUN-034 |
| D-15 | `payments` | add `backdateReason?: string` (cash > 10 days back), `note?: string`, `receiptFile?: FileRef` (Quittung; set once → whitelist it like `reconciledTransactionId` in the immutability matrix and the mutation inventory) | PAY-061, PAY-063 |
| D-16 | `salesDocuments` | `sentOn?: string`; `zugang?: { date; basis: "email_manual" \| "post" \| "hand" \| "upload_portal" \| "other" \| "manual"; reason? }` (replaces `email \| portal \| post \| manual`; `reason` mandatory for `manual`); `zugang` is a derived, whitelisted field updated only by mark / retraction / override (audited), on invoices and reminders | PAY-052, PAY-064, DUN-058 |
| D-17 | `companyProfile` | remove `autoSendReminders`; add `dunning: { autoFinalizeReminders: boolean (default false); zugangPostDays: number (default 3); bankDataMaxAgeDays: number (default 7); defaultStartViaReminder: "zugang_plus_1" \| "after_printed_deadline" (default `after_printed_deadline`, LEGAL-OPEN Q-01) }` | DUN-057, PAY-052, DUN-033, PAY-053 |
| D-18 | `documentArtifacts.kind` | add `"void_notice"` (the „gegenstandslos“ letter, artifact of the reminder; `sendLog.purpose = "reminder_void_notice"`) | DUN-009 |

---

## 5. Validation rules and edge cases (exhaustive; exact German error/warning messages)

Severity: **E** = blocking error (API 409/422 with `rule`), **W** = warning (must be acknowledged in UI; API returns it in `warnings` and requires `acknowledge_warnings: ["code", …]` for W marked ⚑).

### 5.1 Payments

| ID | Case | Rule / behaviour | Sev | Message (de) | Ref |
|---|---|---|---|---|---|
| EC-PAY-01 | Allocation to one document exceeds its open amount (+ claimed fees/interest) without resolving the excess | Rejected; PAY-030 choices offered | E | „Der Betrag übersteigt den offenen Betrag um {diff}. Bitte den Mehrbetrag zuordnen (weitere Rechnung, Mahngebühren/Zinsen, Guthaben).“ | GOBD-03 |
| EC-PAY-02 | Σ allocations from one source exceed the source amount (bank tx available = amount − allocatedCents) | Rejected | E | „Die Zuordnungen ({sum}) übersteigen den verfügbaren Betrag der Zahlung ({available}).“ | GOBD-02 |
| EC-PAY-03 | Same bank transaction allocated concurrently by two clients | Serializable mutation; the second fails with re-check | E | „Diese Bankbuchung wurde soeben anderweitig zugeordnet. Bitte neu laden.“ | GOBD-02 |
| EC-PAY-04 | Payment on a draft | Rejected | E | „Zahlungen können nur auf fertiggestellte Rechnungen gebucht werden.“ | UST-06 |
| EC-PAY-05 | Payment on a cancelled invoice (or the Stornorechnung itself) | Rejected; hint to credit/new invoice | E | „Die Rechnung ist storniert. Bitte die Zahlung der neuen Rechnung zuordnen oder als Guthaben des Kunden erfassen.“ | UST-30 |
| EC-PAY-06 | Payment date in the future | Rejected | E | „Das Zahlungsdatum darf nicht in der Zukunft liegen.“ | GOBD-03 |
| EC-PAY-07 | Payment date before the document date | Allowed | W⚑ | „Das Zahlungsdatum liegt vor dem Rechnungsdatum (Vorauszahlung). Bitte prüfen.“ | — |
| EC-PAY-08 | Payment date in a locked period | Rejected | E | „Der Zeitraum {MM/YYYY} ist festgeschrieben. Bitte ein Datum in einem offenen Zeitraum wählen.“ | GOBD-06 |
| EC-PAY-09 | Skonto chosen after the Skonto period or above the agreed rate | Not bookable as Skonto; default = remainder stays open; alternative `other` "Kulanz-Preisminderung" with reason | W⚑ | „Skonto-Frist überschritten (Zahlung am {date}, Frist bis {deadline}) bzw. Abzug höher als vereinbart ({actual} statt {agreed}). Der Restbetrag bleibt offen – oder als Kulanz-Preisminderung mit Begründung buchen.“ | UST-32 |
| EC-PAY-10 | Bank-fee difference > 25,00 € | Allowed | W⚑ | „Ungewöhnlich hohe Bankgebühren ({amount}). Bitte prüfen, ob es sich um eine Teilzahlung handelt.“ | — |
| EC-PAY-11 | Skonto on an invoice without Skonto terms | Allowed only as `other` price reduction | E | „Für diese Rechnung wurde kein Skonto vereinbart. Bitte ‚Sonstige Preisminderung‘ wählen.“ | UST-32, UST-09 |
| EC-PAY-12 | Skonto/price reduction on a document with KU, exempt, reverse-charge or other non-VAT categories | VAT correction is 0 for those groups (no VAT to correct) | — | (none; preview shows „ohne USt-Korrektur“) | UST-34 |
| EC-PAY-13 | Multi-rate VAT split rounding (cents must sum exactly) | Largest-remainder allocation; property test: Σ group gross = difference; per group net + vat = gross | — | — | UST-32, GOBD-03 |
| EC-PAY-14 | Write-off without sub-reason | Rejected | E | „Bitte den Grund des Forderungsausfalls angeben (Insolvenz, uneinbringlich, verjährt, Verzicht).“ | UST-32 |
| EC-PAY-15 | Write-off sub-reason `statute_barred` before the limitation date | Rejected | E | „Die Forderung ist erst am {date} verjährt.“ | MAHN-05 |
| EC-PAY-16 | Write-off on Ist-taxation | No VAT posting; info | W | „Bei Ist-Versteuerung wurde die Umsatzsteuer noch nicht abgeführt – es erfolgt keine USt-Korrektur.“ | UVA-06 |
| EC-PAY-17 | Taxation method changed between invoice and write-off/Skonto | Method valid on the payment date decides; if the invoice was taxed under Soll and the payment falls in an Ist period, the VAT correction follows the method under which the invoice's VAT was recognised (stored per invoice journal) | W | „Besteuerungsart hat sich seit der Rechnung geändert. Die USt-Korrektur folgt der Versteuerung der Rechnung ({method}).“ | UVA-06 |
| EC-PAY-18 | Payment on a `written_off` invoice | Only through the recovery wizard (PAY-026) | E | „Die Forderung wurde abgeschrieben. Bitte ‚Zahlungseingang auf abgeschriebene Forderung‘ verwenden.“ | UST-32 |
| EC-PAY-19 | Partial payment on an invoice with an active reminder that claims fees/interest | Default: principal first; the reminder total is not changed (immutable); case pauses (DUN-034); next reminder shows the reduced principal and recomputed interest segments | — | Info: „Teilzahlung erhalten – Mahnverfahren pausiert bis {date}.“ | MAHN-02, MAHN-05 |
| EC-PAY-20 | Customer pays the **reminder total** (principal + fees + interest) | Overpayment over principal offered as `dunning_fees`/`default_interest` up to claimed amounts; the rest → PAY-030 | — | „Mehrbetrag {x}: als Mahngebühren {a} / Verzugszinsen {b} buchen?“ | MAHN-02, MAHN-03 |
| EC-PAY-21 | Customer pays fees/interest but less principal | Principal first (default); fees remain unpaid claims (not booked) | — | — | DUN-006 |
| EC-PAY-22 | Payment currency ≠ document currency without EUR amount | Rejected | E | „Bitte den tatsächlich erhaltenen Euro-Betrag angeben (Fremdwährung).“ | MISC-08 |
| EC-PAY-23 | FX: EUR received differs from EUR value at invoice | Posted as fxGain/fxLoss; never Skonto; rounding to cents half-up once on the EUR side | — | Preview: „Kursdifferenz: {amount}“ | MISC-08 |
| EC-PAY-24 | Bank-sourced payment whose bank transaction is later reversed by the bank (Rücklastschrift, return, recall) — the reversal arrives as a **separate booked counter-entry** (statement import P1, feed P2) | F07 proposes the counter-entry as reversal of the original transaction (BNK-121); only after the owner confirms it does the F05 reversal (PAY-040) of all allocations of the original transaction run (reason "Bankbuchung von der Bank zurückgebucht"), dated the counter-entry's booking date if that period is open, else today (PAY-041); the counter-entry is linked to the reversal; invoice reopens; dunning case reopens (DUN-035); never automatic | W | „Die Bankbuchung vom {date} wurde von der Bank zurückgebucht ({counterDate}). Zahlung auf {number} stornieren?“ | GOBD-02, GOBD-06 |
| EC-PAY-25 | Allocation to a **pending** (provisional) feed transaction (P2) | Not allowed; pending rows live in `bankPendingTransactions`, are never booked or matched (F07 BNK-111); suggestions are computed only for the booked row | E | „Die Bankbuchung ist noch nicht gebucht (vorgemerkt). Eine Zuordnung ist erst nach der Buchung möglich.“ | GOBD-02 |
| EC-PAY-26 | Pending feed row later booked with a different amount (card FX) | The booked row is scored fresh; nothing was pre-applied on the pending row | — | — | GOBD-03 |
| EC-PAY-27 | Reversal of an already reversed payment / of a reversal row | Rejected | E | „Diese Zahlung wurde bereits storniert.“ / „Eine Stornobuchung kann nicht storniert werden. Bitte die Zahlung neu erfassen.“ | GOBD-06 |
| EC-PAY-28 | Reversal of a cash payment or a cash refund would make the `cash` account negative at any date (incl. later dates) | Rejected (F07 CSH-026, RI-11) with date and shortfall | E | „Nicht möglich: Der Kassenbestand würde am {date} negativ werden ({balance}).“ | AO-05 |
| EC-PAY-29 | Reversal when the original period is locked | Dated today, original reference kept | W | „Der ursprüngliche Zeitraum ist festgeschrieben. Die Stornobuchung erfolgt mit Datum {today}.“ | GOBD-06 |
| EC-PAY-30 | Editing/deleting a payment via API (`PATCH`/`DELETE /payments/{id}`) or direct model call | 405 / 409 `immutable_record`; trigger blocks direct patches (mutation-inventory test) | E | „Zahlungen können nicht geändert oder gelöscht werden. Bitte stornieren und neu erfassen.“ | GOBD-06 |
| EC-PAY-31 | Storno of an invoice that has (non-reversed) payments | Blocked; links to "Zahlung stornieren" and "Rechnungskorrektur erstellen" | E | „Die Rechnung ist (teilweise) bezahlt und kann nicht storniert werden. Bitte eine Rechnungskorrektur erstellen (Erstattung/Guthaben) oder eine irrtümlich gebuchte Zahlung zuerst stornieren.“ | UST-30, GOBD-06 |
| EC-PAY-32 | Applying credit larger than the credit balance or to another contact's invoice | Rejected | E | „Das Guthaben ({credit}) reicht nicht aus.“ / „Guthaben kann nur auf Rechnungen desselben Kontakts angewendet werden.“ | GOBD-03 |
| EC-PAY-33 | Refund larger than credit / than the correction's open amount | Rejected | E | „Die Erstattung übersteigt den offenen Erstattungsbetrag ({open}).“ | GOBD-03 |
| EC-PAY-34 | A payment on an advance is reversed (chargeback, wrong match) **after** the final invoice deducted it | Allowed (reversal is a bank fact); the advance re-opens as a separate receivable and the owner is warned. No new final invoice; the deduction stays as finalised (it matched the receipts at that time, RI-08). Since F04 INV-07 no final invoice can be finalised while an advance is still open | W | „Die Zahlung auf Abschlagsrechnung {number} wurde zurückgebucht; die Abschlagsrechnung ist wieder offen ({open}).“ | UST-41 |
| EC-PAY-35 | Payment on an advance invoice (Mindest-Ist) in a Soll company | Output VAT for the received share posted in the payment period (F08) | — | — | UST-40 |
| EC-PAY-36 | Partial payment on a multi-rate invoice under Ist | Revenue/VAT split pro rata across rates (F08 posting) | — | — | UVA-06 |
| EC-PAY-37 | Zero or negative amount entered for a normal payment | Rejected (negative only via reversal/refund) | E | „Der Betrag muss größer als 0 sein.“ | GOBD-03 |
| EC-PAY-38 | Amount with more than 2 decimals / ambiguous input `1.234` | Parsed per 04 §8; > 2 decimals rejected | E | „Bitte höchstens zwei Nachkommastellen angeben.“ | GOBD-03 |
| EC-PAY-39 | `other` difference without reason/account | Rejected | E | „Bitte Grund (mind. 5 Zeichen) und Buchungskonto für die Differenz angeben.“ | GOBD-07 |
| EC-PAY-40 | Idempotency key replay with different body | 422 `idempotency_key_reused` | E | „Dieser Idempotency-Key wurde bereits mit anderen Daten verwendet.“ | SEC-02 |
| EC-PAY-41 | Manual `clearing` payment later matched by an imported bank transaction (double counting risk) | PAY-047 reconciliation; scorer ranks "bereits erfasste Zahlung" first; never creates a second payment automatically | W | „Für diese Bankbuchung existiert bereits eine manuell erfasste Zahlung vom {date} über {amount}.“ | GOBD-02 |
| EC-PAY-42 | **Withdrawn (v1.1)** — B3: cash payments are available in P1 without a cash book. Replaced by EC-PAY-46, EC-PAY-47, EC-PAY-48, EC-PAY-50. | — | — | — | — |
| EC-PAY-43 | Cash payment for which no invoice exists ("Barverkauf") | Not possible; payments always target an issued document | E | „Bareinnahmen ohne Rechnung sind nicht vorgesehen (keine Kassenfunktion). Bitte zuerst eine Rechnung erstellen.“ | AO-04 |
| EC-PAY-44 | Payment target locked (Festschreibung) | Payments on locked documents are still allowed in open periods (the document stays unchanged; only `paymentStatus`/`openAmountCents` change per the immutability matrix) | — | — | GOBD-06 |
| EC-PAY-45 | `derivePaymentStatus` would yield open < 0 (corrupt state) | Invariant check aborts the mutation; integrity job reports | E | „Interner Fehler: negativer offener Betrag. Vorgang abgebrochen.“ | GOBD-03 |
| EC-PAY-46 | Cash payment dated more than 1 day in the past (EC-200) | Allowed after acknowledgement | W⚑ | „Bareinnahmen sind täglich aufzuzeichnen (§ 146 Abs. 1 S. 2 AO). Das Zahlungsdatum liegt {n} Tage zurück – bitte prüfen.“ | AO-05 |
| EC-PAY-47 | Cash payment dated more than 10 days in the past (EC-200) | Reason (≥ 5 characters) mandatory, stored in `backdateReason`, audited; future dates and locked periods stay rejected (EC-PAY-06/08) | E | „Die Barzahlung liegt mehr als 10 Tage zurück. Bitte begründen, warum sie erst jetzt erfasst wird.“ | AO-05, GOBD-03 |
| EC-PAY-48 | Two concurrent cash outflows (e.g. a cash refund and a voucher paid „bar“) that individually keep the `cash` balance ≥ 0 but jointly not (EC-151) | Serialisable re-check aborts one | E | „Der Kassenbestand hat sich soeben geändert. Bitte neu laden und erneut versuchen.“ | AO-05 |
| EC-PAY-49 | Source `private` („privat bezahlt“) on a sales document | Rejected (private payment exists only for purchase vouchers, F07 CSH-023) | E | „‚Privat bezahlt‘ ist nur bei Eingangsbelegen möglich.“ | GOBD-03 |
| EC-PAY-50 | Cash payment exceeds the open amount with "nicht zugeordnet lassen" | Not available for cash; excess must go to further items, fees/interest or credit balance (PAY-030) | E | „Ein Mehrbetrag aus einer Barzahlung muss zugeordnet werden (weitere Rechnung, Mahngebühren/Zinsen oder Guthaben).“ | GOBD-02 |
| EC-PAY-51 | Quittung generated a second time | Reprint marked „Kopie“; the archived original (`receiptFile`, sha256) stays unchanged | — | Watermark „Kopie“ | GOBD-20 |

### 5.2 Due date and default

| ID | Case | Rule / behaviour | Sev | Message (de) | Ref |
|---|---|---|---|---|---|
| EC-DUE-01 | Due date falls on Saturday/Sunday/holiday | Moved to next business day (PAY-051) | — | Tooltip: „Fälligkeit auf den nächsten Werktag verschoben (§ 193 BGB).“ | MAHN-01 |
| EC-DUE-02 | B2C invoice without the §286 Abs. 3 note in its snapshot | 30-day route not applied; default only via reminder | W | „Der Hinweis nach § 286 Abs. 3 BGB fehlt auf der Rechnung – Verzug tritt erst mit Zugang einer Mahnung ein.“ | MAHN-01 |
| EC-DUE-03 | **Withdrawn (v1.1)** — B2: a sent mark always carries `sentOn`, so an unknown send date no longer occurs. Replaced by EC-DUE-07, EC-DUE-08. | — | — | — | — |
| EC-DUE-04 | `dueDays = 0` | Due on document date; 30-day route counts from Zugang | — | — | MAHN-01 |
| EC-DUE-05 | Terms > 60 days B2B / > 30 days public | Warning on contact/policy | W | „Zahlungsziele über 60 Tage (B2B) bzw. 30 Tage (öffentliche Auftraggeber) sind nur bei ausdrücklicher Vereinbarung wirksam (§ 271a BGB).“ | MAHN-04 |
| EC-DUE-06 | Calendar-date route flagged on contact but invoice has relative terms | Flag applies only if the contact flag is set; info shown | W | „Verzug ab Fälligkeit nur bei vertraglich kalendermäßig bestimmtem Zahlungstermin.“ | MAHN-01 |
| EC-DUE-07 | Invoice finalised/exported but never marked sent (EC-196) | No Zugang → no 30-day route, no reminder route, run skips, reminder finalisation blocked (EC-DUN-31); to-do after 2 days (PAY-064) | W | „Die Rechnung ist nicht als versendet markiert – ohne Zugang beginnt kein Verzug und es wird nicht gemahnt.“ | MAHN-01 |
| EC-DUE-08 | Sent mark with channel `other` | Zugang = `sentOn` + 3 days (conservative) | — | Info: „Zugang angenommen am {date} (Versandweg ‚Sonstiges‘: + 3 Tage).“ | MAHN-01 |
| EC-DUE-09 | Manual Zugang override before `sentOn`, in the future, or without reason | Rejected | E | „Das Zugangsdatum muss zwischen Versanddatum ({sentOn}) und heute liegen und begründet werden.“ | MAHN-01 |
| EC-DUE-10 | Invoice sent mark retracted (F04) while no reminder references the invoice | Zugang removed; a `defaultStartDate` depending on it is unset; dunning stops until a new mark | W | „Versandmarkierung zurückgenommen – Verzugsbeginn und Mahnplanung wurden zurückgesetzt.“ | MAHN-01 |

### 5.3 Dunning

| ID | Case | Rule / behaviour | Sev | Message (de) | Ref |
|---|---|---|---|---|---|
| EC-DUN-01 | 40 € flat fee for a consumer | UI hides; API/MCP reject | E | „Die 40-€-Pauschale kann nur gegenüber Unternehmern geltend gemacht werden (§ 288 Abs. 5 BGB).“ | MAHN-03 |
| EC-DUN-02 | 40 € flat fee a second time for the same claim | Rejected | E | „Die 40-€-Pauschale wurde für diese Forderung bereits mit Mahnung {number} geltend gemacht.“ | MAHN-03 |
| EC-DUN-03 | Two invoices of the same customer in default | 40 € per claim (per invoice) — allowed once each | — | — | MAHN-03 |
| EC-DUN-04 | 40 € flat fee where the claim is not in default yet | Set to 0 (automation) / rejected (manual) | E | „Die Pauschale setzt Verzug voraus. Verzug beginnt am {date}.“ | MAHN-03, MAHN-01 |
| EC-DUN-05 | Fees or interest on a reminder dated before `defaultStartDate` | Automation sets 0; manual entry warns | W⚑ | „Der Schuldner ist noch nicht im Verzug – Mahngebühren und Zinsen können noch nicht verlangt werden.“ | MAHN-01, MAHN-02 |
| EC-DUN-06 | B2C fee > 5,00 € | Warning | W⚑ | „Gegenüber Verbrauchern sind nur die tatsächlich entstandenen Mahnkosten ersatzfähig (üblich 2–5 €).“ | MAHN-05 |
| EC-DUN-07 | B2B own fee in addition to the 40 € flat fee | Warning | W⚑ | „Eigene Mahnkosten werden auf die 40-€-Pauschale angerechnet (§ 288 Abs. 5 S. 3 BGB).“ | MAHN-03 |
| EC-DUN-08 | Interest manually raised above computed | Requires reason (audit) | W⚑ | „Die Zinsen übersteigen den berechneten Betrag ({computed}). Bitte Grund angeben.“ | MAHN-02 |
| EC-DUN-09 | Interest period spans a Basiszinssatz change | Split segments (G1) | — | — | MAHN-02 |
| EC-DUN-10 | Basiszinssatz for the current half-year missing | Interest computation blocked (no guess) | E | „Der Basiszinssatz ab {date} ist nicht hinterlegt. Bitte unter Einstellungen › Regeln ergänzen.“ | MAHN-02 |
| EC-DUN-11 | Negative Basiszinssatz | Supported (G4) | — | — | MAHN-02 |
| EC-DUN-12 | Interest below 0,01 € | No interest line printed | — | — | MAHN-02 |
| EC-DUN-13 | Editing a finalised reminder | 409 `document_not_draft` | E | „Mahnungen sind nach dem Fertigstellen unveränderbar. Bitte als gegenstandslos markieren und neu erstellen.“ | MAHN-05, GOBD-06 |
| EC-DUN-14 | Inkasso hand-off of a disputed claim | Confirmation required | W⚑ | „Die Forderung ist als bestritten markiert. Bestrittene Forderungen sollten nicht ohne Prüfung an ein Inkassobüro übergeben werden.“ | — |
| EC-DUN-15 | Claim time-barred | Automation stops; manual reminder needs confirmation | W⚑ | „Die Forderung ist seit dem {date} verjährt. Der Schuldner kann die Einrede der Verjährung erheben.“ | MAHN-05 |
| EC-DUN-16 | Limitation within the current year (from 01.10.) | Warning badge and notification | W | „Verjährt am 31.12.{year} – Mahnbescheid oder Klage hemmen die Verjährung, Mahnungen nicht.“ | MAHN-05 |
| EC-DUN-17 | Next level before the previous deadline passed | Automation skips; manual allowed with warning | W⚑ | „Die Frist der letzten Mahnung läuft noch bis {date}.“ | — |
| EC-DUN-18 | Unconfirmed match/incoming payment signal | Automation skips | — | Skip reason: „Zahlung möglicherweise eingegangen – Zuordnung prüfen.“ | GOBD-02 |
| EC-DUN-19 | Bank data not current (P1: latest imported statement ends > `bankDataMaxAgeDays` ago; P2: last Enable Banking fetch > 24 h while a feed is active) | Auto-finalisation downgraded to draft | — | Skip reason: „Bankdaten nicht aktuell (letzter Kontoauszug bis {date} / letzter Abruf {time}).“ | — |
| EC-DUN-20 | **Withdrawn (v1.1)** — B2: the app sends no e-mail, so a missing invoice e-mail address no longer affects dunning. Replaced by —. | — | — | — | — |
| EC-DUN-21 | Reminder for a cancelled or fully paid invoice | Rejected | E | „Für diese Rechnung kann keine Mahnung erstellt werden (Status: {status}).“ | — |
| EC-DUN-22 | Payment arrives after a reminder draft was created but before finalisation | Draft is deleted by the run (or flagged on manual drafts); finalisation re-checks open amount and blocks if 0 | E | „Die Rechnung ist inzwischen bezahlt. Die Mahnung wurde nicht fertiggestellt.“ | — |
| EC-DUN-23 | Payment arrives after a reminder was finalised or marked sent | Reminder stays (immutable); withdrawal suggested; if it was marked sent, the optional „gegenstandslos“ notice is exported and marked sent (DUN-009); if not yet marked, its to-do changes to „Nicht versenden – gegenstandslos setzen“ | — | Info: „Zahlung nach Mahnung eingegangen – Mahnung als gegenstandslos markieren?“ | MAHN-05 |
| EC-DUN-24 | Reminder number range missing / inactive | Finalisation blocked | E | „Kein aktiver Nummernkreis für Mahnungen. Bitte unter Einstellungen › Nummernkreise anlegen.“ | UST-06 |
| EC-DUN-25 | Geschäftsbrief data incomplete | Finalisation blocked (same as invoices) | E | „Pflichtangaben im Geschäftsbrief fehlen: {fields}.“ | MAIL-03 |
| EC-DUN-26 | Dunning run crashes midway | Per-invoice transactions; rerun is idempotent; no duplicate reminders per (invoice, level) | — | — | GOBD-06 |
| EC-DUN-27 | Reminder in foreign currency invoice | Fees/interest in document currency; 40 € converted? → **No**: the 40 € is EUR; for non-EUR invoices the flat fee is shown in EUR as a separate line and the reminder total is split by currency | W | „Pauschale nach § 288 Abs. 5 BGB wird in EUR ausgewiesen.“ | MAHN-03, MISC-08 |
| EC-DUN-28 | Advance invoice overdue | Dunnable like an invoice (claim exists) | — | — | UST-40 |
| EC-DUN-29 | Correction with negative total | Never dunned | — | — | — |
| EC-DUN-30 | Policy changed while a case is active | The case keeps its level; next action uses the current policy step with the next higher level | — | — | — |
| EC-DUN-31 | Reminder finalisation (manual or run) for an invoice without a sent mark | Blocked; drafts allowed | E | „Die Rechnung ist nicht als versendet markiert. Ohne Zugang der Rechnung kann nicht gemahnt werden.“ | MAHN-01 |
| EC-DUN-32 | Next level while the latest reminder is finalised but not marked sent | Run skips; manual next level blocked | E | „Die Mahnung {number} ist noch nicht als versendet markiert. Bitte zuerst exportieren und den Versand markieren.“ | MAHN-05 |
| EC-DUN-33 | Reminder marked sent more than 3 days after its document date | Choice: mark anyway or withdraw and recreate (DUN-056) | W⚑ | „Die im Schreiben genannte Frist ist ggf. zu kurz – Mahnung neu erstellen?“ | MAHN-01 |
| EC-DUN-34 | Reminder `sentOn` before its finalisation date or in the future | Rejected | E | „Das Versanddatum muss zwischen Fertigstellung ({date}) und heute liegen.“ | MAIL-02 |
| EC-DUN-35 | Retracting a reminder's sent mark when a later reminder references it or the case was handed over | Rejected | E | „Die Versandmarkierung kann nicht zurückgenommen werden, weil {number} darauf aufbaut.“ | GOBD-06 |

---

## 6. UI

### 6.1 "Zahlung buchen" dialog (desktop dialog / mobile drawer)

```
Zahlung buchen · RE-2026-01042 · Müller GmbH                         offen 1.190,00 €
──────────────────────────────────────────────────────────────────────────────────────
Zahlungskonto   [Geschäftskonto EUR ▾ · Kasse]  ( Bankumsatz wählen ▸ 3 passende Umsätze )
Datum           [12.10.2026]     (fixiert durch Bankumsatz)
Betrag          [1.166,20 €]
Differenz −23,80 €   ◉ Skonto (2 % bis 15.10.2026 ✓)   ○ Teilzahlung – Rest bleibt offen
                     ○ Bankgebühren   ○ Forderungsausfall   ○ Sonstige Preisminderung
   USt-Korrektur: 19 % netto −20,00 € · USt −3,80 €
▸ Buchungsvorschau  1200 Bank 1.166,20 S · 8736 Gewährte Skonti 19 % 20,00 S · 1776 USt 19 % 3,80 S · 1400 Forderungen 1.190,00 H
                                                              [Abbrechen]  [Zahlung buchen]
```
- Amount field accepts the formats of 04 §8 and shows the difference live; the difference section appears only if amount ≠ open.
- When the amount exceeds open, the section switches to "Mehrbetrag" with choices from PAY-030 (a list of the contact's other open items with checkboxes).
- **„Kasse“ (Bar bezahlt, PAY-061)**: hides the bank-transaction picker; the date field shows the hint of EC-PAY-46 (> 1 day back) and the mandatory field „Begründung für nachträgliche Erfassung“ (> 10 days back, EC-PAY-47); optional „Notiz“; the Mehrbetrag choices omit „nicht zugeordnet“; the booking preview shows `1000 Kasse` S / `1400 Forderungen` H; after booking, „Quittung drucken“ (PAY-063).
- Keyboard: `⌘Enter` books; `Esc` cancels.

### 6.2 Invoice detail, tab "Zahlungen"
Table: Datum · Quelle (badge Bank/Bar/Verrechnung/Guthaben) · Betrag · Differenzen (chips) · Erfasst von (actor badge) · Status (aktiv/storniert). Row menu: "Stornieren" (dialog with reason and date explanation), "Bankumsatz öffnen", "Quittung drucken" (cash only). Footer: Rechnungsbetrag, bezahlt, Differenzen, offen.

### 6.3 Offene Posten (`/auswertungen/offene-posten`)
Header KPIs (offen, überfällig, Guthaben, Ø Zahlungsdauer); aging stacked bar (5 buckets, tabular legend; colours per dataviz rules, overdue buckets not only red—each labelled); table per 04 §4.1 with bulk actions "Zahlung buchen", "Mahnen", "Export CSV/PDF"; Stichtag picker; group by customer toggle. Mobile: cards with number, customer, days overdue, open amount.

### 6.4 Mahnungen cockpit (`/mahnungen`)
Tabs: **Bald fällig** (DUN-053), **Vorschau** (next run: list of planned actions with checkboxes, "Ausgewählte jetzt ausführen" → confirm dialog; creates/finalises only), **Entwürfe** (reminder drafts to review/finalise), **Zu versenden** (finalised, not yet marked sent: "Exportieren", "Als versendet markieren", bulk ZIP export + bulk mark; overdue to-dos highlighted), **Versendet** (with channel, `sentOn` and Zugang), **Ohne Versandmarkierung** (invoices without Zugang, PAY-064), **Pausiert/Bestritten**, **Verjährung** (claims with limitation this year), **Läufe** (run log). Settings link to policies. The Verzugszinsrechner is a side sheet.

### 6.5 Reminder editor
Same two-pane editor as F04 with a reduced form: level, title, texts, fee, interest (read-only computed table with "Zinsen anpassen" + reason), 40 € toggle (hidden for B2C, disabled when already charged with tooltip), new deadline, export option "Rechnungskopie beilegen". Compliance panel: default status ("Verzug seit … (30-Tage-Regel)" or "kein Verzug – Rechnung nicht als versendet markiert"), invoice Zugang, Geschäftsbrief check, number range check. After finalisation: "Exportieren" and "Als versendet markieren" (F04 dialog).

### 6.6 Policy editor (Einstellungen › Mahnwesen)
Timeline visual of steps relative to the due date; each step card with fields of DUN-001; global switches "Mahnungen automatisch erstellen" (default on), "Mahnungen automatisch fertigstellen" (default off; never sends), „Zugangsfiktion Post“ (days, default 3), „Bald fällig“ horizon and to-do toggle, bank-data age for auto-finalisation (days, default 7), Verzugsbeginn nach Mahnung (`after_printed_deadline` default / `zugang_plus_1`, ⚖ Q-01), aging bucket edges, minimum amount.

### 6.7 Contact
Tab "Offene Posten" (PAY-004), header chip "Guthaben 45,00 €" with actions "Auf Rechnung anwenden" / "Erstatten"; settings: Mahnrichtlinie, "Nicht mahnen" + reason, "Zahlungstermin kalendermäßig vereinbart".

---

## 7. API and MCP exposure

### 7.1 REST (base `/api/v1`, 05 §4.4; additions marked ➕ for the lead to merge)

| Method | Path | Scope | Notes |
|---|---|---|---|
| GET | `/payments` | payments:read | Filters `target_id`, `contact_id`, `source_kind`, `date_from/to`, `reversed`, `updated_since` |
| GET | `/payments/{id}` | payments:read | |
| POST | `/invoices/{id}/payments` | payments:write | Body: `{ date, amount_cents, eur_amount_cents?, source (`{ kind: "cash" }` allowed, PAY-061), backdate_reason?, note?, differences?: [{ reason, sub_reason?, amount_cents, account?, text? }], excess?: { mode: "credit" \| "allocate" \| "fees" \| "unallocated", allocations?: [{ invoice_id, amount_cents }] }, acknowledge_warnings?: [] }`. Returns payment(s), new open amount, status, VAT corrections, journal preview |
| ➕ POST | `/payments` | payments:write | Combined payment: `{ source, date, allocations: [{ target: { kind, id }, amount_cents, differences? }] }` |
| ➕ POST | `/payments/preview` | payments:read | Dry run of either body; returns validation, VAT corrections, journal lines. No write |
| POST | `/payments/{id}/reverse` | payments:write | `{ reason }`; returns reversal row and the date used |
| ➕ POST | `/contacts/{id}/credit/apply` | payments:write | `{ invoice_id, amount_cents }` |
| ➕ POST | `/contacts/{id}/credit/refund` | payments:write | `{ source, date, amount_cents }` |
| ➕ POST | `/corrections/{id}/refund` | payments:write | PAY-033 (b): `{ source, date, amount_cents, backdate_reason?, note?, acknowledge_warnings? }` (same body as the credit refund); more than the open refund → 422 `validation_failed` (EC-PAY-33); till below zero → 422 `cash_negative` (PAY-062) |
| GET | `/open-items` | payments:read | `contact_id`, `overdue_only`, `as_of`, `bucket`; returns items + aging totals |
| GET | `/contacts/{id}/open-items` | payments:read | Includes credit balance |
| GET | `/reminders`, `/reminders/{id}` | documents:read | Sales-document shape (05 §4.3), prefix `rem_` |
| POST | `/invoices/{id}/reminders` | dunning:write | Draft; `{ level?, fee_cents?, include_interest?, include_flat_fee?, new_due_date?, texts? }`; `finalize: true` additionally needs `invoices:finalize` |
| POST | `/reminders/{id}/finalize`, `/reminders/{id}/export`, `/reminders/{id}/mark-sent` | invoices:finalize / documents:read / invoices:send (05 §2.2: the scope for marking as sent) | F04 shape (export of the archived artifacts; mark-sent `{ sent_on, channel, note?, artifact_ids }`); no send endpoint (B2) |
| ➕ POST | `/reminders/{id}/withdraw` | dunning:write | `{ reason, void_notice: boolean }`; with `void_notice` (only if the reminder was marked sent) returns the archived notice artifact to export and mark via `mark-sent` with purpose `reminder_void_notice` |
| GET | `/dunning/preview` | payments:read | `?date=`; returns actions and `confirm_token` |
| POST | `/dunning/run` | dunning:write | `{ dry_run, invoice_ids?, mode: "drafts" \| "finalize", confirm_token }`; creates drafts or finalises; never sends |
| GET / POST/PATCH | `/dunning-policies[/{id}]` | payments:read / **dunning:manage** (05 §2.2) | Dedicated scope: a policy change alters what the automatic `dunning.run` creates and finalises |
| ➕ POST | `/invoices/{id}/dunning` | dunning:write | `{ action: "pause" \| "resume" \| "dispute" \| "block" \| "unblock" \| "hand_over", reason?, until?, partner? }` |
| ➕ GET | `/dunning/interest` | payments:read | Calculator: `?amount_cents&from&to&margin=b2b\|b2c\|<bp>` → segments + total |
| ➕ POST | `/dunning/collections-export` | dunning:write | `{ invoice_ids, format: "inkasso_csv" \| "mahnbescheid" }` → `job_` |
| ➕ GET | `/payments/{id}/receipt` | payments:read | Quittung PDF for a cash payment (PAY-063); generated and archived on first call, later calls return the „Kopie“ variant |
| ➕ POST | `/invoices/{id}/zugang`, `/reminders/{id}/zugang` | dunning:write | Manual Zugang override `{ date, reason }` (PAY-052, EC-DUE-09) |

Errors use problem+json with `rule` (e.g. `{ "code": "flat_fee_consumer", "rule": "MAHN-03", "message": "Die 40-€-Pauschale …" }`).

### 7.2 MCP (06 §3.5)

| Tool | Type | Notes |
|---|---|---|
| `receivables_open_items` | R (`readOnlyHint`) | `{ contact_id?, overdue_only?, as_of?, response_format }` → items, aging, credit balances |
| `payment_list` | R | `{ invoice_id?, contact_id?, date_from?, date_to? }` |
| `payment_record` | ⚠ (`destructiveHint`, `requiresUserInteraction`, `confirm_token` from `preview_action{action:"payment_record"}` (same logic as REST `POST /payments/preview`, 06 §2.3)) | Same body as REST combined payment; source `cash` accepted with the PAY-061 dating rules (warnings returned verbatim, `backdate_reason` required > 10 days back) |
| `payment_reverse` | ⚠ | `{ payment_id, reason, confirm_token }`; token from `preview_action` |
| `dunning_preview` | R | Returns planned actions + `confirm_token` |
| `dunning_run` | ⚠ | `{ confirm_token, invoice_ids?, mode: "drafts" \| "finalize" }`; creates or finalises reminders only, never sends; finalised reminders are exported and marked sent with the generic document tools (06, F04) |
| `reminder_create` | W | Creates a reminder **draft** only |

Tool descriptions state: never invent payments; ask the owner before recording; amounts in cents; German messages are returned verbatim.

---

## 8. Acceptance tests

Test names start with the requirement or compliance ID (07-testing §1). Type: U unit, C Convex, G golden, E E2E, V external validator.

| Test ID | Given / When / Then | Type | Covers req IDs |
|---|---|---|---|
| T05-001 | Given 3 open invoices (one 45 days overdue) / when OPOS loads / then totals, days overdue and bucket `31–60` are correct | C | PAY-001, PAY-002 |
| T05-002 | Given payments dated before and after 2026-09-30 and a reversal dated 2026-10-05 / when OPOS as of 2026-09-30 / then the reversed payment still counts | C | PAY-003, GOBD-01 |
| T05-003 | Customer statement PDF lists opening balance, items, closing balance; footer has Geschäftsbrief data | G | PAY-005, MAIL-03 |
| T05-004 | OPOS CSV uses `;`, decimal comma, BOM | G | PAY-006 |
| T05-010 | Full payment 1.190,00 on 1.190,00 invoice → status `paid`, open 0, journal Bank/Receivable, audit + `invoice.paid` outbox in same transaction | C | PAY-010, PAY-016, GOBD-05 |
| T05-011 | Partial 500,00 on 1.190,00 → `partially_paid`, open 690,00 | C | PAY-012 |
| T05-012 | One 1.500,00 bank tx allocated to 1.000,00 + 500,00 invoices → both paid, tx `matched` | C | PAY-013 |
| T05-013 | EC-PAY-01: 1.300,00 on a 1.190,00 invoice without excess mode → 422 with exact message | C | PAY-030, GOBD-03, EC-120, RI-09 |
| T05-014 | EC-PAY-02: allocations 1.600,00 from a 1.500,00 tx → rejected | C | PAY-013, GOBD-02 |
| T05-015 | EC-PAY-03: two parallel mutations allocate the same tx fully → exactly one succeeds | C (integration, real OCC) | GOBD-02, RI-10 |
| T05-016 | EC-PAY-04: payment on draft → rejected | C | PAY-014, UST-06 |
| T05-017 | EC-PAY-05: payment on cancelled invoice and on Stornorechnung → rejected with message | C | UST-30, EC-121 |
| T05-018 | EC-PAY-06/07: future date rejected; date before invoice date returns warning requiring acknowledgement | C | PAY-014 |
| T05-019 | EC-PAY-08: payment dated in locked 09/2026 → 409 `period_locked` | C | PAY-045, GOBD-06, EC-170, RI-13 |
| T05-020 | GOBD-06 mutation inventory: no code path patches `payments` except `reversedById`/`lockedAt`/`reconciledTransactionId`; direct `ctx.db.patch` on amount throws | C | PAY-040, GOBD-06, RI-15 |
| T05-021 | EC-PAY-30: `PATCH`/`DELETE /payments/{id}` → 405/409 `immutable_record` | C (API contract) | GOBD-06, RI-15 |
| T05-022 | Reverse a payment → reversal row with negated amounts and `reversalOfId`, original `reversedById`, invoice reopens, journal Generalumkehr | C | PAY-040, GOBD-06 |
| T05-023 | EC-PAY-27: reversing twice / reversing a reversal → rejected | C | GOBD-06 |
| T05-024 | EC-PAY-29: original period locked → reversal dated today with warning | C | PAY-041, GOBD-06, EC-170 |
| T05-025 | EC-PAY-28: reversal of a cash payment that would make the `cash` account negative on a later date → rejected with date and shortfall | C | PAY-042, PAY-062, AO-05, EC-149 |
| T05-030 | Golden S1: multi-rate Skonto split and VAT correction; no new number consumed (number counters unchanged) | U, C | PAY-021, UST-32, EC-123 |
| T05-031 | Golden S2: single-rate rounding (0,32 VAT) | U | PAY-021, UST-32 |
| T05-032 | Golden S6 + fast-check: Σ group gross == Skonto; net+vat == gross per group, for random invoices | U (property) | PAY-021, EC-PAY-13, GOBD-03, RI-09 |
| T05-033 | UST-32: Skonto payment in October reduces output VAT in the October journal (UStVA period of payment), not the invoice month | C | PAY-021, UST-32 |
| T05-034 | EC-PAY-09 / EC-122: Skonto after deadline → not bookable as Skonto; default leaves remainder open; `other` Kulanz with reason books VAT correction | C | PAY-022, UST-32 |
| T05-035 | EC-PAY-11: Skonto on invoice without terms → rejected; `other` price reduction accepted with VAT correction | C | PAY-027, UST-32 |
| T05-036 | EC-PAY-12: price reduction on KU / AE invoice → vatCorrection 0 | U | UST-34 |
| T05-037 | Bank fees 3,50 difference → bankFees account, no VAT; EC-PAY-10 warning above 25,00 € | C | PAY-023 |
| T05-038 | Skonto + bank fee on one allocation (differences[] with 2 entries) → both posted, status paid | C | PAY-020 |
| T05-039 | EC-PAY-20: customer pays reminder total → excess offered and booked as dunning fees/interest, no VAT | C | PAY-024, MAHN-02, MAHN-03 |
| T05-039a | EC-PAY-21: invoice 1.000,00 with reminder claiming 5,00 fee + 12,00 interest; customer pays 17,00 + 500,00 → principal reduced by 517,00 (principal first), no fee/interest income booked, open 483,00 | C | DUN-006, MAHN-02 |
| T05-040 | Golden S3: write-off insolvency under Soll → bad-debt + output VAT reduction in write-off period; status `written_off` | U, C | PAY-025, UST-32, EC-124 |
| T05-041 | Golden S4 / EC-PAY-16: write-off under Ist → no VAT journal line; info message | C | PAY-025, UVA-06 |
| T05-042 | EC-PAY-14/15: write-off without sub-reason, or `statute_barred` before limitation date → rejected | C | PAY-025, MAHN-05 |
| T05-043 | Golden S5 / EC-PAY-18: payment on written-off invoice only via wizard; VAT re-raised today, rest written off again | C | PAY-026, UST-32, EC-124 |
| T05-044 | EC-PAY-17: invoice under Soll, payment after switch to Ist → VAT correction follows invoice method | U | UVA-06 |
| T05-045 | EC-PAY-39: `other` difference without reason/account → rejected | C | PAY-027, GOBD-07 |
| T05-050 | Overpayment → credit balance; contact shows Guthaben; journal on debtor credit | C | PAY-030, PAY-031, EC-120 |
| T05-051 | Apply credit to an invoice → pair of allocations with `source.kind=credit`; credit 0 | C | PAY-032 |
| T05-052 | EC-PAY-32: credit applied beyond balance / to other contact → rejected | C | PAY-032 |
| T05-053 | Refund outgoing tx against credit and against a negative correction → open refund 0 | C | PAY-033 |
| T05-054 | EC-PAY-33: refund larger than open refund → rejected | C | PAY-033 |
| T05-055 | EC-PAY-31 / EC-074: Storno of a (partially) paid invoice blocked; after reversing the mistaken payment the Storno succeeds; Rechnungskorrektur + refund path works | C | PAY-034, UST-30, GOBD-06 |
| T05-060 | EC-PAY-22/23: USD invoice paid in EUR → requires EUR amount; FX difference posted to fxGain/fxLoss, rounding once | U, C | PAY-018, MISC-08 |
| T05-061 | EC-PAY-24: a statement import brings a booked counter-entry (Rücklastschrift) for a matched incoming transaction → F07 proposes it as reversal; without confirmation nothing changes; after confirmation all allocations are reversed (F05 reversal, dated per PAY-041), invoice reopens, case reopens | C | PAY-040, PAY-042, GOBD-02, GOBD-06, EC-129 |
| T05-062 | EC-PAY-25 (P2): a pending feed row cannot be allocated and gets no suggestion; the booked row is matched normally | C | GOBD-02, RI-10 |
| T05-063 | EC-PAY-26 (P2): pending row booked with a different amount → booked row scored fresh, nothing pre-applied | C | GOBD-03 |
| T05-064 | EC-PAY-41 / PAY-047: manual clearing payment, then the same transfer arrives via CAMT.053 statement import (P1) → reconciliation offered, no second payment, `reconciledTransactionId` set once | C | PAY-047, GOBD-02, EC-152 |
| T05-065 | **Withdrawn (v1.1)** — B3: cash payments are P1 and no longer rejected. Replaced by T05-162, T05-163, T05-164. | — | — |
| T05-066 | EC-PAY-34/35: payment on advance invoice in Soll company → VAT due posting in payment period; final invoice payable = gross − advances | C | PAY-017, UST-40, UST-41 |
| T05-067 | EC-PAY-36: Ist partial payment on 19 %/7 % invoice → pro rata VAT split | U | UVA-06 |
| T05-068 | EC-PAY-37/38: zero/negative/3-decimal amounts rejected; `1.234` parsed as 1234,00 | U | GOBD-03 |
| T05-069 | EC-PAY-40: idempotency replay returns same response; different body → 422 | C (API) | PAY-019, SEC-02 |
| T05-070 | EC-PAY-44: payment on festgeschriebene invoice in open period succeeds; document snapshot unchanged | C | GOBD-06 |
| T05-071 | EC-PAY-45: forced invariant violation aborts mutation | U | GOBD-03 |
| T05-072 | Status derivation table test incl. stored precedence `written_off > credited > paid > partially_paid > open`; `overdue` only in the derived display status, never persisted | U | PAY-043 |
| T05-073 | `receivables.refreshOverdue` emits `invoice.overdue` exactly once per document and leaves `paymentStatus` unchanged | C | PAY-044 |
| T05-080 | MAHN-01: due date = document date + dueDays; §193 shift on Saturday 2026-10-17 → Monday 2026-10-19 | U | PAY-050, PAY-051, EC-DUE-01 |
| T05-081 | MAHN-01: B2C invoice with note, marked sent 2026-06-01 via `email_manual`, due 2026-06-15 → default start 2026-07-16 (30-day rule) | U | PAY-053 |
| T05-082 | MAHN-01: EC-DUE-02 B2C invoice without note → no 30-day route; default only after the Zugang of a reminder marked sent | U | PAY-053, EC-128 |
| T05-083 | MAHN-01: reminder marked sent with channel `post` on 2026-07-01 → Zugang 2026-07-04 → default start 2026-07-05 | U | PAY-052, PAY-053, DUN-052 |
| T05-084 | **Withdrawn (v1.1)** — B2: a sent mark always has `sentOn`; the "unknown send date" case is gone. Replaced by T05-166, T05-167. | — | — |
| T05-084a | MAHN-01 / EC-DUE-04: `dueDays = 0`, B2B, marked sent 2026-06-10 via `email_manual` → due 2026-06-10, 30-day default start 2026-07-11 | U | PAY-050, PAY-053 |
| T05-084b | MAHN-01 / EC-DUE-06: contact flag "kalendermäßig vereinbart" set → default start = due + 1; flag unset → reminder/30-day route; info shown | U | PAY-053 |
| T05-085 | MAHN-04: contact terms 45 days for public customer → warning | U | PAY-054, EC-DUE-05 |
| T05-090 | MAHN-02 golden G1 = 173,76 € | U | DUN-020, EC-126 |
| T05-091 | MAHN-02 golden G2 (partial payment) = 148,40 € | U | DUN-020 |
| T05-092 | MAHN-02 golden G3 (B2C) = 5,54 €; G4 (negative base) = 41,20 €; G5 = 0,00 € and no line printed | U | DUN-020, EC-DUN-11, EC-DUN-12 |
| T05-093 | MAHN-02 fast-check: interest(a,b) + interest(b+1,c) == interest(a,c) ± 1 cent; never compounds fees | U (property) | DUN-020 |
| T05-094 | EC-DUN-10: missing Basiszinssatz row → computation error, no guess | U | DUN-021, EC-127 |
| T05-095 | `rules.freshness` warns on 2026-07-02 when no 2026-07-01 row exists | C | DUN-021 |
| T05-096 | Reminder level 2 prints interest table with segments matching G1 | G | DUN-005, DUN-023, RI-24 |
| T05-100 | MAHN-03: B2C reminder → no 40 € option (UI hidden, API rejects EC-DUN-01) | C, E | DUN-024, MAHN-03, RI-24 |
| T05-101 | MAHN-03: B2B level 2 adds 40 €, level 3 shows "bereits geltend gemacht" and adds nothing (EC-DUN-02) | C, G | DUN-024, MAHN-03, RI-24 |
| T05-102 | MAHN-03: two overdue invoices of one B2B customer → 40 € once per invoice | C | EC-DUN-03 |
| T05-103 | EC-DUN-04/05: reminder before default start → fees/interest/40 € set to 0 in automation; manual → warning | C | DUN-026, MAHN-01 |
| T05-104 | EC-DUN-06/07: B2C fee 7,50 € and B2B fee with 40 € → warnings | U | DUN-025 |
| T05-105 | EC-DUN-08: interest raised above computed without reason → rejected; with reason → audit entry | C | DUN-008 |
| T05-110 | MAHN-05: finalised reminder has number from reminder range, snapshotHash, letters6 retention (retentionUntil = 31.12. + 6) | C | DUN-004, MAHN-05, GOBD-20 |
| T05-111 | MAHN-05 / EC-DUN-13: PATCH on finalised reminder → 409; withdrawal keeps the archived artifact byte-identical | C | DUN-004, DUN-009, GOBD-06 |
| T05-112 | Reminder finalisation posts no journal entries | C | DUN-006 |
| T05-113 | EC-DUN-24/25: missing reminder range or Geschäftsbrief data → finalisation blocked | C | UST-06, MAIL-03 |
| T05-114 | Reminder PDF has no E-Rechnung XML attached and validates as PDF/A | G, V | DUN-004 |
| T05-120 | Daily run: fixture with 10 invoices (incl. unmarked invoices and unmarked reminders) yields expected actions per §4.5; second run same day → no new actions | C | DUN-030 |
| T05-121 | Preview equals subsequent run result for the same date and state | C | DUN-031 |
| T05-122 | **Withdrawn (v1.1)** — B2: no auto-send, no Mailpit/Message-ID send log. Replaced by T05-171. | — | — |
| T05-123 | Safety skips: each skip reason in DUN-033 (incl. `not_marked_sent`, `previous_reminder_not_marked_sent`, P1 statement age, P2 feed age) produces the documented skip (table-driven) | U | DUN-033, EC-DUN-17…19, EC-DUN-31, EC-DUN-32, EC-152 |
| T05-124 | Partial payment pauses case 14 days, auto-resumes, next reminder uses reduced principal | C | DUN-034, EC-PAY-19, EC-125 |
| T05-125 | Dispute pauses until resume; resume recomputes | C | DUN-034 |
| T05-126 | EC-077/EC-129: case closes on paid/Storno; reversal reopens, no action during 7-day grace period, action afterwards | C | DUN-035 |
| T05-127 | EC-DUN-22: payment between draft and finalise → finalisation blocked, draft removed by run | C | DUN-030 |
| T05-128 | EC-DUN-23: payment after a marked-sent reminder → reminder unchanged, withdrawal suggested; payment after an unmarked finalised reminder → to-do changes to „Nicht versenden – gegenstandslos setzen“ | C | MAHN-05, DUN-009 |
| T05-129 | EC-DUN-26: run aborted after 5 of 10 invoices; rerun → total 10 reminders, no duplicates | C | DUN-030 |
| T05-130 | Run log records actor `system:cron.dunning.run` and counts | C | DUN-037, SEC-02 |
| T05-131 | Bulk "Mahnen" on 5 invoices runs a job with progress and preview | E | DUN-036 |
| T05-132 | EC-DUN-21/29: reminder on paid/cancelled invoice or negative correction rejected | C | DUN-008 |
| T05-133 | EC-DUN-27: USD invoice reminder shows 40 € as separate EUR line | G | MAHN-03, MISC-08 |
| T05-133a | UST-40 / EC-DUN-28: overdue advance invoice is evaluated by the run like an invoice; reminder references the advance invoice number | C | DUN-030, UST-40 |
| T05-134 | EC-DUN-30: policy changed mid-case → level continuity | C | DUN-001 |
| T05-135 | **Withdrawn (v1.1)** — B2: no pre-due e-mail. Replaced by T05-174. | — | — |
| T05-140 | MAHN-05: claim due 2023-03-01 shows "verjährt am 31.12.2026" from 2026-10-01, not on 2026-09-30 | U, C | DUN-040, DUN-041, EC-DUN-16, EC-130 |
| T05-141 | EC-DUN-15: time-barred claim → automation stops; manual reminder requires confirmation | C | DUN-041 |
| T05-142 | Inkasso export: CSV columns per §4.8, ZIP contains original invoice bytes (sha256 equal) and reminders; case `handed_over`, automation stops | G, C | DUN-042 |
| T05-143 | EC-DUN-14: disputed claim export requires confirmation | C | DUN-043 |
| T05-144 | Mahnbescheid sheet contains interest wording with start date | G | DUN-044 |
| T05-150 | Templates render placeholders in de/en; unknown placeholder fails template validation | U | DUN-050 |
| T05-151 | MCP: `payment_record` without confirm_token → error; with token from preview → recorded, actor `mcp:<keyId>` | C (MCP contract) | PAY-019, SEC-02 |
| T05-152 | MCP: `dunning_run` requires token from `dunning_preview`; token invalid after state change (`preview_outdated`) | C (MCP contract) | DUN-031 |
| T05-153 | MCP read tools carry `readOnlyHint`; `payment_record`, `payment_reverse`, `dunning_run` carry `destructiveHint` + `requiresUserInteraction` | C (MCP contract) | 06-mcp §2 |
| T05-154 | Webhooks `payment.recorded`, `invoice.paid` and `reminder.sent` (on the first sent mark) written in the same transaction (outbox) | C | PAY-060 |
| T05-160 | E2E desktop + mobile: record payment with Skonto from invoice detail; booking preview visible; status badge updates live | E | PAY-010, PAY-015, PAY-021 |
| T05-161 | E2E: preview next dunning run, execute selection (drafts/finalise), PDF opens, export + „Als versendet markieren“ from „Zu versenden“, axe clean | E | DUN-031, DUN-058, MISC-10 |
| T05-162 | PAY-061 / EC-200: cash payment today → `cash` S / receivable H, status paid, source `{kind:"cash"}`; dated 2 days back → warning ⚑ citing § 146 Abs. 1 S. 2 AO; 11 days back without reason → rejected, with reason → booked, `backdateReason` audited; future date → rejected; locked period → 409 | C | PAY-061, PAY-045, EC-PAY-06, EC-PAY-08, EC-PAY-46, EC-PAY-47, AO-05 |
| T05-163 | PAY-062 / EC-149 / EC-151: cash refund on a negative correction backdated before an earlier cash outflow so that the balance would dip below 0 → rejected with date and shortfall; two concurrent cash outflows jointly negative → exactly one succeeds (real OCC) | C (integration) | PAY-062, PAY-033, EC-PAY-28, EC-PAY-48, RI-11 |
| T05-164 | PAY-061 / PAY-011: cash overpayment must go to credit balance/other items ("unallocated" rejected, EC-PAY-50); source `private` on an invoice rejected (EC-PAY-49); cash income without an invoice impossible (no API/UI/MCP path, EC-PAY-43) | C, M | PAY-011, PAY-030, PAY-061, AO-04 |
| T05-165 | PAY-063 / EC-PAY-51: Quittung generated once, archived with sha256 in `receiptFile`; second generation returns „Kopie“ and the original bytes stay identical; mutation inventory allows `receiptFile` only once | C, G | PAY-063, GOBD-20, GOBD-06 |
| T05-166 | PAY-052: Zugang per channel — `email_manual`/`hand`/`upload_portal` → `sentOn`; `post` → +3 (setting 4 → +4); `other` → +3 (EC-DUE-08); a second mark does not change it; manual override with reason accepted, before `sentOn`/in the future rejected (EC-DUE-09) | U, C | PAY-052, MAHN-01 |
| T05-167 | PAY-064 / EC-196 / EC-DUE-07: invoice exported 2026-06-01, never marked → no `defaultStartDate`, run skip `not_marked_sent`, to-do on 2026-06-03, reminder finalisation blocked (EC-DUN-31); after marking, evaluation resumes from the mark's Zugang; retracting the mark without reminders unsets the default start (EC-DUE-10) | C | PAY-064, PAY-053, MAHN-01 |
| T05-168 | DUN-054: B2B L1 dated 2026-07-01, marked sent by post 2026-07-01 (Zugang 2026-07-04), L2 `daysAfter` 14, `newDueDays` 7 → L2 not eligible before 2026-07-18; finalisation and run dates have no influence | U | DUN-054, PAY-052 |
| T05-169 | DUN-055 / EC-DUN-32: finalised unmarked reminder → to-do at finalisation, no next level evaluated, manual next level blocked; 2 days later the run logs `todo_mark_sent` exactly once | C | DUN-055, DUN-030 |
| T05-170 | DUN-056 / EC-DUN-33: reminder dated 2026-07-01 marked sent 2026-07-06 → warning; "neu erstellen" withdraws without notice; "trotzdem" → next level waits for max(printed deadline, Zugang + newDueDays); interest stays up to the document date | C | DUN-056, DUN-023 |
| T05-171 | DUN-057 / DUN-030: auto-finalise off → drafts + to-do „Mahnvorschläge prüfen“; global + step on → finalised (number, PDF/A) + to-do „exportieren und als versendet markieren“; no `sendLog` row, no outbound mail, run log action `finalize`, actor `system:cron.dunning.run` | C | DUN-057, DUN-030, DUN-037 |
| T05-172 | DUN-058 / DUN-052: reminder marked sent via `post` → `sendLog` row with artifact sha256 = archived hash, status `sent`, Zugang +3; `sentOn` before finalisation rejected (EC-DUN-34); retraction blocked once the next reminder exists (EC-DUN-35) | C | DUN-058, DUN-052, MAIL-02 |
| T05-173 | DUN-009: withdrawing a marked-sent reminder → void notice PDF archived (artifact kind `void_notice`), export bytes = archived hash, mark with purpose `reminder_void_notice`; withdrawing a never-marked reminder → no notice, `flatFeeCharged` reset if it claimed the 40 € | C | DUN-009, DUN-024, GOBD-06 |
| T05-174 | DUN-053: „Bald fällig“ lists invoices due within 3 days; with the toggle on, exactly one to-do per invoice; no document number consumed, no `sendLog` row, no dunning case | C | DUN-053 |
| T05-175 | PAY-053 route (b): `zugang_plus_1` → default from reminder Zugang + 1; `after_printed_deadline` → from the day after the printed deadline; an unmarked reminder never starts default | U | PAY-053, MAHN-01 |
| T05-176 | E2E desktop + iPhone + Pixel: „Bar bezahlt“ in the dialog with a 3-day-old date shows the § 146 AO warning, books, offers „Quittung drucken“; axe clean | E | PAY-061, PAY-063, MISC-10 |

---

## 9. Open questions

| # | Question | Proposed default |
|---|---|---|
| Q-01 | Interest start day for §286 Abs. 3 (Verzug "spätestens 30 Tage nach…": interest from day 31 or 32?) and for the reminder route; ⚖ whether a reminder that prints a payment deadline puts the debtor in default only after that deadline | **Decided:** §286 Abs. 3 interest from day 31 after max(due date, Zugang); reminder route: default from the day after the reminder's printed deadline (`after_printed_deadline`, the conservative reading; never earlier than Zugang + 1), `zugang_plus_1` selectable (`// LEGAL-OPEN: Q-01`); one-off check by a lawyer/Steuerberater before go-live recommended, non-blocking |
| Q-02 | Exact Basiszinssatz for 2026-01-01 … 2026-06-30 (research gives 10.27 % B2B in June 2026, implying 1.27 %) | Ship 1.27 %; verify against the Bundesbank before P1 release |
| Q-03 | Leap years: actual/365 or actual/366 for 2028 | **Decided:** actual/365 (MAHN-02); one-off check before go-live recommended, non-blocking |
| Q-04 | EÜR treatment of customer overpayments (credit balance) and of refunds (Betriebseinnahme on receipt vs. liability) | **Decided conservative default:** debtor credit in the journal; the EÜR report treats it as income on receipt and as expense on refund (F08) (one-off Steuerberater check before go-live recommended, non-blocking) |
| Q-05 | Dunning-policy endpoints: scope `settings:write` vs `dunning:write` | **Resolved:** dedicated scope `dunning:manage` for writes, `payments:read` for reads (05 §2.2, §4.4) |
| Q-06 | `payment_record` is ⚠ in 06-mcp but not marked requiresUserInteraction in the coordinator brief | **Resolved:** every ⚠ tool needs scope + `destructiveHint` + `requiresUserInteraction` + `confirm_token` from `preview_action` (06 §2, CLAUDE.md rule 8) |
| Q-07 | Cash payments in P1 | **Resolved (v1.1, B3):** cash payments „Bar bezahlt“ in P1 without a cash book (PAY-061…063, F07 CSH-020…030) |
| Q-08 | Sammelmahnung (one letter for several invoices of a customer) — data model has one `invoiceId` per reminder | Not in v1; COULD in P3 with `reminder.invoiceIds[]` |
| Q-09 | Default account numbers for dunning-fee income, interest income, bad debt per rate and FX gain/loss | **Resolved (v1.1, B5):** decided defaults from the F08 mapping (§4.10, SKR03 default; ⚠ rows stay flagged) (one-off Steuerberater check before go-live recommended, non-blocking) |
| Q-10 | §367 BGB allocation as default vs. principal-first | Principal first (simpler VAT handling); §367 optional (DUN-027) |
| Q-11 | Bank-data freshness for P1 auto-finalisation while statements are imported only periodically | `bankDataMaxAgeDays` = 7 (setting); older statement data → drafts only (DUN-033); revisit when the Enable Banking feed (P2) is live |

## 10. P1 implementation notes (payments slice, 2026-10-13)

What the P1 payments slice implements and where it deliberately deviates or defers (reason given; nothing here changes a legal rule):

| Topic | Implementation | Reason |
|---|---|---|
| Model API for other slices | `convex/model/payments.ts`: `documentSettlement(ctx, documentId)` → `{ payableCents, receivedCents, settledCents, openAmountCents, fullySettled, paidOn?, paymentStatus? }`; `openItemsAsOf(ctx, { asOf, contactId? })`; `paymentsOfTarget(ctx, target)`; `creditBalance(ctx, contactId)`; `onSettlementChanged(ctx, change)` | Advances (S10 „is the advance settled, how much was received“) and dunning (open items, overdue, payment events) read the same numbers as the UI |
| Payment events | `onSettlementChanged` is called in the payment transaction after every change of a document's settlement (before/after `paymentStatus` and open amount); currently a no-op | The webhook outbox (F10) and the dunning case do not exist yet; they hook in here, inside PAY-016's single transaction |
| Overdue | Never stored; `isOverdue` / `displayStatusOf` derive it from `dueDate`, `paymentStatus` and today (Europe/Berlin) | §5.2 |
| `allocations` table (cash-basis view) | Not written yet; the Ist basis of a payment is taken from the invoice's `vat.output.notdue.*` journal lines when posting (P1/P6/P8 in Ist) | The table is only read by the EÜR / Ist-UStVA reports (F08 §4.4), which come later |
| Refunds to corrections (PAY-033 b) | Implemented 2026-10-18: `convex/model/payments.ts` `planCorrectionRefund` / `refundCorrection` (UI „Erstattung erfassen“ with Bank · „Bar erstattet“, REST `POST /corrections/{id}/refund`, outgoing bank match with target kind `correction`). The correction's open amount = `payableCents` (negative) + `creditAppliedCents` (the part its invoice absorbed, F04 §4.2.5) − refunds; a refund row is a payment on the correction with a negative amount, posted as P11 (F08 §4.2.2; under Ist plus P11-ist). Status `open` → „Erstattung offen“, partly refunded `partially_paid`, fully refunded `paid` („Erstattet“); fully absorbed without money `credited`. Since 2026-10-18 an outgoing bank debit is also **suggested** against the open refund (F07 BNK-041, T07-074: correction number, exact or partial amount, IBAN/name; never above the open refund) and confirmed through the same `refundCorrection` | PAY-033, EC-PAY-33, PAY-062 |
| Concurrent cash refunds (T05-163, 2026-10-18) | Two „Bar erstattet“ on the same correction sent at once: exactly one is booked — the other fails with `REFUND_EXCEEDS` (sum above the open refund, EC-PAY-33) or `cash_negative` (sum above the till, EC-149, RI-11). One scenario (`test/factories/refund-race.ts`, two API keys through the normal wrappers) runs serialised in convex-test (`convex/correctionRefunds.test.ts`) and with real OCC against the self-hosted backend (`test/integration/refund-race.test.ts`; setup via the IS_TEST-only `testFixtures.ensureInvoicingSetup`; the shared till is brought to 150,00 by a Geldtransit deposit first) | Proves the checks run inside the transaction of the act; convex-test has no OCC, the integration run does |
| OPOS with corrections (PAY-001) | Credit corrections with an open refund appear in the OPOS list as negative items (REST `kind: "correction"`, id `cor_…`) and **net** into „offen gesamt“; never overdue, never in an aging bucket other than „nicht fällig“ | PAY-001 lists „every invoice-like document and correction with `openAmountCents ≠ 0`“ |
| FX (PAY-018) | Deferred | EUR only in P1 |
| Excess modes | `credit`, `unallocated` (bank only, EC-PAY-50) via UI/REST/MCP; `allocate` (further items) through the combined payment / `POST /payments`; `fees` as differences `dunning_fees`/`default_interest` | PAY-030 |
| Errors | Rule violations are `invalid_input` (REST 422 `validation_failed`, `errors[0].code` = lower-case reason such as `excess`, `written_off`, `warnings_unacknowledged`); locked periods 409 `period_locked`; till below zero 422 `cash_negative` | 05 §3.1 |
| Quittung | `payments.receipt`: first print archived (`receiptFile`, sha256), every later print a „Kopie“ rendered from the same immutable data; REST answers JSON with Base64 | PAY-063, EC-PAY-51 |

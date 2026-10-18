# F07 — Banking (Enable Banking feed + statement import), Matching and Cash (Bank, Zuordnungen, Kasse)
> **Status:** v1.1 · 2026-10-12 (owner decisions applied: **B1** bank data without the Revolut Business API — Enable Banking PSD2 feed + statement import; **B3** simple cash instead of a cash book; Revolut Expenses receipts removed) · **Phases:** P1 (statement import CAMT.053 / Revolut CSV / MT940 + signed PDF archive, dedupe, balance continuity, matching engine, private/Geldtransit marking, simple cash), P2 (Enable Banking feed with 180-day consent, matching rules, vouchers from transactions, loans, tax payments, PayPal CSV), P3 (rule suggestions), P4 (payment-provider payout APIs) · **sevdesk parity:** research 00 §11–12; research 07 §2 (Privat, Geldtransit, Darlehen), §3 (Banking, Auto-Zuordnung, Differenzgründe), §4 (Kassenbuch); research 02 #8; **research 13 (bank sync without the Revolut Business API, authoritative)** · **Compliance:** GOBD-01, GOBD-02, GOBD-03, GOBD-04, GOBD-05, GOBD-06, GOBD-07, GOBD-20, GOBD-22, AO-01, AO-04, AO-05, AO-06, MISC-08, UST-32, SEC-02, SEC-06, DSGVO-04, DSGVO-05

Related: [01-compliance](../01-compliance.md) · [02-architecture §4, §7](../02-architecture.md) · [03-data-model §1, §5, §7](../03-data-model.md) · [04-ui-ux §4.6](../04-ui-ux.md) · [05-api §4.6](../05-api.md) · [06-mcp §3.7](../06-mcp.md) · [10-edge-cases §3.9, RI-10/11/27/29](../10-edge-cases.md) · [research 13](../../research/13-bank-sync-without-revolut-api.md) · F05 (payments, differences, reversal) · F06 (vouchers, inbox, voucher payment methods) · F08 (journal, accounts, period lock, opening balances).

**What changed in v1.1 (B1, B3).** The owner has no Revolut Grow plan, so the Revolut Business API is not available. Bank data now comes from (1) **statement files** (CAMT.053 primary, Revolut CSV, MT940, plus the signed PDF statement) — the main path in P1 and always available as fallback and for history — and (2) from P2 the **Enable Banking** PSD2 account-information feed in restricted mode (the same kind of PSD2 connection sevdesk uses through finAPI). Rejected alternatives (research 13 §3): open-banking.io (extra intermediary), finAPI (200 €/month), GoCardless (closed to sign-ups), sales-led aggregators. The Revolut Business API remains a **future option only if the owner ever buys the Grow plan**; it is not specified. The cash book (CSH-001…013) is replaced by simple cash payments and one cash account (CSH-020…030). Withdrawn IDs stay listed so references and tests remain traceable.

---

## 1. Scope (in / out, and what we do better than sevdesk)

### In scope
- **Bank accounts**: `bank` (one row per currency account, e.g. each Revolut pocket; fed by statement import and optionally by the Enable Banking feed), `clearing` (Verrechnungskonten), `paypal` (CSV in P2).
- **Statement import** (P1, always available): CAMT.053 (primary format), Revolut statement CSV, MT940, generic CSV with mapping; the **signed PDF statement** is archived with every period (official Kontoauszug); monthly import to-do per currency account; reconciliation; dedupe; balance continuity (GOBD-02, RI-27).
- **Enable Banking feed** (P2): restricted-mode application with the owner's own linked accounts, PSD2 consent (180 days) with renewal reminders, backfill inside the consent callback, 6-hourly polling within the PSD2 limit of 4 unattended fetches per account and day, owner-present "Jetzt abrufen", dedupe by `entry_reference`, provisional pending transactions, cross-source dedupe with statement imports, raw payload revisions.
- **Matching engine** (scoring with weights, thresholds, combined and partial payments, Skonto, FX amounts) and **user-defined matching rules** (beyond sevdesk).
- **Marking**: private (Privatentnahme/-einlage), Geldtransit, loan disbursement/repayment, restricted ignore, tax payments; **vouchers from transactions**.
- **Simple cash** (B3): one cash account (role `cash`, SKR03 1000), cash receipts on invoices („Bar bezahlt“), cash/private payment of purchase vouchers, „Bargeld eingezahlt / entnommen“, ATM withdrawals into the till, never-negative check (AO-05, RI-11), optional Quittung PDF. **No cash book, no daily close, no POS** (AO-04).

### Out of scope
- **Payments out of the app**: read-only by design (PSD2 account information only, no payment initiation); payments are made in the Revolut app. EPC-QR generation is F04.
- **Inbound bank webhooks**: PSD2 account information has no push and the app is tailnet-only (no public endpoint); polling only (BNK-108).
- **Revolut Business API** (needs the Grow plan) and with it the **Revolut Expenses receipt fetch** (former F06 INB-012). Future option only if the owner buys Grow.
- **open-banking.io, finAPI, GoCardless, Tink/Yapily/TrueLayer/Salt Edge/Plaid, Revolut's own PSD2 API** (research 13 §3–4: rejected on cost, sign-up, licence or extra intermediary).
- Year-end revaluation of foreign-currency pockets (§256a HGB, Bilanz only, AO-07).
- SEPA direct-debit collection (pain.008) and mandate management: not needed while the app is tailnet-only and F10 is deferred. Incoming debits *from* the owner's account (suppliers collecting) are ordinary bank transactions and are handled here.
- Payment-provider API payouts (PayPal/Stripe/Mollie) — P4; P2 handles PayPal by CSV into a clearing account.
- **Kassenbuch** (several registers, daily close, Zählprotokoll, Kassensturz), POS / cash register functions (AO-04, ADR-010).

### Better than sevdesk
| sevdesk (research 07 §3–4, 00 §11–12, research 13 §1) | We |
|---|---|
| finAPI PSD2 connection; re-authorisation every 180 days, frequent relinking complaints | Same PSD2 mechanism (Enable Banking, 0 €), consent reminders 14/3/0 days before expiry, account re-mapping after renewal, backfill inside the consent window, statement import as an always-working fallback |
| Booking of pending/changed transactions unclear | Pending items are provisional (separate store), never booked or auto-matched; only booked items enter the books |
| CSV imports without duplicate check | Dedupe by `entry_reference` / content hash with occurrence index, **cross-source dedupe** between feed and statement files; duplicates reported, never inserted |
| No balance check; Kontoauszug not archived | Balance continuity per account, statement reconciliation, signed PDF + CAMT.053 archived as the official Kontoauszug |
| Matching only via priority of 3 criteria; app matches exact amounts only | Weighted, explainable scores (reason chips), RF references, Skonto, FX bill amounts, combined payments, ambiguity guard |
| Only "private" rules | Full matching rules with preview, rule suggestions |
| Kassenbuch: one register, no negative check | Simple cash without a cash book, but **never negative at any date incl. backdating** and the daily-recording warning (§146 Abs. 1 S. 2 AO) |

---

## 2. User stories

| # | As the owner I want to… | so that… |
|---|---|---|
| US-01 | import my monthly Revolut statement (CAMT.053 + signed PDF) per currency account in one step | the bank data and the official Kontoauszug are in the books from go-live (P1) |
| US-02 | see a customer's transfer matched to the right invoice right after the import or the next poll | invoices turn "bezahlt" and dunning stops |
| US-03 | connect Revolut through Enable Banking once and renew the consent when reminded | new transactions arrive every 6 hours without file handling (P2) |
| US-04 | have exchanges between my EUR and USD pockets recognised as Geldtransit | they never appear as income or expense |
| US-05 | confirm all safe suggestions with one click and review the rest | bank reconciliation takes minutes |
| US-06 | define rules ("Miete → 4210, Vermieter X", "Kontoführung → 4970") | recurring items book themselves |
| US-07 | mark private withdrawals, transfers and loan repayments | my profit is correct |
| US-08 | be reminded 14, 3 and 0 days before the bank consent expires | the feed never silently stops |
| US-09 | record that a customer paid an invoice in cash and print a Quittung | cash receipts are booked the same day without a cash book |
| US-10 | record a cash deposit to the bank or a private cash withdrawal | the cash balance stays plausible and never negative |
| US-11 (Claude) | ask "Welche Umsätze sind noch nicht zugeordnet?" and confirm a suggestion | reconciliation works from chat with confirmation |

---

## 3. Functional requirements

### 3.1 Bank accounts and connection

| ID | Requirement | Priority | Phase | Compliance refs |
|---|---|---|---|---|
| BNK-001 | **Account kinds** `bank`, `clearing`, `paypal`; each with a name, currency, account holder, IBAN/BIC (where applicable), a **unique** ledger account (e.g. SKR03 1200/1210/… / SKR04 1800/1810/…; unique across bank accounts and the cash account), `showOnInvoices`, `isDefaultForInvoices`, opening balance (date + amount), archive. A `bank` account may be linked to the Enable Banking feed (`feed`); its IBAN is then taken from the feed/statement and is not editable | MUST | P1 | GOBD-05 |
| BNK-002 | **Withdrawn (v1.1)** — B1: Revolut Business API setup wizard (certificate, Grow plan). Replaced by BNK-101, BNK-102 | — | — | — |
| BNK-003 | **Withdrawn (v1.1)** — B1: Revolut OAuth code exchange. Replaced by BNK-102 | — | — | — |
| BNK-004 | **Withdrawn (v1.1)** — B1: Revolut token refresh. Replaced by BNK-105 (consent lifecycle) | — | — | — |
| BNK-005 | **Withdrawn (v1.1)** — B1: Revolut account discovery. Replaced by BNK-102, BNK-104 | — | — | — |
| BNK-006 | **Withdrawn (v1.1)** — B1: Revolut webhook setup (no inbound webhooks, tailnet only). Replaced by BNK-108 | — | — | — |
| BNK-007 | **Withdrawn (v1.1)** — B1: Revolut webhook endpoint. Replaced by BNK-108 | — | — | — |
| BNK-008 | **Withdrawn (v1.1)** — B1: Revolut webhook event handling. Replaced by BNK-106, BNK-109 | — | — | — |
| BNK-009 | **Withdrawn (v1.1)** — B1: Revolut incremental sync. Replaced by BNK-106 | — | — | — |
| BNK-010 | **Withdrawn (v1.1)** — B1: Revolut initial backfill. Replaced by BNK-103 | — | — | — |
| BNK-011 | **Disconnect**: revokes the Enable Banking session (`DELETE /sessions/{id}` when reachable), deletes the stored session data and, on request, the application private key, after confirmation; all imported transactions, revisions and statements stay; the accounts remain `bank` accounts fed by statement import; audited | MUST | P2 | GOBD-02 |
| BNK-012 | **Sandbox**: an Enable Banking sandbox application is selectable for testing; sandbox and production data never mix (separate connection, banner „Sandbox“, sandbox transactions excluded from journal and reports) | SHOULD | P2 | — |
| BNK-013 | **Secrets hygiene**: the application private key (PEM), signed JWTs, the authorisation `code`, session IDs and PSU headers are redacted in all logs; the key is stored AES-GCM encrypted (`APP_ENCRYPTION_KEY`); JWTs are minted per request (RS256, TTL ≤ 1 h, never stored) | MUST | P2 | SEC-06, DSGVO-05 |

### 3.1a Enable Banking feed and PSD2 rules (research 13 §2, §3.1, §6.2)

| ID | Requirement | Priority | Phase | Compliance refs |
|---|---|---|---|---|
| BNK-100 | **Adapter boundary**: a thin internal interface `BankFeedProvider { startConsent, completeConsent, listAccounts, fetchTransactions(accountRef, since), fetchBalances(accountRef), consentStatus }` (`src/server/bank/feed.ts`) exists for testability (MSW mocks of the Enable Banking API, 07 §3.3). **Only the Enable Banking implementation is specified and built.** Every source (feed, CAMT.053, MT940, Revolut CSV, CSV) is normalised into one `BankTransactionInput` consumed by the pure domain (`src/domain/banking/**`, CLAUDE.md rule 5) | MUST | P2 | GOBD-03 |
| BNK-101 | **Enable Banking setup** (Einstellungen › Bank › Verbindung): checklist with the owner steps: (1) sign in to the Enable Banking Control Panel (e-mail magic link) and create a production application in **restricted mode**; (2) generate the application key pair in the app (RSA-2048; private key encrypted, never leaves the server; public key/certificate shown for upload) or upload an existing private key; (3) whitelist the redirect URL `https://app.<BASE_DOMAIN>/einstellungen/bank/callback` (BNK-115); (4) enter the application ID; (5) link the owner's own Revolut Business accounts (restricted mode only serves linked accounts); (6) record the status of the **written confirmation** from Enable Banking (BNK-116). Until a confirmation is recorded, the settings page shows „Nutzung im Evaluationsmodus – schriftliche Bestätigung von Enable Banking ausstehend“ (info, not blocking) | MUST | P2 | SEC-06, DSGVO-04, AO-06 |
| BNK-102 | **Consent flow** (owner in the UI only): `GET /aspsps` → choose Revolut (country of the account entry; the DE-IBAN branch may be served by the LT entry, research 13 §7) → `POST /auth { aspsp, psu_type: "business", valid_until, redirect_url, state }` with `valid_until` = min(now + `maximum_consent_validity`, now + **180 days**) and a single-use `state` nonce (stored hashed, 10 min) → redirect to the Revolut approval (the owner selects the currency accounts) → callback verifies `state` → `POST /sessions { code }` → accounts listed; the owner maps each to an existing or new `bank` account (BNK-104) | MUST | P2 | SEC-06 |
| BNK-103 | **Backfill inside the callback**: immediately after `POST /sessions`, still inside the callback action, `GET /accounts/{uid}/transactions?date_from=<start>&strategy=longest` is fetched for every mapped account (all pages via `continuation_key`), because Revolut releases history older than 90 days only within the first minutes after consent (research 13 §2). Start = the day after the last booked transaction of that account, or the opening-balance date for a new account (never earlier). Progress is shown; on timeout/error the callback still completes, the gap is fetched by the next polls (≤ 90 days) and an older gap creates a to-do „Ältere Umsätze per Kontoauszug (CAMT.053) importieren: {from}–{to}“. Backfilled rows go through the normal dedupe (BNK-109/110) | MUST | P2 | GOBD-02 |
| BNK-104 | **Account re-mapping after renewal**: account `uid`s are session-specific; after every consent the accounts are re-mapped to existing `bank` accounts by **IBAN**, else by the stable `identification_hash`, never by `uid`. An unmapped account (e.g. a new currency pocket) prompts „Neues Konto gefunden (USD) – übernehmen?“; a previously linked account missing from the new consent shows a warning and stays fed by statement import. A re-consent never creates duplicate accounts or transactions | MUST | P2 | GOBD-02 |
| BNK-105 | **Consent lifecycle** (state machine §4.1): `validUntil` stored; notifications (cron `bank.consentExpiryReminder`, daily 08:00) and a banner at **T−14, T−3 and T−0 days** („Bankverbindung läuft am {date} ab – jetzt erneuern“); renewal = the consent flow again („Neu verbinden“), followed by re-mapping (BNK-104), a gap fetch with 10 days overlap and a continuity check (BNK-035). `EXPIRED_SESSION`, `401`/`403` or a revoked consent at any time → status `reauth_required`, polling paused, banner; nothing is lost because statement import keeps working and the renewal backfills. A new currency pocket also requires re-consent | MUST | P2 | GOBD-02 |
| BNK-106 | **Polling** (cron `bank.sync`, every 6 h at 05:30 / 11:30 / 17:30 / 23:30 Europe/Berlin): per mapped account `GET /transactions?date_from=<last booked date − 10 days>&strategy=default`; balances (`GET /balances`) at most once per day unattended. A per-account, per-endpoint budget enforces **≤ 4 unattended fetches per 24 h** (pagination of one fetch counts once); on `429 ASPSP_RATE_LIMIT_EXCEEDED` no further unattended call for that account for **6 hours** (`backoffUntil`); `5xx`/network errors retry within the budget with backoff. Pending rows are replaced (BNK-111) and booked rows upserted (BNK-109) | MUST | P2 | GOBD-02 |
| BNK-107 | **„Jetzt abrufen“** only while the owner is present: the button exists only in the UI for a signed-in user and sends the PSU headers (`Psu-Ip-Address`, `Psu-User-Agent`) so the call does not consume the unattended budget. API keys and MCP cannot trigger a fetch (they read status only; REST answers `409 owner_presence_required`). Behind Tailscale the client IP is a tailnet address; whether the bank accepts it as PSU IP is UNSURE → on rejection the call is logged and counted against the unattended budget | MUST | P2 | GOBD-02, SEC-02 |
| BNK-108 | **No webhooks**: there is no inbound bank webhook and no public bank endpoint (PSD2 account information has no push; tailnet only). Payment detection latency is ≤ 6 h with the feed, or the next statement import | MUST | P1 | SEC-06 |
| BNK-109 | **Dedupe keys** for booked transactions: feed rows with `entry_reference` → `dedupeKey = "{accountId}:er:{entry_reference}"`; **never** Enable Banking's `transaction_id` ("may change"); rows without `entry_reference` → `"{accountId}:h:{contentHash}:{ordinal}"` where `contentHash = sha256(accountId, bookingDate, valueDate, amountCents, currency, normalise(counterpartyIban ∨ counterpartyName), normalise(remittance))` and `ordinal` counts identical tuples on the same day within one fetch. Hash-keyed rows are validated against the running balance (`balance_after_transaction` or the balances endpoint, BNK-035); a count mismatch puts the affected rows into the review list „Mögliche Dubletten“ instead of inserting them silently | MUST | P2 | GOBD-02 |
| BNK-110 | **Cross-source dedupe** (feed ↔ statement import, and between statement formats): before inserting, a booked row is compared with existing rows of the same account by (a) the bank's transaction ID if both sources carry the same one (Revolut `ID` in CSV vs CAMT `AcctSvcrRef`/`NtryRef` vs feed `entry_reference`, mapping UNSURE until the owner's sample files exist, §9 Q-03), else (b) `contentHash` with booking date (Europe/Berlin) ± 0 days. A unique match does **not** create a row: the new source is appended to `sources[]` (evidence, raw hash) and may fill empty counterparty fields once (BNK-031). Several candidates → review list „Mögliche Dubletten“ (owner decides „gleiche Buchung“ / „eigene Buchung“). The official statement is never discarded: its file stays archived even if all its rows were duplicates | MUST | P1 | GOBD-02 |
| BNK-111 | **Pending transactions are provisional**: feed rows with status `PDNG` are stored only in `bankPendingTransactions` (not protected, not part of the books), shown as „vorgemerkt“, **never journalised, never allocatable, never matched or suggested** (scoring starts when the booked row arrives). Each poll replaces the account's pending rows for the fetched window; when the booked twin appears it is inserted normally and the pending row disappears. Statement files contain booked entries only (CAMT `Sts ≠ BOOK` is skipped) | MUST | P2 | GOBD-02, RI-10 |
| BNK-112 | **Booking date in Europe/Berlin**: sources with UTC timestamps (Revolut CSV „Date completed (UTC)“, feed timestamps if given) are converted to the Europe/Berlin calendar date; date-only fields (`booking_date`, CAMT `BookgDt/Dt`, MT940 `:61:`) are taken as delivered. The same rule for every source so items near midnight are neither doubled nor placed in the wrong month (EC-155) | MUST | P1 | GOBD-22 |
| BNK-113 | **Raw payload revisions**: every fetched booked row's raw provider JSON (or the source file + line/entry reference) is kept append-only in `bankTransactionRevisions` keyed by `(transactionId, rawSha256)`. A later delivery of a booked row with different amount/date/counterparty is **not applied**: it is stored with `applied: false` and raises the integrity finding „Bank hat eine gebuchte Umsatzzeile geändert“ (manual resolution) | MUST | P1 | GOBD-06, GOBD-02 |
| BNK-114 | **Missing fields**: only account, amount, booking date, direction and status are guaranteed (research 13 §2); remittance text, counterparty name and IBAN may be missing. Mapping never invents data; the scorer degrades gracefully (amount + date + name similarity, then manual confirmation). When the feed delivers the counterparty IBAN, it is used for `known_iban` matching and contact learning | MUST | P1 | GOBD-03 |
| BNK-115 | **Redirect URL in the tailnet** (spike, P2 start): the callback runs at `https://app.<BASE_DOMAIN>/einstellungen/bank/callback`, reachable only inside the tailnet; the redirect is performed by the owner's browser, which is in the tailnet. Whether Enable Banking accepts this non-public HTTPS host in the whitelist is **UNSURE** (research 13 §3.1: "the URL does not have to be public" per Firefly III docs). Spike result goes to an ADR; until confirmed, P2 cannot exit. If rejected: fallback is statement import only (no feed) and the owner is informed | MUST | P2 | SEC-06 |
| BNK-116 | **Provider record (Verfahrensdokumentation)**: the provider (Enable Banking, restricted mode), application ID, consent periods and the status of the owner's request for **written confirmation or a price** (`pending` / `confirmed` / `quoted` / `declined`, date, note, optional file) are recorded and printed in the Verfahrensdokumentation section "Bankdaten" (F12) | MUST | P2 | GOBD-10, DSGVO-04 |
| BNK-117 | **Loss of feed access** (Enable Banking ends restricted mode by written notice, the spike fails, or the consent cannot be renewed): the connection is disconnected (BNK-011) and the accounts continue with statement import; no data is lost; cross-source dedupe (BNK-110) prevents duplicates when files overlap feed data; the dashboard shows „Bankdaten nur per Kontoauszug-Import“ | MUST | P2 | GOBD-02 |

### 3.2 Transaction mapping (all sources → `bankTransactions`)

| ID | Requirement | Priority | Phase | Compliance refs |
|---|---|---|---|---|
| BNK-020 | **Withdrawn (v1.1)** — B1: one row per Revolut API leg. Each source delivers one booked row per account entry; see BNK-120 | — | — | — |
| BNK-021 | **Money parsing**: amounts are parsed from the **decimal string/literal** of the source (Enable Banking `transaction_amount.amount` string, CAMT `Amt`, MT940 amount with decimal comma, CSV per mapping) into integer minor units per ISO 4217 exponent (0, 2 or 3 decimals); never via floating-point arithmetic; more decimals than the exponent → row rejected with a finding | MUST | P1 | GOBD-03 |
| BNK-022 | **Withdrawn (v1.1)** — B1: Revolut API field mapping. Replaced by BNK-120 | — | — | — |
| BNK-023 | **Fees**: a fee that arrives as its own transaction (e.g. the Revolut plan fee, transfer fees) is booked to role `bankFees` (SKR03 4970 / SKR04 6855, no VAT, no §13b, F08) by rule or marking; a fee that the source reports as a field of a transaction (CSV `Fee`, feed charge amount) is split into a separate booking line on the same transaction; the Beleg is the bank statement (BNK-030). Whether a source's amount already includes the fee is fixed per source format from the owner's sample files and encoded in one mapper constant with fixture tests; if balance continuity cannot prove it, the owner confirms the split once per source format (`bankAccounts.feeSemantics`, F08 E-ACC-32) (EC-145) | MUST | P1 | GOBD-07, EC-145 |
| BNK-024 | **Withdrawn (v1.1)** — B1: Revolut transaction states. Replaced by BNK-111 (pending provisional) and BNK-121 (bank reversals) | — | — | — |
| BNK-025 | **Withdrawn (v1.1)** — B1: mutable mirror of non-final Revolut transactions. Replaced by BNK-122 | — | — | — |
| BNK-026 | **Revisions are monotonic**: re-deliveries of a booked row never overwrite it (BNK-113); a re-delivery with identical content only appends to `sources[]`/revisions if the source differs | MUST | P1 | GOBD-06, GOBD-02 |
| BNK-027 | **Type defaults** (`src/domain/banking/type-defaults.ts`): derived from the ISO 20022 bank transaction code (feed `bank_transaction_code`, CAMT `BkTxCd`), the Revolut CSV `Type` column and description patterns: exchange between own pockets / transfer to an own IBAN → Geldtransit suggestion (BNK-061); fee → rule suggestion „Bankgebühren“ (F06); card refund → match to the original voucher by merchant + amount; ATM withdrawal → suggestion „Bargeldabhebung in die Kasse“ (CSH-025) or Privatentnahme; top-up → incoming (matching); tax, loan, interest → manual classification with hint. Codes and patterns are rule data, versioned | MUST | P1 | GOBD-03 |
| BNK-028 | **Foreign-currency accounts** (MISC-08; posting rules owned by F08 §4.2.7): every non-EUR transaction stores `amountEurCents` and `fxRate { rate, source, date }` — the rate implicit in the transaction (exchange between pockets: the EUR counter-transaction; feed `exchange_rate` if given) or else the ECB reference rate of the booking date (source logged). Each pocket keeps a **moving-average EUR cost**; outflows are valued at that cost and the realised difference goes to FX gain/loss (EC-144; F08 R1–R3, R14). Card payments from the EUR pocket in a foreign currency are booked at the EUR actually debited. No year-end revaluation (Bilanz only) | MUST | P1 | MISC-08 |
| BNK-120 | **Normalised field mapping** per source into `bankTransactions` (03 §7): `bookingDate` (BNK-112), `valueDate`, `amountCents` (signed by credit/debit indicator), `currency`, `purpose` (remittance unstructured lines joined; structured reference e.g. RF kept in `reference`), `counterpartyName`/`counterpartyIban`/`counterpartyBic` (creditor for debits, debtor for credits; CSV `Payer`/`Beneficiary IBAN`; CAMT `RltdPties`), `endToEndId`, `mandateRef`, `creditorId` (CAMT/MT940 SEPA tags), `source { kind, entryReference?, providerTransactionId?, bankTransactionCode?, proprietaryCode?, merchantName?, mcc?, feeCents?, exchangeRate?, balanceAfterCents? }`, `counterpartySource` (`provider` \| `description` \| `statement`). Mapping tables per source live in `src/domain/banking/sources/*` with fixtures from the owner's real export (§9 Q-03) | MUST | P1 | GOBD-22, GOBD-03 |
| BNK-121 | **Bank reversals**: a booked transaction is never changed by the bank; a reversal arrives as a **separate booked counter-entry** (CAMT `RvslInd = true`, negative amount with the same reference, or a returned SEPA transfer). The importer detects candidates (same account, inverse amount, same end-to-end ID/reference, ≤ 60 days) and suggests „Rückbuchung von {date} {amount}“; on confirmation the counter-entry is linked (`reversalOfId`, set once) and, if the original was allocated, the allocations are reversed via F05 PAY-040 (reason „Rückbuchung durch die Bank“), dated the counter-entry's booking date if that period is open, else today; the invoice/voucher reopens; notification (EC-141, EC-129) | MUST | P1 | GOBD-06, GOBD-02 |
| BNK-122 | **Immutability of booked rows** (03 §11): after insert only `status`, `ignoredReason`, `ignoredLinkId`, `allocatedCents`, `bookedAt`, `lockedAt`, `sources[]` (append), `reversalOfId` (once) and a one-time fill of empty counterparty fields may change, through `convex/model/**`. Pending items never enter this table (BNK-111) | MUST | P1 | GOBD-06 |

### 3.3 Statements, file imports, dedupe, continuity

| ID | Requirement | Priority | Phase | Compliance refs |
|---|---|---|---|---|
| BNK-030 | **Monthly statement import to-do** (EC-156): from the 3rd of each month a to-do per currency account (derived by the query `banking.todos`, §4.10) „Kontoauszug {Monat} importieren (CAMT.053 + PDF signiert)“. The import dialog takes the CAMT.053 (or MT940/Revolut CSV) **and the signed PDF** for the same period; files are stored with sha256 in `bankStatements` (retention `vouchers8`; bank statements are Buchungsbelege) and the import runs the normal pipeline (parse → normalise → dedupe → insert → match). The CAMT opening/closing balances are **reconciled** with the account's booked balance at the period end (statements are in **UTC** by default; the comparison uses the same instant, EC-155). Result: `reconciled = true` or a difference list (missing/extra transactions). The statement is the official Kontoauszug whether or not the feed already delivered the rows | MUST | P1 | GOBD-07, GOBD-02, GOBD-20 |
| BNK-031 | **Enrichment**: a later source (statement or feed) fills empty `counterpartyName`/`counterpartyIban` fields of an existing row once (via BNK-110 match), audited; matching re-runs for affected open transactions | SHOULD | P1 | GOBD-03 |
| BNK-032 | **Revolut CSV import**: parse by **header names** (column names UNSURE until the owner's sample export, research 13 §5; variants with local-time columns, `State`, `Total amount`, `Fee currency`, `MCC`); UTC timestamps converted per BNK-112; `ID` column kept as `source.providerTransactionId` for dedupe within CSV sources and for cross-source matching (BNK-110); only completed rows are inserted; duplicates counted and reported, never inserted | MUST | P1 | GOBD-02 |
| BNK-033 | **CAMT.053 (primary) and MT940 parsers**: camt.053 (.001.02/.04/.08; own parser on `fast-xml-parser`, `Sts = BOOK` only, `RvslInd` handled per BNK-121, batch entries split per `TxDtls`, `Bal` OPBD/CLBD read); MT940 (`mt940js` + German `:86:` structured subfields `?20–?29`, `?32/?33`, `?31`, SEPA tags `EREF+`, `MREF+`, `CRED+`, `SVWZ+`); generic CSV with a saved, versioned mapping (date format, decimal separator, encoding auto-detect UTF-8/Windows-1252, delimiter, header/footer rows, signed amount or amount + debit/credit column) | MUST | P1 | GOBD-02 |
| BNK-034 | **File dedupe**: file sha256 already imported → warning, 0 inserted unless forced; per row `dedupeKey` as in BNK-109 (statement entry reference if present, else content hash + `occurrenceIndex` counting identical tuples within the file — two genuine identical coffees stay two rows; re-import inserts only the surplus); near-duplicates (same account/date/amount/counterparty, different purpose formatting) → review list „Mögliche Dubletten“, never inserted silently | MUST | P1 | GOBD-02 |
| BNK-035 | **Balance continuity** (GOBD-02, RI-27): files — opening = previous closing; opening + Σ entries = closing; CSV without balances → „Saldo nicht prüfbar“ unless the owner enters the closing balance. Feed — where `balance_after_transaction` is delivered, each booked row must satisfy `balance_n = balance_{n−1} + amount_n`; the daily balances call must equal Σ booked amounts since the opening balance (tolerance 0, pending excluded). A break produces „Saldenlücke zwischen {date1} und {date2}: {diff}“ and a to-do to import the statement for that period | MUST | P1 | GOBD-02, RI-27 |
| BNK-036 | **Import rollback** (wrong account/file): only for file imports, only if no row of the import is allocated/booked; rows get status `ignored` with reason `import_rolled_back` (no deletion); the statement files stay archived with the flag „zurückgenommen“; audited | SHOULD | P1 | GOBD-02, GOBD-06 |

### 3.4 Matching engine

| ID | Requirement | Priority | Phase | Compliance refs |
|---|---|---|---|---|
| BNK-040 | **Triggers**: transaction inserted, document finalised or open amount changed, voucher finalised, rule changed, „Neu bewerten“. Pure scorer in `src/domain/banking/match.ts`; suggestions persisted in `matchSuggestions` | MUST | P1 | GOBD-03 |
| BNK-041 | **Candidates**: incoming → open invoices/advance/final invoices (open > 0), existing unreconciled manual payments (F05 PAY-047, ranked first), credit balances; for an outgoing debit whose voucher was already settled „bar“/„privat bezahlt“ the suggestion is „Zahlung umbuchen“ (F06 VOU-139: reverse the cash/private payment, then match); outgoing → open vouchers (P2), negative corrections (refunds to customers), credit refunds, open Geldtransit from cash deposits (CSH-024). Hard filters: direction, currency (`tx.currency` = document currency **or** instructed/original currency = document currency), not cancelled, not fully paid. **The document number in the reference is the primary rule** (§4.4) | MUST | P1 | GOBD-02 |
| BNK-042 | **Scoring** (additive, capped at 1.00; weights in §4.4; RF reference = deterministic 1.00); reasons stored as chips. **Ambiguity guard**: if the second-best candidate is within 0.05, the best is capped at 0.90 with reason `ambiguous` | MUST | P1 | GOBD-03 |
| BNK-043 | **Thresholds** (Einstellungen › Bank › Zuordnung): `autoApply` 0.98 (per account toggle, default on), `safe` 0.95 (04 §4.6 „Alle sicheren bestätigen“), `suggest` 0.40. Auto-apply additionally requires: a **booked** transaction (never pending, BNK-111); a unique candidate; reason `number_in_purpose` or `rf_reference`; exact open amount; no Skonto/partial/combined/FX difference. Auto-applied matches appear under „Automatisch zugeordnet“ with one-click „Rückgängig“ (= F05 reversal) | MUST | P1 | GOBD-03, GOBD-06 |
| BNK-044 | **Combined payments**: if the reference contains ≥ 2 document numbers whose open amounts sum to the transaction amount → combined suggestion (allocations per document); otherwise a bounded exact subset-sum over the open items of the identified contact (≤ 12 items, prefer fewer items, then older due dates). Combined suggestions are never auto-applied | MUST | P1 | GOBD-02 |
| BNK-045 | **Partial and Skonto**: amount < open with a number match → „Teilzahlung“ suggestion; amount = open − agreed Skonto within the Skonto period → suggestion with Skonto difference (F05 PAY-021); both never auto-applied | MUST | P1 | UST-32 |
| BNK-046 | **Review actions** (04 §4.6): ✓ Bestätigen (runs F05 `payments.record` with `source.kind = "bank"`), ✗ Ablehnen (pair stored, not suggested again), ↔ Andere wählen (search), + Neuer Beleg (BNK-065, P2), Privat, Geldtransit, Bargeld in die Kasse (CSH-025), Darlehen (P2), Ignorieren (restricted, BNK-063) | MUST | P1 | — |
| BNK-047 | **Unmatch** („Zuordnung aufheben“) = F05 reversal of the allocations; reversal dated per PAY-041 (today if the period is locked) | MUST | P1 | GOBD-06 |
| BNK-048 | **Learning**: confirming a match stores the transaction's normalised counterparty name / description token and, when delivered, the counterparty IBAN as an alias of the contact (`contactAliases`), so later transfers score `known_iban` / name similarity | SHOULD | P1 | — |
| BNK-049 | **Matching vouchers** (P2): card payments use the merchant name, original amount/currency, MCC (where delivered) and date (±3 days) against vouchers and inbox drafts; recurring vouchers use expected amount (±5 %), date (±5 days) and creditor/mandate data. No pre-linking of receipts by a bank transaction ID (the Revolut Expenses source is removed) | MUST | P2 | GOBD-07 |

### 3.5 Matching rules

| ID | Requirement | Priority | Phase | Compliance refs |
|---|---|---|---|---|
| BNK-050 | **Rules** (`matchingRules`): name, priority, enabled, mode `suggest` \| `auto`; conditions (all must hold): account, direction, currency, bank transaction code / proprietary code (e.g. Revolut CSV `Type`), reference/description *contains* or *regex* (RE2-safe, max 200 chars), counterparty contains, IBAN equals, merchant name contains, MCC in list, amount range; actions: `categorize` (account + tax rule → creates a voucher), `private`, `transfer` (target own bank account or the cash account), `link_contact`, `ignore` (restricted per BNK-063), `loan` (loan account + principal/interest split rule). First matching rule (by priority) wins; rules run before scoring; rules never act on pending transactions | MUST | P2 | GOBD-03 |
| BNK-051 | **Rule preview**: „Diese Regel würde 14 Umsätze der letzten 90 Tage treffen“ with list, before saving; applying a new rule to existing open transactions is an explicit action | MUST | P2 | — |
| BNK-052 | **Rule-created vouchers**: `categorize` creates a finalised voucher only if the rule is `auto` and the rule marks „Kontoauszug genügt als Beleg“ (e.g. bank fees, account plan fee); otherwise it creates a draft voucher flagged „Beleg fehlt“ that appears in F06 missing receipts | MUST | P2 | GOBD-07 |
| BNK-053 | **Rule suggestions**: after 3 identical manual classifications of transactions with the same counterparty token, propose a rule | SHOULD | P3 | — |
| BNK-054 | Rules created via API/MCP are stored with `mode = "suggest"`; switching to `auto` requires the UI (signed-in user) | MUST | P2 | SEC-02 |

### 3.6 Marking, vouchers from transactions, providers

| ID | Requirement | Priority | Phase | Compliance refs |
|---|---|---|---|---|
| BNK-060 | **Privat**: outgoing → Privatentnahme (SKR03 1800 / SKR04 2100), incoming → Privateinlage (SKR03 1890 / SKR04 2180); an Eigenbeleg is generated automatically („Privatentnahme laut Kontoauszug“). For GmbH/UG/AG/GmbH & Co. KG blocked → „Verrechnungskonto Gesellschafter“ (account from mapping) (EC-BNK-21) | MUST | P1 | AO-01, GOBD-07 |
| BNK-061 | **Geldtransit**: transfers between own accounts (Revolut pockets, other own accounts, the cash account, PayPal clearing) via the Geldtransit account (SKR03 1360 / SKR04 1460). Pairs are linked automatically (exchange between pockets arriving as two transactions in two accounts on the same booking date with matching EUR value/exchange rate, IBAN of an own account, cash deposit CSH-024 ↔ bank credit) or manually; a dashboard warning shows an unbalanced Geldtransit older than 7 days | MUST | P1 | GOBD-03 |
| BNK-062 | **Darlehen**: Kreditaufnahme (incoming → loan account, e.g. SKR03 0630 / SKR04 3150) and Rückzahlung split into principal (loan account) and interest (interest expense) — the owner enters the principal or the interest; a loan-statement voucher is requested (missing-receipt list) | SHOULD | P2 | GOBD-07 |
| BNK-063 | **Ignorieren** is restricted for booked transactions (completeness): allowed reasons only `duplicate_of_file_import` (with link; normally prevented by BNK-110), `neutralised_pair` (a booked outgoing and its booked return of equal amount, linked), `test_or_zero`; any other booked money movement must be booked. Pending items are not in the books at all (BNK-111) | MUST | P1 | GOBD-02 |
| BNK-064 | **Tax payments**: transfers to/from the Finanzamt → voucher kind `tax_payment` (UStVA payment/refund, prepayments) with period selection (F08) | SHOULD | P2 | — |
| BNK-065 | **Voucher from transaction** („+ Neuer Beleg“): creates a voucher draft prefilled (date, amount, counterparty, reference, currency/original amount, supplier profile account suggestion), allocated on finalisation; or attach an inbox item/upload directly onto the transaction | MUST | P2 | GOBD-07 |
| BNK-066 | **Withdrawn (v1.1)** — B3: ATM/cash deposits via the cash book. Replaced by CSH-024 (deposit to bank) and CSH-025 (ATM withdrawal into the till) | — | — | — |
| BNK-067 | **Payment providers (P4 note)**: P2 supports PayPal by CSV into a `paypal` clearing account (gross charges matched to invoices on that account, fees → `bankFees`, payouts → Geldtransit to the bank). P4 adds PayPal/Stripe/Mollie APIs with payout break-down (polling; inbound webhooks are not possible while tailnet-only); the same clearing-account model applies | COULD | P4 | GOBD-02 |

### 3.7 Cash (simple, no cash book)

| ID | Requirement | Priority | Phase | Compliance refs |
|---|---|---|---|---|
| CSH-001 | **Withdrawn (v1.1)** — B3: several cash books. Replaced by CSH-020 | — | — | — |
| CSH-002 | **Withdrawn (v1.1)** — B3: cash-book entry kinds. Replaced by CSH-021…025 | — | — | — |
| CSH-003 | **Withdrawn (v1.1)** — B3: append-only cash entries with `seq`. Replaced by CSH-027 (journal + `cashTransfers` are append-only) | — | — | — |
| CSH-004 | **Withdrawn (v1.1)** — B3: never-negative cash book. Replaced by CSH-026 | — | — | — |
| CSH-005 | **Withdrawn (v1.1)** — B3: cash-book dating and closed days. Replaced by CSH-021 dating rules | — | — | — |
| CSH-006 | **Withdrawn (v1.1)** — B3: daily close with Zählprotokoll (no Kassensturz) | — | — | — |
| CSH-007 | **Withdrawn (v1.1)** — B3: open-days reminder (no daily close; the daily-recording warning of CSH-021 replaces it) | — | — | — |
| CSH-008 | **Withdrawn (v1.1)** — B3: cash-book reversal entries. Replaced by CSH-027 | — | — | — |
| CSH-009 | **Withdrawn (v1.1)** — B3: voucher per cash-book entry. Covered by CSH-021…025 (every movement references an invoice, a voucher or an auto Eigenbeleg) | — | — | — |
| CSH-010 | **Withdrawn (v1.1)** — B3: no POS on the cash-book page. Replaced by CSH-029 | — | — | — |
| CSH-011 | **Withdrawn (v1.1)** — B3: Kassenbuch/Kassenbericht reports. Replaced by CSH-030 | — | — | — |
| CSH-012 | **Withdrawn (v1.1)** — B3: archiving cash books | — | — | — |
| CSH-013 | **Withdrawn (v1.1)** — B3: seq-order vs date-order cash-book balance | — | — | — |
| CSH-020 | **One cash account**: role `cash` (SKR03 1000 / SKR04 1600), EUR only; its opening balance (counted cash) is entered as an F08 opening balance. The page „Kasse“ shows the current balance and the chronological movement list with running balance, derived from the journal; there are no registers, no cash book, no daily close | MUST | P1 | AO-05 |
| CSH-021 | **Cash receipt on an invoice** („Bar bezahlt“, F05 PAY-061, payment with `source.kind = "cash"`): payment date ≤ today (Europe/Berlin); **warning** if more than 1 day in the past: „Bareinnahmen sind täglich aufzuzeichnen (§ 146 Abs. 1 S. 2 AO). Bitte künftig am Tag der Zahlung erfassen.“; **reason mandatory** (≥ 5 characters, audited, `backdateReason`) if more than 10 days in the past; never into a locked period (EC-170); amount > 0 (an excess over the open amount becomes a credit balance per F05 PAY-030); optional note. Posts S `cash` · H `receivable` (F08 §4.2.2 P3). The payment and its journal entry are written in one transaction | MUST | P1 | AO-05, GOBD-04, GOBD-06 |
| CSH-022 | **Purchase voucher paid „bar“** (F06 VOU-137): payment with `source.kind = "cash"` and the same dating rules as CSH-021; posts S payable/expense · H `cash`; subject to CSH-026 — if the balance is insufficient, the error suggests „privat bezahlt“ (CSH-023) | MUST | P2 | AO-05, GOBD-07 |
| CSH-023 | **Purchase voucher „privat bezahlt“** (Privateinlage, F06 VOU-138): payment with `source.kind = "private"`, no cash movement; posts against `private.deposit` (SKR03 1890 / SKR04 2180); for corporations against `shareholder.clearing` (Verrechnungskonto Gesellschafter from the mapping) | MUST | P2 | AO-01, GOBD-07 |
| CSH-024 | **„Bargeld eingezahlt / entnommen“** (one dialog, `cashTransfers`): `deposit_to_bank` — cash → Geldtransit (S `transit` · H `cash`); the later bank credit is matched to the open transit (BNK-061); `private_withdrawal` — S `private.withdrawal` (SKR03 1800 / SKR04 2100) · H `cash`; for corporations blocked (EC-BNK-21 analogue) → `shareholder.clearing`. An Eigenbeleg PDF is generated and archived with hash. Same dating rules as CSH-021; subject to CSH-026; postings F08 §4.2.4 T5/T8; a deposit pairs only with a bank credit of exactly the same amount (F08 E-ACC-31) | MUST | P1 | AO-05, GOBD-07 |
| CSH-025 | **Bank cash withdrawal into the till** (ATM): marking a booked bank debit „Bargeldabhebung in die Kasse“ creates a `cashTransfers` row `bank_withdrawal_to_cash` and posts S `cash` · H bank (via `transit`, F08 T9) on the bank booking date; an ATM fee is booked as bank fee (F08 R5). Alternatively the debit is marked Privatentnahme (BNK-060) | MUST | P1 | AO-05, GOBD-03 |
| CSH-026 | **Never negative at any date** (AO-05, RI-11): the balance of the `cash` account, ordered by `(date, journal seq)`, must be ≥ 0 at every date, including the effect of backdated entries on all later dates (algorithm §4.7). Applies to cash payments of vouchers, refunds paid in cash, transfers out and reversals of cash receipts. Checked inside the serialisable Convex mutation, so concurrent entries cannot jointly break it (EC-149, EC-151) | MUST | P1 | AO-05, RI-11 |
| CSH-027 | **Corrections only by reversal**: a cash payment is corrected by the F05 payment reversal (PAY-040/041), a `cashTransfers` row by a reversal row (`reversalOfId`, negated journal entry, reason, dated today or the original date if its period is open); every reversal is subject to CSH-026; postings F08 T10. No update or delete (GOBD-06) | MUST | P1 | AO-05, GOBD-06 |
| CSH-028 | **Quittung** (optional, „Quittung drucken“ on a cash payment, F05 PAY-063): A5/A4 PDF with business name and address, „Quittung“, receipt number = payment reference, date, payer (contact), amount in figures and words, „für Rechnung {number} vom {date}“, „Betrag bar erhalten“, place/date and a signature line; generated from immutable payment data, archived with sha256 on first generation (`payments.receiptFile`, set once); every later print carries „Kopie“. The Quittung is not a tax invoice (it references the invoice) | SHOULD | P1 | GOBD-07 |
| CSH-029 | **No POS** (AO-04): there is no cash sale without an issued invoice (Kleinbetragsrechnung allowed, UST-14); no API, MCP or UI path records cash income without an invoice. The Kasse page states „Kein Kassensystem (keine Registrierkasse, keine TSE) – Bareinnahmen nur zu Rechnungen“ | MUST | P1 | AO-04 |
| CSH-030 | **Cash report**: chronological list of cash movements with running balance for a period (date, Beleg/Rechnungsnummer, text, Einnahme, Ausgabe, Bestand, Gegenkonto) as PDF/CSV, generated from the journal (F08 Kontenblatt of the `cash` account) | SHOULD | P1 | AO-05, GOBD-11 |

### 3.8 Events

| ID | Requirement | Priority | Phase | Compliance refs |
|---|---|---|---|---|
| BNK-080 | Outbound events (05 §5.3, outbox): `bank_transaction.imported`, `bank_transaction.matched`, `bank_transaction.reversal_linked`, `bank_consent.expiring` (T−14/−3/0), `bank_consent.expired`, `bank_statement.reconciled`, `cash_movement.recorded` | MUST | P1 | — |

---

## 4. Workflows and state machines

### 4.1 Enable Banking consent (`bankConnections.status`)

```
not_configured ──setup (BNK-101)──▶ pending_consent ──callback ok + backfill (BNK-102/103)──▶ active
active ──T−14 / T−3 / T−0 reminders──▶ active (banner "läuft ab")
active ──validUntil reached │ EXPIRED_SESSION │ 401/403 │ revoked──▶ reauth_required ──"Neu verbinden"──▶ pending_consent
active ──429──▶ active (account backoff 6 h)      active ──5xx/outage──▶ error (retry within budget) ──ok──▶ active
any ──disconnect (BNK-011) │ feed lost (BNK-117)──▶ disconnected   (accounts continue with statement import)
```

### 4.2 Transaction lifecycle

```
feed PDNG ──▶ bankPendingTransactions (provisional, replaced every poll, never booked)
feed BOOK │ CAMT/MT940/CSV entry ──normalise──▶ dedupe (BNK-109) ──▶ cross-source match (BNK-110)
      ├─ unique match ──▶ append to sources[] (no new row)
      ├─ ambiguous ──▶ "Mögliche Dubletten" (owner decides)
      └─ new ──▶ bankTransactions (immutable) ──▶ rules (P2) ──▶ scoring ──▶ open → matched | partially_matched | booked | private | transfer | ignored(reason)
counter-entry detected (BNK-121) ──owner confirms──▶ reversalOfId linked ──▶ F05 reversal of allocations
```
Booking (journal) happens only for booked rows, dated by the Europe/Berlin booking date.

### 4.3 Poll run (pseudo, `bank.sync` every 6 h)

```
for connection in active connections:
  for account in mapped accounts:
    if now < account.backoffUntil or budget(account, "transactions").used ≥ 4 in 24 h: skip
    rows = fetchTransactions(uid, date_from = lastBookedDate − 10d, strategy=default)  (all pages, counts once)
    on 429: account.backoffUntil = now + 6 h; continue      on EXPIRED_SESSION/401: status = reauth_required; break
    replace bankPendingTransactions(account, window) with rows where status = PDNG
    for r in rows where status = BOOK: insertOrMerge(normalise(r))   (BNK-109/110/113)
    once per day: balances = fetchBalances(uid); continuity check (BNK-035)
  lastSuccessfulPollAt = now
```

### 4.4 Matching score (weights; `src/domain/banking/match.ts`)

| Signal | Reason code | Weight |
|---|---|---|
| Valid ISO 11649 RF creditor reference in the reference/purpose that maps to the document | `rf_reference` | **1.00** (deterministic) |
| Document number (or voucher's supplier document number) found as a token in reference/purpose (normalised: case, spaces, `-`/`/` variants, leading zeros) — **primary rule** | `number_in_purpose` | 0.50 |
| Amount = open amount (in transaction currency, or the original/instructed amount = open in document currency) | `exact_amount` / `bill_amount` | 0.40 |
| Amount = open − agreed Skonto, within Skonto period | `skonto_amount` | 0.35 |
| Existing unreconciled manual payment with the same amount ±0, date ±3 days | `existing_manual_payment` | 0.45 |
| Recurring voucher expected (amount ±5 %, date ±5 days, creditor/mandate/merchant) | `recurring_expected` | 0.25 |
| Known IBAN (counterparty IBAN from the feed or statement equals a contact IBAN or learned alias) | `known_iban` | 0.20 |
| Name similarity (Jaro-Winkler on normalised names; counterparty name from feed/statement or parsed from the description; card: merchant name; contact aliases included) ≥ 0.85 → linear 0.85…1.0 ↦ 0.05…0.15 | `name_similarity` | ≤ 0.15 |
| Amount within tolerance (≤ 1 % or ≤ 2,00 €, e.g. foreign bank fees) | `amount_tolerance` | 0.15 |
| Amount < open with number match | `partial` | 0.10 |
| Booking date within [document date − 3 days, due date + 45 days] | `date_window` | 0.05 |
| Booking date > 180 days outside the window | — | −0.30 |
| Rule action `link_contact` matched | `rule` | sets name similarity to full 0.15 |
| Second-best within 0.05 | `ambiguous` | cap at 0.90 |

**Worked examples:**

| # | Situation | Score | Outcome |
|---|---|---|---|
| M1 | Incoming 1.190,00, reference "RE-2026-01042", open 1.190,00, counterparty "MUELLER GMBH" (sim 0.93) | 0.50 + 0.40 + 0.11 + 0.05 = **1.00** (cap) | auto-applied |
| M2 | Incoming 1.190,00, reference "Rechnung 1042" (number token without prefix matches uniquely), no name | 0.50 + 0.40 + 0.05 = **0.95** | safe, bulk-confirmable, not auto |
| M3 | Incoming 1.166,20 (2 % Skonto) with number, in period | 0.50 + 0.35 + 0.05 = **0.90** | suggestion with Skonto difference |
| M4 | Incoming 500,00 with number, open 1.190,00 | 0.50 + 0.10 + 0.05 = **0.65** | „Teilzahlung“ suggestion |
| M5 | Incoming 2.380,00, reference "RE-1042 RE-1043" each 1.190,00 | combined: 0.50 + 0.40 + 0.05 = **0.95** | combined suggestion, never auto |
| M6 | Incoming 1.190,00, no number, two open invoices of 1.190,00 from different customers | 0.40 + 0.05 = 0.45, ambiguous | weak suggestion listing both |
| M7 | Card −12,05 € with original amount −13,00 USD, merchant "Acme Corp." = supplier, voucher 13,00 USD | 0.40 (bill) + 0.15 + 0.05 = **0.60** | suggestion |
| M8 | Incoming 1.190,00, no number in the reference, counterparty IBAN from the feed = contact IBAN, open 1.190,00 | 0.40 + 0.20 + 0.05 = **0.65** | suggestion (never auto without number/RF) |

### 4.5 Geldtransit and exchange posting (F08 §4.2.7 is authoritative)

```
(a) Exchange EUR→USD arrives as two booked transactions (EUR account −920,00 EUR; USD account +1.000,00 USD, same date):
    paired by BNK-061 (same booking date, exchange rate / EUR value)
    1360 Geldtransit  920,00 S / 1200 Bank EUR     920,00 H
    1210 Bank USD     920,00 S / 1360 Geldtransit  920,00 H      (memo 1.000,00 USD; lot cost rate 0,92)
    → no FX result at purchase; USD pocket moving-average cost = 0,92 EUR/USD
(b) Later exchange USD→EUR: −500,00 USD → +465,00 EUR
    book value of 500 USD at moving average = 460,00 EUR
    1360 Geldtransit  465,00 S / 1210 Bank USD     460,00 H ; income.fx_gain 5,00 H
    1200 Bank EUR     465,00 S / 1360 Geldtransit  465,00 H
A fee (own transaction or fee field) is an extra line: expense.bank_fees S / bank ledger H (no VAT).
(c) Cash deposit: 1360 Geldtransit 200,00 S / 1000 Kasse 200,00 H (CSH-024); bank credit: 1200 Bank 200,00 S / 1360 200,00 H
```
(SKR03 defaults shown; moving-average method is the decided default, F08.)

### 4.6 Statement import and reconciliation

```
upload CAMT.053 (+ signed PDF) for account A, period P → sha256 per file; same file twice → warning, 0 inserted
parse: opening (OPBD/PRCD), closing (CLBD), BOOK entries; RvslInd → reversal candidates (BNK-121)
normalise → dedupe (BNK-109/034) → cross-source match against feed rows (BNK-110) → insert new rows
booked balance at period end instant (UTC end of P) = opening balance + Σ booked amounts with booking instant < end
compare closing vs booked balance → equal: reconciled ✓ ; else list entries in file not in DB / in DB not in file
continuity: opening == previous statement's closing (BNK-035)
store bankStatements (files, balances, reconciled, differences; retention vouchers8)
```

### 4.7 Cash never-negative algorithm (`src/domain/cash/check.ts`, pure)

```
movements of the cash account sorted by (date, seq); balances B_0 = opening balance, B_k = B_{k-1} + a_k
insert new movement x (date d, amount a) at position p = after last movement with date ≤ d
if a ≥ 0: ok
else: require  B_{p-1} + a ≥ 0  and  for all k ≥ p: B_k + a ≥ 0   (i.e. a ≥ −min(B_{p-1}, min_{k≥p} B_k))
error reports the first date where the balance would become negative and the shortfall
```
**Golden (AO-05):** C1 opening 100,00, voucher paid bar 150,00 → blocked (shortfall 50,00). C2 opening 100,00 on 2026-10-01; private withdrawal 80,00 on 2026-10-05; backdated voucher paid bar 50,00 on 2026-10-03 → blocked („am 05.10.2026 −30,00“). C3 as C2 plus cash receipt 100,00 on 2026-10-06; the 2026-10-03 payment is still blocked (the dip on 10-05 is not cured by a later inflow). C4 opening 15,00; same day cash receipt +20,00 then deposit to bank −30,00 → ok (5,00). C5 a cash receipt of 100,00 on 2026-10-01 is reversed on 2026-10-12 while the balance on 10-12 is 20,00 → the reversal (−100,00) is blocked.

### 4.8 Cross-source dedupe decision (`src/domain/banking/dedupe.ts`, pure)

```
input: candidate row c (account A), existing rows E of A with |bookingDate − c.bookingDate| = 0
1. same dedupeKey in E                              → duplicate (same source re-delivery): append revision only
2. same bank transaction ID in any sources[] of E    → same booking: append c.source to sources[]
3. E' = rows of E with contentHash == c.contentHash and not already linked to a source of c.kind
     |E'| == 1 and occurrence counts equal          → same booking: append c.source
     |E'| == 0                                      → new row
     otherwise                                      → review list "Mögliche Dubletten" (nothing inserted)
4. balance check (BNK-035) after the batch; mismatch → affected rows to review
```

### 4.9 Data-model changes (merged into 03 §1, §5, §7 in v1.1)

| # | Table / field | Change | Why |
|---|---|---|---|
| D-01 | `bankTransactions.dedupeKey` | `{accountId}:er:{entryReference}` or `{accountId}:h:{contentHash}:{ordinal}`; new `contentHash`, `source`, `sources[]`, `reversalOfId`; Revolut API `provider` object removed | BNK-109, BNK-110, BNK-121 |
| D-02 | `bankPendingTransactions` (new, not protected) | provisional feed rows, replaced each poll | BNK-111 |
| D-03 | `bankConnections` | Enable Banking only: `applicationId`, `encryptedPrivateKeyPem`, `aspsp`, `redirectUrl`, `sessionId`, `validUntil`, `consentReminders[]`, `pendingAuth`, `backfill`, `evaluationConfirmation`; Revolut certificate/token/webhook fields removed | BNK-101…117 |
| D-04 | `bankAccounts` | `kind: "bank" \| "clearing" \| "paypal"`; `feed { connectionId, identificationHash, providerAccountUid, backoffUntil, budget }`; `revolut` removed; `statementFormat` | BNK-001, BNK-104, BNK-106 |
| D-05 | `matchingRules` | `revolutType` → `bankTransactionCode`/`proprietaryCode`; `cashBookId` removed (transfer target `cash`) | BNK-050 |
| D-06 | cash | `cashBooks`, `cashEntries`, `cashDayClosings` removed; `cashTransfers` added; `payments.source` `{ kind: "cash" }` / `{ kind: "private" }`, `backdateReason`, `note`, `receiptFile` | CSH-020…028 |
| D-07 | `bankStatements` | `periodFrom/periodTo` (not only months), `pdf`/`camt`/`other` FileRefs, `importId` | BNK-030 |
| D-08 | 02 §7 crons | `bank.sync` (every 6 h, 05:30/11:30/17:30/23:30 Europe/Berlin), `bank.consentExpiryReminder` (daily 08:00), `bank.statementsTodo` (monthly, 3rd); `revolut.expenses`, IMAP polling and `cash.openDaysReminder` removed; no Revolut webhook route — **done in 02 §7** | BNK-105, BNK-106, BNK-030 |
| D-09 | 05 §5.3 | events in BNK-080 — **owned by 05** | BNK-080 |

### 4.10 P1 implementation notes (statement-import slice, 2026-10-13)

Where the implementation had to decide details the requirements leave open, or deviates, the decision and reason:

| Item | Decision | Reason |
|---|---|---|
| BNK-033 MT940 | Own parser (`src/domain/banking/sources/mt940.ts`), not `mt940js` | The German `:86:` structured subfields, SEPA tags, `RC`/`RD` reversal marks and the year wrap of the entry date are the whole job; a dependency adds nothing and is unmaintained |
| BNK-033 generic CSV | Not in this slice (Revolut CSV only); T07-048 open | The owner banks only with Revolut; the generic mapping UI (6.6 „CSV mapping step“) follows when a second bank appears |
| BNK-032 / research 13 §5 | Revolut CSV mapping is data (`REVOLUT_CSV_MAPPING`, version `revolut-csv-2026.1`), header names case-insensitive, every column marked `unsure: true`; fee semantics are **verified per file** against the `Balance` column and switched if the other reading holds (EC-145) | Q-03 is open until the owner's real export; nothing is guessed silently |
| §4.8 step 2 | A bank-ID match is not limited to the same booking date | CSV timestamps are UTC, CAMT dates are dates: the same booking can land on different Berlin dates around midnight (EC-155) |
| §4.8 step 1 | A hash-keyed (`:h:`) key only counts as „same row“ for the same source kind | Another format's hash key for the same content is the cross-source case of step 3 (occurrence counts), not a re-delivery |
| BNK-034 same file | Preview shows EC-BNK-45; the commit refuses with EC-BNK-42 unless `force`; a forced re-import inserts 0 rows (all duplicates) and archives no second statement | One archived Kontoauszug per file |
| BNK-030 to-do | Derived query (`banking.todos`): info from the 3rd of the next month, warning after the 10th, `pdf_missing` warning, 12-month lookback; no `bank.statementsTodo` job | A stored to-do goes stale; the derivation is a pure function of accounts, statements and today |
| BNK-030 PDF | The signed PDF can be attached at import or later, once (`bankStatements.pdf` set once, `%PDF-` checked) | EC-BNK-52: the PDF often arrives after the CAMT file |
| BNK-030 reconciliation | Stored at import; the statement view recomputes it live against the current rows (after the duplicate review) | A resolved possible duplicate must turn the statement green without a re-import |
| BNK-036 rollback | Also closes the import's open possible duplicates | Nothing of a rolled-back file may stay in the review list |
| BNK-060/061, CSH-025 | Marking posts at once (F08 ACC-024 amended): T1/T2 (`T1-corp`/`T2-corp` with shareholder + note), T4, T9 incl. an ATM fee line; an Eigenbeleg PDF (pdf-lib, `src/pdf/eigenbeleg.ts`) is rendered in the action, archived with sha256 and attached to the journal entry / `cashTransfers.eigenbelegFile`; if the mutation fails the stored PDF is deleted | GOBD-07 (every booking has a voucher); atomic: no half-marked rows |
| BNK-028 | Not implemented: marking Privat/Geldtransit/Kasse is refused on non-EUR accounts („Umsätze in Fremdwährung können erst mit der EUR-Bewertung (Kurs der EZB) gebucht werden.“); „Ignorieren“ is allowed | No EUR value without an ECB rate source; posting a foreign amount as EUR would be wrong |
| BNK-060 corporations | The shipped SKR mapping leaves `shareholder.clearing` unmapped; a GmbH mark with shareholder data fails with `role_unmapped` until the owner/advisor maps it | The Verrechnungskonto is company-specific (F01 SET-045a) |
| BNK-121 | „Als Rückbuchung verknüpfen“ sets `reversalOfId` (candidates: same account, inverse amount, ≤ 60 days, end-to-end ID/reference/purpose); if both rows are open they become a `neutralised_pair` (BNK-063). Reversing an allocated original (F05 reversal) belongs to the matching slice | Matching is a separate P1 slice |
| Matching extension point (BNK-040…049) | Query `banking:unmatched` → `UnmatchedTransaction[]` (`src/domain/banking/match-types.ts`); `applyAllocation(ctx, { transactionId, deltaCents })` in `convex/model/bankTransactions.ts` is the only write path for `allocatedCents`/allocation status; `MatchCandidateProvider` type for the scorer | Keeps BNK-122 enforceable in one place |
| Parsing location | Files are uploaded to storage; the actions read and decode them (UTF-8 or Windows-1252), hash them and pass the text to the plan query / commit mutation, which re-checks the hash against the stored file | Only actions can read file storage; the archived file is provably the parsed one (GOBD-20) |


---

## 5. Validation rules and edge cases (exhaustive; exact German error/warning messages)

**E** = blocking, **W** = warning (⚑ must be acknowledged). Global IDs from [10-edge-cases](../10-edge-cases.md) in the Ref column.

### 5.1 Feed connection and polling

| ID | Case | Rule / behaviour | Sev | Message (de) | Ref |
|---|---|---|---|---|---|
| EC-BNK-01 | **Withdrawn (v1.1)** — B1: Revolut consent code expiry. See EC-BNK-80 | — | — | — | — |
| EC-BNK-02 | **Withdrawn (v1.1)** — B1: Revolut WRITE/PAY scopes (PSD2 account information is read-only by construction) | — | — | — | — |
| EC-BNK-03 | **Withdrawn (v1.1)** — B1: Revolut JWT `iss`/ClientID mismatch. See EC-BNK-81 | — | — | — | — |
| EC-BNK-04 | **Withdrawn (v1.1)** — B1: Revolut refresh token invalid. See EC-BNK-82 | — | — | — | — |
| EC-BNK-05 | **Withdrawn (v1.1)** — B1: concurrent Revolut token refresh | — | — | — | — |
| EC-BNK-06 | Provider 5xx / outage for days | Retries within the 4/day budget; on recovery the window covers the whole gap + 10 days; gaps > 90 days → to-do „Kontoauszug importieren“; continuity check confirms completeness | W | „Enable Banking nicht erreichbar seit {time}. Wird automatisch wiederholt; fehlende Zeiträume bitte per Kontoauszug importieren.“ | EC-147 |
| EC-BNK-07 | **Withdrawn (v1.1)** — B1: Revolut webhook signature (no webhooks) | — | — | — | — |
| EC-BNK-08 | **Withdrawn (v1.1)** — B1: duplicate Revolut webhook delivery. See EC-BNK-85 | — | — | — | — |
| EC-BNK-09 | **Withdrawn (v1.1)** — B1: Revolut webhook ordering | — | — | — | — |
| EC-BNK-10 | **Withdrawn (v1.1)** — B1: Revolut `updated_at` ordering. See EC-BNK-15 | — | — | — | — |
| EC-BNK-11 | **Withdrawn (v1.1)** — B1: Revolut `created_at` page cursor | — | — | — | — |
| EC-BNK-12 | Pending item is booked with a different amount (FX settlement, tip) | The pending row disappears, the booked row is inserted with its own amount; a suggestion shown on the pending row is re-scored; no auto-apply based on the pending amount | — | — | EC-140 |
| EC-BNK-13 | Pending item never gets booked | It vanishes from the next poll; never booked; nothing to reverse | — | — | EC-153 |
| EC-BNK-14 | Booked transaction reversed by the bank after match/booking | Counter-entry detected (BNK-121); owner confirms; allocations reversed, invoice/voucher reopens; notification | W | „Die Bank hat die Buchung vom {date} ({amount}) zurückgebucht. Bitte bestätigen – die Zuordnung zu {number} wird dann zurückgebucht.“ | EC-141, EC-129 |
| EC-BNK-15 | A source re-delivers a booked row with different amount/date/counterparty | Not applied; revision `applied: false`; integrity finding; manual resolution | E | „Die Bank hat eine bereits gebuchte Umsatzzeile geändert ({field}). Bitte prüfen – keine automatische Änderung.“ | GOBD-06 |
| EC-BNK-16 | **Withdrawn (v1.1)** — B1: declined/failed Revolut authorisations (not delivered as booked items) | — | — | — | — |
| EC-BNK-17 | `balance_after_transaction` continuity break | Warning with range and difference; rows stay; RI-27 WARN; to-do to import the statement for the range | W | „Saldenlücke im Konto {account} zwischen {date1} und {date2}: Differenz {diff}.“ | GOBD-02, RI-27 |
| EC-BNK-18 | Daily balances ≠ Σ booked amounts | Warning; next owner-present fetch re-reads 90 days; to-do statement import | W | „Kontostand laut Bank ({provider}) weicht vom gebuchten Stand ({ours}) ab.“ | RI-27 |
| EC-BNK-19 | Booking just after midnight UTC on the last day of a month (Berlin = next month / vice versa); DST days | Booking date = Europe/Berlin date (BNK-112); statements compared on UTC instants | — | — | EC-155, GOBD-22 |
| EC-BNK-20 | Exchange into a currency account that is not mapped/imported | Own side booked as Geldtransit; warning to add the other account | W | „Gegenbuchung in einem nicht übernommenen Konto ({currency}). Bitte Konto übernehmen.“ | GOBD-02 |
| EC-BNK-21 | Private marking for a corporation | Blocked | E | „Kapitalgesellschaften haben kein Privatkonto. Bitte ‚Verrechnungskonto Gesellschafter‘ verwenden.“ | AO-01 |
| EC-BNK-22 | Incoming transfer without payer IBAN/name | Matching via number + amount; name parsed from the description if present; enrichment by a later source | — | — | EC-152 |
| EC-BNK-23 | Amount literal with more decimals than the currency exponent | Rejected row, import/poll continues, finding | E | „Ungültiger Betrag in Bankdaten ({value}).“ | GOBD-03 |
| EC-BNK-24 | Currency with exponent 0 or 3 (JPY, KWD) | Minor units per ISO 4217 | — | — | GOBD-03 |
| EC-BNK-25 | Fee as a field of a transaction | Separate bankFees booking line; principal matched separately | — | — | EC-145 |
| EC-BNK-26 | Exchange between own pockets | Geldtransit, never revenue/expense; EUR→foreign: lot cost = EUR side (no FX result); foreign→EUR or spending: realised FX vs moving-average cost to FX gain/loss | — | — | EC-144 |
| EC-BNK-27 | Card refund without a link to the original | Matched by merchant + amount; suggestion only | — | — | GOBD-03 |
| EC-BNK-28 | Bank plan fee transaction | Rule suggestion: bankFees, no VAT, no §13b; statement as Beleg | — | — | EC-164 |
| EC-BNK-29 | Sandbox connection while production active | Separate; banner; sandbox transactions excluded from reports | W | „Sandbox-Daten – nicht in der Buchhaltung berücksichtigt.“ | — |
| EC-BNK-30 | **Withdrawn (v1.1)** — B1: Revolut webhook delivery failures | — | — | — | — |
| EC-BNK-80 | Callback with missing/expired/reused `state` or Enable Banking error | Rejected, nothing stored; restart consent | E | „Die Bankfreigabe konnte nicht abgeschlossen werden (Sitzung abgelaufen oder ungültig). Bitte ‚Neu verbinden‘ erneut ausführen.“ | SEC-06 |
| EC-BNK-81 | Enable Banking rejects the application JWT (wrong application ID / key) | Error with hint; status `error` | E | „Enable Banking hat die Anmeldung abgelehnt: Anwendungs-ID und Schlüssel prüfen.“ | — |
| EC-BNK-82 | Consent expired, revoked or `EXPIRED_SESSION` | `reauth_required`, polling paused, banner + notification | W | „Bankverbindung muss erneuert werden. Seit {time} werden keine Umsätze abgerufen – Kontoauszug-Import bleibt möglich.“ | EC-158 |
| EC-BNK-83 | Consent expires in 14 / 3 / 0 days | Reminder notification + banner (once per threshold) | W | „Bankverbindung läuft am {date} ab. Bitte jetzt erneuern.“ | EC-158 |
| EC-BNK-84 | After renewal the account `uid`s differ | Re-mapped by IBAN / identification hash; no new accounts, no duplicates | — | — | EC-159 |
| EC-BNK-85 | Overlapping poll windows deliver the same booked rows again | Idempotent by `dedupeKey`; nothing inserted twice | — | — | EC-157 |
| EC-BNK-86 | `429 ASPSP_RATE_LIMIT_EXCEEDED` or unattended budget used up | No further unattended fetch for 6 h / until the budget frees; next poll continues | W | „Abruflimit der Bank erreicht – nächster automatischer Abruf ab {time}.“ | EC-191 |
| EC-BNK-87 | „Jetzt abrufen“ requested via API key or MCP | Rejected `owner_presence_required` | E | „Ein manueller Abruf ist nur in der Oberfläche möglich, solange Sie angemeldet sind.“ | SEC-02 |
| EC-BNK-88 | Backfill in the callback times out or the bank returns only 90 days | Callback completes; to-do for older history via statement import | W | „Ältere Umsätze konnten nicht abgerufen werden. Bitte Kontoauszüge für {from}–{to} importieren.“ | EC-193 |
| EC-BNK-89 | Row without `entry_reference`, two identical transactions on the same day | Content hash + ordinal; balance continuity confirms the count; mismatch → review | W | „{n} gleichartige Umsätze am {date} – bitte prüfen, ob es Dubletten sind.“ | EC-192 |
| EC-BNK-90 | Enable Banking ends restricted mode / feed permanently unavailable | Disconnect, statement import continues; dashboard notice | W | „Bankdaten nur per Kontoauszug-Import – die automatische Verbindung ist nicht mehr verfügbar.“ | EC-194 |
| EC-BNK-91 | New currency pocket appears in the consent | Prompt to map; until mapped, its rows are not imported | W | „Neues Konto gefunden ({currency}) – übernehmen?“ | GOBD-02 |
| EC-BNK-92 | A previously linked account is missing from the renewed consent | Warning; account continues by statement import | W | „Konto {name} ist in der neuen Freigabe nicht enthalten. Bitte bei der Erneuerung auswählen oder Kontoauszüge importieren.“ | GOBD-02 |

### 5.2 Statements and file imports

| ID | Case | Rule / behaviour | Sev | Message (de) | Ref |
|---|---|---|---|---|---|
| EC-BNK-40 | Monthly statement missing after the 10th | To-do escalates to warning | W | „Kontoauszug {Monat} für {Konto} fehlt.“ | EC-156 |
| EC-BNK-41 | Statement closing ≠ booked balance | Not reconciled; difference list | W | „Kontoauszug {Monat} stimmt nicht mit den Umsätzen überein: Differenz {diff} ({n} Abweichungen).“ | EC-156, GOBD-02 |
| EC-BNK-42 | Same statement file uploaded twice | Rejected by hash | E | „Dieser Kontoauszug wurde bereits hochgeladen ({date}).“ | GOBD-02 |
| EC-BNK-43 | Statement overlaps feed data | Rows matched cross-source are appended as sources, not inserted | — | Import summary „{x} neu, {y} bereits vorhanden“ | EC-148 |
| EC-BNK-44 | CSV without ID column and without balances | Content hash; possible duplicates go to the review list | W | „Ohne Transaktions-ID können Dubletten nicht sicher erkannt werden. {n} mögliche Dubletten zur Prüfung.“ | EC-148 |
| EC-BNK-45 | Same file re-imported | 0 inserted, warning | W | „Diese Datei wurde bereits importiert ({date}).“ | GOBD-02 |
| EC-BNK-46 | Two genuine identical transactions in one file | Both kept via occurrence index | — | — | GOBD-02 |
| EC-BNK-47 | File opening balance ≠ previous closing | Continuity warning (gap) | W | „Anfangssaldo ({opening}) passt nicht zum letzten Endsaldo ({closing}) – fehlen Umsätze zwischen {d1} und {d2}?“ | GOBD-02 |
| EC-BNK-48 | camt entry `Sts` ≠ BOOK or `RvslInd = true` | Pending not imported; reversal entries imported as negative and offered as reversal link (BNK-121) | — | — | GOBD-02 |
| EC-BNK-49 | Unknown encoding / malformed file | Rejected with line number | E | „Die Datei konnte nicht gelesen werden (Zeile {n}: {error}).“ | GOBD-03 |
| EC-BNK-50 | Import rollback with allocated rows | Blocked | E | „Der Import enthält bereits zugeordnete Umsätze und kann nicht zurückgenommen werden.“ | GOBD-06 |
| EC-BNK-51 | Import into an account whose period is locked | Rows imported (bank data), but bookings land in the first open period | W | „Umsätze aus festgeschriebenem Zeitraum {MM/YYYY} werden im Zeitraum {open} gebucht.“ | GOBD-06, EC-170 |
| EC-BNK-52 | Statement period without the signed PDF | Imported; to-do „PDF-Kontoauszug fehlt“ until attached | W | „Für {Monat} fehlt der signierte PDF-Kontoauszug.“ | GOBD-07 |
| EC-BNK-53 | File belongs to a different account (IBAN/currency in the file ≠ selected account) | Blocked | E | „Die Datei gehört zu Konto {iban} ({currency}), nicht zu {account}.“ | GOBD-02 |

### 5.3 Matching and marking

| ID | Case | Rule / behaviour | Sev | Message (de) | Ref |
|---|---|---|---|---|---|
| EC-BNK-60 | Confirm on a pending (provisional) item | Rejected; shown as „vorgemerkt“ | E | „Die Buchung ist noch vorgemerkt. Die Zuordnung ist erst nach der Buchung durch die Bank möglich.“ | RI-10 |
| EC-BNK-61 | Allocations exceed transaction amount | Rejected (F05 EC-PAY-02) | E | „Die Zuordnungen übersteigen den Betrag des Umsatzes.“ | RI-10 |
| EC-BNK-62 | Concurrent confirmations of the same transaction | One succeeds | E | „Dieser Umsatz wurde soeben anderweitig zugeordnet.“ | GOBD-02 |
| EC-BNK-63 | Ambiguous best candidate | Capped, never auto | — | Chip „mehrdeutig“ | GOBD-03 |
| EC-BNK-64 | Transaction amount > open of the matched invoice | F05 PAY-030 excess handling (credit balance) | — | — | EC-120 |
| EC-BNK-65 | Match to a cancelled invoice | Not a candidate; manual attempt rejected | E | „Stornierte Rechnungen können nicht zugeordnet werden.“ | EC-121 |
| EC-BNK-66 | Auto-applied match turns out wrong | „Rückgängig“ = reversal (no delete) | — | — | GOBD-06 |
| EC-BNK-67 | Ignore a booked transaction without allowed reason | Blocked | E | „Gebuchte Bankbewegungen müssen gebucht werden. Ignorieren ist nur für Dubletten aus Dateiimporten oder neutralisierte Hin-/Rückbuchungen möglich.“ | GOBD-02 |
| EC-BNK-68 | Geldtransit without counterpart for > 7 days | Warning | W | „Geldtransit vom {date} über {amount} ohne Gegenbuchung.“ | GOBD-03 |
| EC-BNK-69 | Geldtransit to an own account in another currency without EUR value | Uses the EUR side / ECB rate | — | — | MISC-08 |
| EC-BNK-70 | Rule regex invalid or catastrophic | Rejected at save (RE2 engine, length limit) | E | „Ungültiger regulärer Ausdruck: {error}.“ | — |
| EC-BNK-71 | Rule would act on a pending item | Not applied (pending items are not in the books) | — | — | RI-10 |
| EC-BNK-72 | Rule `categorize` auto without „Kontoauszug genügt“ | Creates draft flagged „Beleg fehlt“ | W | „Beleg fehlt für automatisch kategorisierten Umsatz {date} {amount}.“ | GOBD-07 |
| EC-BNK-73 | Rule created via MCP set to auto | Stored as suggest | W | „Regeln aus API/MCP werden als Vorschlagsregel gespeichert. Automatik bitte in der Oberfläche aktivieren.“ | SEC-02 |
| EC-BNK-74 | Unmatch when the payment period is locked | Reversal dated today | W | „Zeitraum festgeschrieben – Rückbuchung erfolgt mit heutigem Datum.“ | GOBD-06, EC-170 |
| EC-BNK-75 | Loan repayment principal > transaction amount | Blocked | E | „Der Tilgungsanteil übersteigt den Zahlbetrag.“ | GOBD-03 |
| EC-BNK-76 | Foreign card payment matched to EUR voucher | FX difference via F05 PAY-018 mirrored | — | — | MISC-08 |
| EC-BNK-77 | Two candidate rows for the same booking from feed and statement (cross-source ambiguous) | Nothing inserted; review list; owner decides „gleiche Buchung“ / „eigene Buchung“ | W | „Möglicherweise doppelt: {date} {amount} aus {source1} und {source2}.“ | EC-148 |
| EC-BNK-78 | Counter-entry looks like a reversal but the original is in a locked period | Link allowed; the F05 reversal is dated today (else the counter-entry date) | W | „Zeitraum der ursprünglichen Buchung festgeschrieben – Rückbuchung mit heutigem Datum.“ | GOBD-06 |

### 5.4 Cash

| ID | Case | Rule / behaviour | Sev | Message (de) | Ref |
|---|---|---|---|---|---|
| EC-CSH-01 | Movement would make the cash balance negative (now) | Blocked | E | „Der Kassenbestand würde negativ werden ({balance} am {date}). Bitte zuerst fehlende Bareinnahmen erfassen oder ‚privat bezahlt‘ wählen.“ | AO-05, RI-11 |
| EC-CSH-02 | Backdated outflow causes a dip on a later date | Blocked, first negative date shown | E | „Nicht möglich: Durch die Buchung zum {d} wäre der Kassenbestand am {d2} negativ ({balance}).“ | AO-05, EC-149 |
| EC-CSH-03 | Later inflow does not cure an earlier dip | Still blocked | E | (as EC-CSH-02) | AO-05, EC-149 |
| EC-CSH-04 | Reversal of a cash receipt would make the balance negative | Blocked | E | „Storno nicht möglich: Der Kassenbestand würde am {date} negativ werden.“ | AO-05 |
| EC-CSH-05 | **Withdrawn (v1.1)** — B3: entry on a closed cash day (no daily close) | — | — | — | — |
| EC-CSH-06 | Cash movement dated in the future or before the cash opening-balance date | Blocked | E | „Das Datum muss zwischen dem Anfangsbestand der Kasse ({opening}) und heute liegen.“ | AO-05 |
| EC-CSH-07 | Edit or delete a cash payment / cash transfer (any channel) | 405/409 `immutable_record` | E | „Barzahlungen und Kassenbewegungen sind unveränderbar. Bitte stornieren.“ | AO-05, GOBD-06 |
| EC-CSH-08 | Concurrent movements jointly negative | Serializable re-check; one aborted | E | „Der Kassenbestand hat sich geändert. Bitte erneut versuchen.“ | EC-151 |
| EC-CSH-09 | Cash movement without invoice/voucher/Eigenbeleg | Not possible (every path references one; transfers generate an Eigenbeleg) | E | „Jede Kassenbewegung braucht einen Beleg (Rechnung, Beleg oder Eigenbeleg).“ | GOBD-07 |
| EC-CSH-10 | Cash sale without invoice | Not offered; API rejects | E | „Bareinnahmen ohne Rechnung sind nicht vorgesehen (keine Kassenfunktion). Bitte zuerst eine Rechnung erstellen.“ | AO-04 |
| EC-CSH-11 | **Withdrawn (v1.1)** — B3: daily close counted ≠ book | — | — | — | — |
| EC-CSH-12 | **Withdrawn (v1.1)** — B3: chronological daily close | — | — | — | — |
| EC-CSH-13 | **Withdrawn (v1.1)** — B3: open-days reminder | — | — | — | — |
| EC-CSH-14 | **Withdrawn (v1.1)** — B3: cash-book opening balance change (opening balances are F08) | — | — | — | — |
| EC-CSH-15 | Deposit to bank recorded, bank credit not yet booked | Transit stays open; after 7 days EC-BNK-68 warning | W | „Bareinzahlung vom {date} ({amount}) noch nicht auf dem Bankkonto gefunden.“ | GOBD-02 |
| EC-CSH-16 | **Withdrawn (v1.1)** — B3: two cash books with the same ledger account | — | — | — | — |
| EC-CSH-17 | **Withdrawn (v1.1)** — B3: archiving a cash book | — | — | — | — |
| EC-CSH-18 | Cash payment dated in a locked period | Blocked (F05 EC-PAY-08) | E | „Der Zeitraum {MM/YYYY} ist festgeschrieben.“ | GOBD-06 |
| EC-CSH-19 | Amount 0 | Blocked | E | „Der Betrag muss größer als 0 sein.“ | GOBD-03 |
| EC-CSH-30 | Cash payment/transfer dated more than 1 day in the past | Warning ⚑ (daily-recording duty) | W | „Bareinnahmen und -ausgaben sind täglich aufzuzeichnen (§ 146 Abs. 1 S. 2 AO). Bitte künftig am Tag der Zahlung erfassen.“ | EC-200 |
| EC-CSH-31 | Cash payment/transfer dated more than 10 days in the past without reason | Blocked until a reason (≥ 5 characters) is entered; audited | E | „Die Zahlung liegt mehr als 10 Tage zurück. Bitte eine Begründung für die verspätete Erfassung angeben.“ | EC-200 |
| EC-CSH-32 | Private cash withdrawal for a corporation | Blocked → Verrechnungskonto Gesellschafter | E | „Kapitalgesellschaften haben kein Privatkonto. Bitte ‚Verrechnungskonto Gesellschafter‘ verwenden.“ | AO-01 |
| EC-CSH-33 | Voucher „bar“ while the cash balance is insufficient | Blocked with the hint to choose „privat bezahlt“ | E | „Der Kassenbestand reicht nicht aus ({balance}). Wurde der Beleg privat bezahlt? Dann bitte ‚privat bezahlt‘ wählen.“ | AO-05 |
| EC-CSH-34 | Quittung printed again | Served from the archived file with „Kopie“ stamp | — | — | GOBD-07 |
| EC-CSH-35 | Cash payment on a foreign-currency invoice | Blocked (the cash account is EUR only) | E | „Barzahlungen sind nur in EUR möglich.“ | MISC-08 |

---

## 6. UI

### 6.1 Bank overview (`/bank`)
Cards per account: name, currency, booked balance, pending („vorgemerkt“, feed only), data source badge („Kontoauszug-Import“ / „Enable Banking, zuletzt vor 2 Std.“), continuity badge (✓ / ⚠ Saldenlücke), statement status for last month (✓ abgestimmt / ⚠ fehlt / ⚠ PDF fehlt). Connection banner states: active, expiring (with days left), reauth required (button „Neu verbinden“), error, disconnected. Buttons: „Kontoauszug importieren“ (primary in P1), „Jetzt abrufen“ (P2, signed-in user only, shows remaining unattended budget), „Mögliche Dubletten (n)“.

### 6.2 Account transactions (`/bank/[accountId]`)
Table: Datum (Berlin), Gegenpartei (with source icon: Bank / aus Beschreibung / Kontoauszug), Verwendungszweck, Betrag (+ Originalbetrag in grey for FX, fee as sub-line), Status (offen/zugeordnet/teilweise/gebucht/privat/Geldtransit/ignoriert), Zuordnung (link), Quellen (chips: CAMT, CSV, Feed). Pending items appear in a separate collapsible group „Vorgemerkt (nicht gebucht)“. Filters: status, direction, amount, date, code, „ohne Beleg“. Row detail drawer: sources and raw revisions, allocation history, actions (BNK-046), „Beleg hochladen“.

### 6.3 Zuordnungen (`/bank/zuordnungen`, 04 §4.6)
Tabs: Vorschläge · Automatisch zugeordnet (with Rückgängig) · Rückbuchungen (BNK-121) · Mögliche Dubletten (BNK-110) · Ohne Vorschlag. Cards show transaction ↔ best match(es), score bar, reason chips (German: „Rechnungsnr. im Verwendungszweck“, „Betrag exakt“, „Fremdwährungsbetrag passt“, „Skonto“, „IBAN bekannt“, „Name ähnlich“, „Regel: …“, „mehrdeutig“), differences proposed (Skonto/Teilzahlung). Bulk „Alle sicheren bestätigen (≥ 0,95)“ with confirm dialog showing count and sum. Keyboard `j/k`, `Enter` confirm, `x` reject, `o` other.

### 6.4 Rules (`Einstellungen › Bank › Regeln`, P2)
List by priority (drag to reorder), mode badge (Vorschlag/Automatik), hit count last 90 days; editor with condition builder, action, live preview of matches (BNK-051).

### 6.5 Bank connection (`Einstellungen › Bank › Verbindung`, `/einstellungen/bank/verbindung`; consent callback `/einstellungen/bank/callback`, P2)
Steps per BNK-101/102 with copy buttons and a live checklist; consent validity with countdown („gültig bis 10.04.2027, noch 180 Tage“); field „Schriftliche Bestätigung von Enable Banking“ (status, date, file); „Neu verbinden“, „Trennen“; account mapping table (IBAN, currency, mapped account, last poll, unattended fetches today x/4, backoff until).

### 6.6 Statement import dialog (P1)
Account picker (preselected from the IBAN in the file), drop zone for CAMT.053/MT940/CSV and the signed PDF, CSV mapping step if needed, preview (period, opening/closing balance, n entries, x new / y already present / z possible duplicates, continuity result) before „Importieren“. Mobile: single column; file picker.

### 6.7 Kasse (`/kasse`, P1)
Current balance (large), movement list with running balance (date, Beleg, text, Einnahme, Ausgabe, Bestand), buttons „Bargeld eingezahlt / entnommen“ and „Bericht (PDF/CSV)“. Cash receipts are recorded on the invoice („Zahlung buchen › Bar bezahlt“), voucher cash payments in the voucher (F06). The movement dialog validates never-negative live (shows the projected balance for the following days with the minimum highlighted) and shows the daily-recording warning when the date is in the past. Banner: „Kein Kassensystem – Bareinnahmen nur zu Rechnungen“. Mobile: single column, big amount input (`inputmode="decimal"`).

---

## 7. API and MCP exposure

### 7.1 REST (05 §4.6; changes for the platform agent are listed in the lead's report)

| Method | Path | Scope | Notes |
|---|---|---|---|
| GET | `/bank-accounts`, `/bank-accounts/{id}` | banking:read | Includes balances (booked; pending count), continuity status, data source, last poll |
| POST/PATCH | `/bank-accounts[/{id}]` | banking:write | Create/edit `bank`/`clearing`/`paypal` accounts; feed mapping only in the UI |
| POST | `/bank-accounts/{id}/imports` | banking:write | Multipart: statement file(s) incl. signed PDF; `format: camt053 \| mt940 \| revolut_csv \| csv`, `mapping_id?`, `dry_run?`; returns counts, duplicates, possible duplicates, continuity, reconciliation |
| POST | `/bank-accounts/{id}/imports/{importId}/rollback` | banking:write | BNK-036 |
| GET | `/bank-accounts/{id}/statements` | banking:read | Statements with reconciliation result |
| GET | `/bank-connection` | banking:read | Consent status, `validUntil`, reminders, backoff; no secrets |
| — | `POST /bank-accounts/{id}/sync` | — | **Removed**: a fetch needs the signed-in owner (BNK-107); API answers `409 owner_presence_required` |
| GET | `/bank-transactions` | banking:read | `account_id`, `status`, `source`, `date_from/to`, `q`, `without_voucher` |
| GET | `/bank-transactions/{id}` | banking:read | `expand=sources,revisions,allocations` |
| GET | `/bank-transactions/{id}/suggestions` | banking:read | Scored suggestions with reasons and proposed allocations |
| POST | `/bank-transactions/{id}/match` | banking:write | `{ targets: [{ kind, id, amount_cents, differences? }], acknowledge_warnings? }` → F05 payments |
| POST | `/bank-transactions/{id}/unmatch` | banking:write | `{ reason }` |
| POST | `/bank-transactions/{id}/mark` | banking:write | `{ as: "private" \| "transfer" \| "cash_withdrawal" \| "ignored" \| "loan", counter_account_id?, reason?, principal_cents? }` |
| POST | `/bank-transactions/{id}/reversal-link` | banking:write | `{ original_id }` (BNK-121) |
| POST | `/bank-transactions/duplicates/{id}/resolve` | banking:write | `{ decision: "same" \| "separate" }` (BNK-110) |
| POST | `/bank-transactions/{id}/voucher` | vouchers:write | Creates a prefilled voucher draft (P2) |
| GET/POST/PATCH | `/matching-rules` | banking:write | Created as `mode: "suggest"` via API (BNK-054); `POST /matching-rules/preview` dry run |
| GET | `/cash` | banking:read | Balance and movements with running balance (`from`, `to`) |
| POST | `/cash/transfers` | banking:write | `{ kind: "deposit_to_bank" \| "private_withdrawal", date, amount_cents, bank_account_id?, note?, backdate_reason? }` |
| POST | `/cash/transfers/{id}/reverse` | banking:write | `{ reason }` |
| GET | `/cash/report?from&to&format=pdf\|csv` | banking:read | CSH-030 |
| — | `/cash-books/*`, `POST /api/webhooks/revolut` | — | **Removed** (B3, B1) |

Cash receipts on invoices go through F05 `POST /payments` with `source: { kind: "cash" }`; Quittung via `GET /payments/{id}/receipt.pdf` (F05). Errors: problem+json with rule IDs, e.g. `{ "code": "cash_negative", "rule": "AO-05", "message": "Nicht möglich: Durch die Buchung zum 03.10.2026 wäre der Kassenbestand am 05.10.2026 negativ (−30,00 €)." }`.

### 7.2 MCP (06 §3.7)

| Tool | Type | Notes |
|---|---|---|
| `bank_accounts_list` | R (`readOnlyHint`) | Balances, data source, consent status |
| `bank_transactions_search` | R | Filters as REST; text fields (`purpose`, counterparty) returned as `untrusted_text` |
| `bank_match_suggestions` | R | Returns suggestions + `confirm_token` per suggestion |
| `bank_match_confirm` | ⚠ (`destructiveHint`, `requiresUserInteraction`, `confirm_token` from `preview_action`, 06 §2.3) | Never on pending items |
| `bank_transaction_mark` | ⚠ (token from `preview_action`) | private / transfer / cash_withdrawal / ignored (restricted) / loan |
| `bank_statement_import` | W (dry run by default; commit ⚠ with token from `preview_action`) | Statement file upload |
| `matching_rule_upsert` | W | Always stored as `suggest` mode |
| `cash_transfer_record` | ⚠ (token from `preview_action`) | Never-negative and dating rules apply; returns the projected balance |
| — | — | No fetch/sync tool (BNK-107); `cash_entry_record` removed |

---

## 8. Acceptance tests

Fixtures (07 §3.3): `test/fixtures/bank/enable-banking/` (MSW handlers and recorded sandbox responses: `/aspsps`, `/auth`, `/sessions`, `/accounts/{uid}/transactions` with `BOOK`/`PDNG`, missing `entry_reference`, `continuation_key` paging, `/balances`, `429 ASPSP_RATE_LIMIT_EXCEEDED`, `EXPIRED_SESSION`, re-consent with new `uid`s); `test/fixtures/bank/revolut-statements/` (the owner's real month exported as CSV, CAMT.053, MT940 and PDF, anonymised; synthetic variants for multi-currency, exchange, card FX with fee, reversal); `test/fixtures/bank/generic/` (camt.053 .001.02/.08, MT940, CSV with mappings).

| Test ID | Given / When / Then | Type | Covers req IDs |
|---|---|---|---|
| T07-001 | **Withdrawn (v1.1)** — B1: Revolut certificate wizard. See T07-130 | — | — |
| T07-002 | **Withdrawn (v1.1)** — B1: Revolut code exchange. See T07-131 | — | — |
| T07-003 | **Withdrawn (v1.1)** — B1: Revolut WRITE scope | — | — |
| T07-004 | **Withdrawn (v1.1)** — B1: Revolut consent errors. See T07-132 | — | — |
| T07-005 | **Withdrawn (v1.1)** — B1: Revolut refresh 401. See T07-136 | — | — |
| T07-006 | **Withdrawn (v1.1)** — B1: Revolut single-flight refresh | — | — |
| T07-007 | **Withdrawn (v1.1)** — B1: Revolut account discovery. See T07-134 | — | — |
| T07-008 | **Withdrawn (v1.1)** — B1: Revolut webhook setup | — | — |
| T07-009 | **Withdrawn (v1.1)** — B1: Revolut webhook signature | — | — |
| T07-010 | **Withdrawn (v1.1)** — B1: Revolut signature rotation | — | — |
| T07-011 | **Withdrawn (v1.1)** — B1: Revolut webhook ordering. See T07-140 | — | — |
| T07-012 | **Withdrawn (v1.1)** — B1: Revolut page cursor | — | — |
| T07-013 | **Withdrawn (v1.1)** — B1: Revolut incremental window. See T07-137 | — | — |
| T07-014 | EC-147 / EC-BNK-06: 3-day provider outage (MSW 503) → retries within budget; recovery poll fills the gap with 10-day overlap; continuity ok | C (integration) | BNK-106, EC-147 |
| T07-015 | **Withdrawn (v1.1)** — B1: Revolut 60 req/min budget. See T07-138 | — | — |
| T07-016 | **Withdrawn (v1.1)** — B1: Revolut backfill. See T07-133 | — | — |
| T07-017 | Disconnect revokes the session, deletes session data, keeps all transactions and statements, accounts continue with import; audited | C | BNK-011, GOBD-02 |
| T07-018 | Logs contain no private key, JWT, `code`, session ID or PSU header values (log capture scan) | C | BNK-013, DSGVO-05 |
| T07-020 | **Withdrawn (v1.1)** — B1: Revolut leg identity | — | — |
| T07-021 | EC-BNK-23/24: money parsed from decimal strings: `"-47.8"` → −4780, `"0.30"` exact, JPY exponent 0, KWD exponent 3, MT940 decimal comma; more decimals than the exponent rejected | U (property) | BNK-021, GOBD-03 |
| T07-022 | EC-155 / EC-BNK-19: Revolut CSV „Date completed (UTC)“ 2026-10-31T23:30:00Z → booking date 2026-11-01 (Berlin, CET); 2026-03-28T23:30Z → 2026-03-29; CAMT `BookgDt/Dt` taken as is | U | BNK-112, GOBD-22, EC-155 |
| T07-023 | Normalised mapping golden per source (feed JSON, CAMT entry, MT940 :61:/:86:, Revolut CSV row) → identical `BankTransactionInput` for the same booking | U | BNK-120, BNK-114 |
| T07-024 | EC-145 / EC-BNK-25: card FX row with fee field → principal and fee split per mapper constant; fee booked to bankFees without VAT; continuity holds | U, C | BNK-023, EC-145 |
| T07-025 | RI-10 / EC-BNK-60: pending item not allocatable, not in `bankTransactions`; confirm rejected | C | BNK-111, RI-10 |
| T07-026 | EC-140 / EC-BNK-12: pending −50,00 replaced by booked −52,30 at the next poll → booked row inserted, pending row gone, suggestion re-scored, not auto-applied | C | BNK-111, EC-140 |
| T07-027 | EC-141 / EC-BNK-14: booked+matched transaction, then CAMT counter-entry with `RvslInd` → reversal suggestion; on confirm payment reversed (reversal row), invoice reopened, journal reversal dated the counter-entry date (open period) or today (locked), notification | C | BNK-121, EC-141, GOBD-06 |
| T07-028 | EC-BNK-15: booked row re-delivered with a different amount → not applied, revision `applied: false`, integrity finding | C | BNK-113, GOBD-06 |
| T07-029 | EC-153 / EC-BNK-13: pending item absent from the next poll → removed from the pending store, never booked | C | BNK-111, EC-153 |
| T07-030 | GOBD-06: mutation inventory — booked `bankTransactions` fields outside the BNK-122 whitelist cannot change | C | BNK-122, GOBD-06 |
| T07-031 | Type defaults table test (BTC/CSV `Type` → transit / fee rule / refund match / ATM → cash or private) | U | BNK-027 |
| T07-032 | EC-144 / EC-BNK-26 / EC-BNK-69: §4.5 (a) EUR→USD pair → Geldtransit 0, no revenue/expense, lot cost 920,00; (b) USD→EUR 500 USD → 465,00 EUR with moving-average cost 460,00 → FX gain 5,00 | U, C | BNK-028, BNK-061, EC-144, MISC-08 |
| T07-033 | EC-BNK-20: exchange into a non-mapped account → warning | C | BNK-061 |
| T07-034 | EC-BNK-27: card refund without link → suggestion by merchant + amount only | U | BNK-027 |
| T07-035 | EC-164 / EC-BNK-28: plan fee transaction → rule suggestion bankFees, no VAT, no §13b | U | BNK-027, EC-164 |
| T07-036 | EC-BNK-29: sandbox transactions excluded from journal/reports | C | BNK-012 |
| T07-037 | **Withdrawn (v1.1)** — B1: Revolut webhook failed-events | — | — |
| T07-040 | EC-156 / EC-BNK-40: on 2026-11-03 to-do for October per account; escalates after the 10th | C | BNK-030, EC-156 |
| T07-041 | EC-156 / EC-BNK-41: CAMT closing equals booked balance → reconciled; with one missing transaction → difference list | C | BNK-030, GOBD-02 |
| T07-042 | EC-155: statement period end compared on UTC instant (transaction 2026-10-31T23:30Z belongs to the October statement though booked 01.11. Berlin) | U | BNK-030, EC-155 |
| T07-043 | EC-BNK-42: same statement twice → rejected by hash; retention `vouchers8` set; signed PDF stored with sha256 | C | BNK-030, GOBD-20 |
| T07-044 | Enrichment fills payer name/IBAN once from a later source; a second source does not overwrite; matching re-runs | C | BNK-031, EC-152 |
| T07-045 | EC-148 / EC-BNK-43/44: Revolut CSV (3 header variants) overlapping CAMT data of the same month → only new rows inserted; without ID → review list | U, C | BNK-032, BNK-110 |
| T07-046 | camt.053 .001.02/.08 fixtures: BOOK only, RvslInd offered as reversal, batch split per TxDtls (EC-BNK-48) | U | BNK-033 |
| T07-047 | MT940 with German :86: subfields parsed (SVWZ+, EREF+, name, IBAN) | U | BNK-033 |
| T07-048 | Generic CSV mapping (Windows-1252, `;`, `DD.MM.YYYY`, debit/credit column); EC-BNK-49 malformed line error | U | BNK-033 |
| T07-049 | EC-BNK-45/46: same file twice → 0 inserted; file with two identical coffees → 2 rows; re-import of a superset inserts only new | U, C | BNK-034, GOBD-02 |
| T07-050 | GOBD-02 / EC-BNK-17/47: two statements with a missing day → „Saldenlücke“ warning | C | BNK-035, GOBD-02 |
| T07-051 | RI-27 / EC-BNK-18: feed balances ≠ Σ booked → warning + statement to-do | C | BNK-035, RI-27 |
| T07-052 | EC-BNK-50: rollback blocked when allocated; otherwise rows → ignored `import_rolled_back`, files flagged | C | BNK-036 |
| T07-053 | EC-BNK-51 / EC-170: import into locked period → bookings in first open period | C | GOBD-06, EC-170 |
| T07-054 | EC-BNK-52/53: statement without PDF → to-do; file IBAN ≠ account → blocked | C | BNK-030 |
| T07-060 | Scorer golden M1–M8 exact scores and reasons | U | BNK-042, BNK-043 |
| T07-061 | RF reference (ISO 11649 check digits) → 1.00; invalid RF → ignored | U | BNK-042 |
| T07-062 | EC-BNK-63: ambiguity guard caps at 0.90 and blocks auto-apply | U | BNK-042 |
| T07-063 | Auto-apply only when booked + unique + number/RF + exact amount; auto-applied match undoable via reversal (EC-BNK-66) | C | BNK-043, GOBD-06 |
| T07-064 | Combined payment by numbers and by subset-sum (≤ 12 items); never auto | U | BNK-044 |
| T07-065 | Partial and Skonto suggestions carry differences; never auto; confirming Skonto books UST-32 correction | C | BNK-045, UST-32 |
| T07-066 | EC-152 / EC-BNK-22: incoming without IBAN/name matched by reference + amount; IBAN alias learned after confirm improves the next score (M8) | U, C | BNK-042, BNK-048, EC-152 |
| T07-067 | Existing manual clearing payment ranked first; confirm reconciles (no second payment) | C | BNK-041, PAY-047 |
| T07-068 | EC-BNK-61/62: allocations > amount rejected; concurrent confirmations → one wins | C (integration) | RI-10, GOBD-02 |
| T07-069 | EC-120 / EC-BNK-64 / EC-121 / EC-BNK-65: excess → credit balance; cancelled invoice never a candidate | C | BNK-041, EC-120, EC-121 |
| T07-070 | Reject stores pair; same pair not suggested again | C | BNK-046 |
| T07-071 | EC-BNK-74: unmatch in locked period → reversal dated today | C | BNK-047, EC-170 |
| T07-072 | Card payment matched to voucher via original amount/merchant/date (no transaction-ID pre-link) | C | BNK-049 |
| T07-073 | EC-BNK-76: USD card payment matched to USD voucher → FX difference booked | C | BNK-049, MISC-08 |
| T07-074 | BNK-041 outgoing: open refund of a credit correction suggested by number + exact amount (1.00 with name, auto-applicable), by amount + IBAN without number (0.65), partial refund with number; a debit above the open refund, other currency, incoming money or a rejected pair → no refund candidate; credit balance and refund of the same amount → ambiguous; confirm/auto-apply book the PAY-033 (b) refund; UI label „Erstattung zu Rechnungskorrektur …“, REST/MCP target `cor_…` | U, C, C (MCP) | BNK-041, BNK-043, BNK-046, PAY-033, EC-PAY-33 |
| T07-080 | Rule conditions (regex, MCC, bank transaction code, amount range) table test; first match by priority wins | U | BNK-050 |
| T07-081 | EC-BNK-70: catastrophic regex rejected | U | BNK-050 |
| T07-082 | Rule preview counts last-90-day hits without side effects | C | BNK-051 |
| T07-083 | EC-BNK-72: auto categorize without „Kontoauszug genügt“ → draft „Beleg fehlt“; with flag → finalised voucher (bank fees) | C | BNK-052, GOBD-07 |
| T07-084 | EC-BNK-71: rule never acts on pending items; acts on the booked row | C | BNK-050, RI-10 |
| T07-085 | EC-BNK-73: rule via MCP stored as suggest | C (MCP) | BNK-054 |
| T07-086 | Rule suggestion after 3 identical manual classifications | C | BNK-053 |
| T07-090 | Private marking posts 1800/2100 or 1890/2180 by sign with auto Eigenbeleg; EC-BNK-21 GmbH blocked | C | BNK-060, AO-01 |
| T07-091 | Geldtransit pairing (pocket exchange as two transactions, own IBAN, cash deposit ↔ bank credit); EC-BNK-68 unpaired > 7 days warning | C | BNK-061 |
| T07-092 | Loan repayment split; EC-BNK-75 principal > amount blocked | U | BNK-062 |
| T07-093 | GOBD-02 / EC-BNK-67: ignoring a booked transaction without allowed reason blocked; neutralised pair allowed | C | BNK-063, GOBD-02 |
| T07-094 | Voucher from transaction prefilled; allocated on finalise | C | BNK-065 |
| T07-095 | ATM debit marked „Bargeldabhebung in die Kasse“ → cash inflow on the Berlin booking date via transit | C | CSH-025, AO-05 |
| T07-096 | PayPal CSV into clearing account: charge matched, fee booked, payout Geldtransit | C | BNK-067 |
| T07-100 | AO-05 golden C1: opening 100, voucher paid bar 150 → blocked with exact message | U, C | CSH-026, AO-05, RI-11 |
| T07-101 | AO-05 / EC-149 golden C2/C3: backdated outflow causing later dip blocked; later inflow does not cure | U, C | CSH-026, AO-05, EC-149 |
| T07-102 | AO-05 golden C4: intraday order ok; C5 reversal blocked (EC-CSH-04) | U | CSH-026, CSH-027, AO-05 |
| T07-103 | AO-05 property test (fast-check): random accepted cash receipt/voucher/transfer/reversal sequences never produce a negative (date, seq) balance; RI-11 holds after each step | U (property) | CSH-026, RI-11 |
| T07-104 | EC-151 / EC-CSH-08: two concurrent outflows individually ok, jointly negative → exactly one committed | C (integration) | CSH-026, EC-151 |
| T07-105 | **Withdrawn (v1.1)** — B3: closed cash day | — | — |
| T07-106 | EC-CSH-06/19: future date, date before the cash opening balance, zero amount blocked | U | CSH-021, CSH-024 |
| T07-107 | AO-05 / EC-CSH-07: PATCH/DELETE of cash payments or cash transfers → 405/409; model trigger blocks direct patch | C | CSH-027, GOBD-06 |
| T07-108 | EC-CSH-09: cash transfers auto-generate an Eigenbeleg with hash; no path creates a cash movement without invoice/voucher/Eigenbeleg | C | CSH-024, GOBD-07 |
| T07-109 | AO-04 / EC-CSH-10: no API/UI/MCP path for cash income without invoice (route-table + MCP schema scan) | C, M | CSH-029, AO-04 |
| T07-110 | **Withdrawn (v1.1)** — B3: daily close with difference | — | — |
| T07-111 | **Withdrawn (v1.1)** — B3: open-days reminder | — | — |
| T07-112 | **Withdrawn (v1.1)** — B3: cash-book opening balance/archiving | — | — |
| T07-113 | Cash receipt on an invoice creates the F05 payment and journal entry (S 1000 / H receivable) atomically; reversal reverses both | C | CSH-021, CSH-027, PAY-046 |
| T07-114 | EC-CSH-15: deposit to bank → open transit; bank credit matched → transit closed; unmatched after 7 days → warning | C | CSH-024, BNK-061 |
| T07-115 | Cash report PDF/CSV golden (movements, running balance, Gegenkonto) | G | CSH-030 |
| T07-116 | **Withdrawn (v1.1)** — B3: seq-order vs date-order cash-book balance | — | — |
| T07-117 | EC-CSH-18: cash payment dated in locked period blocked | C | CSH-021, GOBD-06 |
| T07-120 | MCP: read tools `readOnlyHint`; `bank_match_confirm`, `bank_transaction_mark`, `cash_transfer_record` need confirm_token; untrusted_text for purposes; no fetch tool exists | C (MCP) | 06-mcp §2, BNK-107, EC-189 |
| T07-121 | Outbound events `bank_transaction.imported/matched`, `bank_consent.expiring` written in the same transaction (outbox) | C | BNK-080 |
| T07-122 | **Withdrawn (v1.1)** — B1: Revolut sandbox E2E. See T07-150 | — | — |
| T07-123 | E2E Zuordnungen desktop + mobile, bulk safe confirm, axe clean; visual baseline | E | BNK-046, MISC-10 |
| T07-124 | E2E Kasse: „Bar bezahlt“ on an invoice with the past-date warning, „Bargeld eingezahlt“ with live projected balance, Quittung download | E | CSH-021, CSH-024, CSH-028 |
| T07-130 | Setup: key pair generated, private key encrypted and never returned by any API; evaluation-confirmation status shown until recorded | C | BNK-101, BNK-116, SEC-06 |
| T07-131 | Consent flow with MSW: `POST /auth` carries `psu_type: business`, `valid_until` ≤ now + 180 days and the redirect URL; `state` single-use; `POST /sessions` stores the session | C (MSW) | BNK-102 |
| T07-132 | EC-BNK-80/81: missing/reused `state`, expired session, rejected JWT → German errors, nothing stored | C | BNK-102 |
| T07-133 | EC-BNK-88 / EC-193: backfill runs inside the callback with `strategy=longest` and all `continuation_key` pages; MSW timeout after 90 days of data → callback completes and creates the statement-import to-do for the older range | C (MSW) | BNK-103, EC-193 |
| T07-134 | EC-BNK-84/91/92 / EC-159: renewal returns new `uid`s → accounts re-mapped by IBAN, then by `identification_hash`; new pocket prompts; missing account warns; zero duplicate accounts/transactions | C | BNK-104, EC-159 |
| T07-135 | EC-BNK-83 / EC-158: reminders exactly at T−14, T−3, T−0 (fake clock, Europe/Berlin), once each | C | BNK-105, EC-158 |
| T07-136 | EC-BNK-82 / EC-158: `EXPIRED_SESSION` → `reauth_required`, polling paused; after renewal gap fetched with 10-day overlap, continuity ok | C | BNK-105, EC-158 |
| T07-137 | Poll schedule 05:30/11:30/17:30/23:30 Europe/Berlin incl. DST days; window = last booked date − 10 days | C | BNK-106 |
| T07-138 | EC-BNK-86 / EC-191: 5th unattended fetch within 24 h is not sent (MSW count); 429 → no call for 6 h; pagination counts once; balances ≤ 1/day | C (MSW) | BNK-106, EC-191 |
| T07-139 | EC-BNK-87: „Jetzt abrufen“ from the UI sends PSU headers and does not consume the budget; REST/MCP trigger → `owner_presence_required` | C, API | BNK-107 |
| T07-140 | EC-157 / EC-BNK-85: overlapping windows and repeated polls insert each booked row once (`entry_reference` key); `transaction_id` changes between polls do not create duplicates | C | BNK-109, EC-157 |
| T07-141 | EC-192 / EC-BNK-89: rows without `entry_reference`: two identical same-day rows → ordinals 0/1; balance continuity confirms; a third with mismatching balance → review list | U, C | BNK-109, EC-192 |
| T07-142 | EC-148 / EC-BNK-77: feed rows then the CAMT.053 of the same month → 0 new rows, sources appended, statement reconciled; ambiguous pair → review list; resolution „eigene Buchung“ inserts, „gleiche Buchung“ links | C | BNK-110, EC-148 |
| T07-143 | Route/handler scan: no inbound bank webhook route exists | C | BNK-108 |
| T07-144 | EC-BNK-90 / EC-194: feed lost → disconnected, imports continue, overlap with earlier feed data deduped | C | BNK-117, EC-194 |
| T07-145 | Verfahrensdokumentation section „Bankdaten“ lists provider, consent periods and confirmation status | C | BNK-116 |
| T07-146 | EC-CSH-30/31 / EC-200: cash receipt dated today ok; 2 days back → warning; 11 days back without reason → blocked, with reason → saved and audited; tomorrow → blocked | U, C | CSH-021, EC-200 |
| T07-147 | Voucher paid bar posts against 1000 and respects CSH-026 (EC-CSH-33 hint); voucher privat bezahlt posts 1890 (sole proprietor) / Verrechnungskonto Gesellschafter (GmbH) without cash movement | C | CSH-022, CSH-023 |
| T07-148 | EC-CSH-32: private cash withdrawal blocked for a GmbH; allowed for an e.K. with Eigenbeleg | C | CSH-024, AO-01 |
| T07-149 | EC-CSH-34: Quittung PDF golden; first generation archived with sha256 (`receiptFile` set once); reprint stamped „Kopie“, archived hash unchanged | G, C | CSH-028 |
| T07-150 | E2E Enable Banking sandbox (P2 gate): consent → callback backfill → poll → match → invoice paid; renewal re-maps accounts | E | BNK-101…106, BNK-043 |
| T07-151 | E2E statement import (P1 gate): owner's anonymised Revolut month (CAMT.053 + PDF) → import preview → import → matches → reconciled ✓; CSV of the same month afterwards → 0 new | E | BNK-030, BNK-033, BNK-110 |
| T07-152 | EC-CSH-35: cash payment on a USD invoice blocked | U | CSH-021 |
| T07-153 | Booked counter-entry for an original in a locked period → link allowed, F05 reversal dated today (EC-BNK-78) | C | BNK-121, GOBD-06 |

---

## 9. Open questions

| # | Question | Decided default |
|---|---|---|
| Q-01 | **Owner action:** does Enable Banking confirm restricted-mode use for one company's own accounts in writing, or quote a price? | Use restricted mode; record the answer (BNK-116); if declined or too expensive → statement import only (BNK-117). Not blocking P1 |
| Q-02 | Does Enable Banking accept the tailnet-only HTTPS redirect URL? (BNK-115) | Spike at P2 start; fallback statement import only |
| Q-03 | Exact Revolut CSV columns, CAMT.053 elements (which carries the Revolut transaction ID: `AcctSvcrRef`/`NtryRef`?), MT940 `:86:` content, fee inclusion — research 13 §5 | **Owner action:** export one Revolut month in all four formats (CSV, CAMT.053, MT940, PDF) for fixtures; parsers keyed by header/element names until then |
| Q-04 | Does the feed deliver remittance text and payer IBAN/name for incoming SEPA transfers to business accounts? | Treated as optional (BNK-114); verify after linking |
| Q-05 | Do DE-IBAN Revolut Business accounts appear under Enable Banking's single "Revolut (Lithuania)" ASPSP? | Assume yes; verify while linking (costs nothing) |
| Q-06 | Is a tailnet IP accepted as `Psu-Ip-Address`? | Log and fall back to the unattended budget (BNK-107) |
| Q-07 | FX accounting for foreign pockets in EÜR | Moving-average cost per pocket, realised FX on outflow (F08); one-off Steuerberater check before go-live recommended, non-blocking |
| Q-08 | Auto-apply on by default per account? | On for ≥ 0.98 with the strict extra conditions (BNK-043); owner can switch off |
| Q-09 | Is a journal-based cash record (no Kassenbuch, no daily close) sufficient? ⚖ LEGAL-OPEN | Decided default: allowed for EÜR businesses without a cash register; the app enforces never-negative, daily-recording warning, reason for > 10 days, no cash sales without invoice, and prints the cash report (CSH-030). For Bilanz companies with frequent cash, a Kassenbuch may be expected — one-off Steuerberater check before go-live recommended, non-blocking |
| Q-10 | Revolut Business API | Not specified; future option only if the owner buys the Grow plan (research 12) |

## 10. P1 implementation notes (matching slice, 2026-10-13)

| Topic | Implementation | Reason |
|---|---|---|
| Suggestions | Computed on read (`matching.review`, `matching.suggestions`) from open documents, opening items, credit balances, open refunds of credit corrections (outgoing only, added 2026-10-18) and unreconciled clearing payments; only rejections (`matchRejections`) and learned aliases (`contactAliases` with token and IBAN, BNK-048) are stored | Open amounts change with every payment; stored suggestions would go stale |
| Invoice number first | The scorer extracts numbers from purpose/reference incl. the „RE “ prefix and RF references; the reason chips are shown in German (`REASON_LABEL_DE`) | BNK-041/042 |
| Auto-apply (BNK-043) | Scheduled per imported row after the import commit (`matching.autoApplyInternal`), only for a single candidate ≥ 0.98 with number/RF and exact amount on accounts with `autoApplyMatches`; „Rückgängig“ = F05 reversal | A failing auto-apply must not undo the import |
| Confirm | `matching.confirm` (⚠ `bank_match_confirm`): incoming → F05 payment (split over several targets, remainder → credit or unallocated); outgoing → refund of a credit balance or of a credit correction's open refund (Convex target `salesDocument` of type `correction`, on the wire kind `correction` with `cor_…`; F05 PAY-033 b, added 2026-10-18 — the first version of this note named `correction` as the Convex kind); target `payment` → reconcile a clearing payment (PAY-047) | One implementation for UI, REST and MCP |
| Refund suggestions (BNK-041 outgoing, 2026-10-18) | An outgoing debit is scored against the open refunds of finalised credit corrections (`OpenRefund`, `src/domain/banking/match.ts`): the correction number in purpose/reference (same normalisation and „tail only when unique“ rule as invoices), the exact open refund, or less with the number („Teilerstattung“, `partial`), known IBAN, name similarity and the date window (document date − 3 … due date/document date + 45). A debit **above** the open refund is never proposed (EC-PAY-33); no differences (Skonto/fees) are proposed. Same weights, ambiguity guard and thresholds as incoming payments, so a credit balance and an open refund of the same amount and customer are flagged `ambiguous`. Card label „Erstattung zu Rechnungskorrektur RK-…“ (the word „Gutschrift“ is reserved for self-billing, § 14 Abs. 2 S. 2 UStG); open amount shown as a positive refund. ✓ Bestätigen runs the existing F05 `refundCorrection` (P11 posting, EC-PAY-33 re-checked); „Andere wählen“ on a debit lists open refunds (`matching.openTargets.refunds`). REST/MCP suggestions encode the target as `{ kind: "correction", id: "cor_…" }`, so `bank_match_confirm` takes it unchanged; its `preview_action` effect shows the open refund before/after | Same engine and confirm flow for both directions (BNK-041); one refund path (PAY-033 b) |
| Refund auto-apply (BNK-043) | A refund candidate is auto-applicable under exactly the BNK-043 conditions (booked, unique, correction number, exact open refund, single allocation, ≥ 0.98 — in practice number + exact amount + name or IBAN) | The money has demonstrably left the account for that correction; booking it is recording, not deciding. „Rückgängig“ (F05 reversal) reopens the refund |
| Bank reversals (BNK-121) | Linking a counter-entry reverses the original's payments with the counter-entry as the carrier of the reversal row (dated on its booking date, reason „Rückbuchung durch die Bank“) | EC-PAY-24: both bank rows end balanced, the invoice is open again |
| ⚠ marks and cash transfers via MCP | The action renders the Eigenbeleg, the internal mutation consumes the confirm token in the transaction of the act; the token binds only the caller-chosen arguments | 06 §2.3; the Eigenbeleg does not exist at preview time |
| Never negative in previews | `cash.transferContext` (used before rendering the Eigenbeleg and by `preview_action`) runs the CSH-026 projection; the posting re-checks in its transaction | Fail early with the same message (EC-CSH-01/02) |

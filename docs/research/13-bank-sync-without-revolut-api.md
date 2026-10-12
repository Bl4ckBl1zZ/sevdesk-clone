# Bank sync for Revolut Business without the Business API (research as of 12 Oct 2026)

**Question.** The owner is on a Revolut Business plan *below* Grow, so the Revolut Business API (research 12) is not available. How can a self-hosted, single-company app still read Revolut Business transactions read-only? How does sevdesk do it? What is the fallback without any provider?

**How I verified this.** Many vendor pages (Revolut, Enable Banking, finAPI, open-banking.io, GoCardless) block plain fetches or render with JavaScript. I loaded them in a headless Chromium on 12 Oct 2026 and read the rendered text. I also used two machine-readable sources:
- the official Revolut Open Banking OpenAPI spec (`github.com/revolut-engineering/revolut-openapi`, `json/open-banking.json`);
- the Enable Banking OpenAPI spec (`enablebanking.com/docs/api/reference/enablebanking-api.yaml`).

Every claim cites its URL. **UNSURE** = not confirmed by a primary source, or my own inference.

---

## 0. Bottom line

1. **sevdesk uses finAPI** for Revolut Business. finAPI is a BaFin-licensed PSD2 account information provider. The owner sees a PSD2 redirect: a finAPI web form, then the Revolut Business login/approval. Revolut says EU connections must be **re-authorised every 180 days**.
2. **The Revolut Business API still needs Grow or higher** (today: Basic 10 €, **Grow 35 €**, Scale 125 € per month). There is no cheaper API plan.
3. **Revolut's own PSD2 Open Banking API is closed to us.** It needs an AISP licence plus eIDAS QWAC/QSealC certificates. Revolut only offers to "contact us" for non-regulated parties.
4. **Viable aggregators at a few € per month or less, as of Oct 2026:**
   - **Enable Banking, "restricted mode": free.** It is the actual licensed AISP and covers Revolut. Its Terms forbid business use, *but* explicitly tolerate business users linking their own accounts "solely for evaluation purposes". Enable Banking can end that with written notice.
   - **open-banking.io: 3 € per month for the first account, +1 € per additional account.** A Danish reseller built on Enable Banking. Business use is explicitly allowed. It is young ("Frühzugang", i.e. early access) and adds one more intermediary.
   - **The rest are out of budget or closed.** GoCardless Bank Account Data (ex-Nordigen) **stopped new sign-ups in July 2025**. finAPI "own use" costs **200 € per month**. Tink, Yapily, TrueLayer, Salt Edge and Plaid EU are sales-led, with no small-customer price.
5. **The fallback always works.** Revolut Business exports statements as **PDF, CSV, CAMT.053 (XML) and MT940** per currency account, for any period since account opening.
6. **Recommendation (§6).** Build a provider-neutral "bank feed" adapter. Use **Enable Banking in restricted mode** (0 €) and ask Enable Banking in writing to confirm this use or quote a price. Keep **open-banking.io** (about 3–4 € per month) as the paid fallback. Keep the **CAMT.053 import** as the safety net and the source of the official statement. Upgrading to **Grow (+25 € per month over Basic)** remains the "best data, no re-consent, webhooks" option already specified in research 12.

---

## 1. How sevdesk connects Revolut Business

| Point | Finding | Source |
|---|---|---|
| Aggregator | **finAPI.** The sevdesk Revolut page says: "Erteile finAPI die Erlaubnis, auf deine Konten und Transaktionen zuzugreifen." | https://sevdesk.de/integrationen/revolut-business/ |
| Flow | Banken → "Zahlungskonto hinzufügen" → search "Revolut Business". Choose the **"deutsche Revolut Business Zweigniederlassung"** entry for a German company, otherwise the general one. Log in to Revolut Business and authorise finAPI. Back in sevdesk, link the Revolut sub-accounts (currency pockets) and confirm. | same |
| Generic finAPI flow (help article dated 10 Apr 2026) | sevdesk redirects to "unseren PSD2-konformen Schnittstellenpartner FinAPI". The import start date must be at least 14 days in the past. "PIN speichern" is recommended for background refresh; that matters for FinTS/credential banks, while Revolut is a redirect to the Revolut login. | https://intercom.help/sevdesk/de/articles/9345270-onlinekonto-anlegen-mit-finapi |
| What the owner sees | 1. The finAPI web form. 2. A redirect to the Revolut Business login (web or app approval). 3. A Revolut screen to pick which currency accounts to share. 4. A redirect back to sevdesk. Revolut's own description of any open-banking integration: "You will be redirected to the Revolut Business login page to select exactly which accounts (GBP, EUR, USD, etc.) you want to sync." | https://help.revolut.com/en-DE/business/help/integrating-with-external-apps/open-banking/how-can-i-set-up-an-open-banking-integration/ |
| Re-consent | Revolut: "European regulations require you to re-authorise this connection **every 180 days**. For UK-based accounts … 'reconfirm' the integration every 90 days. Your software will usually send you a notification before expiration." How sevdesk words its renewal prompt is **UNSURE**; I found no sevdesk article on it. | same Revolut page |
| History on first sync | Revolut: "most integrations can automatically pull the **last 90 days**". Some pull more, but only at the moment of authorisation. For older data, "export a CSV or MT940 statement" and upload it. | https://help.revolut.com/en-DE/business/help/integrating-with-external-apps/open-banking/how-much-historical-data-can-i-sync-open-banking/ |
| Pending items | Revolut: "most accounting apps will only sync them every 6 to 24 hours and once the transactions are 'Completed'". A new currency pocket requires re-authorisation. | https://help.revolut.com/en-DE/business/help/integrating-with-external-apps/open-banking/what-should-i-do-if-my-transactions-aren-t-appearing-or-balance-is-incorrect-open-banking/ |

So the owner's memory ("authenticate with Revolut through a 3rd-party platform") is accurate: it is **PSD2 AIS via finAPI**, not the Revolut Business API. That is why it works on any Revolut plan.

---

## 2. Regulatory frame that applies to every provider

- **Consent renewal of 180 days.** Delegated Regulation (EU) 2022/2360 amended RTS 2018/389, applying from **25 Jul 2023**:
  - It added a *mandatory* SCA exemption for AIS access through an AISP (new Art. 10a).
  - It raised SCA renewal from 90 to **180 days**.
  - Sources: https://eur-lex.europa.eu/eli/reg_del/2022/2360/oj and https://www.eba.europa.eu/publications-and-media/press-releases/eba-publishes-final-report-amendment-its-technical-standards
  - Revolut applies 180 days for EU accounts (§1).
- **Four unattended requests per day.** Under RTS Art. 36(5)(b), an AISP may access the account without the user present at most **4 times per 24 h**.
  - Revolut's Open Banking docs make it concrete: "you must not make more than 4 requests for account information over a period of 24 hours **for each account, endpoint, and consent**".
  - The limit does not apply to (a) pagination bursts, (b) requests made while the user is present (send the `x-fapi-customer-ip-address` header), or (c) the period just after consent.
  - Source: https://developer.revolut.com/docs/guides/build-banking-apps/usage-and-limits
- **Older history only right after consent.** Revolut: "Access to transactions older than 90 days is only possible during the **first 5 minutes** after the user authorised the consent." (same page). Enable Banking describes the general window as "around one hour" (https://enablebanking.com/docs/faq/). **Design consequence:** run the backfill inside the consent callback.
- **What any aggregator gets from Revolut.** Every aggregator calls the same Revolut Open Banking API. Its transaction object (`OBTransaction4` in `open-banking.json`) contains:

| Group | Fields |
|---|---|
| Identity and status | `TransactionId`: "unique and immutable ID … within a servicing institution". `Status`: `Booked` \| `Pending`. |
| Dates | `BookingDateTime`: creation in Revolut's systems. `ValueDateTime`: "Returned only for transactions with `Status=Booked`". `SupplementaryData.StartedDate`: for offline transactions. |
| Amounts | `Amount`, `CreditDebitIndicator`, `ChargeAmount`, `CurrencyExchange`, running `Balance` |
| Description | `TransactionInformation`: unstructured text, which is where the reference/description lands (**UNSURE** exactly which). `MerchantDetails.MerchantName`. |
| Counterparty | `CreditorAccount` / `DebtorAccount` with `SchemeName` (`UK.OBIE.IBAN`, …), `Identification` and `Name` |
| Card and code | `CardInstrument` (scheme, last 4, cardholder name), `ProprietaryBankTransactionCode` |

Source: https://raw.githubusercontent.com/revolut-engineering/revolut-openapi/master/json/open-banking.json. Only `AccountId, Amount, BookingDateTime, CreditDebitIndicator, Status` are required, so counterparty IBAN/name and the reference may be missing on some rows. Whether they are populated for *incoming* SEPA transfers to business accounts is **UNSURE**; check after linking. If they are, PSD2 would give the counterparty IBAN that the Business API lacks for incoming transfers (research 12).

---

## 3. AIS providers evaluated

Legend: ✅ fits · ⚠ caveat · ❌ not viable for this owner.

### 3.1 Enable Banking (Espoo, FI; AISP supervised by FIN-FSA): ✅/⚠, best technical fit

| Aspect | Finding | Source |
|---|---|---|
| Revolut coverage | The ASPSP list shows **"Revolut, Lithuania, AISP+PISP, Sandbox+Production"**, and it is still listed with the "Business" usage filter applied. There is one ASPSP entry for Revolut Bank UAB; DE-IBAN (German branch) accounts are presumably served by the same connector (**UNSURE**; test while linking, which costs nothing). | https://enablebanking.com/open-banking-apis (searched "Revolut") |
| Sign-up | Email magic link. "New accounts are automatically created on the first sign in." No KYB is needed for restricted mode. Full activation requires a "signed … contract … and cleared KYB". | https://enablebanking.com/docs/api/control-panel/ , https://enablebanking.com/knowledge-base |
| Free "restricted mode" | "You can activate an application by linking your own bank accounts … data retrieval is strictly limited to the whitelisted, linked accounts." The application "will stay in this state until an agreement has been signed". | https://enablebanking.com/docs/api/control-panel/ , https://enablebanking.com/docs/api/linked-accounts/ |
| **Terms for businesses** (Terms "Last updated: January 9, 2026") | Production use "is available solely for evaluation purposes or for the personal use of private individuals". "These Terms do not grant any right or license to use the API for any business or professional purpose, including … (i) accessing account information belonging to businesses". **But:** "business users may register and activate Applications in the Production Environment by associating Linked Accounts. Any such use shall be considered solely for evaluation purposes … unless and until Enable Banking provides written notice stating that the API will be deactivated". It also promises "commercially reasonable efforts to provide advance notice and to support a smooth and orderly transition to an Agreement", and grants "no permanent or vested right". Liability is capped at 100 €. | https://enablebanking.com/terms |
| Paid price | Not public. "volume based … There is a minimum invoicing per month". Customers pay "each connected bank account per month"; re-authorisations and API calls are free. A "Get a Quote" form has existed since spring 2026. The minimum amount is **UNSURE / not disclosed**; third-party estimates put the commercial-aggregator floor in the hundreds of €/£ per month, which is not an Enable Banking figure. | https://enablebanking.com/docs/faq/ , https://enablebanking.com/knowledge-base , https://dev.to/johnfrandsen/the-cheapest-open-banking-apis-for-small-businesses-and-indie-builders-in-2026-5cab |
| Consent duration | `valid_until` is chosen by you, up to the ASPSP's `maximum_consent_validity` from `GET /aspsps`. "For the majority of ASPSPs, this value corresponds to 180 days." No refresh logic is needed; you re-authorise when the consent expires. Sessions can expire early (`EXPIRED_SESSION`). | https://enablebanking.com/docs/faq/ |
| Rate limits | "many ASPSPs have the limit of 4 times a day for data fetches when PSU … is not online". On `429 ASPSP_RATE_LIMIT_EXCEEDED`, "continue data fetching after 6 hours". PSU headers (`Psu-Ip-Address`, `Psu-User-Agent`, …) lift the limit while the user is present. | same |
| Data model | `Transaction` contains: `entry_reference`, `transaction_id`, `status` (`BOOK`/`PDNG`), `booking_date`, `value_date`, `transaction_date`, `transaction_amount`, `credit_debit_indicator`, `creditor`/`debtor` (names), `creditor_account`/`debtor_account` (IBAN), agents (BIC), `remittance_information[]`, `reference_number`, `bank_transaction_code`, `merchant_category_code`, `balance_after_transaction`, `exchange_rate`, `note`. | https://enablebanking.com/docs/api/reference/enablebanking-api.yaml |
| ID stability | **Use `entry_reference`, never `transaction_id`.** "`transaction_id` … should not be used as a unique reference … the value may change". `entry_reference` is immutable for accounts with the same `identification_hash`, usually only for `BOOK` items; pending items should be "excluded when matching" unless the ASPSP keeps the ID through booking. Account `uid`s are **session-specific**; match accounts across re-consents by `identification_hash` (or IBAN). | https://enablebanking.com/docs/faq/ |
| API shape | REST at `https://api.enablebanking.com`, authorised by a **JWT you sign with the app's RSA private key** (RS256, TTL ≤ 24 h). Flow: `GET /aspsps` → `POST /auth` (aspsp, `valid_until`, `redirect_url`, `psu_type: business`) → user redirect → `POST /sessions {code}` → `GET /accounts/{uid}/transactions?date_from=&strategy=longest\|default` (paginated by `continuation_key`) and `/balances`. | https://enablebanking.com/docs/api/quick-start/ |
| Webhooks | Payment status only, **none for AIS**. You must poll. | https://enablebanking.com/docs/api/webhooks/ |
| Redirect URL / tailnet | Allowed redirect URLs are whitelisted per application. Firefly III docs: "Production environment requires HTTPS, but the Sandbox environment works with HTTP … **The URL does not have to be public.**" Actual Budget docs also require `https://…/enablebanking/auth_callback`. A Tailscale `https://<host>.<tailnet>.ts.net/...` name with a Tailscale-issued Let's Encrypt certificate fits (**UNSURE**, not tested). Whether `https://localhost` is accepted is **UNSURE**. | https://docs.firefly-iii.org/tutorials/data-importer/eb/ , https://actualbudget.org/docs/advanced/bank-sync/enable-banking |
| Who uses it | Actual Budget (experimental provider), Firefly III Data Importer, Sure (the Maybe fork). | Actual docs above; https://www.mintlify.com/we-promise/sure/integrations/overview |

### 3.2 open-banking.io (Tatic ApS, CVR 42532940, Hadsten, DK): ✅/⚠, cheapest option that allows business use

| Aspect | Finding | Source |
|---|---|---|
| What it is | A hosted account-information app plus REST API that re-sells **Enable Banking** connectivity. "Bank connectivity is provided through Enable Banking Oy … a registered AISP". | https://open-banking.io/en/terms |
| Business use | "The service is for businesses and private users alike." A business with an EU VAT ID is invoiced under reverse charge. | same |
| Price | **3 € per month including the first connected account, +1 € per additional account**, VAT included. Prepaid wallet (top up 10 or 20 €), prorated. A Revolut Business setup with EUR plus one or two other currency pockets costs about **4–5 € per month** (each currency account is a separate account, per Revolut help §1). | https://open-banking.io/en/terms , https://open-banking.io/pricing |
| Revolut coverage | Lists "Revolut" for every EEA country, including Germany and Lithuania. Business-account specifics are **UNSURE**. | https://open-banking.io/en/banks |
| Consent | Their FAQ: "most banks set it to 90 days … We email you before it happens". Revolut EU itself says 180 days. | https://open-banking.io/en/faq |
| Sync model | End-to-end encrypted. The bank session token is sealed under *your* key: "A sync runs only while you're present with your key unlocked". For automation you export the private key (JWK/PKCS#8) to your server and run their headless client or SDK (Node `@open-banking-io/client`, `X-Api-Key` header). They claim "No four-requests-per-day cap"; how they achieve that, and whether it holds for Revolut, is **UNSURE**. Plan for 4 per day anyway. | https://open-banking.io/en/security , https://open-banking.io/en/developers , https://open-banking.io/en/for-self-hosters |
| History | Asks for about 2 years on the first sync, with a 90-day floor; stored incrementally and never deleted. | FAQ |
| Risks | Very young product: the German site still says "Frühzugang sichern" (secure early access). It is a small single company and adds an extra processor (GDPR AVV needed). Liability is capped at 12 months of fees. Which fields it passes through (remittance info, counterparty IBAN, entry reference) is **UNSURE** until tested. | site, terms |

### 3.3 GoCardless Bank Account Data (ex-Nordigen): ❌ for new users

- GoCardless's own page: "**New signups for Bank Account Data are currently disabled.**" https://bankaccountdata.gocardless.com/new-signups-disabled (checked 12 Oct 2026). The sign-up URL shows only a login form.
- Actual Budget: "From July 2025 onwards, GoCardless has stopped accepting new Bank Account Data accounts … existing … should continue to work." https://actualbudget.org/docs/advanced/bank-sync/gocardless/
- A user reports that GoCardless support said the API "will be only available to enterprise customers in the future" (**UNSURE**, second-hand). https://github.com/adept/gocardless-to-csv/issues/4
- For reference, the old free tier allowed 50 bank connections per month and 4 syncs per bank per day. GoCardless docs promise "up to 90 days of continuous access" and "up to 24 months of transaction history". https://docs.gocardless.com/bank-account-data/overview
- **Indirect use** through consumer resellers that are existing GoCardless customers:
  - **Synci** (Tonning, sole proprietorship, Bergen NO): Basic **2 € per month per connection**, syncs every 6 h, 60-day retention, REST API with personal tokens. Its terms say "Connectivity providers (for example GoCardless)…" and "Commercial … use … may require a separate partner agreement". https://synci.io/pricing , https://synci.io/terms
  - **Lunch Flow**: 2.92 USD per month billed yearly for 2 connections, daily sync, routes through GoCardless and others. It is aimed at budgeting apps. https://www.lunchflow.app/coverage/revolut
  - Revolut Business coverage and business-use terms for both are **UNSURE**. Both add a consumer-grade middleman between the bank and the books, so I do not recommend them for a GmbH's bookkeeping.

### 3.4 finAPI (sevdesk's provider): ❌ on cost

- Official price list:
  - **"Access for own use (max. 10 own accounts)" = Access B2X Basic licence 200 € per month** (net).
  - "Customers with personal use only do not legally require a PSD2 licence."
  - Normal Access B2X costs 100 € per month (up to 200 users), and non-licensed customers additionally pay PSD2 licence fees (AIS from 200 € per month).
  - 30-day free trial.
  - Source: https://www.finapi.io/en/prices/ (accordion "Access for own use", "Definitions and notes", "PSD2-Licences")
- A 24-month initial term is mentioned in search snippets of finAPI's order pages (**UNSURE**).
- Revolut coverage is certain (it is what sevdesk uses, with separate LT and DE-branch entries).
- The API is good (REST, web form, webhooks for background updates), but the price is far over budget.

### 3.5 Tink (Visa): ❌

- Pricing page: "The prices listed on this page are applicable exclusively to our existing customers … New prospects … should contact our sales team." https://tink.com/pricing/
- The "Standard" tier is footnoted "* Personal accounts". Business-account access is therefore presumably Enterprise-only (**UNSURE**).
- Third-party summaries say there are no self-serve production prices (https://toolradar.com/tools/tink/pricing).

### 3.6 Salt Edge: ❌ (sales-led)

- The Partner Program is aimed at companies without their own PSD2 licence ("No PSD2 licence? … in 15 minutes"). It requires signing an agreement; the page shows no price. https://www.saltedge.com/partner_program
- An older free "Basic" tier with 100 live connections is mentioned in search snippets (**UNSURE** if current).
- Partners stay "pending" with only fake/sandbox providers until activated. https://docs.saltedge.com/partners/v1/

### 3.7 Yapily: ❌

- Pricing is "Speak with our team". https://www.yapily.com/pricing
- Licensed via Yapily Connect UAB (Bank of Lithuania). It has a Revolut connector (https://docs.yapily.com/institution-configurations/uk/Revolut).
- Third-party estimate: entry production plans of 200–500 GBP per month (**UNSURE**).

### 3.8 TrueLayer: ❌

- `truelayer.com/pricing` returns a 404 page (checked 12 Oct 2026). Production access is sales-led.
- Revolut names TrueLayer, Plaid and Yapily as typical intermediaries in its consent flow. https://help.revolut.com/en-DE/business/help/integrating-with-external-apps/open-banking/what-is-a-third-party-provider-tpp-in-open-banking/

### 3.9 Plaid (EU): ❌

- The EU pricing page offers a free "TEST" plan with "200 live API calls per product". Production is "Contact sales". https://plaid.com/en-eu/pricing/
- 200 calls run out in under 2 months at 4 syncs per day.

### 3.10 Klarna Kosma: ❌

- The brand was retired in Aug 2023, and the unit was folded into Klarna. It has no small-customer offering. https://www.finextra.com/newsarticle/42716

### 3.11 What self-hosters use in 2026

| Tool | Providers | Note |
|---|---|---|
| Actual Budget | Enable Banking (experimental), GoCardless (closed to new users), SimpleFIN (US), Akahu (NZ), Pluggy (BR) | https://actualbudget.org/docs/advanced/bank-sync/ |
| Firefly III Data Importer | Enable Banking ("free restricted mode … to access your own bank accounts"), GoCardless, Lunch Flow, FinTS, SimpleFIN, basiq, Teller, Sophtron | https://docs.firefly-iii.org/tutorials/data-importer/eb/ |
| Sure (Maybe fork) | Plaid, SimpleFIN, **Enable Banking**, Lunch Flow, CSV | https://www.mintlify.com/we-promise/sure/integrations/overview |

The community has converged on **Enable Banking restricted mode** as the GoCardless replacement for *own* accounts. FinTS/HBCI is not an option: I found no evidence that Revolut offers a FinTS endpoint (**UNSURE**, but no German FinTS bank list includes it).

### 3.12 Summary matrix

| Provider | Revolut Business | Cost for 1 company, 1–3 pockets | Consent | Unattended sync | Business own-account use allowed? | Sign-up friction |
|---|---|---|---|---|---|---|
| **Enable Banking (restricted)** | ✅ (LT entry) | **0 €** | up to ASPSP max (Revolut EU: 180 d) | 4/day per account and endpoint | ⚠ "evaluation" only, revocable with notice | Email only |
| Enable Banking (contract) | ✅ | Quote; minimum monthly invoice undisclosed | same | same | ✅ | Contract + KYB |
| **open-banking.io** | ✅ (listed) | **3 € + 1 € per extra account** | they say ~90 d | they claim no cap (**UNSURE**) | ✅ explicit | Email; key handling |
| GoCardless BAD | ✅ | — | 90 d (default) | 4/day | — | **Closed** |
| finAPI own use | ✅ | **200 € per month** | 180 d | finAPI-managed | ✅ | Contract |
| Tink / Yapily / TrueLayer / Salt Edge / Plaid | ✅ / likely | Sales-led (hundreds €+) | 90–180 d | 4/day | ✅ with contract | Sales + KYB |
| Synci / Lunch Flow (resellers) | **UNSURE** | 2–3 € | per GoCardless | every 6 h / daily | ⚠ consumer-oriented | Email |
| *Revolut Business API (Grow)* | ✅ native | **+25 € per month** (Grow 35 € vs Basic 10 €) | refresh token, no PSD2 re-consent | 60 req/min, webhooks | ✅ | Plan upgrade + certificate |

---

## 4. Revolut's own PSD2 Open Banking API: not for us

- "To access our Open Banking API, you must use a valid **eIDAS certificate or Open Banking (OBIE) certificate** to register your application for production … there is no need for you, **as an AISP or PISP**, to enter into a contract with Revolut". https://developer.revolut.com/docs/guides/build-banking-apps/introduction-to-the-open-banking-api/who-can-access-the-api
- The certificate must be a QWAC/QSealC from a QTSP on the EU Trusted List, with the AISP role in `qcStatement`. Registration uses dynamic client registration (DCR). https://developer.revolut.com/docs/guides/build-banking-apps/register-your-application-using-dcr
- Search snippets of the same page add: "If you are not a regulated TPP under PSD2, but would like to use the API, you can contact us to see if you qualify". I could not see this sentence in the rendered page on 12 Oct 2026 (**UNSURE**). There is no documented path for a company reading its own account.
- A PSD2 AISP licence (BaFin registration under §34 ZAG, professional indemnity insurance) plus QWAC certificates cost far more than Grow. **Not viable.**

---

## 5. Fallback without any provider: statement exports

**Formats and how to download** (Revolut help, "Account statements"):
- Path: Home → "…" → Statements → "Account statement" → select the currency account. "Each currency account will have an individual statement generated." Then pick the period (not before the account opening date).
- "We support **PDF, CSV, XML (Camt.053), and TXT (MT940)** formats." A signed and stamped document is available for PDF only.
- "By default, all statements are generated using **UTC** times." CSV can add local time once a local time zone is set in Appearance settings.
- The user needs the "manage accounts" permission.
- Source: https://help.revolut.com/en-DE/business/help/managing-my-business/viewing-my-account-statements/how-to-get-a-monthly-statement/
- Revolut itself recommends CSV/MT940 for history older than 90 days (§1).
- There is no statements API on Basic (or on any plan, per research 12), so download is manual, in the web app or mobile app.

**CSV columns** (as listed by a third-party connector; **UNSURE**, verify with a real export):

`Date started (UTC), Date completed (UTC), ID, Type, Description, Reference, Payer, Card number, Orig currency, Orig amount, Payment currency, Amount, Fee, Balance, Account, Beneficiary account number, Beneficiary sort code or routing number, Beneficiary IBAN, Beneficiary BIC`

Source: https://www.dativery.com/?p=67999. Other sources mention `State`, `Total amount`, `Exchange rate`, `Fee currency`, `MCC` and `Related transaction id` (**UNSURE**).

**Is it enough for matching?**

| Need | CSV | CAMT.053 | Note |
|---|---|---|---|
| Stable ID | `ID` (Revolut transaction UUID; presumably the same ID as the Business API, **UNSURE**) | `AcctSvcrRef` / `NtryRef` (**UNSURE** which Revolut fills) | A stable ID is better than PSD2 hashes |
| Reference / Verwendungszweck | `Reference`, `Description` | `RmtInf/Ustrd` (**UNSURE** if populated) | Enough for invoice-number matching |
| Counterparty name | `Payer` (incoming) / `Description` | `RltdPties/Dbtr\|Cdtr/Nm` | **UNSURE** for incoming |
| Counterparty IBAN | `Beneficiary IBAN` (**outgoing only**) | `DbtrAcct/CdtrAcct` (**UNSURE**) | Incoming payer IBAN is likely missing in CSV |
| Booking vs value date | started / completed timestamps (UTC) | `BookgDt` / `ValDt` | Convert UTC to Europe/Berlin for the booking date |
| Pending vs completed | exports should contain completed items; a `State` column may exist (**UNSURE**) | booked only | |
| Fees / FX | `Fee`, `Orig amount/currency` | `Chrgs`, `AmtDtls` (**UNSURE**) | |
| Opening/closing balance | `Balance` per row | `Bal` OPBD/CLBD | Balance-continuity check is possible |

**Conclusion:** CAMT.053 is the format to standardise on. It is ISO 20022, the importer already exists in the spec (`fast-xml-parser`), it carries opening/closing balances for continuity checks, and together with the signed PDF it is the official Kontoauszug for GoBD archiving (spec cron `bank.statementsTodo`, EC-156). Keep the Revolut CSV importer for its richer `ID`/`Reference` columns. **Action:** the owner should export one month in all four formats so we can build fixtures and settle the UNSURE cells.

---

## 6. Recommendation for this owner

### 6.1 Choice

1. **Primary: Enable Banking, restricted mode (0 €).**
   - Why:
     - It is the regulated AISP itself, with no extra middleman.
     - It covers Revolut, has the best docs and an OpenAPI spec, and supports 180-day consents.
     - It is the de-facto standard in Actual, Firefly and Sure.
     - The Terms explicitly *acknowledge* business users activating apps with their own linked accounts.
   - Trade-offs:
     - Contractually this is "evaluation", which Enable Banking can end by written notice. It promises notice and a transition to a paid agreement with an unknown minimum.
     - No support SLA. Liability is capped at 100 €.
   - **Action:** email `info@enablebanking.com` / `support.api@enablebanking.com`. Describe the setup (one company, its own Revolut Business accounts, read-only, ≤ 4 accounts) and ask for (a) written confirmation that restricted mode is acceptable or (b) a quote. Store the answer with the configuration documentation (Verfahrensdokumentation).
2. **Paid fallback: open-banking.io (about 3–5 € per month).**
   - Why: business use is explicit and the price fits the budget. The underlying connectivity is Enable Banking, so data semantics are the same.
   - Trade-offs: young one-company service and an extra GDPR processor. A different API with client-side decryption means a second adapter. Revolut Business field coverage still needs testing.
3. **Safety net, always on: CAMT.053 (+ signed PDF) monthly import.** It is needed anyway for the official statement, for history older than 90 days, and whenever a consent lapses.
4. **If the owner later wants zero re-consent, webhooks and the richest data:** upgrade to **Grow (+25 € per month)** and use the Business API design already specified in research 12. The adapter boundary below makes that a configuration switch.

**Rejected:**
- GoCardless: closed to new sign-ups.
- finAPI: 200 € per month.
- Tink, Yapily, TrueLayer, Salt Edge, Plaid: sales-led.
- Consumer resellers (Synci, Lunch Flow): extra middleman, unclear business terms.
- Revolut's own Open Banking API: needs a licence.

### 6.2 Implications for the app design (to fold into the spec in a separate PR)

The spec currently assumes the Revolut Business API. Affected places:
- ADR 011 in `02-architecture.md` ("Revolut Business API only … no third-party banking intermediaries");
- the `bank.sync` cron and the webhook route;
- `bankConnections` in `03-data-model.md`;
- the Grow checklist in `08-deployment.md` and `09-roadmap.md`.

The CLAUDE.md line "Revolut Business API, read-only" would also change. Per the repo rules, the spec must be updated with a reason; this research file does not do that. The design points:

1. **Provider abstraction.** Add `BankFeedProvider = "revolut_business_api" | "enable_banking" | "open_banking_io" | "file_import"` behind one interface (`startConsent`, `completeConsent`, `listAccounts`, `fetchTransactions(since)`, `fetchBalances`, `consentStatus`). Domain matching consumes one normalised `BankTransaction`, whatever the source (CLAUDE.md rule 5).
2. **Consent lifecycle (re-consent every 180 days, or 90 if the provider caps it).**
   - Store `sessionId`, `validUntil` and the accounts' `identification_hash`.
   - Notify the owner at T−14, T−3 and T−0 days (the spec's existing notification channel).
   - The "Neu verbinden" button runs `POST /auth` → Revolut → callback → `POST /sessions`.
   - Re-map accounts by `identification_hash`/IBAN, because account UIDs change per session.
   - Treat `EXPIRED_SESSION` or a 401 at any time as "re-consent required". Sync pauses; nothing is lost because the next consent backfills.
   - A **new currency pocket also requires re-consent** (Revolut help).
3. **Backfill inside the callback.** Immediately after `POST /sessions`, fetch with `strategy=longest` (Enable Banking), because Revolut allows history older than 90 days only for **5 minutes** after consent. Import older history from CAMT.053.
4. **Sync frequency.**
   - At most 4 unattended fetches per account and endpoint per day: a cron every 6 h, e.g. 05:30 / 11:30 / 17:30 / 23:30 Europe/Berlin.
   - Fetch balances sparingly (each endpoint has its own budget at Revolut).
   - An owner-triggered "Jetzt abrufen" may send PSU headers (`Psu-Ip-Address`, `Psu-User-Agent`) to lift the cap. Behind Tailscale the client IP is a 100.64.0.0/10 tailnet address; whether banks accept that as `Psu-Ip-Address` is **UNSURE**, so log and fall back.
   - On `429 ASPSP_RATE_LIMIT_EXCEEDED`, back off 6 h.
   - Replace the spec's "hourly + webhook" cadence for PSD2 providers.
5. **No webhooks.** PSD2 AIS has no push, so remove the public webhook dependency for this mode. Near-real-time payment detection becomes "within ≤ 6 h", which is acceptable for dunning and matching.
6. **Dedupe keys.**
   - Primary: `(provider, account identification_hash, entry_reference)` for booked rows.
   - Never key on Enable Banking's `transaction_id` ("may change").
   - Fallback when `entry_reference` is missing: a content hash of `(accountHash, bookingDate, valueDate, amountCents, currency, counterpartyIban|name, remittance text)` plus an ordinal for identical rows on the same day. Guard it with a balance-continuity check using `balance_after_transaction` or the CAMT opening/closing balances.
   - Cross-source dedupe (PSD2 feed vs CAMT/CSV import): match on Revolut `TransactionId` if both carry it (**UNSURE**), otherwise on the content hash plus amount and date. Add an EC-entry and fixtures for this.
7. **Pending vs booked.**
   - Store `PDNG` rows as provisional: shown in the UI, **never journalised, never auto-matched**.
   - On each sync, replace pending rows for the window. When the booked twin appears, link it and drop the pending row (unless the pending row's `entry_reference` is stable, which Enable Banking only provides for some ASPSPs).
   - Only booked rows are bookkeeping-relevant (GoBD). Revolut's own guidance is that accounting apps sync "Completed" only.
8. **Dates and time zones.** Revolut timestamps and statements are UTC. Derive the booking date in Europe/Berlin consistently across API, CSV and CAMT so that items near midnight are not counted twice or placed in the wrong month.
9. **Data gaps.** Remittance text and counterparty IBAN may be missing on some rows (only five Revolut fields are mandatory). The matching scorer must degrade gracefully: amount + date + name fuzzy match, then manual confirmation.
10. **Tailnet-only server.**
    - All provider calls are outbound HTTPS, which is fine.
    - The consent redirect returns to the **owner's browser**, which is in the tailnet. Enable Banking needs only a whitelisted **HTTPS** redirect URL, which "does not have to be public" (Firefly docs).
    - Use `https://<host>.<tailnet>.ts.net/bank/callback` with `tailscale serve`/`tailscale cert`. Tailscale certificates come from Let's Encrypt, so the host name appears in **public Certificate Transparency logs**; pick a non-sensitive machine name. https://tailscale.com/kb/1153/enabling-https
    - Production `http://localhost` is not allowed by Enable Banking (HTTPS required); `https://localhost` is **UNSURE**.
    - open-banking.io: the consent happens in *their* web app, so no redirect to our server is needed at all. Our server only calls their API with the exported key.
11. **Secrets.** The Enable Banking app private key (PEM) or the open-banking.io `credentials.json` (API key + private decryption key) goes under `APP_ENCRYPTION_KEY` like the Revolut key in the current spec. Enable Banking JWTs are short-lived (≤ 24 h; mint per request).
12. **Audit and GoBD.** Keep raw provider payloads (append-only revisions) as in the current spec. Record the provider, consent IDs and the Enable Banking written confirmation in the Verfahrensdokumentation. The monthly signed PDF + CAMT.053 remains the legal Kontoauszug.

---

## 7. Open items / UNSURE list

- Whether Revolut fills `TransactionInformation`, `DebtorAccount.Identification` (IBAN) and `Name` for incoming SEPA transfers to *business* accounts via PSD2. Test in restricted mode, or check Enable Banking's Control Panel "Data Insights" (login needed).
- Whether Revolut DE-IBAN business accounts appear under Enable Banking's single "Revolut (Lithuania)" ASPSP. finAPI shows a separate DE-branch entry.
- Revolut's `maximum_consent_validity` value in `GET /aspsps` (expected 180 days, `15552000` s).
- Enable Banking's minimum monthly invoice for a contract, and whether it will confirm restricted-mode use in writing.
- open-banking.io: actual field coverage for Revolut Business, how it avoids the 4/day limit, and product maturity.
- Revolut CSV/CAMT.053 exact columns and elements. Get one real export per format.
- Whether the Revolut Business API keeps working if the plan is downgraded after setup (not relevant unless Grow is bought; do not rely on it).
- Whether a tailnet IP is acceptable as `Psu-Ip-Address`.

# Revolut Business API for a self-hosted German bookkeeping app (research as of 12 Oct 2026)

## How I verified this

The Revolut developer pages and help centre block plain HTTP fetches with a "security check", so I loaded them in a headless Chromium. I also downloaded the official, current OpenAPI spec from `github.com/revolut-engineering/revolut-openapi` (`json/business.json`, last pushed 12 Oct 2026). Field names and endpoints below come from that spec and the live guides unless marked otherwise.

- **(UNVERIFIED)** means the point comes from third-party sources or is my own inference.
- **(DOC-INCONSISTENCY)** means two official Revolut sources disagree.

**Bottom line:** Read-only sync is well supported. You need the Grow plan or higher, a one-time consent, and a refresh token that by the current docs does not expire. Expect a 40-minute access token, a limit of 60 requests per minute, cursor pagination on `created_at`, and webhooks v2 with HMAC signatures. The main data gaps are:
- **No statements endpoint.** Statements are only available from the app.
- **No receipt upload.** Receipts can only be read.
- **No IBAN or name of the other party on incoming transfers.** There is only a free-text `description`.

---

## 1. Availability and cost

| Item | Finding | Source |
|---|---|---|
| Plans with API access | **Grow, Scale, Enterprise.** Basic has no API. Help centre: "A pricing plan of 'Grow' or above". The German plan table shows "Business APIs: – / ✓ / ✓ / ✓". | help.revolut.com/business/help/integrating-with-external-apps/revolut-business-api/question-using-revolut-business-api/ ; revolut.com/de-DE/business/business-account-plans/ |
| German plan prices (shown on the site today) | Basic €10/month, Grow €35/month, Scale €125/month, Enterprise on request. Whether these are monthly or annual-billing prices is not stated **(UNVERIFIED)**. | revolut.com/de-DE/business/business-account-plans/ |
| Separate API fee | **None documented.** "API access is included … but transaction fees, exchange rates, and limits may apply." The Revolut Business API agreement applies. | help centre |
| Required permissions for the person setting it up | API & Integrations: Manage Integrations, Manage API. Billing: View Business. | dev guide "Make your first API request" |
| Production base URL | `https://b2b.revolut.com/api/1.0`. Webhooks v2 use `https://b2b.revolut.com/api/2.0`. | OpenAPI `servers` |
| Sandbox base URL | `https://sandbox-b2b.revolut.com/api/1.0` (webhooks: `/api/2.0`) | OpenAPI |
| Sandbox web app / signup | `https://sandbox-business.revolut.com/`. Free and approved automatically. There is a "Skip email verification" button and an "Autofill code" button. The sandbox is completely separate from production (different credentials and certificates). | dev guide "Set up a test environment with Revolut Sandbox" |
| Sandbox simulations | `POST /sandbox/topup` (`account_id`, `amount` ≤ 10000, `currency`, `reference`, `state`: pending/completed/reverted/failed). `POST /sandbox/transactions/{id}/{complete\|revert\|decline\|fail}`. Both need the WRITE scope. | guide "Test your flows with simulations" |
| Not in sandbox | The **Expenses API, including receipts**. Its spec entry lists only the production server. | OpenAPI |

Legacy note: older client libraries mention API access on "Freelancer" plans with a 90-day re-authorisation. The current help centre only says "Grow or above" **(UNVERIFIED for freelancer plans today)**.

---

## 2. Authentication end to end

### 2.1 Generate the key pair (official commands)
```bash
openssl genrsa -out privatecert.pem 2048
openssl req -new -x509 -key privatecert.pem -out publiccert.cer -days 1825
```
- At least one Distinguished Name field is required, for example Country. You can skip the prompts with `-subj "/C=DE"`.
- OpenSSL 3 writes `BEGIN PRIVATE KEY` (PKCS#8). OpenSSL 1.x writes `BEGIN RSA PRIVATE KEY` (PKCS#1). Load the key with Node's `crypto.createPrivateKey()`, which accepts both. I tested that `jose` v6 signs with the resulting `KeyObject`.

### 2.2 Upload the certificate
1. In the web app go to **Settings (gear) → APIs → Business API → API Certificates → "Add API certificate"**.
2. Paste the whole of `publiccert.cer` (including the BEGIN/END lines) into **"X509 public key"**.
3. Set the **OAuth redirect URI**. It "must use the same domain here and in the `iss`" claim of the JWT.
4. Give it a title, then click Continue. Copy the **ClientID**.
5. **Optional IP whitelist**: single IPs or CIDR ranges, no private IPs. It becomes **mandatory if you ever enable `READ_SENSITIVE_CARD_DATA`**. Without it, *all* endpoints fail in that case. The field is called "Production IP whitelist" on the certificate.

### 2.3 Client assertion JWT
- Header: `{"alg":"RS256","typ":"JWT"}`
- Payload:
```json
{
  "iss": "books.example.de",           // domain of the redirect URI, without https://
  "sub": "<ClientID>",
  "aud": "https://revolut.com",
  "exp": 1791812273                    // number (unix seconds), not a string
}
```
- The same JWT format is used for the code exchange and for every refresh.
- Revolut recommends a short `exp` ("just enough to refresh"). An expired JWT returns `{"error":"invalid_request","error_description":"The Token has expired on …"}`. Generate a fresh JWT for each token call.

### 2.4 One-time consent
1. Open the certificate and click **"Enable access"**. This goes to:
   `https://business.revolut.com/app-confirm?client_id=<ClientID>&redirect_uri=https://example.com&response_type=code`
2. **Read-only is supported.** Append `&scope=READ` (a comma-separated list, for example `scope=READ,WRITE`).
3. Click Authorise, then complete 2FA. You are redirected to `https://<redirect>?code=oa_prod_…`.
4. **The code is valid for 2 minutes.**
5. For testing, "you can use any URL" and copy the `code` from the address bar by hand. For a self-hosted app, point the redirect at your own callback route. It only needs to be reachable from the browser doing the consent, not from Revolut. Whether `localhost` is accepted is **UNVERIFIED**.

### 2.5 Exchange the code for tokens
```bash
curl https://b2b.revolut.com/api/1.0/auth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data "grant_type=authorization_code" \
  --data "code=<CODE>" \
  --data "client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer" \
  --data "client_assertion=<JWT>"
```
```json
{ "access_token": "oa_prod_rPo9…", "token_type": "bearer", "expires_in": 2399, "refresh_token": "oa_prod_hQac…" }
```

### 2.6 Token lifetimes
- **Access token:** 40 minutes (`expires_in: 2399`).
- **Refresh token:** the current official guide says it is returned "with … the refresh token, **which does not expire**".
  - The "90 days" figure you asked about comes from older libraries (Freelancer plan / PSD2 re-authentication).
  - The 180-day (EU) and 90-day figures in Revolut's 2025 blog post are about the **Open Banking API for third-party providers**, not the Business API.
  - Plan for re-consent anyway. Likely triggers **(UNVERIFIED)**: the certificate or access is revoked in Settings, the certificate is deleted, or the consenting user's permissions change. Treat `401` or `invalid_grant` on refresh as "re-consent required" and notify the owner.

### 2.7 Refresh flow
```bash
curl https://b2b.revolut.com/api/1.0/auth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data "grant_type=refresh_token" \
  --data "refresh_token=<REFRESH>" \
  --data "client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer" \
  --data "client_assertion=<FRESH_JWT>"
```
- The response contains **no new refresh token**: `{access_token, token_type, expires_in}`. Keep the original refresh token.
- **"Refreshing an access token invalidates the previous token"**, so run only one refresh at a time (single-flight).
- An expired access token returns `401 {"message":"The request should be authorized."}`.

### 2.8 Scopes (from the OpenAPI `securitySchemes` and per-operation security)

| Scope | Grants | Relevance |
|---|---|---|
| `READ` | All GET operations: accounts, transactions, expenses, receipts, counterparties, webhooks (including the signing secret via `GET /webhooks/{id}`), failed events | **Enough for syncing** |
| `WRITE` | Counterparties, **webhook create/update/delete/rotate**, payment drafts, cards, team, accounting categories/labels/tax rates, sandbox simulations | Needed to *create* a webhook |
| `PAY` | `POST /pay`, `/transfer`, `/exchange`, payout links | Avoid |
| `READ_SENSITIVE_CARD_DATA` | PAN/CVV | Never request. It forces the IP whitelist. |

**Gotcha:** creating webhooks needs `WRITE`, and `WRITE` also allows creating counterparties and payment drafts. A possible pattern **(UNVERIFIED)**:
1. Create a second certificate with `scope=READ,WRITE`.
2. Use it once to `POST /webhooks`.
3. Revoke it.
4. Run the sync on the READ-only certificate.

Webhooks belong to the business, not to the token.

### 2.9 IP whitelisting
Optional per certificate (IPv4/CIDR). It is mandatory only with `READ_SENSITIVE_CARD_DATA`. On a self-hosted machine with a dynamic IP, leave it empty or use a static egress IP.

---

## 3. Endpoints for bookkeeping

All of these need only the `READ` scope.

### `GET /accounts` and `GET /accounts/{account_id}`
- **One "account" = one currency balance (pocket).**
- Fields: `id` (uuid), `name`, `balance` (double), `currency`, `state` (`active|inactive`), `public` (bool), `created_at`, `updated_at`, `account_type` (`current|merchant|savings|credit|debt|blocking|other`).

### `GET /accounts/{account_id}/bank-details`
Returns an **array**: one entry per set of payment details/scheme.
- Fields: `iban`, `bic`, `account_no`, `sort_code`, `routing_number`, `beneficiary`, `beneficiary_address{street_line1, street_line2, region, city, country, postcode}`, `bank_country`, `pooled` (bool), `unique_reference`, `schemes[]` (`chaps|bacs|faster_payments|sepa|swift|ach|elixir|sorbnet|nics|rix|sumclearing`), `estimated_time{unit, min, max}`.
- Use it to read the real IBAN prefix (DE or LT) and BIC rather than hard-coding them (see §11).

### `GET /transactions`
Query parameters:

| Param | Notes |
|---|---|
| `from` | ISO date or date-time, **inclusive**, compared with `created_at` |
| `to` | **Exclusive**. Defaults to now. Used as the pagination cursor. |
| `account` | Account UUID |
| `count` | Default 100, **max 1000** |
| `type` | `atm, card_payment, card_refund, card_chargeback, card_credit, charge, charge_refund, exchange, transfer, loan, fee, refund, topup, topup_return, tax, tax_refund, rev_payment` |
| `state` | Repeatable (`state=pending&state=created`): `created, pending, completed, declined, failed, reverted` |
| `request_id` | Requires `from`. The window must be ≤ 14 days. |

- **Ordering:** `created_at` descending.
- **Pagination:** next page = `to=<created_at of last item>`. Previous page = `from=<created_at of first item>`.
- **No maximum date window is documented** for normal queries (only the 14-day limit with `request_id`). A limit on history depth is **not documented** **(UNVERIFIED in practice)**.
- **There is no `updated_since` filter**, which matters for pending updates (§5).

### `GET /transaction/{id}`
Same schema as the list. `?id_type=request_id` is deprecated.

### Transaction object (exact field names from the spec)
```text
id                      string            (required)
type                    enum above        (required)
request_id              string
state                   created|pending|completed|declined|failed|reverted (required)
reason_code             string            (when declined/failed)
created_at              date-time         (required)
updated_at              date-time         (required)
completed_at            date-time         (present when completed)
scheduled_for           date
related_transaction_id  uuid              (refunds, cashback; only if the merchant supplies it)
reference               string            (payment reference / Verwendungszweck)
merchant { id, name (cleaned), full_name (raw network descriptor), city, category_code (MCC), country (ISO-3166, usually 3-letter) }
legs[] (required) {
  leg_id (uuid, req), account_id (uuid, req), amount (double, req, signed), currency (req),
  fee (double), bill_amount (double), bill_currency,
  counterparty { account_type: self|revolut|external (req), account_id, id },
  description (string), balance (double, account balance after this leg)
}
card { id, card_number (masked), first_name, last_name, phone, references[{name,value}] }
auth_code               string            (card network authorisation code)
```

What is **not** there: the counterparty's name, IBAN or BIC. For outgoing payments to saved counterparties, resolve `legs[].counterparty.id` with `GET /counterparty/{id}`, which returns `name` and `accounts[].{iban, bic, …}`. For **incoming** external transfers you only get `description` (for example `"From JOHN SMITH"`) and `reference`.

### Official example: card payment in a foreign currency
```json
{
  "id": "640c2b97-aaaa-1234-aaaa-c47a165c2e7e", "type": "card_payment", "state": "completed",
  "request_id": "REVP:8988a9a0-aaaa-1234-aaaa-5bcc66d938bf",
  "created_at": "2024-03-11T07:19:51.302559Z", "updated_at": "2024-03-12T02:13:36.842322Z",
  "completed_at": "2024-03-12T02:13:36.836595Z",
  "merchant": { "name": "Acme Corp.", "full_name": "ACME*1234MN1HA2", "city": "New York", "category_code": "7311", "country": "USA" },
  "legs": [{ "leg_id": "640c2b97-…", "account_id": "92e43866-…", "amount": -47.8, "fee": 0.66, "currency": "AED",
             "bill_amount": -13, "bill_currency": "USD", "description": "Acm *1234mn1ha2", "balance": 7.74 }],
  "card": { "id": "2b1a31bc-…", "card_number": "516760******1234", "first_name": "John", "last_name": "Smith", "phone": "+12412341234" },
  "auth_code": "224466"
}
```

### Official example: exchange between your own pockets (one transaction, 2 legs)
```json
{ "id": "640dc0b7-…", "type": "exchange", "state": "completed",
  "legs": [
    { "leg_id": "640dc0a7-aaaa-a5b5-aaaa-92ac4de1dacd", "account_id": "0d1848dc-…", "amount": -1,   "currency": "GBP",
      "bill_amount": -8.39, "bill_currency": "DKK", "description": "Exchanged to DKK", "balance": 8.74 },
    { "leg_id": "640dc0a7-aaaa-a5b5-aaaa-92ac4de1dacd", "account_id": "246bc9de-…", "amount": 8.39, "fee": 0.08,
      "currency": "DKK", "description": "Exchanged from GBP Main", "balance": 19.33 } ] }
```
**DOC-INCONSISTENCY / gotcha:** in the official examples **both legs share the same `leg_id`** (exchange and internal transfer). In the internal-transfer example both amounts are `+100`, which is almost certainly a documentation bug. Do **not** use `leg_id` alone as a unique key. Use `(transaction_id, account_id, leg_id)`.

### How each case appears
- **Multi-currency pockets:** each currency is its own `account_id`. Each leg is in that pocket's `currency`.
- **Exchange between your own pockets:** `type=exchange`, two legs (negative leg in the source pocket, positive leg in the target pocket). `bill_amount`/`bill_currency` on the source leg holds the counter amount. Any FX fee is in `fee`.
- **Transfer between your own accounts:** `type=transfer`, two legs, `counterparty.account_type: "self"` (or no counterparty).
- **Card payment in a foreign currency:** one leg. `amount`/`currency` = debit in the pocket's currency. `bill_amount`/`bill_currency` = the merchant's original amount and currency. `fee` = the fee for this transaction.
  - Whether `amount` already includes `fee` is **not documented** **(UNVERIFIED)**. Check balance continuity on real data: is `balance_n = balance_{n-1} + amount − fee`, or `+ amount`?
  - The help centre's statement CSV has separate `Amount`, `Fee` and `Total amount` columns, which suggests the fee is separate.
- **Fees:** stand-alone Revolut charges (plan fee, transfer fees beyond the allowance, Expenses add-on) arrive as transactions with `type=fee`. Per-transaction fees sit in `legs[].fee` on the original transaction, **not as a separate leg**.
- **Pending → completed:** the same `id`. `state`, `updated_at` and `completed_at` change, and for card transactions the amounts may change at settlement. `created_at` stays fixed, which is why the cursor alone misses updates.
- **Reverted / declined / failed:** stay as the same `id` with the final state and optional `reason_code`. Declined card authorisations show up as transactions with `state=declined`. Do not book them.
- **Refunds:** `type=refund` or `card_refund` with `related_transaction_id` (only "if provided by the merchant"). Chargebacks: `type=card_chargeback`.

---

## 4. Webhooks (v2)

**Endpoints** (base `https://b2b.revolut.com/api/2.0`):

| Operation | Scope |
|---|---|
| `POST /webhooks` `{url, events?}` | WRITE |
| `GET /webhooks` | READ (no secret in the response) |
| `GET /webhooks/{id}` | READ (includes `signing_secret`) |
| `PATCH /webhooks/{id}` | WRITE |
| `DELETE /webhooks/{id}` | WRITE |
| `POST /webhooks/{id}/rotate-signing-secret` `{expiration_period?: "PT5H30M", max "P7D", default "P0D"}` | WRITE |
| `GET /webhooks/{id}/failed-events?limit=1..1000&created_before=…` | READ (only the last 21 days) |

- **DOC-INCONSISTENCY:** the guide's curl example updates webhooks with `POST /webhooks/{id}`, but the spec says `PATCH`. Use PATCH.
- Max **10 webhooks**. **HTTPS only**. v1 (`/api/1.0/webhook`) is deprecated.
- **Events:** `TransactionCreated`, `TransactionStateChanged`, `PayoutLinkCreated`, `PayoutLinkStateChanged`. The default (no `events` given) is the two Transaction events.
- **Create response:** `{"id","url","events","signing_secret":"wsk_…"}`.

**Payloads:**
```json
{ "event": "TransactionCreated", "timestamp": "2023-01-26T16:22:21.753463Z",
  "data": { /* full transaction object, same schema as GET /transaction/{id} */ } }

{ "event": "TransactionStateChanged", "timestamp": "2023-04-06T12:21:49.865Z",
  "data": { "id": "9a6434d8-…", "request_id": "6a8b2ad9-…", "old_state": "pending", "new_state": "reverted" } }
```
`TransactionStateChanged` carries no amounts, so re-fetch with `GET /transaction/{id}`.

**Signature:**
- Headers: `Revolut-Request-Timestamp` (unix **milliseconds**, for example `1683650202360`) and `Revolut-Signature: v1=<hex>`. The signature header may contain several comma-separated values while more than one secret is active during rotation.
- `payload_to_sign = "v1." + timestamp + "." + raw_body`, then `HMAC-SHA256(key = signing_secret)`, hex-encoded, prefixed with `v1=`.
- The docs say "raw payload without whitespaces". In practice, use the **exact raw bytes** you received and never re-serialise the JSON.
- Replay protection: accept only if the timestamp is within **5 minutes** of UTC now.
- I checked the official test vector in Node and it matches: secret `wsk_r59a4HfWVAKycbCaNO1RvgCJec02gRd8`, ts `1683650202360` → `v1=bca326fb378d0da7f7c490ad584a8106bab9723d8d9cdd0d50b4c5b3be3837c0`.

**Delivery:**
- A failed delivery is retried **3 more times at 10-minute intervals**. After that it appears under failed-events.
- Deliveries can be **duplicated** and can arrive **out of order** (`TransactionStateChanged` may come before `TransactionCreated`).
- **Source IPs:** `35.246.21.235`, `34.89.70.170`. The page has Production/Sandbox tabs and the rendered default (probably Production) showed these two **(UNVERIFIED which environment)**.

**Self-hosted:** you need a public HTTPS endpoint, for example a Cloudflare Tunnel or a reverse proxy. Polling alone is perfectly adequate for bookkeeping. Treat webhooks as an optional "sync now" trigger.

---

## 5. Rate limits and incremental sync

- **Limit:** "A maximum of **60 requests per minute** for a single business." Enterprise can ask for more. Errors: `429`, plus `400/401/403/404/405/406/409/500/503`. Error body: `{code, message}`.
- **Initial backfill:** page backwards from now with `count=1000` until you reach the fiscal-year start or the account opening date.
- **Cursor:** use `created_at` **as the raw string**. It has microsecond precision (for example `…20.364171Z`). Converting through JS `Date` truncates to milliseconds and can skip items at a page boundary because `to` is exclusive.
- **Incremental run** (every 5–15 minutes, or when a webhook arrives):
  1. `GET /transactions?from=<now − 10 days>&count=1000`, paging until there are fewer than 1000 results. This overlap window catches late-created items.
  2. Re-check every locally non-final transaction (`created`/`pending`): either `GET /transactions?state=created&state=pending&from=<now − 60 days>` or `GET /transaction/{id}` for each one. This is needed because there is no `updated_since` filter.
  3. Upsert by `transaction.id` and compare `updated_at`. Upsert legs by `(transaction_id, account_id, leg_id)`. Keep an append-only revision/raw-JSON table for GoBD traceability (§11).
- **Booking rules:**
  - Post journal entries only for `state=completed`, using `completed_at` (UTC, converted to Europe/Berlin) as the booking date.
  - `declined`/`failed`: never book.
  - `reverted`: if you booked it earlier, post a Storno.
  - How long pending card authorisations last is not documented. Several days is typical, and the 60-day re-check is a safety margin **(UNVERIFIED)**.
- **Balance check:** each leg's `balance` lets you verify continuity per account and compare with `GET /accounts` balances.
- **Budget:** a typical run is 1–3 list calls plus a few detail calls, well under 60 per minute. Throttle to about 1 request per second and back off exponentially on 429/5xx.

---

## 6. Expenses and receipts API

**Read-only, production only.**

`GET /expenses`:
- Query: `from`/`to` on `expense_date`, `count` ≤ **500**, `state` (`missing_info, awaiting_review, rejected, pending_reimbursement, refund_requested, refunded, approved, reverted`), `transaction_type` (`atm, card_payment, fee, transfer, external, mileage_reimbursement, rev_payment`).
- Pagination: `to = expense_date` of the last item.
- Fields: `id, state, transaction_type, description, submitted_at, completed_at, payer, merchant, transaction_id, expense_date, splits[]{amount{amount,currency}, category{id,name,code}, labels{group:[label]}, tax_rate{id,name,percentage}}, receipt_ids[], spent_amount{amount,currency}`, plus `labels` (deprecated).

Other endpoints:
- `GET /expenses/{expense_id}`
- `GET /expenses/{expense_id}/receipts/{receipt_id}/content` returns binary (`*/*`, for example a PDF or image). Check the `Content-Type` header.

**So you can download the receipts the owner photographed in the Revolut app** and link them through `transaction_id` → transaction `id`.

Possible errors:
- `403 {"message":"Expenses API for business is disabled","code":9002}`
- `422 {"message":"Expenses feature is not enabled","code":3470}`

The Expenses feature must be enabled. On some plans it may be a paid add-on **(UNVERIFIED)**.

**Uploading receipts or attaching them to transactions is not possible.** The spec has no POST/PUT for expenses or receipts. Write endpoints exist only for accounting categories, tax rates and labels, which are WRITE-scoped.

---

## 7. Payments API (do not enable)

What exists:
- `POST /pay` (scope `READ`+`PAY`). Body requires `request_id, account_id, receiver{counterparty_id, account_id|card_id}, amount, currency`. Optional: `reference, charge_bearer, transfer_reason_code, exchange_reason_code, …`.
- `POST /transfer` (between your own accounts, PAY), `POST /exchange` (PAY), `POST /payout-links` (PAY+WRITE).
- `POST /counterparty` (WRITE), `/payment-drafts*` (WRITE, executed after approval in the app).

Risks:
- Transfers to Revolut accounts execute **instantly**.
- A leaked refresh token plus private key with `PAY` scope means money can be moved.

Mitigations:
- Consent with `scope=READ` only.
- Keep the private key on the server.
- Use short-lived JWTs.
- Optionally set an IP whitelist.
- Never log tokens.

---

## 8. Statements

- **There is no statements endpoint in the Business API** (I checked every path in the spec).
- **In the app:** Home → "…" → Statements → **Account statement** → choose the currency account (one statement per currency) → period → format **PDF, CSV, XML (Camt.053), TXT (MT940)**. A "signed and stamped" version is available for PDF only. Times are UTC by default; the CSV can add local-time columns once a time zone is set under Appearance. You need permission to manage accounts. (help.revolut.com/business/help/managing-my-business/viewing-my-account-statements/how-to-get-a-monthly-statement/)
- **CSV column format: not officially documented.** Community parsers show these header variants **(UNVERIFIED and changes over time, so parse by header name)**:
  - Classic: `Date started (UTC), Date completed (UTC), ID, Type, Description, Reference, Payer, Card number, Orig currency, Orig amount, Payment currency, Amount, Fee, Balance, Account, Beneficiary account number, Beneficiary sort code or routing number, Beneficiary IBAN, Beneficiary BIC`
  - With local time: after the two UTC columns come `Date started (Europe/Berlin), Date completed (Europe/Berlin)`.
  - Newer exports also contain `State, Total amount, Exchange rate, Fee currency, MCC` (seen in a 2023 parser). Others are possible, such as card label/state or related transaction id.
  - Whether CSV `ID` equals the API transaction `id` is likely but **UNVERIFIED**.
- **Recommendation:** use the API for daily sync. Each month (or year), manually archive the **signed PDF plus CAMT.053** per currency account as the official Kontoauszug for GoBD. Use CAMT.053/CSV as the fallback import and to backfill counterparty IBANs that the API does not provide.

---

## 9. Open Banking alternative (brief)

- Revolut Business supports PSD2 account-information access through regulated providers. The help centre says "most integrations can automatically pull the last **90 days**" at setup; for older data it recommends a CSV/MT940 export.
- Options include GoCardless Bank Account Data (ex-Nordigen), Tink, finAPI and Enable Banking. Current terms and pricing for single-company self-hosters are **UNVERIFIED**.
- Downsides: a third party sees your data, periodic re-consent (for EU accounts Revolut's Open Banking docs say 180 days), less detail (no `legs`, MCC, receipts or card info).
- FinTS/HBCI: as far as I know Revolut does not offer it **(UNVERIFIED)**.
- For a Grow+ customer the direct Business API is clearly better.

---

## 10. Node/TypeScript sketch

```ts
// revolut/config.ts
export const REVOLUT_BASE = process.env.REVOLUT_ENV === 'sandbox'
  ? 'https://sandbox-b2b.revolut.com/api' : 'https://b2b.revolut.com/api';
export const API_V1 = `${REVOLUT_BASE}/1.0`;
export const API_V2 = `${REVOLUT_BASE}/2.0`;
```

```ts
// revolut/auth.ts
import { SignJWT } from 'jose';
import { createPrivateKey, KeyObject } from 'node:crypto';
import { API_V1 } from './config';

interface TokenStore {               // implement with your DB; encrypt the refresh token at rest
  getRefreshToken(): Promise<string | null>;
  setRefreshToken(t: string): Promise<void>;
  markReconsentRequired(reason: string): Promise<void>;
}

export class RevolutAuth {
  private key: KeyObject;
  private access?: { token: string; expiresAt: number };
  private inflight?: Promise<string>;

  constructor(privateKeyPem: string, private clientId: string,
              private issuerDomain: string /* e.g. "books.example.de" */, private store: TokenStore) {
    this.key = createPrivateKey(privateKeyPem);        // accepts PKCS#1 and PKCS#8
  }

  private clientAssertion(): Promise<string> {
    return new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(this.issuerDomain)                    // = redirect-URI domain, no scheme
      .setSubject(this.clientId)
      .setAudience('https://revolut.com')
      .setExpirationTime('5m')                         // short-lived per Revolut's advice
      .sign(this.key);
  }

  private async tokenCall(params: Record<string, string>) {
    const body = new URLSearchParams({
      ...params,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: await this.clientAssertion(),
    });
    const res = await fetch(`${API_V1}/auth/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(`token ${res.status}: ${json.error_description ?? json.message ?? ''}`),
                                     { status: res.status, body: json });
    return json as { access_token: string; token_type: string; expires_in: number; refresh_token?: string };
  }

  /** One-time: called from your OAuth callback (?code=...) within 2 minutes. */
  async exchangeCode(code: string) {
    const t = await this.tokenCall({ grant_type: 'authorization_code', code });
    if (!t.refresh_token) throw new Error('no refresh_token returned');
    await this.store.setRefreshToken(t.refresh_token);
    this.access = { token: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 };
  }

  /** Single-flight: refreshing invalidates the previous access token. */
  async getAccessToken(): Promise<string> {
    if (this.access && Date.now() < this.access.expiresAt - 120_000) return this.access.token;
    this.inflight ??= (async () => {
      try {
        const rt = await this.store.getRefreshToken();
        if (!rt) throw new Error('not connected');
        const t = await this.tokenCall({ grant_type: 'refresh_token', refresh_token: rt });
        this.access = { token: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 };
        return t.access_token;                         // response has NO new refresh_token: keep the old one
      } catch (e: any) {
        if (e.status === 400 || e.status === 401) await this.store.markReconsentRequired(String(e.message));
        throw e;
      } finally { this.inflight = undefined; }
    })();
    return this.inflight;
  }

  consentUrl(redirectUri: string, scopes = 'READ') {
    const u = new URL('https://business.revolut.com/app-confirm');   // sandbox: https://sandbox-business.revolut.com/app-confirm (UNVERIFIED path)
    u.search = new URLSearchParams({ client_id: this.clientId, redirect_uri: redirectUri,
                                     response_type: 'code', scope: scopes }).toString();
    return u.toString();
  }
}
```

```ts
// revolut/client.ts
import { API_V1 } from './config';
import type { RevolutAuth } from './auth';

export interface Leg { leg_id: string; account_id: string; amount: number; fee?: number; currency: string;
  bill_amount?: number; bill_currency?: string; description?: string; balance?: number;
  counterparty?: { account_type: 'self' | 'revolut' | 'external'; account_id?: string; id?: string } }
export interface Transaction { id: string; type: string; state: 'created'|'pending'|'completed'|'declined'|'failed'|'reverted';
  request_id?: string; reason_code?: string; created_at: string; updated_at: string; completed_at?: string;
  scheduled_for?: string; related_transaction_id?: string; reference?: string;
  merchant?: { id?: string; name?: string; full_name?: string; city?: string; category_code?: string; country?: string };
  legs: Leg[]; card?: { id: string; card_number: string; first_name?: string; last_name?: string;
  references?: { name: string; value: string }[] }; auth_code?: string }

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let last = 0;                                            // ~1 req/s keeps us below 60/min
async function throttle() { const w = last + 1050 - Date.now(); if (w > 0) await sleep(w); last = Date.now(); }

export class RevolutClient {
  constructor(private auth: RevolutAuth) {}

  async get<T>(path: string, attempt = 0): Promise<T> {
    await throttle();
    const res = await fetch(`${API_V1}${path}`, { headers: { Authorization: `Bearer ${await this.auth.getAccessToken()}` } });
    if ((res.status === 429 || res.status >= 500) && attempt < 5) { await sleep(2 ** attempt * 2000); return this.get(path, attempt + 1); }
    if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  accounts() { return this.get<any[]>('/accounts'); }
  bankDetails(id: string) { return this.get<any[]>(`/accounts/${id}/bank-details`); }
  transaction(id: string) { return this.get<Transaction>(`/transaction/${id}`); }

  /** Newest → oldest; `from` inclusive, `to` exclusive. Cursor kept as RAW string (µs precision). */
  async *transactions(opts: { from: string; to?: string; account?: string; states?: string[] }) {
    const PAGE = 1000;
    let to = opts.to;
    for (;;) {
      const qs = new URLSearchParams({ from: opts.from, count: String(PAGE) });
      if (to) qs.set('to', to);
      if (opts.account) qs.set('account', opts.account);
      opts.states?.forEach(s => qs.append('state', s));
      const page = await this.get<Transaction[]>(`/transactions?${qs}`);
      yield* page;
      if (page.length < PAGE) return;
      const next = page[page.length - 1].created_at;
      if (next === to) throw new Error('pagination stuck (>1000 tx with identical created_at)');
      to = next;
    }
  }
}
```

```ts
// revolut/sync.ts (incremental run)
export async function syncRevolut(client: RevolutClient, db: Db) {
  const overlapFrom = new Date(Date.now() - 10 * 86400_000).toISOString();
  for await (const tx of client.transactions({ from: overlapFrom })) await upsertTx(db, tx);

  const pendingFrom = new Date(Date.now() - 60 * 86400_000).toISOString();
  for await (const tx of client.transactions({ from: pendingFrom, states: ['created', 'pending'] })) await upsertTx(db, tx);
  for (const id of await db.localNonFinalIdsNotSeenIn(pendingFrom)) await upsertTx(db, await client.transaction(id));
}

async function upsertTx(db: Db, tx: Transaction) {
  // 1) append raw JSON to revolut_tx_revisions(id, updated_at, json, fetched_at) if (id, updated_at) is new
  // 2) upsert revolut_tx by id; upsert legs by (tx_id, account_id, leg_id)
  // 3) if state transitioned to completed -> create booking proposal; if completed->reverted -> Storno
}
```

```ts
// revolut/webhook.ts (needs the RAW body: express.raw({type:'application/json'}) / Fastify rawBody)
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyRevolutSignature(raw: Buffer | string, tsHeader: string | undefined,
    sigHeader: string | undefined, secrets: string[], toleranceMs = 5 * 60_000): boolean {
  if (!tsHeader || !sigHeader) return false;
  const ts = Number(tsHeader);                                  // milliseconds
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > toleranceMs) return false;
  const msg = `v1.${tsHeader}.${typeof raw === 'string' ? raw : raw.toString('utf8')}`;
  const provided = sigHeader.split(',').map(s => Buffer.from(s.trim()));
  return secrets.some(secret => {
    const expected = Buffer.from('v1=' + createHmac('sha256', secret).update(msg).digest('hex'));
    return provided.some(p => p.length === expected.length && timingSafeEqual(p, expected));
  });
}

// handler
app.post('/webhooks/revolut', express.raw({ type: '*/*' }), async (req, res) => {
  if (!verifyRevolutSignature(req.body, req.header('Revolut-Request-Timestamp'),
        req.header('Revolut-Signature'), await secrets.activeRevolutSecrets())) return res.sendStatus(401);
  res.sendStatus(200);                                          // ack fast; work async
  const evt = JSON.parse(req.body.toString('utf8'));
  if (evt.event === 'TransactionCreated') await queue.upsert(evt.data);
  else if (evt.event === 'TransactionStateChanged') await queue.refetch(evt.data.id); // payload has no amounts
});
// create once (WRITE scope): POST ${API_V2}/webhooks {url, events:["TransactionCreated","TransactionStateChanged"]}
```

**Secrets storage:**
- Generate `privatecert.pem` on the server. Mount it read-only with mode `0600` or as a Docker/systemd credential. It never leaves the host.
- Store the refresh token and webhook signing secret encrypted (AES-256-GCM with a key from an env var/KMS) in the DB.
- Keep the access token in memory only.
- The ClientID is not secret.
- Redact `Authorization`, `client_assertion`, `refresh_token` and `code` from all logs.
- During webhook secret rotation keep old and new secrets (max 7 days overlap) and try both.

---

## 11. German bookkeeping implications

- **IBAN/BIC (DE vs LT):** German business customers are served by **Revolut Bank UAB** (Lithuania; deposit protection is Lithuanian). There is a **Revolut Bank UAB, Zweigniederlassung Deutschland** (Berlin, HRB 249024 B), which issues DE IBANs to personal customers. Its BIC is listed as **`REVODEB2`/`REVODEB2XXX`**.
  - Whether **business** accounts get DE IBANs today is **conflicting/UNVERIFIED**. Some 2025–26 sources say LT IBANs only, with DE IBANs for business "announced for end of 2026". Another says business customers already get them. Older LT business IBANs typically use BIC `REVOLT21` **(UNVERIFIED)**.
  - **Don't hard-code it.** Read `iban`, `bic` and `bank_country` from `/accounts/{id}/bank-details` and store them per account. After a migration, the old LT IBAN reportedly keeps receiving payments.
  - For tax purposes it is a foreign bank account; consider whether this affects your filings.
- **Accounts:** map each Revolut `account_id` (currency pocket) to its own Finanzkonto, for example SKR03 1200ff / SKR04 1800ff. Foreign-currency pockets are Fremdwährungskonten: convert at transaction date, and revalue at year-end under §256a HGB.
- **Exchanges and internal transfers:** both legs of one transaction belong to one booking (or go via Geldtransit, SKR03 1360 / SKR04 1460). FX gains/losses go to Erträge/Aufwendungen aus Kursdifferenzen (SKR03 2660/2150, SKR04 4840/6880).
- **Fees:** `legs[].fee` is a field on the leg, not a separate leg. Split it into its own booking line to **Nebenkosten des Geldverkehrs** (SKR03 4970 / SKR04 6855), with no VAT. Card FX charges (0.6% above the interbank allowance, 1% outside market hours according to the DE plan page) most likely appear in `fee` or are priced into the rate **(UNVERIFIED which)**. Stand-alone `type=fee` transactions (plan fee, extra transfers) are booked the same way.
- **Merchant matching for receipts:**
  - Use `merchant.name` (cleaned), `merchant.full_name` (raw descriptor, for example `ACME*1234MN1HA2`), `legs[].description`, `merchant.category_code` (MCC, useful for auto-categorising), `merchant.country`/`city`.
  - Use `bill_amount`/`bill_currency` to match foreign-currency invoices.
  - `card.references` (company cards) and `auth_code` help too.
  - Receipts the owner uploaded in Revolut come through `/expenses` → `receipt_ids` → `/content`.
- **Revolut's own invoices and VAT:**
  - **Plan subscription fees: VAT-exempt.** The help centre says: "you can't download an invoice, as it's tax-exempt". You get a **billing statement** under Profile → 'Your plan' → Billing → Documents/History. The exemption covers financial services (§4 Nr. 8 UStG / Art. 135 VAT Directive). Plan, exchange, payment and payment-acceptance fees are exempt. So **no §13b reverse charge arises on plan fees**, because the service is exempt. Book them without VAT and keep the billing statement as the Beleg.
  - **Expenses subscription charges are subject to VAT** and come with a VAT invoice, available 24 hours after the charge.
    - If the invoice is from Revolut Bank UAB (Lithuania) to a German business, this is normally a **§13b UStG reverse charge**: UStVA Kz 46/47 plus input tax Kz 67.
    - If it is issued by the German branch with German VAT shown, it is a normal input-tax invoice.
    - Check the actual invoice and confirm with your Steuerberater **(UNVERIFIED)**.
- **GoBD:**
  - API data can change (pending → completed, amounts at settlement). Keep an **append-only raw-JSON revision log**.
  - Book only `completed` transactions. Never delete; use Storno for `reverted`.
  - Archive the official statements (signed PDF and/or CAMT.053) per currency and period as the bank record.
  - Bank statements are Buchungsbelege. From 2025 (BEG IV) the retention period for Buchungsbelege is 8 years instead of 10 **(confirm with your tax advisor)**.
  - Statements and the API both use UTC; convert to Europe/Berlin for the booking date (around midnight at period ends this can move a transaction into another day or month).
- **Counterparty data gap:** for incoming SEPA payments the API gives no IBAN or name field, only `description`/`reference`. That is weak for matching open invoices. Matching on `reference` and amount usually works. Enrich from the CAMT.053 export if you need payer IBANs.

---

## Uncertain points to test in sandbox or production before relying on them
1. Whether `amount` already includes `fee` (check with balance continuity).
2. Whether `leg_id` is unique per leg in practice.
3. Whether the business account's IBAN is DE or LT today.
4. Whether webhooks created with a temporary WRITE certificate keep working after that access is revoked.
5. Refresh-token revocation triggers.
6. Exact current CSV columns, and whether CSV `ID` equals the API `id`.
7. Sandbox consent host for `app-confirm` (probably `sandbox-business.revolut.com`).
8. Whether `localhost` is accepted as a redirect URI.

## Sources
- OpenAPI spec (official, current): https://github.com/revolut-engineering/revolut-openapi (`json/business.json`)
- Make your first API request (auth): https://developer.revolut.com/docs/guides/manage-accounts/get-started/make-your-first-api-request
- Sandbox setup: https://developer.revolut.com/docs/guides/manage-accounts/get-started/prepare-sandbox-environment
- Retrieve transactions: https://developer.revolut.com/docs/guides/manage-accounts/accounts-and-transactions/retrieve-transactions
- Map transactions and cards: https://developer.revolut.com/docs/guides/manage-accounts/accounts-and-transactions/map-transaction-data
- Account details: https://developer.revolut.com/docs/guides/manage-accounts/accounts-and-transactions/manage-your-accounts
- Expenses and receipts: https://developer.revolut.com/docs/guides/manage-accounts/accounts-and-transactions/retrieve-expenses
- About webhooks: https://developer.revolut.com/docs/guides/manage-accounts/webhooks/about-webhooks
- Manage webhooks: https://developer.revolut.com/docs/guides/manage-accounts/webhooks/manage-webhooks
- Verify payload signature: https://developer.revolut.com/docs/guides/manage-accounts/webhooks/verify-the-payload-signature
- Usage and limits: https://developer.revolut.com/docs/guides/manage-accounts/api-usage-and-testing/usage-and-limits
- Errors: https://developer.revolut.com/docs/guides/manage-accounts/api-usage-and-testing/errors
- Simulations: https://developer.revolut.com/docs/guides/manage-accounts/api-usage-and-testing/test-flows-with-simulations
- Help centre, Business API requirements: https://help.revolut.com/business/help/integrating-with-external-apps/revolut-business-api/question-using-revolut-business-api/
- Help centre, account statements: https://help.revolut.com/business/help/managing-my-business/viewing-my-account-statements/how-to-get-a-monthly-statement/
- Help centre, plan billing statement (tax-exempt): https://help.revolut.com/en-DE/business/help/setting-up-an-account/selecting-a-business-plan/can-i-have-an-invoice-for-your-charges/
- Help centre, Open Banking history: https://help.revolut.com/business/help/integrating-with-external-apps/open-banking/how-much-historical-data-can-i-sync-open-banking/
- DE plans and prices: https://www.revolut.com/de-DE/business/business-account-plans/
- Open Banking refresh-token blog (Open Banking API, not the Business API): https://developer.revolut.com/blog/2025-03-19-open-banking-refresh-tokens
- Community CSV parsers (column names, unofficial): github.com/enobase/demo-coda-export, BananaAccounting/Universal, TolgaV/revolut-business-to-freeagent, nikolausm/Revolut2Lexoffice
- German IBAN/branch (secondary sources): handelsblatt.com/geschaeftskonto/anbieter/revolut/, gruendung.de, vivid.money, revolut.com/en-DE/legal/terms/

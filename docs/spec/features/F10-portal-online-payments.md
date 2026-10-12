# F10 — Customer Portal, E-Signature and Online Payments
> **Status:** v1.1 · 2026-10-12 · **Deferred (needs public exposure)** — not part of any phase gate · **Phases:** none while deferred (was P4) · **sevdesk parity:** research 00 §4.9 (PayPal link only), §6 (digital acceptance, undocumented); research 02 MUST #1, #2, #4, SHOULD #17, #19 · **Edge cases:** [10-edge-cases.md](../10-edge-cases.md) EC-079, EC-120, EC-129, EC-187; RI-09, RI-10 · **Compliance:** MISC-01, MISC-02, MISC-03, MAIL-01, MAIL-02, UST-30, UST-32, UST-34, GOBD-06, GOBD-07, DSGVO-04, DSGVO-05, SEC-02, SEC-06, AO-04

> **⏸ Deferred (needs public exposure).** Since the platform update of 2026-10-12 the app is **tailnet-only with no public host** (02 §4, ADR-016). Every part of this feature needs the internet to reach us: customers open `/p/[token]` from their own devices, and Stripe/Mollie/PayPal deliver webhooks to `/api/webhooks/*`. Neither is possible without a public endpoint, so F10 is **out of scope** and removed from all phase gates (09). The content below is kept unchanged as a **future option**; it assumes a public `api.` host and must be re-designed for the then-current security model (Better Auth login, `user:` actors, tailnet edge) before it is revived. While deferred: the actor kind `portal:` is reserved but never minted (03 §0.1), the `portal:manage` scope is not offered (05 §2.2), the portal/payment webhook events are never emitted (05 §5.3), and no `/p/**` or `/api/webhooks/**` route exists. SEPA pain.008 file generation without the portal (POR-021…024) could be revived separately because it needs no inbound traffic — open question for the owner.

## 1. Scope (in / out, and what we do better than sevdesk)

**In scope**
- Public **customer portal** on the `api.` host at `/p/[token]`: view a document chain (quote → order confirmation → invoices, corrections, reminders), download the archived PDF/XML, see payment status, pay online.
- **Quote acceptance** with a simple electronic signature (typed name + optional drawn signature + consent checkbox) and an evidence record bound to the hash of the accepted snapshot; **decline** and **request changes**.
- **B2C withdrawal button** for contracts concluded through the portal (EU Directive 2023/2673, applicable from 2026-06-19 — **German implementation to be verified**).
- **Online payments** behind a `PaymentProvider` abstraction: Stripe Checkout (cards, SEPA Direct Debit, Wero if offered ⚠, Klarna ⚠), Mollie, PayPal; webhooks → `payments` + fee bookings + payout reconciliation with Revolut.
- **SEPA mandates** (own creditor ID) + pre-notification + **pain.008** export (MISC-02), return-debit handling.
- **Subscriptions auto-charge** on recurring invoices (saved card/SEPA via provider, or own mandate).
- **View tracking** (first view, count) with bot filtering.
- Portal security: hashed tokens, expiry, revocation, rate limits, no sequential IDs, `noindex`.

**Out of scope**
- Customer accounts with passwords; a contact-level "all my documents" portal (COULD later via a contact-scoped magic link).
- Qualified electronic signatures (QES) or advanced signatures (AdES); shop/checkout for anonymous buyers (website integration uses the REST API, 05-api §6).
- POS / cash sales (AO-04). Card-present payments.
- Payment initiation from our own Revolut account (payouts to suppliers).

**Better than sevdesk**
- sevdesk has only a PayPal.me link (research 00 §4.9) and no hosted page, no e-signature evidence, no SEPA mandate handling, no auto-charge. We provide all of these, with every portal action attributed (`portal:<tokenId>`) and audited.

## 2. User stories

| # | As … | I want … | so that … |
|---|---|---|---|
| US-01 | customer | to open a link and see my invoice, download PDF/XML and pay by card/SEPA | I can pay in one minute |
| US-02 | customer | to accept a quote online with my name | I don't have to print and sign |
| US-03 | customer (consumer) | a clearly labelled withdrawal button | I can exercise my legal withdrawal right easily |
| US-04 | owner | proof of what exactly the customer accepted (hash, time, IP, UA) | the acceptance holds up in a dispute |
| US-05 | owner | online payments to be booked automatically incl. provider fees | I never reconcile Stripe by hand |
| US-06 | owner | SEPA mandates and a pain.008 file for my retainer customers | recurring customers pay on time |
| US-07 | owner | subscriptions charged automatically after the invoice is issued | retainers run hands-off |
| US-08 | owner | to know when a customer viewed a quote | I can follow up at the right moment |
| US-09 | owner | to revoke a leaked link and send a new one | a forwarded e-mail doesn't expose data forever |
| US-10 | Claude (MCP) | to create a portal link for a document | I can send it in a chat-drafted e-mail |

## 3. Functional requirements

| ID | Requirement | Priority | Phase | Compliance refs |
|---|---|---|---|---|
| POR-001 | Portal route `/p/[token]` served only on `api.<domain>` (02 §4.1 allowlist); resolves the token to a `portalTokens` row (by SHA-256 hash, constant-time) and mints a portal JWT (`portal:<tokenId>`, scopes `portal:read`, `portal:accept`, `portal:pay`, limited to the chain root) | MUST | P4 | SEC-02, SEC-06 |
| POR-002 | Token = 32 random bytes, base64url (43 chars); stored as SHA-256 hash for lookup **and** AES-256-GCM ciphertext (`APP_ENCRYPTION_KEY`) so the owner can re-display/copy the link; the plaintext never appears in logs, audit diffs or webhooks | MUST | P4 | SEC-06, DSGVO-05 |
| POR-003 | Token lifecycle: created on finalisation when `portalEnabled` (or on demand); default expiry: quotes = `validUntil` + 30 days; invoices = paid date + 180 days, max 3 years; configurable; revocation immediate; "Link neu erzeugen" revokes the old token and creates a new one; expired/revoked tokens show a neutral page with the company's contact data and no document data | MUST | P4 | DSGVO-05 |
| POR-004 | Chain view: documents of the chain root with type, number, date, amount, status (German labels), the archived PDF rendered inline (pdf.js), downloads of the archived original artifacts (ZUGFeRD-PDF, XRechnung-XML); drafts and internal notes are never shown; B2C documents show gross prices | MUST | P4 | UST-34, MISC-03, GOBD-06 |
| POR-005 | Portal downloads write `sendLog` entries (`channel: "portal"`, artifact hashes) on the first download per artifact; a portal download of the original counts as delivery, later downloads by the owner remain „Kopie" (UST-34) | MUST | P4 | MAIL-02, UST-34 |
| POR-006 | Payment status panel: open amount, due date, payments received (date, amount, method), EPC-QR (MISC-01) and bank details as alternatives to online payment | MUST | P4 | MISC-01 |
| POR-007 | **Quote acceptance**: only for finalised, not expired, not already accepted/rejected quotes; form: full name (required), optional e-mail confirmation, optional drawn signature (canvas → PNG), checkbox „Ich nehme das Angebot {nr} vom {datum} über {betrag} verbindlich an" + AGB link if configured; optional positions selectable only if the quote has optional lines (choice recorded) | MUST | P4 | GOBD-06 |
| POR-008 | Acceptance evidence (`salesDocuments.acceptance`, set once): `at` (UTC), `byName`, signature storage ID, IP (full, retention as the document), UA, token ID, `snapshotHash` of the quote snapshot **displayed at load time** (sent with the form; must equal the current snapshot hash), selected optional lines; an **acceptance PDF** (`documentArtifacts.kind = "acceptance_pdf"`): the original quote PDF + an evidence page (data above + SHA-256 of the quote PDF), hashed and archived | MUST | P4 | GOBD-06, GOBD-07 |
| POR-009 | After acceptance: quote status `accepted`, audit entry (actor `portal:<tokenId>`), webhook `quote.accepted`, notification, confirmation page + e-mail to the customer (if address known) with the acceptance PDF; configurable automation: create order confirmation draft / advance invoice draft / invoice draft (never auto-finalise without the owner's rule) | MUST | P4 | MAIL-02 |
| POR-010 | **Decline** (reason optional) → quote `rejected`; **request changes** (text required, ≤ 2,000 chars) → contact activity + notification, quote stays `sent`; both audited | MUST | P4 | — |
| POR-011 | **Withdrawal button** for consumer contracts concluded via the portal (quote accepted by a contact with `isConsumer`): a permanently visible button labelled „Vertrag widerrufen" during the withdrawal period (14 days from conclusion for services; for goods from receipt ⚠), leading to a confirmation step („Widerruf bestätigen") collecting name, contract identification (prefilled) and e-mail; on confirmation an acknowledgement of receipt with date and time is sent on a durable medium (e-mail + PDF) without undue delay; record in `withdrawals`; urgent notification to the owner. **Verify the German implementation (BGB amendment for Art. 11a CRD) before release** | MUST | P4 | — |
| POR-012 | Withdrawal information: the owner configures the Widerrufsbelehrung (template based on the statutory model, owner responsibility) shown before acceptance for consumers; for services, an optional checkbox for the express request to start before the end of the withdrawal period with acknowledgement of the consequences (stored in the evidence) | MUST | P4 | — |
| POR-013 | After a withdrawal the owner gets a guided workflow: Storno/Rechnungskorrektur for issued invoices (UST-30), refund of payments received within 14 days (via provider refund or manual), quote/order marked `withdrawn` (new status ⚠ data model) | MUST | P4 | UST-30 |
| POR-014 | **PaymentProvider abstraction** (`src/server/payments/provider.ts`): `createCheckout(doc, amountCents, methods, urls, idempotencyKey)`, `verifyWebhook(rawBody, headers)`, `fetchPayment(ref)`, `listFees(ref)`, `listPayout(payoutRef)`, `refund(ref, amountCents)`, `chargeSaved(customerRef, pmRef, amountCents)`; implementations Stripe, Mollie, PayPal; each provider configured in `integrations` with encrypted secrets, AVV confirmation and region (DSGVO-04 warning for non-EU processing) | MUST | P4 | DSGVO-04 |
| POR-015 | **Stripe Checkout**: one session per (invoice, open amount, invoice version); methods configurable (card, sepa_debit, klarna ⚠, wero ⚠ if available in Stripe for the account); `metadata = { documentId, tokenId }`; success/cancel URLs back to the portal; session reuse while open; SEPA debit is asynchronous (pending until `checkout.session.async_payment_succeeded`) | MUST | P4 | — |
| POR-016 | **Mollie** Payments API and **PayPal** Orders v2 as alternative providers with the same interface; Mollie webhooks are verified by fetching the payment from the API; PayPal via the webhook signature verification API | SHOULD | P4 | — |
| POR-017 | Webhooks at `/api/webhooks/{stripe,mollie,paypal}`: signature verified on the raw body; event persisted in `providerEvents` (unique `(provider, eventId)`); processing is idempotent and order-independent (the handler fetches the current provider payment state and converges); unknown events acknowledged with 200 and ignored | MUST | P4 | GOBD-03 |
| POR-018 | Successful provider payment → `payments` row (`source: { kind: "provider", provider, ref }`, date = provider charge date in Europe/Berlin, amount actually paid) on the invoice; journal per F08: S `clearing.<provider>` · H `receivable`; fees from the provider balance transaction → separate entry S `expense.bank_fees` · H `clearing.<provider>` with the provider's fee tax rule (Stripe/Mollie: EU reverse charge ⚠, PayPal: exempt ⚠ — confirm with Steuerberater); the provider statement/receipt is the voucher (GoBD Rz. 121 relief noted in the Verfahrensdokumentation) | MUST | P4 | GOBD-07, UST-32 |
| POR-019 | Payout reconciliation: provider payouts (Stripe `payout.paid`, Mollie settlements, PayPal transfers) create an expected Geldtransit item; the **completed** Revolut bank transaction with the payout reference matches it (RI-10): S `bank.EUR` · H `clearing.<provider>`; open clearing balance > 0 for > 7 days → warning | MUST | P4 | GOBD-01, GOBD-02 |
| POR-020 | Refunds (owner-initiated in the app or provider-side) → payment reversal (partial allowed) + prompt to create a Rechnungskorrektur when it is a commercial refund; chargebacks/disputes → payment reversal, dispute fee entry, dunning paused, urgent notification | MUST | P4 | UST-30, UST-32 |
| POR-021 | **SEPA mandates** (`sepaMandates`): capture in the portal (name, address, IBAN validated with `ibantools`, BIC optional, consent text per SEPA rulebook with creditor ID and mandate reference, date, CORE/B2B, OOFF/RCUR) or upload of a signed paper mandate; unique mandate reference ≤ 35 chars `[A-Za-z0-9+?/\-:().,' ]`; revocation; expiry after 36 months without a collection | MUST | P4 | MISC-02 |
| POR-022 | Pre-notification: invoices for mandate customers print „Der Betrag von {betrag} wird am {datum} per SEPA-Lastschrift von Ihrem Konto {IBAN maskiert} eingezogen. Mandatsreferenz: {ref}, Gläubiger-ID: {id}." with collection date ≥ invoice date + pre-notification days (default 14, minimum 1 if agreed in the mandate) | MUST | P4 | MISC-02 |
| POR-023 | **pain.008** export: collection run selects open invoices with active mandates and collection date ≤ chosen date → file `pain.008.001.08` (version configurable, `.001.02` legacy ⚠) validated against the XSD; sequence type per mandate history (first collection FRST or RCUR ⚠ per bank); batch booking; file + SHA-256 stored; invoices flagged „Einzug beauftragt". **Revolut Business acceptance of pain.008 collection files is unverified** — if unsupported, use Stripe SEPA Direct Debit or a second bank (open question) | MUST (file) | P4 | MISC-02 |
| POR-024 | Collection booking: when the Revolut credit of the batch arrives, the matching splits it to the invoices (one payment per invoice); return debits (R-transactions with ISO reason codes, e.g. AC04, AM04, MD01, MD06, MS02) → payment reversal, return fee entry (`expense.bank_fees`), mandate flagged (MD01 → revoked), invoice reopened, dunning resumes after the configured grace, notification | MUST | P4 | MISC-02, GOBD-01 |
| POR-025 | **Subscriptions auto-charge**: a recurring template may set `autoCharge = { method: "stripe_card" \| "stripe_sepa" \| "own_sepa", customerRef, paymentMethodRef \| mandateId }`; after the generated invoice is finalised (F04 recurring automation) the charge is attempted (off-session PaymentIntent, or inclusion in the next SEPA run); SCA required → e-mail with portal pay link; failures retried on day +3 and +7, then normal dunning; each attempt audited | SHOULD | P4 | MISC-02 |
| POR-026 | Saved payment methods are referenced only by provider IDs (no card data stored; PCI scope stays with the provider); the customer can save a method only with explicit consent in the portal | MUST | P4 | DSGVO-05 |
| POR-027 | **View tracking**: a view counts after the page has been visible ≥ 2 s and a JS beacon `POST /p/[token]/seen` is received (link-preview bots and mail scanners don't execute it); known preview UAs ignored; the owner's „Kundenansicht" preview from `app.` is never counted; first view sets `salesDocuments.viewedAt`, every view updates `portalTokens.lastViewedAt/viewCount`; webhook `quote.viewed`/`invoice.viewed` (new events) | SHOULD | P4 | — |
| POR-028 | Security headers on `/p/*`: `X-Robots-Tag: noindex, nofollow, noarchive` + meta robots, `Referrer-Policy: no-referrer`, `Cache-Control: private, no-store`, strict nonce CSP, `frame-ancestors 'none'`, HSTS; no third-party scripts except the provider's redirect (Checkout is a redirect, not an embed) | MUST | P4 | SEC-06 |
| POR-029 | Rate limits: 60 requests/min per IP on `/p/*`; 10 state-changing POSTs per token per hour; 5 unknown-token lookups per IP per minute → 429 and temporary block (enumeration protection); webhook endpoints limited per provider IP range ⚠ but never dropping valid signed events | MUST | P4 | SEC-06 |
| POR-030 | No sequential or internal IDs in portal URLs or HTML (files by artifact kind under the token path); POSTs require a same-origin `Origin` header and a per-page CSRF token (double-submit cookie, `SameSite=Strict`) | MUST | P4 | SEC-06 |
| POR-031 | Portal pages show Impressum and Datenschutzerklärung links (owner-configured URLs; required before enabling the portal) and use the company's layout colours/logo; German default, English if the document language is EN | MUST | P4 | — |
| POR-032 | Portal consent: a customer who downloads PDF invoices from the portal can confirm „Ich bin mit dem Empfang von Rechnungen als PDF einverstanden" → appends a row to `contacts.einvoice.pdfConsents[]` with `source: "portal"` (MAIL-01) | SHOULD | P4 | MAIL-01 |

## 4. Workflows and state machines

### 4.1 Portal token

```
created(expiresAt) ──view──▶ active (lastViewedAt, viewCount)
    │                          │
    ├── revoke ───────────────▶ revoked  (terminal)
    └── expiresAt passed ─────▶ expired  (terminal; computed)
"Link neu erzeugen" = revoke(old) + create(new) in one mutation; audit "portal.token.rotate"
```

### 4.2 Quote acceptance

```
GET /p/{t}  → render quote snapshot S (hash h shown in a hidden field)
POST /p/{t}/accept {name, signature?, optionalLines?, consent, h, csrf}
  ├─ token valid, scope portal:accept, quote status ∈ {finalized, sent}, not expired, acceptance unset
  ├─ h == current snapshotHash (else 409 „Das Angebot wurde geändert")
  ├─ commit (single mutation): acceptance evidence, status accepted, audit, webhook outbox, notification
  └─ schedule: render acceptance_pdf (hash, archive), e-mail confirmation, automation drafts
Concurrent double submit → second request sees acceptance set → idempotent success page (same evidence)
```

### 4.3 Online payment

```
customer clicks "Jetzt bezahlen" → server creates/reuses checkout session (idempotency key = docId:openAmount:version)
→ redirect to provider → provider webhook(s)
   providerEvents insert (unique) ─ duplicate → 200, no-op
   fetch provider payment state → converge:
      succeeded & no payment for ref → create payment (+ fee entry)
      pending (SEPA)                 → mark invoice "Zahlung in Bearbeitung" (no payment yet)
      failed                         → clear pending, notify customer page
      refunded/disputed              → reversal flow (POR-020)
→ portal polls / revalidates: shows "Bezahlt" or "in Bearbeitung"
```

### 4.4 SEPA collection run

```
select invoices (open, mandate active, collection date reached) → preview (sum, count, mandates FRST/RCUR)
→ generate pain.008 (XSD-validated) → owner uploads to the bank (or provider) → mark "Einzug beauftragt"
→ bank credit arrives (Revolut) → match batch → payments per invoice
→ R-transaction (return) → reversal + fee + mandate update + notification
```

### 4.5 Withdrawal (consumer)

```
contract concluded via portal acceptance (isConsumer) → button visible until conclusion + 14 days (end of day, Europe/Berlin)
→ click „Vertrag widerrufen" → confirmation step → submit
→ withdrawals row (at, name, contract ref, e-mail, IP, UA) + audit + acknowledgement e-mail/PDF with timestamp
→ owner workflow: Storno/Korrektur, refunds ≤ 14 days, status withdrawn
```

## 5. Validation rules and edge cases (exhaustive; exact German error/warning messages)

| # | Case | Behaviour | Message (DE, customer-facing unless marked) |
|---|---|---|---|
| E-POR-01 | Unknown token | 404-like neutral page, counts toward enumeration limit | „Dieser Link ist ungültig. Bitte wenden Sie sich an {Firma}." |
| E-POR-02 | Revoked token (e.g. leaked and rotated) | Neutral page, no document data, no indication whether the document exists | „Dieser Link ist nicht mehr gültig. Bitte wenden Sie sich an {Firma} ({E-Mail}, {Telefon})." |
| E-POR-03 | Expired token | Same as revoked | „Dieser Link ist abgelaufen. …" |
| E-POR-04 | Token leaked (owner action) | Owner: „Link sperren und neu senden" → rotation + e-mail with the new link; old PDFs with printed QR show E-POR-02 | Owner: „Der alte Link ist ab sofort gesperrt." |
| E-POR-05 | Too many requests | 429 | „Zu viele Anfragen. Bitte versuchen Sie es in einigen Minuten erneut." |
| E-POR-06 | Accept an expired quote | Blocked | „Dieses Angebot war bis zum {datum} gültig und kann nicht mehr angenommen werden. Bitte fordern Sie ein neues Angebot an." |
| E-POR-07 | Accept an already accepted/rejected quote | Idempotent display of the existing result | „Dieses Angebot wurde am {datum} von {name} angenommen." / „… abgelehnt." |
| E-POR-08 | Snapshot hash mismatch (a correction/new version was issued meanwhile) | Blocked; points to the newest quote in the chain | „Das Angebot wurde inzwischen aktualisiert. Bitte prüfen Sie die aktuelle Fassung." |
| E-POR-09 | Name missing / consent unchecked | Field errors | „Bitte geben Sie Ihren vollständigen Namen ein." / „Bitte bestätigen Sie die verbindliche Annahme." |
| E-POR-10 | Consumer without Widerrufsbelehrung configured | Acceptance disabled for consumers; owner warning | Owner: „Für Verbraucher fehlt die Widerrufsbelehrung (Einstellungen › Portal)." |
| E-POR-11 | Withdrawal after the period | Button hidden; direct POST rejected | „Die Widerrufsfrist ist am {datum} abgelaufen." |
| E-POR-12 | Withdrawal submitted twice | Idempotent, same acknowledgement | „Ihr Widerruf vom {datum, uhrzeit} liegt uns bereits vor." |
| E-POR-13 | Payment webhook replayed / duplicated | `providerEvents` unique → no second payment | — |
| E-POR-14 | Webhook events out of order (refund before success) | Converge on fetched provider state; no negative states | — |
| E-POR-15 | Invalid webhook signature | 400, logged (no body), alert after 10 in 1 h | — |
| E-POR-16 | Customer pays while a bank transfer for the same invoice also arrives | Second payment → overpayment credit; owner notified to refund | Owner: „Rechnung {nr} wurde doppelt bezahlt (Online und Überweisung)." |
| E-POR-17 | Checkout for an invoice paid meanwhile | Session not created | „Diese Rechnung ist bereits bezahlt. Vielen Dank!" |
| E-POR-18 | Open amount changed after a session was created (partial payment) | New session with new idempotency key; old session expired via API | — |
| E-POR-19 | Provider payment in a different currency than the invoice | Rejected, refund flow, owner notified | Owner: „Zahlung in {währung} passt nicht zur Rechnungswährung {währung}." |
| E-POR-20 | Amount paid < open amount (provider-side adjustment) | Partial payment recorded | — |
| E-POR-21 | SEPA debit pending then failed | Pending flag removed; invoice stays open; customer sees „Lastschrift fehlgeschlagen" | „Die Lastschrift konnte nicht eingezogen werden. Bitte zahlen Sie per Überweisung oder Karte." |
| E-POR-22 | Chargeback | Payment reversed, fee booked, dunning paused | Owner: „Rückbuchung (Chargeback) für {nr}: {betrag} €." |
| E-POR-23 | Fee posting into a locked period (late webhook) | F08 late-posting rule | — |
| E-POR-24 | Mandate reference not unique / invalid characters | Blocked | Owner: „Die Mandatsreferenz ist ungültig oder bereits vergeben." |
| E-POR-25 | Collection date earlier than pre-notification allows | Blocked | Owner: „Einzug frühestens am {datum} (Vorabankündigung {n} Tage)." |
| E-POR-26 | Mandate unused > 36 months | Expired; collection blocked | Owner: „Mandat {ref} ist verfallen (36 Monate ohne Einzug)." |
| E-POR-27 | Return debit MD01 (no mandate) | Mandate revoked, notify | Owner: „Rücklastschrift {nr}: kein gültiges Mandat (MD01)." |
| E-POR-28 | B2B mandate (scheme B2B) for a consumer | Blocked | Owner: „SEPA-Firmenlastschrift ist nur für Unternehmenskunden zulässig." |
| E-POR-29 | Auto-charge requires SCA | E-mail with pay link; no retry storm | — |
| E-POR-30 | Provider configured with non-EU processing and no AVV | Enabling blocked until AVV confirmed; warning (DSGVO-04, AO-06 for data location) | Owner: „Bitte Auftragsverarbeitungsvertrag bestätigen. Der Anbieter verarbeitet Daten ggf. außerhalb der EU." |
| E-POR-31 | Portal enabled without Impressum/Datenschutz URLs | Blocked | Owner: „Impressum und Datenschutzerklärung sind für das Kundenportal erforderlich." |
| E-POR-32 | Owner preview opened | Not counted as a view | — |
| E-POR-33 | Restricted contact (DSGVO Art. 18) | Portal links of that contact revoked automatically; new links blocked | Owner: „Kontakt ist gesperrt (DSGVO) – Portal-Links deaktiviert." |
| E-POR-34 | Portal POST without valid Origin/CSRF token | 403 | „Die Anfrage konnte nicht überprüft werden. Bitte laden Sie die Seite neu." |

## 6. UI

**Public portal (`/p/[token]`, mobile-first):** header with logo and company name; document card (Typ, Nummer, Datum, Betrag, Status badge, „fällig am"); inline PDF (full-screen sheet on mobile); buttons „PDF herunterladen", „E-Rechnung (XML)"; payment panel („Jetzt bezahlen" with method icons, EPC-QR, bank details); for quotes: „Angebot annehmen" (drawer with name, optional signature pad, consent, Widerrufsbelehrung link for consumers), „Ablehnen", „Änderung anfragen"; chain list („Zugehörige Dokumente"); withdrawal button for eligible consumer contracts; footer with Impressum/Datenschutz. Visual regression baseline exists (04-ui-ux §11).

**Owner UI:** document detail → „Kundenportal" panel (link copy, QR, expiry, views, „Link sperren und neu erzeugen", „Kundenansicht öffnen"); `/einstellungen/portal` (enable, expiry defaults, legal URLs, Widerrufsbelehrung, automation after acceptance); `/einstellungen/zahlungen` (providers, methods, fee tax rule per provider with ⚠ „mit Steuerberater bestätigen", AVV checkbox, webhook URLs + test); `/bank/lastschriften` (mandates, collection runs, pain.008 downloads, returns); contact detail → Mandate tab.

## 7. API and MCP exposure

| Method | Path | Scope | Notes |
|---|---|---|---|
| POST | `/portal-links` | portal:manage | `{ document_id, expires_at? }` → `{ id, url, expires_at }` |
| GET | `/portal-links?document_id=` | portal:manage | Includes views, status; URL re-displayed from ciphertext |
| POST | `/portal-links/{id}/revoke` / `/rotate` | portal:manage | |
| POST | `/invoices/{id}/payment-link` | portal:manage | Portal link focused on payment |
| GET/POST | `/sepa-mandates`, POST `/sepa-mandates/{id}/revoke` | payments:write | |
| POST | `/sepa/collection-runs` → `{ file_url }` | payments:write | |
| POST | `/api/webhooks/stripe` · `/mollie` · `/paypal` | provider signature | Not under `/api/v1` |

MCP: `portal_link_create` (W, scope `portal:manage`; returns URL and expiry; never returns other customers' data). Viewing status is part of `document_get`. No MCP tools for refunds, mandates or collection runs (owner actions).

Webhooks (additions, proposed): `quote.viewed`, `invoice.viewed`, `quote.change_requested`, `contract.withdrawn`, `payment.pending`, `payment.failed`, `payment.disputed`, `sepa.returned`.

## 8. Acceptance tests

| Test ID | Given / When / Then | Type | Covers req IDs |
|---|---|---|---|
| TST-POR-01 | Portal token created / then DB stores only hash + ciphertext; logs and audit contain no plaintext | C | POR-002, SEC-06 |
| TST-POR-02 | `/p/*` on `app.` host → 404; on `api.` → page; random token → neutral page | E | POR-001, SEC-01 |
| TST-POR-03 | Token leaked: owner rotates / then old URL shows E-POR-02 without document data, new URL works, audit `portal.token.rotate` | C, E | POR-003, E-POR-02, E-POR-04, EC-187 |
| TST-POR-04 | Expired token / then E-POR-03; revoked contact (DSGVO restriction) → links revoked | C | POR-003, E-POR-33, DSGVO-02 |
| TST-POR-05 | 6 unknown-token requests from one IP within a minute / then 429 | C | POR-029, EC-187 |
| TST-POR-06 | Portal download of the original PDF / then bytes equal the archived artifact (SHA-256) and a `sendLog` portal entry exists | C | POR-004, POR-005, MAIL-02 |
| TST-POR-07 | Accept quote / then acceptance evidence with snapshotHash = stored hash, acceptance PDF archived with SHA-256, status accepted, webhook `quote.accepted`, audit actor `portal:<tokenId>` | C, E | POR-007, POR-008, POR-009, GOBD-06 |
| TST-POR-08 | Accept with stale hash / then 409 E-POR-08 | C | POR-008, EC-079 |
| TST-POR-09 | Two concurrent accept POSTs / then one evidence record, both responses show the same result | C (integration) | POR-008, E-POR-07, EC-079 |
| TST-POR-10 | Accept after `validUntil` / then E-POR-06 | C | POR-007 |
| TST-POR-11 | Consumer accepts via portal / then withdrawal button visible until day 14; submit → acknowledgement e-mail with timestamp, `withdrawals` row, owner notification; day 15 → E-POR-11 | C, E | POR-011, POR-012 |
| TST-POR-12 | Withdrawal workflow / then Storno draft suggested for the invoice and refund task created | C | POR-013, UST-30 |
| TST-POR-13 | Stripe `checkout.session.completed` delivered twice (replay) / then exactly one payment and one fee entry | C | POR-017, POR-018, E-POR-13, EC-142 (pattern) |
| TST-POR-14 | Events out of order (refund webhook before success) / then final state: payment + reversal, no errors | C | POR-017, E-POR-14, EC-142 (pattern) |
| TST-POR-15 | Invalid signature / then 400, no event stored | C | POR-017, E-POR-15 |
| TST-POR-16 | Successful card payment 119 € with fee 1.78 € / then S clearing/H receivable 119; S bank fees/H clearing 1.78; payout matched to Revolut credit 117.22 € → clearing 0 | C, G | POR-018, POR-019, GOBD-01 |
| TST-POR-17 | SEPA via Stripe pending then failed / then no payment, invoice open, customer message E-POR-21 | C | POR-015, E-POR-21 |
| TST-POR-18 | Chargeback / then reversal, dispute fee, dunning paused, notification | C | POR-020, EC-129 |
| TST-POR-19 | Online payment and bank transfer for the same invoice / then overpayment credit and owner notification | C | E-POR-16, EC-120 |
| TST-POR-20 | pain.008 run with 3 invoices / then XSD-valid file, correct sequence types, sum and count; collection date respects pre-notification | U, G | POR-022, POR-023, MISC-02 |
| TST-POR-21 | Return debit MD01 on one invoice / then payment reversed, fee booked, mandate revoked, invoice reopened | C | POR-024, MISC-02, EC-129 |
| TST-POR-22 | Mandate unused 36 months / then expired and blocked | U | POR-021 |
| TST-POR-23 | Recurring invoice with Stripe auto-charge, first attempt fails / then retries on +3/+7 then dunning; SCA → pay-link e-mail | C | POR-025 |
| TST-POR-24 | Preview bot (no JS beacon) / then no view; real browser after 2 s → `viewedAt` set; owner preview not counted | E | POR-027 |
| TST-POR-25 | Portal responses / then headers `X-Robots-Tag: noindex…`, `Referrer-Policy: no-referrer`, `Cache-Control: private, no-store`, CSP; HTML contains no Convex IDs | E | POR-028, POR-030 |
| TST-POR-26 | POST without Origin/CSRF / then 403 | C | POR-030 |
| TST-POR-27 | Enabling a provider without AVV / then blocked (E-POR-30) | C | POR-014, DSGVO-04 |
| TST-POR-28 | Portal pages on iPhone and desktop / then axe clean, visual baselines | E, V | POR-004, MISC-10 |
| TST-POR-29 | Provider sandbox E2E (Stripe test mode): pay invoice via card / then invoice paid in the app within 30 s | E | POR-015, POR-018 |

## 9. Open questions

1. **German implementation of Art. 11a CRD (EU Directive 2023/2673)**: exact wording requirements for the button and confirmation step, scope (contracts concluded via online interface — does portal acceptance of an individually negotiated quote qualify?), acknowledgement content. Verify with a lawyer before release.
2. Does **Revolut Business** accept pain.008 collection files (SEPA Direct Debit as creditor)? If not: Stripe SEPA Direct Debit / GoCardless, or a second bank account for collections.
3. VAT treatment of provider fees (Stripe Payments Europe Ltd / Mollie B.V. / PayPal Europe) — reverse charge vs exempt.
4. Wero and Klarna availability via Stripe/Mollie for the account.
5. Data model additions: `portalTokens.tokenCiphertext`, `portalTokens.status`, `withdrawals`, `providerEvents`, `providerPayments` (pending state), `sepaCollectionRuns`, `recurringTemplates.autoCharge`, `salesDocuments.status` += `withdrawn`, `sepaMandates.lastUsedAt`, `sendLog.channel` "portal" already present.
6. Whether portal downloads of the original should be stamped "Kopie" after the first delivery (UST-34 interpretation; current decision: portal = delivery channel, always original bytes).

# Feature gap analysis: sevdesk vs. competitors, for a self-hosted clone (as of Oct 2026)

## Method and caveats

- I based this on vendor pages, help docs, the Lexware product timeline, comparison articles, and sevdesk reviews on OMR (277 reviews, 4.3/5) and Capterra (3.6/5, customer service rated 3.4).
- Searches for sevdesk on Trustpilot and Reddit found no usable threads, so I used review summaries that quote those sites instead. The German comparison blogs are often affiliate-funded or written by a competitor (Norman, kostenlose-erechnung.de), so I treat their claims carefully.
- Some competitor details come from my own knowledge rather than a source I checked this session: Invoice Ninja subscriptions, webhooks and gateways; easybill webhooks; Zoho workflow rules; Kontist and Accountable details. Those are marked "(verify)".

## What users complain about in sevdesk

These complaints come up repeatedly in reviews. The most useful sign is the list of features reviewers asked for.

- **Unreliable banking and receipts:** bank connections fail or need relinking, and sync only runs about every 6 hours. Only invoices created in sevdesk are matched automatically. Users report duplicate transactions, faulty DATEV exports, and OCR that gets things wrong, especially on foreign invoices. One user said receipts were "hardly reliable since the e-invoicing switch".
- **Rigid documents:** few letterhead and layout options, a QR code that is hard to place, and an editor that changes font sizes and has no real lists. There is no separate sender address (mail goes out under the logged-in user). Other gaps: no offer validity date, no custom fields or tags, no datasheets attached to quotes, too few address fields for large customers with departments, only one bank account per invoice, and too few decimal places.
- **Products:** items cannot be grouped or nested, and inventory costs extra.
- **Reports:** no Summen- und Saldenliste (beta only), no Kontenblätter, no totals per customer or in the receipts tab, and EÜR categories are not subdivided. CSV exports miss fields, and there is no import of old data.
- **Time tracking:** described as "rudimentary" and partly a paid add-on. Reviewers point to Clockodo, mite and clockin integrations instead.
- **Mobile:** the app is weak ("ein Grauen"), the web UI is not responsive, there is no offline mode, and the app lacks Bewirtungsbelege (entertainment receipts).
- **Performance and bugs:** slow loading, crashes, items lost on reload, drafts turned into invoices by themselves, and changes overwritten when several users work at once.
- **API and integrations:** the REST API is only in the top plan (Buchhaltung Pro, about 35 €/month). I found no official webhooks; third parties poll instead. Shopify needs paid third-party apps. Stripe and SEPA direct debit only work through add-ons (MiracleSync, SEPApro).
- **Payments:** online payment is limited to pasting a PayPal.me link into the invoice. There is no hosted payment page, card payments or SEPA mandate handling.
- **Dunning:** sevdesk detects overdue invoices and creates reminders "auf Knopfdruck", but I found no evidence of fully automatic sending.
- **Commercial:** 24-month lock-in, cancellation complaints, and an unclear plan structure. Self-hosting removes this problem entirely.

---

## MUST-HAVE

### 1. Hosted invoice page and customer portal with online payment
- **What:** every invoice and quote gets a unique link to a web page. The customer can view the PDF and e-invoice, pay, and download past documents. A logged-in portal (magic-link login) lists all their documents and their payment status.
- **Who has it:** Stripe Invoicing (hosted page and self-serve portal), Invoice Ninja (password-protected portal), Billomat (portal plus Mollie payment links), Zoho Invoice, Odoo, SumUp Invoices (payment link, 2.5% fee), Qonto (payment links). sevdesk only has a PayPal link.
- **Why it helps:** customers pay faster, you don't need to send "please resend the invoice" emails, and payments are matched automatically because the payment ID maps to the invoice.
- **Implementation:**
  - Use signed, unguessable tokens on public routes and do not expose sequential IDs.
  - Abstract payment providers behind one `PaymentProvider` interface:
    - Stripe: Checkout Sessions with card, SEPA Debit, Giropay successor/Wero, Klarna.
    - Mollie: popular in Germany and supports many methods.
    - PayPal.
  - Use provider webhooks to mark invoices as paid and to book fees separately ("Nebenkosten des Geldverkehrs", the way Lexware books PayPal fees).
  - Add an EPC/GiroCode QR code (SEPA transfer QR) to the PDF.
  - Show the payment link in the PDF, not only in the XRechnung, because an XML-only recipient never sees it.

### 2. Online quote acceptance with e-signature
- **What:** the customer can accept or decline a quote, or ask for changes, on the hosted page. They sign by drawing or typing a name and ticking a checkbox. The system records timestamp, IP and user-agent, stamps a PDF, and can turn the accepted quote into an order confirmation or invoice (or a deposit invoice) automatically.
- **Who has it:** FreshBooks (proposals with e-sign), Invoice Ninja (approval checkbox or full signature, automatic conversion to invoice), Zoho Invoice (accept or comment in portal), Odoo (Sign / portal). sevdesk mentions "digital acceptance" but gives no detail. Lexware added a revocation button for consumers in July 2026.
- **Why it helps:** you close deals faster and get a legally usable record. A simple electronic signature is enough for most service contracts.
- **Implementation:**
  - Save a hash of the accepted quote version. Accepting must lock that version.
  - Add a validity date (a sevdesk complaint) and auto-expire quotes after it.
  - For B2C distance contracts, EU Directive 2023/2673 requires an online withdrawal function from 19 June 2026, so add a revocation button for consumer quotes and checkout orders.

### 3. Automated reminders and dunning
- **What:** rule-based schedule. For example: a friendly reminder 3 days before due, a reminder at +7 days, Mahnung 1 at +14 with a fee, Mahnung 2 at +28 with default interest, then hand-off to collections. Rules can differ per customer group, and individual customers can be excluded.
- **Who has it:** easybill (rules per template and customer group, reminders before the due date), FreshBooks (automatic late fees), Zoho ("autopilot" reminders), Stripe (automatic reminders, Smart Retries), Zervant, FastBill (Premium only). Lexware hands collections to the FOMA partner. sevdesk is semi-manual.
- **Why it helps:** late payment is the main cash-flow problem for small businesses, and automation takes away the awkwardness of chasing customers.
- **Implementation:**
  - Run a daily scheduler job. Pause automatically when a bank or provider payment is matched or a partial payment arrives.
  - Calculate default interest under §288 BGB: B2B is the base rate + 9 percentage points plus a 40 € flat fee, B2C is base + 5. Keep the Basiszinssatz as a table that updates on 1 Jan and 1 Jul.
  - Treat each dunning level as its own GoBD document with its own number.
  - Have a "preview the next run" mode before anything is sent.

### 4. Recurring billing and subscriptions with proration
- **What:** recurring invoices (monthly, quarterly, yearly) that are sent and charged automatically, either by card or SEPA mandate. Upgrades and downgrades in the middle of a period are prorated, and you can pause, add trials, and set end dates.
- **Who has it:** Stripe Billing (proration, trials, Smart Retries), Invoice Ninja subscriptions (verify), Billomat, FastBill, Zoho. sevdesk has recurring invoices, but no proration and no automatic charging.
- **Why it helps:** retainers, hosting and maintenance contracts become hands-off revenue.
- **Implementation:**
  - Model `Subscription` with plan items and a billing anchor, and generate draft invoices X days ahead.
  - Choose auto-finalize or review first. Prorate by day and show it as separate credit and charge lines.
  - Each generated invoice must still get a regular, gapless invoice number.
  - Optional: link to Stripe Subscriptions, but keep your own system as the source of truth.

### 5. E-Rechnung: create, receive, validate and display
- **What:**
  - Create XRechnung (CII/UBL) and ZUGFeRD/Factur-X (hybrid PDF/A-3).
  - Receive e-invoices through an email inbox, read the XML, validate it against KoSIT rules, and render it in readable form.
  - Support the Leitweg-ID for B2G, plus optional Peppol sending.
- **Who has it:** everyone has creation (Lexware only from M; full XRechnung/ZUGFeRD only in XL according to one comparison). Lexware added built-in incoming e-invoice checks with an inspection report in May 2025. A sevdesk user complained that receipt handling got worse after the e-invoice rollout.
- **Why it helps:** receiving is mandatory for all businesses since 1 Jan 2025. Sending structured e-invoices is mandatory from 2027 for businesses over 800k € turnover and from 2028 for everyone. Kleinunternehmer and invoices under 250 € are exempt.
- **Implementation:**
  - Use a library such as horstoeko/zugferd (PHP), mustangproject (Java) or the KoSIT validator (Java CLI).
  - When receiving, the XML is the legally binding original, so archive it unchanged. The PDF is only a view.
  - Pre-fill supplier receipts from XML fields. This needs no OCR at all.

### 6. GoBD-compliant immutability and audit log
- **What:**
  - Finalized documents can no longer be changed. Corrections are made only through cancellation (Storno) or correction invoices.
  - Invoice numbers are gapless.
  - Every change is logged: who, what, when, before and after, and which channel (UI, API, MCP).
  - Add an audit-log viewer and a tax-audit export (GDPdU/IDEA "Z3" export).
- **Who has it:** all of the German tools do this internally (sevdesk, Lexware, Papierkram). Few show it to the user.
- **Why it helps:** you need it for the Steuerberater and Betriebsprüfung. With AI agents writing data, you need to see exactly what the AI changed.
- **Implementation:**
  - Use an append-only `audit_events` table, optionally hash-chained so tampering is visible.
  - Record the actor type `user | api_token:<name> | mcp:<client>`.
  - Lock documents at the database level (state machine draft → finalized → paid/cancelled).
  - Write a Verfahrensdokumentation template for your own setup.

### 7. DATEV export (and a tax-advisor handoff)
- **What:** DATEV EXTF Buchungsstapel CSV plus the receipt images (DATEV Belegbilder ZIP or DATEV Unternehmen online upload), along with clean CSV and PDF exports for the tax advisor.
- **Who has it:** sevdesk, Lexware (+ADDISON), Candis, easybill. Reviewers complained about faulty sevdesk DATEV exports and asked for DATEV import.
- **Why it helps:** most small businesses hand bookkeeping or the annual accounts to a Steuerberater. This is how they actually receive the data.
- **Implementation:**
  - Map revenue and expense categories to SKR03/SKR04 accounts with tax keys (BU-Schlüssel).
  - Validate the export (balanced entries, valid accounts) before writing the file.
  - Allow periodic export with a "festschreiben" flag.

### 8. Bank sync and payment matching that actually works
- **What:** automatic import of bank transactions. Matching uses the invoice number in the reference text, the amount, the IBAN and fuzzy name matching, and supports partial or combined payments and payouts from payment providers.
- **Who has it:** Lexware, sevdesk (the most common complaint), FastBill, Qonto/Finom (native, because they are the bank).
- **Why it helps:** this is what feeds automatic dunning and the cash-flow forecast. sevdesk's flaky sync is the top complaint.
- **Implementation:**
  - Use FinTS/HBCI directly (python-fints, or hbci4j) for German banks. Most banks support it and it costs nothing.
  - Or use an aggregator: Enable Banking, or GoCardless Bank Account Data (check whether it still takes new customers).
  - Also support CAMT.053/MT940 file import as a fallback.
  - Split Stripe/PayPal/Mollie payouts into their individual charges and fees using the provider APIs. A Shopify forum thread names exactly this as Lexware's weak spot.

### 9. Receipt inbox through email forwarding, plus AI OCR
- **What:** a dedicated address (e.g. `belege@yourdomain`) plus upload and mobile camera capture. AI extracts supplier, date, net/VAT/gross per rate, invoice number and IBAN, suggests the category or SKR account, and links the receipt to a bank transaction.
- **Who has it:** Candis (import alias, AI pre-assignment that learns), Lexware (up to 20 registered sender addresses, AI suggestions based on past assignments), sevdesk (AI capture, accuracy criticized), Accountable, Norman, Odoo.
- **Why it helps:** collecting receipts is the most tedious part of bookkeeping. Most SaaS invoices already arrive by email.
- **Implementation:**
  - Fetch mail via IMAP polling or an inbound webhook (Postmark/Mailgun).
  - Handle attachments in this order: XML e-invoice → parse; PDF with ZUGFeRD → parse; otherwise → LLM vision extraction with a JSON schema.
  - Keep a per-supplier memory of the last category and account used.
  - Score confidence and send low-confidence receipts to a review queue.
  - Store the originals unchanged (GoBD).

### 10. API-first design: scoped REST API, webhooks, idempotency, plus MCP on top
- **What:**
  - One domain service layer used by the UI, the public REST API (OpenAPI spec) and the MCP server.
  - Scoped API tokens, e.g. `invoices:read` for the website and `invoices:write` for Claude.
  - Signed outgoing webhooks (`invoice.paid`, `quote.accepted`, `customer.created`, …) and idempotency keys.
- **Who has it:** Invoice Ninja (API, webhooks, Zapier; verify), easybill (REST API plus webhooks; verify), Stripe (the reference design). sevdesk keeps its API in the top plan and has no native webhooks. Lexware keeps its API in XL.
- **Why it helps:** this is what makes the MCP integration and the website integration possible, and it lets n8n or Zapier automate everything else.
- **Implementation:**
  - Sign webhooks with HMAC-SHA256 (header with timestamp), retry with exponential backoff, and keep a delivery log with a replay button.
  - MCP safety: AI tools create drafts, and finalizing or sending needs explicit confirmation or a separate scope. A finalized invoice cannot be undone under GoBD.
  - Add `dry_run`/preview tools (for example, preview the PDF and totals before finalizing).

### 11. Import from sevdesk/Lexoffice, full data export, and backups
- **What:**
  - CSV/API import of contacts, products, invoices (as historical PDFs plus metadata) and receipts.
  - One-click full export: JSON plus all PDFs/XML, as a ZIP.
  - Scheduled encrypted backups to S3 or B2, with a restore test.
- **Who has it:** the competitors offer importers to win switchers. sevdesk reviewers complain about missing import and incomplete CSV exports.
- **Why it helps:** you need it to move your history out of sevdesk. You are also legally required to keep records for 8 years (accounting vouchers) or 10 years (books and annual statements), so backups must be part of the design.
- **Implementation:**
  - The sevdesk API can pull everything using a token, as long as your account is still on Buchhaltung Pro. Otherwise use the CSV exports plus a bulk PDF download.
  - Keep imported documents as archived, read-only records with their original numbers.
  - Back up with restic or borg, or dump Postgres to object storage, and add a "verify backup" job.

### 12. Flexible document template designer
- **What:**
  - Templates in HTML/CSS with live preview: logo, letterhead background PDF, fonts, footer columns, where the QR code goes, rich text (bold and lists).
  - Several layouts (DE/EN, with or without a cover letter), several bank accounts per document, and custom fields shown on documents.
  - Text snippets for intros and closings, and per-document sender address and reply-to.
- **Who has it:** easybill and Billomat (template sets), Invoice Ninja (custom designs in HTML), Zoho. Lexware only added bold, italic and lists in April 2026. This is a frequent sevdesk complaint.
- **Why it helps:** a professional look, and it fixes many of the specific sevdesk complaints.
- **Implementation:**
  - Use Handlebars/Twig/Jinja templates rendered to PDF with Gotenberg, WeasyPrint or Playwright, then convert to PDF/A-3 for ZUGFeRD.
  - Version templates, and store a snapshot of the template version used with each finalized document so old documents can be rebuilt exactly.

---

## SHOULD-HAVE

### 13. Time tracking that flows into invoices
- **What:** stopwatch and manual entry per project or task, billable and non-billable flags, rounding rules, and a single action to invoice unbilled time. Can attach a timesheet report to the invoice.
- **Who has it:** Papierkram (very complete: stopwatch, project rates, rounding, external team members, timesheet report), Zoho Invoice, FreshBooks, Invoice Ninja. sevdesk's version is rudimentary or an add-on.
- **Why it helps:** service businesses stop losing billable hours, and customers get a transparent breakdown.
- **Implementation:**
  - `TimeEntry(project, task, user, start, end, billable, rate_override, invoice_line_id)`. Once an entry is billed, lock it.
  - An MCP tool like "log 2h on project X: meeting" makes this very easy to use.

### 14. Projects with budget and profitability
- **What:** a budget per project (hours or €), progress warnings, linked quotes, invoices, time, expenses and receipts. Profitability = revenue − (time × internal cost rate) − assigned expenses.
- **Who has it:** FreshBooks (project profitability on Premium), Papierkram (budgets, but no margin analysis), Zoho (project budgets). sevdesk lacks it.
- **Why it helps:** shows which customers or job types actually make money, so you can set prices better.
- **Implementation:** add a project_id to receipts and invoice lines, set an internal cost rate per user, and build a simple per-project P&L view. Use cost centres (Kostenstellen) for the DATEV mapping.

### 15. Tax reserve (Steuerrücklage) and income tax estimate
- **What:**
  - A live dashboard of VAT collected minus input VAT (the next UStVA payment).
  - Estimated income tax plus Soli and church tax, using the §32a EStG formula on year-to-date profit projected to the full year.
  - Gewerbesteuer for traders, using the Hebesatz.
  - A suggested amount to set aside each month, with optional rules like "move X% of each payment to a sub-account".
- **Who has it:** Accountable (real-time income tax estimate), Kontist (automatic tax reserve), Lexware Smart Split (Aug 2025, sets aside a percentage of each payment on a sub-account), Norman (tax features), Qonto/Finom.
- **Why it helps:** the classic freelancer trap is a large tax demand plus Vorauszahlungen. A GmbH needs Körperschaftsteuer and Gewerbesteuer reserves instead.
- **Implementation:**
  - Keep the tax tariff formulas as yearly versioned config, and include Gewerbesteuer credit under §35 EStG.
  - Label it clearly as an estimate.
  - Track the Kleinunternehmer limits: since 2025, 25,000 € last year and 100,000 € this year, and crossing 100k ends the status immediately. Warn before the limit is reached.

### 16. Cash-flow forecast
- **What:** a 3–6 month projection built from open receivables (weighted by each customer's payment history), recurring revenue, recurring expenses, tax payments due (UStVA, Vorauszahlungen) and planned items.
- **Who has it:** Qonto (cash-flow analysis), Lexware (planning tool with prior-year baseline, March 2026), Akaunting (cash-flow overview).
- **Why it helps:** you see liquidity gaps before they happen.
- **Implementation:**
  - Calculate each customer's average days-to-pay and project expected payment dates from it.
  - Model standing expenses from recurring receipts (Lexware added recurring standing vouchers in Aug 2026).
  - Show it as a chart; scenario toggles can come later.

### 17. SEPA direct-debit mandates (own mandates or via GoCardless)
- **What:** collect a mandate online through the portal or checkout, store the mandate reference and date, send the pre-notification automatically, and either generate pain.008 XML for your bank or collect through GoCardless or Stripe SEPA.
- **Who has it:** GoCardless and Stripe (mandates online), Invoice Ninja (GoCardless gateway; verify). sevdesk needs the SEPApro add-on, with mandate data in custom fields. easybill only gets there with a workaround in its dunning feature.
- **Why it helps:** recurring B2B customers pay on time and cheaply, which suits retainers and subscriptions.
- **Implementation:**
  - Own creditor ID (Gläubiger-ID from the Bundesbank) plus pain.008.001.08 generation. Submit through FinTS, or upload manually.
  - Handle chargebacks (Rücklastschrift) by reopening the invoice and charging a fee.
  - GoCardless or Stripe takes on the mandate UX and the failure handling.

### 18. Website checkout and order intake
- **What:**
  - A public API or hosted checkout for the website: product catalogue endpoint, cart → order → invoice and payment, and automatic invoice email after payment.
  - Embeddable "Buy" or "Request quote" widgets.
  - An inbound lead form that creates a contact and a draft quote.
- **Who has it:** easybill (40+ shop and marketplace integrations: Shopify, WooCommerce, Etsy, …), Invoice Ninja (subscriptions plus purchase pages; verify), Stripe Checkout. sevdesk needs paid third-party apps for Shopify.
- **Why it helps:** one source of truth for products and prices, and no copying web orders by hand.
- **Implementation:**
  - Use a read-only public product endpoint (CORS, cache) and a server-side order endpoint with idempotency keys.
  - Use a Stripe/Mollie Checkout Session with a webhook that finalizes the invoice.
  - Respect B2C rules: show gross prices, add the withdrawal button and terms (AGB) acceptance, and handle the OSS VAT rate if you sell across the EU above 10k €.

### 19. Quote follow-ups
- **What:** automatic reminders for quotes that are sent but not viewed or accepted (e.g. +5 and +12 days), expiry alerts, and tracking of "viewed" events from the hosted page.
- **Who has it:** Zoho, Odoo (follow-ups), Invoice Ninja (view tracking; verify). This is mostly missing in German SaaS tools.
- **Why it helps:** quotes often go quiet simply because nobody followed up.
- **Implementation:** reuse the dunning rule engine with a different document type. A view pixel or hosted-page visit records `quote.viewed`.

### 20. AI assistance beyond OCR
- **What:**
  - Auto-categorize bank transactions.
  - Draft invoices or quotes from plain language ("Quote for Müller GmbH: 3 workshop days + travel").
  - Detect anomalies (duplicate receipts, unusual amounts, missing receipts for a transaction).
  - Answer questions in plain language ("What did I spend on software in Q2?").
- **Who has it:** Accountable (AI tax advisor and checks), Lexware ("automagic" semantic receipt capture, from a single third-party source), sevdesk (AI capture), Candis (learning pre-assignment).
- **Why it helps:** much of this comes almost free with MCP. Claude does the drafting, so the app mainly needs good tools and good data.
- **Implementation:**
  - Expose good MCP tools: `search_customers`, `list_products`, `create_draft_invoice`, `get_open_items`, `categorize_transaction`, `run_report`.
  - Add an in-app LLM only for OCR and categorization.
  - Keep a human-confirmation step for anything that creates a legal record.

### 21. Global search / command palette, keyboard shortcuts, bulk actions
- **What:**
  - A Cmd+K palette that searches customers, documents, products and amounts, and runs actions ("new invoice for …").
  - Shortcuts (n = new, / = search, j/k = navigate).
  - Bulk actions: send, remind, export, mark paid, download PDFs as ZIP.
- **Who has it:** modern SaaS in general. The German incumbents are weak here. Candis reviewers criticize its search.
- **Why it helps:** daily speed, especially when processing many receipts and invoices.
- **Implementation:** Postgres full-text search plus trigram indexes, or Meilisearch. Run bulk operations as background jobs with progress reporting.

### 22. Custom fields, tags, and better contacts and addresses
- **What:**
  - Custom fields on contacts, products and documents, with an option to print them on documents.
  - Tags.
  - Several contacts and addresses per company (departments, billing vs. delivery, per-contact invoice email).
  - Totals per customer (revenue, open amounts, average days-to-pay).
- **Who has it:** Papierkram (custom fields, several contacts, call notes), easybill, Invoice Ninja. These are explicit sevdesk complaints.
- **Implementation:** JSONB custom fields with a definition table for validation and UI rendering.

### 23. Products: variants, groups, stock
- **What:** product categories or hierarchy, variants (size and colour SKU), unit prices with several decimal places, tiered or customer-specific price lists, simple stock with movements tied to invoices and delivery notes, and a low-stock alert.
- **Who has it:** Invoice Ninja (inventory; verify), Odoo (full), Zoho Inventory, easybill (stock). In sevdesk, inventory costs extra and grouping is missing.
- **Why it helps:** needed for any product sales, and the website checkout depends on it.
- **Implementation:** `Product → Variant(SKU, price, stock_qty)` plus a `StockMovement` ledger. Leave it out entirely if you only sell services.

### 24. Multi-language and multi-currency documents
- **What:** document language per customer (DE/EN at least), foreign-currency invoices with the ECB rate stored for VAT reporting in EUR, reverse-charge texts, and checking EU VAT IDs (BZSt eVatR qualified confirmation or VIES).
- **Who has it:** Invoice Ninja, Zoho, FreshBooks, Akaunting (50+ languages). sevdesk reviewers asked for English.
- **Implementation:**
  - Document texts as i18n templates. The §13b/§4 UStG legal notices must be generated automatically from the tax case.
  - Pull ECB reference rates daily.

### 25. Partial, deposit and final invoices (Abschlags-/Schlussrechnung)
- **What:** deposit invoices tied to a quote or project, and a final invoice that deducts them with the correct VAT breakdown.
- **Who has it:** most German tools have this as standard (sevdesk included), and FreshBooks has retainers.
- **Why it matters:** this is about matching what sevdesk already does. Projects and services depend on it, and it is easy to get wrong.

### 26. n8n / Zapier / Make
- **What:** official n8n community node and Zapier app, with triggers from webhooks and actions through the REST API.
- **Who has it:** most of the competitors are on Zapier. sevdesk is only reached through polling connectors.
- **Implementation:** if the webhooks and OpenAPI spec exist, an n8n node is about a day of work. For self-hosting, n8n is the natural fit.

---

## NICE-TO-HAVE

### 27. Simple CRM pipeline
- **What:** leads → quote sent → won or lost as a Kanban board, a follow-up task per contact, notes and call logs, and lost reasons.
- **Who has it:** Odoo, Zoho (CRM). Papierkram has call notes. Lexware reviewers name missing CRM as a gap; Lexware fills it through partners (Tellie, scurio).
- **Why it helps:** a light pipeline is enough for a small business. Pipeline value combined with win rate also improves the cash-flow forecast.

### 28. Expense reports, Bewirtung and travel costs
- **What:** an entertainment-receipt form (participants, occasion, 70/30 tax split), travel expenses with flat meal allowances (Verpflegungspauschalen), and mileage.
- **Who has it:** sevdesk (desktop only; the app lacks it), Lexware. Reviewers asked for this.
- **Implementation:** keep the flat rates as yearly config.

### 29. Reports for GmbHs
- **What:** Summen- und Saldenliste, Kontenblätter, BWA, and EÜR with sub-categories. A full balance sheet stays with the Steuerberater.
- **Who has it:** sevdesk (SuSa in beta, BWA only in Pro), Lexware (real-time BWA, redesigned P&L with drill-down to the voucher).
- **Why it helps:** only matters if you do double-entry bookkeeping yourself. For a GmbH, DATEV handoff (item 7) covers most of the need.

### 30. PWA / mobile-first / offline
- **What:** a responsive UI, an installable PWA, camera capture of receipts, and an offline queue for receipt photos and time entries.
- **Who has it:** Papierkram's app (offline time tracking), and the receipt apps of Lexware and sevdesk. sevdesk's mobile web is "not responsive", and reviewers asked for offline mode.
- **Implementation:** a service worker with IndexedDB queue and background sync. Only receipts and time entries need offline support, not invoicing.

### 31. Dark mode
- Cheap to add if you use CSS variables or Tailwind from the start. Skip it for PDF previews.

### 32. Audit log viewer UI
- A filterable timeline per document or customer, plus a global log filtered by actor (e.g. "show everything MCP changed today"). Builds on item 6 and is very useful for trusting AI changes.

### 33. Collections hand-off
- Export the overdue case to an Inkasso partner or start a Mahnbescheid via online-mahnantrag.de (Lexware integrates FOMA). It is rarely needed but saves time when it is.

### 34. Peppol sending
- German B2B does not require Peppol, but B2G and some foreign customers use it. A Peppol access-point API (e.g. storecove, ecosio) is optional.

### 35. Smaller extras
- Customer ratings in the portal (Zoho).
- Expiring deep links.
- Pre-notifications for SEPA debits.
- Multiple sender identities.
- Attaching datasheets to quotes (a sevdesk complaint).
- More decimal places in unit prices.
- Optimistic locking so concurrent edits don't overwrite each other (another complaint).

---

## Suggested build order
1. Core domain with GoBD state machine and audit log, then the API with scoped tokens, then MCP tools (drafts only).
2. Template designer, ZUGFeRD/XRechnung output, and the hosted invoice page with Stripe/Mollie.
3. Bank sync (FinTS) with matching, then automatic dunning.
4. Quote acceptance and e-signature, recurring billing, and webhooks.
5. Receipt inbox with OCR, then DATEV export.
6. The sevdesk importer (run it before you cancel sevdesk) and backups.
7. Then the Should-haves, roughly in the order listed.

## Sources
- [OMR Reviews – sevdesk (page 5)](https://omr.com/de/reviews/product/sevdesk/all/5), [OMR Reviews – sevdesk (page 3, EN)](https://omr.com/en/reviews/product/sevdesk/all/3)
- [selbststaendigkeit.de – sevdesk Erfahrungen 2026](https://selbststaendigkeit.de/buchhaltung-fuer-gruender/sevdesk-erfahrungen)
- [sevdesk API help (API only from Buchhaltung Pro)](https://hilfe.sevdesk.de/en/knowledge/sevdesk-api), [Apideck sevdesk (virtual webhooks)](https://www.apideck.com/integrations/sevdesk.md), [Pipedream sevdesk (polling)](https://Pipedream.com/apps/sevdesk)
- [sevdesk PayPal](https://sevdesk.de/paypal/), [sevdesk Stripe by MiracleSync](https://sevdesk.de/integrationen/stripe-by-miraclesync/), [sevdesk SEPApro](https://sevdesk.de/integrationen/sepapro/), [sevdesk Mahnwesen](https://sevdesk.de/ratgeber/buchhaltung-finanzen/mahnwesen/), [sevdesk Zeiterfassung](https://sevdesk.de/zeiterfassung/)
- [Lexware timeline 2025–2026](https://www.lexware.de/timeline/), [Norman – Lexware Office vs sevdesk](https://norman.finance/de/blog/lexware-office-vs-sevdesk), [kostenlose-erechnung.de – lexoffice vs sevdesk](https://kostenlose-erechnung.de/ratgeber/lexoffice-vs-sevdesk/), [Shopify community – Stripe + Lexoffice](https://community.shopify.com/t/hoher-aufwand-durch-stripe-buchhaltung-mit-lexoffice/93190/1)
- [easybill automatisiertes Mahnwesen](https://support.easybill.de/hc/de/articles/214592125-Automatisiertes-Mahnwesen), [easybill DATEV Marktplatz](https://www.datev.de/web/de/m/marktplatz/easybill-gmbh/)
- [Billomat customer portal](https://faq.billomat.com/en/customer-portal), [FastBill review (fastlancer)](https://www.fastlancer.org/fastlancer-blog/fastbill-review/)
- [Papierkram – Kunden, Projekte, Zeiten](https://www.papierkram.de/funktionen/kunden-projekte-zeiten/)
- [Candis Rechnungsmanagement](https://candis.io/produkt/rechnungsmanagement), [Candis Freigabeprozess](https://candis.io/blog/freigabeprozess)
- [Accountable Einkommensteuer](https://www.accountable.de/einkommensteuererklaerung/), [Norman – Accountable alternatives](https://norman.finance/de/blog/accountable-alternativen)
- [Invoice Ninja features](https://invoiceninja.com/?p=873), [Invoice Ninja invoicing/quotes](https://invoiceninja.com/?p=888)
- [Stripe Invoicing](https://stripe.com/invoices), [Stripe automatic collection](https://docs.stripe.com/invoicing/automatic-collection)
- [Zoho Invoice features](https://www.zoho.com/invoice/tour/), [FreshBooks features](https://freshbooks.com/features), [Odoo Invoicing](https://www.odoo.com/r/mbW)
- [SumUp Invoices](https://sumup.com/en-gb/invoices-free), [Debitoor online payment](https://debitoor.com/features/online-payment), [Zervant on TrustRadius](https://www.trustradius.com/products/zervant/details)
- [Qonto invoicing](https://qonto.com/de-at/invoicing), [Qonto vs Finom](https://qonto.com/de/comparators/qonto-vs-finom)
- [OpenAlternative – Akaunting vs Crater](https://openalternative.co/compare/akaunting/vs/crater)
- [ETL – E-Rechnung Zeitplan](https://www.etl.de/e-rechnung/zeitplan/), [IHK Dresden – E-Rechnung](https://www.ihk.de/dresden/hauptnavigation/recht-steuern/erechnung-6232764)

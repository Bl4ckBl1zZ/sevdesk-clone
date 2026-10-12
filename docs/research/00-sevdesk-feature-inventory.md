# sevdesk: feature inventory for a 1:1 clone (as of October 2026)

**Main findings**
- **The most precise source is the public API spec**, `https://api.sevdesk.de/openapi.yaml` (v2.0.0). It gives the exact data models, status codes, document-type codes and VAT-rule IDs, and these match the web UI. Sections 2–8 and 19 use it heavily.
- **The help center is the best source for UI flows and settings.** It has 14 collections and 264 articles, many with a "(v1)" legacy twin; everything below uses the current v2 versions.
- **sevdesk is narrower than its marketing suggests.** It cannot produce:
  - a balance sheet (Bilanz)
  - ELSTER filing of the EÜR, ZM, OSS return or annual VAT return
  - payroll
  - user-defined bank rules
  - manual journal entries or opening balances
  - multiple companies in one account

**How to read this**
- **HC/<id>** means `https://hilfe.sevdesk.de/de/articles/<id>`.
- **[?]** means uncertain or not confirmed. **[3rd]** means a third-party source.
- Help center addresses `hilfe.sevdesk.de/de/...` and `intercom.help/sevdesk/de/...` point to the same articles.
- **Two backend generations exist.**
  - "sevdesk-Update 2.0" (from 2024) replaced the old free tax types with fixed VAT rules and the old booking types with DATEV-mapped accounts.
  - Clone the v2 behaviour.
  - Users can see their version via user menu (bottom left) → Kundennummer + Systemversion.

---

## 1. Plans, prices and tier mapping

Sources: https://sevdesk.de/preise/, https://sevdesk.de/funktionen/

### 1.1 Plans
Prices are per month, net. The pricing page shows three billing periods with different list prices:

| Plan | 1 month | 12 months | 24 months | Promo shown Oct 2026 ("Black Cyber Deal") |
|---|---|---|---|---|
| Kostenlos | 0 € | – | – | – |
| Rechnung | 11,90 € | 9,90 € | 8,90 € | 4,45 € |
| Buchhaltung (recommended) | 25,90 € | 22,90 € | 19,90 € | 9,95 € |
| Buchhaltung Pro | 34,90 € | 30,90 € | 27,90 € | 13,95 € |

- A separate summary block on the same page still shows 12,90 / 25,90 / 34,90 € reduced to 6,45 / 12,95 / 17,45 € on 24-month terms. That block looks stale. [?]
- Trial: 14 days with all features, no credit card. Afterwards the account drops to the free plan automatically.
- Payment is by credit card or PayPal. Annual plans are billed in advance.
- Upgrades are self-service in settings. Downgrades go through support.
- Free plan rules (HC/10570010):
  - 3 finalized invoices or e-invoices per billing month; drafts are unlimited.
  - Unused invoices don't carry over.
  - No add-ons, and support is limited.
  - Cancellation is only via a support request.

### 1.2 Which features are in which plan

A dash in the pricing comparison table means "not included".

| Feature | Free | Rechnung | Buchhaltung | Pro |
|---|---|---|---|---|
| Invoices / e-invoices (ZUGFeRD, XRechnung) | 3/month | unlimited | unlimited | unlimited |
| Several invoice layouts, invoice overview | ✓ | ✓ | ✓ | ✓ |
| Unlimited contacts and products | ✓ | ✓ | ✓ | ✓ |
| Angebote (quotes), unlimited | – | ✓ | ✓ | ✓ |
| Invoices abroad, foreign currency, English invoices | – | ✓ | ✓ | ✓ |
| Abschlags- & Schlussrechnungen (down-payment and final invoices) | – | ✓ | ✓ | ✓ |
| Own letterhead and logo, text blocks | – | ✓ | ✓ | ✓ |
| Gutschriften (credit notes) | – | ✓ | ✓ | ✓ |
| Open-invoice overview | ✓? | ✓ | ✓ | ✓ |
| Zahlungserinnerung (payment reminder) | – | ✓ per pricing page (HC/9071059 says Buchhaltung+) [?] | ✓ | ✓ |
| DATEV / ADDISON interface, tax-advisor access, DATEV and OSS exports | – | ✓ | ✓ | ✓ |
| Marketplace integrations, own SMTP, tasks, currencies | – | ✓ | ✓ | ✓ |
| Postal sending of documents (pay per use) | – | ✓ | ✓ | ✓ |
| Receive e-invoices | – | – | ✓ | ✓ |
| Auftragsbestätigungen (order confirmations), Lieferscheine (delivery notes) | – | – | ✓ | ✓ |
| Recurring invoices, dunning levels (Mahnstufen) | – | – | ✓ | ✓ |
| Single- and double-entry bookkeeping | – | – | ✓ | ✓ |
| AI receipt capture, receipts by email, missing-receipt overview | – | – | ✓ | ✓ |
| Foreign-currency receipts, recurring receipts | – | – | ✓ | ✓ |
| Bank connection (finAPI, 4,000+ banks) | – | – | ✓ | ✓ |
| Cash book (Kassenbuch) | – | – | ✓ | ✓ |
| Fixed assets and depreciation (Anlagen/AfA) | – | – | ✓ | ✓ |
| UStVA via ELSTER, EÜR, GuV | – | – | ✓ | ✓ |
| Summen- und Saldenliste (trial balance, beta) | – | – | ✓ | ✓ |
| Access rights per user | – | – | ✓ | ✓ |
| Kostenstellen (cost centres) | – | – | – | ✓ |
| REST API | – | – | – | ✓ |
| BWA (business evaluation) in real time | – | – | – | ✓ |

- Every paid plan includes **1 admin user**.
- Personal support is by chat, email and phone. The AI agent "Sevi" is listed for all plans; an older snippet ties it to Pro. [?]

### 1.3 Add-ons (monthly, same in every paid plan)

| Add-on | Price | Notes |
|---|---|---|
| Premium layouts | 3,90 € | 6 of the 11 layouts are premium |
| Extra layout slot | 4,90 € | 1 slot included |
| Weiterer Benutzer (extra user) | 5,90 € | users 3–10 get 10 % off (5,31 €); beyond 10 get 25 % off (4,43 €) (HC/9374033) |
| Extra letterheads | 4,90 € | 1 letterhead included |
| Zeiterfassung (time tracking) | 4,90 € | 30-day trial, web only |
| Inventar (stock) | 19,90 € | 30-day trial |

### 1.4 Paid services (one-off)
- Einrichtungstermin (setup appointment, about 45 min): 49 €
- Layout design service: from 29 €
- Expertentermin (expert appointment): from 24,90 € per 15 minutes
- 4-Augen-Check (document review): 3 € per document

### 1.5 Multiple companies
- "sevDesk ist nicht mandantenfähig": each company or tax number needs its own account (HC/9373992).
- Volume discount: accounts 2–5 get 10 %, accounts 6–10 get 20 %.
- Companies that share a tax number can split activities with Kostenstellen.
- No in-app company switcher is documented.

---

## 2. App structure and navigation

### 2.1 Main navigation
Pieced together from help-center menu paths; exact current labels and order are [?].
1. **Übersicht / Dashboard**
2. **Kontakte**
3. **Aufträge**: Angebote, Aufträge (Auftragsbestätigungen), Lieferscheine
4. **Rechnungen**: Rechnungen, Wiederkehrend, Gutschriften, Mahnungen
5. **Belege**: expenses and income, Anlagen (assets), Wiederkehrend
6. **Bank**: Konten/Zahlungen, Zuordnungen, Kassenbuch
7. **Steuern**: UStVA, EÜR/GuV, Mein Steuerberater (export)
8. **Auswertungen**: BWA, Summen- und Saldenliste
9. **Produkte**, which becomes **Inventar** when the add-on is booked
10. **Erweiterungen**: Add-ons, Integrationen
11. **Einstellungen**

**User menu (bottom left):** Zeiterfassung, Dokumente (file manager), Aufgaben, Benutzerdaten, Kundennummer and system version (HC/13831806).

### 2.2 Settings tree
Source: help-center collection 9417203.
- **Unternehmen**
  - Allgemein: address, contact details, industry, number of employees
  - Buchhaltung & Steuern: USt-ID, Steuernummer, Amtsgericht, HRB number, VAT status (standard vs Kleinunternehmer), profit method (EÜR/GuV), Soll/Ist, chart of accounts SKR03/SKR04 (SKR07 for Austria), default VAT rate 0/7/19 %, gross/net entry default, invite tax advisor, downloadable change log (HC/9382213)
  - Bankverbindung
  - Logo (PNG/JPG)
- **Buchhaltung**
  - Nummernkreise, Buchungskonten, Zahlungsmethoden, Zahlungskonten
  - Transaktionszuordnung (automatic matching), Umsatzsteuerregelungen
  - Kostenstellen, Kreditoren-/Debitorennummern (HC/9382125)
- **System**
  - Kategorien and Einheiten (custom categories and units)
  - Aufträge & Rechnungen (document behaviour)
  - Kontaktfelder (custom contact fields)
  - Import of contacts and products
  - Anhänge (standard email attachments, e.g. AGB)
  - Festschreiben (locking)
  - Reset or delete account (HC/9382249)
- **Benutzer**: user data, rights, SMTP, interface language, password
- **Briefpapier**: letterhead, Layouts (downloadable HTML templates), Druckoptionen (print options)
- **Textvorlagen**: document text blocks and email signatures

### 2.3 "Aufträge & Rechnungen" settings (HC/9382242)
- **Allgemein**
  - "Referenz im Betreff": the subject is filled automatically, e.g. "Rechnung Nr. X".
  - "Automatische Festschreibung von Dokumenten bei Fertigstellung": locks documents when finalized.
- **Angebote**
  - Default delivery and payment terms printed on quotes.
  - "Letztes Angebot vom Kontakt übernehmen": a pop-up offers to copy the contact's last quote.
  - "Rechnung automatisch erzeugen bei Kunden-Bestätigung": a placeholder link in the quote footer lets the customer accept or decline online; acceptance creates the invoice automatically.
- **Auftragsbestätigung**: default terms, copy the last document.
- **Lieferscheine**: copy the last document.
- **Rechnung**
  - Default Zahlungsziel (payment term). It must be set for contact-specific terms to apply; use 0 for no due date.
  - "Zahlungsziel Text anzeigen": prints the payment term below the footer.
  - "Lieferdatum automatisch setzen": pre-fills the delivery date.
  - "Rechnungsdatum automatisch anpassen": moves past dates on drafts to today.
  - "Letzte Rechnung übernehmen": copy the contact's last invoice.
  - "E-Rechnungs-Standard für alle Rechnungen verwenden": attaches ZUGFeRD/XRechnung XML to every invoice.
- **Wiederkehrende Rechnung**
  - "Text Berechnungszeitraum anzeigen": adds the billing-period line to the header text.
  - Automatic locking when the invoice is sent.
- **Mahnung**: "Mahnfrist" (the deadline text used on reminders).

---

## 3. Dashboard / "Übersicht"

Sources: https://sevdesk.de/dashboard/, https://sevdesk.de/zusammenarbeit/
- **KPI tiles:** revenue, expenses, depreciation, open items (receivables), account balances, open invoices, VAT payable (Umsatzsteuer-Zahllast).
- **VAT payable period:** monthly, quarterly, half-yearly or yearly, matching your filing rhythm.
- **Charts:** trend over a chosen period, cash flow, top customers, bestsellers, spending by expense category, largest expenses.
- **Period selector:** month, quarter, year or custom range.
- **Widgets can be shown, hidden and reordered.** Higher plans reportedly add BWA and key-figure widgets. [?]
- **"Buchhaltungsscore":** a completeness score based on missing receipts, open bookings and unassigned payments. Working through the to-dos raises it.
- **Task list:** open tasks with deadlines and email reminders.
- **Banner:** new automatic matches or suggestions show as a notice under Bank → Zahlungen.
- **No built-in liquidity forecast.** sevdesk points to the Agicap, Commitly and Tidely integrations.

---

## 4. Invoicing (Rechnungsprogramm)

Sources: https://sevdesk.de/rechnungsprogramm-online/, help-center collection 8744482, OpenAPI.

### 4.1 Invoice types (API `invoiceType`)

| Code | Type | How it is created in the UI |
|---|---|---|
| RE | Normal invoice | Rechnungen → "Rechnung erstellen" |
| WKR | Recurring template | Rechnungen → Wiederkehrend |
| SR | Stornorechnung (cancellation) | Invoice → Mehr → "Rechnung stornieren" |
| MA | Mahnung / Zahlungserinnerung (reminder) | From an overdue invoice |
| TR | Teilrechnung (partial invoice) | From an Angebot, AB or Lieferschein |
| AR | Abschlagsrechnung (down payment) | From an Angebot/AB, standalone (arrow next to "Rechnung erstellen"), or "Folgerechnung erzeugen" |
| ER | Schlussrechnung (final invoice) | From the original document, after the partial invoices |

Rules for each type:
- **Abschlagsrechnung (AR)**: HC/9064818
  - Choose a percentage or a fixed amount.
  - A Schlussrechnung is mandatory, even if it comes to 0 €, and only after all AR invoices are paid. Only payments actually received are deducted.
  - VAT is due when the down payment arrives (Mindest-Ist-Besteuerung).
  - In the API, AR/TR invoices allow only taxRule 1 or 11, and no foreign currency.
- **Teilrechnung (TR)**: HC/9064928
  - Enter a percentage or a fixed amount, gross or net. The result is one position.
  - The source document becomes "Teil berechnet". More partial invoices can follow.
- **Schlussrechnung (ER)**
  - The dialog shows the total, payments received and the open balance.
  - The invoice repeats all positions and adds a summary table of the earlier invoices (the `partialheader` block in the layout: number, net, VAT, gross, remaining amount).
  - The ER date must be on or after the dates of the earlier AR/TR invoices.
- **Storno (SR)**: HC/9154465
  - Only for invoices that are open or overdue (offen/fällig).
  - Creates a linked cancellation invoice with the **next number from the invoice range**, which is set to Bezahlt immediately. The original becomes "Storno" and appears in a Storno tab.
  - Paid invoices must be corrected with a Gutschrift (reason Minderleistung) instead.
- **Pro-forma**: no dedicated type. You create an Auftragsbestätigung and rename the subject to "Pro-forma-Rechnung" (HC/9167099).
- **Sammelrechnung** (one invoice covering several deliveries): no dedicated feature found. [?]
- **Negative invoices are not possible.** Single negative positions are allowed, but the total must stay positive.
- **Kassenbuch invoices**: when creating an invoice from the cash book, invoices under 250 € net need no customer data (small-amount invoice).

### 4.2 Statuses and transitions

Invoice status codes (API):

| Code | Status | Meaning |
|---|---|---|
| 50 | Deaktivierte Vorlage | Deactivated recurring template |
| 100 | Entwurf | Draft |
| 200 | Offen / Fällig | Sent; shown as "fällig" once the due date has passed |
| 750 | Teilbezahlt | Partially paid (added June 2024) |
| 1000 | Bezahlt | Paid |

- The UI also has a **Storno** state.
- Mobile app colours: Entwurf blue, Offen yellow, Fällig red with the due date, Teilbezahlt yellow, Bezahlt grey (HC/11433804).

Transitions:
- **Draft → Open:** happens on any finalizing action ("Überprüfen und senden": download, email, post, print, or "Fertigstellen und speichern").
- **Draft-only actions:** each finalizing action has an "Als Entwurf …" variant that does not finalize (HC/9064907).
- **Open → Partially paid / Paid:** by booking payments (section 9).
- **Reset:** `resetToDraft` (only from Open, and only if not locked) and `resetToOpen`. There is no free status change; the API endpoint `changeStatus` was removed.
- **Locking (festschreiben):** cannot be undone. A locked document can only be cancelled (Storno) or credited (Gutschrift).
- **Editing an unlocked invoice:** three-dot menu or Mehr → "Dokument bearbeiten" (HC/9064811).

Numbering:
- Drafts show the *next free* number, but the number is fixed only at finalization, in the order invoices are finalized. All open drafts can show the same number (HC/9064863).

List view:
- Visible tabs/filters include Fällig, Storno and Mahnungen. The full tab list (e.g. Entwurf/Offen/Bezahlt) is [?].
- Row actions: three-dot menu (edit, next reminder, create delivery note, follow-up invoice) and a banknote icon to mark as paid.
- API filters a clone should match: status, number, date range, contact, tags, cost centre, partially paid, delinquent, amount range, `headerOrNumber`, `orderByDueTime`.

### 4.3 Invoice editor (web)
Sources: HC/10117558, HC/9167074, HC/9167060, HC/9064658, HC/9310403.

**Header**
- Kontakt: autocomplete. Typing a new name creates the contact in the background. "Adresse wählen" appears when a contact has several addresses.
- Address as free text.
- Rechnungsnummer, Rechnungsdatum.
- Lieferdatum, or a Leistungszeitraum (service period, `deliveryDate` + `deliveryDateUntil`).
- Referenz / Bestellnummer (`customerInternalNote`).
- Betreff (`header`).

**Kopftext / Fußtext (header and footer text)**
- Rich text with colours, tables, links and lists.
- Can use Textvorlagen and Platzhalter (contact, document, company and custom contact fields).
- Placeholders also work in the subject, position name and position description.

**Positions**
- Columns: Produkt (search or "Produkt erstellen"), Menge, Einheit, Einzelpreis, USt %, Rabatt (% or €), Betrag.
- Descriptions accept limited HTML: bold, italic, underline, `<ul>` lists.
- Buttons: "+ Position hinzufügen", "+ Produkt auswählen", "+ Zeiterfassung auswählen" (add-on).
- "+ Gesamtrabatt hinzufügen": a document-level discount **or surcharge (Aufschlag)**, % or fixed.
- **Headings/blocks** are done as a position with quantity 0 and price 0. No subtotal or text-only position type is documented (HC/9167081). [?]
- Gross/net entry is toggled per document; the default comes from settings.

**"Weitere Optionen" (below the footer)**
- Währung (currency)
- Skonto (cash discount: % plus days)
- Interne Kontaktperson (a sevdesk user)
- Abweichendes Erlöskonto (different revenue account; can add your own account)
- Zahlungsmethode
- Umsatzsteuerregelung (VAT rule): **one per document**
- "Dokumente hinzufügen": extra attachments sent along with the invoice
- For e-invoices: Kundenreferenz / Leitweg-ID

**Preview panel**
- Choose letterhead (Blanko / without letterhead / your own).
- Layout and colour palette, logo size.
- Print toggles (section 5.4), including the QR code and PayPal link per document.

**Other options**
- Cost centre (Pro).
- Tags (minimum 3 characters).

### 4.4 VAT rules (API `taxRule`, v2)

Revenue rules for standard taxation (Regelbesteuerung):

| ID | Rule | Allowed rates |
|---|---|---|
| 1 | Umsatzsteuerpflichtige Umsätze (taxable sales) | 0 / 7 / 19 % |
| 2 | Ausfuhren (exports to non-EU countries) | 0 % |
| 3 | Innergemeinschaftliche Lieferungen (intra-EU supplies) | 0 / 7 / 19 % |
| 4 | Steuerfreie Umsätze §4 UStG (tax-exempt sales) | 0 % |
| 5 | Reverse Charge §13b (UStVA field 60) | 0 % |
| 21 | Reverse Charge §18b (UStVA field 21) | 0 % |
| 17 | Nicht im Inland steuerbare Leistung (service not taxable in Germany; old `noteu`) | 0 % |
| 18 | One-Stop-Shop, goods | rates of the destination country |
| 19 | One-Stop-Shop, electronic services | rates of the destination country |
| 20 | One-Stop-Shop, other services | rates of the destination country |

Restrictions:
- Rules 17–21 cannot be used for AR/TR/ER invoices.
- OSS rules (18–20) also cannot be used for e-invoices, vouchers or a custom revenue account.

Kleinunternehmer (small business, §19):
- Revenue rule 11, "Steuer nicht erhoben nach §19 UStG", 0 %.
- The §19 notice is added automatically and no VAT is shown.

Expense rules (used on receipts):
- 8: Innergemeinschaftliche Erwerbe (intra-EU acquisitions)
- 9: Vorsteuerabziehbare Aufwendungen (input VAT deductible)
- 10: Nicht vorsteuerabziehbar (not deductible)
- 12: Reverse Charge §13b Abs. 2 with input VAT deduction
- 13: Reverse Charge §13b without input VAT deduction
- 14: Reverse Charge §13b Abs. 1 EU

Other notes:
- In v2, products only allow rates of 0, 7 and 19 %.
- The mobile app offers only rules 1, 4 and 5.
- Help-center articles cover how to book intra-EU supplies, third-country cases, OSS, import VAT (Einfuhrumsatzsteuer) and receipts with foreign VAT.
- `deliveryAddressCountry` sets the OSS country.

### 4.5 Recurring invoices (HC/66938)
- **Fields:** same form as a normal invoice, plus:
  - Erste Rechnung (first date)
  - Referenznummer
  - Enddatum (optional end date)
  - Interval: 7 days, 14 days, monthly, 2 months, quarterly, half-yearly, yearly, 2, 3, 4 or 5 years
  - Billing in arrears (nachfällig, checkbox) or in advance
- **Automatic generation** can be switched on or off.
- **Automatic sending:** "kein automatischer Versand" or "E-Mail versenden" with a chosen email template. Needs an email address on the contact; PDF or e-invoice.
- Saved with "Aktivieren". Templates are Aktiv or Inaktiv and can be deactivated or reactivated. "Rechnung erzeugen" creates one invoice early.
- **Automatic header text:** "Berechnung für den Zeitraum vom 27.01.2026 – 26.02.2026".
- The detail view lists the invoices already generated. Generated invoices land in the normal invoice list.
- API fields: `accountIntervall` (ISO-8601 duration), `accountNextInvoice`.

### 4.6 Gutschriften (credit notes, HC/15190963)
Path: Rechnungen → Gutschriften. The booking category is chosen first. API `bookingCategory` values:

| Category | Meaning |
|---|---|
| UNDERACHIEVEMENT | Minderleistung / Teilstorno (refund for a reduced service). Only for paid or partly paid invoices. All positions are copied in and can be reduced. Needs a reference to the source invoice. |
| PROVISION | Commission |
| ROYALTY_ASSIGNED / ROYALTY_UNASSIGNED | Honorar (fee): accounts 3100/5900 if assignable to a product, 4909/6303 if not |
| ACCOUNTING_TYPE | Book to a chosen account. v1 only. |

- Statuses: 100 Entwurf, 200 Offen, 750 Teilbezahlt, 1000 Bezahlt.
- Gutschriften have their own number range.
- **Self-billing** ("Gutschrift als Rechnungsersatz", §14 Abs. 2 UStG) is handled as an uploaded receipt, not a generated document (HC/9684740).
- **Supplier credit notes** are recorded as receipts.
- Credit notes for uncollectible receivables use the "Minderleistung" flow (HC/9886403).

### 4.7 Sending (HC/9064907)

| Channel | Details |
|---|---|
| Download | PDF |
| Email | Fields: recipient (pre-filled from contact), CC/BCC (API), Betreff, Nachricht (template), Signatur, "Kopie an mich selbst", PDF attachment, standard attachments (e.g. AGB) plus "+ Anhang". For e-invoices, option to send XML only. |
| Per Post (letter) | Via emailbrief.de. Options: black-and-white, colour, duplex. Shipping status shows on the invoice; a sent order cannot be cancelled. Billed by sevdesk when charges reach 10 € or monthly. Per-letter price not published. [?] |
| Print | Browser print |
| Save | "Fertigstellen und speichern" |

- API send types: VPR (print), VPDF (download), VM (email), VP (post). `sendBy` with `sendDraft`.
- **Sender address:** noreply@sevdesk.de by default, or your own SMTP per user (HC/9382075).
  - SMTP fields: sender name, server, port 465/587/25/2525, user, password, SSL/TLS.
  - Microsoft 365 connects via OAuth; SMTP for Microsoft is being phased out.

### 4.8 E-Rechnung (sending)
Sources: HC/10079526, https://sevdesk.de/e-rechnung-software/

- **Where it's switched on:** per invoice, per contact ("E-Rechnung Standard"), or account-wide.
- **Formats:**
  - ZUGFeRD: PDF with embedded XML, sent by email.
  - XRechnung: "Nur XML senden".
  - The XML is identical in both. API: `propertyIsEInvoice`, `getXml`, `sendXml`.
- **Required data:**
  - Seller: street, ZIP, city, IBAN, BIC, email, phone, tax number or VAT ID.
  - Buyer: email (mandatory), address, payment method.
  - Leitweg-ID / buyer reference only for public-sector customers; otherwise the Kundenreferenz defaults to "0".
  - SEPA direct debit needs a Gläubiger-ID (creditor ID) and the customer's IBAN.
- **Validation:** sevdesk says it validates against EN 16931 automatically. The ZUGFeRD profile and XRechnung version are not published. [?]
- **Plans:** creating e-invoices is in all plans, including Free. Receiving them needs Buchhaltung or higher.
- **Free tool:** a public "E-Rechnungsgenerator" exists (https://sevdesk.de/e-rechnungsgenerator/).

### 4.9 Payments on invoices
- **QR code (two different features):**
  - The "QR-Code" is a **download link to the PDF**, top right under the logo (HC/9382464).
  - The separate **EPC-QR-Code (GiroCode)** print option needs bank data in the company settings (HC/9382459).
- **PayPal link** (HC/9374449):
  - Erweiterungen → Integrationen → PayPal; enter your PayPal email, optionally enable it for every invoice.
  - Per document: icon, full link, plain text, or off. Printed below the positions with amount pre-filled.
  - API layout key `payPal`: A (icon), B (link), C (off), D (text).
- **No native online payment** (card, Stripe checkout or payment link) was found. Stripe appears only as an accounting import via miraclesync. [?]
- **Zahlungsmethoden** (HC/9382107):
  - Fields: Name and Text (printed on the invoice).
  - One can be the default (star). System methods are locked; your own can be archived.

### 4.10 Languages and currencies
- Document language can be switched per document. Required invoice details are translated.
- API layout `language` values: de_DE, de_AT, de_CH, en_US, es_ES, fr_FR, it_IT, el_GR. The marketing pages only promise German and English.
- **Currencies:** more than 50, with an automatic exchange rate. The API stores foreign-currency sums alongside the accounting sums. Not allowed on AR/TR/ER invoices.
- The UI language itself can be changed under Benutzer.

---

## 5. Layouts, letterhead, text templates, number ranges

### 5.1 Letterhead vs layout (HC/9382319)
- **Briefpapier (letterhead)**: a PDF background in A4.
  - A one-page letterhead is used on every page.
  - With two pages, page 1 is used for the first page and page 2 for all later pages.
  - Picked per document in the preview: Blanko / Ohne Briefpapier (logo top right, or company name) / your own. One can be starred as default.
- **Layout**: controls where the variable data goes and the fonts.
  - 11 layouts: 5 free and 6 premium (3,90 €/month).
  - A colour palette applies to headings and accent lines.
  - Changes apply to all draft documents.

### 5.2 Your own HTML layouts (HC/9382437)
- Download HTML/CSS templates per document type under Einstellungen → Briefpapier → Layouts.
- **Structure:**
  - Running elements on every page: HEADER, FOOTER, ASIDE.
  - Then: `adressline` (sender line), `recipient`, `descbox` (info box), Betreff `{{data.object.header}}`, `headtext`, `postable` (positions table with thead/tbody/tfoot), `partialheader` (final-invoice summary), `footText` (also holds the Skonto and payment-method text).
- **Template syntax (Mustache-style):**
  - `{{VAR}}` for variables
  - `{{#VAR}}…{{/VAR}}` for "if set", `{{^VAR}}…{{/VAR}}` for "if not set"
  - `{{#i18n}}…{{/i18n}}` for auto-translated labels, `{{#date}}…{{/date}}` for dates
- Fonts via a webfont URL or a Base64 TTF/OTF. Images as Base64 or links. The QR code uses the class `qrcode url-qrcode`.
- A parameter list is offered as an XLSX download.

### 5.3 Number ranges (Nummernkreise, HC/9382101)
- **One range per type:** Rechnung, Gutschrift, Angebot, Auftragsbestätigung, Lieferschein, Artikel, Kontakte (shared by customers and suppliers), Inventar (assets).
- Fields: Format (from fixed variables; you can't add your own), Nächste Zahl (default 1000), Vorschau (preview).
- Example: `RE-%YY00%NUMBER` gives RE-26001. Leading zeros are written into the format and must be shortened by hand as the number grows.
- Full variable list (presumably %YYYY, %MM, %DD …) and yearly reset are [?].
- Next-number lookup in the API: `SevSequence/Factory/getByType?objectType=Invoice&type=RE`.

### 5.4 Print options (HC/9382459)
Each can be switched on or off:
- Fußzeile (footer)
- Seitenzahl (page number)
- Falz- und Lochmarken (fold and punch marks)
- QR code (download link)
- EPC-QR/GiroCode
- Artikelnummer
- Positionsbeschreibung (print positions without a description)
- Absendezeile (sender line above the recipient)
- USt-Satz pro Position (VAT rate per position)
- Positionssummen bei Bruttorechnungen (position totals on gross invoices)

### 5.5 Text templates (Textvorlagen, HC/9382483)
- **Typ "Dokument"**
  - "Verwenden für": Angebote, Auftragsbestätigungen, Gutschriften, Lieferscheine, Mahnungen or Rechnungen.
  - Position: Kopftext or Fußtext.
- **Typ "E-Mail"**
  - Position: Signatur, or email body. Can apply to all documents or one type.
- **Options**
  - Placeholders.
  - "Nur für mich sichtbar" (only the creator can use it).
  - "Als Standard festlegen" (one per type, inserted automatically).
- **Placeholder dictionary:** API `GET /Textparser/fetchDictionaryEntriesByType`. The exact placeholder syntax isn't in public docs. [?]
- **Standard attachments:** Einstellungen → System → Anhänge, per document type (HC/9382297).

---

## 6. Quotes and orders: Angebote, Auftragsbestätigung, Lieferschein

Sources: https://sevdesk.de/angebotssoftware/, https://sevdesk.de/lieferscheinprogramm/, OpenAPI Order, HC/11885789, HC/12594801, HC/12058373.

- **One model with `orderType`:** AN (Angebot), AB (Auftragsbestätigung), LI (Lieferschein).
- **Order fields:** like the invoice, plus `version`, `deliveryTerms`, `paymentTerms`, `origin`/`typeOrigin`, and positions with an **`optional` flag** (optional quote positions) and a discount per position. Discounts are retrievable via `getDiscounts`.

Order status codes (API):

| Code | Status |
|---|---|
| 100 | Entwurf |
| 200 | Versendet |
| 300 | Abgelehnt / storniert (rejected or cancelled) |
| 500 | Angenommen (accepted) |
| 750 | Teilberechnet (partly invoiced) |
| 1000 | Berechnet (fully invoiced) |

- **App labels:**
  - Angebot: Entwurf, Offen, Abgelehnt, Erhalten (accepted), Teilberechnet, Berechnet.
  - Auftragsbestätigung: Entwurf, Versendet, Berechnet.
  - Lieferschein: Entwurf, Erhalten, Berechnet (Alle).
- **Conversions:**
  - Angebot → AB, Lieferschein or Rechnung (normal, Teil-, Abschlags- or Schlussrechnung).
  - AB → Rechnung or Lieferschein. Rechnung → Lieferschein.
  - Later documents share the same reference. A "Verknüpfte Dokumente" view shows the chain.
  - API: `createInvoiceFromOrder` (type percentage/net/gross, amount, partialType RE/TR/AR), `createPackingListFromOrder`, `createContractNoteFromOrder`, `getRelatedObjects`.
- **Online acceptance:** the link placeholder in the quote lets the customer accept or decline. With the setting on, acceptance creates the invoice.
- **Sending:** quotes go by email or post, like invoices.
- **Lieferschein (delivery note):**
  - Unit prices optional. Own number range; drafts carry no number.
  - With the Inventar add-on, a Lieferschein reduces stock.
- **Quote versioning** exists in the API (`version`); not confirmed in the UI. [?]

---

## 7. Dunning (Mahnwesen)

Sources: HC/9071059, HC/9167192, https://sevdesk.de/mahnungen/

- **Level 1 is the Zahlungserinnerung** (payment reminder, no fee).
- **Further Mahnungen:** "Nächste Mahnung erstellen", from Buchhaltung upward. **There is no limit on the number of levels** ("Es gibt keine Beschränkung").
- **Flow:**
  1. Rechnungen → filter "Fällig" (overdue).
  2. Three-dot menu or invoice → "Mahnung / Zahlungserinnerung". A document is created with an adjusted subject, editable header and footer text, and the Mahnfrist as the new deadline.
  3. Send, print or download.
- **Overview:** all reminders are listed under Rechnungen → Mahnungen. The next level is created from the invoice or the last Mahnung.
- **Payment:** marking any linked document as paid sets the whole chain to Bezahlt.
- **API:** type MA, `dunningLevel` (1 = reminder, then +1 per level), `reminderDeadline`, `reminderDebit`, `reminderTotal`, `reminderCharge`. In v2, `reminderCharge` above 0 is rejected, so **no reminder fees can be set**.
- **Fees received:** when a customer pays more because of dunning fees, use the payment-difference reason "Mahngebühren" (booked to 4970/6855 at 0 %).
- **Not available:**
  - No automatic interest calculation (Verzugszinsen §288 BGB, base rate +5/+9 pp, 40 € B2B lump sum appear only in guide articles).
  - No scheduled automatic dunning run; marketing implies automation, the help center describes it as manual. [?]
- **Debt collection:** via the paywise integration (Debtist [3rd]); no native handover button.

---

## 8. Contacts and CRM

Sources: HC/13868699, HC/9064577, HC/9382263, HC/9413318, OpenAPI Contact.

- **Types:** Organisation or Person. A person can belong to an organisation (`parent`). In the API, `name` set means organisation; `surename`/`familyname` set means person.
- **Categories:** Kunde, Lieferant, Partner, Interessent, plus custom ones under Einstellungen → System → Kategorien (type "Kontakt"). API IDs: 3 Customer, 2 Supplier, 4 Partner, 28 Prospect.
- **Status:** 100 Lead, 500 Pending, 1000 Active.

**Contact fields (API)**
- Identity: customerNumber, name, name2, surename (first name), familyname, titel (position), academicTitle, gender, birthday, description
- Tax: vatNumber, taxNumber, taxOffice, exemptVat
- Bank: bankAccount (IBAN), bankNumber
- Payment terms: defaultTimeToPay, defaultCashbackTime/Percent (Skonto), defaultDiscountAmount plus a percentage flag
- E-invoicing: buyerReference (Leitweg-ID), governmentAgency (Behörde)

**Related records**
- **Addresses:** separate ContactAddress records, unlimited per contact. Fields: street, zip, city, country, category, name, name2–4. Exact category labels (e.g. invoice vs delivery address) [?].
- **Communication ways:** type EMAIL/PHONE/WEB/MOBILE, a key, value and a `main` flag.
  - Keys: Privat 1, Arbeit 2, Fax 3, Mobil 4, leer 5, Autobox 6, Newsletter 7, Rechnungsadresse 8.
  - Key 8 carries the address used for invoice emails. [?]
- **Accounting contact:** debitorNumber / creditorNumber. Assigned automatically by DATEV logic when empty (debtors 10000–69999, creditors 70000–99999; HC/9382153).
  - Sammeldebitoren/-kreditoren (collective accounts) via categories or a special contact (HC/9064613).
- **Custom fields:** name and description, set per contact under "Eigene Felder". They become placeholders in documents and templates. Rights can be set per user.
- **Tags:** shared with documents. A person inherits its organisation's tags.

**Contact detail screen**
- **Verlauf (history)** is the default tab. It lists all linked documents; you can add notes with file attachments and email colleagues by ticking their names.
- Linked documents, plus a per-customer folder in the file manager.
- Options menu:
  - Brief schreiben (letter with subject, date and text; print or post; HC/9064621)
  - Aufgabe erstellen (create task)
  - Kundenpreis or Lieferantenpreis hinzufügen (customer or supplier price; Inventar add-on, HC/9064585)
  - Löschen (only when no documents are linked)

**Other**
- Merge duplicates (winner/loser, same type only, irreversible).
- CSV import with a template, separator detection and conflict preview (HC/9382275).
- Contact export exists in the API (`/Export/contactListCsv`, `/Report/contactlist`). Whether the UI offers it is [?].
- No VIES check of VAT IDs was found.

---

## 9. Products and stock (Artikel, Inventar add-on)

Sources: HC/9374848, HC/9373930, OpenAPI Part.

**Product form**
- Produktname
- Standardeinheit (default unit)
- Art.-Nr. (assigned from the number range)
- USt % (0/7/19)
- Kategorie: "Standard", "Dienstleistungen" or custom
- VK netto and VK brutto (sales price, each calculated from the other)
- EK netto and EK brutto (purchase price)
- Produktbeschreibung (printed on documents)
- Interne Bemerkung (not printed)
- **Tab "Weitere Einheiten":** extra units with a factor and auto-calculated price, e.g. a box of 10 eggs.
- **Tab "Weitere Einstellungen":** "Bestand aktiviert" (stock on) and "Meldebestand" (reorder level, with an email reminder interval).
  - The help center says this needs the Inventar add-on "bzw. Buchhaltung Pro", which suggests Pro includes stock tracking. That isn't on the pricing page. [?]
- **API Part fields:** partNumber, name, text, category, stock, stockEnabled, unity, price/priceNet/priceGross, pricePurchase, taxRate, status (50 inactive / 100 active), internalComment. `getStock` returns the stock.

**Inventar add-on (19,90 €)**
- Menu "Inventar".
- **Stock goes down only through a Lieferschein**, either linked to an invoice ("Lieferschein erzeugen") or standalone.
- Manual "Bestand bearbeiten": Zugang (increase) or Abgang (decrease) plus quantity.
- "Buchungsverlauf" tab shows the history. The product view shows sales prices and last use.
- Also enables customer and supplier prices.
- Not found: variants, price lists, warehouses, purchase orders.

---

## 10. Receipt capture (Belege) and e-invoice receipt

Sources: HC/9453113, HC/9167324, HC/9172852, HC/10079497, https://sevdesk.de/belege-erfassen/

**Ways to get receipts in**
- "Ausgabe erfassen" or "Einnahme erfassen".
- Drag and drop files or folders: drop on the left for expenses, on the right for income. Saved as drafts.
- Mobile scan: auto-capture, crop, multi-page, gallery upload.
- **Email inbox ("Autobox"):** forward to `autobox@sevdesk.email`. Only accepted from the registered user email. Attachments become drafts.
- Integrations: GetMyInvoices, invoicefetcher, Spesenfuchs, Einfach Reisekosten.
- Formats: PDF, PNG, JPG, and XML for e-invoices.

**AI recognition (OCR)**
- Extracts supplier, date, amount, VAT, receipt number and category (booking account). Recognized fields are framed in the app.
- The category is a suggestion that learns from your past choices, confirmed by the user.
- API: `estimatedAccountingType` on positions.

**Editor fields**
- Supplier (contact or free-text name)
- Belegdatum, Belegnummer (free text)
- Lieferdatum / Leistungszeitraum (service period), payment deadline (API `paymentDeadline`)
- Gross/net per receipt
- **Kategorie = booking account:** dropdown, "Erweiterte Suche" (advanced search), decision-tree helper, "+ Eigenes Buchungskonto" (about 1,500 SKR accounts), favourites (star)
- VAT rule: shown VAT / no input VAT deduction / Reverse Charge, with origin Germany, EU or non-EU
- VAT rate per position
- Foreign currency: conversion at a reference date or a fixed rate (`propertyForeignCurrencyDeadline` / `propertyExchangeRate`)
- Cost centre (Pro), tags, attached document
- Several positions per receipt, each with its own account and rate (API `VoucherPos`: accountDatev, taxRate, net, sumNet/sumGross, isAsset, comment)
- The required-fields list in the app: supplier, date, amount, category, VAT and receipt number.

**Receipt statuses**

| Code | Status |
|---|---|
| 50 | Entwurf (draft) |
| 100 | Offen / unbezahlt, or fällig when overdue |
| 150 | Vorgemerkt (transfer initiated) |
| 750 | Teilbezahlt |
| 1000 | Bezahlt |

- The app adds "Unvollständig" (incomplete: required data missing).
- Assets written off immediately show as "Abgeschlossen".
- `creditDebit`: C = expense, D = revenue.

**Batch processing**
- Select drafts → "Bearbeiten" opens a queue; "Fertigstellen und weiter" moves to the next one.
- Bulk delete of drafts.
- "Sammelbuchung": several receipts against one payment.

**Other receipt features**
- **Missing-receipt overview:** receipts without a payment and payments without a receipt, with suggested matches.
- **Recurring receipts** (HC/9172976):
  - Type RV. Intervals: weekly, 2-weekly, monthly, 2-monthly, quarterly, half-yearly, yearly, 2–5 years.
  - Start date, end date or open-ended. A new open receipt is created each period. Can be activated or deactivated.
- **Hospitality receipts (Bewirtung):** occasion "Geschäftspartner" (70/30 deductible split, 100 % input VAT) or "Mitarbeiter".
- **Not native:** per-diem meal allowance, company-car use, mileage log (Fahrtenbuch), travel expenses. The help center explains manual bookings; partners cover the rest.
- **Self-issued receipt (Eigenbeleg):** template provided.
- **Pass-through items (durchlaufende Posten):** supported.
- **Duplicates:** only a warning when the same image is uploaded twice. [?]

**Receiving e-invoices** (Buchhaltung+)
- Upload XRechnung or ZUGFeRD through any input channel.
- XML is shown in a readable view. Validated with the Mustang validator; data is extracted and a booking is suggested; archived GoBD-compliant.
- The API accepts XML uploads without checking EN 16931 compliance.
- An interface for partners is "planned".

**Asset positions** follow the same flow (section 13).

---

## 11. Banking

Sources: HC/9345270, HC/9382114, HC/9382118, HC/14086069, HC/9360905, HC/9173029, OpenAPI CheckAccount.

### 11.1 Payment account types (API `type`)

| Type | Name | Notes |
|---|---|---|
| online | Onlinekonto | Via **finAPI** (PSD2, BaFin-licensed, 4,000+ banks). Login, save PIN, TAN, select accounts; "Weitere Konten abrufen" for e.g. credit cards. |
| online | PayPal | OAuth connection. Fees arrive as separate transactions (category Gebühren) and are bulk-booked to 4970/6855. |
| online | Datenimport-Konto | CSV import with column mapping, header option and signed amounts. The format is saved per account. API also lists MT940. |
| offline | Verrechnungskonto | Clearing account mapped to a booking account. The built-in "Basiskonto" also exists. |
| register | Kasse | Cash register (section 12) |

- **Account settings:** name, bank name, IBAN (locked), booking account (unique, e.g. 1200 in SKR03 / 1800 in SKR04), "Transaktionen automatisch zuordnen", auto-sync, priority/order, archive (status 0/100), default account. "Umstellen auf Import-Konto" cannot be undone.
- **Sync:** once a day, plus manual "Synchronisieren" and "Transaktionen importieren" for a chosen period. Balance via `getBalanceAtDate`.
- **Duplicates:** CSV imports have no duplicate check. Manual cleanup by filtering on the payment reference, then delete or mark private (HC/9360778).

### 11.2 Transactions
- **Fields:** valueDate, entryDate, paymtPurpose (payment reference), amount, payeePayerName, IBAN, BIC, checkAccount, status, source/target transaction (for rebookings).
- **Statuses:** 100 Erstellt/offen, 200 Zugeordnet (assigned, amount still open), 300 Privat, 400 Gebucht (booked).
- **Actions:**
  - Link to invoice, receipt or credit note, or create a new receipt from the transaction.
  - "Als privat markieren": posts to 1800/2100 or 1890/2180 by sign.
  - "Geldbewegung" (money in transit between own accounts, account 1360/1460).
  - "Als Kreditaufnahme/-rückzahlung markieren" (loan taken / repaid; interest calculated automatically).
  - Delete, "Verknüpfung aufheben" (unlink; not possible for locked documents).
- **Private rules** (`PrivateTransactionRule`): match on payment reference and/or counterpart name, case-sensitive substring, then mark private automatically. **This is the only rule engine.** No general user-defined booking or matching rules are documented.

### 11.3 Automatic matching (Auto-Zuordnung, HC/9382118)
- On by default for import and online accounts.
- Compares **amount, date, payee name and payment reference**. The priority order of reference / amount / name can be set by drag and drop under Einstellungen → Buchhaltung → Transaktionszuordnung.
- Runs after each sync or CSV import.
- **Results:**
  - "Automatisch zugeordnet": very high confidence, linked automatically.
  - "Vorschlag": suggestion to review.
- **Review:** Bank → Zuordnungen. Confirm (✓), reject (X), "Allem bestätigen" (confirm all), "Alles erledigt" (empty state), "Zahlungen ohne Beleg ansehen" (payments without receipt).
- **Mobile app limit:** matching only works when amounts are exactly equal.

### 11.4 Booking payments and payment differences
- **From a document:** "Zahlungseingang buchen" → choose account → choose transaction, or enter the date for offline accounts and cash.
- **From a transaction:** pick suggested documents or search.
- **Difference reasons** (HC/14086069), with API codes:

| Reason | API code | Booking |
|---|---|---|
| Teilzahlung (partial payment) | N | Document becomes Teilbezahlt |
| Teil einer Sammelbuchung (part of a combined payment) | – | Document becomes Bezahlt; the transaction stays Zugeordnet with the rest open |
| Skonto (cash discount) | CB | Skonto accounts by VAT rate, e.g. 8736/4736 given, 3736/5736 received |
| Kosten des Zahlungsverkehrs (bank fees) | MTC | 4970/6855 at 0 % |
| Mahngebühren (dunning fees) | OF | 4970/6855 at 0 % |
| Sonstige (other) | O | – |
| Currency fluctuation | CF | Deprecated |

- Full payment uses code `FULL_PAYMENT`.

### 11.5 Payments out of sevdesk
- **SEPA transfer** from a receipt via finAPI (online accounts only), with a TAN on the finAPI page. Very small amounts may need no TAN.
- **Sammelüberweisung:** several receipts to the same payee. Fields: execution date, IBAN, payment reference built from receipt numbers. Restricted character set.
- Receipts move to "Vorgemerkt", then Bezahlt after the next sync (HC/9173029).
- Direct-debit integrations: SepaHeld, SEPApro.

---

## 12. Cash book (Kassenbuch, HC/9360787)

- **Opening:** Bank → Kassenbuch → "Kasse eröffnen" with an opening balance and date. Cannot be changed afterwards.
- **Entries:**
  - "Ausgabe erfassen" (normal receipt form, booked to the cash register).
  - "Rechnung erstellen" (invoices under 250 € need no customer data). Payment is booked to cash after sending.
  - Any receipt or invoice can be "als bezahlt" against Kasse. Geldbewegung between bank and cash.
- **Unchangeable:** entries cannot be edited or deleted, not even by support. Corrections are made only by unlinking, which creates an **automatic counter-entry dated today** (the date cannot be changed).
- **Reports:** running balance; daily and monthly closings; cash report as PDF.
- **Not documented:** only one register is supported; no negative-balance check; no POS import (SumUp exists as an integration). [?]

---

## 13. Fixed assets and depreciation (Anlagen/AfA)

Sources: HC/9915171, HC/9173125, https://sevdesk.de/funktion-abschreibungen/

- **Detection:** an expense on an asset account (e.g. 420/650, 480/670 GWG) makes sevdesk ask: "Anlage" with a useful life, or "Geringwertiges Wirtschaftsgut" (low-value asset). API flag `isAsset`.
- **Thresholds:**
  - Above 800 € net: an asset, depreciated straight-line **monthly** from the purchase month.
  - 250,01–800 €: GWG, written off immediately.
  - **Pool depreciation (Sammelposten) is not possible.**
- **Useful life:** from the BMF AfA table (search by category or keyword), or a custom life. Computer hardware and software: immediate write-off or 3 years.
- **Asset list:** Belege → Anlagen. Shows status, purchase cost, book value, monthly depreciation, remaining term, inventory number (own number range), and a depreciation table per asset. Depreciation flows into EÜR and GuV.
- **Gaps:**
  - Disposal, sale and early end are manual. Early end needs support; sale is booked as gain/loss plus a sale invoice.
  - Declining-balance depreciation (until 31.12.2027) and the 75 % first-year write-off for electric vehicles need workarounds.
  - **No asset register report (Anlagenspiegel) was found.**

---

## 14. Chart of accounts and bookkeeping logic

Sources: HC/9382213, HC/11325646, HC/9965272.
- **Charts:** **SKR03 or SKR04** (SKR07 for Austria). "Kategorien" are SKR accounts; v2 restricts which accounts are allowed.
  - API endpoint `ReceiptGuidance` lists each account with its allowed tax rules and receipt types.
  - Endpoints: `forAllAccounts`, `forAccountNumber`, `forTaxRule`, `forRevenue`, `forExpense`.
- **Accounts posted only by special functions:** private (1800/2100, 1890/2180), money in transit (1360/1460), loans, interest.
- **Company settings:**
  - Profit method: EÜR (cash basis, payment date, 10-day rule for recurring payments) or GuV (service date, VAT-neutral).
  - Soll- or Ist-Versteuerung (accrual or cash VAT; Soll is the default).
  - Regelbesteuerung or Kleinunternehmer. Switching Kleinunternehmer to standard taxation locks all earlier data.
- **Single vs double entry:**
  - "Doppelte Buchführung" means a DATEV-compatible export from which the tax advisor builds the balance sheet. Sevdesk itself does not produce one.
  - **No manual journal entries and no opening balances** (the trial balance beta lists opening balances as future work).
  - Liability accounts are usable to a limited extent (HC/12679803).
- **Custom VAT rules** (text, rate, revenue/expense, UStVA field, BU key) exist in v1. v2 uses the fixed list from section 4.4.
- **Help-center booking guides:** Löhne (wages, net method), Minijobs, Darlehen (loans), Rückstellungen (provisions, v1), Steuerzahlungen (tax payments), Stundung (tax deferral), Porto, Gebühren, Gutscheine (vouchers), Schadensersatz (damages), Cashback, Kreditkarte, Geldtransit.

---

## 15. Taxes and reports

Sources: HC/9310598, HC/9886922, HC/9310586, HC/9310611, HC/9360933, HC/9700577, HC/10709526.

### 15.1 UStVA via ELSTER (Buchhaltung+)
- **Path:** Steuern → UStVa.
- **Flow:**
  1. Pick the period (monthly or quarterly) and year/month.
  2. Values are calculated automatically and **cannot be entered by hand**, except Kz 36 and Kz 98. Click a line to see its documents.
  3. "Überprüfen & Versenden": summary and optional details.
  4. Optional "Versand ans Finanzamt testen" (test submission).
  5. "Versenden".
  6. Green tick and protocol PDF with the tax office's ticket number.
  7. "Steuerbeleg fertigstellen": creates a pre-filled tax receipt to link to the payment.
- **Setup:** no ELSTER certificate needed. The tax office is derived from the tax number and address.
- **Kennzahlen supported:** 81, 86, 35/36, 41, 43, 48, 89, 93, 95/98, 46/47, 84/85, 21, 45, 66, 61, 62, 67, 83.
- **Corrections:** the v1 docs say a corrected UStVA can be sent at any time; the v2 correction flow is [?].
- **Dauerfristverlängerung** (one-month extension) and the 1/11 special prepayment must be filed outside sevdesk; the prepayment is booked manually (1781/3830) and credited back in Kz 39.

### 15.2 Reports

| Report | Plan | Details |
|---|---|---|
| EÜR | Buchhaltung | Steuern → EÜR. Periods: month, quarter, year, day range. Line numbers match the official **Anlage EÜR** so values can be copied into ELSTER. Can hide unbooked categories. Private deposits and withdrawals shown for information. PDF. **Not submitted via ELSTER.** |
| GuV | Buchhaltung | §275 HGB structure, "Vereinfacht" or "Amtlich" view, periods year/quarter/month/range, drill-down to documents, PDF. Marketing claims per-project GuV. [?] |
| BWA | **Pro** | Auswertungen → BWA. Modelled on the DATEV BWA, with an EÜR variant and a GuV variant. Options: month, comparison period, cost-centre filter, show/hide unbooked categories and ratios (total revenue ratio, total cost ratio, business income ratio, personnel cost ratio), expandable lines. PDF. |
| Summen- und Saldenliste (beta) | Buchhaltung | Account, debit, credit, balance; sortable; year/quarter/month; click an account to see its bookings. No opening balances; v2 data from 2021 only. |
| Kassenbericht (cash report) | Buchhaltung | Daily and monthly, PDF |
| Cost-centre analysis | Pro | List filters plus the BWA filter. One cost centre per document. |

- **Not offered:**
  - Bilanz / E-Bilanz (balance sheet)
  - ZM (EC sales list): Kz 41 values only feed the UStVA
  - OSS return: OSS revenue appears in Kz 45; filing is manual in the BZSt portal
  - Annual VAT, income tax, trade tax and corporate tax returns
  - Asset register (Anlagenspiegel), journal, account ledger, liquidity plan
  - A separate open-items report: open items appear in the invoice list and dashboard
- **API exports:**
  - CSV lists of invoices, credit notes, receipts, transactions and contacts.
  - ZIPs of invoice and receipt PDFs.
  - Report endpoints for invoice, order, contact and voucher lists.

---

## 16. Tax advisor, DATEV and GoBD

Sources: HC/9373838, HC/12587033, HC/9413016, HC/15531427, HC/9413300.

### 16.1 Tax advisor portal
- Address: `steuerberater.sevdesk.de`. Free for advisors; linking a client is included in every paid client plan.
- **Inviting:** the client uses Steuern → Mein Steuerberater, or Einstellungen → Unternehmen → "Steuerberater um Mitarbeit bitten".
- **What the advisor can do:**
  - Client list with link status, software version, export interval and receipt status.
  - Missing receipts per period, with reminder emails.
  - View tax settings.
  - Log into the client account; edit unlocked documents; change the profit method, Soll/Ist and chart of accounts. Only the client can change bank data.
  - Add accounts.
  - Lock (festschreiben) client data.
  - Export.

### 16.2 Exports
- **DATEV modes:**
  - "Buchungsdaten & Belegbilder" (booking data and receipt images): via **DATEV Buchungsdatenservice**, needs DATEV Unternehmen online. Login with SmartCard, mIDentity or SmartLogin; the link lasts 2 years.
  - "Rechnungsdaten & Belegbilder" (invoice data and images): via **DATEV Rechnungsdatenservice 1.0** ("Digitaler Pendelordner", XML).
  - Manual file export in either mode.
- **Manual ZIP contents:** Buchungsstapel CSV (DATEV format: amount, debit/credit, account, counter-account, BU key, document number, net/VAT), Stammdaten CSV (contacts), image ZIPs for outgoing and incoming invoices.
- **Export settings:** advisor number, client number, fiscal-year start, date range (by document date), document types, include images, include locked data, include open documents. An export history is kept.
- **API DATEV export:** `scope` letters E (earnings), X (expenditure), T (transactions), C (cash register), D (assets); flags `withUnpaidDocuments`, `withEnshrinedDocuments`, `enshrine`; CSV and XML ZIP export jobs.
- **Other systems:** ADDISON OneClick / SMART Connect (scheduled pull or manual); BMD, RZL and Agenda via CSV.

### 16.3 Locking (Festschreibung) and GoBD
- **Three ways to lock:**
  1. Automatically at finalization (outgoing invoices; can be switched off).
  2. Optionally during the manual booking-data export.
  3. Manually under Einstellungen → System → Festschreiben, by period and document type (invoices, receipts, payments, credit notes).
- After locking, documents cannot be edited or deleted; corrections only by Storno or a counter-entry. sevdesk recommends locking monthly by the end of the following month.
- **Verfahrensdokumentation (procedure documentation):** **sevdesk provides no template.** The help center links to the official AWV template and states that no software certification for GoBD exists.
- **Hosting:** AWS with servers in Germany, Cloudflare, AWS WAF, penetration tests, multi-factor login.
- **Data-processing agreement (AVV)** and a GDPR article exist.
- **Retention:** data is kept only while the subscription is active; export everything before cancelling. The 8-year retention period for booking documents (BEG IV) is mentioned in a guide.
- **Tax auditor (Betriebsprüfer) access:** an extra user with limited rights; support refunds the cost afterwards. No dedicated GDPdU/Z3 data export was found.

---

## 17. Collaboration: users, rights, tasks, documents, time tracking

- **Users** (HC/9382074):
  - Created under Einstellungen → Benutzer. Roles: Administrator, or Benutzer with individual rights.
  - **Rights are checkboxes grouped by navigation item.** Unticking one hides that menu item.
  - A separate right exists for custom contact fields. An activity history covers all users.
  - Deleting a user requires cancelling the add-on first (14 days' notice).
- **Security:** MFA recommended (authenticator app [3rd]); Face ID in the app; no SSO mentioned.
- **API token:** one per administrator, a 32-character hex string, sent as the Authorization header (Pro plan).
- **Tasks (Aufgaben)** (HC/13831806):
  - Fields: description, due date, assigned user, type (Anruf, Termin or Sonstiges), reference (receipt, contact or invoice), "Benachrichtigung bei Erledigung" (notifies the creator when done).
  - Status open or done. Shown in the user menu, on the dashboard to-do list, and by email reminder.
- **Documents (Dokumente):** a file manager with folders. A "Kunden" folder gets an automatic subfolder per contact. Upload, rename, delete, drag and drop; no preview.
- **Time tracking (Zeiterfassung, add-on, web only)** (HC/9374051):
  - Fields: customer, project (a text grouping only; there is no project module), employee, duration (start–end or hh:mm, to the minute), date, service (manual or from products with a stored hourly rate), hourly rate, VAT %, description.
  - Per-customer tabs for open and billed entries with totals. On an invoice, "+ Zeiterfassung auswählen" → "Übernehmen".
  - No timer.

---

## 18. Mobile apps

Sources: https://sevdesk.de/apps/, help-center collection 9417204, store listings.

- **Listings:**
  - iOS "sevdesk Buchhaltung & Rechnung" (id731738076): about 4.4★ from about 8,000 ratings; v9.8.0 from Oct 2026, which added dark mode.
  - Android `de.sevdesk.sevdeskgo`: 100,000+ downloads.
- **Sections:** Kontakte, Angebote, Aufträge, Lieferscheine, Rechnungen, Ausgaben, Banking, Mehr (settings, support), plus a dashboard (income, expenses, open invoices).
- **Invoices:**
  - Create with customer search, positions (product/service, quantity, price, unit, 0/7/19 %, discount % or €), number, reference, invoice and delivery date.
  - Due date: today, 14 or 30 days. Payment method; VAT rules 1, 4 and 5 only.
  - Preview, draft, finalize and send; e-invoices supported. Partial payments can be seen but not booked.
- **Expenses:** scan with auto-capture, multi-page and crop; recognized fields are framed; category favourites; statuses as in section 10; link to a transaction.
- **Banking:**
  - Account filter, hide balance, search.
  - "Zuordnen" (open items only) or "Alle Zahlungen". Pull down to sync.
  - Negative transaction means expense, positive means income. Matching only on exact amount.
  - "Andere Zahlart" uses a clearing account (which must be created on the web). Mark as private.
- **Other:** quote → invoice conversion, Face ID.
- **Not in the app:** offline mode, DATEV export, BWA, letterhead setup, time tracking.

---

## 19. Public REST API

Source: `https://api.sevdesk.de/openapi.yaml` (OpenAPI 3.0, v2.0.0).

- **Basics:**
  - Base URL `https://my.sevdesk.de/api/v1/`.
  - Token authentication.
  - `embed=` to inline nested objects.
  - References as `{id, objectName}`.
  - `mapAll`; dates as timestamp or dd.mm.yyyy.
  - Version check via `GET /Tools/bookkeepingSystemVersion`.

| Area | Endpoints / model highlights |
|---|---|
| **Contact** | CRUD; `getNextCustomerNumber`; `checkCustomerNumberAvailability`; `findContactsByCustomFieldValue`; `getTabsItemCount`. Filters: depth (include persons), category, city, tags, customerNumber, parent, name, zip, country, created/updated before/after. |
| **ContactAddress, CommunicationWay (+ CommunicationWayKey), AccountingContact** | CRUD (fields in section 8) |
| **ContactCustomField / ContactCustomFieldSetting** | CRUD, reference count; Textparser placeholders |
| **Part** | CRUD (no DELETE published), `getStock` |
| **Invoice / InvoicePos** | `Factory/saveInvoice` (invoice + invoicePosSave/Delete + discountSave/Delete + attachment filename), `createInvoiceFromOrder`, `createInvoiceReminder`, `cancelInvoice`, `render`, `getPdf`, `getXml`, `sendViaEmail` (toEmail, subject, text, copy, cc, bcc, additionalAttachments, sendXml), `sendBy`, `enshrine`, `bookAmount`, `resetToOpen`/`resetToDraft`, `getIsPartiallyPaid`, `getPositions` |
| **Order / OrderPos** | `Factory/saveOrder`, CRUD, `getPositions`, `getDiscounts`, `getRelatedObjects`, `sendViaEmail`, `createPackingListFromOrder`, `createContractNoteFromOrder`, `getPdf`, `sendBy` |
| **CreditNote / CreditNotePos** | `saveCreditNote`, `createFromInvoice`, `createFromVoucher` (v1 only), `sendViaEmail`, `sendByWithRender`, `getPdf`, `bookAmount`, `enshrine`, resets |
| **Voucher / VoucherPos** | `saveVoucher`, `uploadTempFile`, CRUD, `bookAmount`, `enshrine`, resets; ReceiptGuidance ×5. Voucher filters include fulltextSearch, creditDebit, hasDocument, delinquent, amount range, cost centre, tags. |
| **CheckAccount** | List; create file-import account (CSV/MT940) or clearing account; update, delete; `getBalanceAtDate` |
| **CheckAccountTransaction** | CRUD, `enshrine` |
| **PrivateTransactionRule** | List, create, delete |
| **Layout** | `getLetterpapersWithThumb`, `getTemplatesWithThumb`, `changeParameter` (key: template, letterpaper, language or payPal) for invoice, order and credit note |
| **Tag / TagRelation** | Create, list, update, delete; filter documents with `tags[x][id]` |
| **Export** | `datevCSV`, DATEV CSV/XML ZIP jobs, progress and download hash, CSV/ZIP of invoices, credit notes, receipts, transactions, contacts; `updateExportConfig` |
| **Report** | invoicelist, orderlist, contactlist, voucherlist |

- **Referenced but not documented in the public spec:**
  - Category, StaticCountry, Unity, TaxRule, AccountDatev/AccountingType, CostCentre, PaymentMethod, SevUser, SevSequence, Document
  - TextTemplate: no public TextTemplate model was found. [?]
- **Your clone should mirror these resources.**

---

## 20. Integrations and marketplace

Source: https://sevdesk.de/integrationen/ (71 entries). There is no native-vs-partner label; partner costs are extra.

| Category | Integrations |
|---|---|
| Banking | Commerzbank, Deutsche Bank, Postbank, bunq, FINOM, FYRST, Holvi, Kontist, Qonto, Revolut Business (Premium Partner), Wise Business |
| E-commerce | Shopify, Billbee (+ Amazon/eBay/Etsy via Billbee), Etsy by Kassenklingeln, ePages, Germanized, German Market, Shopware by SHOPSY, STRATO, IONOS, Stripe by miraclesync, SumUp (Premium Partner), Faktur Pro, PayJoe |
| Finance | Agicap, Commitly, Tidely, SepaHeld, SEPApro, paywise, billwerk |
| Receipts / invoice management | GetMyInvoices, invoicefetcher, Spesenfuchs, Einfach Reisekosten |
| Tax | DATEV Rechnungsdatenservice 1.0, ADDISON OneClick, steuerberaten.de |
| CRM | HubSpot, Pipedrive, Salesforce (Cloudwharf), Leveto, Rapidmail |
| Time / projects | clockin, Clockodo, mite, Tyme, Papershift, timeBuzzer, awork, Adam, kontool, Daylite |
| Trades | craftboxx, Das Programm, Meisterwerk, openHandwerk, Simple-Simon |
| Other | Make, eTermin, Placetel, Malt, project b. (payroll service), exali / Finanzchef24 (insurance) |

- **Not available:** an official Zapier app [3rd], native WooCommerce (plugin only), Candis, Moss, Personio, Lexware.
- **Migration:**
  - SyncFast (free) imports from Lexware Office and Papierkram via API keys.
  - Manual guides exist for Lexware Office and Accountable; CSV import for contacts and products.

---

## 21. Payroll

- **Not native:** "sevdesk ist kein Lohnbuchhaltungstool". Wages are booked manually (net method: net pay 4120/6020, employer social security 4130/6110; HC/12425656). Minijob guides exist.
- **Partner:** project b. (listed under Lohnservice). There is no sevdesk payroll product.

---

## 22. Gaps and suggestions for your clone
- **Confirmed absent in sevdesk:**
  - Balance sheet / E-Bilanz, opening balances, manual journal entries
  - ELSTER filing of the EÜR, ZM, OSS, annual VAT return
  - Asset register report, pool depreciation, automatic asset disposal
  - User-defined bank or booking rules (only private-transaction rules exist)
  - Automatic dunning runs and interest calculation; reminder fees
  - Native online payment
  - Multi-company switching
  - Projects module, timer, mileage log, travel expenses, payroll
  - Content-based duplicate-receipt detection, MT940/CAMT import in the UI
  - A Verfahrensdokumentation template
- **Easy wins a clone could add:** ZM/OSS reports, a GiroCode plus payment link, configurable dunning fees and interest, matching rules, an asset register (Anlagenspiegel), and a VIES VAT-ID check.

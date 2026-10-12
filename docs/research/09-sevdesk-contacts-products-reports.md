# sevdesk feature research (as of October 2026)

**How to read this:** "HC" means the official help center (hilfe.sevdesk.de, hosted on intercom.help). "API" means the official OpenAPI spec at https://api.sevdesk.de/openapi.yaml. Anything I could not confirm is marked **[UNSURE]**. Third-party sources are marked **[3rd]**.

Context that applies throughout:
- **Plans and prices** (https://sevdesk.de/preise/): Kostenlos, Rechnung, Buchhaltung, Buchhaltung Pro. List prices are 11,90 / 25,90 / 34,90 € per month on monthly billing. During a "Black Cyber Deal" promo they showed as 4,45 / 9,95 / 13,95 €. There is a 14-day trial with all functions.
- **Help center size:** 14 collections and 264 articles (https://hilfe.sevdesk.de/de/).
- **Two UI versions:** Many HC articles exist as "(v1)" and current versions. The version is shown under the user menu at the bottom left.

---

## 1. Mahnwesen (dunning)

**Plan split**
- **Kostenlos:** no dunning at all.
- **Rechnung:** "rechtskonforme Zahlungserinnerung" only.
- **Buchhaltung and Pro:** add "Mahnstufen (internes Mahnwesen)". Sources: https://sevdesk.de/preise/ and https://sevdesk.de/funktionen/ (the second shows a dash for Rechnung in the Mahnstufen row).
- The HC says sending reminders, and further Mahnungen, needs "Tarif Buchhaltung oder höher" (https://hilfe.sevdesk.de/de/articles/9071059, updated 9 Feb 2026). This conflicts with the price page, which lists the Zahlungserinnerung under Rechnung. **[UNSURE]**
- The old URL `sevdesk.de/addons-mahnstufen` now serves the /mahnungen/ page. Experte.de **[3rd]** still describes a paid "Mahnungsstufen" add-on. That is probably outdated: Mahnstufen look folded into the Buchhaltung plan.

**Number of levels**
- The Zahlungserinnerung counts as the first level ("erste Mahnung, ohne Mahngebühr").
- After that: "Es gibt keine Beschränkung der Mahnstufen. Sie können beliebig fortgeführt werden" (https://hilfe.sevdesk.de/de/articles/9167192-mahnungen).
- There is no fixed 1./2./3. Mahnung model.

**Workflow** (HC 9071059 and 9167192)
1. Go to Rechnungen and filter on the "Fällig" tab.
2. Choose "Mahnung / Zahlungserinnerung" from the invoice or its three-dot menu.
3. A form opens with pre-filled, editable header and footer text (Kopf-/Fußtext).
4. Send via "Versenden / Drucken / Herunterladen", or download as PDF.
5. For the next level, use "Nächste Mahnung erstellen" from the list. All Mahnungen are listed under Rechnungen → Mahnungen.
- Marking any linked Mahnung or the invoice "Als bezahlt markieren" (with account and date, then "Buchen") sets all linked documents to "Bezahlt".
- A reminder contains the invoice number and date, a new payment deadline, the reminder date and the Mahnstufe (https://sevdesk.de/funktion-zahlungserinnerung/).

**Settings**
- Path: Einstellungen → System → tab "Aufträge & Rechnungen" → section "Mahnung".
- Field "Mahnfrist": the deadline printed as payment-term text on reminders.
- Per the HC, Mahnstufen can be configured here on the Buchhaltung plan, but no details are given (https://hilfe.sevdesk.de/de/articles/9382242).

**Fees and interest (Mahngebühren, Verzugszinsen)**
- No help article describes configuring either.
- The API Invoice model has read-only fields:
  - `dunningLevel`: "Starts with 1 (Payment reminder) and should be incremented by one every time another reminder is sent"
  - `reminderTotal`, `reminderDebit`, `reminderDeadline`, `reminderCharge` ("The additional reminder charge")
- Endpoint `POST /Invoice/Factory/createInvoiceReminder`. Invoice type `MA - Mahnung` is a document type in exports.
- So an extra reminder charge exists in the data model. Automatic interest calculation is not documented. **[UNSURE]**
- sevdesk's guide pages give the legal background only: Verzugszinsen are base rate +5 pp for consumers and +9 pp for B2B (§288 BGB), plus a 40 € B2B lump sum; courts accept roughly 2–3 € (up to 5 €) in Mahngebühren (https://sevdesk.de/ratgeber/buchhaltung-finanzen/mahnwesen/mahngebuehren-berechnen/).

**Automation**
- Marketing headline: "Mahnungen automatisch abgleichen und versenden". The body text only describes one-click creation plus the bank feed detecting paid invoices (https://sevdesk.de/mahnungen/).
- The HC says Mahnungen are created manually. No scheduled or automatic dunning run is documented.

**Inkasso (debt collection)**
- No native handover button.
- **paywise** is a marketplace integration (categories Produktivität, Finanzen). It imports contacts and invoices, syncs transactions to update case status, and claims "100% der Forderungssumme" paid out on success. New customers get 4 months of sevdesk free (https://sevdesk.de/integrationen/paywise/).
- **Debtist** lists sevdesk as a source system **[3rd]** (https://debtist.de/en/integrations).

## 2. Kontakte / CRM

**Types**
- Person or Organisation. A person can belong to an organisation.
- In the API, a contact counts as an organisation if `name` is set, and as a person if `surename`/`familyname` is set.

**Categories**
- Defaults: Kunde, Lieferant, Partner, Interessent. Custom ones under Einstellungen → System → Kategorien, with Kategorieart "Kontakt" (https://hilfe.sevdesk.de/de/articles/9310378-kontakte-anlegen).
- API category IDs: Supplier 2, Customer 3, Partner 4, Prospect 28.

**Fields** (API Model_Contact)
- Identity: `customerNumber`, `name`/`name2`, `surename`, `familyname`, `titel` (position in the organisation), `academicTitle`, `gender`, `birthday`, `description`, `parent`
- Status: `status` (100 Lead, 500 Pending, 1000 Active)
- Tax: `vatNumber`, `taxNumber`, `taxOffice` (Greece only), `exemptVat`
- Bank: `bankAccount` (IBAN), `bankNumber`
- Payment terms: `defaultTimeToPay` (Zahlungsziel), `defaultCashbackTime`/`defaultCashbackPercent` (Skonto), `defaultDiscountAmount` plus a percentage flag
- E-invoicing: `buyerReference` (Leitweg-ID / Käuferreferenz), `governmentAgency` (Behörde)
- Experte.de **[3rd]** confirms a Leitweg-ID field on contacts.

**Debitoren-/Kreditorennummer**
- Ranges: Debitoren 10000–69999, Kreditoren 70000–99999.
- Field "Kreditoren/Debitoren-Nr." on the contact. If empty, it is assigned automatically (DATEV logic) on export or after an invoice or voucher is created.
- Managed under Einstellungen → Buchhaltung → tab "Kreditoren-/Debitoren Nr." (https://hilfe.sevdesk.de/de/articles/9382153).
- Customers and suppliers share a single "Kontakte" number range (https://hilfe.sevdesk.de/de/articles/9382101-nummernkreise).

**Addresses**
- Separate ContactAddress objects, unlimited per contact, each with a category (fetched via `/Category?objectType=ContactAddress`).
- On invoices, a "Adresse wählen" button picks among them.
- The exact category labels (e.g., Rechnungsadresse, Lieferadresse) are **[UNSURE]**.

**Communication**
- Types: EMAIL, PHONE, WEB, MOBILE.
- Keys: Privat 1, Arbeit 2, Fax 3, Mobil 4, " " 5, Autobox 6, Newsletter 7, Rechnungsadresse 8.
- A `main` flag marks the primary entry (API).

**Custom fields (Kontaktfelder)**
- Created under Einstellungen → System → tab "Kontaktfelder" with name and description only. No field types are documented.
- Values are set on the contact under "Eigene Felder". They can be used as placeholders in documents and text templates (https://intercom.help/sevdesk/de/articles/9382263).

**Tags**
- Apply to contacts, Belege and invoices (and offers). Minimum 3 characters, entered in the detail-view info bar, filterable.
- An organisation's tags are inherited by its persons (https://hilfe.sevdesk.de/de/articles/9413318).

**Kontaktverlauf (history)**
- The default view when opening a contact. It lists all linked Vorgänge.
- Notes can be added with any file attached. Ticking a colleague's checkbox emails them (https://hilfe.sevdesk.de/de/articles/9064577).

**Other contact features**
- **Documents:** under user menu → Dokumente, a "Kunden" folder auto-creates a subfolder per contact for invoices and offers. There is no file preview (https://hilfe.sevdesk.de/de/articles/13831806).
- **Customer-specific and supplier prices:** "Kundenpreis/Lieferantenpreis hinzufügen" under Optionen, only with the Inventar add-on (https://hilfe.sevdesk.de/de/articles/9064585).
- **Duplicates:** "Kontakte zusammenführen" picks a Gewinner and a Verlierer. Only same-type contacts can be merged, and it is irreversible (https://hilfe.sevdesk.de/de/articles/9064572).
- **Deleting:** only possible if no documents are linked.
- **Sammeldebitoren/-kreditoren** exist (HC article 9064613).

**Import and export**
- CSV import under Einstellungen → System → "Kontakte importieren", with a downloadable template, separator detection (; or ,), UTF-8 advice and a preview with conflict flags (https://intercom.help/sevdesk/de/articles/9382275).
- No contact export is documented. **[UNSURE]**

**Not found:** VIES / USt-IdNr validation.

## 3. Produkte / Artikel and the Inventar add-on

**Product form** (https://intercom.help/sevdesk/de/articles/9374848-produkte-anlegen, March 2026)
1. Produktname
2. Standardeinheit
3. Art.-Nr. (auto-assigned from the Artikel number range)
4. Umsatzsteuer in %
5. Kategorie: "Standard" or "Dienstleistungen", or custom
6. VK netto
7. EK netto
8. VK brutto
9. EK brutto (netto and brutto calculate each other automatically)
10. Produktbeschreibung (printed on documents)
11. Interne Bemerkung (not printed)

- **Tab "Weitere Einheiten":** extra units with a conversion factor and an auto-calculated price.
- **Tab "Weitere Einstellungen":** "Bestand aktiviert" and "Meldebestand" (reorder level). These require the Inventar add-on "bzw. Tarif Buchhaltung Pro".
- **API Part model:** `partNumber`, `name`, `text`, `category`, `stock`, `stockEnabled`, `unity`, `price`, `priceNet`, `priceGross`, `pricePurchase`, `taxRate`, `status` (50 inactive / 100 active), `internalComment`. Endpoint `/Part/{id}/getStock`.
- Custom units under Einstellungen → System. CSV product import exists.

**Inventar add-on** (19,90 € per month, 30-day trial; https://sevdesk.de/addons-inventar/)
- Adds a main-menu item "Inventar".
- Stock tracking per item, with a Meldebestand email at a chosen interval.
- **Automatic stock decrease only via Lieferschein:** either "Lieferschein erzeugen" from an invoice (linked) or created under Aufträge → Lieferscheine (unlinked).
- Manual "Bestand bearbeiten" → Zugang/Abgang plus quantity.
- A "Buchungsverlauf" tab shows the history (https://intercom.help/sevdesk/de/articles/9373930).
- Also enables Kundenpreise/Lieferantenpreise.
- Lieferscheine themselves are a Buchhaltung-plan feature (price page).

**Not found:** variants, or price lists beyond the per-contact prices.

## 4. Zeiterfassung add-on

- **Price and availability:** 4,90 € per month, 30-day trial. Web only: "kann nicht mobil genutzt werden" (https://sevdesk.de/zeiterfassung/).
- **Path:** user menu (bottom left) → Zeiterfassung → "Zeit erfassen".
- **Fields:**
  - Kunde, Projekt (optional), Mitarbeiter
  - Dauer: start–end time or hh:mm
  - Datum (defaults to today)
  - Aufgabe/Service: saved services carry their own hourly rate
  - Stundensatz (for manually entered services), USt %, Beschreibung (printed on the invoice)
- **Billing:** in the invoice's Produkte section, "+ Zeiterfassung auswählen" → "Übernehmen".
- **Overview:** per customer, with tabs for open and billed entries, plus hour and amount totals (https://hilfe.sevdesk.de/de/articles/9374051-zeiterfassung).
- **No timer documented.**
- **Alternatives** via integrations: Clockodo, clockin, mite, Tyme, Papershift, timeBuzzer.

## 5. Aufgaben, Projekte, Notizen

**Aufgaben (tasks)**
- Created from user menu → Aufgaben, or from a contact via Optionen → "Aufgabe erstellen".
- **Fields:**
  - Beschreibung
  - Fälligkeit
  - Zu erledigen von (assigned user)
  - Art der Aufgabe: Anruf / Termin / Sonstiges
  - Referenz (Beleg, Kontakt or Rechnung)
  - Toggle "Benachrichtigung bei Erledigung" (notifies the creator)
- Status is open or done. Tasks show in an "Erstellte Aufgaben" tab, a to-do list on the dashboard, and email reminders (https://hilfe.sevdesk.de/de/articles/13831806, https://sevdesk.de/zusammenarbeit/).

**Projekte:** I found no standalone project module. "Projekt" exists only as a grouping field on time entries. Project management is left to integrations (awork, kontool, Adam, Daylite, and others). **[UNSURE]** whether project records can be managed separately.

**Notizen:** exist only as entries in the Kontaktverlauf. Products also have "Interne Bemerkung".

## 6. Benutzer und Rechte

**Users and pricing**
- Every plan includes 1 admin user.
- Add-on "Weiterer Benutzer": 5,90 € per month per user. Users 3–10 get 10% off (5,31 €), beyond 10 get 25% off (4,43 €) (https://intercom.help/sevdesk/de/articles/9374033).
- Booked under Erweiterungen → Add-ons. Users are managed under Einstellungen → Benutzer → "Benutzer anlegen".
- Cancellation needs 14 days' notice and takes effect at the end of the plan term.

**Roles**
- Administrator (all rights) or Benutzer (individual rights).
- The marketing page also lists "Betriebsführer", with no details (https://sevdesk.de/addons-benutzer/).
- Rights are toggles grouped by navigation item. Unticking one hides that menu item (https://intercom.help/sevdesk/de/articles/9382074).
- There is an activity history for all users (https://sevdesk.de/zusammenarbeit/).

**Betriebsprüfer (tax auditor)**
- Set up as a Benutzer with limited rights.
- Support refunds the cost when the access is removed.

**Steuerberater (tax advisor)**
- Free, separate access via the Steuerberaterportal.
- Invite via Erweiterungen → Integrationen → "Steuerberater einladen", or Steuern → Mein Steuerberater → "Verknüpfung einrichten".
- Real-time access to booking data. The advisor can download DATEV exports and correct bookings (https://hilfe.sevdesk.de/de/articles/9374574).
- Available from the Rechnung plan, together with the DATEV/ADDISON interface.

**Multiple companies**
- "sevDesk ist nicht mandantenfähig". Each tax number needs its own account. Companies sharing a tax number can use Kostenstellen instead.
- Discounts for extra accounts: accounts 2–5 get 10%, accounts 6–10 get 20% (https://hilfe.sevdesk.de/de/articles/9373992).
- No in-app company switcher is documented.

**Security**
- The security page urges users to "Multi-Faktor-Authentifizierung aktivieren". The method is not specified; third-party guides suggest an authenticator app **[3rd]**.
- Hosted on AWS, with Cloudflare and AWS WAF; servers in Germany (https://sevdesk.de/sicherheit/).
- SSO: no mention found.
- The mobile app supports Face ID.

**API token:** one per administrator, a 32-character hexadecimal string. REST API on the Buchhaltung Pro plan.

## 7. Mobile apps

- **iOS:** "sevdesk Buchhaltung & Rechnung", id731738076.
  - 4.39★ from 7,957 ratings; version 9.8.0 from 5 Oct 2026; requires iOS 15.6 or later.
  - Latest release notes: Dark Mode, date picker change, final-invoice bug fix (iTunes lookup API).
- **Android:** package `de.sevdesk.sevdeskgo`.
  - 4.7★ from about 3,000 reviews; 100,000+ downloads; updated 06.10.2026 (Play Store page).
  - sevdesk itself advertises 4.4★ on both stores (https://sevdesk.de/apps/).
- **Features:**
  - Invoices including XRechnung/ZUGFeRD; offers converted to invoices
  - Auftragsbestätigungen and Lieferscheine
  - AI receipt scanning
  - Banking: 4,000+ banks, payment matching, transfers, mark invoices as paid
  - Dashboard: income, expenses, open invoices
  - Contacts, real-time sync, Face ID
- **App sections** (HC collection 9417204): Kontakte, Angebote, Aufträge, Lieferscheine, Rechnungen, Ausgaben, Banking, and "Mehr" (settings, support).
- **Limits:**
  - No offline mode
  - No DATEV export or BWA in the app
  - Briefpapier must be set up on the web
  - Zeiterfassung not available in the app

## 8. Integrations, Sevi, settings, navigation, onboarding, migration

**Marketplace** (https://sevdesk.de/integrationen/)
- 71 listed. Filter categories: Banking, CRM, E-Commerce, Finanzen, Handwerk, HR-Plattform, Lohnservice, Produktivität, Projektverwaltung, Rechnungsmanagement, sevApps, Steuern, Versicherung, Zeiterfassung.
- No native/partner label. Only Revolut Business and SumUp carry a "Premium Partner" badge.
- Partner costs are extra.

| Category | Integrations |
|---|---|
| Banking | Commerzbank, Deutsche Bank, Postbank, bunq, FINOM, FYRST, Holvi, Kontist, Qonto, Revolut Business, Wise Business |
| E-Commerce | Shopify, Billbee, Amazon/eBay/Etsy by Billbee, Etsy by Kassenklingeln, ePages, Germanized, German Market, Shopware by SHOPSY, STRATO, IONOS, stripe by miraclesync, SumUp, Faktur Pro |
| Finance / receivables | Agicap, Commitly, Tidely, SepaHeld, SEPApro, Paywise, billwerk |
| Invoice management | GetMyInvoices, invoicefetcher, Spesenfuchs, Einfach Reisekosten |
| Tax | DATEV Rechnungsdatenservice 1.0, ADDISON OneClick, steuerberaten.de |
| CRM | HubSpot, Pipedrive, Salesforce by Cloudwharf, Leveto, Rapidmail |
| Time tracking / projects | clockin, Clockodo, mite, Tyme, Papershift, awork, Adam, kontool, Daylite (timeBuzzer has an HC article) |
| Trades (Handwerk) | craftboxx, Das Programm, Meisterwerk, openHandwerk, Simple-Simon |
| Other | Make, eTermin, Ajonta, Kreativ.Management, Kutego, Malt, Placetel, pododesk, project b. (payroll/HR), exali and Finanzchef24 (insurance), sevdesk API (sevApps) |

**Named integrations not in the list**
- PayPal: only a payment link inserted into invoices (HC 9374449).
- Zapier: Zapier says sevdesk has not built an official integration **[3rd]** (https://zapier.com/apps/sevdesk/integrations).
- WooCommerce: only via a third-party plugin **[3rd]**.
- Penta: the /integrationen/penta/ URL redirects to the Qonto page.
- Candis, Moss, Personio: no integration page (404).
- Pliant, Fintecture, Lexware: none found.

**Sevi**
- A 24/7 AI support agent "direkt in sevdesk". It searches the help and knowledge base and answers in chat (https://sevdesk.de/funktionen/, ratgeber/ki-buchhaltung).
- Plan availability is inconsistent: the features page suggests all paid plans, while an older snippet ties it to Pro. **[UNSURE]**

**Own SMTP**
- Set per user under Profil → Benutzerdaten → E-Mail-Einstellungen → SMTP, or by an admin under Einstellungen → Benutzer.
- Fields: Absendername, SMTP-Benutzer, Server, Port (465/587/25/2525), Absender-E-Mail, Passwort, Verschlüsselung SSL/TLS.
- Microsoft 365 connects via OAuth, and only one method can be active per user (https://hilfe.sevdesk.de/de/articles/9382075).

**Settings structure** (HC collection 9417203)
- **Unternehmen:** tabs Allgemein / Buchhaltung & Steuern / Bankverbindung / Logo.
- **Buchhaltung:** Nummernkreise, Buchungskonten, Zahlungsmethoden, Zahlungskonten, automatic transaction matching, Umsatzsteuerregelungen, Kostenstellen, Kreditoren-/Debitoren-Nr.
- **System:** Kategorien, Einheiten, Aufträge & Rechnungen, Kontaktfelder, contact and product import, Anhänge, Festschreibung, account reset/delete.
- **Benutzer:** rights, SMTP, language, password.
- **Briefpapier / Layout:** print options, QR code.
- **Textvorlagen / Signatur.**

**Main navigation** (compiled from HC menu paths; the exact current labels and order are **[UNSURE]**)
- Übersicht/Dashboard, Kontakte, Aufträge (Angebote, Auftragsbestätigungen, Lieferscheine), Rechnungen (incl. Mahnungen), Belege, Bank/Zahlungen, Kasse, Steuern (incl. Mein Steuerberater), Auswertungen (BWA, SuSa Beta), Produkte / Inventar, Erweiterungen (Add-ons, Integrationen), Einstellungen.
- The user menu at the bottom left holds Zeiterfassung, Dokumente, Aufgaben, Benutzerdaten, and the account's Kundennummer and version.
- Experte.de **[3rd]** lists: Dashboard, Kontakte, Aufträge, Rechnungen, Belege, Zahlungen, Dokumente, Auswertungen, Exporte, Aufgaben, Inventar.

**Onboarding**
- "Grundeinstellungen zum Start" covers: company data; tax setup (USt-IdNr/Steuernummer, Kleinunternehmer, EÜR/GuV, Ist/Soll, SKR03/SKR04/SKR07 for Austria); bank details; logo (https://hilfe.sevdesk.de/de/articles/10248335).
- Paid services: Einrichtungstermin (45 min, 49 €), Expertentermin (24,90 € per 15 min), plus a free beginner webinar.

**Migration**
- **SyncFast** (free; sevdesk pays). It requires matching SKR and Soll/Ist settings and works via two API keys.
  - From Lexware Office: contacts, products, invoices, Belege, Gutschriften, offers, orders and delivery notes (as drafts), e-invoices, attachments, payments.
  - From Papierkram: a subset of the same data (https://hilfe.sevdesk.de/de/articles/13428759).
- Manual step-by-step guides exist for Lexware Office and Accountable, and CSV import for contacts and products (HC collection 16310178).

# sevdesk: bookkeeping, receipts and banking features (as of Oct 2026)

Most of this comes from the sevdesk help center. Its links appear as both hilfe.sevdesk.de and intercom.help/sevdesk and point to the same articles. Many articles exist in two versions, v1 and v2, because sevdesk runs two software versions ("Softwareversion 1" and "Softwareversion 2"). Facts below are from v2 articles unless marked v1. **[U]** = uncertain or not confirmed by a primary source.

---

## 0. Plans and which features they include
Source: https://sevdesk.de/preise/ and https://sevdesk.de/buchhaltungssoftware/

- **Plans:** Kostenlos (free), Rechnung, Buchhaltung, Buchhaltung Pro. List prices are 12,90 / 25,90 / 34,90 € per month net. Discounted prices of 6,45 / 12,95 / 17,45 € apply to 24-month terms. The pricing page also shows other figures (4,45 / 9,95 / 13,95 €) **[U]**.
- **Free:** 3 invoices or e-invoices per month (ZUGFeRD and XRechnung), unlimited contacts and products.
- **Rechnung:** invoicing only, plus DATEV/ADDISON export and tax advisor access. It has **no** receipt capture, banking or bookkeeping.
- **Buchhaltung adds:**
  - Single- and double-entry bookkeeping
  - AI receipt capture ("KI-gestützte Belegerfassung")
  - Receipts by email, the missing-receipts overview, foreign-currency receipts, recurring receipts
  - Receiving e-invoices ("Empfangene E-Rechnungen erfassen")
  - Online banking (4,000+ banks)
  - Cash book (Kassenbuch)
  - Asset accounting and depreciation (Anlagenbuchhaltung/Abschreibungen)
  - VAT return (UStVA) sent to ELSTER, EÜR and GuV
  - Trial balance (Summen- und Saldenliste), still in beta
  - Recurring invoices and dunning levels
- **Buchhaltung Pro adds:** cost centers (Kostenstellen), the business report (BWA), REST API, and analytics. The help article on cost centers confirms they are Pro-only: https://hilfe.sevdesk.de/de/articles/9310500-kostenstellen-anlegen
- **All plans:** 1 user included. Extra users are 5,90 € per month. The inventory add-on is 19,90 € per month.
- **Receipt limits:** no limit on receipt count is stated for any plan **[U]**.

## 1. Receipt capture (Belegerfassung)
Sources: https://hilfe.sevdesk.de/de/articles/9453113-belege-erfassen (v2, updated 22 May 2026), https://sevdesk.de/belege-erfassen/

**Ways to get receipts in**
1. **Editor form:** Belege → "Ausgabe erfassen" for expenses. For income, use the arrow next to it → "Einnahme erfassen".
2. **Drag and drop** of files or whole folders onto the receipt overview. Drop on the left for expenses, on the right for income. The result is saved as a draft.
3. **Mobile app (iOS/Android):** photo or upload. Dropbox and Google Drive uploads are possible on mobile only, according to the marketing page.
4. **Email ("Autobox"):** forward to the fixed address **autobox@sevdesk.email**.
   - It only works from the email address registered with sevdesk (found under Einstellungen > Benutzer).
   - Attachments become drafts.
   - Auto-forwarding rules in your mail client (e.g. Outlook) are suggested.
5. **Integrations:** GetMyInvoices (pulls invoices from portals and mailboxes), invoicefetcher, Einfach Reisekosten, Spesenfuchs, SumUp, Faktur Pro. Source: https://sevdesk.de/integrationen/

**Formats:** PDF (single or multi-page), PNG, JPG. XML is also accepted for e-invoices. No file size limit is documented.

**AI recognition (OCR)**
- Help center: fills date, amount, receipt number, supplier and category, and "improves with each upload".
- Marketing pages add the VAT amount and invoice number.
- For the booking category, sevdesk makes an AI suggestion and learns from your past assignments. You review and confirm it; it is not applied silently.

**Editor fields (documented in v2)**
- File upload
- Links (Verknüpfungen) to contacts, i.e. the supplier or customer
- **Kategorie:** this is the booking account. There is a dropdown, an "Erweiterte Suche" (advanced search) and a decision-tree helper. "+ Eigenes Buchungskonto erstellen" adds an account from about 1,500 SKR accounts.
- **Belegnummer:** free text, so no number range applies.
- **Besteuerungsart (Brutto/Netto):** set per receipt, not per line.
- **Umsatzsteuerregelung (VAT rule):** "Ausgewiesene Umsatzsteuer", "Kein Vorsteuerabzug", or "Reverse Charge" with origin Deutschland / EU-Ausland / Außerhalb EU.
- **Fremdwährung:** currency plus conversion at a reference date or a fixed rate. The original amount is shown in grey.
- **Belegdatum** and **Lieferdatum / Leistungszeitraum** (service period) appear in the Skonto and depreciation articles: https://hilfe.sevdesk.de/de/articles/14804835-gewahrtes-und-erhaltenes-skonto
- **Kostenstelle:** one per document, Pro only.
- **Line items with separate accounts and VAT rates:** the per-diem article mentions splitting a receipt into positions with 7% and 19% (https://hilfe.sevdesk.de/de/articles/9874631-verpflegungsmehraufwand). However, the help also says an expense account and 1800/2100 cannot be combined on one receipt **[U: exact line-item UI]**.
- **Not documented:** due date (Fälligkeit), tags **[U]**.
- **Custom VAT rules:** can be created under Einstellungen > Buchhaltung > Umsatzsteuerregelungen, each set for income or expenses. Source: https://hilfe.sevdesk.de/de/articles/9382135-umsatzsteuerregelungen-v1

**Statuses**
- **Entwurf (draft):** a blue dot marks receipts not yet reviewed.
- **Offen (open)**
- **Vorgemerkt:** set after a transfer is initiated.
- **Teilbezahlt (partially paid)**
- **Bezahlt (paid)**
- Assets that are written off immediately go straight to **"Abgeschlossen"**.
- Paid receipts can be reset with "Als offen markieren" → "Zurücksetzen" and then edited. Locked (festgeschrieben) receipts cannot be reset.
- Sources: https://hilfe.sevdesk.de/de/articles/9167324-belege-bearbeiten, https://hilfe.sevdesk.de/de/articles/9360905-teilzahlungen-und-sammelbuchungen

**Batch processing**
- Select drafts → "Bearbeiten" opens a queue, and "Fertigstellen und weiter" moves to the next one.
- Bulk delete of drafts.
- "Sammelbuchung": several receipts against one payment account.
- Filters include period and supplier.
- Source: https://hilfe.sevdesk.de/de/articles/9172852-belege-im-stapel-bearbeiten

**Other receipt features**
- **Missing receipts overview ("Übersicht über fehlende Belege"):** shows missing receipts and receipts without a linked payment, and suggests matching payments. Also in the app. The bank side has a "Zahlungen ohne Beleg ansehen" view. Source: https://sevdesk.de/funktions-uebersicht
- **Duplicates:** the only documented check is a warning that the receipt image is already used, which can be dismissed. Source: https://hilfe.sevdesk.de/de/articles/9881023-privatentnahmen. Content-based duplicate-invoice detection is **not documented [U]**.
- **Recurring receipts:**
  - Same form as a normal receipt, plus "Intervall" (examples: monthly, quarterly, every 3 months, half-yearly, yearly), "Erster Beleg" (start date), and "Letzter Beleg" (end date, or "unbefristet").
  - A new **open** receipt is generated each period.
  - Templates can be switched with "Aktivieren" / "Deaktivieren", and the detail view shows the last 3 generated receipts.
  - Source: https://hilfe.sevdesk.de/de/articles/9172976-wiederkehrende-belege
- **Hospitality receipts (Bewirtung):**
  - Use account Bewirtungskosten and pick the occasion "Geschäftspartner" (business partners) or "Mitarbeiter" (employees).
  - For business partners, food and tip are split automatically 70/30 (deductible/non-deductible), with 100% input VAT (UStVA field 66). For employees, 100% is deductible.
  - No field for participants is documented.
  - Source: https://hilfe.sevdesk.de/de/articles/9965373-bewirtungsbelege
- **Per-diem meal allowance (Verpflegungsmehraufwand):** no dedicated module.
  - Book manually on account 4674/6674 with 0% VAT, paid via a "Privateinlage" clearing account.
  - Employee accounts are "Reisekosten AN …".
  - There is no travel-expense or mileage-log (Fahrtenbuch) module. Partners cover this (Einfach Reisekosten, Spesenfuchs).
- **Self-issued receipt (Eigenbeleg):** recorded as a normal receipt. A template is offered. Source: https://hilfe.sevdesk.de/de/articles/9172983-eigenbeleg
- **Pass-through items (Durchlaufende Posten):** accounts 1590/1370, and 1591/1371 for "not yet assignable". Uses the VAT setting "Nicht Steuerbar". Source: https://hilfe.sevdesk.de/de/articles/10532257-durchlaufende-posten

**Receiving e-invoices (E-Rechnung)**
- XRechnung (XML) and ZUGFeRD, uploaded via Beleg erfassen, drag and drop, email forwarding or the app.
- ZUGFeRD is shown as its PDF. For XML, sevdesk renders a readable view.
- Validation follows the **Mustang** validator requirements.
- The data is read from the XML, and sevdesk suggests how to book it. It is archived GoBD-compliant.
- Requires Buchhaltung or higher.
- An interface for integration partners is "planned".
- Sources: https://hilfe.sevdesk.de/de/articles/10079497-e-rechnung-empfangen, https://sevdesk.de/e-rechnung-software/

## 2. Chart of accounts and bookkeeping logic
- **Charts of accounts:** **SKR03 and SKR04 only** (SKR07 for Austria). Booking "categories" are SKR accounts.
  - Some accounts are only posted by special functions, not selectable on receipts: private (1800/2100 and 1890/2180), bank loans (630/3150), money in transit (Geldtransit, 1360/1460), and interest (2100/7300).
  - Accounts outside the list are unavailable.
  - Source: https://hilfe.sevdesk.de/de/articles/11325646-verfugbare-buchungskonten
- **Settings under Einstellungen > Unternehmen > Buchhaltung & Steuer:**
  - Profit method: **EÜR** or **GuV**. There is no balance sheet (Bilanz).
  - Ist- or Soll-Versteuerung (cash vs accrual VAT). Soll is the default.
  - Standard 19% or Kleinunternehmer (§19 UStG).
  - Choice of chart of accounts.
  - Switching from Kleinunternehmer to standard taxation **locks all earlier data**.
  - Source: https://intercom.help/sevdesk/de/articles/9382213-einstellung-zu-buchhaltung-steuer
- **Single vs double entry:**
  - EÜR uses payment dates. GuV uses the service date and treats VAT as neutral.
  - The DATEV export uses double-entry logic, so the **tax advisor prepares the balance sheet**. sevdesk does not produce one.
  - Source: https://hilfe.sevdesk.de/de/articles/9965272-einfache-und-doppelte-buchfuhrung
- **Manual journal entries (Buchungssätze):** no general manual journal entry is documented **[U]**. Workarounds go through clearing accounts (Verrechnungskonten) plus "Geldbewegung" (money movement).
  - Opening balances (Eröffnungsbilanz / Saldenvorträge) are **not supported**. The trial balance beta lists "Eröffnungsbilanzwerte" as a future feature and only shows v2 data from 2021 onward. Source: https://hilfe.sevdesk.de/de/articles/9700577-summen-und-saldenliste-beta-susa
  - The gross wage method is not supported because there are no liability-account evaluations.
- **Private withdrawals and deposits:**
  - On a bank transaction, Mehr → "als privat markieren" sets status "Privat" and posts automatically to 1800/2100 or 1890/2180 depending on the sign.
  - Withdrawals of goods go to 8910/4620 (19%) or 8915/4610 (7%) via the "Unentgeltliche Wertabgaben" clearing account (1880/2130).
  - Source: https://hilfe.sevdesk.de/de/articles/9881023-privatentnahmen
- **Money in transit (Geldtransit):** transaction → Mehr → **"Geldbewegung"**, choosing "Von Konto" and "Zu Konto", posts to 1360/1460. Both sides become "Gebucht". Also used for marketplace payouts (e.g. Shopify). Source: https://hilfe.sevdesk.de/de/articles/10473343-so-bildest-du-geldtransit-ab
- **Loans:** "Als Kreditaufnahme markieren" and "Als Kreditrückzahlung markieren". When you enter the principal, sevdesk calculates the interest automatically. Source: https://hilfe.sevdesk.de/de/articles/10570020-darlehen-tilgung-und-zinsen
- **UStVA:**
  - Filing frequency: monthly above 9,000 €, quarterly at 2,000–9,000 €, annual below 2,000 €.
  - Sent directly from sevdesk, with an optional test send ("Versand ans Finanzamt testen").
  - Afterwards, "Steuerbeleg fertigstellen" books the tax payment or refund.
  - Source: https://hilfe.sevdesk.de/de/articles/9310598-umsatzsteuervoranmeldung-ustva

## 3. Banking
- **Provider:** **finAPI**, a PSD2 provider certified by BaFin. 4,000+ banks.
  - Setup: Bank → "Zahlungskonto hinzufügen" → search for the bank → login, with "PIN speichern" ticked → TAN → select accounts.
  - "Weitere Konten abrufen" fetches extra accounts, e.g. credit cards.
  - The first account becomes the default.
  - Sources: https://hilfe.sevdesk.de/de/articles/9345270-onlinekonto-anlegen-mit-finapi, https://sevdesk.de/online-banking/
- **Sync:** once a day (every 24 hours), so new transactions can take 1–2 days, or 3–4 days if a transfer fails. "Manuell Synchronisieren" and "Transaktionen importieren" (a chosen period) are available. The first import start date must be at least 14 days in the past.
- **Payment account types:**
  - Onlinekonto (connected bank)
  - PayPal-Konto
  - Datenimport-Konto (CSV)
  - Verrechnungskonto (clearing account, formerly "Offlinekonto" / Basiskonto), mapped to a chosen booking account, each account usable once
  - Kasse (cash register)
  - Settings per account: Name, Bankname, IBAN (cannot be edited), Buchungskonto, "Transaktionen automatisch zuordnen", "Zahlungsdaten aktualisieren".
  - "Umstellen auf Import-Konto" cannot be undone.
  - Accounts can be archived and reordered.
  - Sources: https://hilfe.sevdesk.de/de/articles/9382114-zahlungskonten, https://hilfe.sevdesk.de/de/articles/9345140-verrechnungskonto-hinzufugen
- **CSV import:**
  - Options: "Überschriften in CSV" checkbox, column mapping via dropdown per column, signed amounts required.
  - The format is saved per account and cannot be changed afterwards.
  - **MT940 and CAMT are not mentioned [U]**.
  - CSV imports have **no duplicate check**. Duplicates are found manually via the "Verwendungszweck" (payment reference) filter and removed with Mehr → "Löschen" or "Als privat markieren".
  - Sources: https://hilfe.sevdesk.de/de/articles/9360767-datenimport-konto-hinzufugen, https://hilfe.sevdesk.de/de/articles/9360778-doppelte-transaktionen-im-zahlungskonto
- **PayPal:**
  - Connected by OAuth-style consent ("Zustimmen und verbinden"). Data is pulled "regularly".
  - Each fee arrives as its own transaction in category "Gebühren", with a "Gebühren anzeigen" toggle.
  - Fees are booked in bulk to 4970/6855.
  - Foreign currency uses the daily rate.
  - Source: https://hilfe.sevdesk.de/de/articles/9360816-anbindung-von-paypal-als-zahlungskonto
- **Credit cards:** connected via finAPI where supported, otherwise CSV.
  - The statement settlement on the current account is booked as Umbuchung or Geldtransit against the card account.
  - For EÜR, the date of the card transaction counts.
  - Source: https://hilfe.sevdesk.de/de/articles/9947700-kreditkarte-als-zahlungskonto
- **Automatic matching (automatische Transaktionszuordnung):**
  - Compares amount, date, payee name and payment reference.
  - The **priority of the criteria (Verwendungszweck / Betrag / Name)** can be set by drag and drop under Einstellungen > Buchhaltung > Transaktionszuordnung.
  - It runs after each sync or CSV import.
  - Results: "Automatisch zugeordnet" (very high match, linked automatically), "Vorschlag zur Prüfung" (suggestion to review), "Alles erledigt".
  - Under Bank > Zuordnungen you confirm (✓), reject (X) or use "Allem bestätigen".
  - Unlinking uses "Verknüpfung aufheben", which is not possible for locked documents.
  - A match score is shown.
  - Sources: https://hilfe.sevdesk.de/de/articles/9382118-automatische-transaktionszuordnung, https://www.sevdesk.de/blog/automatisierter-bankabgleich/
- **User-defined rules (Zuordnungs-/Buchungsregeln):** **no rule engine is documented** in the help center or on product pages **[U, likely absent]**.
- **Transaction statuses:** offen, Gebucht, Zugeordnet (assigned, with a remaining open amount), Privat.
- **Splits and partial payments:**
  - One document paid by many transactions: use the difference reason "Teilzahlung". The document becomes Teilbezahlt until fully paid.
  - One transaction covering many documents: "Transaktion zuordnen" with multiple documents, or the reason "Teil einer Sammelbuchung".
- **Difference reasons (Differenzgründe):**
  - Kosten des Zahlungsverkehrs (bank fees): auto-posted to 4970/6855 at 0%.
  - Mahngebühren (dunning fees): 4970/6855.
  - Teil einer Sammelbuchung
  - Teilzahlung
  - Skonto: auto-posted to the matching Skonto account by VAT rate, e.g. 8736/4736 for discounts given and 3736/5736 for discounts received.
  - Sonstige (other)
  - Sources: https://hilfe.sevdesk.de/de/articles/14086069-differenzgrunde, https://hilfe.sevdesk.de/de/articles/14804835-gewahrtes-und-erhaltenes-skonto
- **Payments out of sevdesk:**
  - Bank transfers via finAPI from online accounts. "Sammelüberweisung" covers several receipts for the **same payee**.
  - Fields: execution date (Ausführungsdatum), IBAN, payment reference listing receipt numbers.
  - Authorised with a TAN on the finAPI page. Very small amounts need no TAN.
  - Status flow: vorgemerkt → bezahlt after the next sync.
  - Restricted character set.
  - QR codes (GiroCode) are not documented **[U]**.
  - Source: https://hilfe.sevdesk.de/de/articles/9173029-sammeluberweisungen-durchfuhren
- **Balance:** not documented in the help center **[U]**.

## 4. Cash book (Kassenbuch)
Source: https://hilfe.sevdesk.de/de/articles/9360787-kassenbuch

- **Opening:** Bank → Kassenbuch → "Kasse eröffnen", enter opening balance and date. The opening balance cannot be edited later.
- **Entries:**
  - "Ausgabe erfassen" opens the normal receipt form and posts directly to the cash book.
  - "Rechnung erstellen": invoices under 250 € net can be created without customer details.
  - Any receipt can be marked "als bezahlt" against the Kasse.
- **Unchangeable:** entries cannot be changed. Corrections use "Verknüpfung aufheben", which creates an automatic counter-entry dated **today** (the date cannot be changed). Support may not delete the cash book.
- **Reports:** current cash balance after each entry. Daily and monthly closings and reports as PDF. Source: https://sevdesk.de/kassenbuch/
- **Not documented [U]:** a block on negative balances, multiple cash registers, and POS import. SumUp is listed as a POS integration.
- **Money movements:** Geldbewegung between bank and Kasse, e.g. a private deposit.

## 5. Fixed assets and depreciation (Anlagen / AfA)
Sources: https://hilfe.sevdesk.de/de/articles/9915171-wirtschaftsguter-korrekt-zuordnen, https://sevdesk.de/funktion-abschreibungen/

- **Thresholds:** above 800 € net, the item is an asset depreciated over its useful life. From 250,01 to 800 € it is a low-value asset (GWG), written off immediately.
  - **Pool depreciation (Sammelposten) is explicitly not possible.**
- **Method:** straight-line, monthly from the purchase month (§7(1) EStG).
- **Useful life:** from the AfA table of the Bundesfinanzministerium, chosen by category or keyword. "Eigene Nutzungsdauer" sets a custom life.
  - Computer hardware: choose immediate write-off or 3 years (BMF letter of 2022).
- **Flow:**
  1. Create an expense and choose an asset account via Erweiterte Suche (e.g. 420/650, 480/670 GWG, 300/500).
  2. Pick "Anlage" plus the useful life, or "Geringwertiges Wirtschaftsgut".
  3. Find the asset under Belege > Anlagen, with a depreciation table per asset.
- **Asset overview:** status, purchase price, book value, monthly depreciation amount, remaining term, inventory number. Depreciation flows into EÜR and GuV.
- **Disposal, sale or early end: manual only (v1).**
  - Early end requires a support request.
  - Sale: book the remaining book value as an expense on 4855/2315 (gain) or 6895/2310 (loss), plus a sale invoice on 4845/8820 or 6885/8801.
  - Source: https://hilfe.sevdesk.de/de/articles/9173125-abschreibung-vorzeitig-beenden-v1
- **Workaround articles:** declining-balance depreciation (degressive AfA) for purchases up to 31.12.2027, and the 75% first-year write-off for electric vehicles. These are workarounds, not native features.
- **Asset register report (Anlagenspiegel):** none documented **[U]**.

## 6. Cost centers (Kostenstellen, Pro only)
- Created under Einstellungen > Buchhaltung > Kostenstelle. Fields: Name and Nummer.
- One can be set as default (pin icon). A cost center already used in bookings cannot be deleted.
- **Maximum one cost center per document.** It does not change the booking account.
- Used as a filter in invoice and receipt lists, including a filter for receipts without a cost center.

## 7. Locking (Festschreibung), GoBD and retention
- **Path:** Einstellungen → System → Festschreiben, choosing the period and the document types.
- No DATEV export is needed to lock.
- After locking, records cannot be edited or deleted. Corrections use a cancellation (Storno) or a general reversal entry (Generalumkehrbuchung).
- sevdesk advises locking by the end of the following month.
- Source: https://sevdesk.de/lexikon/festschreibung/
- **DATEV export:** advises locking after the export. The export can include or exclude locked data. Delivered via DATEV Buchungsdatenservice (with Beraternummer and Mandantennummer) or a ZIP file containing the Buchungsstapel CSV, Stammdaten CSV and receipt images. Source: https://hilfe.sevdesk.de/de/articles/9373838-export
- **GoBD claim:** "sevdesk erfüllt die Anforderungen der GoBD" (sevdesk/buchhaltungssoftware).
- **Retention:** sevdesk's archive guide mentions 8 years for booking documents, following the 2025 law change (BEG IV). No statement was found on keeping data after cancellation, nor an explicit 10-year archive promise **[U]**.

## 8. Payroll (Lohn)
- **Not native:** "sevdesk ist kein Lohnbuchhaltungstool". Wages are booked manually with the net method:
  - Net pay to 4120/6020
  - Employer social security to 4130/6110
  - Source: https://hilfe.sevdesk.de/de/articles/12425656-verbuchung-von-lohn-und-lohnnebenkosten
- **Partner:** the marketplace lists **"project b."** under "Lohn (Lohnservice)". Source: https://sevdesk.de/integrationen/
- No "sevdesk Lohn" product and no payroll-journal import were found.

## 9. Gaps to note when cloning
These are not documented or explicitly absent:
- User-defined bank rules
- Balance sheet and opening balances
- Manual journal entries
- Pool depreciation (Sammelposten) and automatic asset disposal
- Mileage log (Fahrtenbuch) and a travel-expense module
- Tags and a due-date field on receipts
- Duplicate-invoice detection beyond the image-reuse warning
- MT940/CAMT import
- Multiple cash registers
- Native payroll

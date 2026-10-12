# sevdesk invoicing and sales documents: research findings (as of Oct 2026)

**How the sources were checked.** Most of this comes from the sevdesk help center (hilfe.sevdesk.de, an Intercom site; articles dated 2024 to 2026) and the sevdesk product pages. I also downloaded and searched sevdesk's official OpenAPI spec (https://api.sevdesk.de/openapi.yaml). It gives the exact status codes, document types and tax rule IDs, which match what the web UI uses. Help-center links below are shortened to `HC/<id>`, meaning `https://hilfe.sevdesk.de/de/articles/<id>`. **[3rd]** marks a third-party source and **[?]** marks something I couldn't confirm.

---

## 1. Document types and document model (API)
- **Invoice types** (`invoiceType`): `RE` normal invoice, `WKR` recurring template, `SR` storno (cancellation) invoice, `MA` reminder/Mahnung, `TR` Teilrechnung, `AR` Abschlagsrechnung, `ER` Endrechnung/Schlussrechnung (final invoice). (OpenAPI, "Types and status of invoices")
- **Order types** (`orderType`): `AN` Angebot, `AB` Auftragsbestätigung, `LI` Lieferschein. All three share one model, which has `version`, `deliveryTerms` and `paymentTerms` fields. (OpenAPI)
- **Credit note** is a separate object. It needs a `bookingCategory`: `PROVISION`, `ROYALTY_ASSIGNED`, `ROYALTY_UNASSIGNED`, `UNDERACHIEVEMENT` (needs `refSrcInvoice`), or `ACCOUNTING_TYPE` (not supported in sevdesk-Update 2.0). (OpenAPI)
- **Invoice fields** (OpenAPI): contact, address (free text), `invoiceDate`, `deliveryDate` plus optional `deliveryDateUntil` (a delivery period), `header` (Betreff/subject), `headText`/`footText` (limited HTML), `timeToPay` (days), `discount` % plus `discountTime` days (Skonto), `showNet` (net vs gross entry), `currency` (ISO-4217), `taxRule`, `taxText`, `smallSettlement` (Kleinunternehmer), `contactPerson` (a sevdesk user), `paymentMethod`, `costCentre`, `customerInternalNote` (for reference or order numbers), `origin` (source order), `sendType`, `enshrined`, `propertyIsEInvoice`, `deliveryAddressCountry` (used for OSS).
- **Position fields**: part, quantity, `unity` (unit), price/priceNet/priceGross, `taxRate`, `discount`, `positionNumber`, `text`, and **`optional`, which exists only on order positions (quotes), not on invoice positions**.

## 2. Invoice statuses and transitions
- Status codes (OpenAPI):
  - `50`: deactivated recurring template
  - `100`: Entwurf (draft)
  - `200`: Offen / Fällig (one code; the UI shows "fällig" once the due date has passed)
  - `750`: Teilbezahlt (partially paid; added in release 4.181, 13 Jun 2024)
  - `1000`: Bezahlt (paid)
- The UI also has a "Storno" state with its own tab. HC/9154465
- Credit note statuses are 100, 200, 750 and 1000. Order statuses:
  - `100`: Entwurf
  - `200`: versendet
  - `300`: abgelehnt/storniert
  - `500`: angenommen
  - `750`: teilberechnet
  - `1000`: berechnet
- **Transitions**:
  - Creating an invoice gives a draft. Sending, printing or downloading it finalises it and sets it to offen or fällig. HC/9064907
  - Booking a payment sets it to bezahlt or teilbezahlt.
  - The API has no manual status change. Status moves only through `sendBy`/`sendViaEmail`, `bookAmount`, `resetToDraft` (only from 200) and `resetToOpen`.
  - `enshrine` (festschreiben) cannot be undone. OpenAPI
- **Festschreibung (locking)**:
  - Setting "Automatische Festschreibung von Dokumenten bei Fertigstellung" locks documents when they are finalised. Recurring invoices have a separate setting, "…bei Rechnungsversand". HC/9382242
  - A locked invoice cannot be edited and must be corrected with a Storno or a Gutschrift.
  - An unlocked invoice can go back to edit mode via the three-dot menu or "Mehr" → "Dokument bearbeiten". HC/9064811
- **Numbering in drafts**: drafts show the next free number, but the number is fixed only at finalisation, in send order, and is checked again first. All open drafts show the same number. Quotes and other documents work the same way. HC/9064863
- **List view**: the visible tabs or filters are Fällig, Storno and Mahnungen. Row actions include the three-dot menu ("Dokument bearbeiten", "Nächste Mahnung erstellen") and a money-bill icon to mark as paid. HC/9167192, HC/9064811
  - API filters: `partiallyPaid`, `orderByDueTime`, `orderByDebit`, `invoiceNumber`.
  - **[?]** I couldn't confirm the full tab list (e.g. "Entwurf", "Offen", "Bezahlt") or a "duplicate" action.
- **Mark as paid**: button "Zahlungseingang buchen", then pick the date ("Bezahldatum entspricht Belegdatum") and the account (Basiskonto, a connected bank account or Kasse), then "Buchen". The amount can be changed for partial payments. HC/9064917
  - API booking types for payment differences: `FULL_PAYMENT`, `N` (partial), `CB` (Skonto), `O` (other), `OF` (reminder fees), `MTC` (bank fees), `CF` (deprecated).

## 3. Invoice types and how each works
- **Normal invoice**: menu "Rechnungen" → "Rechnung erstellen" → "Versenden / Drucken / Herunterladen". HC/10117558
- **Abschlagsrechnung** (down-payment invoice): HC/9064818
  - From an Angebot/Auftrag via "Mehr" → "Rechnung erzeugen", choosing a percentage or a fixed amount.
  - Or standalone via the arrow next to "Rechnung erstellen" → "Abschlagsrechnung erstellen".
  - Or as a follow-up via three dots → "Folgerechnung erzeugen".
  - Linked documents appear under "Verknüpfte Dokumente anzeigen".
  - A Schlussrechnung is required, even if it is for 0,00 €, and **only after all Abschlagsrechnungen are paid**. Only payments actually received are deducted.
  - VAT is due when the down payment arrives (Mindest-Ist-Besteuerung).
- **Teilrechnung** (partial invoice): only from an Angebot, AB or Lieferschein. Enter a percentage, or a fixed amount marked brutto or netto. The result is one position for that value. The source document becomes "Teil berechnet", and you can create more Teilrechnungen. HC/9064928
- **Schlussrechnung**: created from the original document. The dialog shows the total, payments received and the open balance. The invoice repeats all positions and adds a summary block of the earlier invoices (`partialheader` in the layout). HC/9064928, HC/9382437
- **API rules**: AR and TR invoices allow only taxRule 1 (or 11 for Kleinunternehmer) and **cannot use a foreign currency**. The ER date must be on or after the earlier AR/TR dates. `createInvoiceFromOrder` takes `type` (percentage, net or gross), `amount` and `partialType` (RE, TR or AR). OpenAPI
- **Stornorechnung**: HC/9154465, OpenAPI `cancelInvoice`
  - Only for invoices that are **offen or fällig**: "Mehr" → "Rechnung stornieren".
  - The storno invoice is created automatically with a reference to the original, takes the **next number from the invoice number range**, and is set to "Bezahlt". The original becomes "Storno".
  - For paid invoices, create a Gutschrift (reason Minderleistung) instead.
  - Negative invoices are not possible. Single negative positions are allowed, but the total must stay positive. HC/9064658
- **Gutschrift (credit note)**: HC/15190963, HC/9684740
  - Path: "Rechnungen" → "Gutschriften", then choose a Buchungskategorie.
  - **Minderleistung / Teilstorno** (refund for a reduced service, partial return or partial cancellation): only for invoices that are **Bezahlt or Teilbezahlt**. You find the source invoice by number or contact, or start from the invoice via "Mehr". All positions are copied in and can be reduced or deleted.
  - **Provision** (commission) and **Honorar** (fee; accounts 3100/5900 if assignable to a product, 4909/6303 if not): the tax rule is preset to "Vorsteuerabziehbare Aufwendungen".
  - A Gutschrift becomes an Ausgabebeleg (expense document) and must be linked to the refund or payment transaction.
  - The older v1 UI also had "individuelles Buchungskonto" (book to a chosen account).
  - Self-billing ("Gutschrift als Rechnungsersatz", §14 Abs. 2 UStG) is handled as a Beleg upload, not a generated document.
  - Gutschriften have their own number range. HC/9382101
- **Wiederkehrende Rechnung (recurring)**: HC/66938, https://sevdesk.de/wiederkehrende-rechnungen/
  - Path: Rechnungen → Wiederkehrend → "Wiederkehrende Rechnung erstellen".
  - Fields: "Erste Rechnung" (date), "Referenznummer", "Enddatum (optional)", "Rechnungsintervall", "Rechnungsstellung" checkbox (in arrears/nachfällig vs in advance/im Voraus), "Automatische Generierung" toggle.
  - Intervals: 7 Tage, 14 Tage, monatlich, 2 Monate, vierteljährlich, halbjährlich, jährlich, 2, 3, 4 or 5 Jahre.
  - Sending: "kein automatischer Versand" or "E-Mail versenden" with a chosen email template. Needs an email address on the contact. Can send PDF or e-invoice.
  - Save with "Aktivieren". Templates show Aktiv or Inaktiv and can be deactivated or reactivated. "Rechnung erzeugen" creates one invoice manually.
  - Header text gets an automatic line such as "Berechnung für den Zeitraum vom 27.01.2026 - 26.02.2026" (setting "Text Berechnungszeitraum anzeigen").
  - No "end after N invoices" option.
- **Pro-forma-Rechnung**: there is no dedicated type. You create an Auftragsbestätigung and change the Betreff to "Pro-forma-Rechnung". HC/9167099
- **Sammelrechnung** (one invoice covering several deliveries): **[?]** I found no dedicated feature. sevdesk only has glossary and template pages on the topic.
- **Mahnung / Zahlungserinnerung** (dunning and payment reminders): HC/9167192, HC/9071059
  - Created from a fällig invoice via "Mahnung / Zahlungserinnerung" or "Nächste Mahnung erstellen". The Betreff is adjusted automatically.
  - **Unlimited dunning levels.** Paying any linked document marks the whole chain as Bezahlt.
  - The Mahnfrist (dunning period) is set in the settings.
  - In the API, `dunningLevel` 1 is the Zahlungserinnerung. `reminderCharge` above 0 is no longer allowed, so there are no reminder fees via the API.

## 4. Invoice editor fields (web UI)
- **Kontakt**: autocomplete, or type a new name to create the contact in the background. "Adresse wählen" appears when a contact has several addresses. HC/9167074
- **Settings that affect dates**: "Lieferdatum automatisch setzen", "Rechnungsdatum automatisch anpassen" (moves past draft dates to today), and "Referenz im Betreff" (Betreff becomes document type + number). HC/9382242
- **Kopf-/Fußtext**: free text, a "Textvorlage" or "Platzhalter" (contact, invoice, company or custom contact fields). Placeholders can also be pasted into Betreff, Position and Positionsbeschreibung. HC/9167060
- **Positions**: HC/9064658
  - Columns: Position (with "Produkt suchen" or "Produkt erstellen"), Menge, Einheit (custom units allowed), Einzelpreis, USt., Rabatt (% or €), Betrag.
  - Buttons: "+ Position hinzufügen", "+ Produkt auswählen", "+ Zeiterfassung auswählen", "+ Gesamtrabatt hinzufügen" (discount **or Aufschlag/surcharge**, % or fixed).
  - Brutto/Netto is chosen per document, with the default set in Buchhaltung & Steuern. HC/9382213
- **Überschriften / Positionsblöcke** (headings and blocks): a position with Menge 0 and Preis 0. **No dedicated subtotal ("Zwischensumme") or text-position type is documented [?].** HC/9167081
- **Optional positions**: available on Angebote (`optional` on OrderPos; https://sevdesk.de/angebotssoftware/). Not on invoices.
- **"Weitere Optionen"** (v2): Währung, Skonto, Interne Kontaktperson, Abweichendes Erlöskonto (different revenue account), Zahlungsmethode, Umsatzsteuerregelung (one per document), Dokumente hinzufügen (attachments), and for e-invoices "Kundenreferenz / Leitweg-ID". HC/9310403, HC/10079526
- **Umsatzsteuerregeln** (taxRule IDs, OpenAPI). The UI shows a limited subset; v1 labels were "Umsatzsteuer ausgewiesen", "Steuerfreie innergemeinschaftliche Lieferung" and "Steuerschuldnerschaft des Leistungsempfängers".
  - 1: Umsatzsteuerpflichtige Umsätze (0/7/19 %)
  - 2: Ausfuhren
  - 3: Innergemeinschaftliche Lieferungen
  - 4: Steuerfreie Umsätze §4 UStG
  - 5: Reverse Charge §13b
  - 21: Reverse Charge §18b
  - 17: Nicht im Inland steuerbare Leistung
  - 18/19/20: OSS for goods, electronic services and other services (rates by country)
  - 11: Steuer nicht erhoben nach §19 UStG (Kleinunternehmer)
  - Custom rules (Text, Steuersatz, Einnahmen/Ausgaben, UStVA-Feld, BU-Schlüssel) belong to the older v1 UI. HC/9382135
- **Payment settings**: "Zahlungsziel" (default days; enter 0 for no due date) and "Zahlungsziel Text anzeigen". HC/9382242

## 5. Numbering, text templates, layouts, email
- **Nummernkreise** (number ranges): HC/9382101
  - **One range each** for Rechnung, Gutschrift, Angebot, Auftragsbestätigung, Lieferschein, Artikel, Kontakte and Inventar.
  - Fields: Format, Nächste Zahl (default 1000), Vorschau.
  - Example syntax: `RE-%YY00%NUMBER`. Leading zeros come from the format. No custom variables.
  - **[?]** I couldn't confirm the full variable list or a yearly reset.
- **Textvorlagen** (text templates): HC/9382483
  - Typ "Dokument" (Position: Kopftext or Fußtext) or Typ "E-Mail" (Position: Signatur).
  - "Verwenden für": Angebote, Auftragsbestätigungen, Gutschriften, Lieferscheine, Mahnungen, Rechnungen.
  - Options: "Als Standard festlegen" (one per type) and "Nur für mich sichtbar". The editor has text colours and tables.
  - **[?]** Exact placeholder syntax is not public in the help center.
- **Layouts**: HC/9382437, HC/9374156, https://sevdesk.de/preise/
  - Free standard layouts plus a design colour; premium layouts cost 3,90 €/month.
  - One layout slot is included; each extra slot is 4,90 €/month.
  - Layout files are **HTML/CSS templates (Mustache-style `{{var}}`, `{{#i18n}}`, `{{#date}}`)**, downloadable per document type, with an Excel parameter list. A design service starts at 29 €.
- **Briefpapier** (letterhead): PDF upload via "Neues Briefpapier", one or two pages (page 2 is the background for later pages). Star one as default, or pick per document in the preview. One letterhead is free; more need the "Briefpapiere" add-on at 4,90 €/month.
- **Druckoptionen** (print options): Fußzeile, Seitenzahl, Falz-/Lochmarken, QR-Code, **EPC-QR-Code (GiroCode)**, Artikelnummer, Positionsbeschreibung, Absendezeile, USt. pro Position, Positionssummen bei Bruttorechnungen. HC/9382459
- **Email**: dialog fields Empfänger, Betreff, Nachricht, Signatur and "Kopie an mich selbst", with the PDF attached. Default sender is noreply@sevdesk.de. **Own SMTP** per user: Absendername, Server, Port (465/587/25/2525), Benutzer, Passwort, SSL/TLS. Microsoft 365 connects via OAuth, and SMTP for Microsoft accounts is being phased out. HC/9064907, HC/9382075

## 6. Sending
- Options under "Überprüfen und senden": Herunterladen, E-Mail, **Per Post**, Drucken, "Fertigstellen und speichern". Each has an "Als Entwurf…" variant (no finalisation). HC/9064907
  - API send types: VPR (print), VPDF (download), VM (email), VP (post).
- **Post**: provider **emailbrief.de**; options Schwarz-Weiß, Farbdruck or Duplex. Shipping status shows on the invoice, and a send order cannot be cancelled. Charges are billed once they reach 10 € or monthly. **The per-letter price is not published [?].** Available in all paid tiers. https://sevdesk.de/rechnungsversand/
- **E-Rechnung (e-invoice)**: HC/10079526, OpenAPI
  - Turned on with a toggle per invoice, per contact ("E-Rechnung Standard") or account-wide ("E-Rechnungs-Standard für alle Rechnungen verwenden").
  - "Per E-Mail versenden" sends **ZUGFeRD** (PDF with embedded XML). "Nur XML senden" sends **XRechnung** (plain XML), and the XML is identical in both. `getXml` returns it.
  - Requirements: USt-ID, bank details, payment terms, the customer's email (mandatory). The Leitweg-ID is needed only for public-sector customers; otherwise the Kundenreferenz defaults to "0". SEPA direct debit needs the Gläubiger-ID and the customer's IBAN.
  - sevdesk says it validates against EN 16931 automatically before sending. https://sevdesk.de/wiederkehrende-rechnungen/
  - **[?]** The XRechnung version and ZUGFeRD profile are not published.
  - Receiving e-invoices needs the Buchhaltung tier or higher.

## 7. Payment features
- **The QR code is two different things.**
  - The "QR-Code" is a **download link to the PDF** (top right under the logo), switchable per document in Vorschau → Einstellungen. HC/9382464
  - The separate **EPC/GiroCode** print option needs complete bank details. HC/9382459
- **PayPal link**: Erweiterungen → Integrationen → PayPal; enter the PayPal email and optionally enable it for every invoice. Per invoice in Vorschau → Einstellungen, the style is PayPal icon, full link, or the word "PayPal". It appears below the positions table, with recipient and amount prefilled. HC/9374449
- **I found no native payment link or card payment** (Stripe is only an accounting import via MiracleSync) **[?]**.

## 8. Angebote, Auftragsbestätigung, Lieferschein
- **Angebot (quote)**:
  - Statuses in the app: Entwurf, Offen, Abgelehnt, Erhalten (accepted), Teilberechnet, Berechnet/Bezahlt. HC/11885789
  - Position and total discounts, optional positions.
  - **Online acceptance**: the email contains a link. The setting "Rechnung automatisch erzeugen bei Kunden-Bestätigung" lets the customer accept or decline and creates an invoice on acceptance. HC/9382242, https://sevdesk.de/angebotssoftware/
  - Other settings: default Liefer-/Zahlungsbedingungen (delivery and payment terms) and "Letztes Angebot vom Kontakt übernehmen" (copy the contact's last quote).
  - Conversion with one click to AB, Lieferschein or Rechnung (normal, Teil-, Abschlags- or Schlussrechnung).
  - The API has `version` on orders. **[?]** I couldn't find quote versioning in the UI.
- **Auftragsbestätigung (order confirmation)**: statuses Entwurf, Versendet, Berechnet. Created from a quote or manually, and converts to a Rechnung. HC/12594801
- **Lieferschein (delivery note)**: statuses Entwurf, Erhalten, "Berechnet (Alle)". Created from an Angebot, AB or Rechnung, or manually. Fields: Produkt, Menge, Einheit, Preis (unit prices optional), USt. Own number range; drafts use no number. HC/12058373, https://sevdesk.de/lieferscheinprogramm/

## 9. Currency, language, international, tax settings
- **Foreign currency**: more than 50 currencies with an automatic exchange rate (https://sevdesk.de/funktion-englische-rechnungen-belege/). Not allowed for AR/TR/ER invoices (OpenAPI).
- **Language**: switch German or English per invoice with one click; mandatory invoice details are translated. **[3rd]** trusted.de lists layout languages DE, EN, ES, FR, IT, GR.
- **Kleinunternehmer**: automatic §19 notice and no VAT shown. HC/9382213
- **Ist/Soll-Versteuerung** (cash vs accrual VAT): from the Buchhaltung tier; Ist uses the payment date, Soll the service date or period. Gross/net price entry default is set here. A document change log can be downloaded. HC/9382213

## 10. Tier limits (https://sevdesk.de/preise/, Oct 2026)
- **Prices** (per month, net; promotions cut these by up to 50 %):

| Tier | Monthly billing | Yearly | 2-year |
|---|---|---|---|
| Free | 0 € | – | – |
| Rechnung | 11,90 € (another part of the page says 12,90 €) | 9,90 € | 8,90 € |
| Buchhaltung | 25,90 € | 22,90 € | 19,90 € |
| Buchhaltung Pro | 34,90 € | 30,90 € | 27,90 € |

- **Free**: 3 invoices or e-invoices per month, ZUGFeRD/XRechnung, several layouts, unlimited contacts and products. **No Angebote.**
- **Rechnung** adds: unlimited invoices and quotes, international invoices, Abschlags- and Schlussrechnungen, Gutschriften, English invoices, multiple currencies, own Briefpapier and logo, Zahlungserinnerungen, DATEV export.
- **Buchhaltung** adds: **wiederkehrende Rechnungen, Auftragsbestätigungen, Lieferscheine, Mahnstufen**, bank connection, receiving e-invoices.
  - Conflict: the help center says sending Zahlungserinnerungen and Mahnungen needs Buchhaltung (HC/9071059), while the pricing table lists Zahlungserinnerungen under Rechnung.
- **Buchhaltung Pro** adds: REST API, Kostenstellen (cost centres), BWA.
- Every tier includes 1 user; each extra user is 5,90 €/month.

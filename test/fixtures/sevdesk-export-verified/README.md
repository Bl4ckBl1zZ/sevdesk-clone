# Synthetic sevdesk export set in the verified layout (F09 TST-IMP-16, open item 9)

Synthetic data only — no real persons or companies. The **byte layout** (headers, quoting, BOMs, trailing
separators, file names) is copied from real sevdesk exports of a Kleinunternehmer account taken on 2026-10-18
(„Exportieren › CSV (Excel)“ on Rechnungen, Kontakte and Produkte; „ZIP Archiv“ on Rechnungen). The older set in
`../sevdesk-export/` keeps covering columns sevdesk does not export (type, status, tax rule, currency), which the
owner can still map by hand.

| File | Layout as exported by sevdesk |
|---|---|
| `contacts.csv` | **two** UTF-8 BOMs, `;`, every cell quoted, trailing `;`, header `"Position "` with a trailing space; VAT ID in „UmSt.-ID“ |
| `invoices.csv` | UTF-8 BOM, quoted header ending in an unnamed column `""` (the „Referenz“ printed on the PDF), unquoted rows; no type, status, tax, currency or supply-date column; a Storno is its own row in the same number range with negative amounts and the subject „Stornorechnung Nr. X zur Rechnung Nr. Y“ |
| `18-10-2026_part.csv` | UTF-8 BOM, mixed quoting, „Umsatzsteuer“ `0,00` (Kleinunternehmer), price in „Verkaufspreis“ |
| `pdf/*` | minimal PDF bytes named like the ZIP archive: `YYYY-MM-DD_<Rechnung|Stornorechnung>_<number>_<32 hex>.pdf` |

Known sevdesk quirk (EC-203): the invoice list's „Gesamtbetrag“ can differ from the document total (seen: 1.548,00
in the CSV for a 1.548,80 invoice underpaid by 0,80). The importer cannot see this; the import page asks the owner
to compare the totals with the PDFs before the commit.

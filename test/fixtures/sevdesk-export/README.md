# Synthetic sevdesk export set (F09 TST-IMP-16)

Synthetic data only — no real persons or companies. This set uses **alternate** columns sevdesk's own export does not
write (type, status, tax rule, VAT, currency, supply date, Bezug) so the mapping paths an owner can set by hand stay
covered. The layout of real sevdesk exports (verified 2026-10-18) is in `../sevdesk-export-verified/`.

| File | Encoding | Content |
|---|---|---|
| `kontakte.csv` | UTF-8 with BOM, `;` | 3 contacts (company, person, French company with VAT ID) |
| `artikel.csv` | Windows-1252, `;` | 2 articles (19 %, 7 %), „“ quotes and umlauts as single bytes |
| `rechnungen.csv` | UTF-8 with BOM, `;`, comma decimals, `dd.mm.yyyy` | invoices (paid, partially paid, open, intra-Community, OSS, 0 % without label, cancelled), a Storno, a Gutschrift and a draft |
| `pdf/*` | — | minimal PDF bytes named like sevdesk's PDF export (TST-IMP-18: exact, prefixed, lower-case/space, one file for two rows, one orphan) |

`load.ts` reads them for the domain tests; the Convex tests import the UTF-8 files with `?raw`.

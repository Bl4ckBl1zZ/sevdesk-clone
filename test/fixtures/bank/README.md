# Bank statement fixtures (F07, 07-testing §3.3)

- `revolut-statements/synthetic-2026-10/` — **synthetic** data (no real bank data): one October 2026 scenario of a
  Revolut Business account rendered as CAMT.053 (.001.02 EUR, .001.08 USD), Revolut CSV in three header variants
  and MT940, plus an overlapping and a gap statement. Revolut field choices are UNSURE (F07 Q-03, research 13 §5).
- `generic/` — synthetic files of other banks: a camt.053.001.08 batch entry with a pending entry, an MT940 with
  German structured `:86:`.

## Adding the owner's real month (T07-151)

1. Export one month per currency account from Revolut Business in all four formats (CSV, CAMT.053 XML, MT940 TXT,
   signed PDF) and anonymise names/IBANs consistently across the files.
2. Put them into `revolut-statements/owner-YYYY-MM/` with a `case.json` (`{ "synthetic": false, "description": … }`).
3. `pnpm golden:update` writes `test/golden/bank-statements/owner-YYYY-MM/*.json`; review the normalised rows
   against the PDF and resolve the UNSURE mapping assumptions in `src/domain/banking/sources/*` (flip `unsure`).

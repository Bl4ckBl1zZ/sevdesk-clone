# src/domain — pure compliance core

Pure TypeScript, deterministic, no I/O (02 §3, ADR-003). Enforced by `pnpm lint` (`scripts/check-boundaries.ts`):

- imports only from `src/domain/**` and pure packages (zod, date-fns, …) — no React, Next, Convex, Node I/O;
- no `Date.now()`, `new Date()` without arguments, `Math.random()`, `fetch()`, `process.env` — pass `today`/`now` in;
- money as integers (`*Cents`, `*Micros`, `*Milli`, basis points), rounding via `money/` (CLAUDE.md §4);
- rates, thresholds, form mappings and note texts are date-effective data in `rules/` (ADR-005).

Shared shapes: `result.ts` (`Result<T>`, `Issue` = `{ code, message, params? }` with German messages).

Tests live next to the code (`*.test.ts`, Vitest project `domain`) and start with the requirement ID.
Coverage gate: lines ≥ 95 %, branches ≥ 90 %; nightly Stryker mutation score ≥ 80 %.

| Folder | Content |
|---|---|
| `money/` | cents arithmetic, EN 16931 half-up rounding, parsing, formatting |
| `tax/` | VAT categories, USt-IdNr / Steuernummer formats, tax-case derivation, KU monitor |
| `documents/` | totals, validation rules, lifecycle state machines |
| `einvoice/` | EN 16931 model, mapping, ER-03 decision, Leitweg-ID |
| `numbering/` | number-format templates and the normaliser |
| `dunning/` | interest (§288 BGB), fees, schedule rules |
| `accounting/` | SKR03/04 mapping, journal generation, EÜR, AfA |
| `reports/` | UStVA Kennzahlen, ZM, EÜR line mapping (versioned) |
| `datev/` | EXTF writer |
| `gdpdu/` | Z3 export writer (index.xml) |
| `banking/` | IBAN validation, normalised bank-feed mapping, CAMT/CSV/MT940 parsing, matching scorer |
| `epc/` | GiroCode payload |
| `access/` | roles, permission matrix, sign-up gate |
| `rules/` | date-effective rule tables + lookup helpers (VAT rate keys, Basiszinssatz, thresholds, note texts) |
| `time/` | business dates (`YYYY-MM-DD`, epoch-day arithmetic) and the Europe/Berlin date of an instant |
| `schemas/` | zod schemas shared by UI, Convex, REST and MCP |

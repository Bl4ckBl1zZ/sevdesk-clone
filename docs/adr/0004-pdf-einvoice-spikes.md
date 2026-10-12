# ADR 0004 — P0 spikes 4 and 5: PDF/A-3b, Factur-X embedding and the e-invoice serializer

- **Status:** accepted · 2026-10-13
- **Context:** 09-roadmap P0 spikes 4 ("react-pdf produces PDF/A-3b that veraPDF accepts; `embedFacturX` yields a
  valid ZUGFeRD; else Gotenberg") and 5 ("`@e-invoice-eu/core` produces KoSIT-acceptable XRechnung UBL/CII + ZUGFeRD
  EN16931 from our model, incl. TypeCodes 326/380/381 (F04 9.1) and a 380 final invoice with negative BT-115
  (F04 9.4)"), ADR-006 (react-pdf) and ADR-007 (`@e-invoice-eu/core` behind our serializer, own builder as fallback).
- **Validators:** einvoice-tools sidecar (services/einvoice-tools) with KoSIT validator 1.6.3 + XRechnung
  configuration 3.0.2 (release 2026-08-31) and Mustang 2.26.0 (veraPDF inside), JVM `-Xmx512m`.

## Spike 4 — react-pdf PDF/A-3b and Factur-X embedding

| Check | Result |
|---|---|
| `@react-pdf/renderer` 4.9 `conformance="PDF/A-3b"` with embedded TTF fonts (Inter, Noto Sans, Source Serif 4 as base64 module) | veraPDF flavour 3b, `isCompliant=true` (1 061 assertions for a one-page invoice, 12 351 for the hybrid) |
| `@cantoo/pdf-lib` 2.11 `embedFacturX` (AFRelationship `Alternative`, `fx:` XMP + extension schema, keeps the existing 3B level) | Mustang: `pdfaValid`, `xmlPresent`, `xmlValid`, `valid` — for `factur-x.xml` (EN 16931) and `xrechnung.xml` (XRECHNUNG) |
| Extracted XML byte-equal to the returned XML (INV-21) | yes (`src/pdf/render-artifacts.test.tsx`, `readEmbeddedFiles`) |
| Determinism (archive sha256) | byte-identical output for identical snapshot + layout + `createdAt` (react-pdf `creationDate`/`modificationDate`, pdf-lib `updateMetadata: false` and fixed attachment dates) |
| Every golden PDF (48 rendered cases incl. non-invoice types, Kopie, Lesefassung, 3-page invoice) | veraPDF PDF/A-3b valid; every ZUGFeRD PDF also Mustang-valid (`test/integration/einvoice-validation.test.ts`) |

**Decision:** keep react-pdf + `embedFacturX`. The Gotenberg fallback (09 P0 spike 4) is not needed.

Findings worth keeping:
- `lineHeight` on the react-pdf `Page` (or an inherited one) drops dynamic `render` texts ("Seite x von y") and
  inflates row heights in 4.9 — the template sets no page-level `lineHeight`.
- A `fixed` header row inside the positions `View` repeats on every page (DOC-30, EC-DOC-79).
- Fonts are a generated TS module (`src/pdf/fonts/data.generated.ts`, sha256-pinned in
  `scripts/generate-pdf-fonts.ts`), so rendering needs no file system (Next route handlers, Convex Node actions).
  The module is ~4 MB; it is excluded from Biome.

## Spike 5 — `@e-invoice-eu/core` vs. own builder

`scripts/spikes/einvoice-eu-core.ts` feeds the library (3.4.0) the content of our XRechnung UBL for six golden cases
(UBL-shaped JSON, as its input model requires) and validates its XRECHNUNG-UBL, XRECHNUNG-CII, CII and
Factur-X-EN16931 output:

| Case | BT-3 | BT-115 | lib XRECHNUNG-UBL | lib XRECHNUNG-CII | lib CII | lib Factur-X-EN16931 (Mustang) |
|---|---|---|---|---|---|---|
| de-19-standard | 380 | 1 190,00 | acceptable | acceptable | acceptable | valid |
| advance-invoice-30 | 326 | 3 570,00 | acceptable | acceptable | acceptable | valid |
| construction-advance-875 | 875 | 1 785,00 | acceptable | acceptable | acceptable | valid |
| storno-full | 381 (CreditNote) | 1 190,00 | acceptable | acceptable | acceptable | valid |
| advance-rate-change (final) | 380 | **−120,00** | acceptable | acceptable | acceptable | **invalid** (XSD: several notes become one `ram:IncludedNote` with repeated `ram:Content`) |
| ku-invoice | 380 | 1 000,00 | acceptable | acceptable | acceptable | valid |

The library covers the TypeCodes and the negative BT-115. Gaps found:
1. **Notes in CII:** all BT-22 notes are merged into one `IncludedNote` with several `Content` elements, and the
   BT-21 subject code stays as `#AAI#` text instead of `ram:SubjectCode`. KoSIT (full D16B schema) accepts it, the
   Factur-X EN16931 XSD does not — our final invoices always carry ≥ 2 notes (title note + deduction lines, App. A.6),
   so every hybrid final invoice would be invalid.
2. **Input model:** the library takes UBL-shaped JSON. We would maintain an EN 16931 → UBL-JSON mapping anyway, i.e.
   a UBL serializer in another shape; the CII is derived by the library, so CII-specific rules (BT-21 above, BG-3
   repetition, `TaxTotalAmount` in EUR) are out of our hands.
3. **Runtime footprint:** the bundle imports `child_process`, `tmp-promise` and LibreOffice spawning (spreadsheet
   path), `ajv` and `xmlbuilder2`; `generate()` is async only. Not usable in the Convex default runtime and heavy for
   a pure domain step.
4. **Golden files:** the output format (tabs, `utf-8`, schemaLocation) is library-controlled; every library update
   would rewrite all goldens.

**Decision (ADR-007 fallback taken):** our own deterministic serializers in `src/domain/einvoice` (`model.ts` →
`cii.ts` / `ubl.ts`, `xml.ts` writer, no dependencies, synchronous, pure). `@e-invoice-eu/core` stays installed (pinned
3.4.0) for this spike script and as a cross-check; no runtime code imports it (moving it to `devDependencies` is a
follow-up lockfile change). Our output for **all 43 invoice-type golden
cases** is KoSIT-acceptable (CII as Factur-X EN16931 or XRechnung CII, UBL as XRechnung UBL Invoice/CreditNote) —
86 XML documents.

## Open questions answered (F04 9.1 / 9.4 / 9.2, 01 open item 8)

| Question | Result (KoSIT 1.6.3, XRechnung 3.0.2) |
|---|---|
| 326 for advance/partial invoices | accepted (CII + UBL) |
| 875 / 877 (construction advance / final) | accepted |
| 381 as UBL `CreditNote` with positive amounts (Storno, credit correction) | accepted |
| 384 (rectification) with BG-3 | accepted |
| 380 final invoice with negative BT-115 (refund after a rate change) | accepted (CII + UBL); Factur-X EN16931 XSD + Schematron (Mustang) valid |
| 386 (prepayment invoice), 876 | not used by the app (App. A.2); not tested |
| Kleinunternehmer as category E, rate 0, KU note as BT-120, no VATEX code | accepted (EN 16931 and XRechnung). Needs BT-29 when the KU has no USt-IdNr. and no register entry (BR-CO-26) — we write the Steuernummer as BT-29 (and BT-32) |
| Category O | EN 16931 forbids a line rate (BR-O-05); XRechnung requires BT-119 in the breakdown (BR-DE-14) → BT-119 = 0.00 in the XRechnung profile only |

## Consequences

- The invoice slice calls `renderArtifacts(snapshot, layout, variant, { createdAt, logo })` inside the finalisation
  action and archives `pdf` / `xml` with their sha256; KoSIT/Mustang validation stays a sidecar call (INV-20).
- `pnpm golden` checks snapshot JSON, CII, UBL and PDF text for every case; CI's `einvoice-validate` job runs
  `test/integration/einvoice-validation.test.ts` with `EINVOICE_TOOLS_URL` set.
- Re-run `scripts/spikes/einvoice-eu-core.ts` when `@e-invoice-eu/core` changes; if gap 1 is fixed upstream and the
  runtime footprint shrinks, switching back is an adapter change behind `serializeEinvoice`.

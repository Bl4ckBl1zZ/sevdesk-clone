# German E-Rechnung + PDF generation in TypeScript/Node: research report (as of 2026-10-12)

Versions, dates, licenses and download counts come straight from the npm registry, Docker Hub and GitHub APIs on 2026-10-12, unless a line says otherwise. Anything I could not confirm is marked **(unverified)**. I wrote no files.

---

## TL;DR recommendation

1. **Making the PDF.** Use `@react-pdf/renderer` 4.9.0. It added a `conformance="PDF/A-3b"` Document prop on 2026-08-27. If you prefer HTML/CSS layouts, use Playwright/Puppeteer instead and fix up PDF/A afterwards.
2. **Making the XML.** Generate CII yourself (a typed builder using `xmlbuilder2`, or templates), or use `@e-invoice-eu/core`. Produce **ZUGFeRD EN16931** (or the XRECHNUNG profile) for hybrid PDFs, and **XRechnung UBL or CII** for public-sector buyers.
3. **Putting the XML into the PDF.** `@cantoo/pdf-lib` 2.11.1 has `embedFacturX()` and `convertToPDFA()`. It is maintained; upstream `pdf-lib` is effectively dead. Alternatives are `@e-invoice-eu/core`, `@stackforge-eu/factur-x`, or Gotenberg's `/forms/pdfengines/factur-x` route.
4. **Validating.** Run sidecars: the KoSIT validator in daemon mode (`-D`) for the XML, and Mustang or veraPDF for the PDF/A-3 and the hybrid PDF. Validate every outgoing invoice in CI and before sending.
5. **Reading incoming invoices.** Extract the attachment with `pdfjs-dist` `getAttachments()` or cantoo `getAttachments()`. Parse with `fast-xml-parser` 5.x. For display, use the KoSIT `xrechnung-visualization` XSLT, either with Saxon-JS or by calling Mustang `--action visualize`.

---

## 1. Legal context (brief)

- **Basis:** the Wachstumschancengesetz, which amended §14 UStG. Detailed rules are in the BMF letters of 15.10.2024 and **15.10.2025** (the latter covers how the 800k threshold is calculated, formats and validation). I found no 2026 BMF letter that changes the deadlines.
- **Receiving:** every domestic B2B business must be able to receive e-invoices **since 1.1.2025**.
- **Issuing:**
  - **From 1.1.2027:** mandatory if prior-year turnover is above **€800,000**. Per the BMF this is total turnover in the sense of §19(3) UStG.
  - **From 1.1.2028:** mandatory for everyone.
  - **Until the end of 2026 (2027 for small firms):** paper is still allowed, and so is PDF/other formats with the recipient's consent.
  - The ZDH (crafts association) is lobbying to push the 2027 stage back. There is no legislative process for that.
- **Exempt:** small-amount invoices up to €250, travel tickets, and issuing by Kleinunternehmer (who must still be able to receive).
- **Valid formats:** anything EN 16931-compliant.
  - **XRechnung** in UBL or CII syntax.
  - **ZUGFeRD ≥ 2.0.1 / Factur-X** with profile **EN16931 (Comfort), EXTENDED or XRECHNUNG**. BASIC is also accepted per the BMF; I believe this but did not recheck the letter's exact wording.
  - **MINIMUM and BASIC-WL are *not* valid e-invoices.**
  - In a hybrid PDF, the **XML is the leading part** (per the BMF letter; unverified).
- **Current versions:**

| Standard | Current | Notes |
|---|---|---|
| **XRechnung** | **3.0.2**, in force since 1.2.2024 (3.0.x) | KoSIT made no normative summer-2026 release, so 3.0 stays valid **at least until 31.07.2027**. An **XRechnung 4.0 pre-release** came out on 15.09.2026, based on EN 16931-1:2026 with more than 50 new BTs (e.g. a Skonto group BG-35, multiple order/delivery references). It is not for production; KoSIT expects the technical bundle in **spring 2027**. |
| **ZUGFeRD / Factur-X** | **ZUGFeRD 2.5.2 = Factur-X 1.09.2** (4.8.2026, applies from 1.9.2026) | 2.5 / 1.09 came out 10.6.2026 and aligned the code lists. 2.4 / 1.08 came out 4.12.2025 (sub-lines). 2.3.3 came out 7.5.2025. All are backward compatible. |
| EN16931 CEN Schematron | 1.3.16 | Used by the current KoSIT config and by Mustang 2.26.0 |

Sources: [kostenlose-erechnung.de/standards](https://kostenlose-erechnung.de/standards/), [fiscal-requirements XRechnung 4.0](https://www.fiscal-requirements.com/news/5998-germany-xrechnung-40-what-changes-in-the-new-e-invoice-specification), [FeRD downloads](https://www.ferd-net.de/en/downloads/publications), [vatupdate 2.5.2](https://www.vatupdate.com/2026/08/06/germany-france-zugferd-2-5-2-factur-x-1-09-2-technical-update-published-effective-1-september-2026/), [FNFE 2.4 press release](https://fnfe-mpe.org/wp-content/uploads/2025/12/2025-12-04_Factur-X_1.08_ZUGFeRD_2.4_Press_Release_EN.pdf), [IHK Stuttgart](https://www.ihk.de/stuttgart/fuer-unternehmen/recht-und-steuern/steuerrecht/steuermeldungen/e-rechnungen-5864496), [kostenlose-erechnung FAQ](https://kostenlose-erechnung.de/ratgeber/e-rechnung-pflicht-faq-2026/)

---

## 2. PDF generation

| Package | Latest | Released | License | Weekly DL | Notes |
|---|---|---|---|---|---|
| `@react-pdf/renderer` | **4.9.0** | 2026-08-27 | MIT | 6.6M | Peer `react ^16.8 \|\| ^17 \|\| ^18 \|\| ^19`, so React 19 works. Built on `pdfkit 0.20.1`. |
| `pdfmake` | 0.3.11 | 2026-06-12 | MIT | 2.9M | The 0.3 line started 2026-01-01. Uses pdfkit ^0.19.1. Supports PDF/A and attachments. |
| `pdfkit` | 0.20.2 | 2026-08-30 | MIT | – | Low level. `subset: 'PDF/A-3b'`, plus `doc.file()` with a `relationship` option. |
| `puppeteer` | 25.13.0 | 2026-10-08 | Apache-2.0 | 11.5M | |
| `playwright` / `playwright-core` | 1.64.0 | 2026-10-07 | Apache-2.0 | 124M (core) | `page.pdf()` works in Chromium only. |
| `pdf-lib` | **1.17.1** | **2021-11-06** | MIT | 18M | **Unmaintained** for about 5 years. |
| `@cantoo/pdf-lib` | **2.11.1** | 2026-09-15 | MIT | 922k | Active fork with the same API. Adds `convertToPDFA()`, `embedFacturX()`, `getAttachments()`, encryption and SVG. |

**@react-pdf/renderer details**
- New in 4.9.0: `<Document conformance="PDF/A-3b">`. Per the changelog it writes PDF/A-1/2/3 (b-level only) with XMP `pdfaid` metadata and an **sRGB OutputIntent**, and picks the `pdfVersion` the level needs.
- **Fonts must be registered with `Font.register`**; the standard 14 fonts are not embedded and fail PDF/A.
- Only **TTF and WOFF** are supported (no WOFF2). Variable fonts don't work, so register static files.
- `Font.register({ family, src, fontStyle, fontWeight, fonts: [] })`. For German hyphenation use `Font.registerHyphenationCallback` with `@react-pdf/hyphenate`.
- There is no attachment prop. Attach the XML afterwards with cantoo `embedFacturX` (section 3).

**HTML-to-PDF with Chromium in Docker**
- Install only the headless shell: `npx playwright install --with-deps --only-shell chromium`. The Playwright docs show about 281 MB for a full Chromium install.
- Official image: `mcr.microsoft.com/playwright:v1.64.0-noble` (also `-jammy` and `-resolute`). It is large, likely over 1.5 GB uncompressed **(unverified)**.
- `zenika/alpine-chrome:124` is about 281 MB compressed, but its tag is old.
- **Gotenberg 8.37.0** (2026-09-11, MIT, `gotenberg/gotenberg:8`, about 703 MB compressed on amd64) wraps Chromium and LibreOffice over HTTP:
  - `POST /forms/chromium/convert/html` accepts `pdfa=PDF/A-3b`, `pdfua`, `embeds` (file[]), `embedsMetadata` (JSON, per-file `mimeType` and `relationship`) and `metadata`.
  - There is a dedicated **`POST /forms/pdfengines/factur-x`** route, covered in section 3.
- **Chromium output is not PDF/A.** You need a post-processing step: cantoo `convertToPDFA`/`embedFacturX`, Gotenberg, or Ghostscript `-dPDFA=3`. Then check the result with veraPDF.

**pdfmake PDF/A example**
```js
{ version: '1.7', subset: 'PDF/A-3b', tagged: true, info: { title: 'Rechnung' }, content: [...] }
```

Sources: [react-pdf CHANGELOG](https://github.com/diegomura/react-pdf/blob/master/packages/renderer/CHANGELOG.md), [react-pdf Document](https://react-pdf.org/docs/v4/components/document), [react-pdf fonts](https://react-pdf.org/fonts), [pdfmake PDF/A](https://pdfmake.github.io/docs/0.3/document-definition-object/pdfa/), [pdfkit attachments](https://pdfkit.org/docs/attachments.html), [Playwright browsers](https://playwright.dev/docs/browsers), [Gotenberg HTML route](https://gotenberg.dev/docs/convert-with-chromium/convert-html-to-pdf), [cantoo pdf-lib](https://github.com/cantoo-scribe/pdf-lib)

---

## 3. PDF/A-3 with embedded ZUGFeRD/Factur-X XML in JS/TS

### What a valid hybrid PDF needs (in pdf-lib terms)
- **PDF/A-3b basics:**
  - all fonts embedded
  - an OutputIntent with an ICC profile (sRGB)
  - an uncompressed XMP metadata stream containing `pdfaid:part=3` and `pdfaid:conformance=B`
  - a trailer `/ID`
  - no encryption and no JavaScript
  - Info dictionary and XMP kept in sync
- **The attachment** must be named `factur-x.xml`; for ZUGFeRD 2.1+ and the XRECHNUNG profile it is `xrechnung.xml`. It needs a FileSpec with `/AFRelationship /Alternative` (or `/Data` or `/Source`), and the catalog needs an `/AF` array.
  - Upstream pdf-lib 1.17 `attach()` already supports the `afRelationship` option (the `AFRelationship` enum is in the source).
- **Factur-X XMP extension schema:** the `fx:` namespace (`urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#`) with `DocumentType=INVOICE`, `DocumentFileName`, `Version=1.0` and `ConformanceLevel`, declared through `pdfaExtension:schemas`.
- **Upstream `pdf-lib` alone:** it can be done by hand-writing the XMP and OutputIntent. The **cantoo fork does this for you.** Neither fork rewrites page content, so non-embedded fonts or bad transparency will still fail. **Always run veraPDF and Mustang on the output.**

### Library comparison

| Package | Ver / date | License | Wk DL | XML gen | PDF/A-3 embed | Notes |
|---|---|---|---|---|---|---|
| **`@cantoo/pdf-lib`** | 2.11.1 / 2026-09-15 | MIT | 922k | ✗ | ✓ `embedFacturX(pdfDoc, xml, {conformanceLevel})`, levels `MINIMUM\|BASIC WL\|BASIC\|EN 16931\|EXTENDED\|XRECHNUNG` | Ensures PDF/A-3B, writes the `fx:` XMP and extension schema, attaches with AF. Added in 2.8.0. **Best "bring your own XML" option.** |
| **`@e-invoice-eu/core`** (gflohr) | 3.4.0 / 2026-10-04 | **WTFPL** | 20k | ✓ UBL, CII, XRECHNUNG-UBL/CII, Factur-X-Minimum…Extended, Factur-X-XRechnung (ZUGFeRD-* aliases) | ✓ via `@cantoo/pdf-lib` | Input is JSON (its own BT-based schema) or a spreadsheet plus mapping. Pass `pdf` (your own PDF) or `data` (a spreadsheet, rendered by **LibreOffice only in that case**). The README says the PDF/A transform is "not battle-tested"; it suggests Ghostscript or LibreOffice as fallbacks. Also ships `@e-invoice-eu/cli`, `@e-invoice-eu/server` (REST) and Docker `gflohr/e-invoice-eu:latest` (with LibreOffice) or `:slim`, port 3000. |
| `node-zugferd` (jslno) | 0.1.1-beta.1 / 2025-08-07 | MIT | 48k | ✓ CII: MINIMUM, BASIC WL, BASIC, EN16931, EXTENDED (**no XRECHNUNG profile**) | ✓ `invoice.embedInPdf(pdf,{metadata})`, writes `pdfaid` XMP and an ICC color profile | Uses zod 3 and upstream pdf-lib 1.17. README marks it WIP. 75★. Last commit 2026-02, no npm release since 2025-08. Docs: node-zugferd.jsolano.de |
| `@stackforge-eu/factur-x` | 1.4.3 / 2026-09-28 | **EUPL-1.2** (copyleft) | 44k | ✓ CII (Factur-X 1.09 / ZUGFeRD 2.5), standalone XRechnung CII, extraction | ✓ PDF/A-3b plus XMP | XSD validation via `libxml2-wasm`. Upstream pdf-lib. 18★. |
| `factur-x-kit` | 0.3.2 / 2026-07-31 | MIT | 5.5k | read and write CII | ✓ | zod 4, upstream pdf-lib |
| `@stafyniaksacha/facturx` | 0.6.1 / 2026-08-28 | MIT | 2.8k | Factur-X / Order-X | ✓ | Uses saxon-js for Schematron and libxml2-wasm for XSD. Has a CLI. |
| `@fin.cx/einvoice` | 11.3.1 / 2026-09-30 | MIT | 0.6k | multi-format | ✓ | Small user base |
| `@attestwire/en16931` | 0.14.1 / 2026-10-04 | MIT | 1.8k | validation and generation | – | New |
| `@lucaapp/zugferd-ts`, `zugferd-ts`, `@ekwo-ai/factur-x`, `@aifind/mustangjs` (a TS port of Mustang, 31 DL/wk) | 2026 | various | <1k | | | Too young to rely on |
| `zugferd-generator` / `xrechnung-generator` (BenediktCleff) | 1.2.1 / 1.1.0 | | 1.1k / 21 | | | Small |

**Not found on npm:** `zugferd-js`, `einvoice`, `@fiscalbase/*`. `factur-x` 0.0.2 (2024), `zugferd` 0.0.1 and `xrechnung` 0.0.1 are empty placeholders.

### Recommended pipeline (react-pdf → cantoo)
```ts
import { renderToBuffer } from '@react-pdf/renderer';
import { PDFDocument, embedFacturX } from '@cantoo/pdf-lib';

const pdfBytes = await renderToBuffer(<InvoiceDoc conformance="PDF/A-3b" />); // registered TTF fonts!
const doc = await PDFDocument.load(pdfBytes);
doc.setTitle(`Rechnung ${nr}`); doc.setAuthor(sellerName);
await embedFacturX(doc, new TextEncoder().encode(ciiXml), { conformanceLevel: 'EN 16931' });
const hybrid = await doc.save();   // then: veraPDF + Mustang validate
```
I did not test applying `embedFacturX` to a *loaded* PDF that react-pdf already made PDF/A. The README says it "keeps an existing 3U/3B level" **(unverified in practice)**.

### Gotenberg alternative (no JS PDF/A code at all)
```bash
curl -X POST http://gotenberg:3000/forms/pdfengines/factur-x \
  --form files=@invoice.pdf --form facturxXml=@factur-x.xml \
  --form 'facturxConformanceLevel=EN 16931' -o invoice-zugferd.pdf
```
- Levels: `MINIMUM`, `BASIC WL`, `BASIC`, `EN 16931`, `EXTENDED`, `XRECHNUNG`. `pdfa` can be `PDF/A-3a`, `3b` or `3u`; the default converts to 3b. Uses QPDF.
- It **does not validate** the XML, and it always names the attachment `factur-x.xml`.

Sources: [e-invoice-eu GitHub](https://github.com/gflohr/e-invoice-eu), [core README](https://github.com/gflohr/e-invoice-eu/blob/main/packages/core/README.md), [e-invoice-eu deployment docs](https://gflohr.github.io/e-invoice-eu/en/docs/service/deployment/), [node-zugferd](https://github.com/jslno/node-zugferd), [StackForge factur-x](https://github.com/StackForge-EU/factur-x), [cantoo pdf-lib README/CHANGELOG](https://github.com/cantoo-scribe/pdf-lib), [Gotenberg Factur-X](https://gotenberg.dev/docs/manipulate-pdfs/factur-x)

---

## 4. Mustang project (Java)

- **Latest:** **core-2.26.0** (2026-08-25; CEN Schematron 1.3.16, BG-11 tax representative). 2.25.0 (2026-08-05) added **ZUGFeRD 2.5.2 / Factur-X 1.09.2**, veraPDF CVE fixes and `--no-arithmetic-check`. 2.24.0 (2026-06-12) added ZUGFeRD 2.5.
- **License:** Apache-2.0.
- **Java:** 11 was still supported as of 2.23; a Java 17 branch is planned **(verify)**.
- **Jar:** `https://github.com/ZUGFeRD/mustangproject/releases/download/core-2.26.0/Mustang-CLI-2.26.0.jar`
- **CLI actions** (`java -Xmx1G -Dfile.encoding=UTF-8 -jar Mustang-CLI-2.26.0.jar --action <x>`):
  - `combine` (PDF plus XML to PDF/A-3)
  - `extract`
  - `validate` (ZUGFeRD 1/2, XRechnung, plus PDF/A via the bundled veraPDF)
  - `validateExpectValid` / `validateExpectInvalid -d <dir>`
  - `visualize` (XML to HTML, experimental)
  - `pdf` (XML to a German PDF/A-3)
  - `a3only` (PDF/A-1 to PDF/A-3)
  - `ubl` (CII to UBL)
  - `upgrade` (ZF1 to ZF2)
  - `metrics`
- **Non-interactive flags:** `--source`, `--source-xml`, `--out`, `--attachments ""`, `--no-additional-attachments`, `--format fx|zf`, `--version 1|2`, `--profile M|"BASIC WL"|B|C|X|E|T`. Example (assembled from the documented flags, not copied from the docs):
  ```bash
  java -jar Mustang-CLI-2.26.0.jar --action combine --source in.pdf --source-xml factur-x.xml \
    --out out.pdf --format zf --version 2 --profile E --no-additional-attachments
  java -jar Mustang-CLI-2.26.0.jar --no-notices --action validate --source out.pdf 2>/dev/null
  ```
  `validate` prints an XML report (`<validation><xml|pdf><summary status="valid|invalid"/>…`). The exit code is 0 when the file is valid.
- **Server and Docker:**
  - **Mustangserver** (mustangserver.com) is the **proprietary** Spring-based REST API, documented in OpenAPI. Pricing and on-prem terms are not published.
  - The old open-source dropwizard "mustangapi" is discontinued.
  - **There is no official Docker image.** Community options:
    - `docentric/e-invoice-validator`: a .NET 10 REST wrapper around the Mustang CLI.
    - **`gflohr/e-invoice-eu-validator`** (WTFPL): a Java HTTP server around Mustang. `POST /validate`, multipart field `invoice`, returns 200 or 400 with an XML report. Run with `PORT=8080 java -jar validator-<ver>-jar-with-dependencies.jar`; versions track Mustang.
- **Sidecar approach:** build your own small image, e.g. `FROM eclipse-temurin:17-jre` plus the e-invoice-eu-validator jar (keeps the JVM warm) or the Mustang CLI jar invoked per job. The CLI is slow to start because of JVM startup.

Sources: [Mustang releases](https://github.com/ZUGFeRD/mustangproject/releases), [Mustang CLI docs](https://www.mustangproject.org/commandline/), [Mustangserver](https://www.mustangproject.org/server/), [e-invoice-eu-validator](https://github.com/gflohr/e-invoice-eu-validator), [docentric image](https://hub.docker.com/r/docentric/e-invoice-validator)

---

## 5. Generating XRechnung UBL/CII in TS

**Approach.** The XML is deterministic and the schema is stable within 3.0.x. A typed domain model plus a builder (`xmlbuilder2` 4.0.3, MIT, 2025-12-01) or tagged templates is maintainable. Alternatively, map your model into `@e-invoice-eu/core`'s JSON format and let it emit UBL, CII or Factur-X. Either way:
- format decimals deterministically (use `decimal.js` or integer cents)
- compute totals with the BR-CO rules
- validate with KoSIT in tests (use the KoSIT xrechnung-testsuite as fixtures)

**Required identifiers (XRechnung 3.0)**
- **BT-24 CustomizationID:** `urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0`. The prefix `urn:xeinkauf.de:kosit:xrechnung_` is confirmed in the schematron; the full string is from my knowledge.
- **BT-23 ProfileID:** `urn:fdc:peppol.eu:2017:poacc:billing:01:1.0` (PEPPOL-EN16931-R001).
- **ZUGFeRD guideline IDs:**
  - EN16931: `urn:cen.eu:en16931:2017`
  - XRECHNUNG profile: the XRechnung URN above
  - BASIC: `urn:cen.eu:en16931:2017#compliant#urn:factur-x.eu:1p0:basic`
  - EXTENDED: `urn:cen.eu:en16931:2017#conformant#urn:factur-x.eu:1p0:extended`

**Mandatory fields beyond EN 16931 core.** I took these from the XRechnung Schematron v2.6.0 (for XRechnung 3.0.2) by reading it in memory:

| Rule | Requirement |
|---|---|
| BR-DE-1 | Payment instructions **BG-16** |
| BR-DE-2, 5, 6, 7 | Seller contact **BG-6**: name **BT-41**, phone **BT-42** (at least 3 digits, BR-DE-27), email **BT-43** (BR-DE-28) |
| BR-DE-3, 4 | Seller city **BT-37**, post code **BT-38** |
| BR-DE-8, 9 | Buyer city **BT-52**, post code **BT-53** |
| BR-DE-10, 11 | Deliver-to city and post code if BG-15 is present |
| **BR-DE-15** | **Buyer reference BT-10 must be present** |
| BR-DE-16 | With tax codes S/Z/E/AE/K/G/L/M: seller VAT ID BT-31, or tax number BT-32, or tax representative |
| BR-DE-14 | VAT rate **BT-119** |
| BR-DE-17 | Type code BT-3 only 326, 380, 384, 389, 381, 875, 876, 877 (my recollection; the schematron text was cut off) |
| BR-DE-18 | Skonto syntax in BT-20: `#SKONTO#TAGE=14#PROZENT=2.00#` |
| BR-DE-19 | IBAN check for BT-84 when means code is 58 |
| BR-DE-23/24/25 | Payment means consistency (30/58 needs BG-17, 48/54/55 needs BG-18, 59 needs BG-19 plus BT-90/BT-91) |
| BR-DE-26 | Code 384 requires BG-3 |
| BR-DE-TMP-32 | Delivery date BT-72, or period BG-14, or line period BG-26 (warning) |
| **PEPPOL-EN16931-R020 / R010** | **Seller electronic address BT-34 and buyer electronic address BT-49 are mandatory.** Usually an email with scheme `EM`, or a Leitweg-ID with `0204` for the buyer. |

**Leitweg-ID (BT-10)**
- Required for invoices to German public authorities, as `cbc:BuyerReference` in UBL or `ram:BuyerReference` in CII.
- Format: `Grobadressierung (2–12 digits) - Feinadressierung (up to 30 alphanumeric, optional) - Prüfziffer (2 digits, ISO 7064 Mod 97-10)`, e.g. `04011000-1234512345-06`, max 46 characters.
- For B2B there is no Leitweg-ID, but BT-10 is still mandatory in XRechnung. Use the buyer's order or reference number.
- Federal invoices are submitted via the OZG-RE / ZRE portals or Peppol. Whether ZRE is still running should be checked **(unverified claim that ZRE was discontinued at the end of 2025)**.

---

## 6. Validation

**KoSIT validator** ([github.com/itplr-kosit/validator](https://github.com/itplr-kosit/validator), Apache-2.0)
- Latest **v1.6.3** (2026-08-20). Since 1.6.1 the standalone jar is on Maven Central: `https://repo1.maven.org/maven2/org/kosit/validator/1.6.3/validator-1.6.3-standalone.jar`. Needs **Java 11+**.
- **Configuration:** **validator-configuration-xrechnung `v2026-08-31`** (published 2026-09-02) for XRechnung 3.0.2, with CEN Schematron 1.3.16 and Validator 1.6.3:
  `https://github.com/itplr-kosit/validator-configuration-xrechnung/releases/download/v2026-08-31/xrechnung-3.0.2-validator-configuration-2026-08-31.zip`
  - It validates XRechnung and plain EN16931 UBL/CII.
  - Related: xrechnung-schematron v2.6.0, xrechnung-visualization v2026-08-31, testsuite v2026-08-31. The test suite now lives at projekte.kosit.org (GitLab).
- **CLI:** `java -jar validator-1.6.3-standalone.jar -s scenarios.xml -r ${PWD} -h ubl.xml` writes `ubl-report.xml` and `ubl-report.html`. Other flags: `-p` prints the report to stdout, `-m` shows memory use.
  - Exit codes: 0 = all acceptable, n > 0 = number rejected, -1 = argument error, -2 = configuration error.
- **Daemon:** `java -jar validator-1.6.3-standalone.jar -s scenarios.xml -r /cfg -D -H 0.0.0.0 -P 8080 --disable-gui` (default bind is localhost:8080).
  ```bash
  curl -X POST http://kosit:8080 -H 'Content-Type: application/xml' --data-binary @invoice.xml
  ```
  - Responses: **200** acceptable, **406** not acceptable, **422** processing or configuration error, 400 empty, 405 non-POST. The body is the XML report.
  - Health check at `GET /server/health`. The GET GUI is for demos only.
- **Validates XML only.** For a ZUGFeRD PDF, extract the XML first.
- **No official Docker image.** Community images:
  - `apps4everything/kosit-validator-xrechnung`: 1.6.3 plus XRechnung 3.0.2, updated 2026-08-31, Apache-2.0, healthcheck at `/server/health`.
  - `exsemt/xrechnung-kosit-validator`: Temurin 17, amd64 and arm64.
  - `flx235/xr-validator-service`: 1.6.1, port 8081, source at github.com/flexness/xrechnung-validator-docker.
  - `easybill/kosit-validator-xrechnung_3.0.2`.
  - `easybill/e-invoice-validator`: MIT, its own Schematron service, `POST /validation`, JSON response with 200/400, port 8080. Its image was **last updated Jan 2025**, so it may be stale.
  - **Recommendation:** build your own tiny image (`eclipse-temurin:17-jre`, then fetch the jar and config, then the `-D` command above) so you control which config version you run.
- **PDF/A:** veraPDF **1.30.3** (2026-10-09). Images `verapdf/cli:v1.30.3` (about 54 MB) and `verapdf/rest` (about 75 MB; latest tag v1.30.2). Mustang `validate` checks PDF/A, XMP and XML together for hybrid PDFs.
- **Portals (manual checks):**
  - **E-Rechnungs-Validator** of Serviceportal Baden-Württemberg: https://erechnungsvalidator.service-bw.de/ (KoSIT rules, free, no signup). I could not read its details.
  - Vendor portals such as b2brouter and ecosio.

Sources: [KoSIT daemon docs](https://github.com/itplr-kosit/validator/blob/main/docs/daemon.md), [KoSIT CLI docs](https://github.com/itplr-kosit/validator/blob/main/docs/cli.md), [config repo](https://github.com/itplr-kosit/validator-configuration-xrechnung), [apps4everything image](https://hub.docker.com/r/apps4everything/kosit-validator-xrechnung), [flx235 image](https://hub.docker.com/r/flx235/xr-validator-service), [exsemt image](https://hub.docker.com/r/exsemt/xrechnung-kosit-validator), [easybill validator](https://github.com/easybill/e-invoice-validator), [nordflux on KoSIT errors](https://nordflux.de/en/insights/xrechnung-validator-schematron-fehler), [verapdf/cli](https://hub.docker.com/r/verapdf/cli)

---

## 7. Parsing incoming XRechnung/ZUGFeRD

**Detecting the format**
- XML root `Invoice` / `CreditNote` (UBL namespace) means UBL.
- `rsm:CrossIndustryInvoice` means CII.
- A PDF means extracting `factur-x.xml`, `zugferd-invoice.xml` (ZF 2.0), `ZUGFeRD-invoice.xml` (ZF 1) or `xrechnung.xml`.
- Then read BT-24 (`GuidelineSpecifiedDocumentContextParameter/ID` or `CustomizationID`) to get the profile.

**Extracting attachments**
- `pdfjs-dist` **6.4.299** (2026-10-03, Apache-2.0, **Node >= 22.13**):
  ```ts
  import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
  const doc = await getDocument({ data: new Uint8Array(buf) }).promise;
  const atts = await doc.getAttachments();          // { [name]: { filename, content: Uint8Array } }
  const hit = Object.values(atts ?? {}).find(a => /^(factur-x|zugferd-invoice|xrechnung)\.xml$/i.test(a.filename));
  ```
- `@cantoo/pdf-lib`: `PDFDocument.load(buf).then(d => d.getAttachments())` returns `[{ name, data }]`.
- Upstream pdf-lib has no public extraction API; you would have to walk `/Names /EmbeddedFiles` by hand.

**Parsing XML**
- `fast-xml-parser` **5.11.2** (2026-09-29, MIT, 84M/week).
- Use `new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, isArray: (n) => LIST_TAGS.has(n), parseTagValue: false })`.
- Keep `parseTagValue: false` so amounts and IDs stay strings (no float or leading-zero loss), and force arrays for repeating groups (lines, VAT breakdown).
- For XSD checks use `libxml2-wasm` or `xmllint-wasm`. For Schematron in Node, use the KoSIT sidecar instead.

**Visualization**
- KoSIT **xrechnung-visualization v2026-08-31** contains:
  - `xsl/ubl-invoice-xr.xsl`, `ubl-creditnote-xr.xsl` and `cii-xr.xsl`, which turn UBL/CII into an intermediate XR format
  - `xsl/xrechnung-html.xsl` (XR to HTML)
  - `xsl/xr-pdf.xsl` (XSL-FO for Apache FOP)
- Run it with either:
  - **Saxon-JS:** `saxon-js` / `xslt3` 2.7.0 (2024-10), or `saxonjs-he` / `xslt3-he` **3.0.0-beta2** (2025-06). Both use a **proprietary Saxonica license**: free to use and redistribute in binary form, not OSS.
    ```bash
    npx xslt3 -t -xsl:xsl/ubl-invoice-xr.xsl -export:ubl-xr.sef.json -nogo
    npx xslt3 -t -xsl:xsl/xrechnung-html.xsl -export:xr-html.sef.json -nogo
    ```
    ```ts
    const xr = SaxonJS.transform({ stylesheetFileName: 'ubl-xr.sef.json', sourceText: xml, destination: 'serialized' }).principalResult;
    const html = SaxonJS.transform({ stylesheetFileName: 'xr-html.sef.json', sourceText: xr, destination: 'serialized' }).principalResult;
    ```
    I have not confirmed that the KoSIT XSLTs compile cleanly under Saxon-JS. They target Saxon-HE (Java). Test early.
  - **Mustang `--action visualize`** (Java sidecar).
- **Commercial-friendly fallback:** render your own React view from the parsed model.

---

## Key caveats
- `pdf-lib` upstream has had no release since Nov 2021. Prefer `@cantoo/pdf-lib`; `@e-invoice-eu/core` already depends on it.
- Every JS PDF/A helper adds only the structural parts. Font embedding and clean content are your job, and veraPDF plus Mustang have the final say.
- License flags: `@stackforge-eu/factur-x` is **EUPL-1.2** (copyleft), Saxon-JS is proprietary freeware, `@e-invoice-eu/*` is WTFPL.
- Plan for the 2027 changes: XRechnung 4.0 / EN 16931-1:2026, with the bundle due spring 2027. ZUGFeRD now updates twice a year to track code lists, so pin validator config versions and update them on a schedule.

# Compliance Requirements for German Small-Business Invoicing and Bookkeeping Software (as of 12 October 2026)

**How to read this report**
- Each rule follows the same pattern: **Rule → Legal basis → Software requirement (REQ) → Test**.
- Status tags:
  - **[VERIFIED]**: checked against the statute text or an official source during this research.
  - **[CHANGED 2025]** / **[CHANGED 2026]**: changed recently.
  - **[UPCOMING]**: enacted or announced but not yet in force.
  - **[DRAFT]**: only a bill or discussion draft.
  - **[UNSURE]**: I could not confirm this from a primary source. Check it before you build on it.
- Randziffer (Rz.) references to the GoBD and the BMF E-Rechnung letter come partly from memory where the official PDF could not be fetched (bundesfinanzministerium.de returned HTTP 503 during the research). Treat those as approximate.
- This is a technical requirements analysis, not tax or legal advice. Have a Steuerberater sign off on the final spec.

---

## 0. Corrections to assumptions in the brief, and recent changes

| # | Topic | Finding |
|---|---|---|
| 1 | ZUGFeRD profiles | **BASIC is valid.** Only **MINIMUM and BASIC-WL** are not E-Rechnungen. Valid profiles are BASIC, EN 16931 (COMFORT), EXTENDED and XRECHNUNG, for ZUGFeRD from version 2.0.1 (BMF FAQ; BMF 15.10.2025). [VERIFIED via secondary sources quoting the BMF] |
| 2 | ZUGFeRD version | The current version is **ZUGFeRD 2.5 / Factur-X 1.09**, published 10.06.2026 and applicable from 01.07.2026. Corrigendum **2.5.2** followed (FeRD page dated 04.08.2026). 2.4 applied from 15.01.2026. Earlier 2.x versions stay usable as long as they conform to EN 16931. The next version is expected in autumn 2026 and should support gross-price invoices. [CHANGED 2026] |
| 3 | XRechnung version | **3.0.2** is current. The latest bugfix bundle is "Summer 2026 Bugfix", valid from 31.08.2026. 3.0 stays in force **until at least 31.07.2027**. A **4.0 pre-version** was published 15.09.2026. It implements EN 16931-1:2026, is not backward compatible, and the final release is expected in spring 2027. [VERIFIED, xeinkauf.de] [UPCOMING] |
| 4 | Second BMF E-Rechnung letter | **BMF 15.10.2025**, III C 2 – S 7287-a/00019/007/243. It replaces and extends the letter of 15.10.2024. It adds error categories (Formatfehler, Geschäftsregelfehler, Inhaltsfehler), states the role of validation, and says that price reductions under §17 UStG do not require a corrected invoice. [CHANGED 2025] |
| 5 | GoBD | The base text is BMF 28.11.2019, amended **11.03.2024** and **14.07.2025**. The 2025 amendment says keeping only the structured part of an E-Rechnung is enough. For outgoing invoices, no image copy is needed if a content-identical copy can be reproduced. No 2026 rewrite was found. [VERIFIED] |
| 6 | Kleinunternehmer and E-Rechnung | Kleinunternehmer are **permanently** exempt from issuing E-Rechnungen (§34a Satz 4 UStDV), not just during the transition. They **must still be able to receive** them. [VERIFIED] |
| 7 | Kleinunternehmer showing VAT | Since 2025 the supply is tax-exempt. VAT shown by mistake is therefore owed under **§14c Abs. 1** (unrichtiger Ausweis), not Abs. 2 (BMF 18.03.2025). [CHANGED 2025] |
| 8 | Ist-Versteuerer | From **01.01.2028** a new mandatory invoice item applies: "Versteuerung nach vereinnahmten Entgelten" (§14 Abs. 4 Satz 1 Nr. 6a UStG new, Art. 27 JStG 2024; also on Kleinbetragsrechnungen and Fahrausweise). Customers may then deduct input VAT only once they have paid. [UPCOMING, enacted; exact final wording UNSURE] |
| 9 | Restaurant food | **7% from 01.01.2026** for restaurant and catering services, drinks excluded (§12 Abs. 2 Nr. 15 UStG, StÄndG 2025, BGBl. 2025 I Nr. 363). [CHANGED 2026] |
| 10 | Basiszinssatz | **1.52% since 01.07.2026** (1.27% before). [VERIFIED, Bundesbank] |
| 11 | UStVA thresholds | Monthly filing if prior-year tax was **> 9,000 €**. The Finanzamt can waive filing if it was **≤ 2,000 €** (BEG IV, from 2025). [VERIFIED] |
| 12 | Retention | **Buchungsbelege, including invoices: 8 years** (§147 Abs. 3 AO, §257 HGB, §14b UStG; BEG IV, from 01.01.2025). [VERIFIED] |
| 13 | Kassenpflicht | A draft would require an electronic recording system above **100,000 €** total turnover, generally from **01.01.2028** (referentenentwurf dated 07.08.2026). [DRAFT] |
| 14 | DSFinV-BV (§147b AO) | Standardised bookkeeping data export. Revised discussion draft April 2026. It would apply at the earliest on 31 December of the third year after promulgation, i.e. around end of 2029. [DRAFT] |
| 15 | KassenSichV | Second amendment in force 01.02.2026 (BGBl. 2026 I Nr. 10). An **E-Rechnung can carry the Kassenbeleg data** and replace the separate receipt. App-based systems are explicitly covered. [CHANGED 2026] |
| 16 | USt-IdNr check | BZSt eVatR moved to a **REST API** (July 2025). The XML-RPC interface was switched off on 30.11.2025. [CHANGED 2025; endpoint details UNSURE] |
| 17 | SEPA | **Verification of Payee** has been mandatory since 09.10.2025 (Reg. (EU) 2024/886). The payee name on invoices and in QR codes should match the account holder name. [CHANGED 2025] |
| 18 | Depreciation | **Degressive AfA of 30%** (max. 3× linear) for movable assets bought **01.07.2025–31.12.2027**. **75% special AfA** for e-vehicles (§7 Abs. 2a EStG). [CHANGED 2025] |
| 19 | GWG | Still **800 €**. The Bundesrat (25.09.2026) proposes 1,200 € and abolishing the Sammelposten for assets acquired after 31.12.2026, via the JStG 2026. The government only agreed to "examine" it. The Bundestag vote is expected around 13.11.2026. [DRAFT] |
| 20 | Bewirtung | **BMF 19.11.2025** on Bewirtungsbelege, including E-Rechnung and fully digital records. [CHANGED 2025] |
| 21 | ViDA | Dir. (EU) 2025/516: from **01.07.2030** mandatory E-Rechnung plus digital reporting for intra-EU B2B. This replaces the Zusammenfassende Meldung. [UPCOMING] |

---

## 1. Key dates timeline

| Date | Event | Basis |
|---|---|---|
| 01.01.2017 | Kleinbetragsrechnung threshold 250 € gross | §33 UStDV |
| 01.01.2023 | 0% rate for photovoltaics | §12 Abs. 3 UStG |
| 01.01.2024 | Ist-Versteuerung threshold 800k €; §141 AO thresholds 800k € / 80k € | Wachstumschancengesetz |
| 01.01.2025 | All domestic businesses must be able to **receive** E-Rechnungen; new Kleinunternehmer rules (25k € / 100k €); 8-year retention for vouchers; UStVA thresholds 9k € / 2k €; ELSTER notification for cash systems (§146a Abs. 4 AO) | WtChG, JStG 2024, BEG IV |
| 31.07.2025 | Deadline to notify cash systems acquired before 01.07.2025 | BMF 28.06.2024 |
| 01.07.2025 | Degressive AfA 30% starts | Investitionssofortprogramm |
| 14.07.2025 | GoBD second amendment | BMF |
| 09.10.2025 | Verification of Payee in force | Reg. (EU) 2024/886 |
| 15.10.2025 | Second BMF E-Rechnung letter | BMF |
| 30.11.2025 | eVatR XML-RPC switched off | BZSt [UNSURE] |
| 01.01.2026 | 7% on restaurant food | StÄndG 2025 |
| 01.02.2026 | KassenSichV amendment | BGBl. 2026 I Nr. 10 |
| 01.07.2026 | ZUGFeRD 2.5 applies; Basiszinssatz 1.52% | FeRD, Bundesbank |
| 31.12.2026 | End of free choice: paper or (with consent) PDF still allowed for supplies made through 2026 | §27 Abs. 38 Nr. 1 UStG |
| 01.01.2027 | **E-Rechnung issuing mandatory** if the issuer's 2026 Gesamtumsatz was > 800k €. Neugründer monthly UStVA suspension expires unless extended [UNSURE] | §27 Abs. 38 Nr. 2 UStG; §18 Abs. 2 UStG |
| 31.07.2027 | XRechnung 3.0 guaranteed in force until at least this date | KoSIT |
| 31.12.2027 | End of transition for issuers ≤ 800k € and for EDI | §27 Abs. 38 Nr. 2, 3 UStG |
| 01.01.2028 | **E-Rechnung mandatory for all** (Kleinunternehmer, Kleinbetrag and Fahrausweis excepted); Ist-Versteuerer invoice note and payment-based input VAT deduction; Kassenpflicht [DRAFT] | §14 UStG; JStG 2024 Art. 27; draft |
| 01.07.2030 | ViDA intra-EU e-invoicing and reporting | Dir. 2025/516 |

---

## 2. Umsatzsteuer: invoice content and special cases

### 2.1 When an invoice must be issued, and the deadline

**UST-01 Obligation and 6-month deadline**
- **Basis:** §14 Abs. 2 Satz 1 Nr. 1–3 UStG. Fines up to 5,000 € under §26a Abs. 2 Nr. 1 UStG.
  - An invoice is mandatory within **6 months** for B2B supplies, for supplies to legal persons, and for Werklieferungen or services connected with real estate supplied to anyone.
  - Supplies exempt under §4 Nr. 8–29 UStG are excluded.
- **REQ:**
  - Track the date of supply for every delivery or job.
  - Raise an "uninvoiced supply" warning at day 150 and an escalation at day 180.
  - Invoices for B2C property services must carry the §14 Abs. 4 Nr. 9 retention note (see UST-12).
- **Test:** Create a supply dated T−151 days with no invoice. The warning must appear. At T−181 days the escalation must appear.

**UST-02 Deadline for intra-EU invoices: 15th of the following month**
- **Basis:** §14a Abs. 1 and Abs. 3 UStG.
- **REQ:** For EU B2B services (§3a Abs. 2) and intra-Community supplies (§6a), compute the due date as the 15th day of the month after the supply. Warn before it.
- **Test:** Supply on 31.03. The deadline must show as 15.04.

### 2.2 Mandatory items on a standard invoice (§14 Abs. 4 UStG)

**UST-03 Full name and address of supplier and recipient** [VERIFIED]
- **Basis:** §14 Abs. 4 Satz 1 Nr. 1 UStG; §31 Abs. 2–3 UStDV.
  - A P.O. box is accepted as the address (UStAE 14.5 Abs. 2).
  - Abbreviations are allowed only if their meaning is defined in documents both parties hold.
- **REQ:**
  - Required fields: supplier legal name, street or P.O. box, postcode, city, country; recipient name and address.
  - Block finalisation if any is missing.
  - Store the address as a snapshot on the invoice, so later changes to the customer record do not change issued invoices.
- **Test:**
  - Finalise with an empty recipient street. It must be blocked.
  - Change the customer address after finalisation. The issued invoice and its PDF/XML must be unchanged.

**UST-04 Supplier Steuernummer or USt-IdNr**
- **Basis:** §14 Abs. 4 Satz 1 Nr. 2 UStG.
  - One of the two is enough.
  - For §14a cases the USt-IdNr of both parties is mandatory (see UST-20 and UST-21).
  - Kleinunternehmer may alternatively show the Kleinunternehmer-ID (§34a Nr. 2 UStDV).
- **REQ:**
  - Company settings hold the Steuernummer and USt-IdNr.
  - The invoice shows at least one. If both exist, show the USt-IdNr; this is a recommendation because it exposes less data.
  - Validate the format:
    - USt-IdNr: `DE` followed by 9 digits, with the ISO 7064 MOD 11,10 check digit.
    - Steuernummer: accept the regional 10–11 digit format and the 13-digit ELSTER format, and store both.
- **Test:**
  - `DE123456789` with a wrong check digit must be rejected.
  - An invoice without either number must be blocked.

**UST-05 Invoice date**
- **Basis:** §14 Abs. 4 Satz 1 Nr. 3 UStG.
- **REQ:**
  - The invoice date is set at finalisation.
  - It may not be later than today.
  - Backdating beyond a configurable window (default 10 days) requires a reason, which goes into the audit log (GoBD timeliness, see GOBD-05).
- **Test:** Try to finalise with a date tomorrow. It must be blocked.

**UST-06 Unique invoice number and number ranges**
- **Basis:** §14 Abs. 4 Satz 1 Nr. 4 UStG ("fortlaufende Nummer mit einer oder mehreren Zahlenreihen … einmalig vergeben"); UStAE 14.5 Abs. 10–13.
  - Several separate number ranges are allowed (per year, location or document type).
  - Alphanumeric numbers are allowed.
  - A gap-free sequence is **not** required for VAT purposes. Unexplained gaps can still raise questions in a Betriebsprüfung (GoBD: completeness).
  - For a Gutschrift (self-billing), the issuer, i.e. the customer, assigns the number.
- **REQ:**
  - Configurable number ranges: prefix pattern such as `{YYYY}-{#####}`, scope (global, per year, per document type), next value.
  - Numbers are assigned **atomically at finalisation**, never to drafts.
  - Numbers are never reused, including after a void or storno.
  - Uniqueness is enforced across all ranges with a DB unique constraint on the normalised number.
  - A yearly reset is allowed only if the year is part of the number.
  - Limit numbers to ≤ 36 characters from `[A-Za-z0-9$%&*+\-/]` so they fit DATEV Belegfeld 1 (see DATEV-04).
  - Keep a register of every number assigned, with status (issued, cancelled by storno).
- **Test:**
  - Finalise 1,000 invoices in parallel. There must be no duplicates.
  - Delete a draft. No number may be consumed.
  - Change the range prefix so it collides with an existing number. It must be rejected.

**UST-07 Quantity and description of goods or services**
- **Basis:** §14 Abs. 4 Satz 1 Nr. 5 UStG ("Menge und Art (handelsübliche Bezeichnung)", "Umfang und Art der sonstigen Leistung").
  - Generic texts such as "Beratung" or "Waren" put the customer's input VAT deduction at risk.
- **REQ:**
  - Each line has quantity, unit (UN/ECE Rec. 20 code for the E-Rechnung) and description.
  - Warn on a short list of generic-only descriptions such as "Leistung", "Diverses" or "Pauschale".
- **Test:** A line with description "Diverses" must produce a warning.

**UST-08 Date of supply or service period** [VERIFIED]
- **Basis:**
  - §14 Abs. 4 Satz 1 Nr. 6 UStG.
  - §31 Abs. 4 UStDV: the calendar month is enough.
  - UStAE 14.5 Abs. 16: if the supply date equals the invoice date, it must still be stated, e.g. "Leistungsdatum entspricht Rechnungsdatum".
  - For an advance-payment invoice: the date the payment is received, if it is known and differs from the invoice date.
- **REQ:**
  - Mandatory field: either a single date, a period (from–to), or a month.
  - Always print it, also when it equals the invoice date.
  - E-Rechnung: always fill BT-72 (Actual delivery date) or BG-14 (BT-73/74 Invoicing period).
- **Test:**
  - An invoice without a supply date must be blocked.
  - The generated XML must contain BT-72 or BG-14.

**UST-09 Net amount by tax rate, plus agreed reductions**
- **Basis:** §14 Abs. 4 Satz 1 Nr. 7 UStG.
  - Show the Entgelt broken down by tax rate and exemption.
  - Show every agreed reduction not already included, such as Skonto, Boni or Rabatte. A reference such as "2 % Skonto bei Zahlung bis …" is enough (UStAE 14.5 Abs. 19).
- **REQ:**
  - A VAT summary block per rate or exemption category: net, rate, VAT amount.
  - Skonto terms printed. In XRechnung BT-20 use the KoSIT syntax `#SKONTO#TAGE=14#PROZENT=2.00#` (optionally `BASISBETRAG=`).
- **Test:**
  - An invoice with 19% and 7% lines must show two summary rows.
  - The Skonto string must validate against the KoSIT rules.

**UST-10 Rate and tax amount, or exemption note**
- **Basis:** §14 Abs. 4 Satz 1 Nr. 8 UStG; §12 UStG.
- **REQ:**
  - Each line has a VAT category: Standard 19%, Reduced 7%, Zero 0% (PV), Exempt (with reason), Reverse charge, Intra-Community, Export, Not taxable in Germany, Kleinunternehmer.
  - Map these to UNCL5305 codes S, AA*, Z, E, AE, K, G, O. Note: in EN 16931/XRechnung the reduced rate is also category **S** with rate 7. Exemptions use E plus BT-120/121 VATEX codes.
  - Compute VAT per category on the sum of line net amounts, round half-up to 2 decimals. This is the EN 16931 BR-CO-17 logic, so PDF and XML always match.
  - Every non-standard category automatically prints the right legal note (see 2.4).
- **Test:**
  - Golden-file tests: 3 lines at 19% with nets 10.005 / 10.005 / 10.005. Line nets round to 10.01 each; category net 30.03 → VAT 5.71. Compare PDF and XML.
  - A line with category K must print the exemption text and both VAT IDs.

**UST-11 The word "Gutschrift" on self-billing invoices**
- **Basis:** §14 Abs. 4 Satz 1 Nr. 10 and §14 Abs. 2 Satz 5 UStG; UStAE 14.5 Abs. 24 (equivalents in other EU languages are accepted, e.g. "Self-billing", "Autofacturation").
- **REQ:** Document type "Umsatzsteuerliche Gutschrift (Self-billing)" always prints "Gutschrift". In the E-Rechnung use TypeCode 389.
- **Test:** A self-billing document without the word "Gutschrift" must be impossible to produce.

**UST-12 Retention note for private recipients of property services**
- **Basis:** §14 Abs. 4 Satz 1 Nr. 9 with §14b Abs. 1 Satz 5 UStG: a private recipient must keep the invoice 2 years.
- **REQ:**
  - Flag "Leistung im Zusammenhang mit einem Grundstück" plus customer type = consumer.
  - The note is then printed automatically, e.g. "Sie sind gesetzlich verpflichtet, diese Rechnung zwei Jahre lang aufzubewahren (§ 14b Abs. 1 Satz 5 UStG)."
- **Test:** A B2C invoice with the property flag must contain the text.

**UST-13 Ist-Versteuerer note** [UPCOMING 01.01.2028]
- **Basis:** §14 Abs. 4 Satz 1 Nr. 6a UStG new (Art. 27 JStG 2024), also §§33, 34 UStDV. Text: "Versteuerung nach vereinnahmten Entgelten".
- **REQ:**
  - Company setting: taxation method Soll or Ist (see UVA-06).
  - From invoice dates ≥ 01.01.2028, Ist-taxing companies print the note on **all** invoices, including Kleinbetragsrechnungen.
  - Implement it behind a date-effective rule engine so the switch is pure configuration.
- **Test:**
  - Ist-taxing company, invoice dated 31.12.2027: no note.
  - Invoice dated 02.01.2028: note present, also in the XML (BT-22 note or a dedicated field per future FeRD/KoSIT guidance [UNSURE]).

**UST-14 Simplifications for Kleinbetragsrechnung** [VERIFIED]
- **Basis:** §33 UStDV, threshold **250 € gross (Gesamtbetrag)**, unchanged since 01.01.2017.
  - Minimum content: supplier name and address, issue date, quantity/description, gross amount and tax amount in one sum, and the rate or exemption note.
  - **No** recipient, no invoice number, no supply date and no tax number are required.
  - Not usable for §3c distance sales, §6a intra-Community supplies or §13b reverse charge.
  - May always be sent as a "sonstige Rechnung" (no E-Rechnung obligation).
- **REQ:**
  - Optional "Kleinbetragsrechnung" mode, allowed only if gross ≤ 250.00 € and the category is not K/AE/§3c.
  - Recommendation: still assign a number and keep full data (GoBD voucher identification).
- **Test:**
  - Gross 250.00 €: allowed. 250.01 €: blocked.
  - Category K: blocked.

**UST-15 Rates (19 / 7 / 0)** [VERIFIED]
- **Basis:** §12 Abs. 1 UStG (19%); §12 Abs. 2 with Anlage 2 (7%); §12 Abs. 2 Nr. 15 (restaurant food 7% from 01.01.2026, drinks 19%); §12 Abs. 3 UStG (0% PV).
  - The 0% PV rate covers supply and installation of PV modules, essential components and storage to the operator.
  - It applies to installations on or near private homes and public-benefit buildings. This is deemed met at ≤ 30 kWp gross per Marktstammdatenregister.
- **REQ:**
  - A tax-rate table with validity periods (valid_from/valid_to). The rate is chosen by **date of supply**, not invoice date.
  - 0% is "Z", a taxable supply at a zero rate; it is not an exemption. UStVA Kz 87 [UNSURE about the exact Kennzahl, check the current form].
  - A PV assistant asks for the kWp and the operator confirmation.
- **Test:**
  - Catering supplied 31.12.2025 → 19%. Supplied 01.01.2026 → 7% food, 19% drinks.
  - PV, 0%: XML category Z, rate 0.

### 2.3 Kleinunternehmer (§19 UStG, reformed 2025)

**KU-01 Thresholds and hard cap** [VERIFIED] [CHANGED 2025]
- **Basis:** §19 Abs. 1 UStG.
  - Supplies are tax-exempt if the prior-year Gesamtumsatz was ≤ **25,000 €** **and** the current-year Gesamtumsatz does not exceed **100,000 €**.
  - Both are net amounts, based on vereinnahmte Entgelte (§19 Abs. 2).
  - Exceeding 100,000 € ends the status **immediately**: the supply that crosses the line is already taxable (BMF 18.03.2025, UStAE 19.1).
  - In the founding year the limit is **25,000 €**.
  - Assets sold from fixed assets are excluded from Gesamtumsatz.
- **REQ:**
  - A live dashboard of Gesamtumsatz for the current and previous year.
  - Warnings at 80% and 95% of 25k € (prior-year test, relevant for next year) and of 100k €.
  - Before finalising an invoice that would push the cumulative figure over the limit, show a blocking dialog and switch that invoice and all following ones to standard taxation.
  - The founding year uses 25k € as the hard cap.
  - **[UNSURE]** Edge cases (advance payments, the paid-vs-invoiced timing) must follow UStAE 19.1. Confirm the algorithm with a Steuerberater.
- **Test:**
  - Simulate cumulative 99,500 € plus a new invoice of 1,000 €. That invoice must be issued with VAT.
  - Founding-year company at 24,900 € plus 200 € → the 200 € invoice is taxable.

**KU-02 Invoice content for Kleinunternehmer** [VERIFIED]
- **Basis:** §34a UStDV. Required:
  1. Name and address of supplier and recipient
  2. Steuernummer, USt-IdNr or Kleinunternehmer-ID
  3. Issue date
  4. Quantity/description
  5. Total amount **plus a note that the Kleinunternehmer exemption under §19 UStG applies**
  6. "Gutschrift" where relevant

  **No invoice number and no supply date are required by VAT law.** §§33 and 34 UStDV stay applicable. The invoice may always be sent as a sonstige Rechnung.
- **REQ:**
  - KU mode hides VAT columns.
  - Prints a configurable note. Default: "Steuerfreie Leistung gemäß § 19 Abs. 1 UStG (Kleinunternehmerregelung)."
  - Still assigns numbers and supply dates, because GoBD voucher identification and receivables matching need them.
  - E-Rechnung (optional): VAT category E with exemption reason text; check the VATEX code per KoSIT guidance [UNSURE].
- **Test:** A KU invoice must contain no VAT amount, must contain the §19 note, and its XML (if generated) must validate.

**KU-03 Showing VAT by mistake**
- **Basis:** §14c Abs. 1 UStG (since 2025, BMF 18.03.2025). The VAT is owed until corrected.
- **REQ:** In KU mode a VAT rate other than "KU" cannot be selected. A manual override needs a confirmation and an audit-log entry.
- **Test:** The API call to create a KU invoice with 19% must be rejected.

**KU-04 Waiver (Option)**
- **Basis:** §19 Abs. 3 UStG: the waiver is irrevocable for 5 years and can be declared until end of February of the second following year.
- **REQ:** Settings store the KU status with effective dates and the waiver date. A switch-back is blocked during the 5-year lock unless overridden with a documented reason.
- **Test:** Waiver in 2025. Switching back in 2027 must be blocked or warned.

**KU-05 No UStVA or annual return; EU Kleinunternehmer**
- **Basis:** §19 Abs. 1 Satz 4 UStG: §18 Abs. 1–4 not applicable (exceptions: §18 Abs. 4a, §149 AO on request). §19 Abs. 4–5 and §19a UStG: EU-wide 100k € limit, special procedure, Kleinunternehmer-ID.
- **REQ:**
  - KU mode disables UStVA generation, unless there are §13b liabilities (§18 Abs. 4a, reverse charge received).
  - Optional §19a fields: Kleinunternehmer-ID, EU-wide turnover per member state for quarterly reporting to the BZSt [UNSURE about exact reporting data].
- **Test:** In KU mode with a §13b purchase, the software must still offer the UStVA for the §13b tax.

### 2.4 Special cases (§14a UStG and related)

**UST-20 EU B2B service (reverse charge in the other member state)** [VERIFIED]
- **Basis:** §3a Abs. 2 UStG; §14a Abs. 1 UStG.
  - Text "Steuerschuldnerschaft des Leistungsempfängers".
  - USt-IdNr of supplier **and** customer.
  - Deadline: 15th of the following month.
  - Zusammenfassende Meldung (§18a). UStVA Kz 21.
- **REQ:**
  - Category "EU-B2B-Leistung": requires a validated customer USt-IdNr from a non-German member state (see MISC-04).
  - Auto-text: "Steuerschuldnerschaft des Leistungsempfängers / Reverse charge".
  - No VAT.
  - XML category AE with VATEX-EU-AE.
- **Test:**
  - Missing customer USt-IdNr: blocked.
  - The PDF must contain the exact German wording and both IDs.

**UST-21 Intra-Community supply of goods**
- **Basis:** §4 Nr. 1b, §6a UStG; §14a Abs. 3 UStG; §17a–17b UStDV (Gelangensbestätigung) and Art. 45a MwStVO (proof of transport).
  - Since 2020 a valid USt-IdNr used by the customer and a correct ZM are substantive conditions (§6a Abs. 1 Nr. 4; §4 Nr. 1b with §18a).
- **REQ:**
  - Category K: auto-text "Steuerfreie innergemeinschaftliche Lieferung (§ 4 Nr. 1b, § 6a UStG)". Both VAT IDs. VATEX-EU-IC.
  - Attach proof of transport (Gelangensbestätigung or CMR) as a linked document.
  - Feeds the ZM and UStVA Kz 41.
- **Test:**
  - A K invoice without a proof attachment gets a warning flag.
  - It must appear in the ZM export.

**UST-22 Domestic reverse charge (§13b)**
- **Basis:** §13b Abs. 2 and 5 UStG; §14a Abs. 5 UStG.
  - Covers construction services to construction businesses, building cleaning, metals, mobile phones/tablets/ICs ≥ 5,000 €, scrap, gas/electricity to resellers, and services from foreign businesses.
  - Text "Steuerschuldnerschaft des Leistungsempfängers"; no VAT shown.
  - JStG 2026 draft adds emission certificates under §3 Nr. 8 TEHG from 01.01.2027 [DRAFT].
- **REQ:**
  - Category "§13b Inland": auto-text, no VAT, XML AE.
  - The customer record stores construction-business proof (Bescheinigung USt 1 TG) with an expiry date.
  - Feeds UStVA Kz 60.
- **Test:** Choosing §13b for a customer without a valid USt 1 TG gives a warning. The invoice must show 0 VAT and the text.

**UST-23 Third countries**
- **Basis:** §4 Nr. 1a, §6 UStG (export of goods; Ausfuhrnachweis §§8–11 UStDV, ATLAS exit note); §3a Abs. 2 UStG (B2B service to a non-EU customer is not taxable in Germany).
- **REQ:**
  - Category G: auto-text "Steuerfreie Ausfuhrlieferung (§ 4 Nr. 1a, § 6 UStG)"; attach the export proof; UStVA Kz 43.
  - Category "nicht im Inland steuerbar": auto-text "Nicht im Inland steuerbare Leistung (§ 3a Abs. 2 UStG)"; XML O; UStVA Kz 45.
- **Test:** Export invoice: VAT 0, text present, Kz 43 populated.

**UST-24 Other §14a texts**
- **Basis:** §14a Abs. 6 UStG:
  - "Sonderregelung für Reisebüros" (§25)
  - "Gebrauchtgegenstände/Sonderregelung", "Kunstgegenstände/Sonderregelung", "Sammlungsstücke und Antiquitäten/Sonderregelung" (§25a)

  §14a Abs. 7: triangular transaction note plus customer liability.
- **REQ:** Optional categories with fixed texts and no VAT shown. If out of scope for v1, explicitly block these use cases.
- **Test:** Margin-scheme invoice: no VAT line, exact text.

### 2.5 Corrections, storno, credit notes, §14c

**UST-30 Immutable after issue; correct only by document**
- **Basis:** §31 Abs. 5 UStDV (a correction document must reference the original specifically and unambiguously and meet invoice form requirements); §146 Abs. 4 AO; GoBD Rz. 58–60 and 107 ff.
- **REQ:**
  - Issued invoices are read-only.
  - Allowed actions:
    - **Rechnungsberichtigung**: a correction document referencing original number and date, containing the corrected or missing items.
    - **Storno plus new invoice**: a full negative mirror referencing the original, with its own number, then a new invoice.
  - In an E-Rechnung context, the correction is itself an E-Rechnung (TypeCode 384 corrected invoice or 381 credit note). BT-25/26 hold the preceding invoice reference.
- **Test:**
  - PUT on an issued invoice → HTTP 409.
  - A storno must have BT-25 equal to the original number, and the totals summed must be 0.

**UST-31 Retroactive correction (input VAT)**
- **Basis:** EuGH C-518/14 *Senatex*; BFH V R 26/15; UStAE 15.2a Abs. 7. A correction works retroactively if the original had minimum content: issuer, recipient, description, net amount and separately shown VAT.
- **REQ:** Prefer a Berichtigung (keeps the original date) over storno plus re-issue when only formal items are missing. The UI explains the difference.
- **Test:** Documentation and UI-text review.

**UST-32 Price reductions (Skonto, discount, complaint)**
- **Basis:** §17 UStG; BMF 15.10.2025 Rz. 51a–51b. A mere reduction of the tax base does **not** require a corrected invoice. A change in the scope or nature of the supply does, as a new E-Rechnung.
- **REQ:**
  - Record payment differences (Skonto) as payment-level adjustments with a VAT correction in the books, without creating an invoice document.
  - Changes to scope go through UST-30.
- **Test:** A Skonto payment reduces output VAT in the UStVA for the payment period. No new invoice number is consumed.

**UST-33 Kaufmännische vs. umsatzsteuerliche Gutschrift**
- **Basis:** §14 Abs. 2 Satz 5, Abs. 4 Nr. 10 UStG; UStAE 14.3 Abs. 1. Calling a commercial credit note "Gutschrift" is not harmful according to the administration, but it is confusing.
- **REQ:**
  - Separate document types:
    - "Rechnungskorrektur / Korrekturrechnung" for commercial credit notes. Never label it "Gutschrift".
    - "Gutschrift" only for self-billing. This requires a stored self-billing agreement with the supplier (date, scope) and supports the recipient's objection (Widerspruch), which makes it lose effect.
- **Test:** A commercial credit note PDF does not contain the word "Gutschrift". A self-billing document cannot be created without an agreement record.

**UST-34 §14c: incorrect or unauthorised VAT**
- **Basis:** §14c Abs. 1 UStG (too high, or VAT on an exempt or KU supply → owed until corrected via §17 analogous); §14c Abs. 2 UStG (unauthorised: no supply, non-entrepreneur → correction only after the tax risk is removed, with an application to the Finanzamt). B2C nuance: EuGH C-378/21; BMF 27.02.2024.
- **REQ:**
  - Prevent VAT on categories E/K/AE/G/O/KU.
  - Copies are marked "Kopie/Duplikat". Two originals for the same supply would trigger §14c (UStAE 14c.1 Abs. 4).
  - Report "§14c-Beträge" separately (UStVA Kz 69).
- **Test:** A re-download of a PDF must carry "Kopie" if it is not the first issue. The original artifact is preserved byte-identical.

### 2.6 Advance, partial and final invoices

**UST-40 Advance and partial invoices**
- **Basis:**
  - §14 Abs. 5 UStG.
  - §13 Abs. 1 Nr. 1a Satz 4 UStG: under Sollversteuerung, tax arises when an advance payment is received.
  - §14 Abs. 4 Nr. 6: show the payment date if known.
  - UStAE 14.8.
  - Under the E-Rechnung rules, advance and final invoices must also be E-Rechnungen. XRechnung TypeCodes: 326 partial, 875–877 for construction [UNSURE about the allowed code list in BR-DE-17; check against the KoSIT spec].
- **REQ:**
  - Document type "Abschlagsrechnung", linked to a project or order.
  - Tax is reported when the payment is received (for Soll-taxing companies too), not when the invoice is issued, unless the supply is already performed.
- **Test:** Soll-taxing company: an advance invoice issued in March and paid in April → VAT appears in the April UStVA.

**UST-41 Final invoice deducts advances correctly**
- **Basis:** §14 Abs. 5 Satz 2 UStG. Advances paid and the VAT on them must be deducted. If not, the full VAT is owed again under §14c Abs. 1 (UStAE 14.8 Abs. 10).
- **REQ:**
  - The final invoice shows the total supply (net, VAT per rate). Then for each advance, or in total: net and VAT deducted. Then the remaining amount.
  - If the rate changed between advance and supply (e.g. catering 19% → 7% on 01.01.2026), the final invoice applies the rate at the supply date to the total. Advances are deducted at their original rate. The difference corrects the tax.
- **Test (golden file):**
  - Contract 10,000.00 € net at 19%. Advance 3,000.00 + 570.00 = 3,570.00 paid.
  - Final invoice: total 10,000.00 / 1,900.00 / 11,900.00. Less 3,000.00 / 570.00. Remaining 7,000.00 / 1,330.00 / **8,330.00**.
  - XML: BT-113 (paid amount) = 3,570.00; BT-115 (due) = 8,330.00.
  - Rate-change test: advance 2025 for 1,000 net @19% (190). Supply 2026 @7%. Final: total 1,000 + 70. Less advance 1,000 + 190. Remaining net 0 and VAT −120: the customer gets 120 € back.

### 2.7 Retention of invoices

**UST-50 §14b retention**
- **Basis:** §14b Abs. 1 UStG: **8 years** from end of the calendar year of issue, since 01.01.2025 for all invoices whose period had not expired by 31.12.2024 (§27 Abs. 40 UStG).
  - Keep unchanged and readable.
  - An E-Rechnung must be kept in its structured form, at least the XML (BMF 15.10.2025 Rz. 60 f.).
  - Electronic storage in another EU state requires full online access (§14b Abs. 2) [UNSURE about the notification details].
- **REQ:** See GOBD-20 to GOBD-23 (retention engine).
- **Test:** An invoice dated 15.03.2018 has an earliest deletion date of 01.01.2027, if no Ablaufhemmung (suspension of expiry) applies.

---

## 3. E-Rechnung

### 3.1 Scope and timing

**ER-01 What counts as an E-Rechnung** [VERIFIED]
- **Basis:**
  - §14 Abs. 1 Satz 3–6 UStG: a structured electronic format that allows electronic processing, conforming to **EN 16931** (Directive 2014/55/EU).
  - Alternatively, a format agreed between the parties, if correct and complete data extraction compatible with EN 16931 is possible (§14 Abs. 1 Satz 6 Nr. 2).
  - Everything else (paper, PDF, image, Word) is a "sonstige Rechnung".
  - Recognised: **XRechnung** (UBL 2.1 or CII D16B) and **ZUGFeRD ≥ 2.0.1** in profiles **BASIC, EN 16931/COMFORT, EXTENDED, XRECHNUNG**. **Not** MINIMUM or BASIC-WL (BMF FAQ; BMF 15.10.2025).
  - **Hybrid:** the XML prevails over the PDF if they differ.
  - All mandatory items must be in the XML. References to attachments or links do not count (BMF 2025 Rz. 35).
- **REQ:**
  - Generate XRechnung 3.0.2 (UBL and CII selectable). CustomizationID `urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0`.
  - Generate ZUGFeRD 2.5.x / Factur-X 1.09 hybrid in profile **EN 16931** (default) or XRECHNUNG.
  - Never generate MINIMUM or BASIC-WL for invoices.
  - The PDF view is rendered **from the same data model** as the XML, so they cannot diverge.
- **Test:**
  - Each generated XML validates with zero errors in the KoSIT validator (XRechnung) or the FeRD Schematron (ZUGFeRD).
  - Snapshot test: every amount in the PDF text equals the XML.

**ER-02 Receiving obligation (since 01.01.2025)**
- **Basis:** §14 Abs. 1, 2 UStG; BMF letters. Every domestic business must be able to receive E-Rechnungen, including Kleinunternehmer and businesses with only exempt turnover. An e-mail inbox is enough for receipt.
- **REQ:**
  - Import XRechnung (UBL and CII) and ZUGFeRD/Factur-X PDFs: extract the embedded XML, detect the profile.
  - Render a human-readable view (e.g. KoSIT `xrechnung-visualization` XSLT).
  - Store the **original file byte-identical** with SHA-256 hash and receipt timestamp.
  - Run validation and store the validation report.
  - Pre-fill a purchase booking (supplier, net/VAT per rate, due date, IBAN).
  - Optional: IMAP mailbox polling.
- **Test:**
  - Import the KoSIT test suite instances (`xrechnung-testsuite`) and the FeRD sample files for all profiles. All parse and display.
  - MINIMUM/BASIC-WL files are flagged "keine E-Rechnung i.S.d. §14 UStG".

**ER-03 Issuing obligation and transition** [VERIFIED]
- **Basis:** §14 Abs. 2 Satz 2 Nr. 1 UStG; §27 Abs. 38 UStG.
  - Mandatory if supplier and recipient are both established in Germany, the recipient is a business acting for its business, and the supply is taxable or subject to invoicing. This includes supplies taxable by option under §9 (BMF 2025 Rz. 17).
  - Transition:
    - Supplies 2025–2026, invoiced by 31.12.2026: paper (no consent needed) or PDF/other electronic format (recipient consent needed).
    - Supplies in 2027: same option if the **issuer's Gesamtumsatz in 2026 was ≤ 800,000 €**; also EDI formats not meeting EN 16931 (until 31.12.2027).
    - From 01.01.2028: E-Rechnung mandatory.
  - Exceptions, permanent:
    - Kleinbetragsrechnung ≤ 250 € (§33 Satz 4 UStDV)
    - Fahrausweise (§34 Abs. 1 Satz 2 UStDV)
    - Kleinunternehmer (§34a Satz 4 UStDV)
    - B2C
    - Exempt supplies under §4 Nr. 8–29 with no invoicing obligation
  - In excepted cases, an E-Rechnung may still be sent **without consent** (BMF 2025 Rz. 22).
- **REQ:** A decision function `requiresERechnung(issuer, recipient, supply, invoiceDate)` that implements all of the above. Output: MUST_E / MAY_PAPER_OR_PDF / PDF_NEEDS_CONSENT. It is shown to the user and enforced at finalisation, with recipient consent stored per customer.
- **Test (table-driven):**
  - 2026, B2B DE→DE, 300 € → paper allowed.
  - 2027, issuer 2026 turnover 900k €, B2B DE→DE → MUST_E.
  - 2027, issuer 500k € → paper allowed.
  - 2028, B2B 249 € → Kleinbetrag, PDF allowed.
  - 2028, KU issuer → PDF allowed.
  - 2028, B2C → no obligation.
  - 2028, B2B, customer in Austria → no German E-Rechnung obligation.
  - 2028, rental with §9 option → MUST_E.

**ER-04 Special documents**
- **Basis:** BMF letters (Dauerschuldverhältnisse, Gutschrift, corrections). For continuing contracts (rent, maintenance), the contract plus one E-Rechnung covering the first period, or periodic E-Rechnungen, satisfy the rule. Self-billing must also be an E-Rechnung. Corrections of E-Rechnungen must be E-Rechnungen [details UNSURE without the BMF PDF; Rz. not verified].
- **REQ:** Recurring-invoice module creates E-Rechnungen for each period (recommended), or a single E-Rechnung referencing the contract with BT-12 (Contract reference).
- **Test:** A recurring monthly invoice produces valid XML each month with BG-14 period.

### 3.2 Format details and validation

**ER-10 XRechnung-specific business rules**
- **Basis:** XRechnung 3.0.2 CIUS (KoSIT).
  - BT-10 Buyer reference is mandatory (Leitweg-ID for B2G; for B2B any customer reference, BMF: missing BT-10 in B2B is not VAT-relevant).
  - Seller contact BT-41/42/43 (name, phone, e-mail) is mandatory.
  - BT-34/BT-49 electronic addresses are mandatory since 3.0.x.
  - Payment instructions (BG-16 to BG-19).
  - BR-DE rules (e.g. BR-DE-1 to BR-DE-xx).
- **REQ:** Seller master data: contact name, phone, e-mail, electronic address (scheme EM for e-mail or 0204 for Leitweg). Customer master data: buyer reference, electronic address.
- **Test:** The KoSIT validator reports "acceptable" for all generated test invoices (B2B with BT-10 placeholder, B2G with Leitweg-ID).

**ER-11 ZUGFeRD/Factur-X container**
- **Basis:** FeRD ZUGFeRD 2.5 specification.
  - PDF/A-3 (a/b/u) with embedded `factur-x.xml`, or `xrechnung.xml` for the XRECHNUNG profile.
  - AFRelationship (`Alternative` for DE / `Data`/`Source`).
  - XMP extension schema `urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#` with DocumentType, DocumentFileName, Version, ConformanceLevel.
  - Guideline ID BT-24, e.g. `urn:cen.eu:en16931:2017` for EN 16931 or `urn:cen.eu:en16931:2017#conformant#urn:factur-x.eu:1p0:extended`.
- **REQ:** Produce PDF/A-3 with embedded fonts, the XMP metadata and an ICC output intent.
- **Test:**
  - veraPDF validation PDF/A-3 passes.
  - Mustang validator (or FeRD reference validator) gives zero errors.
  - Extract the XML from the PDF and check it equals the stored XML byte-for-byte.

**ER-12 Validation before sending and on receipt; error classes** [CHANGED 2025]
- **Basis:** BMF 15.10.2025 Rz. 6a, 6b, 24, 35a.
  - **Formatfehler** (syntax not extractable): the file is not an E-Rechnung. The customer loses input VAT once the transition ends.
  - **Geschäftsregelfehler** (EN 16931 business rule violated): VAT-relevant only if a §14 item is affected; curable.
  - **Inhaltsfehler** (a §14/§14a item wrong): not a proper invoice.
  - With due care, a business may rely on the validator for format and business rules.
  - Keep the validation report.
- **REQ:**
  - Bundle the KoSIT validator (`itplr-kosit/validator`) with the current `validator-configuration-xrechnung` (the 3.0.2 Summer 2026 bugfix bundle) and the FeRD Schematron for ZUGFeRD.
  - Block sending if the outbound XML has errors.
  - Archive the validation report (XML/HTML) next to each invoice for 8 years.
  - Track the validator configuration version and update it when KoSIT releases (twice a year, around February and August).
- **Test:**
  - A deliberately broken XML (missing BT-1) is blocked.
  - The report is archived with the invoice ID and validator version.

**ER-13 Retention of E-Rechnungen** [CHANGED 2025]
- **Basis:** GoBD Rz. 118, 119, 125 (amended 14.07.2025); BMF 2025 Rz. 60 f.
  - Keeping the structured part is enough. Keep the PDF part of a hybrid only if it has extra or different tax-relevant content (e.g. booking notes).
  - Do not lose the XML through conversion.
  - Storing outside a "GoBD system" is not by itself a §14b breach.
- **REQ:**
  - Archive the XML (mandatory) and the PDF (recommended) unaltered and hashed.
  - Booking notes are stored as separate metadata, never written into the file.
- **Test:** After import, the file hash equals the hash computed at receipt. Annotations live only in DB fields.

### 3.3 B2G (public sector)

**ER-20 Leitweg-ID, channels**
- **Basis:**
  - E-Rechnungsverordnung (ERechV) for federal authorities: mandatory XRechnung (or other EN 16931 format) since 27.11.2020; direct orders ≤ 1,000 € net exempt (§3 Abs. 3 ERechV); Leitweg-ID required (§5 ERechV).
  - Länder have their own rules, which vary.
  - Federal channels: OZG-RE (the federal portal; I am **[UNSURE]** whether ZRE has been fully merged into it), Peppol.
- **REQ:**
  - Customer type "öffentlicher Auftraggeber" makes the Leitweg-ID mandatory in BT-10.
  - Validate the Leitweg-ID format: Grobadressierung (2–12 digits) – optional Feinadressierung (≤ 30 alphanumeric) – 2-digit check digit, ISO 7064 Mod 97-10.
  - Export for portal upload. Optional Peppol via a contracted Access Point: participant ID scheme `0204:<Leitweg-ID>`, Peppol BIS Billing 3.0 / XRechnung.
- **Test:** `991-01234-38` checks out OK under Mod 97-10 (correction 2026-10-12: the originally cited `991-01234-44` is **invalid**; verified against the KoSIT example `04011000-1234512345-06`). A wrong check digit is rejected.

**ER-30 Planned: ViDA and a national reporting system** [UPCOMING]
- **Basis:** Dir. (EU) 2025/516: from 01.07.2030 intra-EU B2B E-Rechnung plus near-real-time reporting replacing the ZM; harmonisation by 2035. Germany has announced a reporting system but no draft was found.
- **REQ:** Architecture: keep a format-agnostic invoice data model (EN 16931 semantic model, BT-xx keyed) and a pluggable transmission layer.
- **Test:** Architecture review.

---

## 4. GoBD (BMF 28.11.2019, as amended 11.03.2024 and 14.07.2025)

The GoBD also apply to EÜR businesses and to voluntary bookkeeping (§146 Abs. 6 AO). The Finanzverwaltung does **not** certify software (GoBD Rz. 179–181). An IDW PS 880 certificate is optional.

**GOBD-01 Traceability (Nachvollziehbarkeit, Nachprüfbarkeit)**
- **Basis:** §145 Abs. 1 AO; §238 Abs. 1 HGB; GoBD Rz. 30–35. An expert third party must be able to follow every transaction from voucher to booking to report and back, in reasonable time.
- **REQ:**
  - Every booking links to its voucher (invoice, receipt, bank line).
  - Every report figure drills down to bookings.
  - Bidirectional navigation in the UI and in exports.
- **Test:** From a UStVA Kennzahl, drill down to individual invoices and back.

**GOBD-02 Completeness and single recording**
- **Basis:** §146 Abs. 1 AO; GoBD Rz. 36–43.
- **REQ:**
  - No transaction can be removed.
  - Number-range gap report.
  - Cancelled invoices remain visible with their storno.
  - Bank import detects gaps (balance continuity check).
- **Test:** Import two bank statements with a missing day. A warning about the balance mismatch must appear.

**GOBD-03 Correctness**
- **Basis:** §146 Abs. 1 AO; GoBD Rz. 44.
- **REQ:** Plausibility checks: VAT arithmetic, totals, dates. Server-side validation for every API and UI path.
- **Test:** Property-based tests on totals.

**GOBD-04 Timely recording; cash daily**
- **Basis:** §146 Abs. 1 Satz 2 AO (cash daily); GoBD Rz. 45–52 (non-cash transactions within ~10 days is unproblematic, Rz. 47; monthly booking acceptable if vouchers are secured in the meantime).
- **REQ:**
  - Store an `erfasst_am` timestamp for every record, separate from the voucher date.
  - Dashboard of unbooked vouchers older than 10 days.
  - The cash book requires daily entries (see AO-05).
- **Test:** A voucher received 12 days ago and still unbooked appears in the overdue list.

**GOBD-05 Order (Ordnung)**
- **Basis:** §146 Abs. 1 AO; GoBD Rz. 53–57.
- **REQ:** Chronological journal plus account view. Unique voucher IDs. Folder or index structure in exports.
- **Test:** The journal export is sorted by booking date and sequence, without gaps in its internal sequence.

**GOBD-06 Immutability and logging (core requirement)**
- **Basis:** §146 Abs. 4 AO (no change that makes the original content unrecognisable, or leaves unclear whether it was original or later); GoBD Rz. 58–60, 107–112.
  - Changes must be logged with original content, change, time and author.
  - Data-processing records must be protected in the same way as paper.
- **REQ:**
  1. **Lifecycle:**
     - `draft` (freely editable and deletable; no voucher yet)
     - `finalized/issued` (immutable)
     - `cancelled` (via a storno document only)

     Bookings: `entered` → `festgeschrieben` (locked) at the latest at period close or UStVA submission. Option: auto-lock at UStVA transmission.
  2. **No hard deletes** of finalised invoices, bookings, vouchers or log entries. DB-level: revoke DELETE/UPDATE on those tables from the app role, or use triggers raising errors.
  3. **Audit log:** append-only, entries for create/finalise/send/cancel/lock/settings change/import/export/restore. Each entry holds UTC timestamp, actor (see SEC), entity, before/after values (JSON diff), reason, and a hash chain (`hash = SHA256(prev_hash || canonical(entry))`).
  4. **Artifact hashing:** store the SHA-256 of each issued PDF/XML. Optionally get a periodic external anchor such as an RFC 3161 timestamp.
  5. **Versioned master data:** customer, article and tax-rate changes create new versions. Documents reference the version or snapshot.
  6. **Template versioning:** the PDF template version is stored per invoice. Per GoBD Rz. 76 (2025) an image copy is unnecessary only if a content-identical copy can be reproduced. **Recommendation:** archive the sent PDF anyway.
- **Test:**
  - SQL `UPDATE invoices SET total=...` on a finalised row fails.
  - Tamper with one audit row. Chain verification must report the break position.
  - Re-render the invoice from stored data: the content (not bytes) matches the archived PDF.

**GOBD-07 Voucher function**
- **Basis:** GoBD Rz. 61–81. Every booking needs a voucher. Received electronic vouchers stay in their original format. Outgoing invoices need a reproducible copy (Rz. 76 as amended). Payment-provider technical proofs are not subject to retention under conditions (Rz. 121, 2025).
- **REQ:**
  - Upload or attach vouchers (PDF, image, XML, e-mail .eml) to bookings, stored unaltered with hash.
  - Internal vouchers (Eigenbeleg) have a template with reason and signature/approval.
- **Test:** Booking without voucher → warning; exception list in the period-close checklist.

**GOBD-08 Replacing paper by scanning (ersetzendes Scannen)**
- **Basis:** GoBD Rz. 136–140; §147 Abs. 2 AO. Requires an organisational instruction (who scans, when, what, quality control, protection against loss). Paper may then be destroyed unless other law requires originals.
- **REQ:**
  - Scan/upload workflow: hash at capture, store image unaltered (PDF/A or original format), record scanner/user/time.
  - OCR text stored separately.
  - Optional "complete-and-checked" flag.
  - Ship a **scanning procedure template** (Verfahrensdokumentation, GOBD-10).
- **Test:** The upload's hash and capture timestamp are recorded. A replaced file creates a new version, and the old one is kept.

**GOBD-09 Internal control system and data security**
- **Basis:** GoBD Rz. 100–106. Access and authorisation controls, segregation, plausibility checks, protection against loss/theft/unauthorised change. Loss of data makes the books improper and allows estimation (§158, §162 AO).
- **REQ:** See SEC (section 11). Backups: automated, encrypted, versioned, off-site; restore test monthly; backup integrity verification.
- **Test:** A scripted restore into a clean instance gives an identical audit-chain head hash.

**GOBD-10 Verfahrensdokumentation (procedure documentation)**
- **Basis:** GoBD Rz. 151–155: general description, user documentation, technical system documentation, operating documentation. It counts as an organisational document under §147 Abs. 1 Nr. 1 AO, so **10 years** retention.
- **REQ:**
  - Ship a pre-filled, versioned Verfahrensdokumentation template covering the software's processes: invoice lifecycle, numbering, E-Rechnung receipt and validation, archiving, backups, access concept, scanning, cash book, DATEV transfer.
  - Version-stamp it automatically with the software version and change log.
  - The user completes the organisational parts.
- **Test:** The export contains the document and the software change history.

**GOBD-11 Datenzugriff in an audit (Z1/Z2/Z3)**
- **Basis:** §147 Abs. 6 AO; GoBD Rz. 158–174 (amended 11.03.2024 incl. an annex on data provision).
  - **Z1:** the auditor gets direct read-only access in the system.
  - **Z2:** the taxpayer runs evaluations as requested.
  - **Z3:** data handed over in machine-readable form.
  - Duty applies for the whole retention period. Since 2020 a 5-year relief after a system change applies (§147 Abs. 6 Satz 6 AO).
- **REQ:**
  1. **Z1:** an "Auditor" read-only role/session (see SEC-03) with full search and filters, no write paths.
  2. **Z2:** report builder (filters by period, account, customer) with CSV export.
  3. **Z3:** "GDPdU/GoBD export". UTF-8 or ISO-8859-15 CSV files plus `index.xml` per the **Beschreibungsstandard für die Datenträgerüberlassung** (gdpdu-01-09-2004.dtd). Tables: journal, accounts, customers, suppliers, invoices, invoice lines, payments, cash book, audit log, document index with file references and hashes. Declare decimal symbol, date format, encoding.
  4. Keep the data readable after software upgrades (schema migrations must not drop history) and after system retirement (read-only "archive mode" plus full export).
  5. Watch the **DSFinV-BV** (§147b AO) [DRAFT, earliest ~2029] and design exporters to be pluggable.
- **Test:** The Z3 export opens in IDA/IDEA-like tooling (validate `index.xml` against the DTD). The row counts match the DB.

### Retention and deletion

**GOBD-20 Retention periods** [VERIFIED] [CHANGED 2025]
- **Basis:** §147 Abs. 3 AO, §257 Abs. 4 HGB, §14b UStG (BEG IV):

| Category (§147 Abs. 1 AO) | Period |
|---|---|
| Nr. 1: books, records (journal, accounts), inventories, annual accounts, opening balance, **work instructions and organisational documents** (Verfahrensdokumentation, likely the audit log) | **10 years** |
| Nr. 4: Buchungsbelege (invoices in and out, bank statements, cash receipts) | **8 years** (since 01.01.2025; banks, insurers etc. from 2026) |
| Nr. 2, 3, 5: received and sent business letters (offers, order confirmations, dunning letters, contract correspondence), other tax-relevant documents | **6 years** |
| OSS records | **10 years** (Art. 63c MwSt-DVO; §22 UStG) [UNSURE about the German cross-reference] |

  - The period starts at the end of the calendar year of the last entry or creation (§147 Abs. 4).
  - **Ablaufhemmung** (suspension of expiry): documents may not be destroyed while they matter for a tax whose assessment period is still open (§147 Abs. 3 Satz 5 AO), e.g. during an ongoing audit or appeal.
- **REQ:** Each record gets a `retention_class` and a computed `retention_until`.
- **Test:**
  - Invoice 2018 → 31.12.2026.
  - Journal 2016 → 31.12.2026.
  - Offer letter 2020 → 31.12.2026.

**GOBD-21 Deletion**
- **Basis:** GoBD plus DSGVO Art. 17 Abs. 3 lit. b.
- **REQ:**
  - No deletion before `retention_until`.
  - After it, a **manual, batch, logged purge** with a mandatory confirmation that no audit, appeal or open assessment is pending ("Ablaufhemmung check").
  - The purge removes personal data or anonymises master data and keeps a non-personal tombstone (ID, hash, purge date) in the audit log.
- **Test:** A purge attempt on a 2019 invoice in 2026 is refused. In 2028 it is allowed after confirmation, and a log entry exists.

**GOBD-22 Timestamps**
- **Basis:** GoBD Rz. 107 ff. (logging), Rz. 45 ff. (timeliness).
- **REQ:**
  - Store everything as UTC (ISO 8601 with offset), display Europe/Berlin.
  - The server clock is NTP-synchronised. Log a clock-skew warning if it drifts more than 2 seconds.
  - Keep business dates (invoice date, supply date) separate from system timestamps (created, finalised, sent).
- **Test:** A DST transition (last Sunday in March/October) does not alter invoice dates.

**GOBD-23 Format conversion and migration**
- **Basis:** GoBD Rz. 135, 142–144; §147 Abs. 2 AO (machine-readable for the whole period); §147 Abs. 6 Satz 6 AO.
- **REQ:** Keep the original plus any converted version. Migrations are logged. Data from any retired version stays queryable.
- **Test:** After an upgrade migration, the old invoices' hashes still verify.

---

## 5. AO / HGB / EStG: bookkeeping obligations, cash, depreciation

**AO-01 Who must keep double-entry books** [VERIFIED]
- **Basis:**
  - §238 HGB: merchants.
  - §241a HGB: sole merchants exempt if, in two consecutive years, turnover ≤ **800,000 €** and profit ≤ **80,000 €**; for new businesses, at the first balance-sheet date.
  - §141 AO: tax bookkeeping duty above 800,000 € turnover or 80,000 € profit; starts only after the Finanzamt notifies (Abs. 2).
  - Partnerships with a commercial firm (OHG, KG, GmbH & Co. KG) and corporations (GmbH, UG, AG) **always** keep double-entry books.
  - Everyone else may use the **EÜR** (§4 Abs. 3 EStG) with the official form **Anlage EÜR**, filed electronically (§60 Abs. 4 EStDV).
- **REQ:**
  - Company setting: legal form plus method (EÜR or Bilanz).
  - Block EÜR for corporations and commercial partnerships.
  - Show a threshold monitor (800k € / 80k €) with a warning.
  - For Bilanz companies, the tool provides a DATEV export and positions itself as a **subledger** (invoicing plus receivables), unless full double-entry is in scope.
- **Test:** Legal form GmbH plus EÜR → blocked.

**AO-02 EÜR specifics**
- **Basis:** §11 EStG (cash-basis principle; 10-day rule for recurring payments around year end, e.g. UStVA payments due within 10 days); §4 Abs. 3 EStG; Anlage EÜR (line numbers change yearly).
- **REQ:**
  - EÜR report by payment date.
  - Map each account or category to Anlage EÜR lines, with a mapping table versioned per tax year.
  - 10-day logic for USt payments (BFH X R 44/16: payment and due date both within 10 days of year end; with Dauerfristverlängerung, the December payment falls outside).
  - Fixed assets: depreciation instead of immediate expense.
- **Test:** UStVA for December paid 08.01., due 10.01. (no Dauerfristverlängerung) → previous year. With Dauerfristverlängerung (due 10.02.) → current year.

**AO-03 Depreciation (AfA), GWG, Sammelposten** [VERIFIED / DRAFT where marked]
- **Basis:**
  - §7 Abs. 1 EStG linear AfA per BMF AfA-Tabellen, monthly pro rata.
  - §7 Abs. 2 EStG degressive **30%**, max. 3× linear, for movable assets bought 01.07.2025–31.12.2027.
  - §7 Abs. 2a EStG 75% first-year special AfA for e-vehicles (2025–2027).
  - §6 Abs. 2 EStG **GWG ≤ 800 € net**: immediate write-off; list required for > 250 €.
  - §6 Abs. 2a EStG **Sammelposten** 250.01–1,000 €, 5-year pool.
  - §7g EStG Investitionsabzugsbetrag (IAB) and special AfA.
  - Pending: GWG 1,200 € and abolition of the Sammelposten from 2027 [DRAFT JStG 2026].
- **REQ:**
  - Asset register: acquisition date, cost (net if input VAT deductible), useful life, method, disposal.
  - A rule engine with validity periods offers only methods valid for the acquisition date.
  - Annual AfA journal.
  - GWG list.
  - Sammelposten pool per year.
- **Test:**
  - Machine 10,000 € bought 15.08.2025, life 10 years: degressive year 1 = min(30%, 3×10%) × 10,000 × 5/12 = 1,250 €.
  - Laptop 799 € → GWG option.
  - Purchase in 2027 → the rule set loaded must reflect the JStG 2026 outcome.

**AO-04 TSE / KassenSichV: does the invoicing tool need one?**
- **Basis:**
  - §146a AO; KassenSichV §1: electronic recording systems = electronic or computer-based cash registers; from 2026 explicitly also app-based systems, taxameters and odometers.
  - The TSE duty applies only to systems with a **cash function**, i.e. capable of recording and processing cash or cash-like payments (AEAO zu §146a Nr. 1.2).
  - AEAO zu §146a lists e.g. accounting programs as not covered [UNSURE about the exact AEAO wording; check AEAO zu §146a Nr. 1.2].
  - **Belegausgabepflicht** (§146a Abs. 2 AO) and the **notification duty** via ELSTER (§146a Abs. 4 AO, since 01.01.2025) apply only to those systems.
  - KassenSichV amendment 2026: an E-Rechnung may carry the receipt data (§6 KassenSichV).
  - Planned **Kassenpflicht**: above 100k € turnover, generally from 01.01.2028 [DRAFT].
- **REQ:**
  1. **Do not build a POS or "Kasse" mode** (quick cash sales without an invoice process). Otherwise the product becomes a §146a system needing a certified TSE, DSFinV-K export and an ELSTER notification.
  2. Recording "paid in cash" against an issued invoice is a payment entry, not a POS sale.
  3. The UI and documentation state clearly that the tool is not a cash register.
  4. If POS is ever added, it needs a TSE integration (BSI-certified, cloud or hardware), DSFinV-K export, receipts carrying §6 KassenSichV data (TSE serial, transaction counter, start/end time, signature counter, signature), an ELSTER notification helper, and a decision on the 2028 Kassenpflicht.
- **Test:** Product review: no code path creates a sale without an invoice document and number.

**AO-05 Cash book (Kassenbuch) without a register (offene Ladenkasse)**
- **Basis:** §146 Abs. 1 Satz 2 AO (daily); §146 Abs. 4 AO; GoBD Rz. 48, 58 ff. Spreadsheet cash books are not accepted, because they are changeable. The cash balance must never go negative (that indicates improper books). Kassensturzfähigkeit (it must always be possible to count the cash against the book).
- **REQ:**
  - Cash book as an append-only journal with a running balance.
  - Block any entry that would make the balance negative at any point in time, including backdated entries.
  - Daily close with a counted balance (optional Zählprotokoll), locking that day.
  - Corrections only as reversal entries.
  - Each entry links to a voucher.
- **Test:**
  - Opening balance 100 €, outflow 150 € → blocked.
  - Backdated inflow after the outflow date does not cure a negative balance in between → blocked.
  - Editing a closed day → refused.

**AO-06 Language, abbreviations, location of books**
- **Basis:**
  - §146 Abs. 3 AO: a living language; abbreviations must be defined.
  - §146 Abs. 2, 2a AO: books kept in Germany or **another EU state** if full data access is ensured.
  - §146 Abs. 2b AO: **non-EU hosting requires approval** from the Finanzamt. Fine of 2,500–250,000 € (§146 Abs. 2c).
- **REQ:**
  - German as primary output language.
  - Self-hosting docs warn: server location must be in Germany or the EU. The installer asks for the server location and records it in the Verfahrensdokumentation.
  - No telemetry or backups to non-EU without explicit configuration and a warning.
- **Test:** Choosing a non-EU backup target shows the §146 Abs. 2b warning.

**AO-07 Annual accounts and reports (if Bilanz)**
- **Basis:** §§242 ff. HGB; E-Bilanz §5b EStG (XBRL, taxonomy changes yearly).
- **REQ:** Out of scope unless full double-entry. Then DATEV export is the handover. State this explicitly in the spec.

---

## 6. UStVA, ZM, OSS, Soll/Ist

**UVA-01 Filing periods** [VERIFIED] [CHANGED 2025]
- **Basis:** §18 Abs. 1, 2, 2a UStG.
  - Due on the 10th day after the period ends, electronically.
  - Quarterly as default. Monthly if prior-year tax > **9,000 €**. Waiver possible if ≤ **2,000 €**.
  - Monthly option if the prior-year refund > 9,000 €.
  - Neugründer: monthly in founding year and following year. For 2021–2026 this is replaced by an annualised projection (§18 Abs. 2 Satz 6). **From 2027 the strict monthly rule returns unless extended [UNSURE]**.
- **REQ:**
  - Setting: period (monthly or quarterly), with a yearly suggestion based on the prior-year tax.
  - Founding-year logic per tax year.
  - Deadline calendar, including Dauerfristverlängerung (+1 month) and the weekend/holiday shift (§108 Abs. 3 AO).
- **Test:**
  - Prior-year tax 9,000.00 → quarterly. 9,000.01 → monthly.
  - Period Q1 due 10.04. If 10.04. is a Saturday → due 12.04.

**UVA-02 Dauerfristverlängerung**
- **Basis:** §18 Abs. 6 UStG; §§46–48 UStDV. Application by the first filing deadline. Monthly filers pay a Sondervorauszahlung of **1/11** of the prior-year total, offset in the December return (Kz 39). Quarterly filers pay none.
- **REQ:** Compute the Sondervorauszahlung, generate the application data (Kz 38) and offset it in December/Q4 (Kz 39).
- **Test:** Prior-year advance payments total 22,000 € → Sondervorauszahlung 2,000 €.

**UVA-03 UStVA content and Kennzahlen**
- **Basis:** official UStVA form (BMF publishes a new Vordruckmuster each autumn).
- **REQ:**
  - Mapping layer from tax categories to Kennzahlen, **versioned per year**.
  - Typical (2025/2026) [check against the current form]:

| Kz | Content |
|---|---|
| 81 | Taxable supplies at 19%, net base |
| 86 | Taxable supplies at 7%, net base |
| 87 | 0% (PV) |
| 35 / 36 | Other rates |
| 41 | Intra-Community supplies to buyers with USt-IdNr |
| 44 / 49 | New vehicles |
| 43 | Other exempt with input VAT deduction (exports) |
| 48 | Exempt without input VAT deduction |
| 21 | EU B2B services, not taxable in Germany |
| 45 | Other non-taxable |
| 60 | §13b supplies where the customer owes the tax |
| 89 / 93 / 95 / 98 | Intra-Community acquisitions |
| 46/47, 73/74, 84/85 | §13b received (base / tax) |
| 66 | Input VAT from invoices |
| 61 | Input VAT on intra-Community acquisitions |
| 62 | Import VAT |
| 67 | Input VAT §13b |
| 64 | §15a correction |
| 69 | §14c amounts |
| 50 / 37 | Bad-debt corrections |
| 39 | Sondervorauszahlung |
| 83 | Result |
| 10 | Corrected return |

  - Totals are rounded per form rules (base amounts whole euros, tax amounts to the cent).
- **Test:** A golden dataset produces the expected Kennzahlen for 2026. Swapping in a 2027 mapping table changes nothing else.

**UVA-04 Electronic submission via ELSTER/ERiC**
- **Basis:** §18 Abs. 1 UStG; §87a Abs. 6 AO (authenticated transmission); StDÜV.
- **REQ (choose one; document the choice):**
  - **(a) Direct ERiC integration.**
    - Register as an ELSTER software developer to receive the ERiC library and a Hersteller-ID.
    - Use the user's ELSTER software certificate (.pfx plus PIN), never stored in plain text.
    - Test transmissions with the test tax office and test flag.
    - Show the transmission protocol (Übertragungsprotokoll) and archive it (PDF from ERiC).
    - ERiC releases must be upgraded regularly; old versions are switched off.
    - The ERiC licence restricts redistribution [UNSURE: check whether an open-source self-hosted project may bundle ERiC].
  - **(b) No direct transmission.** Produce a Kennzahlen sheet for manual entry in Mein ELSTER, or a DATEV export for the Steuerberater.
- **Test:**
  - (a) Test transmission in ELSTER test mode returns success; the protocol is archived; the period is locked (festgeschrieben) after transmission.
  - (b) The sheet matches the computed values.

**UVA-05 Zusammenfassende Meldung (ZM)**
- **Basis:** §18a UStG.
  - Report intra-Community supplies, EU B2B services (§3a Abs. 2) and triangular transactions to the BZSt by the **25th day** after the period.
  - Monthly; quarterly allowed if intra-Community supplies ≤ 50,000 € per quarter (current and last four quarters).
  - Services only: quarterly.
  - Electronic (BZSt online portal or ELSTER).
  - A correct ZM is a condition for the §4 Nr. 1b exemption.
  - Kleinunternehmer exempt.
- **REQ:**
  - ZM report per period: customer USt-IdNr, sum per type (supply / service / triangular). CSV in the BZSt format [UNSURE about the current BZSt CSV layout].
  - Correction reports.
- **Test:** Two EU customers, mixed types → correct aggregation, ZM due date shown.

**UVA-06 Soll- vs. Ist-Versteuerung** [VERIFIED]
- **Basis:**
  - §16, §13 Abs. 1 Nr. 1a UStG (Soll: tax at supply).
  - §20 UStG (Ist on application if prior-year Gesamtumsatz ≤ **800,000 €**, or exempt from bookkeeping under §148 AO, or Freiberufler income).
  - From 2028: customers of Ist-taxers deduct input VAT only on payment, plus the invoice note (UST-13).
- **REQ:**
  - Setting with effective dates.
  - Soll: UStVA by supply date (advances by receipt).
  - Ist: by payment receipt, with partial payments split pro rata across rates.
  - Switching methods avoids double or zero taxation.
  - Input VAT: in Soll and Ist alike, by invoice receipt plus supply, except advances (until 2028; then supplier-dependent).
- **Test:**
  - Ist: invoice 1,190 € in March, paid 595 € in April and 595 € in May → output VAT 95 € in April and 95 € in May.
  - Soll: 190 € in March.

**UVA-07 OSS**
- **Basis:** §3c Abs. 4 UStG (EU-wide threshold **10,000 €** for B2C distance sales and electronic/telecom/broadcast services); §18j UStG (quarterly OSS return to the BZSt by the end of the following month).
- **REQ:**
  - B2C EU customers: track the 10k € threshold.
  - Once exceeded (or if opted in), apply the **destination-country VAT rate**. Requires a rate table per EU member state (date-effective).
  - OSS report per country and rate.
  - 10-year retention class.
  - If out of scope for v1: block B2C EU sales above the threshold with a clear message.
- **Test:** B2C France, threshold exceeded → 20% French VAT on the invoice. The OSS report shows FR/20%.

---

## 7. Dunning and late payment (Mahnwesen / Verzug)

**MAHN-01 Due date and default**
- **Basis:**
  - §271 BGB: immediately due if nothing is agreed.
  - §286 Abs. 1 BGB: default after a reminder.
  - §286 Abs. 2 Nr. 1 BGB: no reminder needed if a calendar date is contractually agreed. A one-sided date on the invoice is **not** enough per prevailing view.
  - §286 Abs. 3 BGB: default automatically **30 days after receipt of the invoice**. For consumers only if the invoice specifically pointed this out.
- **REQ:**
  - Due date per payment terms.
  - For B2C invoices, print by default: "Sie kommen spätestens 30 Tage nach Fälligkeit und Zugang dieser Rechnung in Verzug, ohne dass es einer Mahnung bedarf (§ 286 Abs. 3 BGB)."
  - Default date computation: receipt date assumption configurable (e.g. send date + 3 days for postal; e-mail = send date).
- **Test:** A B2C invoice contains the note. The default date is computed as receipt + 30 days.

**MAHN-02 Default interest** [VERIFIED]
- **Basis:** §288 Abs. 1 BGB: Basiszinssatz + **5 points** (consumer involved); §288 Abs. 2 BGB: + **9 points** (no consumer involved); §247 BGB (Basiszinssatz adjusted 01.01./01.07.; **1.52% since 01.07.2026** → 6.52% / 10.52%); §289 BGB: no compound interest.
- **REQ:**
  - Basiszinssatz table with history; the admin can add new values. Optional fetch from the Bundesbank.
  - Interest computed per day (actual/365), split at rate-change dates.
  - No interest on interest.
- **Test:** B2B claim 10,000 € in default from 01.06.2026 to 31.07.2026:
  - 30 days at 10.27%: 10,000 × 10.27% × 30/365 = 84.41 €
  - 31 days at 10.52%: 10,000 × 10.52% × 31/365 = 89.35 €
  - Total **173.76 €**. Verify the day-count convention with legal counsel.

**MAHN-03 Flat 40 € fee (B2B)**
- **Basis:** §288 Abs. 5 BGB: 40 € if the debtor is not a consumer; offset against later collection costs; cannot be excluded in advance (§288 Abs. 6).
- **REQ:** Add the 40 € once per claim (not per reminder) for B2B only. Not available for B2C.
- **Test:** B2C dunning → no 40 € option. B2B second reminder → still only one 40 €.

**MAHN-04 Payment-term limits**
- **Basis:** §271a BGB:
  - B2B terms > 60 days effective only if expressly agreed and not grossly unfair.
  - Public bodies: > 30 days only if expressly agreed and objectively justified; > 60 days void.
  - Inspection/acceptance > 30 days only if expressly agreed.
  - Not applicable to consumers or instalment agreements.

  §308 Nr. 1a BGB (standard terms: > 30 days presumed unreasonable when the buyer imposes them).
- **REQ:** Warn when payment terms > 60 days (B2B) or > 30 days (public customer).
- **Test:** Public customer with 45 days → warning.

**MAHN-05 Dunning documents and limitation**
- **Basis:** §§195, 199 BGB: 3 years from the end of the year the claim arose. Dunning letters are business letters (6-year retention; Geschäftsbrief items apply, see MAIL-03). Consumers: only actual costs as dunning fees.
- **REQ:**
  - Dunning levels with templates, which are immutable once sent.
  - Limitation warning before 31.12. of year+3.
  - Export for the online Mahnantrag (optional).
- **Test:** Claim from 2023 shows "verjährt am 31.12.2026" from 01.10.2026.

**MAHN-06 EU Late Payment Regulation** [UNSURE / pending]
- **Basis:** 2023 Commission proposal (hard 30-day maximum). Not adopted as of research.
- **REQ:** Keep payment-term rules configurable.

---

## 8. Data protection (DSGVO / BDSG)

**DSGVO-01 Legal basis**
- **Basis:** Art. 6 Abs. 1 lit. b (contract) and lit. c (legal obligation: §147 AO, §257 HGB, §14b UStG) DSGVO.
- **REQ:** Record of processing (Art. 30) template shipped with the docs. Purposes per data category.
- **Test:** Docs review.

**DSGVO-02 Deletion vs. retention conflict**
- **Basis:** Art. 17 Abs. 3 lit. b DSGVO (no deletion while a legal retention duty applies); Art. 18 (restriction); §35 Abs. 3 BDSG.
- **REQ:**
  - Per data subject: "deletion request" → immediately delete data **not** subject to retention (marketing notes, unused contacts, open drafts).
  - Restrict the rest (flag `restricted`: hidden from normal UI and search, excluded from new processing, visible only in audit/export).
  - Schedule the final deletion or anonymisation at max(`retention_until`) (GOBD-21).
- **Test:** Deletion request for a customer with 2024 invoices → drafts deleted, record restricted, scheduled date = 01.01.2033 (8 years after 2024).

**DSGVO-03 Access and portability**
- **Basis:** Art. 15, Art. 20 DSGVO (1 month deadline, Art. 12 Abs. 3).
- **REQ:** Per-person export (JSON plus PDF list of documents), including audit-log entries about that person.
- **Test:** The export contains all invoices and contact records.

**DSGVO-04 Processors and transfers**
- **Basis:** Art. 28 DSGVO (data processing agreement, AVV, with hosting, e-mail/SMTP, backup and Peppol AP providers); Art. 44 ff. (third-country transfers). The Steuerberater is usually an independent controller, not a processor.
- **REQ:** Settings page listing configured external services with an AVV checkbox and documentation link. Warn for non-EU endpoints (also AO-06).
- **Test:** Configuring an SMTP host triggers the AVV reminder.

**DSGVO-05 Security of processing (TOMs)**
- **Basis:** Art. 32 DSGVO; Art. 25 (privacy by design/default); Art. 33/34 (breach notification within 72 hours).
- **REQ:** Encryption at rest (DB or disk) and in transit (TLS 1.2+), access control (SEC), backups, pseudonymised logs (no full payload in debug logs), breach-response doc.
- **Test:** Security scan (TLS config), logs reviewed for PII.

**DSGVO-06 Logging and data minimisation**
- **Basis:** Art. 5 Abs. 1 lit. c, e DSGVO.
- **REQ:**
  - The GoBD audit log is a legal obligation and kept per GOBD-20.
  - Technical logs (HTTP access, errors) rotated after ≤ 30–90 days, IPs truncated.
- **Test:** Log rotation configured. Technical logs older than the limit are absent.

---

## 9. DATEV export

**DATEV-01 Format and header**
- **Basis:** DATEV-Format specification (developer.datev.de). Header version **700**, Formatkategorie **21** "Buchungsstapel", Formatversion **13** (current; the DATEV interface requirements page lists **12 as minimum**). [VERIFIED via search snippets; the page is JS-rendered, so check the full field list there.]
- **REQ:**
  - Line 1 header fields in exact order:
    1. `"EXTF"`
    2. `700`
    3. `21`
    4. `"Buchungsstapel"`
    5. `13`
    6. Created timestamp `YYYYMMDDHHMMSSFFF`
    7. (empty)
    8. Herkunft (2 characters)
    9. Exportiert von
    10. (empty)
    11. **Beraternummer** (1001–9999999)
    12. **Mandantennummer** (1–99999)
    13. **WJ-Beginn** `YYYYMMDD`
    14. **Sachkontenlänge** (4–9)
    15. Datum vom
    16. Datum bis
    17. Bezeichnung (≤ 30)
    18. Diktatkürzel
    19. Buchungstyp (1 = Fibu)
    20. Rechnungslegungszweck (0)
    21. **Festschreibung** (0/1; default 1 per GoBD)
    22. WKZ `EUR`
    23–26. reserved / Derivat
    27. Sachkontenrahmen (`03` / `04`)

    and the remaining reserved fields.
  - Line 2: column headers.
  - Data lines: **all** columns of the specification in order, even if empty.
  - Semicolon separator, decimal comma, text in double quotes.
  - Encoding Windows-1252 [UNSURE whether UTF-8 is accepted; Windows-1252 is the safe choice].
  - Filename `EXTF_Buchungsstapel_<from>_<to>.csv`.
  - One file per fiscal year (Belegdatum is `TTMM`; the year comes from the header).
- **Test:** Import the test file into the DATEV Rechnungswesen test client (or have the Steuerberater test it). Schema test checks the column count equals the spec.

**DATEV-02 Data fields**
- **REQ:**
  - Key columns: Umsatz (no sign, `119,00`), Soll/Haben-Kennzeichen (`S`/`H`), WKZ, Konto, Gegenkonto (without BU), **BU-Schlüssel** (tax key, if the account is not an automatic account), Belegdatum `TTMM`, **Belegfeld 1** (invoice number ≤ 36 characters), Belegfeld 2 (due date `TTMMJJ` or reference), Skonto, Buchungstext (≤ 60), Beleglink, EU-Land u. USt-IdNr, EU-Steuersatz, Leistungsdatum, Festschreibung.
  - Customer and supplier accounts:
    - SKR03/SKR04 personal accounts: debtors 10000–69999, creditors 70000–99999 with 4-digit G/L accounts. Configurable.
    - Also export the master data file (Formatkategorie 16 "Debitoren/Kreditoren", version 5) [UNSURE about the current version].
  - Default revenue accounts, configurable and confirmed with the Steuerberater:

| Purpose | SKR03 | SKR04 |
|---|---|---|
| Revenue 19% | 8400 | 4400 |
| Revenue 7% | 8300 | 4300 |
| Intra-Community supply | 8125 | 4125 |
| EU services §13b | 8336 | 4336 |
| Kleinunternehmer revenue | 8195 | 4185 |

  - Tax keys (classic, 3-digit field): 2 = 7% output, 3 = 19% output, 8 = 7% input, 9 = 19% input, 40 = suspend automatic account. **[UNSURE: DATEV tax keys are version-dependent; get the current list from the Steuerberater's DATEV system.]**
- **Test:** A round-trip of an invoice with 2 rates gives 2 booking lines (or 1 per account split) whose totals match.

**DATEV-03 Voucher images**
- **Basis:** DATEV Unternehmen online / DATEV APIs (Belegbilderservice, Rechnungsdatenservice) require DATEV Marketplace partnership.
- **REQ:** v1: ZIP export of PDFs/XMLs named by Belegfeld 1, plus a Beleglink column. Optional later: DATEV API integration.
- **Test:** Every Belegfeld 1 in the CSV has exactly one matching file in the ZIP.

**DATEV-04 Number format compatibility**
- **REQ:** Enforce UST-06 character and length rules so DATEV OPOS matching works.

---

## 10. Sending by e-mail and business-letter details

**MAIL-01 Consent**
- **Basis:** §14 Abs. 1 UStG (as amended).
  - **E-Rechnung in the mandatory scope:** no consent needed.
  - **"Sonstige" electronic invoice (PDF):** recipient consent needed. It may be tacit, e.g. paying without objection. During the transition it is allowed only with consent (§27 Abs. 38 Nr. 1, 2).
  - In excepted cases (Kleinbetrag, KU), an E-Rechnung may be sent without consent (BMF 2025 Rz. 22).
  - B2C: PDF needs consent (tacit acceptance is common).
- **REQ:**
  - Customer field "Zustimmung zu elektronischen Rechnungen (sonstige)" with date and source.
  - The send dialog uses ER-03 to decide the allowed formats.
- **Test:** A 2026 PDF to a B2B customer without consent → warning, suggests E-Rechnung or paper.

**MAIL-02 Transmission integrity and proof**
- **Basis:** §14 Abs. 3 UStG (authenticity, integrity, legibility by any method, including an internal control procedure establishing a reliable audit trail); GoBD Rz. 121 (an e-mail body that is only a transport vehicle need not be kept).
- **REQ:**
  - Log the send event: recipient, time, message-ID, attachment hashes, SMTP response.
  - Use TLS for SMTP. DKIM/SPF are recommended in the docs.
  - Store the sent .eml if its body contains tax-relevant content.
- **Test:** The send log contains a hash equal to the archived PDF/XML.

**MAIL-03 Geschäftsbrief items on invoices and letters**
- **Basis:**
  - **§37a HGB** (registered sole merchant): firm name with "e.K.", place of business, register court, HR number.
  - **§125a HGB** (OHG/KG): legal form, seat, register court, HRA number. If no natural person is personally liable (GmbH & Co. KG), also the §35a GmbHG items of the general partner.
  - **§177a HGB** (KG).
  - **§35a GmbHG** (GmbH/UG): legal form, seat, register court, HRB number, **all managing directors** (surname plus at least one full first name), chair of the supervisory board if any. If share capital is stated, the outstanding contributions too.
  - **§80 AktG** (AG).
  - **§7 Abs. 5 PartGG** (PartG).
  - eGbR: name suffix "eGbR" (§707a BGB). §707b BGB does not reference §37a/§125a HGB, so no specific letter-item duty was found [UNSURE].
  - Non-registered traders and freelancers: full name (also required by §14 Abs. 4 Nr. 1 UStG).
  - Service providers: DL-InfoV §2 information before contract (may be on the website).
  - Website/portal: Impressum under **§5 DDG** (since 14.05.2024; replaced the TMG).
- **REQ:**
  - Legal form drives the mandatory fields. The footer template blocks finalisation if the required items are missing.
  - The same footer is used on offers, order confirmations and dunning letters (these are also Geschäftsbriefe).
- **Test:**
  - GmbH without managing directors entered → invoice finalisation blocked.
  - The footer shows "Geschäftsführer: Max Mustermann".

---

## 11. Security for a single-user, self-hosted system without login

**Why this matters:** The GoBD require an internal control system that includes access and authorisation controls (GoBD Rz. 100–103). §146 Abs. 4 AO requires that changes are attributable. Art. 32 DSGVO requires access control for personal data. A system with **no authentication** cannot attribute actions or prevent unauthorised changes. In an audit this weakens the evidential value of the books (§158 AO) and allows estimation (§162 AO). No statute literally says "a login is required", but the GoBD and DSGVO outcomes are hard to meet without one.

**SEC-01 Minimum: authentication in front of the app (strongly recommended)**
- **REQ, one of:**
  - (a) Built-in single-user password or passkey (WebAuthn), with optional TOTP.
  - (b) Documented reverse-proxy authentication (e.g. OIDC/Basic over TLS), with the app trusting a header only from the proxy.
  - (c) Bind to `127.0.0.1` or a VPN-only interface by default; refuse to start on `0.0.0.0` without auth configured, unless an explicit `--insecure` flag is set, which is logged.
- **Test:** Fresh install, request from another host → refused. Start with a public bind and no auth → startup error.

**SEC-02 Attribution without user accounts**
- **REQ:**
  - Every audit entry stores an actor (`owner`, `auditor`, `system:cron`, `api-token:<name>`), source IP and user agent.
  - Named API tokens for integrations, revocable.
  - The Verfahrensdokumentation documents that the single user is the business owner.
- **Test:** An action via an API token is logged with the token name.

**SEC-03 Read-only auditor access (Z1)**
- **Basis:** GoBD Rz. 165 ff.; §147 Abs. 6 Nr. 1 AO.
- **REQ:** Time-limited read-only access (separate credential or signed link), with server-side enforcement of no writes, fully logged.
- **Test:** POST/PUT/DELETE with the auditor credential → 403 for every endpoint (automated route-table test).

**SEC-04 Tamper evidence (compensates for weak access control)**
- **REQ:**
  - Audit hash chain (GOBD-06).
  - DB triggers preventing UPDATE/DELETE on finalised data.
  - Periodic signed checkpoints exported off-host (e-mail to the owner, or a WORM/object-lock bucket).
  - Optional RFC 3161 timestamps.
  - Integrity check on startup and nightly, with an alert on failure.
- **Test:** Manual DB edit → the integrity check reports it.

**SEC-05 Backups and restore**
- **Basis:** GoBD Rz. 103–106; Art. 32 Abs. 1 lit. c DSGVO.
- **REQ:**
  - Encrypted, versioned, off-site (EU) backups.
  - Immutable retention (object lock) of at least 30 days.
  - Monthly restore test reminder.
  - Backups include archived artifacts and the audit log.
  - Restoring a backup is itself logged.
- **Test:** Restore drill: hash-chain head after restore = before backup.

**SEC-06 Platform hardening**
- **REQ:**
  - TLS 1.2+ everywhere (also on LAN).
  - Encryption at rest (LUKS / DB-level).
  - Secrets (ELSTER certificate PIN, SMTP password) in an OS keyring or encrypted, never in logs.
  - CSRF/XSS protections even single-user (a browser-based attack on an unauthenticated localhost app is a real risk: use CORS lockdown and Host-header validation against DNS rebinding).
  - Automatic security updates documented.
- **Test:** A request with a foreign Host header → 421/403. CSRF test.

**SEC-07 Documentation**
- **REQ:** The Verfahrensdokumentation section "Zugriffskonzept" describes physical access to the host, who knows the credentials, backup custody and the auditor-access procedure.

---

## 12. Other requirements so the tool "never has issues"

**MISC-01 EPC QR code (GiroCode)**
- **Basis:** EPC069-12 (current v3.1, EPC). Payload lines:
  1. `BCD`
  2. `002` (BIC optional) or `001`
  3. `1` (UTF-8)
  4. `SCT`
  5. BIC (optional for v002)
  6. Name (≤ 70)
  7. IBAN
  8. `EUR` + amount (0.01–999999999.99, e.g. `EUR1190.00`)
  9. Purpose (4 characters, optional)
  10. Structured reference (RF creditor reference ≤ 35) **or**
  11. Unstructured remittance (≤ 140; use one or the other, not both)
  12. Info (≤ 70)

  Max payload 331 bytes, QR error-correction level M. Payment data must also be printed in plain text.
- **REQ:**
  - Generate the QR on invoices with the open amount (after advances/Skonto rules) and the invoice number as remittance.
  - The name equals the account holder name (Verification of Payee).
- **Test:** Decode the QR and assert the fields. Byte length ≤ 331. Scanning with 2 banking apps works.

**MISC-02 SEPA**
- **Basis:**
  - Reg. (EU) 260/2012 (SEPA), Reg. (EU) 2024/886 (Instant Payments; VoP since 09.10.2025).
  - Direct debit: mandate (signed, with mandate reference ≤ 35, creditor ID from the Bundesbank), pre-notification (default 14 days, can be shortened by agreement), pain.008.
  - Bank import: camt.053/054 (MT940 is being phased out [UNSURE about the German bank timeline]).
- **REQ:** Store the mandate with its date and type (CORE/B2B, first/recurring). Pre-notification on the invoice. Bank import camt.053 with automatic matching by invoice number or RF reference.
- **Test:** pain.008 validates against the XSD. camt.053 sample imports and matches.

**MISC-03 Price display to consumers**
- **Basis:** PAngV §3 (gross total prices incl. VAT for consumers).
- **REQ:** Offers and invoices to consumers display gross prices (net may be shown additionally). EN 16931 is net-based; ZUGFeRD gross-invoice support is planned [UPCOMING].
- **Test:** A B2C offer shows prices incl. VAT.

**MISC-04 USt-IdNr validation**
- **Basis:** §18e UStG (BZSt confirmation; **qualified** confirmation of name, place, postcode and street gives good-faith protection for intra-Community supplies, UStAE 18e.1, §6a Abs. 4 UStG).
  - BZSt eVatR confirms **foreign** IDs only. It moved to REST in July 2025; XML-RPC was switched off 30.11.2025.
  - EU VIES (REST API) for a simple check, including DE IDs.
- **REQ:**
  - Before the first K/AE invoice, and periodically (e.g. each invoice older than 3 months), run a qualified eVatR query.
  - Store the request and response (date, result codes A/B/C/D per field) as evidence with the customer, 10 years recommended.
  - Offline fallback: block K/AE until checked, or allow with a warning and an audit entry.
- **Test:** Mock API returns "B" for the name → warning, invoice can't be finalised as K without override.

**MISC-05 Bewirtungsbelege (business meals)**
- **Basis:**
  - §4 Abs. 5 Satz 1 Nr. 2 EStG (70% deductible; written record of place, date, participants, occasion, amount; invoice attached).
  - R 4.10 EStR.
  - BMF 30.06.2021 (machine-printed restaurant receipt from a TSE-secured till; > 250 €: host name on invoice).
  - **BMF 19.11.2025** (E-Rechnung and fully digital records; the Eigenbeleg must be approved electronically and stored unalterably, linked to the invoice).
  - Rates since 2026: food 7%, drinks 19%.
- **REQ:** Expense type "Bewirtung" requires a structured Eigenbeleg (participants, occasion: specific text required, generic "Geschäftsessen" flagged), links the receipt, locks the Eigenbeleg on approval, and splits 70/30 for EÜR. Input VAT 100% deductible.
- **Test:** Missing participants → cannot be posted. A posted Eigenbeleg is immutable.

**MISC-06 Travel expenses (Reisekosten)**
- **Basis:** §9 Abs. 4a EStG (meal allowances **14 €** > 8 h / arrival-departure day, **28 €** for 24 h), §9 Abs. 1 Nr. 4a EStG (business trips by car **0.30 €/km**), applied via §4 Abs. 5 Nr. 5 EStG. Commuting allowance 0.38 €/km from the first km since 2026 (StÄndG 2025) [UNSURE, not verified in this research]. Foreign per diems per the annual BMF letter.
- **REQ:** Travel module (optional) with a date-effective rate table. Meal reduction when meals are provided.
- **Test:** 2-day trip → 14 + 14. 3-day trip → 14 + 28 + 14.

**MISC-07 §35a EStG labour costs for private customers**
- **Basis:** §35a Abs. 3 EStG (customer tax credit for craftsman services; labour cost must be identifiable; payment by transfer).
- **REQ:** Line-type "Arbeitskosten / Material". On B2C invoices, show a separate labour subtotal (incl. VAT).
- **Test:** A mixed B2C invoice shows the labour-cost subtotal.

**MISC-08 Currency and foreign customers**
- **Basis:** §16 Abs. 6 UStG (VAT conversion to EUR at the official monthly rate, or the daily rate with Finanzamt approval); EN 16931 BT-6 VAT accounting currency.
- **REQ:** Foreign-currency invoices show the VAT amount in EUR (BT-111 with BT-6 = EUR). Rate source logged.
- **Test:** USD invoice: XML contains BT-6 EUR and BT-111.

**MISC-09 Rate-change readiness (lesson from 2020/21 and 2026)**
- **REQ:** All tax logic is date-effective by supply date. A "Stichtag-Simulation" test harness. Advances re-taxed (UST-41).
- **Test:** Inject a hypothetical future rate change → all document types compute correctly on both sides of the date.

**MISC-10 Accessibility**
- **Basis:** BFSG (European Accessibility Act, from 28.06.2025). It applies to consumer-facing e-commerce services, and micro-enterprises providing services are exempt. A B2B self-hosted tool is likely out of scope [UNSURE].
- **REQ:** WCAG 2.1 AA as a quality goal for generated PDFs (tagged PDF) and UI.

**MISC-11 Fines overview, for prioritising**
- **Basis:**
  - §26a UStG: up to 5,000 € (no or late invoice; not keeping invoices); up to 50,000 € for some other offences.
  - §379 AO (books, vouchers, §146a offences up to 25,000 €).
  - §146 Abs. 2c AO (up to 250,000 €).
  - §162 AO (estimation if books are improper).
  - Input VAT denial for customers (§15 UStG) when invoices are defective. This is the biggest commercial risk for your users' customers.

---

## 13. Suggested acceptance test suite

1. **Golden invoices** (PDF + XML + DATEV lines + UStVA mapping), one per category: 19 / 7 / 0 PV / exempt / KU / §13b domestic / EU service / intra-Community supply / export / non-taxable / Kleinbetrag / advance + final / storno / correction / self-billing / B2G with Leitweg-ID / foreign currency.
2. **Validation gate:** all outbound XML through the KoSIT validator (current XRechnung bundle) and the ZUGFeRD 2.5 Schematron; PDF/A-3 through veraPDF. CI fails on any error.
3. **E-Rechnung decision matrix** (ER-03), table-driven, covering 2025–2028 dates.
4. **Immutability suite:** direct DB UPDATE/DELETE attempts, hash-chain tamper, restore drill.
5. **Retention engine:** computed `retention_until` for each class and year; purge refusals.
6. **Date-effective rules:** rate changes (31.12.2025/01.01.2026), 2028 Ist-Versteuerer note, AfA windows, Basiszinssatz splits.
7. **Inbound E-Rechnung corpus:** KoSIT test suite and FeRD samples (all profiles, UBL and CII). MINIMUM/BASIC-WL correctly flagged.
8. **DATEV import test** with the Steuerberater (one quarter of real data) before go-live.
9. **Security:** no-auth startup refusal, auditor read-only route test, DNS-rebinding/Host-header test.

---

## 14. Open items to confirm with a Steuerberater or primary sources before freezing the spec

1. Exact wording and XML field for the 2028 "Versteuerung nach vereinnahmten Entgelten" note.
2. Kleinunternehmer edge cases around crossing the 100k € limit (UStAE 19.1, BMF 18.03.2025), and the VAT category/VATEX code for KU in XRechnung.
3. Whether Neugründer monthly UStVA returns from 2027.
4. Outcome of the JStG 2026 (GWG 1,200 € / Sammelposten; Bundestag vote around 13.11.2026) and the Kassenpflicht bill.
5. DATEV: current Formatversion accepted by the Steuerberater's installation (12 or 13), encoding, current tax-key list.
6. Current UStVA 2026/2027 Kennzahlen (official Vordruckmuster) and the ZM CSV layout.
7. ERiC licence terms for redistribution in a self-hosted product.
8. Allowed XRechnung TypeCodes (BR-DE-17) for advance and partial invoices.
9. AEAO zu §146a wording on bookkeeping/invoicing software (TSE exposure).
10. BMF 15.10.2025 Randziffern for Dauerschuldverhältnisse, corrections and self-billing as E-Rechnung. The BMF site was unreachable during research.

---

## Sources

**Statutes (gesetze-im-internet.de)**
- UStG §14: https://www.gesetze-im-internet.de/ustg_1980/__14.html
- UStG §14a: https://www.gesetze-im-internet.de/ustg_1980/__14a.html
- UStG §18: https://www.gesetze-im-internet.de/ustg_1980/__18.html
- UStG §19: https://www.gesetze-im-internet.de/ustg_1980/__19.html
- UStG §20: https://www.gesetze-im-internet.de/ustg_1980/__20.html
- UStG §27 (transition rules): https://www.gesetze-im-internet.de/ustg_1980/__27.html
- UStDV §31: https://www.gesetze-im-internet.de/ustdv_1980/__31.html
- UStDV §33: https://www.gesetze-im-internet.de/ustdv_1980/__33.html
- UStDV §34a: https://www.gesetze-im-internet.de/ustdv_1980/__34a.html
- AO §141: https://www.gesetze-im-internet.de/ao_1977/__141.html
- AO §146: https://www.gesetze-im-internet.de/ao_1977/__146.html
- AO §147: https://www.gesetze-im-internet.de/ao_1977/__147.html
- HGB §241a: https://www.gesetze-im-internet.de/hgb/__241a.html
- BGB §271a: https://www.gesetze-im-internet.de/bgb/__271a.html
- BGB §707b: https://www.gesetze-im-internet.de/bgb/__707b.html
- UStG amendment history (buzer.de): https://www.buzer.de/gesetz/5509/l.htm
- UStG §14 version history (buzer.de): https://www.buzer.de/14_UStG.htm
- 9. StBerRÄndG of 29.06.2026 (buzer.de): https://www.buzer.de/gesetz/17592/index.htm

**BMF and authorities**
- BMF letter 15.10.2025 on E-Rechnung: https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Umsatzsteuer/Umsatzsteuer-Anwendungserlass/2025-10-15-einfuehrung-obligatorische-e-rechnung.pdf
- BMF E-Rechnung FAQ: https://www.bundesfinanzministerium.de/Content/DE/FAQ/e-rechnung.html
- BMF letter 19.11.2025 on Bewirtungskosten: https://bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Einkommensteuer/2025-11-19-bewirtungskosten-als-betriebsausgaben.pdf
- Bundesbank, Basiszinssatz from 01.07.2026: https://www.bundesbank.de/de/presse/pressemitteilungen/bekanntgabe-des-basiszinssatzes-zum-1-juli-2026-anpassung-auf-1-52--941386
- Bundesbank, Basiszinssatz overview: https://www.bundesbank.de/de/bundesbank/organisation/agb-und-regelungen/basiszinssatz-607820
- Finanzamt Bayern, §146a notification: https://finanzamt.bayern.de/Informationen/Steuerinfos/Weitere_Themen/Elektronische_Kassensysteme/2024-06-28-mitteilungsverpflichtung-nach-AO.pdf

**Standards bodies**
- XRechnung versions and bundles (KoSIT/xeinkauf): https://xeinkauf.de/xrechnung/versionen-und-bundles/
- KoSIT XRechnung validator configuration: https://github.com/itplr-kosit/validator-configuration-xrechnung
- ZUGFeRD 2.5 press release (FeRD): https://www.ferd-net.de/fileadmin/user_upload/FeRD/f%C3%BCr_FeRD-Meldungen/20260610_ZUGFeRD_2_5_Factur-X_1_09_Press_Release_DE.pdf
- ZUGFeRD 2.5.2 (FeRD): https://www.ferd-net.de/en/downloads/publications/details/zugferd-252-english
- ZUGFeRD 2.4 announcement (FNFE-MPE): https://fnfe-mpe.org/wp-content/uploads/2025/12/2025-12-04_ZUGFeRD_2.4_Factur-X_1.08_Meldung_DE.pdf
- EPC QR code guidelines (EPC069-12): https://www.europeanpaymentscouncil.eu/node/1511
- EPC069-12 v3.0 PDF: https://europeanpaymentscouncil.eu/sites/default/files/kb/file/2022-09/EPC069-12%20v3.0%20Quick%20Response%20Code%20-%20Guidelines%20to%20Enable%20the%20Data%20Capture%20for%20the%20Initiation%20of%20an%20SCT_0.pdf
- DATEV-Format header: https://developer.datev.de/datev/platform/en/dtvf/formate/header
- DATEV-Format interface requirements: https://developer.datev.de/datev/platform/en/schnittstellenvorgaben/dtvf

**Secondary sources (chambers, advisory firms, trade press)**
- Deloitte on the BMF letter of 15.10.2025: https://www.deloitte-tax-news.de/steuern/indirekte-steuern-zoll/bmf-zweites-schreiben-zur-einfuehrung-der-verpflichtenden-e-rechnung-fuer-inlaendische-b2b-umsaetze.html
- Grant Thornton on the BMF letter of 15.10.2025: https://www.grantthornton.de/themen/2025/e-rechnung-das-neue-bmf-schreiben-im-uberblick/
- IHK Köln on the BMF letter of 15.10.2025: https://www.ihk.de/koeln/hauptnavigation/recht-steuern/steuern/bmf-schreiben-zur-e-rechnung-vom-15-10-2025-6774012
- KPMG on the GoBD second amendment: https://kpmg.com/de/de/themen/2025/07/bmf-gobd-zweite-aenderung.html
- Deloitte on the GoBD update: https://www.deloitte-tax-news.de/steuern/indirekte-steuern-zoll/bmf-aktualisierung-der-gobd-und-entwurf-einer-zweiten-verwaltungsanweisung-zur-e-rechnung.html
- GoBD 2025 amendment excerpt (umwelt-online): https://umwelt-online.de/recht/allgemei/steuer/11032024.htm
- Ebner Stolz on BMF 18.03.2025 (Kleinunternehmer): https://www.ebnerstolz.de/de/unser-angebot/leistungen/steuerberatung/umsatzsteuer/bmf-aenderung-kleinunternehmerregelung-86402.html
- IHK Berlin, Kleinunternehmerregelung: https://www.ihk.de/berlin/service-und-beratung/recht-und-steuern/steuern-und-finanzen/kleinunternehmerregelung-4408200
- IHK Rhein-Neckar, E-Rechnungspflicht: https://www.ihk.de/rhein-neckar/recht/steuerrecht/umsatzsteuer/e-rechnungspflicht-5931752
- Haufe on JStG 2024 (Ist-Versteuerer input VAT): https://www.haufe.de/id/beitrag/jahressteuergesetz-jstg-2024-610-vorsteuerabzug-bei-leistungsbezug-von-einem-istversteuerer-15-abs-1-satz-1-nr-1-ustg-HI16311118.html
- IWW on JStG 2024: https://www.iww.de/pfb/steuern-und-recht-aktuell/gesetzgebung-jstg-2024-hat-den-vorsteuerabzug-reformiert-f168354
- IWW on restaurant VAT at 7%: https://www.iww.de/gstb/steuerrecht-aktuell/restaurant-und-verpflegungsdienstleistungen-weihnachtsgeschenk-fuer-die-gastronomie-gastrosteuer-von-7-ust-jetzt-amtlich-f171879
- Lexware on BEG IV: https://www.lexware.de/wissen/buchhaltung-finanzen/buerokratieentlastungsgesetz/
- EY on the Investitionssofortprogramm: https://www.ey.com/content/dam/ey-unified-site/ey-com/de-de/technical/steuernachrichten/steuerl_invprogramm_22072025_final.pdf
- KPMG on the KassenSichV amendment: https://kpmg.com/de/de/themen/2026/01/2-vo-aend-kassensichvo-bgbl.html
- PwC on the JStG 2026 and Kassenpflicht drafts: https://blogs.pwc.de/de/steuern-und-recht/article/256881/gesetzesentwuerfe-jahressteuergesetz-2026-kassenpflicht/
- topagrar on Kassenpflicht exceptions: https://www.topagrar.com/betriebsleitung/news/kassenpflicht-doch-ausnahmen-geplant-20028162.html
- Ebner Stolz on the Bundesrat statement on JStG 2026: https://www.ebnerstolz.de/de/unser-angebot/leistungen/steuerberatung/allgemeine-steuerberatung/stellungnahme-bundesrat-jstg-2026-113679.html
- Ecovis on the DSFinV-BV draft: https://ecovis-kso.com/blog/buchfuehrungsdatenschnittstelle-dsfinvbv-neuer-entwurf/
- ZDH on the Bewirtungskosten letter: https://www.zdh.de/ueber-uns/fachbereich-steuern-und-finanzen/lohn-und-einkommensteuer/bmf-aktualisiertes-schreiben-zu-der-anerkennung-von-bewirtungsko/
- eVatR REST wrapper (unofficial): https://root.packagist.org/packages/rechtlogisch/evatr
- VDIV on Verification of Payee: https://vdiv.de/news-details/sepa-sicherheitsmassnahme-verification-of-payee-ab-9-oktober-2025-pflicht
- WKO on ViDA: https://www.wko.at/oe/news/kurzinfo-vida-eu-mehrwertsteuervorschriften
- Agicap on XRechnung 4.0: https://agicap.com/de/artikel/xrechnung/
- Spendesk on ZUGFeRD profiles: https://www.spendesk.com/de/blog/zugferd-rechnung-e-rechnungspflicht/

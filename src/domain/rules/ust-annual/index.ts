/**
 * USt-Jahreserklärung (USt 2 A) line mapping per tax year (F08 TAX-023, UVA-03). The worksheet sums the UStVA
 * Kennzahlen of the year (`src/domain/rules/ustva`) and places them on the Zeile/Kennzahl of the annual return. Line
 * numbers change yearly, so every table carries `verifiedAgainstForm`; without it the worksheet shows the values with
 * a banner and the Mein ELSTER copy strings are blocked (E-UVA-20; block rather than guess).
 *
 *  - `ust-annual-2026.1`: transcribed from the official Vordruck „USt 2 A Umsatzsteuererklärung 2026“
 *    (2026USt2A501–506, Dezember 2025) and the Anleitung USt 2 E, BMF-Schreiben vom 29.12.2025
 *    (GZ III C 3 - S 7344/00040/008/034, DOK COO.7005.100.3.13669962, BStBl I 2025 S. 2126;
 *    https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Umsatzsteuer/
 *    2025-12-29-muster-USt-erklaerung-2026.pdf) — each Zeile/Kennzahl pair below read from the Vordruck on 2026-10-23.
 *
 * Rows the app cannot fill exactly are marked `review` (no copy string): the annual return splits what one UStVA
 * Kennzahl collects (Kz 48 → Zeilen 51–54 by paragraph; § 17 write-offs of Kz 50 are part of the Abschnitt-B bases and
 * only „nachrichtlich“ in Zeile 84). Zeilen 24/27 carry a `hint`: unentgeltliche Wertabgaben booked with 19 %/7 % are
 * inside Kz 81/86 and belong to Zeilen 25/26 and 28/29 of the annual return.
 *
 * LEGAL-OPEN: 01-compliance open item 6 (USt-Jahreserklärung lines per year, verified per data release; the split of
 * the review rows is the owner's manual step in Mein ELSTER).
 */

/** What a worksheet row takes from the year's UStVA computation (`computeUstva` over the whole year). */
export type UstAnnualSource =
  /** Bemessungsgrundlage of a UStVA Kennzahl, whole euros (form value). */
  | { readonly ustvaKz: string; readonly take: "base" }
  /** Tax of a UStVA Kennzahl: `formTax` = computed from the whole-euro base, `value` = entered tax field. */
  | { readonly ustvaKz: string; readonly take: "formTax" | "value" }
  /** Computed result rows of section K. */
  | { readonly result: "verbleibend" | "vorauszahlungssoll" | "abschluss" };

export interface UstAnnualRow {
  readonly zeile: number;
  /** Kennzahl of the Vordruck; null for columns without a Kennzahl (e.g. the tax next to Kz 177). */
  readonly kz: string | null;
  readonly label: string;
  /** base = whole euros; tax = euro and cent. */
  readonly kind: "base" | "tax";
  readonly source: UstAnnualSource;
  /** Not copyable: the owner has to split/check the value (reason shown). */
  readonly review?: string;
  /** Copyable, with a hint to check (shown next to the value). */
  readonly hint?: string;
}

export interface UstAnnualMapping {
  readonly version: string;
  readonly formYear: number;
  readonly formName: string;
  readonly verifiedAgainstForm?: { readonly source: string; readonly verifiedOn: string };
  readonly rows: readonly UstAnnualRow[];
}

const WERTABGABEN =
  "Enthält ggf. unentgeltliche Wertabgaben (§ 3 Abs. 1b/9a UStG), die in der Jahreserklärung in eigenen Zeilen stehen – bitte prüfen.";

const R = (
  zeile: number,
  kz: string | null,
  label: string,
  kind: UstAnnualRow["kind"],
  source: UstAnnualSource,
  extra: Pick<UstAnnualRow, "review" | "hint"> = {},
): UstAnnualRow => ({ zeile, kz, label, kind, source, ...extra });

/** USt 2 A 2026, the rows the app fills (form order). */
const ROWS_2026: readonly UstAnnualRow[] = [
  // B. Steuerpflichtige Lieferungen, sonstige Leistungen und unentgeltliche Wertabgaben
  R(
    24,
    "177",
    "Lieferungen und sonstige Leistungen zu 19 %",
    "base",
    { ustvaKz: "81", take: "base" },
    { hint: WERTABGABEN },
  ),
  R(24, null, "Steuer zu Zeile 24 (berechnet)", "tax", { ustvaKz: "81", take: "formTax" }),
  R(
    27,
    "275",
    "Lieferungen und sonstige Leistungen zu 7 %",
    "base",
    { ustvaKz: "86", take: "base" },
    { hint: WERTABGABEN },
  ),
  R(27, null, "Steuer zu Zeile 27 (berechnet)", "tax", { ustvaKz: "86", take: "formTax" }),
  R(30, "157", "Lieferungen und sonstige Leistungen zu 0 %", "base", { ustvaKz: "87", take: "base" }),
  // C. Steuerfreie Lieferungen, sonstige Leistungen und unentgeltliche Wertabgaben
  R(42, "741", "Innergemeinschaftliche Lieferungen an Abnehmer mit USt-IdNr.", "base", { ustvaKz: "41", take: "base" }),
  R(45, "752", "Ausfuhrlieferungen (§ 4 Nr. 1 Buchst. a UStG)", "base", { ustvaKz: "43", take: "base" }),
  R(
    54,
    "240",
    "Steuerfreie Umsätze ohne Vorsteuerabzug (zum Gesamtumsatz gehörend, nach § … UStG)",
    "base",
    { ustvaKz: "48", take: "base" },
    {
      review:
        "Die Jahreserklärung trennt steuerfreie Umsätze ohne Vorsteuerabzug nach Vorschrift (Zeilen 51–54) – bitte zuordnen.",
    },
  ),
  // D. Innergemeinschaftliche Erwerbe
  R(57, "781", "Steuerpflichtige innergemeinschaftliche Erwerbe zum Steuersatz von 19 %", "base", {
    ustvaKz: "89",
    take: "base",
  }),
  R(57, null, "Steuer zu Zeile 57 (berechnet)", "tax", { ustvaKz: "89", take: "formTax" }),
  R(58, "793", "Steuerpflichtige innergemeinschaftliche Erwerbe zum Steuersatz von 7 %", "base", {
    ustvaKz: "93",
    take: "base",
  }),
  R(58, null, "Steuer zu Zeile 58 (berechnet)", "tax", { ustvaKz: "93", take: "formTax" }),
  // G. Leistungsempfänger als Steuerschuldner (§ 13b UStG)
  R(
    71,
    "846",
    "Sonstige Leistungen eines im übrigen Gemeinschaftsgebiet ansässigen Unternehmers (§ 13b Abs. 1)",
    "base",
    {
      ustvaKz: "46",
      take: "base",
    },
  ),
  R(71, "847", "Steuer zu Kz 846", "tax", { ustvaKz: "47", take: "value" }),
  R(73, "877", "Andere Leistungen (§ 13b Abs. 2 Nr. 1, 2, 4 bis 12 UStG)", "base", { ustvaKz: "84", take: "base" }),
  R(73, "878", "Steuer zu Kz 877", "tax", { ustvaKz: "85", take: "value" }),
  // H. Ergänzende Angaben zu Umsätzen
  R(
    76,
    "209",
    "Steuerpflichtige Umsätze, für die der Leistungsempfänger die Steuer nach § 13b Abs. 5 UStG schuldet",
    "base",
    {
      ustvaKz: "60",
      take: "base",
    },
  ),
  R(80, "721", "Nicht steuerbare sonstige Leistungen gemäß § 18b Satz 1 Nr. 2 UStG", "base", {
    ustvaKz: "21",
    take: "base",
  }),
  R(81, "205", "Übrige nicht steuerbare Umsätze (Leistungsort nicht im Inland)", "base", {
    ustvaKz: "45",
    take: "base",
  }),
  R(
    84,
    "650",
    "Minderung der Bemessungsgrundlage für uneinbringliche Forderungen (§ 17 Abs. 2 Nr. 1 UStG, in Abschnitt B enthalten)",
    "base",
    { ustvaKz: "50", take: "base" },
    {
      review:
        "In der Jahreserklärung ist die Minderung in den Bemessungsgrundlagen von Abschnitt B enthalten und hier nur nachrichtlich (positiver Betrag) – bitte Zeilen 24/27 und 84 prüfen.",
    },
  ),
  // I. Abziehbare Vorsteuerbeträge
  R(85, "320", "Vorsteuerbeträge aus Rechnungen von anderen Unternehmern", "tax", { ustvaKz: "66", take: "value" }),
  R(86, "761", "Vorsteuerbeträge aus innergemeinschaftlichen Erwerben", "tax", { ustvaKz: "61", take: "value" }),
  R(87, "762", "Entstandene Einfuhrumsatzsteuer", "tax", { ustvaKz: "62", take: "value" }),
  R(89, "467", "Vorsteuerbeträge aus Leistungen im Sinne des § 13b UStG", "tax", { ustvaKz: "67", take: "value" }),
  // K. Berechnung der zu entrichtenden Umsatzsteuer
  R(124, "816", "Verbleibende Umsatzsteuer / verbleibender Überschuss", "tax", { result: "verbleibend" }),
  R(125, null, "Vorauszahlungssoll (einschließlich Sondervorauszahlung)", "tax", { result: "vorauszahlungssoll" }),
  R(126, "820", "Abschlusszahlung / Erstattungsanspruch", "tax", { result: "abschluss" }),
];

export const UST_ANNUAL_MAPPINGS: Readonly<Record<number, UstAnnualMapping>> = {
  2026: {
    version: "ust-annual-2026.1",
    formYear: 2026,
    formName: "Umsatzsteuererklärung 2026 (USt 2 A)",
    rows: ROWS_2026,
    verifiedAgainstForm: {
      source:
        "Vordruck USt 2 A Umsatzsteuererklärung 2026 (2026USt2A501–506) mit Anleitung USt 2 E, BMF-Schreiben vom 29.12.2025, III C 3 - S 7344/00040/008/034, BStBl I 2025 S. 2126",
      verifiedOn: "2026-10-23",
    },
  },
};

/** The mapping of a tax year, or null (E-UVA-07: not shipped yet). */
export function ustAnnualMappingFor(year: number): UstAnnualMapping | null {
  return UST_ANNUAL_MAPPINGS[year] ?? null;
}

/**
 * Mein ELSTER guide data of the annual return (TAX-020): path and checklist. Navigation labels follow the UStVA guide
 * data of the year (decided default). LEGAL-OPEN: F08-Q12 — Mein ELSTER navigation labels ⚠ verified per data release.
 */
export const ustAnnualGuideData = (
  year: number,
  results: { verbleibend: string; abschluss: string } = {
    verbleibend: "Verbleibende Umsatzsteuer",
    abschluss: "Abschlusszahlung",
  },
) => ({
  id: `elster-ust-annual-${year}`,
  formName: `Umsatzsteuererklärung ${year} (USt 2 A)`,
  prerequisites: [
    "ELSTER-Unternehmenskonto (Organisationszertifikat) oder persönliches ELSTER-Konto mit Zertifikatsdatei bzw. Sicherheitsstick einrichten (einmalig, Aktivierungsbrief per Post).",
    "Steuernummer des Unternehmens in den Firmendaten hinterlegen – sie wird im Formular als Erstes abgefragt.",
    "Mein ELSTER in einem zweiten Fenster neben dieser Seite öffnen und die Werte Zeile für Zeile kopieren.",
  ],
  navigation: [
    "Formulare & Leistungen",
    "Alle Formulare",
    "Unternehmen",
    "Umsatzsteuer",
    `Umsatzsteuererklärung ${year}`,
  ],
  checklist: [
    "Steuernummer und Kalenderjahr im ELSTER-Formular stimmen.",
    `Formularjahr stimmt (Umsatzsteuererklärung ${year}).`,
    "Zeile 21: Versteuerungsart (vereinbarte oder vereinnahmte Entgelte) wie in den Firmendaten gewählt.",
    "Alle Werte dieser Ausfüllhilfe sind eingetragen; die als „bitte prüfen“ markierten Zeilen sind von Hand zugeordnet.",
    "ELSTER-Funktion „Prüfen“ zeigt keine Fehler.",
    `Die ELSTER-Vorschau zeigt in ${results.verbleibend} und ${results.abschluss} dieselben Beträge wie diese Seite.`,
    "„Absenden“ wählen, danach das Übermittlungsprotokoll (PDF) speichern und das Transferticket notieren.",
  ],
});

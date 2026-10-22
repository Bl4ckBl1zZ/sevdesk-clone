/**
 * Anlage EÜR line mapping per tax year (F08 §4.6, TAX-015, AO-02; 01-compliance open item 6). Semantic EÜR keys
 * (`src/domain/rules/accounting/types.ts`) map to the official Zeile and Kennzahl of the year's Vordruck. Line numbers
 * change yearly, so every table carries `verifiedAgainstForm`; a table without it shows the values with the banner
 * „Zeilen gegen amtlichen Vordruck prüfen“ while the Mein ELSTER instructions and the EÜR submission record are
 * blocked (E-UVA-20; block rather than guess).
 *
 *  - `euer-2025.1`: transcribed from the official Vordruck „Anlage EÜR 2025“ and its Anleitung, BMF-Schreiben vom
 *    29.08.2025 (GZ IV C 6 - S 2142/00023/010/001, BStBl I 2025 S. 1652) — verified.
 *  - `euer-2026.1`: transcribed from the official Vordruck „Anlage EÜR 2026“ (2026AnlEÜR801–803, August 2026), the
 *    Anlage AVEÜR 2026 and the Anleitung, BMF-Schreiben vom 01.09.2026 (GZ IV C 6 - S 2142/00024/010/001,
 *    DOK COO.7005.100.3.15620198; https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/
 *    Steuerarten/Einkommensteuer/2026-09-01-anlage-EUER-2026.pdf) — verified line by line on 2026-10-23.
 *    Change against 2025: a new Zeile 27 „Bildung Rücklage Tierbewertung bei Land- und Forstwirten“ (Anlage LuF,
 *    not supported by the app); the Übertrag moves to Zeile 28, „Waren, Rohstoffe und Hilfsstoffe“ from Zeile 27 to
 *    Zeile 29 and every later line one down (Summe Betriebsausgaben Zeile 76, Gewinn Zeile 98, Entnahmen/Einlagen
 *    Zeile 107/108). No Kennzahl changed; Zeilen 1–23 and the Anlage AVEÜR Zeilen/Kennzahlen are unchanged.
 *
 * LEGAL-OPEN: 01-compliance open item 6 (Anlage EÜR lines per year, verified per data release).
 */
import type { EuerKey } from "../accounting/types";

export type EuerSection = "BE" | "BA" | "BA_BESCHRAENKT" | "KFZ" | "ERGEBNIS" | "PRIVAT";

export interface EuerLine {
  /** Zeile of the Vordruck. */
  readonly zeile: number;
  /** Kennzahl (ELSTER field); null for lines without a value field. */
  readonly kz: string;
  readonly label: string;
  readonly section: EuerSection;
  /** Keys summed into this line. */
  readonly keys: readonly EuerKey[];
  /** Beschränkt abziehbare Betriebsausgaben: the column of the line. „nicht abziehbar“ does not reduce the profit. */
  readonly column?: "nicht_abziehbar" | "abziehbar";
  /** Kleinunternehmer only: Zeile 12/13 take all Betriebseinnahmen of a KU (Anleitung zu Zeile 12). */
  readonly kuOnly?: true;
  /** Informational line („davon …“), not part of the sums. */
  readonly informational?: true;
}

export interface AveuerGroup {
  readonly key: "immateriell" | "gebaeude" | "kfz" | "buero" | "andere";
  readonly title: string;
  /** Zeilen/Kz of: AK-Summe, Buchwert Beginn, Zugänge, AfA, Abgänge, Buchwert Ende. */
  readonly fields: Readonly<
    Record<
      "akCents" | "bookValueStartCents" | "additionsCents" | "afaCents" | "disposalsCents" | "bookValueEndCents",
      { readonly zeile: number; readonly kz: string }
    >
  >;
}

export interface AveuerMapping {
  readonly groups: readonly AveuerGroup[];
  /** Sammelposten: per pool year offset (0 = current year … 4) the Zeilen/Kz of Bildung/AK, Buchwert Beginn, Auflösung, Buchwert Ende. */
  readonly pools: readonly {
    readonly offset: number;
    readonly akKz: string;
    readonly akZeile: number;
    readonly startKz?: string;
    readonly releaseKz: string;
    readonly releaseZeile: number;
    readonly endKz?: string;
  }[];
}

export interface EuerMapping {
  readonly version: string;
  readonly formYear: number;
  readonly formName: string;
  readonly verifiedAgainstForm?: { readonly source: string; readonly verifiedOn: string };
  readonly lines: readonly EuerLine[];
  readonly sums: {
    readonly einnahmen: { readonly zeile: number; readonly kz: string };
    readonly ausgaben: { readonly zeile: number; readonly kz: string };
    readonly gewinn: { readonly zeile: number; readonly kz: string };
  };
  /** Schuldzinsen above this amount require the Anlage SZ (§ 4 Abs. 4a EStG), which the app does not compute. */
  readonly anlageSzThresholdCents: number;
  readonly aveuer: AveuerMapping;
}

const L = (
  zeile: number,
  kz: string,
  label: string,
  section: EuerSection,
  keys: readonly EuerKey[],
  extra: Partial<Pick<EuerLine, "column" | "kuOnly" | "informational">> = {},
): EuerLine => ({ zeile, kz, label, section, keys, ...extra });

/** Anlage EÜR 2025 (BMF 29.08.2025), lines the app fills. Lines for LuF, §7g, §6b, InvStG etc. are not supported. */
const LINES_2025: readonly EuerLine[] = [
  // 1. Betriebseinnahmen
  L(
    12,
    "111",
    "Betriebseinnahmen als umsatzsteuerlicher Kleinunternehmer (nach § 19 Abs. 1 UStG)",
    "BE",
    ["BE.KU", "BE.STFREI", "BE.SONSTIGE"],
    { kuOnly: true },
  ),
  L(
    13,
    "119",
    "davon nicht steuerbare Umsätze sowie Umsätze nach § 19 Abs. 2 Satz 1 Nr. 1 und 2 sowie Satz 2 UStG",
    "BE",
    ["BE.STFREI", "BE.SONSTIGE"],
    { kuOnly: true, informational: true },
  ),
  L(15, "112", "Umsatzsteuerpflichtige Betriebseinnahmen (ohne solche zum ermäßigten Steuersatz von 0 %)", "BE", [
    "BE.STPFL",
  ]),
  L(
    16,
    "103",
    "Betriebseinnahmen, die umsatzsteuerfrei oder nicht umsatzsteuerbar sind, dem Steuersatz von 0 % unterliegen oder für die der Leistungsempfänger die Umsatzsteuer nach § 13b UStG schuldet",
    "BE",
    ["BE.STFREI", "BE.SONSTIGE"],
  ),
  L(17, "140", "Vereinnahmte Umsatzsteuer sowie Umsatzsteuer auf unentgeltliche Wertabgaben", "BE", [
    "BE.UST_VEREINNAHMT",
  ]),
  L(18, "141", "Vom Finanzamt erstattete und ggf. verrechnete Umsatzsteuer", "BE", ["BE.UST_ERSTATTET"]),
  L(19, "102", "Veräußerung oder Entnahme von Anlagevermögen", "BE", ["BE.ANLAGEN_VERAEUSSERUNG"]),
  L(21, "108", "Sonstige Sach-, Nutzungs- und Leistungsentnahmen", "BE", ["BE.ENTNAHMEN"]),
  // 2. Betriebsausgaben
  L(27, "100", "Waren, Rohstoffe und Hilfsstoffe einschließlich der Nebenkosten", "BA", ["BA.WAREN"]),
  L(29, "110", "Bezogene Fremdleistungen", "BA", ["BA.FREMDLEISTUNGEN"]),
  L(30, "120", "Ausgaben für eigenes Personal (z. B. Gehälter, Löhne und Versicherungsbeiträge)", "BA", [
    "BA.PERSONAL",
  ]),
  L(31, "136", "AfA auf Grundstücke/grundstücksgleiche Rechte", "BA", ["BA.AFA_UNBEWEGLICH"]),
  L(32, "131", "AfA auf immaterielle Wirtschaftsgüter", "BA", ["BA.AFA_IMMATERIELL"]),
  L(33, "130", "AfA auf bewegliche Wirtschaftsgüter", "BA", ["BA.AFA_BEWEGLICH"]),
  L(36, "132", "Aufwendungen für geringwertige Wirtschaftsgüter nach § 6 Abs. 2 EStG", "BA", ["BA.GWG"]),
  L(37, "137", "Auflösung Sammelposten nach § 6 Abs. 2a EStG", "BA", ["BA.SAMMELPOSTEN_AUFLOESUNG"]),
  L(38, "135", "Restbuchwerte der ausgeschiedenen Anlagegüter", "BA", ["BA.RESTBUCHWERT"]),
  L(39, "150", "Miete/Pacht für Geschäftsräume und betrieblich genutzte Grundstücke", "BA", ["BA.RAUMKOSTEN"]),
  L(41, "151", "Sonstige Aufwendungen für betrieblich genutzte Grundstücke (ohne Schuldzinsen und AfA)", "BA", [
    "BA.RAUM_SONSTIGE",
  ]),
  L(43, "280", "Aufwendungen für Telekommunikation (z. B. Telefon, Internet)", "BA", ["BA.TELEKOMMUNIKATION"]),
  L(44, "221", "Übernachtungs- und Reisenebenkosten bei Geschäftsreisen des Steuerpflichtigen", "BA", ["BA.REISE"]),
  L(45, "281", "Fortbildungskosten (ohne Reisekosten)", "BA", ["BA.FORTBILDUNG"]),
  L(46, "194", "Kosten für Rechts- und Steuerberatung, Buchführung", "BA", ["BA.BERATUNG"]),
  L(48, "225", "Erhaltungsaufwendungen (z. B. Instandhaltung, Wartung, Reparatur; ohne Gebäude und Kfz)", "BA", [
    "BA.ERHALTUNG",
  ]),
  L(49, "223", "Beiträge, Gebühren, Abgaben und Versicherungen (ohne solche für Gebäude und Kfz)", "BA", [
    "BA.BEITRAEGE",
  ]),
  L(50, "228", "Laufende EDV-Kosten (z. B. Beratung, Wartung, Reparatur)", "BA", ["BA.EDV"]),
  L(51, "229", "Arbeitsmittel (z. B. Bürobedarf, Porto, Fachliteratur)", "BA", ["BA.ARBEITSMITTEL"]),
  L(54, "224", "Werbekosten (z. B. Inserate, Werbespots, Plakate)", "BA", ["BA.WERBUNG"]),
  L(56, "234", "Übrige Schuldzinsen", "BA", ["BA.ZINSEN"]),
  L(57, "185", "Gezahlte und nach § 15 UStG abziehbare Vorsteuerbeträge", "BA", ["BA.VORSTEUER"]),
  L(58, "186", "An das Finanzamt gezahlte und ggf. verrechnete Umsatzsteuer", "BA", ["BA.UST_GEZAHLT"]),
  L(60, "183", "Übrige unbeschränkt abziehbare Betriebsausgaben", "BA", ["BA.SONSTIGE"]),
  // Beschränkt abziehbare Betriebsausgaben (columns per the Vordruck: nicht abziehbar | abziehbar)
  L(62, "164", "Geschenke – nicht abziehbar", "BA_BESCHRAENKT", ["BA.GESCHENKE_NICHT_ABZIEHBAR"], {
    column: "nicht_abziehbar",
  }),
  L(62, "174", "Geschenke – abziehbar", "BA_BESCHRAENKT", ["BA.GESCHENKE"], { column: "abziehbar" }),
  L(63, "165", "Bewirtungsaufwendungen – nicht abziehbar", "BA_BESCHRAENKT", ["BA.BEWIRTUNG_NICHT_ABZIEHBAR"], {
    column: "nicht_abziehbar",
  }),
  L(63, "175", "Bewirtungsaufwendungen – abziehbar", "BA_BESCHRAENKT", ["BA.BEWIRTUNG_ABZIEHBAR"], {
    column: "abziehbar",
  }),
  L(64, "171", "Verpflegungsmehraufwendungen", "BA_BESCHRAENKT", ["BA.VERPFLEGUNG"], { column: "abziehbar" }),
  // Anleitung zu Zeile 67: „Die Gewerbesteuer … ist in der Spalte ‚nicht abziehbar‘ zu erklären.“
  L(
    67,
    "168",
    "Sonstige beschränkt abziehbare Betriebsausgaben – nicht abziehbar (u. a. Gewerbesteuer)",
    "BA_BESCHRAENKT",
    ["BA.GEWERBESTEUER"],
    { column: "nicht_abziehbar" },
  ),
  // Kfz-Kosten und andere Fahrtkosten
  L(68, "144", "Kfz: Leasingkosten", "KFZ", ["BA.KFZ_LEASING"]),
  L(69, "145", "Kfz: Steuern, Versicherungen und Maut", "KFZ", ["BA.KFZ_STEUERN_VERS"]),
  L(
    70,
    "146",
    "Sonstige tatsächliche Fahrtkosten ohne AfA und Zinsen (z. B. Reparaturen, Wartungen, Treibstoff, öffentliche Verkehrsmittel)",
    "KFZ",
    ["BA.KFZ"],
  ),
  // 5. Zusätzliche Angaben bei Einzelunternehmen
  L(106, "122", "Entnahmen einschließlich Sach-, Leistungs- und Nutzungsentnahmen", "PRIVAT", ["PRIVAT.ENTNAHME"]),
  L(107, "123", "Einlagen einschließlich Sach-, Leistungs- und Nutzungseinlagen", "PRIVAT", ["PRIVAT.EINLAGE"]),
];

/** Anlage AVEÜR 2025 (same BMF-Schreiben): the groups the asset register fills. GWG are not entered (Anleitung). */
const AVEUER_2025: AveuerMapping = {
  groups: [
    {
      key: "gebaeude",
      title: "Gebäude",
      fields: {
        akCents: { zeile: 9, kz: "110" },
        bookValueStartCents: { zeile: 10, kz: "111" },
        additionsCents: { zeile: 11, kz: "112" },
        afaCents: { zeile: 13, kz: "114" },
        disposalsCents: { zeile: 14, kz: "115" },
        bookValueEndCents: { zeile: 15, kz: "116" },
      },
    },
    {
      key: "immateriell",
      title: "Immaterielle Wirtschaftsgüter",
      fields: {
        akCents: { zeile: 34, kz: "320" },
        bookValueStartCents: { zeile: 35, kz: "321" },
        additionsCents: { zeile: 36, kz: "322" },
        afaCents: { zeile: 37, kz: "324" },
        disposalsCents: { zeile: 38, kz: "325" },
        bookValueEndCents: { zeile: 39, kz: "326" },
      },
    },
    {
      key: "kfz",
      title: "Bewegliche Wirtschaftsgüter – Kfz",
      fields: {
        akCents: { zeile: 40, kz: "400" },
        bookValueStartCents: { zeile: 41, kz: "401" },
        additionsCents: { zeile: 42, kz: "402" },
        afaCents: { zeile: 44, kz: "404" },
        disposalsCents: { zeile: 45, kz: "405" },
        bookValueEndCents: { zeile: 46, kz: "406" },
      },
    },
    {
      key: "buero",
      title: "Bewegliche Wirtschaftsgüter – Büroausstattung",
      fields: {
        akCents: { zeile: 48, kz: "410" },
        bookValueStartCents: { zeile: 49, kz: "411" },
        additionsCents: { zeile: 50, kz: "412" },
        afaCents: { zeile: 52, kz: "414" },
        disposalsCents: { zeile: 53, kz: "415" },
        bookValueEndCents: { zeile: 54, kz: "416" },
      },
    },
    {
      key: "andere",
      title: "Bewegliche Wirtschaftsgüter – Andere",
      fields: {
        akCents: { zeile: 55, kz: "420" },
        bookValueStartCents: { zeile: 56, kz: "421" },
        additionsCents: { zeile: 57, kz: "422" },
        afaCents: { zeile: 59, kz: "424" },
        disposalsCents: { zeile: 60, kz: "425" },
        bookValueEndCents: { zeile: 61, kz: "426" },
      },
    },
  ],
  pools: [
    { offset: 0, akKz: "432", akZeile: 64, releaseKz: "434", releaseZeile: 65, endKz: "436" },
    { offset: 1, akKz: "440", akZeile: 67, startKz: "441", releaseKz: "444", releaseZeile: 69, endKz: "446" },
    { offset: 2, akKz: "450", akZeile: 71, startKz: "451", releaseKz: "454", releaseZeile: 73, endKz: "456" },
    { offset: 3, akKz: "460", akZeile: 75, startKz: "461", releaseKz: "464", releaseZeile: 77, endKz: "466" },
    { offset: 4, akKz: "470", akZeile: 79, startKz: "471", releaseKz: "474", releaseZeile: 81 },
  ],
};

/**
 * Anlage EÜR 2026 (BMF 01.09.2026): the 2025 lines with the 2026 Zeilen. Kennzahlen, labels and keys are unchanged;
 * „Waren …“ (Kz 100) moved from Zeile 27 to 29 (after the new Zeile 27 and the Übertrag in Zeile 28), every line from
 * the former Zeile 29 on moved down by one. Each Zeile below was read from the 2026 Vordruck (test pins every pair).
 */
const ZEILE_2026_BY_KZ: Readonly<Record<string, number>> = {
  "111": 12,
  "119": 13,
  "112": 15,
  "103": 16,
  "140": 17,
  "141": 18,
  "102": 19,
  "108": 21,
  "100": 29,
  "110": 30,
  "120": 31,
  "136": 32,
  "131": 33,
  "130": 34,
  "132": 37,
  "137": 38,
  "135": 39,
  "150": 40,
  "151": 42,
  "280": 44,
  "221": 45,
  "281": 46,
  "194": 47,
  "225": 49,
  "223": 50,
  "228": 51,
  "229": 52,
  "224": 55,
  "234": 57,
  "185": 58,
  "186": 59,
  "183": 61,
  "164": 63,
  "174": 63,
  "165": 64,
  "175": 64,
  "171": 65,
  "168": 68,
  "144": 69,
  "145": 70,
  "146": 71,
  "122": 107,
  "123": 108,
};

const LINES_2026: readonly EuerLine[] = LINES_2025.map((l) => {
  const zeile = ZEILE_2026_BY_KZ[l.kz];
  if (zeile === undefined) throw new Error(`Anlage EÜR 2026: Kz ${l.kz} has no verified Zeile`);
  return { ...l, zeile };
});

const formName = (formYear: number) => `Anlage EÜR ${formYear} (Einnahmenüberschussrechnung nach § 4 Abs. 3 EStG)`;

export const EUER_MAPPINGS: Readonly<Record<number, EuerMapping>> = {
  2025: {
    version: "euer-2025.1",
    formYear: 2025,
    formName: formName(2025),
    lines: LINES_2025,
    sums: {
      einnahmen: { zeile: 23, kz: "159" },
      ausgaben: { zeile: 75, kz: "199" },
      gewinn: { zeile: 97, kz: "219" },
    },
    anlageSzThresholdCents: 205_000,
    aveuer: AVEUER_2025,
    verifiedAgainstForm: {
      source:
        "Vordruck Anlage EÜR 2025 und Anlage AVEÜR 2025 mit Anleitung, BMF-Schreiben vom 29.08.2025, IV C 6 - S 2142/00023/010/001, BStBl I 2025 S. 1652",
      verifiedOn: "2026-10-20",
    },
  },
  2026: {
    version: "euer-2026.1",
    formYear: 2026,
    formName: formName(2026),
    lines: LINES_2026,
    sums: {
      einnahmen: { zeile: 23, kz: "159" },
      ausgaben: { zeile: 76, kz: "199" },
      gewinn: { zeile: 98, kz: "219" },
    },
    // BMF-Schreiben 01.09.2026: Anlage SZ above 2.050 € Schuldzinsen (unchanged)
    anlageSzThresholdCents: 205_000,
    // Anlage AVEÜR 2026: Zeilen and Kennzahlen identical to 2025 (only year labels and EÜR cross-references changed)
    aveuer: AVEUER_2025,
    verifiedAgainstForm: {
      source:
        "Vordruck Anlage EÜR 2026 (2026AnlEÜR801–803, August 2026) und Anlage AVEÜR 2026 mit Anleitung, BMF-Schreiben vom 01.09.2026, IV C 6 - S 2142/00024/010/001",
      verifiedOn: "2026-10-23",
    },
  },
};

/** The mapping of a tax year (= calendar year of the EÜR), or null (E-UVA-07: not shipped yet). */
export function euerMappingFor(year: number): EuerMapping | null {
  return EUER_MAPPINGS[year] ?? null;
}

/**
 * § 11 Abs. 1 Satz 2 / Abs. 2 Satz 2 EStG „kurze Zeit“ = 10 days (H 11 EStH; BFH X R 44/16): payments from 22.12.
 * to 10.01. that are also due in that window belong to the year they economically belong to. The due date is the
 * statutory one — a § 108 Abs. 3 AO weekend shift is ignored (BFH 21.06.2022, VIII R 25/20).
 */
export const TEN_DAY_RULE = {
  daysBefore: 10,
  daysAfter: 10,
  source: "§ 11 EStG, H 11 EStH, BFH VIII R 25/20",
} as const;

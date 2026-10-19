/**
 * Mein ELSTER instructions (Ausfüllhilfe) as versioned rule data per form and year (F08 TAX-020, §4.7a; UVA-04,
 * UVA-05). The owner files personally (no Steuerberater, owner decision B5); the app shows the navigation path, the
 * form year, the fields in form order with copy strings and a final checklist. Navigation labels change between
 * ELSTER releases: every data release re-verifies them (F08 open question 12); data without `verifiedAgainstForm`
 * blocks the copy buttons and the submission record (E-UVA-20).
 *
 * LEGAL-OPEN: F08-Q12 — Mein ELSTER navigation labels ⚠ verified per data release.
 */

export type ElsterForm = "ustva" | "zm" | "ust1h";

export interface ElsterSection {
  readonly title: string;
  /** Kennzahlen (UStVA, USt 1 H) in form order; ZM rows are generated per USt-IdNr. */
  readonly fields: readonly string[];
}

export interface ElsterGuideData {
  /** e.g. "elster-ustva-2026" (stored with the filing's rule versions). */
  readonly id: string;
  readonly form: ElsterForm;
  readonly formYear: number;
  readonly formName: string;
  readonly verifiedAgainstForm?: { readonly verifiedOn: string; readonly source: string };
  readonly prerequisites: readonly string[];
  readonly navigation: readonly string[];
  readonly sections: readonly ElsterSection[];
  readonly checklist: readonly string[];
}

const PREREQUISITES = [
  "ELSTER-Unternehmenskonto (Organisationszertifikat) oder persönliches ELSTER-Konto mit Zertifikatsdatei bzw. Sicherheitsstick einrichten (einmalig, Aktivierungsbrief per Post).",
  "Steuernummer des Unternehmens in den Firmendaten hinterlegen – sie wird im Formular als Erstes abgefragt.",
  "Mein ELSTER in einem zweiten Fenster neben dieser Seite öffnen (Desktop) und die Werte Feld für Feld kopieren.",
];

const COMMON_CHECKLIST = (form: string) => [
  "Steuernummer und Zeitraum im ELSTER-Formular stimmen.",
  `Formularjahr stimmt (${form}).`,
  "Alle Werte aus dieser Ausfüllhilfe sind eingetragen, leere Felder bleiben leer.",
  "ELSTER-Funktion „Prüfen“ zeigt keine Fehler.",
];

const verified2026 = {
  verifiedOn: "2026-10-19",
  source: "F08 §4.5/§4.7a, Formularaufbau 2026 (entschiedene Standardwerte, LEGAL-OPEN F08-Q12)",
};

const USTVA_SECTIONS: readonly ElsterSection[] = [
  {
    title: "Lieferungen und sonstige Leistungen – steuerfreie Umsätze",
    fields: ["41", "43", "48"],
  },
  { title: "Steuerpflichtige Umsätze", fields: ["81", "86", "87", "50"] },
  { title: "Innergemeinschaftliche Erwerbe", fields: ["89", "93"] },
  { title: "Ergänzende Angaben zu Umsätzen", fields: ["60", "21", "45"] },
  { title: "Leistungsempfänger als Steuerschuldner (§ 13b UStG)", fields: ["46", "47", "84", "85"] },
  { title: "Abziehbare Vorsteuerbeträge", fields: ["66", "61", "62", "67"] },
  { title: "Andere Steuerbeträge und Ergebnis", fields: ["39", "83"] },
];

const ustva = (year: number, verified: boolean): ElsterGuideData => ({
  id: `elster-ustva-${year}`,
  form: "ustva",
  formYear: year,
  formName: `Umsatzsteuer-Voranmeldung ${year} (UStVA)`,
  ...(verified ? { verifiedAgainstForm: verified2026 } : {}),
  prerequisites: PREREQUISITES,
  navigation: [
    "Formulare & Leistungen",
    "Alle Formulare",
    "Unternehmen",
    "Umsatzsteuer",
    `Umsatzsteuer-Voranmeldung ${year}`,
  ],
  sections: USTVA_SECTIONS,
  checklist: [
    ...COMMON_CHECKLIST(`Umsatzsteuer-Voranmeldung ${year}`),
    "Die ELSTER-Vorschau zeigt in Kz 83 denselben Betrag wie diese Seite.",
    "„Absenden“ wählen, danach das Übermittlungsprotokoll (PDF) speichern und das Transferticket notieren.",
  ],
});

const zm = (year: number, verified: boolean): ElsterGuideData => ({
  id: `elster-zm-${year}`,
  form: "zm",
  formYear: year,
  formName: `Zusammenfassende Meldung ${year} (ZM)`,
  ...(verified ? { verifiedAgainstForm: verified2026 } : {}),
  prerequisites: PREREQUISITES,
  navigation: ["Formulare & Leistungen", "Alle Formulare", "Unternehmen", "Umsatzsteuer", "Zusammenfassende Meldung"],
  sections: [{ title: "Angaben je Leistungsempfänger (USt-IdNr.)", fields: [] }],
  checklist: [
    ...COMMON_CHECKLIST(`Zusammenfassende Meldung ${year}`),
    "Die Summe aller Zeilen in ELSTER entspricht der Summe auf dieser Seite.",
    "„Absenden“ wählen, danach das Übermittlungsprotokoll (PDF) speichern und das Transferticket notieren.",
  ],
});

const ust1h = (year: number, verified: boolean): ElsterGuideData => ({
  id: `elster-ust1h-${year}`,
  form: "ust1h",
  formYear: year,
  formName: `Antrag auf Dauerfristverlängerung / Anmeldung der Sondervorauszahlung ${year} (USt 1 H)`,
  ...(verified ? { verifiedAgainstForm: verified2026 } : {}),
  prerequisites: PREREQUISITES,
  navigation: [
    "Formulare & Leistungen",
    "Alle Formulare",
    "Unternehmen",
    "Umsatzsteuer",
    `Antrag auf Dauerfristverlängerung / Anmeldung der Sondervorauszahlung ${year}`,
  ],
  sections: [{ title: "Sondervorauszahlung", fields: ["38"] }],
  checklist: [
    ...COMMON_CHECKLIST(`USt 1 H ${year}`),
    "Die ELSTER-Vorschau zeigt in Kz 38 denselben Betrag wie diese Seite.",
    "Bis zum 10. Februar absenden; Übermittlungsprotokoll (PDF) speichern und Transferticket notieren.",
  ],
});

export const ELSTER_GUIDES: readonly ElsterGuideData[] = [
  ustva(2026, true),
  zm(2026, true),
  ust1h(2026, true),
  ust1h(2027, false),
  ustva(2027, false),
  zm(2027, false),
];

/** Guide data of a form and form year (the year of the period), or null (E-UVA-07: not shipped yet). */
export function elsterGuideFor(form: ElsterForm, year: number): ElsterGuideData | null {
  return ELSTER_GUIDES.find((g) => g.form === form && g.formYear === year) ?? null;
}

/** TAX-020 (4): the extra first step of a correction filing. */
export const CORRECTION_STEP = "Berichtigte Anmeldung: Ja (Kz 10 = 1)";

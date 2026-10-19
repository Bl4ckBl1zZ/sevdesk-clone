/**
 * Mein ELSTER step-by-step instructions (F08 TAX-020, §4.7a): (1) prerequisites, (2) navigation path and form year,
 * (3) fields in form order with the copy string exactly as ELSTER expects it („leer lassen“ for zero; Kz 83 always),
 * (4) for corrections the explicit step „Berichtigte Anmeldung: Ja (Kz 10 = 1)“ with complete values, (5) the final
 * checklist. Conservative gates: while blockers exist (drafts or pending artifacts in the period, bank balance
 * mismatch, guide/mapping missing or unverified) the guide is `blocked` — the copy buttons stay disabled and the
 * submission record is refused (E-UVA-03/E-UVA-07/E-UVA-20). Pure.
 */
import { CORRECTION_STEP, type ElsterGuideData } from "../rules/elster";
import { elsterCopyString, mappingMissingNotice, type UstvaSheet, unverifiedNotice } from "./ustva";
import type { ZmSheet } from "./zm";

export interface GuideField {
  kz: string;
  label: string;
  valueCents: number;
  /** null = „leer lassen“. */
  copy: string | null;
}

export interface GuideStep {
  title: string;
  fields: GuideField[];
  /** ZM rows (per USt-IdNr). */
  rows?: {
    countryCode: string;
    vatNumber: string;
    type: string;
    euros: number;
    copy: { amount: string; vatNumber: string };
  }[];
  /** Plain instruction (correction step). */
  instruction?: string;
}

export interface ElsterGuide {
  id: string | null;
  formName: string;
  formYear: number;
  /** E-UVA-22: the owner files a period of an earlier year (e.g. December in January). */
  formYearWarning?: string;
  prerequisites: string[];
  navigation: string[];
  steps: GuideStep[];
  checklist: string[];
  correction: boolean;
  blocked: boolean;
  blockers: string[];
  sheetHash: string;
}

export interface GuideOptions {
  correction?: boolean;
  /** Blockers found by the read model (E-UVA-03, ACC-017 (2a)). */
  blockers?: readonly string[];
  today: string;
  sheetHash: string;
}

const formYearWarning = (formYear: number, today: string): string | undefined => {
  const y = Number(today.slice(0, 4));
  return y > formYear ? `Achtung: Formular ${formYear} wählen, nicht ${y}.` : undefined;
};

function gate(
  data: ElsterGuideData | null,
  formLabel: string,
  year: number,
  extra: readonly string[],
  mappingOk = true,
) {
  const blockers = [...extra];
  if (!data) blockers.push(mappingMissingNotice(year));
  else if (!data.verifiedAgainstForm || !mappingOk) blockers.push(unverifiedNotice(formLabel, year));
  return blockers;
}

/** UStVA (and UStVA correction) guide from the computed sheet. */
export function buildUstvaGuide(sheet: UstvaSheet, data: ElsterGuideData | null, o: GuideOptions): ElsterGuide {
  const blockers = gate(data, "Umsatzsteuer-Voranmeldung", sheet.formYear, o.blockers ?? [], sheet.verified);
  if (sheet.ku && !sheet.required) blockers.push(sheet.notices[0] ?? "Keine Voranmeldung erforderlich.");
  const byKz = new Map(sheet.fields.map((f) => [f.kz, f]));
  const placed = new Set<string>();
  const steps: GuideStep[] = [];
  if (o.correction) steps.push({ title: "Berichtigte Anmeldung", fields: [], instruction: CORRECTION_STEP });
  for (const section of data?.sections ?? []) {
    const fields: GuideField[] = [];
    for (const kz of section.fields) {
      const f = byKz.get(kz);
      if (!f) continue;
      placed.add(kz);
      fields.push({ kz, label: f.label, valueCents: f.valueCents, copy: elsterCopyString(f.kind, f.valueCents) });
    }
    if (fields.length > 0) steps.push({ title: section.title, fields });
  }
  // A Kennzahl of the mapping that the guide data does not place blocks the guide (never silently dropped).
  const missing = sheet.fields.filter((f) => !placed.has(f.kz) && f.valueCents !== 0).map((f) => f.kz);
  if (data && missing.length > 0) {
    blockers.push(`Die Ausfüllhilfe enthält die Kennzahlen ${missing.join(", ")} nicht. Bitte Update einspielen.`);
  }
  const warning = formYearWarning(sheet.formYear, o.today);
  return {
    id: data?.id ?? null,
    formName: data?.formName ?? `Umsatzsteuer-Voranmeldung ${sheet.formYear}`,
    formYear: sheet.formYear,
    ...(warning ? { formYearWarning: warning } : {}),
    prerequisites: [...(data?.prerequisites ?? [])],
    navigation: [...(data?.navigation ?? [])],
    steps,
    checklist: [...(data?.checklist ?? [])],
    correction: o.correction ?? false,
    blocked: blockers.length > 0,
    blockers,
    sheetHash: o.sheetHash,
  };
}

/** ZM guide: one row per USt-IdNr and type, amounts in whole euros. */
export function buildZmGuide(
  sheet: ZmSheet,
  formYear: number,
  data: ElsterGuideData | null,
  o: GuideOptions,
): ElsterGuide {
  const blockers = gate(data, "Zusammenfassende Meldung", formYear, o.blockers ?? []);
  for (const w of sheet.warnings) if (w.includes("USt-IdNr")) blockers.push(w);
  const steps: GuideStep[] = [];
  if (o.correction) {
    steps.push({
      title: "Berichtigte Meldung",
      fields: [],
      instruction: "Berichtigung: je Kunde und Zeitraum den vollständigen berichtigten Betrag eintragen.",
    });
  }
  steps.push({
    title: data?.sections[0]?.title ?? "Angaben je Leistungsempfänger",
    fields: [],
    rows: sheet.rows.map((r) => ({
      countryCode: r.countryCode,
      vatNumber: r.vatNumber,
      type: r.type,
      euros: r.euros,
      copy: { amount: String(r.euros), vatNumber: r.vatNumber },
    })),
  });
  const warning = formYearWarning(formYear, o.today);
  return {
    id: data?.id ?? null,
    formName: data?.formName ?? `Zusammenfassende Meldung ${formYear}`,
    formYear,
    ...(warning ? { formYearWarning: warning } : {}),
    prerequisites: [...(data?.prerequisites ?? [])],
    navigation: [...(data?.navigation ?? [])],
    steps,
    checklist: [...(data?.checklist ?? [])],
    correction: o.correction ?? false,
    blocked: blockers.length > 0,
    blockers,
    sheetHash: o.sheetHash,
  };
}

/** USt 1 H guide (Kz 38). */
export function buildSvzGuide(
  amountCents: number,
  formYear: number,
  data: ElsterGuideData | null,
  o: GuideOptions,
): ElsterGuide {
  const blockers = gate(data, "Sondervorauszahlung (USt 1 H)", formYear, o.blockers ?? []);
  return {
    id: data?.id ?? null,
    formName: data?.formName ?? `USt 1 H ${formYear}`,
    formYear,
    prerequisites: [...(data?.prerequisites ?? [])],
    navigation: [...(data?.navigation ?? [])],
    steps: [
      {
        title: data?.sections[0]?.title ?? "Sondervorauszahlung",
        fields: [
          {
            kz: "38",
            label: "Sondervorauszahlung (1/11 der Vorauszahlungen des Vorjahres)",
            valueCents: amountCents,
            copy: elsterCopyString("total", amountCents),
          },
        ],
      },
    ],
    checklist: [...(data?.checklist ?? [])],
    correction: false,
    blocked: blockers.length > 0,
    blockers,
    sheetHash: o.sheetHash,
  };
}

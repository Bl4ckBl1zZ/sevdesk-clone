/**
 * USt-Jahreserklärung worksheet (F08 TAX-023, UVA-03, GOBD-01). Pure.
 *
 * Year totals per line of the annual return (mapping `ust-annual-<year>`, `src/domain/rules/ust-annual`) are the UStVA
 * computation (`computeUstva`) over every tax point of the calendar year — the same contributions the Voranmeldungen
 * read (journal by `taxPointDate`, TAX-008), so one rule set serves both. Kz 39 is not applied: the Sondervorauszahlung
 * is part of the Vorauszahlungssoll (Zeile „Vorauszahlungssoll … einschließlich Sondervorauszahlung“).
 *
 * Reconciliation with the latest submitted UStVA per period (TAX-023): Vorauszahlungssoll = Σ filed Kz 83 (the ELSTER
 * value when „abweichend übermittelt“, E-UVA-19) + Σ filed Kz 39; expected Abschlusszahlung/Erstattung = year tax −
 * Vorauszahlungssoll, split into causes that add up exactly:
 *  - `nachgemeldet`: a filed period whose recomputation differs (late postings, corrections) — with the Kz deltas and
 *    the journal entries recorded after the filing;
 *  - `nicht_gemeldet`: a period with values but no submitted UStVA;
 *  - `abweichend_uebermittelt`: stored app value − the total ELSTER reported;
 *  - `rundung`: the year's whole-euro bases vs. the per-period truncation (TAX-004).
 * No submission record and no lock (the months are locked by the UStVA records).
 */
import { type UstAnnualMapping, ustAnnualGuideData } from "../rules/ust-annual";
import type { UstvaMapping } from "../rules/ustva";
import {
  type Contribution,
  computeUstva,
  elsterCopyString,
  filingPeriodLabel,
  type KzDelta,
  kennzahlDeltas,
  monthsOfFilingPeriod,
  sheetValues,
  type UstvaSheet,
  unverifiedNotice,
} from "./ustva";

/** The UStVA in force for a period (latest `submitted_manually`; superseded ones excluded by the caller). */
export interface FiledUstva {
  period: string;
  /** Frozen values (Kz → cents). */
  values: Record<string, number>;
  submittedAt: number;
  submittedValuesDiffer?: boolean;
  elsterReportedTotalCents?: number;
}

export interface UstAnnualInput {
  year: number;
  /** Filing periods of the year (`ustvaPeriod`): 12 months, 4 quarters or just `YYYY`. */
  periods: readonly string[];
  /** Kennzahl contributions of the journal (any year; filtered by tax point). */
  contributions: readonly Contribution[];
  /** entryId → recordedAt (ms), to name the entries recorded after a filing. */
  recordedAt: ReadonlyMap<string, number>;
  ustva: UstvaMapping | null;
  annual: UstAnnualMapping | null;
  filed: readonly FiledUstva[];
  ku: boolean;
  /** The calendar year is over (Europe/Berlin). */
  ended: boolean;
  /** Read-model blockers (drafts / pending artifacts in the year, E-UVA-03). */
  blockers?: readonly string[];
}

export type UstAnnualCauseKind = "nachgemeldet" | "nicht_gemeldet" | "abweichend_uebermittelt" | "rundung";

export interface UstAnnualCause {
  kind: UstAnnualCauseKind;
  period: string | null;
  label: string;
  amountCents: number;
  deltas: KzDelta[];
  entries: { entryId: string; seq: number; source: { kind: string; id: string } }[];
}

export interface UstAnnualRowValue {
  zeile: number;
  kz: string | null;
  label: string;
  kind: "base" | "tax";
  valueCents: number;
  /** Mein ELSTER string; null = „leer lassen“ (zero) or not copyable (`review`, no Kennzahl). */
  copy: string | null;
  review?: string;
  hint?: string;
  /** UStVA Kennzahl the value comes from (drill-down). */
  ustvaKz?: string;
}

export interface UstAnnualGuide {
  id: string;
  formName: string;
  formYear: number;
  formYearWarning?: string;
  prerequisites: string[];
  navigation: string[];
  steps: { title: string; fields: { kz: string; zeile: number; label: string; copy: string | null }[] }[];
  checklist: string[];
  blocked: boolean;
  blockers: string[];
  sheetHash: string;
}

export interface UstAnnualSheet {
  year: number;
  mappingVersion: string | null;
  ustvaMappingVersion: string | null;
  verified: boolean;
  ku: boolean;
  rows: UstAnnualRowValue[];
  /** Year computation (for drill-down per UStVA Kennzahl). */
  yearSheet: UstvaSheet | null;
  totals: { verbleibendCents: number; vorauszahlungssollCents: number; abschlussCents: number };
  reconciliation: { differenceCents: number; causes: UstAnnualCause[] };
  notices: string[];
  blockers: string[];
  guide: UstAnnualGuide;
}

/** E-UVA-07 */
export const ustAnnualMappingMissingNotice = (year: number) =>
  `Die Zeilenzuordnung der Umsatzsteuererklärung für ${year} ist noch nicht hinterlegt. Bitte Update einspielen.`;
export const yearNotEndedNotice = (year: number) => `Das Jahr ${year} ist noch nicht abgeschlossen.`;
export const KU_ANNUAL_NOTICE =
  "Als Kleinunternehmer enthält das Arbeitsblatt nur Steuer nach § 13b UStG und aus innergemeinschaftlichen Erwerben. Umsätze nach § 19 Abs. 1 UStG (Zeile 53) berechnet die App nicht – bitte aus der Umsatzübersicht übernehmen.";

const SECTION_OF = (zeile: number): string =>
  zeile <= 41
    ? "B. Steuerpflichtige Lieferungen und sonstige Leistungen"
    : zeile <= 54
      ? "C. Steuerfreie Lieferungen und sonstige Leistungen"
      : zeile <= 62
        ? "D. Innergemeinschaftliche Erwerbe"
        : zeile <= 74
          ? "G. Leistungsempfänger als Steuerschuldner (§ 13b UStG)"
          : zeile <= 84
            ? "H. Ergänzende Angaben zu Umsätzen"
            : zeile <= 93
              ? "I. Abziehbare Vorsteuerbeträge"
              : "K. Berechnung der zu entrichtenden Umsatzsteuer";

const copyOf = (kind: "base" | "tax", cents: number, always: boolean): string | null =>
  elsterCopyString(kind === "base" ? "base" : always ? "total" : "tax", cents);

const effective83 = (f: FiledUstva) =>
  f.submittedValuesDiffer && f.elsterReportedTotalCents !== undefined
    ? f.elsterReportedTotalCents
    : (f.values["83"] ?? 0);

const withoutResult = (v: Record<string, number>) =>
  Object.fromEntries(Object.entries(v).filter(([kz]) => kz !== "39" && kz !== "83"));

export function computeUstAnnual(i: UstAnnualInput): UstAnnualSheet {
  const { year, ustva: m, annual } = i;
  const notices: string[] = [];
  const blockers: string[] = [...(i.blockers ?? [])];
  if (!annual) blockers.push(ustAnnualMappingMissingNotice(year));
  else if (!annual.verifiedAgainstForm) {
    notices.push(unverifiedNotice("Umsatzsteuererklärung", year));
    blockers.push(unverifiedNotice("Umsatzsteuererklärung", year));
  }
  if (!m) blockers.push(`Die Kennzahlen-Zuordnung für ${year} ist noch nicht hinterlegt. Bitte Update einspielen.`);
  if (!i.ended) blockers.push(yearNotEndedNotice(year));
  if (i.ku) notices.push(KU_ANNUAL_NOTICE);

  const ofYear = i.contributions.filter((c) => c.taxPointDate.startsWith(`${year}-`));
  const yearSheet = m ? computeUstva(String(year), ofYear, m, { ku: i.ku }) : null;
  const field = (kz: string) => yearSheet?.fields.find((f) => f.kz === kz);

  // ── reconciliation ─────────────────────────────────────────────────────────────────────────────────
  const filedBy = new Map(i.filed.map((f) => [f.period, f]));
  const causes: UstAnnualCause[] = [];
  let sumRecomputed = 0;
  let vorauszahlungssoll = 0;
  for (const p of i.periods) {
    const months = monthsOfFilingPeriod(p);
    const inP = ofYear.filter((c) => months.includes(c.taxPointDate.slice(0, 7)));
    const sheet = m ? computeUstva(p, inP, m, { ku: i.ku }) : null;
    const recomputed = sheet?.totalCents ?? 0;
    sumRecomputed += recomputed;
    const values = sheet ? withoutResult(sheetValues(sheet)) : {};
    const f = filedBy.get(p);
    const label = filingPeriodLabel(p);
    if (!f) {
      if (recomputed !== 0 || Object.values(values).some((v) => v !== 0)) {
        causes.push({
          kind: "nicht_gemeldet",
          period: p,
          label:
            p.length === 4
              ? `Keine Voranmeldungen für ${year} – die Umsatzsteuer wird mit der Jahreserklärung angemeldet`
              : `Keine übermittelte Voranmeldung für ${label}`,
          amountCents: recomputed,
          deltas: kennzahlDeltas({}, values),
          entries: entriesOf(inP),
        });
      }
      continue;
    }
    const stored83 = f.values["83"] ?? 0;
    const svz = f.values["39"] ?? 0;
    vorauszahlungssoll += effective83(f) + svz;
    const deltas = kennzahlDeltas(withoutResult(f.values), values);
    const late = recomputed - stored83 - svz;
    if (late !== 0 || deltas.length > 0) {
      causes.push({
        kind: "nachgemeldet",
        period: p,
        label: `Nach der Voranmeldung ${label} erfasst – berichtigte Voranmeldung oder Jahreserklärung`,
        amountCents: late,
        deltas,
        entries: entriesOf(inP.filter((c) => (i.recordedAt.get(c.entryId) ?? 0) > f.submittedAt)),
      });
    }
    const elster = stored83 - effective83(f);
    if (elster !== 0) {
      causes.push({
        kind: "abweichend_uebermittelt",
        period: p,
        label: `Voranmeldung ${label} abweichend übermittelt (ELSTER ${effective83(f)} ct, App ${stored83} ct)`,
        amountCents: elster,
        deltas: [],
        entries: [],
      });
    }
  }
  const verbleibend = yearSheet?.totalCents ?? 0;
  const rounding = verbleibend - sumRecomputed;
  if (rounding !== 0) {
    causes.push({
      kind: "rundung",
      period: null,
      label: "Rundung der Bemessungsgrundlagen auf volle Euro (Jahr statt je Voranmeldungszeitraum)",
      amountCents: rounding,
      deltas: [],
      entries: [],
    });
  }
  const abschluss = verbleibend - vorauszahlungssoll;

  // ── rows ───────────────────────────────────────────────────────────────────────────────────────────
  const rows: UstAnnualRowValue[] = (annual?.rows ?? []).map((r) => {
    let valueCents = 0;
    let ustvaKz: string | undefined;
    const always = "result" in r.source;
    if ("result" in r.source) {
      valueCents =
        r.source.result === "verbleibend"
          ? verbleibend
          : r.source.result === "vorauszahlungssoll"
            ? vorauszahlungssoll
            : abschluss;
    } else {
      ustvaKz = r.source.ustvaKz;
      const f = field(r.source.ustvaKz);
      valueCents =
        r.source.take === "formTax" ? (f?.formTaxCents ?? 0) : f?.kind === "total" ? 0 : (f?.valueCents ?? 0);
      // Kz 50 is a negative base reduction in the UStVA; the annual return states it as a positive amount
      if (r.source.ustvaKz === "50") valueCents = Math.abs(valueCents);
    }
    const copyable = r.kz !== null && !r.review;
    return {
      zeile: r.zeile,
      kz: r.kz,
      label: r.label,
      kind: r.kind,
      valueCents,
      copy: copyable ? copyOf(r.kind, valueCents, always) : null,
      ...(r.review ? { review: r.review } : {}),
      ...(r.hint ? { hint: r.hint } : {}),
      ...(ustvaKz ? { ustvaKz } : {}),
    };
  });

  // ── guide (TAX-020) ────────────────────────────────────────────────────────────────────────────────
  const resultRow = (key: "verbleibend" | "abschluss") => {
    const r = annual?.rows.find((x) => "result" in x.source && x.source.result === key);
    return r ? `Zeile ${r.zeile}${r.kz ? ` (Kz ${r.kz})` : ""}` : key;
  };
  const data = ustAnnualGuideData(year, { verbleibend: resultRow("verbleibend"), abschluss: resultRow("abschluss") });
  const stepsBy = new Map<string, UstAnnualGuide["steps"][number]>();
  for (const r of rows) {
    if (r.kz === null || r.review) continue;
    if (r.copy === null) continue; // zero → „leer lassen“ is not listed
    const title = SECTION_OF(r.zeile);
    const step = stepsBy.get(title) ?? { title, fields: [] };
    step.fields.push({ kz: r.kz, zeile: r.zeile, label: r.label, copy: r.copy });
    stepsBy.set(title, step);
  }
  return {
    year,
    mappingVersion: annual?.version ?? null,
    ustvaMappingVersion: m?.version ?? null,
    verified: annual?.verifiedAgainstForm !== undefined,
    ku: i.ku,
    rows,
    yearSheet,
    totals: { verbleibendCents: verbleibend, vorauszahlungssollCents: vorauszahlungssoll, abschlussCents: abschluss },
    reconciliation: { differenceCents: abschluss, causes },
    notices,
    blockers,
    guide: {
      id: data.id,
      formName: annual?.formName ?? data.formName,
      formYear: year,
      prerequisites: data.prerequisites,
      navigation: data.navigation,
      steps: [...stepsBy.values()],
      checklist: data.checklist,
      blocked: blockers.length > 0,
      blockers,
      sheetHash: "",
    },
  };
}

function entriesOf(cs: readonly Contribution[]): UstAnnualCause["entries"] {
  const seen = new Map<string, UstAnnualCause["entries"][number]>();
  for (const c of cs)
    if (!seen.has(c.entryId)) seen.set(c.entryId, { entryId: c.entryId, seq: c.seq, source: c.source });
  return [...seen.values()].sort((a, b) => a.seq - b.seq);
}

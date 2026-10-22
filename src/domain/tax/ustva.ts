/**
 * UStVA computation from the journal (F08 TAX-003…TAX-005, TAX-007, TAX-011; UVA-03, UVA-06, KU-05). Pure.
 *
 * The journal is read by **tax point** (`lines[].taxPointDate`), never by the booking period: late postings and §17
 * corrections land in other booking months, and the stored `taxPeriod` only exists when an `ustvaPeriod` row existed
 * at posting time. The filing period of a tax point follows the current `ustvaPeriod` setting of its year (TAX-008).
 *
 * Classification per entry (mapping `ustva-<year>`): base lines by role (advances, write-offs) or tax key; VAT lines
 * by role. A base line without its own tax point inherits the tax point of the entry's VAT line of the same family
 * (§13b and igE vouchers, income vouchers, S11 clearing). Ist (UVA-06): a VAT transfer line (P1-ist) carries no base
 * line — the read model supplies the base share of the payment (`baseCents`, pro rata of the target's VAT groups);
 * without it the base is derived from the VAT at the rate (half-up), so Kz 81/86 never stay empty.
 *
 * Form arithmetic (TAX-004): bases in whole euros (truncated toward zero, decided default ⚠ LEGAL-OPEN 01-compliance
 * open item 6), tax amounts in cents; for Kz 81/86/87/89/93 the form computes the tax from the base („laut
 * Formular“), the booked VAT is shown next to it („laut Buchhaltung“). Kz 83 = Σ form taxes + Σ entered tax fields −
 * Σ input tax − Kz 39; the booked VAT never leaks into Kz 83 except for Kz 50 (no computed tax column).
 */
import { canonicalize } from "../audit/canonical";
import { sha256Hex } from "../audit/chain";
import { formatDecimal, roundHalfAway } from "../money";
import type { KzDef, UstvaMapping } from "../rules/ustva";

export interface TaxJournalLine {
  account: string;
  role?: string;
  taxKey?: string;
  debitCents: number;
  creditCents: number;
  taxPointDate?: string;
  /** Ist VAT transfer lines: base share of the payment (signed like the VAT line's effect), from the read model. */
  baseCents?: number;
}

export interface TaxJournalEntry {
  id: string;
  seq: number;
  date: string;
  recordedAt: number;
  source: { kind: string; id: string };
  text: string;
  lines: readonly TaxJournalLine[];
  /** ZM (TAX-009): the customer of the entry with the USt-IdNr used on the document. */
  counterparty?: { contactId?: string; name?: string; vatId?: string };
}

export interface Contribution {
  kz: string;
  part: "base" | "tax";
  /** Signed in the direction of the Kennzahl (credit-type bases: credit − debit, input VAT: debit − credit). */
  cents: number;
  taxPointDate: string;
  entryId: string;
  seq: number;
  source: { kind: string; id: string };
}

const rateOfFamily = (family: string): number | null =>
  family === "out19" || family === "ige19" ? 1900 : family === "out7" || family === "ige7" ? 700 : null;

const familyMatches = (base: string, tax: string) => base === tax || (base === "out" && tax.startsWith("out"));

const net = (l: TaxJournalLine, sign: "credit" | "debit") =>
  sign === "credit" ? l.creditCents - l.debitCents : l.debitCents - l.creditCents;

const taxSign = (role: string): "credit" | "debit" => (role.startsWith("vat.output") ? "credit" : "debit");

const fieldOf = (m: UstvaMapping, kz: string): KzDef | undefined => m.fields.find((f) => f.kz === kz);

/** Kennzahl contributions of one entry (TAX-003, drill-down source TAX-005). */
export function entryContributions(entry: TaxJournalEntry, m: UstvaMapping): Contribution[] {
  const out: Contribution[] = [];
  const meta = { entryId: entry.id, seq: entry.seq, source: entry.source };
  const bases: { kz: string; family: string; line: TaxJournalLine }[] = [];
  for (const l of entry.lines) {
    const rule = (l.role ? m.baseByRole[l.role] : undefined) ?? (l.taxKey ? m.baseByTaxKey[l.taxKey] : undefined);
    if (rule) bases.push({ kz: rule.kz, family: rule.family, line: l });
  }
  const taxes: { kz: string; family: string; line: TaxJournalLine; role: string }[] = [];
  for (const l of entry.lines) {
    const rule = l.role ? m.taxByRole[l.role] : undefined;
    if (!rule || !l.role || !l.taxPointDate) continue;
    let kz = rule.kz;
    if (rule.byBaseKz) {
      const mapped = bases
        .filter((b) => familyMatches(b.family, rule.family))
        .map((b) => rule.byBaseKz?.[b.kz])
        .find((k) => k !== undefined);
      if (mapped) kz = mapped;
    }
    taxes.push({ kz, family: rule.family, line: l, role: l.role });
  }
  for (const b of bases) {
    const tp = b.line.taxPointDate ?? taxes.find((t) => familyMatches(b.family, t.family))?.line.taxPointDate;
    if (!tp) continue; // Ist base: reported with the payment (allocation-based)
    const f = fieldOf(m, b.kz);
    const cents = net(b.line, f?.sign ?? "credit");
    if (cents !== 0) out.push({ kz: b.kz, part: "base", cents, taxPointDate: tp, ...meta });
  }
  for (const t of taxes) {
    const tp = t.line.taxPointDate as string;
    const cents = net(t.line, taxSign(t.role));
    if (cents === 0) continue;
    out.push({ kz: t.kz, part: "tax", cents, taxPointDate: tp, ...meta });
    // Ist transfer (P1-ist, P11-ist, P12-ist): output VAT without a base line of its family in the entry.
    const rate = rateOfFamily(t.family);
    if (t.role.startsWith("vat.output.") && rate && !bases.some((b) => familyMatches(b.family, t.family))) {
      const base = t.line.baseCents ?? Number(roundHalfAway(BigInt(cents) * 10000n, BigInt(rate)));
      if (base !== 0) out.push({ kz: t.kz, part: "base", cents: base, taxPointDate: tp, ...meta });
    }
  }
  return out;
}

// ── filing periods ───────────────────────────────────────────────────────────────────────────────────────

export type FilingPeriodKind = "monthly" | "quarterly" | "annual_only";

/** Filing period (`YYYY-MM`, `YYYY-Qn`, `YYYY`) of a date under the period kind of its year. */
export function filingPeriodOf(date: string, kind: FilingPeriodKind): string {
  const y = date.slice(0, 4);
  if (kind === "monthly") return date.slice(0, 7);
  if (kind === "quarterly") return `${y}-Q${Math.ceil(Number(date.slice(5, 7)) / 3)}`;
  return y;
}

export function isFilingPeriod(p: string): boolean {
  return /^\d{4}(-(0[1-9]|1[0-2])|-Q[1-4])?$/.test(p);
}

export const filingPeriodKind = (p: string): FilingPeriodKind =>
  p.includes("-Q") ? "quarterly" : p.length === 7 ? "monthly" : "annual_only";

/** Calendar months of a filing period. */
export function monthsOfFilingPeriod(p: string): string[] {
  const y = p.slice(0, 4);
  const mm = (m: number) => `${y}-${String(m).padStart(2, "0")}`;
  const q = /-Q([1-4])$/.exec(p);
  if (q) {
    const start = (Number(q[1]) - 1) * 3 + 1;
    return [mm(start), mm(start + 1), mm(start + 2)];
  }
  if (p.length === 7) return [p];
  return Array.from({ length: 12 }, (_, i) => mm(i + 1));
}

/** German label: „09/2026“, „Q3/2026“, „2026“. */
export function filingPeriodLabel(p: string): string {
  const q = /-Q([1-4])$/.exec(p);
  if (q) return `Q${q[1]}/${p.slice(0, 4)}`;
  return p.length === 7 ? `${p.slice(5, 7)}/${p.slice(0, 4)}` : p;
}

/** Last filing period of the year (December or Q4): Kz 39 is applied only there (E-UVA-08). */
export const isLastPeriodOfYear = (p: string) => p.endsWith("-12") || p.endsWith("-Q4") || p.length === 4;

// ── the sheet ────────────────────────────────────────────────────────────────────────────────────────────

export interface UstvaField {
  kz: string;
  label: string;
  kind: KzDef["kind"];
  /** Value as entered in the form, in cents (bases: whole euros × 100). */
  valueCents: number;
  /** Exact booked sum of the base (cents) — bases only. */
  exactCents?: number;
  /** base_computed: tax computed by the form from the whole-euro base („laut Formular“). */
  formTaxCents?: number;
  /** base_computed / Kz 50: booked VAT („laut Buchhaltung“). */
  bookedTaxCents?: number;
  /** formTax − booked (TAX-004). */
  differenceCents?: number;
}

export interface UstvaSheet {
  period: string;
  formYear: number;
  mappingVersion: string;
  verified: boolean;
  /** TAX-011: KU mode — only §13b/igE Kennzahlen; `required` false = no UStVA for the period. */
  ku: boolean;
  required: boolean;
  fields: UstvaField[];
  /** Kz 83 (cents). */
  totalCents: number;
  /** Kz → contributing journal entries (TAX-005; frozen at submission as `taxFilings.drillDown`). */
  drillDown: Record<string, { source: { kind: string; id: string }; entryId: string; seq: number; cents: number }[]>;
  notices: string[];
}

export interface UstvaOptions {
  ku: boolean;
  /** Kz 39 (December/Q4 with Dauerfristverlängerung and a recorded Sondervorauszahlung). */
  sondervorauszahlungCents?: number;
}

const truncEuros = (cents: number) => Math.trunc(cents / 100);

/** `cents × rateBp / 10000` of a whole-euro base, in cents (half away from zero for non-integral results). */
function formTax(euros: number, rateBp: number): number {
  const num = euros * rateBp; // cents × 100
  const q = Math.trunc(num / 100);
  const r = num - q * 100;
  return Math.abs(r) * 2 >= 100 ? q + Math.sign(num) : q;
}

export const KU_UVA_NOTICE = "Als Kleinunternehmer melden Sie nur Steuer nach § 13b/igE.";
export const KU_NOT_REQUIRED =
  "Als Kleinunternehmer (§ 19 UStG) ist für diesen Zeitraum keine Umsatzsteuer-Voranmeldung abzugeben – es gibt keine Steuer nach § 13b UStG oder aus innergemeinschaftlichen Erwerben.";

export function computeUstva(
  period: string,
  contributions: readonly Contribution[],
  m: UstvaMapping,
  opts: UstvaOptions,
): UstvaSheet {
  const fields = opts.ku ? m.fields.filter((f) => f.ku) : m.fields;
  const allowed = new Set(fields.map((f) => f.kz));
  const base = new Map<string, number>();
  const tax = new Map<string, number>();
  const drillDown: UstvaSheet["drillDown"] = {};
  for (const c of contributions) {
    if (!allowed.has(c.kz)) continue;
    const target = c.part === "base" ? base : tax;
    target.set(c.kz, (target.get(c.kz) ?? 0) + c.cents);
    const list = drillDown[c.kz] ?? [];
    const prev = list.find((x) => x.entryId === c.entryId);
    if (prev) prev.cents += c.part === "base" ? c.cents : 0;
    else list.push({ source: c.source, entryId: c.entryId, seq: c.seq, cents: c.part === "base" ? c.cents : 0 });
    drillDown[c.kz] = list;
  }
  if (opts.sondervorauszahlungCents && isLastPeriodOfYear(period) && allowed.has("39")) {
    tax.set("39", opts.sondervorauszahlungCents);
  }
  const out: UstvaField[] = [];
  let total = 0;
  for (const f of fields) {
    if (f.kind === "total") continue;
    if (f.kind === "base_computed") {
      const exact = base.get(f.kz) ?? 0;
      const euros = truncEuros(exact);
      const ft = formTax(euros, f.rateBp ?? 0);
      const booked = tax.get(f.kz) ?? 0;
      out.push({
        kz: f.kz,
        label: f.label,
        kind: f.kind,
        valueCents: euros * 100,
        exactCents: exact,
        formTaxCents: ft,
        bookedTaxCents: booked,
        differenceCents: ft - booked,
      });
      total += f.kz83 * ft;
    } else if (f.kind === "base") {
      const exact = base.get(f.kz) ?? 0;
      const booked = tax.get(f.kz);
      out.push({
        kz: f.kz,
        label: f.label,
        kind: f.kind,
        valueCents: truncEuros(exact) * 100,
        exactCents: exact,
        ...(booked !== undefined ? { bookedTaxCents: booked } : {}),
      });
      total += f.kz83 * (booked ?? 0);
    } else {
      const v = tax.get(f.kz) ?? 0;
      out.push({ kz: f.kz, label: f.label, kind: f.kind, valueCents: v });
      total += f.kz83 * v;
    }
  }
  const totalDef = fields.find((f) => f.kind === "total");
  if (totalDef) out.push({ kz: totalDef.kz, label: totalDef.label, kind: "total", valueCents: total });
  const nonZero = out.some((f) => f.kind !== "total" && (f.valueCents !== 0 || (f.exactCents ?? 0) !== 0));
  const required = opts.ku ? nonZero : true;
  const notices: string[] = [];
  if (opts.ku) notices.push(required ? KU_UVA_NOTICE : KU_NOT_REQUIRED);
  if (!m.verifiedAgainstForm) notices.push(unverifiedNotice("Umsatzsteuer-Voranmeldung", m.formYear));
  return {
    period,
    formYear: m.formYear,
    mappingVersion: m.version,
    verified: m.verifiedAgainstForm !== undefined,
    ku: opts.ku,
    required,
    fields: out,
    totalCents: total,
    drillDown,
    notices,
  };
}

/** E-UVA-20 */
export const unverifiedNotice = (form: string, year: number) =>
  `Die Ausfüllhilfe für ${form} ${year} ist noch nicht gegen das amtliche Formular geprüft. Bitte Update einspielen.`;

/** E-UVA-07 */
export const mappingMissingNotice = (year: number) =>
  `Die Kennzahlen-Zuordnung für ${year} ist noch nicht hinterlegt. Bitte Update einspielen.`;

/** Kz → value in cents (the frozen `taxFilings.values`). */
export function sheetValues(sheet: Pick<UstvaSheet, "fields">): Record<string, number> {
  const v: Record<string, number> = {};
  for (const f of sheet.fields) if (f.valueCents !== 0 || f.kind === "total") v[f.kz] = f.valueCents;
  return v;
}

// ── copy strings (TAX-004, TAX-020, TST-TAX-27) ─────────────────────────────────────────────────────────

/**
 * The value exactly as Mein ELSTER expects it: bases in whole euros, tax amounts with decimal comma, no thousands
 * separator, no € sign, leading minus. `null` = „leer lassen“ (zero), except the total (Kz 83 is always shown).
 */
export function elsterCopyString(kind: KzDef["kind"], valueCents: number): string | null {
  if (valueCents === 0 && kind !== "total") return null;
  if (kind === "base" || kind === "base_computed") return String(Math.trunc(valueCents / 100));
  return formatDecimal(valueCents, 2).replace(/\./g, "");
}

// ── sheet hash (TAX-020/TAX-021, E-UVA-18) ──────────────────────────────────────────────────────────────

export function sheetHash(input: {
  form: string;
  period: string;
  ruleVersions: readonly string[];
  values: Record<string, number>;
}): Promise<string> {
  return sha256Hex(canonicalize({ ...input, ruleVersions: [...input.ruleVersions] }));
}

// ── corrections (TAX-007) ───────────────────────────────────────────────────────────────────────────────

export interface KzDelta {
  kz: string;
  beforeCents: number;
  afterCents: number;
  deltaCents: number;
}

/** Differences between the filed values and a recomputation (RI-23, TAX-007 „Korrektur erforderlich“). */
export function kennzahlDeltas(before: Record<string, number>, after: Record<string, number>): KzDelta[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort((a, b) => Number(a) - Number(b));
  return keys
    .map((kz) => ({ kz, beforeCents: before[kz] ?? 0, afterCents: after[kz] ?? 0 }))
    .map((d) => ({ ...d, deltaCents: d.afterCents - d.beforeCents }))
    .filter((d) => d.deltaCents !== 0);
}

/** E-UVA-04: a second „übermittelt“ for the same period is only possible as a berichtigte Anmeldung (Kz 10 = 1). */
export const alreadySubmittedNotice = (periodLabel: string) =>
  `Für ${periodLabel} wurde bereits eine Voranmeldung übermittelt. Bitte eine berichtigte Voranmeldung erstellen.`;

/**
 * E-UVA-06: a correction for a period of a prior year — once the annual return of that year is filed, corrections
 * go into a berichtigte Jahreserklärung. The app keeps no annual-return record (TAX-023: worksheet only), so the
 * warning is shown for every correction of a period before the current year.
 */
export const priorYearCorrectionWarning = (year: number) =>
  `Für ${year} ist die Jahreserklärung bereits abgegeben? Dann bitte keine berichtigte Voranmeldung, sondern eine berichtigte Umsatzsteuer-Jahreserklärung in Mein ELSTER übermitteln (Arbeitsblatt USt-Jahreserklärung).`;

/** Notices of a filing period that already has a submitted UStVA (E-UVA-04, E-UVA-06). */
export function submittedPeriodNotices(o: { submitted: boolean; periodLabel: string; period: string; today: string }) {
  if (!o.submitted) return [];
  const year = Number(o.period.slice(0, 4));
  return [
    alreadySubmittedNotice(o.periodLabel),
    ...(year < Number(o.today.slice(0, 4)) ? [priorYearCorrectionWarning(year)] : []),
  ];
}

/** E-UVA-05 */
export const NO_CORRECTION_NEEDED =
  "Die berichtigten Werte entsprechen der letzten Meldung – keine Berichtigung nötig.";

/** E-TAX-01 */
export const correctionRequiredNotice = (n: number, periodLabel: string) =>
  `${n} Buchungen gehören steuerlich in den bereits gemeldeten Zeitraum ${periodLabel}. Eine berichtigte Voranmeldung ist erforderlich.`;

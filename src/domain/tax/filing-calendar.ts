/**
 * Filing period suggestion and deadline calendar (F08 TAX-001, TAX-019; UVA-01, AO-02). Pure: `today` and the
 * settings are passed in.
 *
 *  - UStVA due on the 10th after the period end, +1 month with Dauerfristverlängerung (§ 46 UStDV); ZM on the 25th
 *    (§ 18a Abs. 1 UStG, no Dauerfrist); Sondervorauszahlung application by 10 February (§ 48 UStDV);
 *    ESt/KiSt/Soli prepayments 10.03/10.06/10.09/10.12 (§ 37 EStG), GewSt 15.02/15.05/15.08/15.11 (§ 19 GewStG);
 *    annual returns of a tax year for self-filers from the date-effective table (§ 149 Abs. 2 AO, default 31 July).
 *  - Every date falling on a Saturday, Sunday or public holiday (federal + the company's Land) moves to the next
 *    business day (§ 108 Abs. 3 AO).
 */
import { formatCents } from "../money";
import { shiftToBusinessDay } from "../rules/holidays";
import { lookupAnnualReturnDeadline, lookupNeugruenderRule, lookupUstvaPeriodLimits } from "../rules/tax-filing";
import { addDays, type CalendarDate, calendarDate, daysInMonth } from "../time/calendar-date";
import { type FilingPeriodKind, filingPeriodLabel, monthsOfFilingPeriod } from "./ustva";

const euro = (cents: number) => `${formatCents(cents).replace(/,00$/, "")} €`;

export interface PeriodSuggestion {
  period: Exclude<FilingPeriodKind, "annual_only">;
  /** ≤ waiver limit: exemption from the UStVA possible on application (never applied automatically). */
  waiverPossible: boolean;
  reason: string;
}

/** TAX-001 / E-UVA-11: suggestion for `year` from the prior-year tax (Kz 83 sum + Sondervorauszahlung). */
export function suggestUstvaPeriod(input: {
  year: number;
  priorYearTaxCents: number | null;
  foundedOn?: string | undefined;
}): PeriodSuggestion {
  const yearStart = calendarDate(`${input.year}-01-01`);
  const founded = input.foundedOn ? Number(input.foundedOn.slice(0, 4)) : null;
  const founder = founded !== null && (founded === input.year || founded === input.year - 1);
  const rule = lookupNeugruenderRule(yearStart);
  if (founder && rule.ok && rule.value.value.monthlyForFounders) {
    return {
      period: "monthly",
      waiverPossible: false,
      reason: "Neugründung: im Gründungsjahr und im Folgejahr ist die Voranmeldung monatlich abzugeben.",
    };
  }
  const limits = lookupUstvaPeriodLimits(yearStart);
  if (!limits.ok || input.priorYearTaxCents === null) {
    return { period: "quarterly", waiverPossible: false, reason: "Ohne Vorjahreswerte: Vorschlag vierteljährlich." };
  }
  const { monthlyAboveCents, waiverUpToCents } = limits.value.value;
  if (input.priorYearTaxCents > monthlyAboveCents) {
    return {
      period: "monthly",
      waiverPossible: false,
      reason: `Ihre Zahllast ${input.year - 1} lag über ${euro(monthlyAboveCents)} – ab ${input.year} monatliche Voranmeldung.`,
    };
  }
  return {
    period: "quarterly",
    waiverPossible: input.priorYearTaxCents <= waiverUpToCents,
    reason:
      input.priorYearTaxCents <= waiverUpToCents
        ? `Zahllast ${input.year - 1} bis ${euro(waiverUpToCents)}: vierteljährlich; Befreiung von der Voranmeldung auf Antrag beim Finanzamt möglich.`
        : `Zahllast ${input.year - 1} bis ${euro(monthlyAboveCents)}: vierteljährliche Voranmeldung.`,
  };
}

// ── deadlines ───────────────────────────────────────────────────────────────────────────────────────────

const ymd = (y: number, m: number, d: number) =>
  calendarDate(`${y}-${String(m).padStart(2, "0")}-${String(Math.min(d, daysInMonth(y, m))).padStart(2, "0")}`);

/** Day `day` of the `offset`-th month after the last month of the filing period. */
function afterPeriod(period: string, offset: number, day: number): CalendarDate {
  const last = monthsOfFilingPeriod(period).at(-1) as string;
  let y = Number(last.slice(0, 4));
  let m = Number(last.slice(5, 7)) + offset;
  while (m > 12) {
    m -= 12;
    y++;
  }
  return ymd(y, m, day);
}

export interface Deadline {
  kind:
    | "ustva"
    | "zm"
    | "sondervorauszahlung"
    | "est_prepayment"
    | "gewst_prepayment"
    | "einvoice_eu_service"
    | "annual_euer"
    | "annual_ust"
    | "annual_gewst";
  period?: string;
  label: string;
  /** Legal date before the § 108 Abs. 3 AO shift. */
  statutory: CalendarDate;
  /** Effective due date (shifted to the next business day). */
  due: CalendarDate;
  /** Reminder dates (notification days). */
  remindOn: CalendarDate[];
}

export function ustvaDeadline(period: string, dauerfrist: boolean, state: string | undefined) {
  const statutory = afterPeriod(period, dauerfrist ? 2 : 1, 10);
  return { statutory, due: shiftToBusinessDay(statutory, state) };
}

export function zmDeadline(period: string, state: string | undefined) {
  const statutory = afterPeriod(period, 1, 25);
  return { statutory, due: shiftToBusinessDay(statutory, state) };
}

export interface CalendarSettings {
  /** `ustvaPeriod` of the tax year; null = no UStVA (KU without §13b/igE). */
  ustvaPeriod: FilingPeriodKind | null;
  dauerfrist: boolean;
  /** ZM relevant (EU supplies/services in the year or setting); period kind of the ZM. */
  zm: "monthly" | "quarterly" | null;
  /** Land for the holiday calendar (companyProfile.taxNumberState). */
  state?: string | undefined;
  estPrepayments: boolean;
  gewstPrepayments: boolean;
  /** UST-02: invoices for EU B2B services are due by the 15th of the following month. */
  euServices: boolean;
  /** EÜR company (else Bilanz: the Jahresabschluss is external, AO-07). */
  euer: boolean;
  gewerbe: boolean;
}

const periodsOf = (year: number, kind: FilingPeriodKind): string[] =>
  kind === "monthly"
    ? Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`)
    : kind === "quarterly"
      ? [1, 2, 3, 4].map((q) => `${year}-Q${q}`)
      : [String(year)];

const ustvaReminder = (due: CalendarDate) => [addDays(due, -5)];

/** TAX-019: all deadlines that belong to tax year `year` (the December/Q4 and annual ones fall into later years). */
export function deadlinesForTaxYear(year: number, s: CalendarSettings): Deadline[] {
  const out: Deadline[] = [];
  const shift = (d: CalendarDate) => shiftToBusinessDay(d, s.state);
  if (s.ustvaPeriod && s.ustvaPeriod !== "annual_only") {
    for (const p of periodsOf(year, s.ustvaPeriod)) {
      const d = ustvaDeadline(p, s.dauerfrist, s.state);
      out.push({
        kind: "ustva",
        period: p,
        label: `UStVA ${filingPeriodLabel(p)}`,
        ...d,
        remindOn: ustvaReminder(d.due),
      });
    }
    if (s.dauerfrist && s.ustvaPeriod === "monthly") {
      const statutory = ymd(year, 2, 10);
      const due = shift(statutory);
      out.push({
        kind: "sondervorauszahlung",
        period: String(year),
        label: `Sondervorauszahlung / Dauerfristverlängerung ${year} (USt 1 H)`,
        statutory,
        due,
        remindOn: [addDays(due, -14), addDays(due, -3)],
      });
    }
  }
  if (s.zm) {
    for (const p of periodsOf(year, s.zm)) {
      const d = zmDeadline(p, s.state);
      out.push({
        kind: "zm",
        period: p,
        label: `Zusammenfassende Meldung ${filingPeriodLabel(p)}`,
        ...d,
        remindOn: [addDays(d.due, -5)],
      });
    }
  }
  if (s.euServices) {
    for (let m = 1; m <= 12; m++) {
      const statutory = m === 12 ? ymd(year + 1, 1, 15) : ymd(year, m + 1, 15);
      out.push({
        kind: "einvoice_eu_service",
        period: `${year}-${String(m).padStart(2, "0")}`,
        label: `Rechnungen für EU-Dienstleistungen ${String(m).padStart(2, "0")}/${year} (§ 14a UStG)`,
        statutory,
        due: shift(statutory),
        remindOn: [addDays(shift(statutory), -3)],
      });
    }
  }
  const quarterly = (kind: Deadline["kind"], label: string, days: [number, number][]) => {
    for (const [m, d] of days) {
      const statutory = ymd(year, m, d);
      const due = shift(statutory);
      out.push({ kind, period: String(year), label, statutory, due, remindOn: [addDays(due, -7)] });
    }
  };
  if (s.estPrepayments) {
    quarterly("est_prepayment", "ESt-Vorauszahlung", [
      [3, 10],
      [6, 10],
      [9, 10],
      [12, 10],
    ]);
  }
  if (s.gewstPrepayments) {
    quarterly("gewst_prepayment", "GewSt-Vorauszahlung", [
      [2, 15],
      [5, 15],
      [8, 15],
      [11, 15],
    ]);
  }
  const annual = lookupAnnualReturnDeadline(calendarDate(`${year}-01-01`));
  if (annual.ok) {
    const { month, day, remindDaysBefore } = annual.value.value;
    const statutory = ymd(year + 1, month, day);
    const due = shift(statutory);
    const remindOn = remindDaysBefore.map((n) => addDays(due, -n));
    const add = (kind: Deadline["kind"], label: string) =>
      out.push({ kind, period: String(year), label, statutory, due, remindOn });
    if (s.euer) add("annual_euer", `Einkommensteuererklärung mit Anlage EÜR ${year}`);
    add("annual_ust", `Umsatzsteuer-Jahreserklärung ${year}`);
    if (s.gewerbe) add("annual_gewst", `Gewerbesteuererklärung ${year}`);
  }
  return out.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0));
}

/** Deadlines whose reminder or due date is `today` (the daily `deadlines.notify` run). */
export function dueNotifications(deadlines: readonly Deadline[], today: CalendarDate) {
  const out: { deadline: Deadline; when: "reminder" | "due" }[] = [];
  for (const d of deadlines) {
    if (d.due === today) out.push({ deadline: d, when: "due" });
    else if (d.remindOn.includes(today)) out.push({ deadline: d, when: "reminder" });
  }
  return out;
}

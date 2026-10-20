/**
 * Travel-expense voucher helper (01-compliance MISC-06; F06 P4 „Reisekosten“). Pure.
 *
 * Computes the domestic meal allowances (Verpflegungsmehraufwand) per day and the mileage of one business trip from
 * the date-effective `TRAVEL_RATES` table (per day, so a trip across a rate change uses both rows), and turns the
 * result into expense voucher lines (no input VAT on flat rates) plus the rows of the Eigenbeleg
 * „Reisekostenabrechnung“.
 *
 * Day rule (§ 9 Abs. 4a S. 3 EStG): a single-day trip earns the partial-day rate only when the absence exceeds
 * 8 hours; on a trip over several calendar days (an overnight stay away is assumed) the arrival and departure days
 * earn the partial-day rate and every day in between the full-day rate. Provided meals reduce a day's allowance by
 * 20 % / 40 % of the full-day rate, never below 0 (§ 9 Abs. 4a S. 8 EStG).
 */
import { formatMoneyDe } from "../banking/amount";
import { roundHalfAway } from "../money";
import { err, type Issue, issue, ok, type Result } from "../result";
import type { Chart } from "../rules/accounting/types";
import type { RuleOverride } from "../rules/rule-table";
import { lookupTravelRates, type TravelRates } from "../rules/travel-expenses";
import { berlinCalendarDate } from "../time/berlin";
import { addDays, type CalendarDate, formatGermanDate } from "../time/calendar-date";
import type { VoucherLine } from "./types";

export interface MealsProvided {
  readonly breakfast?: boolean;
  readonly lunch?: boolean;
  readonly dinner?: boolean;
}

export interface TripInput {
  /** Departure from home/first place of work and return (UTC instants). */
  readonly startedAt: number;
  readonly endedAt: number;
  readonly destination: string;
  readonly purpose: string;
  readonly mealsProvided?: Readonly<Record<string, MealsProvided>>;
  readonly kilometres?: number;
  readonly vehicle?: "car" | "other";
}

export type TravelDayKind = "none" | "partial" | "full";

export interface TravelDay {
  readonly date: CalendarDate;
  readonly kind: TravelDayKind;
  readonly allowanceCents: number;
  readonly reductionCents: number;
  readonly payableCents: number;
  readonly ruleRowId: string;
}

export interface TravelExpenses {
  readonly days: readonly TravelDay[];
  readonly mealAllowanceCents: number;
  readonly mileageCents: number;
  readonly totalCents: number;
  readonly ruleRowIds: readonly string[];
}

export type TravelIssue = Issue<"travel_period" | "travel_text" | "travel_km" | "rule_missing">;

export const TRAVEL_MESSAGES = {
  period: "Die Rückkehr liegt vor der Abreise.",
  text: "Bitte Reiseziel und Reisezweck angeben.",
  km: "Die gefahrenen Kilometer müssen eine ganze Zahl ≥ 0 sein.",
} as const;

const EIGHT_HOURS_MS = 8 * 3_600_000;

function dayAllowance(kind: TravelDayKind, r: TravelRates, meals: MealsProvided | undefined) {
  const allowance = kind === "full" ? r.fullDayCents : kind === "partial" ? r.partialDayCents : 0;
  if (allowance === 0) return { allowanceCents: 0, reductionCents: 0 };
  const share = (bp: number) => Number(roundHalfAway(BigInt(r.fullDayCents) * BigInt(bp), 10_000n));
  const reduction =
    (meals?.breakfast ? share(r.breakfastReductionBp) : 0) +
    (meals?.lunch ? share(r.mealReductionBp) : 0) +
    (meals?.dinner ? share(r.mealReductionBp) : 0);
  return { allowanceCents: allowance, reductionCents: Math.min(allowance, reduction) };
}

export function computeTravelExpenses(
  trip: TripInput,
  overrides: readonly RuleOverride<TravelRates>[] = [],
): Result<TravelExpenses, TravelIssue> {
  if (trip.endedAt < trip.startedAt) return err(issue("travel_period", TRAVEL_MESSAGES.period));
  if (!trip.destination.trim() || !trip.purpose.trim()) return err(issue("travel_text", TRAVEL_MESSAGES.text));
  const km = trip.kilometres ?? 0;
  if (!Number.isSafeInteger(km) || km < 0) return err(issue("travel_km", TRAVEL_MESSAGES.km));
  const first = berlinCalendarDate(trip.startedAt);
  const last = berlinCalendarDate(trip.endedAt);
  const days: TravelDay[] = [];
  for (let date = first; date <= last; date = addDays(date, 1)) {
    const rule = lookupTravelRates(date, overrides);
    if (!rule.ok) return err(rule.error);
    const single = first === last;
    const kind: TravelDayKind = single
      ? trip.endedAt - trip.startedAt > EIGHT_HOURS_MS
        ? "partial"
        : "none"
      : date === first || date === last
        ? "partial"
        : "full";
    const a = dayAllowance(kind, rule.value.value, trip.mealsProvided?.[date]);
    days.push({ date, kind, ...a, payableCents: a.allowanceCents - a.reductionCents, ruleRowId: rule.value.rowId });
  }
  const start = lookupTravelRates(first, overrides);
  if (!start.ok) return err(start.error);
  const perKm = trip.vehicle === "other" ? start.value.value.otherVehiclePerKmCents : start.value.value.carPerKmCents;
  const mealAllowanceCents = days.reduce((s, d) => s + d.payableCents, 0);
  const mileageCents = km * perKm;
  return ok({
    days,
    mealAllowanceCents,
    mileageCents,
    totalCents: mealAllowanceCents + mileageCents,
    ruleRowIds: [...new Set([...days.map((d) => d.ruleRowId), start.value.rowId])],
  });
}

/** Expense accounts of the travel lines (SKR03/SKR04 „Reisekosten Unternehmer …“). */
export const TRAVEL_ACCOUNTS: Readonly<Record<Chart, { meals: string; mileage: string }>> = {
  SKR03: { meals: "4674", mileage: "4673" },
  SKR04: { meals: "6674", mileage: "6673" },
};

/** Voucher lines (no input VAT on flat rates) and the Eigenbeleg rows of a computed trip. */
export function travelVoucher(
  trip: TripInput,
  result: TravelExpenses,
  chart: Chart,
): { lines: VoucherLine[]; title: string; rows: [string, string][]; statement: string } {
  const accounts = TRAVEL_ACCOUNTS[chart];
  const first = result.days[0]?.date;
  const last = result.days[result.days.length - 1]?.date;
  const period =
    first && last && first !== last
      ? `${formatGermanDate(first)}–${formatGermanDate(last)}`
      : first
        ? formatGermanDate(first)
        : "";
  const line = (account: string, description: string, cents: number): VoucherLine => ({
    account,
    description,
    netCents: cents,
    vatRateBp: 0,
    vatCents: 0,
    grossCents: cents,
  });
  const lines: VoucherLine[] = [];
  if (result.mealAllowanceCents > 0) {
    lines.push(
      line(accounts.meals, `Verpflegungsmehraufwand ${trip.destination.trim()} ${period}`, result.mealAllowanceCents),
    );
  }
  if (result.mileageCents > 0) {
    lines.push(
      line(
        accounts.mileage,
        `Fahrtkosten ${trip.kilometres ?? 0} km (${trip.vehicle === "other" ? "sonstiges Fahrzeug" : "Pkw"})`,
        result.mileageCents,
      ),
    );
  }
  const rows: [string, string][] = [
    ["Reiseziel", trip.destination.trim()],
    ["Reisezweck", trip.purpose.trim()],
    ["Zeitraum", period],
  ];
  for (const d of result.days) {
    const label =
      d.kind === "full" ? "24 Stunden" : d.kind === "partial" ? "An-/Abreise bzw. > 8 Stunden" : "unter 8 Stunden";
    const reduction = d.reductionCents > 0 ? ` (abzgl. Mahlzeiten ${formatMoneyDe(d.reductionCents, "EUR")})` : "";
    rows.push([formatGermanDate(d.date), `${label}: ${formatMoneyDe(d.payableCents, "EUR")}${reduction}`]);
  }
  if (result.mileageCents > 0) rows.push(["Fahrtkosten", formatMoneyDe(result.mileageCents, "EUR")]);
  rows.push(["Summe", formatMoneyDe(result.totalCents, "EUR")]);
  return {
    lines,
    title: "Reisekostenabrechnung",
    rows,
    statement: "Pauschalen nach § 9 Abs. 4a und Abs. 1 Nr. 4a EStG (§ 4 Abs. 5 Nr. 5 EStG); keine Vorsteuer.",
  };
}

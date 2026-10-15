/**
 * § 288 BGB default interest (F05 DUN-020, MAHN-02). Pure; no floating point.
 *
 * - days are counted inclusive of both ends, actual/365 also in leap years (F05 Q-03, decided);
 * - rate = Basiszinssatz (§ 247 BGB, `rules/basiszinssatz.ts`) + 5 points (B2C) / + 9 points (B2B) or a custom margin;
 * - segments split at every Basiszinssatz row change, every change of the surcharge table and every principal change
 *   (a payment dated D reduces the principal from D on);
 * - the exact rational sum over all segments is rounded **once** half-up to cents; fees and earlier interest are never
 *   part of the base (no compound interest).
 *
 * A missing Basiszinssatz row is an error (`basiszinssatz_missing`, EC-DUN-10) — never a guess.
 */
import { roundHalfAway } from "../money/rounding";
import { err, type Issue, ok, type Result } from "../result";
import { type BasiszinssatzValue, lookupBasiszinssatz } from "../rules/basiszinssatz";
import type { RuleOverride } from "../rules/rule-table";
import { lookupVerzugSurcharges } from "../rules/thresholds";
import { addDays, type CalendarDate, daysBetween } from "../time/calendar-date";

export type InterestMargin = "b2c" | "b2b" | { readonly customBp: number };

export interface PrincipalChange {
  /** Effective from this day (inclusive). */
  readonly date: CalendarDate;
  /** Negative = payment/credit, positive = reversal of a payment. */
  readonly deltaCents: number;
}

export interface InterestInput {
  /** Principal on `from` (before changes dated after `from`). */
  readonly principalCents: number;
  readonly changes?: readonly PrincipalChange[];
  /** First interest day (inclusive). */
  readonly from: CalendarDate;
  /** Last interest day (inclusive). */
  readonly to: CalendarDate;
  readonly margin: InterestMargin;
  readonly overrides?: readonly RuleOverride<BasiszinssatzValue>[];
}

export interface InterestSegment {
  readonly from: CalendarDate;
  readonly to: CalendarDate;
  readonly days: number;
  readonly principalCents: number;
  /** Interest rate p. a. in basis points (Basiszinssatz + margin). */
  readonly rateBp: number;
  /** Rounded per segment for display only; the total is rounded once over the exact sum. */
  readonly amountCents: number;
  readonly basiszinsRowId: string;
}

export interface InterestResult {
  readonly totalCents: number;
  readonly segments: readonly InterestSegment[];
  /** EC-DUN-12: below 0,01 € no interest line is printed. */
  readonly printable: boolean;
}

const YEAR_DAYS = 365n;
const BP = 10_000n;

const minDate = (a: CalendarDate, b: CalendarDate): CalendarDate => (a < b ? a : b);

function principalOn(input: InterestInput, date: CalendarDate): number {
  let p = input.principalCents;
  for (const c of input.changes ?? []) if (c.date <= date) p += c.deltaCents;
  return Math.max(0, p);
}

function marginBp(margin: InterestMargin, surcharge: { b2cBp: number; b2bBp: number }): number {
  if (margin === "b2c") return surcharge.b2cBp;
  if (margin === "b2b") return surcharge.b2bBp;
  return margin.customBp;
}

export function computeInterest(input: InterestInput): Result<InterestResult, Issue> {
  const segments: InterestSegment[] = [];
  let numerator = 0n;
  let start = input.from;
  const changeDates = [...new Set((input.changes ?? []).map((c) => c.date))].sort();
  while (start <= input.to) {
    const base = lookupBasiszinssatz(start, input.overrides ?? []);
    if (!base.ok) return err(base.error);
    const surcharge = lookupVerzugSurcharges(start);
    if (!surcharge.ok) return err(surcharge.error);
    let end = input.to;
    if (base.value.validTo) end = minDate(end, base.value.validTo);
    if (surcharge.value.validTo) end = minDate(end, surcharge.value.validTo);
    const nextChange = changeDates.find((c) => c > start);
    if (nextChange) end = minDate(end, addDays(nextChange as CalendarDate, -1));
    const principal = principalOn(input, start);
    const rateBp = base.value.value.rateBp + marginBp(input.margin, surcharge.value.value);
    const days = daysBetween(start, end) + 1;
    if (principal > 0) {
      const exact = BigInt(principal) * BigInt(rateBp) * BigInt(days);
      numerator += exact;
      segments.push({
        from: start,
        to: end,
        days,
        principalCents: principal,
        rateBp,
        amountCents: Number(roundHalfAway(exact, BP * YEAR_DAYS)),
        basiszinsRowId: base.value.rowId,
      });
    }
    start = addDays(end, 1);
  }
  const totalCents = Number(roundHalfAway(numerator, BP * YEAR_DAYS));
  return ok({ totalCents, segments, printable: totalCents >= 1 });
}

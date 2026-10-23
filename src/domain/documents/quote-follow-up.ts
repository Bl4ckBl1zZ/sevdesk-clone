/**
 * F04 QUO-16: quote follow-up reminders („Angebot nachfassen“) +5 and +12 days after sending when the customer has
 * not reacted. Reuses the dunning policy step model (`PolicyStep`, `nextStepOf`, F05 DUN-001): one level per daily
 * run, never skipping a level. Only a to-do is raised — nothing is sent. Pure.
 */
import { type DunningPolicy, nextStepOf, type PolicyStep } from "../dunning/policy";
import { addDays, type CalendarDate, daysBetween } from "../time/calendar-date";
import type { SalesDocStatus } from "./lifecycle";

const step = (level: number, daysAfter: number, title: string): PolicyStep => ({
  level,
  daysAfter,
  title,
  feeCents: 0,
  addInterest: false,
  addFlatFee40: false,
  newDueDays: 0,
  autoFinalize: false,
});

/** Unlike dunning levels, `daysAfter` counts from the day the quote was marked as sent (not from the last step). */
export const QUOTE_FOLLOW_UP_POLICY: Pick<DunningPolicy, "name" | "steps"> = {
  name: "Angebote nachfassen",
  steps: [step(1, 5, "Angebot nachfassen"), step(2, 12, "Angebot erneut nachfassen")],
};

export interface QuoteFollowUpRow {
  readonly id: string;
  readonly status: SalesDocStatus;
  /** Day the quote was marked as sent (SND-16); unsent quotes are not followed up. */
  readonly sentOn?: string | undefined;
  readonly validUntil?: string | undefined;
  /** Highest follow-up level already raised (0 = none). */
  readonly level: number;
}

export interface QuoteFollowUp {
  readonly id: string;
  readonly level: number;
  readonly daysSinceSent: number;
  readonly title: string;
}

export function quoteFollowUps(
  rows: readonly QuoteFollowUpRow[],
  today: string,
  policy: Pick<DunningPolicy, "steps"> = QUOTE_FOLLOW_UP_POLICY,
): QuoteFollowUp[] {
  const out: QuoteFollowUp[] = [];
  for (const q of rows) {
    // „Ohne Reaktion“: still `sent` — accepted, rejected, withdrawn, expired or converted quotes are done.
    if (q.status !== "sent" || !q.sentOn) continue;
    if (q.validUntil && q.validUntil < today) continue;
    const next = nextStepOf(policy, q.level);
    if (!next || addDays(q.sentOn as CalendarDate, next.daysAfter) > today) continue;
    out.push({
      id: q.id,
      level: next.level,
      daysSinceSent: daysBetween(q.sentOn as CalendarDate, today as CalendarDate),
      title: next.title,
    });
  }
  return out;
}

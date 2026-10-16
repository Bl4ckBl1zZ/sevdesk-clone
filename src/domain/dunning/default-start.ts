/**
 * Default start (Verzugsbeginn, first interest day) — F05 PAY-053, MAHN-01, § 286 BGB. Pure.
 *
 * Earliest applicable of:
 *  (a) "Zahlungstermin kalendermäßig vereinbart" on the contact → due date + 1 (§ 286 Abs. 2 Nr. 1, needs no Zugang);
 *  (b) the first reminder dated after the due date that has a Zugang (manual sent mark, PAY-052) → per setting
 *      `after_printed_deadline` (default: the day after the printed deadline, never earlier than Zugang + 1) or
 *      `zugang_plus_1` (§ 286 Abs. 1). A finalised but unmarked or withdrawn reminder never starts default;
 *  (c) § 286 Abs. 3: max(due date, Zugang of the invoice) + 31 days — only with a Zugang (PAY-064) and, for consumers,
 *      only if the invoice carries the § 286 Abs. 3 note (EC-DUE-02).
 */
import { addDays, type CalendarDate, formatGermanDate } from "../time/calendar-date";

export type DefaultRoute = "calendar" | "reminder" | "30_days";

// LEGAL-OPEN: F05 Q-01 (README open item 12) — whether a reminder with a printed deadline puts the debtor in default
// only after that deadline. Default `after_printed_deadline` (conservative), `zugang_plus_1` selectable in
// Einstellungen › Mahnwesen (companyProfile.receivables.defaultStartViaReminder).
export type DefaultStartViaReminder = "after_printed_deadline" | "zugang_plus_1";

export interface ReminderFacts {
  readonly documentDate: CalendarDate;
  /** Printed deadline (`reminder.newDueDate`, § 193-shifted). */
  readonly newDueDate: CalendarDate;
  readonly zugang?: CalendarDate | undefined;
  readonly status: "draft" | "finalized" | "sent" | "cancelled";
}

export interface DefaultStartInput {
  readonly dueDate: CalendarDate;
  readonly invoiceZugang?: CalendarDate | undefined;
  readonly isConsumer: boolean;
  /** The invoice snapshot contains the `b2c_286` note (MAHN-01). */
  readonly hasB2c286Note: boolean;
  readonly calendarDueDateAgreed: boolean;
  readonly reminders: readonly ReminderFacts[];
  readonly route: DefaultStartViaReminder;
}

export interface DefaultStart {
  readonly date: CalendarDate;
  readonly route: DefaultRoute;
  /** „Verzug seit 16.07.2026 – 30-Tage-Regel“ */
  readonly label: string;
}

export const DEFAULT_ROUTE_LABEL_DE: Readonly<Record<DefaultRoute, string>> = {
  calendar: "Zahlungstermin kalendermäßig vereinbart",
  reminder: "Mahnung",
  "30_days": "30-Tage-Regel",
};

const maxDate = (a: CalendarDate, b: CalendarDate): CalendarDate => (a > b ? a : b);

export function defaultStartOf(i: DefaultStartInput): DefaultStart | null {
  const candidates: { date: CalendarDate; route: DefaultRoute }[] = [];
  if (i.calendarDueDateAgreed) candidates.push({ date: addDays(i.dueDate, 1), route: "calendar" });
  const first = [...i.reminders]
    .filter((r) => r.status !== "cancelled" && r.status !== "draft" && r.zugang && r.documentDate > i.dueDate)
    .sort((a, b) => ((a.zugang as string) < (b.zugang as string) ? -1 : 1))[0];
  if (first?.zugang) {
    const afterZugang = addDays(first.zugang, 1);
    candidates.push({
      date: i.route === "zugang_plus_1" ? afterZugang : maxDate(afterZugang, addDays(first.newDueDate, 1)),
      route: "reminder",
    });
  }
  if (i.invoiceZugang && (!i.isConsumer || i.hasB2c286Note)) {
    candidates.push({ date: addDays(maxDate(i.dueDate, i.invoiceZugang), 31), route: "30_days" });
  }
  const best = candidates.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))[0];
  if (!best) return null;
  return { ...best, label: `Verzug seit ${formatGermanDate(best.date)} – ${DEFAULT_ROUTE_LABEL_DE[best.route]}` };
}

/** DUN-026: fees, interest and the 40 € need default on the reminder date. */
export const inDefaultOn = (start: DefaultStart | null | undefined, date: CalendarDate): boolean =>
  start !== null && start !== undefined && start.date <= date;

/**
 * Number register rules (F01 SET-059, SET-060, SET-062, SET-064, §4.3, §5.5; UST-06, GOBD-02, GOBD-05). Pure: the
 * Convex model passes the issued numbers (`numberRegister.normalized`) and counters in.
 */
import { err, type Issue, issue, ok, type Result } from "../result";
import { MAX_NUMBER_LENGTH, normalizeNumber, periodKey, type ResetPolicy, render, type YearMonth } from "./format";

/** EC-008: how many numbers per period the format simulation renders. */
export const COLLISION_SIMULATION_COUNT = 10_000;

/** German labels of the numbered document types (messages, settings UI). */
export const NUMBERED_TYPE_LABEL_DE: Readonly<Record<string, string>> = {
  invoice: "Rechnung",
  advance_invoice: "Abschlagsrechnung",
  partial_invoice: "Teilrechnung",
  final_invoice: "Schlussrechnung",
  cancellation: "Stornorechnung",
  correction: "Rechnungskorrektur",
  quote: "Angebot",
  order_confirmation: "Auftragsbestätigung",
  delivery_note: "Lieferschein",
  proforma: "Proforma-Rechnung",
  reminder: "Mahnung",
  self_billing: "Gutschrift",
  contact: "Kontakt",
  product: "Produkt",
  asset: "Anlage",
  voucherInternal: "Beleg (intern)",
  project: "Projekt",
};

export interface RangeFormat {
  format: string;
  resetPolicy: ResetPolicy;
  /** First counter value of a new period. */
  startValue: number;
}

/**
 * The business date of the period after `date`: the next month when the format or the reset is monthly, otherwise
 * the next year (a format without reset still renders a new year token, F01 §5.5 "Format change mid-year").
 */
export function nextPeriodDate(format: string, reset: ResetPolicy, date: YearMonth): YearMonth {
  const monthly = reset === "monthly" || format.includes("{MM}");
  if (monthly)
    return date.month === 12 ? { year: date.year + 1, month: 1 } : { year: date.year, month: date.month + 1 };
  return { year: date.year + 1, month: 1 };
}

/**
 * SET-060 (EC-008): renders the next 10,000 numbers of the current period (from `next`) and of the next period
 * (from `startValue` after a reset, otherwise from `next` again) and returns the first one that is already
 * registered (uppercase-normalised), or null.
 */
export function simulateCollision(
  range: RangeFormat & { next: number },
  today: YearMonth,
  issuedNormalized: ReadonlySet<string>,
  count = COLLISION_SIMULATION_COUNT,
): { number: string } | null {
  if (issuedNormalized.size === 0) return null;
  for (const number of simulatedNumbers(range, today, count)) {
    if (issuedNormalized.has(normalizeNumber(number))) return { number };
  }
  return null;
}

/** The numbers `simulateCollision` renders, in order (current period, then the next period). */
export function* simulatedNumbers(
  range: RangeFormat & { next: number },
  today: YearMonth,
  count = COLLISION_SIMULATION_COUNT,
): Generator<string> {
  const following = nextPeriodDate(range.format, range.resetPolicy, today);
  // Without a reset the next period continues the counter from wherever this period ends — unknown, so the
  // conservative simulation starts at the current counter again.
  const runs: [YearMonth, number][] = [
    [today, range.next],
    [following, range.resetPolicy === "never" ? range.next : range.startValue],
  ];
  for (const [date, start] of runs) {
    for (let i = 0; i < count; i++) yield render(range.format, date, start + i);
  }
}

/** Lexicographic bounds of the normalised simulated numbers (index range scan on `numberRegister.by_normalized`). */
export function simulationBounds(
  range: RangeFormat & { next: number },
  today: YearMonth,
  count = COLLISION_SIMULATION_COUNT,
): { lo: string; hi: string } {
  let lo: string | undefined;
  let hi: string | undefined;
  for (const n of simulatedNumbers(range, today, count)) {
    const v = normalizeNumber(n);
    if (lo === undefined || v < lo) lo = v;
    if (hi === undefined || v > hi) hi = v;
  }
  return { lo: lo ?? "", hi: hi ?? "" };
}

export function collisionIssue(number: string): Issue<"format_collision"> {
  return issue(
    "format_collision",
    `Das Format erzeugt die bereits vergebene Nummer ${number}. Bitte Präfix oder Startwert ändern.`,
    { number },
  );
}

/**
 * SET-059: "Nächste Nummer" may only be raised, never below max(counter, highest issued + 1). Raising creates a
 * documented gap (reason mandatory, listed by the gap report SET-063).
 */
export function validateNextValue(
  current: { counterNext?: number; maxIssuedCounter?: number },
  requested: number,
  reason: string | undefined,
): Result<{ gap?: { from: number; to: number } }, Issue<"counter_decrease" | "reason_required">> {
  const candidates = [
    current.counterNext,
    current.maxIssuedCounter === undefined ? undefined : current.maxIssuedCounter + 1,
  ];
  const known = candidates.filter((n): n is number => n !== undefined);
  if (known.length === 0) return ok({}); // nothing issued and no counter yet: the start value is free
  const min = Math.max(...known);
  if (requested < min) {
    return err(
      issue(
        "counter_decrease",
        `Die nächste Nummer kann nicht unter ${min} gesetzt werden, weil Nummern nie doppelt vergeben werden dürfen.`,
        { min },
      ),
    );
  }
  if (requested === min) return ok({});
  if (!reason?.trim()) {
    return err(issue("reason_required", "Bitte begründen, warum Nummern übersprungen werden (Lückenprotokoll)."));
  }
  return ok({ gap: { from: min, to: requested - 1 } });
}

export interface RangeRef {
  id: string;
  docTypes: readonly string[];
  active: boolean;
  isDefault: boolean;
}

function defaultRequired(range: RangeRef, all: readonly RangeRef[]): Issue<"range_default_required"> | null {
  if (!range.isDefault || !range.active) return null;
  for (const docType of range.docTypes) {
    const others = all.some((r) => r.id !== range.id && r.active && r.isDefault && r.docTypes.includes(docType));
    if (!others) {
      return issue(
        "range_default_required",
        `Für ${NUMBERED_TYPE_LABEL_DE[docType] ?? docType} muss ein aktiver Standard-Nummernkreis existieren.`,
        { docType },
      );
    }
  }
  return null;
}

/** SET-062: a range with issued numbers is never deleted; the only active default of a type stays. */
export function checkDeleteRange(
  range: RangeRef,
  issuedCount: number,
  all: readonly RangeRef[],
): Issue<"range_in_use" | "range_default_required"> | null {
  if (issuedCount > 0) {
    return issue(
      "range_in_use",
      "Aus diesem Nummernkreis wurden bereits Nummern vergeben. Er kann nur deaktiviert werden.",
    );
  }
  return defaultRequired(range, all);
}

/** SET-062: a deactivated range cannot be the default; the only active default of a type cannot be deactivated. */
export function checkDeactivateRange(
  range: RangeRef,
  all: readonly RangeRef[],
): Issue<"range_default_required"> | null {
  return defaultRequired(range, all);
}

/**
 * SET-064 / §4.3 steps 2–5: the number for `date` from the range's counter (`counterNext` undefined = the period
 * has no counter yet → start value). Rejects lengths > 36 and numbers that are already registered.
 */
export function assignNumber(
  range: RangeFormat,
  counterNext: number | undefined,
  date: YearMonth,
  issuedNormalized: ReadonlySet<string>,
): Result<
  { number: string; normalized: string; periodKey: string; counter: number; next: number },
  Issue<"number_collision" | "number_too_long">
> {
  const counter = counterNext ?? range.startValue;
  const number = render(range.format, date, counter);
  const normalized = normalizeNumber(number);
  if (number.length > MAX_NUMBER_LENGTH) {
    return err(issue("number_too_long", `Die Nummer ${number} ist länger als ${MAX_NUMBER_LENGTH} Zeichen.`));
  }
  if (issuedNormalized.has(normalized)) {
    return err(
      issue("number_collision", `Die Nummer ${number} ist bereits vergeben. Bitte den Nummernkreis prüfen.`, {
        number,
      }),
    );
  }
  return ok({ number, normalized, periodKey: periodKey(range.resetPolicy, date), counter, next: counter + 1 });
}

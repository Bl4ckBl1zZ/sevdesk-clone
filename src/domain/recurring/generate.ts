/**
 * Recurring invoices — the generated draft (F04 §4.11, REC-04, REC-09, REC-15; 10 EC-024, EC-DOC-94).
 *
 * Turns the template's draft content into the draft of one occurrence: supply period = the billing period (BG-14),
 * BT-12 = the template's contract reference or name, period placeholders and the optional period line in the head
 * text, and — when the period crosses a VAT-rate change — item lines split at the boundary (pro rata by days,
 * allocated per F04 App. E.1). A crossing of the Kleinunternehmer status cannot be split on the line level (the whole
 * invoice is taxed one way, KU-01): it is reported so the caller keeps a draft and notifies the owner.
 */
import { allocate } from "../money/allocate";
import { lookupVatRateForPeriod } from "../rules/vat-rates";
import type { DraftValues } from "../schemas/documents";
import { addDays, type CalendarDate, daysBetween, formatGermanDate } from "../time/calendar-date";
import { type Period, periodText } from "./schedule";

type Line = DraftValues["lines"][number];

/** The template's draft content: an invoice draft without document/supply dates (03 §4 `recurringTemplates.draft`). */
export type TemplateDraft = Omit<
  DraftValues,
  "documentDate" | "supplyDate" | "supplyDateMode" | "backdateReason" | "chainOrder" | "validUntil" | "deliveryTerms"
> & { type: "invoice" };

/** Rate-change dates of `key` inside (from, to]: the first day of each new rate segment. */
export function rateChangeDates(key: string, period: Period): CalendarDate[] {
  const out: CalendarDate[] = [];
  let start = period.from;
  for (let guard = 0; guard < 100; guard++) {
    const r = lookupVatRateForPeriod(key, start, period.to);
    if (r.ok || r.error.code !== "rule_changes_in_period") break;
    const at = r.error.params?.changeDate as CalendarDate | undefined;
    if (!at || at <= start) break;
    out.push(at);
    start = at;
  }
  return out;
}

/** KU-01: the first Kleinunternehmer status change inside (from, to], or the status differs at `from`/`to`. */
export function kuChangeIn(
  history: readonly { readonly validFrom: string; readonly isKU: boolean }[],
  period: Period,
): CalendarDate | null {
  const sorted = [...history].sort((a, b) => (a.validFrom < b.validFrom ? -1 : 1));
  const at = (d: string) => sorted.filter((e) => e.validFrom <= d).at(-1)?.isKU ?? false;
  const start = at(period.from);
  const change = sorted.find((e) => e.validFrom > period.from && e.validFrom <= period.to && e.isKU !== start);
  return change ? (change.validFrom as CalendarDate) : null;
}

export interface SplitResult {
  readonly lines: Line[];
  /** Every boundary a line was split at (ascending, unique). */
  readonly boundaries: CalendarDate[];
}

/**
 * REC-15: item lines whose rate key changes inside the period become one line per rate segment with its own
 * `linePeriod`; the quantity is split pro rata by days (`allocate`, residual to the longest segment, App. E.1), so the
 * sum of the parts equals the original quantity. Lines with an own `linePeriod` are kept as entered.
 */
export function splitAtRateChanges(lines: readonly Line[], period: Period): SplitResult {
  const out: Line[] = [];
  const boundaries = new Set<CalendarDate>();
  for (const l of lines) {
    if (l.kind !== "item" || l.linePeriod) {
      out.push(l);
      continue;
    }
    const changes = rateChangeDates(l.vatRateKey ?? "standard", period);
    if (changes.length === 0) {
      out.push(l);
      continue;
    }
    const segments: Period[] = [];
    let from = period.from;
    for (const at of changes) {
      segments.push({ from, to: addDays(at, -1) });
      boundaries.add(at);
      from = at;
    }
    segments.push({ from, to: period.to });
    const days = segments.map((s) => daysBetween(s.from, s.to) + 1);
    const quantities = allocate(l.quantityMilli ?? 0, days);
    segments.forEach((s, i) => {
      out.push({ ...l, quantityMilli: Number(quantities[i] ?? 0), linePeriod: { from: s.from, to: s.to } });
    });
  }
  return { lines: out, boundaries: [...boundaries].sort() };
}

const RECURRING_KEYS = ["periodFrom", "periodTo", "periodText"] as const;

/** Replaces `{{recurring.periodFrom|periodTo|periodText}}` with the occurrence's values (F01 §5.6). */
export function fillRecurringPlaceholders(text: string, period: Period, language: "de" | "en"): string {
  const values: Record<(typeof RECURRING_KEYS)[number], string> = {
    periodFrom: formatGermanDate(period.from),
    periodTo: formatGermanDate(period.to),
    periodText: periodText(period, language),
  };
  return text.replace(/\{\{\s*recurring\.(periodFrom|periodTo|periodText)\s*\}\}/g, (_m, k: string) =>
    k in values ? values[k as keyof typeof values] : "",
  );
}

export interface OccurrenceDraftInput {
  readonly draft: TemplateDraft;
  readonly templateName: string;
  readonly contractReference?: string | undefined;
  readonly period: Period;
  readonly periodTextEnabled: boolean;
  readonly kleinunternehmer: readonly { readonly validFrom: string; readonly isKU: boolean }[];
}

export interface OccurrenceDraft {
  readonly values: DraftValues;
  /** REC-15: rate-change boundaries the lines were split at. */
  readonly rateBoundaries: CalendarDate[];
  /** REC-15 / KU-01: a Kleinunternehmer status change inside the period. */
  readonly kuChange: CalendarDate | null;
  /** True when the draft must not be finalised automatically (REC-15). */
  readonly needsReview: boolean;
}

/** REC-04/09/15: the draft of one occurrence. The document date stays open (= generation/finalisation day, REC-06). */
export function occurrenceDraft(input: OccurrenceDraftInput): OccurrenceDraft {
  const { draft, period } = input;
  const lang = draft.language;
  const fill = (t: string | undefined) => (t === undefined ? undefined : fillRecurringPlaceholders(t, period, lang));
  const head = fill(draft.headText);
  const usesPlaceholder = /\{\{\s*recurring\.periodText\s*\}\}/.test(draft.headText ?? "");
  const headText =
    input.periodTextEnabled && !usesPlaceholder
      ? [periodText(period, lang), head?.trim() ? head : undefined].filter(Boolean).join("\n\n")
      : head;
  const subject = fill(draft.subject);
  const footText = fill(draft.footText);
  const split = splitAtRateChanges(draft.lines, period);
  const kuChange = kuChangeIn(input.kleinunternehmer, period);
  const contractReference = input.contractReference?.trim() || input.templateName.trim();
  const { headText: _h, subject: _s, footText: _f, ...rest } = draft;
  const values: DraftValues = {
    ...rest,
    type: "invoice",
    supplyDateMode: "explicit",
    supplyDate: { kind: "period", from: period.from, to: period.to },
    ...(subject?.trim() ? { subject } : {}),
    ...(headText?.trim() ? { headText } : {}),
    ...(footText?.trim() ? { footText } : {}),
    contractReference,
    lines: split.lines,
  };
  return {
    values,
    rateBoundaries: split.boundaries,
    kuChange,
    needsReview: split.boundaries.length > 0 || kuChange !== null,
  };
}

/** REC-13 „Steuersatz-Hinweis“: the rate changes of the template's line keys inside a period. */
export function rateHints(draft: Pick<TemplateDraft, "lines">, period: Period): string[] {
  const keys = [...new Set(draft.lines.filter((l) => l.kind === "item").map((l) => l.vatRateKey ?? "standard"))];
  return keys.flatMap((k) =>
    rateChangeDates(k, period).map(
      (d) => `Steuersatzänderung am ${formatGermanDate(d)} – Positionen werden aufgeteilt, Entwurf zur Prüfung`,
    ),
  );
}

/**
 * Invoice lines from time entries (F11 PRJ-010, PRJ-011, PRJ-013, PRJ-016; E-PRJ-12/13/15/17/18/23; EC-024).
 * Pure: the caller loads the entries (with their product's VAT key and name) and passes a VAT row resolver so a
 * rate change inside the billed period splits the lines by sub-period (UST-15).
 *
 * Quantity on time lines = Σ rounded minutes / 60, half-up to 3 decimals (`quantityMilli`); the line net follows
 * EN 16931 rounding (`lineAmountCents`). If the hours are not exactly representable (10 min = 0,167 h) the plan
 * carries the E-PRJ-17 notice with the exact vs rounded amount; unit `MIN` bills minutes at the per-minute price.
 */
import { formatCents, formatMilli, lineAmountCents, roundHalfAway } from "../money";
import { err, type Issue, issue, ok, type Result } from "../result";
import { type CalendarDate, daysInMonth, formatGermanDate } from "../time/calendar-date";
import { NO_ROUNDING, roundMinutes, type TimeRounding } from "./rates";
import { periodLabel, type TimeEntryStatus } from "./time-entries";

export const TIME_GROUPINGS = ["per_entry", "per_day", "per_product_rate", "summary"] as const;
export type TimeGrouping = (typeof TIME_GROUPINGS)[number];

export const TIME_GROUPING_LABELS: Readonly<Record<TimeGrouping, string>> = {
  per_entry: "Eine Position je Eintrag",
  per_day: "Eine Position je Tag",
  per_product_rate: "Eine Position je Leistung und Satz",
  summary: "Eine Sammelposition (lt. Leistungsnachweis)",
};

export type TimeUnit = "HUR" | "MIN";

export interface BillableEntry {
  readonly id: string;
  readonly date: CalendarDate;
  readonly durationMinutes: number;
  readonly description: string;
  readonly contactId?: string | undefined;
  readonly currency: string;
  /** 0 = no rate could be resolved (E-PRJ-23). */
  readonly hourlyRateMicros: number;
  readonly productId?: string | undefined;
  readonly productName?: string | undefined;
  readonly vatRateKey: string;
  readonly billable: boolean;
  readonly status: TimeEntryStatus;
  readonly incomplete?: boolean | undefined;
  /** Draft or invoice label for the locked messages. */
  readonly documentLabel?: string | undefined;
}

export interface TimeInvoiceOptions {
  readonly grouping: TimeGrouping;
  readonly rounding?: TimeRounding | undefined;
  /** „pro Gruppe runden“: round the group's sum instead of each entry. */
  readonly perGroup?: boolean | undefined;
  readonly unit?: TimeUnit | undefined;
  /** The VAT rule row valid on `date` for `vatRateKey`; null = no row (the document validator reports it later). */
  readonly vatRowOf?:
    | ((vatRateKey: string, date: CalendarDate) => { readonly rowId: string; readonly validFrom: CalendarDate } | null)
    | undefined;
}

export interface TimeInvoiceLine {
  readonly name: string;
  readonly description?: string;
  readonly productId?: string;
  readonly quantityMilli: number;
  readonly unitCode: TimeUnit;
  readonly unitPriceMicros: number;
  readonly vatRateKey: string;
  readonly linePeriod: { readonly from: CalendarDate; readonly to: CalendarDate };
  readonly timeEntryIds: readonly string[];
  readonly rawMinutes: number;
  readonly roundedMinutes: number;
  /** EN 16931 line net of the rounded quantity × price. */
  readonly netCents: number;
  /** minutes × hourly rate / 60, exact to the cent. */
  readonly exactNetCents: number;
}

export interface TimeInvoicePlan {
  readonly lines: readonly TimeInvoiceLine[];
  readonly contactId?: string;
  readonly currency: string;
  readonly supplyDate:
    | { readonly kind: "date"; readonly date: CalendarDate }
    | { readonly kind: "period"; readonly from: CalendarDate; readonly to: CalendarDate };
  /** Rounded minutes per entry (absent with „pro Gruppe runden“: the group carries the rounding). */
  readonly roundedByEntry: Readonly<Record<string, number>>;
  readonly rounding: TimeRounding & { readonly perGroup: boolean };
  /** E-PRJ-15 / E-PRJ-17 info and warnings (German). */
  readonly notices: readonly string[];
}

export type TimeInvoiceIssue = Issue<
  | "time_entries_empty"
  | "time_entries_contacts"
  | "time_entries_currency"
  | "time_entries_rate_missing"
  | "time_entry_locked"
  | "time_entry_incomplete"
>;

export const TIME_INVOICE_MESSAGES = {
  empty: "Bitte mindestens einen offenen Zeiteintrag auswählen.",
  contacts: "Zeiten verschiedener Kunden können nicht in einer Rechnung abgerechnet werden.",
  currency: "Die ausgewählten Zeiten haben unterschiedliche Währungen.",
  incomplete:
    "Unvollständige Einträge können erst abgerechnet werden, wenn Beschreibung und Projekt oder Kunde ergänzt sind.",
  fixedPrice: "Festpreisprojekt – Zeiten werden nicht einzeln abgerechnet.",
} as const;

export const rateMissingMessage = (n: number): string => `Für ${n} Einträge ist kein Stundensatz hinterlegt.`;

/** PRJ-016: the default selection for invoicing — open entries, billable unless explicitly included. */
export function selectableForInvoicing<E extends Pick<BillableEntry, "status" | "billable">>(
  entries: readonly E[],
  opts: { includeNonBillable?: boolean } = {},
): E[] {
  return entries.filter((e) => e.status === "open" && (e.billable || opts.includeNonBillable === true));
}

/** Validation shared by „Neuer Entwurf“ and „Zu Entwurf hinzufügen“ (E-PRJ-12/13/14/23, PRJ-012). */
export function checkSelection(
  entries: readonly BillableEntry[],
  target?: { readonly contactId?: string | undefined; readonly currency: string },
): TimeInvoiceIssue | null {
  if (entries.length === 0) return issue("time_entries_empty", TIME_INVOICE_MESSAGES.empty);
  const locked = entries.find((e) => e.status !== "open");
  if (locked) {
    const label = locked.documentLabel ?? "Entwurf";
    return locked.status === "in_draft"
      ? issue(
          "time_entry_locked",
          `Dieser Eintrag ist in Rechnungsentwurf ${label} enthalten. Entfernen Sie ihn dort zuerst.`,
        )
      : issue(
          "time_entry_locked",
          `Dieser Eintrag wurde mit Rechnung ${label} abgerechnet und kann nicht mehr geändert werden.`,
        );
  }
  if (entries.some((e) => e.incomplete)) return issue("time_entry_incomplete", TIME_INVOICE_MESSAGES.incomplete);
  const contacts = new Set(entries.map((e) => e.contactId ?? ""));
  if (contacts.size > 1 || (target && !contacts.has(target.contactId ?? ""))) {
    return issue("time_entries_contacts", TIME_INVOICE_MESSAGES.contacts);
  }
  const currencies = new Set(entries.map((e) => e.currency));
  if (currencies.size > 1 || (target && !currencies.has(target.currency))) {
    return issue("time_entries_currency", TIME_INVOICE_MESSAGES.currency);
  }
  const noRate = entries.filter((e) => !(e.hourlyRateMicros > 0)).length;
  if (noRate > 0) return issue("time_entries_rate_missing", rateMissingMessage(noRate), { count: noRate });
  return null;
}

const minDate = (ds: readonly CalendarDate[]) => ds.reduce((a, b) => (b < a ? b : a));
const maxDate = (ds: readonly CalendarDate[]) => ds.reduce((a, b) => (b > a ? b : a));

function groupKey(e: BillableEntry, g: TimeGrouping): string {
  const rate = `${e.productId ?? "-"}|${e.hourlyRateMicros}|${e.vatRateKey}`;
  switch (g) {
    case "per_entry":
      return e.id;
    case "per_day":
      return `${e.date}|${rate}`;
    case "per_product_rate":
      return rate;
    case "summary":
      return `${e.hourlyRateMicros}|${e.vatRateKey}`;
  }
}

const uniqueTexts = (es: readonly BillableEntry[]) => [...new Set(es.map((e) => e.description.trim()))].join("\n");

function lineTexts(es: readonly BillableEntry[], g: TimeGrouping, from: CalendarDate, to: CalendarDate) {
  const first = es[0] as BillableEntry;
  switch (g) {
    case "per_entry":
      return { name: `${formatGermanDate(first.date)}: ${first.description.trim()}` };
    case "per_day":
      return { name: `Leistungen am ${formatGermanDate(first.date)}`, description: uniqueTexts(es) };
    case "per_product_rate":
      return {
        name: first.productName?.trim() || `Arbeitszeit ${periodLabel(from, to)}`,
        description: uniqueTexts(es),
      };
    case "summary":
      return { name: `Leistungen lt. Leistungsnachweis ${periodLabel(from, to)}` };
  }
}

/** Quantity and price for `minutes` at `hourlyRateMicros` in the chosen unit (PRJ-011). */
export function timeQuantity(minutes: number, hourlyRateMicros: number, unit: TimeUnit = "HUR") {
  if (unit === "MIN") {
    return { quantityMilli: minutes * 1000, unitPriceMicros: Number(roundHalfAway(BigInt(hourlyRateMicros), 60n)) };
  }
  return { quantityMilli: Number(roundHalfAway(BigInt(minutes) * 1000n, 60n)), unitPriceMicros: hourlyRateMicros };
}

/** minutes × rate / 60 in cents (micros are 1/10,000 €, so cents = micros / 100). */
export const exactTimeNetCents = (minutes: number, hourlyRateMicros: number): number =>
  Number(roundHalfAway(BigInt(minutes) * BigInt(hourlyRateMicros), 6000n));

/** E-PRJ-17 text: „10 Minuten ergeben 0,167 Stunden (gerundet). Abweichung: 0,03 €. Einheit „Minute“ verwenden?“ */
export function inexactHoursNotice(minutes: number, quantityMilli: number, diffCents: number): string {
  return `${minutes} Minuten ergeben ${formatMilli(quantityMilli)} Stunden (gerundet). Abweichung: ${formatCents(Math.abs(diffCents))} €. Einheit „Minute“ verwenden?`;
}

/** Splits entries (date-sorted) into runs with the same VAT rule row (EC-024, E-PRJ-15). */
function splitByVatRow(
  es: readonly BillableEntry[],
  vatRowOf: TimeInvoiceOptions["vatRowOf"],
): { parts: BillableEntry[][]; changes: CalendarDate[] } {
  const sorted = [...es].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));
  if (!vatRowOf) return { parts: [sorted], changes: [] };
  const parts: BillableEntry[][] = [];
  const changes: CalendarDate[] = [];
  let current: BillableEntry[] = [];
  let row: string | null | undefined;
  for (const e of sorted) {
    const r = vatRowOf(e.vatRateKey, e.date);
    if (current.length > 0 && (r?.rowId ?? null) !== row) {
      parts.push(current);
      changes.push(r?.validFrom ?? e.date);
      current = [];
    }
    row = r?.rowId ?? null;
    current.push(e);
  }
  if (current.length > 0) parts.push(current);
  return { parts, changes };
}

/** Builds the lines, supply period and notices for the selected entries (no validation — see `checkSelection`). */
export function planTimeInvoice(
  entries: readonly BillableEntry[],
  o: TimeInvoiceOptions,
): Result<TimeInvoicePlan, TimeInvoiceIssue> {
  const problem = checkSelection(entries);
  if (problem) return err(problem);
  const rule = o.rounding ?? NO_ROUNDING;
  const perGroup = o.perGroup === true;
  const unit = o.unit ?? "HUR";
  const groups = new Map<string, BillableEntry[]>();
  for (const e of [...entries].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))) {
    const k = groupKey(e, o.grouping);
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  const lines: TimeInvoiceLine[] = [];
  const roundedByEntry: Record<string, number> = {};
  const notices: string[] = [];
  const changeDates = new Set<CalendarDate>();
  for (const group of groups.values()) {
    const { parts, changes } = splitByVatRow(group, o.vatRowOf);
    for (const c of changes) changeDates.add(c);
    for (const part of parts) {
      const first = part[0] as BillableEntry;
      const raw = part.reduce((s, e) => s + e.durationMinutes, 0);
      let rounded: number;
      if (perGroup) rounded = roundMinutes(raw, rule);
      else {
        rounded = 0;
        for (const e of part) {
          const r = roundMinutes(e.durationMinutes, rule);
          roundedByEntry[e.id] = r;
          rounded += r;
        }
      }
      const dates = part.map((e) => e.date);
      const from = minDate(dates);
      const to = maxDate(dates);
      const { quantityMilli, unitPriceMicros } = timeQuantity(rounded, first.hourlyRateMicros, unit);
      const netCents = lineAmountCents(quantityMilli, unitPriceMicros);
      const exactNetCents = exactTimeNetCents(rounded, first.hourlyRateMicros);
      if (unit === "HUR" && exactNetCents !== netCents) {
        notices.push(inexactHoursNotice(rounded, quantityMilli, netCents - exactNetCents));
      }
      const texts = lineTexts(part, o.grouping, from, to);
      lines.push({
        ...texts,
        ...(first.productId && part.every((e) => e.productId === first.productId)
          ? { productId: first.productId }
          : {}),
        quantityMilli,
        unitCode: unit,
        unitPriceMicros,
        vatRateKey: first.vatRateKey,
        linePeriod: { from, to },
        timeEntryIds: part.map((e) => e.id),
        rawMinutes: raw,
        roundedMinutes: rounded,
        netCents,
        exactNetCents,
      });
    }
  }
  for (const d of [...changeDates].sort()) {
    notices.unshift(
      `Wegen Steuersatzänderung am ${formatGermanDate(d)} wurden die Zeiten auf zwei Positionen aufgeteilt.`,
    );
  }
  const all = entries.map((e) => e.date);
  const from = minDate(all);
  const to = maxDate(all);
  const first = entries[0] as BillableEntry;
  return ok({
    lines,
    ...(first.contactId ? { contactId: first.contactId } : {}),
    currency: first.currency,
    supplyDate: from === to ? { kind: "date", date: from } : { kind: "period", from, to },
    roundedByEntry,
    rounding: { ...rule, perGroup },
    notices,
  });
}

// ── supply period (PRJ-013, UST-08, E-PRJ-18) ──────────────────────────────────────────────────────────────

type SupplyLike =
  | { readonly kind: "date"; readonly date: string }
  | { readonly kind: "period"; readonly from: string; readonly to: string }
  | { readonly kind: "month"; readonly month: string };

function boundsOf(s: SupplyLike): { from: string; to: string } {
  if (s.kind === "date") return { from: s.date, to: s.date };
  if (s.kind === "period") return { from: s.from, to: s.to };
  const [y, m] = s.month.split("-").map(Number) as [number, number];
  const last = daysInMonth(y, m);
  return { from: `${s.month}-01`, to: `${s.month}-${String(last).padStart(2, "0")}` };
}

/** The owner may widen the supply period of an invoice from entries, never narrow it below the entries' dates. */
export function checkSupplyCoversEntries(
  supply: SupplyLike | undefined,
  entryDates: readonly CalendarDate[],
): Issue<"supply_period_too_narrow"> | null {
  if (entryDates.length === 0) return null;
  const from = minDate(entryDates);
  const to = maxDate(entryDates);
  const b = supply ? boundsOf(supply) : null;
  if (b && b.from <= from && b.to >= to) return null;
  return issue(
    "supply_period_too_narrow",
    `Der Leistungszeitraum muss alle abgerechneten Zeiten umfassen (${formatGermanDate(from)}–${formatGermanDate(to)}).`,
    { from, to },
  );
}

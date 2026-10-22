/**
 * Time reports (F11 PRJ-017) and the week view of `/zeiten` (F11 §6). Pure: the caller loads the entries.
 *
 * - Hours per project / customer / product / month / week in a period, billable vs non-billable, the unbilled value
 *   (open billable entries, minutes × rate) and the billed value.
 * - Utilisation per week: billable share of the tracked time (basis points). There is no capacity setting (single
 *   owner, no attendance tracking — F11 §1 out of scope), so the tracked time is the reference.
 * - Week view: Monday–Sunday columns, one row per project (or customer), totals per day and per row.
 */
import type { CsvColumn } from "../csv/export";
import { type CalendarDate, formatGermanDate } from "../time/calendar-date";
import { weekDays, weekLabel, weekStart } from "../time/week";
import { exactTimeNetCents } from "./invoicing";
import type { TimeEntryStatus } from "./time-entries";

export interface ReportEntry {
  readonly date: CalendarDate;
  readonly durationMinutes: number;
  readonly billable: boolean;
  readonly status: TimeEntryStatus;
  readonly hourlyRateMicros: number;
  readonly projectId?: string | undefined;
  readonly projectName?: string | null | undefined;
  readonly contactId?: string | undefined;
  readonly contactName?: string | null | undefined;
  readonly productId?: string | undefined;
  readonly productName?: string | null | undefined;
}

export const TIME_REPORT_GROUPINGS = ["project", "customer", "product", "month", "week"] as const;
export type TimeReportGroupBy = (typeof TIME_REPORT_GROUPINGS)[number];

export interface TimeReportFigures {
  readonly minutes: number;
  readonly billableMinutes: number;
  readonly nonBillableMinutes: number;
  /** Open billable entries (not yet in a draft or invoice). */
  readonly unbilledMinutes: number;
  readonly unbilledValueCents: number;
  /** Billable entries in a draft or invoiced. */
  readonly billedValueCents: number;
  readonly entries: number;
}

export interface TimeReportRow extends TimeReportFigures {
  readonly key: string;
  readonly label: string;
}

export interface TimeReportWeek {
  readonly weekStart: CalendarDate;
  readonly label: string;
  readonly minutes: number;
  readonly billableMinutes: number;
  /** billable ÷ tracked minutes in basis points (floored); null without tracked time. */
  readonly utilisationBp: number | null;
}

export interface TimeReport {
  readonly groupBy: TimeReportGroupBy;
  readonly from: CalendarDate;
  readonly to: CalendarDate;
  readonly rows: readonly TimeReportRow[];
  readonly totals: TimeReportFigures;
  readonly weeks: readonly TimeReportWeek[];
}

const EMPTY: TimeReportFigures = {
  minutes: 0,
  billableMinutes: 0,
  nonBillableMinutes: 0,
  unbilledMinutes: 0,
  unbilledValueCents: 0,
  billedValueCents: 0,
  entries: 0,
};

function addEntry(f: TimeReportFigures, e: ReportEntry): TimeReportFigures {
  const value = e.billable ? exactTimeNetCents(e.durationMinutes, e.hourlyRateMicros) : 0;
  const open = e.billable && e.status === "open";
  return {
    minutes: f.minutes + e.durationMinutes,
    billableMinutes: f.billableMinutes + (e.billable ? e.durationMinutes : 0),
    nonBillableMinutes: f.nonBillableMinutes + (e.billable ? 0 : e.durationMinutes),
    unbilledMinutes: f.unbilledMinutes + (open ? e.durationMinutes : 0),
    unbilledValueCents: f.unbilledValueCents + (open ? value : 0),
    billedValueCents: f.billedValueCents + (e.billable && !open ? value : 0),
    entries: f.entries + 1,
  };
}

function keyOf(e: ReportEntry, g: TimeReportGroupBy): { key: string; label: string } {
  switch (g) {
    case "project":
      return e.projectId
        ? { key: e.projectId, label: e.projectName ?? e.projectId }
        : { key: "-", label: "ohne Projekt" };
    case "customer":
      return e.contactId
        ? { key: e.contactId, label: e.contactName ?? e.contactId }
        : { key: "-", label: "ohne Kunde" };
    case "product":
      return e.productId
        ? { key: e.productId, label: e.productName ?? e.productId }
        : { key: "-", label: "ohne Leistung" };
    case "month":
      return { key: e.date.slice(0, 7), label: `${e.date.slice(5, 7)}/${e.date.slice(0, 4)}` };
    case "week": {
      const monday = weekStart(e.date);
      return { key: monday, label: weekLabel(e.date) };
    }
  }
}

const utilisation = (billable: number, minutes: number) =>
  minutes > 0 ? Math.floor((billable * 10_000) / minutes) : null;

export function timeReport(
  entries: readonly ReportEntry[],
  o: { groupBy: TimeReportGroupBy; from: CalendarDate; to: CalendarDate },
): TimeReport {
  const inRange = entries.filter((e) => e.date >= o.from && e.date <= o.to);
  const groups = new Map<string, TimeReportRow>();
  const weeks = new Map<CalendarDate, { minutes: number; billableMinutes: number; label: string }>();
  let totals = EMPTY;
  for (const e of inRange) {
    const k = keyOf(e, o.groupBy);
    const prev = groups.get(k.key) ?? { ...EMPTY, ...k };
    groups.set(k.key, { ...addEntry(prev, e), key: k.key, label: prev.label });
    totals = addEntry(totals, e);
    const monday = weekStart(e.date);
    const w = weeks.get(monday) ?? { minutes: 0, billableMinutes: 0, label: weekLabel(e.date) };
    weeks.set(monday, {
      label: w.label,
      minutes: w.minutes + e.durationMinutes,
      billableMinutes: w.billableMinutes + (e.billable ? e.durationMinutes : 0),
    });
  }
  const chronological = o.groupBy === "month" || o.groupBy === "week";
  const rows = [...groups.values()].sort((a, b) =>
    chronological ? a.key.localeCompare(b.key) : b.minutes - a.minutes || a.label.localeCompare(b.label, "de"),
  );
  return {
    groupBy: o.groupBy,
    from: o.from,
    to: o.to,
    rows,
    totals,
    weeks: [...weeks.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([monday, w]) => ({
        weekStart: monday,
        label: w.label,
        minutes: w.minutes,
        billableMinutes: w.billableMinutes,
        utilisationBp: utilisation(w.billableMinutes, w.minutes),
      })),
  };
}

/** F09 EXP-021 columns of the time report CSV (Excel and technical variant; minutes as integers). */
export const TIME_REPORT_CSV_COLUMNS: readonly CsvColumn<TimeReportRow>[] = [
  { label: "Gruppe", key: "group", kind: "text", value: (r) => r.label },
  { label: "Gruppen-ID", key: "group_id", kind: "id", value: (r) => r.key },
  { label: "Minuten gesamt", key: "minutes", kind: "int", value: (r) => r.minutes },
  { label: "Minuten abrechenbar", key: "billable_minutes", kind: "int", value: (r) => r.billableMinutes },
  { label: "Minuten nicht abrechenbar", key: "non_billable_minutes", kind: "int", value: (r) => r.nonBillableMinutes },
  { label: "Minuten nicht abgerechnet", key: "unbilled_minutes", kind: "int", value: (r) => r.unbilledMinutes },
  {
    label: "Wert nicht abgerechnet (EUR)",
    key: "unbilled_value_cents",
    kind: "cents",
    value: (r) => r.unbilledValueCents,
  },
  { label: "Wert abgerechnet (EUR)", key: "billed_value_cents", kind: "cents", value: (r) => r.billedValueCents },
  { label: "Einträge", key: "entries", kind: "int", value: (r) => r.entries },
];

// ── week view (F11 §6 `/zeiten`) ────────────────────────────────────────────────────────────────────────────

export interface WeekGridRow {
  readonly key: string;
  readonly label: string;
  /** Minutes Monday … Sunday. */
  readonly minutesByDay: readonly number[];
  readonly total: number;
}

export interface WeekGrid {
  readonly days: readonly CalendarDate[];
  readonly label: string;
  readonly rows: readonly WeekGridRow[];
  readonly dayTotals: readonly number[];
  readonly total: number;
}

/** Monday–Sunday grid of the week containing `date`: one row per project (else customer), totals per day/row. */
export function weekGrid(entries: readonly ReportEntry[], date: CalendarDate): WeekGrid {
  const days = weekDays(date);
  const index = new Map(days.map((d, i) => [d as string, i]));
  const rows = new Map<string, { label: string; minutesByDay: number[] }>();
  const dayTotals = days.map(() => 0);
  for (const e of entries) {
    const i = index.get(e.date);
    if (i === undefined) continue;
    const k = e.projectId
      ? { key: `p:${e.projectId}`, label: e.projectName ?? e.projectId }
      : e.contactId
        ? { key: `c:${e.contactId}`, label: e.contactName ?? e.contactId }
        : { key: "-", label: "ohne Projekt" };
    const row = rows.get(k.key) ?? { label: k.label, minutesByDay: days.map(() => 0) };
    row.minutesByDay[i] = (row.minutesByDay[i] ?? 0) + e.durationMinutes;
    rows.set(k.key, row);
    dayTotals[i] = (dayTotals[i] ?? 0) + e.durationMinutes;
  }
  const list = [...rows.entries()]
    .map(([key, r]) => ({
      key,
      label: r.label,
      minutesByDay: r.minutesByDay,
      total: r.minutesByDay.reduce((s, m) => s + m, 0),
    }))
    .sort((a, b) => a.label.localeCompare(b.label, "de"));
  const first = days[0] as CalendarDate;
  const last = days[6] as CalendarDate;
  return {
    days,
    label: `${weekLabel(first)} · ${formatGermanDate(first)}–${formatGermanDate(last)}`,
    rows: list,
    dayTotals,
    total: dayTotals.reduce((s, m) => s + m, 0),
  };
}

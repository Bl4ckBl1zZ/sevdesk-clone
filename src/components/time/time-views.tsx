"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { CalendarRangeIcon, ChevronLeftIcon, ChevronRightIcon, PlusIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { type ReactNode, useId, useState } from "react";
import { formatPercentBp, selectClass, todayBerlin, useCan, useUrlState } from "@/components/catalog/shared";
import { downloadText, ExportMenu } from "@/components/exports/export-menu";
import { EmptyState } from "@/components/layout/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCsv } from "@/domain/csv/export";
import { formatEuro } from "@/domain/money/format";
import { formatMinutes } from "@/domain/projects/time-entries";
import {
  TIME_REPORT_CSV_COLUMNS,
  TIME_REPORT_GROUPINGS,
  type TimeReportGroupBy,
  weekGrid,
} from "@/domain/projects/time-report";
import { addDays, type CalendarDate, formatGermanDate, isCalendarDate } from "@/domain/time/calendar-date";
import { weekStart } from "@/domain/time/week";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { TimeEntryDialog } from "./entry-dialog";

const WEEKDAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"] as const;

const dayLabel = (d: CalendarDate, i: number) => `${WEEKDAYS[i]} ${formatGermanDate(d).slice(0, 6)}`;

/**
 * `/zeiten` week view (F11 §6): Monday–Sunday columns, one row per project (else customer), totals per day and per
 * row; previous/next week in the URL (`?view=week&week=YYYY-MM-DD`). Narrow containers list the days instead.
 */
export function WeekView({ projectId }: { projectId?: string }) {
  const t = useTranslations("time.week");
  const url = useUrlState();
  const canWrite = useCan("time.write");
  const [adding, setAdding] = useState(false);
  const raw = url.get("week");
  const today = todayBerlin() as CalendarDate;
  const monday = weekStart(isCalendarDate(raw) ? raw : today);
  const sunday = addDays(monday, 6);
  const rows = useAuthedQuery(api.timeEntries.list, {
    from: monday,
    to: sunday,
    ...(projectId ? { projectId: projectId as Id<"projects"> } : {}),
  });
  const grid = weekGrid(
    (rows ?? []).map((r) => ({
      date: r.date as CalendarDate,
      durationMinutes: r.durationMinutes,
      billable: r.billable,
      status: r.status,
      hourlyRateMicros: r.hourlyRateMicros,
      ...(r.projectId ? { projectId: r.projectId, projectName: r.projectName } : {}),
      ...(r.contactId ? { contactId: r.contactId, contactName: r.contactName } : {}),
    })),
    monday,
  );
  const go = (d: CalendarDate | "") => url.set({ week: d });
  const cell = (m: number) => (m > 0 ? formatMinutes(m) : "—");

  return (
    <section aria-label={t("label")} className="flex flex-col gap-3" data-testid="week-view">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="icon" className="size-11 md:size-9" onClick={() => go(addDays(monday, -7))}>
          <ChevronLeftIcon aria-hidden="true" />
          <span className="sr-only">{t("previous")}</span>
        </Button>
        <h2 className="min-w-0 font-semibold text-base tabular-nums" data-testid="week-label">
          {grid.label}
        </h2>
        <Button variant="outline" size="icon" className="size-11 md:size-9" onClick={() => go(addDays(monday, 7))}>
          <ChevronRightIcon aria-hidden="true" />
          <span className="sr-only">{t("next")}</span>
        </Button>
        {monday !== weekStart(today) && (
          <Button variant="ghost" className="h-11 md:h-9" onClick={() => go("")}>
            {t("current")}
          </Button>
        )}
        {canWrite && (
          <Button className="h-11 md:ml-auto md:h-9" onClick={() => setAdding(true)}>
            <PlusIcon aria-hidden="true" />
            {t("add")}
          </Button>
        )}
      </div>
      {rows === undefined ? (
        <div className="h-48" aria-busy="true" />
      ) : grid.rows.length === 0 ? (
        <EmptyState icon={CalendarRangeIcon} title={t("empty")} />
      ) : (
        <>
          <div className="hidden overflow-x-auto @3xl/main:block">
            <Table data-testid="week-table">
              <TableHeader>
                <TableRow>
                  <TableHead>{t("project")}</TableHead>
                  {grid.days.map((d, i) => (
                    <TableHead key={d} className="text-right" aria-current={d === today ? "date" : undefined}>
                      {dayLabel(d, i)}
                    </TableHead>
                  ))}
                  <TableHead className="text-right">{t("total")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {grid.rows.map((r) => (
                  <TableRow key={r.key}>
                    <TableCell className="max-w-56 truncate">{r.label}</TableCell>
                    {r.minutesByDay.map((m, i) => (
                      <TableCell
                        key={grid.days[i]}
                        className={m > 0 ? "text-right tabular-nums" : "text-right text-muted-foreground"}
                      >
                        {cell(m)}
                      </TableCell>
                    ))}
                    <TableCell className="text-right font-medium tabular-nums">{formatMinutes(r.total)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell>{t("total")}</TableCell>
                  {grid.dayTotals.map((m, i) => (
                    <TableCell key={grid.days[i]} className="text-right tabular-nums">
                      {cell(m)}
                    </TableCell>
                  ))}
                  <TableCell className="text-right font-semibold tabular-nums" data-testid="week-total">
                    {formatMinutes(grid.total)}
                  </TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </div>
          <ol className="flex flex-col gap-2 @3xl/main:hidden" data-testid="week-days">
            {grid.days.map((d, i) => {
              const items = grid.rows.filter((r) => (r.minutesByDay[i] ?? 0) > 0);
              return (
                <li key={d} className="rounded-lg border p-3 text-sm">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-medium">{dayLabel(d, i)}</span>
                    <span className="tabular-nums">{cell(grid.dayTotals[i] ?? 0)}</span>
                  </div>
                  {items.length > 0 && (
                    <ul className="mt-1 flex flex-col gap-0.5 text-muted-foreground">
                      {items.map((r) => (
                        <li key={r.key} className="flex justify-between gap-2">
                          <span className="min-w-0 truncate">{r.label}</span>
                          <span className="tabular-nums">{formatMinutes(r.minutesByDay[i] ?? 0)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
            <li className="flex justify-between rounded-lg bg-muted p-3 font-medium text-sm">
              <span>{t("total")}</span>
              <span className="tabular-nums">{formatMinutes(grid.total)}</span>
            </li>
          </ol>
        </>
      )}
      {adding && <TimeEntryDialog projectId={projectId} onClose={() => setAdding(false)} />}
    </section>
  );
}

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-muted-foreground text-xs">
        {label}
      </label>
      {children}
    </div>
  );
}

/**
 * Time reports (F11 PRJ-017): hours per project/customer/product/month/week in a period, billable vs non-billable,
 * unbilled value, utilisation per week; CSV export (F09 EXP-021, both variants).
 */
export function TimeReportView() {
  const t = useTranslations("time.report");
  const url = useUrlState();
  const today = todayBerlin() as CalendarDate;
  const from = isCalendarDate(url.get("from"))
    ? (url.get("from") as CalendarDate)
    : (`${today.slice(0, 7)}-01` as CalendarDate);
  const to = isCalendarDate(url.get("to")) ? (url.get("to") as CalendarDate) : today;
  const groupBy = (TIME_REPORT_GROUPINGS as readonly string[]).includes(url.get("group"))
    ? (url.get("group") as TimeReportGroupBy)
    : "project";
  const valid = from <= to;
  const report = useAuthedQuery(api.timeEntries.report, { from, to, groupBy }, valid);
  const ids = { from: useId(), to: useId(), group: useId() };

  return (
    <section aria-label={t("label")} className="flex flex-col gap-4" data-testid="time-report">
      <div className="flex flex-wrap items-end gap-2">
        <Field id={ids.from} label={t("from")}>
          <Input
            id={ids.from}
            type="date"
            className="h-11 w-auto md:h-9"
            value={from}
            onChange={(e) => url.set({ from: e.target.value })}
          />
        </Field>
        <Field id={ids.to} label={t("to")}>
          <Input
            id={ids.to}
            type="date"
            className="h-11 w-auto md:h-9"
            value={to}
            onChange={(e) => url.set({ to: e.target.value })}
          />
        </Field>
        <Field id={ids.group} label={t("groupBy")}>
          <select
            id={ids.group}
            className={selectClass}
            value={groupBy}
            onChange={(e) => url.set({ group: e.target.value === "project" ? "" : e.target.value })}
          >
            {TIME_REPORT_GROUPINGS.map((g) => (
              <option key={g} value={g}>
                {t(`groups.${g}`)}
              </option>
            ))}
          </select>
        </Field>
        {report && report.rows.length > 0 && (
          <div className="md:ml-auto">
            <ExportMenu
              local={(variant) =>
                downloadText(
                  `zeiten-auswertung_${from}_${to}.csv`,
                  formatCsv(TIME_REPORT_CSV_COLUMNS, report.rows, variant),
                )
              }
            />
          </div>
        )}
      </div>
      {!valid ? (
        <p role="alert" className="text-danger text-sm">
          {t("invalidPeriod")}
        </p>
      ) : report === undefined ? (
        <div className="h-48" aria-busy="true" />
      ) : report.rows.length === 0 ? (
        <EmptyState icon={CalendarRangeIcon} title={t("empty")} />
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-3 text-sm @3xl/main:grid-cols-4" data-testid="time-report-totals">
            {(
              [
                ["total", formatMinutes(report.totals.minutes)],
                ["billable", formatMinutes(report.totals.billableMinutes)],
                ["nonBillable", formatMinutes(report.totals.nonBillableMinutes)],
                ["unbilledValue", formatEuro(report.totals.unbilledValueCents)],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className="rounded-lg border p-3">
                <dt className="text-muted-foreground">{t(`columns.${k}`)}</dt>
                <dd className="font-semibold text-lg tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>
          <div className="overflow-x-auto">
            <Table data-testid="time-report-table">
              <TableHeader>
                <TableRow>
                  <TableHead>{t(`groups.${groupBy}`)}</TableHead>
                  <TableHead className="text-right">{t("columns.total")}</TableHead>
                  <TableHead className="text-right">{t("columns.billable")}</TableHead>
                  <TableHead className="text-right">{t("columns.nonBillable")}</TableHead>
                  <TableHead className="text-right">{t("columns.unbilledValue")}</TableHead>
                  <TableHead className="text-right">{t("columns.billedValue")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.rows.map((r) => (
                  <TableRow key={r.key}>
                    <TableCell className="max-w-56 truncate">{r.label}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMinutes(r.minutes)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMinutes(r.billableMinutes)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMinutes(r.nonBillableMinutes)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatEuro(r.unbilledValueCents)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatEuro(r.billedValueCents)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="flex flex-col gap-2">
            <h2 className="font-semibold text-base">{t("utilisation")}</h2>
            <p className="text-muted-foreground text-sm">{t("utilisationHint")}</p>
            <div className="overflow-x-auto">
              <Table data-testid="time-report-weeks">
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("groups.week")}</TableHead>
                    <TableHead className="text-right">{t("columns.total")}</TableHead>
                    <TableHead className="text-right">{t("columns.billable")}</TableHead>
                    <TableHead className="text-right">{t("columns.utilisation")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.weeks.map((w) => (
                    <TableRow key={w.weekStart}>
                      <TableCell>{w.label}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatMinutes(w.minutes)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatMinutes(w.billableMinutes)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatPercentBp(w.utilisationBp)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

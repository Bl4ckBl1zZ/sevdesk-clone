"use client";

import { useTranslations } from "next-intl";
import { formatDecimal, formatEuro } from "@/domain/money";
import type { MonthResult } from "@/domain/reports/dashboard";

/**
 * „Gewinn vor Steuern“ 12-month grouped columns (04 §4.7, DASH-003): plain CSS, no chart library (recharts' responsive
 * container does not measure in jsdom and the chart is two series only). Income blue, expenses red (palette validated
 * for CVD separation in light and dark mode); negative months (a Storno exceeding the month) draw no bar — the value
 * is in the table. Screen readers get the visually hidden table instead of the bars.
 */

export const INCOME_BAR = "bg-blue-600 dark:bg-blue-500";
export const EXPENSE_BAR = "bg-red-600 dark:bg-red-500";

/** Clean y-axis ticks in cents (multiples of 1 €): 0 … ≥ max in four steps of 1/2/5 × 10ⁿ. */
export function niceTicks(maxCents: number, steps = 4): number[] {
  const max = Math.max(maxCents, 10_000);
  const raw = max / steps;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(
    100,
    Math.round([1, 2, 5, 10].map((f) => f * magnitude).find((s) => s >= raw) ?? 10 * magnitude),
  );
  const count = Math.ceil(max / step);
  return Array.from({ length: count + 1 }, (_, i) => i * step);
}

const euros = (cents: number) => `${formatDecimal((cents - (cents % 100)) / 100, 0)} €`;
const pct = (value: number, top: number) => `${Math.round((Math.max(0, value) * 1000) / top) / 10}%`;

export function ResultChart({ months }: { months: readonly MonthResult[] }) {
  const t = useTranslations("pages.start.result");
  const ticks = niceTicks(Math.max(0, ...months.flatMap((m) => [m.incomeCents, m.expenseCents])));
  const top = ticks.at(-1) ?? 1;
  return (
    <div className="flex flex-col gap-2">
      <div role="img" aria-label={t("chartLabel")} className="grid grid-cols-[auto_1fr] gap-x-2">
        <div className="relative h-48 w-14 text-muted-foreground text-xs tabular-nums">
          {ticks.map((tick) => (
            <span
              key={tick}
              className="absolute right-0 translate-y-1/2 whitespace-nowrap"
              style={{ bottom: pct(tick, top) }}
            >
              {euros(tick)}
            </span>
          ))}
        </div>
        <div className="relative h-48">
          {ticks.map((tick) => (
            <div key={tick} className="absolute inset-x-0 border-border border-t" style={{ bottom: pct(tick, top) }} />
          ))}
          <div className="absolute inset-0 grid grid-cols-12">
            {months.map((m) => (
              <div key={m.period} className="group relative flex h-full items-end justify-center gap-0.5">
                <div
                  className={`w-2 rounded-t-[4px] @xl/main:w-3 ${INCOME_BAR}`}
                  style={{ height: pct(m.incomeCents, top) }}
                />
                <div
                  className={`w-2 rounded-t-[4px] @xl/main:w-3 ${EXPENSE_BAR}`}
                  style={{ height: pct(m.expenseCents, top) }}
                />
                <div className="pointer-events-none absolute bottom-full left-1/2 z-10 hidden -translate-x-1/2 whitespace-nowrap rounded-md border bg-popover px-2 py-1 text-popover-foreground text-xs shadow-sm group-hover:block">
                  <p className="font-medium">{m.label}</p>
                  <p>
                    {t("income")}: {formatEuro(m.incomeCents)}
                  </p>
                  <p>
                    {t("expense")}: {formatEuro(m.expenseCents)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div />
        <div className="mt-1 grid grid-cols-12 text-center text-[11px] text-muted-foreground leading-tight">
          {months.map((m) => {
            const [month, year] = m.label.split(" ");
            return (
              <span key={m.period}>
                {month}
                <span className="hidden @xl/main:inline"> {year}</span>
              </span>
            );
          })}
        </div>
      </div>
      <table className="sr-only">
        <caption>{t("tableCaption")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("month")}</th>
            <th scope="col">{t("income")}</th>
            <th scope="col">{t("expense")}</th>
            <th scope="col">{t("profit")}</th>
          </tr>
        </thead>
        <tbody>
          {months.map((m) => (
            <tr key={m.period}>
              <th scope="row">{m.label}</th>
              <td>{formatEuro(m.incomeCents)}</td>
              <td>{formatEuro(m.expenseCents)}</td>
              <td>{formatEuro(m.profitCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

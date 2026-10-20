/**
 * Dashboard KPI period selector (F08 RPT-002): month / quarter / year to date of `today`, or a custom range. Pure.
 */
import { isCalendarDate } from "../time/calendar-date";

export const KPI_PERIODS = ["month", "quarter", "year", "custom"] as const;
export type KpiPeriod = (typeof KPI_PERIODS)[number];

export function kpiRange(
  period: KpiPeriod,
  today: string,
  from?: string,
  to?: string,
): { from: string; to: string } | null {
  const y = today.slice(0, 4);
  const m = Number(today.slice(5, 7));
  if (period === "month") return { from: `${today.slice(0, 7)}-01`, to: today };
  if (period === "quarter") {
    const q = Math.ceil(m / 3);
    return { from: `${y}-${String((q - 1) * 3 + 1).padStart(2, "0")}-01`, to: today };
  }
  if (period === "year") return { from: `${y}-01-01`, to: today };
  if (!from || !to || !isCalendarDate(from) || !isCalendarDate(to) || from > to) return null;
  return { from, to };
}

import { resolveRole } from "../../src/domain/accounting/resolve";
import { type KpiPeriod, kpiRange } from "../../src/domain/reports/kpis";
import { chartAccounts } from "../../src/domain/rules/accounting";
import { monthsOfFilingPeriod } from "../../src/domain/tax/ustva";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import { calendarDate } from "../../src/domain/time/calendar-date";
import { appError } from "../lib/errors";
import { getCompanyProfile } from "./companyProfile";
import { forecastView } from "./forecast";
import { resolveContextAt } from "./journal";
import { ledgerAccountsOf } from "./ledgerAccounts";
import { reportLines } from "./reports";
import { taxReserveView, vatAccountSet } from "./taxReserve";
import type { ReadCtx } from "./types";
import { kuOn } from "./vouchers";

/**
 * Dashboard KPIs (F08 RPT-002) for a period (month / quarter / year / custom): revenue and expenses (net, journal by
 * date), result, open payables, cash balance, USt-Zahllast of the current filing period, AfA year to date, the tax
 * reserve „jetzt“ and the 90-day liquidity sparkline (weekly, „erwartet“). Read only.
 */

const OPEN_VOUCHER = new Set(["open", "partially_paid", "scheduled"]);

export async function kpiView(ctx: ReadCtx, now: number, a: { period: KpiPeriod; from?: string; to?: string }) {
  const today = berlinCalendarDate(now);
  const range = kpiRange(a.period, today, a.from, a.to);
  if (!range) throw appError("invalid_input", "Ungültiger Zeitraum.");
  const profile = await getCompanyProfile(ctx);
  if (!profile) throw appError("setup_incomplete");
  const rctx = await resolveContextAt(ctx, calendarDate(range.to));
  const seed = chartAccounts(rctx.chart, calendarDate(range.to));
  const types = new Map<string, string>((seed.ok ? seed.value : []).map((x) => [x.number, x.type]));
  for (const c of (await ledgerAccountsOf(ctx, rctx.chart)).custom) types.set(c.number, c.type);
  const lines = await reportLines(ctx, today > range.to ? today : range.to);

  let revenue = 0;
  let expenses = 0;
  let afaYtd = 0;
  const yearStart = `${today.slice(0, 4)}-01-01`;
  for (const l of lines) {
    const t = types.get(l.account);
    if (l.date >= range.from && l.date <= range.to) {
      if (t === "revenue") revenue += l.creditCents - l.debitCents;
      if (t === "expense") expenses += l.debitCents - l.creditCents;
    }
    if (l.sourceKind === "asset_depreciation" && t === "expense" && l.date >= yearStart && l.date <= today) {
      afaYtd += l.debitCents - l.creditCents;
    }
  }

  let payables = 0;
  for (const v of await ctx.db.query("vouchers").collect()) {
    if (v.direction === "expense" && OPEN_VOUCHER.has(v.status)) payables += v.openAmountCents ?? 0;
  }

  const cashRole = resolveRole("cash", rctx);
  const cashAccount = cashRole.ok ? cashRole.value.account : null;
  const cash = cashAccount
    ? lines
        .filter((l) => l.account === cashAccount && l.date <= today)
        .reduce((s, l) => s + l.debitCents - l.creditCents, 0)
    : null;

  // USt-Zahllast of the current filing period (Umsatzsteuer − Vorsteuer posted in its months)
  let ust: { period: string; cents: number } | null = null;
  if (!kuOn(profile, today)) {
    const year = Number(today.slice(0, 4));
    const row = profile.ustvaPeriod.find((p) => p.year === year);
    const kind = row?.period ?? "quarterly";
    const month = Number(today.slice(5, 7));
    const period =
      kind === "monthly" ? today.slice(0, 7) : kind === "quarterly" ? `${year}-Q${Math.ceil(month / 3)}` : String(year);
    const months = new Set(
      kind === "annual_only"
        ? Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`)
        : monthsOfFilingPeriod(period),
    );
    const vat = await vatAccountSet(ctx, profile, today, { withPrepayments: false });
    let cents = 0;
    for (const l of lines)
      if (vat.has(l.account) && months.has(l.date.slice(0, 7))) cents += l.creditCents - l.debitCents;
    ust = { period, cents };
  }

  const reserve = await taxReserveView(ctx, Number(today.slice(0, 4)), now).catch(() => null);
  const forecast = await forecastView(ctx, now, {});
  return {
    period: a.period,
    from: range.from,
    to: range.to,
    revenueCents: revenue,
    expensesCents: expenses,
    resultCents: revenue - expenses,
    openPayablesCents: payables,
    cashCents: cash,
    ust,
    afaYtdCents: afaYtd,
    taxReserve: reserve
      ? { reserveNowCents: reserve.reserveNowCents, monthlyCents: reserve.monthlyCents, disclaimer: reserve.disclaimer }
      : null,
    liquidity: {
      openingCents: forecast.openingCents,
      weeks: forecast.weeks.map((w) => ({ to: w.to, cents: w.expectedCents })),
    },
  };
}

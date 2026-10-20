"use client";

import { api } from "@convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import type { Route } from "next";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { euro } from "@/components/accounting/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { filingPeriodLabel } from "@/domain/tax/ustva";
import { useAuthedQuery } from "@/hooks/use-authed-query";

export type KpiData = FunctionReturnType<typeof api.reports.kpis>;
type Period = KpiData["period"];
const PERIODS: Period[] = ["month", "quarter", "year", "custom"];

const today = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });

/**
 * „Kennzahlen“ card of the Übersicht (F08 RPT-002): period selector (Monat / Quartal / Jahr / Zeitraum), revenue,
 * expenses, result, open payables, cash, USt-Zahllast of the current filing period, AfA YTD, tax reserve and the
 * 90-day liquidity sparkline. Self-loading, so the existing widgets stay untouched.
 */
export function KpiCard() {
  const t = useTranslations("pages.start.kpis");
  const [period, setPeriod] = useState<Period>("month");
  const [from, setFrom] = useState(`${today().slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today());
  const data = useAuthedQuery(api.reports.kpis, period === "custom" ? { period, from, to } : { period });
  const id = useId();
  return (
    <section aria-labelledby={id} className="min-w-0">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle>
            <h2 id={id} className="font-semibold text-base">
              {t("title")}
            </h2>
          </CardTitle>
          <fieldset className="flex flex-wrap gap-1" aria-label={t("period")}>
            {PERIODS.map((p) => (
              <label
                key={p}
                className="cursor-pointer rounded-md border px-2.5 py-1.5 text-sm has-checked:bg-primary has-checked:text-primary-foreground has-focus-visible:ring-3 has-focus-visible:ring-ring/50"
              >
                <input
                  type="radio"
                  name={`${id}-period`}
                  className="sr-only"
                  checked={period === p}
                  onChange={() => setPeriod(p)}
                />
                {t(`periods.${p}`)}
              </label>
            ))}
          </fieldset>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {period === "custom" && (
            <div className="flex flex-wrap gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${id}-from`}>{t("from")}</Label>
                <Input id={`${id}-from`} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${id}-to`}>{t("to")}</Label>
                <Input id={`${id}-to`} type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              </div>
            </div>
          )}
          {data === undefined ? <div className="h-40" aria-busy="true" /> : <KpiGrid data={data} />}
        </CardContent>
      </Card>
    </section>
  );
}

export function KpiGrid({ data }: { data: KpiData }) {
  const t = useTranslations("pages.start.kpis");
  const tiles: { key: string; label: string; cents: number; href?: Route; hint?: string }[] = [
    { key: "revenue", label: t("revenue"), cents: data.revenueCents, href: "/auswertungen?bericht=umsatz" as Route },
    { key: "expenses", label: t("expenses"), cents: data.expensesCents },
    { key: "result", label: t("result"), cents: data.resultCents, href: "/auswertungen?bericht=bwa" as Route },
    { key: "payables", label: t("payables"), cents: data.openPayablesCents, href: "/belege" as Route },
  ];
  if (data.cashCents !== null) tiles.push({ key: "cash", label: t("cash"), cents: data.cashCents, href: "/kasse" });
  if (data.ust) {
    tiles.push({
      key: "ust",
      label: t("ust", { period: filingPeriodLabel(data.ust.period) }),
      cents: data.ust.cents,
      href: "/steuern/ustva",
    });
  }
  tiles.push({ key: "afa", label: t("afa"), cents: data.afaYtdCents, href: "/buchhaltung/anlagen" });
  if (data.taxReserve) {
    tiles.push({
      key: "reserve",
      label: t("reserve"),
      cents: data.taxReserve.reserveNowCents,
      href: "/steuern/ruecklage",
      hint: data.taxReserve.disclaimer,
    });
  }
  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-2 gap-3 @3xl/main:grid-cols-4">
        {tiles.map((k) => (
          <div key={k.key} className="flex flex-col gap-1 rounded-lg bg-muted px-4 py-3">
            <dt className="text-muted-foreground text-sm">
              {k.href ? (
                <Link className="underline-offset-4 hover:underline" href={k.href}>
                  {k.label}
                </Link>
              ) : (
                k.label
              )}
            </dt>
            <dd className="font-semibold text-xl tabular-nums">{euro(k.cents)}</dd>
            {k.hint && <dd className="text-muted-foreground text-xs">{k.hint}</dd>}
          </div>
        ))}
      </dl>
      <Sparkline weeks={data.liquidity.weeks} />
    </div>
  );
}

function Sparkline({ weeks }: { weeks: KpiData["liquidity"]["weeks"] }) {
  const t = useTranslations("pages.start.kpis");
  if (weeks.length < 2) return null;
  const values = weeks.map((w) => w.cents);
  const lo = Math.min(0, ...values);
  const hi = Math.max(1, ...values);
  const pts = weeks
    .map(
      (w, i) =>
        `${((i * 200) / (weeks.length - 1)).toFixed(1)},${(38 - ((w.cents - lo) * 36) / (hi - lo || 1)).toFixed(1)}`,
    )
    .join(" ");
  const last = weeks.at(-1);
  return (
    <Link
      href="/auswertungen/liquiditaet"
      className="flex items-center gap-3 rounded-lg border p-3 text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <svg viewBox="0 0 200 40" className="h-10 w-40 shrink-0" aria-hidden="true">
        <polyline points={pts} fill="none" strokeWidth={2} className="stroke-blue-600 dark:stroke-blue-500" />
      </svg>
      <span>
        {t("liquidity")}
        {last && (
          <span className="block font-medium tabular-nums">{t("liquidityEnd", { amount: euro(last.cents) })}</span>
        )}
      </span>
    </Link>
  );
}

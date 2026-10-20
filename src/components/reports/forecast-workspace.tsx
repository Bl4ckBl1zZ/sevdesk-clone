"use client";

import { api } from "@convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import type { Route } from "next";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { dateDe, euro } from "@/components/accounting/format";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { SELECT } from "@/components/tax/ustva-workspace";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCents, formatDecimal, parseCents } from "@/domain/money";
import { useAuthedQuery } from "@/hooks/use-authed-query";

type View = FunctionReturnType<typeof api.reports.forecast>;
type Week = View["weeks"][number];
type Source = View["items"][number]["source"];
const SOURCES: Source[] = ["receivable", "recurring_invoice", "payable", "recurring_voucher", "tax", "planned"];

/**
 * /auswertungen/liquiditaet (F08 §6, RPT-012): 90-day forecast — weekly chart „erwartet“ vs „vorsichtig“ with the
 * threshold line, the first day below it, and the items by source. The threshold is a URL parameter (`?minimum=`).
 */
export function ForecastWorkspace() {
  return (
    <ConvexGuard fallback={null}>
      <Inner />
    </ConvexGuard>
  );
}

function Inner() {
  const t = useTranslations("reports.forecast");
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const minimum = params.get("minimum");
  const parsed = minimum ? parseCents(minimum) : null;
  const thresholdCents = parsed?.ok ? parsed.value : undefined;
  const [draft, setDraft] = useState(thresholdCents !== undefined ? formatCents(thresholdCents) : "");
  const [source, setSource] = useState<Source | "all">("all");
  const minId = useId();
  const srcId = useId();
  const data = useAuthedQuery(api.reports.forecast, thresholdCents !== undefined ? { thresholdCents } : {});
  const apply = () => {
    const next = new URLSearchParams(params.toString());
    const p = draft.trim() ? parseCents(draft.trim()) : null;
    if (p?.ok) next.set("minimum", formatCents(p.value));
    else next.delete("minimum");
    router.replace(`${pathname}${next.size ? `?${next}` : ""}` as Route, { scroll: false });
  };
  return (
    <div className="@container flex flex-col gap-6">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={minId}>{t("threshold")}</Label>
          <Input
            id={minId}
            inputMode="decimal"
            className="w-44"
            placeholder="5.000,00"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={apply}
          />
        </div>
      </form>
      {data === undefined ? (
        <div className="h-72" aria-busy="true" />
      ) : (
        <>
          {data.notices.map((n) => (
            <p key={n} className="rounded-md border bg-muted p-3 text-sm">
              {n}
            </p>
          ))}
          {data.belowThreshold.cautious && (
            <p role="alert" className="rounded-md border border-destructive/50 p-3 font-medium text-sm">
              {data.belowThreshold.expected
                ? t("belowExpected", { date: dateDe(data.belowThreshold.expected) })
                : t("belowCautious", { date: dateDe(data.belowThreshold.cautious) })}
            </p>
          )}
          <dl className="grid grid-cols-1 gap-3 @md:grid-cols-3">
            {[
              { k: t("opening"), v: data.openingCents },
              { k: t("endExpected"), v: data.days.at(-1)?.expectedCents ?? 0 },
              { k: t("endCautious"), v: data.days.at(-1)?.cautiousCents ?? 0 },
            ].map(({ k, v }) => (
              <div key={k} className="rounded-lg border p-4">
                <dt className="text-muted-foreground text-sm">{k}</dt>
                <dd className="font-semibold text-2xl tabular-nums">{euro(v)}</dd>
              </div>
            ))}
          </dl>
          <ForecastChart weeks={data.weeks} thresholdCents={data.thresholdCents} />
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={srcId}>{t("source")}</Label>
              <select
                id={srcId}
                className={`${SELECT} w-56`}
                value={source}
                onChange={(e) => setSource(e.target.value as Source | "all")}
              >
                <option value="all">{t("allSources")}</option>
                {SOURCES.map((s) => (
                  <option key={s} value={s}>
                    {t(`sources.${s}`)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <Table aria-label={t("tableLabel")} scrollLabel={t("tableLabel")}>
            <TableHeader>
              <TableRow>
                <TableHead>{t("expectedDate")}</TableHead>
                <TableHead>{t("cautiousDate")}</TableHead>
                <TableHead>{t("item")}</TableHead>
                <TableHead>{t("source")}</TableHead>
                <TableHead className="text-right">{t("amount")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items
                .filter((i) => source === "all" || i.source === source)
                .map((i) => (
                  <TableRow key={i.id}>
                    <TableCell>{dateDe(i.expectedDate)}</TableCell>
                    <TableCell>{dateDe(i.cautiousDate)}</TableCell>
                    <TableCell>
                      {i.href ? (
                        <Link className="underline-offset-4 hover:underline" href={i.href as Route}>
                          {i.label}
                        </Link>
                      ) : (
                        i.label
                      )}
                      {i.delay && i.delay.basis !== "none" && (
                        <span className="block text-muted-foreground text-xs">
                          {t("delay", { expected: i.delay.expectedDays, cautious: i.delay.cautiousDays })}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>{t(`sources.${i.source}`)}</TableCell>
                    <TableCell className="text-right tabular-nums">{euro(i.cents)}</TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </>
      )}
    </div>
  );
}

const W = 640;
const H = 220;
const PAD = { l: 64, r: 8, t: 8, b: 24 };

/** Weekly line chart: solid „erwartet“, dashed „vorsichtig“, dotted threshold. A hidden table carries the values. */
export function ForecastChart({ weeks, thresholdCents }: { weeks: readonly Week[]; thresholdCents: number | null }) {
  const t = useTranslations("reports.forecast");
  if (weeks.length === 0) return null;
  const values = weeks.flatMap((w) => [w.expectedCents, w.cautiousCents]).concat(thresholdCents ?? []);
  const lo = Math.min(0, ...values);
  const hi = Math.max(1, ...values);
  const x = (i: number) => PAD.l + (i * (W - PAD.l - PAD.r)) / Math.max(1, weeks.length - 1);
  const y = (c: number) => PAD.t + ((hi - c) * (H - PAD.t - PAD.b)) / (hi - lo || 1);
  const path = (k: "expectedCents" | "cautiousCents") =>
    weeks.map((w, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(w[k]).toFixed(1)}`).join(" ");
  const ticks = [lo, (lo + hi) / 2, hi].map((v) => Math.round(v / 100) * 100);
  const euros = (c: number) => `${formatDecimal(Math.round(c / 100), 0)} €`;
  return (
    <figure className="flex flex-col gap-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={t("chartLabel")}>
        {ticks.map((tk) => (
          <g key={tk}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(tk)} y2={y(tk)} className="stroke-border" />
            <text x={PAD.l - 6} y={y(tk) + 4} textAnchor="end" className="fill-muted-foreground text-[10px]">
              {euros(tk)}
            </text>
          </g>
        ))}
        {thresholdCents !== null && (
          <line
            x1={PAD.l}
            x2={W - PAD.r}
            y1={y(thresholdCents)}
            y2={y(thresholdCents)}
            strokeDasharray="2 4"
            className="stroke-red-600 dark:stroke-red-500"
            strokeWidth={1.5}
          />
        )}
        <path
          d={path("cautiousCents")}
          fill="none"
          strokeWidth={2}
          strokeDasharray="6 4"
          className="stroke-amber-600"
        />
        <path d={path("expectedCents")} fill="none" strokeWidth={2} className="stroke-blue-600 dark:stroke-blue-500" />
        {weeks.map((w, i) =>
          i % 2 === 0 ? (
            <text key={w.from} x={x(i)} y={H - 6} textAnchor="middle" className="fill-muted-foreground text-[10px]">
              {dateDe(w.to).slice(0, 6)}
            </text>
          ) : null,
        )}
      </svg>
      <figcaption className="flex flex-wrap gap-4 text-muted-foreground text-xs">
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block h-0.5 w-5 bg-blue-600" />
          {t("expected")}
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block h-0.5 w-5 border-amber-600 border-t-2 border-dashed" />
          {t("cautious")}
        </span>
        {thresholdCents !== null && (
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true" className="inline-block h-0.5 w-5 border-red-600 border-t-2 border-dotted" />
            {t("thresholdLine", { amount: euro(thresholdCents) })}
          </span>
        )}
      </figcaption>
      <table className="sr-only">
        <caption>{t("chartLabel")}</caption>
        <thead>
          <tr>
            <th>{t("week")}</th>
            <th>{t("expected")}</th>
            <th>{t("cautious")}</th>
          </tr>
        </thead>
        <tbody>
          {weeks.map((w) => (
            <tr key={w.from}>
              <td>
                {dateDe(w.from)} – {dateDe(w.to)}
              </td>
              <td>{euro(w.expectedCents)}</td>
              <td>{euro(w.cautiousCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

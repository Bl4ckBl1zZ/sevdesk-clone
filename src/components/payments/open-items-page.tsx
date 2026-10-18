"use client";

import { api } from "@convex/_generated/api";
import { DownloadIcon, ReceiptTextIcon } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { formatDate, todayBerlin } from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { money } from "@/components/invoices/invoice-shared";
import { EmptyState } from "@/components/layout/empty-state";
import { PageBody } from "@/components/layout/list-layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { openItemsCsv } from "@/domain/payments/open-items";
import { useAuthedQuery } from "@/hooks/use-authed-query";

/** Neutral-to-strong sequence for the aging buckets (each bucket is also labelled, never colour only). */
const BUCKET_CLASSES = ["bg-muted-foreground/30", "bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4"];

/**
 * Offene Posten (F05 PAY-001…PAY-007, §6.3): KPIs, aging buckets (labelled bar + table), Stichtag (as-of) picker,
 * „nur überfällige“, list (table on wide containers, cards on phones), CSV export. Overdue is derived at read time.
 */
export function OpenItemsPage() {
  return (
    <ConvexGuard fallback={<div className="h-96" aria-busy="true" />}>
      <OpenItemsInner />
    </ConvexGuard>
  );
}

function OpenItemsInner() {
  const t = useTranslations("payments.openItems");
  const [asOf, setAsOf] = useState(todayBerlin());
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [bucket, setBucket] = useState<string | null>(null);
  const data = useAuthedQuery(api.payments.openItems, {
    asOf,
    ...(overdueOnly ? { overdueOnly: true } : {}),
    ...(bucket ? { bucket } : {}),
  });
  const ids = { asOf: useId() };
  if (data === undefined) return <PageBody aria-busy="true" className="h-96" />;
  const total = data.totals.buckets.reduce((s, b) => s + Math.max(0, b.openCents), 0);
  const download = () => {
    const blob = new Blob([openItemsCsv(data)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `offene-posten-${data.asOf}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <PageBody className="@container/opos">
      <section aria-label={t("kpis")} className="grid gap-3 @lg/opos:grid-cols-4">
        {[
          { label: t("open"), value: data.totals.openCents, id: "kpi-open" },
          { label: t("overdue"), value: data.totals.overdueCents, id: "kpi-overdue" },
          { label: t("due7"), value: data.totals.dueWithin7Cents, id: "kpi-due7" },
          { label: t("credits"), value: data.totals.creditCents, id: "kpi-credits" },
        ].map((k) => (
          <div key={k.id} className="flex flex-col rounded-xl border p-3">
            <span className="text-muted-foreground text-sm">{k.label}</span>
            <span className="font-semibold text-xl tabular-nums" data-testid={k.id}>
              {money(k.value)}
            </span>
          </div>
        ))}
      </section>

      <section aria-labelledby="aging" className="flex flex-col gap-2 rounded-xl border p-4">
        <h2 id="aging" className="font-semibold text-base">
          {t("aging")}
        </h2>
        {total > 0 && (
          <div className="flex h-4 w-full overflow-hidden rounded" aria-hidden="true">
            {data.totals.buckets.map((b, i) =>
              b.openCents > 0 ? (
                <div
                  key={b.key}
                  className={BUCKET_CLASSES[i] ?? "bg-chart-5"}
                  style={{ width: `${(b.openCents / total) * 100}%` }}
                />
              ) : null,
            )}
          </div>
        )}
        <ul className="grid gap-1 text-sm @lg/opos:grid-cols-5">
          {data.totals.buckets.map((b, i) => (
            <li key={b.key}>
              <button
                type="button"
                aria-pressed={bucket === b.key}
                onClick={() => setBucket(bucket === b.key ? null : b.key)}
                className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-muted aria-pressed:bg-muted md:min-h-9"
              >
                <span
                  className={`size-3 shrink-0 rounded-sm ${BUCKET_CLASSES[i] ?? "bg-chart-5"}`}
                  aria-hidden="true"
                />
                <span className="flex-1">
                  {b.key === "not_due" ? t("notDue") : t("daysBucket", { label: b.label })} ({b.count})
                </span>
                <span className="tabular-nums">{money(b.openCents)}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.asOf} className="font-medium text-sm">
            {t("asOf")}
          </label>
          <Input
            id={ids.asOf}
            type="date"
            value={asOf}
            max={todayBerlin()}
            onChange={(e) => e.target.value && setAsOf(e.target.value)}
            className="h-11 md:h-9"
          />
        </div>
        <label className="flex min-h-11 items-center gap-2 text-sm md:min-h-9">
          <input
            type="checkbox"
            className="size-5 accent-primary md:size-4"
            checked={overdueOnly}
            onChange={(e) => setOverdueOnly(e.target.checked)}
          />
          {t("overdueOnly")}
        </label>
        <Button variant="outline" className="h-11 md:h-9" onClick={download}>
          <DownloadIcon aria-hidden="true" />
          {t("csv")}
        </Button>
      </div>

      {data.items.length === 0 ? (
        <EmptyState icon={ReceiptTextIcon} title={t("empty")} />
      ) : (
        <>
          <div className="hidden @3xl/opos:block">
            <Table data-testid="open-items-table">
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns.number")}</TableHead>
                  <TableHead>{t("columns.customer")}</TableHead>
                  <TableHead>{t("columns.date")}</TableHead>
                  <TableHead>{t("columns.due")}</TableHead>
                  <TableHead className="text-right">{t("columns.days")}</TableHead>
                  <TableHead className="text-right">{t("columns.amount")}</TableHead>
                  <TableHead className="text-right">{t("columns.paid")}</TableHead>
                  <TableHead className="text-right">{t("columns.open")}</TableHead>
                  <TableHead>{t("columns.status")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((i) => (
                  <TableRow key={`${i.kind}-${i.id}`}>
                    <TableCell>
                      {i.kind === "salesDocument" ? (
                        <Link className="underline" href={`/rechnungen/${i.id}` as Route}>
                          {i.number}
                        </Link>
                      ) : (
                        i.number
                      )}
                    </TableCell>
                    <TableCell>{i.contactName}</TableCell>
                    <TableCell className="whitespace-nowrap">{formatDate(i.documentDate)}</TableCell>
                    <TableCell className="whitespace-nowrap">{formatDate(i.dueDate)}</TableCell>
                    <TableCell className="text-right tabular-nums">{i.daysOverdue || ""}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(i.payableCents)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(i.paidCents)}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">{money(i.openCents)}</TableCell>
                    <TableCell>
                      <Badge variant={i.overdue ? "destructive" : "outline"}>
                        {i.overdue ? t("statusOverdue") : i.openCents < 0 ? t("statusRefundOpen") : t("statusOpen")}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <ul className="flex flex-col gap-2 @3xl/opos:hidden" data-testid="open-items-cards">
            {data.items.map((i) => (
              <li key={`${i.kind}-${i.id}`} className="flex justify-between gap-3 rounded-lg border p-3 text-sm">
                <span className="flex min-w-0 flex-col">
                  {i.kind === "salesDocument" ? (
                    <Link className="font-medium underline" href={`/rechnungen/${i.id}` as Route}>
                      {i.number}
                    </Link>
                  ) : (
                    <span className="font-medium">{i.number}</span>
                  )}
                  <span className="truncate text-muted-foreground">{i.contactName}</span>
                  <span className="text-muted-foreground">
                    {t("columns.due")} {formatDate(i.dueDate)}
                    {i.overdue ? ` · ${t("daysOverdue", { days: i.daysOverdue })}` : ""}
                  </span>
                </span>
                <span className="flex flex-col items-end gap-1">
                  <span className="font-semibold tabular-nums">{money(i.openCents)}</span>
                  {i.overdue && <Badge variant="destructive">{t("statusOverdue")}</Badge>}
                  {i.openCents < 0 && <Badge variant="outline">{t("statusRefundOpen")}</Badge>}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {data.credits.length > 0 && (
        <section aria-labelledby="credits" className="flex flex-col gap-2">
          <h2 id="credits" className="font-semibold text-base">
            {t("creditList")}
          </h2>
          <ul className="flex flex-col gap-1 text-sm">
            {data.credits.map((c) => (
              <li key={c.contactId} className="flex justify-between gap-3 rounded-md border p-2">
                <Link className="underline" href={`/kontakte/${c.contactId}` as Route}>
                  {c.contactName}
                </Link>
                <span className="tabular-nums">{money(c.balanceCents)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </PageBody>
  );
}

"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useAction, useMutation } from "convex/react";
import { PauseIcon, PlayIcon, PlusIcon, RepeatIcon, ZapIcon } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { formatDate, useCan, useRun, useUrlState } from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { money } from "@/components/invoices/invoice-shared";
import { EmptyState } from "@/components/layout/empty-state";
import { ListLayout, StatusFilter } from "@/components/layout/list-layout";
import { Button, buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { cn } from "@/lib/utils";
import { ResumeDialog } from "./recurring-detail";

/**
 * „Wiederkehrend“ (F04 §6.1): Aktiv · Pausiert · Beendet with name, customer, interval, next invoice, amount,
 * automation and generated count; row actions „Jetzt erzeugen“, „Pausieren/Fortsetzen“, „Bearbeiten“.
 */
const TABS = ["active", "paused", "ended"] as const;
type Tab = (typeof TABS)[number];
const BASE = "/rechnungen/wiederkehrend";

export function RecurringList() {
  return (
    <ConvexGuard fallback={<div className="h-96" aria-busy="true" />}>
      <RecurringListInner />
    </ConvexGuard>
  );
}

type Row = NonNullable<ReturnType<typeof useRows>>["rows"][number];
const useRows = (tab: Tab) => useAuthedQuery(api.recurring.list, { tab });

function RecurringListInner() {
  const t = useTranslations("recurring.list");
  const url = useUrlState();
  const tab: Tab = (TABS as readonly string[]).includes(url.get("status")) ? (url.get("status") as Tab) : "active";
  const data = useRows(tab);
  const canWrite = useCan("documents.write");
  const run = useRun();
  const runNow = useAction(api.recurring.runNow);
  const pause = useMutation(api.recurring.pause);
  const [busy, setBusy] = useState<string | null>(null);
  const [resumeId, setResumeId] = useState<Id<"recurringTemplates"> | null>(null);

  const filters = (
    <StatusFilter
      label={t("tabsLabel")}
      current={tab}
      options={TABS.map((s) => ({
        value: s,
        label: `${t(`tabs.${s}`)}${data ? ` (${data.counts[s]})` : ""}`,
        href: url.hrefWith({ status: s === "active" ? "" : s }),
      }))}
    />
  );
  const toolbar = canWrite && (
    <Link href={`${BASE}/neu` as Route} className={cn(buttonVariants(), "hidden h-9 md:ml-auto md:inline-flex")}>
      <PlusIcon aria-hidden="true" />
      {t("new")}
    </Link>
  );
  const fab = canWrite && (
    <Link
      href={`${BASE}/neu` as Route}
      className={cn(
        buttonVariants(),
        "fixed right-4 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-20 h-12 rounded-full shadow-lg md:hidden",
      )}
    >
      <PlusIcon aria-hidden="true" />
      {t("new")}
    </Link>
  );

  if (data === undefined) {
    return (
      <ListLayout filters={filters} toolbar={toolbar}>
        <div className="h-64" aria-busy="true" />
      </ListLayout>
    );
  }
  if (data.rows.length === 0) {
    const pristine = data.counts.active + data.counts.paused + data.counts.ended === 0;
    return (
      <ListLayout filters={filters} toolbar={toolbar}>
        <EmptyState
          icon={RepeatIcon}
          title={pristine ? t("empty") : t("noResults")}
          action={pristine && canWrite ? { label: t("action"), href: `${BASE}/neu` as Route } : undefined}
        />
        {fab}
      </ListLayout>
    );
  }

  const automation = (r: Row) =>
    r.automationEffective ? t("automationOn") : r.automation.finalize ? t("automationPending") : t("automationOff");
  const doRunNow = async (r: Row) => {
    setBusy(r._id);
    const res = await run(() => runNow({ id: r._id }));
    setBusy(null);
    if (res.ok) toast.success(t("runNowDone", { created: res.value.created, finalized: res.value.finalized }));
  };
  const actions = (r: Row) =>
    canWrite && (
      <div className="flex flex-wrap gap-1">
        {r.state === "active" && (
          <Button
            variant="outline"
            size="sm"
            className="h-11 md:h-8"
            disabled={busy === r._id}
            onClick={() => void doRunNow(r)}
            aria-label={`${t("runNow")}: ${r.name}`}
          >
            <ZapIcon aria-hidden="true" />
            <span className="sr-only @3xl/main:not-sr-only">{t("runNow")}</span>
          </Button>
        )}
        {r.state === "active" && (
          <Button
            variant="ghost"
            size="sm"
            className="h-11 md:h-8"
            onClick={() => void run(() => pause({ id: r._id }), t("paused"))}
            aria-label={`${t("pause")}: ${r.name}`}
          >
            <PauseIcon aria-hidden="true" />
            <span className="sr-only @3xl/main:not-sr-only">{t("pause")}</span>
          </Button>
        )}
        {r.state === "paused" && (
          <Button
            variant="ghost"
            size="sm"
            className="h-11 md:h-8"
            onClick={() => setResumeId(r._id)}
            aria-label={`${t("resume")}: ${r.name}`}
          >
            <PlayIcon aria-hidden="true" />
            <span className="sr-only @3xl/main:not-sr-only">{t("resume")}</span>
          </Button>
        )}
      </div>
    );

  return (
    <ListLayout
      filters={filters}
      toolbar={toolbar}
      table={
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("columns.name")}</TableHead>
              <TableHead>{t("columns.customer")}</TableHead>
              <TableHead>{t("columns.interval")}</TableHead>
              <TableHead>{t("columns.next")}</TableHead>
              <TableHead className="text-right">{t("columns.amount")}</TableHead>
              <TableHead>{t("columns.automation")}</TableHead>
              <TableHead className="text-right">{t("columns.generated")}</TableHead>
              {canWrite && <TableHead>{t("columns.actions")}</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.rows.map((r) => (
              <TableRow key={r._id}>
                <TableCell>
                  <Link href={`${BASE}/${r._id}` as Route} className="font-medium hover:underline">
                    {r.name}
                  </Link>
                </TableCell>
                <TableCell>{r.contactName ?? "—"}</TableCell>
                <TableCell>{r.intervalLabel}</TableCell>
                <TableCell className="tabular-nums">{formatDate(r.nextDate)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {r.amount ? money(r.amount.grossCents, r.amount.currency) : "—"}
                </TableCell>
                <TableCell>{automation(r)}</TableCell>
                <TableCell className="text-right tabular-nums">{r.generatedCount}</TableCell>
                {canWrite && <TableCell>{actions(r)}</TableCell>}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      }
      cards={data.rows.map((r) => (
        <article key={r._id} className="flex flex-col gap-2 rounded-lg border p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-1">
              <Link href={`${BASE}/${r._id}` as Route} className="font-medium hover:underline">
                {r.name}
              </Link>
              <span className="text-muted-foreground text-sm">
                {r.contactName ?? "—"} · {r.intervalLabel} · {formatDate(r.nextDate)}
              </span>
              <span className="text-muted-foreground text-xs">
                {automation(r)} · {t("generatedCount", { count: r.generatedCount })}
              </span>
            </div>
            <span className="font-medium text-sm tabular-nums">
              {r.amount ? money(r.amount.grossCents, r.amount.currency) : "—"}
            </span>
          </div>
          {actions(r)}
        </article>
      ))}
    >
      {fab}
      {resumeId && <ResumeDialog id={resumeId} onClose={() => setResumeId(null)} />}
    </ListLayout>
  );
}

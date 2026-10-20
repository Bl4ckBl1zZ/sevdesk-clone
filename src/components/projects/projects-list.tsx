"use client";

import { api } from "@convex/_generated/api";
import { FolderKanbanIcon, PlusIcon } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useCan, useUrlState } from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { EmptyState } from "@/components/layout/empty-state";
import { ListLayout, StatusFilter } from "@/components/layout/list-layout";
import { ListSearch } from "@/components/layout/list-search";
import { BudgetBar } from "@/components/time/time-shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatEuro } from "@/domain/money/format";
import { formatMinutes } from "@/domain/projects/time-entries";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { cn } from "@/lib/utils";
import { ProjectCreateDialog } from "./project-form";

/** Projekte (F11 §6 `/projekte`, PRJ-001/003): name, customer, status, budget bar and the unbilled value. */
const STATUSES = ["active", "done", "archived", "all"] as const;
type Status = (typeof STATUSES)[number];

export function ProjectsList() {
  return (
    <ConvexGuard fallback={<div className="h-96" aria-busy="true" />}>
      <ProjectsListInner />
    </ConvexGuard>
  );
}

function ProjectsListInner() {
  const t = useTranslations("projects.list");
  const url = useUrlState();
  const status: Status = (STATUSES as readonly string[]).includes(url.get("status"))
    ? (url.get("status") as Status)
    : "active";
  const q = url.get("q");
  const rows = useAuthedQuery(api.projects.list, { status, ...(q ? { q } : {}) });
  const canWrite = useCan("projects.write");
  const [creating, setCreating] = useState(false);

  const filters = (
    <StatusFilter
      label={t("statusLabel")}
      current={status}
      options={STATUSES.map((s) => ({
        value: s,
        label: t(`status.${s}`),
        href: url.hrefWith({ status: s === "active" ? "" : s }),
      }))}
    />
  );
  const toolbar = (
    <>
      <ListSearch
        label={t("search")}
        placeholder={t("searchPlaceholder")}
        defaultValue={q}
        onSearch={(v) => url.set({ q: v })}
      />
      {canWrite && (
        <Button className="hidden h-9 md:ml-auto md:inline-flex" onClick={() => setCreating(true)}>
          <PlusIcon aria-hidden="true" />
          {t("new")}
        </Button>
      )}
    </>
  );
  const fab = canWrite && (
    <Button
      className="fixed right-4 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-20 h-12 rounded-full shadow-lg md:hidden"
      onClick={() => setCreating(true)}
    >
      <PlusIcon aria-hidden="true" />
      {t("new")}
    </Button>
  );
  const dialog = creating && <ProjectCreateDialog onClose={() => setCreating(false)} />;

  if (rows === undefined) {
    return (
      <ListLayout filters={filters} toolbar={toolbar}>
        <div className="h-64" aria-busy="true" />
      </ListLayout>
    );
  }
  if (rows.length === 0) {
    const pristine = !q && status === "active";
    return (
      <ListLayout filters={filters} toolbar={toolbar}>
        <EmptyState icon={FolderKanbanIcon} title={pristine ? t("empty") : t("noResults")} />
        {pristine && canWrite && (
          <Button className="h-11 self-center md:h-9" onClick={() => setCreating(true)}>
            {t("action")}
          </Button>
        )}
        {fab}
        {dialog}
      </ListLayout>
    );
  }

  const budget = (r: (typeof rows)[number]) =>
    r.budget ? (
      <BudgetBar budget={r.budget} label={t("budgetLabel", { label: r.budget.label })} />
    ) : (
      <span className="text-muted-foreground text-sm">{t("noBudget")}</span>
    );

  return (
    <ListLayout
      filters={filters}
      toolbar={toolbar}
      table={
        <Table data-testid="projects-table">
          <TableHeader>
            <TableRow>
              <TableHead>{t("columns.number")}</TableHead>
              <TableHead>{t("columns.name")}</TableHead>
              <TableHead>{t("columns.contact")}</TableHead>
              <TableHead>{t("columns.status")}</TableHead>
              <TableHead>{t("columns.budget")}</TableHead>
              <TableHead className="text-right">{t("columns.tracked")}</TableHead>
              <TableHead className="text-right">{t("columns.unbilled")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r._id}>
                <TableCell className="tabular-nums">{r.number}</TableCell>
                <TableCell>
                  <Link href={`/projekte/${r._id}` as Route} className="font-medium hover:underline">
                    {r.name}
                  </Link>
                </TableCell>
                <TableCell>
                  {r.contactName ?? <span className="text-muted-foreground">{t("noContact")}</span>}
                </TableCell>
                <TableCell>
                  <Badge variant={r.status === "active" ? "outline" : "secondary"}>{t(`status.${r.status}`)}</Badge>
                </TableCell>
                <TableCell>{budget(r)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMinutes(r.trackedMinutes)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatEuro(r.unbilledValueCents)}
                  <span className="block text-muted-foreground text-xs">{formatMinutes(r.unbilledMinutes)}</span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      }
      cards={rows.map((r) => (
        <article key={r._id} className="flex flex-col gap-2 rounded-lg border p-3" data-testid="project-card">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <Link href={`/projekte/${r._id}` as Route} className="font-medium hover:underline">
                {r.name}
              </Link>
              <span className="text-muted-foreground text-sm">
                {r.number} · {r.contactName ?? t("noContact")}
              </span>
            </div>
            <Badge variant={r.status === "active" ? "outline" : "secondary"}>{t(`status.${r.status}`)}</Badge>
          </div>
          {budget(r)}
          <span className={cn("text-sm tabular-nums", r.unbilledValueCents === 0 && "text-muted-foreground")}>
            {t("unbilledValue", { value: formatEuro(r.unbilledValueCents) })}
          </span>
        </article>
      ))}
    >
      {fab}
      {dialog}
    </ListLayout>
  );
}

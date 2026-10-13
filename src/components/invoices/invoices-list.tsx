"use client";

import { api } from "@convex/_generated/api";
import { PlusIcon, ReceiptIcon } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { formatDate, useAuthedPaginatedQuery, useCan, useUrlState } from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { EmptyState } from "@/components/layout/empty-state";
import { ListLayout, StatusFilter } from "@/components/layout/list-layout";
import { ListSearch } from "@/components/layout/list-search";
import { Button, buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { DisplayStatus } from "@/domain/documents/display-status";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { cn } from "@/lib/utils";
import { InvoiceStatusBadge, money } from "./invoice-shared";

/** Rechnungen list (DOC-37, F04 §6.1): status tabs and search in the URL; table on desktop, cards on phones. */
const TABS = ["all", "draft", "unsent", "open", "overdue", "paid", "exported_not_marked"] as const;

export function InvoicesList() {
  return (
    <ConvexGuard fallback={<div className="h-96" aria-busy="true" />}>
      <InvoicesListInner />
    </ConvexGuard>
  );
}

function InvoicesListInner() {
  const t = useTranslations("invoices.list");
  const url = useUrlState();
  const tab = (TABS as readonly string[]).includes(url.get("status")) ? url.get("status") : "all";
  const q = url.get("q");
  const args = useMemo(() => ({ tab, ...(q ? { q } : {}) }), [tab, q]);
  const { results, status, loadMore } = useAuthedPaginatedQuery(api.invoices.list, args, 50);
  const canWrite = useCan("documents.write");

  const filters = (
    <StatusFilter
      label={t("tabsLabel")}
      current={tab}
      options={TABS.map((s) => ({
        value: s,
        label: t(`tabs.${s}`),
        href: url.hrefWith({ status: s === "all" ? "" : s }),
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
        <Link href="/rechnungen/neu" className={cn(buttonVariants(), "hidden h-9 md:ml-auto md:inline-flex")}>
          <PlusIcon aria-hidden="true" />
          {t("new")}
        </Link>
      )}
    </>
  );
  const fab = canWrite && (
    <Link
      href="/rechnungen/neu"
      className={cn(
        buttonVariants(),
        "fixed right-4 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-20 h-12 rounded-full shadow-lg md:hidden",
      )}
    >
      <PlusIcon aria-hidden="true" />
      {t("new")}
    </Link>
  );

  if (status === "LoadingFirstPage") {
    return (
      <ListLayout filters={filters} toolbar={toolbar}>
        <div className="h-64" aria-busy="true" />
      </ListLayout>
    );
  }
  if (results.length === 0) {
    const pristine = !q && tab === "all";
    return (
      <ListLayout filters={filters} toolbar={toolbar}>
        <EmptyState
          icon={ReceiptIcon}
          title={pristine ? t("empty") : t("noResults")}
          action={pristine && canWrite ? { label: t("action"), href: "/rechnungen/neu" } : undefined}
        />
        {fab}
      </ListLayout>
    );
  }
  const label = (r: (typeof results)[number]) => r.number ?? t("draft");
  return (
    <ListLayout
      filters={filters}
      toolbar={toolbar}
      table={
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("columns.status")}</TableHead>
              <TableHead>{t("columns.number")}</TableHead>
              <TableHead>{t("columns.customer")}</TableHead>
              <TableHead>{t("columns.date")}</TableHead>
              <TableHead>{t("columns.due")}</TableHead>
              <TableHead className="text-right">{t("columns.gross")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {results.map((r) => (
              <TableRow key={r._id}>
                <TableCell>
                  <InvoiceStatusBadge token={r.displayStatus.token as DisplayStatus} label={r.displayStatus.label} />
                </TableCell>
                <TableCell className="tabular-nums">
                  <Link href={`/rechnungen/${r._id}` as Route} className="font-medium hover:underline">
                    {label(r)}
                  </Link>
                </TableCell>
                <TableCell>{r.contactName ?? "—"}</TableCell>
                <TableCell className="tabular-nums">{formatDate(r.documentDate)}</TableCell>
                <TableCell className="tabular-nums">{formatDate(r.dueDate)}</TableCell>
                <TableCell className="text-right tabular-nums">{money(r.grossCents, r.currency)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      }
      cards={results.map((r) => (
        <article key={r._id} className="flex items-start justify-between gap-3 rounded-lg border p-3">
          <div className="flex min-w-0 flex-col gap-1">
            <Link href={`/rechnungen/${r._id}` as Route} className="font-medium hover:underline">
              {label(r)}
            </Link>
            <span className="text-muted-foreground text-sm">
              {r.contactName ?? "—"} · {formatDate(r.documentDate)}
            </span>
            <InvoiceStatusBadge token={r.displayStatus.token as DisplayStatus} label={r.displayStatus.label} />
          </div>
          <span className="font-medium text-sm tabular-nums">{money(r.grossCents, r.currency)}</span>
        </article>
      ))}
    >
      {status === "CanLoadMore" && (
        <Button variant="outline" className="h-11 self-center md:h-9" onClick={() => loadMore(50)}>
          {t("loadMore")}
        </Button>
      )}
      {fab}
    </ListLayout>
  );
}

/** Dashboard „Aufgaben“ (SND-21): open to-dos such as exported but unmarked invoices. */
export function TodosWidget() {
  return (
    <ConvexGuard fallback={<p className="text-muted-foreground text-sm">…</p>}>
      <TodosInner />
    </ConvexGuard>
  );
}

function TodosInner() {
  const t = useTranslations("invoices.todos");
  const todos = useAuthedQuery(api.invoices.todos, {});
  if (todos === undefined) return <p className="text-muted-foreground text-sm">{t("loading")}</p>;
  if (todos.length === 0) return <p className="text-muted-foreground text-sm">{t("none")}</p>;
  return (
    <ul className="flex flex-col gap-2 text-sm" data-testid="todos">
      {todos.map((n) => (
        <li key={n._id}>
          {n.link ? (
            <Link href={n.link as Route} className="underline-offset-4 hover:underline">
              {n.title}
            </Link>
          ) : (
            n.title
          )}
        </li>
      ))}
    </ul>
  );
}

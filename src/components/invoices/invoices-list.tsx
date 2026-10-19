"use client";

import { api } from "@convex/_generated/api";
import { PlusIcon, ReceiptIcon } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { formatDate, useAuthedPaginatedQuery, useCan, useUrlState } from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { ExportMenu } from "@/components/exports/export-menu";
import { EmptyState } from "@/components/layout/empty-state";
import { ListLayout, StatusFilter } from "@/components/layout/list-layout";
import { ListSearch } from "@/components/layout/list-search";
import { Button, buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { DisplayStatus } from "@/domain/documents/display-status";
import { type DraftType, documentPath, documentRoute } from "@/domain/documents/doc-types";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { cn } from "@/lib/utils";
import { useDocTypeLabel } from "./corrections";
import { InvoiceStatusBadge, money } from "./invoice-shared";

/**
 * Document lists (DOC-37, F04 §6.1) for Rechnungen (incl. the Proforma tab), Angebote, Auftragsbestätigungen and
 * Lieferscheine: status tabs and search in the URL; table on desktop, cards on phones.
 */
type ListType = "invoice" | "quote" | "order_confirmation" | "delivery_note";

const TABS: Record<ListType, readonly string[]> = {
  invoice: ["all", "draft", "unsent", "open", "overdue", "paid", "exported_not_marked", "proforma"],
  quote: ["all", "draft", "open", "accepted", "rejected", "expired", "invoiced"],
  order_confirmation: ["all", "draft", "open", "partially_invoiced", "invoiced"],
  delivery_note: ["all", "draft", "open", "received", "invoiced"],
};

export function InvoicesList({ type = "invoice" }: { type?: ListType }) {
  return (
    <ConvexGuard fallback={<div className="h-96" aria-busy="true" />}>
      <InvoicesListInner listType={type} />
    </ConvexGuard>
  );
}

const percent = (bp: number | null) => (bp === null ? "—" : `${Math.floor(bp / 100).toLocaleString("de-DE")} %`);

function InvoicesListInner({ listType }: { listType: ListType }) {
  const tAll = useTranslations("invoices.list");
  const tType = useTranslations(`invoices.list.byType.${listType}`);
  const typeLabel = useDocTypeLabel();
  const url = useUrlState();
  const tabs = TABS[listType];
  const tab = tabs.includes(url.get("status")) ? url.get("status") : "all";
  const q = url.get("q");
  // Proforma lives under /rechnungen with its own tab (F04 §6.1).
  const type: DraftType = listType === "invoice" && tab === "proforma" ? "proforma" : listType;
  const args = useMemo(() => ({ type, tab: tab === "proforma" ? "all" : tab, ...(q ? { q } : {}) }), [type, tab, q]);
  const { results, status, loadMore } = useAuthedPaginatedQuery(api.invoices.list, args, 50);
  const canWrite = useCan("documents.write");
  const base = documentRoute(listType);
  const newHref = (type === "proforma" ? `${base}/neu?typ=proforma` : `${base}/neu`) as Route;
  const t = (key: "search" | "searchPlaceholder" | "new" | "empty" | "noResults" | "action") =>
    type === "proforma" ? tAll(`byType.proforma.${key}`) : tType(key);

  const filters = (
    <StatusFilter
      label={tAll("tabsLabel")}
      current={tab}
      options={tabs.map((s) => ({
        value: s,
        label: tAll(`tabs.${s}` as "tabs.all"),
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
      <ExportMenu list="documents" params={{ type: listType }} />
      {canWrite && (
        <Link href={newHref} className={cn(buttonVariants(), "hidden h-9 md:ml-auto md:inline-flex")}>
          <PlusIcon aria-hidden="true" />
          {t("new")}
        </Link>
      )}
    </>
  );
  const fab = canWrite && (
    <Link
      href={newHref}
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
          action={pristine && canWrite ? { label: t("action"), href: newHref } : undefined}
        />
        {fab}
      </ListLayout>
    );
  }
  // Non-standard documents of the Rechnungen area are prefixed with their type (Abschlags-, Storno-, Korrekturbelege).
  const label = (r: (typeof results)[number]) => {
    const n = r.number ?? tAll("draft");
    return listType !== "invoice" || r.type === "invoice" || r.type === "proforma"
      ? n
      : `${typeLabel(r.type, r.correctionKind)} ${n}`;
  };
  const href = (r: (typeof results)[number]) => documentPath(r.type, r._id) as Route;
  const priced = listType !== "delivery_note";
  return (
    <ListLayout
      filters={filters}
      toolbar={toolbar}
      table={
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{tAll("columns.status")}</TableHead>
              <TableHead>{tAll("columns.number")}</TableHead>
              <TableHead>{tAll("columns.customer")}</TableHead>
              <TableHead>
                {listType === "delivery_note" ? tAll("columns.deliveryDate") : tAll("columns.date")}
              </TableHead>
              {listType === "invoice" && <TableHead>{tAll("columns.due")}</TableHead>}
              {listType === "quote" && <TableHead>{tAll("columns.validUntil")}</TableHead>}
              {listType === "order_confirmation" && <TableHead>{tAll("columns.orderReference")}</TableHead>}
              {listType === "order_confirmation" && (
                <TableHead className="text-right">{tAll("columns.invoiced")}</TableHead>
              )}
              {priced && <TableHead className="text-right">{tAll("columns.gross")}</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {results.map((r) => (
              <TableRow key={r._id}>
                <TableCell>
                  <InvoiceStatusBadge token={r.displayStatus.token as DisplayStatus} label={r.displayStatus.label} />
                </TableCell>
                <TableCell className="tabular-nums">
                  <Link href={href(r)} className="font-medium hover:underline">
                    {label(r)}
                  </Link>
                </TableCell>
                <TableCell>{r.contactName ?? "—"}</TableCell>
                <TableCell className="tabular-nums">
                  {formatDate(listType === "delivery_note" ? supplyDay(r.supplyDate) : r.documentDate)}
                </TableCell>
                {listType === "invoice" && <TableCell className="tabular-nums">{formatDate(r.dueDate)}</TableCell>}
                {listType === "quote" && <TableCell className="tabular-nums">{formatDate(r.validUntil)}</TableCell>}
                {listType === "order_confirmation" && <TableCell>{r.orderReference ?? "—"}</TableCell>}
                {listType === "order_confirmation" && (
                  <TableCell className="text-right tabular-nums">{percent(r.coveredBp)}</TableCell>
                )}
                {priced && <TableCell className="text-right tabular-nums">{money(r.grossCents, r.currency)}</TableCell>}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      }
      cards={results.map((r) => (
        <article key={r._id} className="flex items-start justify-between gap-3 rounded-lg border p-3">
          {/* items-start: the status badge keeps its own width instead of stretching across the card. */}
          <div className="flex min-w-0 flex-col items-start gap-1">
            <Link href={href(r)} className="font-medium hover:underline">
              {label(r)}
            </Link>
            <span className="text-muted-foreground text-sm">
              {r.contactName ?? "—"} ·{" "}
              {formatDate(listType === "delivery_note" ? supplyDay(r.supplyDate) : r.documentDate)}
            </span>
            <InvoiceStatusBadge token={r.displayStatus.token as DisplayStatus} label={r.displayStatus.label} />
          </div>
          {priced && <span className="font-medium text-sm tabular-nums">{money(r.grossCents, r.currency)}</span>}
        </article>
      ))}
    >
      {status === "CanLoadMore" && (
        <Button variant="outline" className="h-11 self-center md:h-9" onClick={() => loadMore(50)}>
          {tAll("loadMore")}
        </Button>
      )}
      {fab}
    </ListLayout>
  );
}

/** Delivery date of a delivery note (supply `date`, else the end of the period). */
function supplyDay(s: { kind: string; date?: string; to?: string; month?: string } | null): string | null {
  if (!s) return null;
  return s.date ?? s.to ?? null;
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

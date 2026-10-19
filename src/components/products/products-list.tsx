"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useConvex } from "convex/react";
import { PackageIcon, PlusIcon } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId, useMemo } from "react";
import {
  formatDate,
  formatPercentBp,
  formatPrice,
  selectClass,
  useAuthedPaginatedQuery,
  useCan,
  useRun,
  useUrlState,
} from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { downloadText, ExportMenu } from "@/components/exports/export-menu";
import { EmptyState } from "@/components/layout/empty-state";
import { ListLayout, StatusFilter } from "@/components/layout/list-layout";
import { ListSearch } from "@/components/layout/list-search";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { type CsvVariant, csvFileName, formatTextCsv } from "@/domain/csv/export";
import { PRODUCT_TYPE_LABELS, PRODUCT_TYPES } from "@/domain/products/product";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { cn } from "@/lib/utils";

/**
 * Produkte list (F03 §6.2, PRD-070…072): search by name/number, status, type and category filters in the URL, both
 * price views at today's rate, margin; table on desktop, cards on phones.
 */
const STATUSES = ["active", "archived"] as const;

export function ProductsList() {
  return (
    <ConvexGuard fallback={<div className="h-96" aria-busy="true" />}>
      <ProductsListInner />
    </ConvexGuard>
  );
}

export function RateChangeBanners() {
  const banners = useAuthedQuery(api.products.rateChangeBanners, {}) ?? [];
  if (banners.length === 0) return null;
  return (
    <ul className="flex flex-col gap-2">
      {banners.map((b) => (
        <li key={b} role="status" className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
          {b}
        </li>
      ))}
    </ul>
  );
}

function ProductsListInner() {
  const t = useTranslations("products.list");
  const url = useUrlState();
  const status = url.get("status") === "archived" ? "archived" : "active";
  const q = url.get("q");
  const type = (PRODUCT_TYPES as readonly string[]).includes(url.get("type"))
    ? (url.get("type") as (typeof PRODUCT_TYPES)[number])
    : undefined;
  const categoryId = url.get("category") || undefined;
  const args = useMemo(
    () => ({
      status: status as "active" | "archived",
      ...(q ? { q } : {}),
      ...(type ? { type } : {}),
      ...(categoryId ? { categoryId: categoryId as Id<"productCategories"> } : {}),
    }),
    [status, q, type, categoryId],
  );
  const { results, status: loadStatus, loadMore } = useAuthedPaginatedQuery(api.products.list, args, 50);
  const categories = useAuthedQuery(api.products.categories, {}) ?? [];
  const canWrite = useCan("products.write");
  const convex = useConvex();
  const run = useRun();
  const typeId = useId();
  const catId = useId();

  /** CON-143 / PRD-085 rows of the current filter; EXP-021 both variants, EXP-022 guard in the Excel variant. */
  const exportCsv = async (variant: CsvVariant) => {
    const r = await run(() => convex.query(api.products.exportRows, args), t("exported"));
    if (!r.ok) return;
    const day = new Date().toISOString().slice(0, 10);
    downloadText(csvFileName("produkte", variant, day), formatTextCsv(r.value, variant));
  };

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
      <label htmlFor={typeId} className="sr-only">
        {t("typeFilter")}
      </label>
      <select
        id={typeId}
        className={selectClass}
        value={type ?? ""}
        onChange={(e) => url.set({ type: e.target.value })}
      >
        <option value="">{t("typeAll")}</option>
        {PRODUCT_TYPES.map((x) => (
          <option key={x} value={x}>
            {PRODUCT_TYPE_LABELS[x]}
          </option>
        ))}
      </select>
      <label htmlFor={catId} className="sr-only">
        {t("categoryFilter")}
      </label>
      <select
        id={catId}
        className={selectClass}
        value={categoryId ?? ""}
        onChange={(e) => url.set({ category: e.target.value })}
      >
        <option value="">{t("categoryAll")}</option>
        {categories.map((c) => (
          <option key={c._id} value={c._id}>
            {c.path}
          </option>
        ))}
      </select>
      <div className="flex flex-wrap gap-2 @3xl/main:ml-auto">
        <Link href="/produkte/kategorien" className={cn(buttonVariants({ variant: "outline" }), "h-11 md:h-9")}>
          {t("categories")}
        </Link>
        {canWrite && (
          <Link href="/produkte/import" className={cn(buttonVariants({ variant: "outline" }), "h-11 md:h-9")}>
            {t("import")}
          </Link>
        )}
        <ExportMenu local={(variant) => exportCsv(variant)} />
        {canWrite && (
          <Link href="/produkte/neu" className={cn(buttonVariants(), "hidden h-9 md:inline-flex")}>
            <PlusIcon aria-hidden="true" />
            {t("new")}
          </Link>
        )}
      </div>
    </>
  );

  const fab = canWrite && (
    <Link
      href="/produkte/neu"
      className={cn(
        buttonVariants(),
        "fixed right-4 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-20 h-12 rounded-full shadow-lg md:hidden",
      )}
    >
      <PlusIcon aria-hidden="true" />
      {t("new")}
    </Link>
  );

  if (loadStatus === "LoadingFirstPage") {
    return (
      <ListLayout filters={filters} toolbar={toolbar}>
        <div className="h-64" aria-busy="true" />
      </ListLayout>
    );
  }
  if (results.length === 0) {
    const pristine = !q && status === "active" && !type && !categoryId;
    return (
      <ListLayout filters={filters} toolbar={toolbar}>
        <RateChangeBanners />
        <EmptyState
          icon={PackageIcon}
          title={pristine ? t("empty") : t("noResults")}
          action={pristine && canWrite ? { label: t("action"), href: "/produkte/neu" } : undefined}
        />
        {fab}
      </ListLayout>
    );
  }

  return (
    <ListLayout
      filters={
        <>
          {filters}
          <RateChangeBanners />
        </>
      }
      toolbar={toolbar}
      table={
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("columns.number")}</TableHead>
              <TableHead>{t("columns.name")}</TableHead>
              <TableHead>{t("columns.type")}</TableHead>
              <TableHead>{t("columns.category")}</TableHead>
              <TableHead>{t("columns.unit")}</TableHead>
              <TableHead className="text-right">{t("columns.net")}</TableHead>
              <TableHead className="text-right">{t("columns.gross")}</TableHead>
              <TableHead className="text-right">{t("columns.vat")}</TableHead>
              <TableHead className="text-right">{t("columns.margin")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {results.map((r) => (
              <TableRow key={r._id}>
                <TableCell className="tabular-nums">{r.number}</TableCell>
                <TableCell>
                  <Link href={`/produkte/${r._id}` as Route} className="font-medium hover:underline">
                    {r.name}
                  </Link>
                  {r.scheduledPrice && (
                    <span className="block text-muted-foreground text-xs">
                      {t("scheduled", { date: formatDate(r.scheduledPrice.validFrom) })}
                    </span>
                  )}
                </TableCell>
                <TableCell>{PRODUCT_TYPE_LABELS[r.type]}</TableCell>
                <TableCell>{r.category || "—"}</TableCell>
                <TableCell>{r.unitCode}</TableCell>
                <TableCell className={cn("text-right tabular-nums", r.priceMode === "net" && "font-medium")}>
                  {formatPrice(r.netMicros)}
                </TableCell>
                <TableCell className={cn("text-right tabular-nums", r.priceMode === "gross" && "font-medium")}>
                  {formatPrice(r.grossMicros)}
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatPercentBp(r.rateBp)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatPercentBp(r.marginBp)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      }
      cards={results.map((r) => (
        <article key={r._id} className="flex items-start justify-between gap-3 rounded-lg border p-3">
          <div className="flex min-w-0 flex-col items-start gap-1">
            <Link href={`/produkte/${r._id}` as Route} className="font-medium hover:underline">
              {r.name}
            </Link>
            <span className="text-muted-foreground text-sm">
              {r.number} · {PRODUCT_TYPE_LABELS[r.type]}
              {r.category ? ` · ${r.category}` : ""}
            </span>
            {!r.active && <Badge variant="outline">{t("status.archived")}</Badge>}
          </div>
          <div className="flex flex-col items-end text-sm tabular-nums">
            <span className="font-medium">{formatPrice(r.priceMode === "net" ? r.netMicros : r.grossMicros)}</span>
            <span className="text-muted-foreground text-xs">
              {r.priceMode === "net" ? t("columns.net") : t("columns.gross")} / {r.unitCode}
            </span>
          </div>
        </article>
      ))}
    >
      {loadStatus === "CanLoadMore" && (
        <Button variant="outline" className="h-11 self-center md:h-9" onClick={() => loadMore(50)}>
          {t("loadMore")}
        </Button>
      )}
      {fab}
    </ListLayout>
  );
}

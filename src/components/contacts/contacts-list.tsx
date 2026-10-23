"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useConvex, useMutation } from "convex/react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  Building2Icon,
  MailIcon,
  PhoneIcon,
  PlusIcon,
  UserIcon,
  UsersIcon,
} from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId, useMemo, useState } from "react";
import { selectClass, useAuthedPaginatedQuery, useCan, useRun, useUrlState } from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { downloadText, ExportMenu } from "@/components/exports/export-menu";
import { EmptyState } from "@/components/layout/empty-state";
import { ListLayout, StatusFilter } from "@/components/layout/list-layout";
import { ListSearch } from "@/components/layout/list-search";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { telHref } from "@/domain/contacts/channels";
import { ROLE_LABELS } from "@/domain/contacts/core";
import { rowsToXlsx } from "@/domain/contacts/xlsx";
import { type CsvVariant, csvFileName, formatTextCsv } from "@/domain/csv/export";
import { formatEuro } from "@/domain/money";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { cn } from "@/lib/utils";

/**
 * Kontakte list (F02 §6.2, CON-172…174): status chips, debounced search, filters and bulk actions; all filters live
 * in the URL (04-ui-ux §4.1). Desktop table, phone cards (container query `@3xl/main`).
 */
const STATUS_CHIPS = ["open", "customer", "supplier", "prospect", "archived"] as const;
type Chip = (typeof STATUS_CHIPS)[number];
const TYPES = ["b2b", "b2c", "b2g"] as const;
const VAT = ["qualified", "valid", "invalid", "unchecked", "unavailable"] as const;
/** CON-153: sortable figure columns; `?sort=open-desc` etc. in the URL. */
const SORTS = ["open-desc", "open-asc", "revenueYear-desc", "revenueYear-asc"] as const;
type Sort = (typeof SORTS)[number];

export function ContactsList() {
  return (
    <ConvexGuard fallback={<div className="h-96" aria-busy="true" />}>
      <ContactsListInner />
    </ConvexGuard>
  );
}

function ContactsListInner() {
  const t = useTranslations("contacts.list");
  const url = useUrlState();
  const chip = (STATUS_CHIPS as readonly string[]).includes(url.get("status")) ? (url.get("status") as Chip) : "open";
  const q = url.get("q");
  const type = (TYPES as readonly string[]).includes(url.get("type"))
    ? (url.get("type") as (typeof TYPES)[number])
    : undefined;
  const vat = (VAT as readonly string[]).includes(url.get("vat"))
    ? (url.get("vat") as (typeof VAT)[number])
    : undefined;
  const args = useMemo(
    () => ({
      ...(q ? { q } : {}),
      status: chip === "archived" ? ("archived" as const) : ("open" as const),
      ...(chip === "customer" || chip === "supplier" || chip === "prospect" ? { role: chip } : {}),
      ...(type ? { type } : {}),
      ...(vat ? { vatStatus: vat } : {}),
    }),
    [q, chip, type, vat],
  );
  const sort = (SORTS as readonly string[]).includes(url.get("sort")) ? (url.get("sort") as Sort) : undefined;
  const [sortBy, dir] = (sort?.split("-") ?? []) as ["open" | "revenueYear", "asc" | "desc"];
  const paged = useAuthedPaginatedQuery(api.contacts.list, args, 50);
  const ranked = useAuthedQuery(
    api.contacts.ranking,
    { ...args, sortBy: sortBy ?? "open", dir: dir ?? "desc" },
    sort !== undefined,
  );
  const results = sort ? (ranked ?? []) : paged.results;
  const status = sort ? "Exhausted" : paged.status;
  const loadMore = paged.loadMore;
  const sortHeader = (key: "open" | "revenueYear", label: string) => {
    const active = sortBy === key ? dir : undefined;
    const next = active === "desc" ? `${key}-asc` : `${key}-desc`;
    return (
      <TableHead
        className="text-right"
        aria-sort={active === "desc" ? "descending" : active === "asc" ? "ascending" : "none"}
      >
        <button
          type="button"
          className="inline-flex min-h-11 items-center gap-1 font-medium hover:underline md:min-h-0"
          onClick={() => url.set({ sort: next })}
        >
          {label}
          {active === "desc" && <ArrowDownIcon aria-hidden="true" className="size-3.5" />}
          {active === "asc" && <ArrowUpIcon aria-hidden="true" className="size-3.5" />}
        </button>
      </TableHead>
    );
  };
  const canWrite = useCan("contacts.write");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const typeId = useId();
  const vatId = useId();
  const convex = useConvex();
  const run = useRun();

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const allSelected = results.length > 0 && results.every((r) => selected.has(r._id));

  /** CON-143 / PRD-085 rows of the current filter; EXP-021 both variants, EXP-022 guard in the Excel variant. */
  const exportCsv = async (variant: CsvVariant) => {
    const r = await run(() => convex.query(api.contacts.exportRows, args), t("exported"));
    if (!r.ok) return;
    const day = new Date().toISOString().slice(0, 10);
    downloadText(csvFileName("kontakte", variant, day), formatTextCsv(r.value, variant));
  };

  /** CON-144: the same rows as an Excel workbook (all cells text). */
  const exportXlsx = async () => {
    const r = await run(() => convex.query(api.contacts.exportRows, args), t("exported"));
    if (!r.ok) return;
    const day = new Date().toISOString().slice(0, 10);
    const url = URL.createObjectURL(
      new Blob([rowsToXlsx(r.value) as BlobPart], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `kontakte_${day}.xlsx`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const filters = (
    <StatusFilter
      label={t("statusLabel")}
      current={chip}
      options={STATUS_CHIPS.map((s) => ({
        value: s,
        label: t(`status.${s}`),
        href: url.hrefWith({ status: s === "open" ? "" : s }),
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
        {TYPES.map((x) => (
          <option key={x} value={x}>
            {t(`types.${x}`)}
          </option>
        ))}
      </select>
      <label htmlFor={vatId} className="sr-only">
        {t("vatFilter")}
      </label>
      <select id={vatId} className={selectClass} value={vat ?? ""} onChange={(e) => url.set({ vat: e.target.value })}>
        <option value="">{t("vatAll")}</option>
        {VAT.map((x) => (
          <option key={x} value={x}>
            {t(`vat.${x}`)}
          </option>
        ))}
      </select>
      <div className="flex flex-wrap gap-2 @3xl/main:ml-auto">
        <Link href="/kontakte/duplikate" className={cn(buttonVariants({ variant: "outline" }), "h-11 md:h-9")}>
          <UsersIcon aria-hidden="true" />
          {t("duplicates")}
        </Link>
        {canWrite && (
          <Link href="/kontakte/import" className={cn(buttonVariants({ variant: "outline" }), "h-11 md:h-9")}>
            {t("import")}
          </Link>
        )}
        <ExportMenu local={(variant) => exportCsv(variant)} />
        <Button variant="outline" className="h-11 md:h-9" onClick={() => void exportXlsx()}>
          {t("exportXlsx")}
        </Button>
        {canWrite && (
          <Link href="/kontakte/neu" className={cn(buttonVariants(), "hidden h-9 md:inline-flex")}>
            <PlusIcon aria-hidden="true" />
            {t("new")}
          </Link>
        )}
      </div>
    </>
  );

  if (status === "LoadingFirstPage") {
    return (
      <ListLayout filters={filters} toolbar={toolbar}>
        <div className="h-64" aria-busy="true" />
      </ListLayout>
    );
  }

  if (results.length === 0) {
    const pristine = !q && chip === "open" && !type && !vat;
    return (
      <ListLayout filters={filters} toolbar={toolbar}>
        <EmptyState
          icon={UsersIcon}
          title={pristine ? t("empty") : t("noResults")}
          action={pristine && canWrite ? { label: t("action"), href: "/kontakte/neu" } : undefined}
        />
      </ListLayout>
    );
  }

  return (
    <ListLayout
      filters={filters}
      toolbar={toolbar}
      table={
        <Table>
          <TableHeader>
            <TableRow>
              {canWrite && (
                <TableHead className="w-10">
                  <input
                    type="checkbox"
                    aria-label={t("selectAll")}
                    className="size-4 accent-primary"
                    checked={allSelected}
                    onChange={() => setSelected(allSelected ? new Set() : new Set(results.map((r) => r._id)))}
                  />
                </TableHead>
              )}
              <TableHead>{t("columns.number")}</TableHead>
              <TableHead>{t("columns.name")}</TableHead>
              <TableHead>{t("columns.roles")}</TableHead>
              <TableHead>{t("columns.city")}</TableHead>
              <TableHead>{t("columns.email")}</TableHead>
              <TableHead>{t("columns.phone")}</TableHead>
              <TableHead>{t("columns.vat")}</TableHead>
              <TableHead>{t("columns.tags")}</TableHead>
              {sortHeader("open", t("columns.open"))}
              {sortHeader("revenueYear", t("columns.revenueYear"))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {results.map((r) => (
              <TableRow key={r._id} data-state={selected.has(r._id) ? "selected" : undefined}>
                {canWrite && (
                  <TableCell>
                    <input
                      type="checkbox"
                      aria-label={t("selectRow", { name: r.displayName })}
                      className="size-4 accent-primary"
                      checked={selected.has(r._id)}
                      onChange={() => toggle(r._id)}
                    />
                  </TableCell>
                )}
                <TableCell className="tabular-nums">{r.number}</TableCell>
                <TableCell>
                  <Link
                    href={`/kontakte/${r._id}` as Route}
                    className="inline-flex items-center gap-2 font-medium hover:underline"
                  >
                    {r.kind === "organization" ? (
                      <Building2Icon aria-label={t("organization")} className="size-4 text-muted-foreground" />
                    ) : (
                      <UserIcon aria-label={t("person")} className="size-4 text-muted-foreground" />
                    )}
                    {r.displayName}
                  </Link>
                  {r.parentName && (
                    <span className="block text-muted-foreground text-xs">{t("personOf", { name: r.parentName })}</span>
                  )}
                </TableCell>
                <TableCell>{r.roles.map((x) => ROLE_LABELS[x]).join(", ")}</TableCell>
                <TableCell>{r.city ?? "—"}</TableCell>
                <TableCell className="max-w-48 truncate">{r.email ?? "—"}</TableCell>
                <TableCell>{r.phone ?? "—"}</TableCell>
                <TableCell>{r.vatBadge ? <VatBadge kind={r.vatBadge.kind} text={r.vatBadge.text} /> : "—"}</TableCell>
                <TableCell>
                  <span className="flex flex-wrap gap-1">
                    {r.tags.map((tag) => (
                      <Badge key={tag._id} variant="secondary">
                        {tag.name}
                      </Badge>
                    ))}
                  </span>
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatEuro(r.openCents)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatEuro(r.revenueYearCents)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      }
      cards={results.map((r) => (
        <article key={r._id} className="flex items-start gap-3 rounded-lg border p-3">
          {canWrite && (
            <input
              type="checkbox"
              aria-label={t("selectRow", { name: r.displayName })}
              className="mt-1 size-5 accent-primary"
              checked={selected.has(r._id)}
              onChange={() => toggle(r._id)}
            />
          )}
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <Link href={`/kontakte/${r._id}` as Route} className="font-medium hover:underline">
              {r.displayName}
            </Link>
            <span className="text-muted-foreground text-sm">
              {r.number}
              {r.city ? ` · ${r.city}` : ""}
            </span>
            {r.vatBadge && <VatBadge kind={r.vatBadge.kind} text={r.vatBadge.text} />}
          </div>
          <div className="flex gap-1">
            {r.phone && (
              <a
                href={telHref(r.phone)}
                className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "size-11")}
                aria-label={t("call", { name: r.displayName })}
              >
                <PhoneIcon aria-hidden="true" />
              </a>
            )}
            {r.email && (
              <a
                href={`mailto:${r.email}`}
                className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "size-11")}
                aria-label={t("mail", { name: r.displayName })}
              >
                <MailIcon aria-hidden="true" />
              </a>
            )}
          </div>
        </article>
      ))}
    >
      {selected.size > 0 && canWrite && (
        <BulkBar ids={[...selected] as Id<"contacts">[]} onDone={() => setSelected(new Set())} />
      )}
      {status === "CanLoadMore" && (
        <Button variant="outline" className="h-11 self-center md:h-9" onClick={() => loadMore(50)}>
          {t("loadMore")}
        </Button>
      )}
      {canWrite && (
        <Link
          href="/kontakte/neu"
          className={cn(
            buttonVariants(),
            "fixed right-4 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-20 h-12 rounded-full shadow-lg md:hidden",
          )}
        >
          <PlusIcon aria-hidden="true" />
          {t("new")}
        </Link>
      )}
    </ListLayout>
  );
}

export function VatBadge({ kind, text }: { kind: string; text: string }) {
  const variant =
    kind === "qualified" || kind === "valid" ? "secondary" : kind === "invalid" ? "destructive" : "outline";
  return <Badge variant={variant}>{text}</Badge>;
}

function BulkBar({ ids, onDone }: { ids: Id<"contacts">[]; onDone: () => void }) {
  const t = useTranslations("contacts.list");
  const tags = useAuthedQuery(api.lookups.listTags, {});
  const archive = useMutation(api.contacts.bulkArchive);
  const tag = useMutation(api.contacts.bulkTag);
  const run = useRun();
  const [tagId, setTagId] = useState("");
  const selectId = useId();
  return (
    <section
      aria-label={t("selected", { count: ids.length })}
      className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 p-3 text-sm"
    >
      <span className="font-medium">{t("selected", { count: ids.length })}</span>
      <Button
        variant="outline"
        className="h-11 md:h-8"
        onClick={() =>
          void run(() => archive({ ids }), t("archived", { count: ids.length })).then((r) => r.ok && onDone())
        }
      >
        {t("bulkArchive")}
      </Button>
      <label htmlFor={selectId} className="sr-only">
        {t("chooseTag")}
      </label>
      <select id={selectId} className={selectClass} value={tagId} onChange={(e) => setTagId(e.target.value)}>
        <option value="">{t("chooseTag")}</option>
        {(tags ?? []).map((x) => (
          <option key={x.tagId} value={x.tagId}>
            {x.name}
          </option>
        ))}
      </select>
      {(["add", "remove"] as const).map((mode) => (
        <Button
          key={mode}
          variant="outline"
          className="h-11 md:h-8"
          disabled={!tagId}
          onClick={() =>
            void run(
              () => tag({ ids, tagId: tagId as Id<"tags">, add: mode === "add" }),
              t("tagged", { count: ids.length }),
            ).then((r) => r.ok && onDone())
          }
        >
          {mode === "add" ? t("bulkTag") : t("bulkUntag")}
        </Button>
      ))}
    </section>
  );
}

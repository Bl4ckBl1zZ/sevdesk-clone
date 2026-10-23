"use client";

import { api } from "@convex/_generated/api";
import { useMutation } from "convex/react";
import {
  FileQuestionIcon,
  ListOrderedIcon,
  PencilLineIcon,
  ReceiptTextIcon,
  RepeatIcon,
  UploadIcon,
} from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  formatDate,
  todayBerlin,
  useAuthedPaginatedQuery,
  useCan,
  useRun,
  useUrlState,
} from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { EmptyState } from "@/components/layout/empty-state";
import { ListLayout, StatusFilter } from "@/components/layout/list-layout";
import { ListSearch } from "@/components/layout/list-search";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { cn } from "@/lib/utils";
import { queueHref } from "./queue-model";
import { VoucherBulkBar } from "./voucher-bulk-bar";
import { money, useVoucherUpload, VoucherStatusBadge } from "./voucher-shared";

/**
 * „Belege“ list (F06 §6.2, 04 §4.1): status tabs with counts and search in the URL; table on wide containers, cards
 * on phones; upload button and a drop zone (left half = Ausgabe, right half = Einnahme, as sevdesk); drafts can be
 * selected for the batch queue (VOU-100).
 */
const TABS = [
  "all",
  "draft",
  "open",
  "overdue",
  "partially_paid",
  "paid",
  "cancelled",
  "unbooked",
  "paper_destructible",
] as const;
type Tab = (typeof TABS)[number];

export const voucherPath = (id: string) => `/belege/${id}` as Route;

export function VouchersList() {
  return (
    <ConvexGuard fallback={<div className="h-96" aria-busy="true" />}>
      <VouchersListInner />
    </ConvexGuard>
  );
}

function VouchersListInner() {
  const t = useTranslations("vouchers.list");
  const url = useUrlState();
  const router = useRouter();
  const tab: Tab = (TABS as readonly string[]).includes(url.get("status")) ? (url.get("status") as Tab) : "all";
  const q = url.get("q");
  const args = useMemo(() => ({ tab, ...(q ? { q } : {}) }), [tab, q]);
  const { results, status, loadMore } = useAuthedPaginatedQuery(api.vouchers.list, args, 50);
  const counts = useAuthedQuery(api.vouchers.counts, {});
  const canWrite = useCan("vouchers.write");
  const upload = useVoucherUpload();
  const create = useMutation(api.vouchers.create);
  const run = useRun();
  const fileRef = useRef<HTMLInputElement>(null);
  const [direction, setDirection] = useState<"expense" | "income">("expense");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState<"expense" | "income" | null>(null);
  const [selected, setSelected] = useState<string[]>([]);

  const uploadAll = async (files: readonly File[], dir: "expense" | "income") => {
    if (files.length === 0) return;
    setBusy(true);
    let last: string | null = null;
    let done = 0;
    for (const file of files) {
      const r = await run(() => upload(file, { direction: dir }));
      if (r.ok) {
        last = r.value.voucherId;
        done++;
      }
    }
    setBusy(false);
    if (done > 0) toast.success(t("uploaded", { count: done }));
    if (done === 1 && last) router.push(voucherPath(last));
  };

  const manual = async () => {
    const r = await run(() => create({ input: { documentDate: todayBerlin() } }));
    if (r.ok) router.push(voucherPath(r.value));
  };

  const filters = (
    <StatusFilter
      label={t("tabsLabel")}
      current={tab}
      // VOU-123: „Papier vernichtbar“ only under a released scanning procedure (Verfahrensdokumentation).
      options={TABS.filter((s) => s !== "paper_destructible" || counts?.paperDestructibleAvailable).map((s) => ({
        value: s,
        label: t(`tabs.${s}`),
        ...(counts ? { count: counts[s] } : {}),
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
      <Link href={"/belege/fehlend" as Route} className={cn(buttonVariants({ variant: "outline" }), "h-11 md:h-9")}>
        <FileQuestionIcon aria-hidden="true" />
        {t("missing")}
      </Link>
      <Link
        href={"/belege/wiederkehrend" as Route}
        className={cn(buttonVariants({ variant: "outline" }), "h-11 md:h-9")}
      >
        <RepeatIcon aria-hidden="true" />
        {t("recurring")}
      </Link>
      {selected.length > 0 && (
        <Link
          href={queueHref(selected) as Route}
          className={cn(buttonVariants({ variant: "secondary" }), "h-11 md:h-9")}
          data-testid="open-queue"
        >
          <ListOrderedIcon aria-hidden="true" />
          {t("queue", { count: selected.length })}
        </Link>
      )}
      <VoucherBulkBar ids={selected} onDone={() => setSelected([])} />
      {canWrite && (
        <div className="flex flex-wrap gap-2 md:ml-auto">
          <Button variant="outline" className="h-11 md:h-9" onClick={() => void manual()} disabled={busy}>
            <PencilLineIcon aria-hidden="true" />
            {t("manual")}
          </Button>
          <Button
            variant="outline"
            className="h-11 md:h-9"
            disabled={busy}
            onClick={() => {
              setDirection("income");
              fileRef.current?.click();
            }}
          >
            {t("uploadIncome")}
          </Button>
          <Button
            className="h-11 md:h-9"
            disabled={busy}
            onClick={() => {
              setDirection("expense");
              fileRef.current?.click();
            }}
          >
            <UploadIcon aria-hidden="true" />
            {busy ? t("uploading") : t("upload")}
          </Button>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept="application/pdf,image/*,.xml,application/xml"
            className="hidden"
            tabIndex={-1}
            aria-hidden="true"
            data-testid="voucher-file-input"
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = "";
              void uploadAll(files, direction);
            }}
          />
        </div>
      )}
    </>
  );

  const drop = (dir: "expense" | "income") => ({
    onDragOver: (e: React.DragEvent) => {
      if (!canWrite) return;
      e.preventDefault();
      setDragging(dir);
    },
    onDragLeave: () => setDragging(null),
    onDrop: (e: React.DragEvent) => {
      if (!canWrite) return;
      e.preventDefault();
      setDragging(null);
      void uploadAll([...e.dataTransfer.files], dir);
    },
  });
  const dropZone = canWrite && (
    <div className="relative hidden grid-cols-2 gap-2 @3xl/main:grid" aria-hidden="true">
      {(["expense", "income"] as const).map((dir) => (
        <div
          key={dir}
          {...drop(dir)}
          className={cn(
            "rounded-lg border border-dashed p-3 text-center text-muted-foreground text-xs transition-colors",
            dragging === dir && "border-primary bg-primary/5 text-foreground",
          )}
        >
          {dir === "expense" ? t("dropExpense") : t("dropIncome")}
        </div>
      ))}
    </div>
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
        {dropZone}
        <EmptyState icon={ReceiptTextIcon} title={pristine ? t("empty") : t("noResults")} />
      </ListLayout>
    );
  }
  const label = (r: (typeof results)[number]) => r.internalNumber ?? t("draft");
  const toggle = (id: string, on: boolean) =>
    setSelected((s) => (on ? [...new Set([...s, id])] : s.filter((x) => x !== id)));
  const grossSum = results.reduce((s, r) => s + (r.status === "cancelled" ? 0 : r.grossEurCents), 0);
  const openSum = results.reduce(
    (s, r) => s + (r.status === "cancelled" || r.status === "draft" ? 0 : r.openAmountCents),
    0,
  );
  return (
    <ListLayout
      filters={filters}
      toolbar={toolbar}
      table={
        <Table data-testid="vouchers-table">
          <TableHeader>
            <TableRow>
              <TableHead className="w-8">
                <span className="sr-only">{t("columns.select")}</span>
              </TableHead>
              <TableHead>{t("columns.status")}</TableHead>
              <TableHead>{t("columns.number")}</TableHead>
              <TableHead>{t("columns.supplier")}</TableHead>
              <TableHead>{t("columns.documentNumber")}</TableHead>
              <TableHead>{t("columns.date")}</TableHead>
              <TableHead>{t("columns.due")}</TableHead>
              <TableHead className="text-right">{t("columns.gross")}</TableHead>
              <TableHead className="text-right">{t("columns.open")}</TableHead>
              <TableHead>{t("columns.taxRule")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {results.map((r) => (
              <TableRow key={r._id} data-voucher={r._id}>
                <TableCell>
                  {r.status === "draft" && (
                    <Checkbox
                      checked={selected.includes(r._id)}
                      onCheckedChange={(on) => toggle(r._id, on)}
                      aria-label={t("selectRow", { label: r.supplierName ?? label(r) })}
                    />
                  )}
                </TableCell>
                <TableCell>
                  <VoucherStatusBadge status={r.status} label={r.statusLabel} overdue={r.overdue} />
                </TableCell>
                <TableCell className="tabular-nums">
                  <Link href={voucherPath(r._id)} className="font-medium hover:underline">
                    {label(r)}
                  </Link>
                  {!r.hasFile && <span className="ml-1 text-muted-foreground text-xs">({t("noFile")})</span>}
                </TableCell>
                <TableCell>{r.supplierName ?? "—"}</TableCell>
                <TableCell>{r.documentNumber ?? "—"}</TableCell>
                <TableCell className="tabular-nums">{formatDate(r.documentDate)}</TableCell>
                <TableCell className={cn("tabular-nums", r.overdue && "text-danger")}>
                  {formatDate(r.dueDate)}
                </TableCell>
                <TableCell className="text-right tabular-nums">{money(r.grossCents, r.currency)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {r.status === "draft" || r.status === "cancelled" ? "—" : money(r.openAmountCents)}
                </TableCell>
                <TableCell className="text-muted-foreground text-xs">{r.taxRuleLabel}</TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell colSpan={7}>{t("totalsRow")}</TableCell>
              <TableCell className="text-right tabular-nums">{money(grossSum)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(openSum)}</TableCell>
              <TableCell />
            </TableRow>
          </TableFooter>
        </Table>
      }
      cards={results.map((r) => (
        <article key={r._id} className="flex items-start justify-between gap-3 rounded-lg border p-3">
          <div className="flex min-w-0 flex-col items-start gap-1">
            <Link href={voucherPath(r._id)} className="font-medium hover:underline">
              {r.supplierName ?? label(r)}
            </Link>
            <span className="text-muted-foreground text-sm">
              {label(r)} · {formatDate(r.documentDate)}
            </span>
            <VoucherStatusBadge status={r.status} label={r.statusLabel} overdue={r.overdue} />
          </div>
          <span className="font-medium text-sm tabular-nums">{money(r.grossCents, r.currency)}</span>
        </article>
      ))}
    >
      {dropZone}
      {status === "CanLoadMore" && (
        <Button variant="outline" className="h-11 self-center md:h-9" onClick={() => loadMore(50)}>
          {t("loadMore")}
        </Button>
      )}
    </ListLayout>
  );
}

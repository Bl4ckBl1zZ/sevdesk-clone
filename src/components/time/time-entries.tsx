"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useMutation } from "convex/react";
import { ClockIcon, PencilIcon, PlusIcon } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { type ReactNode, useId, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  ConfirmDialog,
  formatDate,
  formatPrice,
  selectClass,
  useCan,
  useRun,
  useUrlState,
} from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { EmptyState } from "@/components/layout/empty-state";
import { ListLayout, StatusFilter } from "@/components/layout/list-layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { documentPath } from "@/domain/documents/doc-types";
import { formatEuro } from "@/domain/money/format";
import { formatMinutes, type TimeEntryStatus } from "@/domain/projects/time-entries";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { cn } from "@/lib/utils";
import { TimeEntryDialog } from "./entry-dialog";
import { InvoiceEntriesDialog } from "./invoice-dialog";
import { EntryStatusBadge, type TimeEntryRow, useClearFixedPageActions, useProjectOptions } from "./time-shared";
import { TimerCard } from "./timer";

const STATUSES = ["all", "open", "in_draft", "invoiced"] as const;
type StatusFilterValue = (typeof STATUSES)[number];

/** `/zeiten` (F11 §6): timer, Storno offers, filters in the URL and the entry list with bulk actions. */
export function TimePage() {
  return (
    <ConvexGuard fallback={<div className="h-96" aria-busy="true" />}>
      <TimePageInner />
    </ConvexGuard>
  );
}

function TimePageInner() {
  const t = useTranslations("time.list");
  const url = useUrlState();
  const status: StatusFilterValue = (STATUSES as readonly string[]).includes(url.get("status"))
    ? (url.get("status") as StatusFilterValue)
    : "all";
  const from = url.get("from");
  const to = url.get("to");
  const projectId = url.get("project");
  const billable = url.get("billable");
  const projects = useProjectOptions();
  const ids = { from: useId(), to: useId(), project: useId(), billable: useId() };

  const args = useMemo(
    () => ({
      ...(status !== "all" ? { status } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(projectId ? { projectId: projectId as Id<"projects"> } : {}),
      ...(billable === "yes" ? { billable: true } : billable === "no" ? { billable: false } : {}),
    }),
    [status, from, to, projectId, billable],
  );

  const filters = (
    <>
      <TimerCard />
      <ReopenBanners />
      <StatusFilter
        label={t("statusLabel")}
        current={status}
        options={STATUSES.map((s) => ({
          value: s,
          label: t(`status.${s}`),
          href: url.hrefWith({ status: s === "all" ? "" : s }),
        }))}
      />
    </>
  );
  const toolbar = (
    <>
      <FilterField id={ids.from} label={t("from")}>
        <Input
          id={ids.from}
          type="date"
          className="h-11 w-auto md:h-9"
          value={from}
          onChange={(e) => url.set({ from: e.target.value })}
        />
      </FilterField>
      <FilterField id={ids.to} label={t("to")}>
        <Input
          id={ids.to}
          type="date"
          className="h-11 w-auto md:h-9"
          value={to}
          onChange={(e) => url.set({ to: e.target.value })}
        />
      </FilterField>
      <FilterField id={ids.project} label={t("project")}>
        <select
          id={ids.project}
          className={selectClass}
          value={projectId}
          onChange={(e) => url.set({ project: e.target.value })}
        >
          <option value="">{t("allProjects")}</option>
          {projects.map((p) => (
            <option key={p._id} value={p._id}>
              {p.name}
            </option>
          ))}
        </select>
      </FilterField>
      <FilterField id={ids.billable} label={t("billable")}>
        <select
          id={ids.billable}
          className={selectClass}
          value={billable}
          onChange={(e) => url.set({ billable: e.target.value })}
        >
          <option value="">{t("billableAll")}</option>
          <option value="yes">{t("billableYes")}</option>
          <option value="no">{t("billableNo")}</option>
        </select>
      </FilterField>
    </>
  );
  return <TimeEntryList args={args} filters={filters} toolbar={toolbar} pristine={Object.keys(args).length === 0} />;
}

function FilterField({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-muted-foreground text-xs">
        {label}
      </label>
      {children}
    </div>
  );
}

/** E-PRJ-25: entries of a cancelled invoice can be made billable again. */
export function ReopenBanners() {
  const t = useTranslations("time.reopen");
  const offers = useAuthedQuery(api.timeEntries.reopenOffers, {}) ?? [];
  const canWrite = useCan("time.write");
  const reopen = useMutation(api.timeEntries.reopen);
  const run = useRun();
  if (offers.length === 0) return null;
  return (
    <ul className="flex flex-col gap-2" data-testid="reopen-banners">
      {offers.map((o) => (
        <li
          key={o.invoiceId}
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm"
        >
          <span>{t("banner", { number: o.number, count: o.count })}</span>
          {canWrite && (
            <Button
              variant="outline"
              className="h-11 md:h-9"
              onClick={async () => {
                const r = await run(() => reopen({ invoiceId: o.invoiceId }));
                if (r.ok) toast.success(t("done", { count: r.value.reopened }));
              }}
            >
              {t("action")}
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Entry list (F11 §6): table on wide containers, cards on narrow ones; open entries are selectable for the bulk
 * actions „Abrechnen“, „Als nicht abrechenbar markieren“ and „Löschen“; in-draft and invoiced entries are locked.
 */
export function TimeEntryList({
  args,
  filters,
  toolbar,
  projectId,
  pristine,
}: {
  args: {
    projectId?: Id<"projects">;
    status?: TimeEntryStatus;
    from?: string;
    to?: string;
    billable?: boolean;
  };
  filters?: ReactNode;
  toolbar?: ReactNode;
  /** Preselects the project in „Zeit erfassen“. */
  projectId?: string;
  pristine?: boolean;
}) {
  const t = useTranslations("time.list");
  const rows = useAuthedQuery(api.timeEntries.list, args);
  const canWrite = useCan("time.write");
  const run = useRun();
  const setBillable = useMutation(api.timeEntries.setBillableFlag);
  const remove = useMutation(api.timeEntries.remove);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<TimeEntryRow | "new" | null>(null);
  const [invoicing, setInvoicing] = useState<TimeEntryRow[] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const open = (rows ?? []).filter((r) => r.status === "open");
  const chosen = open.filter((r) => selected.has(r._id));
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allChosen = open.length > 0 && chosen.length === open.length;
  // Phone: on pages with header actions (project page) the fixed action bar would cover the bulk bar.
  const bulkBottom = useClearFixedPageActions(canWrite && chosen.length > 0);

  const newButton = canWrite && (
    <Button className="h-11 md:ml-auto md:h-9" onClick={() => setEditing("new")}>
      <PlusIcon aria-hidden="true" />
      {t("new")}
    </Button>
  );
  const fullToolbar = (
    <>
      {toolbar}
      {newButton}
    </>
  );
  const dialogs = (
    <>
      {editing && (
        <TimeEntryDialog
          entry={editing === "new" ? undefined : editing}
          projectId={projectId}
          onClose={() => setEditing(null)}
        />
      )}
      {invoicing && (
        <InvoiceEntriesDialog
          candidates={invoicing}
          onClose={() => {
            setInvoicing(null);
            setSelected(new Set());
          }}
        />
      )}
      {confirmDelete && (
        <ConfirmDialog
          title={t("deleteTitle", { count: chosen.length })}
          description={t("deleteDescription")}
          confirmLabel={t("bulk.delete")}
          destructive
          onClose={() => setConfirmDelete(false)}
          onConfirm={async () => {
            const r = await run(() => remove({ ids: chosen.map((c) => c._id) }));
            if (!r.ok) return;
            toast.success(t("deleted", { count: r.value.deleted }));
            setSelected(new Set());
            setConfirmDelete(false);
          }}
        />
      )}
    </>
  );

  if (rows === undefined) {
    return (
      <ListLayout filters={filters} toolbar={fullToolbar}>
        <div className="h-64" aria-busy="true" />
      </ListLayout>
    );
  }
  if (rows.length === 0) {
    return (
      <ListLayout filters={filters} toolbar={fullToolbar}>
        <EmptyState icon={ClockIcon} title={pristine ? t("empty") : t("noResults")} />
        {dialogs}
      </ListLayout>
    );
  }

  const totalMinutes = rows.reduce((s, r) => s + r.durationMinutes, 0);
  const totalValue = rows.filter((r) => r.billable).reduce((s, r) => s + r.valueCents, 0);
  const setFlag = async (billable: boolean) => {
    const r = await run(() => setBillable({ ids: chosen.map((c) => c._id), billable }));
    if (!r.ok) return;
    toast.success(t("updated", { count: r.value.updated }));
    setSelected(new Set());
  };

  const bulkBar =
    canWrite && chosen.length > 0 ? (
      <div
        role="toolbar"
        aria-label={t("bulk.label")}
        data-testid="time-bulk-bar"
        style={bulkBottom !== null ? { bottom: bulkBottom } : undefined}
        className="sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-10 flex flex-wrap items-center gap-2 rounded-lg border bg-background p-2 shadow-sm md:bottom-2"
      >
        <span className="px-1 text-sm">{t("selected", { count: chosen.length })}</span>
        <Button className="h-11 md:h-9" onClick={() => setInvoicing(chosen)}>
          {t("bulk.invoice")}
        </Button>
        {chosen.some((c) => c.billable) ? (
          <Button variant="outline" className="h-11 md:h-9" onClick={() => void setFlag(false)}>
            {t("bulk.nonBillable")}
          </Button>
        ) : (
          <Button variant="outline" className="h-11 md:h-9" onClick={() => void setFlag(true)}>
            {t("bulk.billable")}
          </Button>
        )}
        <Button variant="outline" className="h-11 text-danger md:h-9" onClick={() => setConfirmDelete(true)}>
          {t("bulk.delete")}
        </Button>
      </div>
    ) : null;

  const who = (r: TimeEntryRow) => r.projectName ?? r.contactName ?? "—";
  const flags = (r: TimeEntryRow) => (
    <>
      {!r.billable && <Badge variant="outline">{t("nonBillable")}</Badge>}
      {r.incomplete && (
        <Badge variant="outline" className="border-warning">
          {t("incomplete")}
        </Badge>
      )}
      {r.flaggedForReview && <Badge variant="outline">{t("flagged")}</Badge>}
    </>
  );
  const docLink = (r: TimeEntryRow) =>
    r.document ? (
      <Link
        href={documentPath("invoice", r.document._id) as Route}
        className="text-muted-foreground text-xs hover:underline"
        title={r.status === "invoiced" ? t("lockedHint") : undefined}
      >
        {r.document.number ?? t("draftDocument")}
      </Link>
    ) : null;
  const checkbox = (r: TimeEntryRow) =>
    canWrite && r.status === "open" ? (
      <input
        type="checkbox"
        className="size-5 md:size-4"
        checked={selected.has(r._id)}
        onChange={() => toggle(r._id)}
        aria-label={t("selectRow", { description: r.description || t("noDescription") })}
      />
    ) : null;
  const editButton = (r: TimeEntryRow) =>
    canWrite && r.status === "open" ? (
      <Button variant="ghost" size="icon" className="size-11 md:size-8" onClick={() => setEditing(r)}>
        <PencilIcon aria-hidden="true" />
        <span className="sr-only">{t("edit")}</span>
      </Button>
    ) : null;

  return (
    <ListLayout
      filters={filters}
      toolbar={fullToolbar}
      table={
        <Table data-testid="time-table">
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                {canWrite && open.length > 0 && (
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={allChosen}
                    onChange={() => setSelected(allChosen ? new Set() : new Set(open.map((o) => o._id)))}
                    aria-label={t("selectAll")}
                  />
                )}
              </TableHead>
              <TableHead>{t("columns.date")}</TableHead>
              <TableHead>{t("columns.description")}</TableHead>
              <TableHead>{t("columns.project")}</TableHead>
              <TableHead className="text-right">{t("columns.duration")}</TableHead>
              <TableHead className="text-right">{t("columns.rate")}</TableHead>
              <TableHead className="text-right">{t("columns.value")}</TableHead>
              <TableHead>{t("columns.status")}</TableHead>
              <TableHead className="w-10">
                <span className="sr-only">{t("columns.actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r._id} data-status={r.status}>
                <TableCell>{checkbox(r)}</TableCell>
                <TableCell className="tabular-nums">{formatDate(r.date)}</TableCell>
                <TableCell className="max-w-80">
                  <span className="block truncate">{r.description || t("noDescription")}</span>
                  <span className="flex flex-wrap gap-1">{flags(r)}</span>
                </TableCell>
                <TableCell>
                  {r.projectId ? (
                    <Link href={`/projekte/${r.projectId}` as Route} className="hover:underline">
                      {who(r)}
                    </Link>
                  ) : (
                    who(r)
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatMinutes(r.durationMinutes)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatPrice(r.hourlyRateMicros)}</TableCell>
                <TableCell className={cn("text-right tabular-nums", !r.billable && "text-muted-foreground")}>
                  {formatEuro(r.valueCents)}
                </TableCell>
                <TableCell>
                  <span className="flex flex-col items-start gap-0.5">
                    <EntryStatusBadge status={r.status} />
                    {docLink(r)}
                  </span>
                </TableCell>
                <TableCell>{editButton(r)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      }
      cards={rows.map((r) => (
        <article key={r._id} className="flex items-start gap-3 rounded-lg border p-3" data-testid="time-card">
          {checkbox(r)}
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="font-medium">{r.description || t("noDescription")}</span>
            <span className="text-muted-foreground text-sm">
              {formatDate(r.date)} · {who(r)}
            </span>
            <span className="flex flex-wrap items-center gap-1">
              <EntryStatusBadge status={r.status} />
              {flags(r)}
              {docLink(r)}
            </span>
          </div>
          <div className="flex flex-col items-end gap-1 text-sm tabular-nums">
            <span className="font-medium">{formatMinutes(r.durationMinutes)}</span>
            <span className="text-muted-foreground text-xs">{formatEuro(r.valueCents)}</span>
            {editButton(r)}
          </div>
        </article>
      ))}
    >
      <p className="text-muted-foreground text-sm tabular-nums" data-testid="time-total">
        {t("total", { count: rows.length, duration: formatMinutes(totalMinutes), value: formatEuro(totalValue) })}
      </p>
      {bulkBar}
      {dialogs}
    </ListLayout>
  );
}

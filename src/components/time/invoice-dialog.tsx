"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useMutation } from "convex/react";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { type ReactNode, useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { formatDate, formatPrice, selectClass, useCan, useRun } from "@/components/catalog/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { documentPath } from "@/domain/documents/doc-types";
import { formatEuro, formatMilli } from "@/domain/money/format";
import { TIME_GROUPINGS, type TimeGrouping } from "@/domain/projects/invoicing";
import { formatMinutes } from "@/domain/projects/time-entries";
import type { InvoiceFromEntriesValues } from "@/domain/schemas/projects";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import type { TimeEntryRow } from "./time-shared";

const INCREMENTS = ["default", "0", "1", "5", "6", "10", "15", "30", "60"] as const;
type Increment = (typeof INCREMENTS)[number];

/** Dialog values → `invoiceFromEntriesSchema` input (exported for the tests). */
export function invoiceValues(s: {
  entryIds: readonly string[];
  grouping: TimeGrouping;
  unit: "" | "HUR" | "MIN";
  increment: Increment;
  mode: "up" | "nearest";
  perGroup: boolean;
}): InvoiceFromEntriesValues {
  return {
    entryIds: [...s.entryIds],
    grouping: s.grouping,
    ...(s.unit ? { unit: s.unit } : {}),
    ...(s.increment !== "default"
      ? {
          rounding: {
            incrementMinutes: Number(s.increment) as NonNullable<
              InvoiceFromEntriesValues["rounding"]
            >["incrementMinutes"],
            mode: s.mode,
          },
        }
      : {}),
    ...(s.perGroup ? { perGroup: true } : {}),
  };
}

/**
 * „Zeiten abrechnen“ (F11 §6, PRJ-009…013): entry table with checkboxes, grouping, unit and rounding with a live
 * preview (raw vs rounded minutes, amounts, supply period), target „Neuer Entwurf“ or an open draft of the customer.
 */
export function InvoiceEntriesDialog({
  candidates,
  initialSelected,
  onClose,
}: {
  candidates: readonly TimeEntryRow[];
  initialSelected?: readonly string[];
  onClose: () => void;
}) {
  const t = useTranslations("time.invoice");
  const tf = useTranslations("projects.form");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const run = useRun();
  const create = useMutation(api.timeEntries.createInvoice);
  const canInvoice = useCan("documents.write");
  const canReadDocs = useCan("documents.read");
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initialSelected ?? candidates.map((c) => c._id)));
  const [grouping, setGrouping] = useState<TimeGrouping>("per_entry");
  const [unit, setUnit] = useState<"" | "HUR" | "MIN">("");
  const [increment, setIncrement] = useState<Increment>("default");
  const [mode, setMode] = useState<"up" | "nearest">("up");
  const [perGroup, setPerGroup] = useState(false);
  /** PRJ-014: null = the project's default. */
  const [attach, setAttach] = useState<boolean | null>(null);
  const [target, setTarget] = useState("new");
  const [busy, setBusy] = useState(false);
  const ids = {
    grouping: useId(),
    unit: useId(),
    increment: useId(),
    mode: useId(),
    target: useId(),
    pg: useId(),
    ts: useId(),
  };

  const values = useMemo(
    () =>
      invoiceValues({
        entryIds: candidates.filter((c) => selected.has(c._id)).map((c) => c._id),
        grouping,
        unit,
        increment,
        mode,
        perGroup,
      }),
    [candidates, selected, grouping, unit, increment, mode, perGroup],
  );
  const preview = useAuthedQuery(api.timeEntries.previewInvoice, { values }, values.entryIds.length > 0);
  const contactId = preview?.ok ? preview.plan.contactId : undefined;
  const drafts =
    useAuthedQuery(
      api.timeEntries.draftsOfContact,
      { contactId: (contactId ?? "") as Id<"contacts"> },
      Boolean(contactId) && canReadDocs,
    ) ?? [];
  const draftTarget = drafts.some((d) => d._id === target) ? target : "new";
  const attachTimesheet = attach ?? (preview?.ok ? preview.timesheetDefault : false);

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const submit = async () => {
    setBusy(true);
    const r = await run(() =>
      create({
        values: { ...values, attachTimesheet, ...(draftTarget !== "new" ? { draftId: draftTarget } : {}) },
      }),
    );
    setBusy(false);
    if (!r.ok) return;
    toast.success(draftTarget !== "new" ? t("appended") : t("created"));
    for (const n of r.value.notices) toast.info(n);
    onClose();
    router.push(documentPath("invoice", r.value.id) as Route);
  };

  const plan = preview?.ok ? preview.plan : null;
  const total = plan ? plan.lines.reduce((s, l) => s + l.netCents, 0) : 0;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description", { count: values.entryIds.length })}</DialogDescription>
        </DialogHeader>
        <div className="@container/form flex flex-col gap-4">
          <fieldset className="flex flex-col gap-1">
            <legend className="sr-only">{t("title")}</legend>
            <ul className="flex max-h-56 flex-col divide-y overflow-y-auto rounded-md border">
              {candidates.map((c) => (
                <li key={c._id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-5 md:size-4"
                    checked={selected.has(c._id)}
                    onChange={() => toggle(c._id)}
                    aria-label={c.description || formatDate(c.date)}
                  />
                  <span className="w-24 shrink-0 tabular-nums">{formatDate(c.date)}</span>
                  <span className="min-w-0 flex-1 truncate">{c.description}</span>
                  <span className="shrink-0 tabular-nums">{formatMinutes(c.durationMinutes)}</span>
                </li>
              ))}
            </ul>
          </fieldset>
          <div className="grid gap-3 @lg/form:grid-cols-2">
            <Labeled id={ids.grouping} label={t("grouping")}>
              <select
                id={ids.grouping}
                className={selectClass}
                value={grouping}
                onChange={(e) => setGrouping(e.target.value as TimeGrouping)}
              >
                {TIME_GROUPINGS.map((g) => (
                  <option key={g} value={g}>
                    {t(`groupings.${g}`)}
                  </option>
                ))}
              </select>
            </Labeled>
            <Labeled id={ids.unit} label={t("unit")}>
              <select
                id={ids.unit}
                className={selectClass}
                value={unit}
                onChange={(e) => setUnit(e.target.value as "" | "HUR" | "MIN")}
              >
                <option value="">{t("unitDefault")}</option>
                <option value="HUR">{t("units.HUR")}</option>
                <option value="MIN">{t("units.MIN")}</option>
              </select>
            </Labeled>
            <Labeled id={ids.increment} label={t("rounding")}>
              <select
                id={ids.increment}
                className={selectClass}
                value={increment}
                onChange={(e) => setIncrement(e.target.value as Increment)}
              >
                {INCREMENTS.map((i) => (
                  <option key={i} value={i}>
                    {i === "default"
                      ? t("roundingDefault")
                      : i === "0"
                        ? tf("roundingNone")
                        : tf("minutes", { count: Number(i) })}
                  </option>
                ))}
              </select>
            </Labeled>
            {increment !== "default" && increment !== "0" && (
              <Labeled id={ids.mode} label={tf("roundingMode")}>
                <select
                  id={ids.mode}
                  className={selectClass}
                  value={mode}
                  onChange={(e) => setMode(e.target.value as "up" | "nearest")}
                >
                  <option value="up">{tf("roundingModes.up")}</option>
                  <option value="nearest">{tf("roundingModes.nearest")}</option>
                </select>
              </Labeled>
            )}
            {grouping !== "per_entry" && (
              <label htmlFor={ids.pg} className="flex min-h-11 items-center gap-2 text-sm @lg/form:col-span-2">
                <input
                  id={ids.pg}
                  type="checkbox"
                  className="size-5 md:size-4"
                  checked={perGroup}
                  onChange={(e) => setPerGroup(e.target.checked)}
                />
                {t("perGroup")}
              </label>
            )}
            <label htmlFor={ids.ts} className="flex min-h-11 items-center gap-2 text-sm @lg/form:col-span-2">
              <input
                id={ids.ts}
                type="checkbox"
                className="size-5 md:size-4"
                checked={attachTimesheet}
                onChange={(e) => setAttach(e.target.checked)}
              />
              {t("attachTimesheet")}
            </label>
            {drafts.length > 0 && (
              <Labeled id={ids.target} label={t("target")}>
                <select
                  id={ids.target}
                  className={selectClass}
                  value={draftTarget}
                  onChange={(e) => setTarget(e.target.value)}
                >
                  <option value="new">{t("targetNew")}</option>
                  {drafts.map((d) => (
                    <option key={d._id} value={d._id}>
                      {t("targetDraft", { name: d.subject ?? t("draftUntitled") })}
                    </option>
                  ))}
                </select>
              </Labeled>
            )}
          </div>
          <section aria-label={t("preview")} data-testid="invoice-preview" className="flex flex-col gap-2">
            <h3 className="font-semibold text-sm">{t("preview")}</h3>
            {values.entryIds.length > 0 && preview === undefined && (
              <p className="text-muted-foreground text-sm" aria-busy="true">
                {t("loading")}
              </p>
            )}
            {preview && !preview.ok && (
              <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 p-3 text-sm">
                {preview.error.message}
              </p>
            )}
            {plan && (
              <>
                <Table scrollLabel={t("previewTable")}>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("columns.line")}</TableHead>
                      <TableHead className="text-right">{t("columns.raw")}</TableHead>
                      <TableHead className="text-right">{t("columns.rounded")}</TableHead>
                      <TableHead className="text-right">{t("columns.quantity")}</TableHead>
                      <TableHead className="text-right">{t("columns.price")}</TableHead>
                      <TableHead className="text-right">{t("columns.net")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {plan.lines.map((l) => (
                      <TableRow key={`${l.name}-${l.timeEntryIds.join(",")}`}>
                        <TableCell>
                          {l.name}
                          {l.description && (
                            <span className="block text-muted-foreground text-xs">{l.description}</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{formatMinutes(l.rawMinutes)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatMinutes(l.roundedMinutes)}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatMilli(l.quantityMilli)} {t(`units.${l.unitCode}`)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{formatPrice(l.unitPriceMicros)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatEuro(l.netCents)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                  <TableFooter>
                    <TableRow>
                      <TableCell colSpan={5}>{t("total")}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatEuro(total)}</TableCell>
                    </TableRow>
                  </TableFooter>
                </Table>
                <p className="text-sm">
                  {plan.supplyDate.kind === "date"
                    ? t("supplyDate", { date: formatDate(plan.supplyDate.date) })
                    : t("supplyPeriod", { from: formatDate(plan.supplyDate.from), to: formatDate(plan.supplyDate.to) })}
                </p>
                {plan.notices.length > 0 && (
                  <ul className="flex flex-col gap-1 text-sm" role="status">
                    {plan.notices.map((n) => (
                      <li key={n} className="rounded-md border border-warning/40 bg-warning/10 p-2">
                        {n}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
            {!canInvoice && <p className="text-muted-foreground text-sm">{t("noPermission")}</p>}
          </section>
        </div>
        <DialogFooter>
          <Button variant="outline" className="h-11 md:h-9" onClick={onClose}>
            {tCommon("cancel")}
          </Button>
          <Button className="h-11 md:h-9" disabled={!plan || !canInvoice || busy} onClick={() => void submit()}>
            {draftTarget !== "new" ? t("submitAppend") : t("submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Labeled({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="font-medium text-sm">
        {label}
      </label>
      {children}
    </div>
  );
}

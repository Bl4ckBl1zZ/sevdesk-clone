"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { cn } from "cn";
import { useConvex, useMutation } from "convex/react";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { DownloadIcon, LockIcon, PlusIcon, PrinterIcon, Undo2Icon } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { amountFilterCents, JOURNAL_SORTS, type JournalSort, journalCsv } from "@/domain/accounting/journal-search";
import { csvFileName } from "@/domain/csv/export";
import { useAdapterErrorToast } from "@/hooks/use-adapter-error-toast";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { dateDe, euro, periodDe } from "./format";

type Search = FunctionReturnType<typeof api.accounting.searchJournal>;
type Entry = Search["page"][number];
type Filter = Omit<FunctionArgs<typeof api.accounting.searchJournal>, "offset" | "limit">;

const PAGE_SIZE = 50;

export const SELECT =
  "h-11 rounded-md border border-input bg-background px-2.5 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:h-9 md:text-sm dark:bg-input/30";

const SOURCE_KINDS = [
  "salesDocument",
  "voucher",
  "payment",
  "bankTransaction",
  "cashTransfer",
  "asset_depreciation",
  "manual",
  "opening_balance",
] as const;

const berlinToday = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });

const monthRange = (month: string) => {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
};

interface FormState {
  month: string;
  from: string;
  to: string;
  account: string;
  sourceKind: string;
  text: string;
  min: string;
  max: string;
  late: boolean;
  reversals: "" | "only" | "exclude";
  actor: string;
  sort: JournalSort;
}

const EMPTY: FormState = {
  month: "",
  from: "",
  to: "",
  account: "",
  sourceKind: "",
  text: "",
  min: "",
  max: "",
  late: false,
  reversals: "",
  actor: "",
  sort: "seq_desc",
};

/** Builds the query filter from the form; `null` while an amount is invalid. */
function filterOf(f: FormState): Filter | null {
  const min = amountFilterCents(f.min);
  const max = amountFilterCents(f.max);
  if (min === null || max === null) return null;
  const range = /^\d{4}-\d{2}$/.test(f.month)
    ? monthRange(f.month)
    : {
        ...(/^\d{4}-\d{2}-\d{2}$/.test(f.from) ? { from: f.from } : {}),
        ...(/^\d{4}-\d{2}-\d{2}$/.test(f.to) ? { to: f.to } : {}),
      };
  return {
    ...range,
    ...(f.account.trim() ? { account: f.account.trim() } : {}),
    ...(f.sourceKind ? { sourceKind: f.sourceKind } : {}),
    ...(f.text.trim() ? { text: f.text.trim() } : {}),
    ...(min !== undefined ? { minCents: min } : {}),
    ...(max !== undefined ? { maxCents: max } : {}),
    ...(f.late ? { late: true } : {}),
    ...(f.reversals ? { reversals: f.reversals } : {}),
    ...(f.actor.trim() ? { actor: f.actor.trim() } : {}),
    ...(f.sort !== "seq_desc" ? { sort: f.sort } : {}),
  };
}

/**
 * Journal (F08 §6 /buchhaltung/journal; ACC-001/ACC-003/ACC-025, RPT-008): filters (period, account, source kind,
 * text, amount range, late postings, reversals, actor), sorting by `seq` or date, table on wide containers and cards
 * on narrow ones, CSV export of the Buchungsjournal and a print view; a row opens the side sheet with all lines,
 * source, rule versions and „Warum dieses Konto?“. „Manuelle Buchung“ (primary) and „Gegenbuchung“ (manual entries
 * only) need `accounting.write`.
 */
export function JournalViewer({ canWrite = false }: { canWrite?: boolean }) {
  return (
    <ConvexGuard fallback={null}>
      <JournalViewerInner canWrite={canWrite} />
    </ConvexGuard>
  );
}

function JournalViewerInner({ canWrite }: { canWrite: boolean }) {
  const t = useTranslations("accounting.journal");
  const [form, setForm] = useState<FormState>(EMPTY);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const filter = useMemo(() => filterOf(form), [form]);
  const data = useAuthedQuery(api.accounting.searchJournal, { ...(filter ?? {}), limit }, filter !== null);
  const [open, setOpen] = useState<Entry | null>(null);
  const update = (patch: Partial<FormState>) => {
    setForm((f) => ({ ...f, ...patch }));
    setLimit(PAGE_SIZE);
  };
  const filtered = Object.keys(filter ?? {}).some((k) => k !== "sort");
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-prose text-muted-foreground text-sm">{t("readOnly")}</p>
        <div className="flex flex-wrap gap-2 print:hidden">
          <ExportButton filter={filter} />
          <Button variant="outline" className="h-11 md:h-9" onClick={() => window.print()}>
            <PrinterIcon aria-hidden="true" />
            {t("print")}
          </Button>
          {canWrite && (
            <Link href={"/buchhaltung/journal/neu" as Route} className={cn(buttonVariants(), "h-11 md:h-9")}>
              <PlusIcon aria-hidden="true" />
              {t("newManual")}
            </Link>
          )}
        </div>
      </div>
      <FilterBar form={form} update={update} reset={() => update(EMPTY)} invalidAmount={filter === null} />
      {data === undefined ? (
        <div className="h-40" aria-busy="true" />
      ) : data.page.length === 0 ? (
        <p className="rounded-lg border p-6 text-center text-muted-foreground text-sm">
          {filtered ? t("emptyFiltered") : t("empty")}
        </p>
      ) : (
        <>
          <p className="text-muted-foreground text-sm" aria-live="polite">
            {t("resultCount", { count: data.total, sum: euro(data.totalCents) })}
          </p>
          <div className="hidden @3xl/main:block print:block">
            <JournalTable entries={data.page} onOpen={setOpen} />
          </div>
          <ul className="flex flex-col gap-2 @3xl/main:hidden print:hidden">
            {data.page.map((e) => (
              <li key={e.id}>
                <EntryCard entry={e} onOpen={() => setOpen(e)} />
              </li>
            ))}
          </ul>
        </>
      )}
      {data && data.total > data.page.length && (
        <Button
          variant="outline"
          className="h-11 self-center md:h-9 print:hidden"
          onClick={() => setLimit((l) => Math.min(200, l + PAGE_SIZE))}
          disabled={limit >= 200}
        >
          {t("loadMore")}
        </Button>
      )}
      <EntrySheet entry={open} canWrite={canWrite} onClose={() => setOpen(null)} />
    </div>
  );
}

function FilterBar({
  form,
  update,
  reset,
  invalidAmount,
}: {
  form: FormState;
  update: (p: Partial<FormState>) => void;
  reset: () => void;
  invalidAmount: boolean;
}) {
  const t = useTranslations("accounting.journal");
  const id = useId();
  const field = (key: string) => `${id}-${key}`;
  return (
    <search aria-label={t("filters")} className="flex flex-col gap-3 rounded-lg border p-3 print:hidden">
      <div className="grid @xl/main:grid-cols-3 @4xl/main:grid-cols-6 grid-cols-1 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={field("month")}>{t("periodLabel")}</Label>
          <Input
            id={field("month")}
            type="month"
            className="h-11 md:h-9"
            value={form.month}
            onChange={(e) => update({ month: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={field("from")}>{t("from")}</Label>
          <Input
            id={field("from")}
            type="date"
            className="h-11 md:h-9"
            value={form.from}
            disabled={form.month !== ""}
            onChange={(e) => update({ from: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={field("to")}>{t("to")}</Label>
          <Input
            id={field("to")}
            type="date"
            className="h-11 md:h-9"
            value={form.to}
            disabled={form.month !== ""}
            onChange={(e) => update({ to: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={field("account")}>{t("accountFilter")}</Label>
          <Input
            id={field("account")}
            inputMode="numeric"
            className="h-11 md:h-9"
            value={form.account}
            onChange={(e) => update({ account: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={field("source")}>{t("sourceKind")}</Label>
          <select
            id={field("source")}
            className={SELECT}
            value={form.sourceKind}
            onChange={(e) => update({ sourceKind: e.target.value })}
          >
            <option value="">{t("all")}</option>
            {SOURCE_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`sourceKinds.${k}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={field("text")}>{t("textFilter")}</Label>
          <Input
            id={field("text")}
            type="search"
            className="h-11 md:h-9"
            value={form.text}
            onChange={(e) => update({ text: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={field("min")}>{t("minAmount")}</Label>
          <Input
            id={field("min")}
            inputMode="decimal"
            className="h-11 md:h-9"
            value={form.min}
            aria-invalid={invalidAmount && amountFilterCents(form.min) === null}
            onChange={(e) => update({ min: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={field("max")}>{t("maxAmount")}</Label>
          <Input
            id={field("max")}
            inputMode="decimal"
            className="h-11 md:h-9"
            value={form.max}
            aria-invalid={invalidAmount && amountFilterCents(form.max) === null}
            onChange={(e) => update({ max: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={field("reversals")}>{t("reversals")}</Label>
          <select
            id={field("reversals")}
            className={SELECT}
            value={form.reversals}
            onChange={(e) => update({ reversals: e.target.value as FormState["reversals"] })}
          >
            <option value="">{t("all")}</option>
            <option value="only">{t("reversalsOnly")}</option>
            <option value="exclude">{t("reversalsExclude")}</option>
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={field("actor")}>{t("actor")}</Label>
          <Input
            id={field("actor")}
            className="h-11 md:h-9"
            placeholder="user:…"
            value={form.actor}
            onChange={(e) => update({ actor: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={field("sort")}>{t("sort")}</Label>
          <select
            id={field("sort")}
            className={SELECT}
            value={form.sort}
            onChange={(e) => update({ sort: e.target.value as JournalSort })}
          >
            {JOURNAL_SORTS.map((s) => (
              <option key={s} value={s}>
                {t(`sorts.${s}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2 self-end pb-2">
          <Checkbox id={field("late")} checked={form.late} onCheckedChange={(v) => update({ late: v === true })} />
          <Label htmlFor={field("late")} className="font-normal">
            {t("lateOnly")}
          </Label>
        </div>
      </div>
      {invalidAmount && (
        <p className="text-destructive text-sm" role="alert">
          {t("invalidAmount")}
        </p>
      )}
      <Button variant="ghost" className="h-11 self-start md:h-9" onClick={reset}>
        {t("resetFilters")}
      </Button>
    </search>
  );
}

function ExportButton({ filter }: { filter: Filter | null }) {
  const t = useTranslations("accounting.journal");
  const convex = useConvex();
  const showError = useAdapterErrorToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="outline"
      className="h-11 md:h-9"
      disabled={busy || filter === null}
      onClick={async () => {
        if (!filter) return;
        setBusy(true);
        try {
          const rows = await convex.query(api.accounting.journalReport, filter);
          const blob = new Blob([journalCsv(rows)], { type: "text/csv;charset=utf-8" });
          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url;
          link.download = csvFileName("buchungsjournal", "excel", berlinToday());
          link.click();
          URL.revokeObjectURL(url);
        } catch (e) {
          showError(e);
        } finally {
          setBusy(false);
        }
      }}
    >
      <DownloadIcon aria-hidden="true" />
      {t("exportCsv")}
    </Button>
  );
}

const sideAccounts = (e: Entry, side: "debit" | "credit") =>
  [...new Set(e.lines.filter((l) => (side === "debit" ? l.debitCents : l.creditCents) > 0).map((l) => l.account))].join(
    ", ",
  );

const taxKeys = (e: Entry) => [...new Set(e.lines.map((l) => l.taxKey).filter(Boolean))].join(", ");

function JournalTable({ entries, onOpen }: { entries: Entry[]; onOpen: (e: Entry) => void }) {
  const t = useTranslations("accounting.journal");
  return (
    <Table aria-label={t("tableLabel")}>
      <TableHeader>
        <TableRow>
          <TableHead className="w-16 text-right">{t("columns.seq")}</TableHead>
          <TableHead>{t("columns.date")}</TableHead>
          <TableHead>{t("columns.source")}</TableHead>
          <TableHead>{t("columns.text")}</TableHead>
          <TableHead>{t("columns.debit")}</TableHead>
          <TableHead>{t("columns.credit")}</TableHead>
          <TableHead className="text-right">{t("columns.amount")}</TableHead>
          <TableHead>{t("columns.taxKey")}</TableHead>
          <TableHead>
            <span className="sr-only">{t("locked")}</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((e) => (
          <TableRow key={e.id}>
            <TableCell className="text-right tabular-nums">
              <button
                type="button"
                className="rounded font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2"
                onClick={() => onOpen(e)}
                aria-label={t("open", { seq: e.seq })}
              >
                {e.seq}
              </button>
            </TableCell>
            <TableCell className="tabular-nums">{dateDe(e.date)}</TableCell>
            <TableCell>{e.source.label}</TableCell>
            <TableCell className="max-w-72 truncate" title={e.text}>
              {e.text}
              {e.reversalOfSeq !== undefined && (
                <span className="ml-2 text-muted-foreground text-xs">{t("reversalOf", { seq: e.reversalOfSeq })}</span>
              )}
              {e.latePostingReason && <span className="ml-2 text-muted-foreground text-xs">{t("latePosting")}</span>}
            </TableCell>
            <TableCell className="font-mono text-xs">{sideAccounts(e, "debit")}</TableCell>
            <TableCell className="font-mono text-xs">{sideAccounts(e, "credit")}</TableCell>
            <TableCell className="text-right tabular-nums">{euro(e.totalCents)}</TableCell>
            <TableCell className="text-xs">{taxKeys(e)}</TableCell>
            <TableCell>{e.locked && <LockIcon className="size-4" aria-label={t("locked")} />}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function EntryCard({ entry: e, onOpen }: { entry: Entry; onOpen: () => void }) {
  const t = useTranslations("accounting.journal");
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t("open", { seq: e.seq })}
      className="flex min-h-14 w-full flex-col gap-1 rounded-lg border p-3 text-left text-sm hover:bg-muted"
    >
      <span className="flex items-center justify-between gap-2">
        <span className="font-medium">
          {t("columns.seq")} {e.seq} · {dateDe(e.date)}
        </span>
        <span className="tabular-nums">{euro(e.totalCents)}</span>
      </span>
      <span className="truncate">{e.text}</span>
      <span className="font-mono text-muted-foreground text-xs">
        {t("columns.debit")} {sideAccounts(e, "debit")} · {t("columns.credit")} {sideAccounts(e, "credit")}
      </span>
    </button>
  );
}

function EntrySheet({ entry: e, canWrite, onClose }: { entry: Entry | null; canWrite: boolean; onClose: () => void }) {
  const t = useTranslations("accounting.journal");
  const format = useFormatter();
  const [reverse, setReverse] = useState(false);
  const canReverse =
    canWrite && e !== null && e.source.kind === "manual" && e.reversalOfSeq === undefined && !e.reversedBySeq;
  return (
    <Sheet open={e !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto data-[side=right]:sm:max-w-xl">
        {e && (
          <>
            <SheetHeader>
              <SheetTitle>{t("sheetTitle", { seq: e.seq })}</SheetTitle>
              <SheetDescription>
                {dateDe(e.date)} · {e.text}
              </SheetDescription>
            </SheetHeader>
            <div className="flex flex-col gap-5 px-4 pb-6">
              <div className="flex flex-wrap gap-2">
                {e.locked && <Badge variant="secondary">{t("locked")}</Badge>}
                {e.reversalOfSeq !== undefined && (
                  <Badge variant="outline">{t("reversalOf", { seq: e.reversalOfSeq })}</Badge>
                )}
                {e.reversedBySeq !== undefined && (
                  <Badge variant="outline">{t("reversedBy", { seq: e.reversedBySeq })}</Badge>
                )}
                {e.latePostingReason && <Badge variant="outline">{t("latePosting")}</Badge>}
              </div>
              {e.latePostingReason && (
                <p className="rounded-md border border-warning bg-warning/10 p-3 text-sm">
                  {e.latePostingReason}
                  {e.originalDate && (
                    <span className="block">{t("originalDate", { date: dateDe(e.originalDate) })}</span>
                  )}
                </p>
              )}
              <section aria-labelledby={`lines-${e.id}`} className="flex flex-col gap-2">
                <h3 id={`lines-${e.id}`} className="font-medium text-sm">
                  {t("lines")}
                </h3>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("account")}</TableHead>
                        <TableHead className="text-right">{t("columns.debit")}</TableHead>
                        <TableHead className="text-right">{t("columns.credit")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {e.lines.map((l, i) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: journal lines have no id; order is fixed
                        <TableRow key={i}>
                          <TableCell className="whitespace-normal">
                            <span className="font-mono">{l.account}</span> {l.accountName}
                            {(l.roleLabel || l.taxKey || l.taxPointDate || l.currency) && (
                              <span className="block text-muted-foreground text-xs">
                                {[
                                  l.roleLabel,
                                  l.taxKey,
                                  l.taxPointDate && t("taxPoint", { date: dateDe(l.taxPointDate) }),
                                  l.currency &&
                                    l.amountFx !== undefined &&
                                    t("fx", {
                                      amount: format.number(l.amountFx / 100, {
                                        minimumFractionDigits: 2,
                                        maximumFractionDigits: 2,
                                      }),
                                      currency: l.currency,
                                      rate: l.fxRate?.rate ?? "",
                                    }),
                                ]
                                  .filter(Boolean)
                                  .join(" · ")}
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {l.debitCents ? euro(l.debitCents) : ""}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {l.creditCents ? euro(l.creditCents) : ""}
                          </TableCell>
                        </TableRow>
                      ))}
                      <TableRow>
                        <TableCell className="font-medium">{t("sum")}</TableCell>
                        <TableCell className="text-right font-medium tabular-nums">{euro(e.totalCents)}</TableCell>
                        <TableCell className="text-right font-medium tabular-nums">{euro(e.totalCents)}</TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </div>
              </section>
              <section aria-labelledby={`why-${e.id}`} className="flex flex-col gap-1 rounded-md bg-muted p-3">
                <h3 id={`why-${e.id}`} className="font-medium text-sm">
                  {t("why")}
                </h3>
                <p className="text-sm">{e.explanationText}</p>
              </section>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                <dt className="text-muted-foreground">{t("source")}</dt>
                <dd>{e.source.label}</dd>
                <dt className="text-muted-foreground">{t("ruleVersion")}</dt>
                <dd className="font-mono text-xs">
                  {e.ruleVersion} · {e.explanation}
                </dd>
                <dt className="text-muted-foreground">{t("roleMappingVersion")}</dt>
                <dd className="font-mono text-xs">{e.roleMappingVersion}</dd>
                <dt className="text-muted-foreground">{t("periodLabel")}</dt>
                <dd>{periodDe(e.period)}</dd>
              </dl>
              <p className="text-muted-foreground text-xs">
                {t("recorded", {
                  at: format.dateTime(new Date(e.recordedAt), { dateStyle: "medium", timeStyle: "short" }),
                  actor: e.actor,
                })}
              </p>
              {canReverse && (
                <Button variant="outline" className="h-11 self-start md:h-9" onClick={() => setReverse(true)}>
                  <Undo2Icon aria-hidden="true" />
                  {t("reverse")}
                </Button>
              )}
            </div>
            {reverse && (
              <ReverseDialog
                entry={e}
                onClose={(done) => {
                  setReverse(false);
                  if (done) onClose();
                }}
              />
            )}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function ReverseDialog({ entry, onClose }: { entry: Entry; onClose: (done: boolean) => void }) {
  const t = useTranslations("accounting.journal.reverseDialog");
  const reverse = useMutation(api.manualEntries.reverse);
  const showError = useAdapterErrorToast();
  const dateId = useId();
  const reasonId = useId();
  const [date, setDate] = useState(berlinToday());
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose(false)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title", { seq: entry.seq })}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={dateId}>{t("date")}</Label>
            <Input
              id={dateId}
              type="date"
              className="h-11 md:h-9"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={reasonId}>{t("reason")}</Label>
            <Input
              id={reasonId}
              className="h-11 md:h-9"
              value={reason}
              maxLength={200}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" className="h-11 md:h-9" onClick={() => onClose(false)}>
            {t("cancel")}
          </Button>
          <Button
            className="h-11 md:h-9"
            disabled={busy || reason.trim() === "" || date === ""}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await reverse({ entryId: entry.id as Id<"journalEntries">, date, reason });
                toast.success(t("done", { seq: r.seq }));
                onClose(true);
              } catch (err) {
                showError(err);
              } finally {
                setBusy(false);
              }
            }}
          >
            {t("submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

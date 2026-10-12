"use client";

import { api } from "@convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import { LockIcon } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useId, useState } from "react";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAuthedPaginatedQuery } from "@/hooks/use-authed-query";
import { dateDe, euro, periodDe } from "./format";

type Entry = FunctionReturnType<typeof api.accounting.listJournal>["page"][number];

const PAGE_SIZE = 50;

/**
 * Read-only journal (F08 §6 /buchhaltung/journal, ACC-001/ACC-003): newest first, month filter, table on wide
 * containers and cards on narrow ones; a row opens the side sheet with all lines, source, rule versions and
 * „Warum dieses Konto?“. Manual entries and „Gegenbuchung“ follow with ACC-011 (P2).
 */
export function JournalViewer() {
  return (
    <ConvexGuard fallback={null}>
      <JournalViewerInner />
    </ConvexGuard>
  );
}

function JournalViewerInner() {
  const t = useTranslations("accounting.journal");
  const periodId = useId();
  const [period, setPeriod] = useState("");
  const { results, status, loadMore } = useAuthedPaginatedQuery(
    api.accounting.listJournal,
    /^\d{4}-\d{2}$/.test(period) ? { period } : {},
    PAGE_SIZE,
  );
  const [open, setOpen] = useState<Entry | null>(null);
  const loading = status === "LoadingFirstPage";
  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground text-sm">{t("readOnly")}</p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={periodId}>{t("periodLabel")}</Label>
          <Input
            id={periodId}
            type="month"
            className="h-11 w-48 md:h-9"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
          />
        </div>
      </div>
      {loading ? (
        <div className="h-40" aria-busy="true" />
      ) : results.length === 0 ? (
        <p className="rounded-lg border p-6 text-center text-muted-foreground text-sm">
          {period ? t("emptyPeriod") : t("empty")}
        </p>
      ) : (
        <>
          <div className="hidden @3xl/main:block">
            <JournalTable entries={results} onOpen={setOpen} />
          </div>
          <ul className="flex flex-col gap-2 @3xl/main:hidden">
            {results.map((e) => (
              <li key={e.id}>
                <EntryCard entry={e} onOpen={() => setOpen(e)} />
              </li>
            ))}
          </ul>
        </>
      )}
      {status === "CanLoadMore" && (
        <Button variant="outline" className="h-11 self-center md:h-9" onClick={() => loadMore(PAGE_SIZE)}>
          {t("loadMore")}
        </Button>
      )}
      <EntrySheet entry={open} onClose={() => setOpen(null)} />
    </div>
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

function EntrySheet({ entry: e, onClose }: { entry: Entry | null; onClose: () => void }) {
  const t = useTranslations("accounting.journal");
  const format = useFormatter();
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
                            {(l.roleLabel || l.taxKey || l.taxPointDate) && (
                              <span className="block text-muted-foreground text-xs">
                                {[
                                  l.roleLabel,
                                  l.taxKey,
                                  l.taxPointDate && t("taxPoint", { date: dateDe(l.taxPointDate) }),
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
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

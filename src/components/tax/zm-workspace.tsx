"use client";

import { api } from "@convex/_generated/api";
import { DownloadIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useMemo, useState } from "react";
import { dateDe } from "@/components/accounting/format";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { ElsterGuideSteps, SubmissionDialog } from "./elster-guide-steps";
import { FilingList, lastEnded, periodsOf, SELECT } from "./ustva-workspace";

const wholeEuros = (euros: number) => `${new Intl.NumberFormat("de-DE").format(euros)} €`;

/**
 * /steuern/zm (F08 §6; TAX-009, TAX-020, TAX-021): rows per USt-IdNr (Land, Nr., Art L/S, Betrag in vollen Euro),
 * reconciliation with Kz 41/21, the Mein ELSTER step page with copy buttons per row, CSV for the BZSt-Online-Portal
 * and „Übermittlung erfassen“ (Σ cross-check). Quarterly by default; monthly when goods exceed 50.000 €.
 */
export function ZmWorkspace({ canSubmit }: { canSubmit: boolean }) {
  return (
    <ConvexGuard fallback={null}>
      <Inner canSubmit={canSubmit} />
    </ConvexGuard>
  );
}

function Inner({ canSubmit }: { canSubmit: boolean }) {
  const t = useTranslations("tax.zm");
  const pickId = useId();
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
  const year = Number(today.slice(0, 4));
  const [picked, setPicked] = useState<string | null>(null);
  const period = picked ?? lastEnded(today, "quarterly");
  const options = useMemo(
    () => [...periodsOf(year, "quarterly"), ...periodsOf(year, "monthly"), ...periodsOf(year - 1, "quarterly")],
    [year],
  );
  const view = useAuthedQuery(api.taxes.zm, { period });
  const [submitting, setSubmitting] = useState(false);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={pickId}>{t("period")}</Label>
          <select id={pickId} className={`${SELECT} w-48`} value={period} onChange={(e) => setPicked(e.target.value)}>
            {options.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        {view && (
          <div className="flex flex-wrap gap-2 pb-1">
            <Badge variant="outline">{t("due", { date: dateDe(view.deadline.due) })}</Badge>
            {view.filings.some((f) => f.status === "submitted_manually") && (
              <Badge variant="secondary">{t("submitted")}</Badge>
            )}
          </div>
        )}
      </div>
      {view === undefined ? (
        <div className="h-60" aria-busy="true" />
      ) : (
        <>
          {[...view.zm.warnings, ...view.reconciliation].map((w) => (
            <p key={w} role="alert" className="rounded-md border border-warning bg-warning/10 p-3 text-sm">
              {w}
            </p>
          ))}
          {view.blockers.length > 0 && (
            <ul className="list-disc rounded-md border border-destructive/50 p-3 pl-8 text-sm">
              {view.blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          )}
          <section aria-labelledby="zm-rows" className="flex flex-col gap-2 rounded-lg border p-4">
            <h3 id="zm-rows" className="font-medium">
              {t("rows", { label: view.label })}
            </h3>
            {view.zm.rows.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t("empty")}</p>
            ) : (
              <div className="overflow-x-auto">
                <Table aria-label={t("rows", { label: view.label })}>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("country")}</TableHead>
                      <TableHead>{t("vatId")}</TableHead>
                      <TableHead>{t("customer")}</TableHead>
                      <TableHead>{t("type")}</TableHead>
                      <TableHead className="text-right">{t("amount")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {view.zm.rows.map((r) => (
                      <TableRow key={`${r.vatId}-${r.type}`}>
                        <TableCell className="font-mono">{r.countryCode}</TableCell>
                        <TableCell className="font-mono">{r.vatNumber}</TableCell>
                        <TableCell>{r.name}</TableCell>
                        <TableCell>{r.type}</TableCell>
                        <TableCell className="text-right tabular-nums">{wholeEuros(r.euros)}</TableCell>
                      </TableRow>
                    ))}
                    <TableRow className="font-medium">
                      <TableCell colSpan={4}>{t("total")}</TableCell>
                      <TableCell className="text-right tabular-nums">{wholeEuros(view.zm.totalEuros)}</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            )}
            {view.zm.rows.length > 0 && (
              <Button
                variant="outline"
                className="h-11 self-start md:h-9"
                onClick={() => {
                  const url = URL.createObjectURL(new Blob([view.csv], { type: "text/csv;charset=utf-8" }));
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `ZM-${view.period}.csv`;
                  a.click();
                  URL.revokeObjectURL(url);
                }}
              >
                <DownloadIcon aria-hidden="true" />
                {t("csv")}
              </Button>
            )}
          </section>
          {view.zm.rows.length > 0 && view.guide && <ElsterGuideSteps guide={view.guide} />}
          {view.zm.rows.length > 0 && view.guide && canSubmit && (
            <Button
              className="h-11 self-start md:h-9"
              disabled={view.guide.blocked || !view.ended}
              onClick={() => setSubmitting(true)}
            >
              {view.correction ? t("recordCorrection") : t("record")}
            </Button>
          )}
          <FilingList filings={view.filings} />
          {submitting && view.guide && (
            <SubmissionDialog
              form="zm"
              period={view.period}
              sheetHash={view.guide.sheetHash}
              crossCheckLabel={t("crossCheck")}
              expectedCents={view.zm.totalEuros * 100}
              locks
              onClose={() => setSubmitting(false)}
            />
          )}
        </>
      )}
    </div>
  );
}

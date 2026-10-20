"use client";

import { api } from "@convex/_generated/api";
import { useAction } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { FileDownIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { dateDe, euro } from "@/components/accounting/format";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAdapterErrorToast } from "@/hooks/use-adapter-error-toast";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { ElsterGuideSteps, SubmissionDialog } from "./elster-guide-steps";
import { SELECT } from "./ustva-workspace";

type View = FunctionReturnType<typeof api.taxes.euer>;
type Line = View["sheet"]["lines"][number];

const berlinYear = () => Number(new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" }).slice(0, 4));

/**
 * /steuern/euer (F08 §6, §4.7a; TAX-015, TAX-016, TAX-022, AO-02): year picker, Anlage-EÜR lines with the official
 * Zeile/Kennzahl of the year and drill-down, „Zeilen gegen amtlichen Vordruck prüfen“ banner while unverified, private
 * section, non-deductible add-backs, Anlage AVEÜR, the Mein ELSTER steps and „Übermittlung erfassen“ (Gewinn/Verlust
 * cross-check; locks all months of the year).
 */
export function EuerWorkspace({ canSubmit }: { canSubmit: boolean }) {
  return (
    <ConvexGuard fallback={null}>
      <Inner canSubmit={canSubmit} />
    </ConvexGuard>
  );
}

function Inner({ canSubmit }: { canSubmit: boolean }) {
  const t = useTranslations("tax.euer");
  const pickId = useId();
  const current = berlinYear();
  // after year end the previous year is the one to file
  const [year, setYear] = useState(current - 1);
  const view = useAuthedQuery(api.taxes.euer, { year });
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={pickId}>{t("year")}</Label>
          <select
            id={pickId}
            className={`${SELECT} w-36`}
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
          >
            {[current, current - 1, current - 2, current - 3].map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>
        {view && (
          <div className="flex flex-wrap items-center gap-2 pb-1 text-sm">
            {view.filing ? (
              <Badge variant="secondary">{t("submitted", { date: dateDe(view.filing.submittedOn ?? "") })}</Badge>
            ) : (
              <Badge variant="outline">{t("notSubmitted")}</Badge>
            )}
            {view.status.provisional && <Badge variant="outline">{t("provisional")}</Badge>}
          </div>
        )}
        {view && <Downloads year={year} />}
      </div>
      {view === undefined ? <div className="h-60" aria-busy="true" /> : <YearView view={view} canSubmit={canSubmit} />}
    </div>
  );
}

/** PDF/A and CSV of the sheet (F09 EXP-020 Kennzahlen export, RPT-014), audited per download. */
function Downloads({ year }: { year: number }) {
  const t = useTranslations("tax.euer");
  const download = useAction(api.kennzahlenNode.download);
  const showError = useAdapterErrorToast();
  const [busy, setBusy] = useState(false);
  const get = async (format: "pdf" | "csv") => {
    setBusy(true);
    try {
      const r = await download({ form: "euer", period: String(year), format });
      const url = URL.createObjectURL(new Blob([r.data], { type: r.mime }));
      const a = document.createElement("a");
      a.href = url;
      a.download = r.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ml-auto flex gap-2 pb-1">
      {(["pdf", "csv"] as const).map((f) => (
        <Button key={f} variant="outline" className="h-11 md:h-9" disabled={busy} onClick={() => get(f)}>
          <FileDownIcon aria-hidden="true" />
          {t(f)}
        </Button>
      ))}
    </div>
  );
}

function YearView({ view, canSubmit }: { view: View; canSubmit: boolean }) {
  const t = useTranslations("tax.euer");
  const [drill, setDrill] = useState<Line | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const { sheet } = view;
  const main = sheet.lines.filter((l) => l.section !== "PRIVAT");
  const priv = sheet.lines.filter((l) => l.section === "PRIVAT");
  return (
    <div className="flex flex-col gap-4">
      {sheet.notices.map((n) => (
        <p key={n} role={sheet.verified ? undefined : "alert"} className="rounded-md border bg-muted p-3 text-sm">
          {n}
        </p>
      ))}
      {view.blockers.length > 0 && (
        <section className="flex flex-col gap-1 rounded-md border border-destructive/50 p-3 text-sm">
          <h3 className="font-medium text-destructive">{t("blockers")}</h3>
          <ul className="list-disc pl-5">
            {view.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </section>
      )}
      <section aria-labelledby="euer-values" className="flex flex-col gap-2 rounded-lg border p-4 @container">
        <h3 id="euer-values" className="font-medium">
          <span className="mr-2 inline-flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs">
            1
          </span>
          {t("check")}
        </h3>
        <p className="text-muted-foreground text-xs">{t("basis")}</p>
        <div className="overflow-x-auto">
          <Table aria-label={t("tableLabel", { year: view.year })}>
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 w-16 bg-background">{t("line")}</TableHead>
                <TableHead className="w-16">Kz</TableHead>
                <TableHead>{t("label")}</TableHead>
                <TableHead className="text-right">{t("amount")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {main
                .filter((l) => l.valueCents !== 0)
                .map((l) => (
                  <LineRow key={`${l.zeile}-${l.kz}`} line={l} onDrill={() => setDrill(l)} />
                ))}
              {sheet.sumFields && (
                <>
                  <SumRow
                    zeile={sheet.sumFields.einnahmen.zeile}
                    kz={sheet.sumFields.einnahmen.kz}
                    label={t("sumIncome")}
                    cents={sheet.sums.einnahmenCents}
                  />
                  <SumRow
                    zeile={sheet.sumFields.ausgaben.zeile}
                    kz={sheet.sumFields.ausgaben.kz}
                    label={t("sumExpenses")}
                    cents={sheet.sums.ausgabenCents}
                  />
                  <SumRow
                    zeile={sheet.sumFields.gewinn.zeile}
                    kz={sheet.sumFields.gewinn.kz}
                    label={t("profit")}
                    cents={sheet.sums.gewinnCents}
                  />
                </>
              )}
            </TableBody>
          </Table>
        </div>
        {sheet.sums.nichtAbziehbarCents !== 0 && (
          <p className="text-sm">{t("addBack", { amount: euro(sheet.sums.nichtAbziehbarCents) })}</p>
        )}
      </section>
      {priv.some((l) => l.valueCents !== 0) && (
        <section aria-labelledby="euer-private" className="flex flex-col gap-2 rounded-lg border p-4">
          <h3 id="euer-private" className="font-medium">
            {t("private")}
          </h3>
          <ul className="flex flex-col divide-y text-sm">
            {priv.map((l) => (
              <li key={l.kz} className="flex flex-wrap justify-between gap-2 py-2">
                <span>
                  {t("lineKz", { zeile: l.zeile, kz: l.kz })} · {l.label}
                </span>
                <span className="tabular-nums">{euro(l.valueCents)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {view.aveuer && (
        <section aria-labelledby="euer-aveuer" className="flex flex-col gap-2 rounded-lg border p-4">
          <h3 id="euer-aveuer" className="font-medium">
            {t("aveuer")}
          </h3>
          {view.aveuer.groups.map((g) => (
            <div key={g.key} className="flex flex-col gap-1">
              <h4 className="font-medium text-sm">{g.title}</h4>
              <ul className="flex flex-col divide-y rounded-md border text-sm">
                {g.fields.map((f) => (
                  <li key={f.kz} className="flex flex-wrap justify-between gap-2 p-2">
                    <span>
                      {t("lineKz", { zeile: f.zeile, kz: f.kz })} · {f.label}
                    </span>
                    <span className="tabular-nums">{euro(f.valueCents)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}
      <ElsterGuideSteps guide={view.guide} />
      {canSubmit && (
        <section className="flex flex-col gap-2 rounded-lg border p-4">
          <h3 className="font-medium">
            <span className="mr-2 inline-flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs">
              6
            </span>
            {t("record")}
          </h3>
          <p className="text-muted-foreground text-sm">{t("recordHint")}</p>
          <Button className="h-11 self-start md:h-9" disabled={view.guide.blocked} onClick={() => setSubmitting(true)}>
            {t("record")}
          </Button>
        </section>
      )}
      {view.lateEntries.length > 0 && (
        <section role="note" className="flex flex-col gap-2 rounded-md border border-warning bg-warning/10 p-3 text-sm">
          <h3 className="font-medium">{t("late", { year: view.year })}</h3>
          <p>{t("lateHint", { year: view.year })}</p>
          <ul className="flex flex-col gap-1">
            {view.lateEntries.map((e) => (
              <li key={e.entryId}>
                {t("lateEntry", { seq: e.seq, date: dateDe(e.originalDate) })} ·{" "}
                {e.href ? (
                  <a className="text-primary underline-offset-4 hover:underline" href={e.href}>
                    {e.text}
                  </a>
                ) : (
                  e.text
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      <DrillSheet line={drill} onClose={() => setDrill(null)} />
      {submitting && (
        <SubmissionDialog
          form="euer"
          period={String(view.year)}
          sheetHash={view.guide.sheetHash}
          crossCheckLabel={t("crossCheck")}
          expectedCents={sheet.sums.gewinnCents}
          locks
          onClose={() => setSubmitting(false)}
        />
      )}
    </div>
  );
}

function LineRow({ line, onDrill }: { line: Line; onDrill: () => void }) {
  const t = useTranslations("tax.euer");
  return (
    <TableRow>
      <TableCell className="sticky left-0 bg-background font-mono">{line.zeile}</TableCell>
      <TableCell className="font-mono">
        <button
          type="button"
          className="rounded text-primary underline-offset-4 hover:underline focus-visible:outline-2"
          onClick={onDrill}
          aria-label={t("drill", { kz: line.kz })}
        >
          {line.kz}
        </button>
      </TableCell>
      <TableCell className="whitespace-normal">
        {line.label}
        {line.column === "nicht_abziehbar" && (
          <Badge variant="outline" className="ml-2">
            {t("notDeductible")}
          </Badge>
        )}
        {line.informational && (
          <Badge variant="outline" className="ml-2">
            {t("informational")}
          </Badge>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">{euro(line.valueCents)}</TableCell>
    </TableRow>
  );
}

function SumRow({ zeile, kz, label, cents }: { zeile: number; kz: string; label: string; cents: number }) {
  return (
    <TableRow className="font-medium">
      <TableCell className="sticky left-0 bg-background font-mono">{zeile}</TableCell>
      <TableCell className="font-mono">{kz}</TableCell>
      <TableCell>{label}</TableCell>
      <TableCell className="text-right tabular-nums">{euro(cents)}</TableCell>
    </TableRow>
  );
}

function DrillSheet({ line, onClose }: { line: Line | null; onClose: () => void }) {
  const t = useTranslations("tax.euer");
  const rows = line?.drillDown ?? [];
  return (
    <Sheet open={line !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto data-[side=right]:sm:max-w-xl">
        {line && (
          <>
            <SheetHeader>
              <SheetTitle>
                {t("lineKz", { zeile: line.zeile, kz: line.kz })} · {line.label}
              </SheetTitle>
              <SheetDescription>{t("drillSum", { sum: euro(line.valueCents), count: rows.length })}</SheetDescription>
            </SheetHeader>
            <ul className="flex flex-col divide-y px-4 pb-6 text-sm">
              {rows.map((r) => (
                <li
                  key={`${r.entryId}-${r.cents}-${r.via?.id ?? ""}`}
                  className="flex flex-wrap items-center justify-between gap-2 py-2"
                >
                  <span>
                    <span className="text-muted-foreground">
                      {t("entry", { seq: r.seq })} · {dateDe(r.date)}
                      {r.tenDayRule ? ` · ${t("tenDay", { reason: r.tenDayRule })}` : ""}
                    </span>
                    <span className="block">
                      {r.href ? (
                        <a className="text-primary underline-offset-4 hover:underline" href={r.href}>
                          {r.text}
                        </a>
                      ) : (
                        r.text
                      )}
                    </span>
                  </span>
                  <span className="tabular-nums">{euro(r.cents)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

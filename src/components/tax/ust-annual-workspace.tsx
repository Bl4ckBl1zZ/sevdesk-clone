"use client";

import { api } from "@convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { dateDe, euro } from "@/components/accounting/format";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { filingPeriodLabel } from "@/domain/tax/ustva";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { ElsterGuideSteps } from "./elster-guide-steps";
import { SELECT } from "./ustva-workspace";

type View = FunctionReturnType<typeof api.taxes.ustAnnual>;
type Row = View["sheet"]["rows"][number];

const berlinYear = () => Number(new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" }).slice(0, 4));

/**
 * /steuern/ust-jahr (F08 §6, TAX-023): USt-Jahreserklärung worksheet — USt 2 A lines with year totals and drill-down,
 * reconciliation with the submitted Voranmeldungen (expected Abschlusszahlung/Erstattung per cause), the Mein ELSTER
 * steps (blocked while the year is open or the line table is unverified). No submission record.
 */
export function UstAnnualWorkspace() {
  return (
    <ConvexGuard fallback={null}>
      <Inner />
    </ConvexGuard>
  );
}

function Inner() {
  const t = useTranslations("tax.ustAnnual");
  const pickId = useId();
  const current = berlinYear();
  const [year, setYear] = useState(current - 1);
  const view = useAuthedQuery(api.taxes.ustAnnual, { year });
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={pickId}>{t("year")}</Label>
        <select id={pickId} className={`${SELECT} w-36`} value={year} onChange={(e) => setYear(Number(e.target.value))}>
          {[current, current - 1, current - 2, current - 3].map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
      </div>
      {view === undefined ? <div className="h-60" aria-busy="true" /> : <YearView view={view} />}
    </div>
  );
}

export function YearView({ view }: { view: View }) {
  const t = useTranslations("tax.ustAnnual");
  const [drill, setDrill] = useState<Row | null>(null);
  const { sheet } = view;
  const shown = sheet.rows.filter((r) => r.valueCents !== 0 || r.zeile >= 124);
  return (
    <div className="flex flex-col gap-4">
      {sheet.notices.map((n) => (
        <p key={n} role={sheet.verified ? undefined : "alert"} className="rounded-md border bg-muted p-3 text-sm">
          {n}
        </p>
      ))}
      <section aria-labelledby="ust-annual-periods" className="flex flex-col gap-2">
        <h3 id="ust-annual-periods" className="font-medium text-sm">
          {t("periods", { year: view.year })}
        </h3>
        <ul className="flex flex-wrap gap-2">
          {view.periods.map((p) => (
            <li key={p.period}>
              <Badge variant={p.filed ? "secondary" : "outline"}>
                {filingPeriodLabel(p.period)}: {p.filed ? t("filed") : t("notFiled")}
              </Badge>
            </li>
          ))}
        </ul>
      </section>
      {sheet.blockers.length > 0 && (
        <section className="flex flex-col gap-1 rounded-md border border-destructive/50 p-3 text-sm">
          <h3 className="font-medium text-destructive">{t("blockers")}</h3>
          <ul className="list-disc pl-5">
            {sheet.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </section>
      )}
      <section aria-labelledby="ust-annual-values" className="flex flex-col gap-2 rounded-lg border p-4 @container">
        <h3 id="ust-annual-values" className="font-medium">
          {t("values", { year: view.year })}
        </h3>
        <p className="text-muted-foreground text-xs">{t("basis")}</p>
        <Table aria-label={t("tableLabel", { year: view.year })} scrollLabel={t("tableLabel", { year: view.year })}>
          <TableHeader>
            <TableRow>
              <TableHead className="sticky left-0 w-16 bg-background">{t("line")}</TableHead>
              <TableHead className="w-16">{t("kz")}</TableHead>
              <TableHead>{t("label")}</TableHead>
              <TableHead className="text-right">{t("amount")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((r) => (
              <TableRow key={`${r.zeile}-${r.kz ?? "x"}-${r.label}`}>
                <TableCell className="sticky left-0 bg-background font-mono">{r.zeile}</TableCell>
                <TableCell className="font-mono">
                  {r.kz && r.ustvaKz && (view.drillDown[r.ustvaKz]?.length ?? 0) > 0 ? (
                    <button
                      type="button"
                      className="rounded text-primary underline-offset-4 hover:underline focus-visible:outline-2"
                      onClick={() => setDrill(r)}
                      aria-label={t("drill", { kz: r.kz })}
                    >
                      {r.kz}
                    </button>
                  ) : (
                    (r.kz ?? "–")
                  )}
                </TableCell>
                <TableCell className="whitespace-normal">
                  {r.label}
                  {r.review && (
                    <span className="mt-1 block text-warning-foreground text-xs">
                      <Badge variant="outline" className="mr-1">
                        {t("review")}
                      </Badge>
                      {r.review}
                    </span>
                  )}
                  {r.hint && <span className="mt-1 block text-muted-foreground text-xs">{r.hint}</span>}
                </TableCell>
                <TableCell className="text-right tabular-nums">{euro(r.valueCents)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
      <section aria-labelledby="ust-annual-reco" className="flex flex-col gap-2 rounded-lg border p-4">
        <h3 id="ust-annual-reco" className="font-medium">
          {t("reconciliation")}
        </h3>
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
          <dt>{t("verbleibend")}</dt>
          <dd className="text-right tabular-nums">{euro(sheet.totals.verbleibendCents)}</dd>
          <dt>{t("vorauszahlungssoll")}</dt>
          <dd className="text-right tabular-nums">{euro(sheet.totals.vorauszahlungssollCents)}</dd>
          <dt className="font-medium">{t("abschluss")}</dt>
          <dd className="text-right font-medium tabular-nums">{euro(sheet.totals.abschlussCents)}</dd>
        </dl>
        {sheet.reconciliation.causes.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("noDifference")}</p>
        ) : (
          <div className="flex flex-col gap-1">
            <h4 className="font-medium text-sm">{t("causes")}</h4>
            <ul className="flex flex-col divide-y rounded-md border text-sm">
              {sheet.reconciliation.causes.map((c) => (
                <li key={`${c.kind}-${c.period ?? ""}`} className="flex flex-col gap-1 p-2">
                  <span className="flex flex-wrap justify-between gap-2">
                    <span>{c.label}</span>
                    <span className="tabular-nums">{euro(c.amountCents)}</span>
                  </span>
                  {c.deltas.length > 0 && (
                    <span className="text-muted-foreground text-xs">
                      {c.deltas.map((d) => `Kz ${d.kz}: ${euro(d.deltaCents)}`).join(" · ")}
                    </span>
                  )}
                  {c.entries.length > 0 && (
                    <span className="text-muted-foreground text-xs">
                      {t("causeEntries", { count: c.entries.length })}:{" "}
                      {c.entries.map((e) => t("entry", { seq: e.seq })).join(", ")}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
      <section aria-labelledby="ust-annual-guide" className="flex flex-col gap-2">
        <h3 id="ust-annual-guide" className="font-medium">
          {t("guide")}
        </h3>
        {sheet.guide.blocked ? (
          <p className="rounded-md border p-3 text-sm">{t("guideBlocked")}</p>
        ) : (
          <ElsterGuideSteps guide={sheet.guide} />
        )}
      </section>
      <DrillSheet row={drill} view={view} onClose={() => setDrill(null)} />
    </div>
  );
}

function DrillSheet({ row, view, onClose }: { row: Row | null; view: View; onClose: () => void }) {
  const t = useTranslations("tax.ustAnnual");
  const list = row?.ustvaKz ? (view.drillDown[row.ustvaKz] ?? []) : [];
  return (
    <Sheet open={row !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto data-[side=right]:sm:max-w-xl">
        {row && (
          <>
            <SheetHeader>
              <SheetTitle>{t("drillTitle", { kz: row.ustvaKz ?? "" })}</SheetTitle>
              <SheetDescription>{t("drillSum", { count: list.length })}</SheetDescription>
            </SheetHeader>
            <ul className="flex flex-col divide-y px-4 pb-6 text-sm">
              {list.map((d) => (
                <li key={d.entryId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span>
                    <span className="text-muted-foreground">
                      {t("entry", { seq: d.seq })} · {dateDe(d.date)}
                    </span>
                    <span className="block">
                      {d.href ? (
                        <a className="text-primary underline-offset-4 hover:underline" href={d.href}>
                          {d.text}
                        </a>
                      ) : (
                        d.text
                      )}
                    </span>
                  </span>
                  <span className="tabular-nums">{euro(d.cents)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

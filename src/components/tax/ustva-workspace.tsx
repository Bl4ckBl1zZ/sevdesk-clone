"use client";

import { api } from "@convex/_generated/api";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useTranslations } from "next-intl";
import { useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { dateDe, euro } from "@/components/accounting/format";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAdapterErrorToast } from "@/hooks/use-adapter-error-toast";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { ElsterGuideSteps, SubmissionDialog } from "./elster-guide-steps";

type View = FunctionReturnType<typeof api.taxes.ustva>;
type Field = NonNullable<View["sheet"]>["fields"][number];

export const SELECT =
  "h-11 rounded-md border border-input bg-background px-2.5 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:h-9 md:text-sm dark:bg-input/30";

const berlinToday = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });

/** Periods of a year for the picker: months or quarters (newest first). */
export function periodsOf(year: number, kind: "monthly" | "quarterly"): string[] {
  const out =
    kind === "monthly"
      ? Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`)
      : [1, 2, 3, 4].map((q) => `${year}-Q${q}`);
  return out.reverse();
}

/** The last ended period (default selection). */
export function lastEnded(today: string, kind: "monthly" | "quarterly"): string {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  if (kind === "monthly") return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  const q = Math.ceil(m / 3);
  return q === 1 ? `${y - 1}-Q4` : `${y}-Q${q - 1}`;
}

/**
 * /steuern/ustva (F08 §6, §4.7a; TAX-001…TAX-011, TAX-019…TAX-021): period picker with deadline and status, (1)
 * „Werte prüfen“ with drill-down per Kennzahl, Δ banner for corrections and blockers, (2–5) the Mein ELSTER steps,
 * (6) „Übermittlung erfassen“; the Dauerfristverlängerung card (USt 1 H) and the deadline calendar. Kleinunternehmer:
 * the page states that no UStVA is due unless §13b/igE liabilities exist (TAX-011).
 */
export function UstvaWorkspace({ canSubmit, isOwner }: { canSubmit: boolean; isOwner: boolean }) {
  return (
    <ConvexGuard fallback={null}>
      <Inner canSubmit={canSubmit} isOwner={isOwner} />
    </ConvexGuard>
  );
}

function Inner({ canSubmit, isOwner }: { canSubmit: boolean; isOwner: boolean }) {
  const t = useTranslations("tax.ustva");
  const pickId = useId();
  const today = berlinToday();
  const [year, setYear] = useState(Number(today.slice(0, 4)));
  const settings = useAuthedQuery(api.taxes.filingSettings, { year });
  const kind = settings?.setting?.period === "monthly" ? "monthly" : "quarterly";
  const [picked, setPicked] = useState<string | null>(null);
  const period = picked ?? lastEnded(today, kind);
  const options = useMemo(() => {
    const list = [...periodsOf(year, kind), ...periodsOf(year - 1, kind)];
    return list.includes(period) ? list : [period, ...list];
  }, [year, kind, period]);
  const view = useAuthedQuery(api.taxes.ustva, { period });
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={pickId}>{t("period")}</Label>
          <select
            id={pickId}
            className={`${SELECT} w-48`}
            value={period}
            onChange={(e) => {
              setPicked(e.target.value);
              setYear(Number(e.target.value.slice(0, 4)));
            }}
          >
            {options.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        {view && (
          <div className="flex flex-wrap items-center gap-2 pb-1 text-sm">
            <Badge variant="outline">{t("due", { date: dateDe(view.deadline.due) })}</Badge>
            {view.filings.some((f) => f.status === "submitted_manually") ? (
              <Badge variant="secondary">{t("submitted")}</Badge>
            ) : (
              <Badge variant="outline">{view.ended ? t("open") : t("running")}</Badge>
            )}
          </div>
        )}
      </div>
      {view === undefined ? (
        <div className="h-60" aria-busy="true" />
      ) : (
        <PeriodView view={view} canSubmit={canSubmit} />
      )}
      <SvzCard year={year} canSubmit={canSubmit} />
      {isOwner && settings && <SettingsCard year={year} settings={settings} />}
      <DeadlineList year={year} />
    </div>
  );
}

function PeriodView({ view, canSubmit }: { view: View; canSubmit: boolean }) {
  const t = useTranslations("tax.ustva");
  const [drill, setDrill] = useState<Field | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const sheet = view.sheet;
  if (!sheet) {
    return (
      <ul className="flex flex-col gap-2">
        {view.blockers.map((b) => (
          <li key={b} role="alert" className="rounded-md border border-warning bg-warning/10 p-3 text-sm">
            {b}
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {sheet.notices.map((n) => (
        <p key={n} className="rounded-md border bg-muted p-3 text-sm">
          {n}
        </p>
      ))}
      {view.correction?.required && (
        <section
          role="alert"
          className="flex flex-col gap-2 rounded-md border border-warning bg-warning/10 p-3 text-sm"
        >
          {view.correction.notice && <p className="font-medium">{view.correction.notice}</p>}
          <ul>
            {view.correction.deltas.map((d) => (
              <li key={d.kz} className="tabular-nums">
                {t("delta", {
                  kz: d.kz,
                  before: euro(d.beforeCents),
                  after: euro(d.afterCents),
                  delta: euro(d.deltaCents),
                })}
              </li>
            ))}
          </ul>
        </section>
      )}
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
      <section aria-labelledby="ustva-values" className="flex flex-col gap-2 rounded-lg border p-4">
        <h3 id="ustva-values" className="font-medium">
          <span className="mr-2 inline-flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs">
            1
          </span>
          {t("check")}
        </h3>
        {!sheet.required ? (
          <p className="text-sm">{t("notRequired")}</p>
        ) : (
          <div className="overflow-x-auto">
            <Table aria-label={t("tableLabel", { label: view.label })}>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">Kz</TableHead>
                  <TableHead>{t("label")}</TableHead>
                  <TableHead className="text-right">{t("value")}</TableHead>
                  <TableHead className="text-right">{t("formTax")}</TableHead>
                  <TableHead className="text-right">{t("booked")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sheet.fields.map((f) => (
                  <TableRow key={f.kz}>
                    <TableCell className="font-mono">
                      {(view.drillDown[f.kz]?.length ?? 0) > 0 ? (
                        <button
                          type="button"
                          className="rounded text-primary underline-offset-4 hover:underline focus-visible:outline-2"
                          onClick={() => setDrill(f)}
                          aria-label={t("drill", { kz: f.kz })}
                        >
                          {f.kz}
                        </button>
                      ) : (
                        f.kz
                      )}
                    </TableCell>
                    <TableCell className="whitespace-normal">{f.label}</TableCell>
                    <TableCell className="text-right tabular-nums">{euro(f.valueCents)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {f.formTaxCents !== undefined ? euro(f.formTaxCents) : ""}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {f.bookedTaxCents !== undefined ? euro(f.bookedTaxCents) : ""}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
      {sheet.required && view.guide && <ElsterGuideSteps guide={view.guide} />}
      {sheet.required && view.guide && canSubmit && (
        <section className="flex flex-col gap-2 rounded-lg border p-4">
          <h3 className="font-medium">
            <span className="mr-2 inline-flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs">
              6
            </span>
            {t("record")}
          </h3>
          <p className="text-muted-foreground text-sm">{t("recordHint")}</p>
          <Button
            className="h-11 self-start md:h-9"
            disabled={view.guide.blocked || !view.ended}
            onClick={() => setSubmitting(true)}
          >
            {view.correction ? t("recordCorrection") : t("recordButton")}
          </Button>
        </section>
      )}
      <FilingList filings={view.filings} />
      <DrillSheet field={drill} rows={drill ? (view.drillDown[drill.kz] ?? []) : []} onClose={() => setDrill(null)} />
      {submitting && view.guide && (
        <SubmissionDialog
          form="ustva"
          period={view.period}
          sheetHash={view.guide.sheetHash}
          crossCheckLabel={t("crossCheck")}
          expectedCents={sheet.totalCents}
          locks
          onClose={() => setSubmitting(false)}
        />
      )}
    </div>
  );
}

function DrillSheet({
  field,
  rows,
  onClose,
}: {
  field: Field | null;
  rows: View["drillDown"][string];
  onClose: () => void;
}) {
  const t = useTranslations("tax.ustva");
  const sum = rows.reduce((s, r) => s + r.cents, 0);
  return (
    <Sheet open={field !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto data-[side=right]:sm:max-w-xl">
        {field && (
          <>
            <SheetHeader>
              <SheetTitle>
                Kz {field.kz} · {field.label}
              </SheetTitle>
              <SheetDescription>{t("drillSum", { sum: euro(sum), count: rows.length })}</SheetDescription>
            </SheetHeader>
            <ul className="flex flex-col divide-y px-4 pb-6 text-sm">
              {rows.map((r) => (
                <li key={`${r.entryId}-${r.cents}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span>
                    <span className="text-muted-foreground">
                      {t("entry", { seq: r.seq })} · {r.date ? dateDe(r.date) : ""}
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

export function FilingList({ filings }: { filings: View["filings"] }) {
  const t = useTranslations("tax.filings");
  if (filings.length === 0) return null;
  return (
    <section aria-labelledby="filings" className="flex flex-col gap-2">
      <h3 id="filings" className="font-medium">
        {t("title")}
      </h3>
      <ul className="flex flex-col gap-2 text-sm">
        {filings.map((f) => (
          <li key={f.id} className="flex flex-wrap items-center gap-2 rounded-md border p-3">
            <Badge variant={f.status === "superseded" ? "outline" : "secondary"}>{t(`status.${f.status}`)}</Badge>
            <span>{t(`kind.${f.kind}`)}</span>
            {f.submittedOn && <span>{t("on", { date: dateDe(f.submittedOn) })}</span>}
            {f.transmissionTicket && <span className="font-mono text-xs">{f.transmissionTicket}</span>}
            {f.submittedValuesDiffer && <Badge variant="destructive">{t("differs")}</Badge>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function SvzCard({ year, canSubmit }: { year: number; canSubmit: boolean }) {
  const t = useTranslations("tax.svz");
  const svz = useAuthedQuery(api.taxes.sondervorauszahlung, { year });
  const [submitting, setSubmitting] = useState(false);
  if (!svz) return null;
  return (
    <section aria-labelledby="svz" className="flex flex-col gap-3 rounded-lg border p-4">
      <h2 id="svz" className="font-medium">
        {t("title", { year })}
      </h2>
      {!svz.applicable ? (
        <p className="text-muted-foreground text-sm">{svz.reason}</p>
      ) : (
        <>
          <p className="text-sm">{svz.reason}</p>
          <p className="font-semibold text-xl tabular-nums">{t("amount", { amount: euro(svz.amountCents) })}</p>
          {svz.blockers.length > 0 && (
            <ul className="list-disc pl-5 text-sm">
              {svz.blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          )}
          {svz.guide && <ElsterGuideSteps guide={svz.guide} />}
          {svz.guide && canSubmit && (
            <Button className="h-11 self-start md:h-9" disabled={svz.guide.blocked} onClick={() => setSubmitting(true)}>
              {t("record")}
            </Button>
          )}
          <FilingList filings={svz.filings} />
          {submitting && svz.guide && (
            <SubmissionDialog
              form="sondervorauszahlung"
              period={String(year)}
              sheetHash={svz.guide.sheetHash}
              crossCheckLabel={t("crossCheck")}
              expectedCents={svz.amountCents}
              locks={false}
              onClose={() => setSubmitting(false)}
            />
          )}
        </>
      )}
    </section>
  );
}

function SettingsCard({
  year,
  settings,
}: {
  year: number;
  settings: FunctionReturnType<typeof api.taxes.filingSettings>;
}) {
  const t = useTranslations("tax.settings");
  const save = useMutation(api.taxes.setFilingPeriod);
  const showError = useAdapterErrorToast();
  const base = useId();
  const [period, setPeriod] = useState(settings.setting?.period ?? settings.suggestion.period ?? "quarterly");
  const [dauerfrist, setDauerfrist] = useState(settings.setting?.dauerfrist ?? false);
  return (
    <section aria-labelledby="ustva-settings" className="flex flex-col gap-3 rounded-lg border p-4">
      <h2 id="ustva-settings" className="font-medium">
        {t("title", { year })}
      </h2>
      <p className="text-muted-foreground text-sm">{settings.suggestion.reason}</p>
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${base}-period`}>{t("period")}</Label>
          <select
            id={`${base}-period`}
            className={`${SELECT} w-56`}
            value={period}
            onChange={(e) => setPeriod(e.target.value as typeof period)}
          >
            <option value="monthly">{t("monthly")}</option>
            <option value="quarterly">{t("quarterly")}</option>
            <option value="annual_only">{t("annual_only")}</option>
          </select>
        </div>
        <div className="flex items-center gap-2 pb-2">
          <Checkbox id={`${base}-df`} checked={dauerfrist} onCheckedChange={(v) => setDauerfrist(v === true)} />
          <Label htmlFor={`${base}-df`} className="font-normal">
            {t("dauerfrist")}
          </Label>
        </div>
        <Button
          variant="outline"
          className="h-11 md:h-9"
          onClick={() =>
            save({ year, period, dauerfrist: period === "annual_only" ? false : dauerfrist }).then(
              () => toast.success(t("saved")),
              showError,
            )
          }
        >
          {t("save")}
        </Button>
      </div>
    </section>
  );
}

function DeadlineList({ year }: { year: number }) {
  const t = useTranslations("tax.deadlines");
  const list = useAuthedQuery(api.taxes.deadlines, { year });
  if (!list || list.length === 0) return null;
  const today = berlinToday();
  return (
    <section aria-labelledby="deadlines" className="flex flex-col gap-2">
      <h2 id="deadlines" className="font-medium">
        {t("title", { year })}
      </h2>
      <ul className="flex flex-col divide-y rounded-md border text-sm">
        {list.map((d) => (
          <li
            key={`${d.kind}-${d.period ?? ""}-${d.due}`}
            className="flex flex-wrap items-center justify-between gap-2 p-2"
          >
            <span>{d.label}</span>
            <span className="flex items-center gap-2">
              <span className="tabular-nums">{dateDe(d.due)}</span>
              {d.done ? (
                <Badge variant="secondary">{t("done")}</Badge>
              ) : d.due < today ? (
                <Badge variant="destructive">{t("overdue")}</Badge>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

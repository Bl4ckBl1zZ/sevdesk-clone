"use client";

import { api } from "@convex/_generated/api";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { InfoIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { type FormEvent, useId, useState } from "react";
import { euro } from "@/components/accounting/format";
import { useRun } from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCents, parseCents } from "@/domain/money";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { SELECT } from "./ustva-workspace";

type View = FunctionReturnType<typeof api.reports.taxReserve>;

const berlinYear = () => Number(new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" }).slice(0, 4));

/**
 * /steuern/ruecklage (F08 RPT-010/011): the estimate with its result first (Rücklage jetzt, Monatsbetrag), the
 * breakdown, every assumption and the visible label „Schätzung – keine Steuerberatung“; the owner edits the
 * assumptions of the year (saved, audited).
 */
export function TaxReserveWorkspace({ canEdit }: { canEdit: boolean }) {
  return (
    <ConvexGuard fallback={null}>
      <Inner canEdit={canEdit} />
    </ConvexGuard>
  );
}

function Inner({ canEdit }: { canEdit: boolean }) {
  const t = useTranslations("tax.reserve");
  const pickId = useId();
  const current = berlinYear();
  const [year, setYear] = useState(current);
  const view = useAuthedQuery(api.reports.taxReserve, { year });
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={pickId}>{t("year")}</Label>
        <select id={pickId} className={`${SELECT} w-36`} value={year} onChange={(e) => setYear(Number(e.target.value))}>
          {[current + 1, current, current - 1].map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
      </div>
      {view === undefined ? (
        <div className="h-60" aria-busy="true" />
      ) : (
        <div className="@container flex flex-col gap-6">
          <Result view={view} />
          {canEdit && <Assumptions key={`${year}-${view.saved?._id ?? "new"}`} year={year} view={view} />}
        </div>
      )}
    </div>
  );
}

export function Result({ view }: { view: View }) {
  const t = useTranslations("tax.reserve");
  const rows: { label: string; cents: number }[] = [];
  for (const p of view.persons) {
    const who = view.persons.length > 1 ? ` (${p.name})` : "";
    rows.push({ label: `${t("est")}${who}`, cents: p.estCents });
    if (p.par35CreditCents > 0) rows.push({ label: `${t("par35")}${who}`, cents: -p.par35CreditCents });
    rows.push({ label: `${t("soli")}${who}`, cents: p.soliCents });
    if (p.churchTaxCents > 0) rows.push({ label: `${t("kist")}${who}`, cents: p.churchTaxCents });
  }
  if (view.kst) {
    rows.push({ label: t("kst"), cents: view.kst.kstCents }, { label: t("soli"), cents: view.kst.soliCents });
  }
  if (view.gewst) rows.push({ label: t("gewst"), cents: view.gewst.gewstCents });
  return (
    <section aria-labelledby="reserve-result" className="flex flex-col gap-4">
      <p
        role="note"
        className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-50 p-3 font-medium text-sm dark:bg-amber-950/30"
      >
        <InfoIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        {view.disclaimer}
      </p>
      {view.banner && (
        <p role="alert" className="rounded-md border bg-muted p-3 text-sm">
          {view.banner}
        </p>
      )}
      {view.notices.map((n) => (
        <p key={n} className="rounded-md border bg-muted p-3 text-sm">
          {n}
        </p>
      ))}
      <h2 id="reserve-result" className="sr-only">
        {t("result")}
      </h2>
      <dl className="grid grid-cols-1 gap-3 @md:grid-cols-3">
        {[
          { k: t("reserveNow"), v: view.reserveNowCents },
          { k: t("monthly", { n: view.monthsLeft }), v: view.monthlyCents },
          { k: t("annual"), v: view.annualCents },
        ].map(({ k, v }) => (
          <div key={k} className="rounded-lg border p-4">
            <dt className="text-muted-foreground text-sm">{k}</dt>
            <dd className="font-semibold text-2xl tabular-nums">{euro(v)}</dd>
          </div>
        ))}
      </dl>
      <Table aria-label={t("tableLabel")} scrollLabel={t("tableLabel")}>
        <TableHeader>
          <TableRow>
            <TableHead>{t("position")}</TableHead>
            <TableHead className="text-right">{t("amount")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>{t("profit", { basis: t(`basis.${view.profit.basis}`) })}</TableCell>
            <TableCell className="text-right tabular-nums">{euro(view.profit.projectedCents)}</TableCell>
          </TableRow>
          <TableRow>
            <TableCell>
              {t("ust")}
              {view.ust.periods.length > 0 && (
                <span className="text-muted-foreground"> ({view.ust.periods.join(", ")})</span>
              )}
            </TableCell>
            <TableCell className="text-right tabular-nums">{euro(view.ust.openCents)}</TableCell>
          </TableRow>
          {rows.map((r) => (
            <TableRow key={r.label}>
              <TableCell>{r.label}</TableCell>
              <TableCell className="text-right tabular-nums">{euro(r.cents)}</TableCell>
            </TableRow>
          ))}
          <TableRow>
            <TableCell>{t("prepaid")}</TableCell>
            <TableCell className="text-right tabular-nums">{euro(-view.prepaidCents)}</TableCell>
          </TableRow>
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell>{t("remaining")}</TableCell>
            <TableCell className="text-right tabular-nums">{euro(view.remainingCents)}</TableCell>
          </TableRow>
        </TableFooter>
      </Table>
      <section className="flex flex-col gap-1 text-sm">
        <h3 className="font-medium">{t("assumptions")}</h3>
        <ul className="list-disc pl-5 text-muted-foreground">
          {view.assumptions.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
        <p className="text-muted-foreground text-xs">
          {t("rules", { version: view.ruleVersion, source: view.ruleSource })}
        </p>
      </section>
    </section>
  );
}

const centsText = (c: number | undefined) => (c === undefined ? "" : formatCents(c));
const toCents = (s: string): number | null | "invalid" => {
  if (s.trim() === "") return null;
  const r = parseCents(s.trim());
  return r.ok ? r.value : "invalid";
};

function Assumptions({ year, view }: { year: number; view: View }) {
  const t = useTranslations("tax.reserve");
  const save = useMutation(api.taxes.saveTaxReserveInputs);
  const run = useRun();
  const ids = { profit: useId(), deductions: useId(), splitting: useId(), kist: useId(), hebesatz: useId() };
  const s = view.saved;
  const [profit, setProfit] = useState(centsText(s?.profitOverrideCents));
  const [deductions, setDeductions] = useState(centsText(s?.deductionsCents));
  const [splitting, setSplitting] = useState(s?.splitting ?? false);
  const [kist, setKist] = useState<0 | 800 | 900>(s?.churchTaxBp ?? 0);
  const [hebesatz, setHebesatz] = useState(
    s?.gewerbesteuerHebesatzBp === undefined ? "" : String(s.gewerbesteuerHebesatzBp / 100),
  );
  const [error, setError] = useState<string | null>(null);
  const showGewst = view.gewst !== null || view.legalForm !== "freiberufler";
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const p = toCents(profit);
    const d = toCents(deductions);
    const h = hebesatz.trim() === "" ? null : Number(hebesatz.replace(",", "."));
    if (p === "invalid" || d === "invalid" || (h !== null && !Number.isInteger(h))) {
      setError(t("invalid"));
      return;
    }
    setError(null);
    await run(
      () =>
        save({
          year,
          splitting,
          churchTaxBp: kist,
          profitOverrideCents: p,
          deductionsCents: d,
          gewerbesteuerHebesatzBp: h === null ? null : h * 100,
        }),
      t("saved"),
    );
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4 rounded-lg border p-4" aria-labelledby="reserve-inputs">
      <h2 id="reserve-inputs" className="font-medium">
        {t("inputs")}
      </h2>
      <div className="grid grid-cols-1 gap-4 @md:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={ids.profit}>{t("profitOverride")}</Label>
          <Input
            id={ids.profit}
            inputMode="decimal"
            placeholder={t("profitPlaceholder")}
            value={profit}
            onChange={(e) => setProfit(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={ids.deductions}>{t("deductions")}</Label>
          <Input
            id={ids.deductions}
            inputMode="decimal"
            value={deductions}
            onChange={(e) => setDeductions(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={ids.kist}>{t("kistLabel")}</Label>
          <select
            id={ids.kist}
            className={SELECT}
            value={kist}
            onChange={(e) => setKist(Number(e.target.value) as 0 | 800 | 900)}
          >
            <option value={0}>{t("kistNone")}</option>
            <option value={800}>{t("kist8")}</option>
            <option value={900}>{t("kist9")}</option>
          </select>
        </div>
        {showGewst && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={ids.hebesatz}>{t("hebesatz")}</Label>
            <Input
              id={ids.hebesatz}
              inputMode="numeric"
              placeholder="400"
              value={hebesatz}
              onChange={(e) => setHebesatz(e.target.value)}
            />
          </div>
        )}
        <div className="flex items-center gap-2">
          <Checkbox id={ids.splitting} checked={splitting} onCheckedChange={(v) => setSplitting(v === true)} />
          <Label htmlFor={ids.splitting}>{t("splitting")}</Label>
        </div>
      </div>
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      <div>
        <Button type="submit" className="h-11 md:h-9">
          {t("save")}
        </Button>
      </div>
    </form>
  );
}

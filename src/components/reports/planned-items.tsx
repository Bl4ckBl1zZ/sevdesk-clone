"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useMutation } from "convex/react";
import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { type FormEvent, useId, useState } from "react";
import { dateDe, euro } from "@/components/accounting/format";
import { useCan, useRun } from "@/components/catalog/shared";
import { SELECT } from "@/components/tax/ustva-workspace";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatCents, parseCents } from "@/domain/money";
import { RECURRING_INTERVAL_LABELS_DE, RECURRING_INTERVALS } from "@/domain/recurring/schedule";
import {
  FORECAST_CONFIDENCES,
  type ForecastConfidence,
  type PlannedCashItem,
  validatePlannedItem,
} from "@/domain/reports/forecast";
import { useAuthedQuery } from "@/hooks/use-authed-query";

type Recurrence = PlannedCashItem["recurrence"];

/**
 * RPT-013 „Geplante Positionen“ of the Liquiditätsvorschau: list with edit/remove and the form „Geplante Position
 * hinzufügen“ (one-off or recurring, inflow or outflow, confidence). Not bookkeeping data; Convex enforces the role.
 */
export function PlannedItems() {
  const t = useTranslations("reports.forecast.planned");
  const items = useAuthedQuery(api.reports.plannedCashItems, {});
  const canEdit = useCan("accounting.write");
  const remove = useMutation(api.reports.removePlannedCashItem);
  const run = useRun();
  const [editing, setEditing] = useState<PlannedCashItem | "new" | null>(null);
  return (
    <section aria-labelledby="planned-items" className="flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="planned-items" className="font-medium">
          {t("title")}
        </h3>
        {canEdit && editing === null && (
          <Button variant="outline" className="h-11 md:h-9" onClick={() => setEditing("new")}>
            <PlusIcon aria-hidden="true" />
            {t("add")}
          </Button>
        )}
      </div>
      {editing !== null && (
        <PlannedItemForm item={editing === "new" ? null : editing} onDone={() => setEditing(null)} />
      )}
      {items && items.length === 0 && <p className="text-muted-foreground text-sm">{t("empty")}</p>}
      {items && items.length > 0 && (
        <ul className="flex flex-col divide-y rounded-md border text-sm">
          {items.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center gap-2 p-2">
              <span className="min-w-40 flex-1">
                {i.label}
                <span className="block text-muted-foreground text-xs">
                  {i.recurrence === "once"
                    ? t("onceOn", { date: dateDe(i.date) })
                    : t("recurringFrom", {
                        rhythm: RECURRING_INTERVAL_LABELS_DE[i.recurrence],
                        date: dateDe(i.date),
                      })}
                  {i.endDate ? ` · ${t("until", { date: dateDe(i.endDate) })}` : ""}
                </span>
              </span>
              <Badge variant="outline">{t(`confidence.${i.confidence}`)}</Badge>
              <span className="w-32 text-right tabular-nums">{euro(i.cents)}</span>
              {canEdit && (
                <>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t("edit", { label: i.label })}
                    onClick={() => setEditing(i)}
                  >
                    <PencilIcon aria-hidden="true" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t("remove", { label: i.label })}
                    onClick={() =>
                      run(() => remove({ id: i.id as Id<"plannedCashItems"> }), t("removed", { label: i.label }))
                    }
                  >
                    <Trash2Icon aria-hidden="true" />
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function PlannedItemForm({ item, onDone }: { item: PlannedCashItem | null; onDone: () => void }) {
  const t = useTranslations("reports.forecast.planned");
  const save = useMutation(api.reports.savePlannedCashItem);
  const run = useRun();
  const ids = {
    label: useId(),
    dir: useId(),
    amount: useId(),
    date: useId(),
    rec: useId(),
    end: useId(),
    conf: useId(),
  };
  const [label, setLabel] = useState(item?.label ?? "");
  const [direction, setDirection] = useState<"in" | "out">(item && item.cents > 0 ? "in" : "out");
  const [amount, setAmount] = useState(item ? formatCents(Math.abs(item.cents)) : "");
  const [date, setDate] = useState(item?.date ?? "");
  const [recurrence, setRecurrence] = useState<Recurrence>(item?.recurrence ?? "once");
  const [endDate, setEndDate] = useState(item?.endDate ?? "");
  const [confidence, setConfidence] = useState<ForecastConfidence>(item?.confidence ?? "medium");
  const [errors, setErrors] = useState<string[]>([]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseCents(amount.trim());
    const cents = parsed.ok ? (direction === "in" ? parsed.value : -parsed.value) : 0;
    const value = {
      label,
      cents,
      date,
      recurrence,
      ...(recurrence !== "once" && endDate ? { endDate } : {}),
      confidence,
    };
    const issues = validatePlannedItem(value);
    if (issues.length > 0) {
      setErrors(issues.map((i) => i.message));
      return;
    }
    setErrors([]);
    const { cents: amountCents, ...rest } = value;
    const r = await run(
      () => save({ ...(item ? { id: item.id as Id<"plannedCashItems"> } : {}), ...rest, amountCents }),
      t("saved"),
    );
    if (r.ok) onDone();
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-3 rounded-md bg-muted/40 p-3" aria-label={t("formLabel")}>
      <div className="grid grid-cols-1 gap-3 @md:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={ids.label}>{t("label")}</Label>
          <Input id={ids.label} value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} />
        </div>
        <div className="flex flex-wrap gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={ids.dir}>{t("direction")}</Label>
            <select
              id={ids.dir}
              className={`${SELECT} w-36`}
              value={direction}
              onChange={(e) => setDirection(e.target.value as "in" | "out")}
            >
              <option value="in">{t("inflow")}</option>
              <option value="out">{t("outflow")}</option>
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={ids.amount}>{t("amount")}</Label>
            <Input
              id={ids.amount}
              inputMode="decimal"
              className="w-36"
              placeholder="1.000,00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
        </div>
        <div className="flex flex-wrap gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={ids.date}>{recurrence === "once" ? t("date") : t("firstDate")}</Label>
            <Input id={ids.date} type="date" className="w-44" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={ids.rec}>{t("recurrence")}</Label>
            <select
              id={ids.rec}
              className={`${SELECT} w-44`}
              value={recurrence}
              onChange={(e) => setRecurrence(e.target.value as Recurrence)}
            >
              <option value="once">{t("once")}</option>
              {RECURRING_INTERVALS.map((r) => (
                <option key={r} value={r}>
                  {RECURRING_INTERVAL_LABELS_DE[r]}
                </option>
              ))}
            </select>
          </div>
          {recurrence !== "once" && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={ids.end}>{t("endDate")}</Label>
              <Input
                id={ids.end}
                type="date"
                className="w-44"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={ids.conf}>{t("confidenceLabel")}</Label>
          <select
            id={ids.conf}
            className={`${SELECT} w-44`}
            value={confidence}
            onChange={(e) => setConfidence(e.target.value as ForecastConfidence)}
          >
            {FORECAST_CONFIDENCES.map((c) => (
              <option key={c} value={c}>
                {t(`confidence.${c}`)}
              </option>
            ))}
          </select>
        </div>
      </div>
      {errors.length > 0 && (
        <ul role="alert" className="list-disc pl-5 text-destructive text-sm">
          {errors.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Button type="submit" className="h-11 md:h-9">
          {t("save")}
        </Button>
        <Button type="button" variant="ghost" className="h-11 md:h-9" onClick={onDone}>
          {t("cancel")}
        </Button>
      </div>
    </form>
  );
}

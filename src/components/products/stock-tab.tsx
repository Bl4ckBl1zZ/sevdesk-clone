"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useMutation } from "convex/react";
import type { Route } from "next";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { type UseFormReturn, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { FormDialog, formatDateTime, useRun } from "@/components/catalog/shared";
import { CheckboxField, SelectField, TextField } from "@/components/forms/fields";
import { useZodForm } from "@/components/setup/use-zod-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatMilli } from "@/domain/money/format";
import { MANUAL_STOCK_KINDS, STOCK_MESSAGES, STOCK_REASON_LABELS } from "@/domain/products/stock";
import {
  type StockAdjustmentValues,
  type StockSettingsValues,
  stockAdjustmentSchema,
  stockSettingsSchema,
} from "@/domain/schemas/projects";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { cn } from "@/lib/utils";

/**
 * „Bestand“ tab of the product page (F03 §6.3, PRD-090…097): stock settings, current quantity, manual movements
 * (Zugang / Abgang / Korrektur with mandatory text) and the immutable „Buchungsverlauf“ with the running balance.
 */
export function StockTab({ productId, canWrite }: { productId: Id<"products">; canWrite: boolean }) {
  const t = useTranslations("products.stock");
  const data = useAuthedQuery(api.stock.history, { productId });
  const [booking, setBooking] = useState(false);
  const headingId = useId();
  const historyId = useId();
  if (data === undefined) return <div className="h-48" aria-busy="true" />;
  if (data === null) return null;
  if (data.type !== "good") {
    return <p className="rounded-xl border p-4 text-muted-foreground text-sm">{STOCK_MESSAGES.service}</p>;
  }
  const stock = data.stock;
  const below = stock?.enabled && stock.belowReorderSince !== undefined;
  return (
    <div className="flex flex-col gap-4">
      <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-xl border p-4 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id={headingId} className="font-semibold text-base">
            {t("heading")}
          </h2>
          {canWrite && stock?.enabled && (
            <Button variant="outline" className="h-11 md:h-9" onClick={() => setBooking(true)}>
              {t("book")}
            </Button>
          )}
        </div>
        {stock?.enabled ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
            <dt className="text-muted-foreground">{t("current")}</dt>
            <dd className="flex flex-wrap items-center gap-2">
              <span
                className={cn("font-semibold text-lg tabular-nums", stock.quantityMilli < 0 && "text-danger")}
                data-testid="stock-quantity"
              >
                {formatMilli(stock.quantityMilli)} {data.unitCode}
              </span>
              {below && (
                <Badge variant="outline" className="border-warning">
                  {t("belowReorder")}
                </Badge>
              )}
            </dd>
            {stock.reorderLevelMilli !== undefined && (
              <>
                <dt className="text-muted-foreground">{t("reorder")}</dt>
                <dd className="tabular-nums">
                  {formatMilli(stock.reorderLevelMilli)} {data.unitCode}
                </dd>
              </>
            )}
          </dl>
        ) : (
          <p className="text-muted-foreground">{t("disabled")}</p>
        )}
        {canWrite && <StockSettings key={JSON.stringify(stock)} productId={productId} stock={stock} />}
      </section>
      <section aria-labelledby={historyId} className="flex flex-col gap-3 rounded-xl border p-4 text-sm">
        <h2 id={historyId} className="font-semibold text-base">
          {t("history")}
        </h2>
        {data.movements.length === 0 ? (
          <p className="text-muted-foreground">{t("noMovements")}</p>
        ) : (
          <div className="overflow-x-auto">
            <Table data-testid="stock-history">
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns.at")}</TableHead>
                  <TableHead>{t("columns.reason")}</TableHead>
                  <TableHead className="text-right">{t("columns.quantity")}</TableHead>
                  <TableHead className="text-right">{t("columns.balance")}</TableHead>
                  <TableHead>{t("columns.text")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.movements.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell className="whitespace-nowrap tabular-nums">{formatDateTime(m.at)}</TableCell>
                    <TableCell>{STOCK_REASON_LABELS[m.reason]}</TableCell>
                    <TableCell
                      className={cn("text-right tabular-nums", m.quantityMilli < 0 ? "text-danger" : "text-success")}
                    >
                      {m.quantityMilli > 0 ? "+" : ""}
                      {formatMilli(m.quantityMilli)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatMilli(m.balanceMilli)}</TableCell>
                    <TableCell>
                      {m.document ? (
                        <Link href={m.document.href as Route} className="hover:underline">
                          {m.document.label}
                        </Link>
                      ) : (
                        (m.text ?? "—")
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
      {booking && <AdjustDialog productId={productId} unitCode={data.unitCode} onClose={() => setBooking(false)} />}
    </div>
  );
}

function StockSettings({
  productId,
  stock,
}: {
  productId: Id<"products">;
  stock: { enabled: boolean; reorderLevelMilli?: number } | null;
}) {
  const t = useTranslations("products.stock");
  const run = useRun();
  const configure = useMutation(api.stock.configure);
  const formId = useId();
  const form = useZodForm(stockSettingsSchema, {
    enabled: stock?.enabled ?? false,
    reorderLevel: stock?.reorderLevelMilli !== undefined ? formatMilli(stock.reorderLevelMilli) : "",
  }) as unknown as UseFormReturn<StockSettingsValues>;
  const enabled = useWatch({ control: form.control, name: "enabled" });
  const submit = form.handleSubmit(async () => {
    await run(() => configure({ productId, values: form.getValues() }), t("settingsSaved"));
  });
  return (
    <form
      id={formId}
      noValidate
      onSubmit={submit}
      className="@container/form flex flex-col gap-3 border-t pt-3"
      aria-label={t("settings")}
    >
      <CheckboxField form={form} name="enabled" label={t("enabled")} description={t("enabledHint")} />
      {enabled && (
        <TextField
          form={form}
          name="reorderLevel"
          label={t("reorderLevel")}
          description={t("reorderHint")}
          inputMode="decimal"
        />
      )}
      <Button type="submit" variant="outline" className="h-11 self-start md:h-9" disabled={form.formState.isSubmitting}>
        {t("saveSettings")}
      </Button>
    </form>
  );
}

function AdjustDialog({
  productId,
  unitCode,
  onClose,
}: {
  productId: Id<"products">;
  unitCode: string;
  onClose: () => void;
}) {
  const t = useTranslations("products.stock");
  const run = useRun();
  const adjust = useMutation(api.stock.adjust);
  const formId = useId();
  const form = useZodForm(stockAdjustmentSchema, {
    kind: "manual_in",
    quantity: "",
    text: "",
  }) as unknown as UseFormReturn<StockAdjustmentValues>;
  const submit = form.handleSubmit(async () => {
    const r = await run(() => adjust({ productId, values: form.getValues() }));
    if (!r.ok) return;
    toast.success(t("booked"));
    if (r.value.warning) toast.warning(r.value.warning);
    onClose();
  });
  return (
    <FormDialog
      title={t("adjustTitle")}
      description={t("adjustDescription")}
      formId={formId}
      onClose={onClose}
      onSubmit={submit}
      submitting={form.formState.isSubmitting}
      submitLabel={t("book")}
    >
      <SelectField
        form={form}
        name="kind"
        label={t("kind")}
        options={MANUAL_STOCK_KINDS.map((k) => ({ value: k, label: STOCK_REASON_LABELS[k] }))}
      />
      <TextField
        form={form}
        name="quantity"
        label={t("quantity", { unit: unitCode })}
        description={t("quantityHint")}
        inputMode="decimal"
        required
      />
      <TextField form={form} name="text" label={t("text")} description={t("textHint")} required />
    </FormDialog>
  );
}

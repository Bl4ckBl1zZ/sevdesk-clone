"use client";

import { api } from "@convex/_generated/api";
import type { Doc } from "@convex/_generated/dataModel";
import { useMutation } from "convex/react";
import { PlusIcon, Trash2Icon } from "lucide-react";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Controller, type UseFormReturn, useFieldArray, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { CustomFieldsEditor, TagPicker } from "@/components/catalog/custom-fields";
import { ConfirmDialog, FormSection, todayBerlin, useRun } from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { FormErrorSummary, SelectField, TextField } from "@/components/forms/fields";
import { useZodForm } from "@/components/setup/use-zod-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatBasisPoints, formatMicros, formatMilli } from "@/domain/money/format";
import { parseMilli } from "@/domain/money/parse";
import { convertPriceMode, extraUnitPriceMicros, parseUnitPrice, resolveRate } from "@/domain/products/pricing";
import {
  defaultUnitFor,
  MAX_EXTRA_UNITS,
  PLACE_OF_SUPPLY_LABELS,
  PLACE_OF_SUPPLY_RULES,
  PRODUCT_TYPE_LABELS,
  PRODUCT_TYPES,
} from "@/domain/products/product";
import { EXEMPTION_REASONS } from "@/domain/rules/exemption-reasons";
import { RC13B_TYPES } from "@/domain/rules/rc13b-types";
import { VAT_RATE_KEY_LABELS, VAT_RATE_KEYS } from "@/domain/rules/vat-rates";
import { emptyProductForm, type ProductFormValues, productSchema } from "@/domain/schemas/products";
import type { CalendarDate } from "@/domain/time/calendar-date";
import { useAuthedQuery } from "@/hooks/use-authed-query";

type Form = UseFormReturn<ProductFormValues>;

/** Form values of a stored product (prices back to German input strings). */
export function formFromProduct(p: Doc<"products">): ProductFormValues {
  return {
    ...emptyProductForm(),
    number: p.number,
    name: p.name,
    description: p.description ?? "",
    internalNote: p.internalNote ?? "",
    type: p.type,
    unitCode: p.unitCode,
    gtin: p.gtin ?? "",
    priceMode: p.priceMode,
    price: formatMicros(p.unitPriceMicros),
    purchasePrice: p.purchasePriceMicros !== undefined ? formatMicros(p.purchasePriceMicros) : "",
    vatRateKey: p.vatRateKey,
    exemptionReasonCode: p.exemptionReasonCode ?? "",
    placeOfSupplyRule: (p.placeOfSupplyRule ?? "") as ProductFormValues["placeOfSupplyRule"],
    reverseCharge13b: p.reverseCharge13b ?? "",
    laborCostShare: p.laborCostShareBp !== undefined ? formatBasisPoints(p.laborCostShareBp) : "",
    categoryId: p.categoryId ?? "",
    extraUnits: p.extraUnits.map((u) => ({ unitCode: u.unitCode, factor: formatMilli(u.factorMilli) })),
    tags: p.tags,
    customFields: p.customFields as ProductFormValues["customFields"],
  };
}

const errorReason = (e: unknown): string | undefined => (e as { data?: { reason?: string } }).data?.reason;

/** Product form (F03 §6.4): net and gross inputs (the edited side is stored, PRD-011/013), tax, extra units, § 35a. */
export function ProductForm({ product }: { product?: Doc<"products"> }) {
  return (
    <ConvexGuard fallback={<div className="h-96" aria-busy="true" />}>
      <ProductFormInner product={product} />
    </ConvexGuard>
  );
}

function ProductFormInner({ product }: { product?: Doc<"products"> }) {
  const t = useTranslations("products.form");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const run = useRun();
  const create = useMutation(api.products.create);
  const update = useMutation(api.products.update);
  const editing = product !== undefined;
  const form = useZodForm(productSchema, product ? formFromProduct(product) : emptyProductForm()) as unknown as Form;
  const [warnings, setWarnings] = useState<string[]>([]);
  const [confirmClear, setConfirmClear] = useState(false);
  const formId = useId();

  const save = async (confirmClearExtraUnits: boolean) => {
    const values = form.getValues();
    if (editing && product) {
      try {
        const r = await update({
          id: product._id,
          version: product.version,
          values,
          ...(confirmClearExtraUnits ? { confirmClearExtraUnits } : {}),
        });
        toast.success(t("saved"));
        setWarnings(r.warnings);
      } catch (e) {
        if (errorReason(e) === "EXTRA_UNITS_CLEAR_CONFIRM") {
          setConfirmClear(true);
          return;
        }
        await run(() => Promise.reject(e));
      }
      return;
    }
    const r = await run(() => create({ values }));
    if (r.ok) {
      toast.success(t("created", { number: r.value.number }));
      for (const w of r.value.warnings) toast.warning(w);
      router.push(`/produkte/${r.value.id}` as Route);
    }
  };
  const submit = form.handleSubmit(() => save(false));
  const type = useWatch({ control: form.control, name: "type" });
  const vatRateKey = useWatch({ control: form.control, name: "vatRateKey" });

  return (
    <form id={formId} noValidate onSubmit={submit} className="flex flex-col gap-4 pb-24 md:pb-0">
      <FormErrorSummary form={form} />
      <FormSection title={t("sections.basics")}>
        <fieldset className="flex flex-col gap-2 @lg/form:col-span-2">
          <legend className="mb-1 font-medium text-sm">{t("type")}</legend>
          <div className="flex flex-wrap gap-2">
            {PRODUCT_TYPES.map((k) => (
              <label
                key={k}
                className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 has-checked:border-primary has-checked:bg-primary/5 md:min-h-9"
              >
                <input
                  type="radio"
                  value={k}
                  className="size-5 accent-primary md:size-4"
                  {...form.register("type", {
                    onChange: () => {
                      // PRD-005: the default unit follows the type until the user picked another one.
                      const unit = form.getValues("unitCode");
                      if (!editing && (unit === "" || unit === "HUR" || unit === "C62"))
                        form.setValue("unitCode", defaultUnitFor(k));
                    },
                  })}
                />
                {PRODUCT_TYPE_LABELS[k]}
              </label>
            ))}
          </div>
        </fieldset>
        <TextField form={form} name="name" label={t("name")} required className="@lg/form:col-span-2" />
        <ProductNumberField form={form} editing={editing} />
        <CategorySelect form={form} />
        <UnitSelect form={form} name="unitCode" label={t("unit")} />
        <TextField form={form} name="gtin" label={t("gtin")} inputMode="numeric" />
        <TextArea form={form} name="description" label={t("description")} hint={t("descriptionHint")} />
        <TextArea form={form} name="internalNote" label={t("internalNote")} hint={t("internalNoteHint")} />
      </FormSection>

      <FormSection title={t("sections.price")}>
        <SelectField
          form={form}
          name="vatRateKey"
          label={t("vatRateKey")}
          options={Object.keys(VAT_RATE_KEYS).map((k) => ({
            value: k,
            label: VAT_RATE_KEY_LABELS[k as keyof typeof VAT_RATE_KEY_LABELS],
          }))}
        />
        {vatRateKey === "exempt" ? (
          <SelectField
            form={form}
            name="exemptionReasonCode"
            label={t("exemptionReason")}
            required
            placeholder={t("exemptionReasonNone")}
            options={Object.entries(EXEMPTION_REASONS).map(([code, table]) => ({
              value: code,
              label: `§ 4 Nr. ${table.entries.at(-1)?.value.ustgNr ?? ""} UStG — ${table.entries.at(-1)?.value.labelDe ?? code}`,
            }))}
          />
        ) : (
          <div />
        )}
        <PriceInputs form={form} />
        <TextField form={form} name="purchasePrice" label={t("purchasePrice")} inputMode="decimal" />
        {type === "service" && (
          <SelectField
            form={form}
            name="placeOfSupplyRule"
            label={t("placeOfSupply")}
            placeholder={t("placeOfSupplyGeneral")}
            options={PLACE_OF_SUPPLY_RULES.filter((r) => r !== "general").map((r) => ({
              value: r,
              label: PLACE_OF_SUPPLY_LABELS[r],
            }))}
          />
        )}
        <SelectField
          form={form}
          name="reverseCharge13b"
          label={t("reverseCharge13b")}
          placeholder={t("reverseCharge13bNone")}
          options={Object.entries(RC13B_TYPES).map(([key, table]) => ({
            value: key,
            label: table.entries.at(-1)?.value.labelDe ?? key,
          }))}
        />
      </FormSection>

      <FormSection title={t("sections.labor")}>
        <TextField
          form={form}
          name="laborCostShare"
          label={t("laborCostShare")}
          description={t("laborHint")}
          inputMode="decimal"
        />
      </FormSection>

      <FormSection title={t("sections.extraUnits")}>
        <ExtraUnits form={form} />
      </FormSection>

      <FormSection title={t("sections.more")}>
        <Controller
          control={form.control}
          name="tags"
          render={({ field }) => <TagPicker legend={t("tags")} value={field.value} onChange={field.onChange} />}
        />
        <Controller
          control={form.control}
          name="customFields"
          render={({ field }) => <CustomFieldsEditor entity="product" value={field.value} onChange={field.onChange} />}
        />
      </FormSection>

      {warnings.length > 0 && (
        <section aria-label={t("warnings")} className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
          <ul className="list-disc pl-5">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </section>
      )}

      <div className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-30 flex gap-2 border-t bg-background p-3 *:flex-1 md:static md:z-auto md:justify-end md:border-0 md:bg-transparent md:p-0 md:*:flex-none">
        <Button type="submit" className="h-11 md:h-9" disabled={form.formState.isSubmitting}>
          {editing ? tCommon("save") : t("create")}
        </Button>
      </div>

      {confirmClear && (
        <ConfirmDialog
          title={t("clearExtraUnitsTitle")}
          description="Die Basiseinheit wurde geändert. Die Zusatzeinheiten beziehen sich auf die alte Einheit und werden entfernt."
          confirmLabel={t("clearExtraUnitsConfirm")}
          destructive
          onClose={() => setConfirmClear(false)}
          onConfirm={async () => {
            setConfirmClear(false);
            await save(true);
          }}
        />
      )}
    </form>
  );
}

function TextArea({
  form,
  name,
  label,
  hint,
}: {
  form: Form;
  name: "description" | "internalNote";
  label: string;
  hint: string;
}) {
  const id = useId();
  const error = form.formState.errors[name]?.message;
  return (
    <div className="flex flex-col gap-1.5 @lg/form:col-span-2">
      <label htmlFor={id} className="font-medium text-sm">
        {label}
      </label>
      <Textarea
        id={id}
        rows={3}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-hint${error ? ` ${id}-e` : ""}`}
        {...form.register(name)}
      />
      <p id={`${id}-hint`} className="text-muted-foreground text-sm">
        {hint}
      </p>
      {error && (
        <p id={`${id}-e`} className="text-danger text-sm">
          {error}
        </p>
      )}
    </div>
  );
}

function ProductNumberField({ form, editing }: { form: Form; editing: boolean }) {
  const t = useTranslations("products.form");
  const preview = useAuthedQuery(api.products.nextNumber, {}, !editing);
  const description = editing
    ? undefined
    : preview
      ? t("numberAuto", { preview })
      : preview === null
        ? t("numberAutoNoRange")
        : undefined;
  return <TextField form={form} name="number" label={t("number")} description={description} spellCheck={false} />;
}

function CategorySelect({ form }: { form: Form }) {
  const t = useTranslations("products.form");
  const categories = useAuthedQuery(api.products.categories, {}) ?? [];
  return (
    <SelectField
      form={form}
      name="categoryId"
      label={t("category")}
      placeholder={t("categoryNone")}
      options={categories.map((c) => ({ value: c._id, label: c.path }))}
    />
  );
}

function useUnitOptions() {
  const units = useAuthedQuery(api.lookups.listUnits, {}) ?? [];
  return units.filter((u) => u.archivedAt === null).map((u) => ({ value: u.code, label: `${u.labelDe} (${u.code})` }));
}

function UnitSelect({
  form,
  name,
  label,
}: {
  form: Form;
  name: "unitCode" | `extraUnits.${number}.unitCode`;
  label: string;
}) {
  const options = useUnitOptions();
  const current = useWatch({ control: form.control, name });
  // Keep the stored unit selectable while the list loads or after the unit was archived.
  const all =
    current && !options.some((o) => o.value === current) ? [{ value: current, label: current }, ...options] : options;
  return <SelectField form={form} name={name} label={label} options={all} />;
}

/** PRD-011/013: both views; the side typed into is the stored one, the other is derived at today's rate. */
function PriceInputs({ form }: { form: Form }) {
  const t = useTranslations("products.form");
  const netId = useId();
  const grossId = useId();
  const mode = useWatch({ control: form.control, name: "priceMode" });
  const price = useWatch({ control: form.control, name: "price" });
  const key = useWatch({ control: form.control, name: "vatRateKey" });
  const rate = resolveRate(key, todayBerlin() as CalendarDate);
  const rateBp = rate.ok ? rate.value.value.rateBp : 0;
  const parsed = parseUnitPrice(price);
  const derived = (side: "net" | "gross") =>
    side === mode
      ? price
      : parsed.ok && price !== ""
        ? formatMicros(convertPriceMode(parsed.value, mode, side, rateBp))
        : "";
  const error = form.formState.errors.price?.message;
  const set = (side: "net" | "gross", value: string) => {
    form.setValue("priceMode", side, { shouldDirty: true });
    form.setValue("price", value, { shouldDirty: true, shouldValidate: form.formState.isSubmitted });
  };
  return (
    <>
      {(["net", "gross"] as const).map((side) => {
        const id = side === "net" ? netId : grossId;
        return (
          <div key={side} className="flex flex-col gap-1.5">
            <label htmlFor={id} className="font-medium text-sm">
              {t(side)}
            </label>
            <div className="relative">
              <Input
                id={id}
                inputMode="decimal"
                className="h-11 pr-8 text-right tabular-nums md:h-9"
                value={derived(side)}
                aria-invalid={side === mode && error ? true : undefined}
                aria-describedby={`${id}-hint${side === mode && error ? ` ${id}-e` : ""}`}
                onChange={(e) => set(side, e.target.value)}
              />
              <span
                aria-hidden="true"
                className="-translate-y-1/2 absolute top-1/2 right-3 text-muted-foreground text-sm"
              >
                €
              </span>
            </div>
            <p id={`${id}-hint`} className="text-muted-foreground text-sm">
              {side === mode ? t("entered") : t("derived", { rate: formatBasisPoints(rateBp) })}
            </p>
            {side === mode && error && (
              <p id={`${id}-e`} className="text-danger text-sm">
                {error}
              </p>
            )}
          </div>
        );
      })}
    </>
  );
}

/** PRD-035: up to 10 extra units with a factor of the base unit; the price is derived (never stored). */
function ExtraUnits({ form }: { form: Form }) {
  const t = useTranslations("products.form");
  const { fields, append, remove } = useFieldArray({ control: form.control, name: "extraUnits" });
  const price = useWatch({ control: form.control, name: "price" });
  const rows = useWatch({ control: form.control, name: "extraUnits" });
  const base = parseUnitPrice(price);
  return (
    <div className="flex flex-col gap-3 @lg/form:col-span-2">
      {fields.map((f, i) => {
        const factor = parseMilli(rows?.[i]?.factor ?? "");
        const p = base.ok && factor.ok ? `${formatMicros(extraUnitPriceMicros(base.value, factor.value))} €` : "—";
        return (
          <div
            key={f.id}
            className="grid items-end gap-3 rounded-lg border p-3 @lg/form:grid-cols-[1fr_10rem_8rem_auto]"
          >
            <UnitSelect form={form} name={`extraUnits.${i}.unitCode`} label={t("extraUnit")} />
            <TextField form={form} name={`extraUnits.${i}.factor`} label={t("factor")} inputMode="decimal" />
            <div className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">{t("extraPrice")}</span>
              <output className="flex h-11 items-center tabular-nums md:h-9">{p}</output>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-11 md:size-9"
              aria-label={t("removeExtraUnit", { n: i + 1 })}
              onClick={() => remove(i)}
            >
              <Trash2Icon aria-hidden="true" />
            </Button>
          </div>
        );
      })}
      {fields.length < MAX_EXTRA_UNITS && (
        <Button
          type="button"
          variant="outline"
          className="h-11 self-start md:h-9"
          onClick={() => append({ unitCode: "", factor: "" })}
        >
          <PlusIcon aria-hidden="true" />
          {t("addExtraUnit")}
        </Button>
      )}
    </div>
  );
}

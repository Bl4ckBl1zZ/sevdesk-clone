"use client";

import { api } from "@convex/_generated/api";
import type { Doc } from "@convex/_generated/dataModel";
import { useMutation } from "convex/react";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { type UseFormReturn, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { FormDialog, FormSection, useRun } from "@/components/catalog/shared";
import { FormErrorSummary, SelectField, TextField } from "@/components/forms/fields";
import { useZodForm } from "@/components/setup/use-zod-form";
import { ContactSelectField } from "@/components/time/time-shared";
import { Button } from "@/components/ui/button";
import {
  emptyProjectForm,
  type ProjectFormValues,
  projectFormFromRecord,
  projectFormSchema,
} from "@/domain/schemas/projects";
import { useAuthedQuery } from "@/hooks/use-authed-query";

type Form = UseFormReturn<ProjectFormValues>;

const INCREMENTS = ["1", "5", "6", "10", "15", "30", "60"] as const;
const STATUSES = ["active", "done", "archived"] as const;
const BILLING = ["hourly", "fixed", "non_billable"] as const;

/** Project form fields (F11 PRJ-001/003/008/011): master data, billing, budget and rounding. */
function ProjectFields({
  form,
  contact,
  defaultProduct,
  withStatus,
}: {
  form: Form;
  contact?: { _id: string; displayName: string } | null;
  defaultProduct?: { _id: string; name: string } | null;
  withStatus: boolean;
}) {
  const t = useTranslations("projects.form");
  const tl = useTranslations("projects.list");
  const budgetKind = useWatch({ control: form.control, name: "budgetKind" });
  const increment = useWatch({ control: form.control, name: "roundingIncrement" });
  const products = useAuthedQuery(api.products.options, {}) ?? [];
  const productOptions = products.map((p) => ({ value: p._id as string, label: `${p.name} (${p.number})` }));
  if (defaultProduct && !productOptions.some((o) => o.value === defaultProduct._id)) {
    productOptions.unshift({ value: defaultProduct._id, label: defaultProduct.name });
  }
  return (
    <>
      <FormErrorSummary form={form} />
      <FormSection title={t("sections.basics")}>
        <TextField form={form} name="name" label={t("name")} required className="@lg/form:col-span-2" />
        <TextField form={form} name="description" label={t("description")} className="@lg/form:col-span-2" />
        <ContactSelectField
          form={form}
          name="contactId"
          label={t("contact")}
          searchLabel={t("contactSearch")}
          emptyLabel={t("noContact")}
          initial={contact ?? null}
        />
        {withStatus && (
          <SelectField
            form={form}
            name="status"
            label={t("status")}
            options={STATUSES.map((s) => ({ value: s, label: tl(`status.${s}`) }))}
          />
        )}
      </FormSection>
      <FormSection title={t("sections.billing")}>
        <SelectField
          form={form}
          name="billingMode"
          label={t("billingMode")}
          options={BILLING.map((b) => ({ value: b, label: t(`billingModes.${b}`) }))}
        />
        <SelectField
          form={form}
          name="defaultProductId"
          label={t("defaultProduct")}
          description={t("defaultProductHint")}
          placeholder={t("noProduct")}
          options={productOptions}
        />
        <TextField
          form={form}
          name="hourlyRate"
          label={t("hourlyRate")}
          description={t("hourlyRateHint")}
          inputMode="decimal"
        />
        <TextField
          form={form}
          name="internalCostRate"
          label={t("internalCostRate")}
          description={t("internalCostRateHint")}
          inputMode="decimal"
        />
      </FormSection>
      <FormSection title={t("sections.budget")}>
        <SelectField
          form={form}
          name="budgetKind"
          label={t("budgetKind")}
          options={(["none", "hours", "amount"] as const).map((k) => ({ value: k, label: t(`budgetKinds.${k}`) }))}
        />
        {budgetKind !== "none" && (
          <TextField
            form={form}
            name="budgetValue"
            label={t("budgetValue")}
            description={t("budgetValueHint")}
            inputMode="decimal"
            required
          />
        )}
        <TextField form={form} name="startDate" label={t("startDate")} type="date" />
        <TextField form={form} name="endDate" label={t("endDate")} type="date" />
      </FormSection>
      <FormSection title={t("sections.rounding")}>
        <SelectField
          form={form}
          name="roundingIncrement"
          label={t("roundingIncrement")}
          description={t("roundingHint")}
          options={[
            { value: "default", label: t("roundingDefault") },
            { value: "0", label: t("roundingNone") },
            ...INCREMENTS.map((i) => ({ value: i, label: t("minutes", { count: Number(i) }) })),
          ]}
        />
        {increment !== "default" && increment !== "0" && (
          <>
            <SelectField
              form={form}
              name="roundingMode"
              label={t("roundingMode")}
              options={(["up", "nearest"] as const).map((m) => ({ value: m, label: t(`roundingModes.${m}`) }))}
            />
            <TextField form={form} name="roundingMinimum" label={t("roundingMinimum")} inputMode="numeric" />
          </>
        )}
      </FormSection>
    </>
  );
}

/** „Neues Projekt“ (PRJ-001): numbered from the project range on save, then opens the project. */
export function ProjectCreateDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslations("projects.form");
  const tl = useTranslations("projects.list");
  const router = useRouter();
  const run = useRun();
  const create = useMutation(api.projects.create);
  const formId = useId();
  const form = useZodForm(projectFormSchema, emptyProjectForm()) as unknown as Form;
  const submit = form.handleSubmit(async () => {
    const r = await run(() => create({ values: form.getValues() }));
    if (!r.ok) return;
    toast.success(tl("created", { number: r.value.number }));
    router.push(`/projekte/${r.value.id}` as Route);
  });
  return (
    <FormDialog
      title={t("newTitle")}
      formId={formId}
      onClose={onClose}
      onSubmit={submit}
      submitting={form.formState.isSubmitting}
      wide
    >
      <ProjectFields form={form} withStatus={false} />
    </FormDialog>
  );
}

/** „Einstellungen“ tab (PRJ-001/003/008/011); E-PRJ-19 offers to apply a changed rate to open entries. */
export function ProjectSettingsForm({
  project,
  contact,
  defaultProduct,
}: {
  project: Doc<"projects">;
  contact: { _id: string; displayName: string } | null;
  defaultProduct: { _id: string; name: string } | null;
}) {
  const t = useTranslations("projects.form");
  const tCommon = useTranslations("common");
  const run = useRun();
  const update = useMutation(api.projects.update);
  const applyRate = useMutation(api.projects.applyRateToOpenEntries);
  const [oldRate, setOldRate] = useState(0);
  const formId = useId();
  const form = useZodForm(projectFormSchema, projectFormFromRecord(project)) as unknown as Form;
  const submit = form.handleSubmit(async () => {
    const r = await run(() => update({ id: project._id, values: form.getValues() }), t("saved"));
    if (r.ok) setOldRate(r.value.openEntriesWithOldRate);
  });
  return (
    <form id={formId} noValidate onSubmit={submit} className="@container/form flex flex-col gap-4">
      <ProjectFields form={form} contact={contact} defaultProduct={defaultProduct} withStatus />
      {oldRate > 0 && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm"
        >
          <span>{t("rateChanged", { count: oldRate })}</span>
          <Button
            type="button"
            variant="outline"
            className="h-11 md:h-9"
            onClick={async () => {
              const r = await run(() => applyRate({ id: project._id }));
              if (r.ok) {
                toast.success(t("rateApplied", { count: r.value.updated }));
                setOldRate(0);
              }
            }}
          >
            {t("applyRate")}
          </Button>
        </div>
      )}
      <div className="flex justify-end">
        <Button type="submit" className="h-11 md:h-9" disabled={form.formState.isSubmitting}>
          {tCommon("save")}
        </Button>
      </div>
    </form>
  );
}

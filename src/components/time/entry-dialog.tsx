"use client";

import { api } from "@convex/_generated/api";
import { useMutation } from "convex/react";
import { useTranslations } from "next-intl";
import { useId } from "react";
import { type UseFormReturn, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { FormDialog, todayBerlin, useRun } from "@/components/catalog/shared";
import { CheckboxField, FormErrorSummary, SelectField, TextField } from "@/components/forms/fields";
import { useZodForm } from "@/components/setup/use-zod-form";
import {
  emptyTimeEntryForm,
  type TimeEntryFormValues,
  timeEntryFormFromRecord,
  timeEntryFormSchema,
} from "@/domain/schemas/projects";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { ContactSelectField, type TimeEntryRow, useProjectOptions } from "./time-shared";
import { useOfflineTime } from "./use-offline-time";

type Form = UseFormReturn<TimeEntryFormValues>;

/** „Zeit erfassen“ / „Zeiteintrag bearbeiten“ (PRJ-007): duration in any notation or a from–to range. */
export function TimeEntryDialog({
  entry,
  projectId,
  onClose,
}: {
  entry?: TimeEntryRow;
  /** Preselected project (project page). */
  projectId?: string;
  onClose: () => void;
}) {
  const t = useTranslations("time.entry");
  const run = useRun();
  const create = useMutation(api.timeEntries.create);
  const update = useMutation(api.timeEntries.update);
  const offline = useOfflineTime();
  const formId = useId();
  const projects = useProjectOptions();
  const products = useAuthedQuery(api.products.options, {}) ?? [];
  const initial: TimeEntryFormValues = entry
    ? timeEntryFormFromRecord(entry)
    : { ...emptyTimeEntryForm(todayBerlin()), projectId: projectId ?? "" };
  const form = useZodForm(timeEntryFormSchema, initial) as unknown as Form;
  const mode = useWatch({ control: form.control, name: "mode" });
  const project = useWatch({ control: form.control, name: "projectId" });

  const submit = form.handleSubmit(async () => {
    const values = form.getValues();
    if (!entry && !offline.online) {
      // PRJ-018: queued in IndexedDB, replayed (and validated by the server) when the device is back online
      await offline.enqueue({ kind: "manual", at: Date.now(), values: { ...values } });
      toast.info(t("offlineQueued"));
      onClose();
      return;
    }
    const r = entry ? await run(() => update({ id: entry._id, values })) : await run(() => create({ values }));
    if (!r.ok) return;
    toast.success(entry ? t("saved") : t("created"));
    for (const w of r.value.warnings) toast.warning(w);
    onClose();
  });

  const projectOptions = projects.map((p) => ({ value: p._id as string, label: `${p.name} (${p.number})` }));
  if (entry?.projectId && entry.projectName && !projectOptions.some((o) => o.value === entry.projectId)) {
    projectOptions.unshift({ value: entry.projectId, label: entry.projectName });
  }
  const productOptions = products.map((p) => ({ value: p._id as string, label: `${p.name} (${p.number})` }));
  if (entry?.productId && entry.productName && !productOptions.some((o) => o.value === entry.productId)) {
    productOptions.unshift({ value: entry.productId, label: entry.productName });
  }

  return (
    <FormDialog
      title={entry ? t("editTitle") : t("newTitle")}
      formId={formId}
      onClose={onClose}
      onSubmit={submit}
      submitting={form.formState.isSubmitting}
    >
      <FormErrorSummary form={form} />
      <div className="grid gap-4 @md/form:grid-cols-2">
        <TextField form={form} name="date" label={t("date")} type="date" required />
        <SelectField
          form={form}
          name="mode"
          label={t("mode")}
          options={(["duration", "start_end"] as const).map((m) => ({ value: m, label: t(`modes.${m}`) }))}
        />
        {mode === "duration" ? (
          <TextField
            form={form}
            name="duration"
            label={t("duration")}
            description={t("durationHint")}
            inputMode="decimal"
            required
            className="@md/form:col-span-2"
          />
        ) : (
          <>
            <TextField form={form} name="startTime" label={t("startTime")} type="time" required />
            <TextField form={form} name="endTime" label={t("endTime")} type="time" required />
          </>
        )}
      </div>
      <TextField form={form} name="description" label={t("description")} required />
      <SelectField form={form} name="projectId" label={t("project")} placeholder={t("none")} options={projectOptions} />
      {!project && (
        <ContactSelectField
          form={form}
          name="contactId"
          label={t("contact")}
          searchLabel={t("contactSearch")}
          emptyLabel={t("none")}
          initial={
            entry?.contactId && entry.contactName ? { _id: entry.contactId, displayName: entry.contactName } : null
          }
        />
      )}
      <SelectField form={form} name="productId" label={t("product")} placeholder={t("none")} options={productOptions} />
      <TextField form={form} name="rate" label={t("rate")} description={t("rateHint")} inputMode="decimal" />
      <CheckboxField form={form} name="billable" label={t("billable")} />
    </FormDialog>
  );
}

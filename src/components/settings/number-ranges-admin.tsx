"use client";

import { api } from "@convex/_generated/api";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { PlusIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import { toast } from "sonner";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { FormErrorSummary, SelectField, TextField } from "@/components/forms/fields";
import { useZodForm } from "@/components/setup/use-zod-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RESET_POLICIES } from "@/domain/numbering/format";
import { NUMBERED_TYPE_LABEL_DE } from "@/domain/numbering/register";
import {
  NUMBERED_DOC_TYPES,
  type NumberRangeCreateFormValues,
  type NumberRangeCreateValues,
  numberRangeCreateSchema,
} from "@/domain/schemas/settings";
import { useAdapterErrorToast } from "@/hooks/use-adapter-error-toast";
import { useAuthedQuery } from "@/hooks/use-authed-query";

type Range = FunctionReturnType<typeof api.settings.listNumberRanges>[number];
type CreateForm = UseFormReturn<NumberRangeCreateFormValues, unknown, NumberRangeCreateValues>;

const typeLabel = (t: string) => NUMBERED_TYPE_LABEL_DE[t] ?? t;

/**
 * „Alle Nummernkreise“ (F01 SET-055, SET-062): every range incl. extra ones, with „Deaktivieren“ and — only while no
 * number was issued — „Löschen“. New ranges are collision-checked on the server (SET-060).
 */
export function NumberRangesAdmin() {
  return (
    <ConvexGuard fallback={null}>
      <NumberRangesAdminInner />
    </ConvexGuard>
  );
}

function NumberRangesAdminInner() {
  const t = useTranslations("settings.numberRanges");
  const ranges = useAuthedQuery(api.settings.listNumberRanges, {});
  const [creating, setCreating] = useState(false);
  if (ranges === undefined) return <div className="h-40" aria-busy="true" />;
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <CardTitle>
            <h2>{t("allTitle")}</h2>
          </CardTitle>
          <CardDescription>{t("allDescription")}</CardDescription>
        </div>
        <Button variant="outline" className="h-11 md:h-9" onClick={() => setCreating(true)}>
          <PlusIcon aria-hidden="true" />
          {t("create")}
        </Button>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col divide-y rounded-lg border">
          {ranges.map((r) => (
            <RangeRow key={r.rangeId} range={r} />
          ))}
        </ul>
      </CardContent>
      <CreateRangeDialog open={creating} onOpenChange={setCreating} />
    </Card>
  );
}

function RangeRow({ range }: { range: Range }) {
  const t = useTranslations("settings.numberRanges");
  const deactivate = useMutation(api.settings.deactivateNumberRange);
  const remove = useMutation(api.settings.deleteNumberRange);
  const showError = useAdapterErrorToast();
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, success: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(success);
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="flex flex-col gap-2 p-3 text-sm @2xl/main:flex-row @2xl/main:items-center">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2 font-medium">
          {range.name}
          {range.isDefault && <Badge variant="secondary">{t("default")}</Badge>}
          {!range.active && <Badge variant="outline">{t("inactive")}</Badge>}
          {range.inUse && <Badge variant="outline">{t("inUse")}</Badge>}
        </span>
        <span className="text-muted-foreground">
          {range.docTypes.map(typeLabel).join(", ")} · <code className="font-mono">{range.format}</code> ·{" "}
          {t(`reset.${range.resetPolicy}`)} · {t("next")} {range.next}
        </span>
      </div>
      <div className="flex gap-2">
        {range.active && (
          <Button
            variant="outline"
            size="sm"
            className="h-11 md:h-8"
            disabled={busy}
            onClick={() => void run(() => deactivate({ rangeId: range.rangeId }), t("deactivated"))}
          >
            {t("deactivate")}
            <span className="sr-only"> ({range.name})</span>
          </Button>
        )}
        {!range.inUse && (
          <Button
            variant="outline"
            size="sm"
            className="h-11 md:h-8"
            disabled={busy}
            onClick={() => void run(() => remove({ rangeId: range.rangeId }), t("deleted"))}
          >
            {t("delete")}
            <span className="sr-only"> ({range.name})</span>
          </Button>
        )}
      </div>
    </li>
  );
}

const createDefaults: NumberRangeCreateFormValues = {
  name: "",
  docTypes: ["cancellation"],
  format: "ST-{YYYY}-{####}",
  resetPolicy: "yearly",
  startValue: 1,
};

function CreateRangeDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations("settings.numberRanges");
  const tCommon = useTranslations("common");
  const formId = useId();
  const create = useMutation(api.settings.createNumberRange);
  const showError = useAdapterErrorToast();
  const form = useZodForm(numberRangeCreateSchema, createDefaults) as CreateForm;
  const submit = form.handleSubmit(async (values) => {
    try {
      await create({ values });
      toast.success(t("created"));
      form.reset(createDefaults);
      onOpenChange(false);
    } catch (e) {
      showError(e);
    }
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("createTitle")}</DialogTitle>
          <DialogDescription>{t("createDescription")}</DialogDescription>
        </DialogHeader>
        <form id={formId} noValidate onSubmit={submit} className="flex flex-col gap-4">
          <FormErrorSummary form={form} />
          <TextField form={form} name="name" label={t("name")} required />
          <SelectField
            form={form}
            name="docTypes.0"
            label={t("docType")}
            required
            options={NUMBERED_DOC_TYPES.map((d) => ({ value: d, label: typeLabel(d) }))}
          />
          <TextField form={form} name="format" label={t("format")} required spellCheck={false} />
          <SelectField
            form={form}
            name="resetPolicy"
            label={t("resetPolicy")}
            options={RESET_POLICIES.map((r) => ({ value: r, label: t(`reset.${r}`) }))}
          />
          <TextField form={form} name="startValue" label={t("startValue")} type="number" inputMode="numeric" min={1} />
        </form>
        <DialogFooter>
          <Button variant="outline" className="h-11 md:h-9" onClick={() => onOpenChange(false)}>
            {tCommon("cancel")}
          </Button>
          <Button type="submit" form={formId} className="h-11 md:h-9" disabled={form.formState.isSubmitting}>
            {t("create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

"use client";

import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import { FormErrorSummary, RadioCardGroup } from "@/components/forms/fields";
import { type LayoutValues, LOGO_TYPES, layoutSchema, validateLogo } from "../schema";
import { useZodForm } from "../use-zod-form";

type LayoutForm = UseFormReturn<LayoutValues, unknown, LayoutValues>;

/** Default layout: template, accent colour and logo (F01 SET-071, SET-018; §6.2 step 9). */
export function LayoutForm({
  id,
  defaultValues,
  onValid,
}: {
  id: string;
  defaultValues: LayoutValues;
  onValid: (values: LayoutValues & { logo: File | null }) => Promise<void> | void;
}) {
  const t = useTranslations("setup.layout");
  const form = useZodForm(layoutSchema, defaultValues) as LayoutForm;
  const colorId = useId();
  const logoId = useId();
  const [logo, setLogo] = useState<File | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
  const colorError = form.formState.errors.accentColor?.message;

  return (
    <form
      id={id}
      noValidate
      onSubmit={form.handleSubmit((v) => (logoError ? undefined : onValid({ ...v, logo })))}
      className="@container/form flex flex-col gap-6"
    >
      <FormErrorSummary form={form} />
      <div className="flex flex-col gap-1.5">
        <label htmlFor={logoId} className="font-medium text-sm">
          {t("logo")}
        </label>
        <input
          id={logoId}
          type="file"
          accept={LOGO_TYPES.join(",")}
          aria-invalid={logoError ? true : undefined}
          aria-describedby={`${logoId}-hint${logoError ? ` ${logoId}-error` : ""}`}
          className="text-sm file:mr-3 file:h-11 file:rounded-md file:border file:bg-background file:px-3 md:file:h-9"
          onChange={(e) => {
            const file = e.target.files?.[0] ?? null;
            setLogo(file);
            setLogoError(file ? validateLogo(file) : null);
          }}
        />
        <p id={`${logoId}-hint`} className="text-muted-foreground text-sm">
          PNG, JPG oder SVG, höchstens 2 MB, mindestens 300 px breit.
        </p>
        {logoError && (
          <p id={`${logoId}-error`} className="text-danger text-sm">
            {logoError}
          </p>
        )}
      </div>
      <RadioCardGroup
        form={form}
        name="template"
        label={t("template")}
        required
        columns={3}
        options={(["classic", "modern", "minimal"] as const).map((v) => ({ value: v, label: t(`templates.${v}`) }))}
      />
      <div className="flex flex-col gap-1.5">
        <label htmlFor={colorId} className="font-medium text-sm">
          {t("accentColor")}
        </label>
        <input
          id={colorId}
          type="color"
          aria-invalid={colorError ? true : undefined}
          className="h-11 w-20 cursor-pointer rounded-md border bg-background p-1"
          {...form.register("accentColor")}
        />
        {colorError && <p className="text-danger text-sm">{colorError}</p>}
      </div>
      <p className="text-muted-foreground text-sm">{t("previewHint")}</p>
    </form>
  );
}

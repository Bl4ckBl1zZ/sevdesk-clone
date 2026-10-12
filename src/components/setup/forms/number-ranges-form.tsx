"use client";

import { useTranslations } from "next-intl";
import { type UseFormReturn, useFieldArray, useWatch } from "react-hook-form";
import { FormErrorSummary, TextField } from "@/components/forms/fields";
import { checkFormat, previewNumbers, type ResetPolicy } from "../number-format";
import { type NumberRangesFormValues, type NumberRangesValues, numberRangesSchema } from "../schema";
import { useZodForm } from "../use-zod-form";

type RangesForm = UseFormReturn<NumberRangesFormValues, unknown, NumberRangesValues>;

const TOKENS = [
  ["{YYYY}", "tokenYear"],
  ["{YY}", "tokenYearShort"],
  ["{MM}", "tokenMonth"],
  ["{####}", "tokenCounter"],
] as const;

/** Year and month of "today" in Europe/Berlin (GOBD-22), for the preview only. */
export function berlinYearMonth(now = new Date()): { year: number; month: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit" })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return { year: Number(parts.year), month: Number(parts.month) };
}

/**
 * Number ranges with inline format / next-value editing and a live preview (F01 SET-006, SET-056…058).
 * Numbers are only assigned at finalisation (SET-061); this edits formats and counters.
 */
export function NumberRangesForm({
  id,
  defaultValues,
  onValid,
}: {
  id: string;
  defaultValues: NumberRangesFormValues;
  onValid: (values: NumberRangesValues) => Promise<void> | void;
}) {
  const t = useTranslations("setup.ranges");
  const form = useZodForm(numberRangesSchema, defaultValues) as RangesForm;
  const { fields } = useFieldArray({ control: form.control, name: "ranges" });
  const today = berlinYearMonth();

  return (
    <form id={id} noValidate onSubmit={form.handleSubmit(onValid)} className="@container/form flex flex-col gap-4">
      <FormErrorSummary form={form} />
      <div className="text-muted-foreground text-sm">
        <p>{t("draftHint")}</p>
        <p className="mt-1">
          {t("tokens")}:{" "}
          {TOKENS.map(([token, key], i) => (
            <span key={token}>
              {i > 0 && " · "}
              <code className="rounded bg-muted px-1 text-foreground">{token}</code> {t(key)}
            </span>
          ))}
        </p>
      </div>
      <ul className="flex flex-col divide-y rounded-lg border">
        {fields.map((field, i) => (
          <li key={field.id} className="p-3">
            <fieldset className="grid gap-3 @2xl/form:grid-cols-[10rem_minmax(0,1fr)_8rem_minmax(0,1fr)] @2xl/form:items-start">
              <legend className="sr-only">{field.name}</legend>
              <span aria-hidden="true" className="font-medium text-sm @2xl/form:pt-8">
                {field.name}
              </span>
              <TextField
                form={form}
                name={`ranges.${i}.format`}
                label={`${t("format")} ${field.name}`}
                spellCheck={false}
                autoCapitalize="off"
              />
              <TextField
                form={form}
                name={`ranges.${i}.next`}
                label={t("next")}
                type="number"
                inputMode="numeric"
                min={1}
              />
              <Preview form={form} index={i} today={today} />
            </fieldset>
          </li>
        ))}
      </ul>
    </form>
  );
}

function Preview({ form, index, today }: { form: RangesForm; index: number; today: { year: number; month: number } }) {
  const t = useTranslations("setup.ranges");
  const [format, next, reset] = useWatch({
    control: form.control,
    name: [`ranges.${index}.format`, `ranges.${index}.next`, `ranges.${index}.resetPolicy`],
  });
  const check = checkFormat(format ?? "", (reset ?? "never") as ResetPolicy);
  const n = Number(next);
  return (
    <div className="flex flex-col gap-1.5" aria-live="polite">
      <span className="font-medium text-sm">{t("preview")}</span>
      {check.ok && Number.isInteger(n) && n >= 1 ? (
        <ul className="flex flex-col font-mono text-sm tabular-nums" data-volatile="">
          {previewNumbers(format ?? "", today, n).map((num) => (
            <li key={num} className="whitespace-nowrap">
              {num}
            </li>
          ))}
        </ul>
      ) : (
        <span className="text-muted-foreground text-sm">—</span>
      )}
    </div>
  );
}

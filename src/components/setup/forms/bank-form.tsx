"use client";

import { useTranslations } from "next-intl";
import { type UseFormReturn, useWatch } from "react-hook-form";
import { FormErrorSummary, TextField } from "@/components/forms/fields";
import { type BankFormValues, type BankValues, bankSchema } from "../schema";
import { useZodForm } from "../use-zod-form";

type BankForm = UseFormReturn<BankFormValues, unknown, BankValues>;

/** Manual invoice bank account (F01 SET-050…052; before P2 there is no bank connection). */
export function BankForm({
  id,
  defaultValues,
  onValid,
  companyName,
}: {
  id: string;
  defaultValues: BankFormValues;
  onValid: (values: BankValues) => Promise<void> | void;
  companyName?: string;
}) {
  const t = useTranslations("setup.bank");
  const form = useZodForm(bankSchema, defaultValues) as BankForm;
  const holder = useWatch({ control: form.control, name: "accountHolder" });
  const showVopHint = !!holder && !!companyName && holder.trim() !== companyName.trim();

  return (
    <form id={id} noValidate onSubmit={form.handleSubmit(onValid)} className="@container/form flex flex-col gap-4">
      <FormErrorSummary form={form} />
      <div className="grid gap-4 @lg/form:grid-cols-2">
        <TextField
          form={form}
          name="iban"
          label={t("iban")}
          required
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          className="@lg/form:col-span-2"
        />
        <TextField form={form} name="bic" label={t("bic")} autoCapitalize="characters" spellCheck={false} />
        <div className="flex flex-col gap-1.5">
          <span className="font-medium text-sm">{t("currency")}</span>
          <span className="flex h-11 items-center text-sm md:h-9">EUR</span>
        </div>
        <TextField
          form={form}
          name="accountHolder"
          label={t("accountHolder")}
          required
          maxLength={70}
          className="@lg/form:col-span-2"
          description={showVopHint ? t("accountHolderHint") : undefined}
        />
      </div>
      <p className="text-muted-foreground text-sm">{t("connectLater")}</p>
    </form>
  );
}

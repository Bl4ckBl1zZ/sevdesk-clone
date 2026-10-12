"use client";

import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { type UseFormReturn, useWatch } from "react-hook-form";
import { CheckboxField, FormErrorSummary, RadioCardGroup, SelectField, TextField } from "@/components/forms/fields";
import { fieldsFor } from "@/domain/company/legal-forms";
import { type TaxFormValues, type TaxValues, taxSchema } from "@/domain/schemas/settings";
import { BUNDESLAENDER } from "../countries";
import type { TAX_SECTIONS } from "../sections";
import { useZodForm } from "../use-zod-form";

type TaxForm = UseFormReturn<TaxFormValues, unknown, TaxValues>;

const monthNames = Array.from({ length: 12 }, (_, i) =>
  new Intl.DateTimeFormat("de-DE", { month: "long", timeZone: "UTC" }).format(Date.UTC(2026, i, 1)),
);

/**
 * Tax settings (F01 SET-030…043, §6.2 step 7): Steuernummer/USt-IdNr, Kleinunternehmer, Soll/Ist, UStVA period,
 * EÜR/Bilanz, chart of accounts (SKR03 preselected), fiscal year, founding date, prior-year turnover.
 * The KU history, waiver lock and retroactive rules are enforced by the domain on save (SET-033/034).
 */
export function TaxForm({
  id,
  defaultValues,
  onValid,
  currentYear,
  withSectionIds = false,
}: {
  id: string;
  defaultValues: TaxFormValues;
  onValid: (values: TaxValues) => Promise<void> | void;
  currentYear: number;
  withSectionIds?: boolean;
}) {
  const t = useTranslations("setup.tax");
  const tTabs = useTranslations("settings.tabs");
  const form = useZodForm(taxSchema, defaultValues) as TaxForm;
  const [isKu, method, profitMethod, legalForm] = useWatch({
    control: form.control,
    name: ["isKleinunternehmer", "taxationMethod", "profitMethod", "legalForm"],
  });
  const f = fieldsFor(legalForm);
  const sectionId = (s: (typeof TAX_SECTIONS)[number]) => (withSectionIds ? `abschnitt-${s}` : undefined);

  // KU-05: Kleinunternehmer years have no UStVA (annual declaration only).
  useEffect(() => {
    if (isKu === "yes") form.setValue("ustvaPeriod", "annual_only");
  }, [isKu, form]);
  // SET-039: EÜR is not allowed for this legal form.
  useEffect(() => {
    if (f.euerBlocked && profitMethod === "euer") form.setValue("profitMethod", "bilanz");
  }, [f.euerBlocked, profitMethod, form]);

  return (
    <form id={id} noValidate onSubmit={form.handleSubmit(onValid)} className="@container/form flex flex-col gap-8">
      <FormErrorSummary form={form} />
      <Section id={sectionId("steuernummern")} title={tTabs("steuernummern")}>
        <p className="text-muted-foreground text-sm">{t("taxIdHint")}</p>
        <div className="grid gap-4 @lg/form:grid-cols-2">
          <SelectField
            form={form}
            name="taxNumberState"
            label={t("taxNumberState")}
            placeholder={t("taxNumberStatePlaceholder")}
            options={BUNDESLAENDER.map(([value, label]) => ({ value, label }))}
          />
          <TextField
            form={form}
            name="taxNumber"
            label={t("taxNumber")}
            inputMode="numeric"
            placeholder="181/815/08155"
          />
          <TextField
            form={form}
            name="vatId"
            label={t("vatId")}
            placeholder="DE123456789"
            autoCapitalize="characters"
          />
        </div>
      </Section>

      <Section id={sectionId("kleinunternehmer")} title={tTabs("kleinunternehmer")}>
        <RadioCardGroup
          form={form}
          name="isKleinunternehmer"
          label={t("ku")}
          required
          columns={2}
          options={[
            { value: "no", label: t("kuNo") },
            { value: "yes", label: t("kuYes") },
          ]}
        />
        {isKu === "yes" && (
          <TextField form={form} name="kuValidFrom" label={t("kuSince")} type="date" required className="max-w-xs" />
        )}
      </Section>

      <Section id={sectionId("versteuerung")} title={tTabs("versteuerung")}>
        <RadioCardGroup
          form={form}
          name="taxationMethod"
          label={t("method")}
          required
          columns={2}
          options={[
            { value: "soll", label: t("methodSoll"), hint: t("methodSollHint") },
            { value: "ist", label: t("methodIst"), hint: t("methodIstHint") },
          ]}
        />
        {method === "ist" && <CheckboxField form={form} name="istConfirmed" label={t("istConfirm")} />}
        {isKu === "yes" ? (
          <p className="text-sm">
            <span className="font-medium">{t("ustvaPeriod", { year: currentYear })}:</span> {t("periodAnnual")} —{" "}
            <span className="text-muted-foreground">{t("periodKuHint")}</span>
          </p>
        ) : (
          <div className="grid gap-4 @lg/form:grid-cols-2">
            <SelectField
              form={form}
              name="ustvaPeriod"
              label={t("ustvaPeriod", { year: currentYear })}
              required
              options={[
                { value: "monthly", label: t("periodMonthly") },
                { value: "quarterly", label: t("periodQuarterly") },
                { value: "annual_only", label: t("periodAnnual") },
              ]}
            />
            <CheckboxField form={form} name="dauerfrist" label={t("dauerfrist")} className="@lg/form:pt-7" />
          </div>
        )}
      </Section>

      <Section id={sectionId("gewinnermittlung")} title={tTabs("gewinnermittlung")}>
        <RadioCardGroup
          form={form}
          name="profitMethod"
          label={t("profitMethod")}
          required
          columns={2}
          options={[
            { value: "euer", label: t("euer"), disabled: f.euerBlocked, disabledReason: t("euerBlocked") },
            { value: "bilanz", label: t("bilanz"), hint: t("bilanzNotice") },
          ]}
        />
        {profitMethod === "euer" && f.euerNeedsConfirmation && (
          <CheckboxField form={form} name="euerConfirmed" label={t("euerConfirm")} />
        )}
        <RadioCardGroup
          form={form}
          name="chartOfAccounts"
          label={t("chart")}
          required
          columns={2}
          options={[
            { value: "SKR03", label: "SKR03", hint: t("chartSkr03Hint") },
            { value: "SKR04", label: "SKR04", hint: t("chartSkr04Hint") },
          ]}
        />
        <div className="grid gap-4 @lg/form:grid-cols-2">
          <SelectField
            form={form}
            name="fiscalYearStartMonth"
            label={t("fiscalYearStart")}
            required
            options={monthNames.map((m, i) => ({ value: String(i + 1), label: m }))}
          />
          <TextField form={form} name="foundedOn" label={t("foundedOn")} type="date" />
        </div>
      </Section>

      <Section id={sectionId("umsaetze")} title={tTabs("umsaetze")}>
        <TextField
          form={form}
          name="priorYearTurnover"
          label={t("priorYearTurnover", { year: currentYear - 1 })}
          description={t("priorYearTurnoverHint")}
          inputMode="decimal"
          className="max-w-xs"
        />
      </Section>
    </form>
  );
}

function Section({ id, title, children }: { id?: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="flex flex-col gap-4" aria-label={title}>
      <h2 className="font-semibold text-base">{title}</h2>
      {children}
    </section>
  );
}

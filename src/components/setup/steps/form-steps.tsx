"use client";

import { useTranslations } from "next-intl";
import { saveBankAccount, saveCompanyProfile, saveLayout, saveNumberRanges, saveTaxSettings } from "../actions";
import { BankForm } from "../forms/bank-form";
import { CompanyForm } from "../forms/company-form";
import { LayoutForm } from "../forms/layout-form";
import { NumberRangesForm } from "../forms/number-ranges-form";
import { TaxForm } from "../forms/tax-form";
import { companyDefaults, taxDefaults } from "../schema";
import { SEEDED_RANGES } from "../seed-ranges";
import { useStepSubmit, useWizard } from "../wizard-context";

/** Step 6 "Unternehmen". */
export function CompanyStep() {
  const { formId, state, drafts, setDrafts } = useWizard();
  const submit = useStepSubmit();
  return (
    <CompanyForm
      id={formId}
      defaultValues={{ ...companyDefaults, ...state?.company, ...drafts.company }}
      onValid={(values) => {
        setDrafts((d) => ({ ...d, company: values }));
        return submit(() => saveCompanyProfile(values));
      }}
    />
  );
}

/** Step 7 "Steuern". */
export function TaxStep() {
  const { formId, state, drafts } = useWizard();
  const submit = useStepSubmit();
  const legalForm = drafts.company?.legalForm ?? state?.company?.legalForm ?? "einzelunternehmen";
  return (
    <TaxForm
      id={formId}
      currentYear={new Date().getFullYear()}
      defaultValues={{ ...taxDefaults(legalForm), ...state?.tax, legalForm }}
      onValid={(values) => submit(() => saveTaxSettings(values))}
    />
  );
}

/** Step 8 "Bank" (skippable). */
export function BankStep() {
  const t = useTranslations("setup.bank");
  const { formId, state, drafts } = useWizard();
  const submit = useStepSubmit();
  return (
    <div className="flex flex-col gap-4">
      <BankForm
        id={formId}
        companyName={drafts.company?.name ?? state?.company?.name}
        defaultValues={{ iban: "", bic: "", accountHolder: "", currency: "EUR", ...state?.bank }}
        onValid={(values) => submit(() => saveBankAccount(values))}
      />
      <p className="text-muted-foreground text-sm">{t("skipWarning")}</p>
    </div>
  );
}

/** Step 9 "Layout" (skippable). */
export function LayoutStep() {
  const { formId, state } = useWizard();
  const submit = useStepSubmit();
  return (
    <LayoutForm
      id={formId}
      defaultValues={{ template: "classic", accentColor: "#16a34a", ...state?.layout }}
      onValid={(values) => submit(() => saveLayout(values))}
    />
  );
}

/** Step 10 "Nummernkreise". */
export function NumberRangesStep() {
  const { formId, state } = useWizard();
  const submit = useStepSubmit();
  return (
    <NumberRangesForm
      id={formId}
      defaultValues={{ ranges: state?.numberRanges ?? SEEDED_RANGES }}
      onValid={(values) => submit(() => saveNumberRanges(values))}
    />
  );
}

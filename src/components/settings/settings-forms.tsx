"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { isNotConnected } from "@/components/not-connected";
import {
  getSetupState,
  type SetupState,
  saveBankAccount,
  saveCompanyProfile,
  saveLayout,
  saveNumberRanges,
  saveTaxSettings,
} from "@/components/setup/actions";
import { BankForm } from "@/components/setup/forms/bank-form";
import { CompanyForm } from "@/components/setup/forms/company-form";
import { LayoutForm } from "@/components/setup/forms/layout-form";
import { NumberRangesForm } from "@/components/setup/forms/number-ranges-form";
import { TaxForm } from "@/components/setup/forms/tax-form";
import { companyDefaults, taxDefaults } from "@/components/setup/schema";
import { SEEDED_RANGES } from "@/components/setup/seed-ranges";
import { Button } from "@/components/ui/button";
import { useAdapterErrorToast } from "@/hooks/use-adapter-error-toast";

export const SETTINGS_FORM_ID = "einstellungen-formular";

/** Primary action of a settings page (04-ui-ux §1.2): submits the page's form. */
export function SaveButton() {
  const t = useTranslations("common");
  return (
    <Button type="submit" form={SETTINGS_FORM_ID} className="h-11 md:h-9">
      {t("save")}
    </Button>
  );
}

/** Loads the current settings; `null` + banner while the backend is not connected. */
function useSettingsState() {
  const [state, setState] = useState<SetupState | null | undefined>(undefined);
  useEffect(() => {
    getSetupState()
      .then(setState)
      .catch((e: unknown) => {
        setState(null);
        if (!isNotConnected(e)) console.error(e);
      });
  }, []);
  return state;
}

function useSave() {
  const t = useTranslations("settings");
  const showAdapterError = useAdapterErrorToast();
  return async (fn: () => Promise<void>) => {
    try {
      await fn();
      // F01 §6.3: "Gespeichert · {n} Entwürfe übernehmen die Änderung" once drafts can be counted.
      toast.success(t("saved"));
    } catch (e) {
      showAdapterError(e);
    }
  };
}

function Frame({ state, children }: { state: SetupState | null | undefined; children: React.ReactNode }) {
  const tCommon = useTranslations("common");
  const t = useTranslations("settings");
  if (state === undefined) return <div className="h-96" aria-busy="true" />;
  return (
    <div className="flex flex-col gap-6">
      {state === null && (
        <p role="status" className="rounded-md border border-warning bg-warning/10 p-3 text-sm text-warning">
          {tCommon("notConnectedBanner")}
        </p>
      )}
      <p className="text-muted-foreground text-sm">{t("unchangedNotice")}</p>
      {children}
    </div>
  );
}

export function CompanySettings() {
  const state = useSettingsState();
  const save = useSave();
  return (
    <Frame state={state}>
      <CompanyForm
        id={SETTINGS_FORM_ID}
        withSectionIds
        defaultValues={{ ...companyDefaults, ...state?.company }}
        onValid={(v) => save(() => saveCompanyProfile(v))}
      />
    </Frame>
  );
}

export function TaxSettings() {
  const state = useSettingsState();
  const save = useSave();
  const legalForm = state?.company?.legalForm ?? "einzelunternehmen";
  return (
    <Frame state={state}>
      <TaxForm
        id={SETTINGS_FORM_ID}
        withSectionIds
        currentYear={new Date().getFullYear()}
        defaultValues={{ ...taxDefaults(legalForm), ...state?.tax, legalForm }}
        onValid={(v) => save(() => saveTaxSettings(v))}
      />
    </Frame>
  );
}

export function BankSettings() {
  const state = useSettingsState();
  const save = useSave();
  return (
    <Frame state={state}>
      <BankForm
        id={SETTINGS_FORM_ID}
        companyName={state?.company?.name}
        defaultValues={{ iban: "", bic: "", accountHolder: "", currency: "EUR", ...state?.bank }}
        onValid={(v) => save(() => saveBankAccount(v))}
      />
    </Frame>
  );
}

export function NumberRangesSettings() {
  const state = useSettingsState();
  const save = useSave();
  return (
    <Frame state={state}>
      <NumberRangesForm
        id={SETTINGS_FORM_ID}
        defaultValues={{ ranges: state?.numberRanges ?? SEEDED_RANGES }}
        onValid={(v) => save(() => saveNumberRanges(v))}
      />
    </Frame>
  );
}

export function LayoutSettings() {
  const state = useSettingsState();
  const save = useSave();
  return (
    <Frame state={state}>
      <LayoutForm
        id={SETTINGS_FORM_ID}
        defaultValues={{ template: "classic", accentColor: "#16a34a", ...state?.layout }}
        onValid={(v) => save(() => saveLayout(v))}
      />
    </Frame>
  );
}

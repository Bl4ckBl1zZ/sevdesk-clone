"use client";

import { api } from "@convex/_generated/api";
import { useTranslations } from "next-intl";
import { useId, useRef, useState } from "react";
import { toast } from "sonner";
import { ConvexGuard } from "@/components/convex/convex-provider";
import {
  adapterErrorReason,
  type SetupState,
  saveBankAccount,
  saveCompanyProfile,
  saveLayout,
  saveNumberRanges,
  saveTaxSettings,
} from "@/components/setup/actions";
import { BankForm } from "@/components/setup/forms/bank-form";
import { CompanyForm, type FooterContext } from "@/components/setup/forms/company-form";
import { LayoutForm } from "@/components/setup/forms/layout-form";
import { NumberRangesForm } from "@/components/setup/forms/number-ranges-form";
import { TaxForm } from "@/components/setup/forms/tax-form";
import { SEEDED_RANGES } from "@/components/setup/seed-ranges";
import { useSetupState } from "@/components/setup/use-setup-state";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { NumberRangesValues } from "@/domain/schemas/settings";
import { companyDefaults, taxDefaults } from "@/domain/schemas/settings";
import { useAdapterErrorToast } from "@/hooks/use-adapter-error-toast";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { ShareholderClearingPanel } from "./shareholder-clearing";

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

/** Live settings state; `undefined` while loading. */
function useSettingsState() {
  return useSetupState();
}

/**
 * SET-141: the profile version the form was loaded with. A save sends it back; if another tab or device saved in
 * between, the server answers `version_conflict` („… Bitte neu laden.") instead of overwriting.
 */
function useLoadedVersion(state: SetupState | undefined) {
  const ref = useRef<number | undefined>(undefined);
  if (ref.current === undefined && state) ref.current = state.version;
  return ref;
}

function useSave() {
  const t = useTranslations("settings");
  const showAdapterError = useAdapterErrorToast();
  return async (fn: () => Promise<void>, drafts?: number) => {
    try {
      await fn();
      // F01 §6.3 / SET-020: "Gespeichert · {n} Entwürfe übernehmen die Änderung" (finalised documents never change).
      toast.success(drafts ? t("savedDrafts", { count: drafts }) : t("saved"));
    } catch (e) {
      // Errors a page already answers with its own dialog (e.g. SET-059 reason) are not toasted again.
      if ((e as { handled?: boolean }).handled) return;
      showAdapterError(e);
    }
  };
}

function Frame({ state, children }: { state: SetupState | undefined; children: React.ReactNode }) {
  const t = useTranslations("settings");
  if (state === undefined) return <div className="h-96" aria-busy="true" />;
  return (
    <div className="flex flex-col gap-6">
      <p className="text-muted-foreground text-sm">{t("unchangedNotice")}</p>
      {children}
    </div>
  );
}

const loading = <div className="h-96" aria-busy="true" />;

export function CompanySettings() {
  return (
    <ConvexGuard fallback={loading}>
      <CompanySettingsInner />
    </ConvexGuard>
  );
}

function CompanySettingsInner() {
  const state = useSettingsState();
  const save = useSave();
  const version = useLoadedVersion(state);
  const accounts = useAuthedQuery(api.settings.listInvoiceAccounts, {});
  const impact = useAuthedQuery(api.settings.companyChangeImpact, {});
  const footerContext: FooterContext = {
    ...(state?.tax?.taxNumber ? { taxNumber: state.tax.taxNumber } : {}),
    ...(state?.tax?.taxNumberState ? { taxNumberState: state.tax.taxNumberState } : {}),
    ...(state?.tax?.vatId ? { vatId: state.tax.vatId } : {}),
    accounts: (accounts ?? [])
      .filter((a) => a.showOnInvoices && a.archivedAt === null)
      .map((a) => ({ name: a.name, iban: a.iban, bic: a.bic, accountHolder: a.accountHolder })),
  };
  return (
    <Frame state={state}>
      <CompanyForm
        id={SETTINGS_FORM_ID}
        withSectionIds
        footerContext={footerContext}
        defaultValues={{ ...companyDefaults, ...state?.company }}
        onValid={(v) =>
          save(async () => {
            version.current = await saveCompanyProfile(v, version.current);
          }, impact?.drafts)
        }
      />
    </Frame>
  );
}

export function TaxSettings() {
  return (
    <ConvexGuard fallback={loading}>
      <TaxSettingsInner />
    </ConvexGuard>
  );
}

function TaxSettingsInner() {
  const state = useSettingsState();
  const save = useSave();
  const version = useLoadedVersion(state);
  const legalForm = state?.company?.legalForm ?? "einzelunternehmen";
  return (
    <Frame state={state}>
      <TaxForm
        id={SETTINGS_FORM_ID}
        withSectionIds
        currentYear={new Date().getFullYear()}
        defaultValues={{ ...taxDefaults(legalForm), ...state?.tax, legalForm }}
        onValid={(v) =>
          save(async () => {
            version.current = await saveTaxSettings(v, version.current);
          })
        }
      />
      <ShareholderClearingPanel />
    </Frame>
  );
}

export function BankSettings() {
  return (
    <ConvexGuard fallback={loading}>
      <BankSettingsInner />
    </ConvexGuard>
  );
}

function BankSettingsInner() {
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
  return (
    <ConvexGuard fallback={loading}>
      <NumberRangesSettingsInner />
    </ConvexGuard>
  );
}

function NumberRangesSettingsInner() {
  const state = useSettingsState();
  const save = useSave();
  const t = useTranslations("settings.numberRanges");
  const tCommon = useTranslations("common");
  const reasonId = useId();
  // SET-059: raising „Nächste Nummer“ leaves a documented gap — the server asks for the reason (REASON_REQUIRED).
  const [pending, setPending] = useState<NumberRangesValues | null>(null);
  const [reason, setReason] = useState("");
  const submit = (values: NumberRangesValues) =>
    save(async () => {
      try {
        await saveNumberRanges(values);
        setPending(null);
        setReason("");
      } catch (e) {
        if (adapterErrorReason(e) === "REASON_REQUIRED" && !values.reason) {
          setPending(values);
          throw Object.assign(new Error(t("reasonNeeded")), { handled: true });
        }
        throw e;
      }
    });
  return (
    <Frame state={state}>
      <NumberRangesForm
        id={SETTINGS_FORM_ID}
        defaultValues={{ ranges: state?.numberRanges ?? SEEDED_RANGES }}
        onValid={submit}
      />
      <Dialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("reasonTitle")}</DialogTitle>
            <DialogDescription>{t("reasonDescription")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={reasonId}>{t("reasonLabel")}</Label>
            <Textarea id={reasonId} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" className="h-11 md:h-9" onClick={() => setPending(null)}>
              {tCommon("cancel")}
            </Button>
            <Button
              className="h-11 md:h-9"
              disabled={reason.trim() === ""}
              onClick={() => pending && void submit({ ...pending, reason })}
            >
              {tCommon("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Frame>
  );
}

export function LayoutSettings() {
  return (
    <ConvexGuard fallback={loading}>
      <LayoutSettingsInner />
    </ConvexGuard>
  );
}

function LayoutSettingsInner() {
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

"use client";

import { TriangleAlertIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { type UseFormReturn, useWatch } from "react-hook-form";
import { CheckboxField, FormErrorSummary, SelectField, TextField } from "@/components/forms/fields";
import { Button } from "@/components/ui/button";
import { useAdapterErrorToast } from "@/hooks/use-adapter-error-toast";
import { runAccessChecks, type StatusCheck, saveAccessConcept } from "../actions";
import { countryOptions, isEuEea } from "../countries";
import { type AccessValues, accessSchema } from "../schema";
import { hasBlockingError, StatusCheckList } from "../status-check";
import { useZodForm } from "../use-zod-form";
import { useStepSubmit, useWizard } from "../wizard-context";

const HOST_PREFIXES = ["app", "api", "convex", "convex-site", "convex-dash"] as const;

/** Step 2 "Adressen & Zugriff" (F01 SET-007, SET-046): server location, access concept, live host checks. */
export function AccessStep() {
  const t = useTranslations("setup.access");
  const { formId, state } = useWizard();
  const submit = useStepSubmit();
  const showAdapterError = useAdapterErrorToast();
  const [checks, setChecks] = useState<StatusCheck[] | null>(state?.access.checks ?? null);
  const [checking, setChecking] = useState(false);
  const baseDomain = state?.access.baseDomain;

  const form = useZodForm(accessSchema, {
    countryCode: "DE",
    provider: t("providerDefault"),
    nonEuConfirmed: false,
    tailnetName: "",
    tailnetOnlyConfirmed: false,
    ...state?.access.values,
  }) as UseFormReturn<AccessValues, unknown, AccessValues>;
  const country = useWatch({ control: form.control, name: "countryCode" });
  const nonEu = !!country && !isEuEea(country);

  const displayed: StatusCheck[] =
    checks ??
    HOST_PREFIXES.map((p) => ({
      id: p,
      label: baseDomain ? `${p}.${baseDomain}` : `${p}.<BASE_DOMAIN>`,
      status: "unknown" as const,
    }));

  return (
    <form
      id={formId}
      noValidate
      className="@container/form flex flex-col gap-6"
      onSubmit={form.handleSubmit((values) =>
        checks && hasBlockingError(checks) ? undefined : submit(() => saveAccessConcept(values)),
      )}
    >
      <FormErrorSummary form={form} />
      <div className="grid gap-4 @lg/form:grid-cols-2">
        <SelectField form={form} name="countryCode" label={t("country")} required options={countryOptions()} />
        <TextField form={form} name="provider" label={t("provider")} required />
      </div>
      {nonEu && (
        <div className="flex flex-col gap-3 rounded-lg border border-danger/40 bg-danger/10 p-3">
          <p className="flex gap-2 text-danger text-sm">
            <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {t("nonEuWarning")}
          </p>
          <CheckboxField form={form} name="nonEuConfirmed" label={t("nonEuConfirm")} />
        </div>
      )}

      <section aria-labelledby="access-hosts" className="flex flex-col gap-3">
        <h2 id="access-hosts" className="font-medium text-sm">
          {t("baseDomain")}: <span className="font-mono">{baseDomain ?? t("unknownDomain")}</span>
        </h2>
        <StatusCheckList checks={displayed} label={t("checks")} />
        <Button
          type="button"
          variant="outline"
          className="h-11 self-start md:h-9"
          disabled={checking}
          onClick={async () => {
            setChecking(true);
            try {
              setChecks(await runAccessChecks());
            } catch (e) {
              showAdapterError(e);
            } finally {
              setChecking(false);
            }
          }}
        >
          {t("runChecks")}
        </Button>
      </section>

      <div className="grid gap-4 @lg/form:grid-cols-2">
        <TextField form={form} name="tailnetName" label={t("tailnetName")} />
      </div>
      <CheckboxField form={form} name="tailnetOnlyConfirmed" label={t("tailnetConfirm")} />
    </form>
  );
}

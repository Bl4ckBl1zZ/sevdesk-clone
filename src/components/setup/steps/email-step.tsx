"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import { FormErrorSummary, TextField } from "@/components/forms/fields";
import { FactList } from "@/components/layout/list-layout";
import { Button } from "@/components/ui/button";
import { type EmailStepValues, emailStepSchema } from "@/domain/schemas/settings";
import { useAdapterErrorToast } from "@/hooks/use-adapter-error-toast";
import { authClient } from "@/lib/auth-client";
import { type StatusCheck, saveNotificationEmail, sendTestAuthMail } from "../actions";
import { StatusCheckList } from "../status-check";
import { useZodForm } from "../use-zod-form";
import { useStepSubmit, useWizard } from "../wizard-context";

/** Step 3 "E-Mail-Versand" (F01 SET-009a): read-only Cloudflare sender status, test code, notification address. */
export function EmailStep() {
  const t = useTranslations("setup.email");
  const { formId, state } = useWizard();
  const submit = useStepSubmit();
  const showAdapterError = useAdapterErrorToast();
  const { data: session } = authClient.useSession();
  const [delivery, setDelivery] = useState<StatusCheck>(
    state?.email.lastDelivery ?? { id: "delivery", label: t("lastDelivery"), status: "unknown" },
  );
  const [sending, setSending] = useState(false);

  const form = useZodForm(emailStepSchema, {
    notificationEmail: state?.email.notificationEmail ?? session?.user.email ?? "",
  }) as UseFormReturn<EmailStepValues, unknown, EmailStepValues>;

  return (
    <form
      id={formId}
      noValidate
      className="flex flex-col gap-6"
      onSubmit={form.handleSubmit((values) => submit(() => saveNotificationEmail(values)))}
    >
      <FormErrorSummary form={form} />
      <p className="rounded-md border border-info/30 bg-info/10 p-3 text-info text-sm">{t("noCustomerMail")}</p>
      <FactList
        items={[
          { label: t("sender"), value: state?.email.sender ?? "—" },
          { label: t("account"), value: state?.email.accountId ?? "—" },
          {
            label: t("token"),
            value: state ? (state.email.tokenConfigured ? t("tokenConfigured") : t("tokenMissing")) : "—",
          },
        ]}
      />
      <div className="flex flex-col gap-3">
        <StatusCheckList checks={[delivery]} label={t("lastDelivery")} />
        <Button
          type="button"
          variant="outline"
          className="h-11 self-start md:h-9"
          disabled={sending}
          onClick={async () => {
            setSending(true);
            try {
              setDelivery(await sendTestAuthMail());
            } catch (e) {
              showAdapterError(e);
            } finally {
              setSending(false);
            }
          }}
        >
          {t("sendTest")}
        </Button>
      </div>
      <TextField
        form={form}
        name="notificationEmail"
        label={t("notificationEmail")}
        type="email"
        autoComplete="email"
        required
        className="max-w-md"
      />
    </form>
  );
}

"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { type StatusCheck, sendTestAuthMail, testCheckpointStorage } from "@/components/setup/actions";
import { StatusCheckList } from "@/components/setup/status-check";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAdapterErrorToast } from "@/hooks/use-adapter-error-toast";

function useRunner<T>(initial: T, run: () => Promise<T>) {
  const [value, setValue] = useState(initial);
  const [pending, setPending] = useState(false);
  const showAdapterError = useAdapterErrorToast();
  const trigger = async () => {
    setPending(true);
    try {
      setValue(await run());
    } catch (e) {
      showAdapterError(e);
    } finally {
      setPending(false);
    }
  };
  return { value, pending, trigger };
}

/** /einstellungen/integrationen (F01 SET-106, SET-107, SET-115; R2 inbox and OCR are P2). */
export function IntegrationsPanel() {
  const t = useTranslations("setup");
  const email = useRunner<StatusCheck[]>(
    [{ id: "delivery", label: t("email.lastDelivery"), status: "unknown" }],
    async () => [await sendTestAuthMail()],
  );
  const storage = useRunner<StatusCheck[]>(
    [
      { id: "checkpoint", label: t("storage.checkpoint"), status: "unknown" },
      {
        id: "bucketLock",
        label: t("storage.bucketLock"),
        status: "unknown",
        detail: t("storage.bucketLockRecommended"),
      },
    ],
    testCheckpointStorage,
  );
  return (
    <div className="grid gap-4 @4xl/main:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("steps.email")}</h2>
          </CardTitle>
          <CardDescription>{t("email.noCustomerMail")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <StatusCheckList checks={email.value} label={t("steps.email")} />
          <Button variant="outline" className="h-11 self-start md:h-9" disabled={email.pending} onClick={email.trigger}>
            {t("email.sendTest")}
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("storage.checkpoint")}</h2>
          </CardTitle>
          <CardDescription>{t("stepDescriptions.speicher")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <StatusCheckList checks={storage.value} label={t("storage.checkpoint")} />
          <Button
            variant="outline"
            className="h-11 self-start md:h-9"
            disabled={storage.pending}
            onClick={storage.trigger}
          >
            {t("storage.test")}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

/** /einstellungen/system status tiles (F01 SET-130/131) — values arrive with GET /api/health wiring. */
export function SystemPanel() {
  const t = useTranslations("settings.systemTiles");
  const tSettings = useTranslations("settings");
  const tiles = (["database", "validator", "email", "checkpoint", "access"] as const).map((k) => ({
    id: k,
    label: t(k),
    status: "unknown" as const,
  }));
  return <StatusCheckList checks={tiles} label={tSettings("systemStatus")} />;
}

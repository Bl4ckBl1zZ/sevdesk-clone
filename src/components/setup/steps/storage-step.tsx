"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useAdapterErrorToast } from "@/hooks/use-adapter-error-toast";
import { type StatusCheck, testCheckpointStorage } from "../actions";
import { hasBlockingError, StatusCheckList } from "../status-check";
import { useWizard } from "../wizard-context";

/**
 * Step 4 "Speicher" (F01 SET-009b): R2 checkpoint bucket probe, bucket lock (recommended) and latest backup.
 * A failing checkpoint test blocks the step; a missing backup or bucket lock is only a warning.
 */
export function StorageStep() {
  const t = useTranslations("setup.storage");
  const { formId, next, state } = useWizard();
  const showAdapterError = useAdapterErrorToast();
  const [checks, setChecks] = useState<StatusCheck[]>(
    state?.storage.checks ?? [
      { id: "checkpoint", label: t("checkpoint"), status: "unknown" },
      { id: "bucketLock", label: t("bucketLock"), status: "unknown", detail: t("bucketLockRecommended") },
      { id: "backups", label: t("backups"), status: "unknown" },
    ],
  );
  const [testing, setTesting] = useState(false);

  return (
    <form
      id={formId}
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!hasBlockingError(checks)) next();
      }}
    >
      <StatusCheckList checks={checks} label={t("checkpoint")} />
      <Button
        type="button"
        variant="outline"
        className="h-11 self-start md:h-9"
        disabled={testing}
        onClick={async () => {
          setTesting(true);
          try {
            setChecks(await testCheckpointStorage());
          } catch (e) {
            showAdapterError(e);
          } finally {
            setTesting(false);
          }
        }}
      >
        {t("test")}
      </Button>
    </form>
  );
}

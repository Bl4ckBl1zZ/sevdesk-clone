"use client";

import { api } from "@convex/_generated/api";
import { useAction } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { RefreshCwIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAdapterErrorToast } from "@/hooks/use-adapter-error-toast";

type Overview = FunctionReturnType<typeof api.backups.status>;

const dateTimeDe = new Intl.DateTimeFormat("de-DE", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Berlin",
});
const sizeDe = (bytes: number) =>
  bytes >= 1_048_576
    ? `${(bytes / 1_048_576).toLocaleString("de-DE", { maximumFractionDigits: 1 })} MB`
    : `${Math.ceil(bytes / 1024).toLocaleString("de-DE")} KB`;

const STATUS_CLASS: Record<string, string> = {
  ok: "border-success/60 text-success",
  warning: "border-warning/60 text-warning",
  error: "border-danger/60 text-danger",
  unknown: "",
};

/** F12 AUD-026 `/einstellungen/system/backups`: latest backup per source, checkpoint bucket and bucket lock. */
export function BackupsPanel() {
  return (
    <ConvexGuard fallback={<div className="h-64" aria-busy="true" />}>
      <BackupsPanelInner />
    </ConvexGuard>
  );
}

function BackupsPanelInner() {
  const t = useTranslations("backups");
  const load = useAction(api.backups.status);
  const showError = useAdapterErrorToast();
  const [data, setData] = useState<Overview | null>(null);
  const [pending, setPending] = useState(false);
  const refresh = useCallback(async () => {
    setPending(true);
    try {
      setData(await load({}));
    } catch (e) {
      showError(e);
    } finally {
      setPending(false);
    }
  }, [load, showError]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!data ? (
          <div className="h-32" aria-busy="true" />
        ) : !data.configured ? (
          <p role="status" className="text-muted-foreground text-sm">
            {t("notConfigured")}
          </p>
        ) : (
          <>
            <ul className="flex flex-col divide-y rounded-lg border" aria-label={t("sources")}>
              {data.sources.map((s) => (
                <li key={s.prefix} className="flex flex-col gap-1 p-3 text-sm @lg/main:flex-row @lg/main:items-center">
                  <span className="flex-1 font-medium">
                    {s.label} <span className="font-mono text-muted-foreground text-xs">{s.prefix}</span>
                  </span>
                  <span className="text-muted-foreground">
                    {s.latest ? `${dateTimeDe.format(s.latest.at)} · ${sizeDe(s.latest.bytes)}` : "—"}
                  </span>
                  <Badge variant="outline" className={STATUS_CLASS[s.status]}>
                    {t(`status.${s.status}`)}
                  </Badge>
                  <span className="sr-only">{s.detail}</span>
                </li>
              ))}
            </ul>
            {data.checkpoint && (
              <p className="text-sm" data-testid="backup-checkpoint">
                {data.checkpoint.latest
                  ? t("checkpointLatest", { date: dateTimeDe.format(data.checkpoint.latest.at) })
                  : t("checkpointNone")}{" "}
                {t(`bucketLock.${data.checkpoint.bucketLock}`)}
              </p>
            )}
          </>
        )}
        <Button variant="outline" className="h-11 self-start md:h-9" disabled={pending} onClick={() => void refresh()}>
          <RefreshCwIcon aria-hidden="true" />
          {t("refresh")}
        </Button>
      </CardContent>
    </Card>
  );
}

"use client";

import { api } from "@convex/_generated/api";
import { useTranslations } from "next-intl";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuthedQuery } from "@/hooks/use-authed-query";

const dateTimeDe = new Intl.DateTimeFormat("de-DE", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Berlin",
});
const dateDe = (iso: string) => iso.split("-").reverse().join(".");

/**
 * F01 SET-132 integrity status on /einstellungen/system: last `integrity.verify` run (ok/findings), last signed
 * checkpoint (date, lastSeq, export target), audit chain head (seq, short hash) and the latest clock reading. A
 * failed run additionally shows the app-wide red banner (IntegrityBanner, 02 §4.5).
 */
export function IntegrityPanel() {
  return (
    <ConvexGuard fallback={<div className="h-40" aria-busy="true" />}>
      <IntegrityPanelInner />
    </ConvexGuard>
  );
}

function IntegrityPanelInner() {
  const t = useTranslations("integrity.panel");
  const status = useAuthedQuery(api.integrity.status, {});
  const clock = useAuthedQuery(api.system.clock, {});
  if (status === undefined) return <div className="h-40" aria-busy="true" />;
  const run = status.lastRun;
  const cp = status.latestCheckpoint;
  const errors = run?.findings.filter((f) => f.severity === "error") ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid @lg/main:grid-cols-[14rem_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">{t("lastRun")}</dt>
          <dd className={run && !run.ok ? "font-medium text-danger" : ""} data-testid="integrity-last-run">
            {!run
              ? t("never")
              : run.ok
                ? t("runOk", { date: dateTimeDe.format(run.at), scope: t(`scopes.${run.scope}`) })
                : t("runFailed", {
                    date: dateTimeDe.format(run.at),
                    count: run.findings.length,
                    scope: t(`scopes.${run.scope}`),
                  })}
          </dd>
          <dt className="text-muted-foreground">{t("checkpoint")}</dt>
          <dd data-testid="integrity-checkpoint">
            {!cp ? (
              t("noCheckpoint")
            ) : (
              <>
                {t("checkpointValue", { date: dateDe(cp.date), seq: cp.lastSeq })}
                <span className="block text-muted-foreground">
                  {cp.uploadStatus === "uploaded" && cp.exportedTo
                    ? t("uploaded", { target: cp.exportedTo })
                    : t("notUploaded")}
                </span>
              </>
            )}
          </dd>
          <dt className="text-muted-foreground">{t("head")}</dt>
          <dd className="font-mono" data-testid="integrity-head">
            {status.head ? t("headValue", { seq: status.head.seq, hash: status.head.hash.slice(0, 12) }) : t("noHead")}
          </dd>
          <dt className="text-muted-foreground">{t("clock")}</dt>
          <dd data-testid="integrity-clock">
            {clock ? `${clock.detail} (${dateTimeDe.format(clock.at)})` : t("clockUnknown")}
          </dd>
        </dl>
        {errors.length > 0 && (
          <ul className="mt-3 flex flex-col gap-1 text-danger text-sm" aria-label={t("findingsLabel")}>
            {errors.slice(0, 5).map((f) => (
              <li key={`${f.kind}-${f.firstBrokenSeq ?? f.detail}`}>{f.detail}</li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

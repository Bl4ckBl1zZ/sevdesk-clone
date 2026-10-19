"use client";

import { api } from "@convex/_generated/api";
import { useConvex, useMutation } from "convex/react";
import { DownloadIcon, PackageIcon, XIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCan, useRun } from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { EmptyState } from "@/components/layout/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { isActive, JOB_STATUS_LABEL_DE, type JobStatus, progressPercent } from "@/domain/jobs/jobs";
import { useAuthedQuery } from "@/hooks/use-authed-query";

const dateTime = new Intl.DateTimeFormat("de-DE", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Berlin",
});

/** F09 EXP-026 `/export`: export jobs with progress, cancel and the 30-day download. */
export function JobsPage() {
  return (
    <ConvexGuard>
      <Inner />
    </ConvexGuard>
  );
}

function Inner() {
  const t = useTranslations("exports");
  const jobs = useAuthedQuery(api.jobs.list, {});
  const cancel = useMutation(api.jobs.cancel);
  const convex = useConvex();
  const run = useRun();
  const canExport = useCan("documents.export");
  if (jobs === undefined) return <div className="h-64" aria-busy="true" />;
  if (jobs.length === 0) return <EmptyState icon={PackageIcon} title={t("noJobs")} description={t("noJobsHint")} />;
  return (
    <ul className="@container flex flex-col gap-3" aria-label={t("jobsLabel")}>
      {jobs.map((j) => {
        const pct = progressPercent(j.progress);
        return (
          <li key={j.id} className="flex flex-col gap-2 rounded-lg border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{j.label}</span>
              <Badge variant="outline">{JOB_STATUS_LABEL_DE[j.status as JobStatus]}</Badge>
              <span className="text-muted-foreground text-xs">{dateTime.format(j.createdAt)}</span>
            </div>
            {isActive(j.status as JobStatus) && (
              <Progress value={pct} aria-label={t("progress", { label: j.label, pct })} />
            )}
            {j.error && <p className="text-destructive text-sm">{j.error}</p>}
            {j.skipped.length > 0 && (
              <details>
                <summary className="cursor-pointer text-sm">{t("skipped", { count: j.skipped.length })}</summary>
                <ul className="mt-1 list-disc pl-5 text-sm">
                  {j.skipped.map((s) => (
                    <li key={s.id}>
                      {s.label}: {s.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <div className="flex flex-wrap gap-2">
              {j.hasResult && (
                <Button
                  variant="outline"
                  className="min-h-11"
                  onClick={async () => {
                    const r = await run(() => convex.query(api.jobs.resultUrl, { id: j.id }));
                    if (r.ok && r.value.url) window.open(r.value.url, "_blank", "noopener");
                  }}
                >
                  <DownloadIcon aria-hidden="true" />
                  {t("download", { name: j.resultName ?? "" })}
                </Button>
              )}
              {canExport && isActive(j.status as JobStatus) && (
                <Button
                  variant="ghost"
                  className="min-h-11"
                  onClick={() => run(() => cancel({ id: j.id }), t("cancelled"))}
                >
                  <XIcon aria-hidden="true" />
                  {t("cancel")}
                </Button>
              )}
              {j.resultSha256 && (
                <code className="self-center break-all text-muted-foreground text-xs">SHA-256 {j.resultSha256}</code>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

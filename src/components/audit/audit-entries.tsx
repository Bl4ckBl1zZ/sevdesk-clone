"use client";

import type { api } from "@convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import { CheckCircle2Icon, CircleDashedIcon } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type AuditEntryView = FunctionReturnType<typeof api.auditLog.search>["entries"][number];

const dateTime = new Intl.DateTimeFormat("de-DE", {
  dateStyle: "medium",
  timeStyle: "medium",
  timeZone: "Europe/Berlin",
});

const badgeClass: Record<string, string> = {
  mcp: "border-violet-500/50 text-violet-700 dark:text-violet-300",
  "api-key": "border-sky-500/50 text-sky-700 dark:text-sky-300",
  auditor: "border-amber-500/50 text-amber-700 dark:text-amber-300",
  system: "text-muted-foreground",
  user: "",
};

const pretty = (v: unknown) => (v === undefined ? "—" : JSON.stringify(v, null, 2));

/** Timeline of audit entries (AUD-006 viewer, AUD-007 „Verlauf"): actor badge, act, entity link, diff, chain status. */
export function AuditEntries({ entries, label }: { entries: readonly AuditEntryView[]; label: string }) {
  const t = useTranslations("audit");
  return (
    <ol className="flex flex-col gap-2" aria-label={label}>
      {entries.map((e) => (
        <li key={e.id} className="rounded-lg border p-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant="outline" className={cn(badgeClass[e.badge.kind])}>
              {e.badge.label}
            </Badge>
            <span className="font-medium">{e.description ?? e.action}</span>
            {e.link ? (
              <Link href={e.link as Route} className="text-primary underline-offset-4 hover:underline">
                {e.entity.label ?? e.entity.id}
              </Link>
            ) : (
              e.entity.label && <span>{e.entity.label}</span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs">
            <time dateTime={new Date(e.at).toISOString()}>{dateTime.format(e.at)}</time>
            <span>
              {t("seq")} {e.seq}
            </span>
            <code>{e.action}</code>
            <span>{t(`channel.${e.channel}`)}</span>
            <span className="inline-flex items-center gap-1">
              {e.chain.verified ? (
                <CheckCircle2Icon aria-hidden="true" className="size-3.5 text-success" />
              ) : (
                <CircleDashedIcon aria-hidden="true" className="size-3.5" />
              )}
              {e.chain.text}
            </span>
          </div>
          {e.reason && (
            <p className="mt-1 text-sm">
              {t("reason")}: {e.reason}
            </p>
          )}
          {e.diff && (
            <details className="mt-2">
              <summary className="cursor-pointer text-sm">{t("showDiff")}</summary>
              <div className="mt-2 grid @2xl:grid-cols-2 gap-2">
                <div>
                  <p className="font-medium text-xs">{t("before")}</p>
                  <pre className="max-h-64 overflow-auto rounded bg-muted p-2 text-xs">{pretty(e.diff.before)}</pre>
                </div>
                <div>
                  <p className="font-medium text-xs">{t("after")}</p>
                  <pre className="max-h-64 overflow-auto rounded bg-muted p-2 text-xs">{pretty(e.diff.after)}</pre>
                </div>
              </div>
            </details>
          )}
        </li>
      ))}
    </ol>
  );
}

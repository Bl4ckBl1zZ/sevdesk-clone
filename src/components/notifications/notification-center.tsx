"use client";

import { api } from "@convex/_generated/api";
import { useMutation } from "convex/react";
import { BellIcon, CheckCheckIcon } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useCan, useRun } from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { EmptyState } from "@/components/layout/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import type { NotificationSeverity } from "@/domain/notifications/catalog";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { cn } from "@/lib/utils";

const SEVERITIES: NotificationSeverity[] = ["critical", "error", "warning", "info"];

const severityClass: Record<NotificationSeverity, string> = {
  critical: "border-destructive/50 bg-destructive/10 text-destructive",
  error: "border-destructive/40 text-destructive",
  warning: "border-warning/50 text-warning",
  info: "text-muted-foreground",
};

const dateTime = new Intl.DateTimeFormat("de-DE", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Berlin",
});

/** F12 NTF-001: the top-bar bell with the unread counter (plain link while Convex is unavailable). */
export function NotificationBell({ className, label }: { className?: string; label: string }) {
  const plain = (
    <Link href="/benachrichtigungen" aria-label={label} className={className}>
      <BellIcon aria-hidden="true" />
    </Link>
  );
  return (
    <ConvexGuard fallback={plain}>
      <BellInner className={className} />
    </ConvexGuard>
  );
}

function BellInner({ className }: { className?: string | undefined }) {
  const t = useTranslations("notificationCenter");
  const allowed = useCan("notifications.read");
  const count = useAuthedQuery(api.notifications.unreadCount, {}, allowed);
  return (
    <Link
      href="/benachrichtigungen"
      aria-label={count ? t("bellUnread", { count }) : t("bell")}
      className={cn("relative", className)}
    >
      <BellIcon aria-hidden="true" />
      {count ? (
        <span
          data-testid="notification-count"
          aria-hidden="true"
          className="-top-0.5 -right-0.5 absolute flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 font-medium text-[10px] text-white leading-4"
        >
          {count > 99 ? "99+" : count}
        </span>
      ) : null}
    </Link>
  );
}

/** F12 §6 `/benachrichtigungen`: list with severity/kind filters, mark read, „Alle als gelesen markieren". */
export function NotificationCenter() {
  return (
    <ConvexGuard>
      <CenterInner />
    </ConvexGuard>
  );
}

function CenterInner() {
  const t = useTranslations("notificationCenter");
  const [severity, setSeverity] = useState<NotificationSeverity | "">("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const list = useAuthedQuery(api.notifications.list, {
    ...(severity ? { severity } : {}),
    ...(unreadOnly ? { unreadOnly } : {}),
  });
  const canWrite = useCan("notifications.write");
  const markRead = useMutation(api.notifications.markRead);
  const markAllRead = useMutation(api.notifications.markAllRead);
  const run = useRun();

  return (
    <div className="@container flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ntf-severity">{t("filterSeverity")}</Label>
          <select
            id="ntf-severity"
            className="h-10 rounded-md border bg-background px-3 text-sm"
            value={severity}
            onChange={(e) => setSeverity(e.target.value as NotificationSeverity | "")}
          >
            <option value="">{t("all")}</option>
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {t(`severity.${s}`)}
              </option>
            ))}
          </select>
        </div>
        <label className="flex h-10 items-center gap-2 text-sm">
          <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />
          {t("unreadOnly")}
        </label>
        {canWrite && (
          <Button
            variant="outline"
            className="@md:ml-auto min-h-11"
            onClick={() => run(() => markAllRead({}), t("allMarked"))}
            disabled={!list?.some((n) => n.readAt === null)}
          >
            <CheckCheckIcon aria-hidden="true" />
            {t("markAllRead")}
          </Button>
        )}
      </div>
      {list === undefined ? (
        <p className="text-muted-foreground text-sm">{t("loading")}</p>
      ) : list.length === 0 ? (
        <EmptyState icon={BellIcon} title={t("empty")} description={t("emptyHint")} />
      ) : (
        <ul className="flex flex-col gap-2" aria-label={t("listLabel")}>
          {list.map((n) => (
            <li key={n.id}>
              <Card className={cn(n.readAt === null && "border-primary/40")}>
                <CardContent className="flex @md:flex-row flex-col @md:items-start gap-3 py-3">
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className={severityClass[n.severity]}>
                        {t(`severity.${n.severity}`)}
                      </Badge>
                      {n.readAt === null && <Badge>{t("unread")}</Badge>}
                      {n.count > 1 && (
                        <span className="text-muted-foreground text-xs">{t("count", { count: n.count })}</span>
                      )}
                    </div>
                    <p className="font-medium">
                      {n.link ? (
                        <Link href={n.link as Route} className="underline-offset-4 hover:underline">
                          {n.title}
                        </Link>
                      ) : (
                        n.title
                      )}
                    </p>
                    {n.body && <p className="text-muted-foreground text-sm">{n.body}</p>}
                    <p className="text-muted-foreground text-xs">
                      {dateTime.format(n.createdAt)}
                      {n.kindLabel ? ` · ${n.kindLabel}` : ""}
                    </p>
                  </div>
                  {canWrite && n.readAt === null && (
                    <Button
                      variant="ghost"
                      className="min-h-11"
                      onClick={() => run(() => markRead({ id: n.id }))}
                      aria-label={t("markReadLabel", { title: n.title })}
                    >
                      {t("markRead")}
                    </Button>
                  )}
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

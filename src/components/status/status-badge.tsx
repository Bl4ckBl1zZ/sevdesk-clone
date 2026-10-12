"use client";

import { CircleAlertIcon, LockIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

/**
 * Display statuses (04-ui-ux §6). Invoice badges come from the pure domain `displayStatus()` (F04 §4.2.9) —
 * this component only renders a status it is given; "Überfällig" is never stored.
 */
export type DisplayStatus =
  | "draft"
  | "open"
  | "sent"
  | "partiallyPaid"
  | "overdue"
  | "paid"
  | "accepted"
  | "invoiced"
  | "rejected"
  | "expired"
  | "cancelled";

type Tone = "muted" | "info" | "warning-soft" | "destructive" | "success" | "muted-strike";

const TONE_CLASSES: Record<Tone, string> = {
  muted: "border-border bg-muted text-foreground",
  "muted-strike": "border-border bg-muted text-foreground line-through",
  info: "border-info/30 bg-info/10 text-info",
  "warning-soft": "border-warning bg-transparent text-warning",
  destructive: "border-danger/30 bg-danger/10 text-danger",
  success: "border-success/30 bg-success/10 text-success",
};

export const STATUS_STYLES: Record<DisplayStatus, { tone: Tone; icon?: boolean; stornoTag?: boolean }> = {
  draft: { tone: "muted" },
  open: { tone: "info" },
  sent: { tone: "info" },
  partiallyPaid: { tone: "warning-soft" },
  overdue: { tone: "destructive", icon: true },
  paid: { tone: "success" },
  accepted: { tone: "success" },
  invoiced: { tone: "success" },
  rejected: { tone: "muted-strike" },
  expired: { tone: "muted-strike" },
  cancelled: { tone: "muted", stornoTag: true },
};

export function StatusBadge({
  status,
  locked = false,
  className,
}: {
  status: DisplayStatus;
  /** Festgeschrieben: adds a lock suffix (04-ui-ux §6). */
  locked?: boolean;
  className?: string;
}) {
  const t = useTranslations("status");
  const style = STATUS_STYLES[status];
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      <span
        data-status={status}
        className={cn(
          "inline-flex h-6 items-center gap-1 rounded-full border px-2 font-medium text-xs whitespace-nowrap",
          TONE_CLASSES[style.tone],
        )}
      >
        {style.icon && <CircleAlertIcon className="size-3.5" aria-hidden="true" />}
        {t(status)}
      </span>
      {style.stornoTag && (
        <span className="inline-flex h-6 items-center rounded border border-border px-1.5 font-medium text-xs">
          {t("stornoTag")}
        </span>
      )}
      {locked && (
        <span role="img" aria-label={t("locked")} title={t("locked")} className="inline-flex">
          <LockIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
        </span>
      )}
    </span>
  );
}

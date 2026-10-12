"use client";

import { CircleAlertIcon, CircleCheckIcon, CircleDashedIcon, CircleXIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import type { CheckStatus, StatusCheck } from "./actions";

const ICON = {
  ok: CircleCheckIcon,
  warning: CircleAlertIcon,
  error: CircleXIcon,
  unknown: CircleDashedIcon,
} as const;

const TONE: Record<CheckStatus, string> = {
  ok: "text-success",
  warning: "text-warning",
  error: "text-danger",
  unknown: "text-muted-foreground",
};

/** ✓ / ⚠ / ✗ with text — never colour alone (04-ui-ux §6, F01 §6.9). */
export function StatusCheckList({ checks, label }: { checks: StatusCheck[]; label: string }) {
  const t = useTranslations("setup.check");
  return (
    <ul aria-label={label} className="flex flex-col divide-y rounded-lg border">
      {checks.map((c) => {
        const Icon = ICON[c.status];
        return (
          <li key={c.id} className="flex items-start gap-3 p-3">
            <Icon className={cn("mt-0.5 size-5 shrink-0", TONE[c.status])} aria-hidden="true" />
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm">
                <span className="font-medium">{c.label}</span>
                <span className={cn("ml-2", TONE[c.status])}>· {t(c.status)}</span>
              </span>
              {c.detail && <span className="break-words text-muted-foreground text-sm">{c.detail}</span>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function hasBlockingError(checks: StatusCheck[]): boolean {
  return checks.some((c) => c.status === "error");
}

"use client";

import { api } from "@convex/_generated/api";
import { AlertTriangleIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { formatEuro } from "@/domain/money";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { cn } from "@/lib/utils";

/**
 * F01 SET-040 threshold monitor on /einstellungen/steuern: Gesamtumsatz (prior and current year) against 800 000 € and
 * the prior-year EÜR profit against 80 000 € (§ 141 AO, § 241a HGB). Information only — nothing is blocked.
 */
export function ThresholdMonitorCard() {
  return (
    <ConvexGuard fallback={null}>
      <Inner />
    </ConvexGuard>
  );
}

function Inner() {
  const t = useTranslations("settings.thresholds");
  const data = useAuthedQuery(api.settings.thresholdMonitor, {});
  if (!data) return null;
  return (
    <Card data-testid="threshold-monitor">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("intro")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 @lg:grid-cols-3">
        {data.bars.map((b) => {
          const label = t(b.key, { year: b.year });
          const percent = Math.floor(b.bp / 100);
          return (
            <div key={b.key} className="flex flex-col gap-1.5">
              <p className="font-medium text-sm">{label}</p>
              {b.amountCents === null ? (
                <p className="text-muted-foreground text-sm">{t("unknown", { year: b.year })}</p>
              ) : (
                <>
                  <p className="text-sm tabular-nums">
                    {t("of", { amount: formatEuro(b.amountCents), limit: formatEuro(b.limitCents) })}
                  </p>
                  <Progress
                    value={Math.min(100, percent)}
                    aria-label={t("barLabel", { label, percent, limit: formatEuro(b.limitCents) })}
                    className={cn(
                      b.level === "exceeded"
                        ? "[&_[data-slot=progress-indicator]]:bg-danger"
                        : b.level === "warn_80"
                          ? "[&_[data-slot=progress-indicator]]:bg-warning"
                          : "",
                    )}
                  />
                </>
              )}
            </div>
          );
        })}
        {data.notices.length > 0 && (
          <ul className="flex flex-col gap-2 text-sm @lg:col-span-3">
            {data.notices.map((n) => (
              <li key={n.code + n.message} className="flex items-start gap-2">
                <AlertTriangleIcon
                  aria-hidden="true"
                  className={cn(
                    "mt-0.5 size-4 shrink-0",
                    n.severity === "warning" ? "text-warning" : "text-muted-foreground",
                  )}
                />
                <span>{n.message}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

"use client";

import { api } from "@convex/_generated/api";
import type { Route } from "next";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useCan } from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { formatEuro } from "@/domain/money/format";
import { formatMinutes } from "@/domain/projects/time-entries";
import { unbilledEscalationText, unbilledWarningText } from "@/domain/projects/unbilled";
import { useAuthedQuery } from "@/hooks/use-authed-query";

/**
 * PRJ-015 dashboard to-do: open billable time and the UST-01 deadline warnings (> 150 days warning, > 180 days
 * escalation for business customers; § 14 Abs. 2 UStG). Self-contained so the dashboard only mounts it.
 */
export function UnbilledTimeWidget() {
  return (
    <ConvexGuard fallback={null}>
      <UnbilledInner />
    </ConvexGuard>
  );
}

function UnbilledInner() {
  const t = useTranslations("time.unbilled");
  const canRead = useCan("projects.read");
  const s = useAuthedQuery(api.timeEntries.unbilled, {}, canRead);
  if (!s || (s.openCount === 0 && s.warning === 0 && s.escalation === 0)) return null;
  return (
    <div className="flex flex-col gap-1 text-sm" data-testid="unbilled-time">
      <Link href={"/zeiten?status=open&billable=yes" as Route} className="underline-offset-4 hover:underline">
        {t("title")}: {t("summary", { duration: formatMinutes(s.openMinutes), value: formatEuro(s.openValueCents) })}
      </Link>
      {s.escalation > 0 && (
        <p role="alert" className="text-danger">
          {unbilledEscalationText(s.escalation)}
        </p>
      )}
      {s.warning > 0 && <p className="text-warning">{unbilledWarningText(s.warning)}</p>}
    </div>
  );
}

"use client";

import { api } from "@convex/_generated/api";
import { useTranslations } from "next-intl";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { AuditEntries } from "./audit-entries";

/** F12 AUD-007 „Verlauf": the audit entries of one record and its related records (invoice → payments, artifacts). */
export function EntityHistory({ table, id }: { table: string; id: string }) {
  return (
    <ConvexGuard>
      <Inner table={table} id={id} />
    </ConvexGuard>
  );
}

function Inner({ table, id }: { table: string; id: string }) {
  const t = useTranslations("audit");
  const entries = useAuthedQuery(api.auditLog.entityHistory, { table, id });
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 className="font-semibold text-base">{t("historyTitle")}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="@container">
        {entries === undefined ? (
          <p className="text-muted-foreground text-sm">{t("loading")}</p>
        ) : entries.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("historyEmpty")}</p>
        ) : (
          <AuditEntries entries={entries} label={t("historyTitle")} />
        )}
      </CardContent>
    </Card>
  );
}

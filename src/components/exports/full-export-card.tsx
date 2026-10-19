"use client";

import { api } from "@convex/_generated/api";
import { useMutation } from "convex/react";
import { ArchiveIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useCan, useRun } from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * F09 EXP-023 „Vollexport" card on /export (owner): starts the `full_export` job; the ZIP appears in the job list.
 * The restorable snapshot is the daily backup — the card says so (SPEC-GAP EXP-023 a).
 */
export function FullExportCard() {
  return (
    <ConvexGuard fallback={null}>
      <Inner />
    </ConvexGuard>
  );
}

function Inner() {
  const t = useTranslations("exports.full");
  const can = useCan("exports.full");
  const start = useMutation(api.fullExport.start);
  const run = useRun();
  const [busy, setBusy] = useState(false);
  if (!can) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("title")}</h2>
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-muted-foreground text-sm">{t("snapshotNote")}</p>
        <div>
          <Button
            className="h-11 md:h-9"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await run(() => start({}), t("started"));
              setBusy(false);
            }}
          >
            <ArchiveIcon aria-hidden="true" />
            {t("start")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

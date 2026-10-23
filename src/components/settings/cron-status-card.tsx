"use client";

import { api } from "@convex/_generated/api";
import { useTranslations } from "next-intl";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAuthedQuery } from "@/hooks/use-authed-query";

const dateTimeDe = new Intl.DateTimeFormat("de-DE", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Europe/Berlin",
});

const duration = (ms: number) =>
  ms < 1000 ? `${ms} ms` : `${(ms / 1000).toLocaleString("de-DE", { maximumFractionDigits: 1 })} s`;

const BADGE = { ok: "secondary", overdue: "destructive", error: "destructive", never: "outline" } as const;

/** F01 SET-134 cron status table on /einstellungen/system (GOBD-09). */
export function CronStatusCard() {
  return (
    <ConvexGuard fallback={null}>
      <Inner />
    </ConvexGuard>
  );
}

function Inner() {
  const t = useTranslations("settings.cronStatus");
  const rows = useAuthedQuery(api.settings.cronStatus, {});
  if (!rows) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table data-testid="cron-status">
          <TableHeader>
            <TableRow>
              <TableHead>{t("name")}</TableHead>
              <TableHead>{t("schedule")}</TableHead>
              <TableHead>{t("lastRun")}</TableHead>
              <TableHead className="text-right">{t("duration")}</TableHead>
              <TableHead>{t("result")}</TableHead>
              <TableHead>{t("nextRun")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.name}>
                <TableCell className="font-mono text-xs">{r.name}</TableCell>
                <TableCell className="text-muted-foreground text-xs">{r.schedule}</TableCell>
                <TableCell>{r.lastRunAt === null ? t("never") : dateTimeDe.format(r.lastRunAt)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {r.durationMs === null ? "–" : duration(r.durationMs)}
                </TableCell>
                <TableCell>
                  <Badge variant={BADGE[r.state]}>{t(`states.${r.state}`)}</Badge>
                </TableCell>
                <TableCell>{r.nextRunAt === null ? t("unknown") : dateTimeDe.format(r.nextRunAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

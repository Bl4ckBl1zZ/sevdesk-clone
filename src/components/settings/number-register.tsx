"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { DownloadIcon } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { formatDateTime, selectClass } from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { writeCsv } from "@/domain/csv/csv";
import { NUMBERED_TYPE_LABEL_DE } from "@/domain/numbering/register";
import { useAuthedQuery } from "@/hooks/use-authed-query";

type Status = "issued" | "cancelled_by_storno" | "corrected";
const STATUSES: readonly Status[] = ["issued", "cancelled_by_storno", "corrected"];

/** F01 SET-063 `/einstellungen/nummernkreise/register`: issued numbers per range and the gap report (DOC-39 target). */
export function NumberRegister({ initialRange, initialPeriod }: { initialRange?: string; initialPeriod?: string }) {
  return (
    <ConvexGuard fallback={<div className="h-64" aria-busy="true" />}>
      <NumberRegisterInner initialRange={initialRange} initialPeriod={initialPeriod} />
    </ConvexGuard>
  );
}

function NumberRegisterInner({ initialRange, initialPeriod }: { initialRange?: string; initialPeriod?: string }) {
  const t = useTranslations("settings.numberRegister");
  const tStatus = useTranslations("invoices.detail.registerStatus");
  const ranges = useAuthedQuery(api.settings.listNumberRanges, {});
  const [rangeId, setRangeId] = useState(initialRange ?? "");
  const [period, setPeriod] = useState(initialPeriod ?? "");
  const [status, setStatus] = useState<Status | "">("");
  const selected = rangeId || ranges?.[0]?.rangeId || "";
  const data = useAuthedQuery(
    api.settings.numberRegister,
    {
      rangeId: selected as Id<"numberRanges">,
      ...(period ? { periodKey: period } : {}),
      ...(status ? { status } : {}),
    },
    selected !== "",
  );
  const rangeSel = useId();
  const periodSel = useId();
  const statusSel = useId();
  const gapsId = useId();

  const downloadCsv = () => {
    if (!data) return;
    const csv = writeCsv(
      [t("number"), t("type"), t("period"), "Zähler", t("assignedAt"), t("status"), t("imported")],
      data.rows.map((r) => [
        r.number,
        NUMBERED_TYPE_LABEL_DE[r.docType] ?? r.docType,
        r.periodKey,
        r.counter,
        formatDateTime(r.assignedAt),
        tStatus(r.status),
        r.imported ? "ja" : "",
      ]),
    );
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `nummernregister-${data.range.name.replace(/[^\p{L}\p{N}]+/gu, "-").toLowerCase()}.csv`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-3 @lg/main:grid-cols-3">
            <div className="flex flex-col gap-1">
              <label htmlFor={rangeSel} className="font-medium text-sm">
                {t("range")}
              </label>
              <select
                id={rangeSel}
                className={selectClass}
                value={selected}
                onChange={(e) => {
                  setRangeId(e.target.value);
                  setPeriod("");
                }}
              >
                {(ranges ?? []).map((r) => (
                  <option key={r.rangeId} value={r.rangeId}>
                    {r.name} ({r.format})
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor={periodSel} className="font-medium text-sm">
                {t("period")}
              </label>
              <select id={periodSel} className={selectClass} value={period} onChange={(e) => setPeriod(e.target.value)}>
                <option value="">{t("allPeriods")}</option>
                {period && !data?.periods.includes(period) && <option value={period}>{period}</option>}
                {(data?.periods ?? []).map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor={statusSel} className="font-medium text-sm">
                {t("status")}
              </label>
              <select
                id={statusSel}
                className={selectClass}
                value={status}
                onChange={(e) => setStatus(e.target.value as Status | "")}
              >
                <option value="">{t("allStatuses")}</option>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {tStatus(s)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {data?.truncated && <p className="text-muted-foreground text-sm">{t("truncated")}</p>}
          <div className="flex justify-end">
            <Button variant="outline" className="h-11 md:h-9" disabled={!data?.rows.length} onClick={downloadCsv}>
              <DownloadIcon aria-hidden="true" />
              {t("csv")}
            </Button>
          </div>
          {data && data.rows.length === 0 && <p className="text-muted-foreground text-sm">{t("empty")}</p>}
          {data && data.rows.length > 0 && (
            <div className="overflow-x-auto">
              <Table data-testid="number-register">
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("number")}</TableHead>
                    <TableHead>{t("type")}</TableHead>
                    <TableHead>{t("assignedAt")}</TableHead>
                    <TableHead>{t("status")}</TableHead>
                    <TableHead>{t("document")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.rows.map((r) => (
                    <TableRow key={`${r.number}-${r.assignedAt}`}>
                      <TableCell className="font-mono">{r.number}</TableCell>
                      <TableCell>
                        {NUMBERED_TYPE_LABEL_DE[r.docType] ?? r.docType}
                        {r.imported ? ` · ${t("imported")}` : ""}
                      </TableCell>
                      <TableCell>{formatDateTime(r.assignedAt)}</TableCell>
                      <TableCell>{tStatus(r.status)}</TableCell>
                      <TableCell>
                        {r.link ? (
                          <Link href={r.link as Route} className="underline" aria-label={`${r.number} ${t("open")}`}>
                            {t("open")}
                          </Link>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
      {data && (
        <Card>
          <CardHeader>
            <CardTitle id={gapsId}>{t("gaps")}</CardTitle>
          </CardHeader>
          <CardContent>
            {data.gaps.length === 0 ? (
              <p className="text-sm">{t("noGaps")}</p>
            ) : (
              <ul className="flex flex-col gap-1 text-sm" aria-labelledby={gapsId} data-testid="register-gaps">
                {data.gaps.map((g) => (
                  <li key={`${g.periodKey}-${g.from}`}>
                    <span className="font-mono">
                      {g.periodKey ? `${g.periodKey}: ` : ""}
                      {g.from === g.to ? g.from : t("gapRange", { from: g.from, to: g.to })}
                    </span>{" "}
                    — {g.reason ?? <strong>{t("unexplained")}</strong>}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}
      <Link href={"/einstellungen/nummernkreise" as Route} className="text-sm underline">
        {t("back")}
      </Link>
    </div>
  );
}

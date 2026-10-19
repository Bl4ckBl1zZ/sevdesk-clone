"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useMutation } from "convex/react";
import { DownloadIcon, FileArchiveIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { formatDateTime, selectClass, todayBerlin, useCan, useRun } from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useAuthedQuery } from "@/hooks/use-authed-query";

/**
 * F09 EXP-017/018 „GDPdU/Z3" card on /export: the owner creates the package per fiscal year (encoding, originals);
 * the list of generated packages is shown to owner, bookkeeper and — limited to the granted years — the auditor
 * (F12 AUD-023). Every download is audited.
 */
export function GdpduCard() {
  return (
    <ConvexGuard fallback={null}>
      <Inner />
    </ConvexGuard>
  );
}

const mb = (n: number) => `${(n / 1024 / 1024).toLocaleString("de-DE", { maximumFractionDigits: 1 })} MB`;

function Inner() {
  const t = useTranslations("exports.gdpdu");
  const canRead = useCan("exports.gdpdu.read");
  const canStart = useCan("exports.gdpdu");
  const list = useAuthedQuery(api.gdpdu.list, {}, canRead);
  const start = useMutation(api.gdpdu.start);
  const download = useMutation(api.gdpdu.download);
  const run = useRun();
  const thisYear = Number(todayBerlin().slice(0, 4));
  const [year, setYear] = useState(thisYear - 1);
  const [encoding, setEncoding] = useState<"utf8" | "ansi">("utf8");
  const [includeFiles, setIncludeFiles] = useState(true);
  const [busy, setBusy] = useState(false);
  const ids = { year: useId(), encoding: useId(), files: useId() };
  if (!canRead) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("title")}</h2>
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="@container flex flex-col gap-4">
        {canStart && (
          <div className="flex flex-col gap-3 @lg:flex-row @lg:items-end">
            <div className="flex flex-col gap-1">
              <Label htmlFor={ids.year}>{t("year")}</Label>
              <select
                id={ids.year}
                className={selectClass}
                value={year}
                onChange={(e) => setYear(Number(e.target.value))}
              >
                {Array.from({ length: 11 }, (_, i) => thisYear - i).map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={ids.encoding}>{t("encoding")}</Label>
              <select
                id={ids.encoding}
                className={selectClass}
                value={encoding}
                onChange={(e) => setEncoding(e.target.value as "utf8" | "ansi")}
              >
                <option value="utf8">{t("utf8")}</option>
                <option value="ansi">{t("ansi")}</option>
              </select>
            </div>
            <div className="flex min-h-11 items-center gap-2 md:min-h-9">
              <Checkbox id={ids.files} checked={includeFiles} onCheckedChange={(v) => setIncludeFiles(v === true)} />
              <Label htmlFor={ids.files} className="font-normal">
                {t("includeFiles")}
              </Label>
            </div>
            <Button
              className="h-11 md:h-9"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                await run(() => start({ year, encoding, includeFiles }), t("started"));
                setBusy(false);
              }}
            >
              <FileArchiveIcon aria-hidden="true" />
              {t("start")}
            </Button>
          </div>
        )}
        {!list ? (
          <div className="h-16" aria-busy="true" />
        ) : list.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("empty")}</p>
        ) : (
          <ul className="flex flex-col gap-2" aria-label={t("listLabel")}>
            {list.map((p) => (
              <li
                key={p.id}
                className="flex flex-col gap-2 rounded-md border p-3 @md:flex-row @md:items-center @md:justify-between"
              >
                <span className="text-sm">
                  <span className="font-medium">{t("packageLine", { year: p.year })}</span>
                  <span className="text-muted-foreground">
                    {" "}
                    · {formatDateTime(p.createdAt)} · {mb(p.bytes)} · {p.encoding === "ansi" ? "ANSI" : "UTF-8"} ·
                    SHA-256 {p.sha256.slice(0, 12)}…
                  </span>
                </span>
                <Button
                  variant="outline"
                  className="h-11 md:h-8"
                  onClick={async () => {
                    const r = await run(() => download({ id: p.id as Id<"gdpduExports"> }));
                    if (r.ok && r.value.url) window.location.assign(r.value.url);
                  }}
                >
                  <DownloadIcon aria-hidden="true" />
                  {t("download", { name: p.name })}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

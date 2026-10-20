"use client";

import { api } from "@convex/_generated/api";
import { useAction } from "convex/react";
import { FileDownIcon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { selectClass, todayBerlin, useCan, useRun } from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * F09 §6 „Kennzahlen" card on /export (EXP-020): the UStVA and ZM sheets of a filing period as PDF/A or CSV for
 * the manual entry in Mein ELSTER, with links to the tax pages (guide, submission record); the Anlage EÜR of a
 * year (F08 TAX-015/TAX-022) the same way.
 */
export function KennzahlenCard() {
  return (
    <ConvexGuard fallback={null}>
      <Inner />
    </ConvexGuard>
  );
}

/** Previous month (`YYYY-MM`) for UStVA, previous quarter (`YYYY-Qn`) for ZM, previous year (`YYYY`) for the EÜR. */
export function defaultPeriod(form: "ustva" | "zm" | "euer", today: string): string {
  const y = Number(today.slice(0, 4));
  if (form === "euer") return String(y - 1);
  const m = Number(today.slice(5, 7));
  if (form === "ustva") return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  const q = Math.floor((m - 1) / 3);
  return q === 0 ? `${y - 1}-Q4` : `${y}-Q${q}`;
}

function saveBytes(name: string, mime: string, data: ArrayBuffer) {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Inner() {
  const t = useTranslations("exports.kennzahlen");
  const canRead = useCan("tax.read");
  const download = useAction(api.kennzahlenNode.download);
  const run = useRun();
  const [form, setForm] = useState<"ustva" | "zm" | "euer">("ustva");
  const [period, setPeriod] = useState(() => defaultPeriod("ustva", todayBerlin()));
  const [busy, setBusy] = useState(false);
  const ids = { form: useId(), period: useId() };
  if (!canRead) return null;
  const get = async (format: "pdf" | "csv") => {
    setBusy(true);
    const r = await run(() => download({ form, period: period.trim(), format }));
    setBusy(false);
    if (r.ok) saveBytes(r.value.name, r.value.mime, r.value.data);
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("title")}</h2>
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="@container flex flex-col gap-4">
        <div className="flex flex-col gap-3 @lg:flex-row @lg:items-end">
          <div className="flex flex-col gap-1">
            <Label htmlFor={ids.form}>{t("form")}</Label>
            <select
              id={ids.form}
              className={selectClass}
              value={form}
              onChange={(e) => {
                const next = e.target.value as "ustva" | "zm" | "euer";
                setForm(next);
                setPeriod(defaultPeriod(next, todayBerlin()));
              }}
            >
              <option value="ustva">{t("ustva")}</option>
              <option value="zm">{t("zm")}</option>
              <option value="euer">{t("euer")}</option>
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={ids.period}>{t("period")}</Label>
            <Input
              id={ids.period}
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              aria-describedby={`${ids.period}-hint`}
              className="@lg:w-36"
            />
            <span id={`${ids.period}-hint`} className="text-muted-foreground text-xs">
              {t("periodHint")}
            </span>
          </div>
          <Button className="h-11 md:h-9" disabled={busy} onClick={() => get("pdf")}>
            <FileDownIcon aria-hidden="true" />
            {t("pdf")}
          </Button>
          <Button variant="outline" className="h-11 md:h-9" disabled={busy} onClick={() => get("csv")}>
            <FileDownIcon aria-hidden="true" />
            {t("csv")}
          </Button>
        </div>
        <p className="text-sm">
          <Link className="underline underline-offset-4" href="/steuern/ustva">
            {t("toUstva")}
          </Link>
          {" · "}
          <Link className="underline underline-offset-4" href="/steuern/zm">
            {t("toZm")}
          </Link>
          {" · "}
          <Link className="underline underline-offset-4" href="/steuern/euer">
            {t("toEuer")}
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}

"use client";

import { api } from "@convex/_generated/api";
import { useMutation } from "convex/react";
import { AlertTriangleIcon, DownloadIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCan, useRun } from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { downloadText } from "@/components/exports/export-menu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { REGION_LABEL_DE, ROLE_LABEL_DE } from "@/domain/privacy/external-services";
import { useAuthedQuery } from "@/hooks/use-authed-query";

const dateDe = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeZone: "Europe/Berlin" });

/** F12 §6 `/einstellungen/datenschutz`: Externe Dienste (AVV), Aufbewahrung, Verzeichnis (Art. 30), Anfragen (P3). */
export function PrivacyPage({ publicEdge }: { publicEdge: boolean }) {
  const t = useTranslations("privacy");
  return (
    <ConvexGuard fallback={<div className="h-96" aria-busy="true" />}>
      <Tabs defaultValue="services">
        <TabsList>
          <TabsTrigger value="services">{t("tabs.services")}</TabsTrigger>
          <TabsTrigger value="retention">{t("tabs.retention")}</TabsTrigger>
          <TabsTrigger value="art30">{t("tabs.art30")}</TabsTrigger>
          <TabsTrigger value="requests">{t("tabs.requests")}</TabsTrigger>
        </TabsList>
        <TabsContent value="services" className="pt-4">
          <Services publicEdge={publicEdge} />
        </TabsContent>
        <TabsContent value="retention" className="pt-4">
          <Retention />
        </TabsContent>
        <TabsContent value="art30" className="pt-4">
          <Art30 publicEdge={publicEdge} />
        </TabsContent>
        <TabsContent value="requests" className="pt-4">
          <p className="text-muted-foreground text-sm">{t("requestsLater")}</p>
        </TabsContent>
      </Tabs>
    </ConvexGuard>
  );
}

function Services({ publicEdge }: { publicEdge: boolean }) {
  const t = useTranslations("privacy");
  const list = useAuthedQuery(api.privacy.externalServices, { publicEdge });
  const confirm = useMutation(api.privacy.confirmAvv);
  const isOwner = useCan("settings.ownerOnly");
  const run = useRun();
  if (!list) return <div className="h-64" aria-busy="true" />;
  return (
    <ul className="@container flex flex-col gap-3" aria-label={t("servicesLabel")}>
      {list.map((s) => (
        <li key={s.id} className="flex flex-col gap-2 rounded-lg border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{s.name}</span>
            <Badge variant="outline">{ROLE_LABEL_DE[s.role]}</Badge>
            <Badge variant="outline">{REGION_LABEL_DE[s.effectiveRegion]}</Badge>
            {s.role === "processor" &&
              (s.avvConfirmedAt ? (
                <Badge>{t("avvConfirmed", { date: dateDe.format(s.avvConfirmedAt) })}</Badge>
              ) : (
                <Badge variant="outline" className="border-warning/60 text-warning">
                  {t("avvMissing")}
                </Badge>
              ))}
          </div>
          <p className="text-sm">{s.purpose}</p>
          <p className="text-muted-foreground text-xs">
            {t("data")}: {s.dataCategories}
            {s.detail ? ` · ${s.detail}` : ""}
          </p>
          {s.warning && (
            <p role="alert" className="flex items-start gap-2 text-sm text-warning">
              <AlertTriangleIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              {s.warning}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {s.dpaUrl && (
              <a
                href={s.dpaUrl}
                target="_blank"
                rel="noreferrer"
                className="text-primary text-sm underline-offset-4 hover:underline"
              >
                {t("dpaLink")}
              </a>
            )}
            {isOwner && s.role === "processor" && (
              <Button
                variant="outline"
                size="sm"
                className="min-h-11 md:min-h-8"
                onClick={() =>
                  run(
                    () => confirm({ serviceId: s.id, confirmed: s.avvConfirmedAt === null }),
                    t(s.avvConfirmedAt === null ? "confirmed" : "withdrawn"),
                  )
                }
              >
                {s.avvConfirmedAt === null ? t("confirm", { name: s.name }) : t("withdraw")}
              </Button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function Retention() {
  const t = useTranslations("privacy");
  const data = useAuthedQuery(api.privacy.retention, {});
  if (!data) return <div className="h-64" aria-busy="true" />;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-sm">{t("retentionHint", { version: data.version })}</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">{t("tabs.retention")}</caption>
          <thead>
            <tr className="border-b text-left">
              <th scope="col" className="py-2 pr-3 font-medium">
                {t("class")}
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                {t("years")}
              </th>
              <th scope="col" className="py-2 font-medium">
                {t("records")}
              </th>
            </tr>
          </thead>
          <tbody>
            {data.classes.map((c) => (
              <tr key={c.cls} className="border-b last:border-0">
                <th scope="row" className="py-2 pr-3 text-left font-normal">
                  {c.label}
                </th>
                <td className="py-2 pr-3 tabular-nums">{c.years ?? "—"}</td>
                <td className="py-2 text-muted-foreground">{c.tables.join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Art30({ publicEdge }: { publicEdge: boolean }) {
  const t = useTranslations("privacy");
  const data = useAuthedQuery(api.privacy.art30, { publicEdge });
  if (!data) return <div className="h-64" aria-busy="true" />;
  const r = data.record;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">{r.title}</h2>
        <Button
          variant="outline"
          className="min-h-11 md:min-h-9"
          onClick={() => downloadText("verzeichnis-art30.md", data.markdown, "text/markdown;charset=utf-8")}
        >
          <DownloadIcon aria-hidden="true" />
          {t("download")}
        </Button>
      </div>
      <p className="text-sm">
        {t("controller")}: {r.controller.name}, {r.controller.address}
      </p>
      {r.activities.map((a) => (
        <section key={a.name} className="rounded-lg border p-3" aria-label={a.name}>
          <h3 className="font-medium">{a.name}</h3>
          <dl className="mt-2 grid @lg:grid-cols-[12rem_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">{t("purpose")}</dt>
            <dd>{a.purpose}</dd>
            <dt className="text-muted-foreground">{t("legalBasis")}</dt>
            <dd>{a.legalBasis}</dd>
            <dt className="text-muted-foreground">{t("recipients")}</dt>
            <dd>{a.recipients}</dd>
            <dt className="text-muted-foreground">{t("thirdCountry")}</dt>
            <dd>{a.thirdCountry}</dd>
            <dt className="text-muted-foreground">{t("retention")}</dt>
            <dd>{a.retention}</dd>
          </dl>
        </section>
      ))}
    </div>
  );
}

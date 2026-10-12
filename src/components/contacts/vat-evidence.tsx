"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import type { Route } from "next";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { formatDate, formatDateTime } from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { PageBody } from "@/components/layout/list-layout";
import { PageHeader } from "@/components/layout/page-header";
import { Button, buttonVariants } from "@/components/ui/button";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { cn } from "@/lib/utils";

const PROVIDER_LABELS: Record<string, string> = {
  bzst_evatr: "Bundeszentralamt für Steuern — eVatR (qualifizierte Bestätigungsanfrage)",
  eu_vies: "Europäische Kommission — VIES",
};

/**
 * CON-061 „Nachweis als PDF“: the stored request and response of one check as a printable page (browser print → PDF).
 * The record itself is append-only evidence (MISC-04, retention 10 years).
 */
export function VatEvidence({ contactId, checkId }: { contactId: string; checkId: string }) {
  return (
    <ConvexGuard fallback={<div className="h-96" aria-busy="true" />}>
      <Evidence contactId={contactId} checkId={checkId as Id<"vatIdChecks">} />
    </ConvexGuard>
  );
}

function Evidence({ contactId, checkId }: { contactId: string; checkId: Id<"vatIdChecks"> }) {
  const t = useTranslations("contacts.evidence");
  const tNav = useTranslations("nav");
  const data = useAuthedQuery(api.vatIdChecks.evidence, { checkId });
  if (data === undefined) return <div className="h-96" aria-busy="true" />;
  const back = `/kontakte/${contactId}` as Route;
  if (data === null) {
    return (
      <PageBody>
        <p role="alert">{t("notFound")}</p>
      </PageBody>
    );
  }
  const c = data.check;
  const rows: [string, string][] = [
    [t("contact"), data.contact ? `${data.contact.displayName} (${data.contact.number})` : "—"],
    [t("vatId"), c.vatId],
    [t("date"), formatDateTime(c.checkedAt)],
    [t("provider"), PROVIDER_LABELS[c.provider] ?? c.provider],
    [t("requestId"), c.providerRequestId ?? "—"],
    [t("status"), c.status],
    [t("message"), c.message ?? "—"],
    [
      t("codes"),
      c.qualified
        ? `Name ${c.qualified.name} · Straße ${c.qualified.street} · PLZ ${c.qualified.postalCode} · Ort ${c.qualified.city}`
        : "—",
    ],
    [t("retention"), formatDate(c.retentionUntil)],
  ];
  return (
    <>
      <PageHeader
        className="print:hidden"
        title={t("title")}
        breadcrumbs={[
          { label: tNav("items.kontakte"), href: "/kontakte" },
          { label: data.contact?.displayName ?? "—", href: back },
          { label: t("title") },
        ]}
        actions={
          <>
            <Link href={back} className={cn(buttonVariants({ variant: "outline" }), "h-11 md:h-9")}>
              {t("back")}
            </Link>
            <Button className="h-11 md:h-9" onClick={() => window.print()}>
              {t("print")}
            </Button>
          </>
        }
      />
      <PageBody>
        <article className="mx-auto flex w-full max-w-3xl flex-col gap-4 text-sm">
          <h2 className="hidden font-semibold text-xl print:block">{t("title")}</h2>
          <dl className="grid grid-cols-1 gap-x-4 gap-y-2 rounded-xl border p-4 sm:grid-cols-[12rem_1fr]">
            {rows.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="break-all">{v}</dd>
              </div>
            ))}
          </dl>
          <section className="flex flex-col gap-2">
            <h3 className="font-medium">{t("request")}</h3>
            <pre className="overflow-x-auto rounded-lg border bg-muted/40 p-3 text-xs">
              {JSON.stringify(c.request, null, 2)}
            </pre>
          </section>
          <section className="flex flex-col gap-2">
            <h3 className="font-medium">{t("response")}</h3>
            <pre className="overflow-x-auto rounded-lg border bg-muted/40 p-3 text-xs">
              {JSON.stringify(c.response, null, 2)}
            </pre>
          </section>
        </article>
      </PageBody>
    </>
  );
}

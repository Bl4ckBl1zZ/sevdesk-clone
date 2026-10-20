import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import type * as React from "react";
import { RoleGate } from "@/components/auth/role-gate";
import { PageBody } from "@/components/layout/list-layout";
import { PageHeader } from "@/components/layout/page-header";
import { TaxScopeNotice } from "./tax-scope-notice";

type TaxPageKey = "ustva" | "zm" | "euer" | "ustJahr" | "ruecklage";

export async function taxMetadata(page: TaxPageKey): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t(`${page}.title`) };
}

/** Frame of the Steuern pages (F08 §6): header, AO-07 scope notice, role gate `tax.read`. */
export async function TaxPage({ page, children }: { page: TaxPageKey; children: React.ReactNode }) {
  const t = await getTranslations("pages");
  const tNav = await getTranslations("nav");
  return (
    <>
      <PageHeader
        title={t(`${page}.title`)}
        description={t(`${page}.description`)}
        breadcrumbs={[{ label: tNav("items.steuernBereich"), href: "/steuern/ustva" }, { label: t(`${page}.title`) }]}
      />
      <PageBody>
        <TaxScopeNotice page={page === "euer" ? "euer" : "other"} />
        <RoleGate permission="tax.read">{children}</RoleGate>
      </PageBody>
    </>
  );
}

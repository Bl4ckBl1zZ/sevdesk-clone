import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import type * as React from "react";
import { RoleGate } from "@/components/auth/role-gate";
import { PageBody } from "@/components/layout/list-layout";
import { PageHeader } from "@/components/layout/page-header";

type AccountingPageKey = "journal" | "journalNeu" | "konten" | "eroeffnung" | "anlagen" | "festschreibung";

export async function accountingMetadata(page: AccountingPageKey): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t(`${page}.title`) };
}

/** Frame of the Buchhaltung pages (F08 §6): header with breadcrumb, role gate `accounting.read`, body. */
export async function AccountingPage({ page, children }: { page: AccountingPageKey; children: React.ReactNode }) {
  const t = await getTranslations("pages");
  const tNav = await getTranslations("nav");
  return (
    <>
      <PageHeader
        title={t(`${page}.title`)}
        description={t(`${page}.description`)}
        breadcrumbs={[
          { label: tNav("items.auswertungenBereich"), href: "/auswertungen/offene-posten" },
          { label: t(`${page}.title`) },
        ]}
      />
      <PageBody>
        <RoleGate permission="accounting.read">{children}</RoleGate>
      </PageBody>
    </>
  );
}

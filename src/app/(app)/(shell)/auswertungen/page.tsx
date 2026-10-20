import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { RoleGate } from "@/components/auth/role-gate";
import { PageBody } from "@/components/layout/list-layout";
import { PageHeader } from "@/components/layout/page-header";
import { ReportsWorkspace } from "@/components/reports/reports-workspace";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("auswertungen.title") };
}

/** /auswertungen (F08 §6, NAV-004): report tiles; a report opens with its parameters in the URL (RPT-001). */
export default async function Page() {
  const t = await getTranslations("pages");
  return (
    <>
      <PageHeader title={t("auswertungen.title")} description={t("auswertungen.description")} />
      <PageBody>
        <RoleGate permission="reports.read">
          <Suspense fallback={null}>
            <ReportsWorkspace />
          </Suspense>
        </RoleGate>
      </PageBody>
    </>
  );
}

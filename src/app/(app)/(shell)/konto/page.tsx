import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { AccountPanel } from "@/components/auth/account-panel";
import { PageBody } from "@/components/layout/list-layout";
import { PageHeader } from "@/components/layout/page-header";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("account");
  return { title: t("title") };
}

export default async function AccountPage() {
  const t = await getTranslations("account");
  return (
    <>
      <PageHeader title={t("title")} description={t("description")} />
      <PageBody>
        <AccountPanel />
      </PageBody>
    </>
  );
}

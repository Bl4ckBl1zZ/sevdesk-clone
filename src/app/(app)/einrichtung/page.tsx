import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { SetupWizard } from "@/components/setup/setup-wizard";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("setup");
  return { title: t("title") };
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** `/einrichtung?schritt=…` (04-ui-ux §3.4, F01 §6.1). TODO(auth branch): owner only (SET-001). */
export default async function SetupPage({ searchParams }: { searchParams: SearchParams }) {
  const { schritt } = await searchParams;
  return <SetupWizard stepSlug={typeof schritt === "string" ? schritt : null} />;
}

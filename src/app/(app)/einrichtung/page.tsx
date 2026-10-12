import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { RoleGate } from "@/components/auth/role-gate";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { SetupWizard } from "@/components/setup/setup-wizard";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("setup");
  return { title: t("title") };
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** `/einrichtung?schritt=…` (04-ui-ux §3.4, F01 §6.1). Owner only (SET-001). */
export default async function SetupPage({ searchParams }: { searchParams: SearchParams }) {
  const { schritt } = await searchParams;
  return (
    <RoleGate permission="settings.ownerOnly">
      <ConvexGuard fallback={<div className="mx-auto h-96 w-full max-w-5xl" aria-busy="true" />}>
        <SetupWizard stepSlug={typeof schritt === "string" ? schritt : null} />
      </ConvexGuard>
    </RoleGate>
  );
}

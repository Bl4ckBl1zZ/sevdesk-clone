import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { AuthCard } from "@/components/auth/auth-card";
import { TotpForm } from "@/components/auth/totp-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth");
  return { title: t("totpTitle") };
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function TwoFactorPage({ searchParams }: { searchParams: SearchParams }) {
  const t = await getTranslations("auth");
  const { weiter } = await searchParams;
  return (
    <AuthCard title={t("totpTitle")}>
      <TotpForm redirectTo={typeof weiter === "string" ? weiter : null} />
    </AuthCard>
  );
}

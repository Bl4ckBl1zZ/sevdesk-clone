import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { AuthCard } from "@/components/auth/auth-card";
import { OtpStep } from "@/components/auth/otp-step";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth");
  return { title: t("codeTitle") };
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function CodePage({ searchParams }: { searchParams: SearchParams }) {
  const t = await getTranslations("auth");
  const { weiter } = await searchParams;
  return (
    <AuthCard title={t("codeTitle")}>
      <OtpStep redirectTo={typeof weiter === "string" ? weiter : null} />
    </AuthCard>
  );
}

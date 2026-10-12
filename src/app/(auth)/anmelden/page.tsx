import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { AuthCard } from "@/components/auth/auth-card";
import { LoginForm } from "@/components/auth/login-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth");
  return { title: t("signInTitle") };
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function SignInPage({ searchParams }: { searchParams: SearchParams }) {
  const t = await getTranslations("auth");
  const { weiter } = await searchParams;
  // TODO(auth branch): firstRun = no Better Auth user exists yet (02 §4.3) — needs a public server-side check.
  const firstRun = false;
  return (
    <AuthCard title={t("signInTitle")} description={t("signInDescription")}>
      <LoginForm firstRun={firstRun} redirectTo={typeof weiter === "string" ? weiter : null} />
    </AuthCard>
  );
}

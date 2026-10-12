import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { AuthCard } from "@/components/auth/auth-card";
import { PasskeyEnrol } from "@/components/auth/passkey-enrol";
import { requireSession } from "@/lib/auth-server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth");
  return { title: t("enrolTitle") };
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function PasskeyEnrolPage({ searchParams }: { searchParams: SearchParams }) {
  const t = await getTranslations("auth");
  const { weiter } = await searchParams;
  const target = typeof weiter === "string" ? weiter : null;
  // Signed-in members only; mandatory for the owner (F01 SET-009), others may choose "Später" (04 §4.9).
  const me = await requireSession(
    `/anmelden/passkey-einrichten${target ? `?weiter=${encodeURIComponent(target)}` : ""}`,
  );
  return (
    <AuthCard title={t("enrolTitle")}>
      <PasskeyEnrol mandatory={me.role === "owner"} redirectTo={target} />
    </AuthCard>
  );
}

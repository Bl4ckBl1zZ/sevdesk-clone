import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { AuthCard } from "@/components/auth/auth-card";
import { PasskeyEnrol } from "@/components/auth/passkey-enrol";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth");
  return { title: t("enrolTitle") };
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function PasskeyEnrolPage({ searchParams }: { searchParams: SearchParams }) {
  const t = await getTranslations("auth");
  const { weiter } = await searchParams;
  // TODO(auth branch): mandatory = member role is "owner" (F01 SET-009); others may choose "Später".
  // Until members exist, the only person who can reach this page is the bootstrap owner.
  const mandatory = true;
  return (
    <AuthCard title={t("enrolTitle")}>
      <PasskeyEnrol mandatory={mandatory} redirectTo={typeof weiter === "string" ? weiter : null} />
    </AuthCard>
  );
}

import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { BankAccountsAdmin } from "@/components/settings/bank-accounts-admin";
import { BankSettings, SaveButton } from "@/components/settings/settings-forms";
import { SettingsPage, settingsMetadata } from "@/components/settings/settings-page";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export const generateMetadata = () => settingsMetadata("bank");

export default async function Page() {
  const t = await getTranslations("settings");
  return (
    <SettingsPage item="bank" actions={<SaveButton />}>
      <div className="flex flex-col gap-6">
        <BankSettings />
        <BankAccountsAdmin />
      </div>
      <Card size="sm">
        <CardHeader>
          <CardTitle>
            <h2>{t("bankConnection")}</h2>
          </CardTitle>
          <CardDescription>{t("bankConnectionHint")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Link href="/einstellungen/bank/verbindung" className={cn(buttonVariants(), "h-11 md:h-9")}>
            {t("bankConnectionOpen")}
          </Link>
          <Link href="/einstellungen/bank/regeln" className={cn(buttonVariants({ variant: "outline" }), "h-11 md:h-9")}>
            {t("bankRulesOpen")}
          </Link>
        </CardContent>
      </Card>
    </SettingsPage>
  );
}

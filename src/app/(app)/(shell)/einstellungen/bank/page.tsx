import { getTranslations } from "next-intl/server";
import { BankSettings, SaveButton } from "@/components/settings/settings-forms";
import { SettingsPage, settingsMetadata } from "@/components/settings/settings-page";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const generateMetadata = () => settingsMetadata("bank");

export default async function Page() {
  const t = await getTranslations("settings");
  return (
    <SettingsPage item="bank" actions={<SaveButton />}>
      <BankSettings />
      <Card size="sm">
        <CardHeader>
          <CardTitle>
            <h2>{t("bankConnection")}</h2>
          </CardTitle>
          <CardDescription>{t("bankConnectionHint")}</CardDescription>
        </CardHeader>
      </Card>
    </SettingsPage>
  );
}

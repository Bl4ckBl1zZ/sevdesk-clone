import { getTranslations } from "next-intl/server";
import { CompanySettings, SaveButton } from "@/components/settings/settings-forms";
import { SectionNav } from "@/components/settings/settings-nav";
import { SettingsPage, settingsMetadata } from "@/components/settings/settings-page";
import { COMPANY_SECTIONS } from "@/components/setup/sections";

export const generateMetadata = () => settingsMetadata("unternehmen");

export default async function Page() {
  const t = await getTranslations("settings");
  return (
    <SettingsPage item="unternehmen" actions={<SaveButton />}>
      <SectionNav
        label={t("sectionsLabel")}
        sections={COMPANY_SECTIONS.map((s) => ({ id: `abschnitt-${s}`, label: t(`tabs.${s}`) }))}
      />
      <CompanySettings />
    </SettingsPage>
  );
}

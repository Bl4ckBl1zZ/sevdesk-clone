import { getTranslations } from "next-intl/server";
import { SaveButton, TaxSettings } from "@/components/settings/settings-forms";
import { SectionNav } from "@/components/settings/settings-nav";
import { SettingsPage, settingsMetadata } from "@/components/settings/settings-page";
import { TAX_SECTIONS } from "@/components/setup/sections";

export const generateMetadata = () => settingsMetadata("steuern");

export default async function Page() {
  const t = await getTranslations("settings");
  return (
    <SettingsPage item="steuern" actions={<SaveButton />}>
      <SectionNav
        label={t("sectionsLabel")}
        sections={TAX_SECTIONS.map((s) => ({ id: `abschnitt-${s}`, label: t(`tabs.${s}`) }))}
      />
      <TaxSettings />
    </SettingsPage>
  );
}

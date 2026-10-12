import { NumberRangesSettings, SaveButton } from "@/components/settings/settings-forms";
import { SettingsPage, settingsMetadata } from "@/components/settings/settings-page";

export const generateMetadata = () => settingsMetadata("nummernkreise");

export default async function Page() {
  return (
    <SettingsPage item="nummernkreise" actions={<SaveButton />}>
      <NumberRangesSettings />
    </SettingsPage>
  );
}

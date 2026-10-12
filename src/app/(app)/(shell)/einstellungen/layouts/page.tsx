import { LayoutSettings, SaveButton } from "@/components/settings/settings-forms";
import { SettingsPage, settingsMetadata } from "@/components/settings/settings-page";

export const generateMetadata = () => settingsMetadata("layouts");

export default async function Page() {
  return (
    <SettingsPage item="layouts" actions={<SaveButton />}>
      <LayoutSettings />
    </SettingsPage>
  );
}

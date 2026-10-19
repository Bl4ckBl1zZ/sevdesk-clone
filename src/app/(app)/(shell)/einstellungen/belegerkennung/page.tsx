import { OcrSettings } from "@/components/settings/inbox-settings";
import { SettingsPage, settingsMetadata } from "@/components/settings/settings-page";

export const generateMetadata = () => settingsMetadata("belegerkennung");

export default function Page() {
  return (
    <SettingsPage item="belegerkennung">
      <OcrSettings />
    </SettingsPage>
  );
}

import { InboxMailSettings } from "@/components/settings/inbox-settings";
import { SettingsPage, settingsMetadata } from "@/components/settings/settings-page";

export const generateMetadata = () => settingsMetadata("posteingang");

export default function Page() {
  return (
    <SettingsPage item="posteingang">
      <InboxMailSettings />
    </SettingsPage>
  );
}

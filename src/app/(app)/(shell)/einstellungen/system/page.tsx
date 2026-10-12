import { SettingsPage, settingsMetadata } from "@/components/settings/settings-page";
import { SystemPanel } from "@/components/settings/status-panels";

export const generateMetadata = () => settingsMetadata("system");

export default function Page() {
  return (
    <SettingsPage item="system">
      <SystemPanel />
    </SettingsPage>
  );
}

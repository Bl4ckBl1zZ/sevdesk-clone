import { SettingsPlaceholder, settingsMetadata } from "@/components/settings/settings-page";

export const generateMetadata = () => settingsMetadata("benachrichtigungen");

export default function Page() {
  return <SettingsPlaceholder item="benachrichtigungen" />;
}

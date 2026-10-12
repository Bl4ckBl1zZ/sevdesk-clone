import { SettingsPlaceholder, settingsMetadata } from "@/components/settings/settings-page";

export const generateMetadata = () => settingsMetadata("mitglieder");

export default function Page() {
  return <SettingsPlaceholder item="mitglieder" />;
}

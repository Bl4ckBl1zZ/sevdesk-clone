import { SettingsPlaceholder, settingsMetadata } from "@/components/settings/settings-page";

export const generateMetadata = () => settingsMetadata("stammdaten");

export default function Page() {
  return <SettingsPlaceholder item="stammdaten" />;
}
